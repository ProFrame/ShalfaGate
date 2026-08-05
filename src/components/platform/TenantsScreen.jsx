import { useEffect, useMemo, useState } from 'react';
import { Building2, Search, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { errorCode, loadTenantActivity, TENANT_STATUSES } from '../../data/platformService';
import { codeLabel, formatBytes, formatDate, formatNumber, pickFromMap } from '../../utils/localize';
import TenantDetailDrawer from './TenantDetailDrawer';

/** Status is stored as a code; the chip resolves its label and tone at render. */
export const TenantStatusChip = ({ status }) => {
  const { t } = useLanguage();
  if (!status) return <span className="pc-chip">{t('label_none')}</span>;
  return (
    <span className={`pc-chip pc-chip-${String(status).toLowerCase()}`}>
      {codeLabel(t, 'status', status, status)}
    </span>
  );
};

const TenantsScreen = ({ tenants = [], loading = false, onChanged }) => {
  const { t, lang, locale } = useLanguage();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [activity, setActivity] = useState({});
  const [activityError, setActivityError] = useState(null);
  const [openTenantId, setOpenTenantId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadTenantActivity().then(({ data, error }) => {
      if (cancelled) return;
      if (error) setActivityError(error);
      else { setActivityError(null); setActivity(data || {}); }
    });
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tenants
      .map((row) => ({ ...row, display_name: pickFromMap(row.names, lang, 'ar', row.slug) }))
      .filter((row) => (status ? row.status === status : true))
      .filter((row) => (
        !needle
        || row.slug.toLowerCase().includes(needle)
        || String(row.display_name).toLowerCase().includes(needle)
        || Object.values(row.names || {}).some((name) => String(name).toLowerCase().includes(needle))
      ));
  }, [tenants, query, status, lang]);

  return (
    <div className="pc-console">
      <p className="field-note">{t('pc_companies_intro')}</p>

      <div className="pc-toolbar">
        <label className="search-control">
          <Search aria-hidden="true" />
          <span className="sr-only">{t('action_search')}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('pc_search_companies')}
          />
          {query ? (
            <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label={t('action_clear')}>
              <X aria-hidden="true" width={13} height={13} />
            </button>
          ) : null}
        </label>

        <label className="sr-only" htmlFor="pc-tenant-status">{t('pc_filter_status_label')}</label>
        <select
          id="pc-tenant-status"
          className="pc-select"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">{t('label_all')}</option>
          {TENANT_STATUSES.map((code) => (
            <option key={code} value={code}>{codeLabel(t, 'status', code, code)}</option>
          ))}
        </select>

        <span className="pc-count">{t('pc_results_count', { count: formatNumber(rows.length, locale) })}</span>
      </div>

      {activityError ? (
        <p className="pc-status-line pc-error" aria-live="polite">
          {codeLabel(t, 'pc_err', errorCode(activityError), t('error_generic'))}
        </p>
      ) : null}

      <div className="data-table-wrap">
        <table className="enterprise-table">
          <thead>
            <tr>
              <th>{t('pc_col_company')}</th>
              <th>{t('label_status')}</th>
              <th>{t('pc_col_licence')}</th>
              <th>{t('pc_col_users')}</th>
              <th>{t('pc_col_active_users')}</th>
              <th>{t('pc_col_storage')}</th>
              <th>{t('pc_col_created')}</th>
              <th>{t('pc_col_last_activity')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.tenant_id}
                className={openTenantId === row.tenant_id ? 'selected-row' : ''}
                onClick={() => setOpenTenantId(row.tenant_id)}
              >
                <td>
                  <button
                    type="button"
                    className="pc-table-row-button"
                    onClick={() => setOpenTenantId(row.tenant_id)}
                    aria-label={t('pc_open_company', { company: row.display_name })}
                  >
                    <b>{row.display_name}</b>
                    <small className="pc-slug">/{row.slug}</small>
                  </button>
                </td>
                <td><TenantStatusChip status={row.status} /></td>
                <td><span className="pc-chip pc-chip-brand">{row.license_code}</span></td>
                <td>{formatNumber(row.users, locale)}</td>
                <td>{formatNumber(row.active_users, locale)}</td>
                <td>{formatBytes(row.storage_bytes, locale)}</td>
                <td>{formatDate(row.created_on, locale)}</td>
                <td>{activity[row.tenant_id] ? formatDate(activity[row.tenant_id], locale) : t('pc_never')}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {rows.length === 0 ? (
          <div className="empty-table">
            <Building2 aria-hidden="true" />
            <b>{loading ? t('label_loading') : t('pc_no_companies')}</b>
          </div>
        ) : null}
      </div>

      {openTenantId ? (
        <TenantDetailDrawer
          tenantId={openTenantId}
          onClose={() => setOpenTenantId(null)}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  );
};

export default TenantsScreen;
