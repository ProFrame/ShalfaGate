// Data access for the platform operator console.
//
// Every screen under /platform/app/platform reads through this file and nothing
// else. House rules honoured here:
//
//   * no component imports `supabase` — it imports this file;
//   * every function returns `{ data, error }` and never throws;
//   * `useLocalData` keeps the local preview fully usable without a backend;
//   * errors surface as SCREAMING_SNAKE codes the caller hands to `t()`.
//
// The server side lives in migration 202608040018 and 202608040012:
//   platform_overview, platform_tenant_detail, platform_set_tenant_status,
//   platform_set_module, platform_set_quota, platform_set_license,
//   platform_health, platform_usage, tenant_usage_snapshot,
//   storage_overview, storage_set_tenant_config,
//   support_console, support_ticket_detail, support_reply,
//   support_ticket_set_status.

import { supabase, useLocalData } from '../lib/supabaseClient';
import { errorFromMessage } from './serviceEnvelope';

// ---------------------------------------------------------------------------
// Reference codes. Values are CODES; every label is resolved at render time.
// ---------------------------------------------------------------------------

export const TENANT_STATUSES = ['Pending', 'Active', 'Suspended', 'Disabled', 'Deleted'];

/** The three transitions the console offers, in the order the plan lists them. */
export const TENANT_STATUS_ACTIONS = ['Active', 'Suspended', 'Disabled'];

export const SUPPORT_STATUSES = ['Open', 'InProgress', 'Answered', 'Closed'];
export const SUPPORT_SOURCES = ['Public', 'InApp'];
export const SUPPORT_CATEGORIES = [
  'technical', 'subscription', 'account', 'feature', 'billing', 'other',
];

export const STORAGE_LAYERS = ['Core', 'Extended'];
export const STORAGE_STATUSES = ['NotConfigured', 'Suspended', 'Ok', 'Failed', 'Unknown'];

export const USAGE_PERIODS = [7, 30, 90, 365];

/** Metrics written by tenant_usage_snapshot, in the order the plan lists them. */
export const USAGE_METRICS = [
  'ACTIVE_USERS_30D', 'USERS', 'ACTIVE_USERS', 'LOGINS_30D', 'LOGINS_TODAY',
  'STORAGE_BYTES', 'FILES', 'FORMS_SUBMITTED', 'FORMS_TOTAL', 'DOCUMENTS',
  'CHAT_MESSAGES', 'NOTIFICATIONS_SENT', 'EMAILS_SENT', 'EMAILS_TODAY',
  'API_CALLS', 'OPEN_TICKETS',
];

/** Metrics measured in bytes rather than a plain count. */
export const BYTE_METRICS = new Set(['STORAGE_BYTES']);

export const MEGABYTE = 1024 * 1024;

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const ok = (data) => ({ data, error: null });
const fail = (code) => ({ data: null, error: new Error(code) });

/**
 * Postgres raises SCREAMING_SNAKE codes, the network layer raises prose.
 * Either way the caller only ever sees a code it can translate.
 */
const asCode = errorFromMessage;

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The lowercase code a screen appends to `pc_err_` when translating a failure.
 * Callers do `codeLabel(t, 'pc_err', errorCode(error), t('error_generic'))`.
 */
export const errorCode = (error) => {
  const raw = String(error?.message || '').trim();
  const match = raw.match(/[A-Z][A-Z0-9_]{3,}/);
  return (match ? match[0] : 'LOAD_FAILED').toLowerCase();
};

const callRpc = async (name, args, fallbackCode) => {
  if (!supabase) return fail('SERVICE_NOT_CONFIGURED');
  const { data, error } = await supabase.rpc(name, args);
  if (error) return { data: null, error: asCode(error, fallbackCode) };
  return ok(data);
};

/**
 * Whether the signed-in identity may operate the platform. The database is the
 * real gate (`is_platform_operator()` inside every RPC); this only decides
 * whether the console renders or explains itself.
 */
export const canOperatePlatform = ({ roleCode, isPlatformTenant }) => {
  if (!isPlatformTenant) return false;
  if (useLocalData) return true;   // local preview has no roles to check against
  return roleCode === 'PLATFORM_OPERATOR';
};

export const isPreviewMode = () => useLocalData || !supabase;

// ---------------------------------------------------------------------------
// Demo data — shaped exactly like the RPC payloads so the screens never branch.
// ---------------------------------------------------------------------------

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
const dayOnly = (days) => daysAgo(days).slice(0, 10);

const demoTenantSeed = [
  { slug: 'platform', ar: 'بي بي نوفكس', en: 'bbnovix', status: 'Active', license: 'PRO', users: 6, active: 6, bytes: 48 * MEGABYTE, age: 210, platform: true },
  { slug: 'shalfa', ar: 'شلفا', en: 'Shalfa', status: 'Active', license: 'FREE', users: 412, active: 288, bytes: 1820 * MEGABYTE, age: 195 },
  { slug: 'nawa', ar: 'نواة', en: 'Nawa Holding', status: 'Active', license: 'PRO', users: 168, active: 121, bytes: 940 * MEGABYTE, age: 120 },
  { slug: 'atlas', ar: 'أطلس', en: 'Atlas Facilities', status: 'Active', license: 'FREE', users: 74, active: 39, bytes: 305 * MEGABYTE, age: 76 },
  { slug: 'medina', ar: 'المدينة', en: 'Medina Care', status: 'Suspended', license: 'FREE', users: 31, active: 4, bytes: 96 * MEGABYTE, age: 54 },
  { slug: 'gold', ar: 'الذهبية', en: 'Golden Line', status: 'Pending', license: 'FREE', users: 3, active: 0, bytes: 2 * MEGABYTE, age: 6 },
];

