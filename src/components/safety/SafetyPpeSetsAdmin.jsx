// Safety Management — PPE Sets (admin/safety-ppe-sets, Safety.Manage,
// ADMIN_SAFETY_PPE_SETS).
//
// A named bundle of PPE types (e.g. "مجموعة فني كهرباء" = helmet + goggles +
// electrical gloves + boots + vest + voltage detector) PLUS that set's own
// audience — which positions/departments/projects/sites are required to
// wear it. The spec's own "ربط المجموعات بالمناصب الوظيفية" screen is this
// same screen, not a separate one: the set header, its PPE item lines and
// its targeting rule are all edited together in one modal-xwide dialog,
// structurally the AssetGroupsAdmin.jsx/SafetyPpeTypesAdmin.jsx table+dialog
// shape, just with two extra sections inside the dialog instead of one.
//
// Data access only ever goes through src/data/safetyService.js. Every write
// RPC's own Safety.Manage gate is enforced server-side; this screen does not
// re-derive it client-side — same convention every sibling admin screen in
// this codebase already documents — it renders the actions and lets
// PERMISSION_DENIED surface through safetyErrorMessage() if the account may
// not use them.
//
// "Who is required to wear this set" is answered by the platform's own
// Audience Engine (entity_type 'SafetyPpeSet'), reusing the same
// AudiencePicker component Announcements/Circulars/Surveys already use —
// never a bespoke position/department/project/site picker. This module's own
// migration (202608070056) widened the engine with a 'Position' dimension,
// valid only for entity_type 'SafetyPpeSet'; AudiencePicker now accepts a
// `dimensions` prop for exactly this (see AudiencePicker.jsx's own comment),
// so every other entity_type's picker keeps its original dimension list.
// AudiencePicker itself never saves — safetyService.savePpeSetRequirements()
// is called next to the header/items save, same "one button saves one
// record" contract the picker documents.
//
// loadPpeSets() defaults to active-only but accepts {includeInactive}, so
// this screen carries the same "show inactive" toggle + inactive-row
// treatment + reactivate-via-edit-dialog pattern PPE Types/Asset Groups
// already use — deactivating a set must never be a one-way door.

import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, ListChecks, Package, Pencil, Plus, Search, Trash2, Users, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useDialogA11y } from '../../utils/useDialogA11y';
import { pickLocalized } from '../../utils/localize';
import {
  safetyErrorMessage,
  loadPpeSets, savePpeSet, loadPpeSetItems, setPpeSetItems,
  loadPpeTypes, loadPpeSetRequirements, savePpeSetRequirements,
} from '../../data/safetyService';
import { AUDIENCE_DIMENSIONS, POSITION_DIMENSION, normalizeRule, ruleTerms } from '../../data/audienceService';
import './safety.css';

// The Audience Engine picker is a separate module and may not be installed
// in every deployment, so it is resolved through a glob — an unmatched glob
// yields an empty map instead of an unresolved-import build failure — same
// defensive loading shape src/components/announcements/engagementUi.jsx's
// own AudienceField already uses for the very same component.
const audienceModules = import.meta.glob('../audience/AudiencePicker.jsx');
const audienceLoader = audienceModules['../audience/AudiencePicker.jsx'];
const AudiencePicker = audienceLoader ? lazy(audienceLoader) : null;

/** Keeps a failure inside the shared picker from taking down the whole dialog. */
class PickerBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

// 'Position' is this module's own Audience Engine extension, valid only for
// entity_type 'SafetyPpeSet' — every other entity_type's own AudiencePicker
// usage elsewhere in the app keeps AUDIENCE_DIMENSIONS untouched.
const SAFETY_SET_DIMENSIONS = [...AUDIENCE_DIMENSIONS, POSITION_DIMENSION];

// ---------------------------------------------------------------------------
// Set header + item lines
// ---------------------------------------------------------------------------
let itemRowCounter = 0;
const nextItemRowId = () => {
  itemRowCounter += 1;
  return `set-item-${itemRowCounter}`;
};

const emptySetDraft = () => ({
  id: null,
  code: '',
  name_ar: '',
  name_en: '',
  description_ar: '',
  description_en: '',
  display_order: 0,
  is_active: true,
  items: [],
  requirementsRule: null,
});

