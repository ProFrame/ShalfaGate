// Document verification and the certificate factory.
//
// Everything the verification screens and the public verification page need,
// in one place. Nothing here throws: every function resolves with
// { data, error } so a screen can always decide what to render.
//
// Backing objects (migration 202608040017):
//   public.verifiable_documents        every code a third party can check
//   public.certificate_templates(+_fields)  the background and where fields sit
//   public.certificates / certificate_batches
//   RPC verify_document, attestation_create/approve/revoke, certificate_issue
//
// In local preview (`useLocalData`) the same API is served from a localStorage
// mirror, so the screens — including drag & drop and bulk issuing — stay usable
// without a backend.

import { supabase, useLocalData } from '../lib/supabaseClient';
import { STORAGE_LAYER, putFile } from '../lib/storage';

// ---------------------------------------------------------------------------
// Vocabulary — codes stored in the database, labels resolved at render time
// ---------------------------------------------------------------------------

/** Document types a human may create from the attestations screen. */
export const MANUAL_DOC_TYPES = ['Attestation', 'Letter', 'Custom'];

/** Every type the verification page may report. */
export const DOC_TYPES = ['FormRequest', 'Letter', 'Attestation', 'Certificate', 'Custom'];

export const DOCUMENT_STATUSES = ['Draft', 'PendingApproval', 'Active', 'Revoked', 'Expired'];

export const SEAL_STYLES = ['Blue', 'Gold'];

export const FIELD_TYPES = ['Text', 'Date', 'Number', 'Image', 'QR', 'Code'];

export const FIELD_ALIGNMENTS = ['Start', 'Center', 'End'];

export const FIELD_ANCHORS = ['TopStart', 'TopCenter', 'TopEnd'];

export const FONT_WEIGHTS = ['400', '600', '800'];

/** Page presets in CSS pixels at 96 dpi, expressed landscape first. */
export const PAGE_PRESETS = [
  { code: 'A4', width: 1123, height: 794 },
  { code: 'A5', width: 794, height: 559 },
  { code: 'Letter', width: 1056, height: 816 },
];

export const MAX_SHEET_ROWS = 5000;

/** Code → translation key. Shared statuses reuse the platform vocabulary. */
export const STATUS_LABEL_KEYS = {
  Draft: 'status_draft',
  PendingApproval: 'vf_status_pending_approval',
  Active: 'status_active',
  Revoked: 'status_revoked',
  Expired: 'status_expired',
};

export const DOC_TYPE_LABEL_KEYS = {
  FormRequest: 'vf_doctype_formrequest',
  Letter: 'vf_doctype_letter',
  Attestation: 'vf_doctype_attestation',
  Certificate: 'vf_doctype_certificate',
  Custom: 'vf_doctype_custom',
};

/** Verdict of the public page → the wording it shows. */
export const VERDICT_LABEL_KEYS = {
  VALID: { title: 'vf_verdict_valid', hint: 'vf_verdict_valid_hint', tone: 'valid' },
  NOT_FOUND: { title: 'vf_verdict_notfound', hint: 'vf_verdict_notfound_hint', tone: 'invalid' },
  EXPIRED: { title: 'vf_verdict_expired', hint: 'vf_verdict_expired_hint', tone: 'warning' },
  REVOKED: { title: 'vf_verdict_revoked', hint: 'vf_verdict_revoked_hint', tone: 'invalid' },
  NOT_PUBLISHED: { title: 'vf_verdict_notpublished', hint: 'vf_verdict_notpublished_hint', tone: 'warning' },
  NOT_APPROVED: { title: 'vf_verdict_notapproved', hint: 'vf_verdict_notapproved_hint', tone: 'warning' },
};

/** RPC error codes that already have shared wording. */
const SHARED_ERROR_KEYS = {
  PERMISSION_DENIED: 'error_permission',
  MODULE_NOT_ENABLED: 'error_module_disabled',
  QUOTA_EXCEEDED: 'error_quota_exceeded',
  DOCUMENT_NOT_FOUND: 'error_not_found',
  NOT_FOUND: 'error_not_found',
  STORAGE_NOT_ENABLED: 'error_storage_disabled',
  STORAGE_NOT_CONFIGURED: 'error_storage_disabled',
  UPLOAD_REFUSED: 'error_storage_disabled',
  STORAGE_CHECK_FAILED: 'error_storage_disabled',
  FILE_TOO_LARGE: 'error_file_too_large',
  FILE_TYPE_NOT_ALLOWED: 'error_file_type',
};

