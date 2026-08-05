import { useEffect, useMemo, useState } from 'react';
import { Boxes, HardDrive, Info, Save, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useLanguage } from '../../context/LanguageContext';
import {
  errorCode, loadStorageOverview, loadStoragePolicies, MEGABYTE, saveStoragePolicy,
  saveTenantStorage, setTenantChatAttachments, STORAGE_LAYERS,
} from '../../data/platformService';
import { codeLabel, formatBytes, formatNumber, pickFromMap, pickLocalized } from '../../utils/localize';

const TABS = [
  { code: 'providers', labelKey: 'pc_storage_tab_providers' },
  { code: 'tenants', labelKey: 'pc_storage_tab_companies' },
  { code: 'usage', labelKey: 'pc_storage_tab_usage' },
  { code: 'policies', labelKey: 'pc_storage_tab_policies' },
];

const STATUS_TONE = {
  Ok: 'pc-chip-active',
  Failed: 'pc-chip-suspended',
  Suspended: 'pc-chip-pending',
  NotConfigured: 'pc-chip-disabled',
  Unknown: 'pc-chip-disabled',
};

const TYPE_COLORS = ['var(--brand)', 'var(--amber)', 'var(--brand-dark)', 'var(--muted)'];

const Switch = ({ checked, disabled, label, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={Boolean(checked)}
    aria-label={label}
    className="pc-switch"
    disabled={disabled}
    onClick={() => onChange(!checked)}
  >
    <span />
  </button>
);

// ---------------------------------------------------------------------------
// 1. Storage providers — the catalogue and how far it is taken up
// ---------------------------------------------------------------------------

const ProvidersTab = ({ providers }) => {
  const { t, lang, locale } = useLanguage();
  return (
    <div className="data-table-wrap">
      <table className="enterprise-table">
        <thead>
          <tr>
            <th>{t('pc_col_provider')}</th>
            <th>{t('pc_col_layer')}</th>
            <th>{t('pc_col_availability')}</th>
            <th>{t('pc_col_companies_using')}</th>
            <th>{t('pc_col_stored')}</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => (
            <tr key={provider.code}>
              <td>
                <b>{pickLocalized(provider, 'name', lang, provider.code)}</b>
                <small className="pc-slug">{provider.code}</small>
              </td>
              <td>{codeLabel(t, 'pc_layer', provider.kind, provider.kind)}</td>
              <td>
                <span className={`pc-chip ${provider.is_active ? 'pc-chip-active' : 'pc-chip-disabled'}`}>
                  {t(provider.is_active ? 'label_enabled' : 'label_disabled')}
                </span>
              </td>
              <td>{formatNumber(provider.tenants, locale)}</td>
              <td>{formatBytes(provider.bytes, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {providers.length === 0 ? (
        <div className="empty-table"><HardDrive aria-hidden="true" /><b>{t('label_no_results')}</b></div>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 2. Company storage — one row per company with the two switches it owns
// ---------------------------------------------------------------------------

const CompanyStorageTab = ({ tenants, busy, onToggleExtended, onToggleChat }) => {
  const { t, lang, locale } = useLanguage();

  return (
    <div className="data-table-wrap">
      <table className="enterprise-table">
        <thead>
          <tr>
            <th>{t('pc_col_company')}</th>
            <th>{t('pc_col_provider')}</th>
            <th>{t('pc_col_allocated')}</th>
            <th>{t('label_used')}</th>
            <th>{t('pc_col_percent')}</th>
            <th>{t('label_status')}</th>
            <th>{t('pc_col_extended')}</th>
            <th>{t('pc_col_chat_attachments')}</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((row) => {
            const name = pickFromMap(row.names, lang, 'ar', row.slug);
            const percent = row.percent == null ? null : Math.min(100, Number(row.percent));
            const tone = percent == null ? '' : percent >= 95 ? 'pc-bar-full' : percent >= 75 ? 'pc-bar-warn' : '';
            return (
              <tr key={row.tenant_id}>
                <td>
                  <b>{name}</b>
                  <small className="pc-slug">/{row.slug}</small>
                </td>
                <td>{row.provider ? <span className="pc-slug">{row.provider}</span> : t('label_none')}</td>
                <td>{Number(row.allocated_bytes) > 0 ? formatBytes(row.allocated_bytes, locale) : t('label_unlimited')}</td>
                <td>{formatBytes(row.used_bytes, locale)}</td>
                <td>
                  {percent == null ? '—' : (
                    <div className="pc-bar">
                      <div className={`pc-bar-track ${tone}`}><span style={{ width: `${percent}%` }} /></div>
                      <small>{formatNumber(percent, locale, { maximumFractionDigits: 1 })}%</small>
                    </div>
                  )}
                </td>
                <td>
                  <span className={`pc-chip ${STATUS_TONE[row.storage_status] || 'pc-chip-disabled'}`}>
                    {codeLabel(t, 'pc_sstatus', row.storage_status, row.storage_status)}
                  </span>
                </td>
                <td>
                  <Switch
                    checked={row.extended_enabled}
                    disabled={busy}
                    label={`${t('pc_col_extended')} · ${name}`}
                    onChange={(next) => onToggleExtended(row.tenant_id, next)}
                  />
                </td>
                <td>
                  <Switch
                    checked={row.chat_attachments_enabled}
                    disabled={busy}
                    label={`${t('pc_col_chat_attachments')} · ${name}`}
                    onChange={(next) => onToggleChat(row.tenant_id, next)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {tenants.length === 0 ? (
        <div className="empty-table"><HardDrive aria-hidden="true" /><b>{t('pc_no_storage_rows')}</b></div>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 3. Storage usage — where the bytes actually are
// ---------------------------------------------------------------------------

const UsageTab = ({ totals, tenants }) => {
  const { t, lang, locale } = useLanguage();

  const heaviest = useMemo(() => (
    [...tenants]
      .sort((a, b) => Number(b.used_bytes || 0) - Number(a.used_bytes || 0))
      .slice(0, 8)
      .map((row) => ({ label: pickFromMap(row.names, lang, 'ar', row.slug), bytes: Number(row.used_bytes || 0) }))
  ), [tenants, lang]);

  const byType = useMemo(() => {
    const images = Number(totals.images || 0);
    const documents = Number(totals.documents || 0);
    const chat = Number(totals.chat_attachments || 0);
    const other = Math.max(0, Number(totals.files || 0) - images - documents - chat);
    return [
      { key: 'pc_type_images', value: images },
      { key: 'pc_type_documents', value: documents },
      { key: 'pc_type_chat', value: chat },
      { key: 'pc_type_other', value: other },
    ].filter((slice) => slice.value > 0).map((slice) => ({ ...slice, label: t(slice.key) }));
  }, [totals, t]);

  return (
    <div className="pc-console">
      <div className="kpi-grid">
        <div className="kpi-card">
          <HardDrive aria-hidden="true" />
          <div><span>{t('pc_storage_totals')}</span><b>{formatBytes(totals.bytes, locale)}</b><small>{formatNumber(totals.files, locale)}</small></div>
        </div>
        <div className="kpi-card">
          <ShieldCheck aria-hidden="true" />
          <div><span>{t('pc_storage_core')}</span><b>{formatBytes(totals.core_bytes, locale)}</b></div>
        </div>
        <div className="kpi-card">
          <Boxes aria-hidden="true" />
          <div><span>{t('pc_storage_extended')}</span><b>{formatBytes(totals.extended_bytes, locale)}</b></div>
        </div>
      </div>

      <div className="pc-grid-2">
        <section className="pc-panel">
          <header><div><h2>{t('pc_chart_heaviest')}</h2></div></header>
          {heaviest.length === 0 ? <p className="field-note">{t('label_no_results')}</p> : (
            <div className="pc-chart">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={heaviest} layout="vertical" margin={{ top: 4, right: 14, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} tickFormatter={(value) => formatBytes(value, locale)} />
                  <YAxis type="category" dataKey="label" width={110} tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} />
                  <Tooltip
                    formatter={(value) => [formatBytes(value, locale), t('pc_metric_storage')]}
                    contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12 }}
                  />
                  <Bar dataKey="bytes" name={t('pc_metric_storage')} fill="var(--brand)" radius={[0, 5, 5, 0]} maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="pc-panel">
          <header><div><h2>{t('pc_chart_by_type')}</h2></div></header>
          {byType.length === 0 ? <p className="field-note">{t('label_no_results')}</p> : (
            <div className="pc-chart">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={byType} dataKey="value" nameKey="label" innerRadius={48} outerRadius={86} paddingAngle={2}>
                    {byType.map((slice, index) => (
                      <Cell key={slice.key} fill={TYPE_COLORS[index % TYPE_COLORS.length]} stroke="var(--surface)" />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value, name) => [formatNumber(value, locale), name]}
                    contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12 }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
          <ul className="pc-rows">
            {byType.map((slice, index) => (
              <li className="pc-row" key={slice.key}>
                <span className="pc-chip" style={{ background: TYPE_COLORS[index % TYPE_COLORS.length], color: '#fff' }}>{slice.label}</span>
                <div><b>{formatNumber(slice.value, locale)}</b></div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 4. Storage policies — what a file may be, and what a new company starts with
// ---------------------------------------------------------------------------

const PolicyCard = ({ policy, busy, onSave }) => {
  const { t } = useLanguage();
  const [draft, setDraft] = useState({
    maxMb: Math.round(Number(policy.max_file_bytes || 0) / MEGABYTE),
    quotaMb: Math.round(Number(policy.default_quota_bytes || 0) / MEGABYTE),
    types: (policy.allowed_mime_types || []).join('\n'),
    notes: policy.notes || '',
  });

  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const fieldId = (name) => `pc-policy-${policy.layer}-${name}`;

  return (
    <section className="pc-section">
      <header>
        <SlidersHorizontal aria-hidden="true" />
        <h3>{codeLabel(t, 'pc_layer', policy.layer, policy.layer)}</h3>
      </header>

      <div className="pc-field-row">
        <label className="field-label" htmlFor={fieldId('max')}>
          {t('pc_policy_max_file')}
          <input
            id={fieldId('max')}
            className="form-input"
            type="number"
            min="0"
            inputMode="numeric"
            value={draft.maxMb}
            onChange={(event) => set('maxMb', event.target.value)}
          />
        </label>
        <label className="field-label" htmlFor={fieldId('quota')}>
          {t('pc_policy_default_quota')}
          <input
            id={fieldId('quota')}
            className="form-input"
            type="number"
            min="0"
            inputMode="numeric"
            value={draft.quotaMb}
            onChange={(event) => set('quotaMb', event.target.value)}
          />
        </label>
      </div>

      <label className="field-label" htmlFor={fieldId('types')}>
        {t('pc_policy_types')}
        <textarea
          id={fieldId('types')}
          className="form-input"
          rows={5}
          value={draft.types}
          onChange={(event) => set('types', event.target.value)}
          placeholder="application/pdf"
        />
        <span className="field-note">{t('pc_chat_types_help')}</span>
      </label>

      <label className="field-label" htmlFor={fieldId('notes')}>
        {t('pc_policy_notes')}
        <textarea
          id={fieldId('notes')}
          className="form-input"
          rows={2}
          value={draft.notes}
          onChange={(event) => set('notes', event.target.value)}
        />
      </label>

      <div className="pc-actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy}
          onClick={() => onSave(policy.layer, {
            max_file_bytes: Number(draft.maxMb || 0) * MEGABYTE,
            default_quota_bytes: Number(draft.quotaMb || 0) * MEGABYTE,
            allowed_mime_types: String(draft.types).split(/[\n,]/),
            notes: draft.notes,
          })}
        >
          <Save aria-hidden="true" /> {t('action_save')}
        </button>
      </div>
    </section>
  );
};

const PoliciesTab = ({ policies, busy, onSave }) => {
  const { t } = useLanguage();
  const ordered = STORAGE_LAYERS
    .map((layer) => policies.find((row) => row.layer === layer))
    .filter(Boolean);

  return (
    <div className="pc-console">
      <p className="pc-note">
        <Info aria-hidden="true" />
        <span>
          <b>{t('pc_policy_preupload')}</b>
          {' — '}
          {t('pc_policy_preupload_body')}
        </span>
      </p>
      {ordered.map((policy) => (
        <PolicyCard key={policy.layer} policy={policy} busy={busy} onSave={onSave} />
      ))}
      {ordered.length === 0 ? <p className="field-note">{t('label_no_results')}</p> : null}
    </div>
  );
};

// ---------------------------------------------------------------------------

const StorageManagement = () => {
  const { t } = useLanguage();
  const [tab, setTab] = useState('providers');
  const [overview, setOverview] = useState(null);
  const [policies, setPolicies] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState({ tone: 'ok', text: '' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadStorageOverview(), loadStoragePolicies()]).then(([storage, policyRows]) => {
      if (cancelled) return;
      if (storage.error) {
        setFeedback({ tone: 'error', text: codeLabel(t, 'pc_err', errorCode(storage.error), t('error_generic')) });
      } else {
        setOverview(storage.data);
      }
      if (!policyRows.error) setPolicies(policyRows.data || []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [reloadToken, t]);

  const run = async (action) => {
    setBusy(true);
    setFeedback({ tone: 'ok', text: '' });
    const { error } = await action();
    if (error) {
      setFeedback({ tone: 'error', text: codeLabel(t, 'pc_err', errorCode(error), t('error_generic')) });
    } else {
      setFeedback({ tone: 'ok', text: t('pc_saved') });
      setReloadToken((token) => token + 1);
    }
    setBusy(false);
  };

  const totals = overview?.totals || {};
  const tenants = overview?.tenants || [];
  const providers = overview?.providers || [];

  return (
    <div className="pc-console">
      <p className="field-note">{t('pc_storage_intro')}</p>

      <div className="segmented" role="tablist" aria-label={t('pc_storage_tabs_nav')}>
        {TABS.map(({ code, labelKey }) => (
          <button
            key={code}
            type="button"
            role="tab"
            aria-selected={tab === code}
            className={tab === code ? 'active' : ''}
            onClick={() => setTab(code)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      <div aria-live="polite" className={`pc-status-line ${feedback.tone === 'error' ? 'pc-error' : ''}`}>
        {loading ? t('label_loading') : feedback.text}
      </div>

      {tab === 'providers' ? <ProvidersTab providers={providers} /> : null}
      {tab === 'tenants' ? (
        <CompanyStorageTab
          tenants={tenants}
          busy={busy}
          onToggleExtended={(tenantId, next) => run(() => saveTenantStorage(tenantId, { is_enabled: next }))}
          onToggleChat={(tenantId, next) => run(() => setTenantChatAttachments(tenantId, next))}
        />
      ) : null}
      {tab === 'usage' ? <UsageTab totals={totals} tenants={tenants} /> : null}
      {tab === 'policies' ? (
        <PoliciesTab
          policies={policies}
          busy={busy}
          onSave={(layer, values) => run(() => saveStoragePolicy(layer, values))}
        />
      ) : null}
    </div>
  );
};

export default StorageManagement;
