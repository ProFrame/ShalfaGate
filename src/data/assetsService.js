// Assets Management — asset registry, custody chain (issue/transfer/return),
// maintenance workflow, reservations, disposal-to-approval handoff, and
// physical inventory (counting) sessions.
//
// Backing objects (migration 202608060054_assets_management.sql):
//   Tables: public.asset_groups, public.asset_custody_units,
//           public.asset_custody_unit_members, public.assets,
//           public.asset_transactions, public.asset_reservations,
//           public.asset_maintenance, public.asset_inventory_sessions,
//           public.asset_inventory_session_units,
//           public.asset_inventory_session_members, public.asset_inventory_scans
//   RPCs:   asset_group_upsert, asset_custody_unit_upsert,
//           asset_custody_unit_set_members, asset_create, asset_update,
//           asset_transaction_create, asset_transfer_accept,
//           asset_transfer_reject, asset_maintenance_report,
//           asset_maintenance_approve, asset_maintenance_advance,
//           asset_reserve, asset_release_reservation, asset_dispose_request,
//           asset_attachment_list, asset_timeline,
//           asset_inventory_session_create, asset_inventory_session_start,
//           asset_inventory_scan, asset_inventory_session_complete
//
// Module code: 'ASSETS' (useTenant().hasModule('ASSETS')). Permission codes:
// Assets.Manage, Assets.Operate, Assets.Maintain, Assets.Inventory,
// Assets.View — RLS/RPCs already enforce these server-side; screens gate on
// them too via useTenant()/has_permission, same as every other admin screen.
//
// Every function resolves with { data, error } and never throws — same
// contract as engagementService.js/digitalIdentityService.js. In local
// preview (useLocalData) the same API is served from a localStorage mirror.

import { supabase, useLocalData } from '../lib/supabaseClient';
import { getStorageProvider } from '../lib/storage';
import { extractScreamingSnakeCode, makeAsError } from './serviceEnvelope';

// ---------------------------------------------------------------------------
// Enums (mirror the CHECK constraints in the migration)
// ---------------------------------------------------------------------------
// 'Reserved' is deliberately not here — see the migration's own comment on
// assets.status: a reservation is a future-dated overlay that coexists with
// whatever the live status already is, never a status value itself.
export const ASSET_STATUSES = ['Available', 'InUse', 'InMaintenance', 'Lost', 'Disposed'];
export const INVENTORY_SESSION_STATUSES = ['Draft', 'InProgress', 'Completed', 'Cancelled'];
// 'Missing' is system-generated only (asset_inventory_session_complete()'s
// own auto-generation pass) — asset_inventory_scan() rejects a manual
// 'Missing' scan with MISSING_IS_SYSTEM_GENERATED.
export const INVENTORY_SCAN_RESULTS = [
  'Found', 'Missing', 'Damaged', 'WrongLocation', 'WrongCustodian',
  'NeedsMaintenance', 'Disposed', 'UnexpectedAsset', 'BarcodeMissing',
];
export const CUSTODY_ROLE_CODES = ['Owner', 'Custodian', 'BackupCustodian'];

// The disposal request template — asset_dispose_request() opens a Draft form
// against this code; the caller then opens ApprovalChain.jsx's
// SendApprovalModal with that form's id and this template's id, the exact
// approvalService.js "send for approval" flow every other module already
// uses. See loadAssetDisposalTemplateId() below.
export const ASSET_DISPOSAL_TEMPLATE_CODE = 'FM-SH-AST-D-26-0001\\V1.0';

// ---------------------------------------------------------------------------
// Plumbing — same {data, error} envelope as engagementService.js /
// audienceService.js / orgDimensionsService.js / tenantProfileService.js.
// ---------------------------------------------------------------------------
const asError = makeAsError('ASSETS_REQUEST_FAILED');
const ok = (data) => ({ data, error: null });
const ko = (value) => ({ data: null, error: asError(value) });

/** Awaits a PostgREST/RPC builder and flattens it into the platform envelope. */
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

/** Same as run(), but always resolves data to an array — for list reads. */
const runList = async (build) => {
  const { data, error } = await run(build);
  if (error) return { data: null, error };
  return ok(Array.isArray(data) ? data : []);
};

const callRpc = async (name, params) => run(() => supabase.rpc(name, params));
const callRpcList = async (name, params) => runList(() => supabase.rpc(name, params));

/**
 * Wraps a value as a quoted PostgREST filter literal so it is safe to splice
 * into an .or()/.ilike() filter string — without this, a search value
 * containing `,`/`(`/`)` is parsed as additional filter syntax rather than
 * literal text (closing-audit finding: unescaped search injection).
 */
const escapeForOrFilter = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Reduces an unsorted asset_transactions page to one row per asset_id — the most recent by performed_on, since callers always order desc first. */
const latestPerAssetId = (rows) => {
  const seen = new Map();
  for (const row of rows) if (!seen.has(row.asset_id)) seen.set(row.asset_id, row);
  return seen;
};

// Business-facing columns only — every read below excludes tenant_id and the
// apply_row_defaults audit columns (created_by/updated_by/is_deleted/
// deleted_by/deleted_date/row_version/updated_on), which no screen in this
// module renders (contract §17: project the columns the caller actually
// uses).
const ASSET_COLUMNS = 'id, group_id, reference, name_ar, name_en, status, color, brand, model, serial_no, imei, manufacturer, purchase_date, warranty_until, supplier, current_custody_unit_id, current_custodian_user_id, parent_asset_id, notes, created_on';
const ASSET_GROUP_COLUMNS = 'id, code, name_ar, name_en, description_ar, description_en, display_order, is_active';
const CUSTODY_UNIT_COLUMNS = 'id, code, name_ar, name_en, site_id, project_id, department_id, notes, is_active';
const CUSTODY_MEMBER_COLUMNS = 'id, custody_unit_id, user_id, role_code';
const TRANSACTION_COLUMNS = 'id, asset_id, transaction_type, status, from_custodian_user_id, to_custodian_user_id, from_custody_unit_id, to_custody_unit_id, reason, notes, related_maintenance_id, related_inventory_session_id, related_form_id, performed_by, performed_on';
const RESERVATION_COLUMNS = 'id, asset_id, reserved_for_user_id, reserved_for_project_id, purpose, start_date, end_date, status';
const MAINTENANCE_COLUMNS = 'id, asset_id, reference, status, issue_description, reported_by, reported_on, approved_by, approved_on, vendor_text, sent_on, expected_return_date, completed_on, returned_on, closed_on, cost, notes';
const SESSION_COLUMNS = 'id, reference, name_ar, name_en, status, start_date, end_date, notes';
const SESSION_UNIT_COLUMNS = 'id, session_id, custody_unit_id';
const SESSION_MEMBER_COLUMNS = 'id, session_id, user_id';
const SCAN_COLUMNS = 'id, session_id, asset_id, scanned_code, result_status, expected_custody_unit_id, expected_custodian_user_id, notes, scanned_by, scanned_on';

