// Audience Targeting Engine — the only place the browser talks to the SQL side
// of "who sees this".
//
// Three RPCs carry the whole feature:
//
//   public.audience_describe(entity_type, entity_id)        read the rule
//   public.audience_save(entity_type, entity_id, rule)      replace the rule
//   public.audience_matches(entity_type, entity_id, user)   would X see it?
//
// Everything else here is option loading for the dimension selectors. Those
// lists are small, shared by every row of every picker on the screen and change
// about once a quarter, so they are cached in memory for the lifetime of the
// page: opening the picker inside a table row must not refetch per row.
//
// Every function returns { data, error } and never throws.

import { supabase, useLocalData } from '../lib/supabaseClient';

// ---------------------------------------------------------------------------
// Vocabulary shared with the SQL side (migration 013). Values are CODES.
// ---------------------------------------------------------------------------

export const AUDIENCE_ENTITY_TYPES = [
  'Circular', 'Document', 'Design', 'FormTemplate', 'Announcement',
  'Survey', 'CalendarEvent', 'Certificate', 'Note',
];

export const AUDIENCE_DIMENSIONS = [
  'Department', 'Project', 'Sector', 'Site', 'Country',
  'Nationality', 'Role', 'Employee', 'PublicationLevel', 'Tag',
];

export const AUDIENCE_OPERATORS = ['AND', 'OR', 'NOT'];
export const AUDIENCE_MATCH_MODES = ['All', 'Any'];
export const PUBLICATION_LEVELS = ['PUBLIC', 'ADMINISTRATIVE', 'MANAGER_RESTRICTED', 'PRIVATE_RESTRICTED'];

/** Dimension -> translation key for its label, reusing the shared vocabulary. */
export const DIMENSION_LABEL_KEYS = {
  Everyone: 'audience_dim_everyone',
  Department: 'label_department',
  Project: 'label_project',
  Sector: 'label_sector',
  Site: 'label_site',
  Country: 'label_country',
  Nationality: 'label_nationality',
  Role: 'label_role',
  Employee: 'label_employee',
  PublicationLevel: 'audience_dim_publication_level',
  Tag: 'audience_dim_tag',
};

/** Dimension -> translation key of the sentence fragment used in the summary. */
export const DIMENSION_FRAGMENT_KEYS = {
  Everyone: 'audience_frag_everyone',
  Department: 'audience_frag_department',
  Project: 'audience_frag_project',
  Sector: 'audience_frag_sector',
  Site: 'audience_frag_site',
  Country: 'audience_frag_country',
  Nationality: 'audience_frag_nationality',
  Role: 'audience_frag_role',
  Employee: 'audience_frag_employee',
  PublicationLevel: 'audience_frag_publication_level',
  Tag: 'audience_frag_tag',
};

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

const asError = (value) => {
  if (value instanceof Error) return value;
  const message = value?.message || value?.error_description || value;
  return new Error(String(message || 'AUDIENCE_REQUEST_FAILED'));
};

const ok = (data) => ({ data, error: null });
const ko = (value) => ({ data: null, error: asError(value) });

/**
 * Maps an RPC error code onto a translation key. The SQL side raises
 * SCREAMING_SNAKE codes; anything unrecognised falls back to the shared
 * sentences so the user never reads a database message.
 */
export const audienceErrorMessage = (t, error, fallbackKey = 'error_generic') => {
  if (!error) return '';
  const raw = String(error.message || error).trim();
  const code = raw.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/)?.[0];
  if (code) {
    const key = `audience_err_${code.toLowerCase()}`;
    const label = t(key);
    if (label !== key) return label;
  }
  if (/permission|denied|row-level/i.test(raw)) return t('error_permission');
  if (/fetch|network|timeout/i.test(raw)) return t('error_network');
  return t(fallbackKey);
};

// ---------------------------------------------------------------------------
// Rule shape
//
//   { is_everyone, match_mode, groups: [ { group_no, terms: [ term ] } ] }
//   term = { operator, dimension, value_id, value_text }
//
// audience_describe also decorates each term with label_ar / label_en so the
// summary can be written without a second round trip; those extra keys travel
// back through audience_save untouched, which keeps the round trip exact.
// ---------------------------------------------------------------------------

export const emptyRule = () => ({ is_everyone: true, match_mode: 'All', groups: [] });

const cleanText = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