const demoTenantId = (slug) => `demo-tenant-${slug}`;

const demoTopTenants = () => demoTenantSeed.map((row) => ({
  tenant_id: demoTenantId(row.slug),
  slug: row.slug,
  status: row.status,
  names: { ar: row.ar, en: row.en },
  users: row.users,
  active_users: row.active,
  storage_bytes: row.bytes,
  license_code: row.license,
  created_on: daysAgo(row.age),
}));

const demoOverview = () => ({
  tenants: {
    total: demoTenantSeed.length,
    active: demoTenantSeed.filter((row) => row.status === 'Active').length,
    pending: demoTenantSeed.filter((row) => row.status === 'Pending').length,
    suspended: demoTenantSeed.filter((row) => row.status === 'Suspended').length,
    disabled: 0,
    platform: 1,
    new_30d: 1,
  },
  users: { total: 694, active: 641, active_30d: 458, never_logged_in: 53 },
  storage: {
    bytes: demoTenantSeed.reduce((sum, row) => sum + row.bytes, 0),
    files: 8412,
    core_bytes: 320 * MEGABYTE,
    extended_bytes: 2891 * MEGABYTE,
  },
  forms: { total: 5820, submitted: 4931, submitted_30d: 612, approved: 4102 },
  emails: { sent: 12840, pending: 18, failed: 6, sent_30d: 1908 },
  support: { open: 7, unanswered: 2, closed: 141, total: 148 },
  chat_messages: 96430,
  notifications: 41288,
  logins: { today: 96, last_30d: 5820, failures_24h: 11 },
  top_tenants: demoTopTenants(),
});

const demoModules = (licenseCode) => {
  const catalogue = [
    ['EMPLOYEE_PORTAL', 'منصة العمل الرقمية', 'Digital Workplace Platform', 'Core', true],
    ['FORMS', 'النماذج', 'Forms', 'Core', true],
    ['APPROVALS', 'الموافقات', 'Approvals', 'Core', true],
    ['DOCUMENTS', 'الوثائق', 'Documents', 'Content', false],
    ['ANNOUNCEMENTS', 'الإعلانات', 'Announcements', 'Engagement', false],
    ['CALENDAR', 'التقويم', 'Calendar', 'Engagement', false],
    ['SURVEY', 'الاستطلاعات', 'Survey', 'Engagement', false],
    ['NOTES', 'المفكرة', 'Notes', 'Productivity', false],
    ['CHAT', 'الدردشة', 'Chat', 'Collaboration', false],
    ['PERFORMANCE', 'إدارة الأداء', 'Performance', 'HR', false],
    ['KNOWLEDGE_BASE', 'قاعدة المعرفة', 'Knowledge Base', 'Content', false],
    ['CERTIFICATES', 'الشهادات', 'Certificates', 'Verification', false],
    ['VERIFICATION', 'التحقق من الوثائق', 'Verification', 'Verification', false],
    ['SUPPORT', 'الدعم الفني', 'Support', 'Service', false],
    ['MARKETPLACE', 'متجر القوالب', 'Template Marketplace', 'Content', false],
    ['STORAGE_EXTENDED', 'التخزين الإضافي', 'Extended Storage', 'Platform', false],
    ['PUBLIC_API', 'الواجهة البرمجية', 'Public API', 'Platform', false],
    ['AI', 'الذكاء الاصطناعي', 'AI', 'Platform', false],
  ];
  const proOnly = ['KNOWLEDGE_BASE', 'MARKETPLACE', 'STORAGE_EXTENDED', 'PUBLIC_API', 'AI'];
  return catalogue.map(([code, nameAr, nameEn, category, isCore]) => {
    const inLicense = licenseCode === 'PRO' || !proOnly.includes(code);
    return {
      code,
      name_ar: nameAr,
      name_en: nameEn,
      category,
      is_core: isCore,
      in_license: inLicense,
      enabled: inLicense && code !== 'AI',
      override: code === 'AI' && inLicense ? false : null,
    };
  });
};

