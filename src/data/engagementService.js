// Data access for the engagement bundle: announcements, surveys, calendar and
// notes.
//
// The employee-facing reads go through RPCs, because "who may see this record"
// is decided by the audience engine inside the database, never in the browser.
// The administration screens work against the tables directly, guarded by RLS.
//
// Every function returns { data, error } and never throws, and every function
// keeps working in local preview mode (useLocalData) against a small demo store
// in localStorage, so the app can be explored without Supabase.

import { supabase, useLocalData } from '../lib/supabaseClient';
import { extractScreamingSnakeCode, makeAsError } from './serviceEnvelope';

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const asError = makeAsError('ENGAGEMENT_REQUEST_FAILED');

const ok = (data) => ({ data, error: null });
const ko = (value) => ({ data: null, error: asError(value) });

/** Awaits a PostgREST builder and flattens it into the platform envelope. */
const run = async (build) => {
  if (!supabase) return ko('SERVICE_NOT_CONFIGURED');
  try {
    const { data, error } = await build();
    if (error) return ko(error);
    return ok(data);
  } catch (error) {
    return ko(error);
  }
};

const callRpc = async (name, params) => run(() => supabase.rpc(name, params));

/**
 * Maps a database error onto a translation key. RPCs raise
 * `SCREAMING_SNAKE_CODE`; anything else falls back to the shared generic error.
 */
export const engagementErrorMessage = (t, error) => {
  if (!error) return '';
  const code = extractScreamingSnakeCode(error);
  if (code) {
    const key = `engagement_err_${code.toLowerCase()}`;
    const label = t(key);
    if (label !== key) return label;
  }
  return t('error_generic');
};

const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

const nowIso = () => new Date().toISOString();
const dayKey = (value) => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const shiftDays = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return dayKey(date);
};

const trimmed = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

// ---------------------------------------------------------------------------
// Local preview store
// ---------------------------------------------------------------------------

const DEMO_KEY = 'bbnovix_engagement_demo';

const seedDemo = () => ({
  announcements: [
    {
      id: 'demo-ann-1',
      title_1: 'انطلاق منصة العمل الرقمية الجديدة',
      title_2: 'The new digital workplace platform is live',
      body_1: 'تم تفعيل النسخة الجديدة من البوابة بخدمات أسرع وواجهة أوضح. جرّب النماذج الرقمية والموافقات الإلكترونية من قائمة الخدمات.',
      body_2: 'The new portal is now live with faster services and a clearer interface. Try the digital forms and the electronic approvals from the services menu.',
      image_url: null,
      priority: 'Important',
      is_published: true,
      is_pinned: true,
      publish_from: shiftDays(-3),
      publish_to: shiftDays(21),
      display_order: 1,
      is_deleted: false,
      created_on: nowIso(),
    },
    {
      id: 'demo-ann-2',
      title_1: 'تحديث دليل السياسات الإدارية',
      title_2: 'Administrative policy handbook updated',
      body_1: 'صدرت النسخة المحدثة من دليل السياسات الإدارية، وهي متاحة الآن في مكتبة الوثائق.',
      body_2: 'The updated administrative policy handbook is now available in the documents library.',
      image_url: null,
      priority: 'Normal',
      is_published: true,
      is_pinned: false,
      publish_from: shiftDays(-1),
      publish_to: null,
      display_order: 2,
      is_deleted: false,
      created_on: nowIso(),
    },
    {
      id: 'demo-ann-3',
      title_1: 'يوم السلامة المهنية',
      title_2: 'Occupational safety day',
      body_1: 'ندعو جميع الزملاء لحضور فعالية السلامة المهنية في القاعة الرئيسية.',
      body_2: 'All colleagues are invited to the occupational safety event in the main hall.',
      image_url: null,
      priority: 'Normal',
      is_published: true,
      is_pinned: false,
      publish_from: shiftDays(-1),
      publish_to: shiftDays(10),
      display_order: 3,
      is_deleted: false,
      created_on: nowIso(),
    },
  ],
  surveys: [
    {
      id: 'demo-srv-1',
      question_1: 'كيف تقيّم تجربتك مع منصة العمل الرقمية؟',
      question_2: 'How do you rate your experience with the digital workplace platform?',
      is_published: true,
      starts_on: shiftDays(-2),
      ends_on: shiftDays(12),
      is_deleted: false,
      created_on: nowIso(),
      options: [
        { id: 'demo-opt-1', label_1: 'ممتازة', label_2: 'Excellent', display_order: 1, vote_count: 34 },
        { id: 'demo-opt-2', label_1: 'جيدة', label_2: 'Good', display_order: 2, vote_count: 10 },
        { id: 'demo-opt-3', label_1: 'تحتاج تطوير', label_2: 'Needs improvement', display_order: 3, vote_count: 6 },
      ],
    },
  ],
  survey_votes: {},
  calendar_events: [
    {
      id: 'demo-evt-1',
      title_1: 'اليوم الوطني',
      title_2: 'National Day',
      description_1: null,
      description_2: null,
      event_type: 'Holiday',
      event_date: `${new Date().getFullYear()}-09-23`,
      end_date: null,
      all_day: true,
      start_time: null,
      end_time: null,
      scope: 'Company',
      is_mandatory: true,
      remind_before_minutes: null,
      is_deleted: false,
    },
    {
      id: 'demo-evt-2',
      title_1: 'اجتماع الإدارة الشهري',
      title_2: 'Monthly management meeting',
      description_1: null,
      description_2: null,
      event_type: 'Meeting',
      event_date: shiftDays(2),
      end_date: null,
      all_day: false,
      start_time: '10:00',
      end_time: '11:30',
      scope: 'Company',
      is_mandatory: false,
      remind_before_minutes: 1440,
      is_deleted: false,
    },
    {
      id: 'demo-evt-3',
      title_1: 'تذكير شخصي: تسليم التقرير',
      title_2: 'Personal reminder: submit the report',
      description_1: null,
      description_2: null,
      event_type: 'Reminder',
      event_date: shiftDays(1),
      end_date: null,
      all_day: true,
      start_time: null,
      end_time: null,
      scope: 'Personal',
      is_mandatory: false,
      remind_before_minutes: 0,
      is_deleted: false,
    },
  ],
  notes: [
    {
      id: 'demo-note-1',
      title: 'أفكار للاجتماع',
      body: 'مراجعة خطة الربع القادم ومناقشة احتياجات الفريق.',
      color: 'Yellow',
      is_pinned: true,
      is_archived: false,
      display_order: 1,
      updated_on: nowIso(),
      items: [],
    },
    {
      id: 'demo-note-2',
      title: 'قائمة اليوم',
      body: '',
      color: 'Blue',
      is_pinned: false,
      is_archived: false,
      display_order: 2,
      updated_on: nowIso(),
      items: [
        { id: 'demo-item-1', content: 'إرسال محضر الاجتماع', is_done: true, display_order: 1 },
        { id: 'demo-item-2', content: 'مراجعة طلبات الإجازة', is_done: false, display_order: 2 },
      ],
    },
  ],
});

