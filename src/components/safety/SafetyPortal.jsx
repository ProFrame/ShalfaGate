// Safety Management — employee-facing "My Safety" portal screen (route
// /app/safety, any tenant member, module SAFETY, rank 1 — no permission
// beyond being a tenant member, mirroring PORTAL_ASSETS' own "any user" rule
// and this module's own AssetsPortal.jsx template).
//
// Shows the two things an employee needs without any admin permission: the
// PPE currently/ever issued to them (loadMyPpe(), default self via
// auth.uid()) and what their own position/department/project/site requires
// of them (loadPpeRequirementsForEmployee(), same default-self behaviour),
// cross-referenced client-side so a gap is visible without a separate
// compliance dashboard. One click into an issued item opens that item's own
// issuance — Timeline (safety_timeline, entity_type 'SafetyIssuance') and any
// attached signature/receipt (safety_attachment_list) — exactly the "detail
// view" shape AssetsPortal.jsx's own asset detail already establishes for
// this kind of screen. Issuing/inspecting stays on the admin screens; this
// is read-only "what do I have and what do I need".
//
// Data access only ever goes through src/data/safetyService.js. Reuses this
// module's own already-seeded i18n vocabulary (safety_field_*/
// safety_item_status_*/safety_category_* for labels and badges,
// safety_assets_tab_timeline for the Timeline heading, safety_visits_yes/
// safety_visits_no for the Mandatory column) rather than inventing a second
// set of names for the same concepts — only safety_portal_* keys genuinely
// specific to this screen were added. Shares this module's own safety.css
// (.safety-meta-grid/.safety-timeline/.status-badge.status-* from the admin
// screens fit this screen unchanged; a small .safety-page-icon/
// .safety-back-button/.safety-open-link/.safety-req-chip set — mirroring
// assets.css's own .assets-page-icon/.assets-back-button/.assets-open-link —
// was added for this screen alone, since this module never imports
// assets.css). The screen shell itself reuses verification.css's
// .vf-screen/.vf-panel, the same generic non-admin screen furniture
// AssetsPortal.jsx/MyCardScreen.jsx already borrow.
//
// No employee-name display anywhere on this screen (it is scoped to the
// caller's own records only), so useArabicName() has nothing to do here —
// same reasoning AssetsPortal.jsx's own "My Assets" list follows.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, Check, History, PackageCheck, Search, ShieldAlert, ShieldCheck, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import {
  loadMyPpe, loadPpeRequirementsForEmployee, loadSafetyTimeline, listSafetyAttachments, safetyErrorMessage,
} from '../../data/safetyService';
import AttachmentsPanel from '../platform/AttachmentsPanel';
import { SafetyTimelinePanel } from './safetyTimeline';
import { codeLabel, formatDate, pickLocalized } from '../../utils/localize';
import './safety.css';

// Requirements come back from safety_ppe_requirements_for_employee() as a
// computed camelCase shape (nameAr/nameEn/ppeSetNameAr/ppeSetNameEn), not the
// snake_case column names pickLocalized() walks — same fallback
// SafetyFieldVisitsAdmin.jsx's own required-PPE table already uses for this
// exact RPC's output.
const pickCamel = (row, lang, arKey, enKey) => (lang === 'ar' ? row[arKey] : row[enKey]) || row[arKey] || row[enKey] || '';

const ItemStatusBadge = ({ status }) => {
  const { t } = useLanguage();
  return (
    <span className={`status-badge status-${String(status || '').toLowerCase()}`}>
      {codeLabel(t, 'safety_item_status', status, status)}
    </span>
  );
};