const demoQuotas = (users, bytes) => ([
  ['STORAGE_BYTES', 'مساحة التخزين', 'Storage', 'bytes', 5 * 1024 * MEGABYTE, bytes],
  ['EMPLOYEES', 'الموظفون', 'Employees', 'count', 500, users],
  ['DEPARTMENTS', 'الإدارات', 'Departments', 'count', 100, 24],
  ['PROJECTS', 'المشاريع', 'Projects', 'count', 100, 17],
  ['SITES', 'المواقع', 'Sites', 'count', 200, 31],
  ['FORMS', 'الطلبات', 'Forms', 'count', 20000, 5820],
  ['TEMPLATES', 'القوالب', 'Templates', 'count', 100, 12],
  ['DOCUMENTS', 'الوثائق', 'Documents', 'count', 2000, 486],
  ['CERTIFICATES', 'الشهادات', 'Certificates', 'count', 2000, 148],
  ['CHAT_MESSAGES', 'رسائل الدردشة', 'Chat messages', 'count', 200000, 96430],
  ['ANNOUNCEMENTS', 'الإعلانات', 'Announcements', 'count', 500, 61],
  ['SURVEYS', 'الاستطلاعات', 'Surveys', 'count', 200, 14],
  ['EMAILS_PER_DAY', 'الرسائل البريدية يومياً', 'Emails per day', 'per_day', 200, 96],
  ['API_CALLS', 'طلبات الواجهة البرمجية', 'API calls', 'per_day', 10000, 1240],
  ['NOTIFICATIONS', 'الإشعارات', 'Notifications', 'count', 100000, 41288],
].map(([code, nameAr, nameEn, unit, limit, used]) => ({
  code,
  name_ar: nameAr,
  name_en: nameEn,
  unit,
  limit,
  used,
  enforced: true,
  percent: limit > 0 ? Math.round((used * 10000) / limit) / 100 : null,
})));

const demoTenantDetail = (tenantId) => {
  const seed = demoTenantSeed.find((row) => demoTenantId(row.slug) === tenantId) || demoTenantSeed[1];
  return {
    tenant: {
      id: tenantId,
      slug: seed.slug,
      code: seed.slug.toUpperCase(),
      legal_name: seed.en,
      status: seed.status,
      license_code: seed.license,
      default_language: 'ar',
      timezone: 'Asia/Riyadh',
      country_code: 'SA',
      tax_number: '3001234567890003',
      commercial_register: '1010123456',
      industry: 'facilities',
      employee_range: 'medium',
      is_platform: Boolean(seed.platform),
      activated_on: daysAgo(seed.age - 1),
      suspended_on: seed.status === 'Suspended' ? daysAgo(9) : null,
      suspended_reason: seed.status === 'Suspended' ? 'Subscription renewal pending' : null,
      created_on: daysAgo(seed.age),
    },
    names: { ar: seed.ar, en: seed.en },
    branding: {
      primary_color: '#1b4f82',
      support_email: `support@${seed.slug}.example`,
      website_url: `https://${seed.slug}.example`,
      address_ar: 'الرياض، المملكة العربية السعودية',
      address_en: 'Riyadh, Saudi Arabia',
      map_url: null,
    },
    settings: {
      chat_private_enabled: true,
      chat_groups_enabled: true,
      chat_attachments_enabled: seed.license === 'PRO',
      chat_max_attachment_mb: 5,
      chat_allowed_file_types: ['image/png', 'image/jpeg', 'application/pdf'],
      extended_storage_enabled: seed.license === 'PRO',
      storage_provider: seed.license === 'PRO' ? 'supabase' : 'none',
    },
    contacts: [
      { channel: 'email', value: `info@${seed.slug}.example`, display_order: 10 },
      { channel: 'mobile', value: '+966500000000', display_order: 20 },
      { channel: 'website', value: `https://${seed.slug}.example`, display_order: 30 },
    ],
    license: { code: seed.license, name_ar: seed.license === 'PRO' ? 'الاحترافية' : 'المجانية', name_en: seed.license === 'PRO' ? 'Pro' : 'Free' },
    licenses: [
      { code: 'FREE', name_ar: 'المجانية', name_en: 'Free' },
      { code: 'PRO', name_ar: 'الاحترافية', name_en: 'Pro' },
    ],
    modules: demoModules(seed.license),
    quotas: demoQuotas(seed.users, seed.bytes),
    users: { total: seed.users, active: seed.active, invited: 4, active_30d: seed.active, last_login: daysAgo(1) },
    storage: {
      files: 1204,
      bytes: seed.bytes,
      images: 486,
      documents: 610,
      chat_attachments: 108,
      provider: seed.license === 'PRO' ? 'supabase' : null,
      allocated: 5 * 1024 * MEGABYTE,
      status: seed.license === 'PRO' ? 'Ok' : 'NotConfigured',
    },
    activity: {
      created_on: daysAgo(seed.age),
      activated_on: daysAgo(seed.age - 1),
      last_login: daysAgo(1),
      last_form_on: daysAgo(2),
      forms_30d: 118,
      emails_30d: 402,
      open_tickets: 2,
    },
    usage: [],
  };
};