const readDemo = () => {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    // Merged over the seed so a store written by an older build never leaves a
    // collection undefined.
    if (raw) return { ...seedDemo(), ...JSON.parse(raw) };
  } catch {
    // A corrupted preview store is simply reseeded.
  }
  const seeded = seedDemo();
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(seeded)); } catch { /* preview only */ }
  return seeded;
};

const writeDemo = (state) => {
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(state)); } catch { /* preview only */ }
  return state;
};

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export const ANNOUNCEMENT_PRIORITIES = ['Normal', 'Important', 'Urgent'];

/** House style (_1/_2) at the UI boundary <-> real bilingual columns (_ar/_en) in the database. */
const toAnnouncementRow = (row) => (row ? {
  ...row,
  title_1: row.title_ar ?? row.title_1 ?? '',
  title_2: row.title_en ?? row.title_2 ?? null,
  body_1: row.body_ar ?? row.body_1 ?? null,
  body_2: row.body_en ?? row.body_2 ?? null,
} : row);

const withinWindow = (row, from = 'publish_from', to = 'publish_to') => {
  const today = dayKey(new Date());
  const start = row[from] ? String(row[from]).slice(0, 10) : null;
  const end = row[to] ? String(row[to]).slice(0, 10) : null;
  if (start && start > today) return false;
  if (end && end < today) return false;
  return true;
};

const sortAnnouncements = (rows) => [...rows].sort((a, b) => {
  if (Boolean(b.is_pinned) !== Boolean(a.is_pinned)) return b.is_pinned ? 1 : -1;
  const weight = (row) => ANNOUNCEMENT_PRIORITIES.indexOf(row.priority || 'Normal');
  if (weight(b) !== weight(a)) return weight(b) - weight(a);
  return String(b.publish_from || b.created_on || '').localeCompare(String(a.publish_from || a.created_on || ''));
});

/** The board an employee sees: published, inside its window, audience matched. */
export async function loadAnnouncementFeed() {
  if (useLocalData) {
    const state = readDemo();
    const rows = state.announcements.filter((row) => !row.is_deleted && row.is_published && withinWindow(row));
    return ok(sortAnnouncements(rows));
  }
  const { data, error } = await callRpc('announcement_feed');
  if (error) return { data: [], error };
  return ok(sortAnnouncements(Array.isArray(data) ? data : []));
}

