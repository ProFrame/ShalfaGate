// Assets Management — admin "Custody Units" screen (route admin/asset-custody-units,
// Assets.Manage, rank 3).
//
// A custody unit is the place/team an asset is checked out to — a store, a
// site warehouse, a project store — not a single "manager". Each unit points
// at the existing org dimension tables (site/project/department, loaded from
// their own established services, never requeried here) and carries its own
// member roster: any number of people, each tagged Owner, Custodian or
// BackupCustodian (asset_custody_unit_set_members — a full-roster replace,
// not a per-member add/remove RPC, so the roster modal below edits a local
// draft list and commits it in one call on Save).
//
// Data access only ever goes through src/data/assetsService.js — this screen
// never calls supabase directly. loadCustodyUnits() (assetsService.js)
// defaults to active-only rows (mirrors the migration's own scoping and how
// a deactivated unit disappears as an assignment target elsewhere in the
// product). The "show inactive" toggle below passes {includeInactive: true}
// so a deactivated unit can still be found here and reactivated via its own
// edit dialog — otherwise deactivating one would be a one-way door.
//
// Follows src/components/admin/OrgEntityScreen.jsx's table/dialog shape
// loosely (same CRUD-table furniture from the app-wide src/index.css), but
// this is its own component because it calls asset_custody_unit_upsert() /
// asset_custody_unit_set_members(), not OrgEntityScreen's own RPCs. Modals
// follow the exact role="dialog"/aria-modal/useDialogA11y pattern already
// reviewed in src/components/ApprovalChain.jsx.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2, Check, Pencil, Plus, Search, UserPlus, Users, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { pickLocalized } from '../../utils/localize';
import { useDialogA11y } from '../../utils/useDialogA11y';
import { useArabicName } from '../../utils/approval';
import {
  CUSTODY_ROLE_CODES, assetsErrorMessage, loadCustodyUnitMembers, loadCustodyUnits,
  saveCustodyUnit, setCustodyUnitMembers,
} from '../../data/assetsService';
import { loadOrgDimensions } from '../../data/orgDimensionsService';
import { loadOrganizationLookups } from '../../data/organizationService';
import { loadRecipients } from '../../data/approvalService';
import './assets.css';

const ROLE_LABEL_KEYS = {
  Owner: 'assets_role_owner',
  Custodian: 'assets_role_custodian',
  BackupCustodian: 'assets_role_backup_custodian',
};

const emptyDraft = () => ({
  code: '', name_ar: '', name_en: '', project_id: '', site_id: '', department_id: '',
  notes: '', is_active: true,
});

// ---------------------------------------------------------------------------
// Create / edit dialog
// ---------------------------------------------------------------------------

