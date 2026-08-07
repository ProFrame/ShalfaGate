// The one card-rendering implementation, shared by MyCardScreen's live
// preview and PublicCardPage's public view — no second implementation.

import { useLanguage } from '../../context/LanguageContext';
import EntityQrCode from '../platform/EntityQrCode';
import { pickFromMap, pickLocalized } from '../../utils/localize';

const initials = (name) => String(name || '').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

const isHidden = (fieldVisibility, key) => fieldVisibility?.[key] === false;

// card_save_settings() already rejects anything but an https:// URL server
// side; this is the defense-in-depth layer that stops a javascript: URI
// stored before that validation existed (or written directly) from ever
// reaching a rendered <a href>.
const isSafeHttpsUrl = (value) => typeof value === 'string' && /^https:\/\//i.test(value);

/**
 * @param {object} card - the shape card_get_mine()/card_public_view() return
 *   (profile/company embedded, plus a `field_visibility` map used only by
 *   the live-editing preview — the public RPC already strips hidden fields
 *   server-side, so that key is simply absent there).
 * @param {string} lang
 * @param {string} publicUrl - the fully-qualified card link the QR encodes
 * @param {(eventType: 'call'|'email'|'website_click') => void} [onInteract] -
 *   only passed by PublicCardPage; the owner's own settings-screen preview
 *   never tracks interactions against their own analytics.
 */
const BusinessCard = ({ card, lang, publicUrl, onInteract }) => {
  const { t } = useLanguage();
  if (!card) return null;
  const p = card.profile || {};
  const company = card.company || {};
  const fieldVisibility = card.field_visibility || {};
  const name = pickLocalized({ name_ar: p.name_ar, name_en: p.name_en }, 'name', lang, p.full_name) || p.full_name;
  const title = pickLocalized({ job_title_ar: p.job_title_ar, job_title_en: p.job_title_en }, 'job_title', lang, p.job_title) || p.job_title;
  const companyName = pickFromMap(company.names, lang);
  const logo = (card.theme === 'Dark' ? company.logo_dark_url : company.logo_light_url) || company.logo_light_url;
  const linkedinUrl = isSafeHttpsUrl(card.linkedin_url) ? card.linkedin_url : null;

  const show = (key) => !isHidden(fieldVisibility, key);

  return (
    <div
      className={`di-card di-shape-${(card.shape || 'Rounded').toLowerCase()} di-theme-${(card.theme || 'Light').toLowerCase()} di-tpl-${(card.template_code || 'Classic').toLowerCase()}`}
      style={company.primary_color ? { '--di-color': company.primary_color } : undefined}
    >
      <div className="di-card-head">
        {card.show_logo !== false && logo && <img className="di-card-logo" src={logo} alt="" />}
        {card.show_photo !== false && (
          p.avatar_url
            ? <img className="di-card-avatar" src={p.avatar_url} alt="" />
            : <span className="di-card-avatar di-card-avatar-fallback">{initials(name)}</span>
        )}
      </div>
      <div className="di-card-body">
        <h3>{name}</h3>
        {title && <p className="di-card-title">{title}</p>}
        {companyName && <p className="di-card-company">{companyName}</p>}
        <ul className="di-card-fields">
          {show('department_ar') && (p.department_ar || p.department_en) && <li>{pickLocalized(p, 'department', lang, p.department_ar)}</li>}
          {show('site_ar') && (p.site_ar || p.site_en) && <li>{pickLocalized(p, 'site', lang, p.site_ar)}</li>}
          {show('project_ar') && (p.project_ar || p.project_en) && <li>{pickLocalized(p, 'project', lang, p.project_ar)}</li>}
          {show('email') && p.email && <li><a href={`mailto:${p.email}`} onClick={() => onInteract?.('email')}>{p.email}</a></li>}
          {show('mobile') && p.mobile && <li><a href={`tel:${p.mobile}`} onClick={() => onInteract?.('call')}>{p.mobile}</a></li>}
          {show('extension_phone') && card.extension_phone && <li>{card.extension_phone}</li>}
          {show('linkedin_url') && linkedinUrl && <li><a href={linkedinUrl} target="_blank" rel="noreferrer">{t('di_field_linkedin_url')}</a></li>}
          {company.website_url && <li><a href={company.website_url} target="_blank" rel="noreferrer" onClick={() => onInteract?.('website_click')}>{t('di_field_website')}</a></li>}
        </ul>
      </div>
      {publicUrl && (
        <div className="di-card-qr">
          <EntityQrCode value={publicUrl} size={84} title={t('di_card_qr_aria', { name })} />
        </div>
      )}
    </div>
  );
};

export default BusinessCard;
