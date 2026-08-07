// Operations — Manager Dashboard (admin/operations-dashboard, Operations.View
// or Operations.Manage, AdminNav id 'operations-dashboard').
//
// One aggregate RPC call (operations_dashboard_summary(), exposed here as
// loadDashboardSummary()) feeds five KPI cards plus four read-only activity
// panels — the same "one dashboard, one call, one consistent snapshot" shape
// SafetyComplianceAdmin.jsx's own build note documents for
// safety_compliance_summary(). No writes happen on this screen, so there is
// nothing to gate beyond the module check every admin report screen already
// performs (hasModule() + ModuleOffNotice), and no useDialogA11y/modal is
// needed.
//
// Row shapes below are copied straight from operations_dashboard_summary()'s
// own jsonb_build_object() (supabase/migrations/202608070057_operations.sql
// §6.14), not guessed:
//   latestRecords: id, operation_id, operation_number, operation_name_ar,
//     operation_name_en, log_date, description, completion_percent,
//     employee_id, employee_name, created_by, created_by_name, created_on
//   latestPhotos: id, execution_log_id, operation_id, operation_number,
//     log_date, path, file_name, mime_type, file_size, created_by,
//     created_by_name, created_on — that sub-query deliberately does not
//     select storage_objects.layer/provider_code/bucket (unlike
//     operations_execution_log_attachments_list()'s own row shape), so there
//     is no honest way to resolve a signed thumbnail URL from this payload
//     alone. This screen therefore shows each photo as a filename/meta card,
//     not an inline image — the actual image lives one click into that
//     execution log's own Attachments panel (OperationsPortal.jsx), which
//     does carry the columns needed to resolve it.
//   mostActiveEmployees: employee_id, employee_name, log_count (trailing 30
//     days, by created_by)
//   staleOperations: id, number, name_ar, name_en, status, last_log_date —
//     Active operations only, per that function's own where clause; a null
//     last_log_date means the operation has zero execution logs at all.
//
// Data access only ever goes through src/data/operationsService.js.

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2, ClipboardList, Gauge, History, ImageIcon, PauseCircle, Percent,
  PlayCircle, RefreshCcw, TriangleAlert, Trophy, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { loadDashboardSummary, operationsErrorMessage } from '../../data/operationsService';
import { ModuleOffNotice } from '../announcements/engagementUi';
import { formatDate, pickLocalized } from '../../utils/localize';
import './operations.css';

// Mirrors loadDashboardSummary()'s own default — no UI control for it per
// this screen's own build spec ("keep it simple"), so the note under the
// stale-operations panel below is the only place this number is surfaced.
const STALE_DAYS = 3;

const EMPTY_SUMMARY = {
  operationsCount: 0,
  activeCount: 0,
  completedCount: 0,
  onHoldCount: 0,
  avgCompletionPercent: null,
  latestRecords: [],
  latestPhotos: [],
  mostActiveEmployees: [],
  staleOperations: [],
};

