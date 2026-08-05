// Administration of the announcements board: the list, the editor and a live
// preview of exactly the card employees will see.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Megaphone, Pencil, Plus, Search, Trash2, Upload, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { formatDate, pickLocalized } from '../../utils/localize';
import { STORAGE_LAYER, putFile } from '../../lib/storage';
import {
  ANNOUNCEMENT_PRIORITIES,
  deleteAnnouncement,
  engagementErrorMessage,
  loadAnnouncements,
  saveAnnouncement,
} from '../../data/engagementService';
import AnnouncementCard from './AnnouncementCard';
import {
  AudienceField, ConfirmDialog, ModuleOffNotice, StatusLine, WindowBadge, publishingState,
} from './engagementUi';
import './announcements.css';

const emptyDraft = () => ({
  id: null,
  title_1: '',
  title_2: '',
  body_1: '',
  body_2: '',
  image_url: '',
  priority: 'Normal',
  publish_from: new Date().toISOString().slice(0, 10),
  publish_to: '',
  is_published: true,
  is_pinned: false,
  display_order: 0,
  audience: null,
});

const AnnouncementEditor = ({ draft, onChange, onClose, onSave, busy, message, tone }) => {
  const { t } = useLanguage();
  const { tenant } = useTenant();
  const [uploading, setUploading] = useState(false);

  const pickImage = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    const { data, error } = await putFile({
      layer: STORAGE_LAYER.EXTENDED,
      tenantId: tenant?.id,
      area: 'announcements',
      file,
      entityType: 'Announcement',
      entityId: draft.id,
    });
    setUploading(false);
    if (error) {
      onChange({ ...draft, uploadError: error.message });
      return;
    }
    onChange({ ...draft, image_url: data.url, uploadError: null });
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card announcement-editor"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? t('ann_edit') : t('ann_new')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('module_announcements')}</span>
            <h3>{draft.id ? t('ann_edit') : t('ann_new')}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="announcement-editor-layout">
          <div className="announcement-editor-fields">
            <label className="field-label" htmlFor="ann-title-1">
              {t('ann_title_1')}
              <input
                id="ann-title-1"
                className="form-input"
                value={draft.title_1}
                onChange={(event) => onChange({ ...draft, title_1: event.target.value })}
                placeholder={t('ann_title_1')}
                required
              />
            </label>

            <label className="field-label" htmlFor="ann-title-2">
              {t('ann_title_2')}
              <input
                id="ann-title-2"
                className="form-input"
                value={draft.title_2}
                onChange={(event) => onChange({ ...draft, title_2: event.target.value })}
                placeholder={t('ann_title_2')}
              />
            </label>

            <label className="field-label" htmlFor="ann-body-1">
              {t('ann_body_1')}
              <textarea
                id="ann-body-1"
                className="form-input"
                rows={5}
                value={draft.body_1}
                onChange={(event) => onChange({ ...draft, body_1: event.target.value })}
                placeholder={t('ann_body_placeholder')}
              />
            </label>

            <label className="field-label" htmlFor="ann-body-2">
              {t('ann_body_2')}
              <textarea
                id="ann-body-2"
                className="form-input"
                rows={4}
                value={draft.body_2}
                onChange={(event) => onChange({ ...draft, body_2: event.target.value })}
                placeholder={t('ann_body_placeholder')}
              />
            </label>
            <p className="field-note">{t('eng_language_note')}</p>

            <div className="field-label">
              {t('ann_image')}
              <div className="announcement-image-row">
                <input
                  className="form-input"
                  value={draft.image_url}
                  onChange={(event) => onChange({ ...draft, image_url: event.target.value })}
                  placeholder={t('ann_image_url')}
                  aria-label={t('ann_image_url')}
                />
                <label className="secondary-button">
                  <Upload size={16} aria-hidden="true" />
                  {uploading ? t('eng_saving') : t('ann_image_pick')}
                  <input type="file" accept="image/*" className="sr-only" onChange={pickImage} />
                </label>
                {draft.image_url && (
                  <button
                    type="button"
                    className="secondary-button danger"
                    onClick={() => onChange({ ...draft, image_url: '' })}
                  >
                    {t('ann_image_clear')}
                  </button>
                )}
              </div>
              {draft.uploadError && (
                <p className="field-note" role="alert">{engagementErrorMessage(t, { message: draft.uploadError })}</p>
              )}
            </div>

            <div className="form-grid">
              <label className="field-label" htmlFor="ann-priority">
                {t('ann_priority')}
                <select
                  id="ann-priority"
                  className="form-input"
                  value={draft.priority}
                  onChange={(event) => onChange({ ...draft, priority: event.target.value })}
                >
                  {ANNOUNCEMENT_PRIORITIES.map((code) => (
                    <option key={code} value={code}>{t(`ann_priority_${code.toLowerCase()}`)}</option>
                  ))}
                </select>
              </label>

              <label className="field-label" htmlFor="ann-order">
                {t('label_display_order')}
                <input
                  id="ann-order"
                  type="number"
                  className="form-input"
                  value={draft.display_order}
                  onChange={(event) => onChange({ ...draft, display_order: event.target.value })}
                />
              </label>

              <label className="field-label" htmlFor="ann-from">
                {t('ann_publish_from')}
                <input
                  id="ann-from"
                  type="date"
                  className="form-input"
                  value={draft.publish_from || ''}
                  onChange={(event) => onChange({ ...draft, publish_from: event.target.value })}
                />
              </label>

              <label className="field-label" htmlFor="ann-to">
                {t('ann_publish_to')}
                <input
                  id="ann-to"
                  type="date"
                  className="form-input"
                  value={draft.publish_to || ''}
                  onChange={(event) => onChange({ ...draft, publish_to: event.target.value })}
                />
              </label>
            </div>

            <div className="engagement-toggle-row">
              <label className="engagement-toggle" htmlFor="ann-published">
                <input
                  id="ann-published"
                  type="checkbox"
                  checked={draft.is_published}
                  onChange={(event) => onChange({ ...draft, is_published: event.target.checked })}
                />
                {t('ann_is_published')}
              </label>
              <label className="engagement-toggle" htmlFor="ann-pinned">
                <input
                  id="ann-pinned"
                  type="checkbox"
                  checked={draft.is_pinned}
                  onChange={(event) => onChange({ ...draft, is_pinned: event.target.checked })}
                />
                {t('ann_is_pinned')}
              </label>
            </div>

            <AudienceField
              entityType="Announcement"
              entityId={draft.id}
              value={draft.audience}
              onChange={(audience) => onChange({ ...draft, audience })}
            />
          </div>

          <aside className="announcement-editor-preview">
            <span>{t('ann_preview')}</span>
            <AnnouncementCard
              announcement={{
                ...draft,
                id: draft.id || 'preview',
                title_1: draft.title_1 || t('ann_untitled'),
                created_on: draft.publish_from || new Date().toISOString(),
              }}
              showActions={false}
            />
            <p className="field-note">{t('ann_preview_hint')}</p>
            {!draft.title_1.trim() && <p className="field-note">{t('error_required_field')}</p>}
          </aside>
        </div>

        <StatusLine message={message} tone={tone} />

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button type="button" className="primary-button" onClick={onSave} disabled={busy || !draft.title_1.trim()}>
            {busy ? t('eng_saving') : t('action_save')}
          </button>
        </div>
      </div>
    </div>
  );
};

