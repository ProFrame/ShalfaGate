// Support — employee-facing "My Support Tickets" portal screen (route
// /app/support, reaches whoever's account can open PORTAL_SUPPORT —
// min_role_rank 4, module SUPPORT; see supportService.js's own header for
// why that is not literally "every employee" the way PORTAL_HOME/PORTAL_
// NOTES/etc. are, despite this screen having originally been asked for on
// that assumption).
//
// loadMyTickets() explicitly scopes to the signed-in account's own
// requester_user_id — never left to RLS alone, which would also admit a
// Support.View/Support.Manage holder's *company-wide* tickets into a screen
// titled "My Support Tickets" (see supportService.js's own header).
// Selecting a ticket opens its own thread in place, with a reply box wired
// to support_reply()'s own requester branch. Raising a ticket is a modal
// form (mirrors OperationsListAdmin.jsx's own OperationDialog shape:
// role=dialog/aria-modal/useDialogA11y) that calls createMyTicket() —
// support_ticket_create_internal()'s own Support.Manage gate
// (supportService.js's own header) means this only actually succeeds for an
// account that holds it; PERMISSION_DENIED surfaces inside the modal via
// supportErrorMessage() rather than the form being hidden, the same
// convention every other screen built this session uses for an action only
// some holders of a screen can complete.
//
// Screen shell reuses verification.css's own .vf-screen/.vf-panel — imported
// directly below rather than assumed already loaded by another lazy route
// chunk (AssetsPortal.jsx/SafetyPortal.jsx/OperationsPortal.jsx each say in
// their own header they "reuse" the same classes without importing the
// stylesheet that defines them; a fresh page load that lands directly on
// /app/support without visiting one of those first would otherwise render
// unstyled).
//
// Data access only ever goes through src/data/supportService.js.

import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import {
  ArrowLeft, ArrowRight, Check, LifeBuoy, Plus, Search, Send, X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useDialogA11y } from '../../utils/useDialogA11y';
import {
  SUPPORT_TICKET_CATEGORIES, SUPPORT_TICKET_PRIORITIES,
  createMyTicket, loadMyTickets, loadTicketDetail, replyToTicket, supportErrorMessage,
} from '../../data/supportService';
import { codeLabel, formatDateTime } from '../../utils/localize';
import { TicketPriorityChip, TicketStatusChip } from './supportShared';
import '../verification/verification.css';
import './support.css';

const BackIcon = () => {
  const { isRtl } = useLanguage();
  const Icon = isRtl ? ArrowRight : ArrowLeft;
  return <Icon aria-hidden="true" />;
};

// ---------------------------------------------------------------------------
// New ticket modal
// ---------------------------------------------------------------------------
const emptyDraft = () => ({
  subject: '', body: '', category: 'Other', priority: 'Normal',
});