// ---------------------------------------------------------------------------
// Issuance detail — every item belonging to one issuance, plus that
// issuance's own Timeline and Attachments. Only ever reachable from "my PPE"
// below (safety_timeline()/safety_attachment_list()'s own SafetyIssuance
// authorization already limits this to the caller's own employee_id or
// issued_by), so this always targets an issuance the caller can see.
// ---------------------------------------------------------------------------
const IssuanceDetail = ({
  issuanceId, reference, items, tenantId, onBack,
}) => {
  const { t, lang, locale } = useLanguage();
  const [timeline, setTimeline] = useState([]);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [timelineError, setTimelineError] = useState('');
  const headingRef = useRef(null);

  // Fresh mount per selected issuance (the parent swaps the whole subtree),
  // so this effect both loads the Timeline and moves focus to the detail
  // heading — same doubled-up reasoning AssetsPortal.jsx's own AssetDetail
  // documents.
  useEffect(() => {
    headingRef.current?.focus();
    let cancelled = false;
    loadSafetyTimeline('SafetyIssuance', issuanceId).then(({ data, error }) => {
      if (cancelled) return;
      setTimelineLoading(false);
      if (error) { setTimelineError(safetyErrorMessage(t, error)); return; }
      setTimeline(data || []);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issuanceId]);

  return (
    <main className="safety-portal-page app-main">
      <div className="vf-screen">
        <div className="vf-screen-head">
          <div>
            <button type="button" className="secondary-button safety-back-button" onClick={onBack}>
              <ArrowRight aria-hidden="true" /> {t('safety_portal_back_to_list')}
            </button>
            <span className="section-kicker safety-issuance-reference">{reference}</span>
            <h1 ref={headingRef} tabIndex={-1}>{t('safety_portal_detail_title')}</h1>
          </div>
        </div>

        <section className="vf-panel">
          <div className="vf-panel-head"><h2>{t('safety_portal_items_title')}</h2></div>
          <div className="data-table-wrap">
            <table className="enterprise-table">
              <thead>
                <tr>
                  <th>{t('safety_field_ppe_type')}</th>
                  <th>{t('safety_field_category')}</th>
                  <th>{t('safety_field_quantity')}</th>
                  <th>{t('safety_field_size')}</th>
                  <th>{t('safety_field_issued_date')}</th>
                  <th>{t('safety_field_expiry_date')}</th>
                  <th>{t('label_status')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{pickLocalized(item, 'ppe_type_name', lang, item.ppe_type_id)}</td>
                    <td>{codeLabel(t, 'safety_category', item.category, item.category)}</td>
                    <td>{item.quantity}</td>
                    <td>{item.size || '—'}</td>
                    <td>{formatDate(item.issued_date, locale) || '—'}</td>
                    <td>{formatDate(item.expiry_date, locale) || '—'}</td>
                    <td><ItemStatusBadge status={item.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="vf-panel">
          <div className="vf-panel-head"><h2><History aria-hidden="true" /> {t('safety_assets_tab_timeline')}</h2></div>
          {timelineError && <div className="modal-error"><X aria-hidden="true" />{timelineError}</div>}
          <SafetyTimelinePanel rows={timeline} loading={timelineLoading} />
        </section>

        <section className="vf-panel">
          <AttachmentsPanel
            tenantId={tenantId}
            entityType="SafetyIssuance"
            entityId={issuanceId}
            area="safety"
            listFn={(entityType, entityId) => listSafetyAttachments(entityType, entityId)}
          />
        </section>
      </div>
    </main>
  );
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
const SafetyPortal = () => {
  const { t, lang, locale } = useLanguage();
  const { tenant } = useTenant();

  const [loading, setLoading] = useState(true);
  const [myPpe, setMyPpe] = useState([]);
  const [requirements, setRequirements] = useState([]);
  const [notice, setNotice] = useState(null);
  const [query, setQuery] = useState('');
  // Seeded once from a notification deep link's own "?issuance=<id>" — the
  // selectedItems lookup below already no-ops (and falls back to the list)
  // when this id matches nothing in the loaded myPpe array, exactly
  // AssetsPortal.jsx's own "silently do nothing" rule for an unknown id.
  const [selectedIssuanceId, setSelectedIssuanceId] = useState(
    () => new URLSearchParams(window.location.search).get('issuance') || null,
  );
  const listHeadingRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadMyPpe(), loadPpeRequirementsForEmployee()]).then(([ppeResult, reqResult]) => {
      if (cancelled) return;
      if (ppeResult.error) {
        setNotice({ tone: 'error', text: safetyErrorMessage(t, ppeResult.error) });
        setLoading(false);
        return;
      }
      setMyPpe(ppeResult.data || []);
      if (reqResult.error) {
        setNotice({ tone: 'error', text: safetyErrorMessage(t, reqResult.error) });
      } else {
        setRequirements(reqResult.data || []);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Which PPE types this employee currently holds (status Issued only — a
  // Returned/Lost/Expired/Replaced item no longer counts toward "do I have
  // what I need"), used to flag each requirement row below.
  const heldTypeIds = useMemo(() => new Set(
    myPpe.filter((item) => item.status === 'Issued').map((item) => item.ppe_type_id),
  ), [myPpe]);

  const visiblePpe = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return myPpe;
    return myPpe.filter((row) => (
      `${row.issuance_reference} ${pickLocalized(row, 'ppe_type_name', lang)} ${row.size || ''}`
        .toLocaleLowerCase().includes(needle)
    ));
  }, [myPpe, query, lang]);

  const selectedItems = useMemo(
    () => (selectedIssuanceId ? myPpe.filter((row) => row.issuance_id === selectedIssuanceId) : []),
    [myPpe, selectedIssuanceId],
  );
  const selectedReference = selectedItems[0]?.issuance_reference || '';

  // Detail view mounting fresh handles its own "focus the heading" side —
  // IssuanceDetail's own effect does that. Coming back to the list is the
  // one transition this component itself has to move focus for, since the
  // list markup never unmounts, it's just conditionally hidden.
  useEffect(() => {
    if (!selectedIssuanceId) listHeadingRef.current?.focus();
  }, [selectedIssuanceId]);

  if (loading) return <div className="page-loader inline-loader"><span /></div>;

  return (
    <>
      {selectedIssuanceId && selectedItems.length ? (
        <IssuanceDetail
          issuanceId={selectedIssuanceId}
          reference={selectedReference}
          items={selectedItems}
          tenantId={tenant?.id}
          onBack={() => setSelectedIssuanceId(null)}
        />
      ) : (
        <main className="safety-portal-page app-main">
          <div className="vf-screen">
            <div className="vf-screen-head">
              <div>
                <span className="section-kicker">{t('safety_module_kicker')}</span>
                <h1 ref={listHeadingRef} tabIndex={-1}><ShieldCheck className="safety-page-icon" aria-hidden="true" /> {t('safety_portal_title')}</h1>
                <p>{t('safety_portal_intro')}</p>
              </div>
            </div>

            {notice && (
              <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
                {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
                {notice.text}
                <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
              </div>
            )}

            <section className="vf-panel">
              <div className="vf-panel-head">
                <h2><ShieldAlert aria-hidden="true" /> {t('safety_portal_required_title')}</h2>
              </div>
              {!requirements.length ? (
                <div className="empty-table compact"><ShieldAlert aria-hidden="true" /><b>{t('safety_portal_required_empty')}</b></div>
              ) : (
                <div className="data-table-wrap">
                  <table className="enterprise-table">
                    <thead>
                      <tr>
                        <th>{t('safety_field_ppe_type')}</th>
                        <th>{t('safety_field_category')}</th>
                        <th>{t('safety_field_ppe_set')}</th>
                        <th>{t('safety_field_quantity')}</th>
                        <th>{t('safety_field_is_mandatory')}</th>
                        <th>{t('label_status')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {requirements.map((row) => {
                        const held = heldTypeIds.has(row.ppeTypeId);
                        return (
                          <tr key={`${row.ppeSetId}-${row.ppeTypeId}`}>
                            <td>{pickCamel(row, lang, 'nameAr', 'nameEn') || row.ppeTypeId}</td>
                            <td>{codeLabel(t, 'safety_category', row.category, row.category)}</td>
                            <td>{pickCamel(row, lang, 'ppeSetNameAr', 'ppeSetNameEn')}</td>
                            <td>{row.quantity}</td>
                            <td>{row.isMandatory ? t('safety_visits_yes') : t('safety_visits_no')}</td>
                            <td>
                              <span className={`safety-req-chip ${held ? 'met' : 'missing'}`}>
                                {held ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
                                {held ? t('safety_portal_requirement_met') : t('safety_portal_requirement_missing')}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="vf-panel">
              <div className="vf-panel-head">
                <h2><PackageCheck aria-hidden="true" /> {t('safety_portal_my_ppe_title')}</h2>
                <div className="search-control compact">
                  <Search aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('safety_portal_search_placeholder')}
                    aria-label={t('action_search')}
                  />
                  {query && (
                    <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label={t('action_clear')}>
                      <X size={15} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>

              {!visiblePpe.length ? (
                <div className="empty-table">
                  <PackageCheck aria-hidden="true" />
                  <b>{myPpe.length ? t('label_no_results') : t('safety_portal_my_ppe_empty')}</b>
                </div>
              ) : (
                <div className="data-table-wrap">
                  <table className="enterprise-table">
                    <thead>
                      <tr>
                        <th>{t('reference')}</th>
                        <th>{t('safety_field_ppe_type')}</th>
                        <th>{t('safety_field_category')}</th>
                        <th>{t('safety_field_quantity')}</th>
                        <th>{t('safety_field_size')}</th>
                        <th>{t('safety_field_issued_date')}</th>
                        <th>{t('safety_field_expiry_date')}</th>
                        <th>{t('label_status')}</th>
                        <th aria-label={t('label_actions')} />
                      </tr>
                    </thead>
                    <tbody>
                      {visiblePpe.map((row) => (
                        <tr key={row.id}>
                          <td><code>{row.issuance_reference}</code></td>
                          <td>
                            <button type="button" className="safety-open-link" onClick={() => setSelectedIssuanceId(row.issuance_id)}>
                              {pickLocalized(row, 'ppe_type_name', lang, row.ppe_type_id)}
                            </button>
                          </td>
                          <td>{codeLabel(t, 'safety_category', row.category, row.category)}</td>
                          <td>{row.quantity}</td>
                          <td>{row.size || '—'}</td>
                          <td>{formatDate(row.issued_date, locale) || '—'}</td>
                          <td>{formatDate(row.expiry_date, locale) || '—'}</td>
                          <td><ItemStatusBadge status={row.status} /></td>
                          <td>
                            <div className="table-actions">
                              <button
                                type="button"
                                title={t('action_details')}
                                aria-label={t('action_details')}
                                onClick={() => setSelectedIssuanceId(row.issuance_id)}
                              >
                                <ArrowRight aria-hidden="true" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </main>
      )}
    </>
  );
};

export default SafetyPortal;
