// Operations — employee-facing "My Operations" portal screen (route
// /app/operations, any tenant member, module OPERATIONS, rank 1 — no
// permission beyond being a tenant member and being on the operation's own
// team, mirroring AssetsPortal.jsx/SafetyPortal.jsx's own "any user" rule).
//
// loadOperations() is tenant-wide but RLS-scoped: a plain team member's call
// only ever returns the operations they are actually an assigned team member
// of (the migration's own PERMISSIVE RLS policy, not a client-side filter —
// see src/data/operationsService.js's own header), so "My Operations" below
// needs no extra filtering.
//
// Selecting an operation shows its header details, its checklist, and a
// form to log a new execution record (append-only — there is deliberately
// no edit/delete function for a log, per this module's own design). Both
// the checklist checkboxes and the log form render as LIVE controls only
// for a caller who clears operations_can_write() (Operations.Manage, or
// Operations.Execute plus real team membership — the same v_authorized bar
// operations_checklist_item_toggle()/operations_execution_log_create() each
// enforce server-side); a caller who reaches this screen via Operations.View
// or team membership alone (two of the three admission paths the
// migration's own "members read operations" RLS policy allows) gets a
// read-only view of each instead — see canWrite below. Once a record is
// saved — this module's two Attachments
// entity types (EXECUTION_PHOTO_ENTITY_TYPE/EXECUTION_FILE_ENTITY_TYPE)
// scoped to that record's id so photos/files can be attached to what was
// just logged. Below that sits the operation's own full execution history
// (loadExecutionLogs), each entry showing its own two read-only Attachments
// panels behind a per-row expand toggle — mounting both AttachmentsPanel
// instances for every row unconditionally would fan out into 2N concurrent
// network calls as this append-only, unbounded-length log grows over an
// operation's real lifetime, so only the expanded row's panels are ever
// mounted (mirrors OperationsListAdmin.jsx's own ExecutionLogsPanel).
//
// Linked asset/employee/form/site fields on a log (operationsService's own
// createExecutionLog() accepts them) are intentionally left out of this
// screen: they are real nullable FKs, not required, and this portal has no
// existing asset/employee/form picker of its own to reuse (unlike the
// team-roster picker AssetCustodyUnitsAdmin.jsx already builds for the admin
// side) — pulling in three more services' search UIs just for optional
// fields would be new surface this screen does not need. completionPercent/
// headcount/locationText/notes stay plain optional inputs, never forced.
//
// Data access only ever goes through src/data/operationsService.js. Reuses
// this module's own already-seeded i18n vocabulary (operations_field_*/
// operations_status_*/operations_err_*) plus the shared "name"/"all_statuses"
// keys from LanguageContext.jsx rather than inventing a second set of names
// for the same concepts. The screen shell reuses verification.css's
// .vf-screen/.vf-panel, the same generic non-admin screen furniture
// AssetsPortal.jsx/SafetyPortal.jsx already borrow; this module's own
// operations.css (ops- prefix) carries only what is unique to this screen.

