import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircle, Ban, Forward, Info, LogOut, Minus, MoreVertical, Paperclip, Send, Smile,
  UserMinus, UserPlus, Users, X,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { formatBytes, formatDate, formatRelative } from '../../utils/localize';
import {
  chatErrorText, deleteOwnMessage, forwardMessage, loadHistory, markConversationRead,
  removeGroupMember, sendMessage, setMessageReaction, setTyping, uploadChatAttachment,
  validateAttachment,
} from '../../data/chatService';
import MessageBubble, { ChatAvatar, SystemMessage, displayName } from './MessageBubble';
import EmojiPicker from './EmojiPicker';

const PAGE_SIZE = 30;
const TYPING_THROTTLE_MS = 4000;

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

const dayLabel = (value, locale, t) => {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (sameDay(date, today)) return t('label_today');
  if (sameDay(date, yesterday)) return t('label_yesterday');
  return formatDate(date, locale, { dateStyle: 'medium' });
};

/** Comma-separated file extensions the picker should offer. */
const acceptAttribute = (types) => (Array.isArray(types) && types.length ? types.join(',') : undefined);

const typeSummary = (types) => {
  if (!Array.isArray(types) || !types.length) return '';
  return types
    .map((type) => String(type).split('/').pop().split('+')[0].toUpperCase())
    .filter((value, index, list) => list.indexOf(value) === index)
    .slice(0, 5)
    .join(' · ');
};

// ---------------------------------------------------------------------------
// Forward picker
// ---------------------------------------------------------------------------