const demoStorageOverview = () => ({
  totals: {
    tenants: demoTenantSeed.length,
    files: 8412,
    bytes: demoTenantSeed.reduce((sum, row) => sum + row.bytes, 0),
    images: 3120,
    documents: 4218,
    chat_attachments: 1074,
    core_bytes: 320 * MEGABYTE,
    extended_bytes: 2891 * MEGABYTE,
  },
  providers: [
    { code: 'supabase', name_ar: 'تخزين Supabase', name_en: 'Supabase Storage', kind: 'Both', is_active: true, tenants: 3, bytes: 2100 * MEGABYTE },
    { code: 'google_drive', name_ar: 'جوجل درايف', name_en: 'Google Drive', kind: 'Extended', is_active: true, tenants: 1, bytes: 940 * MEGABYTE },
    { code: 'onedrive', name_ar: 'ون درايف', name_en: 'OneDrive', kind: 'Extended', is_active: true, tenants: 0, bytes: 0 },
    { code: 's3', name_ar: 'أمازون S3', name_en: 'Amazon S3', kind: 'Extended', is_active: true, tenants: 0, bytes: 0 },
    { code: 'r2', name_ar: 'كلاودفلير R2', name_en: 'Cloudflare R2', kind: 'Extended', is_active: false, tenants: 0, bytes: 0 },
  ],
  tenants: demoTenantSeed.map((row) => ({
    tenant_id: demoTenantId(row.slug),
    slug: row.slug,
    status: row.status,
    names: { ar: row.ar, en: row.en },
    provider: row.license === 'PRO' ? 'supabase' : null,
    storage_status: row.license === 'PRO' ? 'Ok' : 'NotConfigured',
    extended_enabled: row.license === 'PRO',
    chat_attachments_enabled: row.license === 'PRO',
    allocated_bytes: 5 * 1024 * MEGABYTE,
    used_bytes: row.bytes,
    percent: Math.round((row.bytes * 10000) / (5 * 1024 * MEGABYTE)) / 100,
    files: Math.round(row.bytes / (250 * 1024)),
    images: Math.round(row.bytes / (700 * 1024)),
    documents: Math.round(row.bytes / (520 * 1024)),
    chat_attachments: Math.round(row.bytes / (3 * MEGABYTE)),
    last_check_on: daysAgo(1),
  })),
});

const demoStoragePolicies = () => ([
  {
    layer: 'Core',
    max_file_bytes: 5 * MEGABYTE,
    allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml', 'image/x-icon'],
    default_quota_bytes: 50 * MEGABYTE,
    notes: 'Platform paid. Logos, cover images, avatars and signatures only.',
  },
  {
    layer: 'Extended',
    max_file_bytes: 25 * MEGABYTE,
    allowed_mime_types: ['image/*', 'application/pdf', 'text/plain', 'text/csv', 'application/zip'],
    default_quota_bytes: 200 * MEGABYTE,
    notes: 'Company provider or platform granted space.',
  },
]);

const demoTickets = () => ([
  {
    id: 'demo-ticket-1', ticket_no: 'BBX-2026-100241', source: 'Public', category: 'subscription',
    status: 'Open', priority: 'Normal', subject: 'Upgrade to the Pro plan',
    body: 'We would like to move our workspace to the Pro plan before the new quarter starts.',
    requester_name: 'Sara Al Otaibi', requester_email: 'sara@atlas.example', requester_user_id: null,
    assigned_to: null, tenant_id: demoTenantId('platform'), tenant_slug: 'platform',
    requester_tenant_id: demoTenantId('atlas'), requester_tenant_slug: 'atlas',
    tenant_names: { ar: 'أطلس', en: 'Atlas Facilities' },
    message_count: 1, last_message_on: daysAgo(1), first_response_on: null,
    closed_on: null, created_on: daysAgo(1),
  },
  {
    id: 'demo-ticket-2', ticket_no: 'BBX-2026-100238', source: 'InApp', category: 'technical',
    status: 'InProgress', priority: 'High', subject: 'Chat attachments are refused',
    body: 'Uploading a PDF into a group chat returns a refusal message.',
    requester_name: 'أحمد العمري', requester_email: 'ahmed@shalfa.example', requester_user_id: 'demo-user',
    assigned_to: 'demo-user', tenant_id: demoTenantId('shalfa'), tenant_slug: 'shalfa',
    requester_tenant_id: demoTenantId('shalfa'), requester_tenant_slug: 'shalfa',
    tenant_names: { ar: 'شلفا', en: 'Shalfa' },
    message_count: 3, last_message_on: daysAgo(2), first_response_on: daysAgo(3),
    closed_on: null, created_on: daysAgo(4),
  },
  {
    id: 'demo-ticket-3', ticket_no: 'BBX-2026-100219', source: 'Public', category: 'account',
    status: 'Closed', priority: 'Normal', subject: 'Password setup link expired',
    body: 'The invitation link we received is no longer valid.',
    requester_name: 'Nora Hassan', requester_email: 'nora@medina.example', requester_user_id: null,
    assigned_to: null, tenant_id: demoTenantId('medina'), tenant_slug: 'medina',
    requester_tenant_id: demoTenantId('medina'), requester_tenant_slug: 'medina',
    tenant_names: { ar: 'المدينة', en: 'Medina Care' },
    message_count: 4, last_message_on: daysAgo(12), first_response_on: daysAgo(13),
    closed_on: daysAgo(12), created_on: daysAgo(14),
  },
]);

