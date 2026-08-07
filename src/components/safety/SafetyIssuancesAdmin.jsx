// Safety Management — PPE Issuance screen (route admin/safety-issuances,
// Safety.Issue / Safety.Manage). The module's most important write screen:
// pick an employee, optionally prefill from a PPE Set, adjust/add items,
// capture the recipient's e-signature, and create the issuance. The detail
// view then tracks each item through Returned/Lost/Damaged/Expired (manual)
// or Replaced (system-generated only, via Reissue), plus Close Issuance,
// its attachments and its Timeline.
//
// Data access only ever goes through src/data/safetyService.js — this
// screen never calls supabase directly. Every RPC's own permission gate
// (Safety.Issue/Safety.Manage, or Assets.Operate/Assets.Manage for any line
// that links a specific asset) is enforced server-side; this screen renders
// the action and surfaces PERMISSION_DENIED/ASSET_PERMISSION_DENIED through
// safetyErrorMessage() if the account may not use it — the same convention
// Assets Management's own AssetsCatalogueAdmin.jsx already documents.

import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Check, ChevronLeft, ChevronRight, ClipboardList, Eye, History, Lock, Paperclip,
  Plus, RefreshCcw, ShieldAlert, Undo2, Wrench, X, CalendarX,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { useDialogA11y } from '../../utils/useDialogA11y';
import { useArabicName } from '../../utils/approval';
import { pickLocalized, formatDate, codeLabel } from '../../utils/localize';
import { loadRecipients } from '../../data/approvalService';
import { loadAssets, loadAssetsByIds } from '../../data/assetsService';
import { attachFile } from '../../lib/platformCore/attachments';
import AttachmentsPanel from '../platform/AttachmentsPanel';
import { SafetyTimelinePanel } from './safetyTimeline';
import SignaturePad from '../SignaturePad';
import {
  ISSUANCE_STATUSES, ISSUANCE_ITEM_MANUAL_STATUSES, safetyErrorMessage,
  loadPpeTypes, loadPpeSets, loadPpeSetItems,
  loadIssuances, loadIssuanceItems, createIssuance,
  updateIssuanceItemStatus, reissueIssuanceItem, closeIssuance,
  listSafetyAttachments, loadSafetyTimeline,
} from '../../data/safetyService';
import './safety.css';

// Mirrors safetyService.js's own internal DEFAULT_PAGE_SIZE / assetsService.js's
// own internal DEFAULT_ASSET_PAGE_SIZE — neither constant is exported, so the
// truncation hints below key off the same 200 both services actually use.
const ISSUANCE_LIST_PAGE_SIZE = 200;
const ASSET_PICKER_PAGE_SIZE = 200;

const ITEM_STATUS_ICONS = {
  Returned: Undo2, Lost: ShieldAlert, Damaged: Wrench, Expired: CalendarX,
};

const BackIcon = () => {
  const { isRtl } = useLanguage();
  const Icon = isRtl ? ChevronRight : ChevronLeft;
  return <Icon aria-hidden="true" />;
};

// Shared id->display-name resolver — was defined independently inside both
// IssuanceDetailView and the list screen below; hoisted once so there is a
// single "employee not found" fallback shape for this file.
const makeEmployeeLabel = (employeeById, employeeName) => (id) => {
  const employee = employeeById.get(id);
  return employee ? employeeName(employee) : (id || '');
};

const rowKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const emptyItemRow = () => ({
  key: rowKey(), ppeTypeId: '', quantity: 1, size: '', expiryDate: '', assetId: '',
});

