// Operations — field-work tracking. A manager creates an "Operation" (a work
// scope: school maintenance, security patrols, hospital cleaning...), assigns
// a team, and any team member logs execution records (what was done, when,
// completion %, headcount, photos, attachments, notes) against it. No Work
// Order engine, no stages, no approval chain — a flat, append-only log per
// operation, exactly per this module's own explicit design decision.
//
// Backing objects (migration 202608070057_operations.sql):
//   Tables: public.operations, public.operations_team_members,
//           public.operations_execution_logs, public.operations_checklist_items,
//           public.operations_templates, public.operations_template_checklist_items
//   RPCs:   operations_upsert, operations_set_status, operations_team_set_members,
//           operations_checklist_item_upsert, operations_checklist_item_remove,
//           operations_checklist_item_toggle, operations_can_write,
//           operations_execution_log_create, operations_execution_logs_list,
//           operations_execution_log_attachments_list, operations_timeline,
//           operations_templates_upsert, operations_template_checklist_item_upsert,
//           operations_template_checklist_item_remove, operations_create_from_template,
//           operations_dashboard_summary
//
// Module code: 'OPERATIONS' (useTenant().hasModule('OPERATIONS')). Permission
// codes: Operations.Manage, Operations.Execute, Operations.View — RLS/RPCs
// already enforce these server-side, including the "any assigned team member
// sees only the operations they're actually on" rule (a real PERMISSIVE RLS
// policy, not just an RPC-side check — see the migration's own §8/§9).
//
// Every function resolves with { data, error } and never throws — same
// contract as safetyService.js/assetsService.js. In local preview
// (useLocalData) the same API is served from a localStorage mirror.
//
// Linked Records (asset/employee/form on an execution log) are each a real
// nullable FK column, not a generic entity_type/entity_id pair — this module
// never introduces a polymorphic link shape (see the migration's own header).
// Photo/file attachments on an execution log use TWO distinct entity_types,
// 'OperationExecutionPhoto' and 'OperationExecutionFile' (public.attachments
// has no stored "area"/"kind" column to distinguish them any other way).

import { supabase, useLocalData } from '../lib/supabaseClient';
import { getStorageProvider } from '../lib/storage';
import { extractScreamingSnakeCode, makeAsError } from './serviceEnvelope';

export const OPERATION_STATUSES = ['Draft', 'Active', 'OnHold', 'Completed', 'Cancelled'];
export const EXECUTION_PHOTO_ENTITY_TYPE = 'OperationExecutionPhoto';
export const EXECUTION_FILE_ENTITY_TYPE = 'OperationExecutionFile';

const asError = makeAsError('OPERATIONS_REQUEST_FAILED');
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

