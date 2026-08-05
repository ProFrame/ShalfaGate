import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArchiveRestore, Ban, Building2, Check, CloudCog, DownloadCloud, Gauge, Info, Layers,
  Mail, MessageSquare, Power, Save, ShieldCheck, UploadCloud, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import {
  errorCode, loadTenantDetail, MEGABYTE, saveTenantChatSettings, setTenantLicense,
  setTenantModule, setTenantQuota, setTenantStatus, TENANT_STATUS_ACTIONS,
} from '../../data/platformService';
import { codeLabel, formatBytes, formatDate, formatDateTime, formatNumber, pickFromMap, pickLocalized } from '../../utils/localize';
import { Switch } from './platformUi';

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

const Fact = ({ label, value }) => (
  <div className="pc-fact">
    <span>{label}</span>
    <b>{value || '—'}</b>
  </div>
);

const Section = ({ Icon, title, badge, children }) => (
  <section className="pc-section">
    <header>
      <Icon aria-hidden="true" />
      <h3>{title}</h3>
      {badge}
    </header>
    {children}
  </section>
);

const UsageBar = ({ used, limit, unit, locale }) => {
  const { t } = useLanguage();
  const format = (value) => (unit === 'bytes' ? formatBytes(value, locale) : formatNumber(value, locale));
  const percent = Number(limit) > 0 ? Math.min(100, (Number(used || 0) * 100) / Number(limit)) : 0;
  const tone = percent >= 95 ? 'pc-bar-full' : percent >= 75 ? 'pc-bar-warn' : '';
  return (
    <div className="pc-bar">
      <div className={`pc-bar-track ${tone}`}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <small>
        {t('pc_quota_of', {
          used: format(used || 0),
          limit: Number(limit) > 0 ? format(limit) : t('label_unlimited'),
        })}
      </small>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Modules — one row per platform module, showing where its value comes from
// ---------------------------------------------------------------------------

const ModuleRow = ({ module: row, busy, onToggle }) => {
  const { t, lang } = useLanguage();
  const overridden = row.override !== null && row.override !== undefined && row.override !== row.in_license;
  const originKey = !row.in_license ? 'pc_module_not_in_licence' : overridden ? 'pc_module_overridden' : 'pc_module_inherited';

  return (
    <div className="pc-row">
      <div>
        <b>{codeLabel(t, 'module', row.code, pickLocalized(row, 'name', lang, row.code))}</b>
        <small>
          <span className="pc-slug">{row.code}</span>
          {' · '}
          {t(originKey)}
          {row.is_core ? ` · ${t('pc_module_core')}` : ''}
        </small>
      </div>
      <Switch
        checked={row.enabled}
        disabled={busy}
        label={codeLabel(t, 'module', row.code, row.code)}
        onChange={(next) => onToggle(row.code, next)}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Quotas — a limit editor with a used/limit bar per resource
// ---------------------------------------------------------------------------

const QuotaRow = ({ quota, busy, onSave }) => {
  const { t, lang, locale } = useLanguage();
  // The row is keyed on the stored limit, so a saved change remounts it with a
  // fresh draft rather than reconciling two sources of truth in an effect.
  const inBytes = quota.unit === 'bytes';
  const stored = inBytes ? Math.round(Number(quota.limit || 0) / MEGABYTE) : Number(quota.limit || 0);
  const [draft, setDraft] = useState(String(stored));
  const dirty = String(stored) !== String(draft).trim();
  const unitLabel = codeLabel(t, 'pc_unit', inBytes ? 'mb' : quota.unit, '');

  return (
    <div className="pc-quota-row">
      <div>
        <b>{pickLocalized(quota, 'name', lang, quota.code)}</b>
        <small className="pc-slug">{quota.code}</small>
      </div>
      <label className="field-label">
        <span className="sr-only">{`${pickLocalized(quota, 'name', lang, quota.code)} · ${t('pc_quota_limit')}${unitLabel ? ` (${unitLabel})` : ''}`}</span>
        <input
          className="form-input"
          type="number"
          min="0"
          inputMode="numeric"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="pc-actions">
        <UsageBar used={quota.used} limit={quota.limit} unit={quota.unit} locale={locale} />
        <button
          type="button"
          className="icon-button"
          disabled={busy || !dirty}
          aria-label={t('action_save')}
          onClick={() => onSave(quota.code, inBytes ? Number(draft || 0) * MEGABYTE : Number(draft || 0))}
        >
          <Save aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Chat settings — the switches the plan asks for, written to tenant_settings
// ---------------------------------------------------------------------------

const ChatSettings = ({ settings, chatModule, busy, onToggleModule, onSave }) => {
  const { t } = useLanguage();
  const [draft, setDraft] = useState({
    chat_private_enabled: Boolean(settings?.chat_private_enabled),
    chat_groups_enabled: Boolean(settings?.chat_groups_enabled),
    chat_attachments_enabled: Boolean(settings?.chat_attachments_enabled),
    chat_max_attachment_mb: Number(settings?.chat_max_attachment_mb ?? 5),
    types: (settings?.chat_allowed_file_types || []).join('\n'),
  });

  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));

  return (
    <Section Icon={MessageSquare} title={t('pc_section_chat')}>
      <p className="field-note">{t('pc_chat_master_help')}</p>

      <div className="pc-rows">
        <div className="pc-row">
          <div>
            <b>{t('pc_chat_master')}</b>
            <small>{chatModule?.in_license ? t('pc_module_inherited') : t('pc_module_not_in_licence')}</small>
          </div>
          <Switch
            checked={Boolean(chatModule?.enabled)}
            disabled={busy || !chatModule}
            label={t('pc_chat_master')}
            onChange={(next) => onToggleModule('CHAT', next)}
          />
        </div>

        {[
          ['chat_private_enabled', 'pc_chat_private'],
          ['chat_groups_enabled', 'pc_chat_groups'],
          ['chat_attachments_enabled', 'pc_chat_attachments'],
        ].map(([key, labelKey]) => (
          <div className="pc-row" key={key}>
            <div><b>{t(labelKey)}</b></div>
            <Switch checked={draft[key]} disabled={busy} label={t(labelKey)} onChange={(next) => set(key, next)} />
          </div>
        ))}

        {[['pc_chat_voice'], ['pc_chat_video']].map(([labelKey]) => (
          <div className="pc-row" key={labelKey}>
            <div>
              <b>{t(labelKey)}</b>
              <small>{t('pc_planned_help')}</small>
            </div>
            <span className="pc-chip">{t('pc_planned')}</span>
            <Switch checked={false} disabled label={t(labelKey)} onChange={() => {}} />
          </div>
        ))}
      </div>

      <div className="pc-field-row">
        <label className="field-label">
          {t('pc_chat_max_size')}
          <input
            className="form-input"
            type="number"
            min="0"
            inputMode="numeric"
            value={draft.chat_max_attachment_mb}
            onChange={(event) => set('chat_max_attachment_mb', event.target.value)}
          />
        </label>
        <label className="field-label">
          {t('pc_chat_types')}
          <textarea
            className="form-input"
            rows={4}
            value={draft.types}
            onChange={(event) => set('types', event.target.value)}
            placeholder="image/png"
          />
          <span className="field-note">{t('pc_chat_types_help')}</span>
        </label>
      </div>

      <div className="pc-actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy}
          onClick={() => onSave({
            chat_private_enabled: draft.chat_private_enabled,
            chat_groups_enabled: draft.chat_groups_enabled,
            chat_attachments_enabled: draft.chat_attachments_enabled,
            chat_max_attachment_mb: draft.chat_max_attachment_mb,
            chat_allowed_file_types: String(draft.types).split(/[\n,]/),
          })}
        >
          <Save aria-hidden="true" /> {t('action_save')}
        </button>
      </div>
    </Section>
  );
};

// ---------------------------------------------------------------------------
// Status actions — never silent, always with a reason for the audit trail
// ---------------------------------------------------------------------------

const StatusDialog = ({ company, status, busy, onCancel, onConfirm }) => {
  const { t } = useLanguage();
  const [reason, setReason] = useState('');

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card confirm-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <h3>{t('pc_status_confirm', { company, status: codeLabel(t, 'status', status, status) })}</h3>
          <button type="button" className="icon-button" onClick={onCancel} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
        <label className="field-label">
          {t('pc_reason')}
          <textarea
            className="form-input"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('pc_reason_placeholder')}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>{t('action_cancel')}</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => onConfirm(reason)}>
            <Check aria-hidden="true" /> {t('action_confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};

const BackupSection = () => {
  const { t } = useLanguage();
  return (
    <Section Icon={ArchiveRestore} title={t('pc_section_backup')} badge={<span className="pc-chip">{t('pc_planned')}</span>}>
      <p className="pc-note"><Info aria-hidden="true" />{t('pc_backup_note')}</p>
      <div className="pc-planned-grid">
        <button type="button" className="secondary-button" disabled><DownloadCloud aria-hidden="true" /> {t('pc_backup_export')}</button>
        <button type="button" className="secondary-button" disabled><UploadCloud aria-hidden="true" /> {t('pc_backup_import')}</button>
        <button type="button" className="secondary-button" disabled><ShieldCheck aria-hidden="true" /> {t('pc_backup_backup')}</button>
        <button type="button" className="secondary-button" disabled><ArchiveRestore aria-hidden="true" /> {t('pc_backup_restore')}</button>
      </div>
    </Section>
  );
};

// ---------------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------------

const TenantDetailDrawer = ({ tenantId, onClose, onChanged }) => {
  const { t, lang, locale } = useLanguage();
  const [detail, setDetail] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState({ tone: 'ok', text: '' });
  const [pendingStatus, setPendingStatus] = useState(null);
  const [licenseDraft, setLicenseDraft] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    loadTenantDetail(tenantId).then(({ data, error }) => {
      if (cancelled) return;
      if (error) { setLoadError(error); return; }
      setLoadError(null);
      setDetail(data);
      setLicenseDraft(data?.tenant?.license_code || '');
    });
    return () => { cancelled = true; };
  }, [tenantId, reloadToken]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const companyName = useMemo(
    () => pickFromMap(detail?.names, lang, 'ar', detail?.tenant?.slug || ''),
    [detail, lang],
  );

  const run = async (action) => {
    setBusy(true);
    setFeedback({ tone: 'ok', text: '' });
    const { error } = await action();
    if (error) {
      setFeedback({ tone: 'error', text: codeLabel(t, 'pc_err', errorCode(error), t('error_generic')) });
    } else {
      setFeedback({ tone: 'ok', text: t('pc_saved') });
      reload();
      if (onChanged) onChanged();
    }
    setBusy(false);
  };

  const chatModule = (detail?.modules || []).find((row) => row.code === 'CHAT');
  const tenant = detail?.tenant || {};
  const branding = detail?.branding || {};
  const activity = detail?.activity || {};

  return (
    <div className="pc-drawer-backdrop" onClick={onClose}>
      <aside
        className="pc-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={companyName || t('pc_col_company')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="pc-drawer-head">
          <div>
            <span className="section-kicker">{t('pc_col_company')}</span>
            <h2>{companyName || t('label_loading')}</h2>
            <div className="pc-drawer-head-meta">
              <span className="pc-slug">/{tenant.slug || ''}</span>
              {tenant.status ? (
                <span className={`pc-chip pc-chip-${String(tenant.status).toLowerCase()}`}>
                  {codeLabel(t, 'status', tenant.status, tenant.status)}
                </span>
              ) : null}
              {tenant.is_platform ? <span className="pc-chip pc-chip-brand">{t('pc_platform_workspace')}</span> : null}
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('pc_drawer_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div aria-live="polite" className={`pc-status-line ${feedback.tone === 'error' ? 'pc-error' : ''}`}>
          {feedback.text}
        </div>

        {loadError ? (
          <p className="pc-note pc-note-warn">
            <Info aria-hidden="true" />
            {codeLabel(t, 'pc_err', errorCode(loadError), t('error_generic'))}
          </p>
        ) : null}

        {!detail && !loadError ? <p className="field-note">{t('label_loading')}</p> : null}

        {detail ? (
          <>
            <Section Icon={Building2} title={t('pc_section_identity')}>
              <div className="pc-facts">
                <Fact label={t('pc_legal_name')} value={tenant.legal_name} />
                <Fact label={t('label_code')} value={tenant.code} />
                <Fact label={t('pc_industry')} value={tenant.industry} />
                <Fact label={t('pc_employee_range')} value={tenant.employee_range} />
                <Fact label={t('pc_tax_number')} value={tenant.tax_number} />
                <Fact label={t('pc_commercial_register')} value={tenant.commercial_register} />
                <Fact label={t('label_country')} value={tenant.country_code} />
                <Fact label={t('label_timezone')} value={tenant.timezone} />
                <Fact label={t('pc_default_language')} value={tenant.default_language} />
                <Fact label={t('label_created_on')} value={formatDate(tenant.created_on, locale)} />
                <Fact label={t('pc_activated_on')} value={formatDate(tenant.activated_on, locale)} />
                <Fact label={t('pc_col_last_activity')} value={activity.last_login ? formatDateTime(activity.last_login, locale) : t('pc_never')} />
              </div>
            </Section>

            <Section Icon={Mail} title={t('pc_section_contact')}>
              <div className="pc-facts">
                {(detail.contacts || []).map((contact) => (
                  <Fact key={`${contact.channel}-${contact.value}`} label={t(`contact_${contact.channel}`)} value={contact.value} />
                ))}
                <Fact label={t('contact_email')} value={branding.support_email} />
                <Fact label={t('contact_website')} value={branding.website_url} />
              </div>
              <div className="pc-facts">
                <Fact label={t('contact_address')} value={pickLocalized(branding, 'address', lang, '')} />
              </div>
            </Section>

            <Section Icon={Layers} title={t('pc_section_licence')}>
              <p className="field-note">{t('pc_licence_help')}</p>
              <div className="pc-field-row">
                <label className="field-label" htmlFor="pc-license">
                  {t('pc_licence_select')}
                  <select
                    id="pc-license"
                    className="form-input"
                    value={licenseDraft}
                    onChange={(event) => setLicenseDraft(event.target.value)}
                  >
                    {(detail.licenses || []).map((license) => (
                      <option key={license.code} value={license.code}>
                        {pickLocalized(license, 'name', lang, license.code)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="pc-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || !licenseDraft || licenseDraft === tenant.license_code}
                  onClick={() => run(() => setTenantLicense(tenantId, licenseDraft))}
                >
                  <Save aria-hidden="true" /> {t('action_apply')}
                </button>
              </div>
            </Section>

            <Section Icon={CloudCog} title={t('pc_section_modules')}>
              <p className="field-note">{t('pc_modules_help')}</p>
              <div className="pc-rows">
                {(detail.modules || []).map((row) => (
                  <ModuleRow
                    key={row.code}
                    module={row}
                    busy={busy}
                    onToggle={(code, next) => run(() => setTenantModule(tenantId, code, next))}
                  />
                ))}
              </div>
            </Section>

            <Section Icon={Gauge} title={t('pc_section_quotas')}>
              <p className="field-note">{t('pc_quota_zero_hint')}</p>
              <div className="pc-rows">
                {(detail.quotas || []).map((quota) => (
                  <QuotaRow
                    key={`${quota.code}-${quota.limit}`}
                    quota={quota}
                    busy={busy}
                    onSave={(code, limit) => run(() => setTenantQuota(tenantId, code, limit))}
                  />
                ))}
              </div>
            </Section>

            <ChatSettings
              key={`chat-${tenant.updated_on || tenant.id || tenantId}`}
              settings={detail.settings}
              chatModule={chatModule}
              busy={busy}
              onToggleModule={(code, next) => run(() => setTenantModule(tenantId, code, next))}
              onSave={(values) => run(() => saveTenantChatSettings(tenantId, values))}
            />

            <Section Icon={Power} title={t('pc_section_status')}>
              <p className="field-note">{t('pc_status_help')}</p>
              {tenant.suspended_reason ? (
                <div className="pc-facts">
                  <Fact label={t('pc_suspended_reason')} value={tenant.suspended_reason} />
                </div>
              ) : null}
              <div className="pc-actions">
                {TENANT_STATUS_ACTIONS.map((code) => (
                  <button
                    key={code}
                    type="button"
                    className={code === 'Active' ? 'secondary-button' : 'secondary-button danger'}
                    disabled={busy || tenant.status === code || tenant.is_platform}
                    onClick={() => setPendingStatus(code)}
                  >
                    {code === 'Active' ? <Check aria-hidden="true" /> : <Ban aria-hidden="true" />}
                    {codeLabel(t, 'status', code, code)}
                  </button>
                ))}
              </div>
            </Section>

            <BackupSection />
          </>
        ) : null}

        {pendingStatus ? (
          <StatusDialog
            company={companyName}
            status={pendingStatus}
            busy={busy}
            onCancel={() => setPendingStatus(null)}
            onConfirm={async (reason) => {
              const next = pendingStatus;
              setPendingStatus(null);
              await run(() => setTenantStatus(tenantId, next, reason));
            }}
          />
        ) : null}
      </aside>
    </div>
  );
};

export default TenantDetailDrawer;
