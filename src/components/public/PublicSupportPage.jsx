import { useEffect, useId, useState } from 'react';
import { Link, useParams } from 'wouter';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertCircle, ArrowLeft, CheckCircle2, Headset, Info, LifeBuoy, Search, Send, Ticket,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import LanguageSwitcher from '../LanguageSwitcher';
import { codeLabel, formatDateTime } from '../../utils/localize';
import { SUPPORT_CATEGORIES, createTicket, ticketStatus } from '../../data/publicService';
import './public.css';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const Alert = ({ tone = 'error', icon: Icon = AlertCircle, children }) => (
  <p className={`bb-alert ${tone}`} role={tone === 'error' ? 'alert' : undefined}>
    <Icon aria-hidden="true" />
    <span>{children}</span>
  </p>
);

const LabelledInput = ({ label, hint, error, required, children }) => {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean).join(' ') || undefined;

  return (
    <div className="field-label">
      <label htmlFor={id}>
        {label}
        {required && <span className="bb-required" aria-hidden="true"> *</span>}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && <p className="field-note" id={`${id}-hint`}>{hint}</p>}
      {error && <p className="bb-field-error" id={`${id}-error`}><AlertCircle aria-hidden="true" />{error}</p>}
    </div>
  );
};

const PanelHead = ({ icon: Icon, title, text }) => (
  <div className="bb-panel-head">
    <span className="bb-panel-icon"><Icon aria-hidden="true" /></span>
    <div>
      <h2>{title}</h2>
      {text && <p>{text}</p>}
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Pane one — open a ticket
// ---------------------------------------------------------------------------

const CreateTicketPane = () => {
  const { t } = useLanguage();
  const reduce = useReducedMotion();

  const [values, setValues] = useState({
    category: SUPPORT_CATEGORIES[0],
    subject: '',
    message: '',
    name: '',
    email: '',
    companySlug: '',
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(null);

  const set = (patch) => setValues((current) => ({ ...current, ...patch }));

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);

    const found = {};
    if (!values.subject.trim()) found.subject = t('error_required_field');
    if (!values.message.trim()) found.message = t('error_required_field');
    if (!values.name.trim()) found.name = t('error_required_field');
    if (!EMAIL_PATTERN.test(values.email.trim())) found.email = t('error_invalid_email');
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    const { data, error } = await createTicket(values);
    setBusy(false);
    if (error) { setFailure(t('pub_ticket_error_create')); return; }
    setCreated(data);
  };

  const copy = async (value, which) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(() => setCopied(null), 2200);
    } catch {
      setCopied(null);
    }
  };

  if (created) {
    return (
      <motion.section
        className="bb-card bb-support-panel"
        initial={reduce ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduce ? 0 : 0.4 }}
        aria-live="polite"
      >
        <PanelHead icon={CheckCircle2} title={t('pub_ticket_created_title')} text={t('pub_ticket_created_text', { email: created.email })} />
        <div className="field-label">
          <span>{t('pub_ticket_number_label')}</span>
          <div className="bb-copy-row">
            <span className="bb-code bb-code-lg" dir="ltr">{created.ticket_no}</span>
            <button
              type="button"
              className="secondary-button"
              aria-label={t('pub_ticket_copy')}
              onClick={() => copy(created.ticket_no, 'number')}
            >
              {copied === 'number' ? t('action_copied') : t('action_copy')}
            </button>
          </div>
        </div>

        {created.access_token && (
          <div className="field-label">
            <span>{t('pub_ticket_token_label')}</span>
            <div className="bb-copy-row">
              <span className="bb-code" dir="ltr">{created.access_token}</span>
              <button
                type="button"
                className="secondary-button"
                aria-label={t('pub_ticket_copy_token')}
                onClick={() => copy(created.access_token, 'token')}
              >
                {copied === 'token' ? t('action_copied') : t('action_copy')}
              </button>
            </div>
            <p className="field-note">{t('pub_ticket_token_help')}</p>
          </div>
        )}
        <button
          type="button"
          className="secondary-button"
          onClick={() => { setCreated(null); setValues((current) => ({ ...current, subject: '', message: '' })); }}
        >
          {t('pub_ticket_open_another')}
        </button>
      </motion.section>
    );
  }

  return (
    <section className="bb-card bb-support-panel">
      <PanelHead icon={Headset} title={t('pub_support_create_title')} />
      <form className="bb-form-stack" onSubmit={submit} noValidate>
        <div aria-live="polite">{failure && <Alert>{failure}</Alert>}</div>

        <LabelledInput label={t('pub_field_ticket_category')} required>
          {({ id }) => (
            <select
              id={id}
              className="form-input"
              value={values.category}
              onChange={(event) => set({ category: event.target.value })}
            >
              {SUPPORT_CATEGORIES.map((code) => (
                <option key={code} value={code}>{t(`pub_ticket_category_${code}`)}</option>
              ))}
            </select>
          )}
        </LabelledInput>

        <LabelledInput label={t('pub_field_ticket_subject')} error={errors.subject} required>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className={`form-input${invalid ? ' bb-invalid' : ''}`}
              value={values.subject}
              placeholder={t('pub_field_ticket_subject_placeholder')}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(event) => set({ subject: event.target.value })}
            />
          )}
        </LabelledInput>

        <LabelledInput label={t('pub_field_ticket_message')} error={errors.message} required>
          {({ id, describedBy, invalid }) => (
            <textarea
              id={id}
              className={`form-input${invalid ? ' bb-invalid' : ''}`}
              value={values.message}
              placeholder={t('pub_field_ticket_message_placeholder')}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(event) => set({ message: event.target.value })}
            />
          )}
        </LabelledInput>

        <LabelledInput label={t('pub_field_ticket_name')} error={errors.name} required>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className={`form-input${invalid ? ' bb-invalid' : ''}`}
              value={values.name}
              autoComplete="name"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(event) => set({ name: event.target.value })}
            />
          )}
        </LabelledInput>

        <LabelledInput label={t('pub_field_ticket_email')} error={errors.email} required>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="email"
              className={`form-input${invalid ? ' bb-invalid' : ''}`}
              value={values.email}
              autoComplete="email"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(event) => set({ email: event.target.value })}
            />
          )}
        </LabelledInput>

        <LabelledInput label={t('pub_field_ticket_company')} hint={t('pub_field_ticket_company_help')}>
          {({ id, describedBy }) => (
            <input
              id={id}
              className="form-input"
              value={values.companySlug}
              dir="ltr"
              spellCheck="false"
              autoCapitalize="none"
              aria-describedby={describedBy}
              onChange={(event) => set({ companySlug: event.target.value.toLowerCase().replace(/[^a-z0-9]/g, '') })}
            />
          )}
        </LabelledInput>

        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? t('pub_ticket_submitting') : t('pub_ticket_submit')}
          {!busy && <Send size={16} aria-hidden="true" />}
        </button>
      </form>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Pane two — check a ticket
