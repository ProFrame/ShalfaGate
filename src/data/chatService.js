// Chat data access.
//
// Every screen in src/components/chat talks to the database through this file
// and nowhere else. Each function returns `{ data, error }` and never throws;
// `error` is the RPC's SCREAMING_SNAKE code (or a normalised equivalent) which
// `chatErrorText` turns into a translated sentence.
//
// Attachments: the bytes never touch platform storage. They go through the
// company's Extended Storage provider (src/lib/storage) and the database keeps
// metadata only. When no provider is connected the upload path is refused
// early and the UI explains it — the rest of chat keeps working.

import { supabase, useLocalData } from '../lib/supabaseClient';
import { STORAGE_LAYER, getStorageProvider, putFile } from '../lib/storage';

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

const ok = (data) => ({ data, error: null });

/** Pulls the SCREAMING_SNAKE code out of whatever the transport handed back. */
export const normalizeChatError = (error) => {
  if (!error) return null;
  if (typeof error === 'string') return error.trim() || 'CHAT_REQUEST_FAILED';
  const message = String(error.message || error.error_description || error.details || '');
  const match = message.match(/[A-Z][A-Z0-9_]{3,}/);
  return match ? match[0] : 'CHAT_REQUEST_FAILED';
};

const fail = (error) => ({ data: null, error: normalizeChatError(error) });

// Codes that already have shared wording in the platform dictionary.
const SHARED_ERROR_KEYS = {
  CHAT_DISABLED: 'error_module_disabled',
  NOT_AUTHENTICATED: 'error_session_expired',
  NOT_ALLOWED: 'error_permission',
  QUOTA_EXCEEDED: 'error_quota_exceeded',
  FILE_TOO_LARGE: 'error_file_too_large',
  FILE_TYPE_NOT_ALLOWED: 'error_file_type',
  STORAGE_NOT_ENABLED: 'error_storage_disabled',
  STORAGE_NOT_CONFIGURED: 'error_storage_disabled',
  STORAGE_PROVIDER_NOT_CONFIGURED: 'error_storage_disabled',
  PROVIDER_UNREACHABLE: 'error_network',
};

export const chatErrorKey = (code) =>
  (code ? SHARED_ERROR_KEYS[code] || `chat_err_${String(code).toLowerCase()}` : '');

/** Translated sentence for an error code, with a generic fallback. */
export const chatErrorText = (t, code) => {
  if (!code) return '';
  const key = chatErrorKey(code);
  const text = t(key);
  return text === key ? t('error_generic') : text;
};

export const PRESENCE_CODES = ['Online', 'Away', 'Busy', 'Offline'];

export const DEFAULT_CHAT_POLICY = {
  chat_private_enabled: true,
  chat_groups_enabled: true,
  chat_attachments_enabled: false,
  chat_max_attachment_mb: 5,
  chat_allowed_file_types: ['image/png', 'image/jpeg', 'application/pdf'],
  storage_provider: 'none',
  extended_storage_enabled: false,
};

// ---------------------------------------------------------------------------
// Demo engine — keeps local preview (`?preview=1`, or no Supabase) usable.
// The shapes mirror the RPC payloads exactly so components never branch.
// ---------------------------------------------------------------------------

const DEMO_KEY = 'bbnovix_chat_demo';
const DEMO_ME = 'demo-user';

const demoPeople = [
  { id: DEMO_ME, employee_no: '10001', full_name: 'أحمد محمد', name_ar: 'أحمد محمد', name_en: 'Ahmed Mohammed', job_title_ar: 'مدير النظام', job_title_en: 'System Administrator', department: 'الموارد البشرية' },
  { id: 'demo-employee-2', employee_no: '10024', full_name: 'سارة خالد', name_ar: 'سارة خالد', name_en: 'Sara Khalid', job_title_ar: 'محاسب أول', job_title_en: 'Senior Accountant', department: 'المالية' },
  { id: 'demo-employee-3', employee_no: '10113', full_name: 'محمد علي', name_ar: 'محمد علي', name_en: 'Mohammed Ali', job_title_ar: 'مشرف تشغيل', job_title_en: 'Operations Supervisor', department: 'التشغيل' },
  { id: 'demo-employee-4', employee_no: '10190', full_name: 'نورة عبدالله', name_ar: 'نورة عبدالله', name_en: 'Noura Abdullah', job_title_ar: 'أخصائي موارد بشرية', job_title_en: 'HR Specialist', department: 'الموارد البشرية' },
  { id: 'demo-employee-5', employee_no: '10240', full_name: 'خالد الحربي', name_ar: 'خالد الحربي', name_en: 'Khalid Alharbi', job_title_ar: 'مدير مشروع', job_title_en: 'Project Manager', department: 'المشاريع' },
];

