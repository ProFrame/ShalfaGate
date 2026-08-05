/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react';
import {
  Check, CheckCheck, CheckSquare, Copy, CornerUpLeft, Download, File, FileText, Forward,
  ImageIcon, MoreVertical, Reply, Square, Trash2, Users,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { formatBytes, formatDate, pickLocalized } from '../../utils/localize';

/** Reactions offered straight from the message menu. */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏', '😮'];

// ---------------------------------------------------------------------------
// Small primitives shared by every chat screen. They live next to the bubble
// because the bubble is where a person is drawn most often.
// ---------------------------------------------------------------------------

/** Name of a user card in the reader's language, never with a lang ternary. */
export const displayName = (user, lang, fallback = '') =>
  pickLocalized(user, 'name', lang, user?.full_name || fallback);

export const initials = (name) =>
  String(name || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join('');

const PRESENCE_TONE = { Online: 'online', Away: 'away', Busy: 'busy', Offline: 'offline' };

const PresenceDot = ({ status, inline = false }) => {
  const { t } = useLanguage();
  const tone = PRESENCE_TONE[status] || 'offline';
  const label = t(`chat_presence_${tone}`);
  if (!inline) return <span className={`chat-presence-dot ${tone}`} role="img" aria-label={label} />;
  return (
    <span className="chat-presence-inline">
      <span className={`chat-presence-dot ${tone}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
};

/**
 * Avatar of a person or of a group. `status` draws the presence dot; groups
 * pass none.
 */
export const ChatAvatar = ({ user, name, status = null, isGroup = false, small = false }) => {
  const { lang } = useLanguage();
  const label = name || displayName(user, lang);
  return (
    <span className={`chat-avatar${small ? ' small' : ''}${isGroup ? ' group' : ''}`} aria-hidden="true">
      {isGroup
        ? <Users size={small ? 14 : 17} />
        : (user?.avatar_url ? <img src={user.avatar_url} alt="" /> : <span>{initials(label)}</span>)}
      {status ? <PresenceDot status={status} /> : null}
    </span>
  );
};

/** Icon that matches the file family without inventing a second icon set. */
const AttachmentGlyph = ({ mime }) => {
  const type = String(mime || '');
  if (type.startsWith('image/')) return <ImageIcon />;
  if (type.includes('pdf') || type.startsWith('text/')) return <FileText />;
  return <File />;
};

// ---------------------------------------------------------------------------
// System rows — the database stores a code, the reader gets their language.
// ---------------------------------------------------------------------------

export const SystemMessage = ({ message, resolveName }) => {
  const { t } = useLanguage();
  const code = String(message.body || '').split('.').pop().toLowerCase();
  const key = `chat_system_${code}`;
  const name = resolveName?.(message.meta?.actor) || t('chat_someone');
  const text = t(key, { name, title: message.meta?.title || '' });
  return <p className="chat-system-message">{text === key ? t('chat_system_generic') : text}</p>;
};

// ---------------------------------------------------------------------------
// The bubble
// ---------------------------------------------------------------------------

const DeliveryTicks = ({ state }) => {
  const { t } = useLanguage();
  if (!state) return null;
  if (state === 'Sent') return <Check aria-label={t('chat_state_sent')} />;
  if (state === 'Read') return <CheckCheck className="read-tick" aria-label={t('chat_state_read')} />;
  return <CheckCheck aria-label={t('chat_state_delivered')} />;
};

const MessageMenu = ({ message, canDelete, onReply, onForward, onCopy, onDelete, onReact, onClose }) => {
  const { t } = useLanguage();
  const ref = useRef(null);

  useEffect(() => {
    const handlePointer = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onClose();
    };
    const handleKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [onClose]);

  return (
    <div className="chat-menu up" role="menu" aria-label={t('chat_message_menu')} ref={ref}>
      <div className="chat-quick-reactions" role="group" aria-label={t('chat_react')}>
        {QUICK_REACTIONS.map((emoji) => (
          <button key={emoji} type="button" aria-label={emoji} onClick={() => { onReact(emoji); onClose(); }}>
            <span aria-hidden="true">{emoji}</span>
          </button>
        ))}
      </div>
      <button type="button" role="menuitem" onClick={() => { onReply(message); onClose(); }}>
        <Reply />{t('chat_reply')}
      </button>
      <button type="button" role="menuitem" onClick={() => { onForward(message); onClose(); }}>
        <Forward />{t('chat_forward')}
      </button>
      {message.body ? (
        <button type="button" role="menuitem" onClick={() => { onCopy(message); onClose(); }}>
          <Copy />{t('chat_copy_text')}
        </button>
      ) : null}
      {canDelete ? (
        <button type="button" role="menuitem" className="danger" onClick={() => { onDelete(message); onClose(); }}>
          <Trash2 />{t('chat_delete_message')}
        </button>
      ) : null}
    </div>
  );
};

/**
 * One message. Alignment follows the writer (mine vs theirs) and the text
 * keeps its own direction, so an Arabic line inside an English session still
 * reads correctly.
 */
const MessageBubble = ({
  message,
  showSender = false,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onReply,
  onForward,
  onCopy,
  onDelete,
  onReact,
}) => {
  const { t, lang, locale } = useLanguage();
  const [menuOpen, setMenuOpen] = useState(false);
  const mine = Boolean(message.is_mine);
  const sender = message.sender;
  const attachment = (message.attachments || [])[0] || null;
  const time = formatDate(message.created_on, locale, { hour: '2-digit', minute: '2-digit' });

  return (
    <article className={`chat-message ${mine ? 'mine' : 'theirs'}${selected ? ' selected' : ''}`}>
      {selectionMode ? (
        <button
          type="button"
          className={`chat-select-box${selected ? ' checked' : ''}`}
          aria-pressed={selected}
          aria-label={t('chat_select_messages')}
          onClick={() => onToggleSelect?.(message)}
        >
          {selected ? <CheckSquare /> : <Square />}
        </button>
      ) : null}

      {!mine ? <ChatAvatar user={sender} small /> : null}

      <div className="chat-message-main">
        {showSender && !mine ? (
          <span className="chat-message-sender">{displayName(sender, lang, t('chat_someone'))}</span>
        ) : null}

        <div className="chat-bubble">
          {message.is_forwarded ? (
            <span className="chat-forward-tag"><Forward />{t('chat_forwarded')}</span>
          ) : null}

          {message.reply_to ? (
            <div className="chat-quote">
              <b>{displayName(message.reply_to.sender, lang, t('chat_someone'))}</b>
              <span>{message.reply_to.body || t('chat_attachment_preview')}</span>
            </div>
          ) : null}

          {message.is_deleted ? (
            <p className="chat-bubble-text deleted">{t('chat_message_deleted')}</p>
          ) : (
            <>
              {message.body ? (
                <p className="chat-bubble-text" dir="auto">{message.body}</p>
              ) : null}

              {attachment ? (
                <a
                  className="chat-attachment-card"
                  href={attachment.external_url || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t('chat_download_attachment', { name: attachment.file_name })}
                  aria-label={t('chat_download_attachment', { name: attachment.file_name })}
                >
                  <AttachmentGlyph mime={attachment.mime_type} />
                  <div>
                    <b>{attachment.file_name}</b>
                    <small>
                      {formatBytes(attachment.file_size, locale)}
                      {attachment.state && attachment.state !== 'Ready'
                        ? ` · ${t(`chat_attachment_state_${String(attachment.state).toLowerCase()}`)}`
                        : ''}
                    </small>
                  </div>
                  <Download size={15} aria-hidden="true" />
                </a>
              ) : null}
            </>
          )}

          {(message.reactions || []).length ? (
            <div className="chat-reactions" aria-label={t('chat_reactions')}>
              {message.reactions.map((reaction) => (
                <button
                  key={reaction.emoji}
                  type="button"
                  className={`chat-reaction${reaction.mine ? ' mine' : ''}`}
                  aria-pressed={Boolean(reaction.mine)}
                  aria-label={`${reaction.emoji} ${reaction.count}`}
                  onClick={() => onReact?.(reaction.emoji, !reaction.mine)}
                >
                  <span aria-hidden="true">{reaction.emoji}</span>
                  <span aria-hidden="true">{reaction.count}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="chat-message-meta">
          {message.edited_on ? <span>{t('chat_edited')}</span> : null}
          <time dateTime={message.created_on}>{time}</time>
          {mine ? <DeliveryTicks state={message.state} /> : null}
        </div>
      </div>

      {!selectionMode && !message.is_deleted ? (
        <div className="chat-message-tools">
          <button
            type="button"
            className="chat-icon-btn"
            aria-label={t('chat_reply')}
            title={t('chat_reply')}
            onClick={() => onReply?.(message)}
          >
            <CornerUpLeft />
          </button>
          <span className="chat-menu-anchor">
            <button
              type="button"
              className="chat-icon-btn"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t('chat_message_menu')}
              title={t('chat_message_menu')}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreVertical />
            </button>
            {menuOpen ? (
              <MessageMenu
                message={message}
                canDelete={mine}
                onReply={onReply}
                onForward={onForward}
                onCopy={onCopy}
                onDelete={onDelete}
                onReact={(emoji) => onReact?.(emoji, true)}
                onClose={() => setMenuOpen(false)}
              />
            ) : null}
          </span>
        </div>
      ) : null}
    </article>
  );
};

export default MessageBubble;
