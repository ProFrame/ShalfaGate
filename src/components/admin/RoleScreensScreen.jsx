// Screens and services by role.
//
// The matrix is screens down the side and roles across the top, because a
// company has a handful of roles and dozens of screens. A box that is ticked
// means the role opens that screen; clearing it hides the screen from that
// role's navigation everywhere in the product, since the shell renders
// public.my_screens() rather than a hard-coded list.
//
// A role that has never been touched sits on the platform default, which is
// derived from the screen's minimum rank. The moment a box is changed the whole
// row becomes explicit, and "reset" puts the role back on the default.
//
// The platform operator role belongs to the operator workspace and is never
// listed for a company.

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Check, LayoutGrid, RotateCcw, Save, Search, ShieldAlert, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { pickLocalized } from '../../utils/localize';
import { loadRoleScreenMatrix, saveRoleScreens, tenantErrorMessage } from '../../data/tenantProfileService';

/** How the database ranks content access; used only to show the default state. */
const ROLE_RANK = {
  PLATFORM_OPERATOR: 4,
  PLATFORM_ADMIN: 4,
  SYSTEM_ADMIN: 4,
  DEPARTMENT_MANAGER: 3,
  DEPARTMENT_COORDINATOR: 2,
  EMPLOYEE: 1,
};

const AREA_LABELS = {
  Portal: 'admin_screens_area_portal',
  Admin: 'admin_screens_area_admin',
  Platform: 'admin_screens_area_platform',
};

const keyOf = (roleId, code) => `${roleId}::${code}`;

