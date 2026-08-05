// Organisation dimensions: departments, positions, sectors, projects, sites and
// countries.
//
// They are all the same shape — a code, two names, two descriptions, a display
// order and an active switch — so one service serves the single reusable CRUD
// screen instead of six near-identical modules. Countries carry the nationality
// pair as well, because the country list is also the nationality list.
//
// Every function returns { data, error } and never throws. In local preview
// mode (useLocalData) the data lives in localStorage: departments and positions
// share the store the older organisation service already uses, so the employee
// screen and the dimension screens never disagree.

import { supabase, useLocalData } from '../lib/supabaseClient';

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

const asError = (value) => {
  if (value instanceof Error) return value;
  const message = value?.message || value?.error_description || value;
  return new Error(String(message || 'ORG_REQUEST_FAILED'));
};

const ok = (data) => ({ data, error: null });
const ko = (value) => ({ data: null, error: asError(value) });

/** Maps a database error onto a translation key, falling back to the shared one. */
export const orgErrorMessage = (t, error, fallbackKey = 'error_generic') => {
  if (!error) return '';
  const raw = String(error.message || error).trim();
  const code = raw.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/)?.[0];
  if (code) {
    const key = `admin_err_${code.toLowerCase()}`;
    const label = t(key);
    if (label !== key) return label;
  }
  if (/duplicate key|already exists|uq_/i.test(raw)) return t('error_validation');
  if (/permission|denied|row-level/i.test(raw)) return t('error_permission');
  return t(fallbackKey);
};

// ---------------------------------------------------------------------------
// Entity metadata
// ---------------------------------------------------------------------------

/** The columns each table accepts on write, beyond the shared ones. */
const EXTRA_COLUMNS = {
  countries: ['iso_code', 'dial_code', 'nationality_ar', 'nationality_en'],
  sites: ['project_id'],
  positions: ['department_id'],
};

const SHARED_COLUMNS = [
  'code', 'name_ar', 'name_en', 'description_ar', 'description_en',
  'display_order', 'is_active',
];

const EMBEDS = {
  positions: '*, departments(id,code,name_ar,name_en)',
  sites: '*, projects(id,code,name_ar,name_en)',
};

export const ORG_ENTITIES = ['departments', 'positions', 'sectors', 'projects', 'sites', 'countries'];

const tableOf = (entity) => {
  if (!ORG_ENTITIES.includes(entity)) throw new Error('UNKNOWN_ORG_ENTITY');
  return entity;
};

const columnsOf = (entity) => [...SHARED_COLUMNS, ...(EXTRA_COLUMNS[entity] || [])];

const normalize = (entity, item) => {
  const payload = {};
  columnsOf(entity).forEach((column) => {
    const value = item[column];
    if (column === 'code') payload.code = String(value || '').trim().toUpperCase();
    else if (column === 'display_order') payload.display_order = Number(value || 0);
    else if (column === 'is_active') payload.is_active = value !== false;
    else if (column === 'iso_code') payload.iso_code = String(value || '').trim().toUpperCase() || null;
    else if (column.endsWith('_id')) payload[column] = value || null;
    else payload[column] = String(value ?? '').trim() || null;
  });
  // name_ar is the required primary name on every one of these tables.
  payload.name_ar = String(item.name_ar ?? '').trim();
  return payload;
};

// ---------------------------------------------------------------------------
// Local preview store
// ---------------------------------------------------------------------------

const LEGACY_KEY = 'bbnovix_organization_lookups';   // departments + positions
const DIMENSION_KEY = 'bbnovix_org_dimensions';     // sectors, projects, sites, countries

const legacySeed = {
  departments: [
    { id: 'dept-hr', code: 'HR', name_ar: 'الموارد البشرية', name_en: 'Human Resources', display_order: 10, is_active: true },
    { id: 'dept-fin', code: 'FIN', name_ar: 'المالية', name_en: 'Finance', display_order: 20, is_active: true },
    { id: 'dept-ops', code: 'OPS', name_ar: 'التشغيل', name_en: 'Operations', display_order: 30, is_active: true },
    { id: 'dept-it', code: 'IT', name_ar: 'تقنية المعلومات', name_en: 'Information Technology', display_order: 40, is_active: true },
  ],
  positions: [
    { id: 'pos-hr', code: 'HR-SPEC', name_ar: 'أخصائي موارد بشرية', name_en: 'HR Specialist', department_id: 'dept-hr', display_order: 10, is_active: true },
    { id: 'pos-accountant', code: 'FIN-ACC', name_ar: 'محاسب أول', name_en: 'Senior Accountant', department_id: 'dept-fin', display_order: 20, is_active: true },
    { id: 'pos-project-manager', code: 'OPS-PM', name_ar: 'مدير مشروع', name_en: 'Project Manager', department_id: 'dept-ops', display_order: 30, is_active: true },
  ],
};