const demoPresenceStatus = {
  [DEMO_ME]: 'Online',
  'demo-employee-2': 'Online',
  'demo-employee-3': 'Away',
  'demo-employee-4': 'Busy',
  'demo-employee-5': 'Offline',
};

const demoCard = (id) => {
  const person = demoPeople.find((item) => item.id === id);
  if (!person) return null;
  return {
    id: person.id,
    name_ar: person.name_ar,
    name_en: person.name_en,
    full_name: person.full_name,
    avatar_url: null,
    job_title_ar: person.job_title_ar,
    job_title_en: person.job_title_en,
    is_active: true,
  };
};

const demoPresenceCard = (id) => ({
  status: demoPresenceStatus[id] || 'Offline',
  last_seen_on: new Date(Date.now() - 26 * 60000).toISOString(),
  typing_in_conversation: null,
});

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

const demoMessage = (values) => ({
  id: values.id,
  conversation_id: values.conversation_id,
  sender_id: values.sender_id,
  sender: demoCard(values.sender_id),
  body: values.body ?? null,
  message_type: values.message_type || 'Text',
  meta: values.meta || {},
  is_deleted: false,
  is_mine: values.sender_id === DEMO_ME,
  edited_on: null,
  created_on: values.created_on,
  reply_to: values.reply_to || null,
  forwarded_from_id: values.forwarded_from_id || null,
  is_forwarded: Boolean(values.forwarded_from_id),
  attachments: values.attachments || [],
  reactions: values.reactions || [],
  recipient_count: 1,
  delivered_count: 1,
  read_count: values.read ? 1 : 0,
  state: values.sender_id === DEMO_ME ? (values.state || 'Delivered') : null,
});

