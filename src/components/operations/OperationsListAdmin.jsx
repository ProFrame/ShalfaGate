// Operations — main admin screen (admin/operations, AdminNav id 'operations',
// labelKey admin_nav_operations_list, Operations.Manage/View).
//
// The tenant-wide operations list: create/edit an operation's own header
// fields, drive its status through the fixed server-side transition map
// (Draft->Active|Cancelled, Active->OnHold|Completed|Cancelled,
// OnHold->Active|Cancelled; Completed/Cancelled terminal — mirrored here as
// STATUS_TRANSITIONS purely to decide which buttons to OFFER; the real gate
// is operations_set_status() itself, and INVALID_STATUS_TRANSITION still
// surfaces through operationsErrorMessage() if the server disagrees), manage
// its flat team roster, its simple add/toggle/remove checklist, and browse
// its append-only execution log (read-only here — createExecutionLog() has
// no admin-screen caller by design; that is OperationsPortal.jsx's own job
// for the assigned team member who did the work).
//
// Detail view follows SafetyIssuancesAdmin.jsx's own pattern exactly: a full
// screen swap (selectedId state), not a modal/drawer, with the same
// return-focus-to-the-triggering-row-button convention. The team roster
// follows AssetCustodyUnitsAdmin.jsx's own CustodyRosterModal pattern
// (loadRecipients() for the candidate list, useArabicName().employeeName()
// for display, edit-a-local-draft-then-one-full-replace-call-on-Save) minus
// the per-member role code — this module's own team_members table carries
// none (see operationsService.js's own header).
//
// Data access only ever goes through src/data/operationsService.js — this
// screen never calls supabase directly and never touches the database or
// migration layer. Every write RPC's own Operations.Manage gate is enforced
// server-side; this screen renders the actions and lets PERMISSION_DENIED
// surface through operationsErrorMessage() if the account may not use them,
// same convention every sibling admin screen in this codebase documents.

