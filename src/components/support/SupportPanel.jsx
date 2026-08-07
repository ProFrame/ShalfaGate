// Support — main admin screen (admin/support, AdminNav id 'support',
// labelKey admin_nav_support, Support.View/Support.Manage).
//
// The company-wide ticket queue: every InApp-sourced ticket this tenant can
// see (loadCompanyTickets() — a plain table read, RLS-scoped to
// Support.View/Support.Manage holders, migration 202608040018 §3), with
// status/category/priority filters and a free-text search across ticket
// number/subject/requester, mirroring OperationsListAdmin.jsx's own
// admin-toolbar/filter-bar/enterprise-table shape exactly. Selecting a row
// swaps to a full detail view (not a modal, same convention
// OperationsListAdmin.jsx/SafetyIssuancesAdmin.jsx both document) showing the
// ticket's own message thread and a reply composer.
//
// `source` is never shown or filtered on: every row this screen's own
// loadCompanyTickets() can ever return is source='InApp' by construction —
// see supportService.js's own header for why a 'Public' (anonymous,
// marketing-site) ticket can never live under a real company's tenant_id.
//
// Status change is rendered unconditionally for whoever reaches this screen
// and lets PERMISSION_DENIED surface through supportErrorMessage() if the
// account holds Support.View but not Support.Manage — this codebase's
// established convention for an action only some holders of a screen can use
// (OperationsListAdmin.jsx's own header). There is deliberately no Assign
// control: support_ticket_assign() is is_platform_operator()-only with no
// tenant/Support.Manage branch at all (supportService.js's own header), so
// no company admin could ever succeed there regardless of permission —
// rendering a button that fails for every single caller of this screen,
// forever, is a different and worse case than "some callers lack a
// permission", so it is left out entirely, mirroring
// OperationsListAdmin.jsx's own documented choice to leave an
// out-of-scope action to a different screen.
//
// There is also no "internal note" toggle on the reply composer:
// support_reply()'s own p_is_internal only ever takes effect for the
// platform operator (`v_internal := ... and v_is_operator`, migration 018
// §4 as revised by 202608050038) — a company caller passing true silently
// produces an ordinary, visible reply, so a checkbox here would just be
// misleading. Internal notes never reach this screen's own
// support_ticket_detail() read either (`v_is_operator or not m.is_internal`).
//
// Data access only ever goes through src/data/supportService.js — this
// screen never calls supabase directly.

import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Check, ChevronLeft, ChevronRight, Eye, LifeBuoy, Search, Send, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import {
  SUPPORT_TICKET_CATEGORIES, SUPPORT_TICKET_PRIORITIES, SUPPORT_TICKET_STATUSES,
  loadCompanyTickets, loadTicketDetail, replyToTicket, setTicketStatus, supportErrorMessage,
} from '../../data/supportService';
import { codeLabel, formatDateTime } from '../../utils/localize';
import { TicketPriorityChip, TicketStatusChip } from './supportShared';
import './support.css';

const BackIcon = () => {
  const { isRtl } = useLanguage();
  const Icon = isRtl ? ChevronRight : ChevronLeft;
  return <Icon aria-hidden="true" />;
};

// ---------------------------------------------------------------------------
// Thread + composer
// ---------------------------------------------------------------------------
const Thread = ({ t, locale, messages }) => {
  if (!messages.length) return <p className="field-note">{t('support_thread_empty')}</p>;
  return (
    <div className="sup-thread">
      {messages.map((message) => (
        <article
          key={message.id}
          className={`sup-message ${message.author_type === 'Operator' ? 'sup-message-mine' : ''}`}
        >
          <div className="sup-message-head">
            <b>{message.author_name || t(message.author_type === 'Operator' ? 'support_portal_thread_support' : 'support_field_requester')}</b>
            <small>{formatDateTime(message.created_on, locale)}</small>
          </div>
          <p>{message.body}</p>
        </article>
      ))}
    </div>
  );
};