/** Everything the administrator manages, published or not. */
export async function loadAnnouncements() {
  if (useLocalData) {
    const state = readDemo();
    return ok(sortAnnouncements(state.announcements.filter((row) => !row.is_deleted)));
  }
  const { data, error } = await run(() => supabase
    .from('announcements')
    .select('*')
    .eq('is_deleted', false)
    .order('is_pinned', { ascending: false })
    .order('display_order', { ascending: true })
    .order('created_on', { ascending: false }));
  if (error) return { data: [], error };
  return ok((Array.isArray(data) ? data : []).map(toAnnouncementRow));
}

export async function saveAnnouncement(input) {
  const payload = {
    title_ar: trimmed(input.title_1),
    title_en: trimmed(input.title_2),
    body_ar: trimmed(input.body_1),
    body_en: trimmed(input.body_2),
    image_url: trimmed(input.image_url),
    priority: ANNOUNCEMENT_PRIORITIES.includes(input.priority) ? input.priority : 'Normal',
    is_published: Boolean(input.is_published),
    is_pinned: Boolean(input.is_pinned),
    publish_from: trimmed(input.publish_from),
    publish_to: trimmed(input.publish_to),
    display_order: Number(input.display_order || 0),
  };

  if (!payload.title_ar) return ko('REQUIRED_FIELD_MISSING');

  if (useLocalData) {
    const state = readDemo();
    const id = input.id || newId();
    const existing = state.announcements.find((row) => row.id === id);
    const saved = {
      ...(existing || { created_on: nowIso(), is_deleted: false }),
      title_1: payload.title_ar, title_2: payload.title_en, body_1: payload.body_ar, body_2: payload.body_en,
      image_url: payload.image_url, priority: payload.priority, is_published: payload.is_published,
      is_pinned: payload.is_pinned, publish_from: payload.publish_from, publish_to: payload.publish_to,
      display_order: payload.display_order, id,
    };
    state.announcements = existing
      ? state.announcements.map((row) => (row.id === id ? saved : row))
      : [saved, ...state.announcements];
    writeDemo(state);
    return ok(saved);
  }

  const { data, error } = await run(() => (input.id
    ? supabase.from('announcements').update(payload).eq('id', input.id).select().single()
    : supabase.from('announcements').insert(payload).select().single()));
  if (error) return { data: null, error };
  return ok(toAnnouncementRow(data));
}

export async function deleteAnnouncement(id) {
  if (useLocalData) {
    const state = readDemo();
    state.announcements = state.announcements.filter((row) => row.id !== id);
    writeDemo(state);
    return ok({ id });
  }
  return run(() => supabase
    .from('announcements')
    .update({ is_deleted: true, deleted_date: nowIso() })
    .eq('id', id)
    .select()
    .maybeSingle());
}

const readsKey = (userId) => `bbnovix_announcement_reads_${userId || 'anonymous'}`;

/** Ids this browser already marked as read — the instant, offline-safe source. */
export function readAnnouncementIds(userId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(readsKey(userId)) || '[]');
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

/**
 * Marking as read is recorded locally first so the card reacts immediately,
 * then mirrored to the server. A failure to mirror is reported but never
 * changes what the employee sees.
 */
export async function markAnnouncementRead(announcementId, userId) {
  const seen = readAnnouncementIds(userId);
  seen.add(announcementId);
  try { localStorage.setItem(readsKey(userId), JSON.stringify([...seen])); } catch { /* private mode */ }

  if (useLocalData || !supabase) return ok({ announcement_id: announcementId });
  return callRpc('announcement_mark_read', { p_announcement_id: announcementId });
}

// ---------------------------------------------------------------------------
// Surveys
// ---------------------------------------------------------------------------

const normalizeOption = (option, index) => ({
  id: option.id || newId(),
  label_1: option.label_1 ?? option.label_ar ?? option.label ?? '',
  label_2: option.label_2 ?? option.label_en ?? null,
  display_order: Number(option.display_order ?? index + 1),
  vote_count: Number(option.vote_count ?? option.votes ?? 0),
});

/** Accepts the flat row, the nested RPC payload or an array, and returns one shape. */
const normalizeSurvey = (raw) => {
  if (!raw) return null;
  const source = Array.isArray(raw) ? raw[0] : raw;
  if (!source) return null;
  const survey = source.survey && typeof source.survey === 'object' ? source.survey : source;
  const options = (source.options || survey.options || survey.survey_options || [])
    .map(normalizeOption)
    .sort((a, b) => a.display_order - b.display_order);
  const totalVotes = Number(
    source.total_votes
    ?? survey.total_votes
    ?? (Array.isArray(survey.survey_responses) ? survey.survey_responses[0]?.count : null)
    ?? options.reduce((sum, option) => sum + option.vote_count, 0),
  );
  return {
    id: survey.id,
    question_1: survey.question_1 ?? survey.question_ar ?? survey.question ?? '',
    question_2: survey.question_2 ?? survey.question_en ?? null,
    is_published: Boolean(survey.is_published),
    starts_on: survey.starts_on || null,
    ends_on: survey.ends_on || null,
    options,
    total_votes: totalVotes,
    my_option_id: source.my_option_id ?? survey.my_option_id ?? null,
  };
};

