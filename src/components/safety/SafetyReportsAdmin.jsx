// Safety Management — Safety Reports (admin/safety-reports, Safety.View,
// ADMIN_SAFETY_REPORTS).
//
// Read-only, tab-switched report set, structured exactly like Assets
// Management's own AssetReportsAdmin.jsx (segmented tab bar -> data-table-
// wrap/enterprise-table -> empty-table conventions, kpi-grid up top, no
// modals — nothing here writes anything, so useDialogA11y never applies).
// Data access only ever goes through src/data/safetyService.js, plus the
// same org-reference reuse every other admin report already makes:
// loadRecipients() (src/data/approvalService.js) for the employee directory
// — which already returns each employee's department/project/site as plain
// text (list_form_recipients()'s own join), so no separate id->name lookup
// is needed for the Distribution cut — and loadOrgDimensions() (src/data/
// orgDimensionsService.js) for project/site names on the Field Visit log.
//
// Two report cuts need data no single bulk RPC returns:
//   - Not-issued / Partially-issued (per spec: "same underlying data as the
//     Compliance screen's partiallyIssuedCount/notIssuedCount, but here as a
//     ROW LIST"). safety_compliance_summary() only returns aggregate counts
//     (see the migration's own PL/pgSQL), so the row list is built the only
//     way the data actually supports: loadPpeRequirementsForEmployee() +
//     loadMyPpe() per employee, mirroring that RPC's own comparison exactly
//     (required = every PPE type from any PPE Set whose Audience Engine rule
//     matches the employee, regardless of is_mandatory; held = currently
//     Issued items only) — capped to EMPLOYEE_COMPLIANCE_CAP employees and
//     triggered on demand (never automatically on mount), same lazy+capped
//     shape AssetReportsAdmin.jsx's own "Load last movement" button already
//     established for its own per-row N+1 read.
//   - Lost / Most-replaced / Distribution all need item-level status across
//     every issuance, which only loadIssuanceItems(issuanceId) — scoped to
//     one issuance — provides; they share one on-demand, capped flatten
//     (loadIssuances() already loaded, then loadIssuanceItems() per row, up
//     to ISSUANCE_ITEMS_SCAN_CAP) computed once and reused by all three tabs,
//     the same bounded-list-reuse this screen's own build note calls out as
//     precedent.
// Expired reuses SafetyExpirationsAdmin.jsx's own two data sources
// (loadAssetExtList/loadExpiringIssuanceItems) filtered to overdue only.
// Issuance log and Field visit log show their own bulk load eagerly (single
// bounded call each) with a per-row on-demand detail lookup — the same
// "browse the list, fetch detail only for the one row picked" shape
// AssetReportsAdmin.jsx's own maintenance/inventory-scan lookups use —
// instead of flattening every item/check up front.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import {
  Building2, CalendarX, Check, ClipboardList, Eye, MapPinCheck, PackageX, RefreshCcw, Repeat, TriangleAlert,
  UserX, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { useArabicName } from '../../utils/approval';
import { codeLabel, formatDate, formatList, pickLocalized } from '../../utils/localize';
import { loadRecipients } from '../../data/approvalService';
import { loadOrgDimensions } from '../../data/orgDimensionsService';
import {
  safetyErrorMessage, loadPpeTypes, loadPpeSets, loadAssetExtList, loadExpiringIssuanceItems,
  loadIssuances, loadIssuancesByIds, loadIssuanceItems, loadIssuanceItemsBulk, loadFieldVisits, loadFieldVisitChecks,
  loadPpeRequirementsForEmployee, loadMyPpe,
} from '../../data/safetyService';
import { ModuleOffNotice } from '../announcements/engagementUi';
import { isOverdue, DueCell } from './safetyDueCell';
import './safety.css';

const PAGE_SIZE = 200;
const EMPLOYEE_COMPLIANCE_CAP = 100;
const ISSUANCE_ITEMS_SCAN_CAP = 150;

const TAB_ICONS = {
  notIssued: UserX, partial: TriangleAlert, expired: CalendarX, lost: PackageX,
  mostReplaced: Repeat, distribution: Building2, issuanceLog: ClipboardList, visitLog: MapPinCheck,
};

const TAB_LABEL_KEYS = {
  notIssued: 'safety_reports_tab_not_issued', partial: 'safety_reports_tab_partial',
  expired: 'safety_reports_tab_expired', lost: 'safety_reports_tab_lost',
  mostReplaced: 'safety_reports_tab_most_replaced', distribution: 'safety_reports_tab_distribution',
  issuanceLog: 'safety_reports_tab_issuance_log', visitLog: 'safety_reports_tab_visit_log',
};

