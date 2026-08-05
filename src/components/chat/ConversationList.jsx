import { useEffect, useRef, useState } from 'react';
import {
  Ban, BellOff, LogOut, MessageSquare, MoreVertical, Paperclip, Pin, PinOff, Plus, Search, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { formatRelative } from '../../utils/localize';
import { chatErrorText, searchMessages } from '../../data/chatService';
import { ChatAvatar, displayName } from './MessageBubble';

const SEARCH_DEBOUNCE_MS = 320;

const RowMenu = ({ conversation, onClose, onTogglePin, onToggleMute, onLeaveGroup, onBlock, onUnblock }) => {
  const { t } = useLanguage();
  const ref = useRef(null);

  useEffect(() => {
    const handlePointer = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onClose();
    };
    document.addEventListener('mousedown', handlePointer);
    return () => document.removeEventListener('mousedown', handlePointer);
  }, [onClose]);

  return (
    <div className="chat-menu" role="menu" aria-label={t('chat_row_menu')} ref={ref}>
      <button type="button" role="menuitem" onClick={() => { onTogglePin(conversation); onClose(); }}>
        {conversation.is_pinned ? <PinOff /> : <Pin />}
        {conversation.is_pinned ? t('chat_unpin') : t('chat_pin')}
      </button>
      <button type="button" role="menuitem" onClick={() => { onToggleMute(conversation); onClose(); }}>
        <BellOff />{conversation.is_muted ? t('chat_unmute') : t('chat_mute')}
      </button>
      {conversation.kind === 'Group' ? (
        <button type="button" role="menuitem" className="danger" onClick={() => { onLeaveGroup(conversation); onClose(); }}>
          <LogOut />{t('chat_leave_group')}
        </button>
      ) : (
        <button
          type="button"
          role="menuitem"
          className={conversation.is_blocked ? '' : 'danger'}
          onClick={() => { (conversation.is_blocked ? onUnblock(conversation) : onBlock(conversation)); onClose(); }}
        >
          <Ban />{conversation.is_blocked ? t('chat_unblock') : t('chat_block')}
        </button>
      )}
    </div>
  );
};

const ConversationRow = ({ conversation, onOpen, menuOpen, onMenuToggle, menuHandlers }) => {
  const { t, lang, locale } = useLanguage();
  const isGroup = conversation.kind === 'Group';
  const title = isGroup
    ? (conversation.title || t('chat_group'))
    : displayName(conversation.other_user, lang, t('chat_someone'));
  const unread = Number(conversation.unread_count) || 0;
  const preview = conversation.last_message?.message_type === 'Attachment'
    ? t('chat_attachment_preview')
    : (conversation.last_message_preview || '');

  return (
    <div className={`chat-row${unread ? ' unread' : ''}`}>
      <button type="button" className="chat-row-open" onClick={() => onOpen(conversation)}>
        <ChatAvatar
          user={conversation.other_user}
          name={title}
          isGroup={isGroup}
          status={isGroup ? null : conversation.presence?.status}
        />
        <span className="chat-row-copy">
          <span className="chat-row-line">
            <b>{title}</b>
            {conversation.is_pinned ? <Pin aria-label={t('chat_pinned')} /> : null}
            {conversation.is_muted ? <BellOff aria-label={t('chat_muted')} /> : null}
            <time dateTime={conversation.last_message_at || ''}>
              {conversation.last_message_at ? formatRelative(conversation.last_message_at, locale) : ''}
            </time>
          </span>
          <span className="chat-row-preview" dir="auto">
            {conversation.last_message?.message_type === 'Attachment' ? <Paperclip size={11} aria-hidden="true" /> : null}
            {preview}
          </span>
        </span>
      </button>

      {unread ? <span className="chat-badge" aria-label={t('chat_unread_count', { count: unread })}>{unread}</span> : null}

      <span className="chat-menu-anchor">
        <button
          type="button"
          className="chat-icon-btn"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t('chat_row_menu')}
          title={t('chat_row_menu')}
          onClick={() => onMenuToggle(conversation.id)}
        >
          <MoreVertical />
        </button>
        {menuOpen ? (
          <RowMenu conversation={conversation} onClose={() => onMenuToggle(null)} {...menuHandlers} />
        ) : null}
      </span>
    </div>
  );
};

/**
 * The dock's conversation panel: search across conversations and message
 * bodies, pinned rows first, unread badges, presence and the row menu.
 */