const OWN_ERROR_KEYS = [
  'TITLE_REQUIRED', 'DOCUMENT_LOCKED', 'DOCUMENT_NOT_PENDING', 'DOCUMENT_ALREADY_REVOKED',
  'DOCUMENT_NOT_MANUAL', 'INVALID_DOC_TYPE', 'INVALID_SEAL_STYLE', 'NO_ACTIVE_TENANT',
  'TEMPLATE_NOT_FOUND', 'TEMPLATE_INACTIVE', 'NO_ROWS', 'TOO_MANY_ROWS', 'INVALID_ROWS',
  'RECIPIENT_NAME_REQUIRED', 'VERIFY_FAILED', 'SHEET_UNREADABLE', 'NO_COLUMNS',
  'TEMPLATE_CODE_TAKEN', 'FIELD_KEY_TAKEN', 'FIELD_KEY_INVALID',
];

/**
 * Maps whatever came back — a raised RPC code, a PostgREST error, a thrown
 * Error — onto a translation key the screens can render.
 *
 * @returns {string} translation key
 */
export const verificationErrorKey = (error) => {
  if (!error) return 'error_generic';
  const raw = String(error.code === '23505' ? 'TEMPLATE_CODE_TAKEN' : error.message || error.code || error);

  // The module's own codes are matched first: TEMPLATE_NOT_FOUND is more useful
  // than the generic NOT_FOUND it contains.
  const own = OWN_ERROR_KEYS.find((code) => raw.includes(code));
  if (own) return `vf_err_${own.toLowerCase()}`;

  const shared = Object.keys(SHARED_ERROR_KEYS).find((code) => raw.includes(code));
  if (shared) return SHARED_ERROR_KEYS[shared];

  if (raw.includes('DOCUMENT_CODE_ALLOCATION_FAILED')) return 'vf_err_code_allocation';
  return 'error_generic';
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ok = (data) => ({ data, error: null });
const fail = (error) => ({ data: null, error: error instanceof Error ? error : new Error(String(error)) });

const text = (value) => {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
};

const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isoOrNull = (value) => {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);

/** Field keys travel into a spreadsheet header, so keep them machine friendly. */
export const isValidFieldKey = (value) => /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(String(value || '').trim());

/** Normalised comparison used to match spreadsheet headers with field keys. */
export const normaliseHeader = (value) => String(value ?? '')
  .replace(/‏|‎/g, '')
  .trim()
  .toLowerCase()
  .replace(/[\s_-]+/g, '');

// ---------------------------------------------------------------------------
// Local preview mirror
// ---------------------------------------------------------------------------

const DEMO_KEY = 'bbnovix_verification_demo';
const DEMO_SLUG = 'shalfa';

const demoSeed = () => {
  const day = 86400000;
  const now = Date.now();
  const template = {
    id: 'demo-tpl-training',
    code: 'TRAINING',
    name_ar: 'شهادة حضور دورة تدريبية',
    name_en: 'Training attendance certificate',
    description_ar: 'قالب جاهز لشهادات الدورات التدريبية.',
    description_en: 'A ready template for training course certificates.',
    background_url: null,
    page_width_px: 1123,
    page_height_px: 794,
    orientation: 'Landscape',
    seal_style: 'Gold',
    display_order: 10,
    is_active: true,
  };

  const fields = [
    { id: 'demo-fld-1', template_id: template.id, field_key: 'recipient_name', label_ar: 'الاسم', label_en: 'Name', field_type: 'Text', pos_x_px: 0, pos_y_px: 330, width_px: 1123, height_px: 60, font_family: null, font_size_px: 44, font_weight: '800', color: '#0f2f52', align: 'Center', anchor: 'TopStart', default_value: null, is_required: true, display_order: 10 },
    { id: 'demo-fld-2', template_id: template.id, field_key: 'course_name', label_ar: 'الدورة التدريبية', label_en: 'Training course', field_type: 'Text', pos_x_px: 0, pos_y_px: 420, width_px: 1123, height_px: 40, font_family: null, font_size_px: 26, font_weight: '600', color: '#334155', align: 'Center', anchor: 'TopStart', default_value: null, is_required: true, display_order: 20 },
    { id: 'demo-fld-3', template_id: template.id, field_key: 'completion_date', label_ar: 'تاريخ الإتمام', label_en: 'Completion date', field_type: 'Date', pos_x_px: 90, pos_y_px: 640, width_px: 260, height_px: 32, font_family: null, font_size_px: 18, font_weight: '400', color: '#475569', align: 'Start', anchor: 'TopStart', default_value: null, is_required: false, display_order: 30 },
    { id: 'demo-fld-4', template_id: template.id, field_key: 'verification_qr', label_ar: 'رمز التحقق', label_en: 'Verification QR', field_type: 'QR', pos_x_px: 90, pos_y_px: 600, width_px: 110, height_px: 110, font_family: null, font_size_px: 16, font_weight: '400', color: '#0f2f52', align: 'Center', anchor: 'TopEnd', default_value: null, is_required: false, display_order: 40 },
  ];

  const documents = [
    {
      id: 'demo-doc-1',
      code: 'SHALFA-100000000001',
      doc_type: 'Letter',
      source_table: 'attestations',
      source_id: null,
      title_ar: 'خطاب تعريف بالخبرة',
      title_en: 'Experience letter',
      subject_ar: 'نفيد بأن الموظف على رأس العمل لدينا منذ عام 2021 ويشغل وظيفة مهندس تشغيل.',
      subject_en: 'This letter confirms the employee has been with us since 2021 as an Operations Engineer.',
      holder_employee_id: null,
      holder_name: 'أحمد محمد',
      issued_on: new Date(now - 12 * day).toISOString(),
      valid_until: new Date(now + 90 * day).toISOString(),
      status: 'Active',
      seal_style: 'Blue',
      file_url: null,
      file_mime: null,
      revoked_reason: null,
      revoked_on: null,
      metadata: {},
      created_on: new Date(now - 12 * day).toISOString(),
    },
    {
      id: 'demo-doc-2',
      code: 'SHALFA-100000000002',
      doc_type: 'Attestation',
      source_table: 'attestations',
      source_id: null,
      title_ar: 'تصديق على شهادة راتب',
      title_en: 'Salary certificate attestation',
      subject_ar: null,
      subject_en: null,
      holder_employee_id: null,
      holder_name: 'سارة خالد',
      issued_on: null,
      valid_until: null,
      status: 'Draft',
      seal_style: 'Gold',
      file_url: null,
      file_mime: null,
      revoked_reason: null,
      revoked_on: null,
      metadata: {},
      created_on: new Date(now - 2 * day).toISOString(),
    },
  ];

  return {
    documents,
    templates: [template],
    fields,
    certificates: [],
    batches: [],
    settings: { verification_enabled: true, verification_validity_days: 0 },
  };
};

const readDemo = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(DEMO_KEY) || 'null');
    if (stored && typeof stored === 'object' && Array.isArray(stored.documents)) return stored;
  } catch {
    // A corrupted mirror is simply replaced by a fresh seed.
  }
  const seed = demoSeed();
  writeDemo(seed);
  return seed;
};

