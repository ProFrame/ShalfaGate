// Notification centre data access.
//
// Everything the bell, the panel and the settings screen need goes through this
// file — no component ever touches supabase. Every function returns
// `{ data, error }` and never throws, and every function keeps working in local
// preview (`useLocalData`) against a small demo store so the shell can be
// developed without a database.
//
// Server contract (migration 202608040015_notifications_and_workspace.sql):
//   public.notification_feed(p_state, p_limit)        -> jsonb[]
//   public.notification_mark(p_ids, p_state)          -> { updated, state }
//   public.notification_pin(p_id, p_pinned)           -> { id, is_pinned }
//   public.notification_counts()                      -> { unread, read, ... }
//   public.notification_preferences_list()            -> jsonb[]
//   public.notification_preferences_save(p_preferences)
//
// The navigation loader lives here too: the shell owns no other service file,
// and `public.my_screens()` is read exactly once per session by AppShell.

import { supabase, useLocalData } from '../lib/supabaseClient';

export const NOTIFICATION_STATES = ['Unread', 'Read', 'Archived', 'Deleted'];

/** Tabs the notification panel offers; 'Pinned' is a view, not a stored state. */
export const NOTIFICATION_VIEWS = ['Unread', 'Read', 'Pinned', 'Archived'];

/** The six categories a person may silence. */
export const EDITABLE_CATEGORIES = ['Message', 'Circular', 'Announcement', 'Survey', 'Approval', 'Event'];

/** Operational categories: always delivered, shown read-only in the settings. */
export const LOCKED_CATEGORIES = ['System', 'Support', 'Verification'];

export const NOTIFICATION_CATEGORIES = [...EDITABLE_CATEGORIES, ...LOCKED_CATEGORIES];

const EMPTY_COUNTS = { total: 0, unread: 0, read: 0, archived: 0, deleted: 0, pinned: 0 };

/** RPC error codes are SCREAMING_SNAKE; the client maps them to wording. */
const ERROR_KEYS = {
  INVALID_NOTIFICATION_STATE: 'notif_err_invalid_state',
  NOTIFICATION_NOT_FOUND: 'notif_err_not_found',
  INVALID_NOTIFICATION_CATEGORY: 'notif_err_invalid_category',
  INVALID_PREFERENCES_PAYLOAD: 'error_validation',
  NOT_AUTHENTICATED: 'error_session_expired',
  TENANT_NOT_RESOLVED: 'error_generic',
};

/**
 * Translation key for an error returned by any function in this file.
 * @param {unknown} error
 * @param {string} [fallbackKey]
 */
export const notificationErrorKey = (error, fallbackKey = 'error_generic') => {
  if (!error) return fallbackKey;
  const raw = String(error.code || error.message || error).toUpperCase();
  const match = Object.keys(ERROR_KEYS).find((code) => raw.includes(code));
  return match ? ERROR_KEYS[match] : fallbackKey;
};

// ---------------------------------------------------------------------------
// Demo store — local preview keeps a real, filable inbox in localStorage.
// ---------------------------------------------------------------------------

const DEMO_KEY = 'bbnovix_demo_notifications';
const DEMO_PREFERENCES_KEY = 'bbnovix_demo_notification_preferences';
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

