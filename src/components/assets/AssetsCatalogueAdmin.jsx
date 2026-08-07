// Assets Catalogue — the company-wide admin screen for the Assets Management
// module, and its largest one: search/filter the whole registry, create an
// asset, and — the most important part — the full detail view with the
// Timeline, transaction actions, reservations, maintenance history, QR/
// barcode, a printable asset tag, and the disposal-to-approval handoff.
//
// Data access only ever goes through src/data/assetsService.js (never
// supabase directly), the same {data, error} envelope every sibling service
// already uses. Every RPC's own permission gate (Assets.Manage/Operate/
// Maintain, or "being the current custodian"/"being the reporter") is
// enforced server-side; this screen does not attempt to re-derive those
// permissions client-side — same convention ApprovalAdmin.jsx and every
// other dense admin screen already use — it renders the action and surfaces
// PERMISSION_DENIED through assetsErrorMessage() if the account may not use
// it, rather than guessing at a role check with no client-side permission
// list to check it against.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight, Boxes, CalendarClock, Check, ChevronLeft, ChevronRight, Eye, History, Layers,
  Link2, ListChecks, Package, PackageCheck, PackageMinus, PackagePlus, Paperclip, Pencil, Plus,
  Printer, Recycle, RefreshCcw, Search, ShieldAlert, Tag, Undo2, Unlock, Wrench, X, XCircle,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { useAuth } from '../../context/AuthContext';
import { useDialogA11y } from '../../utils/useDialogA11y';
import { useArabicName } from '../../utils/approval';
import { pickLocalized, formatDate, formatDateTime, codeLabel } from '../../utils/localize';
import { loadRecipients } from '../../data/approvalService';
import { loadOrgDimensions } from '../../data/orgDimensionsService';
import AttachmentsPanel from '../platform/AttachmentsPanel';
import EntityQrCode from '../platform/EntityQrCode';
import { AssetStatusBadge, AssetTimelinePanel } from './AssetShared';
import { SendApprovalModal } from '../ApprovalChain';
import { encodeCode128B, code128Bars } from '../../lib/platformCore/code128';
import {
  ASSET_STATUSES, assetsErrorMessage,
  loadAssetGroups, loadCustodyUnits, loadAssets, loadAsset, createAsset, updateAsset,
  loadAssetTransactions, receiveAsset, issueAsset, transferAsset, returnAsset,
  reportAssetLost, reportAssetFound, createAssetTransaction,
  loadAssetReservations, reserveAsset, releaseAssetReservation,
  loadAssetMaintenance, reportAssetMaintenance, approveAssetMaintenance, advanceAssetMaintenance,
  loadAssetDisposalTemplateId, requestAssetDisposal,
  loadAssetTimeline, listAssetAttachments,
} from '../../data/assetsService';
import './assets.css';

// ---------------------------------------------------------------------------
// A low-level Code 128 SVG renderer wrapped as one small local component —
// same "one component wraps the encoder" pattern EntityQrCode.jsx already is
// for qrcode.react, and VerifiedSeal.jsx's own VerificationQr for that. There
// is no shared Barcode component elsewhere in the app to reuse.
// ---------------------------------------------------------------------------
const AssetBarcode = ({ value, height = 40, moduleWidth = 2, className = '' }) => {
  const { t } = useLanguage();
  if (!value) return null;
  const { widths, error } = encodeCode128B(value);
  if (error) return null;
  const { bars, totalWidth } = code128Bars(widths, moduleWidth);

  return (
    <svg
      className={`asset-barcode ${className}`}
      viewBox={`0 0 ${totalWidth} ${height}`}
      width={totalWidth}
      height={height}
      role="img"
      aria-label={t('barcode_aria', { value })}
    >
      <rect x="0" y="0" width={totalWidth} height={height} fill="#ffffff" />
      {bars.map((bar) => <rect key={bar.x} x={bar.x} y="0" width={bar.width} height={height} fill="#0b1b2b" />)}
    </svg>
  );
};

const BackIcon = () => {
  const { isRtl } = useLanguage();
  const Icon = isRtl ? ChevronRight : ChevronLeft;
  return <Icon aria-hidden="true" />;
};

/** The single entry point behind all eight quick custody actions. Reserve and
 * Release have no dedicated wrapper in assetsService.js (they are log-only
 * entries per the migration's own comment on asset_transaction_create) so
 * they go through createAssetTransaction() directly, same RPC as the rest. */
const runAssetTransaction = (assetId, type, opts) => {
  switch (type) {
    case 'Receive': return receiveAsset(assetId, opts);
    case 'Issue': return issueAsset(assetId, opts);
    case 'Transfer': return transferAsset(assetId, opts);
    case 'Return': return returnAsset(assetId, opts);
    case 'Lost': return reportAssetLost(assetId, opts.reason);
    case 'Found': return reportAssetFound(assetId, opts);
    default: return createAssetTransaction(assetId, type, opts);
  }
};

// Which fields actually affect each transaction type server-side (mirrors
// asset_transaction_create()'s own branches exactly — Reserve/Release only
// ever store `reason`, Issue requires a target custodian, etc.) so the modal
// never offers a field that would silently be ignored.
const TXN_FIELDS = {
  Receive: { custodyUnit: true, custodian: false },
  Issue: { custodyUnit: false, custodian: true },
  Transfer: { custodyUnit: true, custodian: true },
  Return: { custodyUnit: true, custodian: false },
  Lost: { custodyUnit: false, custodian: false },
  Found: { custodyUnit: true, custodian: false },
  Reserve: { custodyUnit: false, custodian: false },
  Release: { custodyUnit: false, custodian: false },
};

const TXN_TITLE_KEYS = {
  Receive: 'asset_action_receive', Issue: 'asset_action_issue', Transfer: 'asset_action_transfer',
  Return: 'asset_action_return', Lost: 'asset_action_report_lost', Found: 'asset_action_report_found',
  Reserve: 'asset_action_reserve', Release: 'asset_action_release',
};

const TXN_ICONS = {
  Receive: PackagePlus, Issue: PackageMinus, Transfer: ArrowLeftRight, Return: Undo2,
  Lost: ShieldAlert, Found: PackageCheck, Reserve: CalendarClock, Release: Unlock,
};

// Mirrors assetsService.js's own DEFAULT_ASSET_PAGE_SIZE — the unfiltered
// parent-asset pickers below never pass their own limit, so a full page back
// means the catalogue may hold more than what's shown.
const ASSET_PICKER_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Create / edit asset form
// ---------------------------------------------------------------------------
const emptyAssetDraft = () => ({
  id: null, group_id: '', name_ar: '', name_en: '', color: '', brand: '', model: '', serial_no: '',
  imei: '', manufacturer: '', purchase_date: '', warranty_until: '', supplier: '', parent_asset_id: '',
  notes: '', initial_custody_unit_id: '',
});

const toAssetDraft = (row) => ({
  id: row.id, group_id: row.group_id || '', name_ar: row.name_ar || '', name_en: row.name_en || '',
  color: row.color || '', brand: row.brand || '', model: row.model || '', serial_no: row.serial_no || '',
  imei: row.imei || '', manufacturer: row.manufacturer || '', purchase_date: row.purchase_date || '',
  warranty_until: row.warranty_until || '', supplier: row.supplier || '', parent_asset_id: row.parent_asset_id || '',
  notes: row.notes || '', initial_custody_unit_id: '',
});