const dimensionSeed = {
  sectors: [
    { id: 'sec-fm', code: 'FM', name_ar: 'إدارة المرافق', name_en: 'Facility Management', display_order: 10, is_active: true },
    { id: 'sec-cons', code: 'CONS', name_ar: 'المقاولات', name_en: 'Contracting', display_order: 20, is_active: true },
    { id: 'sec-corp', code: 'CORP', name_ar: 'القطاع المؤسسي', name_en: 'Corporate', display_order: 30, is_active: true },
  ],
  projects: [
    { id: 'prj-riyadh', code: 'RUH-01', name_ar: 'مشروع الرياض', name_en: 'Riyadh Project', display_order: 10, is_active: true },
    { id: 'prj-jeddah', code: 'JED-01', name_ar: 'مشروع جدة', name_en: 'Jeddah Project', display_order: 20, is_active: true },
  ],
  sites: [
    { id: 'site-hq', code: 'HQ', name_ar: 'المركز الرئيسي', name_en: 'Head Office', project_id: 'prj-riyadh', display_order: 10, is_active: true },
    { id: 'site-north', code: 'NORTH', name_ar: 'الموقع الشمالي', name_en: 'North Site', project_id: 'prj-riyadh', display_order: 20, is_active: true },
    { id: 'site-port', code: 'PORT', name_ar: 'موقع الميناء', name_en: 'Port Site', project_id: 'prj-jeddah', display_order: 30, is_active: true },
  ],
  countries: [
    { id: 'cty-sa', code: 'SA', iso_code: 'SA', dial_code: '+966', name_ar: 'السعودية', name_en: 'Saudi Arabia', nationality_ar: 'سعودي', nationality_en: 'Saudi', display_order: 10, is_active: true },
    { id: 'cty-eg', code: 'EG', iso_code: 'EG', dial_code: '+20', name_ar: 'مصر', name_en: 'Egypt', nationality_ar: 'مصري', nationality_en: 'Egyptian', display_order: 20, is_active: true },
    { id: 'cty-in', code: 'IN', iso_code: 'IN', dial_code: '+91', name_ar: 'الهند', name_en: 'India', nationality_ar: 'هندي', nationality_en: 'Indian', display_order: 30, is_active: true },
    { id: 'cty-ph', code: 'PH', iso_code: 'PH', dial_code: '+63', name_ar: 'الفلبين', name_en: 'Philippines', nationality_ar: 'فلبيني', nationality_en: 'Filipino', display_order: 40, is_active: true },
  ],
};

const storeKeyFor = (entity) => (entity === 'departments' || entity === 'positions' ? LEGACY_KEY : DIMENSION_KEY);
const seedFor = (entity) => (entity === 'departments' || entity === 'positions' ? legacySeed : dimensionSeed);

const readStore = (entity) => {
  const key = storeKeyFor(entity);
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    const seed = seedFor(entity);
    return { ...seed, ...(parsed || {}) };
  } catch {
    return { ...seedFor(entity) };
  }
};

const writeStore = (entity, store) => {
  try {
    localStorage.setItem(storeKeyFor(entity), JSON.stringify(store));
  } catch {
    // A full or blocked storage must never break the screen.
  }
};

