import { useEffect, useState } from 'react';
import { BadgeCheck, Link as LinkIcon, ScanSearch, Search, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { Link } from 'wouter';
import { useLanguage } from '../context/LanguageContext';
import { verifyApprovalCode } from '../data/approvalService';
import { ACTION_KEYS, useArabicName } from '../utils/approval';
import { ApprovalStatusBadge } from './ApprovalCenter';
import logo from '../assets/logo.png';

const codeFromHash = () => {
  const hash = window.location.hash || '';
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return '';
  return new URLSearchParams(hash.slice(queryIndex + 1)).get('code') || '';
};

const VerifyRequestPage = () => {
  const { t, locale, lang } = useLanguage();
  const { roleNameFromRow } = useArabicName();
  const [code, setCode] = useState(codeFromHash);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const lookup = async (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const data = await verifyApprovalCode(trimmed);
      setResult(data);
    } catch (lookupError) {
      setError(lookupError.message || t('operation_failed'));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const initial = codeFromHash();
    if (!initial) return undefined;
    let cancelled = false;
    verifyApprovalCode(initial)
      .then((data) => { if (!cancelled) setResult(data); })
      .catch((lookupError) => { if (!cancelled) setError(lookupError.message || 'operation failed'); });
    return () => { cancelled = true; };
  }, []);

  const templateName = result && (lang === 'ar' || lang === 'ur'
    ? result.template_name_ar || result.template_name
    : result.template_name_en || result.template_name);

  return (
    <main className="verify-page">
      <div className="verify-card">
        <header className="verify-header">
          <img src={logo} alt="Shalfa" />
          <div>
            <span className="section-kicker"><ScanSearch size={14} /> ShalfaGate</span>
            <h1>{t('verify_title')}</h1>
            <p>{t('verify_intro')}</p>
          </div>
        </header>

        <form
          className="verify-form"
          onSubmit={(event) => { event.preventDefault(); lookup(code); }}
        >
          <label className="field-label">{t('verify_code_label')}
            <div className="verify-input-row">
              <input
                className="form-input verify-input"
                inputMode="numeric"
                dir="ltr"
                placeholder="1XXXXXXXXXXXXXX"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <button className="primary-button" disabled={busy || !code.trim()}><Search /> {busy ? t('loading') : t('verify_button')}</button>
            </div>
          </label>
        </form>

        {error && <div className="inline-message error"><X />{error}<button onClick={() => setError('')}><X /></button></div>}

        {result && !result.valid && (
          <div className="verify-result invalid">
            <ShieldAlert />
            <div>
              <b>{t('verify_not_found')}</b>
              <p>{t('verify_not_found_hint')}</p>
            </div>
          </div>
        )}

        {result?.valid && (
          <div className="verify-result-block">
            <div className="verify-result valid">
              <ShieldCheck />
              <div>
                <b>{t('verify_valid')}</b>
                <p>{t('verify_valid_hint')}</p>
              </div>
            </div>
            <div className="request-details-meta">
              <div className="info-field"><span>{t('forms')}</span><b>{templateName || '—'}</b></div>
              <div className="info-field"><span>{t('reference')}</span><b>{result.reference_no || '—'}</b></div>
              <div className="info-field"><span>{t('verify_code_label')}</span><b className="verify-code">{result.verify_code}</b></div>
              <div className="info-field"><span>{t('status')}</span><b><ApprovalStatusBadge status={result.status} /></b></div>
              <div className="info-field"><span>{t('requested_by')}</span><b>{result.requester_name || '—'}</b></div>
              <div className="info-field"><span>{t('beneficiary_employee')}</span><b>{result.employee_name || '—'}</b></div>
            </div>
            <div className="approval-timeline verify-timeline">
              <h3><BadgeCheck /> {t('approval_history_title')}</h3>
              <ol>
                {(result.timeline || []).map((tx) => (
                  <li key={tx.seq} className="timeline-item tone-submit">
                    <span className="timeline-dot" />
                    <div className="timeline-body">
                      <div className="timeline-head">
                        <b>{tx.actor_name}</b>
                        <span className="timeline-action">{t(ACTION_KEYS[tx.action] || tx.action)}</span>
                        {roleNameFromRow(tx) && <span className="timeline-role">{roleNameFromRow(tx)}</span>}
                        {tx.to_user_name && <span className="timeline-target">← {tx.to_user_name}</span>}
                      </div>
                      <small>{new Date(tx.created_on).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}</small>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}

        <footer className="verify-footer">
          <Link href="/login"><LinkIcon size={14} /> {t('back_to_portal')}</Link>
        </footer>
      </div>
    </main>
  );
};

export default VerifyRequestPage;
