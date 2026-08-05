-- ============================================================================
-- 012 — Multi-tenant foundation (bbnovix platform)
--
-- Turns the single-company portal into a multi-tenant SaaS:
--   * one React app, one Supabase project, shared tables
--   * tenant_id on every business table
--   * isolation enforced by a RESTRICTIVE RLS policy on every table, so the
--     existing permission-based policies keep working untouched and no query
--     can ever cross a company boundary
--   * platform tenant ("platform") is the operator workspace; every existing
--     row is migrated into the "shalfa" tenant
--
-- Column convention note: this codebase already uses created_on / updated_on /
-- deleted_date / is_deleted. Those are the canonical audit columns
-- (created_at / updated_at / deleted_at in the specification). This migration
-- completes the set everywhere: created_by, updated_by, deleted_by,
-- deleted_date, is_deleted, row_version.
-- ============================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ----------------------------------------------------------------------------
-- 1. Platform catalogues (owned by the platform operator, not by a tenant)
-- ----------------------------------------------------------------------------

-- Modules are the coarse product surface (Employee Portal, Forms, Chat, ...).
create table if not exists public.platform_modules (
  code text primary key,
  name_ar text not null,
  name_en text not null,
  description_ar text,
  description_en text,
  category text not null default 'Core',
  display_order integer not null default 0,
  is_core boolean not null default false,
  is_active boolean not null default true,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

-- Licenses group modules and default quotas (Free today, Pro later).
create table if not exists public.platform_licenses (
  code text primary key,
  name_ar text not null,
  name_en text not null,
  description_ar text,
  description_en text,
  module_codes text[] not null default '{}',
  quota_defaults jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

-- Countable resources used for company limits and usage reporting.
create table if not exists public.platform_quota_resources (
  code text primary key,
  name_ar text not null,
  name_en text not null,
  unit text not null default 'count' check (unit in ('count', 'bytes', 'per_day')),
  display_order integer not null default 0,
  is_active boolean not null default true
);

-- Slugs the platform keeps for itself; a company can never register them.
create table if not exists public.platform_reserved_slugs (
  slug text primary key,
  reason text
);

insert into public.platform_reserved_slugs (slug, reason) values
  ('platform', 'Platform operator workspace'),
  ('portal', 'Public product site'),
  ('verify', 'Public document verification'),
  ('support', 'Public support desk'),
  ('signup', 'Public subscription form'),
  ('api', 'Reserved for the public API'),
  ('app', 'Application shell'),
  ('admin', 'Reserved'),
  ('login', 'Reserved'),
  ('logout', 'Reserved'),
  ('auth', 'Reserved'),
  ('reset-password', 'Reserved'),
  ('assets', 'Static assets'),
  ('static', 'Static assets'),
  ('data', 'Static data'),
  ('public', 'Reserved'),
  ('www', 'Reserved'),
  ('mail', 'Reserved'),
  ('cdn', 'Reserved'),
  ('status', 'Reserved'),
  ('docs', 'Reserved'),
  ('help', 'Reserved'),
  ('billing', 'Reserved'),
  ('account', 'Reserved'),
  ('settings', 'Reserved'),
  ('bbnovix', 'Brand'),
  ('null', 'Reserved'),
  ('undefined', 'Reserved')
on conflict (slug) do nothing;

-- ----------------------------------------------------------------------------
-- 2. Tenants and their identity
-- ----------------------------------------------------------------------------

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    check (slug ~ '^[a-z0-9]{2,32}$'),
  code text not null unique,
  legal_name text,
  status text not null default 'Pending'
    check (status in ('Pending', 'Active', 'Suspended', 'Disabled', 'Deleted')),
  license_code text not null default 'FREE' references public.platform_licenses(code),
  default_language text not null default 'ar',
  timezone text not null default 'Asia/Riyadh',
  country_code text not null default 'SA',
  tax_number text,
  commercial_register text,
  industry text,
  employee_range text,
  is_platform boolean not null default false,
  activated_on timestamptz,
  suspended_on timestamptz,
  suspended_reason text,
  notes text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_tenants_status on public.tenants(status) where not is_deleted;

-- The company name in every language the platform supports. One row per
-- language; the tenant default_language row is mandatory and is the fallback.
create table if not exists public.tenant_names (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  language_code text not null,
  name text not null,
  short_name text,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  primary key (tenant_id, language_code)
);

create table if not exists public.tenant_branding (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  logo_light_url text,
  logo_dark_url text,
  favicon_url text,
  hero_image_url text,
  theme_preset text not null default 'aurora',
  primary_color text not null default '#0f766e',
  secondary_color text not null default '#0b3b60',
  accent_color text not null default '#f59e0b',
  support_email text,
  website_url text,
  linkedin_url text,
  twitter_url text,
  instagram_url text,
  map_url text,
  address_ar text,
  address_en text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

-- Public contact channels rendered in the company landing footer. Each row
-- carries its own icon; nothing is rendered when a channel is absent.
create table if not exists public.tenant_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel text not null check (channel in ('email', 'mobile', 'whatsapp', 'phone', 'fax', 'address', 'website')),
  value text not null,
  label_ar text,
  label_en text,
  display_order integer not null default 0,
  is_public boolean not null default true,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_tenant_contacts_tenant
  on public.tenant_contacts(tenant_id, display_order);

create table if not exists public.tenant_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  date_format text not null default 'dd/MM/yyyy',
  time_format text not null default 'HH:mm',
  week_start smallint not null default 0 check (week_start between 0 and 6),
  currency text not null default 'SAR',
  decimal_places smallint not null default 2 check (decimal_places between 0 and 6),
  rtl_default boolean not null default true,
  allow_user_language boolean not null default true,
  -- Verification of approved requests
  verification_enabled boolean not null default true,
  verification_validity_days integer not null default 0,
  -- Chat policy (platform can override through tenant_modules)
  chat_private_enabled boolean not null default true,
  chat_groups_enabled boolean not null default true,
  chat_attachments_enabled boolean not null default false,
  chat_max_attachment_mb integer not null default 5,
  chat_allowed_file_types text[] not null default array['image/png', 'image/jpeg', 'application/pdf'],
  chat_retention_days integer not null default 180,
  -- Storage
  storage_provider text not null default 'none'
    check (storage_provider in ('none', 'supabase', 'google_drive', 'onedrive', 's3', 'r2', 'b2', 'azure_blob')),
  extended_storage_enabled boolean not null default false,
  -- Security
  password_min_length smallint not null default 8,
  password_require_upper boolean not null default true,
  password_require_number boolean not null default true,
  password_require_symbol boolean not null default false,
  session_timeout_minutes integer not null default 15,
  mfa_required boolean not null default false,
  max_login_attempts smallint not null default 5,
  ip_allow_list text[] not null default '{}',
  -- Notifications
  notify_email_enabled boolean not null default true,
  settings_json jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create table if not exists public.tenant_domains (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  domain text not null,
  path_slug text,
  is_primary boolean not null default false,
  verified_at timestamptz,
  created_on timestamptz not null default now(),
  unique (domain, path_slug)
);

create index if not exists idx_tenant_domains_tenant on public.tenant_domains(tenant_id);

-- Membership links an auth identity to a company. employee_id points at the
-- public.users row that carries the employee record inside that company.
create table if not exists public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid,
  role_id uuid,
  is_owner boolean not null default false,
  status text not null default 'Active'
    check (status in ('Invited', 'Active', 'Suspended', 'Removed')),
  joined_at timestamptz not null default now(),
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create index if not exists idx_tenant_memberships_user on public.tenant_memberships(user_id, status);

-- Per-tenant module switches. NULL is_enabled means "inherit from license".
create table if not exists public.tenant_modules (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  module_code text not null references public.platform_modules(code) on delete cascade,
  is_enabled boolean not null default true,
  enabled_by uuid references auth.users(id),
  updated_on timestamptz not null default now(),
  primary key (tenant_id, module_code)
);

create table if not exists public.tenant_quotas (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  resource_code text not null references public.platform_quota_resources(code) on delete cascade,
  limit_value bigint not null default 0,
  used_value bigint not null default 0,
  is_enforced boolean not null default true,
  updated_on timestamptz not null default now(),
  primary key (tenant_id, resource_code)
);

-- Daily rollup used by the platform usage screens.
create table if not exists public.tenant_usage_daily (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  usage_date date not null,
  metric_code text not null,
  metric_value bigint not null default 0,
  primary key (tenant_id, usage_date, metric_code)
);

-- ----------------------------------------------------------------------------
-- 3. Seed platform catalogues
-- ----------------------------------------------------------------------------

insert into public.platform_modules (code, name_ar, name_en, category, display_order, is_core) values
  ('EMPLOYEE_PORTAL', 'بوابة الموظفين', 'Employee Portal', 'Core', 10, true),
  ('FORMS', 'النماذج', 'Forms', 'Core', 20, true),
  ('APPROVALS', 'الموافقات', 'Approvals', 'Core', 30, true),
  ('DOCUMENTS', 'الوثائق', 'Documents', 'Content', 40, false),
  ('ANNOUNCEMENTS', 'الإعلانات', 'Announcements', 'Engagement', 50, false),
  ('CALENDAR', 'التقويم', 'Calendar', 'Engagement', 60, false),
  ('SURVEY', 'الاستطلاعات', 'Survey', 'Engagement', 70, false),
  ('NOTES', 'المفكرة', 'Notes', 'Productivity', 80, false),
  ('CHAT', 'الدردشة', 'Chat', 'Collaboration', 90, false),
  ('PERFORMANCE', 'إدارة الأداء', 'Performance', 'HR', 100, false),
  ('KNOWLEDGE_BASE', 'قاعدة المعرفة', 'Knowledge Base', 'Content', 110, false),
  ('CERTIFICATES', 'الشهادات', 'Certificates', 'Verification', 120, false),
  ('VERIFICATION', 'التحقق من الوثائق', 'Verification', 'Verification', 130, false),
  ('SUPPORT', 'الدعم الفني', 'Support', 'Service', 140, false),
  ('MARKETPLACE', 'متجر القوالب', 'Template Marketplace', 'Content', 150, false),
  ('STORAGE_EXTENDED', 'التخزين الإضافي', 'Extended Storage', 'Platform', 160, false),
  ('PUBLIC_API', 'الواجهة البرمجية', 'Public API', 'Platform', 170, false),
  ('AI', 'الذكاء الاصطناعي', 'AI', 'Platform', 180, false)
on conflict (code) do update set
  name_ar = excluded.name_ar,
  name_en = excluded.name_en,
  category = excluded.category,
  display_order = excluded.display_order,
  is_core = excluded.is_core,
  updated_on = now();

insert into public.platform_quota_resources (code, name_ar, name_en, unit, display_order) values
  ('STORAGE_BYTES', 'مساحة التخزين', 'Storage', 'bytes', 10),
  ('EMPLOYEES', 'الموظفون', 'Employees', 'count', 20),
  ('DEPARTMENTS', 'الإدارات', 'Departments', 'count', 30),
  ('PROJECTS', 'المشاريع', 'Projects', 'count', 40),
  ('SITES', 'المواقع', 'Sites', 'count', 50),
  ('FORMS', 'الطلبات', 'Forms', 'count', 60),
  ('TEMPLATES', 'القوالب', 'Templates', 'count', 70),
  ('DOCUMENTS', 'الوثائق', 'Documents', 'count', 80),
  ('CERTIFICATES', 'الشهادات', 'Certificates', 'count', 90),
  ('CHAT_MESSAGES', 'رسائل الدردشة', 'Chat messages', 'count', 100),
  ('ANNOUNCEMENTS', 'الإعلانات', 'Announcements', 'count', 110),
  ('SURVEYS', 'الاستطلاعات', 'Surveys', 'count', 120),
  ('EMAILS_PER_DAY', 'الرسائل البريدية يومياً', 'Emails per day', 'per_day', 130),
  ('API_CALLS', 'طلبات الواجهة البرمجية', 'API calls', 'per_day', 140),
  ('NOTIFICATIONS', 'الإشعارات', 'Notifications', 'count', 150)
on conflict (code) do update set
  name_ar = excluded.name_ar,
  name_en = excluded.name_en,
  unit = excluded.unit,
  display_order = excluded.display_order;

insert into public.platform_licenses (code, name_ar, name_en, module_codes, quota_defaults, is_default, display_order) values
  (
    'FREE', 'المجانية', 'Free',
    array[
      'EMPLOYEE_PORTAL','FORMS','APPROVALS','DOCUMENTS','ANNOUNCEMENTS','CALENDAR',
      'SURVEY','NOTES','CHAT','PERFORMANCE','CERTIFICATES','VERIFICATION','SUPPORT'
    ],
    jsonb_build_object(
      'STORAGE_BYTES', 209715200,
      'EMPLOYEES', 500,
      'DEPARTMENTS', 100,
      'PROJECTS', 100,
      'SITES', 200,
      'FORMS', 20000,
      'TEMPLATES', 100,
      'DOCUMENTS', 2000,
      'CERTIFICATES', 2000,
      'CHAT_MESSAGES', 200000,
      'ANNOUNCEMENTS', 500,
      'SURVEYS', 200,
      'EMAILS_PER_DAY', 200,
      'API_CALLS', 5000,
      'NOTIFICATIONS', 100000
    ),
    true, 10
  ),
  (
    'PRO', 'الاحترافية', 'Pro',
    array[
      'EMPLOYEE_PORTAL','FORMS','APPROVALS','DOCUMENTS','ANNOUNCEMENTS','CALENDAR',
      'SURVEY','NOTES','CHAT','PERFORMANCE','KNOWLEDGE_BASE','CERTIFICATES',
      'VERIFICATION','SUPPORT','MARKETPLACE','STORAGE_EXTENDED','PUBLIC_API','AI'
    ],
    jsonb_build_object(
      'STORAGE_BYTES', 10737418240,
      'EMPLOYEES', 100000,
      'DEPARTMENTS', 5000,
      'PROJECTS', 5000,
      'SITES', 10000,
      'FORMS', 5000000,
      'TEMPLATES', 5000,
      'DOCUMENTS', 500000,
      'CERTIFICATES', 500000,
      'CHAT_MESSAGES', 50000000,
      'ANNOUNCEMENTS', 100000,
      'SURVEYS', 50000,
      'EMAILS_PER_DAY', 20000,
      'API_CALLS', 1000000,
      'NOTIFICATIONS', 50000000
    ),
    false, 20
  )
on conflict (code) do update set
  name_ar = excluded.name_ar,
  name_en = excluded.name_en,
  module_codes = excluded.module_codes,
  quota_defaults = excluded.quota_defaults,
  updated_on = now();

-- ----------------------------------------------------------------------------
-- 4. Create the two founding tenants
--    platform = operator workspace, shalfa = every existing row
-- ----------------------------------------------------------------------------

insert into public.tenants (slug, code, legal_name, status, license_code, default_language, timezone, country_code, is_platform, activated_on)
values ('platform', 'PLATFORM', 'bbnovix', 'Active', 'PRO', 'ar', 'Asia/Riyadh', 'SA', true, now())
on conflict (slug) do nothing;

insert into public.tenants (slug, code, legal_name, status, license_code, default_language, timezone, country_code, is_platform, activated_on)
values ('shalfa', 'SHALFA', 'شركة شلفا لإدارة المرافق', 'Active', 'FREE', 'ar', 'Asia/Riyadh', 'SA', false, now())
on conflict (slug) do nothing;

insert into public.tenant_names (tenant_id, language_code, name) values
  ((select id from public.tenants where slug = 'platform'), 'ar', 'بي بي نوفكس'),
  ((select id from public.tenants where slug = 'platform'), 'en', 'bbnovix'),
  ((select id from public.tenants where slug = 'shalfa'), 'ar', 'شلفا'),
  ((select id from public.tenants where slug = 'shalfa'), 'en', 'Shalfa'),
  ((select id from public.tenants where slug = 'shalfa'), 'hi', 'Shalfa'),
  ((select id from public.tenants where slug = 'shalfa'), 'ur', 'شلفا'),
  ((select id from public.tenants where slug = 'shalfa'), 'tl', 'Shalfa')
on conflict (tenant_id, language_code) do nothing;

insert into public.tenant_branding (tenant_id, support_email, map_url, address_ar, address_en, linkedin_url)
select id,
       'a.alemary@shalfaintl.com.sa',
       'https://maps.app.goo.gl/',
       'الرياض، المملكة العربية السعودية',
       'Riyadh, Saudi Arabia',
       null
from public.tenants where slug = 'shalfa'
on conflict (tenant_id) do nothing;

insert into public.tenant_branding (tenant_id, support_email, website_url)
select id, 'bbnovix@gmail.com', 'https://bbnovix.com'
from public.tenants where slug = 'platform'
on conflict (tenant_id) do nothing;

insert into public.tenant_settings (tenant_id)
select id from public.tenants where slug in ('platform', 'shalfa')
on conflict (tenant_id) do nothing;

insert into public.tenant_contacts (tenant_id, channel, value, display_order)
select t.id, c.channel, c.value, c.display_order
from public.tenants t
cross join (values
  ('email', 'a.alemary@shalfaintl.com.sa', 10),
  ('mobile', '0594420232', 20),
  ('address', 'الرياض، المملكة العربية السعودية', 30)
) as c(channel, value, display_order)
where t.slug = 'shalfa'
  and not exists (select 1 from public.tenant_contacts x where x.tenant_id = t.id)
;

insert into public.tenant_domains (tenant_id, domain, path_slug, is_primary, verified_at)
select id, 'bbnovix.com', slug, true, now() from public.tenants where slug in ('platform', 'shalfa')
on conflict (domain, path_slug) do nothing;

-- Every module of the license is switched on for both founding tenants.
insert into public.tenant_modules (tenant_id, module_code, is_enabled)
select t.id, m.code, true
from public.tenants t
join public.platform_licenses l on l.code = t.license_code
join public.platform_modules m on m.code = any (l.module_codes)
where t.slug in ('platform', 'shalfa')
on conflict (tenant_id, module_code) do nothing;

insert into public.tenant_quotas (tenant_id, resource_code, limit_value)
select t.id, r.code, coalesce((l.quota_defaults ->> r.code)::bigint, 0)
from public.tenants t
join public.platform_licenses l on l.code = t.license_code
cross join public.platform_quota_resources r
where t.slug in ('platform', 'shalfa')
on conflict (tenant_id, resource_code) do nothing;

-- ----------------------------------------------------------------------------
-- 5. tenant_id + audit columns on every business table
-- ----------------------------------------------------------------------------

do $$
declare
  business_tables text[] := array[
    'users', 'roles', 'user_roles', 'role_permissions',
    'templates', 'forms', 'form_attachments', 'form_approval_transactions',
    'approval_roles', 'approval_schemes', 'approval_scheme_roles',
    'departments', 'projects', 'sites', 'positions',
    'competencies', 'competency_indicators', 'goals', 'proficiency_levels',
    'evaluation_templates', 'evaluation_sections', 'evaluation_cycles',
    'evaluation_workflow_steps', 'performance_evaluations',
    'evaluation_goals', 'evaluation_competencies',
    'content_items', 'content_receipts',
    'lookup_values', 'system_settings', 'email_templates', 'email_queue',
    'import_jobs', 'import_job_rows', 'audit_logs'
  ];
  tbl text;
begin
  foreach tbl in array business_tables loop
    if to_regclass('public.' || tbl) is null then
      continue;
    end if;

    execute format(
      'alter table public.%I
         add column if not exists tenant_id uuid references public.tenants(id) on delete cascade,
         add column if not exists created_by uuid references auth.users(id),
         add column if not exists updated_by uuid references auth.users(id),
         add column if not exists is_deleted boolean not null default false,
         add column if not exists deleted_by uuid references auth.users(id),
         add column if not exists deleted_date timestamptz,
         add column if not exists row_version integer not null default 1',
      tbl
    );

    -- Not every legacy table carried timestamps.
    execute format(
      'alter table public.%I
         add column if not exists created_on timestamptz not null default now(),
         add column if not exists updated_on timestamptz not null default now()',
      tbl
    );
  end loop;
end $$;

-- The employee record additionally remembers which company the session is in.
alter table public.users
  add column if not exists active_tenant_id uuid references public.tenants(id),
  add column if not exists sector_id uuid,
  add column if not exists country_id uuid;

-- ----------------------------------------------------------------------------
-- 5b. The audit trail has to understand companies BEFORE the backfill runs
--
--     The backfill writes to audited tables, and every write fires
--     write_audit_log(). The pre-existing version knows nothing about
--     tenant_id, so it would insert audit rows with a null company — and the
--     moment the backfill marks audit_logs.tenant_id NOT NULL, the very next
--     update of an audited table fails. Both functions are therefore defined
--     here, before the first write, rather than with the rest of the helpers.
-- ----------------------------------------------------------------------------

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(u.active_tenant_id, u.tenant_id)
  from public.users u
  where u.id = auth.uid()
    and not u.is_deleted;
$$;
grant execute on function public.current_tenant_id() to authenticated;

create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  payload jsonb;
  row_tenant uuid;
begin
  payload := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  begin
    row_tenant := nullif(payload ->> 'tenant_id', '')::uuid;
  exception when others then
    row_tenant := null;
  end;

  -- During the migration itself there is no signed-in user, so the row's own
  -- company is the only answer; afterwards the session supplies it.
  if row_tenant is null then
    row_tenant := public.current_tenant_id();
  end if;
  if row_tenant is null then
    select id into row_tenant from public.tenants where slug = 'shalfa';
  end if;

  insert into public.audit_logs(tenant_id, actor_id, action, entity_type, entity_id, old_data, new_data)
  values (
    row_tenant,
    auth.uid(),
    tg_op,
    tg_table_name,
    coalesce(payload ->> 'id', ''),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. Backfill: every existing row belongs to Shalfa
-- ----------------------------------------------------------------------------

do $$
declare
  business_tables text[] := array[
    'users', 'roles', 'user_roles', 'role_permissions',
    'templates', 'forms', 'form_attachments', 'form_approval_transactions',
    'approval_roles', 'approval_schemes', 'approval_scheme_roles',
    'departments', 'projects', 'sites', 'positions',
    'competencies', 'competency_indicators', 'goals', 'proficiency_levels',
    'evaluation_templates', 'evaluation_sections', 'evaluation_cycles',
    'evaluation_workflow_steps', 'performance_evaluations',
    'evaluation_goals', 'evaluation_competencies',
    'content_items', 'content_receipts',
    'lookup_values', 'system_settings', 'email_templates', 'email_queue',
    'import_jobs', 'import_job_rows', 'audit_logs'
  ];
  tbl text;
  shalfa uuid;
begin
  select id into shalfa from public.tenants where slug = 'shalfa';

  foreach tbl in array business_tables loop
    if to_regclass('public.' || tbl) is null then
      continue;
    end if;
    execute format('update public.%I set tenant_id = $1 where tenant_id is null', tbl) using shalfa;
    execute format('alter table public.%I alter column tenant_id set not null', tbl);
    execute format('create index if not exists idx_%s_tenant on public.%I (tenant_id)', tbl, tbl);
  end loop;

  update public.users set active_tenant_id = shalfa where active_tenant_id is null;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Composite uniqueness: codes are unique inside a company, not globally
-- ----------------------------------------------------------------------------

-- Migration 0001 declared `email text unique` and `employee_no text unique` as
-- table constraints, not indexes. They are what actually stops two companies
-- from each having an employee number 1, so both have to go.
alter table public.users drop constraint if exists users_email_key;
alter table public.users drop constraint if exists users_employee_no_key;
drop index if exists public.uq_users_email_ci;
drop index if exists public.uq_users_employee_no_active;
create unique index if not exists uq_users_email_tenant
  on public.users (tenant_id, lower(trim(email))) where is_deleted = false;
create unique index if not exists uq_users_employee_no_tenant
  on public.users (tenant_id, employee_no) where is_deleted = false and employee_no is not null;

alter table public.departments drop constraint if exists departments_code_key;
create unique index if not exists uq_departments_code_tenant
  on public.departments (tenant_id, lower(code)) where not is_deleted;

alter table public.projects drop constraint if exists projects_code_key;
create unique index if not exists uq_projects_code_tenant
  on public.projects (tenant_id, lower(code)) where not is_deleted;

alter table public.sites drop constraint if exists sites_code_key;
create unique index if not exists uq_sites_code_tenant
  on public.sites (tenant_id, lower(code)) where not is_deleted;

drop index if exists public.uq_positions_code_active;
create unique index if not exists uq_positions_code_tenant
  on public.positions (tenant_id, lower(code)) where not is_deleted;

alter table public.roles drop constraint if exists roles_code_key;
create unique index if not exists uq_roles_code_tenant
  on public.roles (tenant_id, code) where not is_deleted;

alter table public.templates drop constraint if exists templates_code_key;
create unique index if not exists uq_templates_code_tenant
  on public.templates (tenant_id, code) where not is_deleted;

drop index if exists public.uq_content_items_code_active;
create unique index if not exists uq_content_items_code_tenant
  on public.content_items (tenant_id, lower(code)) where code is not null and not is_deleted;

drop index if exists public.uq_forms_reference_no;
create unique index if not exists uq_forms_reference_no_tenant
  on public.forms (tenant_id, reference_no) where reference_no is not null and is_deleted = false;

drop index if exists public.uq_competencies_code_active;
create unique index if not exists uq_competencies_code_tenant
  on public.competencies (tenant_id, code) where is_deleted = false and code is not null;

drop index if exists public.uq_goals_code_active;
create unique index if not exists uq_goals_code_tenant
  on public.goals (tenant_id, code) where is_deleted = false and code is not null;

drop index if exists public.uq_proficiency_levels_code_active;
create unique index if not exists uq_proficiency_levels_code_tenant
  on public.proficiency_levels (tenant_id, lower(code)) where not is_deleted;

alter table public.proficiency_levels drop constraint if exists proficiency_levels_level_no_key;
create unique index if not exists uq_proficiency_levels_no_tenant
  on public.proficiency_levels (tenant_id, level_no) where not is_deleted;

alter table public.evaluation_cycles drop constraint if exists evaluation_cycles_code_key;
create unique index if not exists uq_evaluation_cycles_code_tenant
  on public.evaluation_cycles (tenant_id, code) where not is_deleted;

alter table public.evaluation_templates drop constraint if exists evaluation_templates_code_version_key;
create unique index if not exists uq_evaluation_templates_code_tenant
  on public.evaluation_templates (tenant_id, code, version) where not is_deleted;

alter table public.approval_roles drop constraint if exists approval_roles_code_key;
create unique index if not exists uq_approval_roles_code_tenant
  on public.approval_roles (tenant_id, code) where not is_deleted;

alter table public.approval_schemes drop constraint if exists approval_schemes_code_key;
create unique index if not exists uq_approval_schemes_code_tenant
  on public.approval_schemes (tenant_id, code) where not is_deleted;

alter table public.lookup_values drop constraint if exists lookup_values_lookup_type_code_key;
create unique index if not exists uq_lookup_values_tenant
  on public.lookup_values (tenant_id, lookup_type, code) where not is_deleted;

alter table public.email_templates drop constraint if exists email_templates_code_version_key;
create unique index if not exists uq_email_templates_code_tenant
  on public.email_templates (tenant_id, code, version) where not is_deleted;

-- system_settings is keyed per company.
alter table public.system_settings drop constraint if exists system_settings_pkey;
alter table public.system_settings
  add constraint system_settings_pkey primary key (tenant_id, setting_key);

-- Tenant-first indexes for the hottest paths.
create index if not exists idx_forms_tenant_employee_updated
  on public.forms (tenant_id, employee_id, updated_on desc) where is_deleted = false;
create index if not exists idx_forms_tenant_status
  on public.forms (tenant_id, status) where is_deleted = false;
create index if not exists idx_users_tenant_department
  on public.users (tenant_id, department_id) where is_deleted = false;
create index if not exists idx_content_tenant_type
  on public.content_items (tenant_id, content_type, display_order) where is_published and not is_deleted;

-- ----------------------------------------------------------------------------
-- 8. Cross-tenant relationship guards
--    A form may never point at an employee of another company, and so on.
--    Composite foreign keys make that structurally impossible.
-- ----------------------------------------------------------------------------

create unique index if not exists uq_users_tenant_id on public.users (tenant_id, id);
create unique index if not exists uq_departments_tenant_id on public.departments (tenant_id, id);
create unique index if not exists uq_projects_tenant_id on public.projects (tenant_id, id);
create unique index if not exists uq_sites_tenant_id on public.sites (tenant_id, id);
create unique index if not exists uq_positions_tenant_id on public.positions (tenant_id, id);
create unique index if not exists uq_templates_tenant_id on public.templates (tenant_id, id);
create unique index if not exists uq_forms_tenant_id on public.forms (tenant_id, id);
create unique index if not exists uq_roles_tenant_id on public.roles (tenant_id, id);
create unique index if not exists uq_approval_roles_tenant_id on public.approval_roles (tenant_id, id);
create unique index if not exists uq_approval_schemes_tenant_id on public.approval_schemes (tenant_id, id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_forms_employee_same_tenant') then
    alter table public.forms
      add constraint fk_forms_employee_same_tenant
      foreign key (tenant_id, employee_id) references public.users (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_forms_requester_same_tenant') then
    alter table public.forms
      add constraint fk_forms_requester_same_tenant
      foreign key (tenant_id, requested_by) references public.users (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_forms_template_same_tenant') then
    alter table public.forms
      add constraint fk_forms_template_same_tenant
      foreign key (tenant_id, template_id) references public.templates (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_user_roles_role_same_tenant') then
    alter table public.user_roles
      add constraint fk_user_roles_role_same_tenant
      foreign key (tenant_id, role_id) references public.roles (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_user_roles_user_same_tenant') then
    alter table public.user_roles
      add constraint fk_user_roles_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_scheme_roles_same_tenant') then
    alter table public.approval_scheme_roles
      add constraint fk_scheme_roles_same_tenant
      foreign key (tenant_id, scheme_id) references public.approval_schemes (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_positions_department_same_tenant') then
    alter table public.positions
      add constraint fk_positions_department_same_tenant
      foreign key (tenant_id, department_id) references public.departments (tenant_id, id);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 9. Tenant context helpers
--
--    current_tenant_id() is defined in section 5b, because the backfill needs
--    it before it runs.
-- ----------------------------------------------------------------------------

create or replace function public.current_tenant_slug()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select t.slug from public.tenants t where t.id = public.current_tenant_id();
$$;
grant execute on function public.current_tenant_slug() to authenticated;

-- Platform operators live in the platform tenant only.
create or replace function public.is_platform_operator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    join public.tenants t on t.id = r.tenant_id
    where ur.user_id = auth.uid()
      and r.code = 'PLATFORM_OPERATOR'
      and t.is_platform
      and r.is_active
      and not r.is_deleted
  );
$$;
grant execute on function public.is_platform_operator() to authenticated;

create or replace function public.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tenant_memberships m
    where m.user_id = auth.uid()
      and m.tenant_id = p_tenant_id
      and m.status = 'Active'
  );
$$;
grant execute on function public.is_tenant_member(uuid) to authenticated;

-- A module is on when the license grants it and the platform has not
-- switched it off for this company.
create or replace function public.tenant_has_module(p_module_code text, p_tenant_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select tm.is_enabled
    from public.tenant_modules tm
    where tm.tenant_id = coalesce(p_tenant_id, public.current_tenant_id())
      and tm.module_code = p_module_code
  ), (
    select p_module_code = any (l.module_codes)
    from public.tenants t
    join public.platform_licenses l on l.code = t.license_code
    where t.id = coalesce(p_tenant_id, public.current_tenant_id())
  ), false);
$$;
grant execute on function public.tenant_has_module(text, uuid) to authenticated;

-- Permission checks are User + Tenant + Role + Permission, never role alone.
create or replace function public.has_permission(permission_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.is_active and not r.is_deleted
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where ur.user_id = auth.uid()
      and p.code = permission_code
      and r.tenant_id = public.current_tenant_id()
  );
$$;
grant execute on function public.has_permission(text) to authenticated;

create or replace function public.has_permission_for_user(target_user_id uuid, permission_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.is_active and not r.is_deleted
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    join public.users u on u.id = ur.user_id
    where ur.user_id = target_user_id
      and p.code = permission_code
      and r.tenant_id = coalesce(u.active_tenant_id, u.tenant_id)
  );
$$;
revoke all on function public.has_permission_for_user(uuid, text) from public;
grant execute on function public.has_permission_for_user(uuid, text) to service_role;

-- Content access ranking stays role based but is now tenant aware.
create or replace function public.current_content_access_rank()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(max(
    case r.code
      when 'PLATFORM_OPERATOR' then 4
      when 'PLATFORM_ADMIN' then 4
      when 'SYSTEM_ADMIN' then 4
      when 'DEPARTMENT_MANAGER' then 3
      when 'DEPARTMENT_COORDINATOR' then 2
      when 'EMPLOYEE' then 1
      else 0
    end
  ), 0)
  from public.user_roles ur
  join public.roles r on r.id = ur.role_id
  where ur.user_id = auth.uid()
    and r.is_active
    and not r.is_deleted
    and r.tenant_id = public.current_tenant_id();
$$;
grant execute on function public.current_content_access_rank() to authenticated;

-- ----------------------------------------------------------------------------
-- 10. Write-side plumbing: stamp tenant_id, audit columns and row_version
-- ----------------------------------------------------------------------------

create or replace function public.apply_row_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.tenant_id is null then
      new.tenant_id := public.current_tenant_id();
    end if;
    if new.created_by is null then
      new.created_by := auth.uid();
    end if;
    new.updated_by := coalesce(auth.uid(), new.created_by);
    new.created_on := coalesce(new.created_on, now());
    new.updated_on := now();
    new.row_version := 1;
  else
    new.tenant_id := old.tenant_id;             -- a row never changes company
    new.created_by := old.created_by;
    new.created_on := old.created_on;
    new.updated_by := coalesce(auth.uid(), old.updated_by);
    new.updated_on := now();
    new.row_version := coalesce(old.row_version, 1) + 1;
    if new.is_deleted and not old.is_deleted then
      new.deleted_by := coalesce(new.deleted_by, auth.uid());
      new.deleted_date := coalesce(new.deleted_date, now());
    elsif not new.is_deleted and old.is_deleted then
      new.deleted_by := null;
      new.deleted_date := null;
    end if;
  end if;
  return new;
end;
$$;

do $$
declare
  business_tables text[] := array[
    'users', 'roles', 'user_roles', 'role_permissions',
    'templates', 'forms', 'form_attachments', 'form_approval_transactions',
    'approval_roles', 'approval_schemes', 'approval_scheme_roles',
    'departments', 'projects', 'sites', 'positions',
    'competencies', 'competency_indicators', 'goals', 'proficiency_levels',
    'evaluation_templates', 'evaluation_sections', 'evaluation_cycles',
    'evaluation_workflow_steps', 'performance_evaluations',
    'evaluation_goals', 'evaluation_competencies',
    'content_items', 'content_receipts',
    'lookup_values', 'system_settings', 'email_templates', 'email_queue',
    'import_jobs', 'import_job_rows'
  ];
  tbl text;
begin
  foreach tbl in array business_tables loop
    if to_regclass('public.' || tbl) is null then
      continue;
    end if;
    execute format('drop trigger if exists apply_row_defaults on public.%I', tbl);
    execute format(
      'create trigger apply_row_defaults before insert or update on public.%I
       for each row execute function public.apply_row_defaults()',
      tbl
    );
  end loop;
end $$;

-- write_audit_log() is defined in section 5b, because the backfill writes to
-- audited tables before it reaches this point.

-- ----------------------------------------------------------------------------
-- 11. Tenant isolation: one RESTRICTIVE policy per table
--     Existing permission policies stay as they are; this policy is ANDed with
--     them, so nothing can ever read or write across companies.
-- ----------------------------------------------------------------------------

do $$
declare
  business_tables text[] := array[
    'users', 'roles', 'user_roles', 'role_permissions',
    'templates', 'forms', 'form_attachments', 'form_approval_transactions',
    'approval_roles', 'approval_schemes', 'approval_scheme_roles',
    'departments', 'projects', 'sites', 'positions',
    'competencies', 'competency_indicators', 'goals', 'proficiency_levels',
    'evaluation_templates', 'evaluation_sections', 'evaluation_cycles',
    'evaluation_workflow_steps', 'performance_evaluations',
    'evaluation_goals', 'evaluation_competencies',
    'content_items', 'content_receipts',
    'lookup_values', 'system_settings', 'email_templates', 'email_queue',
    'import_jobs', 'import_job_rows', 'audit_logs'
  ];
  tbl text;
begin
  foreach tbl in array business_tables loop
    if to_regclass('public.' || tbl) is null then
      continue;
    end if;
    execute format('alter table public.%I enable row level security', tbl);
    execute format('drop policy if exists "tenant isolation" on public.%I', tbl);
    execute format(
      'create policy "tenant isolation" on public.%I
         as restrictive for all to authenticated
         using (tenant_id = public.current_tenant_id())
         with check (tenant_id = public.current_tenant_id())',
      tbl
    );
  end loop;
end $$;

-- Child tables reached only through their parent still need a read path.
drop policy if exists "authenticated read role permissions" on public.role_permissions;
create policy "authenticated read role permissions" on public.role_permissions
  for select to authenticated using (true);

drop policy if exists "authenticated read approval scheme roles tenant" on public.approval_scheme_roles;

-- ----------------------------------------------------------------------------
-- 12. RLS for the tenant tables themselves
-- ----------------------------------------------------------------------------

alter table public.tenants enable row level security;
alter table public.tenant_names enable row level security;
alter table public.tenant_branding enable row level security;
alter table public.tenant_contacts enable row level security;
alter table public.tenant_settings enable row level security;
alter table public.tenant_domains enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.tenant_modules enable row level security;
alter table public.tenant_quotas enable row level security;
alter table public.tenant_usage_daily enable row level security;
alter table public.platform_modules enable row level security;
alter table public.platform_licenses enable row level security;
alter table public.platform_quota_resources enable row level security;
alter table public.platform_reserved_slugs enable row level security;

drop policy if exists "members read own tenant" on public.tenants;
create policy "members read own tenant" on public.tenants
  for select to authenticated
  using (id = public.current_tenant_id() or public.is_platform_operator());

drop policy if exists "platform operators manage tenants" on public.tenants;
create policy "platform operators manage tenants" on public.tenants
  for all to authenticated
  using (public.is_platform_operator())
  with check (public.is_platform_operator());

drop policy if exists "tenant admins update own tenant" on public.tenants;
create policy "tenant admins update own tenant" on public.tenants
  for update to authenticated
  using (id = public.current_tenant_id() and public.has_permission('Settings.Manage'))
  with check (id = public.current_tenant_id() and public.has_permission('Settings.Manage'));

do $$
declare
  tenant_child_tables text[] := array[
    'tenant_names', 'tenant_branding', 'tenant_contacts', 'tenant_settings', 'tenant_domains'
  ];
  tbl text;
begin
  foreach tbl in array tenant_child_tables loop
    execute format('drop policy if exists "members read tenant identity" on public.%I', tbl);
    execute format(
      'create policy "members read tenant identity" on public.%I
         for select to authenticated
         using (tenant_id = public.current_tenant_id() or public.is_platform_operator())',
      tbl
    );
    execute format('drop policy if exists "tenant admins manage identity" on public.%I', tbl);
    execute format(
      'create policy "tenant admins manage identity" on public.%I
         for all to authenticated
         using ((tenant_id = public.current_tenant_id() and public.has_permission(''Settings.Manage''))
                or public.is_platform_operator())
         with check ((tenant_id = public.current_tenant_id() and public.has_permission(''Settings.Manage''))
                or public.is_platform_operator())',
      tbl
    );
  end loop;
end $$;

drop policy if exists "users read own memberships" on public.tenant_memberships;
create policy "users read own memberships" on public.tenant_memberships
  for select to authenticated
  using (user_id = auth.uid() or tenant_id = public.current_tenant_id() or public.is_platform_operator());

drop policy if exists "tenant admins manage memberships" on public.tenant_memberships;
create policy "tenant admins manage memberships" on public.tenant_memberships
  for all to authenticated
  using ((tenant_id = public.current_tenant_id() and public.has_permission('Employees.Manage'))
         or public.is_platform_operator())
  with check ((tenant_id = public.current_tenant_id() and public.has_permission('Employees.Manage'))
         or public.is_platform_operator());

drop policy if exists "members read tenant modules" on public.tenant_modules;
create policy "members read tenant modules" on public.tenant_modules
  for select to authenticated
  using (tenant_id = public.current_tenant_id() or public.is_platform_operator());

drop policy if exists "platform operators manage tenant modules" on public.tenant_modules;
create policy "platform operators manage tenant modules" on public.tenant_modules
  for all to authenticated
  using (public.is_platform_operator())
  with check (public.is_platform_operator());

drop policy if exists "members read tenant quotas" on public.tenant_quotas;
create policy "members read tenant quotas" on public.tenant_quotas
  for select to authenticated
  using (tenant_id = public.current_tenant_id() or public.is_platform_operator());

drop policy if exists "platform operators manage quotas" on public.tenant_quotas;
create policy "platform operators manage quotas" on public.tenant_quotas
  for all to authenticated
  using (public.is_platform_operator())
  with check (public.is_platform_operator());

drop policy if exists "platform operators read usage" on public.tenant_usage_daily;
create policy "platform operators read usage" on public.tenant_usage_daily
  for select to authenticated
  using (tenant_id = public.current_tenant_id() or public.is_platform_operator());

drop policy if exists "authenticated read catalogues" on public.platform_modules;
create policy "authenticated read catalogues" on public.platform_modules
  for select to authenticated using (true);
drop policy if exists "authenticated read licenses" on public.platform_licenses;
create policy "authenticated read licenses" on public.platform_licenses
  for select to authenticated using (true);
drop policy if exists "authenticated read quota resources" on public.platform_quota_resources;
create policy "authenticated read quota resources" on public.platform_quota_resources
  for select to authenticated using (true);
drop policy if exists "platform operators manage catalogues" on public.platform_modules;
create policy "platform operators manage catalogues" on public.platform_modules
  for all to authenticated using (public.is_platform_operator()) with check (public.is_platform_operator());
drop policy if exists "platform operators manage licenses" on public.platform_licenses;
create policy "platform operators manage licenses" on public.platform_licenses
  for all to authenticated using (public.is_platform_operator()) with check (public.is_platform_operator());

-- ----------------------------------------------------------------------------
-- 13. Public (anonymous) tenant identity for the company landing and login
-- ----------------------------------------------------------------------------

create or replace function public.tenant_public_profile(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', t.id,
    'slug', t.slug,
    'status', t.status,
    'default_language', t.default_language,
    'timezone', t.timezone,
    'country_code', t.country_code,
    'is_platform', t.is_platform,
    'names', coalesce((
      select jsonb_object_agg(n.language_code, n.name)
      from public.tenant_names n where n.tenant_id = t.id
    ), '{}'::jsonb),
    'short_names', coalesce((
      select jsonb_object_agg(n.language_code, coalesce(n.short_name, n.name))
      from public.tenant_names n where n.tenant_id = t.id
    ), '{}'::jsonb),
    'branding', coalesce((
      select to_jsonb(b) - 'tenant_id' - 'created_by' - 'updated_by' - 'row_version'
      from public.tenant_branding b where b.tenant_id = t.id
    ), '{}'::jsonb),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'channel', c.channel, 'value', c.value,
        'label_ar', c.label_ar, 'label_en', c.label_en,
        'display_order', c.display_order
      ) order by c.display_order)
      from public.tenant_contacts c where c.tenant_id = t.id and c.is_public
    ), '[]'::jsonb),
    'modules', coalesce((
      select jsonb_object_agg(m.code, public.tenant_has_module(m.code, t.id))
      from public.platform_modules m where m.is_active
    ), '{}'::jsonb),
    'settings', coalesce((
      select jsonb_build_object(
        'rtl_default', s.rtl_default,
        'date_format', s.date_format,
        'time_format', s.time_format,
        'week_start', s.week_start,
        'currency', s.currency,
        'allow_user_language', s.allow_user_language,
        'session_timeout_minutes', s.session_timeout_minutes,
        'password_min_length', s.password_min_length,
        'password_require_upper', s.password_require_upper,
        'password_require_number', s.password_require_number,
        'password_require_symbol', s.password_require_symbol
      )
      from public.tenant_settings s where s.tenant_id = t.id
    ), '{}'::jsonb)
  )
  from public.tenants t
  where t.slug = lower(trim(p_slug))
    and not t.is_deleted
    and t.status in ('Active', 'Pending', 'Suspended');
$$;
grant execute on function public.tenant_public_profile(text) to anon, authenticated;

-- Slug availability for the subscription form.
create or replace function public.slug_is_available(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_slug text := lower(trim(coalesce(p_slug, '')));
begin
  if v_slug !~ '^[a-z0-9]{2,32}$' then
    return jsonb_build_object('available', false, 'reason', 'INVALID_FORMAT');
  end if;
  if exists (select 1 from public.platform_reserved_slugs where slug = v_slug) then
    return jsonb_build_object('available', false, 'reason', 'RESERVED');
  end if;
  if exists (select 1 from public.tenants where slug = v_slug) then
    return jsonb_build_object('available', false, 'reason', 'TAKEN');
  end if;
  return jsonb_build_object('available', true, 'reason', null);
end;
$$;
grant execute on function public.slug_is_available(text) to anon, authenticated;

-- The slug is the company's permanent address: it can never be changed.
create or replace function public.guard_tenant_slug()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.slug is distinct from old.slug then
    raise exception 'TENANT_SLUG_IS_IMMUTABLE' using errcode = '23514';
  end if;
  if exists (select 1 from public.platform_reserved_slugs where slug = new.slug) and tg_op = 'INSERT' then
    if not coalesce(new.is_platform, false) then
      raise exception 'TENANT_SLUG_RESERVED' using errcode = '23514';
    end if;
  end if;
  new.updated_on := now();
  return new;
end;
$$;

drop trigger if exists guard_tenant_slug on public.tenants;
create trigger guard_tenant_slug
before insert or update on public.tenants
for each row execute function public.guard_tenant_slug();

-- ----------------------------------------------------------------------------
-- 14. Session tenant switching (multi-company users)
-- ----------------------------------------------------------------------------

create or replace function public.switch_tenant(p_tenant_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.tenant_memberships m
    where m.user_id = auth.uid() and m.tenant_id = p_tenant_id and m.status = 'Active'
  ) then
    raise exception 'NOT_A_MEMBER_OF_THIS_TENANT';
  end if;

  update public.users set active_tenant_id = p_tenant_id where id = auth.uid();
  return jsonb_build_object('tenant_id', p_tenant_id);
end;
$$;
grant execute on function public.switch_tenant(uuid) to authenticated;

create or replace function public.my_tenants()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'tenant_id', t.id,
    'slug', t.slug,
    'status', t.status,
    'is_platform', t.is_platform,
    'is_active', t.id = public.current_tenant_id(),
    'names', coalesce((select jsonb_object_agg(n.language_code, n.name)
                       from public.tenant_names n where n.tenant_id = t.id), '{}'::jsonb)
  ) order by t.slug), '[]'::jsonb)
  from public.tenant_memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = auth.uid() and m.status = 'Active' and not t.is_deleted;
$$;
grant execute on function public.my_tenants() to authenticated;

-- ----------------------------------------------------------------------------
-- 15. Roles: PLATFORM_OPERATOR exists only inside the platform tenant
-- ----------------------------------------------------------------------------

insert into public.permissions (code, module, description) values
  ('Platform.Manage', 'Platform', 'Manage tenants, licenses, modules and quotas'),
  ('Platform.Support', 'Platform', 'Answer support tickets across tenants'),
  ('Platform.Storage', 'Platform', 'Manage storage providers and company storage'),
  ('Platform.Health', 'Platform', 'View platform health and usage'),
  ('Tenant.Profile.Manage', 'Settings', 'Edit the company profile and identity'),
  ('Announcements.Manage', 'Announcements', 'Publish and manage announcements'),
  ('Surveys.Manage', 'Surveys', 'Publish and manage surveys'),
  ('Calendar.Manage', 'Calendar', 'Manage company calendar events'),
  ('Verification.Manage', 'Verification', 'Manage verifiable documents and certificates'),
  ('Support.Manage', 'Support', 'Raise and follow support tickets'),
  ('Screens.Manage', 'Settings', 'Assign screens and services to roles')
on conflict (code) do nothing;

do $$
declare
  platform_tenant uuid;
  operator_role uuid;
begin
  select id into platform_tenant from public.tenants where slug = 'platform';

  insert into public.roles (tenant_id, code, name_ar, name_en, description, is_system, is_active)
  values (platform_tenant, 'PLATFORM_OPERATOR', 'مشغّل المنصة', 'Platform Operator',
          'Runs the platform: tenants, licenses, quotas, storage and support', true, true)
  on conflict do nothing;

  select id into operator_role from public.roles
  where tenant_id = platform_tenant and code = 'PLATFORM_OPERATOR';

  if operator_role is not null then
    insert into public.role_permissions (tenant_id, role_id, permission_id)
    select platform_tenant, operator_role, p.id from public.permissions p
    on conflict do nothing;
  end if;

  -- The platform workspace also needs the standard tenant roles.
  insert into public.roles (tenant_id, code, name_ar, name_en, is_system, is_active)
  select platform_tenant, r.code, r.name_ar, r.name_en, true, true
  from (values
    ('PLATFORM_ADMIN', 'مدير المؤسسة', 'Organization Administrator'),
    ('SYSTEM_ADMIN', 'مدير النظام', 'System Administrator'),
    ('DEPARTMENT_MANAGER', 'مدير إدارة', 'Department Manager'),
    ('DEPARTMENT_COORDINATOR', 'منسق إدارة', 'Department Coordinator'),
    ('EMPLOYEE', 'موظف', 'Employee')
  ) as r(code, name_ar, name_en)
  on conflict do nothing;

  insert into public.role_permissions (tenant_id, role_id, permission_id)
  select platform_tenant, r.id, p.id
  from public.roles r
  cross join public.permissions p
  where r.tenant_id = platform_tenant and r.code = 'PLATFORM_ADMIN'
    and p.module <> 'Platform'
  on conflict do nothing;
end $$;

-- PLATFORM_ADMIN is now the company-level administrator, not a platform role.
update public.roles
set name_ar = 'مدير المؤسسة',
    name_en = 'Organization Administrator',
    description = 'Full administrator inside their own company'
where code = 'PLATFORM_ADMIN';

-- Give the new permissions to the company administrators of every tenant.
insert into public.role_permissions (tenant_id, role_id, permission_id)
select r.tenant_id, r.id, p.id
from public.roles r
join public.permissions p
  on p.code in (
    'Tenant.Profile.Manage', 'Announcements.Manage', 'Surveys.Manage',
    'Calendar.Manage', 'Verification.Manage', 'Support.Manage', 'Screens.Manage'
  )
where r.code in ('PLATFORM_ADMIN', 'SYSTEM_ADMIN') and not r.is_deleted
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- 16. Membership backfill for the existing Shalfa users
-- ----------------------------------------------------------------------------

insert into public.tenant_memberships (tenant_id, user_id, employee_id, role_id, status, is_owner)
select
  u.tenant_id,
  u.id,
  u.id,
  (select ur.role_id from public.user_roles ur where ur.user_id = u.id limit 1),
  case when u.is_active then 'Active' else 'Suspended' end,
  coalesce((select r.code from public.user_roles ur join public.roles r on r.id = ur.role_id
            where ur.user_id = u.id limit 1) = 'PLATFORM_ADMIN', false)
from public.users u
where not u.is_deleted
on conflict (tenant_id, user_id) do nothing;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_memberships_employee') then
    alter table public.tenant_memberships
      add constraint fk_memberships_employee
      foreign key (employee_id) references public.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_memberships_role') then
    alter table public.tenant_memberships
      add constraint fk_memberships_role
      foreign key (role_id) references public.roles(id) on delete set null;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 17. New auth identities land in the right company
-- ----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_role_code text;
  v_role_id uuid;
begin
  v_tenant := nullif(new.raw_user_meta_data ->> 'tenant_id', '')::uuid;

  if v_tenant is null then
    select id into v_tenant from public.tenants
    where slug = lower(coalesce(new.raw_user_meta_data ->> 'tenant_slug', ''));
  end if;

  -- Without a company we cannot create an employee record; the provisioning
  -- functions always pass one.
  if v_tenant is null then
    return new;
  end if;

  insert into public.users (
    id, tenant_id, active_tenant_id, email, employee_no, full_name, name_ar, name_en,
    mobile, department, job_title, job_title_ar, job_title_en, is_active, account_activated_on
  )
  values (
    new.id,
    v_tenant,
    v_tenant,
    lower(new.email),
    new.raw_user_meta_data ->> 'employee_no',
    coalesce(
      new.raw_user_meta_data ->> 'name_ar',
      new.raw_user_meta_data ->> 'name_en',
      new.raw_user_meta_data ->> 'full_name',
      new.email
    ),
    new.raw_user_meta_data ->> 'name_ar',
    new.raw_user_meta_data ->> 'name_en',
    new.raw_user_meta_data ->> 'mobile',
    new.raw_user_meta_data ->> 'department',
    coalesce(
      new.raw_user_meta_data ->> 'job_title_ar',
      new.raw_user_meta_data ->> 'job_title_en',
      new.raw_user_meta_data ->> 'job_title'
    ),
    new.raw_user_meta_data ->> 'job_title_ar',
    new.raw_user_meta_data ->> 'job_title_en',
    coalesce((new.raw_user_meta_data ->> 'is_active')::boolean, true),
    case when coalesce((new.raw_user_meta_data ->> 'is_active')::boolean, true) then now() else null end
  )
  on conflict (id) do update set
    email = excluded.email,
    tenant_id = coalesce(public.users.tenant_id, excluded.tenant_id),
    active_tenant_id = coalesce(public.users.active_tenant_id, excluded.active_tenant_id),
    full_name = coalesce(excluded.full_name, public.users.full_name),
    name_ar = coalesce(excluded.name_ar, public.users.name_ar),
    name_en = coalesce(excluded.name_en, public.users.name_en),
    mobile = coalesce(excluded.mobile, public.users.mobile),
    employee_no = coalesce(excluded.employee_no, public.users.employee_no),
    updated_on = now();

  v_role_code := coalesce(new.raw_user_meta_data ->> 'role_code', 'EMPLOYEE');
  select id into v_role_id from public.roles
  where tenant_id = v_tenant and code = v_role_code and not is_deleted
  limit 1;

  if v_role_id is not null then
    insert into public.user_roles(tenant_id, user_id, role_id)
    values (v_tenant, new.id, v_role_id)
    on conflict do nothing;
  end if;

  insert into public.tenant_memberships (tenant_id, user_id, employee_id, role_id, status)
  values (v_tenant, new.id, new.id, v_role_id,
          case when coalesce((new.raw_user_meta_data ->> 'is_active')::boolean, true)
               then 'Active' else 'Invited' end)
  on conflict (tenant_id, user_id) do update set role_id = coalesce(excluded.role_id, public.tenant_memberships.role_id);

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 18. Verification codes are prefixed with the company slug so two companies
--     can never produce the same document code.
-- ----------------------------------------------------------------------------

create or replace function public.generate_verify_code(p_tenant_id uuid default null)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_slug text;
  candidate text;
begin
  select t.slug into v_slug
  from public.tenants t
  where t.id = coalesce(p_tenant_id, public.current_tenant_id());

  v_slug := coalesce(v_slug, 'bbx');

  loop
    candidate := upper(v_slug) || '-' || (floor(random() * 8e11) + 1e11)::bigint::text;
    exit when not exists (select 1 from public.forms where verify_code = candidate);
  end loop;
  return candidate;
end;
$$;

-- Keep the zero-argument signature the approval engine already calls.
create or replace function public.generate_verify_code()
returns text
language sql
volatile
security definer
set search_path = public
as $$
  select public.generate_verify_code(public.current_tenant_id());
$$;

-- ----------------------------------------------------------------------------
-- 19. Storage is organised per company
-- ----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tenant-branding',
  'tenant-branding',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml', 'image/x-icon']
)
on conflict (id) do update set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "public read branding" on storage.objects;
create policy "public read branding"
on storage.objects for select to public
using (bucket_id = 'tenant-branding');

