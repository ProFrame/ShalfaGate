// Safety Management — PPE Types catalogue (admin/safety-ppe-types,
// Safety.Manage, ADMIN_SAFETY_PPE_TYPES).
//
// A flat lookup table (helmet, gloves, boots, safety vest, gas detector...),
// structurally closest to Assets Management's own AssetGroupsAdmin.jsx: a
// table + one create/edit dialog, not the much larger multi-tab detail view
// AssetsCatalogueAdmin.jsx renders for a full asset record. Data access only
// ever goes through src/data/safetyService.js, the same {data, error}
// envelope every sibling service already uses. safety_ppe_type_upsert()'s
// own permission gate (Safety.Manage) is enforced server-side; this screen
// does not re-derive it client-side — same convention Assets Management's
// own admin screens already document — it renders the actions and lets
// PERMISSION_DENIED surface through safetyErrorMessage() if the account may
// not use them.
//
// loadPpeTypes() defaults to active-only but accepts {includeInactive}, so
// this screen carries the same "show inactive" toggle + inactive-row
// treatment + reactivate-via-edit-dialog fix AssetGroupsAdmin.jsx/
// AssetCustodyUnitsAdmin.jsx already received — deactivating a PPE type must
// never be a one-way door.
//
// The illustrative image is an attachment (entityType 'SafetyPpeType') and
// needs a real row id to attach to, so the AttachmentsPanel only ever shows
// once the dialog is in edit mode (draft.id set) — create, close, reopen for
// edit — same two-step shape AssetsCatalogueAdmin.jsx's own asset create
// flow requires before its Attachments tab has anything to point at.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, HardHat, Pencil, Plus, Search, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { useDialogA11y } from '../../utils/useDialogA11y';
import { pickLocalized } from '../../utils/localize';
import AttachmentsPanel from '../platform/AttachmentsPanel';
import {
  PPE_CATEGORIES, loadPpeTypes, savePpeType, safetyErrorMessage, listSafetyAttachments,
} from '../../data/safetyService';
import './safety.css';

const emptyDraft = () => ({
  id: null,
  code: '',
  name_ar: '',
  name_en: '',
  category: '',
  description_ar: '',
  description_en: '',
  standard_lifespan_days: '',
  requires_size: false,
  display_order: 0,
  is_active: true,
});

const toDraft = (row) => ({
  id: row.id,
  code: row.code || '',
  name_ar: row.name_ar || '',
  name_en: row.name_en || '',
  category: row.category || '',
  description_ar: row.description_ar || '',
  description_en: row.description_en || '',
  standard_lifespan_days: row.standard_lifespan_days ?? '',
  requires_size: Boolean(row.requires_size),
  display_order: row.display_order ?? 0,
  is_active: row.is_active !== false,
});

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

const PpeTypeDialog = ({ draft, tenantId, busy, error, onChange, onClose, onSubmit }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const set = (key) => (event) => onChange({ ...draft, [key]: event.target.value });

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? t('action_edit') : t('safety_types_add')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('safety_module_kicker')}</span>
            <h3>{draft.id ? t('action_edit') : t('safety_types_add')}</h3>
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
              className="form-input"
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

          <label className="field-label">
            {t('safety_field_category')}
            <select required className="form-input" value={draft.category || ''} onChange={set('category')}>
              <option value="" disabled>{t('safety_types_select_category')}</option>
              {PPE_CATEGORIES.map((category) => (
                <option key={category} value={category}>{t(`safety_category_${category.toLowerCase()}`)}</option>
              ))}
            </select>
          </label>
          <label className="field-label">
            {t('safety_field_lifespan_days')}
            <input
              type="number"
              min="1"
              className="form-input"
              value={draft.standard_lifespan_days ?? ''}
              onChange={set('standard_lifespan_days')}
            />
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
            checked={Boolean(draft.requires_size)}
            onChange={(event) => onChange({ ...draft, requires_size: event.target.checked })}
          />
          {t('safety_field_requires_size')}
        </label>

        <label className="content-publish-check">
          <input
            type="checkbox"
            checked={draft.is_active !== false}
            onChange={(event) => onChange({ ...draft, is_active: event.target.checked })}
          />
          {t('label_active')}
        </label>

        {error && <div className="modal-error"><X aria-hidden="true" />{error}</div>}

        {draft.id ? (
          <div className="safety-type-attachments">
            <AttachmentsPanel
              tenantId={tenantId}
              entityType="SafetyPpeType"
              entityId={draft.id}
              area="safety"
              listFn={listSafetyAttachments}
            />
          </div>
        ) : (
          <p className="field-note">{t('safety_types_photo_hint')}</p>
        )}

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