const normalizeTerm = (raw, groupNo) => {
  const dimension = cleanText(raw?.dimension);
  if (!dimension || !AUDIENCE_DIMENSIONS.includes(dimension)) return null;

  const operator = String(raw?.operator || 'AND').toUpperCase();
  return {
    group_no: groupNo,
    operator: AUDIENCE_OPERATORS.includes(operator) ? operator : 'AND',
    dimension,
    value_id: cleanText(raw?.value_id),
    value_text: cleanText(raw?.value_text),
    label_ar: cleanText(raw?.label_ar),
    label_en: cleanText(raw?.label_en),
  };
};

/**
 * Accepts anything the SQL side or a caller may hand over — the describe
 * payload (which carries both `terms` and `groups`), a plain rule, null — and
 * returns the canonical rule object.
 */
export const normalizeRule = (raw) => {
  if (!raw || typeof raw !== 'object') return emptyRule();

  const mode = String(raw.match_mode || 'All');
  const matchMode = AUDIENCE_MATCH_MODES.includes(mode) ? mode : 'All';

  // Prefer the grouped shape; fall back to the flat term list.
  let groups = [];
  if (Array.isArray(raw.groups) && raw.groups.length) {
    groups = raw.groups.map((group, index) => ({
      group_no: Number(group?.group_no) || index + 1,
      terms: (Array.isArray(group?.terms) ? group.terms : []),
    }));
  } else if (Array.isArray(raw.terms) && raw.terms.length) {
    const byGroup = new Map();
    raw.terms.forEach((term) => {
      const groupNo = Number(term?.group_no) || 1;
      if (!byGroup.has(groupNo)) byGroup.set(groupNo, []);
      byGroup.get(groupNo).push(term);
    });
    groups = [...byGroup.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([groupNo, terms]) => ({ group_no: groupNo, terms }));
  }

  // An explicit "Everyone" term and the is_everyone flag are the same audience;
  // keep the flag and drop the term so the picker has one thing to render.
  let isEveryone = raw.is_everyone === true;
  const cleaned = groups
    .map((group, index) => {
      const groupNo = index + 1;
      const terms = group.terms
        .map((term) => {
          if (cleanText(term?.dimension) === 'Everyone') {
            isEveryone = true;
            return null;
          }
          return normalizeTerm(term, groupNo);
        })
        .filter(Boolean);
      return { group_no: groupNo, terms };
    })
    .filter((group) => group.terms.length > 0)
    .map((group, index) => ({
      group_no: index + 1,
      terms: group.terms.map((term) => ({ ...term, group_no: index + 1 })),
    }));

  // The author's intent is preserved as written: "targeted, nothing chosen yet"
  // is a legitimate half-finished state while the picker is open. Collapsing it
  // onto "everyone" is the *engine's* reading of an empty rule and belongs to
  // isEveryoneRule() and to saveRule(), not here — otherwise turning the switch
  // off would immediately snap it back on.
  return { is_everyone: isEveryone, match_mode: matchMode, groups: cleaned };
};

/** True when the rule targets the whole company (explicitly or by being empty). */
export const isEveryoneRule = (rule) => {
  const normalized = normalizeRule(rule);
  return normalized.is_everyone || normalized.groups.length === 0;
};

/** Flat term list, the shape audience_save reads. */
export const ruleTerms = (rule) =>
  normalizeRule(rule).groups.flatMap((group) =>
    group.terms.map((term, index) => ({ ...term, group_no: group.group_no, display_order: index + 1 })));

// ---------------------------------------------------------------------------
// Local preview store
// ---------------------------------------------------------------------------

const LOCAL_RULES_KEY = 'bbnovix_audience_rules';

const localKey = (entityType, entityId) => `${entityType}:${entityId}`;

const readLocalRules = () => {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_RULES_KEY) || '{}') || {};
  } catch {
    return {};
  }
};

const writeLocalRules = (store) => {
  try {
    localStorage.setItem(LOCAL_RULES_KEY, JSON.stringify(store));
  } catch {
    // A full or blocked storage must never break the screen.
  }
};