const toSetDraft = (row) => ({
  id: row.id,
  code: row.code || '',
  name_ar: row.name_ar || '',
  name_en: row.name_en || '',
  description_ar: row.description_ar || '',
  description_en: row.description_en || '',
  display_order: row.display_order ?? 0,
  is_active: row.is_active !== false,
  items: [],
  requirementsRule: null,
});

const itemRowFromRecord = (row) => ({
  localId: nextItemRowId(),
  ppeTypeId: row.ppe_type_id,
  quantity: row.quantity ?? 1,
  reissueIntervalDays: row.reissue_interval_days ?? '',
  isMandatory: row.is_mandatory !== false,
});

const emptyItemRow = () => ({
  localId: nextItemRowId(), ppeTypeId: '', quantity: 1, reissueIntervalDays: '', isMandatory: true,
});

/** Every item line needs a real PPE type and a positive quantity — same two
 * checks safety_ppe_set_set_items() itself raises PPE_TYPE_ID_REQUIRED/
 * INVALID_QUANTITY for; catching them here (same existing safety_err_* keys)
 * saves the round trip when the row is obviously incomplete. */
const validateItems = (items) => {
  if (items.some((row) => !row.ppeTypeId)) return 'safety_err_ppe_type_id_required';
  if (items.some((row) => !(Number(row.quantity) > 0))) return 'safety_err_invalid_quantity';
  return null;
};

