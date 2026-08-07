// Safety Management — Expirations & Inspections dashboard (admin/safety-
// expirations, Safety.View, ADMIN_SAFETY_EXPIRATIONS).
//
// Read-only: a single index over both PPE kinds this module tracks —
// Asset-kind PPE (public.safety_asset_ext, hung off an existing Assets
// Management asset) and Consumable-kind PPE (public.safety_issuance_items,
// still-Issued rows with an expiry_date). Neither table carries a
// human-readable name for the record it points at (no asset reference/name
// on safety_asset_ext, no employee id on safety_issuance_items itself — that
// lives on its parent safety_issuances row), and this screen's data access is
// scoped to safetyService.js/orgDimensionsService.js/approvalService.js's own
// loadRecipients() only, never assetsService.js — so every row's identity
// here is the PPE type plus (for Consumables) the owning issuance's own
// reference/employee, with a "View" action that hands off to the screen that
// actually owns that record (Safety Assets, Safety Issuances) rather than
// duplicating any write logic here, per this screen's own read-only remit.
//
// loadExpiringIssuanceItems() is a new small export this screen needed and
// added to safetyService.js — see that file's own comment on it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import {
  AlarmClock, Boxes, Check, Eye, PackageCheck, RefreshCcw, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useArabicName } from '../../utils/approval';
import { pickLocalized, codeLabel } from '../../utils/localize';
import { loadRecipients } from '../../data/approvalService';
import {
  safetyErrorMessage, loadPpeTypes, loadAssetExtList, loadIssuances, loadIssuancesByIds, loadExpiringIssuanceItems,
} from '../../data/safetyService';
import { DueCell } from './safetyDueCell';
import './safety.css';

const PAGE_SIZE = 200;

