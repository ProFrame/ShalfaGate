// "My Card" — self-service settings for the employee's own digital business
// card. Every write goes through card_save_settings() (self-scoped by
// ownership, no separate permission needed — same self-service model as the
// existing Profile.Update flow).

import { useEffect, useState } from 'react';
import { Check, Copy, Download, ExternalLink } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { cardUrl } from '../../lib/routing';
import {
  SHAPE_OPTIONS, TEMPLATE_OPTIONS, THEME_OPTIONS, TOGGLEABLE_FIELDS, VISIBILITY_OPTIONS,
  downloadVcfFile, identityErrorKey, loadMyCard, saveMyCard,
} from '../../data/digitalIdentityService';
import BusinessCard from './BusinessCard';
import './identity.css';

const VISIBILITY_KEYS = { Private: 'di_visibility_private', CompanyOnly: 'di_visibility_companyonly', Public: 'di_visibility_public' };
const TEMPLATE_KEYS = { Classic: 'di_template_classic', Modern: 'di_template_modern', Minimal: 'di_template_minimal', Bold: 'di_template_bold' };
const FIELD_KEYS = {
  mobile: 'di_field_mobile', email: 'di_field_email', extension_phone: 'di_field_extension_phone',
  linkedin_url: 'di_field_linkedin_url', department_ar: 'di_field_department_ar',
  site_ar: 'di_field_site_ar', project_ar: 'di_field_project_ar',
};