const AnnouncementsAdmin = () => {
  const { t, lang, locale } = useLanguage();
  const { hasModule } = useTenant();

  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState('info');

  // Reloading is driven by a token rather than by calling a loader from the
  // effect, so the effect body never sets state synchronously.
  const [reloadToken, setReloadToken] = useState(0);
  const refresh = useCallback(() => { setLoading(true); setReloadToken((token) => token + 1); }, []);

  useEffect(() => {
    let cancelled = false;
    loadAnnouncements().then(({ data, error }) => {
      if (cancelled) return;
      setRows(Array.isArray(data) ? data : []);
      if (error) { setMessage(engagementErrorMessage(t, error)); setTone('error'); }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [reloadToken, t]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => `${row.title_1 || ''} ${row.title_2 || ''}`.toLowerCase().includes(needle));
  }, [rows, search]);

  const save = async () => {
    setBusy(true);
    const { error } = await saveAnnouncement(draft);
    setBusy(false);
    if (error) { setMessage(engagementErrorMessage(t, error)); setTone('error'); return; }
    setMessage(t('ann_saved'));
    setTone('info');
    setDraft(null);
    refresh();
  };

  const confirmDelete = async () => {
    setBusy(true);
    const { error } = await deleteAnnouncement(pendingDelete.id);
    setBusy(false);
    setPendingDelete(null);
    if (error) { setMessage(engagementErrorMessage(t, error)); setTone('error'); return; }
    setMessage(t('ann_deleted'));
    setTone('info');
    refresh();
  };

  if (!hasModule('ANNOUNCEMENTS')) return <ModuleOffNotice />;

  return (
    <section className="announcements-admin">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('module_announcements')}</span>
          <h1>{t('ann_board_title')}</h1>
          <p>{t('ann_admin_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="primary-button" onClick={() => setDraft(emptyDraft())}>
            <Plus size={17} aria-hidden="true" />
            {t('ann_new')}
          </button>
        </div>
      </div>

      <div className="announcements-admin-toolbar">
        <div className="search-control">
          <Search aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('ann_search')}
            aria-label={t('ann_search')}
          />
          {search && (
            <button type="button" className="search-clear" onClick={() => setSearch('')} aria-label={t('action_clear')}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <span className="result-count">{t('ann_count', { count: filtered.length })}</span>
      </div>

      <StatusLine message={message} tone={tone} />

      <div className="data-table-wrap">
        <table className="enterprise-table">
          <thead>
            <tr>
              <th scope="col">{t('ann_title_1')}</th>
              <th scope="col">{t('ann_priority')}</th>
              <th scope="col">{t('eng_period')}</th>
              <th scope="col">{t('label_status')}</th>
              <th scope="col">{t('label_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5}><div className="empty-table compact">{t('label_loading')}</div></td></tr>
            )}
            {!loading && !filtered.length && (
              <tr>
                <td colSpan={5}>
                  <div className="empty-table compact">
                    <Megaphone aria-hidden="true" />
                    <b>{t('ann_none_yet')}</b>
                  </div>
                </td>
              </tr>
            )}
            {!loading && filtered.map((row) => (
              <tr key={row.id}>
                <td>
                  <div className="announcement-title-cell">
                    <b>{pickLocalized(row, 'title', lang, t('ann_untitled'))}</b>
                    {row.is_pinned && <small>{t('ann_pinned')}</small>}
                  </div>
                </td>
                <td>{t(`ann_priority_${String(row.priority || 'Normal').toLowerCase()}`)}</td>
                <td>
                  {row.publish_from ? formatDate(row.publish_from, locale) : '—'}
                  {' · '}
                  {row.publish_to ? formatDate(row.publish_to, locale) : t('eng_always')}
                </td>
                <td><WindowBadge state={publishingState(row)} /></td>
                <td>
                  <div className="table-actions">
                    <button
                      type="button"
                      onClick={() => setDraft({ ...emptyDraft(), ...row, publish_to: row.publish_to || '' })}
                      aria-label={t('action_edit')}
                      title={t('action_edit')}
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setPendingDelete(row)}
                      aria-label={t('action_delete')}
                      title={t('action_delete')}
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

      {draft && (
        <AnnouncementEditor
          draft={draft}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={save}
          busy={busy}
          message={tone === 'error' ? message : ''}
          tone={tone}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t('action_delete')}
          message={t('ann_delete_confirm')}
          confirmLabel={t('action_delete')}
          busy={busy}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
};

export default AnnouncementsAdmin;