const demoThreads = {
  'demo-ticket-1': [
    { id: 'm1', author_type: 'Requester', author_name: 'Sara Al Otaibi', body: 'We would like to move our workspace to the Pro plan before the new quarter starts.', is_internal: false, created_on: daysAgo(1) },
  ],
  'demo-ticket-2': [
    { id: 'm1', author_type: 'Requester', author_name: 'أحمد العمري', body: 'رفع ملف PDF داخل مجموعة يرفض العملية ويظهر تنبيه.', is_internal: false, created_on: daysAgo(4) },
    { id: 'm2', author_type: 'Operator', author_name: 'bbnovix', body: 'شكراً لك، نراجع إعدادات المرفقات لشركتكم الآن.', is_internal: false, created_on: daysAgo(3) },
    { id: 'm3', author_type: 'Operator', author_name: 'bbnovix', body: 'Extended storage is off for this company; the licence needs raising first.', is_internal: true, created_on: daysAgo(2) },
  ],
  'demo-ticket-3': [
    { id: 'm1', author_type: 'Requester', author_name: 'Nora Hassan', body: 'The invitation link we received is no longer valid.', is_internal: false, created_on: daysAgo(14) },
    { id: 'm2', author_type: 'Operator', author_name: 'bbnovix', body: 'A new invitation has been sent. Please check the inbox.', is_internal: false, created_on: daysAgo(13) },
  ],
};

const demoHealth = () => ({
  measured_on: new Date().toISOString(),
  host: { cpu_percent: null, memory_percent: null, available: false },
  database: {
    name: 'bbnovix',
    size_bytes: 1842 * MEGABYTE,
    tables: 96,
    live_rows: 1284310,
    connections: 14,
    largest_tables: [
      { table: 'chat_messages', rows: 96430, size_bytes: 412 * MEGABYTE },
      { table: 'forms', rows: 5820, size_bytes: 186 * MEGABYTE },
      { table: 'notifications', rows: 41288, size_bytes: 122 * MEGABYTE },
      { table: 'audit_logs', rows: 210440, size_bytes: 96 * MEGABYTE },
      { table: 'storage_objects', rows: 8412, size_bytes: 42 * MEGABYTE },
    ],
  },
  storage: { files: 8412, bytes: 3211 * MEGABYTE, tenants_with_provider: 3, providers_failing: 0 },
  emails: {
    by_status: { Sent: 12840, Pending: 18, Failed: 6 },
    queue_depth: 18,
    failed: 6,
    oldest_pending_on: daysAgo(0.02),
    stuck_processing: 0,
  },
  jobs: { imports_failed: 1, imports_running: 0, last_usage_snapshot: dayOnly(0) },
  support: { open: 7, unanswered_24h: 2 },
  security: { failed_logins_24h: 11, critical_events_7d: 0 },
});

const demoUsage = (days) => {
  const span = Math.min(days, 90);
  const daily = [];
  const metrics = ['ACTIVE_USERS_30D', 'LOGINS_30D', 'FORMS_SUBMITTED', 'CHAT_MESSAGES', 'EMAILS_SENT', 'STORAGE_BYTES'];
  for (let index = span; index >= 0; index -= 1) {
    const wobble = 1 + Math.sin(index / 4) * 0.08;
    metrics.forEach((metric) => {
      const base = {
        ACTIVE_USERS_30D: 458, LOGINS_30D: 5820, FORMS_SUBMITTED: 4931,
        CHAT_MESSAGES: 96430, EMAILS_SENT: 12840, STORAGE_BYTES: 3211 * MEGABYTE,
      }[metric];
      daily.push({
        usage_date: dayOnly(index),
        metric_code: metric,
        metric_value: Math.round(base * wobble * (1 - index / (span * 12 || 1))),
      });
    });
  }
  return {
    from: dayOnly(days),
    to: dayOnly(0),
    daily,
    by_tenant: demoTenantSeed.map((row) => ({
      tenant_id: demoTenantId(row.slug),
      slug: row.slug,
      metrics: {
        USERS: row.users,
        ACTIVE_USERS: row.active,
        ACTIVE_USERS_30D: row.active,
        LOGINS_TODAY: Math.round(row.active / 6),
        LOGINS_30D: row.active * 14,
        STORAGE_BYTES: row.bytes,
        FILES: Math.round(row.bytes / (250 * 1024)),
        FORMS_TOTAL: row.users * 14,
        FORMS_SUBMITTED: row.users * 11,
        DOCUMENTS: row.users * 2,
        CHAT_MESSAGES: row.users * 230,
        NOTIFICATIONS_SENT: row.users * 96,
        EMAILS_SENT: row.users * 31,
        EMAILS_TODAY: Math.round(row.users / 4),
        API_CALLS: row.users * 8,
        OPEN_TICKETS: row.status === 'Active' ? 1 : 0,
      },
      last_login: row.active ? daysAgo(1) : null,
    })),
  };
};

// Preview edits are kept in memory so a toggle in local mode behaves like a
// toggle rather than snapping back on the next read.
const previewOverrides = { modules: {}, quotas: {}, settings: {}, statuses: {}, licenses: {}, storage: {}, policies: {}, tickets: {} };

