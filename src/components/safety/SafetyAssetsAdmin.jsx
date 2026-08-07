// Safety Management — Safety Assets admin screen: attaches/edits the 1:1
// public.safety_asset_ext extension row on an EXISTING public.assets row
// (asset-kind PPE — gas detectors, breathing apparatus, fire extinguishers —
// tracked as individually custodied assets, never a duplicate record). This
// screen never creates a parallel "PPE asset" table; it either picks an
// existing Assets Management asset or creates one through assetsService.js's
// own createAsset(), exactly the same RPC AssetsCatalogueAdmin.jsx uses.
//
// public.safety_ppe_types carries no linked_asset_group_id column in the
// shipped migration (202608070056_safety_management.sql §2.1) — the design
// intent noted in the task brief does not exist in the actual schema, so
// there is no per-PPE-type asset-group scoping here: the asset picker/
// creator below is open, the same unscoped catalogue browse
// AssetsCatalogueAdmin.jsx's own openCreate() already uses for its parent-
// asset picker.
//
// Attachments for the underlying asset go through Assets Management's own
// asset_attachment_list()/listAssetAttachments() with entityType 'Asset' —
// NOT safetyService.js's listSafetyAttachments(), whose own RPC
// (safety_attachment_list) only accepts entity_type 'SafetyPpeType' /
// 'SafetyIssuance' / 'SafetyFieldVisitCheck' (migration §7.14) and would
// raise UNSUPPORTED_ENTITY_TYPE for 'Asset'/'SafetyAssetExt'. The safety
// extension's own timeline (safety_timeline, entity_type 'SafetyAssetExt',
// keyed by the extension row's own id) IS this module's own wrapper and is
// used for the Timeline tab below.
//
// Two permissions gate this screen's writes, never one: Safety.Manage always
// (for the extension row itself), PLUS Assets.Operate/Assets.Manage when the
// flow also creates the underlying asset (asset_create()'s own gate). Both
// are surfaced in the UI's own permission hint rather than only mentioning
// Safety.Manage — neither RPC's server-side check is re-derived client-side
// beyond what conditional button rendering needs, same convention
// AssetsCatalogueAdmin.jsx's own header comment documents.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, ChevronLeft, ChevronRight, ClipboardCheck, Eye, History,
  Paperclip, PackageCheck, Pencil, Plus, RefreshCcw, Search, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { useDialogA11y } from '../../utils/useDialogA11y';
import { pickLocalized, formatDate, codeLabel } from '../../utils/localize';
import AttachmentsPanel from '../platform/AttachmentsPanel';
import { SafetyTimelinePanel } from './safetyTimeline';
import {
  PPE_ASSET_CONDITION_STATUSES, safetyErrorMessage,
  loadPpeTypes, saveAssetExt, inspectAssetExt, loadAssetExt, loadAssetExtList, loadSafetyTimeline,
} from '../../data/safetyService';
import {
  assetsErrorMessage, loadAssets, loadAsset, loadAssetsByIds, createAsset, listAssetAttachments,
} from '../../data/assetsService';
import './safety.css';

// Mirrors safetyService.js's own unexported DEFAULT_PAGE_SIZE (loadAssetExtList())
// and assetsService.js's own DEFAULT_ASSET_PAGE_SIZE (loadAssets()) — a caller
// never guesses at the server's own page size, it only needs the same number
// to know when a load may have been truncated.
const LIST_PAGE_SIZE = 200;
const ASSET_PICKER_PAGE_SIZE = 200;

const BackIcon = () => {
  const { isRtl } = useLanguage();
  const Icon = isRtl ? ChevronRight : ChevronLeft;
  return <Icon aria-hidden="true" />;
};

const SafetyConditionBadge = ({ status }) => {
  const { t } = useLanguage();
  return (
    <span className={`status-badge status-${String(status || '').toLowerCase()}`}>
      {codeLabel(t, 'safety_condition', status, status)}
    </span>
  );
};

