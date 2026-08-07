// The public verification page.
//
// It answers one question for a stranger holding a printed document: was this
// issued by that company, and is it still valid? It lives outside every company
// workspace (bbnovix.com/verify) but a company address resolves it too, so a
// code printed with the company URL keeps working.
//
// Three address shapes are supported, because printed paper outlives software:
//   /verify/{code}      the current form
//   /verify?code={code} links produced before the path form existed
//   #/verify?code=...   the legacy hash router
//
// Everything comes from one anonymous RPC — public.verify_document — including
// the approval timeline of an approved request, which is what this page showed
// before documents existed and still shows today.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'wouter';
import {
  Building2, ExternalLink, FileCheck2, Link2, Printer, ScanSearch, Search,
  ShieldAlert, ShieldCheck, ShieldQuestion, X,
} from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { formatDate, formatDateTime, pickFromMap, pickLocalized } from '../utils/localize';
import { ACTION_KEYS } from '../utils/approval';
import { safeExternalUrl } from '../utils/safeUrl';
import { parseLocation, publicPath, tenantPath, verifyUrl } from '../lib/routing';
import {
  DOC_TYPE_LABEL_KEYS, VERDICT_LABEL_KEYS, verdictOf, verifyDocument,
} from '../data/verificationService';
import VerifiedSeal, { CopyButton, DocumentStatusChip } from './verification/VerifiedSeal';
import './verification/verification.css';

const VERDICT_ICONS = {
  VALID: ShieldCheck,
  NOT_FOUND: ShieldAlert,
  REVOKED: ShieldAlert,
  EXPIRED: ShieldQuestion,
  NOT_PUBLISHED: ShieldQuestion,
  NOT_APPROVED: ShieldQuestion,
};

/** A code may arrive in the query string or in a legacy hash fragment. */
const codeFromAddress = () => {
  const fromSearch = new URLSearchParams(window.location.search).get('code');
  if (fromSearch) return fromSearch.trim();

  const hash = window.location.hash || '';
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return '';
  return (new URLSearchParams(hash.slice(queryIndex + 1)).get('code') || '').trim();
};

// ---------------------------------------------------------------------------

const InfoField = ({ label, children }) => (
  <div className="info-field">
    <span>{label}</span>
    <b>{children}</b>
  </div>
);

const CompanyStrip = ({ company }) => {
  const { t, lang } = useLanguage();
  const name = pickFromMap(company?.names, lang, 'ar', '');
  const logo = company?.logo_light_url || company?.logo_dark_url || null;

  return (
    <div className="vf-company-strip">
      <span className="vf-company-logo">
        {logo
          ? <img src={logo} alt={t('vf_company_logo_alt', { company: name })} />
          : <Building2 aria-hidden="true" />}
      </span>
      <div>
        <span className="section-kicker">{t('vf_issuing_company')}</span>
        <b>{name || company?.slug || t('label_unavailable')}</b>
      </div>
    </div>
  );
};