// Demo dimensions mirror the seeds the organisation service uses, so the two
// screens agree while the app runs without Supabase.
const DEMO_OPTIONS = {
  Department: [
    { id: 'dept-hr', code: 'HR', name_ar: 'الموارد البشرية', name_en: 'Human Resources' },
    { id: 'dept-fin', code: 'FIN', name_ar: 'المالية', name_en: 'Finance' },
    { id: 'dept-ops', code: 'OPS', name_ar: 'التشغيل', name_en: 'Operations' },
    { id: 'dept-it', code: 'IT', name_ar: 'تقنية المعلومات', name_en: 'Information Technology' },
  ],
  Project: [
    { id: 'prj-riyadh', code: 'RUH-01', name_ar: 'مشروع الرياض', name_en: 'Riyadh Project' },
    { id: 'prj-jeddah', code: 'JED-01', name_ar: 'مشروع جدة', name_en: 'Jeddah Project' },
    { id: 'prj-neom', code: 'NEOM', name_ar: 'مشروع نيوم', name_en: 'NEOM Project' },
  ],
  Sector: [
    { id: 'sec-fm', code: 'FM', name_ar: 'إدارة المرافق', name_en: 'Facility Management' },
    { id: 'sec-cons', code: 'CONS', name_ar: 'المقاولات', name_en: 'Contracting' },
    { id: 'sec-corp', code: 'CORP', name_ar: 'القطاع المؤسسي', name_en: 'Corporate' },
  ],
  Site: [
    { id: 'site-hq', code: 'HQ', name_ar: 'المركز الرئيسي', name_en: 'Head Office' },
    { id: 'site-north', code: 'NORTH', name_ar: 'الموقع الشمالي', name_en: 'North Site' },
    { id: 'site-port', code: 'PORT', name_ar: 'موقع الميناء', name_en: 'Port Site' },
  ],
  Country: [
    { id: 'cty-sa', code: 'SA', name_ar: 'السعودية', name_en: 'Saudi Arabia' },
    { id: 'cty-eg', code: 'EG', name_ar: 'مصر', name_en: 'Egypt' },
    { id: 'cty-in', code: 'IN', name_ar: 'الهند', name_en: 'India' },
    { id: 'cty-ph', code: 'PH', name_ar: 'الفلبين', name_en: 'Philippines' },
  ],
  Nationality: [
    { id: 'cty-sa', code: 'SA', name_ar: 'سعودي', name_en: 'Saudi' },
    { id: 'cty-eg', code: 'EG', name_ar: 'مصري', name_en: 'Egyptian' },
    { id: 'cty-in', code: 'IN', name_ar: 'هندي', name_en: 'Indian' },
    { id: 'cty-ph', code: 'PH', name_ar: 'فلبيني', name_en: 'Filipino' },
  ],
  Role: [
    { id: 'role-admin', code: 'PLATFORM_ADMIN', name_ar: 'مدير المؤسسة', name_en: 'Organization Administrator' },
    { id: 'role-manager', code: 'DEPARTMENT_MANAGER', name_ar: 'مدير إدارة', name_en: 'Department Manager' },
    { id: 'role-employee', code: 'EMPLOYEE', name_ar: 'موظف', name_en: 'Employee' },
    { id: 'role-intern', code: 'INTERN', name_ar: 'متدرب', name_en: 'Intern' },
  ],
  Employee: [
    { id: 'emp-1', code: 'E-1001', name_ar: 'أحمد العماري', name_en: 'Ahmed Alemary' },
    { id: 'emp-2', code: 'E-1002', name_ar: 'سارة القحطاني', name_en: 'Sarah Alqahtani' },
    { id: 'emp-3', code: 'E-1003', name_ar: 'راج كومار', name_en: 'Raj Kumar' },
  ],
  Tag: [
    { id: 'tag-new', code: 'NEW_JOINER', name_ar: 'موظف جديد', name_en: 'New joiner' },
    { id: 'tag-field', code: 'FIELD', name_ar: 'العمل الميداني', name_en: 'Field staff' },
    { id: 'tag-driver', code: 'DRIVER', name_ar: 'سائق', name_en: 'Driver' },
  ],
};

// ---------------------------------------------------------------------------
// Reading and writing the rule
// ---------------------------------------------------------------------------

/**
 * The audience bound to one record.
 *
 * @returns {Promise<{data: object|null, error: Error|null}>} the canonical rule
 */
export const loadRule = async (entityType, entityId) => {
  if (!entityType || !entityId) return ok(emptyRule());

  if (useLocalData || !supabase) {
    const stored = readLocalRules()[localKey(entityType, entityId)];
    return ok(normalizeRule(stored));
  }

  try {
    const { data, error } = await supabase.rpc('audience_describe', {
      p_entity_type: entityType,
      p_entity_id: entityId,
    });
    if (error) return ko(error);
    return ok(normalizeRule(data));
  } catch (error) {
    return ko(error);
  }
};

/**
 * Replaces the whole rule for one record. The picker never calls this itself —
 * the owning screen does, next to its own save, so one button saves one record.
 */