const Composer = ({ t, busy, onSend }) => {
  const [body, setBody] = useState('');
  return (
    <div className="sup-composer">
      <label className="field-label" htmlFor="sup-admin-reply">
        <span className="sr-only">{t('support_reply_placeholder')}</span>
        <textarea
          id="sup-admin-reply"
          className="form-input"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={t('support_reply_placeholder')}
        />
      </label>
      <div className="sup-composer-actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy || !body.trim()}
          onClick={async () => {
            const sent = await onSend(body);
            if (sent) setBody('');
          }}
        >
          <Send aria-hidden="true" /> {t('support_reply_submit')}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Detail view — full-screen swap, mirrors OperationsListAdmin.jsx's own
// OperationDetailView (back button, focus-the-heading-on-mount).
// ---------------------------------------------------------------------------
const TicketDetailView = ({
  ticketId, onBack, t, locale,
}) => {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const headingRef = useRef(null);
  const headingFocusedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadTicketDetail(ticketId).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setNotice({ tone: 'error', text: supportErrorMessage(t, error) });
      } else {
        setDetail(data);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [ticketId, reloadToken, t]);

  useEffect(() => {
    if (loading || headingFocusedRef.current) return;
    headingFocusedRef.current = true;
    headingRef.current?.focus();
  }, [loading]);

  const reply = async (body) => {
    setBusy(true);
    const { error } = await replyToTicket(ticketId, body, false);
    setBusy(false);
    if (error) { setNotice({ tone: 'error', text: supportErrorMessage(t, error) }); return false; }
    setNotice({ tone: 'success', text: t('support_reply_sent') });
    setReloadToken((token) => token + 1);
    return true;
  };

  const changeStatus = async (status) => {
    setStatusBusy(true);
    const { error } = await setTicketStatus(ticketId, status);
    setStatusBusy(false);
    if (error) { setNotice({ tone: 'error', text: supportErrorMessage(t, error) }); return; }
    setNotice({ tone: 'success', text: t('support_status_updated') });
    setReloadToken((token) => token + 1);
  };

  const ticket = detail?.ticket;

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <button type="button" className="secondary-button" onClick={onBack}>
          <BackIcon /> {t('support_back_to_list')}
        </button>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
        </div>
      )}

      {loading ? (
        <p className="field-note">{t('label_loading')}</p>
      ) : !ticket ? (
        <div className="empty-table"><LifeBuoy aria-hidden="true" /><b>{t('support_err_ticket_not_found')}</b></div>
      ) : (
        <>
          <div className="sup-detail-head">
            <div>
              <span className="section-kicker">{ticket.ticket_no}</span>
              <h1 ref={headingRef} tabIndex={-1}>{ticket.subject}</h1>
            </div>
            <TicketStatusChip t={t} status={ticket.status} />
          </div>

          <div className="sup-detail-meta-grid">
            <div className="sup-detail-meta-item">
              <span>{t('support_field_requester')}</span>
              <b>{ticket.requester_name || ticket.requester_email}</b>
            </div>
            <div className="sup-detail-meta-item">
              <span>{t('support_field_category')}</span>
              <b>{codeLabel(t, 'support_cat', ticket.category, ticket.category)}</b>
            </div>
            <div className="sup-detail-meta-item">
              <span>{t('support_field_priority')}</span>
              <b><TicketPriorityChip t={t} priority={ticket.priority} /></b>
            </div>
            <div className="sup-detail-meta-item">
              <span>{t('support_detail_opened_on')}</span>
              <b>{formatDateTime(ticket.created_on, locale)}</b>
            </div>
            {ticket.first_response_on && (
              <div className="sup-detail-meta-item">
                <span>{t('support_detail_first_response')}</span>
                <b>{formatDateTime(ticket.first_response_on, locale)}</b>
              </div>
            )}
            {ticket.closed_on && (
              <div className="sup-detail-meta-item">
                <span>{t('support_detail_closed_on')}</span>
                <b>{formatDateTime(ticket.closed_on, locale)}</b>
              </div>
            )}
          </div>

          <p className="field-note">{ticket.body}</p>

          <Thread t={t} locale={locale} messages={detail.messages || []} />
          <Composer t={t} busy={busy} onSend={reply} />

          <div className="sup-status-row">
            <label className="field-label" htmlFor="sup-admin-status">
              <span className="sr-only">{t('support_set_status_label')}</span>
              <select
                id="sup-admin-status"
                className="form-input"
                value={ticket.status}
                disabled={statusBusy}
                onChange={(event) => changeStatus(event.target.value)}
              >
                {SUPPORT_TICKET_STATUSES.map((code) => (
                  <option key={code} value={code}>{codeLabel(t, 'status', code, code)}</option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// List / screen
// ---------------------------------------------------------------------------
const SupportPanel = () => {
  const { t, locale } = useLanguage();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadCompanyTickets({
      status: statusFilter || undefined,
      category: categoryFilter || undefined,
      priority: priorityFilter || undefined,
    }).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setRows([]);
        setNotice({ tone: 'error', text: supportErrorMessage(t, error) || t('admin_load_failed') });
      } else {
        setRows(data || []);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [statusFilter, categoryFilter, priorityFilter, reloadToken, t]);

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => (
      String(row.ticket_no || '').toLowerCase().includes(needle)
      || String(row.subject || '').toLowerCase().includes(needle)
      || String(row.requester_name || '').toLowerCase().includes(needle)
      || String(row.requester_email || '').toLowerCase().includes(needle)
    ));
  }, [rows, query]);

  if (selectedId) {
    return (
      <TicketDetailView
        ticketId={selectedId}
        onBack={() => { setSelectedId(null); setReloadToken((token) => token + 1); }}
        t={t}
        locale={locale}
      />
    );
  }

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('support_module_kicker')}</span>
          <h1><LifeBuoy className="admin-title-icon" aria-hidden="true" /> {t('support_admin_title')}</h1>
          <p>{t('support_admin_intro')}</p>
        </div>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
        </div>
      )}

      <div className="filter-bar">
        <label className="search-control">
          <Search aria-hidden="true" />
          <span className="sr-only">{t('action_search')}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('support_search_placeholder')}
          />
          {query ? (
            <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label={t('action_clear')}>
              <X aria-hidden="true" width={13} height={13} />
            </button>
          ) : null}
        </label>

        <label className="sr-only" htmlFor="sup-filter-status">{t('label_status')}</label>
        <select
          id="sup-filter-status"
          className="form-input"
          value={statusFilter}
          onChange={(event) => { setLoading(true); setStatusFilter(event.target.value); }}
        >
          <option value="">{t('support_filter_all_statuses')}</option>
          {SUPPORT_TICKET_STATUSES.map((code) => (
            <option key={code} value={code}>{codeLabel(t, 'status', code, code)}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="sup-filter-category">{t('support_field_category')}</label>
        <select
          id="sup-filter-category"
          className="form-input"
          value={categoryFilter}
          onChange={(event) => { setLoading(true); setCategoryFilter(event.target.value); }}
        >
          <option value="">{t('support_filter_all_categories')}</option>
          {SUPPORT_TICKET_CATEGORIES.map((code) => (
            <option key={code} value={code}>{codeLabel(t, 'support_cat', code, code)}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="sup-filter-priority">{t('support_field_priority')}</label>
        <select
          id="sup-filter-priority"
          className="form-input"
          value={priorityFilter}
          onChange={(event) => { setLoading(true); setPriorityFilter(event.target.value); }}
        >
          <option value="">{t('support_filter_all_priorities')}</option>
          {SUPPORT_TICKET_PRIORITIES.map((code) => (
            <option key={code} value={code}>{codeLabel(t, 'support_priority', code, code)}</option>
          ))}
        </select>

        <span className="result-count">{t('admin_records_count', { count: visibleRows.length })}</span>
      </div>

      <div className="data-table-wrap">
        <table className="enterprise-table">
          <thead>
            <tr>
              <th>{t('label_status')}</th>
              <th>{t('support_field_subject')}</th>
              <th>{t('support_field_requester')}</th>
              <th>{t('support_field_category')}</th>
              <th>{t('support_field_priority')}</th>
              <th>{t('support_field_created_on')}</th>
              <th aria-label={t('label_actions')} />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={row.id}>
                <td><TicketStatusChip t={t} status={row.status} /></td>
                <td>
                  <button type="button" className="sup-open-link" onClick={() => setSelectedId(row.id)}>
                    {row.subject}
                  </button>
                  <div><code>{row.ticket_no}</code></div>
                </td>
                <td>{row.requester_name || row.requester_email || '—'}</td>
                <td>{codeLabel(t, 'support_cat', row.category, row.category)}</td>
                <td><TicketPriorityChip t={t} priority={row.priority} /></td>
                <td>{formatDateTime(row.created_on, locale)}</td>
                <td>
                  <div className="table-actions">
                    <button type="button" title={t('action_details')} aria-label={t('action_details')} onClick={() => setSelectedId(row.id)}>
                      <Eye aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && !visibleRows.length && (
              <tr>
                <td colSpan={7}>
                  <div className="empty-table"><LifeBuoy aria-hidden="true" /><b>{t('support_list_empty')}</b></div>
                </td>
              </tr>
            )}
            {loading && <tr><td colSpan={7}>{t('label_loading')}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default SupportPanel;