/** The one survey open for voting right now, with my vote when I already voted. */
export async function loadCurrentSurvey() {
  if (useLocalData) {
    const state = readDemo();
    const survey = state.surveys.find((row) => !row.is_deleted && row.is_published
      && withinWindow(row, 'starts_on', 'ends_on'));
    if (!survey) return ok(null);
    return ok(normalizeSurvey({ ...survey, my_option_id: state.survey_votes[survey.id] || null }));
  }
  const { data, error } = await callRpc('survey_current');
  if (error) return { data: null, error };
  return ok(normalizeSurvey(data));
}

export async function submitSurveyVote(surveyId, optionId) {
  if (!surveyId || !optionId) return ko('SURVEY_OPTION_INVALID');

  if (useLocalData) {
    const state = readDemo();
    const survey = state.surveys.find((row) => row.id === surveyId);
    if (!survey) return ko('SURVEY_NOT_FOUND');
    const previous = state.survey_votes[surveyId];
    if (previous === optionId) return ok(normalizeSurvey({ ...survey, my_option_id: optionId }));
    survey.options = survey.options.map((option) => {
      if (option.id === previous) return { ...option, vote_count: Math.max(0, Number(option.vote_count || 0) - 1) };
      if (option.id === optionId) return { ...option, vote_count: Number(option.vote_count || 0) + 1 };
      return option;
    });
    state.survey_votes[surveyId] = optionId;
    writeDemo(state);
    return ok(normalizeSurvey({ ...survey, my_option_id: optionId }));
  }

  const { data, error } = await callRpc('survey_vote', { p_survey_id: surveyId, p_option_id: optionId });
  if (error) return { data: null, error };
  return ok(normalizeSurvey(data));
}

export async function loadSurveys() {
  if (useLocalData) {
    const state = readDemo();
    return ok(state.surveys.filter((row) => !row.is_deleted).map((row) => normalizeSurvey(row)));
  }
  const { data, error } = await run(() => supabase
    .from('surveys')
    .select('*, survey_options(*), survey_responses(count)')
    .eq('is_deleted', false)
    .order('is_published', { ascending: false })
    .order('created_on', { ascending: false }));
  if (error) return { data: [], error };
  return ok((Array.isArray(data) ? data : []).map((row) => normalizeSurvey(row)));
}

/**
 * Publishing is exclusive: at most one survey may carry `is_published`. The
 * rule is enforced here as well as in the database so the screens can explain
 * it before the administrator commits.
 */
export async function saveSurvey(input) {
  const question = trimmed(input.question_1);
  if (!question) return ko('REQUIRED_FIELD_MISSING');

  const options = (input.options || [])
    .map((option, index) => ({ ...normalizeOption(option, index), label_1: trimmed(option.label_1) }))
    .filter((option) => option.label_1);
  if (options.length < 2) return ko('SURVEY_OPTION_INVALID');

  // The database requires a title distinct from the question, but the admin
  // screen only ever collects one bilingual prompt — the question doubles as
  // the title, since there is no separate title field to add one for.
  const payload = {
    title_ar: question,
    title_en: trimmed(input.question_2),
    question_ar: question,
    question_en: trimmed(input.question_2),
    is_published: Boolean(input.is_published),
    starts_on: trimmed(input.starts_on),
    ends_on: trimmed(input.ends_on),
  };

  if (useLocalData) {
    const state = readDemo();
    const id = input.id || newId();
    if (payload.is_published) {
      state.surveys = state.surveys.map((row) => (row.id === id ? row : { ...row, is_published: false }));
    }
    const existing = state.surveys.find((row) => row.id === id);
    const saved = {
      ...(existing || { created_on: nowIso(), is_deleted: false }),
      ...payload,
      id,
      options: options.map((option, index) => ({ ...option, display_order: index + 1 })),
    };
    state.surveys = existing
      ? state.surveys.map((row) => (row.id === id ? saved : row))
      : [saved, ...state.surveys];
    writeDemo(state);
    return ok(normalizeSurvey(saved));
  }

  if (payload.is_published) {
    const unpublish = supabase.from('surveys').update({ is_published: false }).eq('is_published', true);
    await run(() => (input.id ? unpublish.neq('id', input.id) : unpublish));
  }

  const { data: survey, error } = await run(() => (input.id
    ? supabase.from('surveys').update(payload).eq('id', input.id).select().single()
    : supabase.from('surveys').insert(payload).select().single()));
  if (error) return { data: null, error };

  const surveyId = survey.id;
  const keptIds = options.filter((option) => !String(option.id).startsWith('new-')).map((option) => option.id);
  const removal = supabase.from('survey_options').delete().eq('survey_id', surveyId);
  await run(() => (keptIds.length ? removal.not('id', 'in', `(${keptIds.join(',')})`) : removal));

  const rows = options.map((option, index) => ({
    ...(String(option.id).startsWith('new-') ? {} : { id: option.id }),
    survey_id: surveyId,
    label_ar: option.label_1,
    label_en: option.label_2,
    display_order: index + 1,
  }));
  const { error: optionError } = await run(() => supabase.from('survey_options').upsert(rows).select());
  if (optionError) return { data: null, error: optionError };

  return loadSurvey(surveyId);
}

