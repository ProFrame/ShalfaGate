/* eslint-disable react-refresh/only-export-components */
// One CRUD screen for every organisation dimension.
//
// Departments, positions, sectors, projects, sites and countries are the same
// record with different words on it: a code, a first name, a second name, two
// descriptions, a display order and an active switch. Rather than six screens
// that drift apart, there is one screen driven by a descriptor — the table it
// writes to, the wording it uses, the extra columns it shows and the extra
// fields it edits.
//
// The two name columns are labelled "first name" and "second name" everywhere.
// Nothing in this product calls a column "the Arabic name": a company may run
// in any pair of languages.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BriefcaseBusiness, Building2, Check, Download, Globe, Layers, LayoutGrid, MapPin,
  Pencil, Plus, Search, Trash2, X,
} from 'lucide-react';
import writeXlsxFile from 'write-excel-file/browser';
import { useLanguage } from '../../context/LanguageContext';
import { pickLocalized } from '../../utils/localize';
import {
  deleteOrgEntity, listOrgEntities, orgErrorMessage, saveOrgEntity,
} from '../../data/orgDimensionsService';

const PAGE_SIZE = 20;

/**
 * The descriptors. `columns` are extra table columns, `fields` are extra form
 * fields, `relation` is the parent record the row may point at.
 */
export const ORG_SCREENS = {
  departments: {
    entity: 'departments',
    icon: Building2,
    titleKey: 'admin_entity_departments_title',
    introKey: 'admin_entity_departments_intro',
    addKey: 'admin_entity_departments_add',
  },
  positions: {
    entity: 'positions',
    icon: BriefcaseBusiness,
    titleKey: 'admin_entity_positions_title',
    introKey: 'admin_entity_positions_intro',
    addKey: 'admin_entity_positions_add',
    relation: { key: 'department_id', entity: 'departments', embed: 'departments', labelKey: 'admin_linked_department' },
  },
  sectors: {
    entity: 'sectors',
    icon: Layers,
    titleKey: 'admin_entity_sectors_title',
    introKey: 'admin_entity_sectors_intro',
    addKey: 'admin_entity_sectors_add',
  },
  projects: {
    entity: 'projects',
    icon: LayoutGrid,
    titleKey: 'admin_entity_projects_title',
    introKey: 'admin_entity_projects_intro',
    addKey: 'admin_entity_projects_add',
  },
  sites: {
    entity: 'sites',
    icon: MapPin,
    titleKey: 'admin_entity_sites_title',
    introKey: 'admin_entity_sites_intro',
    addKey: 'admin_entity_sites_add',
    relation: { key: 'project_id', entity: 'projects', embed: 'projects', labelKey: 'admin_linked_project' },
  },
  countries: {
    entity: 'countries',
    icon: Globe,
    titleKey: 'admin_entity_countries_title',
    introKey: 'admin_entity_countries_intro',
    addKey: 'admin_entity_countries_add',
    columns: [
      { key: 'iso_code', labelKey: 'admin_iso_code' },
      { key: 'dial_code', labelKey: 'admin_dial_code' },
      { key: 'nationality', labelKey: 'label_nationality', localized: true },
    ],
    fields: [
      { key: 'iso_code', labelKey: 'admin_iso_code', maxLength: 2, uppercase: true },
      { key: 'dial_code', labelKey: 'admin_dial_code' },
      { key: 'nationality_ar', labelKey: 'admin_nationality_1' },
      { key: 'nationality_en', labelKey: 'admin_nationality_2' },
    ],
  },
};

const emptyDraft = () => ({
  code: '', name_ar: '', name_en: '', description_ar: '', description_en: '',
  display_order: 0, is_active: true,
});

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

