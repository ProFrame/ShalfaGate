import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertCircle, ArrowLeft, ArrowRight, Building2, Check, CheckCircle2, FileText,
  Image as ImageIcon, Link2, Mail, MapPin, MessageCircle, Palette, Phone, Printer,
  ShieldCheck, Smartphone, Upload, UserRound, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import LanguageSwitcher from '../LanguageSwitcher';
import { companyUrl, tenantPath } from '../../lib/routing';
import { codeLabel, formatBytes } from '../../utils/localize';
import {
  COMPANY_SIZE_CODES, CONTACT_CHANNELS, COUNTRY_CODES, INDUSTRY_CODES, RELATIONSHIP_CODES,
  SIGNUP_LIMITS, THEME_PRESETS, checkSlug, countryLabel, listTimezones, preflightSignup,
  submitSignup, timezoneOffsetLabel,
} from '../../data/publicService';
import './public.css';

const STEP_COUNT = 4;
const SLUG_DEBOUNCE_MS = 420;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^[+()\-\s\d]{7,24}$/;

const CHANNEL_ICONS = {
  email: Mail,
  mobile: Smartphone,
  whatsapp: MessageCircle,
  phone: Phone,
  fax: Printer,
  address: MapPin,
};

const createInitialForm = (lang) => ({
  slug: '',
  defaultLanguage: lang,
  names: {},
  legalName: '',
  countryCode: 'SA',
  timezone: 'Asia/Riyadh',
  industry: '',
  companySize: '',
  taxNumber: '',
  commercialRegister: '',
  contacts: CONTACT_CHANNELS.reduce((acc, channel) => ({ ...acc, [channel]: '' }), {}),
  mapUrl: '',
  themePreset: THEME_PRESETS[0].code,
  logoFile: null,
  coverFile: null,
  relationship: RELATIONSHIP_CODES[0],
  adminName: '',
  adminPhone: '',
  adminEmail: '',
  consent: false,
});

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** A labelled control with its own error slot, wired for screen readers. */
const Field = ({ label, hint, error, required, className = '', children }) => {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean).join(' ') || undefined;

  return (
    <div className={`field-label ${className}`.trim()}>
      <label htmlFor={id}>
        {label}
        {required && <span className="bb-required" aria-hidden="true"> *</span>}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && <p className="field-note" id={`${id}-hint`}>{hint}</p>}
      {error && (
        <p className="bb-field-error" id={`${id}-error`}>
          <AlertCircle aria-hidden="true" />{error}
        </p>
      )}
    </div>
  );
};

const TextField = ({ value, onChange, type = 'text', placeholder, autoComplete, inputMode, ...rest }) => (
  <Field {...rest}>
    {({ id, describedBy, invalid }) => (
      <input
        id={id}
        type={type}
        className={`form-input${invalid ? ' bb-invalid' : ''}`}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    )}
  </Field>
);

const SelectField = ({ value, onChange, options, placeholder, ...rest }) => (
  <Field {...rest}>
    {({ id, describedBy, invalid }) => (
      <select
        id={id}
        className={`form-input${invalid ? ' bb-invalid' : ''}`}
        value={value}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    )}
  </Field>
);

const Alert = ({ tone = 'error', icon: Icon = AlertCircle, children }) => (
  <p className={`bb-alert ${tone}`} role={tone === 'error' ? 'alert' : undefined}>
    <Icon aria-hidden="true" />
    <span>{children}</span>
  </p>
);

// ---------------------------------------------------------------------------
// Step 1 — company identity
// ---------------------------------------------------------------------------

