// Asset Groups — admin CRUD screen for the Assets Management module.
//
// A thin category tag every asset belongs to (IT Equipment, Vehicles, Office
// Furniture, ...), used to filter/group the Assets Catalogue and the asset
// reports. Same bilingual code / name / description / display-order / active
// shape as every lookup table OrgEntityScreen.jsx already renders — but this
// entity is not one of ORG_SCREENS (it is not an organisation dimension, and
// it writes through its own RPC, asset_group_upsert(), via
// assetsService.saveAssetGroup() rather than orgDimensionsService.js), so it
// gets its own small screen that closely mirrors OrgEntityScreen's table /
// modal / toggle conventions instead of joining that descriptor map.
//
// loadAssetGroups() defaults to active-only but accepts { includeInactive }
// (same shape OrgEntityScreen's listOrgEntities() already uses), so this
// screen has its own "show inactive" checkbox wired to that flag —
// deactivating a group no longer strands it: switch the filter on, find it
// muted in the list, and reopen its edit dialog to flip Active back on.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Boxes, Check, Download, Pencil, Plus, Search, X,
} from 'lucide-react';
import writeXlsxFile from 'write-excel-file/browser';
import { useLanguage } from '../../context/LanguageContext';
import { useDialogA11y } from '../../utils/useDialogA11y';
import { assetsErrorMessage, loadAssetGroups, saveAssetGroup } from '../../data/assetsService';
import './assets.css';

const emptyDraft = () => ({
  id: null,
  code: '',
  name_ar: '',
  name_en: '',
  description_ar: '',
  description_en: '',
  display_order: 0,
  is_active: true,
});

const toDraft = (row) => ({
  id: row.id,
  code: row.code || '',
  name_ar: row.name_ar || '',
  name_en: row.name_en || '',
  description_ar: row.description_ar || '',
  description_en: row.description_en || '',
  display_order: row.display_order ?? 0,
  is_active: row.is_active !== false,
});

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

