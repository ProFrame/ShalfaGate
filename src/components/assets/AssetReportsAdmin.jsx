// Asset Reports — read-only, filterable views over the asset fleet.
//
// Modeled closely on ApprovalAdmin.jsx's ApprovalTrackingAdmin /
// ApprovalAllRequestsAdmin (filter-bar -> data-table-wrap/enterprise-table ->
// empty-table conventions). Unlike those screens this one issues no writes at
// all — it is pure reporting, so none of its controls need useDialogA11y
// (there are no modals here to gate).
//
// Data sources:
//   - Every asset-domain read (groups, custody units, the asset list itself,
//     per-asset transactions/maintenance, inventory sessions/scans) comes
//     from src/data/assetsService.js only, exactly like every other Assets
//     screen — never a direct supabase call from this component.
//   - Department names, the employee directory and project names are *org*
//     reference data, not asset-domain data; assetsService.js does not (and
//     should not) duplicate those tables, so this screen reuses the same
//     already-established read-only loaders every other admin report already
//     reuses for that purpose: loadDepartmentsForFilter()/loadRecipients()
//     from approvalService.js (assetsService.js's own header comment cites
//     loadDepartmentsForFilter() as precedent for exactly this) and
//     loadOrgDimensions() from orgDimensionsService.js for project names —
//     the same pair of services the Custody Units admin screen's own build
//     instructions point at for site/project/department pickers.
//
// No bulk "all transactions" / "all maintenance cases" RPC exists (by
// design, per the product spec for this screen), so:
//   - "Last movement" is computed lazily, on demand, for the currently
//     filtered/visible rows only (capped), one loadAssetTransactions() call
//     per asset, taking its first (already-sorted-desc) row.
//   - "Maintenance history" and "inventory history" are their own tabs
//     driven by a user-directed lookup (pick an asset / pick a session)
//     rather than a company-wide join, so the number of requests stays
//     bounded by what the admin actually asks to see.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArchiveX, Check, CircleAlert, ClipboardList, Clock, Eye, Package, PackageSearch, PackageX, RefreshCcw, Search,
  Wrench, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { codeLabel, formatDate, pickLocalized } from '../../utils/localize';
import { useArabicName } from '../../utils/approval';
import {
  ASSET_STATUSES, assetsErrorMessage, loadAssetGroups, loadAssetMaintenance, loadAssets,
  loadCustodyUnits, loadInventorySessionScans, loadInventorySessions, loadLastMovementForAssets,
} from '../../data/assetsService';
import { loadDepartmentsForFilter, loadRecipients } from '../../data/approvalService';
import { loadOrgDimensions } from '../../data/orgDimensionsService';
import { ModuleOffNotice } from '../announcements/engagementUi';
import { sessionStatusLabel } from './assetsVocabulary';
import './assets.css';

const UNUSED_DAYS_THRESHOLD = 90;
const LAST_MOVEMENT_CAP = 60;

const EMPTY_FILTERS = {
  groupId: '', status: '', custodyUnitId: '', departmentId: '', projectId: '', custodianUserId: '',
  purchaseFrom: '', purchaseTo: '', search: '',
};

const isUnusedAsset = (asset) => {
  if (asset.status !== 'Available' || asset.current_custodian_user_id) return false;
  const anchor = asset.purchase_date || asset.created_on;
  if (!anchor) return false;
  const days = (Date.now() - new Date(anchor).getTime()) / 86400000;
  return Number.isFinite(days) && days >= UNUSED_DAYS_THRESHOLD;
};

const localizedName = (row, lang) => (row ? pickLocalized(row, 'name', lang, row.name_ar || row.name) : '');

