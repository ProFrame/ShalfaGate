// Field Visits — the field inspection/compliance-check screen for the Safety
// Management module (FourthUpdate.md). Route: admin/safety-field-visits ·
// permission: Safety.Inspect.
//
// The spec describes scanning the employee's QR code or typing their
// employee number ("أو" — or). This codebase has no camera/barcode scanner
// anywhere (qrcode.react is an encoder only), so this screen implements the
// spec's own explicit fallback: type the employee number, or search by name,
// against the employee directory (loadRecipients(), filtered client-side —
// no bespoke employee-search RPC for this scale). A camera scanner would be
// a clean future addition once a scanning library is chosen; it is a
// deliberate scope decision here, not an oversight.
//
// Flow: create a Draft visit (site/project optional) -> resolve an employee
// -> compare what they are required to have against what they currently
// hold -> mark Compliant/Not compliant (missing PPE only cross-referenced
// against the requirements list, never freeform) -> save the check -> attach
// an optional photo to the just-saved check (needs a real check id first) ->
// resolve another employee, or complete the visit once every employee for
// this round has been checked.
//
// Data access only through src/data/safetyService.js, plus
// loadOrgDimensions() and loadRecipients() (from orgDimensionsService.js /
// approvalService.js) for the site/project/employee pickers — the same
// reuse Assets Management's own screens already make for those lists.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Check, CircleCheck, CircleX, ClipboardCheck, Eye, HardHat,
  Plus, RefreshCcw, Search, ShieldAlert, ShieldCheck, UserSearch, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { useDialogA11y } from '../../utils/useDialogA11y';
import { useArabicName } from '../../utils/approval';
import { pickLocalized, formatDate, formatDateTime, codeLabel } from '../../utils/localize';
import { loadRecipients } from '../../data/approvalService';
import { loadOrgDimensions } from '../../data/orgDimensionsService';
import AttachmentsPanel from '../platform/AttachmentsPanel';
import {
  FIELD_VISIT_STATUSES,
  safetyErrorMessage,
  loadFieldVisits, createFieldVisit, loadFieldVisitChecks, recordFieldVisitCheck, completeFieldVisit,
  loadPpeRequirementsForEmployee, loadMyPpe, loadPpeTypes, listSafetyAttachments,
} from '../../data/safetyService';
import './safety.css';

// Matches safetyService.js's own DEFAULT_PAGE_SIZE — loadFieldVisits() never
// takes a search filter, so an unfiltered load may legitimately hit this cap.
const VISITS_PAGE_SIZE = 200;