const AssetGroupDialog = ({ draft, busy, error, onChange, onClose, onSubmit }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const set = (key) => (event) => onChange({ ...draft, [key]: event.target.value });

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? t('action_edit') : t('asset_groups_add')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('assets_module_kicker')}</span>
            <h3>{draft.id ? t('action_edit') : t('asset_groups_add')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="form-grid">
          <label className="field-label">
            {t('label_code')}
            <input
              className="form-input admin-code-input"
              value={draft.code || ''}
              onChange={(event) => onChange({ ...draft, code: event.target.value.toUpperCase() })}
            />
          </label>
          <label className="field-label">
            {t('label_display_order')}
            <input
              type="number"
              className="form-input assets-order-input"
              value={draft.display_order ?? 0}
              onChange={set('display_order')}
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
// Screen
// ---------------------------------------------------------------------------

const AssetGroupsAdmin = () => {
  const { t } = useLanguage();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [notice, setNotice] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // Any save/toggle bumps the token; the one effect below fetches again —
  // same shape as OrgEntityScreen.jsx's own refresh().
  const refresh = useCallback(() => {
    setLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadAssetGroups({ includeInactive }).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setRows([]);
        setNotice({ tone: 'error', text: assetsErrorMessage(t, error) || t('admin_load_failed') });
      } else {
        setRows(data || []);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [reloadToken, includeInactive, t]);

  // loadAssetGroups() takes no filter/search/pagination arguments (unlike
  // orgDimensionsService.js's listOrgEntities()), so search is applied here
  // over the already-fetched active set rather than invented as a service
  // parameter that does not exist.
  const filteredRows = useMemo(() => {
    const sorted = [...rows].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    const needle = search.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter((row) => `${row.code || ''} ${row.name_ar || ''} ${row.name_en || ''}`.toLowerCase().includes(needle));
  }, [rows, search]);

  const openCreate = () => { setDraftError(''); setDraft(emptyDraft()); };
  const openEdit = (row) => { setDraftError(''); setDraft(toDraft(row)); };

  const save = async () => {
    setBusy(true);
    setDraftError('');
    const { error } = await saveAssetGroup(draft);
    setBusy(false);
    if (error) {
      setDraftError(assetsErrorMessage(t, error));
      return;
    }
    setDraft(null);
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refresh();
  };

  // Switching a group off still drops it out of the default (active-only)
  // view on the next refresh, but it stays reachable with "show inactive" on.
  const toggleActive = async (row) => {
    const { error } = await saveAssetGroup({ ...row, is_active: !row.is_active });
    if (error) {
      setNotice({ tone: 'error', text: assetsErrorMessage(t, error) });
      return;
    }
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refresh();
  };

  const exportRows = async () => {
    if (!filteredRows.length) return;
    const columns = [
      { header: t('label_code'), type: String, cell: (row) => row.code || '' },
      { header: t('label_name_1'), type: String, cell: (row) => row.name_ar || '' },
      { header: t('label_name_2'), type: String, cell: (row) => row.name_en || '' },
      { header: t('label_description_1'), type: String, cell: (row) => row.description_ar || '' },
      { header: t('label_description_2'), type: String, cell: (row) => row.description_en || '' },
      { header: t('label_display_order'), type: Number, cell: (row) => Number(row.display_order || 0) },
      { header: t('label_status'), type: String, cell: (row) => t(row.is_active === false ? 'label_inactive' : 'label_active') },
    ];
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      await writeXlsxFile(filteredRows, { columns }).toFile(`asset-groups-${stamp}.xlsx`);
      setNotice({ tone: 'success', text: t('admin_export_done', { count: filteredRows.length }) });
    } catch {
      setNotice({ tone: 'error', text: t('admin_export_failed') });
    }
  };

  return (
    <div className="admin-content assets-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('assets_module_kicker')}</span>
          <h1><Boxes className="admin-title-icon" aria-hidden="true" /> {t('asset_groups_title')}</h1>
          <p>{t('asset_groups_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="secondary-button" onClick={exportRows}>
            <Download aria-hidden="true" /> {t('action_download')}
          </button>
          <button type="button" className="primary-button" onClick={openCreate}>
            <Plus aria-hidden="true" /> {t('asset_groups_add')}
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
          {t('admin_show_inactive')}
        </label>
        <span className="result-count">{t('admin_records_count', { count: filteredRows.length })}</span>
      </div>

      <div className="data-table-wrap">
        <table className="enterprise-table">
          <thead>
            <tr>
              <th>{t('label_code')}</th>
              <th>{t('label_name_1')}</th>
              <th>{t('label_name_2')}</th>
              <th>{t('label_display_order')}</th>
              <th>{t('label_status')}</th>
              <th aria-label={t('label_actions')} />
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.id} style={row.is_active === false ? { opacity: 0.6 } : undefined}>
                <td><code>{row.code || '—'}</code></td>
                <td>
                  <b>{row.name_ar}</b>
                  {row.is_active === false && <span className="aging-badge">{t('label_inactive')}</span>}
                </td>
                <td>{row.name_en || '—'}</td>
                <td>{row.display_order ?? 0}</td>
                <td>
                  <button
                    type="button"
                    className={`toggle ${row.is_active !== false ? 'active' : ''}`}
                    aria-label={t('admin_toggle_active')}
                    aria-pressed={row.is_active !== false}
                    onClick={() => toggleActive(row)}
                  >
                    <span />
                  </button>
                  <small>{t(row.is_active !== false ? 'label_active' : 'label_inactive')}</small>
                </td>
                <td>
                  <div className="table-actions">
                    <button
                      type="button"
                      title={t('admin_edit_record')}
                      aria-label={t('admin_edit_record')}
                      onClick={() => openEdit(row)}
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && !filteredRows.length && (
              <tr>
                <td colSpan={6}>
                  <div className="empty-table">
                    <Boxes aria-hidden="true" />
                    <b>{t('label_no_results')}</b>
                  </div>
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={6}>{t('label_loading')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {draft && (
        <AssetGroupDialog
          draft={draft}
          busy={busy}
          error={draftError}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSubmit={save}
        />
      )}
    </div>
  );
};

export default AssetGroupsAdmin;