drop policy if exists "tenant admins write branding" on storage.objects;
create policy "tenant admins write branding"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'tenant-branding'
  and (storage.foldername(name))[1] = 'tenants'
  and (storage.foldername(name))[2] = public.current_tenant_id()::text
  and public.has_permission('Settings.Manage')
);

drop policy if exists "tenant admins update branding" on storage.objects;
create policy "tenant admins update branding"
on storage.objects for update to authenticated
using (
  bucket_id = 'tenant-branding'
  and (storage.foldername(name))[2] = public.current_tenant_id()::text
  and public.has_permission('Settings.Manage')
)
with check (
  bucket_id = 'tenant-branding'
  and (storage.foldername(name))[2] = public.current_tenant_id()::text
  and public.has_permission('Settings.Manage')
);

drop policy if exists "tenant admins delete branding" on storage.objects;
create policy "tenant admins delete branding"
on storage.objects for delete to authenticated
using (
  bucket_id = 'tenant-branding'
  and (storage.foldername(name))[2] = public.current_tenant_id()::text
  and public.has_permission('Settings.Manage')
);

-- Employee assets move under tenants/{tenant_id}/employees/{user_id}/...
drop policy if exists "employees upload own profile assets" on storage.objects;
create policy "employees upload own profile assets"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'employee-assets'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or (
      (storage.foldername(name))[1] = 'tenants'
      and (storage.foldername(name))[2] = public.current_tenant_id()::text
      and (storage.foldername(name))[4] = auth.uid()::text
    )
  )
);