const seedDemoState = () => ({
  conversations: [
    {
      id: 'demo-conv-1', kind: 'Direct', title: null, other_user_id: 'demo-employee-2',
      is_pinned: true, is_muted: false, my_role: 'Member', unread_count: 1,
      members: [{ user_id: DEMO_ME, role: 'Member' }, { user_id: 'demo-employee-2', role: 'Member' }],
      joined_on: minutesAgo(60 * 72),
    },
    {
      id: 'demo-conv-2', kind: 'Direct', title: null, other_user_id: 'demo-employee-3',
      is_pinned: false, is_muted: true, my_role: 'Member', unread_count: 0,
      members: [{ user_id: DEMO_ME, role: 'Member' }, { user_id: 'demo-employee-3', role: 'Member' }],
      joined_on: minutesAgo(60 * 96),
    },
    {
      id: 'demo-conv-3', kind: 'Group', title: 'فريق التشغيل', other_user_id: null,
      is_pinned: false, is_muted: false, my_role: 'Owner', unread_count: 2,
      members: [
        { user_id: DEMO_ME, role: 'Owner' },
        { user_id: 'demo-employee-3', role: 'Admin' },
        { user_id: 'demo-employee-4', role: 'Member' },
        { user_id: 'demo-employee-5', role: 'Member' },
      ],
      joined_on: minutesAgo(60 * 24),
    },
  ],
  messages: {
    'demo-conv-1': [
      demoMessage({ id: 'demo-msg-1', conversation_id: 'demo-conv-1', sender_id: 'demo-employee-2', body: 'صباح الخير، هل اطّلعت على تقرير المصروفات؟', created_on: minutesAgo(180) }),
      demoMessage({ id: 'demo-msg-2', conversation_id: 'demo-conv-1', sender_id: DEMO_ME, body: 'نعم، سأرسل الملاحظات قبل نهاية اليوم.', created_on: minutesAgo(174), state: 'Read' }),
      demoMessage({ id: 'demo-msg-3', conversation_id: 'demo-conv-1', sender_id: 'demo-employee-2', body: 'ممتاز، شكراً لك 🙏', created_on: minutesAgo(9) }),
    ],
    'demo-conv-2': [
      demoMessage({ id: 'demo-msg-4', conversation_id: 'demo-conv-2', sender_id: DEMO_ME, body: 'تم اعتماد طلب الصيانة.', created_on: minutesAgo(60 * 26), state: 'Read' }),
      demoMessage({ id: 'demo-msg-5', conversation_id: 'demo-conv-2', sender_id: 'demo-employee-3', body: 'شكراً، سنبدأ التنفيذ غداً.', created_on: minutesAgo(60 * 25) }),
    ],
    'demo-conv-3': [
      demoMessage({ id: 'demo-msg-6', conversation_id: 'demo-conv-3', sender_id: DEMO_ME, body: 'ChatSystem.GroupCreated', message_type: 'System', meta: { actor: DEMO_ME, title: 'فريق التشغيل' }, created_on: minutesAgo(60 * 24) }),
      demoMessage({ id: 'demo-msg-7', conversation_id: 'demo-conv-3', sender_id: 'demo-employee-4', body: 'اجتماع المتابعة الساعة 10 صباحاً.', created_on: minutesAgo(95) }),
      demoMessage({ id: 'demo-msg-8', conversation_id: 'demo-conv-3', sender_id: 'demo-employee-5', body: 'تمام، سأحضر.', created_on: minutesAgo(41) }),
    ],
  },
  blocks: [],
});

const readDemoState = () => {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (!raw) {
      const seeded = seedDemoState();
      localStorage.setItem(DEMO_KEY, JSON.stringify(seeded));
      return seeded;
    }
    return JSON.parse(raw);
  } catch {
    return seedDemoState();
  }
};

const writeDemoState = (state) => {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(state));
  } catch {
    // A full quota must never break the dock.
  }
  return state;
};

const demoId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const demoConversationCard = (state, conversation) => {
  const messages = state.messages[conversation.id] || [];
  const last = messages[messages.length - 1] || null;
  return {
    id: conversation.id,
    kind: conversation.kind,
    title: conversation.title,
    avatar_url: null,
    is_archived: false,
    is_pinned: Boolean(conversation.is_pinned),
    is_muted: Boolean(conversation.is_muted),
    my_role: conversation.my_role || 'Member',
    joined_on: conversation.joined_on,
    unread_count: conversation.unread_count || 0,
    last_read_message_id: conversation.last_read_message_id || null,
    last_message_at: last?.created_on || conversation.joined_on,
    last_message_preview: last?.message_type === 'Attachment'
      ? (last.attachments[0]?.file_name || '')
      : (last?.body || ''),
    last_message: last,
    participant_count: conversation.members.length,
    other_user: conversation.kind === 'Direct' ? demoCard(conversation.other_user_id) : null,
    presence: conversation.kind === 'Direct' ? demoPresenceCard(conversation.other_user_id) : null,
    is_blocked: conversation.kind === 'Direct' && state.blocks.includes(conversation.other_user_id),
    has_blocked_me: false,
    members: conversation.kind === 'Group'
      ? conversation.members.map((member) => ({
          user: demoCard(member.user_id),
          role: member.role,
          presence: demoPresenceCard(member.user_id),
        }))
      : [],
  };
};

const demoFeed = () => {
  const state = readDemoState();
  return state.conversations
    .map((conversation) => demoConversationCard(state, conversation))
    .sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
      return String(b.last_message_at || '').localeCompare(String(a.last_message_at || ''));
    });
};

// ---------------------------------------------------------------------------
// Policy and directory
// ---------------------------------------------------------------------------