export const operationsErrorMessage = (t, error) => {
  if (!error) return '';
  const code = extractScreamingSnakeCode(error);
  if (code) {
    const key = `operations_err_${code.toLowerCase()}`;
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

const OPERATION_COLUMNS = 'id, number, name_ar, name_en, description_ar, description_en, customer_name, site_id, start_date, end_date, status, created_on';
const TEAM_MEMBER_COLUMNS = 'id, operation_id, user_id';
const CHECKLIST_ITEM_COLUMNS = 'id, operation_id, title_ar, title_en, display_order, is_done, done_by, done_on';
const TEMPLATE_COLUMNS = 'id, name_ar, name_en, description_ar, description_en, customer_name, site_id, is_active';
const TEMPLATE_CHECKLIST_ITEM_COLUMNS = 'id, template_id, title_ar, title_en, display_order';

const DEFAULT_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Local preview store
// ---------------------------------------------------------------------------
const DEMO_KEY = 'bbnovix_operations_demo';

const seedDemo = () => ({
  operations: [
    {
      id: 'demo-op-1', number: 'NO-DEMO-OP-00000001', name_ar: 'صيانة مدارس الرياض', name_en: 'Riyadh Schools Maintenance',
      description_ar: null, description_en: null, customer_name: 'وزارة التعليم', site_id: null,
      start_date: nowIso().slice(0, 10), end_date: null, status: 'Active', created_on: nowIso(),
    },
  ],
  teamMembers: [
    { id: 'demo-member-1', operation_id: 'demo-op-1', user_id: 'demo-user' },
  ],
  executionLogs: [],
  checklistItems: [
    { id: 'demo-check-1', operation_id: 'demo-op-1', title_ar: 'تم الوصول', title_en: 'Arrived on site', display_order: 1, is_done: false, done_by: null, done_on: null },
    { id: 'demo-check-2', operation_id: 'demo-op-1', title_ar: 'تم تصوير قبل', title_en: 'Before photo taken', display_order: 2, is_done: false, done_by: null, done_on: null },
  ],
  templates: [],
  templateChecklistItems: [],
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
// Operations (header)
// ---------------------------------------------------------------------------
/** @param {{status?, limit?, offset?}} filters */
export async function loadOperations(filters = {}) {
  const limit = Number(filters.limit) > 0 ? Number(filters.limit) : DEFAULT_PAGE_SIZE;
  const offset = Number(filters.offset) > 0 ? Number(filters.offset) : 0;
  if (useLocalData) {
    let rows = readDemo().operations;
    if (filters.status) rows = rows.filter((row) => row.status === filters.status);
    return ok(rows.slice(offset, offset + limit));
  }
  let query = supabase.from('operations').select(OPERATION_COLUMNS).order('created_on', { ascending: false }).range(offset, offset + limit - 1);
  if (filters.status) query = query.eq('status', filters.status);
  return runList(() => query);
}

export async function loadOperation(id) {
  if (useLocalData) {
    const found = readDemo().operations.find((row) => row.id === id);
    return found ? ok(found) : ko('OPERATION_NOT_FOUND');
  }
  return run(() => supabase.from('operations').select(OPERATION_COLUMNS).eq('id', id).single());
}

/** @param {{id?, name_ar, name_en?, description_ar?, description_en?, customer_name?, site_id?, start_date, end_date?}} operation */
export async function saveOperation(operation) {
  if (!trimmed(operation?.name_ar)) return ko('NAME_AR_REQUIRED');
  if (!operation?.start_date) return ko('START_DATE_REQUIRED');
  const params = {
    p_id: operation.id || null,
    p_name_ar: operation.name_ar,
    p_name_en: trimmed(operation.name_en),
    p_description_ar: trimmed(operation.description_ar),
    p_description_en: trimmed(operation.description_en),
    p_customer_name: trimmed(operation.customer_name),
    p_site_id: operation.site_id || null,
    p_start_date: operation.start_date,
    p_end_date: operation.end_date || null,
  };
  if (useLocalData) {
    const state = readDemo();
    const id = operation.id || newId();
    const saved = {
      id, number: operation.id ? state.operations.find((row) => row.id === id)?.number : `NO-DEMO-OP-${String(Date.now()).slice(-8)}`,
      name_ar: params.p_name_ar, name_en: params.p_name_en, description_ar: params.p_description_ar,
      description_en: params.p_description_en, customer_name: params.p_customer_name, site_id: params.p_site_id,
      start_date: params.p_start_date, end_date: params.p_end_date,
      status: operation.id ? state.operations.find((row) => row.id === id)?.status : 'Draft',
      created_on: operation.id ? state.operations.find((row) => row.id === id)?.created_on : nowIso(),
    };
    state.operations = operation.id
      ? state.operations.map((row) => (row.id === id ? saved : row))
      : [...state.operations, saved];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('operations_upsert', params);
}

/** @param {'Draft'|'Active'|'OnHold'|'Completed'|'Cancelled'} status */
export async function setOperationStatus(operationId, status) {
  if (useLocalData) {
    const state = readDemo();
    state.operations = state.operations.map((row) => (row.id === operationId ? { ...row, status } : row));
    writeDemo(state);
    return ok(null);
  }
  return callRpc('operations_set_status', { p_operation_id: operationId, p_status: status });
}

// ---------------------------------------------------------------------------
// Write-access predicate — the Portal's own gate. loadOperations()/RLS admit
// a caller into "My Operations" via any of THREE separate reasons
// (Operations.View, Operations.Manage, or actual team membership — the
// migration's own "members read operations" policy), but only two of those
// three can actually write: Operations.Manage, or Operations.Execute PLUS
// real team membership (operations_checklist_item_toggle()/operations_
// execution_log_create()'s own v_authorized check). Without this, a plain
// View holder or a team member who never received Operations.Execute would
// see live checklist checkboxes and an Add Execution Log form that
// unconditionally fail PERMISSION_DENIED. Only the server can evaluate
// has_permission(), so this predicate is asked once per opened operation
// (OperationsPortal.jsx's own OperationDetail mount effect) rather than
// guessed at client-side. Demo/local preview has no permission model at all
// (every demo RPC below just succeeds), so it always reports true, same as
// demoUser's own PLATFORM_ADMIN role_code in AuthContext.jsx would resolve
// server-side.
export async function canWriteOperation(operationId) {
  if (useLocalData) return ok(true);
  return run(() => supabase.rpc('operations_can_write', { p_operation_id: operationId }));
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------
export async function loadTeamMembers(operationId) {
  if (!operationId) return ok([]);
  if (useLocalData) return ok(readDemo().teamMembers.filter((row) => row.operation_id === operationId));
  return runList(() => supabase.from('operations_team_members').select(TEAM_MEMBER_COLUMNS).eq('operation_id', operationId));
}

/** @param {string} operationId @param {string[]} userIds full-replace, mirrors asset_custody_unit_set_members()'s own shape. */
export async function setTeamMembers(operationId, userIds) {
  if (useLocalData) {
    const state = readDemo();
    state.teamMembers = [
      ...state.teamMembers.filter((row) => row.operation_id !== operationId),
      ...(userIds || []).map((userId) => ({ id: newId(), operation_id: operationId, user_id: userId })),
    ];
    writeDemo(state);
    return ok(null);
  }
  return callRpc('operations_team_set_members', { p_operation_id: operationId, p_user_ids: userIds || [] });
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------
export async function loadChecklistItems(operationId) {
  if (!operationId) return ok([]);
  if (useLocalData) return ok(readDemo().checklistItems.filter((row) => row.operation_id === operationId));
  return runList(() => supabase.from('operations_checklist_items').select(CHECKLIST_ITEM_COLUMNS).eq('operation_id', operationId).order('display_order'));
}

/** @param {{id?, operation_id, title_ar, title_en?, display_order?}} item */
export async function saveChecklistItem(item) {
  if (!trimmed(item?.title_ar)) return ko('TITLE_AR_REQUIRED');
  const params = {
    p_id: item.id || null, p_operation_id: item.operation_id, p_title_ar: item.title_ar,
    p_title_en: trimmed(item.title_en), p_display_order: Number(item.display_order) || 0,
  };
  if (useLocalData) {
    const state = readDemo();
    const id = item.id || newId();
    const saved = {
      id, operation_id: params.p_operation_id, title_ar: params.p_title_ar, title_en: params.p_title_en,
      display_order: params.p_display_order, is_done: false, done_by: null, done_on: null,
    };
    state.checklistItems = item.id
      ? state.checklistItems.map((row) => (row.id === id ? { ...row, ...saved } : row))
      : [...state.checklistItems, saved];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('operations_checklist_item_upsert', params);
}

export async function removeChecklistItem(id) {
  if (useLocalData) {
    const state = readDemo();
    state.checklistItems = state.checklistItems.filter((row) => row.id !== id);
    writeDemo(state);
    return ok(null);
  }
  return callRpc('operations_checklist_item_remove', { p_id: id });
}

export async function toggleChecklistItem(id, isDone) {
  if (useLocalData) {
    const state = readDemo();
    state.checklistItems = state.checklistItems.map((row) => (row.id === id
      ? { ...row, is_done: isDone, done_by: isDone ? 'demo-user' : null, done_on: isDone ? nowIso() : null }
      : row));
    writeDemo(state);
    return ok(null);
  }
  return callRpc('operations_checklist_item_toggle', { p_id: id, p_is_done: isDone });
}

// ---------------------------------------------------------------------------
// Execution log — the core write
// ---------------------------------------------------------------------------
/** @param {{operationId, logDate, startTime?, endTime?, description, completionPercent?, headcount?, locationText?, siteId?, assetId?, employeeId?, formId?, customerName?, notes?}} entry */
export async function createExecutionLog(entry) {
  if (!entry?.operationId) return ko('OPERATION_ID_REQUIRED');
  if (!trimmed(entry?.description)) return ko('DESCRIPTION_REQUIRED');
  const params = {
    p_operation_id: entry.operationId, p_log_date: entry.logDate || nowIso().slice(0, 10),
    p_start_time: entry.startTime || null, p_end_time: entry.endTime || null,
    p_description: entry.description, p_completion_percent: entry.completionPercent ?? null,
    p_headcount: entry.headcount ?? null, p_location_text: trimmed(entry.locationText),
    p_site_id: entry.siteId || null, p_asset_id: entry.assetId || null, p_employee_id: entry.employeeId || null,
    p_form_id: entry.formId || null, p_customer_name: trimmed(entry.customerName), p_notes: trimmed(entry.notes),
  };
  if (useLocalData) {
    const state = readDemo();
    const id = newId();
    state.executionLogs = [...state.executionLogs, {
      id, operation_id: params.p_operation_id, log_date: params.p_log_date, start_time: params.p_start_time,
      end_time: params.p_end_time, description: params.p_description, completion_percent: params.p_completion_percent,
      headcount: params.p_headcount, location_text: params.p_location_text, site_id: params.p_site_id,
      asset_id: params.p_asset_id, employee_id: params.p_employee_id, form_id: params.p_form_id,
      customer_name: params.p_customer_name, notes: params.p_notes,
      created_by: 'demo-user', created_by_name: 'Demo User', created_on: nowIso(),
    }];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('operations_execution_log_create', params);
}

export async function loadExecutionLogs(operationId) {
  if (useLocalData) return ok(readDemo().executionLogs.filter((row) => row.operation_id === operationId));
  return run(() => supabase.rpc('operations_execution_logs_list', { p_operation_id: operationId }));
}

/** @param {'OperationExecutionPhoto'|'OperationExecutionFile'} entityType */
export async function listExecutionLogAttachments(entityType, executionLogId) {
  if (useLocalData) return ok([]);
  const { data, error } = await run(() => supabase.rpc('operations_execution_log_attachments_list', { p_entity_type: entityType, p_execution_log_id: executionLogId }));
  if (error) return { data: null, error };

  const rows = Array.isArray(data) ? data : [];
  const resolved = await Promise.all(rows.map(async (row) => {
    const provider = await getStorageProvider(row.layer, { bucket: row.bucket || undefined });
    const { data: urlData } = await provider.getUrl(row.path, { expiresIn: 3600 });
    return { ...row, url: urlData?.url || '' };
  }));
  return ok(resolved);
}

export async function loadOperationsTimeline(operationId) {
  if (useLocalData) return ok([]);
  return run(() => supabase.rpc('operations_timeline', { p_operation_id: operationId }));
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
export async function loadTemplates({ includeInactive = false } = {}) {
  if (useLocalData) {
    const rows = readDemo().templates;
    return ok(includeInactive ? rows : rows.filter((row) => row.is_active !== false));
  }
  let query = supabase.from('operations_templates').select(TEMPLATE_COLUMNS).order('name_ar');
  if (!includeInactive) query = query.eq('is_active', true);
  return runList(() => query);
}

export async function loadTemplateChecklistItems(templateId) {
  if (!templateId) return ok([]);
  if (useLocalData) return ok(readDemo().templateChecklistItems.filter((row) => row.template_id === templateId));
  return runList(() => supabase.from('operations_template_checklist_items').select(TEMPLATE_CHECKLIST_ITEM_COLUMNS).eq('template_id', templateId).order('display_order'));
}

/** @param {{id?, name_ar, name_en?, description_ar?, description_en?, customer_name?, site_id?, is_active?}} template */
export async function saveTemplate(template) {
  if (!trimmed(template?.name_ar)) return ko('NAME_AR_REQUIRED');
  const params = {
    p_id: template.id || null, p_name_ar: template.name_ar, p_name_en: trimmed(template.name_en),
    p_description_ar: trimmed(template.description_ar), p_description_en: trimmed(template.description_en),
    p_customer_name: trimmed(template.customer_name), p_site_id: template.site_id || null,
    p_is_active: template.is_active ?? true,
  };
  if (useLocalData) {
    const state = readDemo();
    const id = template.id || newId();
    const saved = {
      id, name_ar: params.p_name_ar, name_en: params.p_name_en, description_ar: params.p_description_ar,
      description_en: params.p_description_en, customer_name: params.p_customer_name, site_id: params.p_site_id,
      is_active: params.p_is_active,
    };
    state.templates = template.id
      ? state.templates.map((row) => (row.id === id ? saved : row))
      : [...state.templates, saved];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('operations_templates_upsert', params);
}

/** @param {{id?, template_id, title_ar, title_en?, display_order?}} item */
export async function saveTemplateChecklistItem(item) {
  if (!trimmed(item?.title_ar)) return ko('TITLE_AR_REQUIRED');
  const params = {
    p_id: item.id || null, p_template_id: item.template_id, p_title_ar: item.title_ar,
    p_title_en: trimmed(item.title_en), p_display_order: Number(item.display_order) || 0,
  };
  if (useLocalData) {
    const state = readDemo();
    const id = item.id || newId();
    const saved = { id, template_id: params.p_template_id, title_ar: params.p_title_ar, title_en: params.p_title_en, display_order: params.p_display_order };
    state.templateChecklistItems = item.id
      ? state.templateChecklistItems.map((row) => (row.id === id ? saved : row))
      : [...state.templateChecklistItems, saved];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('operations_template_checklist_item_upsert', params);
}

export async function removeTemplateChecklistItem(id) {
  if (useLocalData) {
    const state = readDemo();
    state.templateChecklistItems = state.templateChecklistItems.filter((row) => row.id !== id);
    writeDemo(state);
    return ok(null);
  }
  return callRpc('operations_template_checklist_item_remove', { p_id: id });
}

/** @param {{templateId, nameAr?, nameEn?, siteId?, customerName?, startDate, endDate?}} params */
export async function createOperationFromTemplate(params) {
  if (!params?.templateId) return ko('TEMPLATE_ID_REQUIRED');
  if (!params?.startDate) return ko('START_DATE_REQUIRED');
  if (useLocalData) {
    const state = readDemo();
    const template = state.templates.find((row) => row.id === params.templateId);
    const id = newId();
    state.operations = [...state.operations, {
      id, number: `NO-DEMO-OP-${String(Date.now()).slice(-8)}`, name_ar: params.nameAr || template?.name_ar || '',
      name_en: params.nameEn || template?.name_en || null, description_ar: template?.description_ar || null,
      description_en: template?.description_en || null, customer_name: params.customerName || template?.customer_name || null,
      site_id: params.siteId || template?.site_id || null, start_date: params.startDate, end_date: params.endDate || null,
      status: 'Draft', created_on: nowIso(),
    }];
    state.checklistItems = [
      ...state.checklistItems,
      ...state.templateChecklistItems.filter((row) => row.template_id === params.templateId).map((row) => ({
        id: newId(), operation_id: id, title_ar: row.title_ar, title_en: row.title_en,
        display_order: row.display_order, is_done: false, done_by: null, done_on: null,
      })),
    ];
    writeDemo(state);
    return ok(id);
  }
  return callRpc('operations_create_from_template', {
    p_template_id: params.templateId, p_name_ar: trimmed(params.nameAr), p_start_date: params.startDate,
    p_name_en: trimmed(params.nameEn), p_site_id: params.siteId || null,
    p_customer_name: trimmed(params.customerName), p_end_date: params.endDate || null,
  });
}

// ---------------------------------------------------------------------------
// Manager Dashboard
// ---------------------------------------------------------------------------
export async function loadDashboardSummary(staleDays = 3) {
  if (useLocalData) {
    return ok({
      operationsCount: 0, activeCount: 0, completedCount: 0, onHoldCount: 0, avgCompletionPercent: null,
      latestRecords: [], latestPhotos: [], mostActiveEmployees: [], staleOperations: [],
    });
  }
  return run(() => supabase.rpc('operations_dashboard_summary', { p_stale_days: staleDays }));
}
