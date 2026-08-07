// Safety Management — PPE (Personal Protective Equipment) catalogue, PPE
// Sets bound to an audience (position/department/project/site) via the
// platform's own Audience Engine, employee issuance/custody, field-visit
// compliance checks, and the safety-specific extension row hung off
// Asset-kind PPE (public.assets already owns its custody/status/Timeline —
// this module never duplicates that, only extends it).
//
// Backing objects (migration 202608070056_safety_management.sql):
//   Tables: public.safety_ppe_types, public.safety_ppe_sets,
//           public.safety_ppe_set_items, public.safety_asset_ext,
//           public.safety_issuances, public.safety_issuance_items,
//           public.safety_field_visits, public.safety_field_visit_checks,
//           public.safety_field_visit_check_missing_items
//   RPCs:   safety_ppe_type_upsert, safety_ppe_set_upsert,
//           safety_ppe_set_set_items, safety_asset_ext_upsert,
//           safety_asset_ext_inspect, safety_issuance_create,
//           safety_issuance_item_add, safety_issuance_item_update_status,
//           safety_issuance_item_reissue, safety_issuance_close,
//           safety_field_visit_create, safety_field_visit_check_record,
//           safety_field_visit_complete, safety_attachment_list,
//           safety_timeline, safety_expiration_scan (service_role only),
//           safety_my_ppe, safety_ppe_requirements_for_employee,
//           safety_compliance_summary
//   Plus the platform's own public.audience_save()/audience_matches()/
//   audience_describe() for "which PPE Set applies to whom" — never a
//   bespoke targeting table (entity_type 'SafetyPpeSet', dimension
//   'Position' among the platform's existing Department/Project/Site/...).
//
// Module code: 'SAFETY' (useTenant().hasModule('SAFETY')). Permission codes:
// Safety.Manage, Safety.Issue, Safety.Inspect, Safety.View — RLS/RPCs
// already enforce these server-side.
//
// Every function resolves with { data, error } and never throws — same
// contract as assetsService.js / engagementService.js. In local preview
// (useLocalData) the same API is served from a localStorage mirror.

import { supabase, useLocalData } from '../lib/supabaseClient';
import { getStorageProvider } from '../lib/storage';
import { extractScreamingSnakeCode, makeAsError } from './serviceEnvelope';

// ---------------------------------------------------------------------------
// Enums (mirror the CHECK constraints in the migration)
// ---------------------------------------------------------------------------
export const PPE_CATEGORIES = ['Head', 'Eye', 'Hand', 'Foot', 'Body', 'Respiratory', 'Hearing', 'Fire', 'Other'];
export const PPE_ASSET_CONDITION_STATUSES = ['Good', 'NeedsInspection', 'NeedsReplacement', 'Retired'];
export const ISSUANCE_STATUSES = ['Issued', 'PartiallyReturned', 'Returned', 'Closed'];
// Replaced is system-generated only (safety_issuance_item_reissue()'s own
// job) — safety_issuance_item_update_status() rejects a manual 'Replaced'
// transition, same "Missing is only ever system-generated" precedent Assets
// Management's own inventory scans already established.
export const ISSUANCE_ITEM_MANUAL_STATUSES = ['Returned', 'Lost', 'Damaged', 'Expired'];
export const FIELD_VISIT_STATUSES = ['Draft', 'Completed'];

// ---------------------------------------------------------------------------
// Plumbing — same {data, error} envelope as assetsService.js.
// ---------------------------------------------------------------------------
const asError = makeAsError('SAFETY_REQUEST_FAILED');
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

const callRpc = async (name, params) => run(() => supabase.rpc(name, params));

export const safetyErrorMessage = (t, error) => {
  if (!error) return '';
  const code = extractScreamingSnakeCode(error);
  if (code) {
    const key = `safety_err_${code.toLowerCase()}`;
    const label = t(key);
    if (label !== key) return label;
  }
  return t('error_generic');
};

const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const nowIso = () => new Date().toISOString();
const trimmed = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

