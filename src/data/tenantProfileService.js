// The company's own record: public.tenants and its identity children
// (tenant_names, tenant_branding, tenant_contacts, tenant_settings), plus the
// screens-by-role matrix that decides what each role may open.
//
// The slug is never written from here. It is the permanent address of the
// company (bbnovix.com/{slug}/) and the database refuses to change it; the
// screen shows it read-only for the same reason.
//
// Every function returns { data, error } and never throws, and every function
// keeps working in local preview mode against a small localStorage store.

import { supabase, useLocalData } from '../lib/supabaseClient';

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

const asError = (value) => {
  if (value instanceof Error) return value;
  const message = value?.message || value?.error_description || value;
  return new Error(String(message || 'TENANT_REQUEST_FAILED'));
};

const ok = (data) => ({ data, error: null });
const ko = (value) => ({ data: null, error: asError(value) });

export const tenantErrorMessage = (t, error, fallbackKey = 'error_generic') => {
  if (!error) return '';
  const raw = String(error.message || error).trim();
  const code = raw.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/)?.[0];
  if (code) {
    const key = `admin_err_${code.toLowerCase()}`;
    const label = t(key);
    if (label !== key) return label;
  }
  if (/permission|denied|row-level/i.test(raw)) return t('error_permission');
  return t(fallbackKey);
};

export const CONTACT_CHANNELS = ['email', 'mobile', 'whatsapp', 'phone', 'fax', 'address', 'website'];

// ---------------------------------------------------------------------------
// Local preview store
// ---------------------------------------------------------------------------

const PROFILE_KEY = 'bbnovix_tenant_profile';
const ROLE_SCREENS_KEY = 'bbnovix_role_screens';

const demoProfile = (slug) => ({
  tenant: {
    id: 'demo-tenant',
    slug: slug || 'shalfa',
    code: 'SHALFA',
    legal_name: 'Shalfa Facility Management',
    status: 'Active',
    default_language: 'ar',
    timezone: 'Asia/Riyadh',
    country_code: 'SA',
    tax_number: '',
    commercial_register: '',
    industry: '',
  },
  names: [
    { language_code: 'ar', name: 'شلفا لإدارة المرافق', short_name: 'شلفا' },
    { language_code: 'en', name: 'Shalfa Facility Management', short_name: 'Shalfa' },
  ],
  branding: {
    logo_light_url: null, logo_dark_url: null, favicon_url: null, hero_image_url: null,
    theme_preset: 'aurora', primary_color: '#1b4f82', secondary_color: '#12365d', accent_color: '#b86a12',
    support_email: '', website_url: '', linkedin_url: '', map_url: '', address_ar: '', address_en: '',
  },
  contacts: [
    { id: 'contact-1', channel: 'email', value: 'info@example.com', display_order: 10, is_public: true },
  ],
  settings: { date_format: 'dd/MM/yyyy', rtl_default: true, allow_user_language: true },
});

const readLocalProfile = (slug) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    return parsed || demoProfile(slug);
  } catch {
    return demoProfile(slug);
  }
};

const writeLocal = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Blocked storage must never break the screen.
  }
};

