// The notepad on the home page: a quick-add line and the few most recent
// notes, with everything else one click away on the full board.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, ArrowRight, Plus, StickyNote } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { engagementErrorMessage, loadNotes, saveNote, setNoteFlags } from '../../data/engagementService';
import { StatusLine } from '../announcements/engagementUi';
import NoteCard from './NoteCard';
import './notes.css';

const VISIBLE_NOTES = 3;

const NotesWidget = () => {
  const { t, isRtl } = useLanguage();
  const { hasModule } = useTenant();

  const [notes, setNotes] = useState([]);
  const [quick, setQuick] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  // A token drives reloading, so nothing sets state synchronously in an effect.
  const [reloadToken, setReloadToken] = useState(0);
  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    loadNotes({ archived: false }).then(({ data, error }) => {
      if (cancelled) return;
      setNotes(Array.isArray(data) ? data : []);
      setMessage(error ? engagementErrorMessage(t, error) : '');
    });
    return () => { cancelled = true; };
  }, [reloadToken, t]);

  const addQuickNote = async (event) => {
    event.preventDefault();
    const text = quick.trim();
    if (!text) return;
    setBusy(true);
    const { error } = await saveNote({ title: text, body: '', color: 'Yellow', items: [] });
    setBusy(false);
    if (error) { setMessage(engagementErrorMessage(t, error)); return; }
    setQuick('');
    setMessage('');
    refresh();
  };

  const togglePin = async (note) => {
    const { error } = await setNoteFlags(note.id, { is_pinned: !note.is_pinned });
    if (error) { setMessage(engagementErrorMessage(t, error)); return; }
    refresh();
  };

  if (!hasModule('NOTES')) return null;

  return (
    <section className="notes-widget" aria-label={t('module_notes')}>
      <header className="notes-widget-head">
        <span className="notes-widget-icon"><StickyNote aria-hidden="true" /></span>
        <div>
          <h2>{t('module_notes')}</h2>
          <p>{t('note_intro')}</p>
        </div>
      </header>

      <form className="notes-quick-add" onSubmit={addQuickNote}>
        <label className="sr-only" htmlFor="notes-quick-add">{t('note_quick_add')}</label>
        <input
          id="notes-quick-add"
          className="form-input"
          value={quick}
          onChange={(event) => setQuick(event.target.value)}
          placeholder={t('note_quick_add')}
        />
        <button type="submit" className="primary-button" disabled={busy || !quick.trim()}>
          <Plus size={16} aria-hidden="true" />
          <span className="sr-only">{t('action_add')}</span>
        </button>
      </form>

      {notes.length ? (
        <div className="notes-stack">
          {notes.slice(0, VISIBLE_NOTES).map((note) => (
            <NoteCard key={note.id} note={note} compact onTogglePin={togglePin} />
          ))}
        </div>
      ) : (
        <div className="engagement-empty">
          <StickyNote aria-hidden="true" />
          <b>{t('note_empty_title')}</b>
          <p>{t('note_empty_hint')}</p>
        </div>
      )}

      <div className="notes-widget-foot">
        <Link href="/app/notes" className="engagement-link">
          {t('note_open_board')}
          {isRtl ? <ArrowLeft size={15} aria-hidden="true" /> : <ArrowRight size={15} aria-hidden="true" />}
        </Link>
      </div>

      <StatusLine message={message} tone="error" />
    </section>
  );
};

export default NotesWidget;