// ---------------------------------------------------------------------------
// Overview, companies and the company file
// ---------------------------------------------------------------------------

/** public.platform_overview() */
export const loadPlatformOverview = async () => {
  if (isPreviewMode()) {
    await delay(240);
    const data = demoOverview();
    data.top_tenants = data.top_tenants.map((row) => ({
      ...row,
      status: previewOverrides.statuses[row.tenant_id] || row.status,
      license_code: previewOverrides.licenses[row.tenant_id] || row.license_code,
    }));
    return ok(data);
  }
  return callRpc('platform_overview', {}, 'LOAD_FAILED');
};

/**
 * Last activity per company. `platform_usage` returns `by_tenant` regardless of
 * the window, so one cheap day is enough for the directory column.
 */
export const loadTenantActivity = async () => {
  const { data, error } = await loadPlatformUsage(1);
  if (error) return { data: null, error };
  const map = {};
  (data?.by_tenant || []).forEach((row) => { map[row.tenant_id] = row.last_login || null; });
  return ok(map);
};

/** public.platform_tenant_detail(p_tenant_id uuid) */
export const loadTenantDetail = async (tenantId) => {
  if (!tenantId) return fail('TENANT_NOT_FOUND');
  if (isPreviewMode()) {
    await delay(220);
    const detail = demoTenantDetail(tenantId);
    const moduleOverrides = previewOverrides.modules[tenantId] || {};
    const quotaOverrides = previewOverrides.quotas[tenantId] || {};
    return ok({
      ...detail,
      tenant: {
        ...detail.tenant,
        status: previewOverrides.statuses[tenantId] || detail.tenant.status,
        license_code: previewOverrides.licenses[tenantId] || detail.tenant.license_code,
      },
      settings: { ...detail.settings, ...(previewOverrides.settings[tenantId] || {}) },
      modules: detail.modules.map((row) => (
        row.code in moduleOverrides
          ? { ...row, enabled: moduleOverrides[row.code], override: moduleOverrides[row.code] }
          : row
      )),
      quotas: detail.quotas.map((row) => (
        row.code in quotaOverrides
          ? { ...row, limit: quotaOverrides[row.code], percent: quotaOverrides[row.code] > 0 ? Math.round((row.used * 10000) / quotaOverrides[row.code]) / 100 : null }
          : row
      )),
    });
  }
  return callRpc('platform_tenant_detail', { p_tenant_id: tenantId }, 'LOAD_FAILED');
};

/** public.platform_set_tenant_status(p_tenant_id, p_status, p_reason) */
export const setTenantStatus = async (tenantId, status, reason = null) => {
  if (!TENANT_STATUSES.includes(status)) return fail('STATUS_INVALID');
  if (isPreviewMode()) {
    await delay(200);
    previewOverrides.statuses[tenantId] = status;
    return ok({ tenant_id: tenantId, status });
  }
  return callRpc(
    'platform_set_tenant_status',
    { p_tenant_id: tenantId, p_status: status, p_reason: reason || null },
    'SAVE_FAILED',
  );
};

/** public.platform_set_module(p_tenant_id, p_module_code, p_enabled) */
export const setTenantModule = async (tenantId, moduleCode, enabled) => {
  if (isPreviewMode()) {
    await delay(160);
    previewOverrides.modules[tenantId] = { ...(previewOverrides.modules[tenantId] || {}), [moduleCode]: Boolean(enabled) };
    return ok({ tenant_id: tenantId, module_code: moduleCode, enabled: Boolean(enabled) });
  }
  return callRpc(
    'platform_set_module',
    { p_tenant_id: tenantId, p_module_code: moduleCode, p_enabled: Boolean(enabled) },
    'SAVE_FAILED',
  );
};

/** public.platform_set_quota(p_tenant_id, p_resource, p_limit) */
export const setTenantQuota = async (tenantId, resourceCode, limitValue) => {
  const limit = Math.max(0, Math.round(Number(limitValue) || 0));
  if (isPreviewMode()) {
    await delay(160);
    previewOverrides.quotas[tenantId] = { ...(previewOverrides.quotas[tenantId] || {}), [resourceCode]: limit };
    return ok({ tenant_id: tenantId, resource: resourceCode, limit });
  }
  return callRpc(
    'platform_set_quota',
    { p_tenant_id: tenantId, p_resource: resourceCode, p_limit: limit },
    'SAVE_FAILED',
  );
};

/** public.platform_set_license(p_tenant_id, p_license_code) */
export const setTenantLicense = async (tenantId, licenseCode) => {
  if (isPreviewMode()) {
    await delay(220);
    previewOverrides.licenses[tenantId] = licenseCode;
    return ok({ tenant_id: tenantId, license_code: licenseCode });
  }
  return callRpc(
    'platform_set_license',
    { p_tenant_id: tenantId, p_license_code: licenseCode },
    'SAVE_FAILED',
  );
};

