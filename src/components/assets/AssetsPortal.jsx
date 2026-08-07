// Assets Management — employee-facing "My Assets" portal screen (route
// /app/assets, any tenant member, module ASSETS, rank 1 — no permission
// beyond being a tenant member, mirroring asset_maintenance_report()'s own
// "any user" rule).
//
// Shows the two things an employee needs from this module without any admin
// permission: the assets currently checked out to them
// (current_custodian_user_id = me), any incoming custody transfer still
// waiting on their Accept/Reject, and — one click into an asset — its full
// detail, Timeline (asset_timeline(), "the most important screen" per the
// migration's own comment) and Attachments. Reporting maintenance is open to
// any user per that same RPC's own doc comment, so it lives here too, both
// from the list row and from the detail view.
//
// Data access only ever goes through src/data/assetsService.js. Reuses this
// module's own already-established i18n vocabulary and status-badge/timeline
// rendering (AssetsCatalogueAdmin.jsx, AssetGroupsAdmin.jsx,
// AssetCustodyUnitsAdmin.jsx — asset_status_*/codeLabel() for the badge,
// asset_field_*/reference/asset_name/asset_group/asset_custody_unit
// for field labels, assets_module_kicker, assets_maintenance_report, the
// global .timeline-item/.timeline-dot/.timeline-body family from
// src/index.css) rather than inventing a second set of names for the same
// concepts. Shares this module's own src/components/assets/assets.css,
// whose .status-badge.status-* modifiers already cover this screen's status
// badge. The screen shell itself reuses verification.css's
// .vf-screen/.vf-panel, the same generic non-admin screen furniture
// src/components/identity/MyCardScreen.jsx already borrows rather than
// re-declaring its own (this screen, unlike its admin siblings, is not
// wrapped in .admin-content/.admin-toolbar — it renders inside the regular
// employee AppShell).
//
// The modal a11y pattern (role="dialog"/aria-modal/useDialogA11y) follows
// src/utils/useDialogA11y.js exactly as already applied throughout
// FormsPortal.jsx/ApprovalChain.jsx and this module's own admin screens.
//
// asset_timeline()'s own authorization (Assets.View OR Assets.Manage OR the
// asset's current custodian) means a rank-1 employee can only ever open it
// for an asset they already hold — exactly "my assets" below — so the
// pending-transfer cards intentionally offer no detail/timeline link (the
// recipient does not hold the asset yet, so that call would PERMISSION_DENY).
//
// Pending transfers addressed to me come from one loadPendingTransfersForMe()
// call (asset_transactions' own RLS already scopes reads to rows where the
// caller is to_custodian_user_id, so this is a plain filtered select, no
// fan-out over the tenant's assets). Each returned transaction's asset is
// then resolved via one bulk loadAssetsByIds() call for display — bounded
// to this employee's own pending transfers, never a scan of the tenant
// catalogue.