const SafetyPpeTypesAdmin = () => {
  const { t, lang } = useLanguage();
  const { tenant } = useTenant();
  const tenantId = tenant?.id || null;

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
  // same shape AssetGroupsAdmin.jsx's own refresh() uses.
  const refresh = useCallback(() => {
    setLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadPpeTypes({ includeInactive }).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setRows([]);
        setNotice({ tone: 'error', text: safetyErrorMessage(t, error) || t('admin_load_failed') });
      } else {
        setRows(data || []);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [reloadToken, includeInactive, t]);

  // loadPpeTypes() takes no search parameter, so filtering happens here over
  // the already-fetched set — same reasoning AssetGroupsAdmin.jsx documents
  // for its own local, non-debounced search (nothing is re-queried per
  // keystroke, so there is nothing to debounce).
  const filteredRows = useMemo(() => {
    const sorted = [...rows].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    const needle = search.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter((row) => `${row.code || ''} ${row.name_ar || ''} ${row.name_en || ''}`.toLowerCase().includes(needle));
  }, [rows, search]);

  const openCreate = () => { setDraftError(''); setDraft(emptyDraft()); };
  const openEdit = (row) => { setDraftError(''); setDraft(toDraft(row)); };

  const save = async () => {
    if (!draft.category) { setDraftError(t('safety_err_invalid_category')); return; }
    setBusy(true);
    setDraftError('');
    const { data, error } = await savePpeType(draft);
    setBusy(false);
    if (error) {
      setDraftError(safetyErrorMessage(t, error));
      return;
    }
    // A first save turns create mode into edit mode in place (rather than
    // closing) so the just-created row's AttachmentsPanel becomes reachable
    // without a second round trip through the table.
    if (!draft.id && data) {
      setDraft((current) => ({ ...current, id: data }));
    } else {
      setDraft(null);
    }
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refresh();
  };

  // Switching a type off still drops it out of the default (active-only)
  // view on the next refresh, but it stays reachable with "show inactive" on.
  const toggleActive = async (row) => {
    const { error } = await savePpeType({ ...row, is_active: !row.is_active });
    if (error) {
      setNotice({ tone: 'error', text: safetyErrorMessage(t, error) });
      return;
    }
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refresh();
  };

  return (
    <div className="admin-content safety-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('safety_module_kicker')}</span>
          <h1><HardHat className="admin-title-icon" aria-hidden="true" /> {t('safety_types_title')}</h1>
          <p>{t('safety_types_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="primary-button" onClick={openCreate}>
            <Plus aria-hidden="true" /> {t('safety_types_add')}
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
              <th>{t('safety_field_category')}</th>
              <th>{t('safety_field_requires_size')}</th>
              <th>{t('label_status')}</th>
              <th aria-label={t('label_actions')} />
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.id} style={row.is_active === false ? { opacity: 0.6 } : undefined}>
                <td><code>{row.code || '—'}</code></td>
                <td>
                  <b>{pickLocalized(row, 'name', lang)}</b>
                  {row.is_active === false && <span className="aging-badge">{t('label_inactive')}</span>}
                </td>
                <td>{row.name_en || '—'}</td>
                <td>{t(`safety_category_${String(row.category || '').toLowerCase()}`)}</td>
                <td>{t(row.requires_size ? 'action_yes' : 'action_no')}</td>
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
                <td colSpan={7}>
                  <div className="empty-table">
                    <HardHat aria-hidden="true" />
                    <b>{t('label_no_results')}</b>
                  </div>
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={7}>{t('label_loading')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {draft && (
        <PpeTypeDialog
          draft={draft}
          tenantId={tenantId}
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

export default SafetyPpeTypesAdmin;