// ---------------------------------------------------------------------------

const TicketThread = ({ ticket }) => {
  const { t, locale } = useLanguage();
  const messages = ticket.messages || [];

  return (
    <div className="bb-ticket-result">
      <div className="bb-ticket-meta">
        <div>
          <span>{t('pub_ticket_number_label')}</span>
          <b className="verify-code">{ticket.ticket_no}</b>
        </div>
        <div>
          <span>{t('label_status')}</span>
          <b>{codeLabel(t, 'status', ticket.status, ticket.status)}</b>
        </div>
        <div>
          <span>{t('pub_field_ticket_category')}</span>
          <b>{t(`pub_ticket_category_${String(ticket.category || 'other').toLowerCase()}`)}</b>
        </div>
        <div>
          <span>{t('pub_ticket_opened_on')}</span>
          <b>{formatDateTime(ticket.created_on, locale) || '—'}</b>
        </div>
      </div>

      <div className="field-label">
        <span>{t('pub_field_ticket_subject')}</span>
        <b>{ticket.subject || '—'}</b>
      </div>

      <div className="field-label">
        <span>{t('pub_ticket_thread')}</span>
        {messages.length === 0 ? (
          <p className="field-note">{t('pub_ticket_no_replies')}</p>
        ) : (
          <ul className="bb-thread">
            {messages.map((message, index) => {
              const fromSupport = String(message.author || '').toLowerCase() !== 'requester';
              return (
                <li key={message.id || index} className={fromSupport ? 'support' : ''}>
                  <div className="bb-thread-head">
                    <b>{fromSupport ? t('pub_ticket_reply_from_support') : t('pub_ticket_reply_from_you')}</b>
                    <small>{formatDateTime(message.created_on, locale)}</small>
                  </div>
                  <p>{message.body}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

const CheckTicketPane = ({ prefilledTicket }) => {
  const { t } = useLanguage();
  const reduce = useReducedMotion();

  const [ticketNo, setTicketNo] = useState(prefilledTicket || '');
  const [accessToken, setAccessToken] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [ticket, setTicket] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);
    setTicket(null);

    const found = {};
    if (!ticketNo.trim()) found.ticketNo = t('error_required_field');
    if (!accessToken.trim()) found.accessToken = t('error_required_field');
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    const { data, error } = await ticketStatus({ ticketNo, accessToken });
    setBusy(false);
    if (error) {
      setFailure(error.message === 'NOT_FOUND' ? t('pub_ticket_not_found') : t('pub_ticket_error_lookup'));
      return;
    }
    setTicket(data);
  };

  return (
    <section className="bb-card bb-support-panel">
      <PanelHead icon={Search} title={t('pub_support_check_title')} text={t('pub_support_check_help')} />

      {prefilledTicket && <Alert tone="info" icon={Info}>{t('pub_ticket_prefill_note')}</Alert>}

      <form className="bb-form-stack" onSubmit={submit} noValidate>
        <LabelledInput label={t('pub_field_ticket_number')} error={errors.ticketNo} required>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className={`form-input verify-code${invalid ? ' bb-invalid' : ''}`}
              value={ticketNo}
              dir="ltr"
              spellCheck="false"
              autoCapitalize="characters"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(event) => setTicketNo(event.target.value.toUpperCase())}
            />
          )}
        </LabelledInput>

        <LabelledInput label={t('pub_field_ticket_token')} error={errors.accessToken} required hint={t('pub_field_ticket_token_help')}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className={`form-input verify-code${invalid ? ' bb-invalid' : ''}`}
              value={accessToken}
              dir="ltr"
              spellCheck="false"
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(event) => setAccessToken(event.target.value.trim())}
            />
          )}
        </LabelledInput>

        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? t('label_loading') : t('pub_ticket_lookup')}
          {!busy && <Search size={16} aria-hidden="true" />}
        </button>
      </form>

      <div aria-live="polite">
        {failure && <Alert>{failure}</Alert>}
        <AnimatePresence initial={false}>
          {ticket && (
            <motion.div
              key={ticket.ticket_no}
              initial={reduce ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -10 }}
              transition={{ duration: reduce ? 0 : 0.32 }}
            >
              <TicketThread ticket={ticket} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const PublicSupportPage = () => {
  const { t, isRtl } = useLanguage();
  const params = useParams();
  const prefilledTicket = (params?.ticket || '').toUpperCase();

  // On a phone the two panes share the screen, so a tab picks between them.
  const [pane, setPane] = useState(prefilledTicket ? 'check' : 'create');

  useEffect(() => {
    document.title = `${t('pub_support_title')} · ${t('platform_brand')}`;
  }, [t]);

  return (
    <div className="bb-page">
      <header className="bb-header">
        <div className="bb-shell bb-header-inner">
          <Link href="/portal" className="bb-wordmark" aria-label={t('pub_home')}>
            <span className="bb-wordmark-slot" aria-hidden="true">{t('platform_brand').slice(0, 1)}</span>
            <span><b>{t('platform_brand')}</b><small>{t('platform_tagline')}</small></span>
          </Link>
          <div className="bb-header-actions">
            <LanguageSwitcher />
            <Link href="/signup" className="primary-button"><span>{t('pub_subscribe')}</span></Link>
          </div>
        </div>
      </header>

      <main className="bb-shell bb-form-page">
        <div className="bb-form-head">
          <Link href="/portal" className="bb-back-link">
            <ArrowLeft size={16} className={isRtl ? 'flip-ltr' : ''} aria-hidden="true" />
            {t('pub_signup_back_to_portal')}
          </Link>
          <h1>
            <LifeBuoy size={26} aria-hidden="true" style={{ verticalAlign: '-4px', marginInlineEnd: 10, color: 'var(--brand)' }} />
            {t('pub_support_title')}
          </h1>
          <p>{t('pub_support_subtitle')}</p>
        </div>

        {/* Visible only on a phone, where the two panes cannot sit side by side. */}
        <div className="segmented bb-support-tabs">
          <button
            type="button"
            aria-pressed={pane === 'create'}
            className={pane === 'create' ? 'active' : ''}
            onClick={() => setPane('create')}
          >
            <Ticket size={15} aria-hidden="true" /> {t('pub_support_tab_create')}
          </button>
          <button
            type="button"
            aria-pressed={pane === 'check'}
            className={pane === 'check' ? 'active' : ''}
            onClick={() => setPane('check')}
          >
            <Search size={15} aria-hidden="true" /> {t('pub_support_tab_check')}
          </button>
        </div>

        <div className="bb-support-layout" data-pane={pane}>
          <CreateTicketPane />
          <CheckTicketPane prefilledTicket={prefilledTicket} />
        </div>
      </main>
    </div>
  );
};

export default PublicSupportPage;