// ---------------------------------------------------------------------------
// Employee search-and-pick — a debounced live-search filter over the
// already-loaded loadRecipients() directory (that RPC takes no search
// param, so this never re-fetches per keystroke; the debounce still exists
// because a live-search-as-you-type field is expected to have one).
// ---------------------------------------------------------------------------
const EmployeeSearchPicker = ({
  employees, employeeName, value, onChange, placeholder, disabled,
}) => {
  const { t } = useLanguage();
  const [rawSearch, setRawSearch] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(rawSearch), 350);
    return () => window.clearTimeout(timer);
  }, [rawSearch]);

  const selected = employees.find((employee) => employee.id === value);

  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return employees;
    return employees.filter((employee) => employeeName(employee).toLocaleLowerCase().includes(term));
  }, [employees, employeeName, search]);

  if (selected) {
    return (
      <span className="safety-picker-chip">
        {employeeName(selected)}
        <button type="button" onClick={() => onChange('')} aria-label={t('action_clear')} disabled={disabled}>
          <X aria-hidden="true" />
        </button>
      </span>
    );
  }

  return (
    <div className="safety-picker-block">
      <input
        className="form-input"
        value={rawSearch}
        disabled={disabled}
        onChange={(event) => setRawSearch(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      <div className="safety-picker-box">
        {filtered.length === 0 && <p className="safety-picker-empty">{t('label_no_results')}</p>}
        {filtered.map((employee) => (
          <button type="button" key={employee.id} className="safety-picker-row" onClick={() => onChange(employee.id)}>
            {employeeName(employee)}
          </button>
        ))}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// New issuance
// ---------------------------------------------------------------------------
const IssuanceCreateModal = ({
  employees, employeeName, ppeTypes, ppeSets, availableAssets, assetsTruncated, tenantId, onClose, onCreated,
}) => {
  const { t, lang } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const ppeTypeById = useMemo(() => new Map(ppeTypes.map((row) => [row.id, row])), [ppeTypes]);

  const [employeeId, setEmployeeId] = useState('');
  const [ppeSetId, setPpeSetId] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState([emptyItemRow()]);
  // One asset-tracked unit can only ever back one Issued item at a time
  // (safety_issuance_create()'s own ASSET_ALREADY_ISSUED guard) — an asset
  // already picked on another row in this same multi-item form is excluded
  // here so the picker itself cannot offer the same double-issuance the RPC
  // would otherwise reject.
  const selectedAssetIds = useMemo(() => new Set(items.map((row) => row.assetId).filter(Boolean)), [items]);
  const [signatureFile, setSignatureFile] = useState(null);
  const [signaturePreviewUrl, setSignaturePreviewUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The object URL is only ever created here (SignaturePad hands back a
  // fresh in-memory File on every save) and never leaves this modal, so it
  // is revoked on unmount and whenever it is replaced by a redraw.
  useEffect(() => () => { if (signaturePreviewUrl) URL.revokeObjectURL(signaturePreviewUrl); }, [signaturePreviewUrl]);

  const updateRow = (key, patch) => setItems((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const removeRow = (key) => setItems((current) => current.filter((row) => row.key !== key));
  const addRow = () => setItems((current) => [...current, emptyItemRow()]);

  // Prefills from the set's own required lines (loadPpeSetItems) — an
  // explicit replace of whatever draft rows already exist, same "prefill on
  // pick" contract the task itself describes; the admin can still add/edit/
  // remove rows afterwards.
  const onPpeSetChange = async (event) => {
    const id = event.target.value;
    setPpeSetId(id);
    if (!id) return;
    const { data } = await loadPpeSetItems(id);
    setItems((data || []).map((row) => ({
      key: rowKey(), ppeTypeId: row.ppe_type_id, quantity: row.quantity || 1, size: '', expiryDate: '', assetId: '',
    })));
  };

  const onSignatureSave = (file) => {
    setSignatureFile(file);
    setSignaturePreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (!employeeId) { setError(t('safety_issuance_employee_required')); return; }

    // assetId present = Asset-kind (a specific physical instance, so its
    // quantity is always exactly one); assetId absent = a plain consumable
    // line — per the task's own fallback rule, safety_ppe_types carries no
    // item_kind-equivalent column in the shipped schema to read instead.
    const payloadItems = items
      .filter((row) => row.ppeTypeId)
      .map((row) => ({
        ppeTypeId: row.ppeTypeId,
        assetId: row.assetId || null,
        quantity: row.assetId ? 1 : (Number(row.quantity) || 1),
        size: row.size || null,
        expiryDate: row.expiryDate || null,
      }));
    if (!payloadItems.length) { setError(t('safety_err_items_required')); return; }

    setBusy(true);
    const { data, error: createError } = await createIssuance(employeeId, ppeSetId || null, notes.trim() || null, payloadItems);
    if (createError) {
      setBusy(false);
      setError(safetyErrorMessage(t, createError));
      return;
    }

    // The issuance has to exist before attachment_attach() can target it —
    // this is new wiring of the existing SignaturePad/attachFile() pair, not
    // a new upload implementation. A failed attach does not roll back the
    // already-created issuance; the caller surfaces a soft warning instead
    // and the signature can still be added from the Attachments tab.
    let attachFailed = false;
    if (signatureFile && data) {
      const { error: attachError } = await attachFile({
        file: signatureFile, tenantId, area: 'safety', layer: 'Extended', entityType: 'SafetyIssuance', entityId: data,
      });
      attachFailed = Boolean(attachError);
    }
    setBusy(false);
    onCreated(data, attachFailed);
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('safety_issuance_add')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('safety_module_kicker')}</span>
            <h3>{t('safety_issuance_add')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="form-grid">
          <div className="field-label">
            <span>{t('safety_field_employee')}</span>
            <EmployeeSearchPicker
              employees={employees}
              employeeName={employeeName}
              value={employeeId}
              onChange={setEmployeeId}
              placeholder={t('safety_issuance_employee_search_placeholder')}
              disabled={busy}
            />
          </div>

          <label className="field-label">{t('safety_field_ppe_set')}
            <select className="form-input" value={ppeSetId} onChange={onPpeSetChange} disabled={busy}>
              <option value="">{t('admin_not_assigned')}</option>
              {ppeSets.map((set) => (
                <option key={set.id} value={set.id}>{set.code ? `${set.code} · ` : ''}{pickLocalized(set, 'name', lang)}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="safety-items-block">
          <div className="safety-items-head">
            <b>{t('safety_issuance_items_heading')}</b>
            <button type="button" className="secondary-button" onClick={addRow} disabled={busy}>
              <Plus aria-hidden="true" /> {t('safety_issuance_add_item')}
            </button>
          </div>

          {!items.length && <p className="field-note">{t('safety_err_items_required')}</p>}

          {items.length > 0 && (
            <div className="safety-items-table-wrap">
              <table className="safety-items-table">
                <thead>
                  <tr>
                    <th>{t('safety_field_ppe_type')}</th>
                    <th>{t('safety_field_quantity')}</th>
                    <th>{t('safety_field_size')}</th>
                    <th>{t('safety_field_expiry_date')}</th>
                    <th>{t('safety_field_asset')}</th>
                    <th aria-label={t('label_actions')} />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => {
                    const type = ppeTypeById.get(row.ppeTypeId);
                    return (
                      <tr key={row.key}>
                        <td>
                          <select
                            className="form-input"
                            value={row.ppeTypeId}
                            disabled={busy}
                            onChange={(event) => updateRow(row.key, { ppeTypeId: event.target.value })}
                            aria-label={t('safety_field_ppe_type')}
                          >
                            <option value="">{t('label_none')}</option>
                            {ppeTypes.map((pt) => <option key={pt.id} value={pt.id}>{pickLocalized(pt, 'name', lang)}</option>)}
                          </select>
                        </td>
                        <td>
                          <input
                            type="number"
                            min="1"
                            className="form-input"
                            value={row.quantity}
                            disabled={busy || Boolean(row.assetId)}
                            onChange={(event) => updateRow(row.key, { quantity: event.target.value })}
                            aria-label={t('safety_field_quantity')}
                          />
                        </td>
                        <td>
                          {type?.requires_size ? (
                            <input
                              className="form-input"
                              value={row.size}
                              disabled={busy}
                              onChange={(event) => updateRow(row.key, { size: event.target.value })}
                              aria-label={t('safety_field_size')}
                            />
                          ) : <span className="field-note">—</span>}
                        </td>
                        <td>
                          <input
                            type="date"
                            className="form-input"
                            value={row.expiryDate}
                            disabled={busy}
                            onChange={(event) => updateRow(row.key, { expiryDate: event.target.value })}
                            aria-label={t('safety_field_expiry_date')}
                          />
                        </td>
                        <td>
                          <select
                            className="form-input"
                            value={row.assetId}
                            disabled={busy}
                            onChange={(event) => updateRow(row.key, {
                              assetId: event.target.value, quantity: event.target.value ? 1 : row.quantity,
                            })}
                            aria-label={t('safety_field_asset')}
                          >
                            <option value="">{t('label_none')}</option>
                            {availableAssets
                              .filter((asset) => asset.id === row.assetId || !selectedAssetIds.has(asset.id))
                              .map((asset) => (
                                <option key={asset.id} value={asset.id}>{asset.reference} · {pickLocalized(asset, 'name', lang)}</option>
                              ))}
                          </select>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="safety-item-remove"
                            disabled={busy}
                            aria-label={t('safety_issuance_remove_item')}
                            onClick={() => removeRow(row.key)}
                          >
                            <X aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {assetsTruncated && <p className="field-note">{t('safety_issuance_assets_truncated_hint')}</p>}
        </div>

        <label className="field-label">{t('safety_issuance_notes')}
          <textarea className="form-input" value={notes} disabled={busy} onChange={(event) => setNotes(event.target.value)} />
        </label>

        <div className="safety-signature-block">
          <b>{t('safety_issuance_signature_heading')}</b>
          <p className="field-note">{t('safety_issuance_signature_hint')}</p>
          {signatureFile && (
            <span className="safety-signature-captured">
              <Check aria-hidden="true" /> {t('safety_issuance_signature_captured')}
              {signaturePreviewUrl && <img src={signaturePreviewUrl} alt={t('safety_issuance_signature_captured')} />}
            </span>
          )}
          <SignaturePad busy={busy} onSave={onSignatureSave} />
        </div>

        {error && <div className="modal-error"><X aria-hidden="true" />{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>{t('action_cancel')}</button>
          <button className="primary-button" disabled={busy}>{busy ? t('label_loading') : t('action_save')}</button>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Per-item manual status change (Returned/Lost/Damaged/Expired only —
// ISSUANCE_ITEM_MANUAL_STATUSES never offers 'Replaced', that transition is
// system-generated exclusively via reissueIssuanceItem()).
// ---------------------------------------------------------------------------
const ItemStatusModal = ({ item, targetStatus, onClose, onDone }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const label = t('safety_issuance_mark_as', { status: codeLabel(t, 'safety_item_status', targetStatus, targetStatus) });

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { error: statusError } = await updateIssuanceItemStatus(item.id, targetStatus, notes.trim() || null);
    setBusy(false);
    if (statusError) { setError(safetyErrorMessage(t, statusError)); return; }
    onDone();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form className="modal-card" role="dialog" aria-modal="true" aria-label={label} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="modal-heading">
          <div><h3>{label}</h3></div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
        <label className="field-label">{t('safety_issuance_notes')}
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
// Reissue — its own distinct action on a Lost/Damaged/Expired item, not one
// of the manual status choices above.
// ---------------------------------------------------------------------------
const ReissueModal = ({ item, onClose, onDone }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const [newExpiryDate, setNewExpiryDate] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { error: reissueError } = await reissueIssuanceItem(item.id, newExpiryDate || null, notes.trim() || null);
    setBusy(false);
    if (reissueError) { setError(safetyErrorMessage(t, reissueError)); return; }
    onDone();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form className="modal-card" role="dialog" aria-modal="true" aria-label={t('safety_issuance_reissue')} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="modal-heading">
          <div><h3><RefreshCcw aria-hidden="true" /> {t('safety_issuance_reissue')}</h3></div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
        <label className="field-label">{t('safety_field_expiry_date')}
          <input type="date" className="form-input" value={newExpiryDate} onChange={(event) => setNewExpiryDate(event.target.value)} />
        </label>
        <label className="field-label">{t('safety_issuance_notes')}
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

const CloseIssuanceConfirmModal = ({ busy, onClose, onConfirm }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-card confirm-modal" role="dialog" aria-modal="true" aria-label={t('safety_issuance_close')} onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div><h3>{t('safety_issuance_close')}</h3></div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="confirm-body"><Lock aria-hidden="true" /><p>{t('safety_issuance_close_confirm')}</p></div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button type="button" className="primary-button" disabled={busy} onClick={onConfirm}>
            <Lock aria-hidden="true" /> {busy ? t('label_loading') : t('safety_issuance_close')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Items tab
// ---------------------------------------------------------------------------
const IssuanceItemsPanel = ({
  items, loading, ppeTypeById, assetById, lang, locale, onMarkStatus, onReissue,
}) => {
  const { t } = useLanguage();

  if (loading) return <p className="field-note">{t('label_loading')}</p>;
  if (!items.length) return <div className="empty-table compact"><ClipboardList aria-hidden="true" /><b>{t('label_no_results')}</b></div>;

  return (
    <div className="data-table-wrap">
      <table className="enterprise-table">
        <thead>
          <tr>
            <th>{t('safety_field_ppe_type')}</th><th>{t('safety_field_asset')}</th><th>{t('safety_field_quantity')}</th>
            <th>{t('safety_field_size')}</th><th>{t('safety_field_issued_date')}</th><th>{t('safety_field_expiry_date')}</th>
            <th>{t('label_status')}</th><th aria-label={t('label_actions')} />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const type = ppeTypeById.get(item.ppe_type_id);
            const asset = item.asset_id ? assetById.get(item.asset_id) : null;
            return (
              <tr key={item.id}>
                <td>{type ? pickLocalized(type, 'name', lang) : item.ppe_type_id}</td>
                <td>{asset ? asset.reference : t('label_none')}</td>
                <td>{item.quantity}</td>
                <td>{item.size || '—'}</td>
                <td>{formatDate(item.issued_date, locale)}</td>
                <td>{item.expiry_date ? formatDate(item.expiry_date, locale) : '—'}</td>
                <td><span className={`status-badge status-${String(item.status).toLowerCase()}`}>{codeLabel(t, 'safety_item_status', item.status, item.status)}</span></td>
                <td>
                  <div className="table-actions">
                    {item.status === 'Issued' && ISSUANCE_ITEM_MANUAL_STATUSES.map((status) => {
                      const Icon = ITEM_STATUS_ICONS[status] || Check;
                      const label = t('safety_issuance_mark_as', { status: codeLabel(t, 'safety_item_status', status, status) });
                      return (
                        <button key={status} type="button" title={label} aria-label={label} onClick={() => onMarkStatus(item, status)}>
                          <Icon aria-hidden="true" />
                        </button>
                      );
                    })}
                    {['Lost', 'Damaged', 'Expired'].includes(item.status) && (
                      <button type="button" title={t('safety_issuance_reissue')} aria-label={t('safety_issuance_reissue')} onClick={() => onReissue(item)}>
                        <RefreshCcw aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------
const TABS = [
  { id: 'items', labelKey: 'safety_issuance_tab_items', icon: ClipboardList },
  { id: 'attachments', labelKey: 'att_panel_title', icon: Paperclip },
  { id: 'timeline', labelKey: 'safety_issuance_tab_timeline', icon: History },
];

const IssuanceDetailView = ({
  issuance, tenantId, ppeTypeById, ppeSetById, employees, employeeName, onBack, onChanged,
}) => {
  const { t, lang, locale } = useLanguage();

  const [items, setItems] = useState([]);
  const [timeline, setTimeline] = useState([]);
  const [assetById, setAssetById] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [activeTab, setActiveTab] = useState('items');
  const [notice, setNotice] = useState(null);
  const [statusTarget, setStatusTarget] = useState(null); // { item, targetStatus }
  const [reissueTarget, setReissueTarget] = useState(null); // item
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);

  const refresh = useCallback(() => { setLoading(true); setReloadToken((token) => token + 1); }, []);

  // `issuance` itself is the row the parent's own list already holds (there
  // is no singular loadIssuance(id) exported from safetyService.js) — this
  // effect only ever fetches what genuinely needs its own request: items,
  // timeline, and the linked assets those items reference.
  useEffect(() => {
    if (!issuance) return undefined;
    let cancelled = false;
    Promise.all([loadIssuanceItems(issuance.id), loadSafetyTimeline('SafetyIssuance', issuance.id)])
      .then(async ([itemsResult, timelineResult]) => {
        if (cancelled) return;
        if (itemsResult.error) setNotice({ tone: 'error', text: safetyErrorMessage(t, itemsResult.error) });
        const itemRows = itemsResult.data || [];
        setItems(itemRows);
        setTimeline(timelineResult.data || []);
        const assetIds = Array.from(new Set(itemRows.map((row) => row.asset_id).filter(Boolean)));
        if (assetIds.length) {
          const { data: assetRows } = await loadAssetsByIds(assetIds);
          if (!cancelled) setAssetById(new Map((assetRows || []).map((row) => [row.id, row])));
        } else if (!cancelled) {
          setAssetById(new Map());
        }
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [issuance, reloadToken, t]);

  const employeeById = useMemo(() => new Map(employees.map((row) => [row.id, row])), [employees]);
  const employeeLabel = useMemo(() => makeEmployeeLabel(employeeById, employeeName), [employeeById, employeeName]);

  // Moves focus to the detail heading once, the moment this view finishes
  // its first load — same ref-guard convention AssetsCatalogueAdmin.jsx's
  // own AssetDetailView documents for its own headingRef.
  const headingRef = useRef(null);
  const headingFocusedRef = useRef(false);
  useEffect(() => {
    if (!issuance || headingFocusedRef.current) return;
    headingFocusedRef.current = true;
    headingRef.current?.focus();
  }, [issuance]);

  const afterMutate = () => {
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refresh();
    onChanged?.();
  };

  const runClose = async () => {
    setCloseBusy(true);
    const { error } = await closeIssuance(issuance.id);
    setCloseBusy(false);
    if (error) { setNotice({ tone: 'error', text: safetyErrorMessage(t, error) }); return; }
    setCloseConfirmOpen(false);
    afterMutate();
  };

  if (!issuance) {
    return (
      <div className="admin-content safety-content">
        <button type="button" className="secondary-button" onClick={onBack}><BackIcon /> {t('safety_issuance_back_to_list')}</button>
        <p className="field-note">{t('label_loading')}</p>
      </div>
    );
  }

  const closed = issuance.status === 'Closed';

  return (
    <div className="admin-content safety-content">
      <div className="admin-toolbar">
        <button type="button" className="secondary-button" onClick={onBack}><BackIcon /> {t('safety_issuance_back_to_list')}</button>
        <button type="button" className="secondary-button" onClick={refresh}><RefreshCcw aria-hidden="true" /> {t('action_refresh')}</button>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
        </div>
      )}

      <div className="safety-detail-head">
        <div>
          <span className="section-kicker">{t('safety_module_kicker')}</span>
          <h1 ref={headingRef} tabIndex={-1}>{employeeLabel(issuance.employee_id) || issuance.reference}</h1>
          <code className="safety-issuance-reference">{issuance.reference}</code>

          <div className="safety-meta-grid">
            <div className="safety-meta-item"><span>{t('safety_field_employee')}</span><b>{employeeLabel(issuance.employee_id) || t('label_none')}</b></div>
            <div className="safety-meta-item">
              <span>{t('safety_field_ppe_set')}</span>
              <b>{issuance.ppe_set_id ? (pickLocalized(ppeSetById.get(issuance.ppe_set_id), 'name', lang) || issuance.ppe_set_id) : t('label_none')}</b>
            </div>
            <div className="safety-meta-item">
              <span>{t('label_status')}</span>
              <b><span className={`status-badge status-${String(issuance.status).toLowerCase()}`}>{codeLabel(t, 'safety_issuance_status', issuance.status, issuance.status)}</span></b>
            </div>
            <div className="safety-meta-item"><span>{t('safety_field_issued_date')}</span><b>{formatDate(issuance.issued_on, locale)}</b></div>
          </div>

          {issuance.notes && <p className="field-note">{issuance.notes}</p>}
        </div>

        <div className="safety-actions-row">
          {!closed && (
            <button type="button" className="secondary-button" onClick={() => setCloseConfirmOpen(true)}>
              <Lock aria-hidden="true" /> {t('safety_issuance_close')}
            </button>
          )}
        </div>
      </div>
      {!closed && <p className="field-note">{t('safety_issuance_open_items_hint')}</p>}

      <div className="safety-tablist" role="tablist" aria-label={issuance.reference}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`safety-issuance-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`safety-issuance-tabpanel-${tab.id}`}
            className={activeTab === tab.id ? 'active' : ''}
            onClick={() => setActiveTab(tab.id)}
          >
            <tab.icon aria-hidden="true" /> {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div id={`safety-issuance-tabpanel-${activeTab}`} role="tabpanel" aria-labelledby={`safety-issuance-tab-${activeTab}`} className="safety-tab-panel">
        {activeTab === 'items' && (
          <IssuanceItemsPanel
            items={items}
            loading={loading}
            ppeTypeById={ppeTypeById}
            assetById={assetById}
            lang={lang}
            locale={locale}
            onMarkStatus={(item, targetStatus) => setStatusTarget({ item, targetStatus })}
            onReissue={setReissueTarget}
          />
        )}
        {activeTab === 'attachments' && (
          <AttachmentsPanel tenantId={tenantId} entityType="SafetyIssuance" entityId={issuance.id} area="safety" listFn={listSafetyAttachments} />
        )}
        {activeTab === 'timeline' && <SafetyTimelinePanel rows={timeline} loading={loading} />}
      </div>

      {statusTarget && (
        <ItemStatusModal
          item={statusTarget.item}
          targetStatus={statusTarget.targetStatus}
          onClose={() => setStatusTarget(null)}
          onDone={() => { setStatusTarget(null); afterMutate(); }}
        />
      )}
      {reissueTarget && (
        <ReissueModal
          item={reissueTarget}
          onClose={() => setReissueTarget(null)}
          onDone={() => { setReissueTarget(null); afterMutate(); }}
        />
      )}
      {closeConfirmOpen && (
        <CloseIssuanceConfirmModal busy={closeBusy} onClose={() => setCloseConfirmOpen(false)} onConfirm={runClose} />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// List / screen
// ---------------------------------------------------------------------------
const SafetyIssuancesAdmin = () => {
  const { t, lang, locale } = useLanguage();
  const { tenant } = useTenant();
  const tenantId = tenant?.id || null;
  const { employeeName } = useArabicName();

  const [employees, setEmployees] = useState([]);
  const [ppeTypes, setPpeTypes] = useState([]);
  const [ppeSets, setPpeSets] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [notice, setNotice] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [availableAssets, setAvailableAssets] = useState([]);
  const [assetsTruncated, setAssetsTruncated] = useState(false);

  // Which row's Eye button opened the detail view, so onBack can return
  // focus to it — same convention AssetsCatalogueAdmin.jsx's own
  // returnFocusRowIdRef documents.
  const returnFocusRowIdRef = useRef(null);
  const tableWrapRef = useRef(null);

  const refreshList = useCallback(() => { setLoading(true); setReloadToken((token) => token + 1); }, []);

  // Dropdown/lookup sources — each loaded through its own already-established
  // service, never requeried here, each degrading to an empty list on
  // failure rather than blocking the screen.
  useEffect(() => {
    let cancelled = false;
    Promise.all([loadRecipients().catch(() => []), loadPpeTypes(), loadPpeSets()])
      .then(([employeeRows, typesResult, setsResult]) => {
        if (cancelled) return;
        setEmployees(employeeRows || []);
        setPpeTypes(typesResult.data || []);
        setPpeSets(setsResult.data || []);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadIssuances({ status: statusFilter || undefined, employeeId: employeeFilter || undefined, limit: ISSUANCE_LIST_PAGE_SIZE })
      .then(({ data, error }) => {
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
  }, [statusFilter, employeeFilter, reloadToken, t]);

  useEffect(() => {
    if (selectedId || !returnFocusRowIdRef.current) return;
    const id = returnFocusRowIdRef.current;
    returnFocusRowIdRef.current = null;
    const target = tableWrapRef.current?.querySelector(`[data-issuance-row-id="${id}"]`);
    if (target) target.focus();
    else tableWrapRef.current?.focus();
  }, [selectedId, rows]);

  const ppeTypeById = useMemo(() => new Map(ppeTypes.map((row) => [row.id, row])), [ppeTypes]);
  const ppeSetById = useMemo(() => new Map(ppeSets.map((row) => [row.id, row])), [ppeSets]);
  const employeeById = useMemo(() => new Map(employees.map((row) => [row.id, row])), [employees]);
  const employeeLabel = useMemo(() => makeEmployeeLabel(employeeById, employeeName), [employeeById, employeeName]);

  const openDetail = (id) => { returnFocusRowIdRef.current = id; setSelectedId(id); };

  // Loaded fresh (Available only) every time the create dialog opens, same
  // "genuine browse, never a stale filtered list" reasoning
  // AssetsCatalogueAdmin.jsx's own openCreate() documents for its parent
  // candidates fetch.
  const openCreate = () => {
    setCreateOpen(true);
    loadAssets({ status: 'Available' }).then(({ data }) => {
      const list = data || [];
      setAvailableAssets(list);
      setAssetsTruncated(list.length >= ASSET_PICKER_PAGE_SIZE);
    });
  };

  const onCreated = (issuanceId, signatureAttachFailed) => {
    setCreateOpen(false);
    setNotice({
      tone: signatureAttachFailed ? 'error' : 'success',
      text: signatureAttachFailed ? t('safety_issuance_signature_attach_failed') : t('admin_save_done'),
    });
    refreshList();
    if (issuanceId) openDetail(issuanceId);
  };

  const selectedIssuance = useMemo(() => rows.find((row) => row.id === selectedId) || null, [rows, selectedId]);

  if (selectedId) {
    return (
      <IssuanceDetailView
        issuance={selectedIssuance}
        tenantId={tenantId}
        ppeTypeById={ppeTypeById}
        ppeSetById={ppeSetById}
        employees={employees}
        employeeName={employeeName}
        onBack={() => { setSelectedId(null); refreshList(); }}
        onChanged={refreshList}
      />
    );
  }

  return (
    <div className="admin-content safety-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('safety_module_kicker')}</span>
          <h1><ClipboardList className="admin-title-icon" aria-hidden="true" /> {t('safety_issuance_title')}</h1>
          <p>{t('safety_issuance_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="primary-button" onClick={openCreate}>
            <Plus aria-hidden="true" /> {t('safety_issuance_add')}
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
          onChange={(event) => { setStatusFilter(event.target.value); setLoading(true); }}
          aria-label={t('label_status')}
        >
          <option value="">{t('safety_issuance_filter_all_statuses')}</option>
          {ISSUANCE_STATUSES.map((status) => <option key={status} value={status}>{codeLabel(t, 'safety_issuance_status', status, status)}</option>)}
        </select>

        <EmployeeSearchPicker
          employees={employees}
          employeeName={employeeName}
          value={employeeFilter}
          onChange={(id) => { setEmployeeFilter(id); setLoading(true); }}
          placeholder={t('safety_issuance_employee_search_placeholder')}
        />

        <span className="result-count">{t('admin_records_count', { count: rows.length })}</span>
      </div>
      {rows.length >= ISSUANCE_LIST_PAGE_SIZE && <p className="field-note">{t('safety_issuance_list_truncated_hint')}</p>}

      <div className="data-table-wrap" ref={tableWrapRef} tabIndex={-1}>
        <table className="enterprise-table">
          <thead>
            <tr>
              <th>{t('reference')}</th><th>{t('safety_field_employee')}</th><th>{t('safety_field_ppe_set')}</th>
              <th>{t('label_status')}</th><th>{t('safety_field_issued_date')}</th><th aria-label={t('label_actions')} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td><code>{row.reference}</code></td>
                <td>{employeeLabel(row.employee_id) || t('label_none')}</td>
                <td>{row.ppe_set_id ? (pickLocalized(ppeSetById.get(row.ppe_set_id), 'name', lang) || row.ppe_set_id) : t('label_none')}</td>
                <td><span className={`status-badge status-${String(row.status).toLowerCase()}`}>{codeLabel(t, 'safety_issuance_status', row.status, row.status)}</span></td>
                <td>{formatDate(row.issued_on, locale)}</td>
                <td>
                  <div className="table-actions">
                    <button type="button" data-issuance-row-id={row.id} title={t('action_details')} aria-label={t('action_details')} onClick={() => openDetail(row.id)}>
                      <Eye aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && !rows.length && (
              <tr>
                <td colSpan={6}>
                  <div className="empty-table"><ClipboardList aria-hidden="true" /><b>{t('label_no_results')}</b></div>
                </td>
              </tr>
            )}
            {loading && <tr><td colSpan={6}>{t('label_loading')}</td></tr>}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <IssuanceCreateModal
          employees={employees}
          employeeName={employeeName}
          ppeTypes={ppeTypes}
          ppeSets={ppeSets}
          availableAssets={availableAssets}
          assetsTruncated={assetsTruncated}
          tenantId={tenantId}
          onClose={() => setCreateOpen(false)}
          onCreated={onCreated}
        />
      )}
    </div>
  );
};

export default SafetyIssuancesAdmin;