export const saveRule = async (entityType, entityId, rule) => {
  if (!entityType) return ko('INVALID_ENTITY_TYPE');
  if (!entityId) return ko('ENTITY_REQUIRED');

  const normalized = normalizeRule(rule);
  const payload = {
    is_everyone: normalized.is_everyone || normalized.groups.length === 0,
    match_mode: normalized.match_mode,
    terms: normalized.is_everyone ? [] : ruleTerms(normalized),
  };

  if (useLocalData || !supabase) {
    const store = readLocalRules();
    store[localKey(entityType, entityId)] = {
      is_everyone: payload.is_everyone,
      match_mode: payload.match_mode,
      terms: payload.terms,
    };
    writeLocalRules(store);
    return ok(normalizeRule(store[localKey(entityType, entityId)]));
  }

  try {
    const { data, error } = await supabase.rpc('audience_save', {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_rule: payload,
    });
    if (error) return ko(error);
    return ok(normalizeRule(data));
  } catch (error) {
    return ko(error);
  }
};

/**
 * Would this employee see the record? Answers from the *saved* rule, because
 * that is what the RLS policies read.
 *
 * @returns {Promise<{data: boolean|null, error: Error|null}>}
 */
export const testRule = async (entityType, entityId, userId) => {
  if (!entityType || !entityId) return ko('ENTITY_REQUIRED');
  if (!userId) return ko('EMPLOYEE_REQUIRED');

  if (useLocalData || !supabase) {
    const stored = normalizeRule(readLocalRules()[localKey(entityType, entityId)]);
    // The preview has no employee records to evaluate, so it answers the only
    // thing it can answer honestly: an untargeted record reaches everyone.
    return ok(stored.is_everyone || stored.groups.length === 0);
  }

  try {
    const { data, error } = await supabase.rpc('audience_matches', {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_user_id: userId,
    });
    if (error) return ko(error);
    return ok(Boolean(data));
  } catch (error) {
    return ko(error);
  }
};

// ---------------------------------------------------------------------------
// Dimension options
//
// Shape handed to the picker:
//   { key, value_id, value_text, name_ar, name_en, hint, label_key }
//
// `key` is what a selection is compared on, `label_key` marks options whose
// label is a translation rather than database text (publication levels).
// ---------------------------------------------------------------------------

const optionsCache = new Map();
const inFlight = new Map();

/** Drops the cached lists — call after an administrator edits a dimension. */
export const clearAudienceOptionsCache = (dimension) => {
  if (dimension) {
    optionsCache.delete(dimension);
    inFlight.delete(dimension);
    return;
  }
  optionsCache.clear();
  inFlight.clear();
};

const optionOf = ({ id = null, text = null, nameAr, nameEn, hint = null, labelKey = null }) => ({
  key: id || text || '',
  value_id: id,
  value_text: text,
  name_ar: nameAr || null,
  name_en: nameEn || null,
  hint,
  label_key: labelKey,
});

const publicationLevelOptions = () =>
  PUBLICATION_LEVELS.map((code) => optionOf({
    text: code,
    labelKey: `audience_level_${code.toLowerCase()}`,
  }));

const demoOptions = (dimension) => {
  if (dimension === 'PublicationLevel') return publicationLevelOptions();
  return (DEMO_OPTIONS[dimension] || []).map((row) => optionOf({
    id: row.id,
    nameAr: row.name_ar,
    nameEn: row.name_en,
    hint: row.code,
  }));
};

