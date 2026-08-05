import { useEffect, useMemo, useState } from 'react';
import { LifeBuoy, Search, Send, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import {
  errorCode, loadSupportConsole, loadSupportTicket, replySupportTicket,
  setSupportTicketStatus, SUPPORT_CATEGORIES, SUPPORT_SOURCES, SUPPORT_STATUSES,
} from '../../data/platformService';
import { codeLabel, formatDateTime, formatNumber, formatRelative, pickFromMap } from '../../utils/localize';

const StatusChip = ({ status }) => {
  const { t } = useLanguage();
  const tone = status === 'Closed' ? 'pc-chip-disabled'
    : status === 'Answered' ? 'pc-chip-active'
      : status === 'InProgress' ? 'pc-chip-pending' : 'pc-chip-brand';
  return <span className={`pc-chip ${tone}`}>{codeLabel(t, 'status', status, status)}</span>;
};

// ---------------------------------------------------------------------------

const TicketQueue = ({ tickets, selectedId, onSelect }) => {
  const { t, lang, locale } = useLanguage();

  if (tickets.length === 0) {
    return (
      <div className="pc-queue">
        <div className="empty-table compact">
          <LifeBuoy aria-hidden="true" />
          <b>{t('pc_no_tickets')}</b>
        </div>
      </div>
    );
  }

  return (
    <div className="pc-queue" role="group" aria-label={t('pc_ticket_queue')}>
      {tickets.map((ticket) => (
        <button
          key={ticket.id}
          type="button"
          className={ticket.id === selectedId ? 'active' : ''}
          aria-current={ticket.id === selectedId ? 'true' : undefined}
          onClick={() => onSelect(ticket.id)}
        >
          <span className="pc-queue-top">
            <code>{ticket.ticket_no}</code>
            <StatusChip status={ticket.status} />
            <span className="pc-chip">{codeLabel(t, 'pc_source', ticket.source === 'InApp' ? 'inapp' : 'public', ticket.source)}</span>
          </span>
          <b>{ticket.subject}</b>
          <small>
            {pickFromMap(ticket.tenant_names, lang, 'ar', ticket.requester_tenant_slug || ticket.tenant_slug || '')}
            {' · '}
            {ticket.requester_name || ticket.requester_email}
            {' · '}
            {formatRelative(ticket.created_on, locale)}
          </small>
        </button>
      ))}
    </div>
  );
};

const Thread = ({ messages }) => {
  const { t, locale } = useLanguage();
  if (!messages.length) return <p className="field-note">{t('label_no_results')}</p>;
  return (
    <div className="pc-thread">
      {messages.map((message) => (
        <article
          key={message.id}
          className={`pc-message ${message.author_type === 'Operator' ? 'pc-message-operator' : ''} ${message.is_internal ? 'pc-message-internal' : ''}`}
        >
          <div className="pc-message-head">
            <b>{message.author_name || t(message.author_type === 'Operator' ? 'pc_author_operator' : 'pc_author_requester')}</b>
            <small>{formatDateTime(message.created_on, locale)}</small>
            {message.is_internal ? <span className="pc-chip pc-chip-pending">{t('pc_internal_badge')}</span> : null}
          </div>
          <p>{message.body}</p>
        </article>
      ))}
    </div>
  );
};

const Composer = ({ busy, onSend }) => {
  const { t } = useLanguage();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);

  return (
    <div className="pc-composer">
      <label className="field-label" htmlFor="pc-reply">
        <span className="sr-only">{t('pc_reply_placeholder')}</span>
        <textarea
          id="pc-reply"
          className="form-input"
          rows={4}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={t('pc_reply_placeholder')}
        />
      </label>
      <div className="pc-composer-actions">
        <label className="pc-checkbox">
          <input
            type="checkbox"
            checked={internal}
            onChange={(event) => setInternal(event.target.checked)}
          />
          {t('pc_internal_note')}
        </label>
        <button
          type="button"
          className="primary-button"
          disabled={busy || !body.trim()}
          onClick={async () => {
            const sent = await onSend(body, internal);
            if (sent) setBody('');
          }}
        >
          <Send aria-hidden="true" /> {t(internal ? 'pc_save_note' : 'pc_send_reply')}
        </button>
      </div>
    </div>
  );
};

