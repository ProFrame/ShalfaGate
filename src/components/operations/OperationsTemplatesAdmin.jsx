// Operations — Templates admin screen (admin/operations-templates,
// Operations.Manage, AdminNav id 'operations-templates').
//
// A template is a saved operation shape — header details (name/description/
// customer/site) plus a starter checklist — that a manager instantiates into
// a real operation in one step (operations_create_from_template). This
// screen owns three things: the template list (with an active/inactive
// toggle, mirroring every other catalogue-style admin screen's "show
// inactive" convention so deactivating a template is never a one-way door),
// a create/edit dialog for the template header plus its nested checklist
// items, and a small per-row "create operation from this template" dialog.
//
// Structurally this mirrors src/components/safety/SafetyPpeSetsAdmin.jsx's
// own parent-with-nested-child-items editor (table + wide dialog + a section
// inside the dialog for the child rows). The one real difference: PPE sets
// replace their whole item list in one RPC (setPpeSetItems); templates only
// expose per-item upsert/remove RPCs (saveTemplateChecklistItem/
// removeTemplateChecklistItem), so this screen still edits a local draft list
// inside the dialog, but commits it on Save by diffing against what was
// loaded — one upsert call per surviving row, one remove call per row the
// admin deleted while editing — rather than a single batch call.
//
// Data access only ever goes through src/data/operationsService.js. Every
// write RPC's own Operations.Manage gate is enforced server-side; this
// screen does not re-derive it client-side, same convention every sibling
// admin screen in this codebase already documents — it renders the actions
// and lets PERMISSION_DENIED surface through operationsErrorMessage() if the
// account may not use them.
//
// loadTemplates() defaults to active-only but accepts {includeInactive}, so
// this screen carries the same "show inactive" toggle + inactive-row
// treatment + reactivate-via-edit-dialog pattern PPE Sets/Custody Units
// already use.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, Copy, ListChecks, Pencil, Plus, Rocket, Search, Trash2, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useDialogA11y } from '../../utils/useDialogA11y';
import { pickLocalized } from '../../utils/localize';
import {
  operationsErrorMessage,
  loadTemplates, saveTemplate, loadTemplateChecklistItems, saveTemplateChecklistItem,
  removeTemplateChecklistItem, createOperationFromTemplate, loadOperation,
} from '../../data/operationsService';
import { loadOrgDimensions } from '../../data/orgDimensionsService';
import './operations.css';

// ---------------------------------------------------------------------------
// Template header + nested checklist items
// ---------------------------------------------------------------------------
let itemRowCounter = 0;
const nextItemRowId = () => {
  itemRowCounter += 1;
  return `tpl-item-${itemRowCounter}`;
};

const emptyTemplateDraft = () => ({
  id: null,
  name_ar: '',
  name_en: '',
  description_ar: '',
  description_en: '',
  customer_name: '',
  site_id: '',
  is_active: true,
  items: [],
});

const toTemplateDraft = (row) => ({
  id: row.id,
  name_ar: row.name_ar || '',
  name_en: row.name_en || '',
  description_ar: row.description_ar || '',
  description_en: row.description_en || '',
  customer_name: row.customer_name || '',
  site_id: row.site_id || '',
  is_active: row.is_active !== false,
  items: [],
});

const itemRowFromRecord = (row) => ({
  localId: nextItemRowId(),
  id: row.id,
  title_ar: row.title_ar || '',
  title_en: row.title_en || '',
  display_order: row.display_order ?? 0,
});

const emptyItemRow = (nextOrder) => ({
  localId: nextItemRowId(), id: null, title_ar: '', title_en: '', display_order: nextOrder,
});

/** Every checklist row needs an Arabic title — same check
 * operations_checklist_item_upsert()/operations_template_checklist_item_upsert()
 * itself raises TITLE_AR_REQUIRED for; catching it here saves the round trip
 * when a row is obviously incomplete. */
const validateItems = (items) => (items.some((row) => !row.title_ar.trim()) ? 'operations_err_title_ar_required' : null);

