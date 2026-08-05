// The company's own record.
//
// Everything the subscriber entered when they signed up — names, logo, colours,
// contact numbers, registration details — is edited here in one place, except
// for one field: the company extension. The extension is the permanent address
// of the company on the platform (bbnovix.com/{slug}/); every link, printed
// document and verification code already issued depends on it, so it is shown
// prominently, read-only, with the reason next to it.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2, Check, Copy, Globe, Image as ImageIcon, Link2, Mail, MapPin,
  MessageCircle, Palette, Phone, Plus, Printer, Save, Smartphone, Trash2, Upload, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { absoluteUrl, tenantPath } from '../../lib/routing';
import { CORE_BUCKETS, STORAGE_LAYER, putFile } from '../../lib/storage';
import { pickLocalized } from '../../utils/localize';
import { loadOrgDimensions } from '../../data/orgDimensionsService';
import {
  CONTACT_CHANNELS, loadTenantProfile, saveTenantProfile, tenantErrorMessage,
} from '../../data/tenantProfileService';

const timeZones = () => {
  try {
    return Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const Section = ({ icon: Icon, title, hint, children }) => (
  <section className="admin-card">
    <header>
      <Icon aria-hidden="true" />
      <div>
        <h2>{title}</h2>
        {hint && <p>{hint}</p>}
      </div>
    </header>
    {children}
  </section>
);

const CompanyAddressCard = ({ slug }) => {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);
  const address = slug ? absoluteUrl(tenantPath(slug)) : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="admin-card admin-slug-card">
      <header>
        <Link2 aria-hidden="true" />
        <div>
          <h2>{t('admin_company_address_section')}</h2>
          <p>{t('admin_company_slug_note')}</p>
        </div>
      </header>

      <div className="admin-slug-row">
        <div>
          <span className="admin-slug-label">{t('admin_company_slug')}</span>
          <code className="admin-slug-value">{slug}</code>
        </div>
        <div>
          <span className="admin-slug-label">{t('admin_company_address_section')}</span>
          <code className="admin-slug-url" dir="ltr">{address}</code>
        </div>
        <button type="button" className="secondary-button" onClick={copy} aria-label={t('admin_company_copy_address')}>
          {copied ? <Check /> : <Copy />}
          {t(copied ? 'action_copied' : 'action_copy')}
        </button>
      </div>
      <p className="field-note admin-readonly-note">{t('admin_company_slug_note')}</p>
    </section>
  );
};

const ImageField = ({ label, value, busy, onPick, onClear }) => {
  const { t } = useLanguage();
  const inputRef = useRef(null);
  return (
    <div className="admin-image-field">
      <span className="admin-image-label">{label}</span>
      <div className="admin-image-preview">
        {value
          ? <img src={value} alt={t('admin_company_image_alt')} />
          : <ImageIcon aria-hidden="true" />}
      </div>
      <div className="admin-image-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => inputRef.current?.click()}>
          <Upload /> {busy ? t('admin_company_uploading') : t('action_upload')}
        </button>
        {value && (
          <button type="button" className="secondary-button" onClick={onClear}>
            <Trash2 /> {t('admin_company_remove_image')}
          </button>
        )}
        <input
          ref={inputRef}
          hidden
          type="file"
          accept="image/*"
          aria-label={label}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onPick(file);
            event.target.value = '';
          }}
        />
      </div>
    </div>
  );
};

/** Each channel carries its own icon, the same one the public pages use. */
const CHANNEL_ICONS = {
  email: Mail,
  mobile: Smartphone,
  whatsapp: MessageCircle,
  phone: Phone,
  fax: Printer,
  address: MapPin,
  website: Globe,
};