const demoSeed = () => ([
  {
    id: 'demo-1', category: 'Approval', event_code: 'Approval.Submit',
    title_ar: 'طلب جديد بانتظار موافقتك', title_en: 'A new request is waiting for your approval',
    body_ar: 'طلب إجازة — REQ-10241', body_en: 'Leave request — REQ-10241',
    link_path: '/app/approvals', state: 'Unread', is_pinned: true, created_on: minutesAgo(24),
  },
  {
    id: 'demo-2', category: 'Circular', event_code: 'Circular.Published',
    title_ar: 'تعميم جديد: مواعيد الدوام في رمضان', title_en: 'New circular: working hours during Ramadan',
    body_ar: 'صادر عن إدارة الموارد البشرية', body_en: 'Issued by Human Resources',
    link_path: '/app/circulars', state: 'Unread', is_pinned: false, created_on: minutesAgo(190),
  },
  {
    id: 'demo-3', category: 'Announcement', event_code: 'Announcement.Published',
    title_ar: 'إعلان: اللقاء الشهري للموظفين', title_en: 'Announcement: monthly employee meeting',
    body_ar: 'قاعة الاجتماعات الكبرى، الساعة الحادية عشرة', body_en: 'Main meeting hall at eleven',
    link_path: '/app', state: 'Unread', is_pinned: false, created_on: minutesAgo(1500),
  },
  {
    id: 'demo-4', category: 'Survey', event_code: 'Survey.Opened',
    title_ar: 'استطلاع مفتوح: رضا الموظفين', title_en: 'Open survey: employee satisfaction',
    body_ar: 'يستغرق دقيقتين فقط', body_en: 'It only takes two minutes',
    link_path: '/app', state: 'Read', is_pinned: false, created_on: minutesAgo(2900),
    read_on: minutesAgo(2800),
  },
  {
    id: 'demo-5', category: 'Event', event_code: 'Event.Reminder',
    title_ar: 'تذكير: ورشة عمل الأمن السيبراني', title_en: 'Reminder: cyber security workshop',
    body_ar: 'غداً في تمام التاسعة صباحاً', body_en: 'Tomorrow at nine in the morning',
    link_path: '/app/calendar', state: 'Read', is_pinned: false, created_on: minutesAgo(4400),
    read_on: minutesAgo(4300),
  },
  {
    id: 'demo-6', category: 'Message', event_code: 'Chat.Message',
    title_ar: 'رسالة جديدة من فريق الموارد البشرية', title_en: 'New message from the HR team',
    body_ar: 'تم تحديث بيانات ملفك الوظيفي', body_en: 'Your employment record has been updated',
    link_path: '/app', state: 'Archived', is_pinned: false, created_on: minutesAgo(9000),
    archived_on: minutesAgo(8000),
  },
]);

const readDemo = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(DEMO_KEY) || 'null');
    if (Array.isArray(saved)) return saved;
  } catch {
    // A corrupt cache is not worth an error screen: fall back to the seed.
  }
  const seed = demoSeed();
  localStorage.setItem(DEMO_KEY, JSON.stringify(seed));
  return seed;
};

const writeDemo = (rows) => {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(rows));
  } catch {
    // Storage may be full or blocked; the in-memory result is still correct.
  }
  return rows;
};

const demoCounts = (rows) => rows.reduce((acc, row) => {
  if (row.state === 'Deleted') return { ...acc, deleted: acc.deleted + 1 };
  return {
    ...acc,
    total: acc.total + 1,
    unread: acc.unread + (row.state === 'Unread' ? 1 : 0),
    read: acc.read + (row.state === 'Read' ? 1 : 0),
    archived: acc.archived + (row.state === 'Archived' ? 1 : 0),
    pinned: acc.pinned + (row.is_pinned ? 1 : 0),
  };
}, { ...EMPTY_COUNTS });

// ---------------------------------------------------------------------------
// Feed and counts
// ---------------------------------------------------------------------------

const sortFeed = (rows) => [...rows].sort((a, b) => {
  if (Boolean(a.is_pinned) !== Boolean(b.is_pinned)) return a.is_pinned ? -1 : 1;
  return String(b.created_on || '').localeCompare(String(a.created_on || ''));
});

/**
 * @param {'Unread'|'Read'|'Archived'|'Pinned'|'All'} state
 * @param {number} limit
 */
export const loadNotificationFeed = async (state = 'Unread', limit = 50) => {
  if (useLocalData || !supabase) {
    const rows = readDemo().filter((row) => {
      if (state === 'All') return row.state !== 'Deleted';
      if (state === 'Pinned') return row.is_pinned && row.state !== 'Deleted';
      return row.state === state;
    });
    return { data: sortFeed(rows).slice(0, limit), error: null };
  }

  try {
    const { data, error } = await supabase.rpc('notification_feed', { p_state: state, p_limit: limit });
    if (error) return { data: [], error };
    return { data: Array.isArray(data) ? data : [], error: null };
  } catch (thrown) {
    return { data: [], error: thrown };
  }
};