const ApprovalTimeline = ({ timeline }) => {
  const { t, lang, locale } = useLanguage();
  if (!timeline?.length) return null;

  return (
    <div className="approval-timeline verify-timeline">
      <h3><FileCheck2 aria-hidden="true" /> {t('approval_history_title')}</h3>
      <ol>
        {timeline.map((entry) => (
          <li key={`${entry.seq}-${entry.created_on}`} className="timeline-item tone-submit">
            <span className="timeline-dot" />
            <div className="timeline-body">
              <div className="timeline-head">
                <b>{entry.actor_name}</b>
                <span className="timeline-action">{t(ACTION_KEYS[entry.action] || entry.action)}</span>
                {pickLocalized(entry, 'role_name', lang) && (
                  <span className="timeline-role">{pickLocalized(entry, 'role_name', lang)}</span>
                )}
                {entry.to_user_name && <span className="timeline-target">{entry.to_user_name}</span>}
              </div>
              <small>{formatDateTime(entry.created_on, locale)}</small>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
};

const VerificationResult = ({ result }) => {
  const { t, lang, locale } = useLanguage();
  const verdict = verdictOf(result);
  const wording = VERDICT_LABEL_KEYS[verdict];
  const Icon = VERDICT_ICONS[verdict] || ShieldAlert;

  if (verdict === 'NOT_FOUND') {
    return (
      <div className={`verify-result ${wording.tone}`} role="status">
        <Icon aria-hidden="true" />
        <div>
          <b>{t(wording.title)}</b>
          <p>{t(wording.hint)}</p>
        </div>
      </div>
    );
  }

  const title = pickLocalized(result, 'title', lang);
  const subject = pickLocalized(result, 'subject', lang);
  const typeKey = DOC_TYPE_LABEL_KEYS[result.doc_type] || 'vf_doctype_custom';

  return (
    <div className="verify-result-block">
      <div className={`verify-result ${wording.tone}`} role="status">
        <Icon aria-hidden="true" />
        <div>
          <b>{t(wording.title)}</b>
          <p>{t(wording.hint)}</p>
        </div>
      </div>

      <div className="vf-result-head">
        <CompanyStrip company={result.company} />
        <VerifiedSeal
          code={result.code}
          sealStyle={result.seal_style}
          size={104}
          qrSize={88}
          showHint={false}
        />
      </div>

      <div className="request-details-meta">
        <InfoField label={t('vf_document_type')}>{t(typeKey)}</InfoField>
        <InfoField label={t('vf_document_title')}>{title || '—'}</InfoField>
        <InfoField label={t('label_status')}><DocumentStatusChip status={result.status} /></InfoField>
        <InfoField label={t('vf_holder')}>{result.holder_name || '—'}</InfoField>
        <InfoField label={t('vf_issued_on')}>{formatDate(result.issued_on, locale) || '—'}</InfoField>
        <InfoField label={t('vf_valid_until')}>
          {result.valid_until ? formatDate(result.valid_until, locale) : t('vf_no_expiry')}
        </InfoField>
        {result.reference_no && <InfoField label={t('reference')}>{result.reference_no}</InfoField>}
        <InfoField label={t('vf_document_code')}>
          <span className="verify-code" dir="ltr">{result.code}</span>
        </InfoField>
      </div>

      {subject && (
        <div className="vf-document-body">
          <span className="section-kicker">{t('vf_subject')}</span>
          <p>{subject}</p>
        </div>
      )}

      {safeExternalUrl(result.file_url) && (
        <a className="secondary-button no-print vf-file-link" href={safeExternalUrl(result.file_url)} target="_blank" rel="noreferrer">
          <ExternalLink aria-hidden="true" /> {t('vf_open_file')}
        </a>
      )}

      <ApprovalTimeline timeline={result.timeline} />
    </div>
  );
};

// ---------------------------------------------------------------------------

const VerifyRequestPage = () => {
  const { t, locale } = useLanguage();
  const params = useParams();
  const [, navigate] = useLocation();

  const routeCode = (params?.code ? decodeURIComponent(params.code) : '') || codeFromAddress();
  const [code, setCode] = useState(routeCode);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lastLookup = useRef('');
  const requestId = useRef(0);

  const lookup = useCallback(async (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;

    lastLookup.current = trimmed;
    const thisRequest = ++requestId.current;
    setBusy(true);
    setError('');
    setResult(null);

    const { data, error: failure } = await verifyDocument(trimmed);
    // A newer lookup (route change or resubmission) started while this one
    // was in flight — its response is stale, discard it rather than
    // overwriting whatever the newer request already showed.
    if (thisRequest !== requestId.current) return;
    setBusy(false);
    if (failure) {
      setError(t('vf_err_verify_failed'));
      return;
    }
    setResult({ ...data, code: data.code || trimmed });
  }, [t]);

  useEffect(() => {
    if (!routeCode || routeCode === lastLookup.current) return;
    setCode(routeCode);
    lookup(routeCode);
  }, [routeCode, lookup]);

  const submit = (event) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    lookup(trimmed);
    if (trimmed !== routeCode) navigate(`/verify/${encodeURIComponent(trimmed)}`, { replace: true });
  };

  const entry = parseLocation();
  const homeHref = entry.scope === 'tenant' && entry.slug ? tenantPath(entry.slug) : publicPath('portal');
  const homeLabel = entry.scope === 'tenant' && entry.slug ? t('back_to_portal') : t('go_to_platform');
  const shareUrl = result?.code ? verifyUrl(result.code) : '';

  return (
    <main className="verify-page">
      <div className="verify-card">
        <header className="verify-header">
          <span className="vf-brand-mark" aria-hidden="true"><ShieldCheck /></span>
          <div>
            <span className="section-kicker"><ScanSearch size={14} aria-hidden="true" /> {t('vf_public_kicker')}</span>
            <h1>{t('vf_public_title')}</h1>
            <p>{t('vf_public_intro')}</p>
          </div>
        </header>

        <form className="verify-form no-print" onSubmit={submit}>
          <label className="field-label" htmlFor="verify-code-input">
            {t('verify_code_label')}
            <div className="verify-input-row">
              <input
                id="verify-code-input"
                className="form-input verify-input"
                dir="ltr"
                autoComplete="off"
                spellCheck="false"
                placeholder={t('vf_code_placeholder')}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <button type="submit" className="primary-button" disabled={busy || !code.trim()}>
                <Search aria-hidden="true" /> {busy ? t('label_loading') : t('verify_button')}
              </button>
            </div>
          </label>
        </form>

        {/* Announces only the busy state — once a result lands, VerificationResult's
            own role="status" panel already announces the verdict title; duplicating
            it here would fire the same announcement twice. */}
        <p className="sr-only" role="status" aria-live="polite">
          {busy ? t('vf_verifying') : ''}
        </p>

        {error && (
          <div className="inline-message error no-print">
            <ShieldAlert aria-hidden="true" />
            {error}
            <button type="button" onClick={() => setError('')} aria-label={t('action_close')}>
              <X aria-hidden="true" />
            </button>
          </div>
        )}

        {result && <VerificationResult result={result} />}

        {result && result.valid && (
          <div className="vf-public-actions no-print">
            <CopyButton value={shareUrl} label={t('vf_copy_link')} icon={Link2} variant="button" />
            <button type="button" className="secondary-button" onClick={() => window.print()}>
              <Printer aria-hidden="true" /> {t('action_print')}
            </button>
          </div>
        )}

        {result && (
          <p className="print-only vf-print-note">
            {t('vf_printed_note', { date: formatDateTime(new Date(), locale) })}
          </p>
        )}

        <footer className="verify-footer no-print">
          <a href={homeHref}><Link2 size={14} aria-hidden="true" /> {homeLabel}</a>
        </footer>
      </div>
    </main>
  );
};

export default VerifyRequestPage;