drop policy if exists "employees read own profile assets" on storage.objects;
create policy "employees read own profile assets"
on storage.objects for select to authenticated
using (
  bucket_id = 'employee-assets'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or (
      (storage.foldername(name))[1] = 'tenants'
      and (storage.foldername(name))[2] = public.current_tenant_id()::text
    )
  )
);

-- ----------------------------------------------------------------------------
-- 20. Quota helper used by every upload / create path
-- ----------------------------------------------------------------------------

create or replace function public.tenant_quota_check(p_resource text, p_delta bigint default 1)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_quota public.tenant_quotas%rowtype;
begin
  select * into v_quota from public.tenant_quotas
  where tenant_id = v_tenant and resource_code = p_resource;

  if not found or not v_quota.is_enforced or v_quota.limit_value <= 0 then
    return jsonb_build_object('allowed', true, 'limit', null, 'used', null);
  end if;

  return jsonb_build_object(
    'allowed', (v_quota.used_value + p_delta) <= v_quota.limit_value,
    'limit', v_quota.limit_value,
    'used', v_quota.used_value,
    'remaining', greatest(v_quota.limit_value - v_quota.used_value, 0)
  );
end;
$$;
grant execute on function public.tenant_quota_check(text, bigint) to authenticated;

create or replace function public.tenant_quota_consume(p_resource text, p_delta bigint default 1, p_tenant_id uuid default null)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  insert into public.tenant_quotas (tenant_id, resource_code, limit_value, used_value)
  values (coalesce(p_tenant_id, public.current_tenant_id()), p_resource, 0, greatest(p_delta, 0))
  on conflict (tenant_id, resource_code) do update
    set used_value = greatest(public.tenant_quotas.used_value + p_delta, 0),
        updated_on = now();
$$;
grant execute on function public.tenant_quota_consume(text, bigint, uuid) to authenticated;

-- Seed the current Shalfa usage so the platform screens are meaningful.
do $$
declare
  shalfa uuid;
begin
  select id into shalfa from public.tenants where slug = 'shalfa';
  update public.tenant_quotas q
  set used_value = case q.resource_code
    when 'EMPLOYEES' then (select count(*) from public.users where tenant_id = shalfa and not is_deleted)
    when 'DEPARTMENTS' then (select count(*) from public.departments where tenant_id = shalfa and not is_deleted)
    when 'PROJECTS' then (select count(*) from public.projects where tenant_id = shalfa and not is_deleted)
    when 'SITES' then (select count(*) from public.sites where tenant_id = shalfa and not is_deleted)
    when 'FORMS' then (select count(*) from public.forms where tenant_id = shalfa and not is_deleted)
    when 'TEMPLATES' then (select count(*) from public.templates where tenant_id = shalfa and not is_deleted)
    when 'DOCUMENTS' then (select count(*) from public.content_items where tenant_id = shalfa and not is_deleted)
    else q.used_value
  end
  where q.tenant_id = shalfa;
end $$;