// ---------------------------------------------------------------------------
// Asset picker — a live, server-backed search (loadAssets({ search })), so
// it debounces the same 350ms AssetsCatalogueAdmin.jsx's own catalogue
// search does; the main list below filters an already-loaded page instead
// (no server round trip), so that one stays synchronous with no debounce,
// same split AssetGroupsAdmin.jsx (client filter) vs AssetsCatalogueAdmin.jsx
// (server filter) already establish for their own search fields.
// ---------------------------------------------------------------------------
const AssetPicker = ({ onPick }) => {
  const { t, lang } = useLanguage();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);

  // setLoading(true) lives in the debounce timer's callback, not in the
  // fetch effect's own body below — same split AssetsCatalogueAdmin.jsx's
  // own debounced catalogue search uses, so no effect ever calls setState
  // synchronously in its body (loading already starts true for the first,
  // un-debounced mount fetch).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (search === searchInput) return;
      setLoading(true);
      setSearch(searchInput);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchInput, search]);

  useEffect(() => {
    let cancelled = false;
    loadAssets({ search: search || undefined }).then(({ data }) => {
      if (cancelled) return;
      const list = data || [];
      setRows(list);
      setTruncated(list.length >= ASSET_PICKER_PAGE_SIZE);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [search]);

  return (
    <div className="safety-picker-block">
      <div className="search-control">
        <Search aria-hidden="true" />
        <input
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder={t('safety_assets_asset_search_placeholder')}
          aria-label={t('action_search')}
        />
      </div>
      <div className="safety-picker-box">
        {loading && <p className="field-note">{t('label_loading')}</p>}
        {!loading && !rows.length && <p className="safety-picker-empty">{t('safety_assets_asset_picker_empty')}</p>}
        {!loading && rows.map((row) => (
          <button type="button" key={row.id} className="safety-picker-row" onClick={() => onPick(row)}>
            <span>{pickLocalized(row, 'name', lang)}</span>
            <small>{row.reference}</small>
          </button>
        ))}
      </div>
      {truncated && <p className="field-note">{t('safety_assets_asset_picker_truncated_hint')}</p>}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Attach / edit modal — asset is null for the create-or-pick flow, or the
// existing asset row when editing an already-extended asset (its identity is
// then fixed; only the extension fields and the PPE type are editable).
// ---------------------------------------------------------------------------
const emptyExtDraft = () => ({
  ppeTypeId: '', expiryDate: '', inspectionIntervalDays: '', lastInspectionDate: '', conditionStatus: 'Good', notes: '',
});

const toExtDraft = (row) => ({
  ppeTypeId: row.ppe_type_id || '',
  expiryDate: row.expiry_date || '',
  inspectionIntervalDays: row.inspection_interval_days ?? '',
  lastInspectionDate: row.last_inspection_date || '',
  conditionStatus: row.condition_status || 'Good',
  notes: row.notes || '',
});

const emptyNewAssetDraft = () => ({ name_ar: '', name_en: '', brand: '', model: '', serial_no: '' });

const AssetExtFormModal = ({ asset, ppeTypes, onClose, onDone }) => {
  const { t, lang } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const isEdit = Boolean(asset);

  const [mode, setMode] = useState('pick');
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [newAssetDraft, setNewAssetDraft] = useState(emptyNewAssetDraft());
  const [ext, setExt] = useState(emptyExtDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Prefills from the current extension row when editing — never guessed at
  // from the list row alone, since the list only carries the ext columns the
  // table itself renders (contract §17 projection).
  useEffect(() => {
    if (!isEdit) return undefined;
    let cancelled = false;
    loadAssetExt(asset.id).then(({ data }) => { if (!cancelled && data) setExt(toExtDraft(data)); });
    return () => { cancelled = true; };
  }, [isEdit, asset]);

  const set = (key) => (event) => setExt((prev) => ({ ...prev, [key]: event.target.value }));
  const setNewAsset = (key) => (event) => setNewAssetDraft((prev) => ({ ...prev, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (!ext.ppeTypeId) { setError(t('safety_err_ppe_type_id_required')); return; }

    let assetId = asset?.id || selectedAsset?.id || null;
    setBusy(true);

    if (!isEdit && mode === 'create') {
      if (!newAssetDraft.name_ar.trim()) { setBusy(false); setError(t('safety_err_name_ar_required')); return; }
      const { data: newAssetId, error: createError } = await createAsset(newAssetDraft);
      if (createError) { setBusy(false); setError(assetsErrorMessage(t, createError)); return; }
      assetId = newAssetId;
    }

    if (!assetId) { setBusy(false); setError(t('safety_assets_asset_required')); return; }

    const { error: saveError } = await saveAssetExt({
      assetId,
      ppeTypeId: ext.ppeTypeId,
      expiryDate: ext.expiryDate || null,
      inspectionIntervalDays: ext.inspectionIntervalDays || null,
      lastInspectionDate: ext.lastInspectionDate || null,
      conditionStatus: ext.conditionStatus,
      notes: ext.notes,
    });
    setBusy(false);
    if (saveError) { setError(safetyErrorMessage(t, saveError)); return; }
    onDone(assetId);
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? t('safety_assets_edit_title') : t('safety_assets_add')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('safety_module_kicker')}</span>
            <h3><PackageCheck aria-hidden="true" /> {isEdit ? t('safety_assets_edit_title') : t('safety_assets_add')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <p className="field-note">{t('safety_assets_permission_hint')}</p>

        {isEdit && (
          <div className="safety-picked-asset">
            <div>
              <b>{pickLocalized(asset, 'name', lang)}</b>
              <code>{asset.reference}</code>
            </div>
          </div>
        )}

        {!isEdit && (
          <>
            <div className="segmented" role="group" aria-label={t('safety_assets_mode_label')}>
              <button type="button" aria-pressed={mode === 'pick'} className={mode === 'pick' ? 'active' : ''} onClick={() => { setMode('pick'); setSelectedAsset(null); }}>
                {t('safety_assets_mode_pick')}
              </button>
              <button type="button" aria-pressed={mode === 'create'} className={mode === 'create' ? 'active' : ''} onClick={() => { setMode('create'); setSelectedAsset(null); }}>
                {t('safety_assets_mode_create')}
              </button>
            </div>

            {mode === 'pick' && !selectedAsset && <AssetPicker onPick={setSelectedAsset} />}
            {mode === 'pick' && selectedAsset && (
              <div className="safety-picked-asset">
                <div>
                  <b>{pickLocalized(selectedAsset, 'name', lang)}</b>
                  <code>{selectedAsset.reference}</code>
                </div>
                <button type="button" className="secondary-button" onClick={() => setSelectedAsset(null)}>
                  {t('safety_assets_change_asset')}
                </button>
              </div>
            )}

            {mode === 'create' && (
              <div className="form-grid">
                <label className="field-label">{t('label_name_1')}
                  <input required className="form-input" value={newAssetDraft.name_ar} onChange={setNewAsset('name_ar')} />
                </label>
                <label className="field-label">{t('label_name_2')}
                  <input className="form-input" value={newAssetDraft.name_en} onChange={setNewAsset('name_en')} />
                </label>
                <label className="field-label">{t('asset_field_brand')}
                  <input className="form-input" value={newAssetDraft.brand} onChange={setNewAsset('brand')} />
                </label>
                <label className="field-label">{t('asset_field_model')}
                  <input className="form-input" value={newAssetDraft.model} onChange={setNewAsset('model')} />
                </label>
                <label className="field-label">{t('asset_field_serial_no')}
                  <input className="form-input" value={newAssetDraft.serial_no} onChange={setNewAsset('serial_no')} />
                </label>
              </div>
            )}
          </>
        )}

        <div className="form-grid">
          <label className="field-label">{t('safety_field_ppe_type')}
            <select required className="form-input" value={ext.ppeTypeId} onChange={set('ppeTypeId')}>
              <option value="">{t('admin_not_assigned')}</option>
              {ppeTypes.map((type) => <option key={type.id} value={type.id}>{pickLocalized(type, 'name', lang)}</option>)}
            </select>
          </label>
          <label className="field-label">{t('safety_field_condition_status')}
            <select className="form-input" value={ext.conditionStatus} onChange={set('conditionStatus')}>
              {PPE_ASSET_CONDITION_STATUSES.map((status) => <option key={status} value={status}>{codeLabel(t, 'safety_condition', status, status)}</option>)}
            </select>
          </label>
          <label className="field-label">{t('safety_field_expiry_date')}
            <input type="date" className="form-input" value={ext.expiryDate} onChange={set('expiryDate')} />
          </label>
          <label className="field-label">{t('safety_field_inspection_interval_days')}
            <input type="number" min="1" className="form-input" value={ext.inspectionIntervalDays} onChange={set('inspectionIntervalDays')} />
          </label>
          <label className="field-label">{t('safety_field_last_inspection_date')}
            <input type="date" className="form-input" value={ext.lastInspectionDate} onChange={set('lastInspectionDate')} />
          </label>
          <label className="field-label field-span-2">{t('asset_field_notes')}
            <textarea className="form-input" value={ext.notes} onChange={set('notes')} />
          </label>
        </div>

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
// Record Inspection — a lighter-weight action than the full upsert above
// (safety_asset_ext_inspect() only ever touches last_inspection_date/
// next_inspection_due/condition_status/notes), for a Safety Inspector
// logging a routine check without touching the PPE type or expiry date.
// ---------------------------------------------------------------------------
const InspectionModal = ({ asset, onClose, onDone }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const [inspectionDate, setInspectionDate] = useState(new Date().toISOString().slice(0, 10));
  const [conditionStatus, setConditionStatus] = useState('');
  const [nextInspectionDue, setNextInspectionDue] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { error: inspectError } = await inspectAssetExt(asset.id, {
      inspectionDate, conditionStatus: conditionStatus || null, nextInspectionDue: nextInspectionDue || null, notes,
    });
    setBusy(false);
    if (inspectError) { setError(safetyErrorMessage(t, inspectError)); return; }
    onDone();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form className="modal-card" role="dialog" aria-modal="true" aria-label={t('safety_assets_action_record_inspection')} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{asset.reference}</span>
            <h3><ClipboardCheck aria-hidden="true" /> {t('safety_assets_action_record_inspection')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
        <p className="field-note">{t('safety_assets_inspection_hint')}</p>
        <label className="field-label">{t('safety_field_last_inspection_date')}
          <input required type="date" className="form-input" value={inspectionDate} onChange={(event) => setInspectionDate(event.target.value)} />
        </label>
        <label className="field-label">{t('safety_field_condition_status')}
          <select className="form-input" value={conditionStatus} onChange={(event) => setConditionStatus(event.target.value)}>
            <option value="">{t('admin_not_assigned')}</option>
            {PPE_ASSET_CONDITION_STATUSES.map((status) => <option key={status} value={status}>{codeLabel(t, 'safety_condition', status, status)}</option>)}
          </select>
        </label>
        <label className="field-label">{t('safety_field_next_inspection_due')}
          <input type="date" className="form-input" value={nextInspectionDue} onChange={(event) => setNextInspectionDue(event.target.value)} />
        </label>
        <label className="field-label">{t('asset_field_notes')}
          <textarea className="form-input" value={notes} onChange={(event) => setNotes(event.target.value)} />
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
// Detail view
// ---------------------------------------------------------------------------
const SafetyAssetDetailView = ({ assetId, tenantId, ppeTypes, onBack, onChanged }) => {
  const { t, lang } = useLanguage();

  const [asset, setAsset] = useState(null);
  const [ext, setExt] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [notice, setNotice] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [editOpen, setEditOpen] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);

  const refresh = useCallback(() => { setLoading(true); setReloadToken((token) => token + 1); }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadAsset(assetId), loadAssetExt(assetId)]).then(async ([assetResult, extResult]) => {
      if (cancelled) return;
      if (assetResult.error) {
        setNotice({ tone: 'error', text: assetsErrorMessage(t, assetResult.error) || t('admin_load_failed') });
        setAsset(null);
      } else {
        setAsset(assetResult.data);
      }
      const extRow = extResult.data || null;
      setExt(extRow);
      if (extRow) {
        const { data: timelineRows } = await loadSafetyTimeline('SafetyAssetExt', extRow.id);
        if (!cancelled) setTimeline(timelineRows || []);
      } else {
        setTimeline([]);
      }
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [assetId, reloadToken, t]);

  const ppeTypeById = useMemo(() => new Map(ppeTypes.map((row) => [row.id, row])), [ppeTypes]);
  const ppeTypeLabel = useCallback((id) => {
    const type = ppeTypeById.get(id);
    return type ? pickLocalized(type, 'name', lang) : '';
  }, [ppeTypeById, lang]);

  // Moves focus to the detail heading once, the moment this view finishes
  // its first load — same ref-guarded pattern AssetDetailView (Assets
  // Management) uses for the same list<->detail focus handoff.
  const headingRef = useRef(null);
  const headingFocusedRef = useRef(false);
  useEffect(() => {
    if (!asset || headingFocusedRef.current) return;
    headingFocusedRef.current = true;
    headingRef.current?.focus();
  }, [asset]);

  if (loading && !asset) {
    return (
      <div className="admin-content safety-content">
        <button type="button" className="secondary-button" onClick={onBack}><BackIcon /> {t('safety_assets_back_to_list')}</button>
        <p className="field-note">{t('label_loading')}</p>
      </div>
    );
  }

  if (!asset) {
    return (
      <div className="admin-content safety-content">
        <button type="button" className="secondary-button" onClick={onBack}><BackIcon /> {t('safety_assets_back_to_list')}</button>
        <div className="empty-table"><PackageCheck aria-hidden="true" /><b>{t('label_no_results')}</b></div>
      </div>
    );
  }

  return (
    <div className="admin-content safety-content">
      <div className="admin-toolbar">
        <button type="button" className="secondary-button" onClick={onBack}><BackIcon /> {t('safety_assets_back_to_list')}</button>
        <button type="button" className="secondary-button" onClick={refresh}><RefreshCcw aria-hidden="true" /> {t('action_refresh')}</button>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
        </div>
      )}

      <div className="safety-identity">
        <div>
          <span className="section-kicker">{t('safety_module_kicker')}</span>
          <h1 ref={headingRef} tabIndex={-1}>{pickLocalized(asset, 'name', lang)}</h1>
          <code className="safety-reference">{asset.reference}</code>
        </div>

        <div className="safety-meta-grid">
          <div className="safety-meta-item"><span>{t('safety_field_ppe_type')}</span><b>{ppeTypeLabel(ext?.ppe_type_id) || t('label_none')}</b></div>
          <div className="safety-meta-item"><span>{t('safety_field_condition_status')}</span><b>{ext ? <SafetyConditionBadge status={ext.condition_status} /> : t('label_none')}</b></div>
          <div className="safety-meta-item"><span>{t('safety_field_expiry_date')}</span><b>{ext?.expiry_date ? formatDate(ext.expiry_date, lang) : t('label_none')}</b></div>
          <div className="safety-meta-item"><span>{t('safety_field_inspection_interval_days')}</span><b>{ext?.inspection_interval_days ?? t('label_none')}</b></div>
          <div className="safety-meta-item"><span>{t('safety_field_last_inspection_date')}</span><b>{ext?.last_inspection_date ? formatDate(ext.last_inspection_date, lang) : t('label_none')}</b></div>
          <div className="safety-meta-item"><span>{t('safety_field_next_inspection_due')}</span><b>{ext?.next_inspection_due ? formatDate(ext.next_inspection_due, lang) : t('label_none')}</b></div>
        </div>

        {ext?.notes && <p className="field-note">{ext.notes}</p>}

        <div className="safety-actions-row">
          <button type="button" className="secondary-button" onClick={() => setEditOpen(true)}>
            <Pencil aria-hidden="true" /> {t('action_edit')}
          </button>
          <button type="button" className="secondary-button" onClick={() => setInspectOpen(true)}>
            <ClipboardCheck aria-hidden="true" /> {t('safety_assets_action_record_inspection')}
          </button>
        </div>
      </div>

      <div className="safety-tablist" role="tablist" aria-label={t('safety_assets_title')}>
        {[
          { id: 'overview', label: t('safety_assets_tab_overview'), Icon: PackageCheck },
          { id: 'timeline', label: t('safety_assets_tab_timeline'), Icon: History },
          { id: 'attachments', label: t('att_panel_title'), Icon: Paperclip },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`safety-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`safety-tabpanel-${tab.id}`}
            className={activeTab === tab.id ? 'active' : ''}
            onClick={() => setActiveTab(tab.id)}
          >
            <tab.Icon aria-hidden="true" /> {tab.label}
          </button>
        ))}
      </div>

      <div id={`safety-tabpanel-${activeTab}`} role="tabpanel" aria-labelledby={`safety-tab-${activeTab}`} className="safety-tab-panel">
        {activeTab === 'overview' && (
          <div className="safety-meta-grid">
            {asset.brand && <div className="safety-meta-item"><span>{t('asset_field_brand')}</span><b>{asset.brand}</b></div>}
            {asset.model && <div className="safety-meta-item"><span>{t('asset_field_model')}</span><b>{asset.model}</b></div>}
            {asset.serial_no && <div className="safety-meta-item"><span>{t('asset_field_serial_no')}</span><b>{asset.serial_no}</b></div>}
            {asset.manufacturer && <div className="safety-meta-item"><span>{t('asset_field_manufacturer')}</span><b>{asset.manufacturer}</b></div>}
            {asset.purchase_date && <div className="safety-meta-item"><span>{t('asset_field_purchase_date')}</span><b>{formatDate(asset.purchase_date, lang)}</b></div>}
            {asset.warranty_until && <div className="safety-meta-item"><span>{t('asset_field_warranty_until')}</span><b>{formatDate(asset.warranty_until, lang)}</b></div>}
            {asset.supplier && <div className="safety-meta-item"><span>{t('asset_field_supplier')}</span><b>{asset.supplier}</b></div>}
          </div>
        )}
        {activeTab === 'timeline' && <SafetyTimelinePanel rows={timeline} loading={loading} />}
        {activeTab === 'attachments' && (
          <AttachmentsPanel tenantId={tenantId} entityType="Asset" entityId={asset.id} area="safety" listFn={listAssetAttachments} />
        )}
      </div>

      {editOpen && (
        <AssetExtFormModal
          asset={asset}
          ppeTypes={ppeTypes}
          onClose={() => setEditOpen(false)}
          onDone={() => { setEditOpen(false); setNotice({ tone: 'success', text: t('admin_save_done') }); refresh(); onChanged?.(); }}
        />
      )}
      {inspectOpen && (
        <InspectionModal
          asset={asset}
          onClose={() => setInspectOpen(false)}
          onDone={() => { setInspectOpen(false); setNotice({ tone: 'success', text: t('admin_save_done') }); refresh(); onChanged?.(); }}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
const SafetyAssetsAdmin = () => {
  const { t, lang } = useLanguage();
  const { tenant } = useTenant();
  const tenantId = tenant?.id || null;

  const [ppeTypes, setPpeTypes] = useState([]);
  const [extRows, setExtRows] = useState([]);
  const [assetsById, setAssetsById] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [searchInput, setSearchInput] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedAssetId, setSelectedAssetId] = useState(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [truncated, setTruncated] = useState(false);

  // Which row's Eye button opened the detail view, so onBack can return
  // focus to it — same pair AssetsCatalogueAdmin.jsx's own
  // returnFocusRowIdRef/tableWrapRef use for this exact list<->detail swap.
  const returnFocusRowIdRef = useRef(null);
  const tableWrapRef = useRef(null);

  const refresh = useCallback(() => { setLoading(true); setReloadToken((token) => token + 1); }, []);

  useEffect(() => {
    let cancelled = false;
    loadPpeTypes().then(({ data }) => { if (!cancelled) setPpeTypes(data || []); });
    return () => { cancelled = true; };
  }, []);

  // safety_asset_ext carries no asset name/reference of its own (contract
  // §17 projection — see ASSET_EXT_COLUMNS in safetyService.js), so the
  // underlying assets are fetched in one batched loadAssetsByIds() call
  // rather than one loadAsset() per row.
  useEffect(() => {
    let cancelled = false;
    loadAssetExtList({}).then(async ({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setExtRows([]);
        setNotice({ tone: 'error', text: safetyErrorMessage(t, error) || t('admin_load_failed') });
        setLoading(false);
        return;
      }
      const rows = data || [];
      setTruncated(rows.length >= LIST_PAGE_SIZE);
      const { data: assetRows } = await loadAssetsByIds(rows.map((row) => row.asset_id));
      if (cancelled) return;
      setAssetsById(new Map((assetRows || []).map((row) => [row.id, row])));
      setExtRows(rows);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [reloadToken, t]);

  const ppeTypeById = useMemo(() => new Map(ppeTypes.map((row) => [row.id, row])), [ppeTypes]);
  const ppeTypeLabel = useCallback((id) => {
    const type = ppeTypeById.get(id);
    return type ? pickLocalized(type, 'name', lang) : '';
  }, [ppeTypeById, lang]);

  // Client-side filter over the already-loaded page — loadAssetExtList()
  // takes no search parameter (same shape loadAssetGroups() doesn't either),
  // so there is no server round trip to debounce, matching
  // AssetGroupsAdmin.jsx's own plain-state search rather than
  // AssetsCatalogueAdmin.jsx's debounced one.
  const filteredRows = useMemo(() => {
    const needle = searchInput.trim().toLowerCase();
    if (!needle) return extRows;
    return extRows.filter((row) => {
      const asset = assetsById.get(row.asset_id);
      const haystack = `${asset?.reference || ''} ${pickLocalized(asset, 'name', lang)} ${ppeTypeLabel(row.ppe_type_id)}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [extRows, searchInput, assetsById, lang, ppeTypeLabel]);

  const openDetail = (assetId) => { returnFocusRowIdRef.current = assetId; setSelectedAssetId(assetId); };

  useEffect(() => {
    if (selectedAssetId || !returnFocusRowIdRef.current) return;
    const id = returnFocusRowIdRef.current;
    returnFocusRowIdRef.current = null;
    const target = tableWrapRef.current?.querySelector(`[data-safety-asset-row-id="${id}"]`);
    if (target) target.focus();
    else tableWrapRef.current?.focus();
  }, [selectedAssetId, extRows]);

  if (selectedAssetId) {
    return (
      <SafetyAssetDetailView
        assetId={selectedAssetId}
        tenantId={tenantId}
        ppeTypes={ppeTypes}
        onBack={() => { setSelectedAssetId(null); refresh(); }}
        onChanged={refresh}
      />
    );
  }

  return (
    <div className="admin-content safety-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('safety_module_kicker')}</span>
          <h1><PackageCheck className="admin-title-icon" aria-hidden="true" /> {t('safety_assets_title')}</h1>
          <p>{t('safety_assets_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="primary-button" onClick={() => setAttachOpen(true)}>
            <Plus aria-hidden="true" /> {t('safety_assets_add')}
          </button>
        </div>
      </div>

      <p className="field-note">{t('safety_assets_permission_hint')}</p>

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
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={t('admin_search_placeholder')}
            aria-label={t('action_search')}
          />
        </div>
        <button type="button" className="secondary-button" onClick={refresh}><RefreshCcw aria-hidden="true" /> {t('action_refresh')}</button>
        <span className="result-count">{t('admin_records_count', { count: filteredRows.length })}</span>
      </div>
      {truncated && <p className="field-note">{t('safety_assets_list_truncated_hint')}</p>}

      <div className="data-table-wrap" ref={tableWrapRef} tabIndex={-1}>
        <table className="enterprise-table">
          <thead>
            <tr>
              <th>{t('reference')}</th><th>{t('safety_field_asset')}</th><th>{t('safety_field_ppe_type')}</th>
              <th>{t('safety_field_condition_status')}</th><th>{t('safety_field_expiry_date')}</th>
              <th>{t('safety_field_next_inspection_due')}</th><th aria-label={t('label_actions')} />
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => {
              const asset = assetsById.get(row.asset_id);
              return (
                <tr key={row.id}>
                  <td><code>{asset?.reference || '—'}</code></td>
                  <td>{asset ? pickLocalized(asset, 'name', lang) : '—'}</td>
                  <td>{ppeTypeLabel(row.ppe_type_id) || '—'}</td>
                  <td><SafetyConditionBadge status={row.condition_status} /></td>
                  <td>{row.expiry_date ? formatDate(row.expiry_date, lang) : '—'}</td>
                  <td>{row.next_inspection_due ? formatDate(row.next_inspection_due, lang) : '—'}</td>
                  <td>
                    <div className="table-actions">
                      <button type="button" data-safety-asset-row-id={row.asset_id} title={t('action_details')} aria-label={t('action_details')} onClick={() => openDetail(row.asset_id)}>
                        <Eye aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!loading && !filteredRows.length && (
              <tr>
                <td colSpan={7}>
                  <div className="empty-table"><PackageCheck aria-hidden="true" /><b>{t('label_no_results')}</b></div>
                </td>
              </tr>
            )}
            {loading && <tr><td colSpan={7}>{t('label_loading')}</td></tr>}
          </tbody>
        </table>
      </div>

      {attachOpen && (
        <AssetExtFormModal
          asset={null}
          ppeTypes={ppeTypes}
          onClose={() => setAttachOpen(false)}
          onDone={(assetId) => {
            setAttachOpen(false);
            setNotice({ tone: 'success', text: t('admin_save_done') });
            refresh();
            setSelectedAssetId(assetId);
          }}
        />
      )}
    </div>
  );
};

export default SafetyAssetsAdmin;