const NewTicketDialog = ({
  t, busy, error, onClose, onSubmit,
}) => {
  const closeRef = useDialogA11y(onClose);
  const [draft, setDraft] = useState(emptyDraft);
  const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }));

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('support_portal_create_title')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); onSubmit(draft); }}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('support_module_kicker')}</span>
            <h3>{t('support_portal_create_title')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <p className="field-note">{t('support_portal_create_intro')}</p>

        <div className="form-grid">
          <label className="field-label field-span-2">
            {t('support_field_subject')}
            <input
              required
              className="form-input"
              value={draft.subject}
              placeholder={t('support_field_subject_placeholder')}
              onChange={set('subject')}
            />
          </label>

          <label className="field-label">
            {t('support_field_category')}
            <select className="form-input" value={draft.category} onChange={set('category')}>
              {SUPPORT_TICKET_CATEGORIES.map((code) => (
                <option key={code} value={code}>{codeLabel(t, 'support_cat', code, code)}</option>
              ))}
            </select>
          </label>

          <label className="field-label">
            {t('support_field_priority')}
            <select className="form-input" value={draft.priority} onChange={set('priority')}>
              {SUPPORT_TICKET_PRIORITIES.map((code) => (
                <option key={code} value={code}>{codeLabel(t, 'support_priority', code, code)}</option>
              ))}
            </select>
          </label>

          <label className="field-label field-span-2">
            {t('support_field_body')}
            <textarea
              required
              className="form-input"
              rows={5}
              value={draft.body}
              placeholder={t('support_field_body_placeholder')}
              onChange={set('body')}
            />
          </label>
        </div>

        {error && <div className="modal-error" role="alert"><X aria-hidden="true" />{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button className="primary-button" disabled={busy}>
            {busy ? t('label_loading') : t('support_portal_create_submit')}
          </button>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Ticket detail — thread + reply, in place. Always a fresh mount per
// selected ticket (the parent swaps the whole subtree), so this effect also
// doubles as the "focus the detail heading when it opens" a11y move — same
// reasoning OperationsPortal.jsx's own OperationDetail documents.
// ---------------------------------------------------------------------------
const TicketDetail = ({
  ticketId, t, locale, onBack,
}) => {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [replyBody, setReplyBody] = useState('');
  const headingRef = useRef(null);

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

  useEffect(() => { if (!loading) headingRef.current?.focus(); }, [loading]);

  const ticket = detail?.ticket;

  const submitReply = async (event) => {
    event.preventDefault();
    if (!replyBody.trim()) return;
    setBusy(true);
    const { error } = await replyToTicket(ticketId, replyBody, false);
    setBusy(false);
    if (error) { setNotice({ tone: 'error', text: supportErrorMessage(t, error) }); return; }
    setReplyBody('');
    setNotice({ tone: 'success', text: t('support_reply_sent') });
    setReloadToken((token) => token + 1);
  };

  return (
    <main className="support-portal-page app-main">
      <div className="vf-screen">
        <div className="vf-screen-head">
          <div>
            <button type="button" className="secondary-button" onClick={onBack}>
              <BackIcon /> {t('support_portal_back_to_list')}
            </button>
            {ticket && <span className="section-kicker">{ticket.ticket_no}</span>}
            <h1 ref={headingRef} tabIndex={-1}>{ticket?.subject || t('support_portal_title')}</h1>
          </div>
          {ticket && <TicketStatusChip t={t} status={ticket.status} />}
        </div>

        {notice && (
          <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
            {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
            {notice.text}
            <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
          </div>
        )}

        {loading ? (
          <div className="page-loader inline-loader">
            <span aria-hidden="true" />
            <span className="sr-only" role="status" aria-live="polite">{t('label_loading')}</span>
          </div>
        ) : !ticket ? (
          <div className="empty-table"><LifeBuoy aria-hidden="true" /><b>{t('support_err_ticket_not_found')}</b></div>
        ) : (
          <>
            <section className="vf-panel">
              <div className="sup-detail-meta-grid">
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
              </div>
              <p className="field-note">{ticket.body}</p>
            </section>

            <section className="vf-panel">
              <div className="vf-panel-head"><h2>{t('support_thread_title')}</h2></div>

              {(detail.messages || []).length === 0 ? (
                <p className="field-note">{t('support_thread_empty')}</p>
              ) : (
                <div className="sup-thread">
                  {detail.messages.map((message) => (
                    <article
                      key={message.id}
                      className={`sup-message ${message.author_type === 'Requester' ? 'sup-message-mine' : ''}`}
                    >
                      <div className="sup-message-head">
                        <b>{message.author_type === 'Requester' ? t('support_portal_thread_you') : (message.author_name || t('support_portal_thread_support'))}</b>
                        <small>{formatDateTime(message.created_on, locale)}</small>
                      </div>
                      <p>{message.body}</p>
                    </article>
                  ))}
                </div>
              )}

              {ticket.status === 'Closed' && <p className="field-note">{t('support_ticket_closed_notice')}</p>}

              <form className="sup-composer" onSubmit={submitReply}>
                <label className="field-label" htmlFor="sup-portal-reply">
                  <span className="sr-only">{t('support_reply_placeholder')}</span>
                  <textarea
                    id="sup-portal-reply"
                    className="form-input"
                    value={replyBody}
                    onChange={(event) => setReplyBody(event.target.value)}
                    placeholder={t('support_reply_placeholder')}
                  />
                </label>
                <div className="sup-composer-actions">
                  <button type="submit" className="primary-button" disabled={busy || !replyBody.trim()}>
                    <Send aria-hidden="true" /> {t('support_reply_submit')}
                  </button>
                </div>
              </form>
            </section>
          </>
        )}
      </div>
    </main>
  );
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
const SupportTickets = () => {
  const { t, locale } = useLanguage();
  const { profile } = useAuth();
  const requesterId = profile?.id || null;

  const [loading, setLoading] = useState(true);
  const [tickets, setTickets] = useState([]);
  const [notice, setNotice] = useState(null);
  const [query, setQuery] = useState('');
  // Seeded once from a notification deep link's own "?ticket=<id>" — mirrors
  // OperationsPortal.jsx's own selectedOperationId convention exactly.
  const [selectedId, setSelectedId] = useState(
    () => new URLSearchParams(window.location.search).get('ticket') || null,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const listHeadingRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    loadMyTickets(requesterId).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setNotice({ tone: 'error', text: supportErrorMessage(t, error) });
        setLoading(false);
        return;
      }
      setTickets(data || []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [requesterId, reloadToken, t]);

  const visibleTickets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tickets;
    return tickets.filter((row) => (
      `${row.ticket_no || ''} ${row.subject || ''}`.toLowerCase().includes(needle)
    ));
  }, [tickets, query]);

  // Coming back to the list is the one transition this component itself has
  // to move focus for — the detail view's own effect handles focusing itself
  // when it mounts, same split OperationsPortal.jsx documents.
  useEffect(() => {
    if (!selectedId) listHeadingRef.current?.focus();
  }, [selectedId]);

  const submitCreate = async (draft) => {
    setCreateBusy(true);
    setCreateError('');
    const { data, error } = await createMyTicket(draft);
    setCreateBusy(false);
    if (error) { setCreateError(supportErrorMessage(t, error)); return; }
    setCreateOpen(false);
    setNotice({ tone: 'success', text: t('support_portal_create_success') });
    setReloadToken((token) => token + 1);
    if (data?.id) setSelectedId(data.id);
  };

  if (loading) {
    return (
      <div className="page-loader inline-loader">
        <span aria-hidden="true" />
        <span className="sr-only" role="status" aria-live="polite">{t('label_loading')}</span>
      </div>
    );
  }

  if (selectedId) {
    return (
      <TicketDetail
        ticketId={selectedId}
        t={t}
        locale={locale}
        onBack={() => { setSelectedId(null); setReloadToken((token) => token + 1); }}
      />
    );
  }

  return (
    <>
      <main className="support-portal-page app-main">
        <div className="vf-screen">
          <div className="vf-screen-head">
            <div>
              <span className="section-kicker">{t('support_module_kicker')}</span>
              <h1 ref={listHeadingRef} tabIndex={-1}><LifeBuoy className="sup-page-icon" aria-hidden="true" /> {t('support_portal_title')}</h1>
              <p>{t('support_portal_intro')}</p>
            </div>
            <button type="button" className="primary-button" onClick={() => { setCreateError(''); setCreateOpen(true); }}>
              <Plus aria-hidden="true" /> {t('support_portal_new_ticket')}
            </button>
          </div>

          {notice && (
            <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
              {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
              {notice.text}
              <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
            </div>
          )}

          <section className="vf-panel">
            <div className="vf-panel-head">
              <h2><LifeBuoy aria-hidden="true" /> {t('support_portal_list_title')}</h2>
              <div className="search-control compact">
                <Search aria-hidden="true" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('support_portal_search_placeholder')}
                  aria-label={t('action_search')}
                />
                {query && (
                  <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label={t('action_clear')}>
                    <X size={15} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>

            {!visibleTickets.length ? (
              <div className="empty-table">
                <LifeBuoy aria-hidden="true" />
                <b>{tickets.length ? t('label_no_results') : t('support_portal_empty')}</b>
              </div>
            ) : (
              <div className="sup-portal-list">
                {visibleTickets.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className="sup-portal-ticket-card"
                    onClick={() => setSelectedId(row.id)}
                  >
                    <span className="sup-portal-ticket-top">
                      <code>{row.ticket_no}</code>
                      <TicketStatusChip t={t} status={row.status} />
                      <TicketPriorityChip t={t} priority={row.priority} />
                    </span>
                    <b>{row.subject}</b>
                    <small>{codeLabel(t, 'support_cat', row.category, row.category)} · {formatDateTime(row.created_on, locale)}</small>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>

      {createOpen && (
        <NewTicketDialog
          t={t}
          busy={createBusy}
          error={createError}
          onClose={() => setCreateOpen(false)}
          onSubmit={submitCreate}
        />
      )}
    </>
  );
};

export default SupportTickets;