/**
 * The company's chat policy. `tenantSettings` (from useTenant()) wins whenever
 * it carries the key, so a platform-operator change is reflected immediately.
 */
export async function loadChatPolicy(tenantSettings = {}) {
  const overrides = Object.fromEntries(
    Object.entries(tenantSettings || {}).filter(
      ([key, value]) => key in DEFAULT_CHAT_POLICY && value !== null && value !== undefined,
    ),
  );

  if (useLocalData || !supabase) {
    return ok({ ...DEFAULT_CHAT_POLICY, chat_attachments_enabled: true, storage_provider: 'local', extended_storage_enabled: true, ...overrides });
  }

  const { data, error } = await supabase
    .from('tenant_settings')
    .select('chat_private_enabled, chat_groups_enabled, chat_attachments_enabled, chat_max_attachment_mb, chat_allowed_file_types, storage_provider, extended_storage_enabled')
    .maybeSingle();

  if (error) return ok({ ...DEFAULT_CHAT_POLICY, ...overrides });
  return ok({ ...DEFAULT_CHAT_POLICY, ...(data || {}), ...overrides });
}

/** Everyone in the company who can be written to. */
export async function loadDirectory() {
  if (useLocalData || !supabase) return ok(demoPeople);
  const { data, error } = await supabase.rpc('list_form_recipients');
  if (error) return fail(error);
  return ok(data || []);
}