// Column projections — business-facing columns only (contract §17).
const PPE_TYPE_COLUMNS = 'id, code, name_ar, name_en, category, description_ar, description_en, standard_lifespan_days, requires_size, display_order, is_active';
const PPE_SET_COLUMNS = 'id, code, name_ar, name_en, description_ar, description_en, display_order, is_active';
const PPE_SET_ITEM_COLUMNS = 'id, set_id, ppe_type_id, quantity, reissue_interval_days, is_mandatory';
const ASSET_EXT_COLUMNS = 'id, asset_id, ppe_type_id, expiry_date, inspection_interval_days, last_inspection_date, next_inspection_due, condition_status, notes';
const ISSUANCE_COLUMNS = 'id, reference, employee_id, ppe_set_id, status, issued_by, issued_on, notes';
const ISSUANCE_ITEM_COLUMNS = 'id, issuance_id, ppe_type_id, asset_id, quantity, size, issued_date, expiry_date, status, replaced_by_item_id, returned_on, notes';
const FIELD_VISIT_COLUMNS = 'id, reference, site_id, project_id, inspector_id, visit_date, status, notes';
const FIELD_VISIT_CHECK_COLUMNS = 'id, visit_id, employee_id, is_compliant, notes, checked_by, checked_on';

const DEFAULT_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Local preview store
// ---------------------------------------------------------------------------
const DEMO_KEY = 'bbnovix_safety_demo';

const seedDemo = () => ({
  ppeTypes: [
    { id: 'demo-ppe-helmet', code: 'HELM', name_ar: 'خوذة السلامة', name_en: 'Safety Helmet', category: 'Head', description_ar: null, description_en: null, standard_lifespan_days: 1095, requires_size: false, display_order: 1, is_active: true },
    { id: 'demo-ppe-gloves', code: 'GLOVE', name_ar: 'قفازات', name_en: 'Gloves', category: 'Hand', description_ar: null, description_en: null, standard_lifespan_days: 180, requires_size: true, display_order: 2, is_active: true },
    { id: 'demo-ppe-boots', code: 'BOOT', name_ar: 'حذاء السلامة', name_en: 'Safety Boots', category: 'Foot', description_ar: null, description_en: null, standard_lifespan_days: 365, requires_size: true, display_order: 3, is_active: true },
  ],
  ppeSets: [
    { id: 'demo-set-electrician', code: 'ELEC-SET', name_ar: 'مجموعة فني كهرباء', name_en: 'Electrician Set', description_ar: null, description_en: null, display_order: 1, is_active: true },
  ],
  ppeSetItems: [
    { id: 'demo-set-item-1', set_id: 'demo-set-electrician', ppe_type_id: 'demo-ppe-helmet', quantity: 1, reissue_interval_days: null, is_mandatory: true },
    { id: 'demo-set-item-2', set_id: 'demo-set-electrician', ppe_type_id: 'demo-ppe-gloves', quantity: 1, reissue_interval_days: 180, is_mandatory: true },
  ],
  assetExt: [],
  issuances: [
    { id: 'demo-issuance-1', reference: 'NO-DEMO-PI-00000001', employee_id: 'demo-user', ppe_set_id: 'demo-set-electrician', status: 'Issued', issued_by: 'demo-user', issued_on: nowIso(), notes: null },
  ],
  issuanceItems: [
    { id: 'demo-issuance-item-1', issuance_id: 'demo-issuance-1', ppe_type_id: 'demo-ppe-helmet', asset_id: null, quantity: 1, size: null, issued_date: nowIso().slice(0, 10), expiry_date: null, status: 'Issued', replaced_by_item_id: null, returned_on: null, notes: null },
  ],
  fieldVisits: [],
  fieldVisitChecks: [],
});

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
// PPE Types
// ---------------------------------------------------------------------------
export async function loadPpeTypes({ includeInactive = false } = {}) {
  if (useLocalData) {
    const rows = readDemo().ppeTypes;
    return ok(includeInactive ? rows : rows.filter((row) => row.is_active !== false));
  }
  let query = supabase.from('safety_ppe_types').select(PPE_TYPE_COLUMNS).order('display_order');
  if (!includeInactive) query = query.eq('is_active', true);
  return runList(() => query);
}