const SlugField = ({ value, onChange, state, error }) => {
  const { t } = useLanguage();
  const preview = companyUrl(value || t('pub_field_slug_placeholder'));

  const stateView = {
    checking: { className: 'busy', icon: null, text: t('pub_slug_checking') },
    ok: { className: 'ok', icon: CheckCircle2, text: t('pub_slug_reason_available') },
    bad: { className: 'bad', icon: X, text: codeLabel(t, 'pub_slug_reason', state.reason, t('pub_slug_reason_check_failed')) },
  }[state.status];

  return (
    <div className="bb-span-2">
      <Field
        label={t('pub_field_slug')}
        hint={t('pub_field_slug_help')}
        error={error}
        required
      >
        {({ id, describedBy, invalid }) => (
          <span className="bb-slug-input">
            <input
              id={id}
              className={`form-input${invalid ? ' bb-invalid' : ''}`}
              value={value}
              placeholder={t('pub_field_slug_placeholder')}
              spellCheck="false"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(event) => onChange(event.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''))}
            />
            {state.status === 'checking' && <span className="bb-slug-spinner" aria-hidden="true" />}
          </span>
        )}
      </Field>

      <div aria-live="polite" style={{ display: 'grid', gap: 8, marginTop: 8 }}>
        {stateView && (
          <span className={`bb-slug-state ${stateView.className}`}>
            {stateView.icon && <stateView.icon aria-hidden="true" />}
            {stateView.text}
          </span>
        )}
        <div className="bb-url-chip">
          <Link2 aria-hidden="true" />
          <span className="sr-only">{t('pub_slug_preview')}</span>
          <code>{preview}</code>
        </div>
      </div>
    </div>
  );
};

const CompanyNames = ({ names, defaultLanguage, onChange, error }) => {
  const { t, languages } = useLanguage();

  return (
    <fieldset className="bb-fieldset bb-span-2">
      <legend>{t('pub_names_title')}</legend>
      <p className="field-note">{t('pub_names_help')}</p>
      <div className="bb-name-rows">
        {languages.map((language) => {
          const isDefault = language.code === defaultLanguage;
          return (
            <div className="bb-name-row" key={language.code}>
              <span>
                {language.name}
                {isDefault && <b className="bb-default-pill">{t('label_required')}</b>}
              </span>
              <input
                className={`form-input${isDefault && error ? ' bb-invalid' : ''}`}
                value={names[language.code] || ''}
                dir={language.dir}
                aria-label={t('pub_field_company_name_in', { language: language.name })}
                aria-invalid={(isDefault && Boolean(error)) || undefined}
                onChange={(event) => onChange(language.code, event.target.value)}
              />
            </div>
          );
        })}
      </div>
      {error && <p className="bb-field-error" style={{ marginTop: 10 }}><AlertCircle aria-hidden="true" />{error}</p>}
    </fieldset>
  );
};