export const loadNotificationCounts = async () => {
  if (useLocalData || !supabase) return { data: demoCounts(readDemo()), error: null };

  try {
    const { data, error } = await supabase.rpc('notification_counts');
    if (error) return { data: { ...EMPTY_COUNTS }, error };
    return { data: { ...EMPTY_COUNTS, ...(data || {}) }, error: null };
  } catch (thrown) {
    return { data: { ...EMPTY_COUNTS }, error: thrown };
  }
};

// ---------------------------------------------------------------------------
// Filing: read / unread / archive / delete / pin
// ---------------------------------------------------------------------------

/**
 * @param {string[]|null} ids  null means "every notification I have"
 * @param {'Unread'|'Read'|'Archived'|'Deleted'} state
 */
export const markNotifications = async (ids, state) => {
  if (!NOTIFICATION_STATES.includes(state)) {
    return { data: null, error: new Error('INVALID_NOTIFICATION_STATE') };
  }

  if (useLocalData || !supabase) {
    const now = new Date().toISOString();
    const rows = readDemo().map((row) => {
      if (ids && !ids.includes(row.id)) return row;
      return {
        ...row,
        state,
        read_on: state === 'Unread' ? null : row.read_on || now,
        archived_on: state === 'Archived' ? row.archived_on || now : null,
      };
    });
    writeDemo(rows);
    return { data: { updated: rows.length, state }, error: null };
  }

  try {
    const { data, error } = await supabase.rpc('notification_mark', {
      p_ids: ids && ids.length ? ids : (ids === null ? null : []),
      p_state: state,
    });
    if (error) return { data: null, error };
    return { data, error: null };
  } catch (thrown) {
    return { data: null, error: thrown };
  }
};

/**
 * "Mark everything as read" means the unread pile only. Passing a null id list
 * to the RPC would also drag archived notifications back into Read, which is
 * not what the button promises.
 */
export const markAllNotificationsRead = async () => {
  const { data, error } = await loadNotificationFeed('Unread', 200);
  if (error) return { data: null, error };
  const ids = (data || []).map((row) => row.id).filter(Boolean);
  if (!ids.length) return { data: { updated: 0, state: 'Read' }, error: null };
  return markNotifications(ids, 'Read');
};

export const deleteNotification = (id) => markNotifications([id], 'Deleted');

export const pinNotification = async (id, pinned) => {
  if (useLocalData || !supabase) {
    const rows = readDemo().map((row) => (row.id === id ? { ...row, is_pinned: Boolean(pinned) } : row));
    writeDemo(rows);
    return { data: { id, is_pinned: Boolean(pinned) }, error: null };
  }

  try {
    const { data, error } = await supabase.rpc('notification_pin', { p_id: id, p_pinned: Boolean(pinned) });
    if (error) return { data: null, error };
    return { data, error: null };
  } catch (thrown) {
    return { data: null, error: thrown };
  }
};

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

const defaultPreferences = () => EDITABLE_CATEGORIES.map((category) => ({ category, in_app: true, email: false }));

/** Always returns one row per editable category, whether or not it is stored. */
export const loadNotificationPreferences = async () => {
  if (useLocalData || !supabase) {
    try {
      const saved = JSON.parse(localStorage.getItem(DEMO_PREFERENCES_KEY) || 'null');
      if (Array.isArray(saved) && saved.length) return { data: saved, error: null };
    } catch {
      // Fall through to the defaults.
    }
    return { data: defaultPreferences(), error: null };
  }

  try {
    const { data, error } = await supabase.rpc('notification_preferences_list');
    if (error) return { data: defaultPreferences(), error };
    const rows = Array.isArray(data) ? data : [];
    // A category the server did not return is still a switch the user owns.
    const merged = EDITABLE_CATEGORIES.map((category) => {
      const row = rows.find((item) => item.category === category);
      return { category, in_app: row ? Boolean(row.in_app) : true, email: row ? Boolean(row.email) : false };
    });
    return { data: merged, error: null };
  } catch (thrown) {
    return { data: defaultPreferences(), error: thrown };
  }
};

