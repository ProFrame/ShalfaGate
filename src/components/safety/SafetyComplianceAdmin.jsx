// Safety Management — Compliance dashboard (admin/safety-compliance,
// Safety.View, ADMIN_SAFETY_COMPLIANCE). "شاشة متابعة الالتزام" per spec.
//
// Read-only reporting screen, structurally closest to AssetReportsAdmin.jsx's
// own filter-bar -> kpi-grid shape: four optional org-dimension filters feed
// safety_compliance_summary() (via loadComplianceSummary() in
// safetyService.js) and the aggregate {requiredCount, fullyIssuedCount,
// partiallyIssuedCount, notIssuedCount} it returns renders as four KPI
// cards. No writes happen here, so there is nothing to gate beyond the
// module check every report screen in this app already performs — the RPC's
// own Safety.View check is the real gate.
//
// Departments/positions come from orgDimensionsService.js's listOrgEntities()
// (active-only, one bounded page each); projects/sites come from the same
// module's loadOrgDimensions() (already active-only, unbounded) — the exact
// pair AssetReportsAdmin.jsx's own filter bar build instructions point at.
// Data access otherwise goes only through src/data/safetyService.js.

import { useEffect, useMemo, useState } from 'react';
import { Gauge, ListChecks, RefreshCcw, ShieldAlert, ShieldCheck, ShieldX, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { loadComplianceSummary, safetyErrorMessage } from '../../data/safetyService';
import { listOrgEntities, loadOrgDimensions } from '../../data/orgDimensionsService';
import { pickLocalized } from '../../utils/localize';
import { ModuleOffNotice } from '../announcements/engagementUi';
import './safety.css';

// listOrgEntities() paginates; one generous page covers every realistic
// department/position count without a second round trip, same reasoning
// AssetsCatalogueAdmin.jsx's own ASSET_PICKER_PAGE_SIZE documents.
const DIMENSION_PICKER_PAGE_SIZE = 200;

const EMPTY_FILTERS = { departmentId: '', projectId: '', siteId: '', positionId: '' };
const EMPTY_SUMMARY = { requiredCount: 0, fullyIssuedCount: 0, partiallyIssuedCount: 0, notIssuedCount: 0 };

const localizedName = (row, lang) => (row ? pickLocalized(row, 'name', lang, row.code) : '');

const SafetyComplianceAdmin = () => {
  const { t, lang } = useLanguage();
  const { hasModule } = useTenant();

  const [dimsLoading, setDimsLoading] = useState(true);
  const [departments, setDepartments] = useState([]);
  const [positions, setPositions] = useState([]);
  const [projects, setProjects] = useState([]);
  const [sites, setSites] = useState([]);
  const [pickersTruncated, setPickersTruncated] = useState(false);

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [notice, setNotice] = useState('');

  // Departments/positions/projects/sites are loaded once on mount — they are
  // org reference data, not filter-dependent, same "load the pickers once"
  // shape AssetReportsAdmin.jsx's own org-dimension effect uses.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listOrgEntities('departments', { includeInactive: false, page: 1, pageSize: DIMENSION_PICKER_PAGE_SIZE }),
      listOrgEntities('positions', { includeInactive: false, page: 1, pageSize: DIMENSION_PICKER_PAGE_SIZE }),
      loadOrgDimensions(),
    ]).then(([deptRes, posRes, dimsRes]) => {
      if (cancelled) return;
      const firstError = deptRes.error || posRes.error || dimsRes.error;
      if (firstError) setNotice(safetyErrorMessage(t, firstError) || t('admin_load_failed'));
      setDepartments(deptRes.data?.rows || []);
      setPositions(posRes.data?.rows || []);
      setProjects(dimsRes.data?.projects || []);
      setSites(dimsRes.data?.sites || []);
      setPickersTruncated(
        (deptRes.data?.total || 0) > (deptRes.data?.rows || []).length
        || (posRes.data?.total || 0) > (posRes.data?.rows || []).length,
      );
      setDimsLoading(false);
    });
    return () => { cancelled = true; };
  }, [t]);

  // `summaryLoading` is armed by whichever event handler is about to change
  // a filter (field()/clearFilters()/refresh() below) — never from inside
  // the effect itself, same "effects only ever turn loading back off"
  // convention SafetyPpeTypesAdmin.jsx's own refresh()/effect split
  // documents. `summaryLoading` already starts true, so the first mount
  // needs no handler to prime it.
  useEffect(() => {
    let cancelled = false;
    loadComplianceSummary(filters).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setNotice(safetyErrorMessage(t, error) || t('admin_load_failed'));
        setSummary(EMPTY_SUMMARY);
      } else {
        setSummary({ ...EMPTY_SUMMARY, ...(data || {}) });
      }
      setSummaryLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.departmentId, filters.projectId, filters.siteId, filters.positionId, reloadToken, t]);

  const refresh = () => { setSummaryLoading(true); setReloadToken((token) => token + 1); };

  const field = (key) => (event) => {
    setSummaryLoading(true);
    setFilters((current) => ({ ...current, [key]: event.target.value }));
  };
  const clearFilters = () => { setSummaryLoading(true); setFilters(EMPTY_FILTERS); };

  const noFiltersApplied = useMemo(
    () => !filters.departmentId && !filters.projectId && !filters.siteId && !filters.positionId,
    [filters],
  );

  if (!hasModule('SAFETY')) return <ModuleOffNotice />;

  return (
    <div className="admin-content safety-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('safety_module_kicker')}</span>
          <h1><Gauge className="admin-title-icon" aria-hidden="true" /> {t('safety_compliance_title')}</h1>
          <p>{t('safety_compliance_intro')}</p>
        </div>
        <button type="button" className="secondary-button" onClick={refresh}>
          <RefreshCcw aria-hidden="true" /> {t('refresh')}
        </button>
      </div>

      {notice && (
        <div className="inline-message error" role="status" aria-live="polite">
          <X aria-hidden="true" />
          {notice}
          <button type="button" onClick={() => setNotice('')} aria-label={t('action_close')}><X aria-hidden="true" /></button>
        </div>
      )}

      <div className="filter-bar">
        <select className="form-input" value={filters.departmentId} onChange={field('departmentId')} aria-label={t('filter_by_department')} disabled={dimsLoading}>
          <option value="">{t('filter_by_department')}</option>
          {departments.map((row) => <option key={row.id} value={row.id}>{localizedName(row, lang)}</option>)}
        </select>
        <select className="form-input" value={filters.positionId} onChange={field('positionId')} aria-label={t('position')} disabled={dimsLoading}>
          <option value="">{t('position')}</option>
          {positions.map((row) => <option key={row.id} value={row.id}>{localizedName(row, lang)}</option>)}
        </select>
        <select className="form-input" value={filters.projectId} onChange={field('projectId')} aria-label={t('filter_by_project')} disabled={dimsLoading}>
          <option value="">{t('filter_by_project')}</option>
          {projects.map((row) => <option key={row.id} value={row.id}>{localizedName(row, lang)}</option>)}
        </select>
        <select className="form-input" value={filters.siteId} onChange={field('siteId')} aria-label={t('site')} disabled={dimsLoading}>
          <option value="">{t('site')}</option>
          {sites.map((row) => <option key={row.id} value={row.id}>{localizedName(row, lang)}</option>)}
        </select>
        <button type="button" className="secondary-button" onClick={clearFilters}><X aria-hidden="true" /> {t('clear_filters')}</button>
      </div>

      {pickersTruncated && <p className="field-note">{t('safety_compliance_picker_truncated_hint')}</p>}
      {noFiltersApplied && <p className="field-note">{t('safety_compliance_everyone_hint')}</p>}

      <div className="kpi-grid compact">
        <div className="kpi-card">
          <ListChecks aria-hidden="true" />
          <div><span>{t('safety_compliance_kpi_required')}</span><b>{summaryLoading ? '—' : summary.requiredCount}</b></div>
        </div>
        <div className="kpi-card">
          <ShieldCheck aria-hidden="true" />
          <div><span>{t('safety_compliance_kpi_fully_issued')}</span><b>{summaryLoading ? '—' : summary.fullyIssuedCount}</b></div>
        </div>
        <div className="kpi-card">
          <ShieldAlert aria-hidden="true" />
          <div><span>{t('safety_compliance_kpi_partially_issued')}</span><b>{summaryLoading ? '—' : summary.partiallyIssuedCount}</b></div>
        </div>
        <div className="kpi-card sla">
          <ShieldX aria-hidden="true" />
          <div><span>{t('safety_compliance_kpi_not_issued')}</span><b>{summaryLoading ? '—' : summary.notIssuedCount}</b></div>
        </div>
      </div>
    </div>
  );
};

export default SafetyComplianceAdmin;