const IdentityStep = ({ form, errors, slugState, update }) => {
  const { t, locale, languages } = useLanguage();

  const countries = useMemo(
    () => COUNTRY_CODES
      .map((code) => ({ value: code, label: countryLabel(code, locale) }))
      .sort((a, b) => a.label.localeCompare(b.label, locale)),
    [locale],
  );

  const timezones = useMemo(
    () => listTimezones().map((zone) => ({
      value: zone,
      label: `${zone}${timezoneOffsetLabel(zone) ? ` (${timezoneOffsetLabel(zone)})` : ''}`,
    })),
    [],
  );

  return (
    <div className="bb-grid">
      <SlugField
        value={form.slug}
        onChange={(value) => update({ slug: value })}
        state={slugState}
        error={errors.slug}
      />

      <SelectField
        label={t('pub_field_default_language')}
        hint={t('pub_field_default_language_help')}
        required
        value={form.defaultLanguage}
        onChange={(value) => update({ defaultLanguage: value })}
        options={languages.map((language) => ({ value: language.code, label: language.name }))}
      />

      <TextField
        label={t('pub_field_legal_name')}
        hint={t('pub_field_legal_name_help')}
        value={form.legalName}
        onChange={(value) => update({ legalName: value })}
        autoComplete="organization"
      />

      <CompanyNames
        names={form.names}
        defaultLanguage={form.defaultLanguage}
        error={errors.names}
        onChange={(code, value) => update({ names: { ...form.names, [code]: value } })}
      />

      <SelectField
        label={t('label_country')}
        required
        value={form.countryCode}
        onChange={(value) => update({ countryCode: value })}
        options={countries}
        error={errors.countryCode}
      />

      <SelectField
        label={t('label_timezone')}
        required
        value={form.timezone}
        onChange={(value) => update({ timezone: value })}
        options={timezones}
        error={errors.timezone}
      />

      <SelectField
        label={t('pub_field_industry')}
        value={form.industry}
        onChange={(value) => update({ industry: value })}
        placeholder={t('pub_choose_placeholder')}
        options={INDUSTRY_CODES.map((code) => ({ value: code, label: t(`pub_industry_${code}`) }))}
      />

      <SelectField
        label={t('pub_field_company_size')}
        value={form.companySize}
        onChange={(value) => update({ companySize: value })}
        placeholder={t('pub_choose_placeholder')}
        options={COMPANY_SIZE_CODES.map((code) => ({ value: code, label: t(`pub_size_${code}`) }))}
      />

      <TextField
        label={t('pub_field_tax_number')}
        value={form.taxNumber}
        onChange={(value) => update({ taxNumber: value })}
        inputMode="numeric"
      />

      <TextField
        label={t('pub_field_commercial_register')}
        value={form.commercialRegister}
        onChange={(value) => update({ commercialRegister: value })}
        inputMode="numeric"
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Step 2 — contact channels, logo, cover and theme
// ---------------------------------------------------------------------------

const ImageField = ({ label, hint, accept, maxBytes, allowedTypes, file, onPick, error, variant }) => {
  const { t, locale } = useLanguage();
  const inputRef = useRef(null);

  // Derived, not stored: the preview is a pure function of the picked file, and
  // the effect exists only to hand the object URL back when it stops being used.
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const handleFiles = (list) => {
    const picked = list?.[0];
    if (!picked) return;
    if (allowedTypes.length && !allowedTypes.includes(picked.type)) {
      onPick(null, t('pub_file_wrong_type'));
      return;
    }
    if (picked.size > maxBytes) {
      onPick(null, t('pub_file_too_large', { size: formatBytes(maxBytes, locale) }));
      return;
    }
    onPick(picked, null);
  };

  return (
    <div className="bb-span-2">
      <div className="field-label" style={{ gap: 10 }}>
        <span>{label}</span>
        <div className="bb-upload">
          <span className={`bb-upload-preview${variant === 'cover' ? ' cover' : ''}`}>
            {previewUrl
              ? <img src={previewUrl} alt={t('pub_file_preview_alt')} />
              : <ImageIcon aria-hidden="true" />}
          </span>
          <div className="bb-upload-body">
            <p>{hint}</p>
            <div className="bb-upload-actions">
              <input
                ref={inputRef}
                type="file"
                className="sr-only"
                accept={accept}
                aria-label={label}
                onChange={(event) => { handleFiles(event.target.files); event.target.value = ''; }}
              />
              <button type="button" className="secondary-button" onClick={() => inputRef.current?.click()}>
                <Upload size={15} aria-hidden="true" />
                {file ? t('pub_file_replace') : t('pub_file_choose')}
              </button>
              <span className="bb-upload-file">
                {file
                  ? <><b>{file.name}</b><span>· {formatBytes(file.size, locale)}</span></>
                  : t('pub_file_none')}
              </span>
              {file && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('action_remove')}
                  onClick={() => onPick(null, null)}
                >
                  <X />
                </button>
              )}
            </div>
          </div>
        </div>
        {error && <p className="bb-field-error"><AlertCircle aria-hidden="true" />{error}</p>}
      </div>
    </div>
  );
};

const ThemePicker = ({ value, onChange }) => {
  const { t } = useLanguage();

  return (
    <fieldset className="bb-fieldset bb-span-2">
      <legend>{t('pub_theme_title')}</legend>
      <p className="field-note">{t('pub_theme_help')}</p>
      <div className="bb-theme-grid">
        {THEME_PRESETS.map((preset) => (
          <button
            key={preset.code}
            type="button"
            className="bb-theme"
            aria-pressed={preset.code === value}
            onClick={() => onChange(preset.code)}
          >
            <span
              className="bb-theme-swatch"
              aria-hidden="true"
              style={{
                background: `linear-gradient(120deg, ${preset.primary_color}, ${preset.secondary_color} 62%, ${preset.accent_color})`,
              }}
            />
            <span className="bb-theme-row">
              <b>{t(`pub_theme_${preset.code}`)}</b>
              {preset.code === value && <Check aria-hidden="true" />}
            </span>
          </button>
        ))}
      </div>
    </fieldset>
  );
};