/** @param {{category: string, in_app: boolean, email: boolean}[]} preferences */
export const saveNotificationPreferences = async (preferences) => {
  const payload = (preferences || [])
    .filter((row) => EDITABLE_CATEGORIES.includes(row.category))
    .map((row) => ({ category: row.category, in_app: Boolean(row.in_app), email: Boolean(row.email) }));

  if (!payload.length) return { data: [], error: new Error('INVALID_PREFERENCES_PAYLOAD') };

  if (useLocalData || !supabase) {
    try {
      localStorage.setItem(DEMO_PREFERENCES_KEY, JSON.stringify(payload));
    } catch {
      // Preview only: an unwritable store must not fail the screen.
    }
    return { data: payload, error: null };
  }

  try {
    const { data, error } = await supabase.rpc('notification_preferences_save', { p_preferences: payload });
    if (error) return { data: null, error };
    return { data: Array.isArray(data) ? data : payload, error: null };
  } catch (thrown) {
    return { data: null, error: thrown };
  }
};

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/**
 * Live updates for the bell. Falls back to a no-op when realtime is not
 * available, because the panel also polls; the subscription is an optimisation,
 * never a requirement.
 *
 * @param {string} userId
 * @param {() => void} onChange
 * @returns {() => void} unsubscribe
 */
export const subscribeToNotifications = (userId, onChange) => {
  if (useLocalData || !supabase || !userId || typeof onChange !== 'function') return () => {};

  try {
    const channel = supabase
      .channel(`notification-centre-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` },
        () => onChange(),
      )
      .subscribe();

    return () => {
      try {
        supabase.removeChannel(channel);
      } catch {
        // The channel may already be gone after a sign-out.
      }
    };
  } catch {
    return () => {};
  }
};

// ---------------------------------------------------------------------------
// Navigation: public.my_screens()
//
// Returns the screens the signed-in role is allowed to open. `data: null` means
// "the server could not answer" — the shell then renders its static fallback so
// the application keeps working while the RPC is being rolled out.
// ---------------------------------------------------------------------------

const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.screens)) return value.screens;
  return [];
};

// public.app_screens.route is the sub path INSIDE the shell, so 'admin/employees'
// is the screen at /{company}/app/admin/employees and '' is the home page.
const screenPath = (route) => {
  const value = String(route ?? '').trim().replace(/^\/+/, '');
  if (!value) return '/app';
  if (value.startsWith('app/')) return `/${value}`;
  return `/app/${value}`;
};

const normalizeScreen = (row) => {
  const raw = row.path ?? row.route ?? row.link_path ?? row.screen_path;
  if (raw == null) return null;
  const path = screenPath(raw);
  return {
    code: row.code || row.screen_code || path,
    path,
    is_exact: path === '/app',
    area: String(row.area || row.area_code || row.group_code || 'OTHER').toUpperCase(),
    area_name_ar: row.area_name_ar || row.group_name_ar || null,
    area_name_en: row.area_name_en || row.group_name_en || null,
    name_ar: row.name_ar || row.title_ar || null,
    name_en: row.name_en || row.title_en || null,
    icon: row.icon || null,
    module_code: row.module_code || row.module || null,
    display_order: Number(row.display_order ?? row.sort_order ?? 0),
  };
};

export const loadMyScreens = async () => {
  if (useLocalData || !supabase) return { data: null, error: null };

  try {
    const { data, error } = await supabase.rpc('my_screens');
    if (error) return { data: null, error };
    const screens = asArray(data).map(normalizeScreen).filter(Boolean);
    return { data: screens.length ? screens : null, error: null };
  } catch (thrown) {
    return { data: null, error: thrown };
  }
};