const AssetReportsAdmin = ({ onViewAsset } = {}) => {
  const { t, lang, locale } = useLanguage();
  const { hasModule } = useTenant();
  const { employeeName } = useArabicName();

  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState('overview');

  const [groups, setGroups] = useState([]);
  const [custodyUnits, setCustodyUnits] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [projects, setProjects] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [assets, setAssets] = useState([]);
  const [reportRows, setReportRows] = useState([]);
  const [inventorySessions, setInventorySessions] = useState([]);

  const [filters, setFilters] = useState(EMPTY_FILTERS);

  const [lastMovementById, setLastMovementById] = useState({});
  const [lastMovementBusy, setLastMovementBusy] = useState(false);

  const [maintenanceQuery, setMaintenanceQuery] = useState('');
  const [maintenanceAsset, setMaintenanceAsset] = useState(null);
  const [maintenanceCases, setMaintenanceCases] = useState(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);

  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [sessionScans, setSessionScans] = useState(null);
  const [sessionBusy, setSessionBusy] = useState(false);

  // fetchAll() itself never sets state synchronously (only inside the
  // Promise's .then()), so the mount effect below may call it directly.
  // `loading` already starts true (useState(true) above) for that first
  // call; refresh() is the one callers reach for afterwards (the toolbar
  // button), and it is never invoked from inside an effect body — same
  // split ApprovalAllRequestsAdmin's own fetchRows()/runSearch() uses in
  // ApprovalAdmin.jsx for the same reason. fetchAll() returns its own
  // cancellation cleanup (same "let cancelled = false" guard every sibling
  // load in this module uses), so the mount effect can hand it back as its
  // own cleanup function.
  const fetchAll = useCallback(() => {
    let cancelled = false;
    Promise.all([loadAssetGroups(), loadCustodyUnits(), loadAssets({ limit: 2000 }), loadInventorySessions()])
      .then(([groupsRes, unitsRes, assetsRes, sessionsRes]) => {
        if (cancelled) return;
        const firstError = groupsRes.error || unitsRes.error || assetsRes.error || sessionsRes.error;
        if (firstError) setNotice(assetsErrorMessage(t, firstError));
        setGroups(groupsRes.data || []);
        setCustodyUnits(unitsRes.data || []);
        setAssets(assetsRes.data || []);
        setInventorySessions(sessionsRes.data || []);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [t]);

  const refresh = () => { setLoading(true); fetchAll(); };

  useEffect(() => fetchAll(), [fetchAll]);

  // Org reference data (department names, the employee directory, project
  // names) — loaded once, independent of the asset refresh above; see the
  // header comment for why this does not go through assetsService.js.
  useEffect(() => {
    let cancelled = false;
    loadDepartmentsForFilter()
      .then((data) => { if (!cancelled) setDepartments(data); })
      .catch(() => { if (!cancelled) setDepartments([]); });
    loadRecipients()
      .then((data) => { if (!cancelled) setEmployees(data); })
      .catch(() => { if (!cancelled) setEmployees([]); });
    loadOrgDimensions()
      .then(({ data }) => { if (!cancelled) setProjects(data?.projects || []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, []);

  // Rows for the Overview/Unused/Lost/Disposed/Maintenance tabs are narrowed
  // server-side (same loadAssets() filter params AssetsCatalogueAdmin.jsx
  // uses) instead of pulling the whole fleet and filtering it in JS. `assets`
  // above stays the unfiltered fleet load — the KPI cards, the maintenance
  // asset picker and the inventory-scan lookup below all need the whole
  // fleet regardless of what this filter bar currently narrows.
  useEffect(() => {
    let cancelled = false;
    loadAssets({
      groupId: filters.groupId || undefined,
      status: filters.status || undefined,
      custodyUnitId: filters.custodyUnitId || undefined,
      custodianUserId: filters.custodianUserId || undefined,
      search: filters.search || undefined,
      limit: 2000,
    }).then(({ data, error }) => {
      if (cancelled) return;
      if (error) setNotice(assetsErrorMessage(t, error));
      setReportRows(data || []);
    });
    return () => { cancelled = true; };
  }, [filters.groupId, filters.status, filters.custodyUnitId, filters.custodianUserId, filters.search, t]);

  const groupById = useMemo(() => Object.fromEntries(groups.map((row) => [row.id, row])), [groups]);
  const unitById = useMemo(() => Object.fromEntries(custodyUnits.map((row) => [row.id, row])), [custodyUnits]);
  const departmentById = useMemo(() => Object.fromEntries(departments.map((row) => [row.id, row])), [departments]);
  const projectById = useMemo(() => Object.fromEntries(projects.map((row) => [row.id, row])), [projects]);
  const employeeById = useMemo(() => Object.fromEntries(employees.map((row) => [row.id, row])), [employees]);
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);

  // groupId/status/custodyUnitId/custodianUserId/search are already applied
  // server-side by the effect above; department/project (no direct column on
  // assets — needs the custody unit join) and the purchase-date range (not a
  // loadAssets() filter param) are the only ones still narrowed here.
  const filteredAssets = useMemo(() => reportRows.filter((asset) => {
    const unit = unitById[asset.current_custody_unit_id];
    if (filters.departmentId && unit?.department_id !== filters.departmentId) return false;
    if (filters.projectId && unit?.project_id !== filters.projectId) return false;
    if (filters.purchaseFrom && (!asset.purchase_date || asset.purchase_date < filters.purchaseFrom)) return false;
    if (filters.purchaseTo && (!asset.purchase_date || asset.purchase_date > filters.purchaseTo)) return false;
    return true;
  }), [reportRows, filters.departmentId, filters.projectId, filters.purchaseFrom, filters.purchaseTo, unitById]);

  const unusedAssets = useMemo(() => filteredAssets.filter(isUnusedAsset), [filteredAssets]);
  const lostAssets = useMemo(() => filteredAssets.filter((asset) => asset.status === 'Lost'), [filteredAssets]);
  const disposedAssets = useMemo(() => filteredAssets.filter((asset) => asset.status === 'Disposed'), [filteredAssets]);
  const inMaintenanceAssets = useMemo(() => filteredAssets.filter((asset) => asset.status === 'InMaintenance'), [filteredAssets]);

  const kpis = useMemo(() => ({
    total: assets.length,
    unused: assets.filter(isUnusedAsset).length,
    lost: assets.filter((asset) => asset.status === 'Lost').length,
    disposed: assets.filter((asset) => asset.status === 'Disposed').length,
    inMaintenance: assets.filter((asset) => asset.status === 'InMaintenance').length,
  }), [assets]);

  const loadLastMovementFor = useCallback((rows) => {
    const targets = rows.filter((asset) => !(asset.id in lastMovementById));
    if (!targets.length) return;
    setLastMovementBusy(true);
    loadLastMovementForAssets(targets.map((asset) => asset.id))
      .then(({ data }) => setLastMovementById((prev) => ({ ...prev, ...(data || {}) })))
      .finally(() => setLastMovementBusy(false));
  }, [lastMovementById]);

  const maintenanceCandidates = useMemo(() => {
    const needle = maintenanceQuery.trim().toLowerCase();
    if (!needle) return [];
    return assets
      .filter((asset) => `${asset.reference} ${asset.name_ar} ${asset.name_en || ''}`.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [assets, maintenanceQuery]);

  const pickMaintenanceAsset = (asset) => {
    setMaintenanceAsset(asset);
    setMaintenanceQuery('');
    setMaintenanceCases(null);
    setMaintenanceBusy(true);
    loadAssetMaintenance(asset.id).then(({ data, error }) => {
      if (error) { setNotice(assetsErrorMessage(t, error)); setMaintenanceCases([]); } else setMaintenanceCases(data || []);
      setMaintenanceBusy(false);
    });
  };

  const pickSession = (sessionId) => {
    setSelectedSessionId(sessionId);
    setSessionScans(null);
    if (!sessionId) return;
    setSessionBusy(true);
    loadInventorySessionScans(sessionId).then(({ data, error }) => {
      if (error) { setNotice(assetsErrorMessage(t, error)); setSessionScans([]); } else setSessionScans(data || []);
      setSessionBusy(false);
    });
  };

  const sessionScanSummary = useMemo(() => {
    if (!sessionScans) return null;
    const counts = {};
    sessionScans.forEach((scan) => { counts[scan.result_status] = (counts[scan.result_status] || 0) + 1; });
    return counts;
  }, [sessionScans]);

  const field = (key) => (event) => setFilters({ ...filters, [key]: event.target.value });
  const clearFilters = () => setFilters(EMPTY_FILTERS);

  const TAB_DEFS = [
    { id: 'overview', Icon: Package, labelKey: 'assets_reports_tab_overview', count: filteredAssets.length },
    { id: 'unused', Icon: PackageSearch, labelKey: 'assets_reports_tab_unused', count: unusedAssets.length },
    { id: 'lost', Icon: PackageX, labelKey: 'assets_reports_tab_lost', count: lostAssets.length },
    { id: 'disposed', Icon: ArchiveX, labelKey: 'assets_reports_tab_disposed', count: disposedAssets.length },
    { id: 'maintenance', Icon: Wrench, labelKey: 'assets_reports_tab_maintenance', count: inMaintenanceAssets.length },
    { id: 'inventory', Icon: ClipboardList, labelKey: 'assets_reports_tab_inventory', count: inventorySessions.length },
  ];

  const renderAssetsTable = (rows, { showLastMovement = false, emptyKey, emptyHintKey } = {}) => (
    <div className="data-table-wrap">
      <table className="enterprise-table">
        <thead>
          <tr>
            <th>{t('reference')}</th>
            <th>{t('name')}</th>
            <th>{t('label_group')}</th>
            <th>{t('status')}</th>
            <th>{t('label_custody_unit')}</th>
            <th>{t('label_current_custodian')}</th>
            <th>{t('department')}</th>
            <th>{t('project')}</th>
            <th>{t('label_purchase_date')}</th>
            {showLastMovement && <th>{t('label_last_movement')}</th>}
            {onViewAsset && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((asset) => {
            const unit = unitById[asset.current_custody_unit_id];
            const department = departmentById[unit?.department_id];
            const project = projectById[unit?.project_id];
            const custodian = employeeById[asset.current_custodian_user_id];
            const movement = lastMovementById[asset.id];
            return (
              <tr key={asset.id}>
                <td><code>{asset.reference}</code></td>
                <td>{localizedName(asset, lang) || '—'}</td>
                <td>{groupById[asset.group_id] ? localizedName(groupById[asset.group_id], lang) : '—'}</td>
                <td><span className={`status-badge status-${String(asset.status).toLowerCase()}`}>{codeLabel(t, 'asset_status', asset.status, asset.status)}</span></td>
                <td>{unit ? localizedName(unit, lang) : '—'}</td>
                <td>{employeeName(custodian) || '—'}</td>
                <td>{department ? localizedName(department, lang) : '—'}</td>
                <td>{project ? localizedName(project, lang) : '—'}</td>
                <td>{formatDate(asset.purchase_date, locale) || '—'}</td>
                {showLastMovement && (
                  <td>{asset.id in lastMovementById ? (movement ? formatDate(movement.performedOn, locale) : t('assets_reports_no_movement')) : '—'}</td>
                )}
                {onViewAsset && (
                  <td><div className="table-actions"><button type="button" onClick={() => onViewAsset(asset.id)} title={t('view_details')} aria-label={t('view_details')}><Eye /></button></div></td>
                )}
              </tr>
            );
          })}
          {!loading && !rows.length && (
            <tr>
              <td colSpan={9 + (showLastMovement ? 1 : 0) + (onViewAsset ? 1 : 0)}>
                <div className="empty-table"><Package /><b>{t(emptyKey || 'assets_reports_empty')}</b><span>{t(emptyHintKey || 'assets_reports_empty_hint')}</span></div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  if (!hasModule('ASSETS')) return <ModuleOffNotice />;

  return (
    <div className="admin-content assets-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('module_assets')}</span>
          <h1>{t('assets_reports_title')}</h1>
          <p>{t('assets_reports_intro')}</p>
        </div>
        <button className="secondary-button" onClick={refresh}><RefreshCcw /> {t('refresh')}</button>
      </div>

      {notice && (
        <div className="inline-message" role="status" aria-live="polite">
          <CircleAlert />{notice}
          <button type="button" onClick={() => setNotice('')} aria-label={t('action_close')}><X /></button>
        </div>
      )}

      <div className="kpi-grid compact">
        <div className="kpi-card"><Package /><div><span>{t('kpi_total_assets')}</span><b>{kpis.total}</b></div></div>
        <div className="kpi-card"><PackageSearch /><div><span>{t('kpi_unused_assets')}</span><b>{kpis.unused}</b></div></div>
        <div className="kpi-card sla"><PackageX /><div><span>{t('kpi_lost_assets')}</span><b>{kpis.lost}</b></div></div>
        <div className="kpi-card"><ArchiveX /><div><span>{t('kpi_disposed_assets')}</span><b>{kpis.disposed}</b></div></div>
        <div className="kpi-card"><Wrench /><div><span>{t('kpi_in_maintenance_assets')}</span><b>{kpis.inMaintenance}</b></div></div>
      </div>

      <div className="segmented" role="tablist" aria-label={t('assets_reports_title')}>
        {TAB_DEFS.map(({ id, Icon, labelKey, count }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`assets-reports-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`assets-reports-tabpanel-${id}`}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            <Icon size={16} /> {t(labelKey)}<span className="tab-count">{count}</span>
          </button>
        ))}
      </div>

      <div id={`assets-reports-tabpanel-${tab}`} role="tabpanel" aria-labelledby={`assets-reports-tab-${tab}`}>
        {['overview', 'unused', 'lost', 'disposed', 'maintenance'].includes(tab) && (
          <div className="filter-bar">
            <select className="form-input" value={filters.groupId} onChange={field('groupId')} aria-label={t('filter_by_group')}>
              <option value="">{t('filter_by_group')}</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{localizedName(group, lang)}</option>)}
            </select>
            <select className="form-input" value={filters.status} onChange={field('status')} aria-label={t('all_statuses')}>
              <option value="">{t('all_statuses')}</option>
              {ASSET_STATUSES.map((status) => <option key={status} value={status}>{codeLabel(t, 'asset_status', status, status)}</option>)}
            </select>
            <select className="form-input" value={filters.custodyUnitId} onChange={field('custodyUnitId')} aria-label={t('filter_by_custody_unit')}>
              <option value="">{t('filter_by_custody_unit')}</option>
              {custodyUnits.map((unit) => <option key={unit.id} value={unit.id}>{localizedName(unit, lang)}</option>)}
            </select>
            <select className="form-input" value={filters.departmentId} onChange={field('departmentId')} aria-label={t('filter_by_department')}>
              <option value="">{t('filter_by_department')}</option>
              {departments.map((department) => <option key={department.id} value={department.id}>{localizedName(department, lang)}</option>)}
            </select>
            <select className="form-input" value={filters.projectId} onChange={field('projectId')} aria-label={t('filter_by_project')}>
              <option value="">{t('filter_by_project')}</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{localizedName(project, lang)}</option>)}
            </select>
            <select className="form-input" value={filters.custodianUserId} onChange={field('custodianUserId')} aria-label={t('filter_by_custodian')}>
              <option value="">{t('filter_by_custodian')}</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employeeName(employee)}</option>)}
            </select>
            <label className="field-label">{t('filter_by_date_from')}
              <input type="date" className="form-input" value={filters.purchaseFrom} onChange={field('purchaseFrom')} />
            </label>
            <label className="field-label">{t('filter_by_date_to')}
              <input type="date" className="form-input" value={filters.purchaseTo} onChange={field('purchaseTo')} />
            </label>
            <div className="search-control">
              <Search size={16} />
              <input value={filters.search} onChange={field('search')} placeholder={t('assets_reports_search_placeholder')} aria-label={t('action_search')} />
            </div>
            <button className="secondary-button" onClick={clearFilters}><X /> {t('clear_filters')}</button>
          </div>
        )}

        {tab === 'overview' && (
          <>
            <div className="assets-report-toolbar">
              <p className="field-note">{t('assets_reports_last_movement_hint', { count: LAST_MOVEMENT_CAP })}</p>
              <button type="button" className="secondary-button" disabled={lastMovementBusy} onClick={() => loadLastMovementFor(filteredAssets.slice(0, LAST_MOVEMENT_CAP))}>
                <Clock size={16} /> {lastMovementBusy ? t('saving') : t('action_load_last_movement')}
              </button>
            </div>
            {filteredAssets.length > LAST_MOVEMENT_CAP && (
              <p className="field-note">{t('assets_reports_last_movement_capped', { count: LAST_MOVEMENT_CAP, total: filteredAssets.length })}</p>
            )}
            {renderAssetsTable(filteredAssets, { showLastMovement: true })}
          </>
        )}

        {tab === 'unused' && (
          <>
            <p className="field-note">{t('assets_reports_unused_hint', { days: UNUSED_DAYS_THRESHOLD })}</p>
            {renderAssetsTable(unusedAssets, { emptyKey: 'assets_reports_empty_unused', emptyHintKey: 'assets_reports_empty_unused_hint' })}
          </>
        )}

        {tab === 'lost' && (
          <>
            <p className="field-note">{t('assets_reports_lost_hint')}</p>
            {renderAssetsTable(lostAssets, { emptyKey: 'assets_reports_empty_lost', emptyHintKey: 'assets_reports_empty_hint' })}
          </>
        )}

        {tab === 'disposed' && (
          <>
            <p className="field-note">{t('assets_reports_disposed_hint')}</p>
            {renderAssetsTable(disposedAssets, { emptyKey: 'assets_reports_empty_disposed', emptyHintKey: 'assets_reports_empty_hint' })}
          </>
        )}

        {tab === 'maintenance' && (
          <div className="dashboard-panels">
            <section className="dashboard-panel">
              <h3><Wrench size={16} /> {t('assets_reports_maintenance_current_title')}</h3>
              {renderAssetsTable(inMaintenanceAssets, { emptyKey: 'assets_reports_empty_maintenance', emptyHintKey: 'assets_reports_empty_hint' })}
            </section>
            <section className="dashboard-panel assets-report-lookup">
              <h3>{t('assets_reports_maintenance_lookup_title')}</h3>
              <p className="field-note">{t('assets_reports_maintenance_lookup_hint')}</p>
              <div className="search-control">
                <Search size={16} />
                <input value={maintenanceQuery} onChange={(event) => setMaintenanceQuery(event.target.value)} placeholder={t('assets_reports_search_asset_placeholder')} aria-label={t('action_search')} />
              </div>
              {!!maintenanceCandidates.length && (
                <ul className="assets-report-candidates">
                  {maintenanceCandidates.map((asset) => (
                    <li key={asset.id}>
                      <button type="button" onClick={() => pickMaintenanceAsset(asset)}>
                        <code>{asset.reference}</code> {localizedName(asset, lang)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {!maintenanceAsset && <p className="field-note">{t('assets_reports_no_asset_selected')}</p>}
              {maintenanceAsset && (
                <div className="data-table-wrap">
                  <table className="enterprise-table">
                    <thead>
                      <tr>
                        <th>{t('reference')}</th>
                        <th>{t('status')}</th>
                        <th>{t('label_issue_description')}</th>
                        <th>{t('label_reported_on')}</th>
                        <th>{t('label_completed_on')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(maintenanceCases || []).map((row) => (
                        <tr key={row.id}>
                          <td><code>{row.reference}</code></td>
                          <td><span className={`status-badge status-${String(row.status).toLowerCase()}`}>{codeLabel(t, 'asset_maint_status', row.status, row.status)}</span></td>
                          <td>{row.issue_description || '—'}</td>
                          <td>{formatDate(row.reported_on, locale) || '—'}</td>
                          <td>{formatDate(row.completed_on, locale) || '—'}</td>
                        </tr>
                      ))}
                      {!maintenanceBusy && maintenanceCases && !maintenanceCases.length && (
                        <tr><td colSpan="5"><div className="empty-table"><Wrench /><b>{t('assets_reports_no_maintenance_history')}</b></div></td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}

        {tab === 'inventory' && (
          <div className="dashboard-panels">
            <section className="dashboard-panel">
              <h3><ClipboardList size={16} /> {t('assets_reports_tab_inventory')}</h3>
              <div className="data-table-wrap">
                <table className="enterprise-table">
                  <thead><tr><th>{t('reference')}</th><th>{t('name')}</th><th>{t('status')}</th><th>{t('label_period')}</th><th /></tr></thead>
                  <tbody>
                    {inventorySessions.map((session) => {
                      const isSelected = selectedSessionId === session.id;
                      return (
                        <tr key={session.id} className={isSelected ? 'assets-row-selected' : ''} aria-selected={isSelected}>
                          <td><code>{session.reference}</code></td>
                          <td>
                            {localizedName(session, lang)}
                            {isSelected && <span className="assets-row-selected-badge"><Check size={11} /> {t('assets_reports_session_selected')}</span>}
                          </td>
                          <td><span className={`status-badge status-${String(session.status).toLowerCase()}`}>{sessionStatusLabel(t, session.status)}</span></td>
                          <td>{formatDate(session.start_date, locale) || '—'} – {formatDate(session.end_date, locale) || '—'}</td>
                          <td><div className="table-actions"><button type="button" onClick={() => pickSession(session.id)} title={t('assets_reports_pick_session')} aria-label={t('assets_reports_pick_session')}><Eye /></button></div></td>
                        </tr>
                      );
                    })}
                    {!loading && !inventorySessions.length && (
                      <tr><td colSpan="5"><div className="empty-table"><ClipboardList /><b>{t('assets_reports_empty')}</b></div></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="dashboard-panel assets-report-lookup">
              <h3>{t('assets_reports_session_scans_title')}</h3>
              {!selectedSessionId && <p className="field-note">{t('assets_reports_no_session_selected')}</p>}
              {selectedSessionId && sessionScanSummary && (
                <div className="assets-chip-row">
                  {Object.entries(sessionScanSummary).map(([resultStatus, count]) => (
                    <span key={resultStatus} className="assets-chip">{codeLabel(t, 'scan_result', resultStatus, resultStatus)}: {count}</span>
                  ))}
                </div>
              )}
              {selectedSessionId && (
                <div className="data-table-wrap">
                  <table className="enterprise-table">
                    <thead>
                      <tr>
                        <th>{t('reference')}</th>
                        <th>{t('label_scanned_code')}</th>
                        <th>{t('status')}</th>
                        <th>{t('label_scanned_on')}</th>
                        <th>{t('label_notes')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(sessionScans || []).map((scan) => {
                        const scannedAsset = scan.asset_id ? assetById.get(scan.asset_id) : null;
                        return (
                          <tr key={scan.id}>
                            <td>{scannedAsset ? <code>{scannedAsset.reference}</code> : '—'}</td>
                            <td>{scan.scanned_code || '—'}</td>
                            <td><span className={`scan-badge scan-${String(scan.result_status).toLowerCase()}`}>{codeLabel(t, 'scan_result', scan.result_status, scan.result_status)}</span></td>
                            <td>{formatDate(scan.scanned_on, locale) || '—'}</td>
                            <td>{scan.notes || '—'}</td>
                          </tr>
                        );
                      })}
                      {!sessionBusy && sessionScans && !sessionScans.length && (
                        <tr><td colSpan="5"><div className="empty-table"><ClipboardList /><b>{t('assets_reports_no_scans')}</b></div></td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
};

export default AssetReportsAdmin;