const newId = () => (globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

// ---------------------------------------------------------------------------
// Company profile
// ---------------------------------------------------------------------------

const TENANT_WRITABLE = [
  'legal_name', 'default_language', 'timezone', 'country_code',
  'tax_number', 'commercial_register', 'industry', 'employee_range',
];

const BRANDING_WRITABLE = [
  'logo_light_url', 'logo_dark_url', 'favicon_url', 'hero_image_url', 'theme_preset',
  'primary_color', 'secondary_color', 'accent_color', 'support_email',
  'website_url', 'linkedin_url', 'map_url', 'address_ar', 'address_en',
];

const SETTINGS_WRITABLE = ['date_format', 'time_format', 'rtl_default', 'allow_user_language', 'currency'];

const pickColumns = (source = {}, columns) => columns.reduce((payload, column) => {
  if (source[column] !== undefined) {
    const value = source[column];
    payload[column] = typeof value === 'string' ? value.trim() || null : value;
  }
  return payload;
}, {});

/**
 * Everything the company profile screen needs, in one call.
 *
 * @param {string|null} slug the company address, used when the session may see
 *                           more than one company (platform operator).
 */
export const loadTenantProfile = async (slug = null) => {
  if (useLocalData || !supabase) return ok(readLocalProfile(slug));

  try {
    let tenantQuery = supabase.from('tenants').select('*');
    if (slug) tenantQuery = tenantQuery.eq('slug', slug);
    const { data: tenant, error: tenantError } = await tenantQuery.limit(1).maybeSingle();
    if (tenantError) return ko(tenantError);
    if (!tenant) return ko('TENANT_NOT_FOUND');

    const [names, branding, contacts, settings] = await Promise.all([
      supabase.from('tenant_names').select('*').eq('tenant_id', tenant.id),
      supabase.from('tenant_branding').select('*').eq('tenant_id', tenant.id).maybeSingle(),
      supabase.from('tenant_contacts').select('*').eq('tenant_id', tenant.id).order('display_order'),
      supabase.from('tenant_settings').select('*').eq('tenant_id', tenant.id).maybeSingle(),
    ]);

    return ok({
      tenant,
      names: names.data || [],
      branding: branding.data || {},
      contacts: contacts.data || [],
      settings: settings.data || {},
    });
  } catch (error) {
    return ko(error);
  }
};

/**
 * Writes the company profile back. The slug and the code are deliberately not
 * part of the payload.
 */
export const saveTenantProfile = async (tenantId, payload = {}) => {
  if (!tenantId) return ko('TENANT_NOT_FOUND');

  if (useLocalData || !supabase) {
    const current = readLocalProfile(null);
    const next = {
      tenant: { ...current.tenant, ...pickColumns(payload.tenant, TENANT_WRITABLE) },
      names: (payload.names || current.names).filter((row) => row.name?.trim()),
      branding: { ...current.branding, ...pickColumns(payload.branding, BRANDING_WRITABLE) },
      contacts: (payload.contacts || current.contacts)
        .filter((row) => row.channel && String(row.value || '').trim())
        .map((row, index) => ({ ...row, id: row.id || newId(), display_order: (index + 1) * 10 })),
      settings: { ...current.settings, ...pickColumns(payload.settings, SETTINGS_WRITABLE) },
    };
    writeLocal(PROFILE_KEY, next);
    return ok(next);
  }

  try {
    const tenantPayload = pickColumns(payload.tenant, TENANT_WRITABLE);
    if (Object.keys(tenantPayload).length) {
      const { error } = await supabase.from('tenants').update(tenantPayload).eq('id', tenantId);
      if (error) return ko(error);
    }

    const names = (payload.names || [])
      .filter((row) => row.language_code && String(row.name || '').trim())
      .map((row) => ({
        tenant_id: tenantId,
        language_code: row.language_code,
        name: String(row.name).trim(),
        short_name: String(row.short_name || '').trim() || null,
      }));
    if (names.length) {
      const { error } = await supabase.from('tenant_names').upsert(names, { onConflict: 'tenant_id,language_code' });
      if (error) return ko(error);
    }

    const branding = pickColumns(payload.branding, BRANDING_WRITABLE);
    if (Object.keys(branding).length) {
      const { error } = await supabase
        .from('tenant_branding')
        .upsert({ tenant_id: tenantId, ...branding }, { onConflict: 'tenant_id' });
      if (error) return ko(error);
    }

    if (Array.isArray(payload.contacts)) {
      // The channel list is small and fully edited in one screen, so it is
      // replaced wholesale rather than diffed row by row.
      const { error: clearError } = await supabase.from('tenant_contacts').delete().eq('tenant_id', tenantId);
      if (clearError) return ko(clearError);
      const rows = payload.contacts
        .filter((row) => row.channel && String(row.value || '').trim())
        .map((row, index) => ({
          tenant_id: tenantId,
          channel: row.channel,
          value: String(row.value).trim(),
          label_ar: row.label_ar || null,
          label_en: row.label_en || null,
          display_order: (index + 1) * 10,
          is_public: row.is_public !== false,
        }));
      if (rows.length) {
        const { error } = await supabase.from('tenant_contacts').insert(rows);
        if (error) return ko(error);
      }
    }

    const settings = pickColumns(payload.settings, SETTINGS_WRITABLE);
    if (Object.keys(settings).length) {
      const { error } = await supabase
        .from('tenant_settings')
        .upsert({ tenant_id: tenantId, ...settings }, { onConflict: 'tenant_id' });
      if (error) return ko(error);
    }

    return loadTenantProfile(payload.slug || null);
  } catch (error) {
    return ko(error);
  }
};

// ---------------------------------------------------------------------------
// Screens by role
// ---------------------------------------------------------------------------

const demoMatrix = () => ({
  screens: [
    { code: 'PORTAL_HOME', area: 'Portal', group_code: 'Workspace', name_ar: 'الرئيسية', name_en: 'Home', module_code: 'EMPLOYEE_PORTAL', module_enabled: true, display_order: 10 },
    { code: 'PORTAL_APPROVALS', area: 'Portal', group_code: 'Requests', name_ar: 'مركز الموافقات', name_en: 'Approval Center', module_code: 'APPROVALS', module_enabled: true, display_order: 40 },
    { code: 'ADMIN_EMPLOYEES', area: 'Admin', group_code: 'Organization', name_ar: 'الموظفون', name_en: 'Employees', module_code: 'EMPLOYEE_PORTAL', module_enabled: true, display_order: 210 },
    { code: 'ADMIN_COMPANY_PROFILE', area: 'Admin', group_code: 'Organization', name_ar: 'بيانات الشركة', name_en: 'Company Profile', module_code: null, module_enabled: true, display_order: 280 },
    { code: 'ADMIN_SCREENS', area: 'Admin', group_code: 'Access', name_ar: 'الشاشات والخدمات', name_en: 'Screens and Services', module_code: null, module_enabled: true, display_order: 300 },
  ],
  roles: [
    { id: 'role-admin', code: 'PLATFORM_ADMIN', name_ar: 'مدير المؤسسة', name_en: 'Organization Administrator', is_system: true },
    { id: 'role-manager', code: 'DEPARTMENT_MANAGER', name_ar: 'مدير إدارة', name_en: 'Department Manager', is_system: true },
    { id: 'role-employee', code: 'EMPLOYEE', name_ar: 'موظف', name_en: 'Employee', is_system: true },
  ],
  assignments: [],
});

const readLocalMatrix = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(ROLE_SCREENS_KEY) || 'null');
    const base = demoMatrix();
    return parsed ? { ...base, assignments: parsed.assignments || [] } : base;
  } catch {
    return demoMatrix();
  }
};

