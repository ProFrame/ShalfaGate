// One note. The board renders it with every affordance; the home widget renders
// a quieter version with the actions it does not need switched off.

import { Archive, ArchiveRestore, ChevronDown, ChevronUp, GripVertical, Pencil, Pin, Trash2 } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { formatRelative } from '../../utils/localize';
import { NOTE_COLORS } from '../../data/engagementService';
import './notes.css';

const noteColorLabelKey = (color) => `note_color_${String(color || 'default').toLowerCase()}`;

export const ColorPicker = ({ value, onChange }) => {
  const { t } = useLanguage();
  return (
    <div className="note-colors" role="group" aria-label={t('note_color')}>
      {NOTE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={`note-color-swatch${value === color ? ' active' : ''}`}
          data-color={color}
          onClick={() => onChange(color)}
          aria-label={t(noteColorLabelKey(color))}
          title={t(noteColorLabelKey(color))}
          aria-pressed={value === color}
        />
      ))}
    </div>
  );
};

const NoteCard = ({
  note,
  onEdit,
  onTogglePin,
  onToggleArchive,
  onDelete,
  onToggleItem,
  compact = false,
  draggable = false,
  dragging = false,
  dropTarget = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onMoveUp,
  onMoveDown,
}) => {
  const { t, locale } = useLanguage();
  const title = note.title || (note.items?.length ? t('note_checklist') : t('note_untitled'));

  return (
    <article
      className={[
        'note-card',
        dragging ? 'dragging' : '',
        dropTarget ? 'drop-target' : '',
      ].filter(Boolean).join(' ')}
      data-color={note.color}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      aria-label={title}
    >
      <div className="note-card-head">
        {draggable && (
          <span className="note-drag" aria-hidden="true"><GripVertical size={15} /></span>
        )}
        <h3>{title}</h3>
        {onTogglePin && (
          <button
            type="button"
            className={`note-pin${note.is_pinned ? ' active' : ''}`}
            onClick={() => onTogglePin(note)}
            aria-label={note.is_pinned ? t('note_unpin') : t('note_pin')}
            title={note.is_pinned ? t('note_unpin') : t('note_pin')}
            aria-pressed={note.is_pinned}
          >
            <Pin size={15} aria-hidden="true" />
          </button>
        )}
      </div>

      {note.body && <p className={`note-body${compact ? ' clamp' : ''}`}>{note.body}</p>}

      {note.items?.length > 0 && (
        <ul className="note-items">
          {note.items.map((item) => (
            <li key={item.id} className={`note-item${item.is_done ? ' done' : ''}`}>
              <input
                id={`note-item-${note.id}-${item.id}`}
                type="checkbox"
                checked={item.is_done}
                disabled={!onToggleItem}
                onChange={() => onToggleItem?.(note, item)}
              />
              <label htmlFor={`note-item-${note.id}-${item.id}`}>
                <span>{item.content}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {!compact && (
        <div className="note-card-foot">
          <small>{formatRelative(note.updated_on, locale)}</small>
          {onMoveUp && (
            <button type="button" onClick={() => onMoveUp(note)} aria-label={t('note_move_up')} title={t('note_move_up')}>
              <ChevronUp size={15} aria-hidden="true" />
            </button>
          )}
          {onMoveDown && (
            <button
              type="button"
              onClick={() => onMoveDown(note)}
              aria-label={t('note_move_down')}
              title={t('note_move_down')}
            >
              <ChevronDown size={15} aria-hidden="true" />
            </button>
          )}
          {onEdit && (
            <button type="button" onClick={() => onEdit(note)} aria-label={t('action_edit')} title={t('action_edit')}>
              <Pencil size={15} aria-hidden="true" />
            </button>
          )}
          {onToggleArchive && (
            <button
              type="button"
              onClick={() => onToggleArchive(note)}
              aria-label={note.is_archived ? t('action_restore') : t('action_archive')}
              title={note.is_archived ? t('action_restore') : t('action_archive')}
            >
              {note.is_archived
                ? <ArchiveRestore size={15} aria-hidden="true" />
                : <Archive size={15} aria-hidden="true" />}
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="danger"
              onClick={() => onDelete(note)}
              aria-label={t('action_delete')}
              title={t('action_delete')}
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </article>
  );
};

export default NoteCard;
