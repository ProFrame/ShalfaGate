import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search, UserPlus, Users, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { pickLocalized } from '../../utils/localize';
import { chatErrorText } from '../../data/chatService';
import { ChatAvatar, displayName } from './MessageBubble';

/**
 * Start a direct conversation or a group, and also the "add members" step of
 * an existing group. Blocked colleagues are never offered.
 *
 * @param {object}   props
 * @param {'new'|'add'} props.mode
 * @param {Array}    props.directory     everyone in the company
 * @param {string[]} props.blockedIds    ids this user has blocked
 * @param {string[]} props.excludeIds    ids already in the conversation
 * @param {Function} props.onSubmit      ({ kind, userIds, title })
 */
const NewConversationDialog = ({
  mode = 'new',
  directory = [],
  blockedIds = [],
  excludeIds = [],
  currentUserId,
  privateEnabled = true,
  groupsEnabled = true,
  busy = false,
  errorCode = null,
  onSubmit,
  onClose,
}) => {
  const { t, lang } = useLanguage();
  const searchRef = useRef(null);
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState([]);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState(() => {
    if (mode === 'add') return 'Group';
    if (!privateEnabled) return 'Group';
    return 'Direct';
  });
  const [validation, setValidation] = useState('');

  useEffect(() => { searchRef.current?.focus(); }, []);

  const people = useMemo(() => {
    const blocked = new Set(blockedIds);
    const excluded = new Set([...excludeIds, currentUserId]);
    const needle = term.trim().toLowerCase();
    return directory
      .filter((person) => person && !blocked.has(person.id) && !excluded.has(person.id))
      .filter((person) => {
        if (!needle) return true;
        const haystack = [
          pickLocalized(person, 'name', lang, person.full_name || ''),
          person.full_name, person.employee_no, person.department,
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(needle);
      });
  }, [blockedIds, currentUserId, directory, excludeIds, lang, term]);

  const multi = mode === 'add' || kind === 'Group';

  const toggle = (person) => {
    setValidation('');
    setSelected((current) => {
      if (!multi) return current.includes(person.id) ? [] : [person.id];
      return current.includes(person.id)
        ? current.filter((id) => id !== person.id)
        : [...current, person.id];
    });
  };

  const chosen = selected
    .map((id) => directory.find((person) => person.id === id))
    .filter(Boolean);

  const submit = () => {
    if (mode === 'add') {
      if (!selected.length) { setValidation('chat_pick_group_members'); return; }
      onSubmit({ kind: 'Add', userIds: selected, title: null });
      return;
    }
    if (kind === 'Direct') {
      if (selected.length !== 1) { setValidation('chat_pick_one_person'); return; }
      onSubmit({ kind: 'Direct', userIds: selected, title: null });
      return;
    }
    if (!selected.length || !title.trim()) { setValidation('chat_pick_group_members'); return; }
    onSubmit({ kind: 'Group', userIds: selected, title: title.trim() });
  };

  const heading = mode === 'add' ? t('chat_add_members') : t('chat_new_conversation');

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card chat-modal"
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('module_chat')}</span>
            <h3>{heading}</h3>
          </div>
          <button type="button" className="icon-button" aria-label={t('action_close')} onClick={onClose}><X /></button>
        </div>

        <div className="chat-modal-body">
          <p className="field-note">
            {mode === 'add' ? t('chat_add_members') : t('chat_new_conversation_hint')}
          </p>

          {mode === 'new' && privateEnabled && groupsEnabled ? (
            <div className="segmented" role="tablist" aria-label={t('chat_new_conversation')}>
              <button
                type="button"
                role="tab"
                aria-selected={kind === 'Direct'}
                className={kind === 'Direct' ? 'active' : ''}
                onClick={() => { setKind('Direct'); setSelected([]); setValidation(''); }}
              >
                {t('chat_mode_direct')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={kind === 'Group'}
                className={kind === 'Group' ? 'active' : ''}
                onClick={() => { setKind('Group'); setSelected([]); setValidation(''); }}
              >
                {t('chat_mode_group')}
              </button>
            </div>
          ) : null}

          {multi && mode === 'new' ? (
            <label className="field-label" htmlFor="chat-group-title">
              {t('chat_group_name')}
              <input
                id="chat-group-title"
                className="form-input"
                type="text"
                value={title}
                placeholder={t('chat_group_name_placeholder')}
                onChange={(event) => { setTitle(event.target.value); setValidation(''); }}
              />
            </label>
          ) : null}

          <div className="chat-search">
            <Search aria-hidden="true" />
            <label className="sr-only" htmlFor="chat-people-search">{t('chat_search_people')}</label>
            <input
              id="chat-people-search"
              ref={searchRef}
              type="search"
              value={term}
              placeholder={t('chat_search_people')}
              onChange={(event) => setTerm(event.target.value)}
            />
          </div>

          {chosen.length ? (
            <div className="chat-chip-row" aria-label={t('chat_selected_people', { count: chosen.length })}>
              {chosen.map((person) => (
                <span key={person.id}>
                  {displayName(person, lang, person.full_name)}
                  <button
                    type="button"
                    aria-label={t('action_remove')}
                    title={t('action_remove')}
                    onClick={() => toggle(person)}
                  >
                    <X />
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <div className="chat-people-list" role="listbox" aria-label={t('chat_search_people')}>
            {people.length ? people.map((person) => {
              const isSelected = selected.includes(person.id);
              return (
                <button
                  key={person.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={isSelected ? 'selected' : ''}
                  onClick={() => toggle(person)}
                >
                  <ChatAvatar user={person} small />
                  <span>
                    <b>{displayName(person, lang, person.full_name)}</b>
                    <small>{[person.department, person.employee_no].filter(Boolean).join(' · ')}</small>
                  </span>
                  {isSelected ? <Check /> : null}
                </button>
              );
            }) : (
              <p className="chat-thread-note">{t('chat_no_people')}</p>
            )}
          </div>

          <p className="field-note">{t('chat_blocked_hidden')}</p>

          {validation ? <p className="chat-composer-note error">{t(validation)}</p> : null}
          {errorCode ? <p className="chat-composer-note error">{chatErrorText(t, errorCode)}</p> : null}
        </div>

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
          <button type="button" className="primary-button" disabled={busy} onClick={submit}>
            {mode === 'add'
              ? <><UserPlus size={16} />{t('chat_add_members')}</>
              : (multi
                ? <><Users size={16} />{t('chat_create_group')}</>
                : t('chat_start_conversation'))}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewConversationDialog;
