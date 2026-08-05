// The home page layout.
//
// Source of truth is the backend: public.workspace_layout() returns the widget
// catalogue with the caller's overrides folded in, workspace_layout_save()
// stores a whole board after a drag & drop, workspace_layout_reset() drops the
// overrides again.
//
// Everything is mirrored into localStorage. That mirror is what makes the board
// survive a backend outage, a local preview without Supabase, and the first
// paint after a reload — the user's own arrangement is the last thing that
// should disappear when the network does.

import { supabase, useLocalData } from '../lib/supabaseClient';
import { loadApprovalCenterFeed } from './approvalService';

export const WIDGET_WIDTHS = ['Full', 'Half', 'Third', 'Quarter'];

/** Column span of each width on the 12 column board. */
export const WIDTH_SPAN = { Full: 12, Half: 6, Third: 4, Quarter: 3 };

/** The width the "cycle width" control moves to next. */
export const nextWidth = (width) => {
  const index = WIDGET_WIDTHS.indexOf(width);
  return WIDGET_WIDTHS[(index < 0 ? 0 : index + 1) % WIDGET_WIDTHS.length];
};

const SLA_HOURS = 48;
const STORAGE_PREFIX = 'bbnovix_workspace_layout';
const storageKey = (userId) => `${STORAGE_PREFIX}_${userId || 'anonymous'}`;

// Offline mirror of public.dashboard_widgets (migration 202608040015). Keeping
// it here means local preview renders exactly the board the server would send.
// The names are data, not interface copy: they are read with pickLocalized().
const CATALOGUE = [
  { code: 'WELCOME', name_ar: 'الترحيب', name_en: 'Welcome', description_ar: 'بطاقة ترحيب باسم الموظف ووقت اليوم', description_en: 'Greeting card with the employee name and the time of day', module_code: 'EMPLOYEE_PORTAL', icon: 'sun', default_order: 10, default_width: 'Full', default_visible: true },
  { code: 'QUICK_ACTIONS', name_ar: 'إجراءات سريعة', name_en: 'Quick Actions', description_ar: 'اختصارات لأكثر الإجراءات استخداماً', description_en: 'Shortcuts to the most used actions', module_code: 'EMPLOYEE_PORTAL', icon: 'zap', default_order: 20, default_width: 'Full', default_visible: true },
  { code: 'MY_REQUESTS', name_ar: 'طلباتي', name_en: 'My Requests', description_ar: 'آخر الطلبات التي قدمتها وحالتها', description_en: 'Your latest requests and their status', module_code: 'FORMS', icon: 'file-text', default_order: 30, default_width: 'Half', default_visible: true },
  { code: 'APPROVAL_INBOX', name_ar: 'وارد الموافقات', name_en: 'Approval Inbox', description_ar: 'الطلبات التي تنتظر إجراءك', description_en: 'Requests waiting for your action', module_code: 'APPROVALS', icon: 'inbox', default_order: 40, default_width: 'Half', default_visible: true },
  { code: 'ANNOUNCEMENTS', name_ar: 'الإعلانات', name_en: 'Announcements', description_ar: 'آخر إعلانات الشركة', description_en: 'The latest company announcements', module_code: 'ANNOUNCEMENTS', icon: 'megaphone', default_order: 50, default_width: 'Half', default_visible: true },
  { code: 'SURVEY', name_ar: 'الاستطلاعات', name_en: 'Surveys', description_ar: 'الاستطلاعات المفتوحة التي تنتظر رأيك', description_en: 'Open surveys waiting for your opinion', module_code: 'SURVEY', icon: 'clipboard-list', default_order: 60, default_width: 'Half', default_visible: true },
  { code: 'CALENDAR', name_ar: 'التقويم', name_en: 'Calendar', description_ar: 'المناسبات والفعاليات القادمة', description_en: 'Upcoming events and occasions', module_code: 'CALENDAR', icon: 'calendar', default_order: 70, default_width: 'Half', default_visible: true },
  { code: 'NOTES', name_ar: 'المفكرة', name_en: 'Notes', description_ar: 'ملاحظاتك الشخصية السريعة', description_en: 'Your quick personal notes', module_code: 'NOTES', icon: 'sticky-note', default_order: 80, default_width: 'Half', default_visible: true },
  { code: 'DOCUMENTS', name_ar: 'الوثائق', name_en: 'Documents', description_ar: 'أحدث الوثائق المنشورة', description_en: 'The most recently published documents', module_code: 'DOCUMENTS', icon: 'folder', default_order: 90, default_width: 'Half', default_visible: true },
  { code: 'CIRCULARS', name_ar: 'التعاميم', name_en: 'Circulars', description_ar: 'أحدث التعاميم الصادرة', description_en: 'The most recent circulars', module_code: 'DOCUMENTS', icon: 'scroll-text', default_order: 100, default_width: 'Half', default_visible: true },
  { code: 'DESIGNS', name_ar: 'التصاميم', name_en: 'Designs', description_ar: 'مكتبة الهوية والتصاميم', description_en: 'The identity and design library', module_code: 'DOCUMENTS', icon: 'image', default_order: 110, default_width: 'Half', default_visible: false },
  { code: 'ORG_CHART', name_ar: 'الهيكل التنظيمي', name_en: 'Organization Chart', description_ar: 'شجرة الإدارات وفرق العمل', description_en: 'The department and team tree', module_code: 'EMPLOYEE_PORTAL', icon: 'network', default_order: 120, default_width: 'Half', default_visible: false },
  { code: 'PERFORMANCE', name_ar: 'الأداء', name_en: 'Performance', description_ar: 'ملخص تقييم الأداء ودورته الحالية', description_en: 'Your evaluation summary and current cycle', module_code: 'PERFORMANCE', icon: 'trending-up', default_order: 130, default_width: 'Half', default_visible: false },
  { code: 'TIP', name_ar: 'نصيحة اليوم', name_en: 'Tip of the Day', description_ar: 'نصيحة قصيرة لاستخدام أفضل للبوابة', description_en: 'A short tip for getting more out of the portal', module_code: 'EMPLOYEE_PORTAL', icon: 'lightbulb', default_order: 140, default_width: 'Third', default_visible: true },
];

