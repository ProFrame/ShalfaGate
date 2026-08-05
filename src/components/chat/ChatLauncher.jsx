import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import {
  DEFAULT_CHAT_POLICY, loadAttachmentCapability, loadChatPolicy, loadConversations, setPresence,
  subscribeToChat,
} from '../../data/chatService';
import ChatDock from './ChatDock';
import './chat.css';

const MODULE_CODE = 'CHAT';
const OPEN_KEY = 'bbnovix_chat_open';
const PRESENCE_HEARTBEAT_MS = 60000;

const readOpen = () => {
  try {
    return sessionStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * The header entry point for chat: an icon with the unread badge that mounts
 * the dock. It owns the conversation feed, the realtime subscription and the
 * presence heartbeat, so the dock and its windows stay presentational.
 *
 * The whole component disappears when the company does not have the chat
 * module — a disabled module is hidden, never broken.
 */
const ChatLauncher = () => {
  const { t } = useLanguage();
  const { hasModule, tenant, settings } = useTenant();
  const { isAuthenticated, profile } = useAuth();

  const [open, setOpen] = useState(readOpen);
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [feedErrorCode, setFeedErrorCode] = useState(null);
  const [policy, setPolicy] = useState(DEFAULT_CHAT_POLICY);
  const [attachmentCapability, setAttachmentCapability] = useState({ ready: false, reason: null });
  const [presence, setPresenceState] = useState('Online');
  const [refreshTokens, setRefreshTokens] = useState({});

  const enabled = Boolean(isAuthenticated) && Boolean(hasModule?.(MODULE_CODE));
  const lastSeenRef = useRef(new Map());

  const bumpToken = useCallback((conversationId) => {
    if (!conversationId) return;
    setRefreshTokens((current) => ({ ...current, [conversationId]: (current[conversationId] || 0) + 1 }));
  }, []);

  /** Applies a feed result and nudges the windows whose tail actually moved. */
  const applyFeed = useCallback(({ data, error }) => {
    if (error) {
      setFeedErrorCode(error);
      setLoading(false);
      return;
    }
    const list = data || [];
    const changed = [];
    const nextSeen = new Map();
    list.forEach((conversation) => {
      const stamp = `${conversation.last_message_at || ''}|${conversation.last_message?.id || ''}`;
      nextSeen.set(conversation.id, stamp);
      if (lastSeenRef.current.has(conversation.id) && lastSeenRef.current.get(conversation.id) !== stamp) {
        changed.push(conversation.id);
      }
    });
    lastSeenRef.current = nextSeen;
    setConversations(list);
    setFeedErrorCode(null);
    setLoading(false);
    if (changed.length) {
      setRefreshTokens((current) => {
        const next = { ...current };
        changed.forEach((id) => { next[id] = (next[id] || 0) + 1; });
        return next;
      });
    }
  }, []);

  const refresh = useCallback(() => loadConversations().then(applyFeed), [applyFeed]);

  // ---- policy and storage capability -------------------------------------

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    Promise.all([loadChatPolicy(settings), loadAttachmentCapability()]).then(([policyResult, capability]) => {
      if (cancelled) return;
      if (policyResult.data) setPolicy(policyResult.data);
      if (capability.data) setAttachmentCapability(capability.data);
    });
    return () => { cancelled = true; };
  }, [enabled, settings]);

  // ---- feed ---------------------------------------------------------------

  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [enabled, refresh]);

  const conversationKey = useMemo(
    () => conversations.map((conversation) => conversation.id).sort().join(','),
    [conversations],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = subscribeToChat({
      conversationIds: conversationKey ? conversationKey.split(',') : [],
      onMessage: (row) => {
        bumpToken(row.conversation_id);
        refresh();
      },
      onTick: refresh,
    });
    return unsubscribe;
  }, [bumpToken, conversationKey, enabled, refresh]);

  // ---- presence -----------------------------------------------------------

  useEffect(() => {
    if (!enabled) return undefined;
    setPresence(presence);
    const timer = window.setInterval(() => setPresence(presence), PRESENCE_HEARTBEAT_MS);
    const onVisibility = () => setPresence(document.visibilityState === 'visible' ? presence : 'Away');
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      setPresence('Offline');
    };
  }, [enabled, presence]);

  const changePresence = useCallback((status) => {
    setPresenceState(status);
    setPresence(status);
  }, []);

  // ---- dock visibility ----------------------------------------------------

  const setDockOpen = useCallback((next) => {
    setOpen(next);
    try {
      sessionStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      // Session storage is a convenience here, never a requirement.
    }
  }, []);

  if (!enabled) return null;

  const unread = conversations.reduce((total, conversation) => total + (Number(conversation.unread_count) || 0), 0);
  const badge = unread > 99 ? '99+' : String(unread);

  return (
    <>
      <span className="chat-launcher menu-anchor">
        <button
          type="button"
          className="icon-button"
          aria-label={t('chat_open')}
          aria-expanded={open}
          title={unread ? t('chat_total_unread', { count: unread }) : t('chat_open')}
          onClick={() => setDockOpen(!open)}
        >
          <MessageCircle />
          {unread ? <span className="chat-launcher-badge" aria-hidden="true">{badge}</span> : null}
        </button>
        <span className="sr-only" role="status" aria-live="polite">
          {unread ? t('chat_total_unread', { count: unread }) : t('chat_no_unread')}
        </span>
      </span>

      {open ? (
        <ChatDock
          conversations={conversations}
          loading={loading}
          feedErrorCode={feedErrorCode}
          refreshTokens={refreshTokens}
          currentUserId={profile?.id}
          tenantId={tenant?.id}
          policy={policy}
          attachmentCapability={attachmentCapability}
          presence={presence}
          onPresenceChange={changePresence}
          onRefresh={refresh}
          onClose={() => setDockOpen(false)}
        />
      ) : null}
    </>
  );
};

export default ChatLauncher;