import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import {
  ArrowRight, ArrowRightLeft, Boxes, Check, History, Package, Search, Wrench, X, XCircle,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import {
  acceptAssetTransfer, assetsErrorMessage, listAssetAttachments, loadAssetGroups,
  loadAssets, loadAssetsByIds, loadAssetTimeline, loadCustodyUnits, loadPendingTransfersForMe,
  rejectAssetTransfer, reportAssetMaintenance,
} from '../../data/assetsService';
import AttachmentsPanel from '../platform/AttachmentsPanel';
import { AssetStatusBadge, AssetTimelinePanel } from './AssetShared';
import { formatDate, pickLocalized } from '../../utils/localize';
import { useDialogA11y } from '../../utils/useDialogA11y';
import './assets.css';

const AssetInfo = ({ label, value, wide }) => (
  <div className={`assets-meta-item ${wide ? 'wide' : ''}`}><span>{label}</span><b>{value || '—'}</b></div>
);

// ---------------------------------------------------------------------------
// Report Maintenance modal — asset_maintenance_report() itself has no
// permission gate beyond tenant membership (spec's own explicit rule), so
// this is reachable from both the list row and the detail view below.
// ---------------------------------------------------------------------------
const ReportMaintenanceModal = ({ asset, busy, error, onClose, onSubmit }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const [issueDescription, setIssueDescription] = useState('');

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={t('assets_maintenance_report')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); onSubmit(issueDescription); }}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{asset.reference}</span>
            <h3><Wrench aria-hidden="true" /> {t('assets_maintenance_report')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <label className="field-label">
          {t('asset_field_issue_description')}
          <textarea
            required
            className="form-input"
            rows={4}
            value={issueDescription}
            onChange={(event) => setIssueDescription(event.target.value)}
          />
        </label>

        {error && <div className="modal-error"><X aria-hidden="true" />{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button className="primary-button" disabled={busy}>
            {busy ? t('label_loading') : t('action_save')}
          </button>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Reject-transfer confirmation — the destructive twin of the immediate
// Accept action, same "confirm before an irreversible action" shape as
// FormsPortal.jsx's own ConfirmCancelModal.
// ---------------------------------------------------------------------------
const ConfirmRejectModal = ({ asset, busy, onClose, onConfirm }) => {
  const { t } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('action_reject_transfer')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div><span className="section-kicker">{asset.reference}</span><h3>{t('action_reject_transfer')}</h3></div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="confirm-body"><XCircle aria-hidden="true" /><p>{t('assets_reject_transfer_confirm')}</p></div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('assets_reject_transfer_keep')}</button>
          <button type="button" className="secondary-button danger" disabled={busy} onClick={onConfirm}>
            <XCircle aria-hidden="true" /> {busy ? t('label_loading') : t('action_reject_transfer')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Asset detail — full fields + Timeline + Attachments. Only ever reachable
// from "my assets" below (see the file header on asset_timeline()'s own
// authorization), so onReportMaintenance from here always targets an asset
// this employee already holds.
// ---------------------------------------------------------------------------
const AssetDetail = ({
  asset, tenantId, groupName, unitName, timelineReloadToken, onBack, onReportMaintenance,
}) => {
  const { t, lang, locale } = useLanguage();
  const [timeline, setTimeline] = useState([]);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [timelineError, setTimelineError] = useState('');
  const headingRef = useRef(null);

  // AssetDetail is always a fresh mount per selected asset (the parent
  // swaps the whole subtree rather than re-rendering this component with a
  // new asset prop), so this effect also doubles as the "focus the detail
  // heading when it opens" a11y move — same reasoning
  // AssetCustodyUnitsAdmin.jsx's own load effect documents. It also reruns
  // on timelineReloadToken so a just-reported maintenance event shows up
  // without the user having to reopen the asset — see submitMaintenance()
  // in the parent. Deliberately doesn't reset timelineLoading back to true
  // on that rerun (only the initial mount needs the loading state), so the
  // refreshed rows just swap in quietly.
  useEffect(() => {
    headingRef.current?.focus();
    let cancelled = false;
    loadAssetTimeline(asset.id).then(({ data, error }) => {
      if (cancelled) return;
      setTimelineLoading(false);
      if (error) { setTimelineError(assetsErrorMessage(t, error)); return; }
      setTimeline(data || []);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id, timelineReloadToken]);

  const assetName = pickLocalized(asset, 'name', lang);

  return (
    <main className="assets-portal-page app-main">
      <div className="vf-screen">
        <div className="vf-screen-head">
          <div>
            <button type="button" className="secondary-button assets-back-button" onClick={onBack}>
              <ArrowRight aria-hidden="true" /> {t('assets_back_to_list')}
            </button>
            <span className="section-kicker">{asset.reference}</span>
            <h1 ref={headingRef} tabIndex={-1}>{assetName}</h1>
            <p>{groupName || '—'}</p>
          </div>
          <div className="assets-portal-actions">
            <AssetStatusBadge status={asset.status} />
            <button type="button" className="primary-button" onClick={onReportMaintenance}>
              <Wrench aria-hidden="true" /> {t('assets_maintenance_report')}
            </button>
          </div>
        </div>

        <section className="vf-panel">
          <div className="vf-panel-head"><h2>{t('assets_detail_title')}</h2></div>
          <div className="assets-meta-grid">
            <AssetInfo label={t('asset_custody_unit')} value={unitName} />
            <AssetInfo label={t('asset_field_brand')} value={asset.brand} />
            <AssetInfo label={t('asset_field_model')} value={asset.model} />
            <AssetInfo label={t('asset_field_serial_no')} value={asset.serial_no} />
            <AssetInfo label={t('asset_field_color')} value={asset.color} />
            <AssetInfo label={t('asset_field_manufacturer')} value={asset.manufacturer} />
            <AssetInfo label={t('asset_field_supplier')} value={asset.supplier} />
            <AssetInfo label={t('asset_field_purchase_date')} value={formatDate(asset.purchase_date, locale)} />
            <AssetInfo label={t('asset_field_warranty_until')} value={formatDate(asset.warranty_until, locale)} />
            {asset.notes && <AssetInfo label={t('asset_field_notes')} value={asset.notes} wide />}
          </div>
        </section>

        <section className="vf-panel">
          <div className="vf-panel-head"><h2><History aria-hidden="true" /> {t('assets_timeline_title')}</h2></div>
          {timelineError && <div className="modal-error"><X aria-hidden="true" />{timelineError}</div>}
          <AssetTimelinePanel rows={timeline} loading={timelineLoading} />
        </section>

        <section className="vf-panel">
          <AttachmentsPanel tenantId={tenantId} entityType="Asset" entityId={asset.id} area="assets" listFn={listAssetAttachments} />
        </section>
      </div>
    </main>
  );
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
const AssetsPortal = () => {
  const { profile } = useAuth();
  const { t, lang, locale } = useLanguage();
  const { tenant } = useTenant();

  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState([]);
  const [groups, setGroups] = useState([]);
  const [custodyUnits, setCustodyUnits] = useState([]);
  const [pendingTransfers, setPendingTransfers] = useState([]);
  const [notice, setNotice] = useState(null);
  const [query, setQuery] = useState('');
  // Seeded once from the notification deep link's own "?asset=<id>" (see
  // the file header) — the selectedAsset lookup below already no-ops (and
  // falls back to the list) when this id isn't in the loaded assets array,
  // which is exactly "silently do nothing" for a not-mine/unknown id.
  const [selectedAssetId, setSelectedAssetId] = useState(
    () => new URLSearchParams(window.location.search).get('asset') || null,
  );
  const [maintenanceTarget, setMaintenanceTarget] = useState(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [maintenanceError, setMaintenanceError] = useState('');
  const [rejectTarget, setRejectTarget] = useState(null);
  const [actionBusyId, setActionBusyId] = useState(null);
  const [timelineReloadToken, setTimelineReloadToken] = useState(0);
  const listHeadingRef = useRef(null);

  const groupById = useMemo(() => new Map(groups.map((row) => [row.id, row])), [groups]);
  const unitById = useMemo(() => new Map(custodyUnits.map((row) => [row.id, row])), [custodyUnits]);
  const groupName = (id) => (id ? pickLocalized(groupById.get(id), 'name', lang) : '');
  const unitName = (id) => (id ? pickLocalized(unitById.get(id), 'name', lang) : '');

  // The actual fetch lives inside the effect below, keyed on reloadToken —
  // refresh() itself just bumps the token, the same indirection this
  // module's own admin screens (e.g. AssetGroupsAdmin.jsx) already use, so
  // the effect's own body only ever sets state from a .then() callback,
  // never synchronously at the top of the effect.
  const [reloadToken, setReloadToken] = useState(0);
  const refresh = () => setReloadToken((token) => token + 1);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadAssets({ custodianUserId: profile?.id }),
      loadAssetGroups(),
      loadCustodyUnits(),
      loadPendingTransfersForMe(profile?.id),
    ]).then(([assetsResult, groupsResult, unitsResult, pendingResult]) => {
      if (cancelled) return;
      if (assetsResult.error) {
        setNotice({ tone: 'error', text: assetsErrorMessage(t, assetsResult.error) });
        setLoading(false);
        return;
      }
      setAssets(assetsResult.data || []);
      setGroups(groupsResult.data || []);
      setCustodyUnits(unitsResult.data || []);

      const pendingRows = pendingResult.data || [];
      if (!pendingRows.length) {
        setPendingTransfers([]);
        setLoading(false);
        return;
      }
      // See the file header — one query finds the pending transfers, then
      // their assets are resolved in one bulk loadAssetsByIds() call
      // (bounded to this employee's own pending transfers) for the
      // card/modal display below.
      loadAssetsByIds(pendingRows.map((transaction) => transaction.asset_id)).then(({ data }) => {
        if (cancelled) return;
        const assetById = new Map((data || []).map((asset) => [asset.id, asset]));
        setPendingTransfers(pendingRows
          .map((transaction) => ({ transaction, asset: assetById.get(transaction.asset_id) }))
          .filter((entry) => entry.asset));
        setLoading(false);
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken, profile?.id]);

  const myAssets = assets;

  const visibleAssets = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return myAssets;
    return myAssets.filter((row) => (
      `${row.reference} ${pickLocalized(row, 'name', lang)} ${row.serial_no || ''} ${row.brand || ''} ${row.model || ''}`
        .toLocaleLowerCase().includes(needle)
    ));
  }, [myAssets, query, lang]);

  const selectedAsset = useMemo(
    () => assets.find((row) => row.id === selectedAssetId) || null,
    [assets, selectedAssetId],
  );

  // Detail view mounting fresh handles its own "focus the heading" side —
  // AssetDetail's own effect does that. Coming back to the list is the one
  // transition this component itself has to move focus for, since the list
  // markup never unmounts, it's just conditionally hidden.
  useEffect(() => {
    if (!selectedAssetId) listHeadingRef.current?.focus();
  }, [selectedAssetId]);

  const openMaintenance = (asset) => { setMaintenanceError(''); setMaintenanceTarget(asset); };

  const acceptTransfer = async (entry) => {
    setActionBusyId(entry.transaction.id);
    const { error } = await acceptAssetTransfer(entry.transaction.id);
    setActionBusyId(null);
    if (error) { setNotice({ tone: 'error', text: assetsErrorMessage(t, error) }); return; }
    setNotice({ tone: 'success', text: t('assets_transfer_accepted') });
    refresh();
  };

  const confirmReject = async () => {
    const entry = rejectTarget;
    if (!entry) return;
    setActionBusyId(entry.transaction.id);
    const { error } = await rejectAssetTransfer(entry.transaction.id);
    setActionBusyId(null);
    setRejectTarget(null);
    if (error) { setNotice({ tone: 'error', text: assetsErrorMessage(t, error) }); return; }
    setNotice({ tone: 'success', text: t('assets_transfer_rejected') });
    refresh();
  };

  const submitMaintenance = async (issueDescription) => {
    if (!issueDescription.trim()) {
      setMaintenanceError(t('assets_maintenance_description_required'));
      return;
    }
    setMaintenanceBusy(true);
    setMaintenanceError('');
    const { error } = await reportAssetMaintenance(maintenanceTarget.id, issueDescription.trim());
    setMaintenanceBusy(false);
    if (error) { setMaintenanceError(assetsErrorMessage(t, error)); return; }
    if (maintenanceTarget.id === selectedAssetId) setTimelineReloadToken((token) => token + 1);
    setMaintenanceTarget(null);
    setNotice({ tone: 'success', text: t('assets_maintenance_reported') });
  };

  if (loading) return <div className="page-loader inline-loader"><span /></div>;

  return (
    <>
      {selectedAsset ? (
        <AssetDetail
          asset={selectedAsset}
          tenantId={tenant?.id}
          groupName={groupName(selectedAsset.group_id)}
          unitName={unitName(selectedAsset.current_custody_unit_id)}
          timelineReloadToken={timelineReloadToken}
          onBack={() => setSelectedAssetId(null)}
          onReportMaintenance={() => openMaintenance(selectedAsset)}
        />
      ) : (
        <main className="assets-portal-page app-main">
          <div className="vf-screen">
            <div className="vf-screen-head">
              <div>
                <span className="section-kicker">{t('assets_module_kicker')}</span>
                <h1 ref={listHeadingRef} tabIndex={-1}><Package className="assets-page-icon" aria-hidden="true" /> {t('assets_my_assets_title')}</h1>
                <p>{t('assets_my_assets_intro')}</p>
              </div>
            </div>

            {notice && (
              <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
                {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
                {notice.text}
                <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
              </div>
            )}

            {pendingTransfers.length > 0 && (
              <section className="vf-panel">
                <div className="vf-panel-head">
                  <h2><ArrowRightLeft aria-hidden="true" /> {t('assets_pending_transfers_title')}</h2>
                </div>
                <div className="assets-pending-list">
                  {pendingTransfers.map((entry) => (
                    <div className="assets-pending-card" key={entry.transaction.id}>
                      <div>
                        <b>{pickLocalized(entry.asset, 'name', lang)}</b>
                        <small>{entry.asset.reference}</small>
                        {entry.transaction.reason && <small>{t('asset_field_reason')}: {entry.transaction.reason}</small>}
                        <small>{formatDate(entry.transaction.performed_on, locale)}</small>
                      </div>
                      <div className="assets-pending-actions">
                        <button
                          type="button"
                          className="primary-button"
                          disabled={actionBusyId === entry.transaction.id}
                          onClick={() => acceptTransfer(entry)}
                        >
                          <Check aria-hidden="true" /> {t('action_accept_transfer')}
                        </button>
                        <button
                          type="button"
                          className="secondary-button danger"
                          disabled={actionBusyId === entry.transaction.id}
                          onClick={() => setRejectTarget(entry)}
                        >
                          <XCircle aria-hidden="true" /> {t('action_reject_transfer')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="vf-panel">
              <div className="vf-panel-head">
                <h2><Boxes aria-hidden="true" /> {t('assets_my_assets_list_title')}</h2>
                <div className="search-control compact">
                  <Search aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('assets_search_placeholder')}
                    aria-label={t('action_search')}
                  />
                  {query && (
                    <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label={t('action_clear')}>
                      <X size={15} />
                    </button>
                  )}
                </div>
              </div>

              {!visibleAssets.length ? (
                <div className="empty-table">
                  <Boxes aria-hidden="true" />
                  <b>{t('label_no_results')}</b>
                </div>
              ) : (
                <div className="data-table-wrap">
                  <table className="enterprise-table">
                    <thead>
                      <tr>
                        <th>{t('reference')}</th>
                        <th>{t('asset_name')}</th>
                        <th>{t('asset_group')}</th>
                        <th>{t('label_status')}</th>
                        <th>{t('asset_custody_unit')}</th>
                        <th aria-label={t('label_actions')} />
                      </tr>
                    </thead>
                    <tbody>
                      {visibleAssets.map((row) => (
                        <tr key={row.id}>
                          <td><code>{row.reference}</code></td>
                          <td>
                            <button type="button" className="assets-open-link" onClick={() => setSelectedAssetId(row.id)}>
                              {pickLocalized(row, 'name', lang)}
                            </button>
                          </td>
                          <td>{groupName(row.group_id) || '—'}</td>
                          <td><AssetStatusBadge status={row.status} /></td>
                          <td>{unitName(row.current_custody_unit_id) || '—'}</td>
                          <td>
                            <div className="table-actions">
                              <button
                                type="button"
                                title={t('action_details')}
                                aria-label={t('action_details')}
                                onClick={() => setSelectedAssetId(row.id)}
                              >
                                <ArrowRight aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                title={t('assets_maintenance_report')}
                                aria-label={t('assets_maintenance_report')}
                                onClick={() => openMaintenance(row)}
                              >
                                <Wrench aria-hidden="true" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </main>
      )}

      {maintenanceTarget && (
        <ReportMaintenanceModal
          asset={maintenanceTarget}
          busy={maintenanceBusy}
          error={maintenanceError}
          onClose={() => setMaintenanceTarget(null)}
          onSubmit={submitMaintenance}
        />
      )}

      {rejectTarget && (
        <ConfirmRejectModal
          asset={rejectTarget.asset}
          busy={actionBusyId === rejectTarget.transaction.id}
          onClose={() => setRejectTarget(null)}
          onConfirm={confirmReject}
        />
      )}
    </>
  );
};

export default AssetsPortal;