const fetchOptions = async (dimension) => {
  const base = (table, select) => supabase.from(table).select(select).eq('is_deleted', false).eq('is_active', true);

  switch (dimension) {
    case 'Department': {
      const { data, error } = await base('departments', 'id,code,name_ar,name_en,display_order')
        .order('display_order').order('name_ar');
      if (error) throw error;
      return (data || []).map((row) => optionOf({ id: row.id, nameAr: row.name_ar, nameEn: row.name_en, hint: row.code }));
    }
    case 'Project': {
      const { data, error } = await base('projects', 'id,code,name_ar,name_en,display_order')
        .order('display_order').order('name_ar');
      if (error) throw error;
      return (data || []).map((row) => optionOf({ id: row.id, nameAr: row.name_ar, nameEn: row.name_en, hint: row.code }));
    }
    case 'Sector': {
      const { data, error } = await base('sectors', 'id,code,name_ar,name_en,display_order')
        .order('display_order').order('name_ar');
      if (error) throw error;
      return (data || []).map((row) => optionOf({ id: row.id, nameAr: row.name_ar, nameEn: row.name_en, hint: row.code }));
    }
    case 'Site': {
      const { data, error } = await base('sites', 'id,code,name_ar,name_en,display_order')
        .order('display_order').order('name_ar');
      if (error) throw error;
      return (data || []).map((row) => optionOf({ id: row.id, nameAr: row.name_ar, nameEn: row.name_en, hint: row.code }));
    }
    case 'Country': {
      const { data, error } = await base('countries', 'id,code,iso_code,name_ar,name_en,display_order')
        .order('display_order').order('name_ar');
      if (error) throw error;
      return (data || []).map((row) => optionOf({
        id: row.id, nameAr: row.name_ar, nameEn: row.name_en, hint: row.iso_code || row.code,
      }));
    }
    case 'Nationality': {
      const { data, error } = await base('countries', 'id,code,iso_code,nationality_ar,nationality_en,name_ar,name_en,display_order')
        .order('display_order').order('name_ar');
      if (error) throw error;
      return (data || []).map((row) => optionOf({
        id: row.id,
        nameAr: row.nationality_ar || row.name_ar,
        nameEn: row.nationality_en || row.name_en,
        hint: row.iso_code || row.code,
      }));
    }
    case 'Role': {
      const { data, error } = await base('roles', 'id,code,name_ar,name_en').order('code');
      if (error) throw error;
      return (data || []).map((row) => optionOf({ id: row.id, nameAr: row.name_ar, nameEn: row.name_en, hint: row.code }));
    }
    case 'Tag': {
      const { data, error } = await base('employee_tags', 'id,code,name_ar,name_en,display_order')
        .order('display_order').order('name_ar');
      if (error) throw error;
      return (data || []).map((row) => optionOf({ id: row.id, nameAr: row.name_ar, nameEn: row.name_en, hint: row.code }));
    }
    case 'Employee': {
      // The directory is the one list that can be large; the picker filters
      // what it holds and the search below asks the server for the rest.
      const { data, error } = await base('users', 'id,employee_no,full_name,name_ar,name_en,email')
        .order('full_name')
        .limit(300);
      if (error) throw error;
      return (data || []).map((row) => optionOf({
        id: row.id,
        nameAr: row.name_ar || row.full_name || row.email,
        nameEn: row.name_en || row.full_name || row.email,
        hint: row.employee_no || row.email,
      }));
    }
    case 'PublicationLevel':
      return publicationLevelOptions();
    default:
      return [];
  }
};

/**
 * The option list for one dimension, cached for the lifetime of the page so a
 * table full of pickers costs one request per dimension in total.
 *
 * @returns {Promise<{data: object[]|null, error: Error|null}>}
 */
export const loadDimensionOptions = async (dimension) => {
  if (!dimension) return ok([]);
  if (dimension === 'PublicationLevel') return ok(publicationLevelOptions());
  if (optionsCache.has(dimension)) return ok(optionsCache.get(dimension));

  if (useLocalData || !supabase) {
    const options = demoOptions(dimension);
    optionsCache.set(dimension, options);
    return ok(options);
  }

  if (!inFlight.has(dimension)) {
    inFlight.set(dimension, fetchOptions(dimension)
      .then((options) => {
        optionsCache.set(dimension, options);
        return options;
      })
      .finally(() => inFlight.delete(dimension)));
  }

  try {
    return ok(await inFlight.get(dimension));
  } catch (error) {
    return ko(error);
  }
};

/**
 * Server-side employee search for the rule tester and for companies whose
 * directory is longer than the cached page.
 */
export const searchEmployees = async (term) => {
  const needle = String(term || '').replace(/[,()%*"']/g, ' ').trim();
  if (needle.length < 2) return loadDimensionOptions('Employee');

  if (useLocalData || !supabase) {
    const lower = needle.toLocaleLowerCase();
    return ok(demoOptions('Employee').filter((option) =>
      `${option.name_ar || ''} ${option.name_en || ''} ${option.hint || ''}`.toLocaleLowerCase().includes(lower)));
  }

  try {
    // public.users stays closed: the directory function returns display
    // columns only, never national_id, gender or mobile.
    const { data, error } = await supabase.rpc('employee_directory', {
      p_query: needle,
      p_limit: 40,
    });
    if (error) return ko(error);
    return ok((data || []).map((row) => optionOf({
      id: row.id,
      nameAr: row.name_ar || row.full_name || row.email,
      nameEn: row.name_en || row.full_name || row.email,
      hint: row.employee_no || row.email,
    })));
  } catch (error) {
    return ko(error);
  }
};