function writeDemo(state) {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(state));
  } catch {
    // Preview only: a full storage must not break the screens.
  }
}

const demoCode = () => `${DEMO_SLUG.toUpperCase()}-${String(Math.floor(Math.random() * 9e11) + 1e11)}`;

const demoCompany = () => ({
  slug: DEMO_SLUG,
  names: { ar: 'شلفا', en: 'Shalfa' },
  short_names: { ar: 'شلفا', en: 'Shalfa' },
  logo_light_url: null,
  logo_dark_url: null,
});

const DEMO_EMPLOYEES = [
  { id: 'demo-employee-1', employee_no: '10001', full_name: 'أحمد محمد', full_name_ar: 'أحمد محمد', full_name_en: 'Ahmed Mohammed', email: 'ahmed@example.com' },
  { id: 'demo-employee-2', employee_no: '10024', full_name: 'سارة خالد', full_name_ar: 'سارة خالد', full_name_en: 'Sara Khalid', email: 'sara@example.com' },
  { id: 'demo-employee-3', employee_no: '10113', full_name: 'محمد علي', full_name_ar: 'محمد علي', full_name_en: 'Mohammed Ali', email: 'mohammed@example.com' },
  { id: 'demo-employee-4', employee_no: '10190', full_name: 'نورة عبدالله', full_name_ar: 'نورة عبدالله', full_name_en: 'Noura Abdullah', email: 'noura@example.com' },
];

// ---------------------------------------------------------------------------
// The public verification endpoint
// ---------------------------------------------------------------------------

/** Verdict of a payload, so the page and the service agree on one vocabulary. */
export const verdictOf = (result) => {
  if (!result) return 'NOT_FOUND';
  if (result.valid) return 'VALID';
  const reason = String(result.reason || 'NOT_FOUND').toUpperCase();
  return VERDICT_LABEL_KEYS[reason] ? reason : 'NOT_FOUND';
};