const CustodyUnitDialog = ({ draft, projects, sites, departments, busy, error, onChange, onClose, onSubmit }) => {
  const { t, lang } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const set = (key) => (event) => onChange({ ...draft, [key]: event.target.value });

  // A unit's site should belong to its project — the site list narrows to the
  // chosen project (same relation shape OrgEntityScreen's sites->projects
  // descriptor already uses), and picking a different project clears a site
  // choice that no longer belongs to it.
  const siteOptions = draft.project_id ? sites.filter((site) => site.project_id === draft.project_id) : sites;

  const changeProject = (event) => {
    const projectId = event.target.value || null;
    // Must check against the NEW project, not siteOptions (still filtered by
    // the OLD draft.project_id at this point) — checking the old list made
    // this almost always true and the site was never actually cleared.
    const siteStillValid = !projectId || sites.some(
      (site) => site.id === draft.site_id && site.project_id === projectId,
    );
    onChange({ ...draft, project_id: projectId, site_id: siteStillValid ? draft.site_id : '' });
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? t('action_edit') : t('assets_custody_units_add')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('assets_module_kicker')}</span>
            <h3>{draft.id ? t('action_edit') : t('assets_custody_units_add')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="form-grid">
          <label className="field-label">
            {t('label_code')}
            <input
              required
              className="form-input assets-code-input"
              value={draft.code || ''}
              onChange={(event) => onChange({ ...draft, code: event.target.value.toUpperCase() })}
            />
          </label>
          <label className="field-label">
            {t('label_name_1')}
            <input required className="form-input" value={draft.name_ar || ''} onChange={set('name_ar')} />
          </label>

          <label className="field-label">
            {t('label_name_2')}
            <input className="form-input" value={draft.name_en || ''} onChange={set('name_en')} />
          </label>
          <label className="field-label">
            {t('label_department')}
            <select
              className="form-input"
              value={draft.department_id || ''}
              onChange={(event) => onChange({ ...draft, department_id: event.target.value || null })}
            >
              <option value="">{t('admin_not_assigned')}</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.code} · {pickLocalized(department, 'name', lang)}
                </option>
              ))}
            </select>
          </label>

          <label className="field-label">
            {t('label_project')}
            <select className="form-input" value={draft.project_id || ''} onChange={changeProject}>
              <option value="">{t('admin_not_assigned')}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.code} · {pickLocalized(project, 'name', lang)}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            {t('label_site')}
            <select
              className="form-input"
              value={draft.site_id || ''}
              onChange={(event) => onChange({ ...draft, site_id: event.target.value || null })}
            >
              <option value="">{t('admin_not_assigned')}</option>
              {siteOptions.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.code} · {pickLocalized(site, 'name', lang)}
                </option>
              ))}
            </select>
          </label>

          <label className="field-label field-span-2">
            {t('label_notes')}
            <textarea className="form-input" value={draft.notes || ''} onChange={set('notes')} />
          </label>
        </div>

        <label className="content-publish-check">
          <input
            type="checkbox"
            checked={draft.is_active !== false}
            onChange={(event) => onChange({ ...draft, is_active: event.target.checked })}
          />
          {t('label_active')}
        </label>
        <p className="field-note">{t('assets_custody_unit_active_hint')}</p>

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
// Member roster modal — asset_custody_unit_set_members() replaces the whole
// roster in one call, so add/remove edit a local list and Save commits it.
// ---------------------------------------------------------------------------