/** loadAssets()'s own bound when a caller does not ask for a narrower page — contract §17: a list screen never loads a whole table. */
const DEFAULT_ASSET_PAGE_SIZE = 200;

/**
 * Maps an RPC's raised SCREAMING_SNAKE_CODE onto a translation key
 * (`assets_err_<code>`), falling back to the shared generic error — same
 * shape as engagementService.js's engagementErrorMessage().
 */
export const assetsErrorMessage = (t, error) => {
  if (!error) return '';
  const code = extractScreamingSnakeCode(error);
  if (code) {
    const key = `assets_err_${code.toLowerCase()}`;
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
const dayKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const shiftDays = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return dayKey(date);
};
// Demo-only stand-in for generate_number() — mirrors the real prefixes
// (NO-{slug}-AS-########, -WO-, -IN-) closely enough to read naturally, but
// is never mistaken for a real allocation (see formsService.js's own
// allocateReferenceNumber demo fallback for the same reasoning).
const demoReference = (prefix) => `NO-DEMO-${prefix}-${String(Date.now()).slice(-8).padStart(8, '0')}`;

// ---------------------------------------------------------------------------
// Local preview store
// ---------------------------------------------------------------------------
const DEMO_KEY = 'bbnovix_assets_demo';

const seedDemo = () => ({
  groups: [
    { id: 'demo-group-it', code: 'IT', name_ar: 'أجهزة تقنية المعلومات', name_en: 'IT Equipment', description_ar: null, description_en: null, display_order: 1, is_active: true },
    { id: 'demo-group-vehicles', code: 'VEH', name_ar: 'مركبات', name_en: 'Vehicles', description_ar: null, description_en: null, display_order: 2, is_active: true },
    { id: 'demo-group-furniture', code: 'FUR', name_ar: 'أثاث مكتبي', name_en: 'Office Furniture', description_ar: null, description_en: null, display_order: 3, is_active: true },
  ],
  custodyUnits: [
    { id: 'demo-unit-hq', code: 'STORE-HQ', name_ar: 'مستودع المقر الرئيسي', name_en: 'Head Office Store', site_id: null, project_id: null, department_id: null, notes: null, is_active: true },
    { id: 'demo-unit-riyadh', code: 'STORE-RUH', name_ar: 'مستودع الرياض', name_en: 'Riyadh Store', site_id: null, project_id: null, department_id: null, notes: null, is_active: true },
  ],
  custodyUnitMembers: [
    { id: 'demo-member-1', custody_unit_id: 'demo-unit-hq', user_id: 'demo-user', role_code: 'Owner' },
    { id: 'demo-member-2', custody_unit_id: 'demo-unit-hq', user_id: 'demo-employee-2', role_code: 'Custodian' },
  ],
  assets: [
    {
      id: 'demo-asset-laptop', group_id: 'demo-group-it', reference: 'NO-DEMO-AS-00000001',
      name_ar: 'حاسب محمول Dell Latitude', name_en: 'Dell Latitude Laptop', status: 'InUse',
      color: 'Black', brand: 'Dell', model: 'Latitude 5440', serial_no: 'SN-DL-0001', imei: null,
      manufacturer: 'Dell', purchase_date: '2025-02-10', warranty_until: '2027-02-10', supplier: 'Dell Saudi',
      current_custody_unit_id: 'demo-unit-hq', current_custodian_user_id: 'demo-user', parent_asset_id: null,
      notes: null, created_on: shiftDays(-40),
    },
    {
      id: 'demo-asset-vehicle', group_id: 'demo-group-vehicles', reference: 'NO-DEMO-AS-00000002',
      name_ar: 'سيارة تويوتا هايلكس', name_en: 'Toyota Hilux', status: 'Available',
      color: 'White', brand: 'Toyota', model: 'Hilux 2024', serial_no: null, imei: null,
      manufacturer: 'Toyota', purchase_date: '2024-11-01', warranty_until: '2027-11-01', supplier: 'Abdul Latif Jameel',
      current_custody_unit_id: 'demo-unit-riyadh', current_custodian_user_id: null, parent_asset_id: null,
      notes: null, created_on: shiftDays(-90),
    },
    {
      id: 'demo-asset-desk', group_id: 'demo-group-furniture', reference: 'NO-DEMO-AS-00000003',
      name_ar: 'مكتب مدير', name_en: 'Manager Desk', status: 'InMaintenance',
      color: 'Brown', brand: null, model: null, serial_no: null, imei: null,
      manufacturer: null, purchase_date: '2023-05-01', warranty_until: null, supplier: null,
      current_custody_unit_id: 'demo-unit-hq', current_custodian_user_id: null, parent_asset_id: null,
      notes: 'أحد الأدراج بحاجة إلى إصلاح', created_on: shiftDays(-300),
    },
  ],
  transactions: [
    {
      id: 'demo-tx-1', asset_id: 'demo-asset-laptop', transaction_type: 'Issue', status: 'Completed',
      from_custodian_user_id: null, to_custodian_user_id: 'demo-user',
      from_custody_unit_id: 'demo-unit-hq', to_custody_unit_id: null,
      reason: 'تسليم للموظف الجديد', notes: null, related_maintenance_id: null,
      related_inventory_session_id: null, related_form_id: null,
      performed_by: 'demo-user', performed_on: shiftDays(-5),
    },
    {
      id: 'demo-tx-2', asset_id: 'demo-asset-vehicle', transaction_type: 'Receive', status: 'Completed',
      from_custodian_user_id: null, to_custodian_user_id: null,
      from_custody_unit_id: null, to_custody_unit_id: 'demo-unit-riyadh',
      reason: 'استلام أولي', notes: null, related_maintenance_id: null,
      related_inventory_session_id: null, related_form_id: null,
      performed_by: 'demo-user', performed_on: shiftDays(-90),
    },
  ],
  reservations: [
    {
      id: 'demo-reservation-1', asset_id: 'demo-asset-vehicle', reserved_for_user_id: 'demo-employee-2',
      reserved_for_project_id: null, purpose: 'زيارة ميدانية', start_date: shiftDays(2), end_date: shiftDays(4),
      status: 'Active',
    },
  ],
  maintenance: [
    {
      id: 'demo-maintenance-1', asset_id: 'demo-asset-desk', reference: 'NO-DEMO-WO-00000001',
      status: 'Approved', issue_description: 'أحد الأدراج مكسور ولا يُغلق بشكل صحيح',
      reported_by: 'demo-user', reported_on: shiftDays(-3), approved_by: 'demo-user', approved_on: shiftDays(-2),
      vendor_text: null, sent_on: null, expected_return_date: null, completed_on: null, returned_on: null,
      closed_on: null, cost: null, notes: null,
    },
  ],
  inventorySessions: [
    {
      id: 'demo-session-1', reference: 'NO-DEMO-IN-00000001', name_ar: 'جرد الربع الأول', name_en: 'Q1 Physical Count',
      status: 'Draft', start_date: shiftDays(1), end_date: shiftDays(3), notes: null,
    },
    {
      id: 'demo-session-2', reference: 'NO-DEMO-IN-00000002', name_ar: 'جرد نهاية العام', name_en: 'Year-End Count',
      status: 'Completed', start_date: shiftDays(-30), end_date: shiftDays(-27), notes: null,
    },
  ],
  inventorySessionUnits: [
    { id: 'demo-session-unit-1', session_id: 'demo-session-1', custody_unit_id: 'demo-unit-hq' },
    { id: 'demo-session-unit-2', session_id: 'demo-session-2', custody_unit_id: 'demo-unit-hq' },
  ],
  inventorySessionMembers: [
    { id: 'demo-session-member-1', session_id: 'demo-session-1', user_id: 'demo-user' },
    { id: 'demo-session-member-2', session_id: 'demo-session-2', user_id: 'demo-user' },
  ],
  inventoryScans: [
    {
      id: 'demo-scan-1', session_id: 'demo-session-2', asset_id: 'demo-asset-laptop', scanned_code: 'SN-DL-0001',
      result_status: 'Found', expected_custody_unit_id: 'demo-unit-hq', expected_custodian_user_id: 'demo-user',
      notes: null, scanned_by: 'demo-user', scanned_on: shiftDays(-29),
    },
    {
      id: 'demo-scan-2', session_id: 'demo-session-2', asset_id: 'demo-asset-desk', scanned_code: null,
      result_status: 'NeedsMaintenance', expected_custody_unit_id: 'demo-unit-hq', expected_custodian_user_id: null,
      notes: 'يحتاج صيانة', scanned_by: 'demo-user', scanned_on: shiftDays(-29),
    },
  ],
});

const readDemo = () => {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    // Merged over the seed so a store written by an older build never leaves
    // a collection undefined (same reasoning as engagementService.js).
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
// Asset Groups
// ---------------------------------------------------------------------------
/**
 * @param {{includeInactive?: boolean}} [opts] `includeInactive` is what lets
 * the admin screen offer a way back for a group someone switched off —
 * without it, deactivating one was a one-way door (release-gate finding).
 */
export async function loadAssetGroups({ includeInactive = false } = {}) {
  if (useLocalData) {
    const rows = readDemo().groups;
    return ok(includeInactive ? rows : rows.filter((row) => row.is_active !== false));
  }
  let query = supabase.from('asset_groups').select(ASSET_GROUP_COLUMNS).order('display_order');
  if (!includeInactive) query = query.eq('is_active', true);
  return runList(() => query);
}

/** @param {{id?, code?, name_ar, name_en?, description_ar?, description_en?, display_order?, is_active?}} group */
export async function saveAssetGroup(group) {
  if (!trimmed(group?.name_ar)) return ko('NAME_AR_REQUIRED');
  const params = {
    p_id: group.id || null,
    p_code: trimmed(group.code),
    p_name_ar: group.name_ar,
    p_name_en: trimmed(group.name_en),
    p_description_ar: trimmed(group.description_ar),
    p_description_en: trimmed(group.description_en),
    p_display_order: Number(group.display_order) || 0,
    p_is_active: group.is_active ?? true,
  };
  if (useLocalData) {
    const state = readDemo();
    const id = group.id || newId();
    const saved = {
      id, code: params.p_code, name_ar: params.p_name_ar, name_en: params.p_name_en,
      description_ar: params.p_description_ar, description_en: params.p_description_en,
      display_order: params.p_display_order, is_active: params.p_is_active,
    };
    state.groups = group.id
      ? state.groups.map((row) => (row.id === id ? saved : row))
      : [...state.groups, saved];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('asset_group_upsert', params);
}

// ---------------------------------------------------------------------------
// Custody Units & Members
// ---------------------------------------------------------------------------
/** @param {{includeInactive?: boolean}} [opts] see loadAssetGroups()'s own doc — same reactivation gap, same fix shape. */
export async function loadCustodyUnits({ includeInactive = false } = {}) {
  if (useLocalData) {
    const rows = readDemo().custodyUnits;
    return ok(includeInactive ? rows : rows.filter((row) => row.is_active !== false));
  }
  let query = supabase.from('asset_custody_units').select(CUSTODY_UNIT_COLUMNS).order('name_ar');
  if (!includeInactive) query = query.eq('is_active', true);
  return runList(() => query);
}

/** @param {{id?, code, name_ar, name_en?, site_id?, project_id?, department_id?, notes?, is_active?}} unit */
export async function saveCustodyUnit(unit) {
  if (!trimmed(unit?.code) || !trimmed(unit?.name_ar)) return ko('REQUIRED_FIELD_MISSING');
  const params = {
    p_id: unit.id || null,
    p_code: unit.code,
    p_name_ar: unit.name_ar,
    p_name_en: trimmed(unit.name_en),
    p_site_id: unit.site_id || null,
    p_project_id: unit.project_id || null,
    p_department_id: unit.department_id || null,
    p_notes: trimmed(unit.notes),
    p_is_active: unit.is_active ?? true,
  };
  if (useLocalData) {
    const state = readDemo();
    const id = unit.id || newId();
    const saved = {
      id, code: params.p_code, name_ar: params.p_name_ar, name_en: params.p_name_en,
      site_id: params.p_site_id, project_id: params.p_project_id, department_id: params.p_department_id,
      notes: params.p_notes, is_active: params.p_is_active,
    };
    state.custodyUnits = unit.id
      ? state.custodyUnits.map((row) => (row.id === id ? saved : row))
      : [...state.custodyUnits, saved];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('asset_custody_unit_upsert', params);
}

export async function loadCustodyUnitMembers(custodyUnitId) {
  if (useLocalData) return ok(readDemo().custodyUnitMembers.filter((row) => row.custody_unit_id === custodyUnitId));
  return runList(() => supabase.from('asset_custody_unit_members').select(CUSTODY_MEMBER_COLUMNS).eq('custody_unit_id', custodyUnitId));
}

/**
 * Replaces a custody unit's whole member roster in one call.
 * @param {Array<{userId: string, roleCode: 'Owner'|'Custodian'|'BackupCustodian'}>} members
 *   Kept camelCase inside the array — this is the RPC's own jsonb contract
 *   (p_members), not a JS naming choice.
 */
export async function setCustodyUnitMembers(custodyUnitId, members) {
  if (useLocalData) {
    const state = readDemo();
    state.custodyUnitMembers = [
      ...state.custodyUnitMembers.filter((row) => row.custody_unit_id !== custodyUnitId),
      ...(members || []).map((member) => ({ id: newId(), custody_unit_id: custodyUnitId, user_id: member.userId, role_code: member.roleCode })),
    ];
    writeDemo(state);
    return ok(null);
  }
  return callRpc('asset_custody_unit_set_members', { p_custody_unit_id: custodyUnitId, p_members: members || [] });
}

// ---------------------------------------------------------------------------
// Assets (list / detail / create / update)
// ---------------------------------------------------------------------------
/**
 * @param {{groupId?, custodyUnitId?, status?, search?, custodianUserId?, parentAssetId?, limit?, offset?}} filters
 * `custodianUserId`/`parentAssetId` exist so "my assets"/parent-child lookups
 * can filter server-side instead of scanning the whole tenant catalogue
 * client-side (idx_assets_custodian/idx_assets_parent back exactly these).
 * Unbounded by default is never allowed — a caller that does not pass its
 * own `limit` still gets DEFAULT_ASSET_PAGE_SIZE, never the whole table.
 */
export async function loadAssets(filters = {}) {
  const limit = Number(filters.limit) > 0 ? Number(filters.limit) : DEFAULT_ASSET_PAGE_SIZE;
  const offset = Number(filters.offset) > 0 ? Number(filters.offset) : 0;
  if (useLocalData) {
    let rows = readDemo().assets;
    if (filters.groupId) rows = rows.filter((row) => row.group_id === filters.groupId);
    if (filters.custodyUnitId) rows = rows.filter((row) => row.current_custody_unit_id === filters.custodyUnitId);
    if (filters.status) rows = rows.filter((row) => row.status === filters.status);
    if (filters.custodianUserId) rows = rows.filter((row) => row.current_custodian_user_id === filters.custodianUserId);
    if (filters.parentAssetId) rows = rows.filter((row) => row.parent_asset_id === filters.parentAssetId);
    if (filters.search) {
      const needle = String(filters.search).trim().toLowerCase();
      rows = rows.filter((row) => `${row.reference} ${row.name_ar} ${row.name_en || ''} ${row.serial_no || ''}`.toLowerCase().includes(needle));
    }
    const sorted = rows.slice().sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)));
    return ok(sorted.slice(offset, offset + limit));
  }
  let query = supabase.from('assets').select(ASSET_COLUMNS).order('created_on', { ascending: false }).range(offset, offset + limit - 1);
  if (filters.groupId) query = query.eq('group_id', filters.groupId);
  if (filters.custodyUnitId) query = query.eq('current_custody_unit_id', filters.custodyUnitId);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.custodianUserId) query = query.eq('current_custodian_user_id', filters.custodianUserId);
  if (filters.parentAssetId) query = query.eq('parent_asset_id', filters.parentAssetId);
  if (filters.search) {
    const pattern = escapeForOrFilter(`%${String(filters.search).trim()}%`);
    query = query.or(`reference.ilike.${pattern},name_ar.ilike.${pattern},name_en.ilike.${pattern},serial_no.ilike.${pattern}`);
  }
  return runList(() => query);
}