const demoVerify = (code) => {
  const state = readDemo();
  const document = state.documents.find((row) => row.code.toLowerCase() === code.toLowerCase());
  if (!document) return { valid: false, reason: 'NOT_FOUND', code };

  const expired = document.valid_until && new Date(document.valid_until).getTime() < Date.now();
  const reason = document.status === 'Revoked' ? 'REVOKED'
    : ['Draft', 'PendingApproval'].includes(document.status) ? 'NOT_PUBLISHED'
      : (document.status === 'Expired' || expired) ? 'EXPIRED' : null;

  return {
    valid: !reason,
    reason,
    code: document.code,
    source: 'document',
    doc_type: document.doc_type,
    status: document.status,
    seal_style: document.seal_style,
    title_ar: document.title_ar,
    title_en: document.title_en,
    subject_ar: document.subject_ar,
    subject_en: document.subject_en,
    holder_name: document.holder_name,
    reference_no: document.metadata?.reference_no || null,
    issued_on: document.issued_on,
    valid_until: document.valid_until,
    file_url: reason ? null : document.file_url,
    file_mime: reason ? null : document.file_mime,
    company: demoCompany(),
    timeline: [],
  };
};

/**
 * The only anonymous read in the module. `data` always carries a payload — an
 * unknown code is a result, not an error; `error` means the service itself
 * could not be reached.
 */
export const verifyDocument = async (code) => {
  const value = String(code || '').trim();
  if (value.length < 4) return ok({ valid: false, reason: 'NOT_FOUND', code: value });

  if (useLocalData || !supabase) return ok(demoVerify(value));

  try {
    const { data, error } = await supabase.rpc('verify_document', { p_code: value });
    if (error) return fail(new Error('VERIFY_FAILED'));
    return ok(data || { valid: false, reason: 'NOT_FOUND', code: value });
  } catch (thrown) {
    return fail(thrown);
  }
};

// ---------------------------------------------------------------------------
// Attestations and letters
// ---------------------------------------------------------------------------

const DOCUMENT_COLUMNS = [
  'id', 'code', 'doc_type', 'source_table', 'source_id', 'title_ar', 'title_en',
  'subject_ar', 'subject_en', 'holder_employee_id', 'holder_name', 'issued_on',
  'valid_until', 'status', 'seal_style', 'file_url', 'file_mime', 'file_size',
  'metadata', 'revoked_on', 'revoked_reason', 'created_on', 'updated_on',
].join(', ');

/**
 * @param {{ docTypes?: string[], limit?: number }} [options]
 * @returns {Promise<{data: Array, error: Error|null}>}
 */
export const loadDocuments = async ({ docTypes = null, limit = 300 } = {}) => {
  if (useLocalData || !supabase) {
    const rows = readDemo().documents
      .filter((row) => !docTypes || docTypes.includes(row.doc_type))
      .sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)));
    return ok(rows.slice(0, limit));
  }

  try {
    let query = supabase
      .from('verifiable_documents')
      .select(DOCUMENT_COLUMNS)
      .eq('is_deleted', false)
      .order('created_on', { ascending: false })
      .limit(limit);
    if (docTypes?.length) query = query.in('doc_type', docTypes);

    const { data, error } = await query;
    if (error) return fail(error);
    return ok(data || []);
  } catch (thrown) {
    return fail(thrown);
  }
};

/**
 * Creates or updates a manual attestation.
 * @param {object} draft screen state
 * @param {boolean} draft.submit send it straight into PendingApproval
 */
