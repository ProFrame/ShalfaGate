import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlarmClock, ArrowDown, ArrowUp, Check, CheckCircle2, Eye, Filter, GitPullRequestArrow, ListChecks, Pencil, Plus,
  RefreshCcw, Trash2, UserRoundCog, Workflow, X,
} from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import {
  assignFinalApproval, assignSchemeToTemplate, loadAdminRequestsList, loadApprovalDashboard, loadApprovalRoles,
  loadApprovalSchemes, loadDepartmentsForFilter, loadRecipients, loadTemplatesWithSchemes, reassignApproval,
  saveApprovalRole, saveApprovalScheme,
} from '../data/approvalService';
import { pickLocalized } from '../utils/localize';
import { agingLabel, approvalErrorMessage, hoursSince, useArabicName } from '../utils/approval';
import { useDialogA11y } from '../utils/useDialogA11y';

const SLA_HOURS = 48;
const hoursBetween = (start, end) => (start ? Math.max(0, (new Date(end || Date.now()).getTime() - new Date(start).getTime()) / 36e5) : 0);

// ---------------------------------------------------------------------------
// Approval setup: roles, schemes (ordered role sets) and template links.
// ---------------------------------------------------------------------------
export const ApprovalSetupAdmin = () => {
  const { t } = useLanguage();
  const { roleName } = useArabicName();
  const [roles, setRoles] = useState([]);
  const [schemes, setSchemes] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [editingRole, setEditingRole] = useState(null);
  const [editingScheme, setEditingScheme] = useState(null);
  const [notice, setNotice] = useState('');

  const refresh = useCallback(() => {
    Promise.all([loadApprovalRoles(), loadApprovalSchemes(), loadTemplatesWithSchemes(), loadRecipients()])
      .then(([rolesData, schemesData, templatesData, employeesData]) => {
        setRoles(rolesData);
        setSchemes(schemesData);
        setTemplates(templatesData);
        setEmployees(employeesData);
      })
      .catch((error) => setNotice(approvalErrorMessage(t, error)));
  }, [t]);

  useEffect(() => { refresh(); }, [refresh]);

  const saveRole = async (draft) => {
    try {
      await saveApprovalRole(draft);
      setEditingRole(null);
      setNotice(t('saved_successfully'));
      refresh();
    } catch (error) {
      setNotice(approvalErrorMessage(t, error));
    }
  };

  const saveScheme = async (draft, roleEntries) => {
    try {
      await saveApprovalScheme(draft, roleEntries);
      setEditingScheme(null);
      setNotice(t('saved_successfully'));
      refresh();
    } catch (error) {
      setNotice(approvalErrorMessage(t, error));
    }
  };

  const assignTemplate = async (templateId, schemeId) => {
    try {
      await assignSchemeToTemplate(templateId, schemeId);
      setNotice(t('saved_successfully'));
      refresh();
    } catch (error) {
      setNotice(approvalErrorMessage(t, error));
    }
  };

  const updateFinalApproval = async (template, patch) => {
    try {
      await assignFinalApproval(template.id, {
        requiresFinalApproval: patch.requiresFinalApproval ?? template.requires_final_approval,
        finalApproverUserId: patch.finalApproverUserId !== undefined ? patch.finalApproverUserId : template.final_approver_user_id,
      });
      setNotice(t('saved_successfully'));
      refresh();
    } catch (error) {
      setNotice(approvalErrorMessage(t, error));
    }
  };

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('approval_center')}</span>
          <h1>{t('approval_setup')}</h1>
          <p>{t('approval_setup_intro')}</p>
        </div>
        <div className="toolbar-buttons">
          <button className="secondary-button" onClick={() => setEditingRole({ is_active: true })}><Plus /> {t('add_role')}</button>
          <button className="primary-button" onClick={() => setEditingScheme({ scheme: { is_active: true }, roleEntries: [] })}><Plus /> {t('add_scheme')}</button>
        </div>
      </div>

      {notice && <div className="inline-message" role="status" aria-live="polite"><Check />{notice}<button type="button" onClick={() => setNotice('')} aria-label={t('action_close')}><X /></button></div>}

      <div className="approval-setup-grid">
        <section className="dashboard-panel">
          <h3><UserRoundCog /> {t('approval_roles_title')}</h3>
          <div className="data-table-wrap">
            <table className="enterprise-table">
              <thead><tr><th>{t('code')}</th><th>{t('name_arabic')}</th><th>{t('name_english')}</th><th>{t('status')}</th><th /></tr></thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id}>
                    <td><code>{role.code}</code></td>
                    <td>{role.name_ar}</td>
                    <td>{role.name_en}</td>
                    <td><span className={`status-badge ${role.is_active ? 'status-approved' : 'status-closed'}`}>{role.is_active ? t('active') : t('inactive')}</span></td>
                    <td><div className="table-actions"><button onClick={() => setEditingRole(role)} title={t('edit')}><Pencil /></button></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="dashboard-panel">
          <h3><Workflow /> {t('approval_schemes_title')}</h3>
          <div className="scheme-cards">
            {schemes.map((scheme) => (
              <article key={scheme.id} className="scheme-card">
                <div className="scheme-card-head">
                  <div><code>{scheme.code}</code><b>{roleName(scheme)}</b></div>
                  <button className="icon-button" onClick={() => setEditingScheme({ scheme, roleEntries: (scheme.roles || []).map((role) => ({ roleId: role.id, allowSelfApproval: !!role.allow_self_approval })) })} title={t('edit')}><Pencil /></button>
                </div>
                <ol className="scheme-role-chain">
                  {(scheme.roles || []).map((role) => <li key={role.id}>{roleName(role)}</li>)}
                </ol>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="dashboard-panel">
        <h3><GitPullRequestArrow /> {t('linked_templates')}</h3>
        <div className="data-table-wrap">
          <table className="enterprise-table">
            <thead>
              <tr>
                <th>{t('forms')}</th><th>{t('code')}</th><th>{t('assign_scheme')}</th>
                <th>{t('requires_final_approval')}</th><th>{t('final_approver_suggested')}</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((template) => (
                <tr key={template.id}>
                  <td><b>{template.name_ar || template.name}</b></td>
                  <td><code>{template.code}</code></td>
                  <td>
                    <select
                      className="form-input"
                      value={template.approval_scheme_id || ''}
                      onChange={(event) => assignTemplate(template.id, event.target.value || null)}
                    >
                      <option value="">{t('not_assigned')}</option>
                      {schemes.map((scheme) => <option key={scheme.id} value={scheme.id}>{roleName(scheme)}</option>)}
                    </select>
                  </td>
                  <td title={t('requires_final_approval_hint')}>
                    <input
                      type="checkbox"
                      aria-label={t('requires_final_approval')}
                      checked={template.requires_final_approval !== false}
                      onChange={(event) => updateFinalApproval(template, { requiresFinalApproval: event.target.checked })}
                    />
                  </td>
                  <td>
                    <select
                      className="form-input"
                      disabled={template.requires_final_approval === false}
                      value={template.final_approver_user_id || ''}
                      onChange={(event) => updateFinalApproval(template, { finalApproverUserId: event.target.value || null })}
                      title={t('final_approver_suggested_hint')}
                    >
                      <option value="">{t('no_final_approver')}</option>
                      {employees.map((employee) => (
                        <option key={employee.id} value={employee.id}>{employee.full_name || employee.name_ar || employee.name_en}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editingRole && <RoleModal role={editingRole} onClose={() => setEditingRole(null)} onSave={saveRole} />}
      {editingScheme && (
        <SchemeModal
          scheme={editingScheme.scheme}
          initialRoleEntries={editingScheme.roleEntries}
          roles={roles}
          onClose={() => setEditingScheme(null)}
          onSave={saveScheme}
        />
      )}
    </div>
  );
};

const RoleModal = ({ role, onClose, onSave }) => {
  const { t } = useLanguage();
  const [draft, setDraft] = useState(role);
  const field = (key) => (event) => setDraft({ ...draft, [key]: event.target.value });
  const closeRef = useDialogA11y(onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form className="modal-card" role="dialog" aria-modal="true" aria-label={draft.id ? t('edit') : t('add_role')} onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); onSave(draft); }}>
        <div className="modal-heading"><h3>{draft.id ? t('edit') : t('add_role')}</h3><button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}><X /></button></div>
        <label className="field-label">{t('code')}<input required className="form-input" disabled={draft.is_system} value={draft.code || ''} onChange={field('code')} /></label>
        <label className="field-label">{t('name_arabic')}<input required className="form-input" value={draft.name_ar || ''} onChange={field('name_ar')} /></label>
        <label className="field-label">{t('name_english')}<input required className="form-input" value={draft.name_en || ''} onChange={field('name_en')} /></label>
        <label className="field-label">{t('account_status')}
          <select className="form-input" value={String(draft.is_active ?? true)} onChange={(event) => setDraft({ ...draft, is_active: event.target.value === 'true' })}>
            <option value="true">{t('active')}</option>
            <option value="false">{t('inactive')}</option>
          </select>
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('cancel')}</button>
          <button className="primary-button">{t('save')}</button>
        </div>
      </form>
    </div>
  );
};