const TicketDetail = ({ detail, summary, busy, onReply, onStatus }) => {
  const { t, lang, locale } = useLanguage();
  const ticket = detail?.ticket;

  if (!ticket) {
    return (
      <section className="pc-panel">
        <div className="empty-table">
          <LifeBuoy aria-hidden="true" />
          <b>{t('pc_select_ticket')}</b>
        </div>
      </section>
    );
  }

  return (
    <section className="pc-panel">
      <header>
        <div>
          <span className="section-kicker">{ticket.ticket_no}</span>
          <h2>{ticket.subject}</h2>
          <p>
            {pickFromMap(summary?.tenant_names, lang, 'ar', summary?.requester_tenant_slug || summary?.tenant_slug || ticket.requester_email)}
            {' · '}
            {ticket.requester_name || ticket.requester_email}
            {' · '}
            {t('pc_opened_on')}: {formatDateTime(ticket.created_on, locale)}
            {ticket.first_response_on ? ` · ${t('pc_first_response')}: ${formatDateTime(ticket.first_response_on, locale)}` : ''}
          </p>
        </div>
        <StatusChip status={ticket.status} />
      </header>

      <div className="pc-facts">
        <div className="pc-fact"><span>{t('pc_filter_source')}</span><b>{codeLabel(t, 'pc_source', ticket.source === 'InApp' ? 'inapp' : 'public', ticket.source)}</b></div>
        <div className="pc-fact"><span>{t('pc_filter_category')}</span><b>{codeLabel(t, 'pc_cat', ticket.category, ticket.category)}</b></div>
        <div className="pc-fact"><span>{t('contact_email')}</span><b>{ticket.requester_email}</b></div>
      </div>

      <Thread messages={detail.messages || []} />

      <Composer busy={busy} onSend={onReply} />

      <div className="pc-actions">
        <label className="sr-only" htmlFor="pc-ticket-status">{t('pc_set_status')}</label>
        <select
          id="pc-ticket-status"
          className="pc-select"
          value={ticket.status}
          disabled={busy}
          onChange={(event) => onStatus(event.target.value)}
        >
          {SUPPORT_STATUSES.map((code) => (
            <option key={code} value={code}>{codeLabel(t, 'status', code, code)}</option>
          ))}
        </select>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------

const SupportConsole = () => {
  const { t, locale } = useLanguage();
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [board, setBoard] = useState({ counts: {}, tickets: [] });
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState({ tone: 'ok', text: '' });

  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadSupportConsole(status || null).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setFeedback({ tone: 'error', text: codeLabel(t, 'pc_err', errorCode(error), t('error_generic')) });
      } else {
        setBoard({ counts: data?.counts || {}, tickets: data?.tickets || [] });
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [status, reloadToken, t]);

  useEffect(() => {
    if (!selectedId) return undefined;

    let cancelled = false;
    loadSupportTicket(selectedId).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setFeedback({ tone: 'error', text: codeLabel(t, 'pc_err', errorCode(error), t('error_generic')) });
        setDetail(null);
        return;
      }
      setDetail(data);
    });
    return () => { cancelled = true; };
  }, [selectedId, reloadToken, t]);

  const tickets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return board.tickets
      .filter((row) => (source ? row.source === source : true))
      .filter((row) => (category ? row.category === category : true))
      .filter((row) => (
        !needle
        || String(row.ticket_no || '').toLowerCase().includes(needle)
        || String(row.subject || '').toLowerCase().includes(needle)
        || String(row.requester_email || '').toLowerCase().includes(needle)
        || String(row.requester_name || '').toLowerCase().includes(needle)
      ));
  }, [board.tickets, source, category, query]);

  const run = async (action, successText) => {
    setBusy(true);
    const { error } = await action();
    if (error) {
      setFeedback({ tone: 'error', text: codeLabel(t, 'pc_err', errorCode(error), t('error_generic')) });
      setBusy(false);
      return false;
    }
    setFeedback({ tone: 'ok', text: successText });
    setReloadToken((token) => token + 1);
    setBusy(false);
    return true;
  };

  const counts = board.counts || {};

  return (
    <div className="pc-console">
      <p className="field-note">{t('pc_support_intro')}</p>

      <div className="kpi-grid compact">
        <div className="kpi-card"><LifeBuoy aria-hidden="true" /><div><span>{t('pc_tickets_open')}</span><b>{formatNumber(counts.open || 0, locale)}</b></div></div>
        <div className="kpi-card"><LifeBuoy aria-hidden="true" /><div><span>{t('pc_tickets_unanswered')}</span><b>{formatNumber(counts.unanswered || 0, locale)}</b></div></div>
        <div className="kpi-card"><LifeBuoy aria-hidden="true" /><div><span>{t('pc_tickets_unassigned')}</span><b>{formatNumber(counts.unassigned || 0, locale)}</b></div></div>
        <div className="kpi-card"><LifeBuoy aria-hidden="true" /><div><span>{t('pc_tickets_closed')}</span><b>{formatNumber(counts.closed || 0, locale)}</b></div></div>
      </div>

      <div className="pc-toolbar">
        <label className="search-control">
          <Search aria-hidden="true" />
          <span className="sr-only">{t('action_search')}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('pc_ticket_search')}
          />
          {query ? (
            <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label={t('action_clear')}>
              <X aria-hidden="true" width={13} height={13} />
            </button>
          ) : null}
        </label>

        <label className="sr-only" htmlFor="pc-support-status">{t('label_status')}</label>
        <select id="pc-support-status" className="pc-select" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">{t('label_all')}</option>
          {SUPPORT_STATUSES.map((code) => (
            <option key={code} value={code}>{codeLabel(t, 'status', code, code)}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="pc-support-source">{t('pc_filter_source')}</label>
        <select id="pc-support-source" className="pc-select" value={source} onChange={(event) => setSource(event.target.value)}>
          <option value="">{t('pc_filter_source')}</option>
          {SUPPORT_SOURCES.map((code) => (
            <option key={code} value={code}>{codeLabel(t, 'pc_source', code === 'InApp' ? 'inapp' : 'public', code)}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="pc-support-category">{t('pc_filter_category')}</label>
        <select id="pc-support-category" className="pc-select" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="">{t('pc_filter_category')}</option>
          {SUPPORT_CATEGORIES.map((code) => (
            <option key={code} value={code}>{codeLabel(t, 'pc_cat', code, code)}</option>
          ))}
        </select>

        <span className="pc-count">{formatNumber(tickets.length, locale)}</span>
      </div>

      <div aria-live="polite" className={`pc-status-line ${feedback.tone === 'error' ? 'pc-error' : ''}`}>
        {loading ? t('label_loading') : feedback.text}
      </div>

      <div className="pc-support">
        <TicketQueue tickets={tickets} selectedId={selectedId} onSelect={setSelectedId} />
        <TicketDetail
          detail={detail}
          summary={board.tickets.find((row) => row.id === selectedId) || null}
          busy={busy}
          onReply={(body, internal) => run(
            () => replySupportTicket(selectedId, body, internal),
            t('pc_saved'),
          )}
          onStatus={(next) => run(() => setSupportTicketStatus(selectedId, next), t('pc_saved'))}
        />
      </div>
    </div>
  );
};

export default SupportConsole;