const CustodyRosterModal = ({ unit, employees, onClose, onSaved }) => {
  const { t } = useLanguage();
  const { employeeName } = useArabicName();
  const closeRef = useDialogA11y(onClose);

  const [members, setMembers] = useState(null); // null while the current roster is still loading
  const [pickUserId, setPickUserId] = useState('');
  const [pickRole, setPickRole] = useState(CUSTODY_ROLE_CODES[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadCustodyUnitMembers(unit.id).then(({ data, error: loadError }) => {
      if (cancelled) return;
      if (loadError) { setError(assetsErrorMessage(t, loadError)); setMembers([]); return; }
      setMembers((data || []).map((row) => ({ userId: row.user_id, roleCode: row.role_code })));
    });
    return () => { cancelled = true; };
  }, [unit.id, t]);

  const memberIds = useMemo(() => new Set((members || []).map((member) => member.userId)), [members]);
  const available = employees.filter((employee) => !memberIds.has(employee.id));

  const addMember = () => {
    if (!pickUserId) return;
    setMembers((current) => [...(current || []), { userId: pickUserId, roleCode: pickRole }]);
    setPickUserId('');
  };

  const removeMember = (userId) => {
    setMembers((current) => (current || []).filter((member) => member.userId !== userId));
  };

  const employeeLabel = (userId) => {
    const employee = employees.find((item) => item.id === userId);
    return employee ? employeeName(employee) : userId;
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { error: saveError } = await setCustodyUnitMembers(
      unit.id,
      (members || []).map((member) => ({ userId: member.userId, roleCode: member.roleCode })),
    );
    setBusy(false);
    if (saveError) { setError(assetsErrorMessage(t, saveError)); return; }
    onSaved();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('assets_custody_roster_title')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{unit.code}</span>
            <h3>{t('assets_custody_roster_title')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <p className="field-note">{t('assets_custody_roster_hint')}</p>

        {members === null ? (
          <p className="assets-loading">{t('label_loading')}</p>
        ) : (
          <ul className="custody-roster-list">
            {members.map((member) => (
              <li key={member.userId} className="custody-roster-row">
                <span className="custody-roster-name">{employeeLabel(member.userId)}</span>
                <span className="role-badge">{t(ROLE_LABEL_KEYS[member.roleCode] || member.roleCode)}</span>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => removeMember(member.userId)}
                  aria-label={t('assets_remove_member', { name: employeeLabel(member.userId) })}
                >
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
            {!members.length && <li className="field-note">{t('assets_custody_roster_empty')}</li>}
          </ul>
        )}

        <div className="custody-roster-add">
          <select
            className="form-input"
            value={pickUserId}
            disabled={members === null}
            onChange={(event) => setPickUserId(event.target.value)}
            aria-label={t('select_employee_placeholder')}
          >
            <option value="">{t('select_employee_placeholder')}</option>
            {available.map((employee) => (
              <option key={employee.id} value={employee.id}>{employeeName(employee)}</option>
            ))}
          </select>

          <div className="segmented" role="group" aria-label={t('label_role')}>
            {CUSTODY_ROLE_CODES.map((code) => (
              <button
                type="button"
                key={code}
                aria-pressed={pickRole === code}
                className={pickRole === code ? 'active' : ''}
                onClick={() => setPickRole(code)}
              >
                {t(ROLE_LABEL_KEYS[code])}
              </button>
            ))}
          </div>

          <button type="button" className="secondary-button" disabled={!pickUserId || members === null} onClick={addMember}>
            <UserPlus aria-hidden="true" /> {t('assets_custody_roster_add')}
          </button>
        </div>

        {error && <div className="modal-error"><X aria-hidden="true" />{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button className="primary-button" disabled={busy || members === null}>
            {busy ? t('label_loading') : t('action_save')}
          </button>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const AssetCustodyUnitsAdmin = () => {
  const { t, lang } = useLanguage();

  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [notice, setNotice] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [projects, setProjects] = useState([]);
  const [sites, setSites] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);

  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rosterUnit, setRosterUnit] = useState(null);

  // `loading` already starts true (useState(true) above), so the initial
  // fetch needs no extra setState here; refresh() and the includeInactive
  // toggle (its own onChange sets loading itself) are the only other
  // triggers — the effect body only ever calls setState from its async
  // .then(), the same shape AttachmentsPanel.jsx's own load effect documents.
  const refresh = useCallback(() => {
    setLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadCustodyUnits({ includeInactive }).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setUnits([]);
        setNotice({ tone: 'error', text: assetsErrorMessage(t, error) });
      } else {
        setUnits(data || []);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [reloadToken, includeInactive, t]);

  // Dropdown sources — each loaded through its own already-established
  // service, never requeried here, and each degrades to an empty list on
  // failure rather than blocking the screen (same reasoning
  // orgDimensionsService.js's own loadOrgDimensions() already documents).
  useEffect(() => {
    let cancelled = false;
    loadOrgDimensions().then(({ data }) => {
      if (cancelled || !data) return;
      setProjects(data.projects || []);
      setSites(data.sites || []);
    });
    loadOrganizationLookups()
      .then((lookups) => { if (!cancelled) setDepartments(lookups?.departments || []); })
      .catch(() => { if (!cancelled) setDepartments([]); });
    loadRecipients()
      .then((list) => { if (!cancelled) setEmployees(list || []); })
      .catch(() => { if (!cancelled) setEmployees([]); });
    return () => { cancelled = true; };
  }, []);

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const siteById = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);
  const departmentById = useMemo(() => new Map(departments.map((department) => [department.id, department])), [departments]);

  const filteredUnits = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return units;
    return units.filter((unit) => `${unit.code || ''} ${unit.name_ar || ''} ${unit.name_en || ''}`
      .toLocaleLowerCase().includes(term));
  }, [units, search]);

  const openCreate = () => { setDraftError(''); setDraft(emptyDraft()); };
  const openEdit = (unit) => { setDraftError(''); setDraft({ ...unit }); };

  const saveDraft = async () => {
    setBusy(true);
    setDraftError('');
    const { error } = await saveCustodyUnit(draft);
    setBusy(false);
    if (error) {
      setDraftError(assetsErrorMessage(t, error));
      return;
    }
    setDraft(null);
    setNotice({ tone: 'success', text: t('assets_custody_unit_saved') });
    refresh();
  };

  // Deactivating drops the unit out of the default active-only scope, so
  // refreshing here is the honest reflection of what just happened — the
  // "show inactive" toggle is what keeps it reachable afterwards. Matches
  // OrgEntityScreen's own toggleActive(), which likewise only surfaces a
  // notice on failure, not on success.
  const toggleActive = async (unit) => {
    const { error } = await saveCustodyUnit({ ...unit, is_active: !unit.is_active });
    if (error) setNotice({ tone: 'error', text: assetsErrorMessage(t, error) });
    else refresh();
  };

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('assets_module_kicker')}</span>
          <h1><Building2 className="admin-title-icon" aria-hidden="true" /> {t('assets_custody_units_title')}</h1>
          <p>{t('assets_custody_units_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="primary-button" onClick={openCreate}>
            <Plus aria-hidden="true" /> {t('assets_custody_units_add')}
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
        <label className="admin-inline-check">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(event) => { setIncludeInactive(event.target.checked); setLoading(true); }}
          />
          {t('assets_custody_units_show_inactive')}
        </label>
        <span className="result-count">{t('admin_records_count', { count: filteredUnits.length })}</span>
      </div>

      <div className="data-table-wrap">
        <table className="enterprise-table">
          <thead>
            <tr>
              <th>{t('label_code')}</th>
              <th>{t('label_name_1')}</th>
              <th>{t('label_name_2')}</th>
              <th>{t('label_project')}</th>
              <th>{t('label_site')}</th>
              <th>{t('label_department')}</th>
              <th>{t('label_status')}</th>
              <th aria-label={t('label_actions')} />
            </tr>
          </thead>
          <tbody>
            {filteredUnits.map((unit) => (
              <tr key={unit.id}>
                <td>
                  <code>{unit.code}</code>
                  {!unit.is_active && (
                    <span className="status-badge status-closed">{t('assets_custody_units_inactive_badge')}</span>
                  )}
                </td>
                <td><b>{unit.name_ar}</b></td>
                <td>{unit.name_en || '—'}</td>
                <td>{pickLocalized(projectById.get(unit.project_id), 'name', lang) || '—'}</td>
                <td>{pickLocalized(siteById.get(unit.site_id), 'name', lang) || '—'}</td>
                <td>{pickLocalized(departmentById.get(unit.department_id), 'name', lang) || '—'}</td>
                <td>
                  <button
                    type="button"
                    className={`toggle ${unit.is_active ? 'active' : ''}`}
                    aria-label={t('admin_toggle_active')}
                    aria-pressed={Boolean(unit.is_active)}
                    onClick={() => toggleActive(unit)}
                  >
                    <span />
                  </button>
                  <small>{t(unit.is_active ? 'label_active' : 'label_inactive')}</small>
                </td>
                <td>
                  <div className="table-actions">
                    <button
                      type="button"
                      title={t('admin_edit_record')}
                      aria-label={t('admin_edit_record')}
                      onClick={() => openEdit(unit)}
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      title={t('assets_manage_members')}
                      aria-label={t('assets_manage_members')}
                      onClick={() => setRosterUnit(unit)}
                    >
                      <Users aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && !filteredUnits.length && (
              <tr>
                <td colSpan={8}>
                  <div className="empty-table">
                    <Building2 aria-hidden="true" />
                    <b>{t('label_no_results')}</b>
                  </div>
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={8}>{t('label_loading')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {draft && (
        <CustodyUnitDialog
          draft={draft}
          projects={projects}
          sites={sites}
          departments={departments}
          busy={busy}
          error={draftError}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSubmit={saveDraft}
        />
      )}

      {rosterUnit && (
        <CustodyRosterModal
          unit={rosterUnit}
          employees={employees}
          onClose={() => setRosterUnit(null)}
          onSaved={() => {
            setRosterUnit(null);
            setNotice({ tone: 'success', text: t('assets_custody_roster_saved') });
          }}
        />
      )}
    </div>
  );
};

export default AssetCustodyUnitsAdmin;