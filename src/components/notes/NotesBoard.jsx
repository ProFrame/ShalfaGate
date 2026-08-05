// The full notepad: a Keep-style masonry board with colours, pinning,
// checklists, drag-to-reorder, search and an archive.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, Plus, Search, StickyNote, Trash2, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import {
  deleteNote,
  engagementErrorMessage,
  loadNotes,
  reorderNotes,
  saveNote,
  setNoteFlags,
} from '../../data/engagementService';
import { ConfirmDialog, StatusLine } from '../announcements/engagementUi';
import NoteCard, { ColorPicker } from './NoteCard';
import './notes.css';

const newItemId = () => `new-${Math.random().toString(36).slice(2, 9)}`;

const emptyNote = () => ({
  id: null,
  title: '',
  body: '',
  color: 'Default',
  is_pinned: false,
  is_archived: false,
  items: [],
});

const NoteEditor = ({ draft, onChange, onClose, onSave, busy, message }) => {
  const { t } = useLanguage();

  const setItem = (id, patch) => onChange({
    ...draft,
    items: draft.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  });

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card note-editor"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? t('note_edit') : t('note_new')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('module_notes')}</span>
            <h3>{draft.id ? t('note_edit') : t('note_new')}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="note-editor-fields">
          <label className="field-label" htmlFor="note-title">
            {t('note_title_placeholder')}
            <input
              id="note-title"
              className="form-input"
              value={draft.title}
              onChange={(event) => onChange({ ...draft, title: event.target.value })}
              placeholder={t('note_title_placeholder')}
            />
          </label>

          <label className="field-label" htmlFor="note-body">
            {t('note_body_placeholder')}
            <textarea
              id="note-body"
              className="form-input"
              rows={5}
              value={draft.body}
              onChange={(event) => onChange({ ...draft, body: event.target.value })}
              placeholder={t('note_body_placeholder')}
            />
          </label>

          <div className="field-label">
            {t('note_checklist')}
            <div className="note-editor-items">
              {draft.items.map((item, index) => (
                <div className="note-editor-item" key={item.id}>
                  <input
                    type="checkbox"
                    checked={item.is_done}
                    onChange={(event) => setItem(item.id, { is_done: event.target.checked })}
                    aria-label={`${t('note_checklist')} ${index + 1}`}
                  />
                  <input
                    type="text"
                    className="form-input"
                    value={item.content}
                    onChange={(event) => setItem(item.id, { content: event.target.value })}
                    placeholder={t('note_item_placeholder')}
                    aria-label={`${t('note_item_placeholder')} ${index + 1}`}
                  />
                  <button
                    type="button"
                    onClick={() => onChange({ ...draft, items: draft.items.filter((row) => row.id !== item.id) })}
                    aria-label={t('note_remove_item')}
                    title={t('note_remove_item')}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="secondary-button"
                onClick={() => onChange({
                  ...draft,
                  items: [...draft.items, { id: newItemId(), content: '', is_done: false }],
                })}
              >
                <Plus size={15} aria-hidden="true" />
                {t('note_add_item')}
              </button>
            </div>
          </div>

          <div className="field-label">
            {t('note_color')}
            <ColorPicker value={draft.color} onChange={(color) => onChange({ ...draft, color })} />
          </div>

          <div className="engagement-toggle-row">
            <label className="engagement-toggle" htmlFor="note-pinned">
              <input
                id="note-pinned"
                type="checkbox"
                checked={draft.is_pinned}
                onChange={(event) => onChange({ ...draft, is_pinned: event.target.checked })}
              />
              {t('note_pin')}
            </label>
          </div>
        </div>

        <StatusLine message={message} tone="error" />

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button type="button" className="primary-button" onClick={onSave} disabled={busy}>
            {busy ? t('eng_saving') : t('action_save')}
          </button>
        </div>
      </div>
    </div>
  );
};

const NotesBoard = () => {
  const { t } = useLanguage();

  const [view, setView] = useState('active');
  const [notes, setNotes] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState('info');

  // A token drives reloading, so nothing sets state synchronously in an effect.
  const [reloadToken, setReloadToken] = useState(0);
  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    loadNotes({ archived: view === 'archive' }).then(({ data, error }) => {
      if (cancelled) return;
      setNotes(Array.isArray(data) ? data : []);
      if (error) { setMessage(engagementErrorMessage(t, error)); setTone('error'); }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [view, reloadToken, t]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return notes;
    return notes.filter((note) => {
      const haystack = [note.title, note.body, ...(note.items || []).map((item) => item.content)]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [notes, search]);

  const pinned = filtered.filter((note) => note.is_pinned);
  const others = filtered.filter((note) => !note.is_pinned);

  const report = (error, successKey) => {
    if (error) { setMessage(engagementErrorMessage(t, error)); setTone('error'); return false; }
    if (successKey) { setMessage(t(successKey)); setTone('info'); }
    return true;
  };

  const save = async () => {
    setBusy(true);
    const { error } = await saveNote(draft);
    setBusy(false);
    if (!report(error, 'note_saved')) return;
    setDraft(null);
    refresh();
  };

  const togglePin = async (note) => {
    const { error } = await setNoteFlags(note.id, { is_pinned: !note.is_pinned });
    if (report(error)) refresh();
  };

  const toggleArchive = async (note) => {
    const { error } = await setNoteFlags(note.id, { is_archived: !note.is_archived });
    if (report(error, note.is_archived ? 'note_saved' : 'note_archived')) refresh();
  };

  const toggleItem = async (note, item) => {
    const items = note.items.map((row) => (row.id === item.id ? { ...row, is_done: !row.is_done } : row));
    setNotes((current) => current.map((row) => (row.id === note.id ? { ...row, items } : row)));
    const { error } = await saveNote({ ...note, items });
    if (error) { report(error); refresh(); }
  };

  const confirmDelete = async () => {
    setBusy(true);
    const { error } = await deleteNote(pendingDelete.id);
    setBusy(false);
    setPendingDelete(null);
    if (report(error, 'note_deleted')) refresh();
  };

  const applyOrder = async (ordered) => {
    setNotes(ordered);
    const { error } = await reorderNotes(ordered.map((note) => note.id));
    if (error) { report(error); refresh(); }
  };

  const moveBy = (note, delta) => {
    const ordered = [...filtered];
    const from = ordered.findIndex((row) => row.id === note.id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= ordered.length) return;
    ordered.splice(to, 0, ordered.splice(from, 1)[0]);
    applyOrder(ordered);
  };

  const onDrop = (target) => {
    if (!dragId || dragId === target.id) { setDragId(null); setOverId(null); return; }
    const ordered = [...filtered];
    const from = ordered.findIndex((row) => row.id === dragId);
    const to = ordered.findIndex((row) => row.id === target.id);
    if (from === -1 || to === -1) { setDragId(null); setOverId(null); return; }
    ordered.splice(to, 0, ordered.splice(from, 1)[0]);
    setDragId(null);
    setOverId(null);
    applyOrder(ordered);
  };

  const cardProps = (note) => ({
    note,
    onEdit: (target) => setDraft({ ...emptyNote(), ...target }),
    onTogglePin: view === 'active' ? togglePin : undefined,
    onToggleArchive: toggleArchive,
    onDelete: setPendingDelete,
    onToggleItem: toggleItem,
    onMoveUp: view === 'active' ? (target) => moveBy(target, -1) : undefined,
    onMoveDown: view === 'active' ? (target) => moveBy(target, 1) : undefined,
    draggable: view === 'active',
    dragging: dragId === note.id,
    dropTarget: overId === note.id && dragId !== note.id,
    onDragStart: () => setDragId(note.id),
    onDragOver: (event) => { event.preventDefault(); setOverId(note.id); },
    onDrop: (event) => { event.preventDefault(); onDrop(note); },
    onDragEnd: () => { setDragId(null); setOverId(null); },
  });

  return (
    <main className="app-main notes-board">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('module_notes')}</span>
          <h1>{t('module_notes')}</h1>
          <p>{t('note_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="primary-button" onClick={() => setDraft(emptyNote())}>
            <Plus size={17} aria-hidden="true" />
            {t('note_new')}
          </button>
        </div>
      </div>

      <div className="notes-board-toolbar">
        <div className="segmented" role="group" aria-label={t('label_status')}>
          <button
            type="button"
            className={view === 'active' ? 'active' : ''}
            onClick={() => { setLoading(true); setView('active'); }}
            aria-pressed={view === 'active'}
          >
            <StickyNote size={14} aria-hidden="true" /> {t('note_active_view')}
          </button>
          <button
            type="button"
            className={view === 'archive' ? 'active' : ''}
            onClick={() => { setLoading(true); setView('archive'); }}
            aria-pressed={view === 'archive'}
          >
            <Archive size={14} aria-hidden="true" /> {t('note_archive_view')}
          </button>
        </div>
        <div className="search-control">
          <Search aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('note_search')}
            aria-label={t('note_search')}
          />
          {search && (
            <button type="button" className="search-clear" onClick={() => setSearch('')} aria-label={t('action_clear')}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <span className="result-count">{t('note_count', { count: filtered.length })}</span>
      </div>

      {view === 'active' && <p className="field-note">{t('note_reorder_hint')}</p>}

      <StatusLine message={message} tone={tone} />

      {loading && <p className="field-note">{t('label_loading')}</p>}

      {!loading && !filtered.length && (
        <div className="engagement-panel">
          <div className="engagement-empty">
            {view === 'archive' ? <Archive aria-hidden="true" /> : <StickyNote aria-hidden="true" />}
            <b>{search
              ? t('note_no_results')
              : (view === 'archive' ? t('note_archive_empty') : t('note_empty_title'))}</b>
            {!search && view === 'active' && <p>{t('note_empty_hint')}</p>}
          </div>
        </div>
      )}

      {!loading && pinned.length > 0 && (
        <section aria-label={t('note_pinned_group')}>
          <h2 className="notes-group-title">{t('note_pinned_group')}</h2>
          <div className="notes-masonry">
            {pinned.map((note) => <NoteCard key={note.id} {...cardProps(note)} />)}
          </div>
        </section>
      )}

      {!loading && others.length > 0 && (
        <section aria-label={pinned.length ? t('note_others_group') : t('note_active_view')}>
          {pinned.length > 0 && <h2 className="notes-group-title">{t('note_others_group')}</h2>}
          <div className="notes-masonry">
            {others.map((note) => <NoteCard key={note.id} {...cardProps(note)} />)}
          </div>
        </section>
      )}

      {draft && (
        <NoteEditor
          draft={draft}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={save}
          busy={busy}
          message={tone === 'error' ? message : ''}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t('action_delete')}
          message={t('note_delete_confirm')}
          confirmLabel={t('action_delete')}
          busy={busy}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </main>
  );
};

export default NotesBoard;