const ForwardPicker = ({ conversations, onCancel, onConfirm, busy }) => {
  const { t, lang } = useLanguage();
  const [targets, setTargets] = useState([]);

  const toggle = (id) =>
    setTargets((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal-card chat-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('chat_forward_title')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('chat_forward')}</span>
            <h3>{t('chat_forward_title')}</h3>
          </div>
          <button type="button" className="icon-button" aria-label={t('action_close')} onClick={onCancel}><X /></button>
        </div>
        <div className="chat-modal-body">
          <p className="field-note">{t('chat_forward_hint')}</p>
          <div className="chat-people-list">
            {conversations.map((item) => {
              const label = item.kind === 'Group'
                ? (item.title || t('chat_group'))
                : displayName(item.other_user, lang, t('chat_someone'));
              return (
                <button
                  key={item.id}
                  type="button"
                  className={targets.includes(item.id) ? 'selected' : ''}
                  aria-pressed={targets.includes(item.id)}
                  onClick={() => toggle(item.id)}
                >
                  <ChatAvatar user={item.other_user} name={label} isGroup={item.kind === 'Group'} small />
                  <span>
                    <b>{label}</b>
                    <small>{item.kind === 'Group' ? t('chat_group') : t('chat_direct')}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>{t('action_cancel')}</button>
          <button
            type="button"
            className="primary-button"
            disabled={!targets.length || busy}
            onClick={() => onConfirm(targets)}
          >
            {t('chat_forward')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Members panel (groups)
// ---------------------------------------------------------------------------

const MembersPanel = ({ conversation, currentUserId, onClose, onAddMembers, onRemove }) => {
  const { t, lang } = useLanguage();
  const canManage = ['Owner', 'Admin'].includes(conversation.my_role);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card chat-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('chat_members')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{conversation.title || t('chat_group')}</span>
            <h3>{t('chat_members')}</h3>
          </div>
          <button type="button" className="icon-button" aria-label={t('action_close')} onClick={onClose}><X /></button>
        </div>
        <div className="chat-modal-body">
          {(conversation.members || []).map((member) => (
            <div className="chat-member-row" key={member.user?.id}>
              <ChatAvatar user={member.user} status={member.presence?.status} small />
              <div>
                <b>{member.user?.id === currentUserId ? t('chat_you') : displayName(member.user, lang, t('chat_someone'))}</b>
                <small>{t(`chat_role_${String(member.role || 'member').toLowerCase()}`)}</small>
              </div>
              {canManage && member.user?.id !== currentUserId && member.role !== 'Owner' ? (
                <button
                  type="button"
                  className="chat-icon-btn"
                  aria-label={t('chat_remove_member')}
                  title={t('chat_remove_member')}
                  onClick={() => onRemove(member.user.id)}
                >
                  <UserMinus />
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          {canManage ? (
            <button type="button" className="secondary-button" onClick={onAddMembers}>
              <UserPlus size={16} />{t('chat_add_members')}
            </button>
          ) : null}
          <button type="button" className="primary-button" onClick={onClose}>{t('action_close')}</button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Window menu
// ---------------------------------------------------------------------------

const WindowMenu = ({ conversation, onClose, onMembers, onLeave, onBlock, onUnblock, onSelectMode }) => {
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
    <div className="chat-menu" role="menu" aria-label={t('chat_conversation_menu')} ref={ref}>
      <button type="button" role="menuitem" onClick={() => { onSelectMode(); onClose(); }}>
        <Forward />{t('chat_select_messages')}
      </button>
      {conversation.kind === 'Group' ? (
        <>
          <button type="button" role="menuitem" onClick={() => { onMembers(); onClose(); }}>
            <Users />{t('chat_members')}
          </button>
          <button type="button" role="menuitem" className="danger" onClick={() => { onLeave(); onClose(); }}>
            <LogOut />{t('chat_leave_group')}
          </button>
        </>
      ) : (
        <button
          type="button"
          role="menuitem"
          className={conversation.is_blocked ? '' : 'danger'}
          onClick={() => { (conversation.is_blocked ? onUnblock() : onBlock()); onClose(); }}
        >
          <Ban />{conversation.is_blocked ? t('chat_unblock') : t('chat_block')}
        </button>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

const ConversationWindow = ({
  conversation,
  conversations = [],
  currentUserId,
  tenantId,
  policy,
  attachmentCapability,
  refreshToken = 0,
  onClose,
  onMinimise,
  onFeedChanged,
  onAddMembers,
  onLeaveGroup,
  onBlock,
  onUnblock,
}) => {
  const { t, lang, locale } = useLanguage();
  const threadRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerRef = useRef(null);
  const lastTypingRef = useRef(0);
  const keepScrollRef = useRef(null);

  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [errorCode, setErrorCode] = useState(null);
  const [status, setStatus] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [forwardOpen, setForwardOpen] = useState(false);

  const isGroup = conversation.kind === 'Group';
  const blocked = Boolean(conversation.is_blocked || conversation.has_blocked_me);
  const kindDisabled = isGroup ? !policy?.chat_groups_enabled : !policy?.chat_private_enabled;
  const canWrite = !blocked && !kindDisabled;

  const title = isGroup
    ? (conversation.title || t('chat_group'))
    : displayName(conversation.other_user, lang, t('chat_someone'));

  const nameById = useMemo(() => {
    const map = new Map();
    (conversation.members || []).forEach((member) => {
      if (member.user?.id) map.set(member.user.id, displayName(member.user, lang, ''));
    });
    if (conversation.other_user?.id) {
      map.set(conversation.other_user.id, displayName(conversation.other_user, lang, ''));
    }
    if (currentUserId) map.set(currentUserId, t('chat_you'));
    return map;
  }, [conversation, currentUserId, lang, t]);

  const typingName = useMemo(() => {
    if (isGroup) {
      const member = (conversation.members || []).find(
        (item) => item.user?.id !== currentUserId
          && item.presence?.typing_in_conversation === conversation.id,
      );
      return member ? displayName(member.user, lang, t('chat_someone')) : null;
    }
    return conversation.presence?.typing_in_conversation === conversation.id
      ? displayName(conversation.other_user, lang, t('chat_someone'))
      : null;
  }, [conversation, currentUserId, isGroup, lang, t]);

  const subtitle = useMemo(() => {
    if (typingName) return null;
    if (isGroup) return t('chat_members_count', { count: conversation.participant_count || (conversation.members || []).length });
    const presence = conversation.presence;
    if (!presence) return t('chat_presence_offline');
    if (presence.status && presence.status !== 'Offline') return t(`chat_presence_${presence.status.toLowerCase()}`);
    return presence.last_seen_on
      ? t('chat_last_seen', { time: formatRelative(presence.last_seen_on, locale) })
      : t('chat_presence_offline');
  }, [conversation, isGroup, locale, t, typingName]);

  const scrollToBottom = useCallback(() => {
    const node = threadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, []);

  const readError = useCallback((code) => setErrorCode(code || null), []);

  // ---- loading -----------------------------------------------------------

  const applyHistory = useCallback(({ data, error }) => {
    if (error) {
      readError(error);
      setLoading(false);
      return;
    }
    setMessages(data?.messages || []);
    setHasMore(Boolean(data?.has_more));
    setLoading(false);
    readError(null);
  }, [readError]);

  // The window is keyed by conversation, so one fetch per mount is enough.
  const reload = useCallback(
    () => loadHistory({ conversationId: conversation.id, limit: PAGE_SIZE }).then(applyHistory),
    [applyHistory, conversation.id],
  );

  const acknowledge = useCallback(
    () => markConversationRead(conversation.id, null).then(({ error }) => {
      if (!error) onFeedChanged?.();
    }),
    [conversation.id, onFeedChanged],
  );

  useEffect(() => {
    reload().then(acknowledge);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  // A realtime hit (or a poll) for this conversation refreshes the tail.
  useEffect(() => {
    if (!refreshToken) return;
    reload().then(acknowledge);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  useEffect(() => {
    if (loading) return;
    if (keepScrollRef.current != null) {
      const node = threadRef.current;
      if (node) node.scrollTop = node.scrollHeight - keepScrollRef.current;
      keepScrollRef.current = null;
      return;
    }
    scrollToBottom();
  }, [messages, loading, scrollToBottom]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore || !messages.length) return;
    setLoadingOlder(true);
    keepScrollRef.current = threadRef.current?.scrollHeight || 0;
    const { data, error } = await loadHistory({
      conversationId: conversation.id,
      before: messages[0].created_on,
      limit: PAGE_SIZE,
    });
    if (error) readError(error);
    else {
      setMessages((current) => [...(data.messages || []), ...current]);
      setHasMore(Boolean(data.has_more));
    }
    setLoadingOlder(false);
  }, [conversation.id, hasMore, loadingOlder, messages, readError]);

  const handleScroll = (event) => {
    if (event.currentTarget.scrollTop <= 24) loadOlder();
  };

  // ---- composing ---------------------------------------------------------

  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingRef.current < TYPING_THROTTLE_MS) return;
    lastTypingRef.current = now;
    setTyping(conversation.id);
  }, [conversation.id]);

  const attachmentsAllowed = Boolean(policy?.chat_attachments_enabled) && Boolean(attachmentCapability?.ready);
  const attachmentHint = policy?.chat_attachments_enabled
    ? t('chat_attachment_limit', {
        size: formatBytes((Number(policy?.chat_max_attachment_mb) || 0) * 1048576, locale),
        types: typeSummary(policy?.chat_allowed_file_types),
      })
    : t('chat_attachments_disabled');

  const pickFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const invalid = validateAttachment(file, policy);
    if (invalid) {
      readError(invalid);
      return;
    }
    readError(null);
    setPendingFile(file);
  };

  const submit = async () => {
    const body = draft.trim();
    if ((!body && !pendingFile) || sending || !canWrite) return;
    setSending(true);
    readError(null);

    let attachment = null;
    if (pendingFile) {
      setStatus(t('chat_uploading', { name: pendingFile.name }));
      const upload = await uploadChatAttachment({ tenantId, file: pendingFile, policy });
      if (upload.error) {
        readError(upload.error);
        setStatus('');
        setSending(false);
        return;
      }
      attachment = upload.data;
    }

    const { data, error } = await sendMessage({
      conversationId: conversation.id,
      body,
      replyToId: replyTo?.id || null,
      attachment,
    });

    if (error) {
      readError(error);
    } else {
      setMessages((current) => [...current, data]);
      setDraft('');
      setReplyTo(null);
      setPendingFile(null);
      setStatus('');
      onFeedChanged?.();
    }
    setSending(false);
    composerRef.current?.focus();
  };

  const onComposerKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  // ---- message actions ---------------------------------------------------

  const copyMessage = async (message) => {
    try {
      await navigator.clipboard.writeText(message.body || '');
      setStatus(t('action_copied'));
    } catch {
      readError('CHAT_REQUEST_FAILED');
    }
  };

  const removeMessage = async (message) => {
    if (!window.confirm(t('chat_delete_message_confirm'))) return;
    const { error } = await deleteOwnMessage(message.id);
    if (error) readError(error);
    else {
      setMessages((current) => current.map((item) => (
        item.id === message.id ? { ...item, is_deleted: true, body: null, attachments: [] } : item
      )));
      onFeedChanged?.();
    }
  };

  const react = async (message, emoji, active) => {
    const { error } = await setMessageReaction({
      messageId: message.id, emoji, userId: currentUserId, active,
    });
    if (error) readError(error);
    else reload();
  };

  const toggleSelected = (message) =>
    setSelectedIds((current) => (
      current.includes(message.id) ? current.filter((id) => id !== message.id) : [...current, message.id]
    ));

  const startForward = (message) => {
    setSelectedIds([message.id]);
    setForwardOpen(true);
  };

  const confirmForward = async (targets) => {
    setSending(true);
    let failure = null;
    for (const messageId of selectedIds) {
      // Sequential on purpose: the quota check is per message.
      const { error } = await forwardMessage(messageId, targets);
      if (error) { failure = error; break; }
    }
    setSending(false);
    setForwardOpen(false);
    setSelectionMode(false);
    setSelectedIds([]);
    if (failure) readError(failure);
    else {
      setStatus(t('chat_forward_done'));
      onFeedChanged?.();
    }
  };

  const removeMember = async (userId) => {
    const { error } = await removeGroupMember(conversation.id, userId);
    if (error) readError(error);
    else onFeedChanged?.();
  };

  // ---- keyboard ----------------------------------------------------------

  const onWindowKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    if (emojiOpen || menuOpen) return;      // those close themselves first
    // preventDefault marks the key as handled, so the dock does not close too.
    event.preventDefault();
    event.stopPropagation();
    if (selectionMode) {
      setSelectionMode(false);
      setSelectedIds([]);
      return;
    }
    if (replyTo) {
      setReplyTo(null);
      return;
    }
    onClose();
  };

  // ---- render ------------------------------------------------------------

  const rows = [];
  messages.forEach((message, index) => {
    const previous = messages[index - 1];
    if (!previous || !sameDay(previous.created_on, message.created_on)) {
      rows.push(
        <div className="chat-day-separator" key={`day-${message.id}`}>
          {dayLabel(message.created_on, locale, t)}
        </div>,
      );
    }
    if (message.message_type === 'System') {
      rows.push(
        <SystemMessage
          key={message.id}
          message={message}
          resolveName={(id) => nameById.get(id) || ''}
        />,
      );
      return;
    }
    rows.push(
      <MessageBubble
        key={message.id}
        message={message}
        showSender={isGroup}
        selectionMode={selectionMode}
        selected={selectedIds.includes(message.id)}
        onToggleSelect={toggleSelected}
        onReply={setReplyTo}
        onForward={startForward}
        onCopy={copyMessage}
        onDelete={removeMessage}
        onReact={(emoji, active) => react(message, emoji, active)}
      />,
    );
  });

  return (
    <motion.section
      className="chat-window"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      aria-label={title}
      onKeyDown={onWindowKeyDown}
    >
      <header className="chat-head">
        <ChatAvatar
          user={conversation.other_user}
          name={title}
          isGroup={isGroup}
          status={isGroup ? null : conversation.presence?.status}
          small
        />
        <button
          type="button"
          className="chat-head-title"
          onClick={() => (isGroup ? setMembersOpen(true) : null)}
          aria-label={title}
        >
          <b>{title}</b>
          <small>
            {typingName ? t('chat_typing') : subtitle}
          </small>
        </button>
        <div className="chat-head-actions">
          <span className="chat-menu-anchor">
            <button
              type="button"
              className="chat-icon-btn"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t('chat_conversation_menu')}
              title={t('chat_conversation_menu')}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreVertical />
            </button>
            {menuOpen ? (
              <WindowMenu
                conversation={conversation}
                onClose={() => setMenuOpen(false)}
                onMembers={() => setMembersOpen(true)}
                onLeave={() => onLeaveGroup?.(conversation)}
                onBlock={() => onBlock?.(conversation)}
                onUnblock={() => onUnblock?.(conversation)}
                onSelectMode={() => setSelectionMode(true)}
              />
            ) : null}
          </span>
          <button
            type="button"
            className="chat-icon-btn"
            aria-label={t('chat_minimise')}
            title={t('chat_minimise')}
            onClick={onMinimise}
          >
            <Minus />
          </button>
          <button
            type="button"
            className="chat-icon-btn"
            aria-label={t('action_close')}
            title={t('action_close')}
            onClick={onClose}
          >
            <X />
          </button>
        </div>
      </header>

      <div className="chat-thread" ref={threadRef} onScroll={handleScroll}>
        {hasMore ? (
          <button type="button" className="chat-thread-more" onClick={loadOlder} disabled={loadingOlder}>
            {loadingOlder ? t('chat_loading_older') : t('chat_load_older')}
          </button>
        ) : null}
        {!hasMore && messages.length ? <span className="chat-thread-note">{t('chat_history_start')}</span> : null}
        {loading ? <span className="chat-thread-note">{t('label_loading')}</span> : null}
        {!loading && !messages.length ? (
          <div className="chat-empty">
            <Info />
            <b>{t('chat_no_messages')}</b>
            <p>{t('chat_no_messages_hint')}</p>
          </div>
        ) : null}
        {rows}
      </div>

      {typingName ? (
        <p className="chat-typing-line">
          <span className="chat-typing-dots" aria-hidden="true"><span /><span /><span /></span>
          {t('chat_typing_named', { name: typingName })}
        </p>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {errorCode ? chatErrorText(t, errorCode) : status}
      </p>

      {selectionMode ? (
        <div className="chat-selection-bar">
          <span>{t('chat_selected_messages', { count: selectedIds.length })}</span>
          <button
            type="button"
            className="primary-button"
            disabled={!selectedIds.length}
            onClick={() => setForwardOpen(true)}
          >
            <Forward size={15} />{t('chat_forward')}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => { setSelectionMode(false); setSelectedIds([]); }}
          >
            {t('chat_exit_selection')}
          </button>
        </div>
      ) : null}

      {blocked ? (
        <p className="chat-notice warning">
          <Ban />
          {conversation.is_blocked ? t('chat_blocked_notice') : t('chat_blocked_by_notice')}
          {conversation.is_blocked ? (
            <button type="button" onClick={() => onUnblock?.(conversation)}>{t('chat_unblock')}</button>
          ) : null}
        </p>
      ) : null}

      {!blocked && kindDisabled ? (
        <p className="chat-notice warning">
          <AlertCircle />
          {isGroup ? t('chat_err_groups_disabled') : t('chat_err_private_chat_disabled')}
        </p>
      ) : null}

      {canWrite ? (
        <div className="chat-composer">
          {errorCode ? <p className="chat-composer-note error">{chatErrorText(t, errorCode)}</p> : null}

          {replyTo ? (
            <div className="chat-reply-preview">
              <div>
                <b>{t('chat_replying_to', { name: displayName(replyTo.sender, lang, t('chat_someone')) })}</b>
                <span>{replyTo.body || t('chat_attachment_preview')}</span>
              </div>
              <button
                type="button"
                className="chat-icon-btn"
                aria-label={t('chat_cancel_reply')}
                title={t('chat_cancel_reply')}
                onClick={() => setReplyTo(null)}
              >
                <X />
              </button>
            </div>
          ) : null}

          {pendingFile ? (
            <div className="chat-upload-preview">
              <Paperclip />
              <b>{pendingFile.name}</b>
              <span>{formatBytes(pendingFile.size, locale)}</span>
              <button
                type="button"
                className="chat-icon-btn"
                aria-label={t('chat_remove_attachment')}
                title={t('chat_remove_attachment')}
                onClick={() => setPendingFile(null)}
              >
                <X />
              </button>
            </div>
          ) : null}

          <div className="chat-composer-row">
            <span className="chat-composer-anchor">
              <button
                type="button"
                className={`chat-icon-btn${emojiOpen ? ' active' : ''}`}
                aria-label={t('chat_emoji')}
                aria-expanded={emojiOpen}
                title={t('chat_emoji')}
                onClick={() => setEmojiOpen((open) => !open)}
              >
                <Smile />
              </button>
              {emojiOpen ? (
                <EmojiPicker
                  onSelect={(emoji) => { setDraft((current) => `${current}${emoji}`); composerRef.current?.focus(); }}
                  onClose={() => setEmojiOpen(false)}
                />
              ) : null}
            </span>

            <button
              type="button"
              className="chat-icon-btn"
              aria-label={t('chat_attach_file')}
              title={attachmentHint}
              disabled={!attachmentsAllowed}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="sr-only"
              aria-label={t('chat_attach_file')}
              accept={acceptAttribute(policy?.chat_allowed_file_types)}
              onChange={pickFile}
            />

            <label className="sr-only" htmlFor={`chat-composer-${conversation.id}`}>
              {t('chat_message_placeholder')}
            </label>
            <textarea
              id={`chat-composer-${conversation.id}`}
              ref={composerRef}
              rows={1}
              dir="auto"
              value={draft}
              placeholder={t('chat_message_placeholder')}
              onChange={(event) => { setDraft(event.target.value); notifyTyping(); }}
              onKeyDown={onComposerKeyDown}
            />

            <button
              type="button"
              className="chat-send-btn"
              aria-label={t('chat_send_message')}
              title={t('chat_send_message')}
              disabled={sending || (!draft.trim() && !pendingFile)}
              onClick={submit}
            >
              <Send />
            </button>
          </div>

          {policy?.chat_attachments_enabled && !attachmentCapability?.ready ? (
            <p className="chat-composer-note">{t('chat_storage_not_connected')}</p>
          ) : null}
        </div>
      ) : null}

      {forwardOpen ? (
        <ForwardPicker
          conversations={conversations}
          busy={sending}
          onCancel={() => setForwardOpen(false)}
          onConfirm={confirmForward}
        />
      ) : null}

      {membersOpen && isGroup ? (
        <MembersPanel
          conversation={conversation}
          currentUserId={currentUserId}
          onClose={() => setMembersOpen(false)}
          onAddMembers={() => { setMembersOpen(false); onAddMembers?.(conversation); }}
          onRemove={removeMember}
        />
      ) : null}
    </motion.section>
  );
};

export default ConversationWindow;
