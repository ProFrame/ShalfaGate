// Favorites + Recent Items — personal navigation aids over public.app_screens.
//
// Backing objects (migration 202608070058_ui_polish.sql):
//   Tables: public.user_favorites, public.user_recent_screens
//   RPCs:   favorite_screen_add(p_screen_code), favorite_screen_remove(p_screen_code),
//           favorite_screens_list(), recent_screen_touch(p_screen_code),
//           recent_screens_list(p_limit default 20)
//
// Both *_list() RPCs return jsonb: the caller's own rows already joined
// against public.app_screens for code/area/group_code/name_ar/name_en/icon/
// route/display_order — this file never re-joins that shape against a second
// screens source, it only passes the RPC's own rows through.
//
// Both favorite_screens_list() and recent_screens_list()'s own
// jsonb_build_object() include the row's own timestamp (favorited_on /
// visited_on respectively) alongside the screen fields, so Recent Items can
// show "2 hours ago" from live data. Consumers of these rows should still
// treat visited_on as optional (see screenSnapshotFromNav below and
// RecentItemsScreen.jsx's own rendering, which both omit the relative-time
// segment entirely when it is missing rather than showing "Invalid Date") —
// this keeps demo/local preview (whose own store always carries visited_on)
// and live data on the same rendering path without relying on the RPC shape.
//
// Every function resolves with { data, error } and never throws — same
// contract as operationsService.js/safetyService.js. In local preview
// (useLocalData) the same API is served from a localStorage mirror.

import { supabase, useLocalData } from '../lib/supabaseClient';
import { extractScreamingSnakeCode, makeAsError } from './serviceEnvelope';

const asError = makeAsError('NAVIGATION_AIDS_REQUEST_FAILED');
const ok = (data) => ({ data, error: null });
const ko = (value) => ({ data: null, error: asError(value) });

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

const runList = async (build) => {
  const { data, error } = await run(build);
  if (error) return { data: null, error };
  return ok(Array.isArray(data) ? data : []);
};

export const navigationAidsErrorMessage = (t, error) => {
  if (!error) return '';
  const code = extractScreamingSnakeCode(error);
  if (code) {
    const key = `navaids_err_${code.toLowerCase()}`;
    const label = t(key);
    if (label !== key) return label;
  }
  return t('error_generic');
};

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Screen -> RPC-shaped snapshot
//
// AppShell.jsx's own useNavigationGroups(roleCode) (exported from there, not
// rebuilt here) is the one place that already resolves "which screens can
// this person see, in which group, under which already-localized label" —
// both FavoritesScreen.jsx (the add-a-favorite picker) and AppShell.jsx
// itself (the per-navigation touch effect) hand one of ITS screen objects in
// here rather than this file inventing a second screen-listing mechanism.
//
// Only used for the DEMO/local-preview store: the real backend only ever
// sends p_screen_code to the RPC (the server does its own join against the
// real public.app_screens), so a real caller may omit this argument
// entirely. Without it, demo mode would have nothing to join against — there
// is no public.app_screens table in local preview — so the snapshot is
// exactly the shape favorite_screens_list()/recent_screens_list() return,
// kept isomorphic so both screens render demo and live rows identically.
// ---------------------------------------------------------------------------
export const screenSnapshotFromNav = (screen) => {
  if (!screen?.code) return null;
  const route = String(screen.path || '').replace(/^\/app\/?/, '');
  const label = screen.label || screen.code;
  return {
    code: screen.code,
    area: screen.area || 'PORTAL',
    group_code: screen.group || screen.area || 'OTHER',
    name_ar: screen.name_ar || label,
    name_en: screen.name_en || label,
    icon: screen.icon || null,
    route,
    display_order: Number(screen.display_order) || 0,
  };
};

// ---------------------------------------------------------------------------
// Local preview store
// ---------------------------------------------------------------------------
const DEMO_KEY = 'bbnovix_navigation_aids_demo';

const seedDemo = () => ({ favorites: [], recents: [] });

const readDemo = () => {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
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
// Favorites
// ---------------------------------------------------------------------------
export async function loadFavoriteScreens() {
  if (useLocalData) return ok(readDemo().favorites);
  return runList(() => supabase.rpc('favorite_screens_list'));
}

/** @param {string} screenCode @param {object} [screenSnapshot] demo-store only, see screenSnapshotFromNav */
export async function addFavoriteScreen(screenCode, screenSnapshot) {
  if (!screenCode) return ko('SCREEN_CODE_REQUIRED');
  if (useLocalData) {
    const state = readDemo();
    const snapshot = screenSnapshot || { code: screenCode };
    state.favorites = [snapshot, ...state.favorites.filter((row) => row.code !== screenCode)];
    writeDemo(state);
    return ok(null);
  }
  return run(() => supabase.rpc('favorite_screen_add', { p_screen_code: screenCode }));
}

/** Idempotent both live and in demo — removing an unfavorited code is a silent no-op. */
export async function removeFavoriteScreen(screenCode) {
  if (useLocalData) {
    const state = readDemo();
    state.favorites = state.favorites.filter((row) => row.code !== screenCode);
    writeDemo(state);
    return ok(null);
  }
  return run(() => supabase.rpc('favorite_screen_remove', { p_screen_code: screenCode }));
}

// ---------------------------------------------------------------------------
// Recent items
// ---------------------------------------------------------------------------
export async function loadRecentScreens(limit = 20) {
  const clamped = Math.min(Math.max(Number(limit) || 20, 1), 50);
  if (useLocalData) {
    const rows = [...readDemo().recents]
      .sort((a, b) => String(b.visited_on || '').localeCompare(String(a.visited_on || '')));
    return ok(rows.slice(0, clamped));
  }
  return runList(() => supabase.rpc('recent_screens_list', { p_limit: clamped }));
}

/**
 * Fire-and-forget friendly: a caller that does not await this and ignores its
 * result is fine (this is a passive "log this visit" call, never a
 * user-facing action needing error feedback) — but it still always resolves
 * { data, error } rather than throwing, so an awaiting caller is never
 * surprised either.
 * @param {string} screenCode @param {object} [screenSnapshot] demo-store only, see screenSnapshotFromNav
 */
export async function touchRecentScreen(screenCode, screenSnapshot) {
  if (!screenCode) return ok(null);
  if (useLocalData) {
    const state = readDemo();
    const snapshot = { ...(screenSnapshot || { code: screenCode }), visited_on: nowIso() };
    state.recents = [snapshot, ...state.recents.filter((row) => row.code !== screenCode)].slice(0, 50);
    writeDemo(state);
    return ok(null);
  }
  return run(() => supabase.rpc('recent_screen_touch', { p_screen_code: screenCode }));
}