import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import {
  ArrowRight, Check, ChevronDown, ChevronUp, ClipboardList, History,
  ListChecks, Lock, NotebookPen, Search, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import {
  OPERATION_STATUSES,
  canWriteOperation, createExecutionLog, loadChecklistItems, loadExecutionLogs,
  loadOperations, operationsErrorMessage, toggleChecklistItem,
} from '../../data/operationsService';
import { ExecutionLogAttachments } from './operationsShared';
import { codeLabel, formatDate, pickLocalized } from '../../utils/localize';
import './operations.css';

const todayIsoDate = () => new Date().toISOString().slice(0, 10);

const emptyLogForm = () => ({
  logDate: todayIsoDate(),
  startTime: '',
  endTime: '',
  description: '',
  completionPercent: '',
  headcount: '',
  locationText: '',
  notes: '',
});

const OperationStatusBadge = ({ status }) => {
  const { t } = useLanguage();
  return (
    <span className={`status-badge status-${String(status || '').toLowerCase()}`}>
      {codeLabel(t, 'operations_status', status, status)}
    </span>
  );
};

const OperationInfo = ({ label, value, wide }) => (
  <div className={`ops-meta-item ${wide ? 'wide' : ''}`}><span>{label}</span><b>{value || '—'}</b></div>
);

// ---------------------------------------------------------------------------
// One execution log entry in the read-only history list. Its own two
// AttachmentsPanel instances (via ExecutionLogAttachments) mount only while
// the card is expanded — see the file header on why this list can't afford
// to mount them for every row unconditionally.
// ---------------------------------------------------------------------------
const ExecutionLogCard = ({
  log, tenantId, locale, t, expanded, onToggleExpand,
}) => (
  <article className="ops-log-card">
    <div className="ops-log-card-head">
      <div>
        <b>{formatDate(log.log_date, locale) || log.log_date}</b>
        {log.created_by_name && <small>{t('operations_portal_logged_by')} {log.created_by_name}</small>}
      </div>
      <div className="ops-log-card-actions">
        {log.completion_percent != null && <span className="ops-log-percent">{log.completion_percent}%</span>}
        <button
          type="button"
          className="icon-button"
          aria-expanded={expanded}
          aria-label={expanded ? t('operations_logs_collapse') : t('operations_logs_expand')}
          onClick={onToggleExpand}
        >
          {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </button>
      </div>
    </div>
    <p className="ops-log-description">{log.description}</p>
    {(log.headcount != null || log.location_text) && (
      <div className="ops-log-meta-row">
        {log.headcount != null && <span>{t('operations_field_headcount')}: {log.headcount}</span>}
        {log.location_text && <span>{t('operations_field_location')}: {log.location_text}</span>}
      </div>
    )}
    {log.notes && <p className="ops-log-notes">{log.notes}</p>}
    {expanded && <ExecutionLogAttachments tenantId={tenantId} executionLogId={log.id} readOnly t={t} />}
  </article>
);

// ---------------------------------------------------------------------------
// Operation detail — header, checklist, "log a record" form, and the
// operation's own execution history. Always a fresh mount per selected
// operation (the parent swaps the whole subtree), so this effect also
// doubles as the "focus the detail heading when it opens" a11y move — same
// reasoning AssetsPortal.jsx's own AssetDetail documents.
// ---------------------------------------------------------------------------
const OperationDetail = ({ operation, tenantId, onBack }) => {
  const { t, lang, locale } = useLanguage();

  // Tri-state: null while operations_can_write() is still loading (see the
  // mount effect below), then true/false once resolved. Gates the checklist
  // checkboxes and the Add Execution Log form — see this file's own header.
  const [canWrite, setCanWrite] = useState(null);

  const [checklist, setChecklist] = useState([]);
  const [checklistLoading, setChecklistLoading] = useState(true);
  const [checklistBusyId, setChecklistBusyId] = useState(null);

  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [expandedLogId, setExpandedLogId] = useState(null);

  const [notice, setNotice] = useState(null);

  const [logForm, setLogForm] = useState(emptyLogForm);
  const [logBusy, setLogBusy] = useState(false);
  const [logError, setLogError] = useState('');
  const [justCreatedLogId, setJustCreatedLogId] = useState(null);

  const headingRef = useRef(null);

  useEffect(() => {
    headingRef.current?.focus();
    let cancelled = false;
    Promise.all([
      loadChecklistItems(operation.id),
      loadExecutionLogs(operation.id),
      canWriteOperation(operation.id),
    ]).then(
      ([checklistResult, logsResult, canWriteResult]) => {
        if (cancelled) return;
        if (checklistResult.error) {
          setNotice({ tone: 'error', text: operationsErrorMessage(t, checklistResult.error) });
        } else {
          setChecklist(checklistResult.data || []);
        }
        setChecklistLoading(false);
        if (logsResult.error) {
          setNotice({ tone: 'error', text: operationsErrorMessage(t, logsResult.error) });
        } else {
          setLogs(logsResult.data || []);
        }
        setLogsLoading(false);
        // A failed canWriteResult (e.g. NO_ACTIVE_TENANT/OPERATION_NOT_FOUND
        // racing this same operation) fails closed, same as the RPC ever
        // resolving false — no separate error banner, since checklistResult/
        // logsResult above would already surface anything tenant/operation-
        // level actually wrong.
        setCanWrite(!canWriteResult.error && !!canWriteResult.data);
      },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation.id]);

  const sortedChecklist = useMemo(
    () => [...checklist].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0)),
    [checklist],
  );

  const handleToggleChecklist = async (item) => {
    setChecklistBusyId(item.id);
    const { error } = await toggleChecklistItem(item.id, !item.is_done);
    setChecklistBusyId(null);
    if (error) {
      setNotice({ tone: 'error', text: operationsErrorMessage(t, error) });
      return;
    }
    setChecklist((current) => current.map((row) => (
      row.id === item.id ? { ...row, is_done: !item.is_done } : row
    )));
  };

  const setLogField = (key) => (event) => {
    const { value } = event.target;
    setLogForm((current) => ({ ...current, [key]: value }));
  };

  const reloadLogs = async () => {
    const { data, error } = await loadExecutionLogs(operation.id);
    if (error) { setNotice({ tone: 'error', text: operationsErrorMessage(t, error) }); return; }
    setLogs(data || []);
  };

  const submitLog = async (event) => {
    event.preventDefault();
    if (!logForm.description.trim()) {
      setLogError(t('operations_err_description_required'));
      return;
    }
    setLogBusy(true);
    setLogError('');
    const { data: newId, error } = await createExecutionLog({
      operationId: operation.id,
      logDate: logForm.logDate || todayIsoDate(),
      startTime: logForm.startTime,
      endTime: logForm.endTime,
      description: logForm.description,
      completionPercent: logForm.completionPercent === '' ? undefined : Number(logForm.completionPercent),
      headcount: logForm.headcount === '' ? undefined : Number(logForm.headcount),
      locationText: logForm.locationText,
      notes: logForm.notes,
    });
    setLogBusy(false);
    if (error) { setLogError(operationsErrorMessage(t, error)); return; }
    setLogForm(emptyLogForm());
    setJustCreatedLogId(newId);
    setNotice({ tone: 'success', text: t('operations_portal_log_created') });
    await reloadLogs();
  };

  const operationName = pickLocalized(operation, 'name', lang);
  const operationDescription = pickLocalized(operation, 'description', lang);

  return (
    <main className="operations-portal-page app-main">
      <div className="vf-screen">
        <div className="vf-screen-head">
          <div>
            <button type="button" className="secondary-button ops-back-button" onClick={onBack}>
              <ArrowRight aria-hidden="true" /> {t('operations_portal_back_to_list')}
            </button>
            <span className="section-kicker">{operation.number}</span>
            <h1 ref={headingRef} tabIndex={-1}>{operationName}</h1>
          </div>
          <OperationStatusBadge status={operation.status} />
        </div>

        {notice && (
          <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
            {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
            {notice.text}
            <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
          </div>
        )}

        <section className="vf-panel">
          <div className="ops-meta-grid">
            <OperationInfo label={t('operations_field_customer')} value={operation.customer_name} />
            <OperationInfo label={t('operations_field_start_date')} value={formatDate(operation.start_date, locale)} />
            <OperationInfo label={t('operations_field_end_date')} value={formatDate(operation.end_date, locale)} />
            {operationDescription && (
              <OperationInfo label={t('operations_field_description')} value={operationDescription} wide />
            )}
          </div>
        </section>

        <section className="vf-panel">
          <div className="vf-panel-head"><h2><ListChecks aria-hidden="true" /> {t('operations_field_checklist')}</h2></div>
          {checklistLoading ? (
            <div className="page-loader inline-loader">
              <span aria-hidden="true" />
              <span className="sr-only" role="status" aria-live="polite">{t('label_loading')}</span>
            </div>
          ) : !sortedChecklist.length ? (
            <div className="empty-table compact"><ListChecks aria-hidden="true" /><b>{t('operations_portal_checklist_empty')}</b></div>
          ) : (
            <ul className="ops-checklist-list">
              {sortedChecklist.map((item) => (
                <li key={item.id} className="ops-checklist-row">
                  {canWrite ? (
                    <label>
                      <input
                        type="checkbox"
                        checked={!!item.is_done}
                        disabled={checklistBusyId === item.id}
                        onChange={() => handleToggleChecklist(item)}
                      />
                      <span className={item.is_done ? 'done' : ''}>{pickLocalized(item, 'title', lang)}</span>
                    </label>
                  ) : (
                    // No permission (or no team membership) to write on this
                    // operation — operations_checklist_item_toggle() would
                    // reject every toggle, so this renders a static
                    // indicator instead of a live checkbox, mirroring
                    // SafetyPortal.jsx's own don't-render-the-write-
                    // affordance convention rather than a control that
                    // always fails.
                    <div className="ops-checklist-static">
                      <span className={`ops-checklist-static-mark ${item.is_done ? 'done' : ''}`} aria-hidden="true">
                        {item.is_done && <Check size={13} />}
                      </span>
                      <span className={item.is_done ? 'done' : ''}>{pickLocalized(item, 'title', lang)}</span>
                      <span className="sr-only">
                        {item.is_done ? t('operations_portal_checklist_state_done') : t('operations_portal_checklist_state_pending')}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="vf-panel">
          <div className="vf-panel-head"><h2><NotebookPen aria-hidden="true" /> {t('operations_portal_log_form_title')}</h2></div>
          {canWrite === null ? (
            <div className="page-loader inline-loader">
              <span aria-hidden="true" />
              <span className="sr-only" role="status" aria-live="polite">{t('label_loading')}</span>
            </div>
          ) : canWrite ? (
            <>
              <form onSubmit={submitLog}>
                <div className="form-grid">
                  <label className="field-label">
                    {t('operations_field_log_date')}
                    <input type="date" className="form-input" value={logForm.logDate} onChange={setLogField('logDate')} required />
                  </label>
                  <label className="field-label">
                    {t('operations_field_start_time')}
                    <input type="time" className="form-input" value={logForm.startTime} onChange={setLogField('startTime')} />
                  </label>
                  <label className="field-label">
                    {t('operations_field_end_time')}
                    <input type="time" className="form-input" value={logForm.endTime} onChange={setLogField('endTime')} />
                  </label>
                  <label className="field-label">
                    {t('operations_field_completion_percent')}
                    <input
                      type="number" min="0" max="100" className="form-input"
                      value={logForm.completionPercent} onChange={setLogField('completionPercent')}
                    />
                  </label>
                  <label className="field-label">
                    {t('operations_field_headcount')}
                    <input type="number" min="0" className="form-input" value={logForm.headcount} onChange={setLogField('headcount')} />
                  </label>
                  <label className="field-label">
                    {t('operations_field_location')}
                    <input type="text" className="form-input" value={logForm.locationText} onChange={setLogField('locationText')} />
                  </label>
                  <label className="field-label field-span-2">
                    {t('operations_field_description')}
                    <textarea required className="form-input" rows={3} value={logForm.description} onChange={setLogField('description')} />
                  </label>
                  <label className="field-label field-span-2">
                    {t('operations_field_notes')}
                    <textarea className="form-input" rows={2} value={logForm.notes} onChange={setLogField('notes')} />
                  </label>
                </div>

                {logError && <div className="modal-error" role="alert"><X aria-hidden="true" />{logError}</div>}

                <div className="ops-log-submit">
                  <button className="primary-button" disabled={logBusy}>
                    {logBusy ? t('label_loading') : t('operations_portal_log_submit')}
                  </button>
                </div>
              </form>

              {justCreatedLogId && (
                <div className="ops-log-new-attachments">
                  <ExecutionLogAttachments tenantId={tenantId} executionLogId={justCreatedLogId} readOnly={false} t={t} />
                </div>
              )}
            </>
          ) : (
            // Operations.View alone, or team membership without Operations.Execute,
            // sees this operation ("members read operations", the migration's own
            // RLS policy) but cannot pass operations_execution_log_create()'s own
            // v_authorized check — so no form is rendered at all, per
            // SafetyPortal.jsx's own established convention, rather than one that
            // would always fail.
            <div className="inline-message">
              <Lock aria-hidden="true" />
              {t('operations_portal_log_readonly')}
            </div>
          )}
        </section>

        <section className="vf-panel">
          <div className="vf-panel-head"><h2><History aria-hidden="true" /> {t('operations_portal_logs_title')}</h2></div>
          {logsLoading ? (
            <div className="page-loader inline-loader">
              <span aria-hidden="true" />
              <span className="sr-only" role="status" aria-live="polite">{t('label_loading')}</span>
            </div>
          ) : !logs.length ? (
            <div className="empty-table compact"><History aria-hidden="true" /><b>{t('operations_portal_logs_empty')}</b></div>
          ) : (
            <div className="ops-log-list">
              {logs.map((log) => (
                <ExecutionLogCard
                  key={log.id}
                  log={log}
                  tenantId={tenantId}
                  locale={locale}
                  t={t}
                  expanded={expandedLogId === log.id}
                  onToggleExpand={() => setExpandedLogId((current) => (current === log.id ? null : log.id))}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
const OperationsPortal = () => {
  const { t, lang, locale } = useLanguage();
  const { tenant } = useTenant();

  const [loading, setLoading] = useState(true);
  const [operations, setOperations] = useState([]);
  const [notice, setNotice] = useState(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  // Seeded once from a notification deep link's own "?operation=<id>" — the
  // selectedOperation lookup below already no-ops (and falls back to the
  // list) when this id matches nothing in the loaded operations array, same
  // "silently do nothing" rule AssetsPortal.jsx/SafetyPortal.jsx document for
  // an unknown id.
  const [selectedOperationId, setSelectedOperationId] = useState(
    () => new URLSearchParams(window.location.search).get('operation') || null,
  );
  const listHeadingRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    loadOperations({}).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setNotice({ tone: 'error', text: operationsErrorMessage(t, error) });
        setLoading(false);
        return;
      }
      setOperations(data || []);
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleOperations = useMemo(() => {
    let rows = operations;
    if (statusFilter) rows = rows.filter((row) => row.status === statusFilter);
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => (
      `${row.number || ''} ${pickLocalized(row, 'name', lang)} ${row.customer_name || ''}`
        .toLocaleLowerCase().includes(needle)
    ));
  }, [operations, statusFilter, query, lang]);

  const selectedOperation = useMemo(
    () => operations.find((row) => row.id === selectedOperationId) || null,
    [operations, selectedOperationId],
  );

  // Detail view mounting fresh handles its own "focus the heading" side —
  // OperationDetail's own effect does that. Coming back to the list is the
  // one transition this component itself has to move focus for, since the
  // list markup never unmounts, it's just conditionally hidden.
  useEffect(() => {
    if (!selectedOperationId) listHeadingRef.current?.focus();
  }, [selectedOperationId]);

  if (loading) {
    return (
      <div className="page-loader inline-loader">
        <span aria-hidden="true" />
        <span className="sr-only" role="status" aria-live="polite">{t('label_loading')}</span>
      </div>
    );
  }

  return (
    <>
      {selectedOperation ? (
        <OperationDetail
          operation={selectedOperation}
          tenantId={tenant?.id}
          onBack={() => setSelectedOperationId(null)}
        />
      ) : (
        <main className="operations-portal-page app-main">
          <div className="vf-screen">
            <div className="vf-screen-head">
              <div>
                <span className="section-kicker">{t('operations_module_kicker')}</span>
                <h1 ref={listHeadingRef} tabIndex={-1}><ClipboardList className="ops-page-icon" aria-hidden="true" /> {t('operations_portal_title')}</h1>
                <p>{t('operations_portal_intro')}</p>
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
                <h2><ClipboardList aria-hidden="true" /> {t('operations_portal_list_title')}</h2>
                <div className="search-control compact">
                  <Search aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('operations_portal_search_placeholder')}
                    aria-label={t('action_search')}
                  />
                  {query && (
                    <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label={t('action_clear')}>
                      <X size={15} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>

              <div className="segmented" role="group" aria-label={t('operations_field_status')}>
                <button
                  type="button"
                  aria-pressed={statusFilter === ''}
                  className={statusFilter === '' ? 'active' : ''}
                  onClick={() => setStatusFilter('')}
                >
                  {t('all_statuses')}
                </button>
                {OPERATION_STATUSES.map((status) => (
                  <button
                    key={status}
                    type="button"
                    aria-pressed={statusFilter === status}
                    className={statusFilter === status ? 'active' : ''}
                    onClick={() => setStatusFilter(status)}
                  >
                    {codeLabel(t, 'operations_status', status, status)}
                  </button>
                ))}
              </div>

              {!visibleOperations.length ? (
                <div className="empty-table">
                  <ClipboardList aria-hidden="true" />
                  <b>{operations.length ? t('label_no_results') : t('operations_portal_empty')}</b>
                </div>
              ) : (
                <div className="data-table-wrap">
                  <table className="enterprise-table">
                    <thead>
                      <tr>
                        <th>{t('operations_field_number')}</th>
                        <th>{t('name')}</th>
                        <th>{t('operations_field_customer')}</th>
                        <th>{t('operations_field_start_date')}</th>
                        <th>{t('operations_field_end_date')}</th>
                        <th>{t('label_status')}</th>
                        <th aria-label={t('label_actions')} />
                      </tr>
                    </thead>
                    <tbody>
                      {visibleOperations.map((row) => (
                        <tr key={row.id}>
                          <td><code>{row.number}</code></td>
                          <td>
                            <button type="button" className="ops-open-link" onClick={() => setSelectedOperationId(row.id)}>
                              {pickLocalized(row, 'name', lang)}
                            </button>
                          </td>
                          <td>{row.customer_name || '—'}</td>
                          <td>{formatDate(row.start_date, locale) || '—'}</td>
                          <td>{formatDate(row.end_date, locale) || '—'}</td>
                          <td><OperationStatusBadge status={row.status} /></td>
                          <td>
                            <div className="table-actions">
                              <button
                                type="button"
                                title={t('action_details')}
                                aria-label={t('action_details')}
                                onClick={() => setSelectedOperationId(row.id)}
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

export default OperationsPortal;