export async function loadAsset(id) {
  if (useLocalData) {
    const found = readDemo().assets.find((row) => row.id === id);
    return found ? ok(found) : ko('ASSET_NOT_FOUND');
  }
  return run(() => supabase.from('assets').select(ASSET_COLUMNS).eq('id', id).single());
}

/**
 * Every asset in `ids`, in ONE query — for the handful of screens that
 * already hold a bounded list of ids (e.g. this employee's own pending
 * transfers) and previously fanned out one loadAsset() call per id
 * (release-gate finding). Bounded by the caller's own id list, so it never
 * needs DEFAULT_ASSET_PAGE_SIZE's own truncation.
 */
export async function loadAssetsByIds(ids) {
  const uniqueIds = Array.from(new Set((ids || []).filter(Boolean)));
  if (!uniqueIds.length) return ok([]);
  if (useLocalData) {
    return ok(readDemo().assets.filter((row) => uniqueIds.includes(row.id)));
  }
  return runList(() => supabase.from('assets').select(ASSET_COLUMNS).in('id', uniqueIds));
}

/** @param {{group_id?, name_ar, name_en?, color?, brand?, model?, serial_no?, imei?, manufacturer?, purchase_date?, warranty_until?, supplier?, parent_asset_id?, notes?, initial_custody_unit_id?}} asset */
export async function createAsset(asset) {
  if (!trimmed(asset?.name_ar)) return ko('NAME_AR_REQUIRED');
  const params = {
    p_group_id: asset.group_id || null,
    p_name_ar: asset.name_ar,
    p_name_en: trimmed(asset.name_en),
    p_color: trimmed(asset.color),
    p_brand: trimmed(asset.brand),
    p_model: trimmed(asset.model),
    p_serial_no: trimmed(asset.serial_no),
    p_imei: trimmed(asset.imei),
    p_manufacturer: trimmed(asset.manufacturer),
    p_purchase_date: asset.purchase_date || null,
    p_warranty_until: asset.warranty_until || null,
    p_supplier: trimmed(asset.supplier),
    p_parent_asset_id: asset.parent_asset_id || null,
    p_notes: trimmed(asset.notes),
    p_initial_custody_unit_id: asset.initial_custody_unit_id || null,
  };
  if (useLocalData) {
    const state = readDemo();
    const id = newId();
    const row = {
      id, group_id: params.p_group_id, reference: demoReference('AS'),
      name_ar: params.p_name_ar, name_en: params.p_name_en, status: 'Available',
      color: params.p_color, brand: params.p_brand, model: params.p_model,
      serial_no: params.p_serial_no, imei: params.p_imei, manufacturer: params.p_manufacturer,
      purchase_date: params.p_purchase_date, warranty_until: params.p_warranty_until, supplier: params.p_supplier,
      current_custody_unit_id: params.p_initial_custody_unit_id, current_custodian_user_id: null,
      parent_asset_id: params.p_parent_asset_id, notes: params.p_notes, created_on: nowIso(),
    };
    state.assets = [row, ...state.assets];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('asset_create', params);
}

/** @param {{group_id?, name_ar, name_en?, color?, brand?, model?, serial_no?, imei?, manufacturer?, purchase_date?, warranty_until?, supplier?, parent_asset_id?, notes?}} asset */
export async function updateAsset(id, asset) {
  if (!trimmed(asset?.name_ar)) return ko('NAME_AR_REQUIRED');
  const params = {
    p_id: id,
    p_group_id: asset.group_id || null,
    p_name_ar: asset.name_ar,
    p_name_en: trimmed(asset.name_en),
    p_color: trimmed(asset.color),
    p_brand: trimmed(asset.brand),
    p_model: trimmed(asset.model),
    p_serial_no: trimmed(asset.serial_no),
    p_imei: trimmed(asset.imei),
    p_manufacturer: trimmed(asset.manufacturer),
    p_purchase_date: asset.purchase_date || null,
    p_warranty_until: asset.warranty_until || null,
    p_supplier: trimmed(asset.supplier),
    p_parent_asset_id: asset.parent_asset_id || null,
    p_notes: trimmed(asset.notes),
  };
  if (useLocalData) {
    const state = readDemo();
    state.assets = state.assets.map((row) => (row.id === id ? {
      ...row,
      group_id: params.p_group_id, name_ar: params.p_name_ar, name_en: params.p_name_en,
      color: params.p_color, brand: params.p_brand, model: params.p_model, serial_no: params.p_serial_no,
      imei: params.p_imei, manufacturer: params.p_manufacturer, purchase_date: params.p_purchase_date,
      warranty_until: params.p_warranty_until, supplier: params.p_supplier,
      parent_asset_id: params.p_parent_asset_id, notes: params.p_notes,
    } : row));
    writeDemo(state);
    return ok(null);
  }
  return callRpc('asset_update', params);
}

// ---------------------------------------------------------------------------
// Custody transactions (receive/issue/transfer/return/lost/found) + transfer
// accept/reject
// ---------------------------------------------------------------------------
export async function loadAssetTransactions(assetId) {
  if (useLocalData) {
    return ok(readDemo().transactions.filter((row) => row.asset_id === assetId)
      .slice().sort((a, b) => String(b.performed_on).localeCompare(String(a.performed_on))));
  }
  return runList(() => supabase.from('asset_transactions').select(TRANSACTION_COLUMNS).eq('asset_id', assetId).order('performed_on', { ascending: false }));
}

/**
 * One query for every asset's pending-my-acceptance Transfer, instead of the
 * asset-by-asset fan-out the module previously had no alternative to
 * (closing-audit finding). asset_transactions' own RLS already lets a caller
 * read rows where they are to_custodian_user_id, so this is a plain filtered
 * select, no new RPC needed — see migration 202608060055's added
 * idx_asset_transactions_pending_recipient for the index backing it.
 */
export async function loadPendingTransfersForMe(userId) {
  if (!userId) return ok([]);
  if (useLocalData) {
    return ok(readDemo().transactions.filter((row) => row.transaction_type === 'Transfer' && row.status === 'PendingAcceptance' && row.to_custodian_user_id === userId));
  }
  return runList(() => supabase.from('asset_transactions').select(TRANSACTION_COLUMNS)
    .eq('to_custodian_user_id', userId).eq('transaction_type', 'Transfer').eq('status', 'PendingAcceptance')
    .order('performed_on', { ascending: false }));
}

/**
 * The most recent transaction per asset, for every id in assetIds, in ONE
 * query instead of one-per-asset (closing-audit finding — Reports' "Last
 * Movement" column). asset_last_movement_for_ids() does the latest-per-asset
 * reduction server-side (DISTINCT ON) so only one row per asset ever comes
 * back over the wire, not that asset's whole transaction history.
 */
export async function loadLastMovementForAssets(assetIds) {
  const ids = Array.from(new Set((assetIds || []).filter(Boolean)));
  if (!ids.length) return ok({});
  if (useLocalData) {
    const rows = readDemo().transactions.filter((row) => ids.includes(row.asset_id))
      .slice().sort((a, b) => String(b.performed_on).localeCompare(String(a.performed_on)));
    const byAsset = latestPerAssetId(rows);
    return ok(Object.fromEntries(Array.from(byAsset.entries())
      .map(([assetId, row]) => [assetId, { performedOn: row.performed_on, transactionType: row.transaction_type }])));
  }
  const { data, error } = await run(() => supabase.rpc('asset_last_movement_for_ids', { p_asset_ids: ids }));
  if (error) return { data: null, error };
  return ok(Object.fromEntries((data || [])
    .map((row) => [row.asset_id, { performedOn: row.performed_on, transactionType: row.transaction_type }])));
}

/**
 * The one entry point behind every custody movement. asset_transaction_create()
 * itself decides Completed vs PendingAcceptance — a 'Transfer' always waits
 * for acceptAssetTransfer()/rejectAssetTransfer() below; every other type
 * completes immediately. transactionType is one of 'Receive'|'Issue'|
 * 'Transfer'|'Return'|'Lost'|'Found'|'Reserve'|'Release';
 * 'Dispose'/'MaintenanceOut'/'MaintenanceReturn' are RPC/trigger-only and are
 * never passed here.
 */
export async function createAssetTransaction(assetId, transactionType, { toCustodianUserId = null, toCustodyUnitId = null, reason = null } = {}) {
  const params = {
    p_asset_id: assetId,
    p_transaction_type: transactionType,
    p_to_custodian_user_id: toCustodianUserId,
    p_to_custody_unit_id: toCustodyUnitId,
    p_reason: reason,
  };
  if (useLocalData) {
    const state = readDemo();
    const asset = state.assets.find((row) => row.id === assetId);
    if (!asset) return ko('ASSET_NOT_FOUND');
    const id = newId();
    // Mirrors asset_transaction_create()'s own branching exactly (see the
    // migration): only a Transfer WITH a target person waits for accept —
    // a unit-to-unit Transfer (no toCustodianUserId) completes immediately,
    // same as Receive/Issue/Return/Lost/Found. Reserve/Release are
    // administrative log rows only and never touch the snapshot.
    const pending = transactionType === 'Transfer' && Boolean(toCustodianUserId);
    const tx = {
      id, asset_id: assetId, transaction_type: transactionType, status: pending ? 'PendingAcceptance' : 'Completed',
      from_custodian_user_id: asset.current_custodian_user_id,
      to_custodian_user_id: transactionType === 'Issue' || pending ? toCustodianUserId : null,
      from_custody_unit_id: asset.current_custody_unit_id, to_custody_unit_id: toCustodyUnitId,
      reason, notes: null, related_maintenance_id: null, related_inventory_session_id: null, related_form_id: null,
      performed_by: 'demo-user', performed_on: nowIso(),
    };
    state.transactions = [tx, ...state.transactions];
    if (!pending && transactionType !== 'Reserve' && transactionType !== 'Release') {
      state.assets = state.assets.map((row) => (row.id === assetId ? {
        ...row,
        current_custodian_user_id: transactionType === 'Issue' ? toCustodianUserId
          : (transactionType === 'Receive' || transactionType === 'Return' || transactionType === 'Transfer') ? null
            : row.current_custodian_user_id,
        current_custody_unit_id: toCustodyUnitId ?? row.current_custody_unit_id,
        status: transactionType === 'Receive' ? 'Available'
          : transactionType === 'Issue' ? 'InUse'
            : transactionType === 'Return' ? 'Available'
              : transactionType === 'Lost' ? 'Lost'
                : transactionType === 'Found' ? (row.current_custodian_user_id ? 'InUse' : 'Available')
                  : transactionType === 'Transfer' ? 'Available'
                    : row.status,
      } : row));
    }
    writeDemo(state);
    return ok(id);
  }
  return callRpc('asset_transaction_create', params);
}

export const receiveAsset = (assetId, opts) => createAssetTransaction(assetId, 'Receive', opts);
export const issueAsset = (assetId, opts) => createAssetTransaction(assetId, 'Issue', opts);
export const transferAsset = (assetId, opts) => createAssetTransaction(assetId, 'Transfer', opts);
export const returnAsset = (assetId, opts) => createAssetTransaction(assetId, 'Return', opts);
export const reportAssetLost = (assetId, reason) => createAssetTransaction(assetId, 'Lost', { reason });
export const reportAssetFound = (assetId, opts) => createAssetTransaction(assetId, 'Found', opts);

export async function acceptAssetTransfer(transactionId) {
  if (useLocalData) {
    const state = readDemo();
    const tx = state.transactions.find((row) => row.id === transactionId);
    if (!tx) return ko('TRANSACTION_NOT_FOUND');
    tx.status = 'Completed';
    state.assets = state.assets.map((row) => (row.id === tx.asset_id ? {
      ...row,
      current_custodian_user_id: tx.to_custodian_user_id ?? row.current_custodian_user_id,
      current_custody_unit_id: tx.to_custody_unit_id ?? row.current_custody_unit_id,
    } : row));
    writeDemo(state);
    return ok(null);
  }
  return callRpc('asset_transfer_accept', { p_transaction_id: transactionId });
}

export async function rejectAssetTransfer(transactionId) {
  if (useLocalData) {
    const state = readDemo();
    const tx = state.transactions.find((row) => row.id === transactionId);
    if (!tx) return ko('TRANSACTION_NOT_FOUND');
    tx.status = 'Rejected';
    writeDemo(state);
    return ok(null);
  }
  return callRpc('asset_transfer_reject', { p_transaction_id: transactionId });
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------
export async function loadAssetReservations(assetId) {
  if (useLocalData) {
    return ok(readDemo().reservations.filter((row) => row.asset_id === assetId)
      .slice().sort((a, b) => String(b.start_date).localeCompare(String(a.start_date))));
  }
  return runList(() => supabase.from('asset_reservations').select(RESERVATION_COLUMNS).eq('asset_id', assetId).order('start_date', { ascending: false }));
}

export async function reserveAsset(assetId, { startDate, endDate, reservedForUserId = null, reservedForProjectId = null, purpose = null } = {}) {
  const params = {
    p_asset_id: assetId, p_start_date: startDate, p_end_date: endDate,
    p_reserved_for_user_id: reservedForUserId, p_reserved_for_project_id: reservedForProjectId, p_purpose: purpose,
  };
  if (useLocalData) {
    const state = readDemo();
    const id = newId();
    state.reservations = [{
      id, asset_id: assetId, reserved_for_user_id: reservedForUserId, reserved_for_project_id: reservedForProjectId,
      purpose, start_date: startDate, end_date: endDate, status: 'Active',
    }, ...state.reservations];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('asset_reserve', params);
}

export async function releaseAssetReservation(reservationId) {
  if (useLocalData) {
    const state = readDemo();
    state.reservations = state.reservations.map((row) => (row.id === reservationId ? { ...row, status: 'Released' } : row));
    writeDemo(state);
    return ok(null);
  }
  return callRpc('asset_release_reservation', { p_reservation_id: reservationId });
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------
export async function loadAssetMaintenance(assetId) {
  if (useLocalData) {
    return ok(readDemo().maintenance.filter((row) => row.asset_id === assetId)
      .slice().sort((a, b) => String(b.reported_on).localeCompare(String(a.reported_on))));
  }
  return runList(() => supabase.from('asset_maintenance').select(MAINTENANCE_COLUMNS).eq('asset_id', assetId).order('reported_on', { ascending: false }));
}

/** Any authenticated tenant member may report an issue — no permission gate, unlike every other write below. */
export async function reportAssetMaintenance(assetId, issueDescription) {
  if (useLocalData) {
    const state = readDemo();
    const id = newId();
    state.maintenance = [{
      id, asset_id: assetId, reference: demoReference('WO'), status: 'Reported',
      issue_description: issueDescription, reported_by: 'demo-user', reported_on: nowIso(),
      approved_by: null, approved_on: null, vendor_text: null, sent_on: null, expected_return_date: null,
      completed_on: null, returned_on: null, closed_on: null, cost: null, notes: null,
    }, ...state.maintenance];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('asset_maintenance_report', { p_asset_id: assetId, p_issue_description: issueDescription });
}

export async function approveAssetMaintenance(id) {
  if (useLocalData) {
    const state = readDemo();
    state.maintenance = state.maintenance.map((row) => (row.id === id
      ? { ...row, status: 'Approved', approved_by: 'demo-user', approved_on: nowIso() }
      : row));
    writeDemo(state);
    return ok(null);
  }
  return callRpc('asset_maintenance_approve', { p_id: id });
}

/** @param {'Sent'|'UnderMaintenance'|'Completed'|'Returned'|'Closed'|'Rejected'} newStatus */
export async function advanceAssetMaintenance(id, newStatus, { vendorText = null, expectedReturnDate = null, cost = null, notes = null } = {}) {
  const params = {
    p_id: id, p_new_status: newStatus, p_vendor_text: vendorText,
    p_expected_return_date: expectedReturnDate, p_cost: cost, p_notes: notes,
  };
  if (useLocalData) {
    const stampField = { Sent: 'sent_on', Completed: 'completed_on', Returned: 'returned_on', Closed: 'closed_on' }[newStatus];
    const state = readDemo();
    state.maintenance = state.maintenance.map((row) => (row.id === id ? {
      ...row, status: newStatus,
      vendor_text: vendorText ?? row.vendor_text, expected_return_date: expectedReturnDate ?? row.expected_return_date,
      cost: cost ?? row.cost, notes: notes ?? row.notes,
      ...(stampField ? { [stampField]: nowIso() } : {}),
    } : row));
    writeDemo(state);
    return ok(null);
  }
  return callRpc('asset_maintenance_advance', params);
}

// ---------------------------------------------------------------------------
// Disposal — hands off to the existing Approval workflow
// ---------------------------------------------------------------------------
/**
 * Plain read of an already-scoped table — same "authenticated read
 * organization" style as approvalService.js's loadDepartmentsForFilter() —
 * resolving the disposal template's id from its fixed code, the same way
 * FormsPortal.jsx's own resolveTemplateId() resolves one from its
 * already-loaded template list.
 */
export async function loadAssetDisposalTemplateId() {
  if (useLocalData) return ok('demo-template-asset-disposal');
  const { data, error } = await run(() => supabase
    .from('templates')
    .select('id')
    .eq('code', ASSET_DISPOSAL_TEMPLATE_CODE)
    .maybeSingle());
  if (error) return { data: null, error };
  return ok(data?.id || null);
}

/**
 * Opens a Draft disposal request form and returns its forms.id. The caller
 * then opens ApprovalChain.jsx's SendApprovalModal with that formId and the
 * templateId from loadAssetDisposalTemplateId() above — the same
 * approvalService.js "send for approval" flow every other module's request
 * screen already uses; this service does not duplicate that flow itself.
 */
export async function requestAssetDisposal(assetId, reason) {
  if (useLocalData) return ok(newId());
  return callRpc('asset_dispose_request', { p_asset_id: assetId, p_reason: reason });
}

// ---------------------------------------------------------------------------
// Timeline — "the most important screen" (the migration's own words)
// ---------------------------------------------------------------------------
export async function loadAssetTimeline(assetId) {
  if (useLocalData) {
    const asset = readDemo().assets.find((row) => row.id === assetId);
    return ok([
      {
        id: 'demo-timeline-1', event_code: 'RECEIVED', title_ar: 'تم استلام الأصل', title_en: 'Asset received',
        actor_id: 'demo-user', actor_name: 'أحمد محمد',
        payload: { toCustodyUnitId: asset?.current_custody_unit_id || 'demo-unit-hq', toCustodyUnitName: 'مستودع المقر الرئيسي' },
        occurred_on: shiftDays(-10),
      },
      {
        id: 'demo-timeline-2', event_code: 'ISSUED', title_ar: 'تم تسليم الأصل', title_en: 'Asset issued',
        actor_id: 'demo-user', actor_name: 'أحمد محمد',
        payload: { toUserId: asset?.current_custodian_user_id || 'demo-user', toUserName: 'أحمد محمد' },
        occurred_on: shiftDays(-2),
      },
    ]);
  }
  return callRpcList('asset_timeline', { p_asset_id: assetId });
}

// ---------------------------------------------------------------------------
// Inventory (counting) sessions & scans
// ---------------------------------------------------------------------------
export async function loadInventorySessions() {
  if (useLocalData) {
    return ok(readDemo().inventorySessions.slice()
      .sort((a, b) => String(b.start_date || '').localeCompare(String(a.start_date || ''))));
  }
  return runList(() => supabase.from('asset_inventory_sessions').select(SESSION_COLUMNS).order('start_date', { ascending: false, nullsFirst: false }));
}

export async function loadInventorySessionScans(sessionId) {
  if (useLocalData) {
    return ok(readDemo().inventoryScans.filter((row) => row.session_id === sessionId)
      .slice().sort((a, b) => String(b.scanned_on).localeCompare(String(a.scanned_on))));
  }
  return runList(() => supabase.from('asset_inventory_scans').select(SCAN_COLUMNS).eq('session_id', sessionId).order('scanned_on', { ascending: false }));
}

/**
 * The session row plus its custody-unit/member scope and scans so far — one
 * bundle for the session detail screen, same Promise.all shape as
 * formsService.js's loadFormWorkspace().
 */
export async function loadInventorySessionDetail(sessionId) {
  if (useLocalData) {
    const state = readDemo();
    const session = state.inventorySessions.find((row) => row.id === sessionId);
    if (!session) return ko('SESSION_NOT_FOUND');
    return ok({
      session,
      units: state.inventorySessionUnits.filter((row) => row.session_id === sessionId),
      members: state.inventorySessionMembers.filter((row) => row.session_id === sessionId),
      scans: state.inventoryScans.filter((row) => row.session_id === sessionId),
    });
  }
  if (!supabase) return ko('SERVICE_NOT_CONFIGURED');
  const [session, units, members, scans] = await Promise.all([
    supabase.from('asset_inventory_sessions').select(SESSION_COLUMNS).eq('id', sessionId).single(),
    supabase.from('asset_inventory_session_units').select(SESSION_UNIT_COLUMNS).eq('session_id', sessionId),
    supabase.from('asset_inventory_session_members').select(SESSION_MEMBER_COLUMNS).eq('session_id', sessionId),
    supabase.from('asset_inventory_scans').select(SCAN_COLUMNS).eq('session_id', sessionId).order('scanned_on', { ascending: false }),
  ]);
  const failed = [session, units, members, scans].find((result) => result.error);
  if (failed) return ko(failed.error);
  return ok({
    session: session.data,
    units: units.data || [],
    members: members.data || [],
    scans: scans.data || [],
  });
}

/** @param {{name_ar, name_en?, start_date?, end_date?, notes?, custody_unit_ids?: string[], member_user_ids?: string[]}} sessionInput */
export async function createInventorySession(sessionInput) {
  if (!trimmed(sessionInput?.name_ar)) return ko('NAME_AR_REQUIRED');
  const params = {
    p_name_ar: sessionInput.name_ar,
    p_name_en: trimmed(sessionInput.name_en),
    p_start_date: sessionInput.start_date || null,
    p_end_date: sessionInput.end_date || null,
    p_notes: trimmed(sessionInput.notes),
    p_custody_unit_ids: sessionInput.custody_unit_ids || [],
    p_member_user_ids: sessionInput.member_user_ids || [],
  };
  if (useLocalData) {
    const state = readDemo();
    const id = newId();
    state.inventorySessions = [{
      id, reference: demoReference('IN'), name_ar: params.p_name_ar, name_en: params.p_name_en, status: 'Draft',
      start_date: params.p_start_date, end_date: params.p_end_date, notes: params.p_notes,
    }, ...state.inventorySessions];
    state.inventorySessionUnits = [
      ...state.inventorySessionUnits,
      ...params.p_custody_unit_ids.map((custodyUnitId) => ({ id: newId(), session_id: id, custody_unit_id: custodyUnitId })),
    ];
    state.inventorySessionMembers = [
      ...state.inventorySessionMembers,
      ...params.p_member_user_ids.map((userId) => ({ id: newId(), session_id: id, user_id: userId })),
    ];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('asset_inventory_session_create', params);
}

export async function startInventorySession(id) {
  if (useLocalData) {
    const state = readDemo();
    state.inventorySessions = state.inventorySessions.map((row) => (row.id === id ? { ...row, status: 'InProgress' } : row));
    writeDemo(state);
    return ok(null);
  }
  return callRpc('asset_inventory_session_start', { p_id: id });
}

/**
 * Records one scan result. resultStatus is one of INVENTORY_SCAN_RESULTS;
 * 'Missing' is system-generated only (completeInventorySession()'s own
 * auto-generation pass) — the RPC rejects a manual 'Missing' scan with
 * MISSING_IS_SYSTEM_GENERATED, and the local-preview branch mirrors that
 * same rejection rather than silently accepting it.
 */
export async function recordInventoryScan(sessionId, resultStatus, { scannedCode = null, assetId = null, notes = null } = {}) {
  const params = {
    p_session_id: sessionId, p_result_status: resultStatus, p_scanned_code: scannedCode,
    p_asset_id: assetId, p_notes: notes,
  };
  if (useLocalData) {
    if (resultStatus === 'Missing') return ko('MISSING_IS_SYSTEM_GENERATED');
    const state = readDemo();
    const id = newId();
    state.inventoryScans = [{
      id, session_id: sessionId, asset_id: assetId, scanned_code: scannedCode, result_status: resultStatus,
      expected_custody_unit_id: null, expected_custodian_user_id: null, notes, scanned_by: 'demo-user', scanned_on: nowIso(),
    }, ...state.inventoryScans];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('asset_inventory_scan', params);
}

export async function completeInventorySession(id) {
  if (useLocalData) {
    const state = readDemo();
    state.inventorySessions = state.inventorySessions.map((row) => (row.id === id ? { ...row, status: 'Completed' } : row));
    writeDemo(state);
    return ok(null);
  }
  return callRpc('asset_inventory_session_complete', { p_id: id });
}

// ---------------------------------------------------------------------------
// Attachments — wider-audience wrapper over the generic Attachment Framework
// (Assets.View OR the asset's current custodian OR Assets.Manage), exactly
// the reasoning approvalService.js's formAttachmentList() documents for
// forms. asset_attachment_list() returns the same row shape as
// attachment_list() minus `url`; resolved here the same one-getUrl-call-
// per-row way (parallel, not sequential), kept identical to
// formAttachmentList() rather than "improved" here alone.
// ---------------------------------------------------------------------------
export async function assetAttachmentList(assetId) {
  if (useLocalData) return ok([]);
  const { data, error } = await callRpc('asset_attachment_list', { p_asset_id: assetId });
  if (error) return { data: null, error };

  const rows = Array.isArray(data) ? data : [];
  const resolved = await Promise.all(rows.map(async (row) => {
    const provider = await getStorageProvider(row.layer, { bucket: row.bucket || undefined });
    const { data: urlData } = await provider.getUrl(row.path, { expiresIn: 3600 });
    return { ...row, url: urlData?.url || '' };
  }));
  return ok(resolved);
}

// assetAttachmentList() reads by asset id alone; this adapter just ignores
// the entityType AttachmentsPanel always passes — same shape as
// approvalService.js's own listFormAttachments export, so AttachmentsPanel's
// listFn prop accepts either interchangeably.
export const listAssetAttachments = (_entityType, assetId) => assetAttachmentList(assetId);