export const saveAttestation = async (draft) => {
  const payload = {
    id: draft.id || null,
    doc_type: MANUAL_DOC_TYPES.includes(draft.doc_type) ? draft.doc_type : 'Attestation',
    title_ar: text(draft.title_1),
    title_en: text(draft.title_2),
    subject_ar: text(draft.subject_1),
    subject_en: text(draft.subject_2),
    holder_employee_id: text(draft.holder_employee_id),
    holder_name: text(draft.holder_name),
    valid_until: isoOrNull(draft.valid_until),
    seal_style: SEAL_STYLES.includes(draft.seal_style) ? draft.seal_style : 'Blue',
    file_url: text(draft.file_url),
    file_mime: text(draft.file_mime),
    file_size: draft.file_size ? number(draft.file_size, null) : null,
    submit: Boolean(draft.submit),
  };

  if (!payload.title_ar) return fail(new Error('TITLE_REQUIRED'));

  if (useLocalData || !supabase) {
    const state = readDemo();
    const existing = state.documents.find((row) => row.id === payload.id);
    if (payload.id && !existing) return fail(new Error('DOCUMENT_NOT_FOUND'));
    if (existing && !['Draft', 'PendingApproval'].includes(existing.status)) return fail(new Error('DOCUMENT_LOCKED'));

    const status = payload.submit ? 'PendingApproval' : 'Draft';
    const row = {
      ...(existing || {
        id: uuid(),
        code: demoCode(),
        source_table: 'attestations',
        source_id: null,
        issued_on: null,
        revoked_on: null,
        revoked_reason: null,
        metadata: {},
        created_on: new Date().toISOString(),
      }),
      ...payload,
      status,
    };
    delete row.submit;

    state.documents = [row, ...state.documents.filter((item) => item.id !== row.id)];
    writeDemo(state);
    return ok({ id: row.id, code: row.code, status: row.status });
  }

  try {
    const { data, error } = await supabase.rpc('attestation_create', { p_payload: payload });
    if (error) return fail(error);
    return ok(data);
  } catch (thrown) {
    return fail(thrown);
  }
};

export const approveAttestation = async (id) => {
  if (useLocalData || !supabase) {
    const state = readDemo();
    const row = state.documents.find((item) => item.id === id);
    if (!row) return fail(new Error('DOCUMENT_NOT_FOUND'));
    if (!['Draft', 'PendingApproval'].includes(row.status)) return fail(new Error('DOCUMENT_NOT_PENDING'));
    row.status = 'Active';
    row.issued_on = row.issued_on || new Date().toISOString();
    row.revoked_on = null;
    row.revoked_reason = null;
    writeDemo(state);
    return ok({ id: row.id, code: row.code, status: row.status });
  }

  try {
    const { data, error } = await supabase.rpc('attestation_approve', { p_id: id });
    if (error) return fail(error);
    return ok(data);
  } catch (thrown) {
    return fail(thrown);
  }
};

export const revokeAttestation = async (id, reason) => {
  if (useLocalData || !supabase) {
    const state = readDemo();
    const row = state.documents.find((item) => item.id === id);
    if (!row) return fail(new Error('DOCUMENT_NOT_FOUND'));
    if (row.status === 'Revoked') return fail(new Error('DOCUMENT_ALREADY_REVOKED'));
    row.status = 'Revoked';
    row.revoked_on = new Date().toISOString();
    row.revoked_reason = text(reason);
    writeDemo(state);
    return ok({ id: row.id, code: row.code, status: row.status });
  }

  try {
    const { data, error } = await supabase.rpc('attestation_revoke', { p_id: id, p_reason: text(reason) });
    if (error) return fail(error);
    return ok(data);
  } catch (thrown) {
    return fail(thrown);
  }
};

// ---------------------------------------------------------------------------
// Certificate templates and their field layout
// ---------------------------------------------------------------------------

const TEMPLATE_COLUMNS = [
  'id', 'code', 'name_ar', 'name_en', 'description_ar', 'description_en',
  'background_url', 'background_provider', 'background_external_id',
  'page_width_px', 'page_height_px', 'orientation', 'seal_style',
  'display_order', 'is_active', 'created_on',
].join(', ');

const FIELD_COLUMNS = [
  'id', 'template_id', 'field_key', 'label_ar', 'label_en', 'field_type',
  'pos_x_px', 'pos_y_px', 'width_px', 'height_px', 'font_family', 'font_size_px',
  'font_weight', 'color', 'align', 'anchor', 'default_value', 'is_required', 'display_order',
].join(', ');

export const loadTemplates = async ({ activeOnly = false } = {}) => {
  if (useLocalData || !supabase) {
    const rows = readDemo().templates
      .filter((row) => !activeOnly || row.is_active)
      .sort((a, b) => (a.display_order - b.display_order) || String(a.code).localeCompare(String(b.code)));
    return ok(rows);
  }

  try {
    let query = supabase
      .from('certificate_templates')
      .select(TEMPLATE_COLUMNS)
      .eq('is_deleted', false)
      .order('display_order')
      .order('code');
    if (activeOnly) query = query.eq('is_active', true);

    const { data, error } = await query;
    if (error) return fail(error);
    return ok(data || []);
  } catch (thrown) {
    return fail(thrown);
  }
};