const todayIso = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// New visit
// ---------------------------------------------------------------------------
const CreateVisitModal = ({ sites, projects, lang, onClose, onCreated }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const [projectId, setProjectId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [visitDate, setVisitDate] = useState(todayIso);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Sites carry their own project_id (orgDimensionsService.js's own
  // sites/projects join) — narrow the site choices to the picked project,
  // and drop a site that no longer belongs the moment the project changes.
  const siteOptions = useMemo(() => (projectId ? sites.filter((row) => row.project_id === projectId) : sites), [sites, projectId]);
  const changeProject = (value) => {
    setProjectId(value);
    if (value && siteId && !sites.find((row) => row.id === siteId && row.project_id === value)) setSiteId('');
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { data, error: saveError } = await createFieldVisit(siteId || null, projectId || null, visitDate || null, notes);
    setBusy(false);
    if (saveError) { setError(safetyErrorMessage(t, saveError)); return; }
    onCreated(data);
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('safety_visits_new_title')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('safety_module_kicker')}</span>
            <h3>{t('safety_visits_new_title')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="form-grid">
          <label className="field-label">{t('safety_field_project')}
            <select className="form-input" value={projectId} onChange={(event) => changeProject(event.target.value)}>
              <option value="">{t('label_none')}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.code} · {pickLocalized(project, 'name', lang)}</option>
              ))}
            </select>
          </label>
          <label className="field-label">{t('safety_field_site')}
            <select className="form-input" value={siteId} onChange={(event) => setSiteId(event.target.value)}>
              <option value="">{t('label_none')}</option>
              {siteOptions.map((site) => (
                <option key={site.id} value={site.id}>{site.code} · {pickLocalized(site, 'name', lang)}</option>
              ))}
            </select>
          </label>
          <label className="field-label">{t('safety_field_visit_date')}
            <input type="date" className="form-input" value={visitDate} onChange={(event) => setVisitDate(event.target.value)} />
          </label>
          <label className="field-label field-span-2">{t('safety_visits_notes')}
            <textarea className="form-input" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
        </div>

        {error && <div className="modal-error"><X aria-hidden="true" />{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button className="primary-button" disabled={busy}>{busy ? t('label_loading') : t('action_save')}</button>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Complete-visit confirmation
// ---------------------------------------------------------------------------
const ConfirmCompleteVisitModal = ({ busy, onClose, onConfirm }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-card confirm-modal" role="dialog" aria-modal="true" aria-label={t('safety_visits_confirm_complete_title')} onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div><h3>{t('safety_visits_confirm_complete_title')}</h3></div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="confirm-body"><ClipboardCheck aria-hidden="true" /><p>{t('safety_visits_confirm_complete_body')}</p></div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button type="button" className="primary-button" disabled={busy} onClick={onConfirm}>
            <ClipboardCheck aria-hidden="true" /> {busy ? t('label_loading') : t('safety_visits_action_complete')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// One employee's compliance check — required-vs-held comparison, the
// Compliant/Not compliant call, the missing-PPE checklist (cross-referenced
// against the requirements list, never freeform), and the post-save photo
// attachment (needs the check's own id, so it only appears after the save).
// Remounted via key={employee.id} by the caller so every newly resolved
// employee starts from a clean slate without an effect needing to reset it.
// ---------------------------------------------------------------------------
const EmployeeCompliancePanel = ({ visitId, employee, employeeLabelText, ppeTypesById, lang, locale, tenantId, onRecorded, onDone }) => {
  const { t } = useLanguage();
  const [requirements, setRequirements] = useState([]);
  const [currentPpe, setCurrentPpe] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isCompliant, setIsCompliant] = useState(null);
  const [missingIds, setMissingIds] = useState([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedCheckId, setSavedCheckId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadPpeRequirementsForEmployee(employee.id), loadMyPpe(employee.id)]).then(([reqResult, ppeResult]) => {
      if (cancelled) return;
      setRequirements(reqResult.data || []);
      setCurrentPpe(ppeResult.data || []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [employee.id]);

  // A requirement can repeat per ppeTypeId (one row per PPE Set that pulls
  // it in) — dedupe by type for both the comparison table and the missing
  // checklist so the inspector picks a PPE type once, not once per set.
  const requirementOptions = useMemo(() => {
    const seen = new Map();
    requirements.forEach((row) => { if (!seen.has(row.ppeTypeId)) seen.set(row.ppeTypeId, row); });
    return [...seen.values()];
  }, [requirements]);

  // Requirements come back as a computed shape (ppeTypeId/nameAr/nameEn),
  // not table rows — resolve the bilingual name through the same PPE-types
  // lookup (snake_case name_ar/name_en) pickLocalized() expects, falling
  // back to the requirement's own names only if the type was since removed.
  const requirementName = (row) => (
    pickLocalized(ppeTypesById[row.ppeTypeId], 'name', lang)
    || (lang === 'ar' ? row.nameAr : row.nameEn)
    || row.nameAr || row.nameEn || row.ppeTypeId
  );

  const toggleMissing = (ppeTypeId) => setMissingIds((current) => (
    current.includes(ppeTypeId) ? current.filter((id) => id !== ppeTypeId) : [...current, ppeTypeId]
  ));

  const chooseCompliant = (value) => { setIsCompliant(value); if (value) setMissingIds([]); };

  const submit = async (event) => {
    event.preventDefault();
    if (isCompliant === null) { setError(t('safety_visits_pick_compliance')); return; }
    setBusy(true);
    setError('');
    const { data, error: saveError } = await recordFieldVisitCheck(visitId, employee.id, isCompliant, isCompliant ? [] : missingIds, notes);
    setBusy(false);
    if (saveError) { setError(safetyErrorMessage(t, saveError)); return; }
    setSavedCheckId(typeof data === 'string' ? data : data?.id || null);
    onRecorded();
  };

  if (savedCheckId) {
    return (
      <div className="safety-check-saved">
        <div className="inline-message" role="status" aria-live="polite"><Check aria-hidden="true" /> {t('safety_visits_check_saved')}</div>
        <p className="field-note">{t('safety_visits_photo_hint')}</p>
        {tenantId && (
          <AttachmentsPanel
            tenantId={tenantId}
            entityType="SafetyFieldVisitCheck"
            entityId={savedCheckId}
            area="safety"
            listFn={listSafetyAttachments}
          />
        )}
        <div className="modal-actions">
          <button type="button" className="primary-button" onClick={onDone}>
            <UserSearch aria-hidden="true" /> {t('safety_visits_check_another')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="safety-check-form" onSubmit={submit}>
      <div className="safety-active-employee">
        <UserSearch aria-hidden="true" />
        <b>{employeeLabelText}</b>
        {employee.employee_no && <code>{employee.employee_no}</code>}
      </div>

      {loading ? <p className="field-note">{t('label_loading')}</p> : (
        <div className="safety-ppe-columns">
          <div>
            <h4>{t('safety_visits_required_ppe_title')}</h4>
            {!requirementOptions.length && <p className="field-note">{t('safety_visits_required_ppe_empty')}</p>}
            {requirementOptions.length > 0 && (
              <div className="data-table-wrap">
                <table className="enterprise-table">
                  <thead>
                    <tr>
                      <th>{t('safety_field_category')}</th><th>{t('safety_field_ppe_type')}</th>
                      <th>{t('safety_field_quantity')}</th><th>{t('safety_field_is_mandatory')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requirementOptions.map((row) => (
                      <tr key={row.ppeTypeId}>
                        <td>{codeLabel(t, 'safety_category', row.category, row.category)}</td>
                        <td>{requirementName(row)}</td>
                        <td>{row.quantity ?? 1}</td>
                        <td>{row.isMandatory ? t('safety_visits_yes') : t('safety_visits_no')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <h4>{t('safety_visits_current_ppe_title')}</h4>
            {!currentPpe.length && <p className="field-note">{t('safety_visits_current_ppe_empty')}</p>}
            {currentPpe.length > 0 && (
              <div className="data-table-wrap">
                <table className="enterprise-table">
                  <thead>
                    <tr>
                      <th>{t('safety_field_ppe_type')}</th><th>{t('safety_field_size')}</th>
                      <th>{t('safety_field_expiry_date')}</th><th>{t('label_status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentPpe.map((row) => (
                      <tr key={row.id}>
                        <td>{pickLocalized(ppeTypesById[row.ppe_type_id], 'name', lang) || row.ppe_type_id}</td>
                        <td>{row.size || '—'}</td>
                        <td>{formatDate(row.expiry_date, locale) || '—'}</td>
                        <td><span className={`status-badge status-${String(row.status).toLowerCase()}`}>{codeLabel(t, 'safety_item_status', row.status, row.status)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="field-label">
        {t('safety_field_is_compliant')}
        <div className="approval-action-options" role="group" aria-label={t('safety_field_is_compliant')}>
          <button
            type="button"
            className={`approval-action-option ${isCompliant === true ? 'active' : ''}`}
            aria-pressed={isCompliant === true}
            onClick={() => chooseCompliant(true)}
          >
            <ShieldCheck aria-hidden="true" /><span><b>{t('safety_visits_mark_compliant')}</b></span>
          </button>
          <button
            type="button"
            className={`approval-action-option ${isCompliant === false ? 'active' : ''}`}
            aria-pressed={isCompliant === false}
            onClick={() => chooseCompliant(false)}
          >
            <ShieldAlert aria-hidden="true" /><span><b>{t('safety_visits_mark_noncompliant')}</b></span>
          </button>
        </div>
      </div>

      {isCompliant === false && (
        <div className="field-label">
          {t('safety_field_missing_ppe')}
          <p className="field-note">{t('safety_visits_missing_ppe_hint')}</p>
          <div className="safety-missing-grid">
            {requirementOptions.map((row) => (
              <label key={row.ppeTypeId} className="content-publish-check">
                <input type="checkbox" checked={missingIds.includes(row.ppeTypeId)} onChange={() => toggleMissing(row.ppeTypeId)} />
                {requirementName(row)}
              </label>
            ))}
            {!requirementOptions.length && <p className="field-note">{t('safety_visits_required_ppe_empty')}</p>}
          </div>
        </div>
      )}

      <label className="field-label">{t('safety_visits_notes')}
        <textarea className="form-input" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>

      {error && <div className="modal-error"><X aria-hidden="true" />{error}</div>}

      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onDone}>{t('action_cancel')}</button>
        <button type="submit" className="primary-button" disabled={busy}>
          <ClipboardCheck aria-hidden="true" /> {busy ? t('label_loading') : t('safety_visits_record_check')}
        </button>
      </div>
    </form>
  );
};

// ---------------------------------------------------------------------------
// Visit detail — employee resolver (Draft only) + the checks already
// recorded for this round.
// ---------------------------------------------------------------------------
const SafetyFieldVisitDetail = ({ visit, tenantId, employees, ppeTypesById, siteLabel, projectLabel, onBack, onChanged }) => {
  const { t, lang, locale, isRtl } = useLanguage();
  const { employeeName } = useArabicName();

  // completeFieldVisit() is the only mutator this view can call on the visit
  // itself, and it only ever moves Draft -> Completed — applying that
  // transition locally on success avoids needing a loadFieldVisit(id) the
  // service does not expose (only the list and per-visit checks are read
  // singly here).
  const [visitState, setVisitState] = useState(visit);
  const [checks, setChecks] = useState([]);
  const [checksLoading, setChecksLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [notice, setNotice] = useState(null);
  const [employeeQuery, setEmployeeQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeEmployee, setActiveEmployee] = useState(null);
  const [completing, setCompleting] = useState(false);
  const [completeBusy, setCompleteBusy] = useState(false);

  const headingRef = useRef(null);
  const focusedOnceRef = useRef(false);
  useEffect(() => {
    if (focusedOnceRef.current) return;
    focusedOnceRef.current = true;
    headingRef.current?.focus();
  }, []);

  const refreshChecks = useCallback(() => { setChecksLoading(true); setReloadToken((token) => token + 1); }, []);

  useEffect(() => {
    let cancelled = false;
    loadFieldVisitChecks(visitState.id).then(({ data, error }) => {
      if (cancelled) return;
      if (error) setNotice({ tone: 'error', text: safetyErrorMessage(t, error) });
      else setChecks(data || []);
      setChecksLoading(false);
    });
    return () => { cancelled = true; };
  }, [visitState.id, reloadToken, t]);

  const employeeById = useMemo(() => new Map(employees.map((row) => [row.id, row])), [employees]);
  const employeeLabel = useCallback((id) => {
    if (!id) return '';
    const row = employeeById.get(id);
    return row ? employeeName(row) : id;
  }, [employeeById, employeeName]);

  const checkedEmployeeIds = useMemo(() => new Set(checks.map((row) => row.employee_id)), [checks]);

  const employeeMatches = useMemo(() => {
    const needle = employeeQuery.trim().toLocaleLowerCase();
    if (!needle) return [];
    return employees
      .filter((employee) => `${employee.employee_no || ''} ${employeeName(employee)}`.toLocaleLowerCase().includes(needle))
      .slice(0, 8);
  }, [employees, employeeQuery, employeeName]);

  const selectEmployee = (employee) => { setActiveEmployee(employee); setEmployeeQuery(''); setPickerOpen(false); };
  const onCheckRecorded = () => { refreshChecks(); onChanged?.(); };

  const confirmComplete = async () => {
    setCompleteBusy(true);
    const { error } = await completeFieldVisit(visitState.id);
    setCompleteBusy(false);
    setCompleting(false);
    if (error) { setNotice({ tone: 'error', text: safetyErrorMessage(t, error) }); return; }
    setVisitState((current) => ({ ...current, status: 'Completed' }));
    setActiveEmployee(null);
    setNotice({ tone: 'success', text: t('admin_save_done') });
    onChanged?.();
  };

  const isDraft = visitState.status === 'Draft';

  return (
    <div className="admin-content">
      <div className="safety-detail-head">
        <button type="button" className="secondary-button" onClick={onBack}>
          {isRtl ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />} {t('safety_visits_back_to_list')}
        </button>
      </div>

      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{visitState.reference}</span>
          <h1 ref={headingRef} tabIndex={-1}><HardHat className="admin-title-icon" aria-hidden="true" /> {t('safety_visits_title')}</h1>
          <p><span className={`status-badge status-${String(visitState.status).toLowerCase()}`}>{codeLabel(t, 'safety_visit_status', visitState.status, visitState.status)}</span></p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="secondary-button" onClick={refreshChecks}><RefreshCcw aria-hidden="true" /> {t('action_refresh')}</button>
          {isDraft && (
            <button type="button" className="primary-button" onClick={() => setCompleting(true)}>
              <ClipboardCheck aria-hidden="true" /> {t('safety_visits_action_complete')}
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
        </div>
      )}

      <div className="safety-meta-grid">
        <div className="safety-meta-item"><span>{t('safety_field_site')}</span><b>{siteLabel(visitState.site_id) || t('label_none')}</b></div>
        <div className="safety-meta-item"><span>{t('safety_field_project')}</span><b>{projectLabel(visitState.project_id) || t('label_none')}</b></div>
        <div className="safety-meta-item"><span>{t('safety_field_visit_date')}</span><b>{formatDate(visitState.visit_date, locale) || '—'}</b></div>
      </div>
      {visitState.notes && <p className="field-note">{visitState.notes}</p>}

      {isDraft ? (
        <section className="dashboard-panel">
          <h3><UserSearch aria-hidden="true" /> {t('safety_visits_resolve_title')}</h3>
          <p className="field-note">{t('safety_visits_resolve_hint')}</p>

          {activeEmployee ? (
            <EmployeeCompliancePanel
              key={activeEmployee.id}
              visitId={visitState.id}
              employee={activeEmployee}
              employeeLabelText={employeeName(activeEmployee)}
              ppeTypesById={ppeTypesById}
              lang={lang}
              locale={locale}
              tenantId={tenantId}
              onRecorded={onCheckRecorded}
              onDone={() => setActiveEmployee(null)}
            />
          ) : (
            <div className="searchable-select" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPickerOpen(false); }}>
              <Search size={18} aria-hidden="true" />
              <input
                className="form-input"
                role="combobox"
                aria-expanded={pickerOpen}
                aria-autocomplete="list"
                value={employeeQuery}
                placeholder={t('safety_visits_resolve_placeholder')}
                onFocus={() => setPickerOpen(true)}
                onChange={(event) => { setEmployeeQuery(event.target.value); setPickerOpen(true); }}
              />
              {pickerOpen && employeeQuery.trim() && (
                <div className="searchable-options" role="listbox">
                  {employeeMatches.map((employee) => (
                    <button
                      type="button"
                      role="option"
                      key={employee.id}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectEmployee(employee)}
                    >
                      <b>{employeeName(employee)}</b>
                      <small>
                        {employee.employee_no || ''}
                        {checkedEmployeeIds.has(employee.id) ? ` · ${t('safety_visits_already_checked_badge')}` : ''}
                      </small>
                    </button>
                  ))}
                  {!employeeMatches.length && <div className="searchable-empty">{t('label_no_results')}</div>}
                </div>
              )}
            </div>
          )}
        </section>
      ) : (
        <p className="field-note">{t('safety_visits_completed_note')}</p>
      )}

      <section className="dashboard-panel">
        <h3><ClipboardCheck aria-hidden="true" /> {t('safety_visits_checks_title')}</h3>
        {checksLoading && <p className="field-note">{t('label_loading')}</p>}
        {!checksLoading && !checks.length && (
          <div className="empty-table compact"><ClipboardCheck aria-hidden="true" /><b>{t('safety_visits_checks_empty')}</b></div>
        )}
        {!checksLoading && checks.length > 0 && (
          <div className="data-table-wrap">
            <table className="enterprise-table">
              <thead>
                <tr>
                  <th>{t('safety_field_employee')}</th><th>{t('safety_field_is_compliant')}</th>
                  <th>{t('safety_visits_notes')}</th><th>{t('safety_visits_checked_by')}</th><th>{t('safety_visits_checked_on')}</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((row) => (
                  <tr key={row.id}>
                    <td>{employeeLabel(row.employee_id) || t('label_none')}</td>
                    <td>
                      {row.is_compliant
                        ? <span className="status-badge status-approved"><CircleCheck size={14} aria-hidden="true" /> {t('safety_visits_mark_compliant')}</span>
                        : <span className="status-badge status-rejected"><CircleX size={14} aria-hidden="true" /> {t('safety_visits_mark_noncompliant')}</span>}
                    </td>
                    <td>{row.notes || '—'}</td>
                    <td>{employeeLabel(row.checked_by) || '—'}</td>
                    <td>{formatDateTime(row.checked_on, locale) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {completing && (
        <ConfirmCompleteVisitModal busy={completeBusy} onClose={() => setCompleting(false)} onConfirm={confirmComplete} />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
const SafetyFieldVisitsAdmin = () => {
  const { t, lang, locale } = useLanguage();
  const { tenant } = useTenant();
  const tenantId = tenant?.id || null;

  const [visits, setVisits] = useState([]);
  const [visitsLoading, setVisitsLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [notice, setNotice] = useState(null);
  const [selectedVisit, setSelectedVisit] = useState(null);
  const [creating, setCreating] = useState(false);
  const [statusFilter, setStatusFilter] = useState('All');
  const [search, setSearch] = useState('');

  const [sites, setSites] = useState([]);
  const [projects, setProjects] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [ppeTypesById, setPpeTypesById] = useState({});

  const headingRef = useRef(null);
  useEffect(() => { headingRef.current?.focus(); }, []);

  // Which row's Eye button opened the detail view, so onBack can return
  // focus to it — same returnFocusRowIdRef/tableWrapRef pair
  // SafetyAssetsAdmin.jsx/SafetyIssuancesAdmin.jsx already use for this
  // exact list<->detail conditional-subtree swap.
  const returnFocusRowIdRef = useRef(null);
  const tableWrapRef = useRef(null);

  const refreshVisits = useCallback(() => { setVisitsLoading(true); setReloadToken((token) => token + 1); }, []);

  useEffect(() => {
    let cancelled = false;
    loadFieldVisits({ limit: VISITS_PAGE_SIZE }).then(({ data, error }) => {
      if (cancelled) return;
      if (error) { setVisits([]); setNotice({ tone: 'error', text: safetyErrorMessage(t, error) || t('admin_load_failed') }); }
      else setVisits(data || []);
      setVisitsLoading(false);
    });
    return () => { cancelled = true; };
  }, [reloadToken, t]);

  // The directory (sites/projects/employees/PPE catalogue) is shared by both
  // the create-visit picker and every employee compliance check opened from
  // the detail view — fetched once, independent of the visits list itself.
  // includeInactive is passed for PPE types so a since-deactivated type an
  // old requirement still points at resolves to a real name instead of a
  // raw id.
  useEffect(() => {
    let cancelled = false;
    Promise.all([loadOrgDimensions(), loadRecipients().catch(() => []), loadPpeTypes({ includeInactive: true })])
      .then(([dimensionsResult, employeeRows, ppeTypesResult]) => {
        if (cancelled) return;
        setSites(dimensionsResult.data?.sites || []);
        setProjects(dimensionsResult.data?.projects || []);
        setEmployees(employeeRows || []);
        setPpeTypesById(Object.fromEntries((ppeTypesResult.data || []).map((row) => [row.id, row])));
        if (dimensionsResult.error || ppeTypesResult.error) {
          setNotice({ tone: 'error', text: safetyErrorMessage(t, dimensionsResult.error || ppeTypesResult.error) });
        }
      });
    return () => { cancelled = true; };
  }, [t]);

  const siteById = useMemo(() => new Map(sites.map((row) => [row.id, row])), [sites]);
  const projectById = useMemo(() => new Map(projects.map((row) => [row.id, row])), [projects]);
  const siteLabel = useCallback((id) => (id && siteById.get(id) ? pickLocalized(siteById.get(id), 'name', lang) : ''), [siteById, lang]);
  const projectLabel = useCallback((id) => (id && projectById.get(id) ? pickLocalized(projectById.get(id), 'name', lang) : ''), [projectById, lang]);

  // Both the search box and the status segmented control filter the already-
  // fetched page in memory (loadFieldVisits() takes no search parameter of
  // its own) — same local-filter shape AssetGroupsAdmin.jsx's own search
  // uses, so no debounce is needed here (nothing it would be debouncing).
  const filteredVisits = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return visits.filter((row) => (
      (statusFilter === 'All' || row.status === statusFilter)
      && (!needle || `${row.reference} ${siteLabel(row.site_id)} ${projectLabel(row.project_id)}`.toLocaleLowerCase().includes(needle))
    ));
  }, [visits, statusFilter, search, siteLabel, projectLabel]);

  const openDetail = (visit) => { returnFocusRowIdRef.current = visit.id; setSelectedVisit(visit); };
  const backToList = () => { setSelectedVisit(null); refreshVisits(); };

  useEffect(() => {
    if (selectedVisit || !returnFocusRowIdRef.current) return;
    const id = returnFocusRowIdRef.current;
    returnFocusRowIdRef.current = null;
    const target = tableWrapRef.current?.querySelector(`[data-safety-visit-row-id="${id}"]`);
    if (target) target.focus();
    else tableWrapRef.current?.focus();
  }, [selectedVisit, visits]);

  const onCreated = async (id) => {
    setCreating(false);
    // createFieldVisit() returns only the new id; the reference number and
    // every other column are server-assigned, so the fresh row is read back
    // from the list rather than guessed at locally — loadFieldVisits() has
    // no single-record counterpart to call instead.
    const { data: freshRows } = await loadFieldVisits({ limit: VISITS_PAGE_SIZE });
    setVisits(freshRows || []);
    setNotice({ tone: 'success', text: t('admin_save_done') });
    const created = (freshRows || []).find((row) => row.id === id);
    if (created) openDetail(created);
  };

  if (selectedVisit) {
    return (
      <SafetyFieldVisitDetail
        visit={selectedVisit}
        tenantId={tenantId}
        employees={employees}
        ppeTypesById={ppeTypesById}
        siteLabel={siteLabel}
        projectLabel={projectLabel}
        onBack={backToList}
        onChanged={refreshVisits}
      />
    );
  }

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('safety_module_kicker')}</span>
          <h1 ref={headingRef} tabIndex={-1}><HardHat className="admin-title-icon" aria-hidden="true" /> {t('safety_visits_title')}</h1>
          <p>{t('safety_visits_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="secondary-button" onClick={refreshVisits}><RefreshCcw aria-hidden="true" /> {t('action_refresh')}</button>
          <button type="button" className="primary-button" onClick={() => setCreating(true)}><Plus aria-hidden="true" /> {t('safety_visits_new')}</button>
        </div>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
        </div>
      )}

      <div className="data-controls">
        <div className="search-control">
          <Search aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('admin_search_placeholder')}
            aria-label={t('action_search')}
          />
        </div>
        <div className="segmented" role="group" aria-label={t('label_status')}>
          {['All', ...FIELD_VISIT_STATUSES].map((status) => (
            <button
              type="button"
              key={status}
              aria-pressed={statusFilter === status}
              className={statusFilter === status ? 'active' : ''}
              onClick={() => setStatusFilter(status)}
            >
              {status === 'All' ? t('label_all') : codeLabel(t, 'safety_visit_status', status, status)}
            </button>
          ))}
        </div>
        <span className="result-count">{t('admin_records_count', { count: filteredVisits.length })}</span>
      </div>

      {visits.length >= VISITS_PAGE_SIZE && <p className="field-note">{t('safety_visits_list_truncated_hint')}</p>}

      <div className="data-table-wrap" ref={tableWrapRef} tabIndex={-1}>
        <table className="enterprise-table">
          <thead>
            <tr>
              <th>{t('reference')}</th><th>{t('safety_field_site')}</th><th>{t('safety_field_project')}</th>
              <th>{t('safety_field_visit_date')}</th><th>{t('label_status')}</th><th aria-label={t('label_actions')} />
            </tr>
          </thead>
          <tbody>
            {filteredVisits.map((row) => (
              <tr key={row.id}>
                <td><code>{row.reference}</code></td>
                <td>{siteLabel(row.site_id) || t('label_none')}</td>
                <td>{projectLabel(row.project_id) || t('label_none')}</td>
                <td>{formatDate(row.visit_date, locale) || '—'}</td>
                <td><span className={`status-badge status-${String(row.status).toLowerCase()}`}>{codeLabel(t, 'safety_visit_status', row.status, row.status)}</span></td>
                <td>
                  <div className="table-actions">
                    <button type="button" data-safety-visit-row-id={row.id} title={t('action_open')} aria-label={t('action_open')} onClick={() => openDetail(row)}>
                      <Eye aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!visitsLoading && !filteredVisits.length && (
              <tr>
                <td colSpan={6}>
                  <div className="empty-table"><HardHat aria-hidden="true" /><b>{t('label_no_results')}</b><span>{t('safety_visits_empty_hint')}</span></div>
                </td>
              </tr>
            )}
            {visitsLoading && <tr><td colSpan={6}>{t('label_loading')}</td></tr>}
          </tbody>
        </table>
      </div>

      {creating && (
        <CreateVisitModal sites={sites} projects={projects} lang={lang} onClose={() => setCreating(false)} onCreated={onCreated} />
      )}
    </div>
  );
};

export default SafetyFieldVisitsAdmin;