const BrandingStep = ({ form, errors, update, fileErrors, setFileErrors }) => {
  const { t, locale } = useLanguage();

  return (
    <div className="bb-grid">
      <fieldset className="bb-fieldset bb-span-2">
        <legend>{t('pub_contacts_title')}</legend>
        <p className="field-note">{t('pub_contacts_help')}</p>
        <div className="bb-grid">
          {CONTACT_CHANNELS.map((channel) => {
            const Icon = CHANNEL_ICONS[channel];
            const filled = Boolean(form.contacts[channel]?.trim());
            return (
              <div className={`bb-channel-row${filled ? ' filled' : ''}`} key={channel}>
                <span className="bb-channel-icon" aria-hidden="true"><Icon /></span>
                <TextField
                  label={t(`contact_${channel}`)}
                  value={form.contacts[channel]}
                  error={errors[`contact_${channel}`]}
                  type={channel === 'email' ? 'email' : 'text'}
                  inputMode={['mobile', 'whatsapp', 'phone', 'fax'].includes(channel) ? 'tel' : undefined}
                  onChange={(value) => update({ contacts: { ...form.contacts, [channel]: value } })}
                />
              </div>
            );
          })}
        </div>
      </fieldset>

      <TextField
        className="bb-span-2"
        label={t('pub_field_map_url')}
        hint={t('pub_field_map_url_help')}
        value={form.mapUrl}
        error={errors.mapUrl}
        type="url"
        onChange={(value) => update({ mapUrl: value })}
      />

      <fieldset className="bb-fieldset bb-span-2">
        <legend>{t('pub_branding_title')}</legend>
        <div className="bb-grid">
          <ImageField
            label={t('pub_field_logo')}
            hint={t('pub_field_logo_help', { size: formatBytes(SIGNUP_LIMITS.logoBytes, locale) })}
            accept={SIGNUP_LIMITS.logoTypes.join(',')}
            allowedTypes={SIGNUP_LIMITS.logoTypes}
            maxBytes={SIGNUP_LIMITS.logoBytes}
            file={form.logoFile}
            error={fileErrors.logo}
            onPick={(file, message) => {
              update({ logoFile: file });
              setFileErrors((current) => ({ ...current, logo: message }));
            }}
          />
          <ImageField
            variant="cover"
            label={t('pub_field_cover')}
            hint={t('pub_field_cover_help', { size: formatBytes(SIGNUP_LIMITS.coverBytes, locale) })}
            accept={SIGNUP_LIMITS.coverTypes.join(',')}
            allowedTypes={SIGNUP_LIMITS.coverTypes}
            maxBytes={SIGNUP_LIMITS.coverBytes}
            file={form.coverFile}
            error={fileErrors.cover}
            onPick={(file, message) => {
              update({ coverFile: file });
              setFileErrors((current) => ({ ...current, cover: message }));
            }}
          />
        </div>
      </fieldset>

      <ThemePicker value={form.themePreset} onChange={(value) => update({ themePreset: value })} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Step 3 — administrator
// ---------------------------------------------------------------------------

const AdministratorStep = ({ form, errors, update }) => {
  const { t } = useLanguage();
  const consentId = useId();

  return (
    <div className="bb-grid">
      <div className="bb-span-2">
        <p className="field-note" style={{ marginTop: 0 }}>{t('pub_admin_help')}</p>
      </div>

      <SelectField
        label={t('pub_field_relationship')}
        required
        value={form.relationship}
        onChange={(value) => update({ relationship: value })}
        options={RELATIONSHIP_CODES.map((code) => ({ value: code, label: t(`pub_relationship_${code}`) }))}
      />

      <TextField
        label={t('pub_field_admin_name')}
        required
        value={form.adminName}
        error={errors.adminName}
        autoComplete="name"
        onChange={(value) => update({ adminName: value })}
      />

      <TextField
        label={t('pub_field_admin_phone')}
        required
        value={form.adminPhone}
        error={errors.adminPhone}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        onChange={(value) => update({ adminPhone: value })}
      />

      <TextField
        label={t('pub_field_admin_email')}
        hint={t('pub_field_admin_email_help')}
        required
        value={form.adminEmail}
        error={errors.adminEmail}
        type="email"
        autoComplete="email"
        onChange={(value) => update({ adminEmail: value })}
      />

      <div className="bb-span-2">
        <label htmlFor={consentId} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13.5, lineHeight: 1.7 }}>
          <input
            id={consentId}
            type="checkbox"
            checked={form.consent}
            aria-invalid={Boolean(errors.consent) || undefined}
            onChange={(event) => update({ consent: event.target.checked })}
          />
          <span>{t('pub_admin_consent')}</span>
        </label>
        {errors.consent && <p className="bb-field-error" style={{ marginTop: 8 }}><AlertCircle aria-hidden="true" />{errors.consent}</p>}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Step 4 — review
// ---------------------------------------------------------------------------

const ReviewRow = ({ label, value, ltr }) => (
  <div className={`bb-review-row${ltr ? ' ltr' : ''}`}>
    <span>{label}</span>
    <b>{value || '—'}</b>
  </div>
);

const ReviewStep = ({ form, onEdit }) => {
  const { t, locale, languages } = useLanguage();

  const filledContacts = CONTACT_CHANNELS.filter((channel) => form.contacts[channel]?.trim());
  const filledNames = languages.filter((language) => form.names[language.code]?.trim());
  const fileLabel = (file) => (file
    ? t('pub_review_file_selected', { name: file.name, size: formatBytes(file.size, locale) })
    : null);

  return (
    <div className="bb-review">
      <div className="bb-review-block">
        <div className="bb-review-head">
          <h3>{t('pub_signup_step_identity')}</h3>
          <button type="button" className="secondary-button" onClick={() => onEdit(0)}>{t('pub_review_edit')}</button>
        </div>
        <div className="bb-review-rows">
          <ReviewRow label={t('pub_slug_preview')} value={companyUrl(form.slug)} ltr />
          <ReviewRow label={t('pub_field_default_language')} value={languages.find((l) => l.code === form.defaultLanguage)?.name} />
          <ReviewRow label={t('pub_field_legal_name')} value={form.legalName} />
          <ReviewRow label={t('label_country')} value={countryLabel(form.countryCode, locale)} />
          <ReviewRow label={t('label_timezone')} value={form.timezone} ltr />
          <ReviewRow label={t('pub_field_industry')} value={form.industry ? t(`pub_industry_${form.industry}`) : ''} />
          <ReviewRow label={t('pub_field_company_size')} value={form.companySize ? t(`pub_size_${form.companySize}`) : ''} />
          <ReviewRow label={t('pub_field_tax_number')} value={form.taxNumber} ltr />
          <ReviewRow label={t('pub_field_commercial_register')} value={form.commercialRegister} ltr />
          <div className="bb-review-row">
            <span>{t('pub_review_names')}</span>
            <b>{filledNames.map((language) => `${language.name}: ${form.names[language.code]}`).join(' · ')}</b>
          </div>
        </div>
      </div>

      <div className="bb-review-block">
        <div className="bb-review-head">
          <h3>{t('pub_signup_step_branding')}</h3>
          <button type="button" className="secondary-button" onClick={() => onEdit(1)}>{t('pub_review_edit')}</button>
        </div>
        <div className="bb-review-rows">
          {filledContacts.length === 0 && (
            <div className="bb-review-row bb-span-2"><b>{t('pub_review_no_contacts')}</b></div>
          )}
          {filledContacts.map((channel) => (
            <ReviewRow
              key={channel}
              label={t(`contact_${channel}`)}
              value={form.contacts[channel]}
              ltr={channel !== 'address'}
            />
          ))}
          <ReviewRow label={t('pub_field_map_url')} value={form.mapUrl} ltr />
          <ReviewRow label={t('pub_theme_selected')} value={t(`pub_theme_${form.themePreset}`)} />
          <ReviewRow label={t('pub_field_logo')} value={fileLabel(form.logoFile) || t('pub_review_no_logo')} />
          <ReviewRow label={t('pub_field_cover')} value={fileLabel(form.coverFile) || t('pub_review_no_cover')} />
        </div>
      </div>

      <div className="bb-review-block">
        <div className="bb-review-head">
          <h3>{t('pub_signup_step_admin')}</h3>
          <button type="button" className="secondary-button" onClick={() => onEdit(2)}>{t('pub_review_edit')}</button>
        </div>
        <div className="bb-review-rows">
          <ReviewRow label={t('pub_field_relationship')} value={t(`pub_relationship_${form.relationship}`)} />
          <ReviewRow label={t('pub_field_admin_name')} value={form.adminName} />
          <ReviewRow label={t('pub_field_admin_phone')} value={form.adminPhone} ltr />
          <ReviewRow label={t('pub_field_admin_email')} value={form.adminEmail} ltr />
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

const SuccessScreen = ({ result, companyName }) => {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);
  const url = companyUrl(result.slug);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <motion.div
      className="bb-success"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45 }}
    >
      <span className="bb-success-mark"><CheckCircle2 aria-hidden="true" /></span>
      <h1>{t('pub_success_title')}</h1>
      <p>{t('pub_success_text', { company: companyName, email: result.admin_email })}</p>

      <div className="bb-success-panel">
        <div className="field-label">
          <span>{t('pub_success_url_label')}</span>
          <div className="bb-copy-row">
            <span className="bb-code">{url}</span>
            <button type="button" className="secondary-button" onClick={copy}>
              {copied ? t('action_copied') : t('action_copy')}
            </button>
          </div>
        </div>
        <div className="field-label">
          <span>{t('pub_success_admin_label')}</span>
          <span className="bb-code">{result.admin_email}</span>
        </div>
        <p className="field-note">{t('pub_success_email_note')}</p>
        {result.local_preview && <Alert tone="info" icon={ShieldCheck}>{t('pub_local_preview_note')}</Alert>}
      </div>

      <div className="bb-success-actions">
        <a className="primary-button" href={tenantPath(result.slug)}>{t('pub_success_open_company')}</a>
        <Link href="/portal" className="secondary-button">{t('pub_signup_back_to_portal')}</Link>
      </div>
    </motion.div>
  );
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const SignupPage = () => {
  const { t, lang, isRtl, languages } = useLanguage();
  const reduce = useReducedMotion();

  const [form, setForm] = useState(() => createInitialForm(lang));
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState({});
  const [fileErrors, setFileErrors] = useState({ logo: null, cover: null });
  const [slugResult, setSlugResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    document.title = `${t('pub_signup_title')} · ${t('platform_brand')}`;
  }, [t]);

  const update = useCallback((patch) => {
    setForm((current) => ({ ...current, ...patch }));
  }, []);

  // --- live slug availability, debounced ------------------------------------
  // The effect only *records* the answer for a given slug; the visible state is
  // derived below, so a stale answer can never be shown next to a newer slug.
  useEffect(() => {
    const value = form.slug.trim();
    if (!value) return undefined;

    let cancelled = false;
    const timer = setTimeout(async () => {
      const { data, error } = await checkSlug(value);
      if (cancelled) return;
      setSlugResult(error
        ? { slug: value, available: false, reason: 'CHECK_FAILED' }
        : { slug: value, available: data.available, reason: data.reason });
    }, SLUG_DEBOUNCE_MS);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [form.slug]);

  const slugState = useMemo(() => {
    const value = form.slug.trim();
    if (!value) return { status: 'idle', reason: null };
    if (!slugResult || slugResult.slug !== value) return { status: 'checking', reason: null };
    return slugResult.available
      ? { status: 'ok', reason: null }
      : { status: 'bad', reason: slugResult.reason };
  }, [form.slug, slugResult]);

  const steps = useMemo(() => [
    { title: t('pub_signup_step_identity'), hint: t('pub_signup_step_identity_hint'), icon: Building2 },
    { title: t('pub_signup_step_branding'), hint: t('pub_signup_step_branding_hint'), icon: Palette },
    { title: t('pub_signup_step_admin'), hint: t('pub_signup_step_admin_hint'), icon: UserRound },
    { title: t('pub_signup_step_review'), hint: t('pub_signup_step_review_hint'), icon: FileText },
  ], [t]);

  const companyName = form.names[form.defaultLanguage]?.trim()
    || languages.map((language) => form.names[language.code]).find((name) => name?.trim())
    || form.legalName
    || form.slug;

  // --- per-step validation ---------------------------------------------------
  const validateStep = useCallback((index) => {
    const found = {};

    if (index === 0) {
      if (!form.slug.trim()) found.slug = t('pub_slug_required');
      else if (slugState.status === 'bad') {
        found.slug = codeLabel(t, 'pub_slug_reason', slugState.reason, t('pub_slug_reason_check_failed'));
      } else if (slugState.status !== 'ok') found.slug = t('pub_slug_not_confirmed');

      if (!form.names[form.defaultLanguage]?.trim()) found.names = t('pub_name_default_required');
      if (!form.countryCode) found.countryCode = t('error_required_field');
      if (!form.timezone) found.timezone = t('error_required_field');
    }

    if (index === 1) {
      const email = form.contacts.email?.trim();
      if (email && !EMAIL_PATTERN.test(email)) found.contact_email = t('error_invalid_email');
      ['mobile', 'whatsapp', 'phone', 'fax'].forEach((channel) => {
        const value = form.contacts[channel]?.trim();
        if (value && !PHONE_PATTERN.test(value)) found[`contact_${channel}`] = t('pub_invalid_phone');
      });
      const map = form.mapUrl.trim();
      if (map && !/^https?:\/\//i.test(map)) found.mapUrl = t('pub_field_map_url_invalid');
      if (fileErrors.logo || fileErrors.cover) found.files = t('error_validation');
    }

    if (index === 2) {
      if (!form.adminName.trim()) found.adminName = t('error_required_field');
      if (!PHONE_PATTERN.test(form.adminPhone.trim())) found.adminPhone = t('pub_invalid_phone');
      if (!EMAIL_PATTERN.test(form.adminEmail.trim())) found.adminEmail = t('error_invalid_email');
      if (!form.consent) found.consent = t('pub_admin_consent_required');
    }

    return found;
  }, [form, slugState, fileErrors, t]);

  const goTo = (index) => {
    setSubmitError(null);
    if (index <= step) { setErrors({}); setStep(index); return; }

    // Walk every step between here and there so a jump cannot skip validation.
    for (let cursor = step; cursor < index; cursor += 1) {
      const found = validateStep(cursor);
      if (Object.keys(found).length) {
        setErrors(found);
        setStep(cursor);
        return;
      }
    }
    setErrors({});
    setStep(index);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitError(null);

    for (let cursor = 0; cursor < STEP_COUNT - 1; cursor += 1) {
      const found = validateStep(cursor);
      if (Object.keys(found).length) {
        setErrors(found);
        setStep(cursor);
        return;
      }
    }

    setSubmitting(true);
    const preflight = await preflightSignup(form);
    if (preflight.error) {
      setSubmitting(false);
      setSubmitError(codeLabel(t, 'pub_error', preflight.error.message, t('pub_error_submit')));
      return;
    }

    const { data, error } = await submitSignup(form);
    setSubmitting(false);
    if (error) {
      const mapped = {
        SLUG_TAKEN: t('pub_error_slug_taken'),
        TENANT_SLUG_RESERVED: t('pub_slug_reason_reserved'),
        EMAIL_IN_USE: t('pub_error_email_in_use'),
        FILE_READ_FAILED: t('error_generic'),
      }[error.message];
      setSubmitError(mapped || t('pub_error_submit'));
      return;
    }
    setResult(data);
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  };

  const stepBody = [
    <IdentityStep key="identity" form={form} errors={errors} slugState={slugState} update={update} />,
    <BrandingStep key="branding" form={form} errors={errors} update={update} fileErrors={fileErrors} setFileErrors={setFileErrors} />,
    <AdministratorStep key="admin" form={form} errors={errors} update={update} />,
    <ReviewStep key="review" form={form} onEdit={goTo} />,
  ][step];

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
            <Link href="/support" className="secondary-button">{t('pub_support')}</Link>
          </div>
        </div>
      </header>

      <main className="bb-shell bb-form-page">
        {result ? (
          <SuccessScreen result={result} companyName={companyName} />
        ) : (
          <>
            <div className="bb-form-head">
              <Link href="/portal" className="bb-back-link">
                <ArrowLeft size={16} className={isRtl ? 'flip-ltr' : ''} aria-hidden="true" />
                {t('pub_signup_back_to_portal')}
              </Link>
              <h1>{t('pub_signup_title')}</h1>
              <p>{t('pub_signup_subtitle')}</p>
            </div>

            <nav className="bb-stepper" aria-label={t('pub_signup_progress', { current: step + 1, total: STEP_COUNT })}>
              {steps.map((item, index) => {
                const state = index === step ? 'active' : index < step ? 'done' : '';
                const Icon = item.icon;
                return (
                  <button
                    key={item.title}
                    type="button"
                    className={`bb-stepper-item ${state}`.trim()}
                    aria-current={index === step ? 'step' : undefined}
                    onClick={() => goTo(index)}
                  >
                    <span className="bb-stepper-top">
                      <i aria-hidden="true">{index < step ? <Check /> : index + 1}</i>
                      <b>{item.title}</b>
                      <Icon size={15} aria-hidden="true" style={{ marginInlineStart: 'auto', color: 'var(--muted)' }} />
                    </span>
                    <small>{item.hint}</small>
                  </button>
                );
              })}
            </nav>

            <div className="bb-progress" role="progressbar" aria-valuemin={1} aria-valuemax={STEP_COUNT} aria-valuenow={step + 1} aria-label={t('pub_signup_progress', { current: step + 1, total: STEP_COUNT })}>
              <motion.div
                initial={false}
                animate={{ width: `${((step + 1) / STEP_COUNT) * 100}%` }}
                transition={{ duration: reduce ? 0 : 0.35, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>

            <form className="bb-card" onSubmit={handleSubmit} noValidate>
              <div aria-live="polite">
                {submitError && <Alert>{submitError}</Alert>}
                {!submitError && Object.keys(errors).length > 0 && <Alert>{t('pub_error_step')}</Alert>}
              </div>

              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={step}
                  initial={reduce ? false : { opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, x: -24 }}
                  transition={{ duration: reduce ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
                >
                  {stepBody}
                </motion.div>
              </AnimatePresence>

              <div className="bb-form-actions">
                {step > 0 && (
                  <button type="button" className="secondary-button" onClick={() => goTo(step - 1)}>
                    <ArrowLeft size={16} className={isRtl ? 'flip-ltr' : ''} aria-hidden="true" />
                    {t('action_previous')}
                  </button>
                )}
                <span className="bb-spacer" />
                {step < STEP_COUNT - 1 ? (
                  <button type="button" className="primary-button" onClick={() => goTo(step + 1)}>
                    {t('action_next')}
                    <ArrowRight size={16} className={isRtl ? 'flip-ltr' : ''} aria-hidden="true" />
                  </button>
                ) : (
                  <button type="submit" className="primary-button" disabled={submitting}>
                    {submitting ? t('pub_signup_submitting') : t('pub_signup_submit')}
                    {!submitting && <Check size={16} aria-hidden="true" />}
                  </button>
                )}
              </div>
            </form>
          </>
        )}
      </main>
    </div>
  );
};

export default SignupPage;