const EntityDialog = ({ descriptor, draft, options, busy, error, onChange, onClose, onSubmit }) => {
  const { t, lang } = useLanguage();
  const relation = descriptor.relation;
  const set = (key) => (event) => onChange({ ...draft, [key]: event.target.value });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal-card modal-wide"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('admin_org_kicker')}</span>
            <h3>{draft.id ? t('action_edit') : t(descriptor.addKey)}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X />
          </button>
        </div>

        <div className="form-grid">
          <label className="field-label">
            {t('label_code')}
            <input
              required
              className="form-input admin-code-input"
              value={draft.code || ''}
              onChange={(event) => onChange({ ...draft, code: event.target.value.toUpperCase() })}
            />
          </label>
          <label className="field-label">
            {t('label_display_order')}
            <input type="number" className="form-input" value={draft.display_order ?? 0} onChange={set('display_order')} />
          </label>

          <label className="field-label">
            {t('label_name_1')}
            <input required className="form-input" value={draft.name_ar || ''} onChange={set('name_ar')} />
          </label>
          <label className="field-label">
            {t('label_name_2')}
            <input className="form-input" value={draft.name_en || ''} onChange={set('name_en')} />
          </label>

          {(descriptor.fields || []).map((field) => (
            <label className="field-label" key={field.key}>
              {t(field.labelKey)}
              <input
                className="form-input"
                maxLength={field.maxLength}
                value={draft[field.key] || ''}
                onChange={(event) => onChange({
                  ...draft,
                  [field.key]: field.uppercase ? event.target.value.toUpperCase() : event.target.value,
                })}
              />
            </label>
          ))}

          {relation && (
            <label className="field-label">
              {t(relation.labelKey)}
              <select
                className="form-input"
                value={draft[relation.key] || ''}
                onChange={(event) => onChange({ ...draft, [relation.key]: event.target.value || null })}
              >
                <option value="">{t('admin_not_assigned')}</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.code} · {pickLocalized(option, 'name', lang)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="field-label field-span-2">
            {t('label_description_1')}
            <textarea className="form-input" value={draft.description_ar || ''} onChange={set('description_ar')} />
          </label>
          <label className="field-label field-span-2">
            {t('label_description_2')}
            <textarea className="form-input" value={draft.description_en || ''} onChange={set('description_en')} />
          </label>
        </div>

        <p className="field-note">{t('admin_name_pair_hint')}</p>

        <label className="content-publish-check">
          <input
            type="checkbox"
            checked={draft.is_active !== false}
            onChange={(event) => onChange({ ...draft, is_active: event.target.checked })}
          />
          {t('label_active')}
        </label>

        {error && <div className="modal-error"><X />{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button className="primary-button" disabled={busy}>{busy ? t('label_loading') : t('action_save')}</button>
        </div>
      </form>
    </div>
  );
};

const ConfirmDialog = ({ message, busy, onCancel, onConfirm }) => {
  const { t } = useLanguage();
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card" role="alertdialog" aria-label={message} onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <h3>{t('action_delete')}</h3>
          <button type="button" className="icon-button" onClick={onCancel} aria-label={t('action_close')}><X /></button>
        </div>
        <p className="admin-confirm-text">{message}</p>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>{t('action_cancel')}</button>
          <button type="button" className="primary-button admin-danger-button" disabled={busy} onClick={onConfirm}>
            <Trash2 /> {t('action_confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const OrgEntityScreen = ({ kind }) => {
  const descriptor = ORG_SCREENS[kind];
  const { t, lang } = useLanguage();

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [options, setOptions] = useState([]);
  const [reloadToken, setReloadToken] = useState(0);

  const relation = descriptor?.relation;
  const entity = descriptor?.entity;

  // Anything that changes the list — a filter, a page, a save — bumps the token
  // and the one effect below fetches again.
  const refresh = useCallback(() => {
    setLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (!entity) return undefined;
    let cancelled = false;
    listOrgEntities(entity, { search, includeInactive, page, pageSize: PAGE_SIZE })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setRows([]);
          setTotal(0);
          setNotice({ tone: 'error', text: orgErrorMessage(t, error, 'admin_load_failed') });
        } else {
          setRows(data.rows);
          setTotal(data.total);
        }
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [entity, search, includeInactive, page, reloadToken, t]);

  useEffect(() => {
    if (!relation) return undefined;
    let cancelled = false;
    listOrgEntities(relation.entity, { includeInactive: false, page: 1, pageSize: 500 })
      .then(({ data }) => { if (!cancelled && data) setOptions(data.rows); });
    return () => { cancelled = true; };
  }, [relation]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const save = async () => {
    setBusy(true);
    setDraftError('');
    const { error } = await saveOrgEntity(descriptor.entity, draft);
    setBusy(false);
    if (error) {
      setDraftError(orgErrorMessage(t, error, 'admin_save_failed'));
      return;
    }
    setDraft(null);
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refresh();
  };

  const toggleActive = async (row) => {
    const { error } = await saveOrgEntity(descriptor.entity, { ...row, is_active: !row.is_active });
    if (error) setNotice({ tone: 'error', text: orgErrorMessage(t, error, 'admin_save_failed') });
    else refresh();
  };

  const confirmDelete = async () => {
    setBusy(true);
    const { error } = await deleteOrgEntity(descriptor.entity, pendingDelete.id);
    setBusy(false);
    setPendingDelete(null);
    if (error) setNotice({ tone: 'error', text: orgErrorMessage(t, error, 'admin_delete_failed') });
    else {
      setNotice({ tone: 'success', text: t('admin_delete_done') });
      refresh();
    }
  };

  const exportRows = async () => {
    const { data, error } = await listOrgEntities(descriptor.entity, {
      search, includeInactive, page: 1, pageSize: 1000,
    });
    if (error || !data) {
      setNotice({ tone: 'error', text: t('admin_export_failed') });
      return;
    }
    const columns = [
      { header: t('label_code'), type: String, cell: (row) => row.code || '' },
      { header: t('label_name_1'), type: String, cell: (row) => row.name_ar || '' },
      { header: t('label_name_2'), type: String, cell: (row) => row.name_en || '' },
      ...(descriptor.columns || []).map((column) => ({
        header: t(column.labelKey),
        type: String,
        cell: (row) => (column.localized ? pickLocalized(row, column.key, lang) : row[column.key] || ''),
      })),
      ...(relation ? [{
        header: t(relation.labelKey),
        type: String,
        cell: (row) => pickLocalized(row[relation.embed], 'name', lang),
      }] : []),
      { header: t('label_description_1'), type: String, cell: (row) => row.description_ar || '' },
      { header: t('label_description_2'), type: String, cell: (row) => row.description_en || '' },
      { header: t('label_display_order'), type: Number, cell: (row) => Number(row.display_order || 0) },
      { header: t('label_status'), type: String, cell: (row) => t(row.is_active === false ? 'label_inactive' : 'label_active') },
    ];
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      await writeXlsxFile(data.rows, { columns }).toFile(`${descriptor.entity}-${stamp}.xlsx`);
      setNotice({ tone: 'success', text: t('admin_export_done', { count: data.rows.length }) });
    } catch {
      setNotice({ tone: 'error', text: t('admin_export_failed') });
    }
  };

  const headerColumns = useMemo(() => descriptor?.columns || [], [descriptor]);

  if (!descriptor) return null;
  const ScreenIcon = descriptor.icon;

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('admin_org_kicker')}</span>
          <h1><ScreenIcon className="admin-title-icon" aria-hidden="true" /> {t(descriptor.titleKey)}</h1>
          <p>{t(descriptor.introKey)}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="secondary-button" onClick={exportRows}>
            <Download /> {t('action_download')}
          </button>
          <button type="button" className="primary-button" onClick={() => { setDraftError(''); setDraft(emptyDraft()); }}>
            <Plus /> {t(descriptor.addKey)}
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

      <div className="data-controls">
        <div className="search-control">
          <Search aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1); setLoading(true); }}
            placeholder={t('admin_search_placeholder')}
            aria-label={t('action_search')}
          />
        </div>
        <label className="admin-inline-check">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(event) => { setIncludeInactive(event.target.checked); setPage(1); setLoading(true); }}
          />
          {t('admin_show_inactive')}
        </label>
        <span className="result-count">{t('admin_records_count', { count: total })}</span>
      </div>

      <div className="data-table-wrap">
        <table className="enterprise-table">
          <thead>
            <tr>
              <th>{t('label_code')}</th>
              <th>{t('label_name_1')}</th>
              <th>{t('label_name_2')}</th>
              {headerColumns.map((column) => <th key={column.key}>{t(column.labelKey)}</th>)}
              {relation && <th>{t(relation.labelKey)}</th>}
              <th>{t('label_display_order')}</th>
              <th>{t('label_status')}</th>
              <th aria-label={t('label_actions')} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td><code>{row.code}</code></td>
                <td><b>{row.name_ar}</b></td>
                <td>{row.name_en || '—'}</td>
                {headerColumns.map((column) => (
                  <td key={column.key}>
                    {(column.localized ? pickLocalized(row, column.key, lang) : row[column.key]) || '—'}
                  </td>
                ))}
                {relation && <td>{pickLocalized(row[relation.embed], 'name', lang) || '—'}</td>}
                <td>{row.display_order ?? 0}</td>
                <td>
                  <button
                    type="button"
                    className={`toggle ${row.is_active ? 'active' : ''}`}
                    aria-label={t('admin_toggle_active')}
                    aria-pressed={Boolean(row.is_active)}
                    onClick={() => toggleActive(row)}
                  >
                    <span />
                  </button>
                  <small>{t(row.is_active ? 'label_active' : 'label_inactive')}</small>
                </td>
                <td>
                  <div className="table-actions">
                    <button
                      type="button"
                      title={t('admin_edit_record')}
                      aria-label={t('admin_edit_record')}
                      onClick={() => { setDraftError(''); setDraft({ ...row }); }}
                    >
                      <Pencil />
                    </button>
                    <button
                      type="button"
                      className="danger"
                      title={t('admin_delete_record')}
                      aria-label={t('admin_delete_record')}
                      onClick={() => setPendingDelete(row)}
                    >
                      <Trash2 />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && !rows.length && (
              <tr>
                <td colSpan={6 + headerColumns.length + (relation ? 1 : 0)}>
                  <div className="empty-table">
                    <ScreenIcon aria-hidden="true" />
                    <b>{t('label_no_results')}</b>
                  </div>
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={6 + headerColumns.length + (relation ? 1 : 0)}>{t('label_loading')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="pagination">
          <button type="button" disabled={page <= 1} onClick={() => { setLoading(true); setPage((value) => Math.max(1, value - 1)); }}>
            {t('action_previous')}
          </button>
          <span className="active">{t('admin_page_indicator', { page, pages })}</span>
          <button type="button" disabled={page >= pages} onClick={() => { setLoading(true); setPage((value) => Math.min(pages, value + 1)); }}>
            {t('action_next')}
          </button>
        </div>
      )}

      {draft && (
        <EntityDialog
          descriptor={descriptor}
          draft={draft}
          options={options}
          busy={busy}
          error={draftError}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSubmit={save}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          busy={busy}
          message={t('admin_confirm_delete', { name: pickLocalized(pendingDelete, 'name', lang) })}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
};

export default OrgEntityScreen;