export const loadTemplateFields = async (templateId) => {
  if (!templateId) return ok([]);

  if (useLocalData || !supabase) {
    const rows = readDemo().fields
      .filter((row) => row.template_id === templateId)
      .sort((a, b) => a.display_order - b.display_order);
    return ok(rows);
  }

  try {
    const { data, error } = await supabase
      .from('certificate_template_fields')
      .select(FIELD_COLUMNS)
      .eq('template_id', templateId)
      .eq('is_deleted', false)
      .order('display_order');
    if (error) return fail(error);
    return ok(data || []);
  } catch (thrown) {
    return fail(thrown);
  }
};

const templatePayload = (template) => ({
  code: text(template.code) || `TPL-${Date.now().toString(36).toUpperCase()}`,
  name_ar: text(template.name_ar) || text(template.name_en) || text(template.code) || 'TEMPLATE',
  name_en: text(template.name_en),
  description_ar: text(template.description_ar),
  description_en: text(template.description_en),
  background_url: text(template.background_url),
  background_provider: text(template.background_provider),
  background_external_id: text(template.background_external_id),
  page_width_px: Math.max(Math.round(number(template.page_width_px, 1123)), 120),
  page_height_px: Math.max(Math.round(number(template.page_height_px, 794)), 120),
  orientation: template.orientation === 'Portrait' ? 'Portrait' : 'Landscape',
  seal_style: SEAL_STYLES.includes(template.seal_style) ? template.seal_style : 'Gold',
  display_order: Math.round(number(template.display_order, 0)),
  is_active: template.is_active !== false,
});

export const saveTemplate = async (template) => {
  const payload = templatePayload(template);

  if (useLocalData || !supabase) {
    const state = readDemo();
    const id = template.id || uuid();
    const row = { ...(state.templates.find((item) => item.id === id) || {}), ...payload, id };
    state.templates = [...state.templates.filter((item) => item.id !== id), row];
    writeDemo(state);
    return ok(row);
  }

  try {
    const query = template.id
      ? supabase.from('certificate_templates').update(payload).eq('id', template.id)
      : supabase.from('certificate_templates').insert(payload);
    const { data, error } = await query.select(TEMPLATE_COLUMNS).single();
    if (error) return fail(error);
    return ok(data);
  } catch (thrown) {
    return fail(thrown);
  }
};

export const deleteTemplate = async (templateId) => {
  if (useLocalData || !supabase) {
    const state = readDemo();
    state.templates = state.templates.filter((row) => row.id !== templateId);
    state.fields = state.fields.filter((row) => row.template_id !== templateId);
    writeDemo(state);
    return ok({ id: templateId });
  }

  try {
    const { error } = await supabase
      .from('certificate_templates')
      .update({ is_deleted: true })
      .eq('id', templateId);
    if (error) return fail(error);
    return ok({ id: templateId });
  } catch (thrown) {
    return fail(thrown);
  }
};

const fieldPayload = (field, templateId, index) => ({
  template_id: templateId,
  field_key: String(field.field_key || '').trim(),
  label_ar: text(field.label_ar),
  label_en: text(field.label_en),
  field_type: FIELD_TYPES.includes(field.field_type) ? field.field_type : 'Text',
  pos_x_px: Math.round(number(field.pos_x_px, 0) * 100) / 100,
  pos_y_px: Math.round(number(field.pos_y_px, 0) * 100) / 100,
  width_px: field.width_px == null || field.width_px === '' ? null : Math.round(number(field.width_px, 0) * 100) / 100,
  height_px: field.height_px == null || field.height_px === '' ? null : Math.round(number(field.height_px, 0) * 100) / 100,
  font_family: text(field.font_family),
  font_size_px: Math.max(number(field.font_size_px, 16), 4),
  font_weight: FONT_WEIGHTS.includes(String(field.font_weight)) ? String(field.font_weight) : '400',
  color: text(field.color) || '#111827',
  align: FIELD_ALIGNMENTS.includes(field.align) ? field.align : 'Start',
  anchor: FIELD_ANCHORS.includes(field.anchor) ? field.anchor : 'TopStart',
  default_value: text(field.default_value),
  is_required: Boolean(field.is_required),
  display_order: Math.round(number(field.display_order, (index + 1) * 10)),
});

/**
 * Stores the whole layout in one call: the designer always owns the complete
 * field list, so removed fields are retired here rather than one by one.
 */