const CATALOGUE_BY_CODE = new Map(CATALOGUE.map((widget) => [widget.code, widget]));

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

const asBoolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

const asWidth = (value, fallback) => (WIDGET_WIDTHS.includes(value) ? value : fallback);

const asOrder = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

/** One board row, whatever it came from, in the shape the screens expect. */
const normalise = (row) => {
  const base = CATALOGUE_BY_CODE.get(row?.code) || {};
  return {
    code: row.code,
    name_ar: row.name_ar ?? base.name_ar ?? row.code,
    name_en: row.name_en ?? base.name_en ?? null,
    description_ar: row.description_ar ?? base.description_ar ?? null,
    description_en: row.description_en ?? base.description_en ?? null,
    module_code: row.module_code ?? base.module_code ?? null,
    icon: row.icon ?? base.icon ?? null,
    is_visible: asBoolean(row.is_visible, base.default_visible ?? true),
    display_order: asOrder(row.display_order, base.default_order ?? 0),
    width: asWidth(row.width, base.default_width || 'Half'),
    is_collapsed: asBoolean(row.is_collapsed, false),
    is_pinned: asBoolean(row.is_pinned, false),
    is_customized: Boolean(row.is_customized),
  };
};

/** Pinned cards lead the board, then the display order the user dragged into. */
export const sortWidgets = (widgets) => [...widgets].sort((a, b) => (
  Number(b.is_pinned) - Number(a.is_pinned)
  || a.display_order - b.display_order
  || a.code.localeCompare(b.code)
));

const toPayload = (widget) => ({
  code: widget.code,
  is_visible: Boolean(widget.is_visible),
  display_order: asOrder(widget.display_order, 0),
  width: asWidth(widget.width, 'Half'),
  is_collapsed: Boolean(widget.is_collapsed),
  is_pinned: Boolean(widget.is_pinned),
});

// ---------------------------------------------------------------------------
// Local mirror
// ---------------------------------------------------------------------------

const readOverrides = (userId) => {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(userId)) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
};

const writeOverrides = (userId, overrides) => {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(overrides));
  } catch {
    // A full or blocked storage must never stop the board from rendering.
  }
};

const clearOverrides = (userId) => {
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    // Same reasoning as above.
  }
};

const cacheBoard = (userId, widgets) => {
  const overrides = widgets.reduce((all, widget) => ({ ...all, [widget.code]: toPayload(widget) }), {});
  writeOverrides(userId, overrides);
};

/** The catalogue with whatever this device remembers folded in. */
const localBoard = (userId) => {
  const overrides = readOverrides(userId);
  return sortWidgets(CATALOGUE.map((widget) => normalise({
    ...widget,
    ...(overrides[widget.code] || {}),
    is_visible: overrides[widget.code]?.is_visible ?? widget.default_visible,
    display_order: overrides[widget.code]?.display_order ?? widget.default_order,
    width: overrides[widget.code]?.width ?? widget.default_width,
    is_customized: Boolean(overrides[widget.code]),
  })));
};