const SafetyReportsAdmin = () => {
  const { t, lang, locale } = useLanguage();
  const { hasModule } = useTenant();
  const { employeeName } = useArabicName();
  const [, navigate] = useLocation();

  const [tab, setTab] = useState('notIssued');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [ppeTypes, setPpeTypes] = useState([]);
  const [ppeSets, setPpeSets] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [projects, setProjects] = useState([]);
  const [sites, setSites] = useState([]);
  const [assetExtRows, setAssetExtRows] = useState([]);
  const [expiringItems, setExpiringItems] = useState([]);
  const [issuances, setIssuances] = useState([]);
  // Issuances referenced by expiringItems but NOT present in the recency-
  // capped `issuances` page above (expiringItems is its own independently
  // ordered/capped list — see loadExpiringIssuanceItems()) — fetched
  // specifically by id so the Expired tab never silently blanks an
  // employee/reference cell for a tenant with >PAGE_SIZE issuances.
  const [extraIssuances, setExtraIssuances] = useState([]);
  const [fieldVisits, setFieldVisits] = useState([]);

  // ---- Not-issued / Partially-issued (computed on demand, capped) --------
  const [complianceRows, setComplianceRows] = useState(null);
  const [complianceBusy, setComplianceBusy] = useState(false);
  const [complianceTruncated, setComplianceTruncated] = useState(false);

  // ---- Lost / Most-replaced / Distribution (shared flatten, on demand) ---
  const [itemsFlat, setItemsFlat] = useState(null);
  const [itemsFlatBusy, setItemsFlatBusy] = useState(false);
  const [itemsFlatTruncated, setItemsFlatTruncated] = useState(false);

  // ---- Issuance log detail lookup -----------------------------------------
  const [selectedIssuanceId, setSelectedIssuanceId] = useState('');
  const [issuanceDetailItems, setIssuanceDetailItems] = useState(null);
  const [issuanceDetailBusy, setIssuanceDetailBusy] = useState(false);

  // ---- Field visit log detail lookup --------------------------------------
  const [selectedVisitId, setSelectedVisitId] = useState('');
  const [visitDetailChecks, setVisitDetailChecks] = useState(null);
  const [visitDetailBusy, setVisitDetailBusy] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setComplianceRows(null);
    setItemsFlat(null);
    setSelectedIssuanceId('');
    setIssuanceDetailItems(null);
    setSelectedVisitId('');
    setVisitDetailChecks(null);
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadPpeTypes({ includeInactive: true }),
      loadPpeSets({ includeInactive: true }),
      loadAssetExtList({ limit: PAGE_SIZE }),
      loadExpiringIssuanceItems({ limit: PAGE_SIZE }),
      loadIssuances({ limit: PAGE_SIZE }),
      loadFieldVisits({ limit: PAGE_SIZE }),
      loadOrgDimensions().catch(() => ({ data: null })),
      loadRecipients().catch(() => []),
    ]).then(([typesRes, setsRes, assetExtRes, expiringRes, issuancesRes, visitsRes, orgRes, employeeRows]) => {
      if (cancelled) return;
      const firstError = typesRes.error || setsRes.error || assetExtRes.error || expiringRes.error
        || issuancesRes.error || visitsRes.error;
      if (firstError) setNotice({ tone: 'error', text: safetyErrorMessage(t, firstError) || t('admin_load_failed') });
      setPpeTypes(typesRes.data || []);
      setPpeSets(setsRes.data || []);
      setAssetExtRows(assetExtRes.data || []);
      const expiringRows = expiringRes.data || [];
      const issuanceRows = issuancesRes.data || [];
      setExpiringItems(expiringRows);
      setIssuances(issuanceRows);
      setFieldVisits(visitsRes.data || []);
      setProjects(orgRes.data?.projects || []);
      setSites(orgRes.data?.sites || []);
      setEmployees(employeeRows || []);
      setLoading(false);

      const knownIds = new Set(issuanceRows.map((row) => row.id));
      const missingIds = [...new Set(expiringRows.map((row) => row.issuance_id).filter((id) => id && !knownIds.has(id)))];
      if (missingIds.length) {
        loadIssuancesByIds(missingIds).then(({ data }) => { if (!cancelled) setExtraIssuances(data || []); });
      } else {
        setExtraIssuances([]);
      }
    });
    return () => { cancelled = true; };
  }, [reloadToken, t]);

  const ppeTypeById = useMemo(() => new Map(ppeTypes.map((row) => [row.id, row])), [ppeTypes]);
  const ppeSetById = useMemo(() => new Map(ppeSets.map((row) => [row.id, row])), [ppeSets]);
  const employeeById = useMemo(() => new Map(employees.map((row) => [row.id, row])), [employees]);
  const projectById = useMemo(() => new Map(projects.map((row) => [row.id, row])), [projects]);
  const siteById = useMemo(() => new Map(sites.map((row) => [row.id, row])), [sites]);
  const issuanceById = useMemo(
    () => new Map([...issuances, ...extraIssuances].map((row) => [row.id, row])),
    [issuances, extraIssuances],
  );

  const ppeTypeLabel = useCallback((id) => {
    const type = ppeTypeById.get(id);
    return type ? pickLocalized(type, 'name', lang) : t('label_none');
  }, [ppeTypeById, lang, t]);

  const ppeSetLabel = useCallback((id) => {
    if (!id) return t('label_none');
    const set = ppeSetById.get(id);
    return set ? pickLocalized(set, 'name', lang) : t('label_none');
  }, [ppeSetById, lang, t]);

  const employeeLabel = useCallback((id) => {
    if (!id) return t('label_none');
    const employee = employeeById.get(id);
    return employee ? employeeName(employee) : t('label_none');
  }, [employeeById, employeeName, t]);

  const projectLabel = useCallback((id) => {
    if (!id) return t('label_none');
    const project = projectById.get(id);
    return project ? pickLocalized(project, 'name', lang) : t('label_none');
  }, [projectById, lang, t]);

  const siteLabel = useCallback((id) => {
    if (!id) return t('label_none');
    const site = siteById.get(id);
    return site ? pickLocalized(site, 'name', lang) : t('label_none');
  }, [siteById, lang, t]);

  // ---------------------------------------------------------------------
  // Expired (client-filtered over the same two bulk loads Expirations uses)
  // ---------------------------------------------------------------------
  const expiredAssetRows = useMemo(
    () => assetExtRows.filter((row) => isOverdue(row.next_inspection_due) || isOverdue(row.expiry_date)),
    [assetExtRows],
  );
  const expiredConsumableRows = useMemo(
    () => expiringItems.filter((row) => isOverdue(row.expiry_date)),
    [expiringItems],
  );
  const expiredTruncated = assetExtRows.length >= PAGE_SIZE || expiringItems.length >= PAGE_SIZE;

  // ---------------------------------------------------------------------
  // Not-issued / Partially-issued
  // ---------------------------------------------------------------------
  const computeCompliance = useCallback(() => {
    const targets = employees.slice(0, EMPLOYEE_COMPLIANCE_CAP);
    setComplianceTruncated(employees.length > EMPLOYEE_COMPLIANCE_CAP);
    setComplianceBusy(true);
    Promise.all(targets.map((employee) => Promise.all([
      loadPpeRequirementsForEmployee(employee.id),
      loadMyPpe(employee.id),
    ]).then(([reqRes, heldRes]) => ({ employee, reqRes, heldRes }))))
      .then((results) => {
        const rows = [];
        results.forEach(({ employee, reqRes, heldRes }) => {
          const required = reqRes.data || [];
          const requiredIds = [...new Set(required.map((row) => row.ppeTypeId))];
          if (!requiredIds.length) return; // not covered by any PPE Set — excluded, same as safety_compliance_summary()
          const held = heldRes.data || [];
          const issuedIds = new Set(held.filter((item) => item.status === 'Issued').map((item) => item.ppe_type_id));
          const matchedIds = requiredIds.filter((id) => issuedIds.has(id));
          if (matchedIds.length === requiredIds.length) return; // fully covered — not a gap
          rows.push({
            employee,
            requiredCount: requiredIds.length,
            issuedCount: matchedIds.length,
            missingLabel: formatList(requiredIds.filter((id) => !issuedIds.has(id)).map((id) => ppeTypeLabel(id)), locale),
            category: matchedIds.length === 0 ? 'NotIssued' : 'Partial',
          });
        });
        setComplianceRows(rows);
        setComplianceBusy(false);
      });
  }, [employees, ppeTypeLabel, locale]);

  const notIssuedRows = useMemo(() => (complianceRows || []).filter((row) => row.category === 'NotIssued'), [complianceRows]);
  const partialRows = useMemo(() => (complianceRows || []).filter((row) => row.category === 'Partial'), [complianceRows]);

  // ---------------------------------------------------------------------
  // Lost / Most-replaced / Distribution — shared item-level flatten
  // ---------------------------------------------------------------------
  const loadItemsFlat = useCallback(() => {
    const targets = issuances.slice(0, ISSUANCE_ITEMS_SCAN_CAP);
    setItemsFlatTruncated(issuances.length > ISSUANCE_ITEMS_SCAN_CAP);
    setItemsFlatBusy(true);
    // One bulk .in(issuance_id) round trip instead of one loadIssuanceItems()
    // call per issuance (was up to ISSUANCE_ITEMS_SCAN_CAP separate requests
    // on a single button click).
    loadIssuanceItemsBulk(targets.map((issuance) => issuance.id))
      .then(({ data, error }) => {
        if (error) setNotice({ tone: 'error', text: safetyErrorMessage(t, error) });
        const itemsByIssuanceId = new Map();
        (data || []).forEach((item) => {
          const list = itemsByIssuanceId.get(item.issuance_id) || [];
          list.push(item);
          itemsByIssuanceId.set(item.issuance_id, list);
        });
        const flat = targets.flatMap((issuance) => (itemsByIssuanceId.get(issuance.id) || [])
          .map((item) => ({ ...item, issuance })));
        setItemsFlat(flat);
        setItemsFlatBusy(false);
      });
  }, [issuances, t]);

  const lostRows = useMemo(() => (itemsFlat || []).filter((item) => item.status === 'Lost'), [itemsFlat]);

  const replacedGroups = useMemo(() => {
    if (!itemsFlat) return [];
    const counts = new Map();
    itemsFlat.filter((item) => item.status === 'Replaced').forEach((item) => {
      counts.set(item.ppe_type_id, (counts.get(item.ppe_type_id) || 0) + 1);
    });
    return [...counts.entries()]
      .map(([ppeTypeId, count]) => ({ ppeTypeId, count }))
      .sort((a, b) => b.count - a.count);
  }, [itemsFlat]);

  const distribution = useMemo(() => {
    if (!itemsFlat) return { byDepartment: [], byProject: [] };
    const deptCounts = new Map();
    const projCounts = new Map();
    itemsFlat.filter((item) => item.status === 'Issued').forEach((item) => {
      const employee = employeeById.get(item.issuance?.employee_id);
      const deptKey = employee?.department || t('label_none');
      const projKey = employee?.project || t('label_none');
      deptCounts.set(deptKey, (deptCounts.get(deptKey) || 0) + 1);
      projCounts.set(projKey, (projCounts.get(projKey) || 0) + 1);
    });
    const toRows = (map) => [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    return { byDepartment: toRows(deptCounts), byProject: toRows(projCounts) };
  }, [itemsFlat, employeeById, t]);

  // ---------------------------------------------------------------------
  // Issuance log / Field visit log — on-demand per-row detail
  // ---------------------------------------------------------------------
  const pickIssuance = (id) => {
    setSelectedIssuanceId(id);
    setIssuanceDetailItems(null);
    if (!id) return;
    setIssuanceDetailBusy(true);
    loadIssuanceItems(id).then(({ data, error }) => {
      if (error) setNotice({ tone: 'error', text: safetyErrorMessage(t, error) });
      setIssuanceDetailItems(data || []);
      setIssuanceDetailBusy(false);
    });
  };

  const pickVisit = (id) => {
    setSelectedVisitId(id);
    setVisitDetailChecks(null);
    if (!id) return;
    setVisitDetailBusy(true);
    loadFieldVisitChecks(id).then(({ data, error }) => {
      if (error) setNotice({ tone: 'error', text: safetyErrorMessage(t, error) });
      setVisitDetailChecks(data || []);
      setVisitDetailBusy(false);
    });
  };

  const goToIssuance = (issuanceId) => navigate(`/app/admin/safety-issuances?issuance=${encodeURIComponent(issuanceId)}`);

  const kpis = {
    issuances: issuances.length,
    visits: fieldVisits.length,
    expired: expiredAssetRows.length + expiredConsumableRows.length,
    gaps: complianceRows ? notIssuedRows.length + partialRows.length : null,
  };

  const TAB_ORDER = ['notIssued', 'partial', 'expired', 'lost', 'mostReplaced', 'distribution', 'issuanceLog', 'visitLog'];
  const tabCount = {
    notIssued: complianceRows ? notIssuedRows.length : null,
    partial: complianceRows ? partialRows.length : null,
    expired: expiredAssetRows.length + expiredConsumableRows.length,
    lost: itemsFlat ? lostRows.length : null,
    mostReplaced: itemsFlat ? replacedGroups.length : null,
    distribution: itemsFlat ? distribution.byDepartment.length : null,
    issuanceLog: issuances.length,
    visitLog: fieldVisits.length,
  };

  const renderComplianceTable = (rows, emptyKey) => (
    <div className="data-table-wrap">
      <table className="enterprise-table">
        <thead>
          <tr>
            <th>{t('safety_field_employee')}</th>
            <th>{t('safety_reports_col_required_count')}</th>
            <th>{t('safety_reports_col_issued_count')}</th>
            <th>{t('safety_field_missing_ppe')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.employee.id}>
              <td><b>{employeeName(row.employee)}</b></td>
              <td>{row.requiredCount}</td>
              <td>{row.issuedCount}</td>
              <td>{row.missingLabel || '—'}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={4}>
                <div className="empty-table"><UserX aria-hidden="true" /><b>{t(emptyKey)}</b></div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  if (!hasModule('SAFETY')) return <ModuleOffNotice />;

  return (
    <div className="admin-content safety-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('safety_module_kicker')}</span>
          <h1><ClipboardList className="admin-title-icon" aria-hidden="true" /> {t('safety_reports_title')}</h1>
          <p>{t('safety_reports_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="secondary-button" onClick={refresh}>
            <RefreshCcw aria-hidden="true" /> {t('action_refresh')}
          </button>
        </div>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
        </div>
      )}

      <div className="kpi-grid compact">
        <div className="kpi-card"><ClipboardList aria-hidden="true" /><div><span>{t('safety_reports_kpi_issuances')}</span><b>{kpis.issuances}</b></div></div>
        <div className="kpi-card"><MapPinCheck aria-hidden="true" /><div><span>{t('safety_reports_kpi_visits')}</span><b>{kpis.visits}</b></div></div>
        <div className="kpi-card sla"><CalendarX aria-hidden="true" /><div><span>{t('safety_reports_kpi_expired')}</span><b>{kpis.expired}</b></div></div>
        <div className="kpi-card"><TriangleAlert aria-hidden="true" /><div><span>{t('safety_reports_kpi_gaps')}</span><b>{kpis.gaps == null ? '—' : kpis.gaps}</b></div></div>
      </div>

      <div className="segmented" role="tablist" aria-label={t('safety_reports_title')}>
        {TAB_ORDER.map((id) => {
          const Icon = TAB_ICONS[id];
          const count = tabCount[id];
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`safety-reports-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`safety-reports-panel-${id}`}
              className={tab === id ? 'active' : ''}
              onClick={() => setTab(id)}
            >
              <Icon size={16} aria-hidden="true" /> {t(TAB_LABEL_KEYS[id])}
              {count != null && <span className="tab-count">{count}</span>}
            </button>
          );
        })}
      </div>

      {(tab === 'notIssued' || tab === 'partial') && (
        <div id={`safety-reports-panel-${tab}`} role="tabpanel" aria-labelledby={`safety-reports-tab-${tab}`}>
          <div className="safety-report-toolbar">
            <p className="field-note">{t('safety_reports_compute_hint')}</p>
            <button type="button" className="secondary-button" disabled={complianceBusy} onClick={computeCompliance}>
              <RefreshCcw aria-hidden="true" /> {complianceBusy ? t('label_loading') : t('safety_reports_compute_action')}
            </button>
          </div>
          {complianceRows && (
            <p className="field-note">{t('safety_reports_compliance_scanned', { count: Math.min(employees.length, EMPLOYEE_COMPLIANCE_CAP) })}</p>
          )}
          {complianceTruncated && <p className="field-note">{t('safety_reports_compliance_truncated_hint', { count: EMPLOYEE_COMPLIANCE_CAP })}</p>}
          {!complianceRows && !complianceBusy && <p className="field-note">{t('safety_reports_not_loaded_yet')}</p>}
          {complianceRows && renderComplianceTable(
            tab === 'notIssued' ? notIssuedRows : partialRows,
            tab === 'notIssued' ? 'safety_reports_empty_not_issued' : 'safety_reports_empty_partial',
          )}
        </div>
      )}

      {tab === 'expired' && (
        <div id="safety-reports-panel-expired" role="tabpanel" aria-labelledby="safety-reports-tab-expired">
          <p className="field-note">{t('safety_reports_expired_intro')}</p>
          {expiredTruncated && <p className="field-note">{t('safety_expirations_truncated_hint')}</p>}
          <div className="dashboard-panels">
            <section className="dashboard-panel">
              <h3>{t('safety_expirations_tab_assets')}</h3>
              <div className="data-table-wrap">
                <table className="enterprise-table">
                  <thead>
                    <tr>
                      <th>{t('safety_field_ppe_type')}</th>
                      <th>{t('safety_field_condition_status')}</th>
                      <th>{t('safety_field_next_inspection_due')}</th>
                      <th>{t('safety_field_expiry_date')}</th>
                      <th aria-label={t('label_actions')} />
                    </tr>
                  </thead>
                  <tbody>
                    {expiredAssetRows.map((row) => (
                      <tr key={row.id}>
                        <td><b>{ppeTypeLabel(row.ppe_type_id)}</b></td>
                        <td>{codeLabel(t, 'safety_condition', row.condition_status, row.condition_status)}</td>
                        <td><DueCell dateStr={row.next_inspection_due} locale={locale} t={t} /></td>
                        <td><DueCell dateStr={row.expiry_date} locale={locale} t={t} /></td>
                        <td>
                          <div className="table-actions">
                            <button type="button" title={t('safety_expirations_view_asset')} aria-label={t('safety_expirations_view_asset')} onClick={() => navigate(`/app/admin/safety-assets?asset=${encodeURIComponent(row.asset_id)}`)}>
                              <Eye aria-hidden="true" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!loading && !expiredAssetRows.length && (
                      <tr><td colSpan={5}><div className="empty-table compact"><CalendarX aria-hidden="true" /><b>{t('safety_reports_empty_expired')}</b></div></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="dashboard-panel">
              <h3>{t('safety_expirations_tab_consumables')}</h3>
              <div className="data-table-wrap">
                <table className="enterprise-table">
                  <thead>
                    <tr>
                      <th>{t('safety_field_ppe_type')}</th>
                      <th>{t('safety_field_employee')}</th>
                      <th>{t('safety_field_expiry_date')}</th>
                      <th aria-label={t('label_actions')} />
                    </tr>
                  </thead>
                  <tbody>
                    {expiredConsumableRows.map((row) => {
                      const issuance = issuanceById.get(row.issuance_id);
                      return (
                        <tr key={row.id}>
                          <td><b>{ppeTypeLabel(row.ppe_type_id)}</b></td>
                          <td>{issuance ? employeeLabel(issuance.employee_id) : '—'}</td>
                          <td><DueCell dateStr={row.expiry_date} locale={locale} t={t} /></td>
                          <td>
                            <div className="table-actions">
                              <button type="button" title={t('safety_expirations_view_issuance')} aria-label={t('safety_expirations_view_issuance')} onClick={() => goToIssuance(row.issuance_id)}>
                                <Eye aria-hidden="true" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {!loading && !expiredConsumableRows.length && (
                      <tr><td colSpan={4}><div className="empty-table compact"><CalendarX aria-hidden="true" /><b>{t('safety_reports_empty_expired')}</b></div></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>
      )}

      {(tab === 'lost' || tab === 'mostReplaced' || tab === 'distribution') && (
        <div id={`safety-reports-panel-${tab}`} role="tabpanel" aria-labelledby={`safety-reports-tab-${tab}`}>
          <div className="safety-report-toolbar">
            <p className="field-note">{t('safety_reports_load_items_hint', { count: ISSUANCE_ITEMS_SCAN_CAP })}</p>
            <button type="button" className="secondary-button" disabled={itemsFlatBusy} onClick={loadItemsFlat}>
              <RefreshCcw aria-hidden="true" /> {itemsFlatBusy ? t('label_loading') : t('safety_reports_load_items_action')}
            </button>
          </div>
          {itemsFlatTruncated && <p className="field-note">{t('safety_reports_items_truncated_hint', { count: ISSUANCE_ITEMS_SCAN_CAP })}</p>}
          {!itemsFlat && !itemsFlatBusy && <p className="field-note">{t('safety_reports_not_loaded_yet')}</p>}

          {itemsFlat && tab === 'lost' && (
            <div className="data-table-wrap">
              <table className="enterprise-table">
                <thead>
                  <tr>
                    <th>{t('safety_field_ppe_type')}</th>
                    <th>{t('safety_field_employee')}</th>
                    <th>{t('safety_field_size')}</th>
                    <th>{t('safety_field_issued_date')}</th>
                  </tr>
                </thead>
                <tbody>
                  {lostRows.map((row) => (
                    <tr key={row.id}>
                      <td><b>{ppeTypeLabel(row.ppe_type_id)}</b></td>
                      <td>{employeeLabel(row.issuance?.employee_id)}</td>
                      <td>{row.size || '—'}</td>
                      <td>{formatDate(row.issued_date, locale) || '—'}</td>
                    </tr>
                  ))}
                  {!lostRows.length && (
                    <tr><td colSpan={4}><div className="empty-table compact"><PackageX aria-hidden="true" /><b>{t('safety_reports_empty_lost')}</b></div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {itemsFlat && tab === 'mostReplaced' && (
            <div className="data-table-wrap">
              <table className="enterprise-table">
                <thead>
                  <tr>
                    <th>{t('safety_field_ppe_type')}</th>
                    <th>{t('safety_reports_col_replaced_count')}</th>
                  </tr>
                </thead>
                <tbody>
                  {replacedGroups.map((row) => (
                    <tr key={row.ppeTypeId}>
                      <td><b>{ppeTypeLabel(row.ppeTypeId)}</b></td>
                      <td>{row.count}</td>
                    </tr>
                  ))}
                  {!replacedGroups.length && (
                    <tr><td colSpan={2}><div className="empty-table compact"><Repeat aria-hidden="true" /><b>{t('safety_reports_empty_most_replaced')}</b></div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {itemsFlat && tab === 'distribution' && (
            <div className="dashboard-panels">
              <section className="dashboard-panel">
                <h3>{t('safety_reports_by_department')}</h3>
                <div className="data-table-wrap">
                  <table className="enterprise-table">
                    <thead><tr><th>{t('label_department')}</th><th>{t('safety_reports_col_item_count')}</th></tr></thead>
                    <tbody>
                      {distribution.byDepartment.map((row) => (
                        <tr key={row.name}><td>{row.name}</td><td>{row.count}</td></tr>
                      ))}
                      {!distribution.byDepartment.length && (
                        <tr><td colSpan={2}><div className="empty-table compact"><Building2 aria-hidden="true" /><b>{t('safety_reports_empty_distribution')}</b></div></td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="dashboard-panel">
                <h3>{t('safety_reports_by_project')}</h3>
                <div className="data-table-wrap">
                  <table className="enterprise-table">
                    <thead><tr><th>{t('label_project')}</th><th>{t('safety_reports_col_item_count')}</th></tr></thead>
                    <tbody>
                      {distribution.byProject.map((row) => (
                        <tr key={row.name}><td>{row.name}</td><td>{row.count}</td></tr>
                      ))}
                      {!distribution.byProject.length && (
                        <tr><td colSpan={2}><div className="empty-table compact"><Building2 aria-hidden="true" /><b>{t('safety_reports_empty_distribution')}</b></div></td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}
        </div>
      )}

      {tab === 'issuanceLog' && (
        <div id="safety-reports-panel-issuanceLog" role="tabpanel" aria-labelledby="safety-reports-tab-issuanceLog">
          {issuances.length >= PAGE_SIZE && <p className="field-note">{t('safety_expirations_truncated_hint')}</p>}
          <div className="dashboard-panels">
            <section className="dashboard-panel">
              <div className="data-table-wrap">
                <table className="enterprise-table">
                  <thead>
                    <tr>
                      <th>{t('safety_field_employee')}</th>
                      <th>{t('safety_field_ppe_set')}</th>
                      <th>{t('label_status')}</th>
                      <th>{t('safety_field_issued_date')}</th>
                      <th aria-label={t('label_actions')} />
                    </tr>
                  </thead>
                  <tbody>
                    {issuances.map((row) => {
                      const isSelected = selectedIssuanceId === row.id;
                      return (
                        <tr key={row.id} className={isSelected ? 'safety-row-selected' : ''} aria-selected={isSelected}>
                          <td>
                            <b>{employeeLabel(row.employee_id)}</b>
                            {isSelected && <span className="safety-row-selected-badge"><Check size={11} aria-hidden="true" /></span>}
                          </td>
                          <td>{ppeSetLabel(row.ppe_set_id)}</td>
                          <td><span className={`status-badge status-${String(row.status).toLowerCase()}`}>{codeLabel(t, 'safety_issuance_status', row.status, row.status)}</span></td>
                          <td>{formatDate(row.issued_on, locale) || '—'}</td>
                          <td>
                            <div className="table-actions">
                              <button type="button" title={t('safety_reports_view_details_action')} aria-label={t('safety_reports_view_details_action')} onClick={() => pickIssuance(row.id)}>
                                <Eye aria-hidden="true" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {!loading && !issuances.length && (
                      <tr><td colSpan={5}><div className="empty-table"><ClipboardList aria-hidden="true" /><b>{t('safety_reports_empty_issuances')}</b></div></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="dashboard-panel">
              <h3>{selectedIssuanceId ? t('safety_reports_details_for', { reference: issuanceById.get(selectedIssuanceId)?.reference || '' }) : t('safety_reports_details_for', { reference: '' })}</h3>
              {!selectedIssuanceId && <p className="field-note">{t('safety_reports_no_row_selected')}</p>}
              {selectedIssuanceId && (
                <div className="data-table-wrap">
                  <table className="enterprise-table">
                    <thead>
                      <tr>
                        <th>{t('safety_field_ppe_type')}</th>
                        <th>{t('safety_field_quantity')}</th>
                        <th>{t('safety_field_size')}</th>
                        <th>{t('label_status')}</th>
                        <th>{t('safety_field_expiry_date')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(issuanceDetailItems || []).map((row) => (
                        <tr key={row.id}>
                          <td><b>{ppeTypeLabel(row.ppe_type_id)}</b></td>
                          <td>{row.quantity}</td>
                          <td>{row.size || '—'}</td>
                          <td><span className={`status-badge status-${String(row.status).toLowerCase()}`}>{codeLabel(t, 'safety_item_status', row.status, row.status)}</span></td>
                          <td>{formatDate(row.expiry_date, locale) || '—'}</td>
                        </tr>
                      ))}
                      {!issuanceDetailBusy && issuanceDetailItems && !issuanceDetailItems.length && (
                        <tr><td colSpan={5}><div className="empty-table compact"><ClipboardList aria-hidden="true" /><b>{t('safety_reports_no_detail_rows')}</b></div></td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {tab === 'visitLog' && (
        <div id="safety-reports-panel-visitLog" role="tabpanel" aria-labelledby="safety-reports-tab-visitLog">
          {fieldVisits.length >= PAGE_SIZE && <p className="field-note">{t('safety_expirations_truncated_hint')}</p>}
          <div className="dashboard-panels">
            <section className="dashboard-panel">
              <div className="data-table-wrap">
                <table className="enterprise-table">
                  <thead>
                    <tr>
                      <th>{t('safety_field_site')}</th>
                      <th>{t('safety_field_project')}</th>
                      <th>{t('safety_field_employee')}</th>
                      <th>{t('safety_field_visit_date')}</th>
                      <th>{t('label_status')}</th>
                      <th aria-label={t('label_actions')} />
                    </tr>
                  </thead>
                  <tbody>
                    {fieldVisits.map((row) => {
                      const isSelected = selectedVisitId === row.id;
                      return (
                        <tr key={row.id} className={isSelected ? 'safety-row-selected' : ''} aria-selected={isSelected}>
                          <td>{siteLabel(row.site_id)}</td>
                          <td>{projectLabel(row.project_id)}</td>
                          <td>
                            <b>{employeeLabel(row.inspector_id)}</b>
                            {isSelected && <span className="safety-row-selected-badge"><Check size={11} aria-hidden="true" /></span>}
                          </td>
                          <td>{formatDate(row.visit_date, locale) || '—'}</td>
                          <td><span className={`status-badge status-${String(row.status).toLowerCase()}`}>{codeLabel(t, 'safety_visit_status', row.status, row.status)}</span></td>
                          <td>
                            <div className="table-actions">
                              <button type="button" title={t('safety_reports_view_details_action')} aria-label={t('safety_reports_view_details_action')} onClick={() => pickVisit(row.id)}>
                                <Eye aria-hidden="true" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {!loading && !fieldVisits.length && (
                      <tr><td colSpan={6}><div className="empty-table"><MapPinCheck aria-hidden="true" /><b>{t('safety_reports_empty_visits')}</b></div></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="dashboard-panel">
              <h3>{selectedVisitId ? t('safety_reports_details_for', { reference: fieldVisits.find((row) => row.id === selectedVisitId)?.reference || '' }) : t('safety_reports_details_for', { reference: '' })}</h3>
              {!selectedVisitId && <p className="field-note">{t('safety_reports_no_row_selected')}</p>}
              {selectedVisitId && (
                <div className="data-table-wrap">
                  <table className="enterprise-table">
                    <thead>
                      <tr>
                        <th>{t('safety_field_employee')}</th>
                        <th>{t('safety_field_is_compliant')}</th>
                        <th>{t('safety_reports_col_notes')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(visitDetailChecks || []).map((row) => (
                        <tr key={row.id}>
                          <td><b>{employeeLabel(row.employee_id)}</b></td>
                          <td>{row.is_compliant ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}</td>
                          <td>{row.notes || '—'}</td>
                        </tr>
                      ))}
                      {!visitDetailBusy && visitDetailChecks && !visitDetailChecks.length && (
                        <tr><td colSpan={3}><div className="empty-table compact"><MapPinCheck aria-hidden="true" /><b>{t('safety_reports_no_detail_rows')}</b></div></td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
};

export default SafetyReportsAdmin;