/** @param {{id?, code?, name_ar, name_en?, category, description_ar?, description_en?, standard_lifespan_days?, requires_size?, display_order?, is_active?}} type */
export async function savePpeType(type) {
  if (!trimmed(type?.name_ar)) return ko('NAME_AR_REQUIRED');
  const params = {
    p_id: type.id || null,
    p_code: trimmed(type.code),
    p_name_ar: type.name_ar,
    p_name_en: trimmed(type.name_en),
    p_category: type.category,
    p_description_ar: trimmed(type.description_ar),
    p_description_en: trimmed(type.description_en),
    p_standard_lifespan_days: Number(type.standard_lifespan_days) || null,
    p_requires_size: type.requires_size ?? false,
    p_display_order: Number(type.display_order) || 0,
    p_is_active: type.is_active ?? true,
  };
  if (useLocalData) {
    const state = readDemo();
    const id = type.id || newId();
    const saved = {
      id, code: params.p_code, name_ar: params.p_name_ar, name_en: params.p_name_en,
      category: params.p_category, description_ar: params.p_description_ar, description_en: params.p_description_en,
      standard_lifespan_days: params.p_standard_lifespan_days, requires_size: params.p_requires_size,
      display_order: params.p_display_order, is_active: params.p_is_active,
    };
    state.ppeTypes = type.id
      ? state.ppeTypes.map((row) => (row.id === id ? saved : row))
      : [...state.ppeTypes, saved];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('safety_ppe_type_upsert', params);
}

// ---------------------------------------------------------------------------
// PPE Sets + set items
// ---------------------------------------------------------------------------
export async function loadPpeSets({ includeInactive = false } = {}) {
  if (useLocalData) {
    const rows = readDemo().ppeSets;
    return ok(includeInactive ? rows : rows.filter((row) => row.is_active !== false));
  }
  let query = supabase.from('safety_ppe_sets').select(PPE_SET_COLUMNS).order('display_order');
  if (!includeInactive) query = query.eq('is_active', true);
  return runList(() => query);
}

export async function loadPpeSetItems(setId) {
  if (!setId) return ok([]);
  if (useLocalData) return ok(readDemo().ppeSetItems.filter((row) => row.set_id === setId));
  return runList(() => supabase.from('safety_ppe_set_items').select(PPE_SET_ITEM_COLUMNS).eq('set_id', setId));
}

/** @param {{id?, code?, name_ar, name_en?, description_ar?, description_en?, display_order?, is_active?}} set */
export async function savePpeSet(set) {
  if (!trimmed(set?.name_ar)) return ko('NAME_AR_REQUIRED');
  const params = {
    p_id: set.id || null,
    p_code: trimmed(set.code),
    p_name_ar: set.name_ar,
    p_name_en: trimmed(set.name_en),
    p_description_ar: trimmed(set.description_ar),
    p_description_en: trimmed(set.description_en),
    p_display_order: Number(set.display_order) || 0,
    p_is_active: set.is_active ?? true,
  };
  if (useLocalData) {
    const state = readDemo();
    const id = set.id || newId();
    const saved = {
      id, code: params.p_code, name_ar: params.p_name_ar, name_en: params.p_name_en,
      description_ar: params.p_description_ar, description_en: params.p_description_en,
      display_order: params.p_display_order, is_active: params.p_is_active,
    };
    state.ppeSets = set.id
      ? state.ppeSets.map((row) => (row.id === id ? saved : row))
      : [...state.ppeSets, saved];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('safety_ppe_set_upsert', params);
}

/** @param {string} setId @param {Array<{ppeTypeId, quantity?, reissueIntervalDays?, isMandatory?}>} items full-replace, same idiom as asset_custody_unit_set_members(). */
export async function setPpeSetItems(setId, items) {
  if (useLocalData) {
    const state = readDemo();
    state.ppeSetItems = [
      ...state.ppeSetItems.filter((row) => row.set_id !== setId),
      ...(items || []).map((item) => ({
        id: newId(), set_id: setId, ppe_type_id: item.ppeTypeId,
        quantity: Number(item.quantity) || 1, reissue_interval_days: item.reissueIntervalDays || null,
        is_mandatory: item.isMandatory ?? true,
      })),
    ];
    writeDemo(state);
    return ok(null);
  }
  return callRpc('safety_ppe_set_set_items', {
    p_set_id: setId,
    p_items: (items || []).map((item) => ({
      ppeTypeId: item.ppeTypeId, quantity: Number(item.quantity) || 1,
      reissueIntervalDays: item.reissueIntervalDays || null, isMandatory: item.isMandatory ?? true,
    })),
  });
}

/** @param {string} setId @param {object} rule Audience Engine rule shape ({match_mode, terms:[{group_no, operator, dimension, value_id|value_text}]}) — same shape Announcements/Circulars already send to audience_save(). */
export async function savePpeSetRequirements(setId, rule) {
  if (useLocalData) return ok(null);
  return run(() => supabase.rpc('audience_save', { p_entity_type: 'SafetyPpeSet', p_entity_id: setId, p_rule: rule || {} }));
}

export async function loadPpeSetRequirements(setId) {
  if (useLocalData) return ok({ match_mode: 'Any', is_everyone: false, terms: [] });
  return run(() => supabase.rpc('audience_describe', { p_entity_type: 'SafetyPpeSet', p_entity_id: setId }));
}

// ---------------------------------------------------------------------------
// Asset-kind PPE extension (hangs off an existing Assets Management asset)
// ---------------------------------------------------------------------------
/** @param {{assetId, ppeTypeId, expiryDate?, inspectionIntervalDays?, lastInspectionDate?, conditionStatus?, notes?}} ext */
export async function saveAssetExt(ext) {
  if (!ext?.assetId) return ko('ASSET_ID_REQUIRED');
  if (!ext?.ppeTypeId) return ko('PPE_TYPE_ID_REQUIRED');
  const params = {
    p_asset_id: ext.assetId,
    p_ppe_type_id: ext.ppeTypeId,
    p_expiry_date: ext.expiryDate || null,
    p_inspection_interval_days: Number(ext.inspectionIntervalDays) || null,
    p_last_inspection_date: ext.lastInspectionDate || null,
    p_condition_status: ext.conditionStatus || 'Good',
    p_notes: trimmed(ext.notes),
  };
  if (useLocalData) return ok(newId());
  return callRpc('safety_asset_ext_upsert', params);
}

export async function inspectAssetExt(assetId, { inspectionDate, conditionStatus, nextInspectionDue, notes } = {}) {
  if (useLocalData) return ok(null);
  return callRpc('safety_asset_ext_inspect', {
    p_asset_id: assetId, p_inspection_date: inspectionDate || null, p_condition_status: conditionStatus || null,
    p_next_inspection_due: nextInspectionDue || null, p_notes: trimmed(notes),
  });
}

export async function loadAssetExt(assetId) {
  if (!assetId) return ok(null);
  if (useLocalData) return ok(readDemo().assetExt.find((row) => row.asset_id === assetId) || null);
  return run(() => supabase.from('safety_asset_ext').select(ASSET_EXT_COLUMNS).eq('asset_id', assetId).maybeSingle());
}

export async function loadAssetExtList({ limit = DEFAULT_PAGE_SIZE, offset = 0 } = {}) {
  if (useLocalData) return ok(readDemo().assetExt);
  return runList(() => supabase.from('safety_asset_ext').select(ASSET_EXT_COLUMNS)
    .order('next_inspection_due', { ascending: true, nullsFirst: false }).range(offset, offset + limit - 1));
}

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------
/** @param {{employeeId?, status?, limit?, offset?}} filters */
export async function loadIssuances(filters = {}) {
  const limit = Number(filters.limit) > 0 ? Number(filters.limit) : DEFAULT_PAGE_SIZE;
  const offset = Number(filters.offset) > 0 ? Number(filters.offset) : 0;
  if (useLocalData) {
    let rows = readDemo().issuances;
    if (filters.employeeId) rows = rows.filter((row) => row.employee_id === filters.employeeId);
    if (filters.status) rows = rows.filter((row) => row.status === filters.status);
    return ok(rows.slice(offset, offset + limit));
  }
  let query = supabase.from('safety_issuances').select(ISSUANCE_COLUMNS)
    .order('issued_on', { ascending: false }).range(offset, offset + limit - 1);
  if (filters.employeeId) query = query.eq('employee_id', filters.employeeId);
  if (filters.status) query = query.eq('status', filters.status);
  return runList(() => query);
}

/** @param {string[]} ids Fetches issuances by id regardless of recency —
 * loadIssuances() itself is capped/ordered by issued_on desc, so an older
 * issuance referenced by an item pulled from a *different* sort/cap (e.g.
 * loadExpiringIssuanceItems(), ordered by expiry_date) can fall outside that
 * page; callers that need to resolve a specific set of issuance ids no
 * matter how old should use this instead of assuming loadIssuances() already
 * covers them. */
export async function loadIssuancesByIds(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return ok([]);
  if (useLocalData) return ok(readDemo().issuances.filter((row) => list.includes(row.id)));
  return runList(() => supabase.from('safety_issuances').select(ISSUANCE_COLUMNS).in('id', list));
}

export async function loadIssuanceItems(issuanceId) {
  if (!issuanceId) return ok([]);
  if (useLocalData) return ok(readDemo().issuanceItems.filter((row) => row.issuance_id === issuanceId));
  return runList(() => supabase.from('safety_issuance_items').select(ISSUANCE_ITEM_COLUMNS).eq('issuance_id', issuanceId));
}

/** @param {string[]} issuanceIds Same rows loadIssuanceItems() returns per
 * issuance, but for many issuances in one round trip via .in() — for
 * SafetyReportsAdmin.jsx's Lost/Most-replaced/Distribution tabs, which
 * previously fired one loadIssuanceItems() call per issuance (up to
 * ISSUANCE_ITEMS_SCAN_CAP separate requests on a single button click). The
 * same tenant-wide safety_issuance_items SELECT RLS policy that already
 * permits loadIssuanceItems()/loadExpiringIssuanceItems() covers this. */
export async function loadIssuanceItemsBulk(issuanceIds) {
  const list = [...new Set((issuanceIds || []).filter(Boolean))];
  if (!list.length) return ok([]);
  if (useLocalData) return ok(readDemo().issuanceItems.filter((row) => list.includes(row.issuance_id)));
  return runList(() => supabase.from('safety_issuance_items').select(ISSUANCE_ITEM_COLUMNS).in('issuance_id', list));
}

/** @param {{withinDays?, limit?, offset?}} filters Still-Issued items with an
 * expiry_date set, soonest first — the flat "every issuance's items" read no
 * other export here provides (loadIssuanceItems() is scoped to one issuance).
 * Added for SafetyExpirationsAdmin.jsx's Consumables tab; mirrors
 * loadAssetExtList()'s own shape. safety_issuance_items' own RLS read policy
 * already permits this plain filtered select (see the migration's RLS
 * section), so no new RPC was needed. */
export async function loadExpiringIssuanceItems({ withinDays, limit = DEFAULT_PAGE_SIZE, offset = 0 } = {}) {
  if (useLocalData) {
    const state = readDemo();
    let rows = state.issuanceItems.filter((row) => row.status === 'Issued' && row.expiry_date);
    if (Number(withinDays) > 0) {
      const horizon = new Date();
      horizon.setDate(horizon.getDate() + Number(withinDays));
      const horizonStr = horizon.toISOString().slice(0, 10);
      rows = rows.filter((row) => row.expiry_date <= horizonStr);
    }
    rows = [...rows].sort((a, b) => (a.expiry_date || '').localeCompare(b.expiry_date || ''));
    return ok(rows.slice(offset, offset + limit));
  }
  let query = supabase.from('safety_issuance_items').select(ISSUANCE_ITEM_COLUMNS)
    .eq('status', 'Issued').not('expiry_date', 'is', null)
    .order('expiry_date', { ascending: true }).range(offset, offset + limit - 1);
  if (Number(withinDays) > 0) {
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + Number(withinDays));
    query = query.lte('expiry_date', horizon.toISOString().slice(0, 10));
  }
  return runList(() => query);
}

/** @param {string} employeeId @param {string|null} ppeSetId @param {string} notes @param {Array<{ppeTypeId, assetId?, quantity?, size?, issuedDate?, expiryDate?}>} items */
export async function createIssuance(employeeId, ppeSetId, notes, items) {
  if (!employeeId) return ko('EMPLOYEE_ID_REQUIRED');
  if (!items?.length) return ko('ITEMS_REQUIRED');
  if (useLocalData) {
    const state = readDemo();
    const id = newId();
    state.issuances = [...state.issuances, {
      id, reference: `NO-DEMO-PI-${String(Date.now()).slice(-8)}`, employee_id: employeeId,
      ppe_set_id: ppeSetId || null, status: 'Issued', issued_by: 'demo-user', issued_on: nowIso(), notes: trimmed(notes),
    }];
    state.issuanceItems = [...state.issuanceItems, ...items.map((item) => ({
      id: newId(), issuance_id: id, ppe_type_id: item.ppeTypeId, asset_id: item.assetId || null,
      quantity: Number(item.quantity) || 1, size: trimmed(item.size), issued_date: item.issuedDate || nowIso().slice(0, 10),
      expiry_date: item.expiryDate || null, status: 'Issued', replaced_by_item_id: null, returned_on: null, notes: null,
    }))];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('safety_issuance_create', {
    p_employee_id: employeeId, p_ppe_set_id: ppeSetId || null, p_notes: trimmed(notes),
    p_items: items.map((item) => ({
      ppeTypeId: item.ppeTypeId, assetId: item.assetId || null, quantity: Number(item.quantity) || 1,
      size: item.size || null, issuedDate: item.issuedDate || null, expiryDate: item.expiryDate || null,
    })),
  });
}

/** @param {'Returned'|'Lost'|'Damaged'|'Expired'} newStatus never 'Replaced' — that status is system-generated only, see reissueIssuanceItem(). */
export async function updateIssuanceItemStatus(itemId, newStatus, notes) {
  if (useLocalData) {
    const state = readDemo();
    state.issuanceItems = state.issuanceItems.map((row) => (row.id === itemId
      ? { ...row, status: newStatus, returned_on: newStatus === 'Returned' ? nowIso() : row.returned_on }
      : row));
    writeDemo(state);
    return ok(null);
  }
  return callRpc('safety_issuance_item_update_status', { p_item_id: itemId, p_new_status: newStatus, p_notes: trimmed(notes) });
}

export async function reissueIssuanceItem(itemId, newExpiryDate, notes) {
  if (useLocalData) {
    const state = readDemo();
    const original = state.issuanceItems.find((row) => row.id === itemId);
    if (!original) return ko('ITEM_NOT_FOUND');
    const newItemId = newId();
    state.issuanceItems = state.issuanceItems.map((row) => (row.id === itemId ? { ...row, status: 'Replaced', replaced_by_item_id: newItemId } : row));
    state.issuanceItems.push({
      ...original, id: newItemId, status: 'Issued', issued_date: nowIso().slice(0, 10),
      expiry_date: newExpiryDate || null, replaced_by_item_id: null, returned_on: null,
    });
    writeDemo(state);
    return ok(newItemId);
  }
  return callRpc('safety_issuance_item_reissue', { p_item_id: itemId, p_new_expiry_date: newExpiryDate || null, p_notes: trimmed(notes) });
}

export async function closeIssuance(issuanceId) {
  if (useLocalData) {
    const state = readDemo();
    state.issuances = state.issuances.map((row) => (row.id === issuanceId ? { ...row, status: 'Closed' } : row));
    writeDemo(state);
    return ok(null);
  }
  return callRpc('safety_issuance_close', { p_issuance_id: issuanceId });
}

// ---------------------------------------------------------------------------
// Field Visits
// ---------------------------------------------------------------------------
export async function loadFieldVisits({ limit = DEFAULT_PAGE_SIZE, offset = 0 } = {}) {
  if (useLocalData) return ok(readDemo().fieldVisits.slice(offset, offset + limit));
  return runList(() => supabase.from('safety_field_visits').select(FIELD_VISIT_COLUMNS)
    .order('visit_date', { ascending: false }).range(offset, offset + limit - 1));
}

export async function loadFieldVisitChecks(visitId) {
  if (!visitId) return ok([]);
  if (useLocalData) return ok(readDemo().fieldVisitChecks.filter((row) => row.visit_id === visitId));
  return runList(() => supabase.from('safety_field_visit_checks').select(FIELD_VISIT_CHECK_COLUMNS).eq('visit_id', visitId));
}

export async function createFieldVisit(siteId, projectId, visitDate, notes) {
  if (useLocalData) {
    const state = readDemo();
    const id = newId();
    state.fieldVisits = [...state.fieldVisits, {
      id, reference: `NO-DEMO-FV-${String(Date.now()).slice(-8)}`, site_id: siteId || null, project_id: projectId || null,
      inspector_id: 'demo-user', visit_date: visitDate || nowIso().slice(0, 10), status: 'Draft', notes: trimmed(notes),
    }];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('safety_field_visit_create', { p_site_id: siteId || null, p_project_id: projectId || null, p_visit_date: visitDate || null, p_notes: trimmed(notes) });
}

/** @param {string} visitId @param {string} employeeId @param {boolean} isCompliant @param {string[]} missingPpeTypeIds required (recognized) when isCompliant is false @param {string} notes */
export async function recordFieldVisitCheck(visitId, employeeId, isCompliant, missingPpeTypeIds, notes) {
  if (useLocalData) {
    const state = readDemo();
    const id = newId();
    state.fieldVisitChecks = [...state.fieldVisitChecks, {
      id, visit_id: visitId, employee_id: employeeId, is_compliant: isCompliant,
      notes: trimmed(notes), checked_by: 'demo-user', checked_on: nowIso(),
    }];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('safety_field_visit_check_record', {
    p_visit_id: visitId, p_employee_id: employeeId, p_is_compliant: isCompliant,
    p_missing_ppe_type_ids: missingPpeTypeIds?.length ? missingPpeTypeIds : null, p_notes: trimmed(notes),
  });
}

export async function completeFieldVisit(visitId) {
  if (useLocalData) {
    const state = readDemo();
    state.fieldVisits = state.fieldVisits.map((row) => (row.id === visitId ? { ...row, status: 'Completed' } : row));
    writeDemo(state);
    return ok(null);
  }
  return callRpc('safety_field_visit_complete', { p_id: visitId });
}

// ---------------------------------------------------------------------------
// Employee-facing reads, attachments, timeline, compliance
// ---------------------------------------------------------------------------
export async function loadMyPpe(employeeId) {
  if (useLocalData) {
    const state = readDemo();
    const items = state.issuanceItems.filter((item) => {
      const issuance = state.issuances.find((row) => row.id === item.issuance_id);
      return issuance && issuance.employee_id === (employeeId || 'demo-user') && item.status === 'Issued';
    });
    return ok(items);
  }
  return run(() => supabase.rpc('safety_my_ppe', { p_employee_id: employeeId || undefined }));
}

export async function loadPpeRequirementsForEmployee(employeeId) {
  if (useLocalData) {
    const state = readDemo();
    return ok(state.ppeSetItems.map((item) => {
      const type = state.ppeTypes.find((row) => row.id === item.ppe_type_id);
      const set = state.ppeSets.find((row) => row.id === item.set_id);
      return {
        ppeTypeId: item.ppe_type_id, nameAr: type?.name_ar, nameEn: type?.name_en, category: type?.category,
        ppeSetId: item.set_id, ppeSetNameAr: set?.name_ar, ppeSetNameEn: set?.name_en,
        quantity: item.quantity, reissueIntervalDays: item.reissue_interval_days, isMandatory: item.is_mandatory,
      };
    }));
  }
  return run(() => supabase.rpc('safety_ppe_requirements_for_employee', { p_employee_id: employeeId || undefined }));
}

export async function loadComplianceSummary({ departmentId, projectId, siteId, positionId } = {}) {
  if (useLocalData) return ok({ requiredCount: 0, fullyIssuedCount: 0, partiallyIssuedCount: 0, notIssuedCount: 0 });
  return run(() => supabase.rpc('safety_compliance_summary', {
    p_department_id: departmentId || null, p_project_id: projectId || null,
    p_site_id: siteId || null, p_position_id: positionId || null,
  }));
}

// safety_attachment_list() returns the same row shape as attachment_list()
// minus `url`; resolved here the same one-getUrl-call-per-row way (parallel,
// not sequential) assetAttachmentList() already established for Assets
// Management, kept identical rather than "improved" here alone.
/** @param {'SafetyPpeType'|'SafetyIssuance'|'SafetyFieldVisitCheck'} entityType */
export async function listSafetyAttachments(entityType, entityId) {
  if (useLocalData) return ok([]);
  const { data, error } = await run(() => supabase.rpc('safety_attachment_list', { p_entity_type: entityType, p_entity_id: entityId }));
  if (error) return { data: null, error };

  const rows = Array.isArray(data) ? data : [];
  const resolved = await Promise.all(rows.map(async (row) => {
    const provider = await getStorageProvider(row.layer, { bucket: row.bucket || undefined });
    const { data: urlData } = await provider.getUrl(row.path, { expiresIn: 3600 });
    return { ...row, url: urlData?.url || '' };
  }));
  return ok(resolved);
}

export async function loadSafetyTimeline(entityType, entityId) {
  if (useLocalData) return ok([]);
  return run(() => supabase.rpc('safety_timeline', { p_entity_type: entityType, p_entity_id: entityId }));
}