import {
  Fragment, useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Ban, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ClipboardList,
  Eye, History, ListChecks, PauseCircle, Pencil, PlayCircle,
  Plus, RefreshCcw, UserPlus, Users, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { useDialogA11y } from '../../utils/useDialogA11y';
import { useArabicName } from '../../utils/approval';
import {
  codeLabel, formatDate, formatDateTime, pickLocalized,
} from '../../utils/localize';
import { loadRecipients } from '../../data/approvalService';
import { loadOrgDimensions } from '../../data/orgDimensionsService';
import { ExecutionLogAttachments } from './operationsShared';
import {
  OPERATION_STATUSES, operationsErrorMessage,
  loadOperations, saveOperation, setOperationStatus,
  loadTeamMembers, setTeamMembers,
  loadChecklistItems, saveChecklistItem, removeChecklistItem, toggleChecklistItem,
  loadExecutionLogs, loadOperationsTimeline,
} from '../../data/operationsService';
import './operations.css';

// Mirrors operationsService.js's own internal DEFAULT_PAGE_SIZE hint shape
// (see SafetyIssuancesAdmin.jsx's own ISSUANCE_LIST_PAGE_SIZE comment) —
// used only to decide when Next/the truncation hint should be offered.
const PAGE_SIZE = 50;

// Mirrors operations_set_status()'s own fixed transition map (migration
// 202608070057_operations.sql §6.2) — this is only ever used to decide which
// buttons to OFFER; the server re-validates independently on every call.
const STATUS_TRANSITIONS = {
  Draft: ['Active', 'Cancelled'],
  Active: ['OnHold', 'Completed', 'Cancelled'],
  OnHold: ['Active', 'Cancelled'],
  Completed: [],
  Cancelled: [],
};

const STATUS_ICONS = {
  Active: PlayCircle, OnHold: PauseCircle, Completed: CheckCircle2, Cancelled: Ban,
};

const emptyDraft = () => ({
  id: null, name_ar: '', name_en: '', description_ar: '', description_en: '',
  customer_name: '', site_id: '', start_date: '', end_date: '',
});

const draftFromRow = (row) => ({
  id: row.id,
  name_ar: row.name_ar || '',
  name_en: row.name_en || '',
  description_ar: row.description_ar || '',
  description_en: row.description_en || '',
  customer_name: row.customer_name || '',
  site_id: row.site_id || '',
  start_date: row.start_date || '',
  end_date: row.end_date || '',
});

const BackIcon = () => {
  const { isRtl } = useLanguage();
  const Icon = isRtl ? ChevronRight : ChevronLeft;
  return <Icon aria-hidden="true" />;
};

// Mirrors OperationsPortal.jsx's own OperationStatusBadge exactly (not
// imported from there since it isn't exported — see that file's header).
const OperationStatusBadge = ({ status }) => {
  const { t } = useLanguage();
  return (
    <span className={`status-badge status-${String(status || '').toLowerCase()}`}>
      {codeLabel(t, 'operations_status', status, status)}
    </span>
  );
};

// ---------------------------------------------------------------------------
// Create / edit dialog
// ---------------------------------------------------------------------------
const OperationDialog = ({
  draft, sites, busy, error, onChange, onClose, onSubmit,
}) => {
  const { t, lang } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const set = (key) => (event) => onChange({ ...draft, [key]: event.target.value });

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? t('action_edit') : t('operations_add')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('operations_module_kicker')}</span>
            <h3>{draft.id ? t('action_edit') : t('operations_add')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="form-grid">
          <label className="field-label">
            {t('label_name_1')}
            <input required className="form-input" value={draft.name_ar} onChange={set('name_ar')} />
          </label>
          <label className="field-label">
            {t('label_name_2')}
            <input className="form-input" value={draft.name_en} onChange={set('name_en')} />
          </label>

          <label className="field-label field-span-2">
            {t('label_description_1')}
            <textarea className="form-input" value={draft.description_ar} onChange={set('description_ar')} />
          </label>
          <label className="field-label field-span-2">
            {t('label_description_2')}
            <textarea className="form-input" value={draft.description_en} onChange={set('description_en')} />
          </label>

          <label className="field-label">
            {t('operations_field_customer')}
            <input className="form-input" value={draft.customer_name} onChange={set('customer_name')} />
          </label>
          <label className="field-label">
            {t('label_site')}
            <select
              className="form-input"
              value={draft.site_id || ''}
              onChange={(event) => onChange({ ...draft, site_id: event.target.value || null })}
            >
              <option value="">{t('admin_not_assigned')}</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>{site.code} · {pickLocalized(site, 'name', lang)}</option>
              ))}
            </select>
          </label>

          <label className="field-label">
            {t('operations_field_start_date')}
            <input required type="date" className="form-input" value={draft.start_date} onChange={set('start_date')} />
          </label>
          <label className="field-label">
            {t('operations_field_end_date')}
            <input type="date" className="form-input" value={draft.end_date} onChange={set('end_date')} />
          </label>
        </div>

        <p className="field-note">{t('admin_name_pair_hint')}</p>

        {error && <div className="modal-error" role="alert"><X aria-hidden="true" />{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button className="primary-button" disabled={busy}>{busy ? t('label_loading') : t('action_save')}</button>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Team roster modal — operations_team_set_members() is a full-replace RPC
// (no per-member role code, unlike asset_custody_unit_set_members()), so
// this edits a local draft list of user ids and commits it in one call on
// Save. Mirrors AssetCustodyUnitsAdmin.jsx's own CustodyRosterModal shape.
// ---------------------------------------------------------------------------
const OperationTeamRosterModal = ({
  operationId, employees, employeeName, onClose, onSaved,
}) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);

  const [memberIds, setMemberIds] = useState(null); // null while the current roster is still loading
  const [pickUserId, setPickUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadTeamMembers(operationId).then(({ data, error: loadError }) => {
      if (cancelled) return;
      if (loadError) { setError(operationsErrorMessage(t, loadError)); setMemberIds([]); return; }
      setMemberIds((data || []).map((row) => row.user_id));
    });
    return () => { cancelled = true; };
  }, [operationId, t]);

  const memberIdSet = useMemo(() => new Set(memberIds || []), [memberIds]);
  const available = employees.filter((employee) => !memberIdSet.has(employee.id));

  const addMember = () => {
    if (!pickUserId) return;
    setMemberIds((current) => [...(current || []), pickUserId]);
    setPickUserId('');
  };
  const removeMember = (userId) => setMemberIds((current) => (current || []).filter((id) => id !== userId));

  const memberLabel = (userId) => {
    const employee = employees.find((item) => item.id === userId);
    return employee ? employeeName(employee) : userId;
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { error: saveError } = await setTeamMembers(operationId, memberIds || []);
    setBusy(false);
    if (saveError) { setError(operationsErrorMessage(t, saveError)); return; }
    onSaved();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('operations_team_roster_title')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('operations_module_kicker')}</span>
            <h3>{t('operations_team_roster_title')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <p className="field-note">{t('operations_team_roster_hint')}</p>

        {memberIds === null ? (
          <p className="field-note">{t('label_loading')}</p>
        ) : (
          <ul className="ops-roster-list">
            {memberIds.map((userId) => (
              <li key={userId} className="ops-roster-row">
                <span className="ops-roster-name">{memberLabel(userId)}</span>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => removeMember(userId)}
                  aria-label={t('operations_team_remove_member', { name: memberLabel(userId) })}
                >
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
            {!memberIds.length && <li className="field-note">{t('operations_team_empty')}</li>}
          </ul>
        )}

        <div className="ops-roster-add">
          <select
            className="form-input"
            value={pickUserId}
            disabled={memberIds === null}
            onChange={(event) => setPickUserId(event.target.value)}
            aria-label={t('select_employee_placeholder')}
          >
            <option value="">{t('select_employee_placeholder')}</option>
            {available.map((employee) => (
              <option key={employee.id} value={employee.id}>{employeeName(employee)}</option>
            ))}
          </select>
          <button type="button" className="secondary-button" disabled={!pickUserId || memberIds === null} onClick={addMember}>
            <UserPlus aria-hidden="true" /> {t('operations_team_roster_add')}
          </button>
        </div>

        {error && <div className="modal-error" role="alert"><X aria-hidden="true" />{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button className="primary-button" disabled={busy || memberIds === null}>
            {busy ? t('label_loading') : t('action_save')}
          </button>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Checklist panel — simple add/toggle/remove list, no per-item edit (matches
// operationsService.js's own exported surface: saveChecklistItem only ever
// creates a new row here since this panel never sets `id` on submit).
// ---------------------------------------------------------------------------
const ChecklistPanel = ({
  operationId, items, loading, lang, locale, onChanged,
}) => {
  const { t } = useLanguage();
  const [titleAr, setTitleAr] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const addItem = async (event) => {
    event.preventDefault();
    if (!titleAr.trim()) { setError(t('operations_err_title_ar_required')); return; }
    setBusy(true);
    setError('');
    const nextOrder = items.reduce((max, row) => Math.max(max, Number(row.display_order) || 0), 0) + 1;
    const { error: saveError } = await saveChecklistItem({
      operation_id: operationId, title_ar: titleAr.trim(), title_en: titleEn.trim() || null, display_order: nextOrder,
    });
    setBusy(false);
    if (saveError) { setError(operationsErrorMessage(t, saveError)); return; }
    setTitleAr('');
    setTitleEn('');
    onChanged();
  };

  const toggle = async (item) => {
    setError('');
    const { error: toggleError } = await toggleChecklistItem(item.id, !item.is_done);
    if (toggleError) { setError(operationsErrorMessage(t, toggleError)); return; }
    onChanged();
  };

  const remove = async (item) => {
    setError('');
    const { error: removeError } = await removeChecklistItem(item.id);
    if (removeError) { setError(operationsErrorMessage(t, removeError)); return; }
    onChanged();
  };

  return (
    <div>
      {loading ? (
        <p className="field-note">{t('label_loading')}</p>
      ) : items.length ? (
        <ul className="ops-detail-checklist-list">
          {items.map((item) => (
            <li key={item.id} className={`ops-detail-checklist-row${item.is_done ? ' done' : ''}`}>
              <label className="ops-detail-checklist-check">
                <input type="checkbox" checked={Boolean(item.is_done)} onChange={() => toggle(item)} />
                <span className="ops-detail-checklist-title">{pickLocalized(item, 'title', lang)}</span>
              </label>
              {item.is_done && item.done_on && (
                <small>{t('operations_checklist_done_on', { date: formatDate(item.done_on, locale) })}</small>
              )}
              <button type="button" className="icon-button" onClick={() => remove(item)} aria-label={t('operations_checklist_remove', { title: pickLocalized(item, 'title', lang) })}>
                <X aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-table compact"><ListChecks aria-hidden="true" /><b>{t('operations_checklist_empty')}</b></div>
      )}

      <form className="ops-detail-checklist-add" onSubmit={addItem}>
        <input
          className="form-input"
          value={titleAr}
          disabled={busy}
          onChange={(event) => setTitleAr(event.target.value)}
          placeholder={t('operations_checklist_title_ar')}
          aria-label={t('operations_checklist_title_ar')}
        />
        <input
          className="form-input"
          value={titleEn}
          disabled={busy}
          onChange={(event) => setTitleEn(event.target.value)}
          placeholder={t('operations_checklist_title_en')}
          aria-label={t('operations_checklist_title_en')}
        />
        <button type="submit" className="secondary-button" disabled={busy}>
          <Plus aria-hidden="true" /> {t('operations_checklist_add')}
        </button>
      </form>
      {error && <p className="field-note" role="alert">{error}</p>}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Execution logs — read-only (this module's own append-only design; there is
// no edit/delete RPC to wire up here). Each row expands in place to show its
// start/end time, headcount, location and notes, plus its own two read-only
// Attachments panels via the shared ExecutionLogAttachments component
// (./operationsShared) — the same component OperationsPortal.jsx's own
// ExecutionLogCard uses for this module, imported here rather than
// duplicated.
// ---------------------------------------------------------------------------
const ExecutionLogsPanel = ({
  logs, loading, tenantId, locale, t,
}) => {
  const [expandedId, setExpandedId] = useState(null);

  if (loading) return <p className="field-note">{t('label_loading')}</p>;
  if (!logs.length) return <div className="empty-table compact"><ClipboardList aria-hidden="true" /><b>{t('operations_logs_empty')}</b></div>;

  return (
    <div className="data-table-wrap">
      <table className="enterprise-table">
        <thead>
          <tr>
            <th>{t('operations_field_log_date')}</th>
            <th>{t('operations_field_description')}</th>
            <th>{t('operations_field_completion_percent')}</th>
            <th>{t('operations_logs_created_by')}</th>
            <th aria-label={t('label_actions')} />
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => {
            const expanded = expandedId === log.id;
            return (
              <Fragment key={log.id}>
                <tr>
                  <td>{formatDate(log.log_date, locale)}</td>
                  <td>{log.description}</td>
                  <td>{log.completion_percent != null ? `${log.completion_percent}%` : '—'}</td>
                  <td>{log.created_by_name || t('label_none')}</td>
                  <td>
                    <div className="table-actions">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={expanded ? t('operations_logs_collapse') : t('operations_logs_expand')}
                        onClick={() => setExpandedId(expanded ? null : log.id)}
                      >
                        {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                      </button>
                    </div>
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={5}>
                      <div className="ops-detail-log-detail">
                        {(log.start_time || log.end_time) && (
                          <p className="field-note">
                            <b>{t('operations_field_start_time')}:</b> {log.start_time || '—'}
                            {' · '}
                            <b>{t('operations_field_end_time')}:</b> {log.end_time || '—'}
                          </p>
                        )}
                        {log.headcount != null && <p className="field-note"><b>{t('operations_field_headcount')}:</b> {log.headcount}</p>}
                        {log.location_text && <p className="field-note"><b>{t('operations_field_location')}:</b> {log.location_text}</p>}
                        {log.notes && <p className="field-note"><b>{t('operations_field_notes')}:</b> {log.notes}</p>}
                        <ExecutionLogAttachments tenantId={tenantId} executionLogId={log.id} readOnly t={t} />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Timeline tab — operations_timeline()'s own coarse lifecycle feed
// (Created/Updated, StatusChanged, TeamUpdated, ExecutionLogAdded,
// OperationCreatedFromTemplate), supplementary to the Execution Logs tab
// above, not a replacement for it (see operationsService.js's own header).
// Reuses index.css's own global .timeline-item/.timeline-dot/.timeline-body/
// .timeline-head/.timeline-role — only the list-reset is this module's own.
// ---------------------------------------------------------------------------
const OperationTimelinePanel = ({
  rows, loading, t, lang, locale,
}) => {
  if (loading) return <p className="field-note">{t('label_loading')}</p>;
  if (!rows.length) return <div className="empty-table compact"><History aria-hidden="true" /><b>{t('label_no_results')}</b></div>;
  return (
    <ol className="ops-detail-timeline">
      {rows.map((row) => (
        <li key={row.id} className="timeline-item">
          <span className="timeline-dot" />
          <div className="timeline-body">
            <div className="timeline-head">
              <b>{pickLocalized(row, 'title', lang, row.event_code)}</b>
              {row.actor_name && <span className="timeline-role">{row.actor_name}</span>}
            </div>
            <small>{formatDateTime(row.occurred_on, locale)}</small>
          </div>
        </li>
      ))}
    </ol>
  );
};

// ---------------------------------------------------------------------------
// Detail view — full-screen swap (not a modal), mirroring
// SafetyIssuancesAdmin.jsx's own IssuanceDetailView exactly: status control,
// Team/Checklist/Execution Logs/Timeline as a tablist, same
// focus-heading-on-mount and return-focus-to-triggering-row-button
// conventions.
// ---------------------------------------------------------------------------
const TABS = [
  { id: 'team', labelKey: 'operations_field_team', icon: Users },
  { id: 'checklist', labelKey: 'operations_field_checklist', icon: ListChecks },
  { id: 'logs', labelKey: 'operations_tab_logs', icon: ClipboardList },
  { id: 'timeline', labelKey: 'operations_tab_timeline', icon: History },
];

const OperationDetailView = ({
  operation, tenantId, sites, employees, employeeName, onBack, onChanged,
}) => {
  const { t, lang, locale } = useLanguage();

  const [team, setTeam] = useState([]);
  const [checklist, setChecklist] = useState([]);
  const [logs, setLogs] = useState([]);
  const [timeline, setTimeline] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [activeTab, setActiveTab] = useState('team');
  const [notice, setNotice] = useState(null);
  const [statusBusy, setStatusBusy] = useState(null);
  const [rosterOpen, setRosterOpen] = useState(false);

  const refresh = useCallback(() => { setLoading(true); setReloadToken((token) => token + 1); }, []);

  // Checklist-only reload for ChecklistPanel's own onChanged — add/toggle/
  // remove never touch team/logs/timeline (their own migration comments
  // confirm none of them call record_activity()), so refetching just this
  // table avoids the full 4-RPC refresh() and its shared `loading` flip.
  const reloadChecklist = useCallback(async () => {
    const { data, error } = await loadChecklistItems(operation.id);
    if (error) { setNotice({ tone: 'error', text: operationsErrorMessage(t, error) }); return; }
    setChecklist(data || []);
  }, [operation.id, t]);

  // `operation` itself is the row the parent's own list already holds (there
  // is no singular loadOperation(id) exported outside the templates screen's
  // own narrow use) — this effect only ever fetches what genuinely needs its
  // own request: team, checklist, execution logs and the timeline.
  useEffect(() => {
    const operationId = operation?.id;
    if (!operationId) return undefined;
    let cancelled = false;
    Promise.all([
      loadTeamMembers(operationId),
      loadChecklistItems(operationId),
      loadExecutionLogs(operationId),
      loadOperationsTimeline(operationId),
    ]).then(([teamResult, checklistResult, logsResult, timelineResult]) => {
      if (cancelled) return;
      const firstError = teamResult.error || checklistResult.error || logsResult.error || timelineResult.error;
      if (firstError) setNotice({ tone: 'error', text: operationsErrorMessage(t, firstError) });
      setTeam(teamResult.data || []);
      setChecklist(checklistResult.data || []);
      setLogs(logsResult.data || []);
      setTimeline(timelineResult.data || []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [operation?.id, reloadToken, t]);

  const siteById = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);
  const employeeLabel = useCallback((userId) => {
    const employee = employees.find((item) => item.id === userId);
    return employee ? employeeName(employee) : userId;
  }, [employees, employeeName]);

  // Moves focus to the detail heading once, the moment this view finishes
  // its first load — same ref-guard convention SafetyIssuancesAdmin.jsx's
  // own IssuanceDetailView documents for its own headingRef.
  const headingRef = useRef(null);
  const headingFocusedRef = useRef(false);
  useEffect(() => {
    if (!operation || headingFocusedRef.current) return;
    headingFocusedRef.current = true;
    headingRef.current?.focus();
  }, [operation]);

  const afterMutate = () => {
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refresh();
    onChanged?.();
  };

  const changeStatus = async (status) => {
    setStatusBusy(status);
    const { error } = await setOperationStatus(operation.id, status);
    setStatusBusy(null);
    if (error) { setNotice({ tone: 'error', text: operationsErrorMessage(t, error) }); return; }
    afterMutate();
  };

  if (!operation) {
    return (
      <div className="admin-content">
        <button type="button" className="secondary-button" onClick={onBack}><BackIcon /> {t('operations_back_to_list')}</button>
        <p className="field-note">{t('label_loading')}</p>
      </div>
    );
  }

  const nextStatuses = STATUS_TRANSITIONS[operation.status] || [];

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <button type="button" className="secondary-button" onClick={onBack}><BackIcon /> {t('operations_back_to_list')}</button>
        <button type="button" className="secondary-button" onClick={refresh}><RefreshCcw aria-hidden="true" /> {t('action_refresh')}</button>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
        </div>
      )}

      <div className="ops-detail-head">
        <div>
          <span className="section-kicker">{t('operations_module_kicker')}</span>
          <h1 ref={headingRef} tabIndex={-1}>{pickLocalized(operation, 'name', lang) || operation.number}</h1>
          <code className="ops-detail-reference">{operation.number}</code>

          <div className="ops-detail-meta-grid">
            <div className="ops-detail-meta-item"><span>{t('operations_field_customer')}</span><b>{operation.customer_name || t('label_none')}</b></div>
            <div className="ops-detail-meta-item"><span>{t('label_site')}</span><b>{pickLocalized(siteById.get(operation.site_id), 'name', lang) || t('label_none')}</b></div>
            <div className="ops-detail-meta-item"><span>{t('operations_field_start_date')}</span><b>{formatDate(operation.start_date, locale)}</b></div>
            <div className="ops-detail-meta-item"><span>{t('operations_field_end_date')}</span><b>{operation.end_date ? formatDate(operation.end_date, locale) : t('label_none')}</b></div>
            <div className="ops-detail-meta-item">
              <span>{t('operations_field_status')}</span>
              <b><OperationStatusBadge status={operation.status} /></b>
            </div>
          </div>

          {(operation.description_ar || operation.description_en) && (
            <p className="field-note">{pickLocalized(operation, 'description', lang)}</p>
          )}
        </div>

        <div className="ops-detail-actions-row">
          {nextStatuses.map((status) => {
            const StatusIcon = STATUS_ICONS[status] || CheckCircle2;
            return (
              <button
                key={status}
                type="button"
                className="secondary-button"
                disabled={Boolean(statusBusy)}
                onClick={() => changeStatus(status)}
              >
                <StatusIcon aria-hidden="true" />
                {statusBusy === status ? t('label_loading') : t('operations_set_status_to', { status: codeLabel(t, 'operations_status', status, status) })}
              </button>
            );
          })}
          {!nextStatuses.length && <p className="field-note">{t('operations_status_terminal_hint')}</p>}
        </div>
      </div>

      <div className="ops-detail-tablist" role="tablist" aria-label={operation.number}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`ops-detail-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`ops-detail-tabpanel-${tab.id}`}
            className={activeTab === tab.id ? 'active' : ''}
            onClick={() => setActiveTab(tab.id)}
          >
            <tab.icon aria-hidden="true" /> {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div id={`ops-detail-tabpanel-${activeTab}`} role="tabpanel" aria-labelledby={`ops-detail-tab-${activeTab}`} className="ops-detail-tab-panel">
        {activeTab === 'team' && (
          <div>
            <div className="ops-detail-panel-head">
              <b>{t('operations_field_team')}</b>
              <button type="button" className="secondary-button" onClick={() => setRosterOpen(true)}>
                <Users aria-hidden="true" /> {t('operations_team_manage')}
              </button>
            </div>
            {loading ? (
              <p className="field-note">{t('label_loading')}</p>
            ) : team.length ? (
              <ul className="ops-detail-team-list">
                {team.map((member) => <li key={member.id} className="ops-detail-team-chip">{employeeLabel(member.user_id)}</li>)}
              </ul>
            ) : (
              <div className="empty-table compact"><Users aria-hidden="true" /><b>{t('operations_team_empty')}</b></div>
            )}
          </div>
        )}

        {activeTab === 'checklist' && (
          <ChecklistPanel
            operationId={operation.id}
            items={checklist}
            loading={loading}
            lang={lang}
            locale={locale}
            onChanged={reloadChecklist}
          />
        )}

        {activeTab === 'logs' && (
          <ExecutionLogsPanel logs={logs} loading={loading} tenantId={tenantId} locale={locale} t={t} />
        )}

        {activeTab === 'timeline' && (
          <OperationTimelinePanel rows={timeline} loading={loading} t={t} lang={lang} locale={locale} />
        )}
      </div>

      {rosterOpen && (
        <OperationTeamRosterModal
          operationId={operation.id}
          employees={employees}
          employeeName={employeeName}
          onClose={() => setRosterOpen(false)}
          onSaved={() => { setRosterOpen(false); afterMutate(); }}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// List / screen
// ---------------------------------------------------------------------------
const OperationsListAdmin = () => {
  const { t, locale } = useLanguage();
  const { tenant } = useTenant();
  const tenantId = tenant?.id || null;
  const { employeeName } = useArabicName();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedId, setSelectedId] = useState(null);

  const [sites, setSites] = useState([]);
  const [employees, setEmployees] = useState([]);

  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState('');
  const [busy, setBusy] = useState(false);

  // Which row's Eye button opened the detail view, so onBack can return
  // focus to it — same convention SafetyIssuancesAdmin.jsx's own
  // returnFocusRowIdRef documents.
  const returnFocusRowIdRef = useRef(null);
  const tableWrapRef = useRef(null);

  const refreshList = useCallback(() => { setLoading(true); setReloadToken((token) => token + 1); }, []);

  // Dropdown/lookup sources — each loaded through its own already-established
  // service, never requeried here, each degrading to an empty list on
  // failure rather than blocking the screen.
  useEffect(() => {
    let cancelled = false;
    Promise.all([loadOrgDimensions(), loadRecipients().catch(() => [])])
      .then(([dimensionsResult, employeeRows]) => {
        if (cancelled) return;
        setSites(dimensionsResult.data?.sites || []);
        setEmployees(employeeRows || []);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadOperations({ status: statusFilter || undefined, limit: PAGE_SIZE, offset }).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setRows([]);
        setNotice({ tone: 'error', text: operationsErrorMessage(t, error) || t('admin_load_failed') });
      } else {
        setRows(data || []);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [statusFilter, offset, reloadToken, t]);

  useEffect(() => {
    if (selectedId || !returnFocusRowIdRef.current) return;
    const id = returnFocusRowIdRef.current;
    returnFocusRowIdRef.current = null;
    const target = tableWrapRef.current?.querySelector(`[data-operation-row-id="${id}"]`);
    if (target) target.focus();
    else tableWrapRef.current?.focus();
  }, [selectedId, rows]);

  const openDetail = (id) => { returnFocusRowIdRef.current = id; setSelectedId(id); };
  const openCreate = () => { setDraftError(''); setDraft(emptyDraft()); };
  const openEdit = (row) => { setDraftError(''); setDraft(draftFromRow(row)); };

  const saveDraft = async () => {
    setBusy(true);
    setDraftError('');
    const { error } = await saveOperation(draft);
    setBusy(false);
    if (error) { setDraftError(operationsErrorMessage(t, error)); return; }
    setDraft(null);
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refreshList();
  };

  const selectedOperation = useMemo(() => rows.find((row) => row.id === selectedId) || null, [rows, selectedId]);

  if (selectedId) {
    return (
      <OperationDetailView
        operation={selectedOperation}
        tenantId={tenantId}
        sites={sites}
        employees={employees}
        employeeName={employeeName}
        onBack={() => { setSelectedId(null); refreshList(); }}
        onChanged={refreshList}
      />
    );
  }

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('operations_module_kicker')}</span>
          <h1><ClipboardList className="admin-title-icon" aria-hidden="true" /> {t('module_operations')}</h1>
          <p>{t('operations_list_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="primary-button" onClick={openCreate}>
            <Plus aria-hidden="true" /> {t('operations_add')}
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

      <div className="filter-bar">
        <select
          className="form-input"
          value={statusFilter}
          onChange={(event) => { setStatusFilter(event.target.value); setOffset(0); setLoading(true); }}
          aria-label={t('operations_field_status')}
        >
          <option value="">{t('operations_filter_all_statuses')}</option>
          {OPERATION_STATUSES.map((status) => <option key={status} value={status}>{codeLabel(t, 'operations_status', status, status)}</option>)}
        </select>
        <span className="result-count">{t('admin_records_count', { count: rows.length })}</span>
      </div>
      {rows.length >= PAGE_SIZE && <p className="field-note">{t('operations_list_truncated_hint')}</p>}

      <div className="data-table-wrap" ref={tableWrapRef} tabIndex={-1}>
        <table className="enterprise-table">
          <thead>
            <tr>
              <th>{t('operations_field_number')}</th>
              <th>{t('label_name_1')}</th>
              <th>{t('label_name_2')}</th>
              <th>{t('operations_field_customer')}</th>
              <th>{t('operations_field_start_date')}</th>
              <th>{t('operations_field_end_date')}</th>
              <th>{t('label_status')}</th>
              <th aria-label={t('label_actions')} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td><code>{row.number}</code></td>
                <td><b>{row.name_ar}</b></td>
                <td>{row.name_en || '—'}</td>
                <td>{row.customer_name || '—'}</td>
                <td>{formatDate(row.start_date, locale)}</td>
                <td>{row.end_date ? formatDate(row.end_date, locale) : '—'}</td>
                <td><OperationStatusBadge status={row.status} /></td>
                <td>
                  <div className="table-actions">
                    <button type="button" data-operation-row-id={row.id} title={t('action_details')} aria-label={t('action_details')} onClick={() => openDetail(row.id)}>
                      <Eye aria-hidden="true" />
                    </button>
                    <button type="button" title={t('admin_edit_record')} aria-label={t('admin_edit_record')} onClick={() => openEdit(row)}>
                      <Pencil aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && !rows.length && (
              <tr>
                <td colSpan={8}>
                  <div className="empty-table"><ClipboardList aria-hidden="true" /><b>{t('label_no_results')}</b></div>
                </td>
              </tr>
            )}
            {loading && <tr><td colSpan={8}>{t('label_loading')}</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <button type="button" disabled={offset === 0} onClick={() => { setLoading(true); setOffset((value) => Math.max(0, value - PAGE_SIZE)); }}>
          {t('action_previous')}
        </button>
        <span className="active">{t('admin_records_count', { count: rows.length })}</span>
        <button type="button" disabled={rows.length < PAGE_SIZE} onClick={() => { setLoading(true); setOffset((value) => value + PAGE_SIZE); }}>
          {t('action_next')}
        </button>
      </div>

      {draft && (
        <OperationDialog
          draft={draft}
          sites={sites}
          busy={busy}
          error={draftError}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSubmit={saveDraft}
        />
      )}
    </div>
  );
};

export default OperationsListAdmin;