export async function loadSurvey(id) {
  if (useLocalData) {
    const state = readDemo();
    const survey = state.surveys.find((row) => row.id === id);
    if (!survey) return ko('SURVEY_NOT_FOUND');
    return ok(normalizeSurvey({ ...survey, my_option_id: state.survey_votes[id] || null }));
  }
  const { data, error } = await run(() => supabase
    .from('surveys')
    .select('*, survey_options(*), survey_responses(count)')
    .eq('id', id)
    .single());
  if (error) return { data: null, error };
  return ok(normalizeSurvey(data));
}

export async function setSurveyPublished(id, published) {
  if (useLocalData) {
    const state = readDemo();
    state.surveys = state.surveys.map((row) => {
      if (row.id === id) return { ...row, is_published: Boolean(published) };
      return published ? { ...row, is_published: false } : row;
    });
    writeDemo(state);
    return ok({ id, is_published: Boolean(published) });
  }
  if (published) {
    await run(() => supabase.from('surveys').update({ is_published: false }).eq('is_published', true).neq('id', id));
  }
  return run(() => supabase.from('surveys').update({ is_published: Boolean(published) }).eq('id', id).select().single());
}

export async function deleteSurvey(id) {
  if (useLocalData) {
    const state = readDemo();
    state.surveys = state.surveys.filter((row) => row.id !== id);
    delete state.survey_votes[id];
    writeDemo(state);
    return ok({ id });
  }
  return run(() => supabase
    .from('surveys')
    .update({ is_deleted: true, is_published: false, deleted_date: nowIso() })
    .eq('id', id)
    .select()
    .maybeSingle());
}

