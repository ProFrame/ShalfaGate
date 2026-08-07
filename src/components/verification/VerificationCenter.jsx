// The verification centre.
//
// One tab with its own side banner: attestations, certificates, certificate
// templates and the company's verification settings. The address decides which
// one is open (/app/verification/:section) so a section can be linked, shared
// and bookmarked like any other page.

import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import {
  Award, ExternalLink, FileBadge, Link2, Loader2, Save,
  ScanSearch, Stamp, ShieldCheck, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { verifyUrl } from '../../lib/routing';
import {
  loadVerificationSettings, saveVerificationSettings, verificationErrorKey,
} from '../../data/verificationService';
import AttestationsScreen from './AttestationsScreen';
import CertificatesScreen from './CertificatesScreen';
import CertificateDesigner from './CertificateDesigner';
import { CopyButton } from './VerifiedSeal';
import './verification.css';

// Icon choices here deliberately match AdminNav.jsx's own 'verification'
// group (FileBadge/Award/Stamp/ShieldCheck) — these four screens are each
// reachable from both places, and a prior drift (FileSignature/LayoutTemplate/
// Settings2 here vs. AdminNav's own choices) meant the same screen showed a
// different icon depending which nav you clicked it from.
const SECTIONS = [
  { id: 'attestations', icon: FileBadge, labelKey: 'vf_nav_attestations', hintKey: 'vf_nav_attestations_hint', module: 'VERIFICATION' },
  { id: 'certificates', icon: Award, labelKey: 'vf_nav_certificates', hintKey: 'vf_nav_certificates_hint', module: 'CERTIFICATES' },
  { id: 'templates', icon: Stamp, labelKey: 'vf_nav_templates', hintKey: 'vf_nav_templates_hint', module: 'CERTIFICATES' },
  { id: 'settings', icon: ShieldCheck, labelKey: 'vf_nav_settings', hintKey: 'vf_nav_settings_hint', module: 'VERIFICATION' },
];

// ---------------------------------------------------------------------------

const VerificationSettings = () => {
  const { t } = useLanguage();
  const { tenant } = useTenant();

  const [settings, setSettings] = useState({ verification_enabled: true, verification_validity_days: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadVerificationSettings(tenant?.id).then(({ data, error }) => {
      if (cancelled) return;
      setLoading(false);
      if (error) {
        setNotice({ tone: 'error', text: t(verificationErrorKey(error)) });
        return;
      }
      setSettings({
        verification_enabled: data.verification_enabled !== false,
        verification_validity_days: Number(data.verification_validity_days) || 0,
      });
    });
    return () => { cancelled = true; };
  }, [tenant?.id, t]);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    const { error } = await saveVerificationSettings(tenant?.id, settings);
    setBusy(false);
    setNotice(error
      ? { tone: 'error', text: t(verificationErrorKey(error)) }
      : { tone: 'success', text: t('vf_settings_saved') });
  };

  const publicLink = verifyUrl('');

  return (
    <form className="vf-screen" onSubmit={save}>
      <div className="vf-screen-head">
        <div>
          <span className="section-kicker">{t('module_verification')}</span>
          <h1>{t('vf_settings_title')}</h1>
          <p>{t('vf_settings_intro')}</p>
        </div>
        <button type="submit" className="primary-button" disabled={busy || loading}>
          {busy ? <Loader2 className="vf-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
          {t('action_save')}
        </button>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      <section className="vf-panel">
        <div className="vf-panel-head"><h2>{t('vf_settings_title')}</h2></div>

        <label className="content-publish-check">
          <input
            type="checkbox"
            checked={settings.verification_enabled}
            onChange={(event) => setSettings((current) => ({ ...current, verification_enabled: event.target.checked }))}
          />
          {t('vf_settings_enabled')}
        </label>
        <p className="field-note">{t('vf_settings_enabled_hint')}</p>

        <label className="field-label vf-settings-days" htmlFor="vf-validity-days">
          {t('vf_settings_validity_days')}
          <input
            id="vf-validity-days"
            className="form-input"
            type="number"
            min="0"
            max="3650"
            value={settings.verification_validity_days}
            onChange={(event) => setSettings((current) => ({
              ...current,
              verification_validity_days: Math.max(Number(event.target.value) || 0, 0),
            }))}
          />
          <p className="field-note">
            {settings.verification_validity_days === 0
              ? t('vf_settings_validity_unlimited')
              : t('vf_settings_validity_hint')}
          </p>
        </label>
      </section>

      <section className="vf-panel">
        <div className="vf-panel-head"><h2>{t('vf_settings_public_link')}</h2></div>
        <p className="field-note">{t('vf_settings_public_link_hint')}</p>
        <div className="vf-inline-actions">
          <code className="verify-code vf-public-link" dir="ltr">{publicLink}</code>
          <CopyButton value={publicLink} label={t('vf_copy_link')} icon={Link2} />
          <a className="secondary-button" href={publicLink} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden="true" /> {t('vf_open_public_page')}
          </a>
        </div>
      </section>
    </form>
  );
};

// ---------------------------------------------------------------------------

const SideBanner = ({ sections, active }) => {
  const { t } = useLanguage();

  return (
    <nav className="vf-sidebar" aria-label={t('vf_center_nav_aria')}>
      {sections.map((section) => {
        const Icon = section.icon;
        return (
          <Link
            key={section.id}
            href={`/app/verification/${section.id}`}
            className={section.id === active ? 'active' : ''}
            aria-current={section.id === active ? 'page' : undefined}
          >
            <Icon aria-hidden="true" />
            <span>
              <b>{t(section.labelKey)}</b>
              <small>{t(section.hintKey)}</small>
            </span>
          </Link>
        );
      })}
    </nav>
  );
};

const VerificationCenter = () => {
  const { t } = useLanguage();
  const { hasModule } = useTenant();
  const params = useParams();
  const [, navigate] = useLocation();

  const sections = SECTIONS.filter((section) => hasModule(section.module));
  const requested = params?.section || sections[0]?.id;
  const active = sections.some((section) => section.id === requested) ? requested : sections[0]?.id;

  const goTo = useCallback((section) => navigate(`/app/verification/${section}`), [navigate]);

  if (!sections.length) {
    return (
      <main className="app-main empty-state">
        <ShieldCheck aria-hidden="true" />
        <h1>{t('error_module_disabled')}</h1>
      </main>
    );
  }

  return (
    <main className="app-main vf-center">
      <div className="vf-center-head">
        <span className="vf-brand-mark" aria-hidden="true"><ScanSearch /></span>
        <div>
          <span className="section-kicker">{t('module_verification')}</span>
          <h1>{t('vf_center_title')}</h1>
          <p>{t('vf_center_intro')}</p>
        </div>
      </div>

      <div className="vf-workspace">
        <SideBanner sections={sections} active={active} />

        <div className="vf-content">
          {active === 'attestations' && <AttestationsScreen />}
          {active === 'certificates' && <CertificatesScreen onDesignTemplates={() => goTo('templates')} />}
          {active === 'templates' && <CertificateDesigner />}
          {active === 'settings' && <VerificationSettings />}
        </div>
      </div>
    </main>
  );
};

export default VerificationCenter;