const ContactsEditor = ({ contacts, onChange }) => {
  const { t } = useLanguage();

  const update = (index, patch) => onChange(contacts.map((row, position) => (
    position === index ? { ...row, ...patch } : row
  )));

  return (
    <div className="admin-contacts">
      {contacts.map((contact, index) => {
        const ChannelIcon = CHANNEL_ICONS[contact.channel] || Mail;
        return (
        <div className="admin-contact-row" key={contact.id || `contact-${index}`}>
          <span className="admin-contact-icon" aria-hidden="true"><ChannelIcon /></span>
          <label className="field-label">
            <span className="sr-only">{t('admin_company_contact_channel')}</span>
            <select
              className="form-input"
              value={contact.channel || 'email'}
              onChange={(event) => update(index, { channel: event.target.value })}
              aria-label={t('admin_company_contact_channel')}
            >
              {CONTACT_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>{t(`contact_${channel}`)}</option>
              ))}
            </select>
          </label>
          <label className="field-label">
            <span className="sr-only">{t('admin_company_contact_value')}</span>
            <input
              className="form-input"
              dir="auto"
              value={contact.value || ''}
              placeholder={t('admin_company_contact_value')}
              aria-label={t('admin_company_contact_value')}
              onChange={(event) => update(index, { value: event.target.value })}
            />
          </label>
          <label className="admin-inline-check">
            <input
              type="checkbox"
              checked={contact.is_public !== false}
              onChange={(event) => update(index, { is_public: event.target.checked })}
            />
            {t('admin_company_contact_public')}
          </label>
          <button
            type="button"
            className="icon-button"
            aria-label={t('admin_company_contact_remove')}
            onClick={() => onChange(contacts.filter((_, position) => position !== index))}
          >
            <X />
          </button>
        </div>
        );
      })}

      {!contacts.length && <p className="field-note">{t('admin_company_no_contacts')}</p>}

      <button
        type="button"
        className="secondary-button"
        onClick={() => onChange([...contacts, { channel: 'email', value: '', is_public: true }])}
      >
        <Plus /> {t('admin_company_contact_add')}
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const CompanyProfileScreen = () => {
  const { t, lang, languages } = useLanguage();
  const { slug, tenant, refresh } = useTenant();

  const [profile, setProfile] = useState(null);
  const [names, setNames] = useState({});
  const [branding, setBranding] = useState({});
  const [settings, setSettings] = useState({});
  const [contacts, setContacts] = useState([]);
  const [countries, setCountries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState('');
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadTenantProfile(slug).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data) {
        setNotice({ tone: 'error', text: tenantErrorMessage(t, error, 'admin_company_load_failed') });
        setLoading(false);
        return;
      }
      setProfile(data.tenant);
      setNames(Object.fromEntries((data.names || []).map((row) => [row.language_code, row])));
      setBranding(data.branding || {});
      setSettings(data.settings || {});
      setContacts((data.contacts || []).map((row) => ({ ...row })));
      setLoading(false);
    });
    loadOrgDimensions().then(({ data }) => { if (!cancelled && data) setCountries(data.countries); });
    return () => { cancelled = true; };
  }, [slug, t]);

  const zones = useMemo(() => timeZones(), []);

  const setTenantField = (key) => (event) => setProfile((current) => ({ ...current, [key]: event.target.value }));
  const setBrandingField = (key) => (event) => setBranding((current) => ({ ...current, [key]: event.target.value }));
  const setName = (code, key, value) => setNames((current) => ({
    ...current,
    [code]: { ...(current[code] || { language_code: code }), language_code: code, [key]: value },
  }));

  const upload = async (field, file) => {
    setUploading(field);
    const { data, error } = await putFile({
      layer: STORAGE_LAYER.CORE,
      bucket: CORE_BUCKETS.branding,
      tenantId: tenant?.id || profile?.id,
      area: 'branding',
      file,
      entityType: 'TenantBranding',
      entityId: tenant?.id || profile?.id || null,
    });
    setUploading('');
    if (error || !data) {
      setNotice({ tone: 'error', text: tenantErrorMessage(t, error, 'admin_company_upload_failed') });
      return;
    }
    setBranding((current) => ({ ...current, [field]: data.url }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    const { error } = await saveTenantProfile(profile?.id, {
      slug,
      tenant: profile,
      names: Object.values(names),
      branding,
      contacts,
      settings,
    });
    setSaving(false);
    if (error) {
      setNotice({ tone: 'error', text: tenantErrorMessage(t, error, 'admin_company_save_failed') });
      return;
    }
    setNotice({ tone: 'success', text: t('admin_company_saved') });
    refresh?.();
  };

  if (loading) {
    return (
      <div className="admin-content">
        <p className="admin-loading" role="status" aria-live="polite">{t('label_loading')}</p>
      </div>
    );
  }

  return (
    <form className="admin-content" onSubmit={submit}>
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('admin_company_kicker')}</span>
          <h1>{t('admin_company_title')}</h1>
          <p>{t('admin_company_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button className="primary-button" disabled={saving}>
            <Save /> {saving ? t('label_loading') : t('action_save')}
          </button>
        </div>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.tone === 'error' ? <X /> : <Check />}
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X /></button>
        </div>
      )}

      <CompanyAddressCard slug={slug || profile?.slug} />

      <Section icon={Building2} title={t('admin_company_identity')}>
        <div className="form-grid">
          <label className="field-label field-span-2">
            {t('admin_company_legal_name')}
            <input className="form-input" value={profile?.legal_name || ''} onChange={setTenantField('legal_name')} />
          </label>

          {languages.map((language) => (
            <label className="field-label" key={`name-${language.code}`}>
              {t('admin_company_name_in', { language: language.name })}
              <input
                className="form-input"
                dir="auto"
                value={names[language.code]?.name || ''}
                onChange={(event) => setName(language.code, 'name', event.target.value)}
              />
            </label>
          ))}
          {languages.map((language) => (
            <label className="field-label" key={`short-${language.code}`}>
              {t('admin_company_short_name_in', { language: language.name })}
              <input
                className="form-input"
                dir="auto"
                value={names[language.code]?.short_name || ''}
                onChange={(event) => setName(language.code, 'short_name', event.target.value)}
              />
            </label>
          ))}

          <label className="field-label">
            {t('admin_company_tax_number')}
            <input className="form-input" dir="ltr" value={profile?.tax_number || ''} onChange={setTenantField('tax_number')} />
          </label>
          <label className="field-label">
            {t('admin_company_commercial_register')}
            <input className="form-input" dir="ltr" value={profile?.commercial_register || ''} onChange={setTenantField('commercial_register')} />
          </label>
          <label className="field-label">
            {t('admin_company_industry')}
            <input className="form-input" value={profile?.industry || ''} onChange={setTenantField('industry')} />
          </label>
        </div>
      </Section>

      <Section icon={Palette} title={t('admin_company_branding')}>
        <div className="admin-image-grid">
          <ImageField
            label={t('admin_company_logo_light')}
            value={branding.logo_light_url}
            busy={uploading === 'logo_light_url'}
            onPick={(file) => upload('logo_light_url', file)}
            onClear={() => setBranding((current) => ({ ...current, logo_light_url: null }))}
          />
          <ImageField
            label={t('admin_company_logo_dark')}
            value={branding.logo_dark_url}
            busy={uploading === 'logo_dark_url'}
            onPick={(file) => upload('logo_dark_url', file)}
            onClear={() => setBranding((current) => ({ ...current, logo_dark_url: null }))}
          />
          <ImageField
            label={t('admin_company_cover')}
            value={branding.hero_image_url}
            busy={uploading === 'hero_image_url'}
            onPick={(file) => upload('hero_image_url', file)}
            onClear={() => setBranding((current) => ({ ...current, hero_image_url: null }))}
          />
          <ImageField
            label={t('admin_company_favicon')}
            value={branding.favicon_url}
            busy={uploading === 'favicon_url'}
            onPick={(file) => upload('favicon_url', file)}
            onClear={() => setBranding((current) => ({ ...current, favicon_url: null }))}
          />
        </div>

        <div className="form-grid admin-color-grid">
          <label className="field-label">
            {t('admin_company_primary_color')}
            <input type="color" className="form-input admin-color-input" value={branding.primary_color || '#1b4f82'} onChange={setBrandingField('primary_color')} />
          </label>
          <label className="field-label">
            {t('admin_company_secondary_color')}
            <input type="color" className="form-input admin-color-input" value={branding.secondary_color || '#12365d'} onChange={setBrandingField('secondary_color')} />
          </label>
          <label className="field-label">
            {t('admin_company_accent_color')}
            <input type="color" className="form-input admin-color-input" value={branding.accent_color || '#b86a12'} onChange={setBrandingField('accent_color')} />
          </label>
        </div>
      </Section>

      <Section icon={Globe} title={t('admin_company_regional')}>
        <div className="form-grid">
          <label className="field-label">
            {t('admin_company_default_language')}
            <select className="form-input" value={profile?.default_language || 'ar'} onChange={setTenantField('default_language')}>
              {languages.map((language) => (
                <option key={language.code} value={language.code}>{language.name}</option>
              ))}
            </select>
          </label>

          <label className="field-label">
            {t('label_timezone')}
            {zones.length ? (
              <select className="form-input" value={profile?.timezone || ''} onChange={setTenantField('timezone')}>
                {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </select>
            ) : (
              <input className="form-input" dir="ltr" value={profile?.timezone || ''} onChange={setTenantField('timezone')} />
            )}
          </label>

          <label className="field-label">
            {t('label_country')}
            {countries.length ? (
              <select className="form-input" value={profile?.country_code || ''} onChange={setTenantField('country_code')}>
                <option value="">{t('admin_not_assigned')}</option>
                {countries.map((country) => (
                  <option key={country.id} value={country.iso_code || country.code}>
                    {pickLocalized(country, 'name', lang)}
                  </option>
                ))}
              </select>
            ) : (
              <input className="form-input" dir="ltr" maxLength={2} value={profile?.country_code || ''} onChange={setTenantField('country_code')} />
            )}
          </label>
        </div>
      </Section>

      <Section icon={Link2} title={t('admin_company_links')}>
        <div className="form-grid">
          <label className="field-label">
            {t('admin_company_website')}
            <input className="form-input" dir="ltr" value={branding.website_url || ''} onChange={setBrandingField('website_url')} />
          </label>
          <label className="field-label">
            {t('admin_company_linkedin')}
            <input className="form-input" dir="ltr" value={branding.linkedin_url || ''} onChange={setBrandingField('linkedin_url')} />
          </label>
          <label className="field-label">
            {t('admin_company_support_email')}
            <input type="email" className="form-input" dir="ltr" value={branding.support_email || ''} onChange={setBrandingField('support_email')} />
          </label>
          <label className="field-label">
            {t('admin_company_map_url')}
            <input className="form-input" dir="ltr" value={branding.map_url || ''} onChange={setBrandingField('map_url')} />
          </label>
          <label className="field-label field-span-2">
            {t('admin_company_address_1')}
            <textarea className="form-input" value={branding.address_ar || ''} onChange={setBrandingField('address_ar')} />
          </label>
          <label className="field-label field-span-2">
            {t('admin_company_address_2')}
            <textarea className="form-input" value={branding.address_en || ''} onChange={setBrandingField('address_en')} />
          </label>
        </div>
      </Section>

      <Section icon={Plus} title={t('admin_company_contacts')} hint={t('admin_company_contacts_hint')}>
        <ContactsEditor contacts={contacts} onChange={setContacts} />
      </Section>

      <div className="admin-form-footer">
        <button className="primary-button" disabled={saving}>
          <Save /> {saving ? t('label_loading') : t('action_save')}
        </button>
      </div>
    </form>
  );
};

export default CompanyProfileScreen;