/** Counts per answer, tallied live from survey_responses by the RPC. */
export async function loadSurveyResults(id) {
  if (useLocalData) {
    const state = readDemo();
    const survey = state.surveys.find((row) => row.id === id);
    if (!survey) return ko('SURVEY_NOT_FOUND');
    return ok(normalizeSurvey(survey));
  }
  const { data, error } = await callRpc('survey_snapshot', { p_survey_id: id });
  if (error) return { data: null, error };
  return ok(normalizeSurvey(data));
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const timeOf = (isoString) => {
  if (!isoString) return null;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * Accepts a raw calendar_events row, the calendar_month RPC's read model, or
 * the calendar_upsert_personal RPC's row echo — all three carry starts_at /
 * ends_at / is_all_day / a single description, never the _1/_2 house style.
 * event_date / end_date are trusted when the caller already computed them
 * (calendar_month resolves the tenant's own timezone); otherwise they are
 * derived from the timestamp in the browser's local time, which is only ever
 * the fallback for a row this same browser just wrote.
 */
const normalizeEvent = (row) => {
  const start = row.starts_at ? new Date(row.starts_at) : null;
  const end = row.ends_at ? new Date(row.ends_at) : null;
  const allDay = row.is_all_day != null ? Boolean(row.is_all_day) : (row.all_day == null ? true : Boolean(row.all_day));
  return {
    id: row.id,
    title_1: row.title_1 ?? row.title_ar ?? row.title ?? '',
    title_2: row.title_2 ?? row.title_en ?? null,
    description_1: row.description_1 ?? row.description ?? null,
    description_2: row.description_2 ?? null,
    event_type: row.event_type || 'Reminder',
    event_date: row.event_date ? String(row.event_date).slice(0, 10) : (start ? dayKey(start) : ''),
    end_date: row.end_date ? String(row.end_date).slice(0, 10) : (end ? dayKey(end) : null),
    all_day: allDay,
    start_time: allDay ? null : (row.start_time ? String(row.start_time).slice(0, 5) : timeOf(row.starts_at)),
    end_time: allDay ? null : (row.end_time ? String(row.end_time).slice(0, 5) : timeOf(row.ends_at)),
    scope: row.scope === 'Company' ? 'Company' : 'Personal',
    is_mandatory: Boolean(row.is_mandatory),
    remind_before_minutes: row.remind_before_minutes == null ? null : Number(row.remind_before_minutes),
  };
};

const monthBounds = (year, month) => ({
  from: dayKey(new Date(year, month, 1)),
  to: dayKey(new Date(year, month + 1, 0)),
});

/**
 * @param {number} year  four digit year
 * @param {number} month zero based month, matching Date
 */
export async function loadCalendarMonth(year, month) {
  if (useLocalData) {
    const { from, to } = monthBounds(year, month);
    const state = readDemo();
    const rows = state.calendar_events.filter((row) => {
      if (row.is_deleted) return false;
      const start = String(row.event_date || '').slice(0, 10);
      const end = row.end_date ? String(row.end_date).slice(0, 10) : start;
      return start <= to && end >= from;
    });
    return ok(rows.map(normalizeEvent));
  }
  const { data, error } = await callRpc('calendar_month', { p_year: year, p_month: month + 1 });
  if (error) return { data: [], error };
  return ok((Array.isArray(data) ? data : []).map(normalizeEvent));
}

/** The demo store keeps its own, pre-existing shape, independent of the real schema. */
const demoEventPayload = (input, scope) => ({
  title_1: trimmed(input.title_1),
  title_2: trimmed(input.title_2),
  description_1: trimmed(input.description_1),
  description_2: trimmed(input.description_2),
  event_type: input.event_type || 'Reminder',
  event_date: trimmed(input.event_date),
  end_date: trimmed(input.end_date),
  all_day: input.all_day == null ? true : Boolean(input.all_day),
  start_time: input.all_day ? null : trimmed(input.start_time),
  end_time: input.all_day ? null : trimmed(input.end_time),
  scope,
  is_mandatory: scope === 'Company' ? Boolean(input.is_mandatory) : false,
  remind_before_minutes: input.remind_before_minutes == null || input.remind_before_minutes === ''
    ? null
    : Number(input.remind_before_minutes),
});

const combineDateTime = (dateStr, timeStr) => {
  if (!dateStr) return null;
  const time = timeStr && /^\d{2}:\d{2}/.test(timeStr) ? timeStr : '00:00';
  const date = new Date(`${dateStr}T${time}:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** Real schema: a single description column and starts_at/ends_at timestamps. */
const eventPayload = (input, scope) => {
  const allDay = input.all_day == null ? true : Boolean(input.all_day);
  const startDate = trimmed(input.event_date);
  const endDate = trimmed(input.end_date);
  const startsAt = combineDateTime(startDate, allDay ? null : input.start_time);
  let endsAt = allDay
    ? (endDate ? combineDateTime(endDate, null) : null)
    : ((endDate || input.end_time) ? combineDateTime(endDate || startDate, input.end_time) : null);
  if (startsAt && endsAt && endsAt < startsAt) endsAt = null;

  return {
    title_ar: trimmed(input.title_1),
    title_en: trimmed(input.title_2),
    // The database has one description column; the dialog collects two. The
    // Arabic field wins when both are filled, matching how the same
    // ambiguity is already resolved for the title inside calendar_upsert_personal.
    description: trimmed(input.description_1) ?? trimmed(input.description_2),
    event_type: input.event_type || 'Reminder',
    scope,
    starts_at: startsAt,
    ends_at: endsAt,
    is_all_day: allDay,
    is_mandatory: scope === 'Company' ? Boolean(input.is_mandatory) : false,
    remind_before_minutes: input.remind_before_minutes == null || input.remind_before_minutes === ''
      ? 0
      : Number(input.remind_before_minutes),
  };
};

/** An employee may only ever write their own events. */
export async function savePersonalEvent(input) {
  if (!trimmed(input.title_1) || !trimmed(input.event_date)) return ko('REQUIRED_FIELD_MISSING');

  if (useLocalData) {
    const payload = demoEventPayload(input, 'Personal');
    const state = readDemo();
    const id = input.id || newId();
    const existing = state.calendar_events.find((row) => row.id === id);
    if (existing && existing.scope === 'Company') return ko('EVENT_NOT_EDITABLE');
    const saved = { ...(existing || { is_deleted: false }), ...payload, id };
    state.calendar_events = existing
      ? state.calendar_events.map((row) => (row.id === id ? saved : row))
      : [...state.calendar_events, saved];
    writeDemo(state);
    return ok(normalizeEvent(saved));
  }

  const payload = eventPayload(input, 'Personal');
  const { data, error } = await callRpc('calendar_upsert_personal', {
    p_payload: input.id ? { ...payload, id: input.id } : payload,
  });
  if (error) return { data: null, error };
  return ok(normalizeEvent(Array.isArray(data) ? data[0] : data));
}

export async function deletePersonalEvent(id) {
  if (useLocalData) {
    const state = readDemo();
    const target = state.calendar_events.find((row) => row.id === id);
    if (target?.scope === 'Company') return ko('EVENT_NOT_EDITABLE');
    state.calendar_events = state.calendar_events.filter((row) => row.id !== id);
    writeDemo(state);
    return ok({ id });
  }
  return callRpc('calendar_delete_personal', { p_id: id });
}

/** Administration view: the company events only. */
export async function loadCompanyEvents() {
  if (useLocalData) {
    const state = readDemo();
    return ok(state.calendar_events
      .filter((row) => !row.is_deleted && row.scope === 'Company')
      .map(normalizeEvent)
      .sort((a, b) => a.event_date.localeCompare(b.event_date)));
  }
  const { data, error } = await run(() => supabase
    .from('calendar_events')
    .select('*')
    .eq('is_deleted', false)
    .eq('scope', 'Company')
    .order('starts_at', { ascending: true }));
  if (error) return { data: [], error };
  return ok((Array.isArray(data) ? data : []).map(normalizeEvent));
}

export async function saveCompanyEvent(input) {
  if (!trimmed(input.title_1) || !trimmed(input.event_date)) return ko('REQUIRED_FIELD_MISSING');

  if (useLocalData) {
    const payload = demoEventPayload(input, 'Company');
    const state = readDemo();
    const id = input.id || newId();
    const existing = state.calendar_events.find((row) => row.id === id);
    const saved = { ...(existing || { is_deleted: false }), ...payload, id };
    state.calendar_events = existing
      ? state.calendar_events.map((row) => (row.id === id ? saved : row))
      : [...state.calendar_events, saved];
    writeDemo(state);
    return ok(normalizeEvent(saved));
  }

  const payload = eventPayload(input, 'Company');
  const { data, error } = await run(() => (input.id
    ? supabase.from('calendar_events').update(payload).eq('id', input.id).select().single()
    : supabase.from('calendar_events').insert(payload).select().single()));
  if (error) return { data: null, error };
  return ok(normalizeEvent(data));
}

export async function deleteCompanyEvent(id) {
  if (useLocalData) {
    const state = readDemo();
    state.calendar_events = state.calendar_events.filter((row) => row.id !== id);
    writeDemo(state);
    return ok({ id });
  }
  return run(() => supabase
    .from('calendar_events')
    .update({ is_deleted: true, deleted_date: nowIso() })
    .eq('id', id)
    .select()
    .maybeSingle());
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export const NOTE_COLORS = ['Default', 'Yellow', 'Green', 'Blue', 'Pink', 'Purple', 'Orange', 'Grey'];

// notes.color is a NOT NULL '#rrggbb' column; the board only ever works with
// the named swatches above (notes.css keys its backgrounds off the name, not
// the stored hex), so the two are translated at this boundary. Any of these
// hex values satisfies the column's check constraint.
const NOTE_COLOR_HEX = {
  Default: '#ffffff',
  Yellow: '#fff7d6',
  Green: '#e4f5e8',
  Blue: '#e5eefb',
  Pink: '#fbe6ee',
  Purple: '#efe8fb',
  Orange: '#ffeedd',
  Grey: '#eef1f5',
};
const hexToNoteColor = (hex) => {
  const needle = String(hex || '').toLowerCase();
  const found = Object.entries(NOTE_COLOR_HEX).find(([, value]) => value.toLowerCase() === needle);
  return found ? found[0] : 'Default';
};
const noteColorToHex = (color) => NOTE_COLOR_HEX[NOTE_COLORS.includes(color) ? color : 'Default'];

const normalizeNote = (row) => ({
  id: row.id,
  title: row.title || '',
  body: row.body || '',
  color: NOTE_COLORS.includes(row.color) ? row.color : hexToNoteColor(row.color),
  is_pinned: Boolean(row.is_pinned),
  is_archived: Boolean(row.is_archived),
  display_order: Number(row.display_order || 0),
  updated_on: row.updated_on || row.created_on || null,
  items: (row.items || row.note_items || [])
    .map((item, index) => ({
      id: item.id || newId(),
      content: item.content || '',
      is_done: Boolean(item.is_done ?? item.is_checked),
      display_order: Number(item.display_order ?? index + 1),
    }))
    .sort((a, b) => a.display_order - b.display_order),
});

const sortNotes = (rows) => [...rows].sort((a, b) => {
  if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
  if (a.display_order !== b.display_order) return a.display_order - b.display_order;
  return String(b.updated_on || '').localeCompare(String(a.updated_on || ''));
});

export async function loadNotes({ archived = false } = {}) {
  if (useLocalData) {
    const state = readDemo();
    const rows = state.notes.filter((row) => Boolean(row.is_archived) === Boolean(archived)).map(normalizeNote);
    return ok(sortNotes(rows));
  }
  const { data, error } = await run(() => supabase
    .from('notes')
    .select('*, note_items(*)')
    .eq('is_deleted', false)
    .eq('is_archived', Boolean(archived))
    .order('is_pinned', { ascending: false })
    .order('display_order', { ascending: true })
    .order('updated_on', { ascending: false }));
  if (error) return { data: [], error };
  return ok(sortNotes((Array.isArray(data) ? data : []).map(normalizeNote)));
}

export async function saveNote(input) {
  const items = (input.items || [])
    .map((item, index) => ({ ...item, content: String(item.content ?? '').trim(), display_order: index + 1 }))
    .filter((item) => item.content);

  const payload = {
    title: String(input.title ?? '').trim(),
    body: String(input.body ?? '').trim(),
    color: NOTE_COLORS.includes(input.color) ? input.color : 'Default',
    is_pinned: Boolean(input.is_pinned),
    is_archived: Boolean(input.is_archived),
    display_order: Number(input.display_order || 0),
  };

  if (!payload.title && !payload.body && !items.length) return ko('REQUIRED_FIELD_MISSING');

  if (useLocalData) {
    const state = readDemo();
    const id = input.id || newId();
    const existing = state.notes.find((row) => row.id === id);
    const saved = {
      ...(existing || { is_deleted: false }),
      ...payload,
      id,
      updated_on: nowIso(),
      items: items.map((item) => ({
        id: String(item.id || '').startsWith('new-') || !item.id ? newId() : item.id,
        content: item.content,
        is_done: Boolean(item.is_done),
        display_order: item.display_order,
      })),
    };
    state.notes = existing
      ? state.notes.map((row) => (row.id === id ? saved : row))
      : [saved, ...state.notes];
    writeDemo(state);
    return ok(normalizeNote(saved));
  }

  const dbPayload = { ...payload, color: noteColorToHex(payload.color) };
  const { data: note, error } = await run(() => (input.id
    ? supabase.from('notes').update({ ...dbPayload, updated_on: nowIso() }).eq('id', input.id).select().single()
    : supabase.from('notes').insert(dbPayload).select().single()));
  if (error) return { data: null, error };

  const keptIds = items.filter((item) => item.id && !String(item.id).startsWith('new-')).map((item) => item.id);
  const removal = supabase.from('note_items').delete().eq('note_id', note.id);
  await run(() => (keptIds.length ? removal.not('id', 'in', `(${keptIds.join(',')})`) : removal));

  if (items.length) {
    const rows = items.map((item) => ({
      ...(item.id && !String(item.id).startsWith('new-') ? { id: item.id } : {}),
      note_id: note.id,
      content: item.content,
      is_checked: Boolean(item.is_done),
      display_order: item.display_order,
    }));
    const { error: itemError } = await run(() => supabase.from('note_items').upsert(rows).select());
    if (itemError) return { data: null, error: itemError };
  }

  const { data: reloaded, error: reloadError } = await run(() => supabase
    .from('notes')
    .select('*, note_items(*)')
    .eq('id', note.id)
    .single());
  if (reloadError) return { data: null, error: reloadError };
  return ok(normalizeNote(reloaded));
}

export async function deleteNote(id) {
  if (useLocalData) {
    const state = readDemo();
    state.notes = state.notes.filter((row) => row.id !== id);
    writeDemo(state);
    return ok({ id });
  }
  return run(() => supabase
    .from('notes')
    .update({ is_deleted: true, deleted_date: nowIso() })
    .eq('id', id)
    .select()
    .maybeSingle());
}

export async function setNoteFlags(id, flags) {
  const payload = {};
  if ('is_pinned' in flags) payload.is_pinned = Boolean(flags.is_pinned);
  if ('is_archived' in flags) payload.is_archived = Boolean(flags.is_archived);
  if ('color' in flags) payload.color = NOTE_COLORS.includes(flags.color) ? flags.color : 'Default';

  if (useLocalData) {
    const state = readDemo();
    state.notes = state.notes.map((row) => (row.id === id ? { ...row, ...payload, updated_on: nowIso() } : row));
    writeDemo(state);
    return ok({ id, ...payload });
  }
  const dbPayload = 'color' in payload ? { ...payload, color: noteColorToHex(payload.color) } : payload;
  return run(() => supabase.from('notes').update({ ...dbPayload, updated_on: nowIso() }).eq('id', id).select().single());
}

/** Persists the order the employee dragged the cards into. */
export async function reorderNotes(orderedIds) {
  if (useLocalData) {
    const state = readDemo();
    state.notes = state.notes.map((row) => {
      const index = orderedIds.indexOf(row.id);
      return index === -1 ? row : { ...row, display_order: index + 1 };
    });
    writeDemo(state);
    return ok(orderedIds);
  }
  const results = await Promise.all(orderedIds.map((id, index) => run(() => supabase
    .from('notes')
    .update({ display_order: index + 1 })
    .eq('id', id)
    .select('id'))));
  const failure = results.find((result) => result.error);
  return failure ? { data: null, error: failure.error } : ok(orderedIds);
}