/**
 * The chat policy lives in public.tenant_settings; the platform operator writes
 * it directly (RLS grants that, migration 012). Chat as a whole stays a module.
 *
 * @param {{ chat_private_enabled?: boolean, chat_groups_enabled?: boolean,
 *           chat_attachments_enabled?: boolean, chat_max_attachment_mb?: number,
 *           chat_allowed_file_types?: string[] }} values
 */
export const saveTenantChatSettings = async (tenantId, values) => {
  const payload = {};
  ['chat_private_enabled', 'chat_groups_enabled', 'chat_attachments_enabled'].forEach((key) => {
    if (key in values) payload[key] = Boolean(values[key]);
  });
  if ('chat_max_attachment_mb' in values) {
    payload.chat_max_attachment_mb = Math.max(0, Math.round(Number(values.chat_max_attachment_mb) || 0));
  }
  if ('chat_allowed_file_types' in values) {
    payload.chat_allowed_file_types = (values.chat_allowed_file_types || [])
      .map((type) => String(type).trim().toLowerCase())
      .filter(Boolean);
  }
  if (!Object.keys(payload).length) return ok({ tenant_id: tenantId });

  if (isPreviewMode()) {
    await delay(200);
    previewOverrides.settings[tenantId] = { ...(previewOverrides.settings[tenantId] || {}), ...payload };
    return ok({ tenant_id: tenantId, settings: payload });
  }
  if (!supabase) return fail('SERVICE_NOT_CONFIGURED');

  const { error } = await supabase.from('tenant_settings').update(payload).eq('tenant_id', tenantId);
  if (error) return { data: null, error: asCode(error, 'SAVE_FAILED') };
  return ok({ tenant_id: tenantId, settings: payload });
};

// ---------------------------------------------------------------------------
// Storage management
// ---------------------------------------------------------------------------

/** public.storage_overview() */
export const loadStorageOverview = async () => {
  if (isPreviewMode()) {
    await delay(240);
    const data = demoStorageOverview();
    return ok({
      ...data,
      tenants: data.tenants.map((row) => ({ ...row, ...(previewOverrides.storage[row.tenant_id] || {}) })),
    });
  }
  return callRpc('storage_overview', {}, 'LOAD_FAILED');
};

/**
 * public.storage_set_tenant_config(p_tenant_id, p_payload). Only the keys
 * present in the payload are written, which is how the RPC is built.
 */
export const saveTenantStorage = async (tenantId, payload) => {
  if (isPreviewMode()) {
    await delay(180);
    const patch = {};
    if ('is_enabled' in payload) patch.extended_enabled = Boolean(payload.is_enabled);
    if ('provider_code' in payload) patch.provider = payload.provider_code === 'none' ? null : payload.provider_code;
    if ('quota_bytes' in payload) patch.allocated_bytes = Number(payload.quota_bytes) || 0;
    previewOverrides.storage[tenantId] = { ...(previewOverrides.storage[tenantId] || {}), ...patch };
    return ok({ tenant_id: tenantId });
  }
  return callRpc('storage_set_tenant_config', { p_tenant_id: tenantId, p_payload: payload }, 'SAVE_FAILED');
};

/**
 * Chat attachments are a company setting, not a storage connection, so the
 * Company Storage tab writes the same column the company file does.
 */
export const setTenantChatAttachments = async (tenantId, enabled) => {
  if (isPreviewMode()) {
    await delay(150);
    previewOverrides.storage[tenantId] = {
      ...(previewOverrides.storage[tenantId] || {}),
      chat_attachments_enabled: Boolean(enabled),
    };
    return ok({ tenant_id: tenantId, chat_attachments_enabled: Boolean(enabled) });
  }
  return saveTenantChatSettings(tenantId, { chat_attachments_enabled: Boolean(enabled) });
};

/** public.storage_policies — one row per layer, readable by anyone, written by the operator. */
export const loadStoragePolicies = async () => {
  if (isPreviewMode()) {
    await delay(180);
    return ok(demoStoragePolicies().map((row) => ({ ...row, ...(previewOverrides.policies[row.layer] || {}) })));
  }
  if (!supabase) return fail('SERVICE_NOT_CONFIGURED');

  const { data, error } = await supabase
    .from('storage_policies')
    .select('layer, max_file_bytes, allowed_mime_types, default_quota_bytes, notes, updated_on')
    .order('layer');
  if (error) return { data: null, error: asCode(error, 'LOAD_FAILED') };
  return ok(data || []);
};

export const saveStoragePolicy = async (layer, values) => {
  if (!STORAGE_LAYERS.includes(layer)) return fail('INVALID_LAYER');
  const payload = {
    max_file_bytes: Math.max(0, Math.round(Number(values.max_file_bytes) || 0)),
    default_quota_bytes: Math.max(0, Math.round(Number(values.default_quota_bytes) || 0)),
    allowed_mime_types: (values.allowed_mime_types || [])
      .map((type) => String(type).trim().toLowerCase())
      .filter(Boolean),
    notes: String(values.notes || '').trim() || null,
  };

  if (isPreviewMode()) {
    await delay(200);
    previewOverrides.policies[layer] = payload;
    return ok({ layer, ...payload });
  }
  if (!supabase) return fail('SERVICE_NOT_CONFIGURED');

  const { error } = await supabase.from('storage_policies').update(payload).eq('layer', layer);
  if (error) return { data: null, error: asCode(error, 'SAVE_FAILED') };
  return ok({ layer, ...payload });
};