export const saveTemplateFields = async (templateId, fields) => {
  const rows = (fields || []).map((field, index) => ({ id: field.id, ...fieldPayload(field, templateId, index) }));

  const invalid = rows.find((row) => !isValidFieldKey(row.field_key));
  if (invalid) return fail(new Error('FIELD_KEY_INVALID'));

  const keys = rows.map((row) => row.field_key.toLowerCase());
  if (new Set(keys).size !== keys.length) return fail(new Error('FIELD_KEY_TAKEN'));

  if (useLocalData || !supabase) {
    const state = readDemo();
    const stored = rows.map((row) => ({ ...row, id: row.id || uuid() }));
    state.fields = [...state.fields.filter((row) => row.template_id !== templateId), ...stored];
    writeDemo(state);
    return ok(stored);
  }

  try {
    const { data: existing, error: readError } = await supabase
      .from('certificate_template_fields')
      .select('id')
      .eq('template_id', templateId)
      .eq('is_deleted', false);
    if (readError) return fail(readError);

    const keptIds = new Set(rows.filter((row) => row.id).map((row) => row.id));
    const removed = (existing || []).filter((row) => !keptIds.has(row.id)).map((row) => row.id);

    if (removed.length) {
      const { error } = await supabase
        .from('certificate_template_fields')
        .update({ is_deleted: true })
        .in('id', removed);
      if (error) return fail(error);
    }

    for (const row of rows) {
      const { id, ...values } = row;
      const query = id
        ? supabase.from('certificate_template_fields').update(values).eq('id', id)
        : supabase.from('certificate_template_fields').insert(values);
      const { error } = await query;
      if (error) return fail(error);
    }

    return loadTemplateFields(templateId);
  } catch (thrown) {
    return fail(thrown);
  }
};

// ---------------------------------------------------------------------------
// Issuing certificates
// ---------------------------------------------------------------------------

/**
 * @param {string} templateId
 * @param {Array<object>} rows one object per certificate; the first row also
 *   carries `batch_name` and `source_file_name` for the batch record.
 */
export const issueCertificates = async (templateId, rows) => {
  if (!templateId) return fail(new Error('TEMPLATE_NOT_FOUND'));
  if (!Array.isArray(rows) || rows.length === 0) return fail(new Error('NO_ROWS'));
  if (rows.length > MAX_SHEET_ROWS) return fail(new Error('TOO_MANY_ROWS'));

  if (useLocalData || !supabase) {
    const state = readDemo();
    const template = state.templates.find((row) => row.id === templateId);
    if (!template) return fail(new Error('TEMPLATE_NOT_FOUND'));
    if (!template.is_active) return fail(new Error('TEMPLATE_INACTIVE'));

    const batchId = uuid();
    const codes = [];
    const errors = [];

    rows.forEach((row, index) => {
      const name = text(row.recipient_name) || text(row.name) || text(row.full_name);
      if (!name) {
        errors.push({ row: index + 1, error: 'RECIPIENT_NAME_REQUIRED' });
        return;
      }
      const certificateId = uuid();
      const code = demoCode();
      const issuedOn = isoOrNull(row.issued_on) || new Date().toISOString();
      const validUntil = isoOrNull(row.valid_until);

      state.documents = [{
        id: uuid(),
        code,
        doc_type: 'Certificate',
        source_table: 'certificates',
        source_id: certificateId,
        title_ar: template.name_ar,
        title_en: template.name_en,
        subject_ar: null,
        subject_en: null,
        holder_employee_id: text(row.recipient_employee_id),
        holder_name: name,
        issued_on: issuedOn,
        valid_until: validUntil,
        status: 'Active',
        seal_style: template.seal_style,
        file_url: null,
        file_mime: null,
        revoked_on: null,
        revoked_reason: null,
        metadata: { template_id: templateId, batch_id: batchId },
        created_on: issuedOn,
      }, ...state.documents];

      state.certificates = [{
        id: certificateId,
        template_id: templateId,
        batch_id: batchId,
        document_id: null,
        code,
        recipient_name: name,
        recipient_employee_id: text(row.recipient_employee_id),
        data_json: row,
        issued_on: issuedOn,
        valid_until: validUntil,
        status: 'Active',
      }, ...state.certificates];

      codes.push({ row: index + 1, certificate_id: certificateId, code, recipient_name: name });
    });

    state.batches = [{
      id: batchId,
      template_id: templateId,
      total_rows: rows.length,
      generated_rows: codes.length,
      failed_rows: errors.length,
      status: codes.length ? 'Completed' : 'Failed',
      created_on: new Date().toISOString(),
    }, ...state.batches];

    writeDemo(state);
    return ok({
      batch_id: batchId,
      total_rows: rows.length,
      generated_rows: codes.length,
      failed_rows: errors.length,
      codes,
      errors,
    });
  }

  try {
    const { data, error } = await supabase.rpc('certificate_issue', { p_template_id: templateId, p_rows: rows });
    if (error) return fail(error);
    return ok(data);
  } catch (thrown) {
    return fail(thrown);
  }
};