const RoleScreensScreen = () => {
  const { t, lang } = useLanguage();
  const { isPlatform } = useTenant();

  const [matrix, setMatrix] = useState({ screens: [], roles: [], assignments: [] });
  const [overrides, setOverrides] = useState({});
  const [touchedRoles, setTouchedRoles] = useState(() => new Set());
  const [dirtyRoles, setDirtyRoles] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadRoleScreenMatrix().then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data) {
        setNotice({ tone: 'error', text: tenantErrorMessage(t, error, 'admin_screens_load_failed') });
        setLoading(false);
        return;
      }
      const map = {};
      const touched = new Set();
      (data.assignments || []).forEach((row) => {
        map[keyOf(row.role_id, row.screen_code)] = row.is_enabled !== false;
        touched.add(row.role_id);
      });
      setMatrix(data);
      setOverrides(map);
      setTouchedRoles(touched);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [t]);

  const roles = useMemo(
    () => (matrix.roles || []).filter((role) => role.code !== 'PLATFORM_OPERATOR'),
    [matrix.roles],
  );

  const screens = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return (matrix.screens || [])
      .filter((screen) => isPlatform || screen.area !== 'Platform')
      .filter((screen) => !term || `${screen.code} ${screen.name_ar || ''} ${screen.name_en || ''}`
        .toLocaleLowerCase().includes(term))
      .sort((a, b) => String(a.area).localeCompare(String(b.area))
        || (a.display_order || 0) - (b.display_order || 0));
  }, [matrix.screens, query, isPlatform]);

  const groups = useMemo(() => {
    const byArea = new Map();
    screens.forEach((screen) => {
      const area = screen.area || 'Admin';
      if (!byArea.has(area)) byArea.set(area, []);
      byArea.get(area).push(screen);
    });
    return [...byArea.entries()];
  }, [screens]);

  const defaultFor = (screen, role) => (ROLE_RANK[role.code] || 1) >= (screen.min_role_rank || 1);

  const valueFor = (screen, role) => {
    const stored = overrides[keyOf(role.id, screen.code)];
    if (stored !== undefined) return stored;
    return touchedRoles.has(role.id) ? false : defaultFor(screen, role);
  };

  const toggle = (screen, role) => {
    const next = !valueFor(screen, role);
    setOverrides((current) => {
      const draft = { ...current };
      // The first change turns the whole row explicit, so nothing silently
      // depends on a default that may move later.
      if (!touchedRoles.has(role.id)) {
        (matrix.screens || []).forEach((item) => {
          draft[keyOf(role.id, item.code)] = defaultFor(item, role);
        });
      }
      draft[keyOf(role.id, screen.code)] = next;
      return draft;
    });
    setTouchedRoles((current) => new Set(current).add(role.id));
    setDirtyRoles((current) => new Set(current).add(role.id));
  };

  const setWholeRole = (role, enabled) => {
    setOverrides((current) => {
      const draft = { ...current };
      (matrix.screens || []).forEach((item) => { draft[keyOf(role.id, item.code)] = enabled; });
      return draft;
    });
    setTouchedRoles((current) => new Set(current).add(role.id));
    setDirtyRoles((current) => new Set(current).add(role.id));
  };

  const resetRole = async (role) => {
    setSaving(true);
    const { error } = await saveRoleScreens(role.id, []);
    setSaving(false);
    if (error) {
      setNotice({ tone: 'error', text: tenantErrorMessage(t, error, 'admin_screens_save_failed') });
      return;
    }
    setOverrides((current) => {
      const draft = { ...current };
      (matrix.screens || []).forEach((item) => { delete draft[keyOf(role.id, item.code)]; });
      return draft;
    });
    setTouchedRoles((current) => {
      const draft = new Set(current);
      draft.delete(role.id);
      return draft;
    });
    setDirtyRoles((current) => {
      const draft = new Set(current);
      draft.delete(role.id);
      return draft;
    });
    setNotice({ tone: 'success', text: t('admin_screens_saved') });
  };

  const save = async () => {
    if (!dirtyRoles.size) return;
    setSaving(true);
    setNotice(null);
    for (const roleId of dirtyRoles) {
      const payload = (matrix.screens || []).map((screen) => ({
        code: screen.code,
        is_enabled: overrides[keyOf(roleId, screen.code)] === true,
      }));
      // One role at a time: that is the unit the RPC replaces.
      const { error } = await saveRoleScreens(roleId, payload);
      if (error) {
        setSaving(false);
        setNotice({ tone: 'error', text: tenantErrorMessage(t, error, 'admin_screens_save_failed') });
        return;
      }
    }
    setSaving(false);
    setDirtyRoles(new Set());
    setNotice({ tone: 'success', text: t('admin_screens_saved') });
  };

  const roleLabel = (role) => pickLocalized(role, 'name', lang, role.code);

  if (loading) {
    return (
      <div className="admin-content">
        <p className="admin-loading" role="status" aria-live="polite">{t('label_loading')}</p>
      </div>
    );
  }

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('admin_screens_kicker')}</span>
          <h1>{t('admin_screens_title')}</h1>
          <p>{t('admin_screens_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="primary-button" disabled={saving || !dirtyRoles.size} onClick={save}>
            <Save /> {saving ? t('label_loading') : t('action_save')}
          </button>
        </div>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.tone === 'error' ? <X /> : <Check />}
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X /></button>
        </div>
      )}

      {Boolean(dirtyRoles.size) && (
        <p className="admin-unsaved" role="status" aria-live="polite">
          <ShieldAlert aria-hidden="true" /> {t('admin_screens_unsaved')}
        </p>
      )}

      <div className="data-controls">
        <div className="search-control">
          <Search aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('admin_search_placeholder')}
            aria-label={t('action_search')}
          />
        </div>
        <span className="result-count">{t('admin_records_count', { count: screens.length })}</span>
      </div>

      {!roles.length ? (
        <div className="empty-table">
          <LayoutGrid aria-hidden="true" />
          <b>{t('admin_screens_no_roles')}</b>
        </div>
      ) : (
        <div className="data-table-wrap admin-matrix-wrap">
          <table className="enterprise-table admin-matrix">
            <thead>
              <tr>
                <th className="admin-matrix-screen">{t('admin_screens_screen')}</th>
                {roles.map((role) => (
                  <th key={role.id} className="admin-matrix-role">
                    <span>{roleLabel(role)}</span>
                    <div className="admin-matrix-role-actions">
                      <button
                        type="button"
                        aria-label={t('admin_screens_enable_role', { role: roleLabel(role) })}
                        title={t('admin_screens_enable_role', { role: roleLabel(role) })}
                        onClick={() => setWholeRole(role, true)}
                      >
                        {t('action_select_all')}
                      </button>
                      <button
                        type="button"
                        aria-label={t('admin_screens_clear_role', { role: roleLabel(role) })}
                        title={t('admin_screens_clear_role', { role: roleLabel(role) })}
                        onClick={() => setWholeRole(role, false)}
                      >
                        {t('action_clear')}
                      </button>
                      <button
                        type="button"
                        aria-label={t('action_reset')}
                        title={t('action_reset')}
                        onClick={() => resetRole(role)}
                      >
                        <RotateCcw />
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(([area, areaScreens]) => (
                <Fragment key={area}>
                  <tr className="admin-matrix-area">
                    <th scope="colgroup" colSpan={roles.length + 1}>
                      {t(AREA_LABELS[area] || 'admin_screens_area_admin')}
                    </th>
                  </tr>
                  {areaScreens.map((screen) => (
                    <tr key={screen.code} className={screen.module_enabled === false ? 'admin-matrix-off' : ''}>
                      <th scope="row" className="admin-matrix-screen">
                        <b>{pickLocalized(screen, 'name', lang, screen.code)}</b>
                        <small>{screen.code}</small>
                        {screen.module_enabled === false && <small>{t('admin_screens_module_off')}</small>}
                      </th>
                      {roles.map((role) => (
                        <td key={role.id} className="admin-matrix-cell">
                          <input
                            type="checkbox"
                            checked={valueFor(screen, role)}
                            disabled={screen.module_enabled === false}
                            aria-label={t('admin_screens_toggle', {
                              screen: pickLocalized(screen, 'name', lang, screen.code),
                              role: roleLabel(role),
                            })}
                            onChange={() => toggle(screen, role)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default RoleScreensScreen;