const OperationsDashboardAdmin = () => {
  const { t, lang, locale } = useLanguage();
  const { hasModule } = useTenant();

  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [notice, setNotice] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  // `loading` is armed by refresh() below, never inside this effect — same
  // "effects only ever turn loading back off" convention
  // SafetyComplianceAdmin.jsx's own refresh()/effect split documents.
  // `loading` already starts true, so the first mount needs no extra call.
  useEffect(() => {
    let cancelled = false;
    loadDashboardSummary(STALE_DAYS).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setSummary(EMPTY_SUMMARY);
        setNotice(operationsErrorMessage(t, error) || t('admin_load_failed'));
      } else {
        setSummary({ ...EMPTY_SUMMARY, ...(data || {}) });
        setNotice('');
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [reloadToken, t]);

  const refresh = useCallback(() => {
    setLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  if (!hasModule('OPERATIONS')) return <ModuleOffNotice />;

  const avgCompletionLabel = summary.avgCompletionPercent == null ? '—' : `${summary.avgCompletionPercent}%`;

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('operations_module_kicker')}</span>
          <h1><Gauge className="admin-title-icon" aria-hidden="true" /> {t('operations_dashboard_title')}</h1>
          <p>{t('operations_dashboard_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="secondary-button" disabled={loading} onClick={refresh}>
            <RefreshCcw aria-hidden="true" /> {t('action_refresh')}
          </button>
        </div>
      </div>

      {notice && (
        <div className="inline-message error" role="status" aria-live="polite">
          <X aria-hidden="true" />
          {notice}
          <button type="button" onClick={() => setNotice('')} aria-label={t('action_close')}><X aria-hidden="true" /></button>
        </div>
      )}

      <div className="kpi-grid compact">
        <div className="kpi-card">
          <ClipboardList aria-hidden="true" />
          <div><span>{t('operations_dashboard_kpi_total')}</span><b>{loading ? '—' : summary.operationsCount}</b></div>
        </div>
        <div className="kpi-card">
          <PlayCircle aria-hidden="true" />
          <div><span>{t('operations_dashboard_kpi_active')}</span><b>{loading ? '—' : summary.activeCount}</b></div>
        </div>
        <div className="kpi-card">
          <CheckCircle2 aria-hidden="true" />
          <div><span>{t('operations_dashboard_kpi_completed')}</span><b>{loading ? '—' : summary.completedCount}</b></div>
        </div>
        <div className="kpi-card">
          <PauseCircle aria-hidden="true" />
          <div><span>{t('operations_dashboard_kpi_onhold')}</span><b>{loading ? '—' : summary.onHoldCount}</b></div>
        </div>
        <div className="kpi-card">
          <Percent aria-hidden="true" />
          <div><span>{t('operations_dashboard_kpi_avg_completion')}</span><b>{loading ? '—' : avgCompletionLabel}</b></div>
        </div>
      </div>

      <div className="dashboard-panels">
        <section className="dashboard-panel">
          <h3><History aria-hidden="true" /> {t('operations_dashboard_records_title')}</h3>
          <div className="data-table-wrap">
            <table className="enterprise-table">
              <thead>
                <tr>
                  <th>{t('operations_dashboard_col_operation')}</th>
                  <th>{t('operations_field_log_date')}</th>
                  <th>{t('operations_field_description')}</th>
                  <th>{t('operations_field_completion_percent')}</th>
                  <th>{t('label_created_by')}</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={5}>{t('label_loading')}</td></tr>
                )}
                {!loading && summary.latestRecords.map((row) => (
                  <tr key={row.id}>
                    <td><b>{pickLocalized(row, 'operation_name', lang, row.operation_number)}</b></td>
                    <td>{formatDate(row.log_date, locale) || '—'}</td>
                    <td>{row.description}</td>
                    <td>{row.completion_percent == null ? '—' : `${row.completion_percent}%`}</td>
                    <td>{row.created_by_name || t('label_none')}</td>
                  </tr>
                ))}
                {!loading && !summary.latestRecords.length && (
                  <tr>
                    <td colSpan={5}>
                      <div className="empty-table compact">
                        <History aria-hidden="true" />
                        <b>{t('operations_dashboard_records_empty')}</b>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="dashboard-panel">
          <h3><Trophy aria-hidden="true" /> {t('operations_dashboard_active_title')}</h3>
          {loading && <p className="field-note">{t('label_loading')}</p>}
          {!loading && !summary.mostActiveEmployees.length && (
            <p className="field-note">{t('operations_dashboard_active_empty')}</p>
          )}
          {!loading && summary.mostActiveEmployees.length > 0 && (
            <ul className="top-approvers">
              {summary.mostActiveEmployees.map((row, index) => (
                <li key={row.employee_id || index}>
                  <b>{row.employee_name || t('label_none')}</b>
                  <span>{t('operations_dashboard_active_count', { count: row.log_count })}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="dashboard-panel">
        <h3><ImageIcon aria-hidden="true" /> {t('operations_dashboard_photos_title')}</h3>
        {loading && <p className="field-note">{t('label_loading')}</p>}
        {!loading && !summary.latestPhotos.length && (
          <p className="field-note">{t('operations_dashboard_photos_empty')}</p>
        )}
        {!loading && summary.latestPhotos.length > 0 && (
          <div className="ops-photo-strip">
            {summary.latestPhotos.map((row) => (
              <div key={row.id} className="ops-photo-card">
                <span className="ops-photo-glyph"><ImageIcon aria-hidden="true" /></span>
                <span className="ops-photo-name" title={row.file_name}>{row.file_name}</span>
                <span className="ops-photo-meta"><code>{row.operation_number}</code></span>
                <span className="ops-photo-meta">{formatDate(row.log_date, locale) || '—'}</span>
                {row.created_by_name && <span className="ops-photo-meta">{row.created_by_name}</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="dashboard-panel">
        <h3><TriangleAlert aria-hidden="true" /> {t('operations_dashboard_stale_title')}</h3>
        <p className="field-note">{t('operations_dashboard_stale_note', { days: STALE_DAYS })}</p>
        {loading && <p className="field-note">{t('label_loading')}</p>}
        {!loading && !summary.staleOperations.length && (
          <p className="field-note">{t('operations_dashboard_stale_empty')}</p>
        )}
        {!loading && summary.staleOperations.length > 0 && (
          <ul className="ops-stale-list">
            {summary.staleOperations.map((row) => (
              <li key={row.id} className="ops-stale-item">
                <TriangleAlert aria-hidden="true" />
                <div>
                  <b>{pickLocalized(row, 'name', lang, row.number)}</b>
                  <div className="ops-stale-meta">
                    <code>{row.number}</code>
                    <span>
                      {row.last_log_date
                        ? t('operations_dashboard_last_record', { date: formatDate(row.last_log_date, locale) })
                        : t('operations_dashboard_never_logged')}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

export default OperationsDashboardAdmin;