const SafetyExpirationsAdmin = () => {
  const { t, lang, locale } = useLanguage();
  const { employeeName } = useArabicName();
  const [, navigate] = useLocation();

  const [activeTab, setActiveTab] = useState('assets');
  const [ppeTypes, setPpeTypes] = useState([]);
  const [assetRows, setAssetRows] = useState([]);
  const [consumableRows, setConsumableRows] = useState([]);
  const [issuances, setIssuances] = useState([]);
  // Issuances referenced by consumableRows but missing from the recency-
  // capped `issuances` page (consumableRows comes from
  // loadExpiringIssuanceItems(), its own independently ordered/capped list)
  // — fetched specifically by id so an older issuance's item never silently
  // shows a blank employee/reference here.
  const [extraIssuances, setExtraIssuances] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => { setLoading(true); setReloadToken((token) => token + 1); }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadPpeTypes({ includeInactive: true }),
      loadAssetExtList({ limit: PAGE_SIZE }),
      loadExpiringIssuanceItems({ limit: PAGE_SIZE }),
      loadIssuances({ limit: PAGE_SIZE }),
      loadRecipients().catch(() => []),
    ]).then(([typesResult, assetExtResult, issuanceItemsResult, issuancesResult, employeeRows]) => {
      if (cancelled) return;
      const firstError = typesResult.error || assetExtResult.error || issuanceItemsResult.error || issuancesResult.error;
      if (firstError) setNotice({ tone: 'error', text: safetyErrorMessage(t, firstError) || t('admin_load_failed') });
      const consumableItemRows = issuanceItemsResult.data || [];
      const issuanceRows = issuancesResult.data || [];
      setPpeTypes(typesResult.data || []);
      setAssetRows(assetExtResult.data || []);
      setConsumableRows(consumableItemRows);
      setIssuances(issuanceRows);
      setEmployees(employeeRows || []);
      setLoading(false);

      const knownIds = new Set(issuanceRows.map((row) => row.id));
      const missingIds = [...new Set(consumableItemRows.map((row) => row.issuance_id).filter((id) => id && !knownIds.has(id)))];
      if (missingIds.length) {
        loadIssuancesByIds(missingIds).then(({ data }) => { if (!cancelled) setExtraIssuances(data || []); });
      } else {
        setExtraIssuances([]);
      }
    });
    return () => { cancelled = true; };
  }, [reloadToken, t]);

  const ppeTypeById = useMemo(() => new Map(ppeTypes.map((row) => [row.id, row])), [ppeTypes]);
  const issuanceById = useMemo(
    () => new Map([...issuances, ...extraIssuances].map((row) => [row.id, row])),
    [issuances, extraIssuances],
  );
  const employeeById = useMemo(() => new Map(employees.map((row) => [row.id, row])), [employees]);

  const ppeTypeLabel = useCallback((id) => {
    const type = ppeTypeById.get(id);
    return type ? pickLocalized(type, 'name', lang) : t('label_none');
  }, [ppeTypeById, lang, t]);

  const employeeLabel = useCallback((id) => {
    if (!id) return t('label_none');
    const employee = employeeById.get(id);
    return employee ? employeeName(employee) : t('label_none');
  }, [employeeById, employeeName, t]);

  // Assets tab already comes from loadAssetExtList() sorted next_inspection_due
  // ascending (nulls last); Consumables tab already comes from
  // loadExpiringIssuanceItems() sorted expiry_date ascending — both server-side,
  // so no re-sort is needed here.
  const assetsTruncated = assetRows.length >= PAGE_SIZE;
  const consumablesTruncated = consumableRows.length >= PAGE_SIZE;

  const goToAsset = (assetId) => navigate(`/app/admin/safety-assets?asset=${encodeURIComponent(assetId)}`);
  const goToIssuance = (issuanceId) => navigate(`/app/admin/safety-issuances?issuance=${encodeURIComponent(issuanceId)}`);

  return (
    <div className="admin-content safety-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('safety_module_kicker')}</span>
          <h1><AlarmClock className="admin-title-icon" aria-hidden="true" /> {t('safety_expirations_title')}</h1>
          <p>{t('safety_expirations_intro')}</p>
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

      <div className="segmented" role="tablist" aria-label={t('safety_expirations_title')}>
        <button
          type="button" role="tab" id="safety-exp-tab-assets" aria-selected={activeTab === 'assets'}
          aria-controls="safety-exp-panel-assets" className={activeTab === 'assets' ? 'active' : ''}
          onClick={() => setActiveTab('assets')}
        >
          <Boxes aria-hidden="true" /> {t('safety_expirations_tab_assets')}
        </button>
        <button
          type="button" role="tab" id="safety-exp-tab-consumables" aria-selected={activeTab === 'consumables'}
          aria-controls="safety-exp-panel-consumables" className={activeTab === 'consumables' ? 'active' : ''}
          onClick={() => setActiveTab('consumables')}
        >
          <PackageCheck aria-hidden="true" /> {t('safety_expirations_tab_consumables')}
        </button>
      </div>

      {activeTab === 'assets' && (
        <div id="safety-exp-panel-assets" role="tabpanel" aria-labelledby="safety-exp-tab-assets">
          <div className="data-controls">
            <span className="result-count">{t('admin_records_count', { count: assetRows.length })}</span>
          </div>
          {assetsTruncated && <p className="field-note">{t('safety_expirations_truncated_hint')}</p>}

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
                {assetRows.map((row) => (
                  <tr key={row.id}>
                    <td><b>{ppeTypeLabel(row.ppe_type_id)}</b></td>
                    <td>{codeLabel(t, 'safety_condition', row.condition_status, row.condition_status)}</td>
                    <td><DueCell dateStr={row.next_inspection_due} locale={locale} t={t} /></td>
                    <td><DueCell dateStr={row.expiry_date} locale={locale} t={t} /></td>
                    <td>
                      <div className="table-actions">
                        <button
                          type="button" title={t('safety_expirations_view_asset')}
                          aria-label={t('safety_expirations_view_asset')} onClick={() => goToAsset(row.asset_id)}
                        >
                          <Eye aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && !assetRows.length && (
                  <tr>
                    <td colSpan={5}>
                      <div className="empty-table"><Boxes aria-hidden="true" /><b>{t('label_no_results')}</b></div>
                    </td>
                  </tr>
                )}
                {loading && (
                  <tr><td colSpan={5}>{t('label_loading')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'consumables' && (
        <div id="safety-exp-panel-consumables" role="tabpanel" aria-labelledby="safety-exp-tab-consumables">
          <div className="data-controls">
            <span className="result-count">{t('admin_records_count', { count: consumableRows.length })}</span>
          </div>
          {consumablesTruncated && <p className="field-note">{t('safety_expirations_truncated_hint')}</p>}

          <div className="data-table-wrap">
            <table className="enterprise-table">
              <thead>
                <tr>
                  <th>{t('safety_field_ppe_type')}</th>
                  <th>{t('safety_field_employee')}</th>
                  <th>{t('reference')}</th>
                  <th>{t('safety_field_quantity')}</th>
                  <th>{t('safety_field_size')}</th>
                  <th>{t('safety_field_expiry_date')}</th>
                  <th aria-label={t('label_actions')} />
                </tr>
              </thead>
              <tbody>
                {consumableRows.map((row) => {
                  const issuance = issuanceById.get(row.issuance_id);
                  return (
                    <tr key={row.id}>
                      <td><b>{ppeTypeLabel(row.ppe_type_id)}</b></td>
                      <td>{issuance ? employeeLabel(issuance.employee_id) : '—'}</td>
                      <td>{issuance ? <code>{issuance.reference}</code> : '—'}</td>
                      <td>{row.quantity}</td>
                      <td>{row.size || '—'}</td>
                      <td><DueCell dateStr={row.expiry_date} locale={locale} t={t} /></td>
                      <td>
                        <div className="table-actions">
                          <button
                            type="button" title={t('safety_expirations_view_issuance')}
                            aria-label={t('safety_expirations_view_issuance')} onClick={() => goToIssuance(row.issuance_id)}
                          >
                            <Eye aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!loading && !consumableRows.length && (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-table"><PackageCheck aria-hidden="true" /><b>{t('label_no_results')}</b></div>
                    </td>
                  </tr>
                )}
                {loading && (
                  <tr><td colSpan={7}>{t('label_loading')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default SafetyExpirationsAdmin;