/** Issued certificates with the code of the document each one published. */
export const loadCertificates = async ({ templateId = null, limit = 300 } = {}) => {
  if (useLocalData || !supabase) {
    const rows = readDemo().certificates
      .filter((row) => !templateId || row.template_id === templateId)
      .slice(0, limit);
    return ok(rows);
  }

  try {
    let query = supabase
      .from('certificates')
      .select('id, template_id, batch_id, document_id, recipient_name, recipient_employee_id, data_json, issued_on, valid_until, status')
      .eq('is_deleted', false)
      .order('issued_on', { ascending: false })
      .limit(limit);
    if (templateId) query = query.eq('template_id', templateId);

    const { data, error } = await query;
    if (error) return fail(error);

    const rows = data || [];
    const documentIds = rows.map((row) => row.document_id).filter(Boolean);
    if (!documentIds.length) return ok(rows.map((row) => ({ ...row, code: null })));

    // Two round trips instead of an embed: `certificates` carries two foreign
    // keys to `verifiable_documents`, so an embedded select would be ambiguous.
    const { data: documents, error: documentError } = await supabase
      .from('verifiable_documents')
      .select('id, code, status, seal_style, valid_until')
      .in('id', documentIds);
    if (documentError) return ok(rows.map((row) => ({ ...row, code: null })));

    const byId = new Map((documents || []).map((row) => [row.id, row]));
    return ok(rows.map((row) => ({
      ...row,
      code: byId.get(row.document_id)?.code || null,
      seal_style: byId.get(row.document_id)?.seal_style || 'Gold',
      document_status: byId.get(row.document_id)?.status || row.status,
    })));
  } catch (thrown) {
    return fail(thrown);
  }
};

// ---------------------------------------------------------------------------
// Company settings and lookups
// ---------------------------------------------------------------------------

export const loadVerificationSettings = async (tenantId) => {
  if (useLocalData || !supabase) return ok(readDemo().settings);

  try {
    const { data, error } = await supabase
      .from('tenant_settings')
      .select('verification_enabled, verification_validity_days')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) return fail(error);
    return ok(data || { verification_enabled: true, verification_validity_days: 0 });
  } catch (thrown) {
    return fail(thrown);
  }
};

export const saveVerificationSettings = async (tenantId, settings) => {
  const payload = {
    verification_enabled: settings.verification_enabled !== false,
    verification_validity_days: Math.max(Math.round(number(settings.verification_validity_days, 0)), 0),
  };

  if (useLocalData || !supabase) {
    const state = readDemo();
    state.settings = payload;
    writeDemo(state);
    return ok(payload);
  }

  if (!tenantId) return fail(new Error('NO_ACTIVE_TENANT'));

  try {
    const { data, error } = await supabase
      .from('tenant_settings')
      .upsert({ tenant_id: tenantId, ...payload }, { onConflict: 'tenant_id' })
      .select('verification_enabled, verification_validity_days')
      .single();
    if (error) return fail(error);
    return ok(data);
  } catch (thrown) {
    return fail(thrown);
  }
};

/** The employee directory used by the holder and recipient pickers. */
export const loadEmployees = async () => {
  if (useLocalData || !supabase) return ok(DEMO_EMPLOYEES);

  try {
    // Display columns only — public.users itself is not readable by colleagues.
    const { data, error } = await supabase.rpc('employee_directory', {
      p_query: null,
      p_limit: 1000,
    });
    if (error) return fail(error);
    // The pickers read full_name_{lang}; the directory returns the employee
    // record's own name_ar / name_en, so map them onto the expected shape.
    return ok((data || []).map((row) => ({
      ...row,
      full_name_ar: row.name_ar || row.full_name,
      full_name_en: row.name_en || row.full_name,
    })));
  } catch (thrown) {
    return fail(thrown);
  }
};

/**
 * One upload path for both screens: quota check, provider, registration — all
 * of it lives in the storage layer, never here.
 */
export const uploadVerificationFile = async ({ tenantId, area, file, entityType = null, entityId = null }) => {
  if (!file) return fail(new Error('error_generic'));
  const { data, error } = await putFile({
    layer: STORAGE_LAYER.EXTENDED,
    tenantId,
    area,
    file,
    entityType,
    entityId,
  });
  if (error) return fail(error);
  return ok(data);
};