// ---------------------------------------------------------------------------
// Support console
// ---------------------------------------------------------------------------

/** public.support_console(p_status text default null) */
export const loadSupportConsole = async (status = null) => {
  if (isPreviewMode()) {
    await delay(240);
    const tickets = demoTickets().map((row) => ({ ...row, ...(previewOverrides.tickets[row.id] || {}) }));
    const filtered = status ? tickets.filter((row) => row.status === status) : tickets;
    return ok({
      counts: {
        total: tickets.length,
        open: tickets.filter((row) => row.status === 'Open').length,
        in_progress: tickets.filter((row) => row.status === 'InProgress').length,
        answered: tickets.filter((row) => row.status === 'Answered').length,
        closed: tickets.filter((row) => row.status === 'Closed').length,
        unassigned: tickets.filter((row) => !row.assigned_to && row.status !== 'Closed').length,
        public: tickets.filter((row) => row.source === 'Public').length,
        in_app: tickets.filter((row) => row.source === 'InApp').length,
        unanswered: tickets.filter((row) => !row.first_response_on && row.status !== 'Closed').length,
      },
      tickets: filtered,
    });
  }
  return callRpc('support_console', { p_status: status || null }, 'LOAD_FAILED');
};

/** public.support_ticket_detail(p_ticket_id uuid) */
export const loadSupportTicket = async (ticketId) => {
  if (!ticketId) return fail('TICKET_NOT_FOUND');
  if (isPreviewMode()) {
    await delay(180);
    const ticket = demoTickets().find((row) => row.id === ticketId);
    if (!ticket) return fail('TICKET_NOT_FOUND');
    return ok({
      ticket: { ...ticket, ...(previewOverrides.tickets[ticketId] || {}) },
      messages: [...(demoThreads[ticketId] || []), ...((previewOverrides.tickets[ticketId] || {}).extra_messages || [])],
    });
  }
  return callRpc('support_ticket_detail', { p_ticket_id: ticketId }, 'LOAD_FAILED');
};

/** public.support_reply(p_ticket_id, p_body, p_is_internal) */
export const replySupportTicket = async (ticketId, body, isInternal = false) => {
  const text = String(body || '').trim();
  if (!text) return fail('BODY_REQUIRED');

  if (isPreviewMode()) {
    await delay(300);
    const current = previewOverrides.tickets[ticketId] || {};
    previewOverrides.tickets[ticketId] = {
      ...current,
      status: isInternal ? (current.status || 'InProgress') : 'Answered',
      first_response_on: isInternal ? current.first_response_on || null : current.first_response_on || new Date().toISOString(),
      extra_messages: [
        ...(current.extra_messages || []),
        {
          id: `preview-${Date.now()}`,
          author_type: 'Operator',
          author_name: 'bbnovix',
          body: text,
          is_internal: Boolean(isInternal),
          created_on: new Date().toISOString(),
        },
      ],
    };
    return ok({ ticket_id: ticketId, status: isInternal ? 'InProgress' : 'Answered', is_internal: Boolean(isInternal) });
  }
  return callRpc(
    'support_reply',
    { p_ticket_id: ticketId, p_body: text, p_is_internal: Boolean(isInternal) },
    'SAVE_FAILED',
  );
};

/** public.support_ticket_set_status(p_ticket_id, p_status) */
export const setSupportTicketStatus = async (ticketId, status) => {
  if (!SUPPORT_STATUSES.includes(status)) return fail('STATUS_INVALID');
  if (isPreviewMode()) {
    await delay(180);
    previewOverrides.tickets[ticketId] = { ...(previewOverrides.tickets[ticketId] || {}), status };
    return ok({ ticket_id: ticketId, status });
  }
  return callRpc('support_ticket_set_status', { p_ticket_id: ticketId, p_status: status }, 'SAVE_FAILED');
};

// ---------------------------------------------------------------------------
// System health and usage
// ---------------------------------------------------------------------------

/** public.platform_health() */
export const loadPlatformHealth = async () => {
  if (isPreviewMode()) {
    await delay(260);
    return ok(demoHealth());
  }
  return callRpc('platform_health', {}, 'LOAD_FAILED');
};

/** public.platform_usage(p_days integer default 30) */
export const loadPlatformUsage = async (days = 30) => {
  const window = Math.max(1, Math.min(Number(days) || 30, 365));
  if (isPreviewMode()) {
    await delay(240);
    return ok(demoUsage(window));
  }
  return callRpc('platform_usage', { p_days: window }, 'LOAD_FAILED');
};

/** public.tenant_usage_snapshot() — recomputes today's rollup for every company. */
export const runUsageSnapshot = async () => {
  if (isPreviewMode()) {
    await delay(500);
    return ok({ usage_date: dayOnly(0), tenants: demoTenantSeed.length });
  }
  return callRpc('tenant_usage_snapshot', {}, 'SAVE_FAILED');
};