// ---------------------------------------------------------------------------
// Layout API — every function resolves with { data, error } and never throws.
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ data: Array, error: Error|null }>} the board. `error` is
 * set when the backend could not be reached, but `data` still carries the
 * locally mirrored board so the page keeps working.
 */
export async function loadWorkspaceLayout(userId) {
  if (useLocalData || !supabase) return { data: localBoard(userId), error: null };

  const { data, error } = await supabase.rpc('workspace_layout');
  if (error || !Array.isArray(data)) {
    return { data: localBoard(userId), error: error || new Error('WORKSPACE_LAYOUT_UNAVAILABLE') };
  }

  const board = sortWidgets(data.map(normalise));
  cacheBoard(userId, board);
  return { data: board, error: null };
}

/**
 * Stores the whole board — visible and hidden cards alike — so an order, a
 * width and a hidden card are one atomic arrangement.
 */
export async function saveWorkspaceLayout(userId, widgets) {
  const board = sortWidgets((widgets || []).map(normalise));

  if (useLocalData || !supabase) {
    cacheBoard(userId, board);
    return { data: board, error: null };
  }

  const { data, error } = await supabase.rpc('workspace_layout_save', { p_layout: board.map(toPayload) });
  // The mirror is only ever written from a state the backend accepted, so a
  // failed write leaves the caller free to roll the board back to what is
  // actually stored.
  if (error) return { data: null, error };

  const saved = Array.isArray(data) ? sortWidgets(data.map(normalise)) : board;
  cacheBoard(userId, saved);
  return { data: saved, error: null };
}

/** Drops every override and returns the catalogue defaults. */
export async function resetWorkspaceLayout(userId) {
  if (useLocalData || !supabase) {
    clearOverrides(userId);
    return { data: localBoard(userId), error: null };
  }

  const { data, error } = await supabase.rpc('workspace_layout_reset');
  if (error) return { data: null, error };

  clearOverrides(userId);
  const board = Array.isArray(data) ? sortWidgets(data.map(normalise)) : localBoard(userId);
  cacheBoard(userId, board);
  return { data: board, error: null };
}

// ---------------------------------------------------------------------------
// Board content the dashboard cards read
// ---------------------------------------------------------------------------

const demoRequests = () => {
  const hoursAgo = (hours) => new Date(Date.now() - hours * 36e5).toISOString();
  return [
    { id: 'demo-req-1', reference_no: 'REQ-2026-0184', status: 'InApproval', template_name_ar: 'طلب إجازة', template_name_en: 'Leave Request', updated_on: hoursAgo(5) },
    { id: 'demo-req-2', reference_no: 'REQ-2026-0179', status: 'Approved', template_name_ar: 'طلب شهادة', template_name_en: 'Certificate Request', updated_on: hoursAgo(30) },
    { id: 'demo-req-3', reference_no: 'REQ-2026-0171', status: 'Draft', template_name_ar: 'تقييم الأداء', template_name_en: 'Performance Evaluation', updated_on: hoursAgo(96) },
  ];
};

const emptySnapshot = () => ({ requests: [], inbox: { items: [], count: 0, lateCount: 0 } });

/**
 * One round trip for the two cards that need live data: the requests the user
 * sent and the approvals waiting on them.
 */
export async function loadWorkspaceSnapshot(userId, { requestLimit = 5, inboxLimit = 3 } = {}) {
  try {
    const feed = await loadApprovalCenterFeed(userId);
    const outbox = Array.isArray(feed?.outbox) ? feed.outbox : [];
    const inbox = Array.isArray(feed?.inbox) ? feed.inbox : [];

    const sent = [...outbox].sort((a, b) => String(b.updated_on || '').localeCompare(String(a.updated_on || '')));
    const requests = (useLocalData && sent.length === 0 ? demoRequests() : sent).slice(0, requestLimit);

    return {
      data: {
        requests,
        inbox: {
          items: inbox.slice(0, inboxLimit),
          count: inbox.length,
          lateCount: inbox.filter((item) => (
            item.pending_since && (Date.now() - new Date(item.pending_since).getTime()) / 36e5 > SLA_HOURS
          )).length,
        },
      },
      error: null,
    };
  } catch (error) {
    return { data: emptySnapshot(), error };
  }
}