const TemplateItemsEditor = ({ items, loading, disabled, onChange, onRemoveExisting }) => {
  const { t } = useLanguage();

  const updateRow = (localId, patch) => onChange(items.map((row) => (row.localId === localId ? { ...row, ...patch } : row)));
  const removeRow = (row) => {
    if (row.id) onRemoveExisting(row.id);
    onChange(items.filter((current) => current.localId !== row.localId));
  };
  const addRow = () => {
    const nextOrder = items.reduce((max, row) => Math.max(max, Number(row.display_order) || 0), 0) + 1;
    onChange([...items, emptyItemRow(nextOrder)]);
  };

  return (
    <div className="ops-set-section">
      <div className="ops-set-section-head">
        <ListChecks aria-hidden="true" />
        <h4>{t('operations_field_checklist')}</h4>
      </div>
      <p className="field-note">{t('operations_templates_items_hint')}</p>

      {loading ? (
        <p className="field-note">{t('label_loading')}</p>
      ) : (
        <>
          {items.length === 0 ? (
            <p className="field-note">{t('operations_templates_items_empty')}</p>
          ) : (
            <div className="data-table-wrap ops-set-items-table">
              <table className="enterprise-table">
                <thead>
                  <tr>
                    <th>{t('label_name_1')}</th>
                    <th>{t('label_name_2')}</th>
                    <th>{t('label_display_order')}</th>
                    <th aria-label={t('label_actions')} />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.localId}>
                      <td>
                        <input
                          required
                          className="form-input"
                          value={row.title_ar}
                          disabled={disabled}
                          aria-label={t('label_name_1')}
                          onChange={(event) => updateRow(row.localId, { title_ar: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="form-input"
                          value={row.title_en}
                          disabled={disabled}
                          aria-label={t('label_name_2')}
                          onChange={(event) => updateRow(row.localId, { title_en: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          className="form-input ops-item-order"
                          value={row.display_order}
                          disabled={disabled}
                          aria-label={t('label_display_order')}
                          onChange={(event) => updateRow(row.localId, { display_order: event.target.value })}
                        />
                      </td>
                      <td>
                        <div className="table-actions">
                          <button
                            type="button"
                            title={t('operations_templates_item_remove', { title: row.title_ar })}
                            aria-label={t('operations_templates_item_remove', { title: row.title_ar })}
                            disabled={disabled}
                            onClick={() => removeRow(row)}
                          >
                            <Trash2 aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button type="button" className="secondary-button ops-item-add-row" disabled={disabled} onClick={addRow}>
            <Plus aria-hidden="true" /> {t('operations_templates_item_add')}
          </button>
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Create / edit template dialog
// ---------------------------------------------------------------------------
const TemplateDialog = ({
  draft, sites, itemsLoading, busy, error, onChange, onRemoveExistingItem, onClose, onSubmit,
}) => {
  const { t, lang } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const set = (key) => (event) => onChange({ ...draft, [key]: event.target.value });

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-xwide"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? t('action_edit') : t('operations_templates_add')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('operations_module_kicker')}</span>
            <h3>{draft.id ? t('action_edit') : t('operations_templates_add')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="form-grid">
          <label className="field-label">
            {t('label_name_1')}
            <input required className="form-input" value={draft.name_ar} onChange={set('name_ar')} />
          </label>
          <label className="field-label">
            {t('label_name_2')}
            <input className="form-input" value={draft.name_en} onChange={set('name_en')} />
          </label>

          <label className="field-label field-span-2">
            {t('label_description_1')}
            <textarea className="form-input" value={draft.description_ar} onChange={set('description_ar')} />
          </label>
          <label className="field-label field-span-2">
            {t('label_description_2')}
            <textarea className="form-input" value={draft.description_en} onChange={set('description_en')} />
          </label>

          <label className="field-label">
            {t('operations_field_customer')}
            <input className="form-input" value={draft.customer_name} onChange={set('customer_name')} />
          </label>
          <label className="field-label">
            {t('label_site')}
            <select
              className="form-input"
              value={draft.site_id || ''}
              onChange={(event) => onChange({ ...draft, site_id: event.target.value || null })}
            >
              <option value="">{t('admin_not_assigned')}</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.code} · {pickLocalized(site, 'name', lang)}
                </option>
              ))}
            </select>
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

        <TemplateItemsEditor
          items={draft.items}
          loading={itemsLoading}
          disabled={busy}
          onChange={(items) => onChange({ ...draft, items })}
          onRemoveExisting={onRemoveExistingItem}
        />

        {error && <div className="modal-error" role="alert"><X aria-hidden="true" />{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button className="primary-button" disabled={busy}>{busy ? t('label_loading') : t('action_save')}</button>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// "Create operation from template" dialog — every field defaults to the
// template's own value but stays editable, per this screen's own spec.
// ---------------------------------------------------------------------------
const CreateFromTemplateDialog = ({
  template, draft, sites, busy, error, onChange, onClose, onSubmit,
}) => {
  const { t, lang } = useLanguage();
  const closeRef = useDialogA11y(onClose);
  const set = (key) => (event) => onChange({ ...draft, [key]: event.target.value });

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal-card modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('operations_templates_create_operation_title')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{template.name_ar}</span>
            <h3>{t('operations_templates_create_operation_title')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <p className="field-note">{t('operations_templates_create_operation_hint')}</p>

        <div className="form-grid">
          <label className="field-label">
            {t('label_name_1')}
            <input required className="form-input" value={draft.nameAr} onChange={set('nameAr')} />
          </label>
          <label className="field-label">
            {t('label_name_2')}
            <input className="form-input" value={draft.nameEn} onChange={set('nameEn')} />
          </label>

          <label className="field-label">
            {t('operations_field_start_date')}
            <input required type="date" className="form-input" value={draft.startDate} onChange={set('startDate')} />
          </label>
          <label className="field-label">
            {t('operations_field_end_date')}
            <input type="date" className="form-input" value={draft.endDate} onChange={set('endDate')} />
          </label>

          <label className="field-label">
            {t('operations_field_customer')}
            <input className="form-input" value={draft.customerName} onChange={set('customerName')} />
          </label>
          <label className="field-label">
            {t('label_site')}
            <select
              className="form-input"
              value={draft.siteId || ''}
              onChange={(event) => onChange({ ...draft, siteId: event.target.value || null })}
            >
              <option value="">{t('admin_not_assigned')}</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.code} · {pickLocalized(site, 'name', lang)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && <div className="modal-error" role="alert"><X aria-hidden="true" />{error}</div>}

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
const OperationsTemplatesAdmin = () => {
  const { t, lang } = useLanguage();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [notice, setNotice] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [sites, setSites] = useState([]);

  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState('');
  const [busy, setBusy] = useState(false);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [removedItemIds, setRemovedItemIds] = useState([]);

  const [fromTemplate, setFromTemplate] = useState(null);
  const [fromDraft, setFromDraft] = useState(null);
  const [fromError, setFromError] = useState('');
  const [fromBusy, setFromBusy] = useState(false);

  // Any save/toggle bumps the token; the one effect below fetches again —
  // same shape SafetyPpeSetsAdmin.jsx/AssetCustodyUnitsAdmin.jsx's own refresh().
  const refresh = useCallback(() => {
    setLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadTemplates({ includeInactive }).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setRows([]);
        setNotice({ tone: 'error', text: operationsErrorMessage(t, error) || t('admin_load_failed') });
      } else {
        setRows(data || []);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [reloadToken, includeInactive, t]);

  useEffect(() => {
    let cancelled = false;
    loadOrgDimensions().then(({ data }) => {
      if (cancelled || !data) return;
      setSites(data.sites || []);
    });
    return () => { cancelled = true; };
  }, []);

  const siteById = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);

  // loadTemplates() takes no search parameter, so filtering happens here over
  // the already-fetched set — same reasoning SafetyPpeSetsAdmin.jsx's own
  // local, non-debounced search documents.
  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => `${row.name_ar || ''} ${row.name_en || ''} ${row.customer_name || ''}`
      .toLowerCase().includes(needle));
  }, [rows, search]);

  const openCreate = () => {
    setDraftError('');
    setRemovedItemIds([]);
    setDraft(emptyTemplateDraft());
    setItemsLoading(false);
  };

  const openEdit = (row) => {
    setDraftError('');
    setRemovedItemIds([]);
    setDraft(toTemplateDraft(row));
    setItemsLoading(true);
    loadTemplateChecklistItems(row.id).then(({ data, error }) => {
      if (error) setNotice({ tone: 'error', text: operationsErrorMessage(t, error) });
      setDraft((current) => (current && current.id === row.id ? { ...current, items: (data || []).map(itemRowFromRecord) } : current));
      setItemsLoading(false);
    });
  };

  const save = async () => {
    const itemsErrorCode = validateItems(draft.items);
    if (itemsErrorCode) { setDraftError(t(itemsErrorCode)); return; }

    setBusy(true);
    setDraftError('');

    const { data: newId, error: headerError } = await saveTemplate(draft);
    if (headerError) {
      setBusy(false);
      setDraftError(operationsErrorMessage(t, headerError));
      return;
    }
    const templateId = draft.id || newId;

    for (const removedId of removedItemIds) {
      // Removals must land before the surviving rows are saved below, and
      // there is no batch RPC to fold these into (see this file's own header
      // comment) — sequential is intentional here, not an oversight.
      const { error: removeError } = await removeTemplateChecklistItem(removedId);
      if (removeError) {
        setBusy(false);
        setDraftError(operationsErrorMessage(t, removeError));
        if (!draft.id) setDraft((current) => ({ ...current, id: templateId }));
        return;
      }
      // Drop the id as soon as it's confirmed removed so a retry after a
      // later failure in this same loop doesn't replay it against a row
      // that's already soft-deleted (which would raise TEMPLATE_ITEM_NOT_FOUND).
      setRemovedItemIds((current) => current.filter((id) => id !== removedId));
    }

    for (const row of draft.items) {
      // Each item's own RPC call is sequential by design — no batch upsert
      // exists for template checklist items (see this file's own header
      // comment for why this screen diffs and loops instead).
      const { data: savedItemId, error: itemError } = await saveTemplateChecklistItem({
        id: row.id, template_id: templateId, title_ar: row.title_ar, title_en: row.title_en, display_order: row.display_order,
      });
      if (itemError) {
        setBusy(false);
        setDraftError(operationsErrorMessage(t, itemError));
        if (!draft.id) setDraft((current) => ({ ...current, id: templateId }));
        return;
      }
      // Patch the new id back onto the local row so a retry after a later
      // failure in this same loop issues an UPDATE (not a duplicate INSERT)
      // for items already saved — mirrors the header's own id-patch above.
      setDraft((current) => ({
        ...current,
        items: current.items.map((r) => (r.localId === row.localId ? { ...r, id: savedItemId } : r)),
      }));
    }

    setBusy(false);
    setDraft(null);
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refresh();
  };

  // Switching a template off still drops it out of the default (active-only)
  // view on the next refresh, but it stays reachable with "show inactive" on.
  const toggleActive = async (row) => {
    const { error } = await saveTemplate({ ...row, is_active: !row.is_active });
    if (error) {
      setNotice({ tone: 'error', text: operationsErrorMessage(t, error) });
      return;
    }
    setNotice({ tone: 'success', text: t('admin_save_done') });
    refresh();
  };

  const openCreateFromTemplate = (row) => {
    setFromError('');
    setFromTemplate(row);
    setFromDraft({
      nameAr: row.name_ar || '',
      nameEn: row.name_en || '',
      siteId: row.site_id || '',
      customerName: row.customer_name || '',
      startDate: '',
      endDate: '',
    });
  };

  const submitCreateFromTemplate = async () => {
    setFromBusy(true);
    setFromError('');
    const { data: newOperationId, error } = await createOperationFromTemplate({
      templateId: fromTemplate.id,
      nameAr: fromDraft.nameAr,
      nameEn: fromDraft.nameEn,
      siteId: fromDraft.siteId || null,
      customerName: fromDraft.customerName,
      startDate: fromDraft.startDate,
      endDate: fromDraft.endDate || null,
    });
    if (error) {
      setFromBusy(false);
      setFromError(operationsErrorMessage(t, error));
      return;
    }

    // Fetching the new operation back for its generated "number" is a nice
    // touch for the success message, but must never block the otherwise
    // successful create — a lookup failure just falls back to a plain
    // confirmation, per this screen's own "keep it simple" spec.
    const { data: newOperation } = await loadOperation(newOperationId);
    setFromBusy(false);
    setFromTemplate(null);
    setFromDraft(null);
    setNotice({
      tone: 'success',
      text: newOperation?.number
        ? t('operations_templates_create_operation_success', { number: newOperation.number })
        : t('admin_save_done'),
    });
  };

  return (
    <div className="admin-content">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('operations_module_kicker')}</span>
          <h1><Copy className="admin-title-icon" aria-hidden="true" /> {t('operations_templates_title')}</h1>
          <p>{t('operations_templates_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="primary-button" onClick={openCreate}>
            <Plus aria-hidden="true" /> {t('operations_templates_add')}
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
              <th>{t('label_name_1')}</th>
              <th>{t('label_name_2')}</th>
              <th>{t('operations_field_customer')}</th>
              <th>{t('label_site')}</th>
              <th>{t('label_status')}</th>
              <th aria-label={t('label_actions')} />
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.id} style={row.is_active === false ? { opacity: 0.6 } : undefined}>
                <td>
                  <b>{row.name_ar}</b>
                  {row.is_active === false && <span className="aging-badge">{t('label_inactive')}</span>}
                </td>
                <td>{row.name_en || '—'}</td>
                <td>{row.customer_name || '—'}</td>
                <td>{pickLocalized(siteById.get(row.site_id), 'name', lang) || '—'}</td>
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
                    <button
                      type="button"
                      title={t('operations_templates_create_operation')}
                      aria-label={t('operations_templates_create_operation')}
                      onClick={() => openCreateFromTemplate(row)}
                    >
                      <Rocket aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && !filteredRows.length && (
              <tr>
                <td colSpan={6}>
                  <div className="empty-table">
                    <Copy aria-hidden="true" />
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
        <TemplateDialog
          draft={draft}
          sites={sites}
          itemsLoading={itemsLoading}
          busy={busy}
          error={draftError}
          onChange={setDraft}
          onRemoveExistingItem={(id) => setRemovedItemIds((current) => [...current, id])}
          onClose={() => setDraft(null)}
          onSubmit={save}
        />
      )}

      {fromTemplate && fromDraft && (
        <CreateFromTemplateDialog
          template={fromTemplate}
          draft={fromDraft}
          sites={sites}
          busy={fromBusy}
          error={fromError}
          onChange={setFromDraft}
          onClose={() => { setFromTemplate(null); setFromDraft(null); }}
          onSubmit={submitCreateFromTemplate}
        />
      )}
    </div>
  );
};

export default OperationsTemplatesAdmin;