const SchemeModal = ({ scheme, initialRoleEntries, roles, onClose, onSave }) => {
  const { t } = useLanguage();
  const { roleName } = useArabicName();
  const closeRef = useDialogA11y(onClose);
  const [draft, setDraft] = useState(scheme);
  const [roleEntries, setRoleEntries] = useState(initialRoleEntries);
  const field = (key) => (event) => setDraft({ ...draft, [key]: event.target.value });
  const usedIds = roleEntries.map((entry) => entry.roleId);
  const available = roles.filter((role) => role.is_active !== false && !usedIds.includes(role.id));
  const move = (index, delta) => {
    const next = [...roleEntries];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setRoleEntries(next);
  };
  const toggleSelfApproval = (roleId, allowed) => {
    setRoleEntries(roleEntries.map((entry) => (entry.roleId === roleId ? { ...entry, allowSelfApproval: allowed } : entry)));
  };
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form className="modal-card modal-wide" role="dialog" aria-modal="true" aria-label={draft.id ? t('edit') : t('add_scheme')} onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); onSave(draft, roleEntries); }}>
        <div className="modal-heading"><h3>{draft.id ? t('edit') : t('add_scheme')}</h3><button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}><X /></button></div>
        <div className="form-grid">
          <label className="field-label">{t('code')}<input required className="form-input" value={draft.code || ''} onChange={field('code')} /></label>
          <label className="field-label">{t('name_arabic')}<input required className="form-input" value={draft.name_ar || ''} onChange={field('name_ar')} /></label>
          <label className="field-label">{t('name_english')}<input required className="form-input" value={draft.name_en || ''} onChange={field('name_en')} /></label>
          <label className="field-label">{t('add_role')}
            <select
              className="form-input"
              value=""
              onChange={(event) => { if (event.target.value) setRoleEntries([...roleEntries, { roleId: event.target.value, allowSelfApproval: false }]); }}
            >
              <option value="">{t('select_approval_role')}</option>
              {available.map((role) => <option key={role.id} value={role.id}>{roleName(role)}</option>)}
            </select>
          </label>
        </div>
        <div className="scheme-role-editor">
          <b>{t('scheme_roles')}</b>
          {!roleEntries.length && <p className="field-note">{t('scheme_roles_hint')}</p>}
          <ol>
            {roleEntries.map((entry, index) => {
              const role = roles.find((item) => item.id === entry.roleId);
              return (
                <li key={entry.roleId}>
                  <span>{index + 1}. {roleName(role) || entry.roleId}</span>
                  <label className="field-note" title={t('allow_self_approval_hint')}>
                    <input
                      type="checkbox"
                      checked={!!entry.allowSelfApproval}
                      onChange={(event) => toggleSelfApproval(entry.roleId, event.target.checked)}
                    /> {t('allow_self_approval')}
                  </label>
                  <div className="table-actions">
                    <button type="button" onClick={() => move(index, -1)} title={t('move_up')}><ArrowUp /></button>
                    <button type="button" onClick={() => move(index, 1)} title={t('move_down')}><ArrowDown /></button>
                    <button type="button" className="danger" onClick={() => setRoleEntries(roleEntries.filter((item) => item.roleId !== entry.roleId))} title={t('delete')}><Trash2 /></button>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('cancel')}</button>
          <button className="primary-button" disabled={!roleEntries.length}>{t('save')}</button>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Tracking: every in-flight request, its holder and age; stuck requests can be
// reassigned to another user by administrators.
// ---------------------------------------------------------------------------
export const ApprovalTrackingAdmin = ({ onViewForm }) => {
  const { t } = useLanguage();
  const [data, setData] = useState(null);
  const [notice, setNotice] = useState('');
  const [reassigning, setReassigning] = useState(null);
  const [employees, setEmployees] = useState([]);

  const refresh = useCallback(() => {
    loadApprovalDashboard()
      .then(setData)
      .catch((error) => setNotice(approvalErrorMessage(t, error)));
  }, [t]);

  useEffect(() => {
    refresh();
    loadRecipients().then(setEmployees).catch(() => setEmployees([]));
  }, [refresh]);

  const pending = data?.pending || [];
  const lateCount = pending.filter((row) => hoursSince(row.pending_since) > SLA_HOURS).length;

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('approval_center')}</span>
          <h1>{t('approval_tracking')}</h1>
          <p>{t('approval_tracking_intro')}</p>
        </div>
        <button className="secondary-button" onClick={refresh}><RefreshCcw /> {t('refresh')}</button>
      </div>

      {notice && <div className="inline-message" role="status" aria-live="polite"><CheckCircle2 />{notice}<button type="button" onClick={() => setNotice('')} aria-label={t('action_close')}><X /></button></div>}

      <div className="kpi-grid compact">
        <div className="kpi-card"><GitPullRequestArrow /><div><span>{t('pending_requests')}</span><b>{pending.length}</b></div></div>
        <div className="kpi-card sla"><AlarmClock /><div><span>{t('sla_violations')}</span><b>{lateCount}</b></div></div>
      </div>

      <div className="data-table-wrap">
        <table className="enterprise-table">
          <thead>
            <tr>
              <th>{t('forms')}</th>
              <th>{t('requested_by')}</th>
              <th>{t('current_holder')}</th>
              <th>{t('approval_role')}</th>
              <th>{t('aging')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pending.map((row) => {
              const hours = hoursSince(row.pending_since);
              return (
                <tr key={row.id} className={hours > SLA_HOURS ? 'row-late' : ''}>
                  <td><b>{row.reference_no}</b> <small>{row.template_name_ar || row.template_name}</small></td>
                  <td>{row.requester_name || '—'}</td>
                  <td>{row.assignee_name || '—'}{row.assignee_department ? <small className="cell-sub"> · {row.assignee_department}</small> : null}</td>
                  <td>{row.is_review ? t('review_requested') : row.role_name_ar || '—'}</td>
                  <td>
                    <span className={`aging-badge ${hours > SLA_HOURS ? 'late' : hours > SLA_HOURS / 2 ? 'warning' : ''}`}>
                      {agingLabel(t, hours)}
                    </span>
                  </td>
                  <td>
                    <div className="table-actions">
                      {onViewForm && <button onClick={() => onViewForm(row.id)} title={t('view_details')}><Eye /></button>}
                      <button onClick={() => setReassigning(row)} title={t('reassign_request')}><UserRoundCog /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!pending.length && (
              <tr><td colSpan="6"><div className="empty-table"><GitPullRequestArrow /><b>{t('no_pending_requests')}</b><span>{t('approval_empty_hint')}</span></div></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {reassigning && (
        <ReassignModal
          row={reassigning}
          employees={employees}
          onClose={() => setReassigning(null)}
          onDone={() => { setReassigning(null); setNotice(t('reassign_success')); refresh(); }}
          onError={(error) => setNotice(approvalErrorMessage(t, error))}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// All Requests: every submitted request across all statuses, filtered.
// Distinct from the pending-only dashboard above (FourthUpdate.md — "مدير
// النظام يجب أن يرى كل الطلبات... مع Filters").
// ---------------------------------------------------------------------------
const STATUS_OPTIONS = ['Submitted', 'InApproval', 'Returned', 'Approved', 'Rejected', 'Cancelled'];
const STATUS_KEYS = {
  Submitted: 'status_submitted', InApproval: 'status_in_approval', Returned: 'status_returned',
  Approved: 'status_approved', Rejected: 'status_rejected', Cancelled: 'status_cancelled',
};
// No tagId filter here: nothing in the shipped app can tag a Form yet (see
// approval_admin_requests_list()'s own header comment, migration 044) — a
// filter control that can never match a row reads as broken, not
// forward-looking, so it isn't rendered. The backend's p_tag_id parameter
// stays available for whenever Forms actually become taggable.
const EMPTY_FILTERS = {
  templateId: '', status: '', departmentId: '', requesterId: '', dateFrom: '', dateTo: '', approverId: '',
};

export const ApprovalAllRequestsAdmin = ({ onViewForm }) => {
  const { t, lang } = useLanguage();
  const [rows, setRows] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([loadTemplatesWithSchemes(), loadDepartmentsForFilter(), loadRecipients()])
      .then(([templatesData, departmentsData, employeesData]) => {
        setTemplates(templatesData);
        setDepartments(departmentsData);
        setEmployees(employeesData);
      })
      .catch(() => {});
  }, []);

  const fetchRows = useCallback((activeFilters) => {
    loadAdminRequestsList(activeFilters)
      .then((data) => { setRows(data); setLoading(false); })
      .catch((error) => { setNotice(approvalErrorMessage(t, error)); setLoading(false); });
  }, [t]);

  // `loading` already starts true, so this effect's own body never calls
  // setState synchronously — only fetchRows()'s async .then()/.catch() does.
  // Mount-only on purpose: fetchRows's identity also changes on a language
  // switch (it closes over `t`), and re-running this effect then would
  // silently refetch with EMPTY_FILTERS, discarding whatever the admin had
  // already applied while the filter selects still showed their choices.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchRows(EMPTY_FILTERS); }, []);

  const runSearch = (activeFilters) => { setLoading(true); fetchRows(activeFilters); };

  const field = (key) => (event) => setFilters({ ...filters, [key]: event.target.value });
  const clear = () => { setFilters(EMPTY_FILTERS); runSearch(EMPTY_FILTERS); };

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('approval_center')}</span>
          <h1>{t('all_requests')}</h1>
          <p>{t('all_requests_intro')}</p>
        </div>
        <button className="secondary-button" onClick={() => runSearch(filters)}><RefreshCcw /> {t('refresh')}</button>
      </div>

      {notice && <div className="inline-message" role="status" aria-live="polite"><CheckCircle2 />{notice}<button type="button" onClick={() => setNotice('')} aria-label={t('action_close')}><X /></button></div>}

      <div className="filter-bar">
        <select className="form-input" value={filters.templateId} onChange={field('templateId')}>
          <option value="">{t('all_templates')}</option>
          {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name_ar || tpl.name}</option>)}
        </select>
        <select className="form-input" value={filters.status} onChange={field('status')}>
          <option value="">{t('all_statuses')}</option>
          {STATUS_OPTIONS.map((status) => <option key={status} value={status}>{t(STATUS_KEYS[status])}</option>)}
        </select>
        <select className="form-input" value={filters.departmentId} onChange={field('departmentId')}>
          <option value="">{t('filter_by_department')}</option>
          {departments.map((dep) => <option key={dep.id} value={dep.id}>{pickLocalized(dep, 'name', lang, dep.name_ar)}</option>)}
        </select>
        <select className="form-input" value={filters.requesterId} onChange={field('requesterId')}>
          <option value="">{t('filter_by_requester')}</option>
          {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.full_name || employee.name_ar}</option>)}
        </select>
        <select className="form-input" value={filters.approverId} onChange={field('approverId')}>
          <option value="">{t('filter_by_approver')}</option>
          {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.full_name || employee.name_ar}</option>)}
        </select>
        <input type="date" className="form-input" value={filters.dateFrom} onChange={field('dateFrom')} title={t('filter_by_date_from')} />
        <input type="date" className="form-input" value={filters.dateTo} onChange={field('dateTo')} title={t('filter_by_date_to')} />
        <button className="primary-button" onClick={() => runSearch(filters)}><Filter /> {t('apply_filters')}</button>
        <button className="secondary-button" onClick={clear}><X /> {t('clear_filters')}</button>
      </div>

      <div className="data-table-wrap">
        <table className="enterprise-table">
          <thead>
            <tr>
              <th>{t('forms')}</th><th>{t('requested_by')}</th><th>{t('current_holder')}</th>
              <th>{t('status')}</th><th>{t('aging')}</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const hours = hoursBetween(row.created_on, row.approval_completed_on);
              return (
                <tr key={row.id}>
                  <td><b>{row.reference_no}</b> <small>{row.template_name_ar || row.template_name}</small></td>
                  <td>{row.requester_name || '—'}{row.requester_department ? <small className="cell-sub"> · {row.requester_department}</small> : null}</td>
                  <td>{row.current_assignee_name || '—'}</td>
                  <td><span className={`status-badge status-${String(row.status).toLowerCase()}`}>{t(STATUS_KEYS[row.status] || row.status)}</span></td>
                  <td>{row.created_on ? agingLabel(t, hours) : '—'}</td>
                  <td>{onViewForm && <button onClick={() => onViewForm(row.id)} title={t('view_details')}><Eye /></button>}</td>
                </tr>
              );
            })}
            {!loading && !rows.length && (
              <tr><td colSpan="6"><div className="empty-table"><ListChecks /><b>{t('no_requests_found')}</b></div></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const ReassignModal = ({ row, employees, onClose, onDone, onError }) => {
  const { t } = useLanguage();
  const { employeeName } = useArabicName();
  const closeRef = useDialogA11y(onClose);
  const [toUserId, setToUserId] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => employees.filter((employee) => employee.id !== row.assignee_id), [employees, row.assignee_id]);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await reassignApproval({ formId: row.id, toUserId, comment });
      window.dispatchEvent(new Event('bbnovix-forms-updated'));
      onDone();
    } catch (error) {
      onError(error);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form className="modal-card" role="dialog" aria-modal="true" aria-label={t('reassign_request')} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="modal-heading">
          <div><span className="section-kicker">{row.reference_no}</span><h3>{t('reassign_request')}</h3></div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}><X /></button>
        </div>
        <p className="field-note">{t('reassign_hint', { name: row.assignee_name || '—' })}</p>
        <label className="field-label">{t('select_user')}
          <select required className="form-input" value={toUserId} onChange={(event) => setToUserId(event.target.value)}>
            <option value="">{t('select_employee_placeholder')}</option>
            {options.map((employee) => (
              <option key={employee.id} value={employee.id}>{employeeName(employee)}{employee.employee_no ? ` · ${employee.employee_no}` : ''}</option>
            ))}
          </select>
        </label>
        <label className="field-label">{t('comment_optional')}
          <textarea className="form-input" value={comment} onChange={(event) => setComment(event.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('cancel')}</button>
          <button className="primary-button" disabled={busy}>{busy ? t('saving') : t('reassign')}</button>
        </div>
      </form>
    </div>
  );
};