/**
 * The whole roles × screens matrix. The RPC answers in one round trip; when it
 * is not there yet the tables are read directly so the screen still works.
 * The platform operator role is never part of a company's matrix.
 */
export const loadRoleScreenMatrix = async () => {
  if (useLocalData || !supabase) return ok(readLocalMatrix());

  try {
    const { data, error } = await supabase.rpc('role_screens_matrix');
    if (!error && data) {
      return ok({
        screens: data.screens || [],
        roles: (data.roles || []).filter((role) => role.code !== 'PLATFORM_OPERATOR'),
        assignments: data.assignments || [],
      });
    }

    const [screens, roles, assignments] = await Promise.all([
      supabase.from('app_screens').select('*').eq('is_active', true).order('display_order'),
      supabase.from('roles').select('id,code,name_ar,name_en,is_system').eq('is_deleted', false).eq('is_active', true).order('code'),
      supabase.from('role_screens').select('role_id,screen_code,is_enabled').eq('is_deleted', false),
    ]);
    if (screens.error) return ko(screens.error);
    if (roles.error) return ko(roles.error);

    return ok({
      screens: (screens.data || []).filter((row) => row.area !== 'Platform').map((row) => ({ ...row, module_enabled: true })),
      roles: (roles.data || []).filter((role) => role.code !== 'PLATFORM_OPERATOR'),
      assignments: assignments.data || [],
    });
  } catch (error) {
    return ko(error);
  }
};

/**
 * Replaces the whole override set of one role.
 *
 * @param {string} roleId
 * @param {{code: string, is_enabled: boolean}[]} screens
 */
export const saveRoleScreens = async (roleId, screens = []) => {
  if (!roleId) return ko('ROLE_NOT_FOUND');
  const payload = screens
    .filter((row) => row && row.code)
    .map((row) => ({ code: row.code, is_enabled: row.is_enabled !== false }));

  if (useLocalData || !supabase) {
    const current = readLocalMatrix();
    const assignments = current.assignments.filter((row) => row.role_id !== roleId)
      .concat(payload.map((row) => ({ role_id: roleId, screen_code: row.code, is_enabled: row.is_enabled })));
    writeLocal(ROLE_SCREENS_KEY, { assignments });
    return ok({ role_id: roleId, screens: payload.length });
  }

  try {
    const { data, error } = await supabase.rpc('role_screens_save', { p_role_id: roleId, p_screens: payload });
    if (error) return ko(error);
    return ok(data);
  } catch (error) {
    return ko(error);
  }
};