/** Ids this user has blocked — they are never offered in the new-chat dialog. */
export async function loadBlockedUsers() {
  if (useLocalData || !supabase) return ok(readDemoState().blocks);
  const { data, error } = await supabase.from('chat_blocks').select('blocked_id');
  if (error) return fail(error);
  return ok((data || []).map((row) => row.blocked_id));
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function loadConversations() {
  if (useLocalData || !supabase) return ok(demoFeed());
  const { data, error } = await supabase.rpc('chat_conversations_feed');
  if (error) return fail(error);
  return ok(Array.isArray(data) ? data : []);
}

export async function openDirectConversation(otherUserId) {
  if (useLocalData || !supabase) {
    const state = readDemoState();
    if (otherUserId === DEMO_ME) return fail('CANNOT_CHAT_WITH_SELF');
    if (state.blocks.includes(otherUserId)) return fail('CONVERSATION_BLOCKED');
    const existing = state.conversations.find(
      (item) => item.kind === 'Direct' && item.other_user_id === otherUserId,
    );
    if (existing) return ok({ id: existing.id, kind: 'Direct', created: false });
    const id = demoId('demo-conv');
    state.conversations.push({
      id, kind: 'Direct', title: null, other_user_id: otherUserId,
      is_pinned: false, is_muted: false, my_role: 'Member', unread_count: 0,
      members: [{ user_id: DEMO_ME, role: 'Member' }, { user_id: otherUserId, role: 'Member' }],
      joined_on: new Date().toISOString(),
    });
    state.messages[id] = [];
    writeDemoState(state);
    return ok({ id, kind: 'Direct', created: true });
  }
  const { data, error } = await supabase.rpc('chat_open_direct', { p_other_user: otherUserId });
  if (error) return fail(error);
  return ok(data);
}

export async function createGroupConversation(title, memberIds = []) {
  if (useLocalData || !supabase) {
    const clean = String(title || '').trim();
    if (!clean) return fail('TITLE_REQUIRED');
    const state = readDemoState();
    const id = demoId('demo-conv');
    state.conversations.push({
      id, kind: 'Group', title: clean, other_user_id: null,
      is_pinned: false, is_muted: false, my_role: 'Owner', unread_count: 0,
      members: [
        { user_id: DEMO_ME, role: 'Owner' },
        ...memberIds.filter((memberId) => memberId !== DEMO_ME).map((memberId) => ({ user_id: memberId, role: 'Member' })),
      ],
      joined_on: new Date().toISOString(),
    });
    state.messages[id] = [
      demoMessage({
        id: demoId('demo-msg'), conversation_id: id, sender_id: DEMO_ME,
        body: 'ChatSystem.GroupCreated', message_type: 'System',
        meta: { actor: DEMO_ME, title: clean, members: memberIds },
        created_on: new Date().toISOString(),
      }),
    ];
    writeDemoState(state);
    return ok({ id, kind: 'Group', title: clean });
  }
  const { data, error } = await supabase.rpc('chat_create_group', {
    p_title: title, p_member_ids: memberIds,
  });
  if (error) return fail(error);
  return ok(data);
}

export async function toggleConversationPin(conversationId) {
  if (useLocalData || !supabase) {
    const state = readDemoState();
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return fail('CONVERSATION_NOT_FOUND');
    conversation.is_pinned = !conversation.is_pinned;
    writeDemoState(state);
    return ok({ conversation_id: conversationId, is_pinned: conversation.is_pinned });
  }
  const { data, error } = await supabase.rpc('chat_toggle_pin', { p_conversation: conversationId });
  if (error) return fail(error);
  return ok(data);
}

export async function toggleConversationMute(conversationId) {
  if (useLocalData || !supabase) {
    const state = readDemoState();
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return fail('CONVERSATION_NOT_FOUND');
    conversation.is_muted = !conversation.is_muted;
    writeDemoState(state);
    return ok({ conversation_id: conversationId, is_muted: conversation.is_muted });
  }
  const { data, error } = await supabase.rpc('chat_toggle_mute', { p_conversation: conversationId });
  if (error) return fail(error);
  return ok(data);
}

export async function leaveGroup(conversationId) {
  if (useLocalData || !supabase) {
    const state = readDemoState();
    state.conversations = state.conversations.filter((item) => item.id !== conversationId);
    delete state.messages[conversationId];
    writeDemoState(state);
    return ok({ conversation_id: conversationId, left: true });
  }
  const { data, error } = await supabase.rpc('chat_leave_group', { p_conversation: conversationId });
  if (error) return fail(error);
  return ok(data);
}

export async function addGroupMembers(conversationId, userIds = []) {
  if (useLocalData || !supabase) {
    const state = readDemoState();
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return fail('CONVERSATION_NOT_FOUND');
    userIds.forEach((userId) => {
      if (!conversation.members.some((member) => member.user_id === userId)) {
        conversation.members.push({ user_id: userId, role: 'Member' });
      }
    });
    writeDemoState(state);
    return ok({ conversation_id: conversationId, added: userIds });
  }
  const { data, error } = await supabase.rpc('chat_add_members', {
    p_conversation: conversationId, p_user_ids: userIds,
  });
  if (error) return fail(error);
  return ok(data);
}

export async function removeGroupMember(conversationId, userId) {
  if (useLocalData || !supabase) {
    const state = readDemoState();
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return fail('CONVERSATION_NOT_FOUND');
    conversation.members = conversation.members.filter((member) => member.user_id !== userId);
    writeDemoState(state);
    return ok({ conversation_id: conversationId, removed: userId });
  }
  const { data, error } = await supabase.rpc('chat_remove_member', {
    p_conversation: conversationId, p_user_id: userId,
  });
  if (error) return fail(error);
  return ok(data);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function loadHistory({ conversationId, before = null, limit = 30 }) {
  if (useLocalData || !supabase) {
    const state = readDemoState();
    const all = state.messages[conversationId] || [];
    const filtered = before ? all.filter((item) => item.created_on < before) : all;
    const page = filtered.slice(Math.max(0, filtered.length - limit));
    return ok({
      conversation_id: conversationId,
      messages: page,
      has_more: filtered.length > page.length,
    });
  }
  const { data, error } = await supabase.rpc('chat_history', {
    p_conversation: conversationId, p_before: before, p_limit: limit,
  });
  if (error) return fail(error);
  return ok(data || { conversation_id: conversationId, messages: [], has_more: false });
}

export async function sendMessage({ conversationId, body, replyToId = null, attachment = null }) {
  if (useLocalData || !supabase) {
    const state = readDemoState();
    const list = state.messages[conversationId] || [];
    const replySource = list.find((item) => item.id === replyToId) || null;
    const message = demoMessage({
      id: demoId('demo-msg'),
      conversation_id: conversationId,
      sender_id: DEMO_ME,
      body: body || null,
      message_type: attachment ? 'Attachment' : 'Text',
      attachments: attachment ? [{ id: demoId('demo-att'), state: 'Ready', ...attachment }] : [],
      created_on: new Date().toISOString(),
      state: 'Sent',
      reply_to: replySource
        ? {
            id: replySource.id,
            sender_id: replySource.sender_id,
            sender: replySource.sender,
            message_type: replySource.message_type,
            body: replySource.body,
          }
        : null,
    });
    state.messages[conversationId] = [...list, message];
    writeDemoState(state);
    return ok(message);
  }
  const { data, error } = await supabase.rpc('chat_send', {
    p_conversation: conversationId,
    p_body: body || null,
    p_reply_to: replyToId,
    p_attachment: attachment,
  });
  if (error) return fail(error);
  return ok(data);
}

export async function forwardMessage(messageId, conversationIds = []) {
  if (useLocalData || !supabase) {
    const state = readDemoState();
    const source = Object.values(state.messages).flat().find((item) => item.id === messageId);
    if (!source) return fail('MESSAGE_NOT_FOUND');
    const copies = conversationIds.map((conversationId) => {
      const copy = demoMessage({
        id: demoId('demo-msg'),
        conversation_id: conversationId,
        sender_id: DEMO_ME,
        body: source.body,
        message_type: source.message_type,
        attachments: source.attachments,
        forwarded_from_id: source.forwarded_from_id || source.id,
        created_on: new Date().toISOString(),
        state: 'Sent',
      });
      state.messages[conversationId] = [...(state.messages[conversationId] || []), copy];
      return copy;
    });
    writeDemoState(state);
    return ok(copies);
  }
  const { data, error } = await supabase.rpc('chat_forward', {
    p_message_id: messageId, p_conversation_ids: conversationIds,
  });
  if (error) return fail(error);
  return ok(Array.isArray(data) ? data : []);
}

export async function markConversationRead(conversationId, upToMessageId = null) {
  if (useLocalData || !supabase) {
    const state = readDemoState();
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (conversation) conversation.unread_count = 0;
    writeDemoState(state);
    return ok({ conversation_id: conversationId, unread_count: 0 });
  }
  const { data, error } = await supabase.rpc('chat_mark_read', {
    p_conversation: conversationId, p_up_to_message: upToMessageId,
  });
  if (error) return fail(error);
  return ok(data);
}

/** Soft delete of a message the signed-in user wrote. */
export async function deleteOwnMessage(messageId) {
  if (useLocalData || !supabase) {
    const state = readDemoState();
    Object.keys(state.messages).forEach((conversationId) => {
      state.messages[conversationId] = state.messages[conversationId].map((item) =>
        (item.id === messageId ? { ...item, is_deleted: true, body: null, attachments: [] } : item));
    });
    writeDemoState(state);
    return ok({ id: messageId });
  }
  const { error } = await supabase
    .from('chat_messages')
    .update({ is_deleted: true, deleted_date: new Date().toISOString() })
    .eq('id', messageId);
  if (error) return fail(error);
  return ok({ id: messageId });
}

/** Adds or removes one of my reactions on a message. */
export async function setMessageReaction({ messageId, emoji, userId, active }) {
  if (useLocalData || !supabase) {
    const state = readDemoState();
    Object.keys(state.messages).forEach((conversationId) => {
      state.messages[conversationId] = state.messages[conversationId].map((item) => {
        if (item.id !== messageId) return item;
        const others = (item.reactions || []).filter((reaction) => reaction.emoji !== emoji);
        const current = (item.reactions || []).find((reaction) => reaction.emoji === emoji);
        if (!active) return { ...item, reactions: others };
        return { ...item, reactions: [...others, { emoji, count: (current?.count || 0) + 1, mine: true }] };
      });
    });
    writeDemoState(state);
    return ok({ message_id: messageId, emoji, active });
  }
  if (active) {
    const { error } = await supabase
      .from('chat_reactions')
      .insert({ message_id: messageId, user_id: userId, emoji });
    if (error) return fail(error);
    return ok({ message_id: messageId, emoji, active: true });
  }
  const { error } = await supabase
    .from('chat_reactions')
    .delete()
    .eq('message_id', messageId)
    .eq('user_id', userId)
    .eq('emoji', emoji);
  if (error) return fail(error);
  return ok({ message_id: messageId, emoji, active: false });
}

export async function searchMessages(query, limit = 25) {
  const needle = String(query || '').trim();
  if (needle.length < 2) return ok([]);
  if (useLocalData || !supabase) {
    const state = readDemoState();
    const lowered = needle.toLowerCase();
    const results = [];
    state.conversations.forEach((conversation) => {
      (state.messages[conversation.id] || []).forEach((message) => {
        if (message.message_type === 'System' || message.is_deleted) return;
        if (!String(message.body || '').toLowerCase().includes(lowered)) return;
        results.push({
          message_id: message.id,
          conversation_id: conversation.id,
          kind: conversation.kind,
          title: conversation.title,
          body: message.body,
          message_type: message.message_type,
          created_on: message.created_on,
          sender: message.sender,
          other_user: conversation.kind === 'Direct' ? demoCard(conversation.other_user_id) : null,
        });
      });
    });
    return ok(results.sort((a, b) => String(b.created_on).localeCompare(String(a.created_on))).slice(0, limit));
  }
  const { data, error } = await supabase.rpc('chat_search', { p_query: needle, p_limit: limit });
  if (error) return fail(error);
  return ok(Array.isArray(data) ? data : []);
}

// ---------------------------------------------------------------------------
// Presence, typing and blocking
// ---------------------------------------------------------------------------

export async function setPresence(status) {
  if (!PRESENCE_CODES.includes(status)) return fail('INVALID_STATUS');
  if (useLocalData || !supabase) return ok({ status, last_seen_on: new Date().toISOString() });
  const { data, error } = await supabase.rpc('chat_set_presence', { p_status: status });
  if (error) return fail(error);
  return ok(data);
}

export async function setTyping(conversationId) {
  if (useLocalData || !supabase) return ok({ conversation_id: conversationId });
  const { data, error } = await supabase.rpc('chat_set_typing', { p_conversation: conversationId });
  if (error) return fail(error);
  return ok(data);
}

export async function blockUser(userId) {
  if (useLocalData || !supabase) {
    const state = readDemoState();
    if (!state.blocks.includes(userId)) state.blocks.push(userId);
    writeDemoState(state);
    return ok({ blocked: true, user_id: userId });
  }
  const { data, error } = await supabase.rpc('chat_block', { p_user: userId });
  if (error) return fail(error);
  return ok(data);
}

export async function unblockUser(userId) {
  if (useLocalData || !supabase) {
    const state = readDemoState();
    state.blocks = state.blocks.filter((item) => item !== userId);
    writeDemoState(state);
    return ok({ blocked: false, user_id: userId });
  }
  const { data, error } = await supabase.rpc('chat_unblock', { p_user: userId });
  if (error) return fail(error);
  return ok(data);
}

// ---------------------------------------------------------------------------
// Attachments — metadata in the database, bytes in the company's own provider
// ---------------------------------------------------------------------------

/** Is there somewhere legitimate to put a chat file today? */
export async function loadAttachmentCapability() {
  if (useLocalData || !supabase) return ok({ ready: true, reason: null, provider: 'local' });
  try {
    const provider = await getStorageProvider(STORAGE_LAYER.EXTENDED);
    const { data } = await provider.status();
    return ok({
      ready: Boolean(data?.ready),
      reason: data?.reason || (data?.ready ? null : 'STORAGE_NOT_ENABLED'),
      provider: provider.code,
    });
  } catch (error) {
    return ok({ ready: false, reason: normalizeChatError(error), provider: 'none' });
  }
}

/** Client-side guard so the limits are enforced before a single byte moves. */
export const validateAttachment = (file, policy = DEFAULT_CHAT_POLICY) => {
  if (!file) return 'ATTACHMENT_NAME_REQUIRED';
  if (!policy.chat_attachments_enabled) return 'ATTACHMENTS_DISABLED';
  const allowed = Array.isArray(policy.chat_allowed_file_types) ? policy.chat_allowed_file_types : [];
  if (allowed.length && file.type && !allowed.includes(file.type)) return 'FILE_TYPE_NOT_ALLOWED';
  const maxMb = Number(policy.chat_max_attachment_mb) || 0;
  if (maxMb > 0 && file.size > maxMb * 1048576) return 'FILE_TOO_LARGE';
  return null;
};

/**
 * Uploads through the company's Extended Storage provider and returns the
 * metadata payload `chat_send` expects. Nothing is written to the database
 * here — the message carries the attachment.
 */
export async function uploadChatAttachment({ tenantId, file, policy = DEFAULT_CHAT_POLICY }) {
  const invalid = validateAttachment(file, policy);
  if (invalid) return fail(invalid);

  const { data, error } = await putFile({
    layer: STORAGE_LAYER.EXTENDED,
    tenantId,
    area: 'chat',
    file,
    entityType: 'ChatAttachment',
  });
  if (error) return fail(error);

  return ok({
    file_name: file.name,
    mime_type: file.type || 'application/octet-stream',
    file_size: file.size,
    external_url: data?.url || null,
    external_id: data?.externalId || data?.path || null,
    state: 'Ready',
  });
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/**
 * Listens to public.chat_messages for the conversations this user is in, with
 * a polling fallback for every environment where the socket is unavailable.
 *
 * @param {object}   options
 * @param {string[]} options.conversationIds  conversations to watch
 * @param {Function} options.onMessage        (row, eventType) for a live row
 * @param {Function} options.onTick           refresh hint (poll or receipt change)
 * @param {number}   options.pollMs           fallback interval
 * @returns {Function} unsubscribe
 */
export function subscribeToChat({ conversationIds = [], onMessage, onTick, pollMs = 12000, tenantId = null }) {
  let cancelled = false;
  let timer = null;
  let channel = null;

  const startPolling = () => {
    if (timer || cancelled) return;
    timer = window.setInterval(() => { if (!cancelled) onTick?.(); }, pollMs);
  };
  const stopPolling = () => {
    if (timer) window.clearInterval(timer);
    timer = null;
  };

  if (useLocalData || !supabase) {
    startPolling();
    return () => { cancelled = true; stopPolling(); };
  }

  const ids = conversationIds.filter(Boolean);
  // Postgres-changes filters have a practical length limit; past it, fall back
  // to a company-wide filter (still far narrower than every tenant on the
  // platform) and let the callback below do the exact per-conversation match.
  const messagesFilter = ids.length && ids.length <= 25
    ? `conversation_id=in.(${ids.join(',')})`
    : (tenantId ? `tenant_id=eq.${tenantId}` : undefined);
  const receiptsFilter = tenantId ? `tenant_id=eq.${tenantId}` : undefined;

  channel = supabase.channel(`chat-dock-${Math.random().toString(36).slice(2, 10)}`);

  channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'chat_messages', ...(messagesFilter ? { filter: messagesFilter } : {}) },
    (payload) => {
      const row = payload?.new || payload?.old;
      if (!row) return;
      if (ids.length && !ids.includes(row.conversation_id)) return;
      onMessage?.(row, payload.eventType);
    },
  );

  channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'chat_message_receipts', ...(receiptsFilter ? { filter: receiptsFilter } : {}) },
    () => onTick?.(),
  );

  channel.subscribe((status) => {
    if (cancelled) return;
    if (status === 'SUBSCRIBED') stopPolling();
    else startPolling();
  });

  // Safety net until the socket confirms it is live.
  startPolling();

  return () => {
    cancelled = true;
    stopPolling();
    if (channel) supabase.removeChannel(channel);
  };
}
