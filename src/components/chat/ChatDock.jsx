import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ChevronUp, MessageSquare, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import {
  PRESENCE_CODES, addGroupMembers, blockUser, chatErrorText, createGroupConversation, leaveGroup,
  loadBlockedUsers, loadDirectory, openDirectConversation, toggleConversationMute,
  toggleConversationPin, unblockUser,
} from '../../data/chatService';
import ConversationList from './ConversationList';
import ConversationWindow from './ConversationWindow';
import NewConversationDialog from './NewConversationDialog';
import { ChatAvatar, displayName } from './MessageBubble';

const DOCK_STATE_KEY = 'bbnovix_chat_dock';
const MAX_OPEN_WINDOWS = 3;

const readDockState = () => {
  try {
    const raw = sessionStorage.getItem(DOCK_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      openIds: Array.isArray(parsed?.openIds) ? parsed.openIds : [],
      minimisedIds: Array.isArray(parsed?.minimisedIds) ? parsed.minimisedIds : [],
      listOpen: parsed?.listOpen !== false,
    };
  } catch {
    return { openIds: [], minimisedIds: [], listOpen: true };
  }
};

const writeDockState = (state) => {
  try {
    sessionStorage.setItem(DOCK_STATE_KEY, JSON.stringify(state));
  } catch {
    // A locked-down session storage must not break the dock.
  }
};

/**
 * The bottom dock: a conversation panel plus up to three open windows, the
 * rest waiting as minimised chips. Which windows are open survives a reload
 * through sessionStorage.
 */
