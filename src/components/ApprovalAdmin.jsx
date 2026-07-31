import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlarmClock, ArrowDown, ArrowUp, Check, CheckCircle2, Eye, GitPullRequestArrow, Pencil, Plus,
  RefreshCcw, Trash2, UserRoundCog, Workflow, X,
} from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import {
  assignSchemeToTemplate, loadApprovalDashboard, loadApprovalRoles, loadApprovalSchemes,
  loadRecipients, loadTemplatesWithSchemes, reassignApproval, saveApprovalRole, saveApprovalScheme,
} from '../data/approvalService';
import { approvalErrorMessage, useArabicName } from '../utils/approval';

const SLA_HOURS = 48;
const hoursSince = (value) => (value ? Math.max(0, (Date.now() - new Date(value).getTime()) / 36e5) : 0);

// ---------------------------------------------------------------------------
// Approval setup: roles, schemes (ordered role sets) and template links.
// ---------------------------------------------------------------------------
export const ApprovalSetupAdmin = () => {
  const { t } = useLanguage();
  const { roleName } = useArabicName();
  const [roles, setRoles] = useState([]);
  const [schemes, setSchemes] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [editingRole, setEditingRole] = useState(null);
  const [editingScheme, setEditingScheme] = useState(null);
  const [notice, setNotice] = useState('');

  const refresh = useCallback(() => {
    Promise.all([loadApprovalRoles(), loadApprovalSchemes(), loadTemplatesWithSchemes()])
      .then(([rolesData, schemesData, templatesData]) => {
        setRoles(rolesData);
        setSchemes(schemesData);
        setTemplates(templatesData);
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

  const saveScheme = async (draft, roleIds) => {
    try {
      await saveApprovalScheme(draft, roleIds);
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
          <button className="primary-button" onClick={() => setEditingScheme({ scheme: { is_active: true }, roleIds: [] })}><Plus /> {t('add_scheme')}</button>
        </div>
      </div>

      {notice && <div className="inline-message"><Check />{notice}<button onClick={() => setNotice('')}><X /></button></div>}

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
                  <button className="icon-button" onClick={() => setEditingScheme({ scheme, roleIds: (scheme.roles || []).map((role) => role.id) })} title={t('edit')}><Pencil /></button>
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
            <thead><tr><th>{t('forms')}</th><th>{t('code')}</th><th>{t('assign_scheme')}</th></tr></thead>
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
          initialRoleIds={editingScheme.roleIds}
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
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal-card" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); onSave(draft); }}>
        <div className="modal-heading"><h3>{draft.id ? t('edit') : t('add_role')}</h3><button type="button" className="icon-button" onClick={onClose}><X /></button></div>
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

const SchemeModal = ({ scheme, initialRoleIds, roles, onClose, onSave }) => {
  const { t } = useLanguage();
  const { roleName } = useArabicName();
  const [draft, setDraft] = useState(scheme);
  const [roleIds, setRoleIds] = useState(initialRoleIds);
  const field = (key) => (event) => setDraft({ ...draft, [key]: event.target.value });
  const available = roles.filter((role) => role.is_active !== false && !roleIds.includes(role.id));
  const move = (index, delta) => {
    const next = [...roleIds];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setRoleIds(next);
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal-card modal-wide" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); onSave(draft, roleIds); }}>
        <div className="modal-heading"><h3>{draft.id ? t('edit') : t('add_scheme')}</h3><button type="button" className="icon-button" onClick={onClose}><X /></button></div>
        <div className="form-grid">
          <label className="field-label">{t('code')}<input required className="form-input" value={draft.code || ''} onChange={field('code')} /></label>
          <label className="field-label">{t('name_arabic')}<input required className="form-input" value={draft.name_ar || ''} onChange={field('name_ar')} /></label>
          <label className="field-label">{t('name_english')}<input required className="form-input" value={draft.name_en || ''} onChange={field('name_en')} /></label>
          <label className="field-label">{t('add_role')}
            <select
              className="form-input"
              value=""
              onChange={(event) => { if (event.target.value) setRoleIds([...roleIds, event.target.value]); }}
            >
              <option value="">{t('select_approval_role')}</option>
              {available.map((role) => <option key={role.id} value={role.id}>{roleName(role)}</option>)}
            </select>
          </label>
        </div>
        <div className="scheme-role-editor">
          <b>{t('scheme_roles')}</b>
          {!roleIds.length && <p className="field-note">{t('scheme_roles_hint')}</p>}
          <ol>
            {roleIds.map((roleId, index) => {
              const role = roles.find((item) => item.id === roleId);
              return (
                <li key={roleId}>
                  <span>{index + 1}. {roleName(role) || roleId}</span>
                  <div className="table-actions">
                    <button type="button" onClick={() => move(index, -1)} title={t('move_up')}><ArrowUp /></button>
                    <button type="button" onClick={() => move(index, 1)} title={t('move_down')}><ArrowDown /></button>
                    <button type="button" className="danger" onClick={() => setRoleIds(roleIds.filter((id) => id !== roleId))} title={t('delete')}><Trash2 /></button>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('cancel')}</button>
          <button className="primary-button" disabled={!roleIds.length}>{t('save')}</button>
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

      {notice && <div className="inline-message"><CheckCircle2 />{notice}<button onClick={() => setNotice('')}><X /></button></div>}

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
                      {hours >= 24 ? t('aging_days', { count: Math.floor(hours / 24) }) : t('aging_hours', { count: Math.max(1, Math.round(hours)) })}
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

const ReassignModal = ({ row, employees, onClose, onDone, onError }) => {
  const { t } = useLanguage();
  const { employeeName } = useArabicName();
  const [toUserId, setToUserId] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => employees.filter((employee) => employee.id !== row.assignee_id), [employees, row.assignee_id]);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await reassignApproval({ formId: row.id, toUserId, comment });
      window.dispatchEvent(new Event('shalfa-forms-updated'));
      onDone();
    } catch (error) {
      onError(error);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal-card" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="modal-heading">
          <div><span className="section-kicker">{row.reference_no}</span><h3>{t('reassign_request')}</h3></div>
          <button type="button" className="icon-button" onClick={onClose}><X /></button>
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