const PpeSetItemsEditor = ({ items, ppeTypes, loading, disabled, onChange }) => {
  const { t, lang } = useLanguage();

  const usedElsewhere = useCallback((excludeLocalId) => new Set(
    items.filter((row) => row.localId !== excludeLocalId && row.ppeTypeId).map((row) => row.ppeTypeId),
  ), [items]);

  const updateRow = (localId, patch) => onChange(items.map((row) => (row.localId === localId ? { ...row, ...patch } : row)));
  const removeRow = (localId) => onChange(items.filter((row) => row.localId !== localId));
  const addRow = () => onChange([...items, emptyItemRow()]);

  return (
    <div className="safety-set-section">
      <div className="safety-set-section-head">
        <ListChecks aria-hidden="true" />
        <h4>{t('safety_sets_items_title')}</h4>
      </div>
      <p className="field-note">{t('safety_sets_items_hint')}</p>

      {loading && <p className="field-note">{t('label_loading')}</p>}

      {!loading && !ppeTypes.length && <p className="field-note">{t('safety_sets_no_types')}</p>}

      {!loading && ppeTypes.length > 0 && (
        <>
          {items.length === 0 ? (
            <p className="field-note">{t('safety_sets_items_empty')}</p>
          ) : (
            <div className="data-table-wrap safety-set-items-table">
              <table className="enterprise-table">
                <thead>
                  <tr>
                    <th>{t('safety_field_ppe_type')}</th>
                    <th>{t('safety_field_quantity')}</th>
                    <th>{t('safety_field_reissue_interval_days')}</th>
                    <th>{t('safety_field_is_mandatory')}</th>
                    <th aria-label={t('label_actions')} />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => {
                    const taken = usedElsewhere(row.localId);
                    const options = ppeTypes.filter((type) => type.id === row.ppeTypeId || !taken.has(type.id));
                    return (
                      <tr key={row.localId}>
                        <td>
                          <select
                            className="form-input"
                            value={row.ppeTypeId}
                            disabled={disabled}
                            onChange={(event) => updateRow(row.localId, { ppeTypeId: event.target.value })}
                          >
                            <option value="" disabled>{t('safety_sets_select_ppe_type')}</option>
                            {options.map((type) => (
                              <option key={type.id} value={type.id}>
                                {pickLocalized(type, 'name', lang)}{type.is_active === false ? ` (${t('label_inactive')})` : ''}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="number"
                            min="1"
                            className="form-input safety-set-item-qty"
                            value={row.quantity}
                            disabled={disabled}
                            aria-label={t('safety_field_quantity')}
                            onChange={(event) => updateRow(row.localId, { quantity: event.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            min="1"
                            className="form-input safety-set-item-qty"
                            value={row.reissueIntervalDays}
                            disabled={disabled}
                            aria-label={t('safety_field_reissue_interval_days')}
                            onChange={(event) => updateRow(row.localId, { reissueIntervalDays: event.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={row.isMandatory}
                            disabled={disabled}
                            aria-label={t('safety_field_is_mandatory')}
                            onChange={(event) => updateRow(row.localId, { isMandatory: event.target.checked })}
                          />
                        </td>
                        <td>
                          <div className="table-actions">
                            <button
                              type="button"
                              title={t('safety_sets_item_remove')}
                              aria-label={t('safety_sets_item_remove')}
                              disabled={disabled}
                              onClick={() => removeRow(row.localId)}
                            >
                              <Trash2 aria-hidden="true" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <button
            type="button"
            className="secondary-button safety-set-item-add-row"
            disabled={disabled || items.length >= ppeTypes.length}
            onClick={addRow}
          >
            <Plus aria-hidden="true" /> {t('safety_sets_item_add')}
          </button>
        </>
      )}
    </div>
  );
};

/** "Who is required to wear this set" — the same Audience Engine picker
 * every other targeted module uses, widened with the 'Position' dimension
 * this module's own migration added for entity_type 'SafetyPpeSet'. */
const PpeSetRequirementsField = ({ entityId, value, onChange, disabled, loading }) => {
  const { t } = useLanguage();
  const unavailable = <p className="field-note">{t('safety_sets_requirements_unavailable')}</p>;

  return (
    <div className="safety-set-section">
      <div className="safety-set-section-head">
        <Users aria-hidden="true" />
        <h4>{t('safety_sets_requirements_title')}</h4>
      </div>
      <p className="field-note">{t('safety_sets_requirements_hint')}</p>

      {loading ? (
        <p className="safety-set-requirements-loading">{t('label_loading')}</p>
      ) : AudiencePicker ? (
        <PickerBoundary fallback={unavailable}>
          <Suspense fallback={<p className="safety-set-requirements-loading">{t('label_loading')}</p>}>
            <AudiencePicker
              entityType="SafetyPpeSet"
              entityId={entityId}
              value={value}
              onChange={onChange}
              disabled={disabled}
              dimensions={SAFETY_SET_DIMENSIONS}
            />
          </Suspense>
        </PickerBoundary>
      ) : unavailable}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------
const PpeSetDialog = ({
  draft, ppeTypes, ppeTypesLoading, itemsLoading, requirementsLoading, busy, error, onChange, onClose, onSubmit,
}) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const set = (key) => (event) => onChange({ ...draft, [key]: event.target.value });

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-xwide"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? t('action_edit') : t('safety_sets_add')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('safety_module_kicker')}</span>
            <h3>{draft.id ? t('action_edit') : t('safety_sets_add')}</h3>
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

        <PpeSetItemsEditor
          items={draft.items}
          ppeTypes={ppeTypes}
          loading={ppeTypesLoading || itemsLoading}
          disabled={busy}
          onChange={(items) => onChange({ ...draft, items })}
        />

        <PpeSetRequirementsField
          entityId={draft.id}
          value={draft.requirementsRule}
          onChange={(requirementsRule) => onChange({ ...draft, requirementsRule })}
          disabled={busy}
          loading={requirementsLoading}
        />

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
const SafetyPpeSetsAdmin = () => {
  const { t } = useLanguage();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [notice, setNotice] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [ppeTypes, setPpeTypes] = useState([]);
  const [ppeTypesLoading, setPpeTypesLoading] = useState(true);

  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState('');
  const [busy, setBusy] = useState(false);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [requirementsLoading, setRequirementsLoading] = useState(false);

  // Any save/toggle bumps the token; the one effect below fetches again —
  // same shape AssetGroupsAdmin.jsx/SafetyPpeTypesAdmin.jsx's own refresh().
  const refresh = useCallback(() => {
    setLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadPpeSets({ includeInactive }).then(({ data, error }) => {
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

  // The item-line picker needs every PPE type (including inactive ones, so a
  // set that already references a since-retired type still displays it,
  // marked inactive, rather than silently dropping the row) — loaded once,
  // independent of the sets list's own includeInactive toggle.
  useEffect(() => {
    let cancelled = false;
    loadPpeTypes({ includeInactive: true }).then(({ data, error }) => {
      if (cancelled) return;
      if (error) setNotice({ tone: 'error', text: safetyErrorMessage(t, error) || t('admin_load_failed') });
      setPpeTypes(data || []);
      setPpeTypesLoading(false);
    });
    return () => { cancelled = true; };
  }, [t]);

  // loadPpeSets() takes no search parameter, so filtering happens here over
  // the already-fetched set — same reasoning AssetGroupsAdmin.jsx/
  // SafetyPpeTypesAdmin.jsx document for their own local, non-debounced
  // search (nothing is re-queried per keystroke, so there is nothing to
  // debounce).
  const filteredRows = useMemo(() => {
    const sorted = [...rows].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    const needle = search.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter((row) => `${row.code || ''} ${row.name_ar || ''} ${row.name_en || ''}`.toLowerCase().includes(needle));
  }, [rows, search]);

  const openCreate = () => {
    setDraftError('');
    setDraft(emptySetDraft());
    setItemsLoading(false);
    setRequirementsLoading(false);
  };

  const openEdit = (row) => {
    setDraftError('');
    setDraft(toSetDraft(row));
    setItemsLoading(true);
    setRequirementsLoading(true);
    Promise.all([loadPpeSetItems(row.id), loadPpeSetRequirements(row.id)]).then(([itemsResult, ruleResult]) => {
      setDraft((current) => (current && current.id === row.id ? {
        ...current,
        items: (itemsResult.data || []).map(itemRowFromRecord),
        requirementsRule: ruleResult.data || null,
      } : current));
      setItemsLoading(false);
      setRequirementsLoading(false);
    });
  };

  const save = async () => {
    const itemsErrorCode = validateItems(draft.items);
    if (itemsErrorCode) { setDraftError(t(itemsErrorCode)); return; }

    setBusy(true);
    setDraftError('');

    const { data: newId, error: headerError } = await savePpeSet(draft);
    if (headerError) {
      setBusy(false);
      setDraftError(safetyErrorMessage(t, headerError));
      return;
    }
    const setId = draft.id || newId;

    const { error: itemsError } = await setPpeSetItems(setId, draft.items.map((row) => ({
      ppeTypeId: row.ppeTypeId,
      quantity: row.quantity,
      reissueIntervalDays: row.reissueIntervalDays || null,
      isMandatory: row.isMandatory,
    })));
    if (itemsError) {
      setBusy(false);
      setDraftError(safetyErrorMessage(t, itemsError));
      if (!draft.id) setDraft((current) => ({ ...current, id: setId }));
      return;
    }

    // Same payload shape audienceService.saveRule() itself builds before
    // calling audience_save — savePpeSetRequirements() forwards whatever
    // rule it is given untouched, so the flattening happens here rather
    // than inside safetyService.js (which stays a thin RPC wrapper, same
    // convention every one of its other functions already follows).
    const normalized = normalizeRule(draft.requirementsRule);
    const requirementsPayload = {
      is_everyone: normalized.is_everyone || normalized.groups.length === 0,
      match_mode: normalized.match_mode,
      terms: normalized.is_everyone ? [] : ruleTerms(normalized),
    };
    const { error: requirementsError } = await savePpeSetRequirements(setId, requirementsPayload);
    setBusy(false);
    if (requirementsError) {
      setDraftError(safetyErrorMessage(t, requirementsError));
      if (!draft.id) setDraft((current) => ({ ...current, id: setId }));
      return;
    }

    setDraft(null);
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refresh();
  };

  // Switching a set off still drops it out of the default (active-only) view
  // on the next refresh, but it stays reachable with "show inactive" on.
  const toggleActive = async (row) => {
    const { error } = await savePpeSet({ ...row, is_active: !row.is_active });
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
          <h1><Package className="admin-title-icon" aria-hidden="true" /> {t('safety_sets_title')}</h1>
          <p>{t('safety_sets_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="primary-button" onClick={openCreate}>
            <Plus aria-hidden="true" /> {t('safety_sets_add')}
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
                    <Package aria-hidden="true" />
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
        <PpeSetDialog
          draft={draft}
          ppeTypes={ppeTypes}
          ppeTypesLoading={ppeTypesLoading}
          itemsLoading={itemsLoading}
          requirementsLoading={requirementsLoading}
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

export default SafetyPpeSetsAdmin;