const AssetFormModal = ({ draft, groups, custodyUnits, parentOptions, parentOptionsTruncated, busy, error, onChange, onClose, onSubmit }) => {
  const { t, lang } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const set = (key) => (event) => onChange({ ...draft, [key]: event.target.value });

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? t('action_edit') : t('assets_catalogue_add')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('assets_module_kicker')}</span>
            <h3>{draft.id ? t('action_edit') : t('assets_catalogue_add')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="form-grid">
          <label className="field-label">{t('label_name_1')}
            <input required className="form-input" value={draft.name_ar || ''} onChange={set('name_ar')} />
          </label>
          <label className="field-label">{t('label_name_2')}
            <input className="form-input" value={draft.name_en || ''} onChange={set('name_en')} />
          </label>

          <label className="field-label">{t('asset_group')}
            <select className="form-input" value={draft.group_id || ''} onChange={set('group_id')}>
              <option value="">{t('admin_not_assigned')}</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>{group.code} · {pickLocalized(group, 'name', lang)}</option>
              ))}
            </select>
          </label>

          {!draft.id && (
            <label className="field-label">{t('asset_field_initial_custody_unit')}
              <select className="form-input" value={draft.initial_custody_unit_id || ''} onChange={set('initial_custody_unit_id')}>
                <option value="">{t('admin_not_assigned')}</option>
                {custodyUnits.map((unit) => (
                  <option key={unit.id} value={unit.id}>{unit.code} · {pickLocalized(unit, 'name', lang)}</option>
                ))}
              </select>
            </label>
          )}

          <label className="field-label">{t('asset_field_parent_asset')}
            <select className="form-input" value={draft.parent_asset_id || ''} onChange={set('parent_asset_id')}>
              <option value="">{t('admin_not_assigned')}</option>
              {parentOptions.map((row) => (
                <option key={row.id} value={row.id}>{row.reference} · {pickLocalized(row, 'name', lang)}</option>
              ))}
            </select>
            {parentOptionsTruncated && <p className="field-note">{t('assets_picker_truncated_hint')}</p>}
          </label>

          <label className="field-label">{t('asset_field_color')}
            <input className="form-input" value={draft.color || ''} onChange={set('color')} />
          </label>
          <label className="field-label">{t('asset_field_brand')}
            <input className="form-input" value={draft.brand || ''} onChange={set('brand')} />
          </label>
          <label className="field-label">{t('asset_field_model')}
            <input className="form-input" value={draft.model || ''} onChange={set('model')} />
          </label>
          <label className="field-label">{t('asset_field_serial_no')}
            <input className="form-input" value={draft.serial_no || ''} onChange={set('serial_no')} />
          </label>
          <label className="field-label">{t('asset_field_imei')}
            <input className="form-input" value={draft.imei || ''} onChange={set('imei')} />
          </label>
          <label className="field-label">{t('asset_field_manufacturer')}
            <input className="form-input" value={draft.manufacturer || ''} onChange={set('manufacturer')} />
          </label>
          <label className="field-label">{t('asset_field_purchase_date')}
            <input type="date" className="form-input" value={draft.purchase_date || ''} onChange={set('purchase_date')} />
          </label>
          <label className="field-label">{t('asset_field_warranty_until')}
            <input type="date" className="form-input" value={draft.warranty_until || ''} onChange={set('warranty_until')} />
          </label>
          <label className="field-label">{t('asset_field_supplier')}
            <input className="form-input" value={draft.supplier || ''} onChange={set('supplier')} />
          </label>

          <label className="field-label field-span-2">{t('asset_field_notes')}
            <textarea className="form-input" value={draft.notes || ''} onChange={set('notes')} />
          </label>
        </div>

        <p className="field-note">{t('admin_name_pair_hint')}</p>

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
// Quick transaction modal — shared by all eight Receive/Issue/Transfer/
// Return/Lost/Found/Reserve/Release buttons on the detail view.
// ---------------------------------------------------------------------------
const AssetTransactionModal = ({ asset, type, employees, custodyUnits, onClose, onDone }) => {
  const { t, lang } = useLanguage();
  const { employeeName } = useArabicName();
  const closeRef = useDialogA11y(onClose);
  const config = TXN_FIELDS[type] || {};
  const Icon = TXN_ICONS[type] || Package;
  const [toCustodianUserId, setToCustodianUserId] = useState('');
  const [toCustodyUnitId, setToCustodyUnitId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    // Transfer supports two distinct moves — person-to-person (pending
    // acceptance) or custody-unit-to-custody-unit (immediate) — so unlike
    // Issue, its target custodian isn't unconditionally required; at least
    // one target has to be picked, though.
    if (type === 'Transfer' && !toCustodianUserId && !toCustodyUnitId) {
      setError(t('assets_transfer_target_required'));
      return;
    }
    setBusy(true);
    const opts = {
      toCustodianUserId: config.custodian && toCustodianUserId ? toCustodianUserId : null,
      toCustodyUnitId: config.custodyUnit && toCustodyUnitId ? toCustodyUnitId : null,
      reason: reason.trim() || null,
    };
    const { error: txnError } = await runAssetTransaction(asset.id, type, opts);
    setBusy(false);
    if (txnError) { setError(assetsErrorMessage(t, txnError)); return; }
    onDone();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form className="modal-card" role="dialog" aria-modal="true" aria-label={t(TXN_TITLE_KEYS[type])} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{asset.reference}</span>
            <h3><Icon aria-hidden="true" /> {t(TXN_TITLE_KEYS[type])}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        {config.custodian && (
          <label className="field-label">{t('asset_field_target_custodian')}
            <select required={type === 'Issue'} className="form-input" value={toCustodianUserId} onChange={(event) => setToCustodianUserId(event.target.value)}>
              <option value="">{t('select_employee_placeholder')}</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employeeName(employee)}</option>)}
            </select>
          </label>
        )}

        {config.custodyUnit && (
          <label className="field-label">{t('asset_field_target_custody_unit')}
            <select className="form-input" value={toCustodyUnitId} onChange={(event) => setToCustodyUnitId(event.target.value)}>
              <option value="">{t('admin_not_assigned')}</option>
              {custodyUnits.map((unit) => (
                <option key={unit.id} value={unit.id}>{unit.code} · {pickLocalized(unit, 'name', lang)}</option>
              ))}
            </select>
          </label>
        )}

        <label className="field-label">{t('asset_field_reason')}
          <textarea className="form-input" value={reason} onChange={(event) => setReason(event.target.value)} />
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
// Request Disposal — collects a reason, opens the Draft form asset_dispose_
// request() returns, then the caller (AssetDetailView) hands off to the
// existing SendApprovalModal, exactly the FormsPortal.jsx openSend() flow.
// ---------------------------------------------------------------------------
const DisposalRequestModal = ({ asset, onClose, onRequested }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { data, error: reqError } = await requestAssetDisposal(asset.id, reason.trim() || null);
    setBusy(false);
    if (reqError) { setError(assetsErrorMessage(t, reqError)); return; }
    onRequested(data);
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form className="modal-card" role="dialog" aria-modal="true" aria-label={t('asset_action_request_disposal')} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{asset.reference}</span>
            <h3><Recycle aria-hidden="true" /> {t('asset_action_request_disposal')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
        <p className="field-note">{t('assets_disposal_hint')}</p>
        <label className="field-label">{t('asset_field_reason')}
          <textarea className="form-input" value={reason} onChange={(event) => setReason(event.target.value)} />
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
// New reservation — the date-scoped booking (asset_reserve), distinct from
// the log-only "Reserve" quick action above: this is what the Reservations
// panel's own Release actions release.
// ---------------------------------------------------------------------------
const NewReservationModal = ({ asset, employees, projects, onClose, onDone }) => {
  const { t, lang } = useLanguage();
  const { employeeName } = useArabicName();
  const closeRef = useDialogA11y(onClose);
  const [reservedForUserId, setReservedForUserId] = useState('');
  const [reservedForProjectId, setReservedForProjectId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { error: reserveError } = await reserveAsset(asset.id, {
      startDate, endDate,
      reservedForUserId: reservedForUserId || null,
      reservedForProjectId: reservedForProjectId || null,
      purpose: purpose.trim() || null,
    });
    setBusy(false);
    if (reserveError) { setError(assetsErrorMessage(t, reserveError)); return; }
    onDone();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form className="modal-card" role="dialog" aria-modal="true" aria-label={t('assets_reservation_new')} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{asset.reference}</span>
            <h3><CalendarClock aria-hidden="true" /> {t('assets_reservation_new')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="form-grid">
          <label className="field-label">{t('asset_field_start_date')}
            <input required type="date" className="form-input" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <label className="field-label">{t('asset_field_end_date')}
            <input required type="date" className="form-input" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </label>
          <label className="field-label">{t('asset_field_reserved_for_user')}
            <select className="form-input" value={reservedForUserId} onChange={(event) => setReservedForUserId(event.target.value)}>
              <option value="">{t('admin_not_assigned')}</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employeeName(employee)}</option>)}
            </select>
          </label>
          <label className="field-label">{t('asset_field_reserved_for_project')}
            <select className="form-input" value={reservedForProjectId} onChange={(event) => setReservedForProjectId(event.target.value)}>
              <option value="">{t('admin_not_assigned')}</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{pickLocalized(project, 'name', lang, project.code)}</option>)}
            </select>
          </label>
          <label className="field-label field-span-2">{t('asset_field_purpose')}
            <textarea className="form-input" value={purpose} onChange={(event) => setPurpose(event.target.value)} />
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
// Release-reservation confirmation — a lightweight confirm step (the parent
// already owns the busy/error state via reservationBusyId/notice, same
// prop-driven shape FormsPortal.jsx's own ConfirmCancelModal uses for a
// single-click destructive action that needs no captured reason).
// ---------------------------------------------------------------------------
const ConfirmReleaseReservationModal = ({ busy, onClose, onConfirm }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-card confirm-modal" role="dialog" aria-modal="true" aria-label={t('asset_action_release')} onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div><h3>{t('asset_action_release')}</h3></div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="confirm-body"><Unlock aria-hidden="true" /><p>{t('assets_release_reservation_confirm')}</p></div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button type="button" className="secondary-button danger" disabled={busy} onClick={onConfirm}>
            <Unlock aria-hidden="true" /> {busy ? t('label_loading') : t('asset_action_release')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Report Maintenance — no permission gate at all (any tenant member), per
// both the spec and asset_maintenance_report()'s own comment.
// ---------------------------------------------------------------------------
const ReportMaintenanceModal = ({ asset, onClose, onDone }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const [issueDescription, setIssueDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { error: reportError } = await reportAssetMaintenance(asset.id, issueDescription.trim());
    setBusy(false);
    if (reportError) { setError(assetsErrorMessage(t, reportError)); return; }
    onDone();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form className="modal-card" role="dialog" aria-modal="true" aria-label={t('assets_maintenance_report')} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{asset.reference}</span>
            <h3><Wrench aria-hidden="true" /> {t('assets_maintenance_report')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
        <label className="field-label">{t('asset_field_issue_description')}
          <textarea required className="form-input" value={issueDescription} onChange={(event) => setIssueDescription(event.target.value)} />
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

// Advancing to 'Sent' or 'Completed' collects a couple of extra fields; every
// other transition (UnderMaintenance/Returned/Closed/Rejected/Approve) needs
// none and runs directly from its button — see runMaintenanceAction() below.
const MaintenanceAdvanceModal = ({ caseRow, targetStatus, onClose, onDone }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const [vendorText, setVendorText] = useState('');
  const [expectedReturnDate, setExpectedReturnDate] = useState('');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { error: advanceError } = await advanceAssetMaintenance(caseRow.id, targetStatus, {
      vendorText: targetStatus === 'Sent' ? (vendorText.trim() || null) : null,
      expectedReturnDate: targetStatus === 'Sent' ? (expectedReturnDate || null) : null,
      cost: targetStatus === 'Completed' && cost !== '' ? Number(cost) : null,
      notes: targetStatus === 'Completed' ? (notes.trim() || null) : null,
    });
    setBusy(false);
    if (advanceError) { setError(assetsErrorMessage(t, advanceError)); return; }
    onDone();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={t('assets_advance_to', { status: codeLabel(t, 'asset_maint_status', targetStatus, targetStatus) })}
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{caseRow.reference}</span>
            <h3>{t('assets_advance_to', { status: codeLabel(t, 'asset_maint_status', targetStatus, targetStatus) })}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
        {targetStatus === 'Sent' && (
          <>
            <label className="field-label">{t('asset_field_vendor_text')}
              <input className="form-input" value={vendorText} onChange={(event) => setVendorText(event.target.value)} />
            </label>
            <label className="field-label">{t('asset_field_expected_return_date')}
              <input type="date" className="form-input" value={expectedReturnDate} onChange={(event) => setExpectedReturnDate(event.target.value)} />
            </label>
          </>
        )}
        {targetStatus === 'Completed' && (
          <>
            <label className="field-label">{t('asset_field_cost')}
              <input type="number" min="0" step="0.01" className="form-input" value={cost} onChange={(event) => setCost(event.target.value)} />
            </label>
            <label className="field-label">{t('asset_field_notes')}
              <textarea className="form-input" value={notes} onChange={(event) => setNotes(event.target.value)} />
            </label>
          </>
        )}
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
// Reject-maintenance confirmation — the destructive twin of Approve, same
// "confirm before an irreversible action" shape AssetsPortal.jsx's own
// ConfirmRejectModal already uses for rejecting a transfer (confirm text +
// an explicit "keep it" escape hatch), extended with a reason field so
// advanceAssetMaintenance()'s own notes parameter is actually populated for
// this path — self-contained submit, same convention every other modal in
// this file already follows.
// ---------------------------------------------------------------------------
const ConfirmMaintenanceRejectModal = ({ caseRow, onClose, onDone }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { error: rejectError } = await advanceAssetMaintenance(caseRow.id, 'Rejected', { notes: reason.trim() || null });
    setBusy(false);
    if (rejectError) { setError(assetsErrorMessage(t, rejectError)); return; }
    onDone();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('action_reject')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{caseRow.reference}</span>
            <h3>{t('action_reject')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="confirm-body"><XCircle aria-hidden="true" /><p>{t('assets_maintenance_reject_confirm')}</p></div>
        <label className="field-label">{t('asset_field_reason')}
          <textarea className="form-input" value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        {error && <div className="modal-error"><X aria-hidden="true" />{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('assets_maintenance_reject_keep')}</button>
          <button type="submit" className="secondary-button danger" disabled={busy}>
            <XCircle aria-hidden="true" /> {busy ? t('label_loading') : t('action_reject')}
          </button>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Printable asset tag — reference + QR + barcode + name, meant to be
// physically stuck on the asset. Same body-class print-isolation convention
// CertificatePreview (verification.css) already uses for its own print area.
// ---------------------------------------------------------------------------
const AssetTagModal = ({ asset, onClose }) => {
  const { t, lang } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (!printing) return undefined;
    document.body.classList.add('assets-printing');
    const timer = setTimeout(() => { window.print(); setPrinting(false); }, 60);
    return () => { clearTimeout(timer); document.body.classList.remove('assets-printing'); };
  }, [printing]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={t('assets_tag_title')} onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading no-print">
          <div>
            <span className="section-kicker">{asset.reference}</span>
            <h3><Tag aria-hidden="true" /> {t('assets_tag_title')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="assets-tag-print-area">
          <div className="assets-tag-card">
            <b className="assets-tag-name">{pickLocalized(asset, 'name', lang)}</b>
            <EntityQrCode value={asset.reference} size={112} title={t('asset_qr_aria', { reference: asset.reference })} />
            <AssetBarcode value={asset.reference} height={38} />
            <code className="assets-tag-reference">{asset.reference}</code>
          </div>
        </div>

        <p className="field-note no-print">{t('assets_tag_hint')}</p>

        <div className="modal-actions no-print">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_close')}</button>
          <button type="button" className="primary-button" onClick={() => setPrinting(true)} disabled={printing}>
            <Printer aria-hidden="true" /> {t('action_print')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Raw transaction history — the ledger asset_timeline() reads to build the
// human-readable Timeline above; shown here as its own tab for whoever needs
// the unfiltered log (every column of public.asset_transactions).
// ---------------------------------------------------------------------------
const AssetTransactionsPanel = ({ rows, loading, employeeLabel, custodyUnitLabel }) => {
  const { t, locale } = useLanguage();

  if (loading) return <p className="field-note">{t('label_loading')}</p>;
  if (!rows.length) return <div className="empty-table compact"><ListChecks aria-hidden="true" /><b>{t('label_no_results')}</b></div>;

  return (
    <div className="data-table-wrap">
      <table className="enterprise-table">
        <thead>
          <tr>
            <th>{t('label_type')}</th><th>{t('label_status')}</th><th>{t('assets_col_from')}</th>
            <th>{t('assets_col_to')}</th><th>{t('asset_field_reason')}</th>
            <th>{t('assets_col_performed_by')}</th><th>{t('assets_col_performed_on')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{codeLabel(t, 'asset_txn_type', row.transaction_type, row.transaction_type)}</td>
              <td><span className={`status-badge status-${String(row.status).toLowerCase()}`}>{codeLabel(t, 'asset_txn_status', row.status, row.status)}</span></td>
              <td>{employeeLabel(row.from_custodian_user_id) || custodyUnitLabel(row.from_custody_unit_id) || t('label_none')}</td>
              <td>{employeeLabel(row.to_custodian_user_id) || custodyUnitLabel(row.to_custody_unit_id) || t('label_none')}</td>
              <td>{row.reason || '—'}</td>
              <td>{employeeLabel(row.performed_by) || '—'}</td>
              <td>{formatDateTime(row.performed_on, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Reservations panel — date-scoped bookings (asset_reserve), with Release.
// ---------------------------------------------------------------------------
const AssetReservationsPanel = ({ rows, loading, employeeLabel, projectLabel, onNew, onRelease, busyId }) => {
  const { t, locale } = useLanguage();

  return (
    <div>
      <div className="assets-actions-row">
        <button type="button" className="primary-button" onClick={onNew}>
          <CalendarClock aria-hidden="true" /> {t('assets_reservation_new')}
        </button>
      </div>

      {loading && <p className="field-note">{t('label_loading')}</p>}
      {!loading && !rows.length && <div className="empty-table compact"><CalendarClock aria-hidden="true" /><b>{t('label_no_results')}</b></div>}

      {!loading && rows.length > 0 && (
        <div className="data-table-wrap">
          <table className="enterprise-table">
            <thead>
              <tr>
                <th>{t('asset_field_reserved_for_user')}</th><th>{t('asset_field_reserved_for_project')}</th>
                <th>{t('asset_field_purpose')}</th><th>{t('label_from')}</th><th>{t('label_to')}</th>
                <th>{t('label_status')}</th><th aria-label={t('label_actions')} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{employeeLabel(row.reserved_for_user_id) || t('label_none')}</td>
                  <td>{projectLabel(row.reserved_for_project_id) || t('label_none')}</td>
                  <td>{row.purpose || '—'}</td>
                  <td>{formatDate(row.start_date, locale)}</td>
                  <td>{formatDate(row.end_date, locale)}</td>
                  <td><span className={`status-badge status-${String(row.status).toLowerCase()}`}>{codeLabel(t, 'asset_reservation_status', row.status, row.status)}</span></td>
                  <td>
                    {row.status === 'Active' && (
                      <div className="table-actions">
                        <button type="button" disabled={busyId === row.id} title={t('asset_action_release')} aria-label={t('asset_action_release')} onClick={() => onRelease(row.id)}>
                          <Unlock aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Maintenance panel — each case's own mini-lifecycle. Buttons are always
// rendered (never hidden by a guessed client-side permission); the RPC's own
// dual-authorization (Assets.Maintain/Manage, or the reporter for Under
// Maintenance/Completed) is the real gate and its PERMISSION_DENIED surfaces
// through assetsErrorMessage() exactly like every other write in this app.
// ---------------------------------------------------------------------------
const MAINTENANCE_NEXT = {
  Reported: ['Approve', 'Rejected'],
  Approved: ['Sent', 'Rejected'],
  Sent: ['UnderMaintenance'],
  UnderMaintenance: ['Completed'],
  Completed: ['Returned'],
  Returned: ['Closed'],
};

const AssetMaintenancePanel = ({ rows, loading, onReport, onAct, busyId }) => {
  const { t, locale } = useLanguage();

  return (
    <div>
      <div className="assets-actions-row">
        <button type="button" className="primary-button" onClick={onReport}>
          <Wrench aria-hidden="true" /> {t('assets_maintenance_report')}
        </button>
      </div>

      {loading && <p className="field-note">{t('label_loading')}</p>}
      {!loading && !rows.length && <div className="empty-table compact"><Wrench aria-hidden="true" /><b>{t('label_no_results')}</b></div>}

      <div className="assets-maintenance-grid">
        {rows.map((row) => {
          const nextSteps = MAINTENANCE_NEXT[row.status] || [];
          return (
            <article key={row.id} className="assets-maintenance-card">
              <div className="assets-maintenance-head">
                <div>
                  <code>{row.reference}</code>
                  <span className={`status-badge status-${String(row.status).toLowerCase()}`}> {codeLabel(t, 'asset_maint_status', row.status, row.status)}</span>
                </div>
              </div>
              <p>{row.issue_description}</p>
              <div className="assets-maintenance-meta">
                <span>{t('reference')}: {row.reference}</span>
                {row.reported_on && <span>{formatDate(row.reported_on, locale)}</span>}
                {row.vendor_text && <span>{row.vendor_text}</span>}
                {row.expected_return_date && <span>{formatDate(row.expected_return_date, locale)}</span>}
                {row.cost != null && <span>{row.cost}</span>}
              </div>
              {nextSteps.length > 0 && (
                <div className="assets-maintenance-actions">
                  {nextSteps.map((step) => (
                    <button
                      key={step}
                      type="button"
                      className="secondary-button"
                      disabled={busyId === row.id}
                      onClick={() => onAct(row, step)}
                    >
                      {step === 'Approve' && <Check aria-hidden="true" />}
                      {step === 'Rejected' && <X aria-hidden="true" />}
                      {step === 'Approve' ? t('action_approve') : step === 'Rejected' ? t('action_reject')
                        : t('assets_advance_to', { status: codeLabel(t, 'asset_maint_status', step, step) })}
                    </button>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------
const TABS = [
  { id: 'overview', labelKey: 'assets_tab_overview', icon: Boxes },
  { id: 'timeline', labelKey: 'assets_tab_timeline', icon: History },
  { id: 'transactions', labelKey: 'assets_tab_transactions', icon: ListChecks },
  { id: 'attachments', labelKey: 'att_panel_title', icon: Paperclip },
  { id: 'reservations', labelKey: 'assets_tab_reservations', icon: CalendarClock },
  { id: 'maintenance', labelKey: 'assets_tab_maintenance', icon: Wrench },
];

const AssetDetailView = ({
  assetId, tenantId, currentUserId, groups, custodyUnits, employees, projects, onBack, onNavigate, onChanged,
}) => {
  const { t, lang } = useLanguage();
  const { employeeName } = useArabicName();

  const [asset, setAsset] = useState(null);
  const [childAssets, setChildAssets] = useState([]);
  const [parentAsset, setParentAsset] = useState(null);
  const [parentOptions, setParentOptions] = useState([]);
  const [parentOptionsTruncated, setParentOptionsTruncated] = useState(false);
  const [timeline, setTimeline] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [maintenance, setMaintenance] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [activeTab, setActiveTab] = useState('overview');
  const [notice, setNotice] = useState(null);

  const [editDraft, setEditDraft] = useState(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');
  const [txnType, setTxnType] = useState(null);
  const [disposalStep, setDisposalStep] = useState(null); // 'reason' | 'send'
  const [disposalFormId, setDisposalFormId] = useState(null);
  const [disposalTemplateId, setDisposalTemplateId] = useState(null);
  const [tagOpen, setTagOpen] = useState(false);
  const [reservationOpen, setReservationOpen] = useState(false);
  const [reservationBusyId, setReservationBusyId] = useState(null);
  const [releaseTarget, setReleaseTarget] = useState(null); // reservation id pending a release confirmation
  const [maintenanceReportOpen, setMaintenanceReportOpen] = useState(false);
  const [maintenanceAdvance, setMaintenanceAdvance] = useState(null); // {caseRow, targetStatus}
  const [maintenanceRejectTarget, setMaintenanceRejectTarget] = useState(null); // caseRow pending a reject confirmation
  const [maintenanceBusyId, setMaintenanceBusyId] = useState(null);

  // `loading` is set to true by whichever event handler is about to trigger
  // a re-fetch (refresh() here, the assetId-changing lineage links below) —
  // never from inside the effect itself, same "effects only ever turn
  // loading back off" convention AttachmentsPanel.jsx documents for its own
  // fetch-on-mount effect. `loading` already starts true, so the first
  // mount needs no handler to prime it.
  const refresh = useCallback(() => { setLoading(true); setReloadToken((token) => token + 1); }, []);

  // childAssets and parentAsset are each their own targeted lookup —
  // loadAssets({ parentAssetId }) for the child list and a single loadAsset()
  // call for the parent (only when one is actually set) — never the whole
  // tenant catalogue, the same idx_assets_parent-backed shape assetsService.js's
  // own header comment documents loadAssets()'s parentAssetId filter for.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadAsset(assetId),
      loadAssets({ parentAssetId: assetId }),
      loadAssetTimeline(assetId),
      loadAssetTransactions(assetId),
      loadAssetReservations(assetId),
      loadAssetMaintenance(assetId),
    ]).then(([assetResult, childResult, timelineResult, txnResult, reservationResult, maintenanceResult]) => {
      if (cancelled) return;
      if (assetResult.error) {
        setNotice({ tone: 'error', text: assetsErrorMessage(t, assetResult.error) || t('admin_load_failed') });
        setAsset(null);
        setParentAsset(null);
      } else {
        setAsset(assetResult.data);
        if (assetResult.data?.parent_asset_id) {
          loadAsset(assetResult.data.parent_asset_id).then(({ data }) => { if (!cancelled) setParentAsset(data || null); });
        } else {
          setParentAsset(null);
        }
      }
      setChildAssets(childResult.data || []);
      setTimeline(timelineResult.data || []);
      setTransactions(txnResult.data || []);
      setReservations(reservationResult.data || []);
      setMaintenance(maintenanceResult.data || []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [assetId, reloadToken, t]);

  const employeeById = useMemo(() => new Map(employees.map((row) => [row.id, row])), [employees]);
  const custodyUnitById = useMemo(() => new Map(custodyUnits.map((row) => [row.id, row])), [custodyUnits]);

  const employeeLabel = useCallback((id) => {
    if (!id) return '';
    const employee = employeeById.get(id);
    return employee ? employeeName(employee) : id;
  }, [employeeById, employeeName]);

  const custodyUnitLabel = useCallback((id) => {
    if (!id) return '';
    const unit = custodyUnitById.get(id);
    return unit ? `${unit.code} · ${pickLocalized(unit, 'name', lang)}` : id;
  }, [custodyUnitById, lang]);

  const projectLabel = useCallback((id) => {
    if (!id) return '';
    const project = projects.find((row) => row.id === id);
    return project ? pickLocalized(project, 'name', lang, project.code) : id;
  }, [projects, lang]);

  // Jumping to a parent/child asset re-renders this same component with a
  // new assetId prop rather than unmounting it — loading has to be armed
  // here, in the click handler that causes it, for the same reason refresh()
  // above does it itself instead of leaving it to the effect.
  const goTo = (id) => { setLoading(true); onNavigate(id); };

  // Loaded fresh (unfiltered, bounded to the same default page loadAssets()
  // itself now caps) the moment the edit dialog opens, rather than derived
  // from any list already held in state — same "genuine browse the catalogue
  // to pick a parent" reasoning the top-level openCreate() picker below
  // documents for its own parentCandidates fetch.
  const onEdit = () => {
    setEditError('');
    setEditDraft(toAssetDraft(asset));
    loadAssets({}).then(({ data }) => {
      const list = data || [];
      setParentOptions(list.filter((row) => row.id !== asset.id));
      setParentOptionsTruncated(list.length >= ASSET_PICKER_PAGE_SIZE);
    });
  };

  const saveEdit = async () => {
    setEditBusy(true);
    setEditError('');
    const { error } = await updateAsset(editDraft.id, {
      ...editDraft,
      group_id: editDraft.group_id || null,
      parent_asset_id: editDraft.parent_asset_id || null,
      purchase_date: editDraft.purchase_date || null,
      warranty_until: editDraft.warranty_until || null,
    });
    setEditBusy(false);
    if (error) { setEditError(assetsErrorMessage(t, error)); return; }
    setEditDraft(null);
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refresh();
    onChanged?.();
  };

  const onTransactionDone = () => {
    setTxnType(null);
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refresh();
    onChanged?.();
  };

  const onDisposalRequested = async (formId) => {
    setDisposalFormId(formId);
    if (!disposalTemplateId) {
      const { data } = await loadAssetDisposalTemplateId();
      setDisposalTemplateId(data);
    }
    setDisposalStep('send');
  };

  const releaseReservation = async (id) => {
    setReservationBusyId(id);
    const { error } = await releaseAssetReservation(id);
    setReservationBusyId(null);
    if (error) { setNotice({ tone: 'error', text: assetsErrorMessage(t, error) }); return; }
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refresh();
  };

  const confirmReleaseReservation = async () => {
    const id = releaseTarget;
    if (!id) return;
    await releaseReservation(id);
    setReleaseTarget(null);
  };

  const runMaintenanceAction = async (caseRow, step) => {
    if (step === 'Sent' || step === 'Completed') { setMaintenanceAdvance({ caseRow, targetStatus: step }); return; }
    if (step === 'Rejected') { setMaintenanceRejectTarget(caseRow); return; }
    setMaintenanceBusyId(caseRow.id);
    const { error } = step === 'Approve'
      ? await approveAssetMaintenance(caseRow.id)
      : await advanceAssetMaintenance(caseRow.id, step);
    setMaintenanceBusyId(null);
    if (error) { setNotice({ tone: 'error', text: assetsErrorMessage(t, error) }); return; }
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refresh();
    onChanged?.();
  };

  // Moves focus to the detail heading once, the moment this view finishes
  // its first load — not on every refresh()/lineage jump, hence the ref
  // guard instead of an [asset] dependency alone.
  const headingRef = useRef(null);
  const headingFocusedRef = useRef(false);
  useEffect(() => {
    if (!asset || headingFocusedRef.current) return;
    headingFocusedRef.current = true;
    headingRef.current?.focus();
  }, [asset]);

  if (loading && !asset) {
    return (
      <div className="admin-content assets-content">
        <button type="button" className="secondary-button" onClick={onBack}><BackIcon /> {t('assets_back_to_list')}</button>
        <p className="field-note">{t('label_loading')}</p>
      </div>
    );
  }

  if (!asset) {
    return (
      <div className="admin-content assets-content">
        <button type="button" className="secondary-button" onClick={onBack}><BackIcon /> {t('assets_back_to_list')}</button>
        <div className="empty-table"><Boxes aria-hidden="true" /><b>{t('label_no_results')}</b></div>
      </div>
    );
  }

  const disposed = asset.status === 'Disposed';

  return (
    <div className="admin-content assets-content">
      <div className="admin-toolbar">
        <button type="button" className="secondary-button" onClick={onBack}><BackIcon /> {t('assets_back_to_list')}</button>
        <button type="button" className="secondary-button" onClick={refresh}><RefreshCcw aria-hidden="true" /> {t('action_refresh')}</button>
      </div>

      {notice && (
        <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
          {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
        </div>
      )}

      <div className="assets-detail-grid">
        <div className="assets-identity">
          <div>
            <span className="section-kicker">{t('assets_module_kicker')}</span>
            <h1 ref={headingRef} tabIndex={-1}>{pickLocalized(asset, 'name', lang)}</h1>
            <code className="assets-reference">{asset.reference}</code>
          </div>

          <div className="assets-meta-grid">
            <div className="assets-meta-item"><span>{t('asset_group')}</span><b>{groups.find((g) => g.id === asset.group_id) ? pickLocalized(groups.find((g) => g.id === asset.group_id), 'name', lang) : t('label_none')}</b></div>
            <div className="assets-meta-item"><span>{t('label_status')}</span><b><AssetStatusBadge status={asset.status} /></b></div>
            <div className="assets-meta-item"><span>{t('asset_custodian')}</span><b>{employeeLabel(asset.current_custodian_user_id) || t('label_none')}</b></div>
            <div className="assets-meta-item"><span>{t('asset_custody_unit')}</span><b>{custodyUnitLabel(asset.current_custody_unit_id) || t('label_none')}</b></div>
            {asset.brand && <div className="assets-meta-item"><span>{t('asset_field_brand')}</span><b>{asset.brand}</b></div>}
            {asset.model && <div className="assets-meta-item"><span>{t('asset_field_model')}</span><b>{asset.model}</b></div>}
            {asset.serial_no && <div className="assets-meta-item"><span>{t('asset_field_serial_no')}</span><b>{asset.serial_no}</b></div>}
            {asset.purchase_date && <div className="assets-meta-item"><span>{t('asset_field_purchase_date')}</span><b>{formatDate(asset.purchase_date, lang)}</b></div>}
            {asset.warranty_until && <div className="assets-meta-item"><span>{t('asset_field_warranty_until')}</span><b>{formatDate(asset.warranty_until, lang)}</b></div>}
            {asset.supplier && <div className="assets-meta-item"><span>{t('asset_field_supplier')}</span><b>{asset.supplier}</b></div>}
          </div>

          {asset.notes && <p className="field-note">{asset.notes}</p>}

          <div className="assets-lineage">
            {parentAsset && (
              <>
                <span>{t('asset_field_parent_asset')}:</span>
                <button type="button" className="assets-lineage-link" onClick={() => goTo(parentAsset.id)}>
                  <Link2 aria-hidden="true" /> {parentAsset.reference}
                </button>
              </>
            )}
          </div>

          {childAssets.length > 0 && (
            <div>
              <span className="field-note"><Layers aria-hidden="true" /> {t('asset_child_assets')}</span>
              <div className="assets-children">
                {childAssets.map((child) => (
                  <button key={child.id} type="button" className="assets-child-chip" onClick={() => goTo(child.id)}>
                    {child.reference}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="assets-actions-row">
            <button type="button" className="secondary-button" onClick={onEdit}><Pencil aria-hidden="true" /> {t('action_edit')}</button>
            {!disposed && Object.keys(TXN_FIELDS).map((type) => {
              const Icon = TXN_ICONS[type];
              return (
                <button key={type} type="button" className="secondary-button" onClick={() => setTxnType(type)}>
                  <Icon aria-hidden="true" /> {t(TXN_TITLE_KEYS[type])}
                </button>
              );
            })}
            {!disposed && (
              <button type="button" className="secondary-button" onClick={() => setDisposalStep('reason')}>
                <Recycle aria-hidden="true" /> {t('asset_action_request_disposal')}
              </button>
            )}
            <button type="button" className="secondary-button" onClick={() => setTagOpen(true)}>
              <Printer aria-hidden="true" /> {t('assets_tag_action')}
            </button>
          </div>
        </div>

        <div className="assets-id-card">
          <EntityQrCode value={asset.reference} size={104} title={t('asset_qr_aria', { reference: asset.reference })} />
          <AssetBarcode value={asset.reference} height={32} />
          <b>{asset.reference}</b>
        </div>
      </div>

      <div className="assets-tablist" role="tablist" aria-label={t('assets_catalogue_title')}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`assets-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`assets-tabpanel-${tab.id}`}
            className={activeTab === tab.id ? 'active' : ''}
            onClick={() => setActiveTab(tab.id)}
          >
            <tab.icon aria-hidden="true" /> {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div id={`assets-tabpanel-${activeTab}`} role="tabpanel" aria-labelledby={`assets-tab-${activeTab}`} className="assets-tab-panel">
        {activeTab === 'overview' && (
          <div className="assets-meta-grid">
            {asset.color && <div className="assets-meta-item"><span>{t('asset_field_color')}</span><b>{asset.color}</b></div>}
            {asset.manufacturer && <div className="assets-meta-item"><span>{t('asset_field_manufacturer')}</span><b>{asset.manufacturer}</b></div>}
            {asset.imei && <div className="assets-meta-item"><span>{t('asset_field_imei')}</span><b>{asset.imei}</b></div>}
          </div>
        )}
        {activeTab === 'timeline' && <AssetTimelinePanel rows={timeline} loading={loading} />}
        {activeTab === 'transactions' && (
          <AssetTransactionsPanel rows={transactions} loading={loading} employeeLabel={employeeLabel} custodyUnitLabel={custodyUnitLabel} />
        )}
        {activeTab === 'attachments' && (
          <AttachmentsPanel tenantId={tenantId} entityType="Asset" entityId={asset.id} area="assets" listFn={listAssetAttachments} />
        )}
        {activeTab === 'reservations' && (
          <AssetReservationsPanel
            rows={reservations}
            loading={loading}
            employeeLabel={employeeLabel}
            projectLabel={projectLabel}
            onNew={() => setReservationOpen(true)}
            onRelease={setReleaseTarget}
            busyId={reservationBusyId}
          />
        )}
        {activeTab === 'maintenance' && (
          <AssetMaintenancePanel
            rows={maintenance}
            loading={loading}
            onReport={() => setMaintenanceReportOpen(true)}
            onAct={runMaintenanceAction}
            busyId={maintenanceBusyId}
          />
        )}
      </div>

      {editDraft && (
        <AssetFormModal
          draft={editDraft}
          groups={groups}
          custodyUnits={custodyUnits}
          parentOptions={parentOptions}
          parentOptionsTruncated={parentOptionsTruncated}
          busy={editBusy}
          error={editError}
          onChange={setEditDraft}
          onClose={() => setEditDraft(null)}
          onSubmit={saveEdit}
        />
      )}

      {txnType && (
        <AssetTransactionModal
          asset={asset}
          type={txnType}
          employees={employees}
          custodyUnits={custodyUnits}
          onClose={() => setTxnType(null)}
          onDone={onTransactionDone}
        />
      )}

      {disposalStep === 'reason' && (
        <DisposalRequestModal asset={asset} onClose={() => setDisposalStep(null)} onRequested={onDisposalRequested} />
      )}
      {disposalStep === 'send' && disposalFormId && (
        <SendApprovalModal
          formId={disposalFormId}
          templateId={disposalTemplateId}
          currentUserId={currentUserId}
          onClose={() => setDisposalStep(null)}
          onSent={() => {
            setDisposalStep(null);
            setNotice({ tone: 'success', text: t('admin_save_done') });
            refresh();
            onChanged?.();
          }}
        />
      )}

      {tagOpen && <AssetTagModal asset={asset} onClose={() => setTagOpen(false)} />}

      {reservationOpen && (
        <NewReservationModal
          asset={asset}
          employees={employees}
          projects={projects}
          onClose={() => setReservationOpen(false)}
          onDone={() => { setReservationOpen(false); setNotice({ tone: 'success', text: t('admin_save_done') }); refresh(); }}
        />
      )}

      {maintenanceReportOpen && (
        <ReportMaintenanceModal
          asset={asset}
          onClose={() => setMaintenanceReportOpen(false)}
          onDone={() => { setMaintenanceReportOpen(false); setNotice({ tone: 'success', text: t('admin_save_done') }); refresh(); }}
        />
      )}

      {maintenanceAdvance && (
        <MaintenanceAdvanceModal
          caseRow={maintenanceAdvance.caseRow}
          targetStatus={maintenanceAdvance.targetStatus}
          onClose={() => setMaintenanceAdvance(null)}
          onDone={() => { setMaintenanceAdvance(null); setNotice({ tone: 'success', text: t('admin_save_done') }); refresh(); onChanged?.(); }}
        />
      )}

      {maintenanceRejectTarget && (
        <ConfirmMaintenanceRejectModal
          caseRow={maintenanceRejectTarget}
          onClose={() => setMaintenanceRejectTarget(null)}
          onDone={() => { setMaintenanceRejectTarget(null); setNotice({ tone: 'success', text: t('admin_save_done') }); refresh(); onChanged?.(); }}
        />
      )}

      {releaseTarget && (
        <ConfirmReleaseReservationModal
          busy={reservationBusyId === releaseTarget}
          onClose={() => setReleaseTarget(null)}
          onConfirm={confirmReleaseReservation}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// List / catalogue
// ---------------------------------------------------------------------------
const EMPTY_FILTERS = { groupId: '', status: '', custodyUnitId: '', search: '' };

const AssetsCatalogueAdmin = () => {
  const { t, lang } = useLanguage();
  const { tenant } = useTenant();
  const { profile } = useAuth();
  const { employeeName } = useArabicName();
  const tenantId = tenant?.id || null;
  const currentUserId = profile?.id || null;

  const [groups, setGroups] = useState([]);
  const [custodyUnits, setCustodyUnits] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [projects, setProjects] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [notice, setNotice] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [createDraft, setCreateDraft] = useState(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');
  const [parentCandidates, setParentCandidates] = useState([]);
  const [parentCandidatesTruncated, setParentCandidatesTruncated] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [searchInput, setSearchInput] = useState('');

  // Which row's Eye button opened the detail view, so onBack can return
  // focus to it; the table wrapper is the fallback when that row is gone
  // (filtered out, or the detail view was opened via a deep link instead).
  const returnFocusRowIdRef = useRef(null);
  const tableWrapRef = useRef(null);
  const deepLinkHandledRef = useRef(false);

  const refreshList = useCallback(() => { setLoading(true); setReloadToken((token) => token + 1); }, []);

  const openDetail = (id) => { returnFocusRowIdRef.current = id; setSelectedId(id); };

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadAssetGroups(), loadCustodyUnits(), loadRecipients().catch(() => []), loadOrgDimensions()])
      .then(([groupsResult, unitsResult, employeeRows, dimensionsResult]) => {
        if (cancelled) return;
        const firstError = groupsResult.error || unitsResult.error || dimensionsResult.error;
        if (firstError) setNotice({ tone: 'error', text: assetsErrorMessage(t, firstError) });
        setGroups(groupsResult.data || []);
        setCustodyUnits(unitsResult.data || []);
        setEmployees(employeeRows || []);
        setProjects(dimensionsResult.data?.projects || []);
      });
    return () => { cancelled = true; };
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    loadAssets({
      groupId: filters.groupId || undefined,
      status: filters.status || undefined,
      custodyUnitId: filters.custodyUnitId || undefined,
      search: filters.search || undefined,
    }).then(({ data, error }) => {
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
  }, [filters.groupId, filters.status, filters.custodyUnitId, filters.search, reloadToken, t]);

  // Debounces the raw keystrokes into `filters.search` (the value the effect
  // above actually depends on) so free typing doesn't fire a server request
  // per character; only the committed change flips `loading`, so a no-op
  // settle (type then delete back to the same text) never leaves it stuck.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (filters.search === searchInput) return;
      setLoading(true);
      setFilters((prev) => ({ ...prev, search: searchInput }));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchInput, filters.search]);

  // Opens the asset a maintenance-approval notification links to
  // ("/app/admin/assets?asset=<uuid>") once per mount, after the first list
  // load — reusing the row already in `rows` when present, otherwise
  // fetching it directly; a PERMISSION_DENIED/not-found fetch just does
  // nothing rather than showing an error for a link the user can't act on.
  useEffect(() => {
    if (deepLinkHandledRef.current || loading) return;
    deepLinkHandledRef.current = true;
    const id = new URLSearchParams(window.location.search).get('asset');
    if (!id) return;
    const found = rows.find((row) => row.id === id);
    Promise.resolve(found ? { data: found, error: null } : loadAsset(id)).then(({ data, error }) => {
      if (error || !data) return;
      setSelectedId(data.id);
    });
  }, [loading, rows]);

  // Returns focus to the row that opened the detail view (or the list
  // itself, if that row is no longer around) the moment we're back.
  useEffect(() => {
    if (selectedId || !returnFocusRowIdRef.current) return;
    const id = returnFocusRowIdRef.current;
    returnFocusRowIdRef.current = null;
    const target = tableWrapRef.current?.querySelector(`[data-asset-row-id="${id}"]`);
    if (target) target.focus();
    else tableWrapRef.current?.focus();
  }, [selectedId, rows]);

  const employeeById = useMemo(() => new Map(employees.map((row) => [row.id, row])), [employees]);
  const custodyUnitById = useMemo(() => new Map(custodyUnits.map((row) => [row.id, row])), [custodyUnits]);
  const groupById = useMemo(() => new Map(groups.map((row) => [row.id, row])), [groups]);

  const employeeLabel = useCallback((id) => {
    if (!id) return '';
    const employee = employeeById.get(id);
    return employee ? employeeName(employee) : id;
  }, [employeeById, employeeName]);

  const custodyUnitLabel = useCallback((id) => {
    if (!id) return '';
    const unit = custodyUnitById.get(id);
    return unit ? `${unit.code} · ${pickLocalized(unit, 'name', lang)}` : id;
  }, [custodyUnitById, lang]);

  const groupLabel = useCallback((id) => {
    if (!id) return '';
    const group = groupById.get(id);
    return group ? pickLocalized(group, 'name', lang) : id;
  }, [groupById, lang]);

  // Loaded fresh (unfiltered) every time the dialog opens, rather than reused
  // from the catalogue table's own `rows` — those are narrowed by whatever
  // group/status/custody-unit filter is currently applied, which would
  // silently hide valid parent candidates the moment any filter is active.
  const openCreate = () => {
    setCreateError('');
    setCreateDraft(emptyAssetDraft());
    loadAssets({}).then(({ data }) => {
      const list = data || [];
      setParentCandidates(list);
      setParentCandidatesTruncated(list.length >= ASSET_PICKER_PAGE_SIZE);
    });
  };

  const saveCreate = async () => {
    setCreateBusy(true);
    setCreateError('');
    const { data, error } = await createAsset({
      ...createDraft,
      group_id: createDraft.group_id || null,
      parent_asset_id: createDraft.parent_asset_id || null,
      purchase_date: createDraft.purchase_date || null,
      warranty_until: createDraft.warranty_until || null,
      initial_custody_unit_id: createDraft.initial_custody_unit_id || null,
    });
    setCreateBusy(false);
    if (error) { setCreateError(assetsErrorMessage(t, error)); return; }
    setCreateDraft(null);
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refreshList();
    if (data) setSelectedId(data);
  };

  if (selectedId) {
    return (
      <AssetDetailView
        assetId={selectedId}
        tenantId={tenantId}
        currentUserId={currentUserId}
        groups={groups}
        custodyUnits={custodyUnits}
        employees={employees}
        projects={projects}
        onBack={() => { setSelectedId(null); refreshList(); }}
        onNavigate={setSelectedId}
        onChanged={refreshList}
      />
    );
  }

  return (
    <div className="admin-content assets-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('assets_module_kicker')}</span>
          <h1><Boxes className="admin-title-icon" aria-hidden="true" /> {t('assets_catalogue_title')}</h1>
          <p>{t('assets_catalogue_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="primary-button" onClick={openCreate}>
            <Plus aria-hidden="true" /> {t('assets_catalogue_add')}
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
        <div className="search-control">
          <Search aria-hidden="true" />
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={t('admin_search_placeholder')}
            aria-label={t('action_search')}
          />
        </div>
        <select className="form-input" value={filters.groupId} onChange={(event) => { setFilters({ ...filters, groupId: event.target.value }); setLoading(true); }} aria-label={t('asset_group')}>
          <option value="">{t('assets_filter_all_groups')}</option>
          {groups.map((group) => <option key={group.id} value={group.id}>{pickLocalized(group, 'name', lang)}</option>)}
        </select>
        <select className="form-input" value={filters.status} onChange={(event) => { setFilters({ ...filters, status: event.target.value }); setLoading(true); }} aria-label={t('label_status')}>
          <option value="">{t('assets_filter_all_statuses')}</option>
          {ASSET_STATUSES.map((status) => <option key={status} value={status}>{codeLabel(t, 'asset_status', status, status)}</option>)}
        </select>
        <select className="form-input" value={filters.custodyUnitId} onChange={(event) => { setFilters({ ...filters, custodyUnitId: event.target.value }); setLoading(true); }} aria-label={t('asset_custody_unit')}>
          <option value="">{t('assets_filter_all_custody_units')}</option>
          {custodyUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.code} · {pickLocalized(unit, 'name', lang)}</option>)}
        </select>
        <button type="button" className="secondary-button" onClick={() => { setFilters(EMPTY_FILTERS); setSearchInput(''); setLoading(true); }}><X aria-hidden="true" /> {t('action_clear')}</button>
        <span className="result-count">{t('admin_records_count', { count: rows.length })}</span>
      </div>

      <div className="data-table-wrap" ref={tableWrapRef} tabIndex={-1}>
        <table className="enterprise-table">
          <thead>
            <tr>
              <th>{t('reference')}</th><th>{t('asset_name')}</th><th>{t('asset_group')}</th>
              <th>{t('label_status')}</th><th>{t('asset_custodian')}</th><th>{t('asset_custody_unit')}</th>
              <th aria-label={t('label_actions')} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td><code>{row.reference}</code></td>
                <td>
                  <div className="assets-name-cell">
                    <b>{pickLocalized(row, 'name', lang)}</b>
                    {row.serial_no && <small>{row.serial_no}</small>}
                  </div>
                </td>
                <td>{groupLabel(row.group_id) || '—'}</td>
                <td><AssetStatusBadge status={row.status} /></td>
                <td>{employeeLabel(row.current_custodian_user_id) || t('label_none')}</td>
                <td>{custodyUnitLabel(row.current_custody_unit_id) || t('label_none')}</td>
                <td>
                  <div className="table-actions">
                    <button type="button" data-asset-row-id={row.id} title={t('action_details')} aria-label={t('action_details')} onClick={() => openDetail(row.id)}>
                      <Eye aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && !rows.length && (
              <tr>
                <td colSpan={7}>
                  <div className="empty-table"><Boxes aria-hidden="true" /><b>{t('label_no_results')}</b></div>
                </td>
              </tr>
            )}
            {loading && (
              <tr><td colSpan={7}>{t('label_loading')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {createDraft && (
        <AssetFormModal
          draft={createDraft}
          groups={groups}
          custodyUnits={custodyUnits}
          parentOptions={parentCandidates}
          parentOptionsTruncated={parentCandidatesTruncated}
          busy={createBusy}
          error={createError}
          onChange={setCreateDraft}
          onClose={() => setCreateDraft(null)}
          onSubmit={saveCreate}
        />
      )}
    </div>
  );
};

export default AssetsCatalogueAdmin;