const ConversationList = ({
  conversations = [],
  loading = false,
  errorCode = null,
  presence = 'Online',
  presenceCodes = [],
  onPresenceChange,
  onOpen,
  onOpenMessage,
  onNew,
  onTogglePin,
  onToggleMute,
  onLeaveGroup,
  onBlock,
  onUnblock,
}) => {
  const { t, lang } = useLanguage();
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState([]);
  const [openMenuId, setOpenMenuId] = useState(null);

  useEffect(() => {
    const needle = term.trim();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (needle.length < 2) {
        if (!cancelled) setHits([]);
        return;
      }
      searchMessages(needle).then(({ data }) => {
        if (!cancelled) setHits(data || []);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [term]);

  const needle = term.trim().toLowerCase();
  const visible = needle
    ? conversations.filter((conversation) => {
        const title = conversation.kind === 'Group'
          ? (conversation.title || '')
          : displayName(conversation.other_user, lang, '');
        return `${title} ${conversation.last_message_preview || ''}`.toLowerCase().includes(needle);
      })
    : conversations;

  const pinned = visible.filter((conversation) => conversation.is_pinned);
  const rest = visible.filter((conversation) => !conversation.is_pinned);

  const menuHandlers = { onTogglePin, onToggleMute, onLeaveGroup, onBlock, onUnblock };

  const renderRow = (conversation) => (
    <ConversationRow
      key={conversation.id}
      conversation={conversation}
      onOpen={onOpen}
      menuOpen={openMenuId === conversation.id}
      onMenuToggle={(id) => setOpenMenuId((current) => (current === id ? null : id))}
      menuHandlers={menuHandlers}
    />
  );

  return (
    <div className="chat-panel-body">
      <div className="chat-search">
        <Search aria-hidden="true" />
        <label className="sr-only" htmlFor="chat-panel-search">{t('chat_search_placeholder')}</label>
        <input
          id="chat-panel-search"
          type="search"
          value={term}
          placeholder={t('chat_search_placeholder')}
          onChange={(event) => setTerm(event.target.value)}
        />
        {term ? (
          <button
            type="button"
            className="chat-icon-btn"
            aria-label={t('action_clear')}
            title={t('action_clear')}
            onClick={() => setTerm('')}
          >
            <X />
          </button>
        ) : null}
      </div>

      <div className="chat-list">
        {errorCode ? <p className="chat-notice warning">{chatErrorText(t, errorCode)}</p> : null}

        {loading && !conversations.length ? <p className="chat-thread-note">{t('label_loading')}</p> : null}

        {!loading && !visible.length && !hits.length ? (
          <div className="chat-empty">
            <MessageSquare />
            <b>{needle ? t('chat_no_search_results') : t('chat_no_conversations')}</b>
            <p>{needle ? '' : t('chat_no_conversations_hint')}</p>
          </div>
        ) : null}

        {pinned.length ? <p className="chat-list-group-title">{t('chat_pinned')}</p> : null}
        {pinned.map(renderRow)}

        {pinned.length && rest.length ? <p className="chat-list-group-title">{t('chat_conversations')}</p> : null}
        {rest.map(renderRow)}

        {hits.length ? (
          <>
            <p className="chat-list-group-title">{t('chat_search_results')}</p>
            {hits.map((hit) => (
              <button
                key={hit.message_id}
                type="button"
                className="chat-search-hit"
                onClick={() => onOpenMessage(hit)}
              >
                <b>
                  {hit.kind === 'Group'
                    ? (hit.title || t('chat_group'))
                    : displayName(hit.other_user, lang, t('chat_someone'))}
                </b>
                <small dir="auto">{hit.body}</small>
              </button>
            ))}
          </>
        ) : null}
      </div>

      <div className="chat-panel-footer">
        <button type="button" className="primary-button" onClick={onNew}>
          <Plus size={16} />{t('chat_new_conversation')}
        </button>
      </div>

      <div className="chat-presence-picker">
        <label htmlFor="chat-presence-select">{t('chat_presence')}</label>
        <select
          id="chat-presence-select"
          value={presence}
          onChange={(event) => onPresenceChange?.(event.target.value)}
          aria-label={t('chat_set_presence')}
        >
          {presenceCodes.map((code) => (
            <option key={code} value={code}>{t(`chat_presence_${code.toLowerCase()}`)}</option>
          ))}
        </select>
      </div>
    </div>
  );
};

export default ConversationList;