const MyCardScreen = () => {
  const { t, lang } = useLanguage();
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadMyCard().then(({ data, error }) => {
      if (cancelled) return;
      setLoading(false);
      if (error) {
        setNotice({ tone: 'error', text: t(identityErrorKey(error)) });
        return;
      }
      setCard(data);
    });
    return () => { cancelled = true; };
  }, [t]);

  const patch = async (payload) => {
    setSaving(true);
    const { data, error } = await saveMyCard(payload);
    setSaving(false);
    if (error) {
      setNotice({ tone: 'error', text: t(identityErrorKey(error)) });
      // Revert to the last confirmed server state — otherwise a failed save
      // leaves an onChange-applied local edit (e.g. LinkedIn/extension
      // phone) on screen looking saved when it never persisted.
      const { data: fresh } = await loadMyCard();
      if (fresh) setCard(fresh);
      return;
    }
    setCard(data);
  };

  const toggleField = (key) => {
    const next = { ...(card.field_visibility || {}) };
    next[key] = next[key] === false ? true : false;
    patch({ field_visibility: next });
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(cardUrl(card.public_code));
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch { /* clipboard unavailable — link is still shown/openable */ }
  };

  const downloadVcf = () => downloadVcfFile(card, lang);

  if (loading || !card) {
    return <div className="page-loader inline-loader"><span /></div>;
  }

  return (
    <div className="vf-screen">
      <div className="vf-screen-head">
        <div>
          <span className="section-kicker">{t('module_identity')}</span>
          <h1>{t('di_my_card')}</h1>
          <p>{t('di_card_intro')}</p>
        </div>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><Check aria-hidden="true" /></button>
        </div>
      )}

      <div className="di-settings-grid">
        <div>
          <section className="vf-panel">
            <h2>{t('di_settings_title')}</h2>

            <label className="field-label" htmlFor="di-visibility">
              {t('di_visibility')}
              <select id="di-visibility" className="form-input" value={card.visibility} disabled={saving}
                onChange={(event) => patch({ visibility: event.target.value })}>
                {VISIBILITY_OPTIONS.map((option) => <option key={option} value={option}>{t(VISIBILITY_KEYS[option])}</option>)}
              </select>
            </label>

            <label className="field-label">{t('di_template')}</label>
            <div className="di-swatch-row">
              {TEMPLATE_OPTIONS.map((option) => (
                <button key={option} type="button" disabled={saving} aria-pressed={card.template_code === option}
                  className={`di-swatch ${card.template_code === option ? 'active' : ''}`}
                  onClick={() => patch({ template_code: option })}>
                  {t(TEMPLATE_KEYS[option])}
                </button>
              ))}
            </div>

            <label className="field-label">{t('di_theme')}</label>
            <div className="di-swatch-row">
              {THEME_OPTIONS.map((option) => (
                <button key={option} type="button" disabled={saving} aria-pressed={card.theme === option}
                  className={`di-swatch ${card.theme === option ? 'active' : ''}`}
                  onClick={() => patch({ theme: option })}>
                  {t(option === 'Light' ? 'di_theme_light' : 'di_theme_dark')}
                </button>
              ))}
            </div>

            <label className="field-label">{t('di_shape')}</label>
            <div className="di-swatch-row">
              {SHAPE_OPTIONS.map((option) => (
                <button key={option} type="button" disabled={saving} aria-pressed={card.shape === option}
                  className={`di-swatch ${card.shape === option ? 'active' : ''}`}
                  onClick={() => patch({ shape: option })}>
                  {t(option === 'Rounded' ? 'di_shape_rounded' : 'di_shape_square')}
                </button>
              ))}
            </div>

            <label className="field-label field-checkbox">
              <input type="checkbox" checked={card.show_logo} disabled={saving} onChange={(event) => patch({ show_logo: event.target.checked })} />
              {t('di_show_logo')}
            </label>
            <label className="field-label field-checkbox">
              <input type="checkbox" checked={card.show_photo} disabled={saving} onChange={(event) => patch({ show_photo: event.target.checked })} />
              {t('di_show_photo')}
            </label>

            <label className="field-label" htmlFor="di-linkedin">
              {t('di_linkedin_url')}
              <input id="di-linkedin" className="form-input" value={card.linkedin_url || ''} disabled={saving}
                placeholder="https://linkedin.com/in/…"
                onBlur={(event) => patch({ linkedin_url: event.target.value })}
                onChange={(event) => setCard({ ...card, linkedin_url: event.target.value })} />
            </label>

            <label className="field-label" htmlFor="di-extension">
              {t('di_extension_phone')}
              <input id="di-extension" className="form-input" value={card.extension_phone || ''} disabled={saving}
                onBlur={(event) => patch({ extension_phone: event.target.value })}
                onChange={(event) => setCard({ ...card, extension_phone: event.target.value })} />
            </label>
          </section>

          <section className="vf-panel">
            <h2>{t('di_field_visibility_title')}</h2>
            {TOGGLEABLE_FIELDS.map((key) => (
              <label key={key} className="di-field-toggle-row">
                <span>{t(FIELD_KEYS[key])}</span>
                <input type="checkbox" checked={(card.field_visibility || {})[key] !== false} disabled={saving}
                  onChange={() => toggleField(key)} />
              </label>
            ))}
          </section>

          <section className="vf-panel">
            <h2>{t('di_analytics_title')}</h2>
            <div className="kpi-grid compact">
              <div className="kpi-card"><div><span>{t('di_analytics_opens')}</span><b>{card.opens_count}</b></div></div>
              <div className="kpi-card"><div><span>{t('di_analytics_vcf')}</span><b>{card.vcf_downloads_count}</b></div></div>
              <div className="kpi-card"><div><span>{t('di_analytics_website')}</span><b>{card.website_clicks_count}</b></div></div>
              <div className="kpi-card"><div><span>{t('di_analytics_calls')}</span><b>{card.calls_count}</b></div></div>
              <div className="kpi-card"><div><span>{t('di_analytics_emails')}</span><b>{card.emails_count}</b></div></div>
            </div>
          </section>
        </div>

        <div>
          <div className="di-preview-wrap">
            <BusinessCard card={card} lang={lang} publicUrl={cardUrl(card.public_code)} />
          </div>
          {card.card_no && <p className="field-note">{t('di_card_reference')}: {card.card_no}</p>}
          <div className="di-share-actions">
            <button type="button" className="secondary-button" onClick={copyLink}>
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />} {t(copied ? 'di_share_link_copied' : 'di_share_link')}
            </button>
            <button type="button" className="secondary-button" onClick={downloadVcf}>
              <Download aria-hidden="true" /> {t('di_download_vcf')}
            </button>
            <a className="secondary-button" href={cardUrl(card.public_code)} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" /> {t('di_open_public_page')}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MyCardScreen;