const newId = () => (globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

/** Local preview joins, so the screen renders the same shape as PostgREST. */
const attachLocalRelations = (entity, rows, store) => {
  if (entity === 'positions') {
    const departments = readStore('departments').departments || [];
    return rows.map((row) => ({ ...row, departments: departments.find((item) => item.id === row.department_id) || null }));
  }
  if (entity === 'sites') {
    const projects = store.projects || [];
    return rows.map((row) => ({ ...row, projects: projects.find((item) => item.id === row.project_id) || null }));
  }
  return rows;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const cleanSearch = (value) => String(value || '').replace(/[,()%*"']/g, ' ').trim();

/**
 * One page of an organisation dimension.
 *
 * @returns {Promise<{data: {rows: object[], total: number}|null, error: Error|null}>}
 */
export const listOrgEntities = async (entity, options = {}) => {
  const { search = '', includeInactive = true, page = 1, pageSize = 20 } = options;
  let table;
  try {
    table = tableOf(entity);
  } catch (error) {
    return ko(error);
  }

  const term = cleanSearch(search).toLocaleLowerCase();

  if (useLocalData || !supabase) {
    const store = readStore(entity);
    let rows = [...(store[entity] || [])].filter((row) => !row.is_deleted);
    if (!includeInactive) rows = rows.filter((row) => row.is_active !== false);
    if (term) {
      rows = rows.filter((row) => `${row.code || ''} ${row.name_ar || ''} ${row.name_en || ''}`
        .toLocaleLowerCase().includes(term));
    }
    rows.sort((a, b) => (a.display_order || 0) - (b.display_order || 0)
      || String(a.name_ar || '').localeCompare(String(b.name_ar || '')));
    const total = rows.length;
    const start = Math.max(0, (page - 1) * pageSize);
    return ok({ rows: attachLocalRelations(entity, rows.slice(start, start + pageSize), store), total });
  }

  try {
    let query = supabase
      .from(table)
      .select(EMBEDS[entity] || '*', { count: 'exact' })
      .eq('is_deleted', false);
    if (!includeInactive) query = query.eq('is_active', true);
    if (term) query = query.or(`code.ilike.%${term}%,name_ar.ilike.%${term}%,name_en.ilike.%${term}%`);

    const start = Math.max(0, (page - 1) * pageSize);
    const { data, error, count } = await query
      .order('display_order', { ascending: true })
      .order('name_ar', { ascending: true })
      .range(start, start + pageSize - 1);

    if (error) return ko(error);
    return ok({ rows: data || [], total: count ?? (data || []).length });
  } catch (error) {
    return ko(error);
  }
};

/**
 * The four dimensions the employee record points at, active rows only. Used by
 * the employee screen combo boxes, which render both names.
 */
export const loadOrgDimensions = async () => {
  if (useLocalData || !supabase) {
    const store = readStore('sectors');
    const pick = (key) => (store[key] || []).filter((row) => !row.is_deleted && row.is_active !== false);
    return ok({ sectors: pick('sectors'), projects: pick('projects'), sites: pick('sites'), countries: pick('countries') });
  }

  try {
    const select = 'id,code,name_ar,name_en,display_order,is_active';
    const [sectors, projects, sites, countries] = await Promise.all([
      supabase.from('sectors').select(select).eq('is_deleted', false).eq('is_active', true).order('display_order'),
      supabase.from('projects').select(select).eq('is_deleted', false).eq('is_active', true).order('display_order'),
      supabase.from('sites').select(`${select},project_id`).eq('is_deleted', false).eq('is_active', true).order('display_order'),
      supabase.from('countries').select(`${select},nationality_ar,nationality_en,iso_code,dial_code`).eq('is_deleted', false).eq('is_active', true).order('display_order'),
    ]);

    // A missing table (a company on an older migration) must degrade to an
    // empty list rather than blanking the whole employee form.
    return ok({
      sectors: sectors.data || [],
      projects: projects.data || [],
      sites: sites.data || [],
      countries: countries.data || [],
    });
  } catch (error) {
    return ko(error);
  }
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export const saveOrgEntity = async (entity, item) => {
  let table;
  try {
    table = tableOf(entity);
  } catch (error) {
    return ko(error);
  }

  const payload = normalize(entity, item);
  if (!payload.code) return ko('CODE_REQUIRED');
  if (!payload.name_ar) return ko('NAME_REQUIRED');

  if (useLocalData || !supabase) {
    const store = readStore(entity);
    const rows = [...(store[entity] || [])];
    const id = item.id || newId();
    const index = rows.findIndex((row) => row.id === id);
    const next = { ...(index >= 0 ? rows[index] : {}), ...payload, id };
    if (index >= 0) rows[index] = next;
    else rows.unshift(next);
    writeStore(entity, { ...store, [entity]: rows });
    return ok(next);
  }

  try {
    const query = item.id
      ? supabase.from(table).update(payload).eq('id', item.id)
      : supabase.from(table).insert(payload);
    const { data, error } = await query.select().single();
    if (error) return ko(error);
    return ok(data);
  } catch (error) {
    return ko(error);
  }
};

/** Soft delete: the row leaves every list but stays in the record. */
export const deleteOrgEntity = async (entity, id) => {
  let table;
  try {
    table = tableOf(entity);
  } catch (error) {
    return ko(error);
  }
  if (!id) return ko('ID_REQUIRED');

  if (useLocalData || !supabase) {
    const store = readStore(entity);
    const rows = (store[entity] || []).filter((row) => row.id !== id);
    writeStore(entity, { ...store, [entity]: rows });
    return ok({ id });
  }

  try {
    const { error } = await supabase
      .from(table)
      .update({ is_deleted: true, is_active: false, deleted_date: new Date().toISOString() })
      .eq('id', id);
    if (error) return ko(error);
    return ok({ id });
  } catch (error) {
    return ko(error);
  }
};

export const setOrgEntityActive = async (entity, row, isActive) =>
  saveOrgEntity(entity, { ...row, is_active: isActive });

/**
 * The four organisational pointers on the employee record. They are written
 * directly because the invite function only knows about department and
 * position; the employee screen calls this straight after it.
 */
export const saveEmployeeDimensions = async (userId, values = {}) => {
  if (!userId) return ok(null);
  const payload = {
    sector_id: values.sector_id || null,
    project_id: values.project_id || null,
    site_id: values.site_id || null,
    country_id: values.country_id || null,
  };

  if (useLocalData || !supabase) return ok({ id: userId, ...payload });

  try {
    const { error } = await supabase.from('users').update(payload).eq('id', userId);
    if (error) return ko(error);
    return ok({ id: userId, ...payload });
  } catch (error) {
    return ko(error);
  }
};