const ChatDock = ({
  conversations = [],
  loading = false,
  feedErrorCode = null,
  refreshTokens = {},
  currentUserId,
  tenantId,
  policy,
  attachmentCapability,
  presence = 'Online',
  onPresenceChange,
  onRefresh,
  onClose,
}) => {
  const { t, lang } = useLanguage();
  const [dock, setDock] = useState(readDockState);
  const [dialog, setDialog] = useState(null);          // { mode, conversation }
  const [directory, setDirectory] = useState([]);
  const [blockedIds, setBlockedIds] = useState([]);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  useEffect(() => { writeDockState(dock); }, [dock]);

  // The directory is only needed for the dialogs, but loading it with the dock
  // keeps "new conversation" instant.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [people, blocked] = await Promise.all([loadDirectory(), loadBlockedUsers()]);
      if (cancelled) return;
      if (people.data) setDirectory(people.data);
      if (blocked.data) setBlockedIds(blocked.data);
    })();
    return () => { cancelled = true; };
  }, []);

  const byId = useMemo(() => {
    const map = new Map();
    conversations.forEach((conversation) => map.set(conversation.id, conversation));
    return map;
  }, [conversations]);

  const openConversations = dock.openIds.map((id) => byId.get(id)).filter(Boolean);
  const minimised = dock.minimisedIds.map((id) => byId.get(id)).filter(Boolean);

  const openConversation = useCallback((conversation) => {
    setDock((current) => {
      const id = conversation.id;
      const minimisedIds = current.minimisedIds.filter((item) => item !== id);
      if (current.openIds.includes(id)) return { ...current, minimisedIds };
      const nextOpen = [...current.openIds, id];
      // Beyond three windows the oldest one steps aside as a chip.
      const overflow = nextOpen.slice(0, Math.max(0, nextOpen.length - MAX_OPEN_WINDOWS));
      return {
        ...current,
        openIds: nextOpen.slice(-MAX_OPEN_WINDOWS),
        minimisedIds: [...overflow, ...minimisedIds],
      };
    });
  }, []);

  const closeWindow = useCallback((id) => {
    setDock((current) => ({
      ...current,
      openIds: current.openIds.filter((item) => item !== id),
      minimisedIds: current.minimisedIds.filter((item) => item !== id),
    }));
  }, []);

  const minimiseWindow = useCallback((id) => {
    setDock((current) => ({
      ...current,
      openIds: current.openIds.filter((item) => item !== id),
      minimisedIds: current.minimisedIds.includes(id) ? current.minimisedIds : [id, ...current.minimisedIds],
    }));
  }, []);

  const toggleList = () => setDock((current) => ({ ...current, listOpen: !current.listOpen }));

  // ---- conversation actions ---------------------------------------------

  const runAction = useCallback(async (promise) => {
    const { error } = await promise;
    if (error) setActionError(error);
    else {
      setActionError(null);
      onRefresh?.();
    }
    return error;
  }, [onRefresh]);

  const handleTogglePin = (conversation) => runAction(toggleConversationPin(conversation.id));
  const handleToggleMute = (conversation) => runAction(toggleConversationMute(conversation.id));

  const handleLeaveGroup = async (conversation) => {
    if (!window.confirm(t('chat_leave_group_confirm'))) return;
    const error = await runAction(leaveGroup(conversation.id));
    if (!error) closeWindow(conversation.id);
  };

  const handleBlock = async (conversation) => {
    if (!conversation.other_user?.id) return;
    if (!window.confirm(t('chat_block_confirm'))) return;
    const error = await runAction(blockUser(conversation.other_user.id));
    if (!error) setBlockedIds((current) => [...current, conversation.other_user.id]);
  };

  const handleUnblock = async (conversation) => {
    if (!conversation.other_user?.id) return;
    const error = await runAction(unblockUser(conversation.other_user.id));
    if (!error) setBlockedIds((current) => current.filter((id) => id !== conversation.other_user.id));
  };

  const handleDialogSubmit = async ({ kind, userIds, title }) => {
    setDialogBusy(true);
    setActionError(null);

    if (kind === 'Add' && dialog?.conversation) {
      const { error } = await addGroupMembers(dialog.conversation.id, userIds);
      setDialogBusy(false);
      if (error) { setActionError(error); return; }
      setDialog(null);
      onRefresh?.();
      return;
    }

    const result = kind === 'Group'
      ? await createGroupConversation(title, userIds)
      : await openDirectConversation(userIds[0]);

    setDialogBusy(false);
    if (result.error) { setActionError(result.error); return; }

    setDialog(null);
    // The feed has to know about the new row before its window can render.
    await Promise.resolve(onRefresh?.());
    if (result.data?.id) openConversation({ id: result.data.id });
  };

  // ---- keyboard ----------------------------------------------------------

  useEffect(() => {
    const handleKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A dialog owns Escape while it is on screen.
      if (document.querySelector('.modal-backdrop')) return;
      onClose?.();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const onDockKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    if (dock.openIds.length) return;    // the focused window handles it first
    event.preventDefault();
    onClose?.();
  };

  // ---- render ------------------------------------------------------------

  const chipLabel = (conversation) => (
    conversation.kind === 'Group'
      ? (conversation.title || t('chat_group'))
      : displayName(conversation.other_user, lang, t('chat_someone'))
  );

  return (
    <div className="chat-dock" role="region" aria-label={t('chat_dock')} onKeyDown={onDockKeyDown}>
      {minimised.length ? (
        <div className="chat-chips">
          {minimised.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className="chat-chip"
              aria-label={t('chat_restore')}
              title={chipLabel(conversation)}
              onClick={() => openConversation(conversation)}
            >
              <ChatAvatar
                user={conversation.other_user}
                name={chipLabel(conversation)}
                isGroup={conversation.kind === 'Group'}
                status={conversation.kind === 'Group' ? null : conversation.presence?.status}
                small
              />
              <span>{chipLabel(conversation)}</span>
              {conversation.unread_count ? <span className="chat-badge">{conversation.unread_count}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      <AnimatePresence initial={false}>
        {openConversations.map((conversation) => (
          <ConversationWindow
            key={conversation.id}
            conversation={conversation}
            conversations={conversations}
            currentUserId={currentUserId}
            tenantId={tenantId}
            policy={policy}
            attachmentCapability={attachmentCapability}
            refreshToken={refreshTokens[conversation.id] || 0}
            onClose={() => closeWindow(conversation.id)}
            onMinimise={() => minimiseWindow(conversation.id)}
            onFeedChanged={onRefresh}
            onAddMembers={(target) => setDialog({ mode: 'add', conversation: target })}
            onLeaveGroup={handleLeaveGroup}
            onBlock={handleBlock}
            onUnblock={handleUnblock}
          />
        ))}
      </AnimatePresence>

      <motion.section
        className={`chat-panel${dock.listOpen ? '' : ' collapsed'}`}
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        aria-label={t('chat_conversations')}
      >
        <header className="chat-head">
          <MessageSquare size={18} aria-hidden="true" />
          <button
            type="button"
            className="chat-head-title"
            aria-expanded={dock.listOpen}
            aria-label={dock.listOpen ? t('chat_hide_conversations') : t('chat_show_conversations')}
            onClick={toggleList}
          >
            <b>{t('module_chat')}</b>
          </button>
          <div className="chat-head-actions">
            <button
              type="button"
              className="chat-icon-btn"
              aria-label={dock.listOpen ? t('chat_hide_conversations') : t('chat_show_conversations')}
              title={dock.listOpen ? t('chat_hide_conversations') : t('chat_show_conversations')}
              onClick={toggleList}
            >
              {dock.listOpen ? <ChevronDown /> : <ChevronUp />}
            </button>
            <button
              type="button"
              className="chat-icon-btn"
              aria-label={t('chat_close_dock')}
              title={t('chat_close_dock')}
              onClick={onClose}
            >
              <X />
            </button>
          </div>
        </header>

        {dock.listOpen ? (
          <ConversationList
            conversations={conversations}
            loading={loading}
            errorCode={actionError || feedErrorCode}
            presence={presence}
            presenceCodes={PRESENCE_CODES}
            onPresenceChange={onPresenceChange}
            onOpen={openConversation}
            onOpenMessage={(hit) => openConversation({ id: hit.conversation_id })}
            onNew={() => { setActionError(null); setDialog({ mode: 'new', conversation: null }); }}
            onTogglePin={handleTogglePin}
            onToggleMute={handleToggleMute}
            onLeaveGroup={handleLeaveGroup}
            onBlock={handleBlock}
            onUnblock={handleUnblock}
          />
        ) : null}
      </motion.section>

      {dialog ? (
        <NewConversationDialog
          mode={dialog.mode}
          directory={directory}
          blockedIds={blockedIds}
          excludeIds={dialog.conversation
            ? (dialog.conversation.members || []).map((member) => member.user?.id).filter(Boolean)
            : []}
          currentUserId={currentUserId}
          privateEnabled={policy?.chat_private_enabled !== false}
          groupsEnabled={policy?.chat_groups_enabled !== false}
          busy={dialogBusy}
          errorCode={actionError}
          onSubmit={handleDialogSubmit}
          onClose={() => { setDialog(null); setActionError(null); }}
        />
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {actionError ? chatErrorText(t, actionError) : ''}
      </p>
    </div>
  );
};

export default ChatDock;
