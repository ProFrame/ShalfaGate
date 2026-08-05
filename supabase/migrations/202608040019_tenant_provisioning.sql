-- ============================================================================
-- 019 — Self-service tenant provisioning
--
-- The product is free and unattended: somebody opens /signup, fills the form,
-- saves, and a complete company exists a second later with its own address
-- (bbnovix.com/{slug}/), its own roles, its own approval chain and one active
-- administrator who receives a password-set link by email.
--
-- Three objects carry that:
--   * tenant_signup_requests — the audit trail of every submission. It predates
--     the company it asks for, so it is filed under the platform tenant and
--     remembers the company it produced in provisioned_tenant_id.
--   * bootstrap_tenant_defaults — everything a brand new company needs on day
--     one. Written to be re-runnable so a half-provisioned tenant can be healed
--     without deleting it.
--   * provision_tenant — one transaction: company, identity, branding, defaults,
--     owner, welcome email. Reachable only with the service key, because it
--     creates companies; the anonymous form gets provision_tenant_preflight
--     instead, which validates and returns problems without writing anything.
--
-- The auth identity is created by the edge function *before* this runs and its
-- id is passed in. It must be created without tenant metadata: handle_new_user
-- (012) deliberately does nothing when it cannot resolve a company, which is
-- exactly the state at signup time.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The operator workspace, resolvable from a column default
-- ----------------------------------------------------------------------------

-- A signup request has no company yet, but the contract still wants a tenant_id
-- on every row. The platform workspace owns them until one is provisioned.
-- 018 declares the same helper; this repeats it so the file stands on its own.
create or replace function public.platform_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select t.id from public.tenants t where t.is_platform and not t.is_deleted
  order by t.created_on limit 1;
$$;
revoke all on function public.platform_tenant_id() from public;
grant execute on function public.platform_tenant_id() to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. Signup requests
-- ----------------------------------------------------------------------------

create table if not exists public.tenant_signup_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default public.platform_tenant_id()
    references public.tenants(id) on delete cascade,
  -- The company this submission produced, once it succeeded.
  provisioned_tenant_id uuid references public.tenants(id) on delete set null,
  slug text not null,
  company_name text,
  requested_by_name text not null,
  requested_by_email citext not null,
  requested_by_phone text,
  is_owner boolean not null default true,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'Pending'
    check (status in ('Pending', 'Approved', 'Rejected', 'Provisioned')),
  review_note text,
  reviewed_by uuid references auth.users(id),
  reviewed_on timestamptz,
  ip inet,
  user_agent text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

alter table public.tenant_signup_requests
  add column if not exists provisioned_tenant_id uuid references public.tenants(id) on delete set null,
  add column if not exists company_name text,
  add column if not exists review_note text,
  add column if not exists reviewed_by uuid references auth.users(id),
  add column if not exists reviewed_on timestamptz,
  add column if not exists user_agent text;

create index if not exists idx_tenant_signup_requests_tenant
  on public.tenant_signup_requests (tenant_id);
create index if not exists idx_tenant_signup_requests_status
  on public.tenant_signup_requests (status, created_on desc) where not is_deleted;
create index if not exists idx_tenant_signup_requests_slug
  on public.tenant_signup_requests (lower(slug));
create index if not exists idx_tenant_signup_requests_email
  on public.tenant_signup_requests (requested_by_email, created_on desc);

drop trigger if exists apply_row_defaults on public.tenant_signup_requests;
create trigger apply_row_defaults before insert or update on public.tenant_signup_requests
for each row execute function public.apply_row_defaults();

alter table public.tenant_signup_requests enable row level security;

drop policy if exists "tenant isolation" on public.tenant_signup_requests;
create policy "tenant isolation" on public.tenant_signup_requests
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- Rows sit in the platform tenant, so this reads as "operators only" even though
-- it never names a tenant: no company session can satisfy the isolation policy.
drop policy if exists "platform operators manage signup requests" on public.tenant_signup_requests;
create policy "platform operators manage signup requests" on public.tenant_signup_requests
  for all to authenticated
  using (public.is_platform_operator() or public.has_permission('Platform.Manage'))
  with check (public.is_platform_operator() or public.has_permission('Platform.Manage'));

grant select, insert, update on public.tenant_signup_requests to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. Platform email templates
--    Owned by the platform tenant: they are sent in the platform's name, before
--    the receiving company exists in one case.
-- ----------------------------------------------------------------------------

insert into public.email_templates (
  tenant_id, code, version, subject_ar, subject_en, body_html_ar, body_html_en, is_active
)
select
  public.platform_tenant_id(),
  'TENANT_WELCOME',
  1,
  'مرحباً بك في bbnovix — تم إنشاء {{company_name}}',
  'Welcome to bbnovix — {{company_name}} is ready',
  $html_ar$<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;background:#f4f6f8;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
    <h1 style="margin:0 0 12px;font-size:20px;color:#0b3b60">مرحباً {{owner_name}}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.9;color:#334155">
      تم إنشاء حساب <strong>{{company_name}}</strong> على منصة bbnovix بنجاح، وأصبح لشركتك رابط خاص بها.
    </p>
    <p style="margin:0 0 8px;font-size:15px;color:#334155">رابط الشركة:</p>
    <p style="margin:0 0 20px;font-size:16px"><a href="{{company_url}}" style="color:#0f766e">{{company_url}}</a></p>
    <p style="margin:0 0 8px;font-size:15px;color:#334155">اسم المستخدم الخاص بك:</p>
    <p style="margin:0 0 24px;font-size:16px;color:#0b3b60"><strong>{{user_name}}</strong></p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.9;color:#334155">
      لتفعيل حسابك يرجى تعيين كلمة المرور من الزر التالي، ثم تسجيل الدخول وإضافة بقية المستخدمين.
    </p>
    <p style="margin:0 0 24px">
      <a href="{{password_link}}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:16px">تعيين كلمة المرور</a>
    </p>
    <p style="margin:0;font-size:13px;color:#64748b">إذا لم تطلب هذا الحساب، تجاهل هذه الرسالة.</p>
  </div>
</div>$html_ar$,
  $html_en$<div dir="ltr" style="font-family:Segoe UI,Arial,sans-serif;background:#f4f6f8;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
    <h1 style="margin:0 0 12px;font-size:20px;color:#0b3b60">Welcome {{owner_name}}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#334155">
      <strong>{{company_name}}</strong> has been created on bbnovix and now has its own address.
    </p>
    <p style="margin:0 0 8px;font-size:15px;color:#334155">Your company link:</p>
    <p style="margin:0 0 20px;font-size:16px"><a href="{{company_url}}" style="color:#0f766e">{{company_url}}</a></p>
    <p style="margin:0 0 8px;font-size:15px;color:#334155">Your user name:</p>
    <p style="margin:0 0 24px;font-size:16px;color:#0b3b60"><strong>{{user_name}}</strong></p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#334155">
      Set your password with the button below, then sign in and create the rest of your users.
    </p>
    <p style="margin:0 0 24px">
      <a href="{{password_link}}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:16px">Set your password</a>
    </p>
    <p style="margin:0;font-size:13px;color:#64748b">If you did not request this account, ignore this message.</p>
  </div>
</div>$html_en$,
  true
where public.platform_tenant_id() is not null
  and not exists (
    select 1 from public.email_templates t
    where t.tenant_id = public.platform_tenant_id()
      and t.code = 'TENANT_WELCOME'
      and not t.is_deleted
  );

insert into public.email_templates (
  tenant_id, code, version, subject_ar, subject_en, body_html_ar, body_html_en, is_active
)
select
  public.platform_tenant_id(),
  'EMPLOYEE_INVITE',
  1,
  'دعوة للانضمام إلى {{company_name}}',
  'You have been invited to {{company_name}}',
  $html_ar$<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;background:#f4f6f8;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
    <h1 style="margin:0 0 12px;font-size:20px;color:#0b3b60">مرحباً {{employee_name}}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.9;color:#334155">
      تمت إضافتك إلى <strong>{{company_name}}</strong> على منصة bbnovix. اسم المستخدم الخاص بك هو <strong>{{user_name}}</strong>.
    </p>
    <p style="margin:0 0 24px">
      <a href="{{password_link}}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:16px">تعيين كلمة المرور</a>
    </p>
    <p style="margin:0;font-size:14px;color:#334155">رابط الدخول: <a href="{{company_url}}" style="color:#0f766e">{{company_url}}</a></p>
  </div>
</div>$html_ar$,
  $html_en$<div dir="ltr" style="font-family:Segoe UI,Arial,sans-serif;background:#f4f6f8;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
    <h1 style="margin:0 0 12px;font-size:20px;color:#0b3b60">Hello {{employee_name}}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#334155">
      You have been added to <strong>{{company_name}}</strong> on bbnovix. Your user name is <strong>{{user_name}}</strong>.
    </p>
    <p style="margin:0 0 24px">
      <a href="{{password_link}}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:16px">Set your password</a>
    </p>
    <p style="margin:0;font-size:14px;color:#334155">Sign in at <a href="{{company_url}}" style="color:#0f766e">{{company_url}}</a></p>
  </div>
</div>$html_en$,
  true
where public.platform_tenant_id() is not null
  and not exists (
    select 1 from public.email_templates t
    where t.tenant_id = public.platform_tenant_id()
      and t.code = 'EMPLOYEE_INVITE'
      and not t.is_deleted
  );

insert into public.email_templates (
  tenant_id, code, version, subject_ar, subject_en, body_html_ar, body_html_en, is_active
)
select
  public.platform_tenant_id(),
  'SUPPORT_TICKET_REPLY',
  1,
  'رد على طلب الدعم {{ticket_code}}',
  'Reply on support ticket {{ticket_code}}',
  $html_ar$<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;background:#f4f6f8;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
    <h1 style="margin:0 0 12px;font-size:20px;color:#0b3b60">طلب الدعم {{ticket_code}}</h1>
    <p style="margin:0 0 12px;font-size:15px;color:#334155">{{ticket_subject}}</p>
    <div style="margin:0 0 20px;padding:16px;background:#f8fafc;border-radius:12px;font-size:15px;line-height:1.9;color:#334155">{{reply_body}}</div>
    <p style="margin:0 0 20px">
      <a href="{{ticket_url}}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:16px">عرض الطلب</a>
    </p>
    <p style="margin:0;font-size:13px;color:#64748b">الحالة الحالية: {{ticket_status}}</p>
  </div>
</div>$html_ar$,
  $html_en$<div dir="ltr" style="font-family:Segoe UI,Arial,sans-serif;background:#f4f6f8;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
    <h1 style="margin:0 0 12px;font-size:20px;color:#0b3b60">Support ticket {{ticket_code}}</h1>
    <p style="margin:0 0 12px;font-size:15px;color:#334155">{{ticket_subject}}</p>
    <div style="margin:0 0 20px;padding:16px;background:#f8fafc;border-radius:12px;font-size:15px;line-height:1.7;color:#334155">{{reply_body}}</div>
    <p style="margin:0 0 20px">
      <a href="{{ticket_url}}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:16px">Open the ticket</a>
    </p>
    <p style="margin:0;font-size:13px;color:#64748b">Current status: {{ticket_status}}</p>
  </div>
</div>$html_en$,
  true
where public.platform_tenant_id() is not null
  and not exists (
    select 1 from public.email_templates t
    where t.tenant_id = public.platform_tenant_id()
      and t.code = 'SUPPORT_TICKET_REPLY'
      and not t.is_deleted
  );

-- ----------------------------------------------------------------------------
-- 4. Everything a new company needs on day one
--
--    Re-runnable on purpose: provisioning is a single transaction, but a tenant
--    created before a later migration added a default still has to be able to
--    catch up without being recreated.
-- ----------------------------------------------------------------------------

create or replace function public.bootstrap_tenant_defaults(p_tenant_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant public.tenants%rowtype;
  v_reference uuid;   -- the tenant the master data is modelled on
  v_standard uuid;
  v_department uuid;
  v_position uuid;
begin
  select * into v_tenant from public.tenants where id = p_tenant_id;
  if not found then
    raise exception 'TENANT_NOT_FOUND';
  end if;

  select id into v_reference from public.tenants where slug = 'shalfa' and not is_deleted;

  -- 4.1 Identity rows the whole application assumes exist.
  insert into public.tenant_branding (tenant_id) values (p_tenant_id)
  on conflict (tenant_id) do nothing;

  insert into public.tenant_settings (tenant_id) values (p_tenant_id)
  on conflict (tenant_id) do nothing;

  insert into public.tenant_modules (tenant_id, module_code, is_enabled)
  select p_tenant_id, m.code, true
  from public.platform_licenses l
  join public.platform_modules m on m.code = any (l.module_codes)
  where l.code = v_tenant.license_code and m.is_active
  on conflict (tenant_id, module_code) do nothing;

  insert into public.tenant_quotas (tenant_id, resource_code, limit_value)
  select p_tenant_id, r.code, coalesce((l.quota_defaults ->> r.code)::bigint, 0)
  from public.platform_licenses l
  cross join public.platform_quota_resources r
  where l.code = v_tenant.license_code
  on conflict (tenant_id, resource_code) do nothing;

  -- 4.2 The five standard roles.
  insert into public.roles (tenant_id, code, name_ar, name_en, description, is_system, is_active)
  select p_tenant_id, v.code, v.name_ar, v.name_en, v.description, true, true
  from (values
    ('PLATFORM_ADMIN', 'مدير المؤسسة', 'Organization Administrator',
     'Full administrator inside their own company'::text),
    ('SYSTEM_ADMIN', 'مدير النظام', 'System Administrator',
     'Runs the day to day administration of the company'),
    ('DEPARTMENT_MANAGER', 'مدير إدارة', 'Department Manager', null),
    ('DEPARTMENT_COORDINATOR', 'منسق إدارة', 'Department Coordinator', null),
    ('EMPLOYEE', 'موظف', 'Employee', null)
  ) as v(code, name_ar, name_en, description)
  where not exists (
    select 1 from public.roles r
    where r.tenant_id = p_tenant_id and r.code = v.code and not r.is_deleted
  );

  -- The baseline every employee of any company gets.
  insert into public.role_permissions (tenant_id, role_id, permission_id)
  select p_tenant_id, r.id, p.id
  from public.roles r
  join public.permissions p on p.code in (
    'Dashboard.View', 'Forms.View', 'Forms.Create', 'Forms.Update', 'Forms.Delete',
    'Profile.Update', 'Notes.Use'
  )
  where r.tenant_id = p_tenant_id
    and r.code in ('EMPLOYEE', 'DEPARTMENT_COORDINATOR', 'DEPARTMENT_MANAGER',
                   'SYSTEM_ADMIN', 'PLATFORM_ADMIN')
    and not r.is_deleted
  on conflict do nothing;

  -- The company system administrator. This list mirrors what the shalfa tenant
  -- holds today; a migration that registers a new permission for SYSTEM_ADMIN
  -- has to extend it here as well, otherwise companies created afterwards will
  -- silently miss it.
  insert into public.role_permissions (tenant_id, role_id, permission_id)
  select p_tenant_id, r.id, p.id
  from public.roles r
  join public.permissions p on p.code in (
    'Employees.Manage', 'Performance.Analytics.View', 'Approvals.Manage',
    'Tenant.Profile.Manage', 'Screens.Manage', 'Support.Manage', 'Support.View',
    'Announcements.Manage', 'Surveys.Manage', 'Calendar.Manage',
    'Verification.Manage', 'Verification.View', 'Certificates.Manage',
    'Organization.Manage', 'Audience.Manage', 'Forms.Manage', 'Chat.Manage',
    'Storage.Manage', 'Security.View'
  )
  where r.tenant_id = p_tenant_id and r.code = 'SYSTEM_ADMIN' and not r.is_deleted
  on conflict do nothing;

  -- The company administrator owns everything except the platform surface,
  -- which no company may ever see.
  insert into public.role_permissions (tenant_id, role_id, permission_id)
  select p_tenant_id, r.id, p.id
  from public.roles r
  cross join public.permissions p
  where r.tenant_id = p_tenant_id and r.code = 'PLATFORM_ADMIN' and not r.is_deleted
    and p.module <> 'Platform'
  on conflict do nothing;

  -- 4.3 Signing capacities and the chains they form.
  insert into public.approval_roles (tenant_id, code, name_ar, name_en, display_order, is_system, is_active)
  select p_tenant_id, v.code, v.name_ar, v.name_en, v.display_order, true, true
  from (values
    ('REQUESTER', 'منشئ الطلب', 'Requester', 0),
    ('DIRECT_MANAGER', 'المدير المباشر', 'Direct Manager', 10),
    ('HR', 'الموارد البشرية', 'Human Resources', 20),
    ('RECOMMENDATION', 'التوصية', 'Recommendation', 30),
    ('WAREHOUSE_OFFICER', 'مسؤول المستودع', 'Warehouse Officer', 40),
    ('PURCHASING_MANAGER', 'مدير المشتريات', 'Purchasing Manager', 50),
    ('FINAL_APPROVAL', 'الاعتماد', 'Final Approval', 60)
  ) as v(code, name_ar, name_en, display_order)
  where not exists (
    select 1 from public.approval_roles a
    where a.tenant_id = p_tenant_id and a.code = v.code and not a.is_deleted
  );

  insert into public.approval_schemes (tenant_id, code, name_ar, name_en, description, is_active)
  select p_tenant_id, v.code, v.name_ar, v.name_en, v.description, true
  from (values
    ('STANDARD', 'الاعتماد القياسي', 'Standard Approval',
     'منشئ الطلب ثم التوصية ثم الاعتماد'::text),
    ('HR_CHAIN', 'سلسلة الموارد البشرية', 'HR Chain',
     'منشئ الطلب ثم المدير المباشر ثم الموارد البشرية ثم الاعتماد'),
    ('PURCHASING_CHAIN', 'سلسلة المشتريات', 'Purchasing Chain',
     'منشئ الطلب ثم مسؤول المستودع ثم مدير المشتريات')
  ) as v(code, name_ar, name_en, description)
  where not exists (
    select 1 from public.approval_schemes s
    where s.tenant_id = p_tenant_id and s.code = v.code and not s.is_deleted
  );

  insert into public.approval_scheme_roles (tenant_id, scheme_id, approval_role_id, display_order, is_required)
  select p_tenant_id, s.id, a.id, v.display_order, true
  from (values
    ('STANDARD', 'REQUESTER', 1),
    ('STANDARD', 'RECOMMENDATION', 2),
    ('STANDARD', 'FINAL_APPROVAL', 3),
    ('HR_CHAIN', 'REQUESTER', 1),
    ('HR_CHAIN', 'DIRECT_MANAGER', 2),
    ('HR_CHAIN', 'HR', 3),
    ('HR_CHAIN', 'FINAL_APPROVAL', 4),
    ('PURCHASING_CHAIN', 'REQUESTER', 1),
    ('PURCHASING_CHAIN', 'WAREHOUSE_OFFICER', 2),
    ('PURCHASING_CHAIN', 'PURCHASING_MANAGER', 3)
  ) as v(scheme_code, role_code, display_order)
  join public.approval_schemes s
    on s.tenant_id = p_tenant_id and s.code = v.scheme_code and not s.is_deleted
  join public.approval_roles a
    on a.tenant_id = p_tenant_id and a.code = v.role_code and not a.is_deleted
  on conflict (scheme_id, approval_role_id) do nothing;

  select id into v_standard
  from public.approval_schemes
  where tenant_id = p_tenant_id and code = 'STANDARD' and not is_deleted;

  -- 4.4 The two standard form templates. The codes are the ones the forms
  -- screens look for, so they are copied verbatim rather than regenerated; the
  -- shalfa rows supply the wording when they are present.
  insert into public.templates (
    tenant_id, code, name, name_ar, name_en,
    description, description_ar, description_en,
    category, version, display_order, is_active, approval_scheme_id
  )
  select
    p_tenant_id,
    d.code,
    coalesce(s.name, d.name),
    coalesce(s.name_ar, d.name_ar),
    coalesce(s.name_en, d.name_en),
    coalesce(s.description, d.description_en),
    coalesce(s.description_ar, d.description_ar),
    coalesce(s.description_en, d.description_en),
    coalesce(s.category, d.category),
    coalesce(s.version, 1),
    coalesce(s.display_order, d.display_order),
    true,
    coalesce(
      (select ns.id
       from public.approval_schemes ns
       join public.approval_schemes ss on ss.id = s.approval_scheme_id
       where ns.tenant_id = p_tenant_id and ns.code = ss.code and not ns.is_deleted),
      v_standard
    )
  from (values
    ('FM-SH-PER-O-24-0053\V1.3',
     'Comprehensive Performance Evaluation Form',
     'نموذج تقييم الأداء الشامل',
     'Comprehensive Performance Evaluation Form',
     'نموذج شامل لتقييم الأهداف والجدارات ونتيجة الأداء.',
     'A comprehensive form for evaluating objectives, competencies, and overall performance.',
     'Performance Management', 10),
    ('FM-SH-INM-R-23-0025\V1.2',
     'Internal Memo Form',
     'نموذج مذكرة داخلية',
     'Internal Memo Form',
     'نموذج موحد لإعداد وحفظ وطباعة المذكرات الداخلية.',
     'A standardized form for preparing, saving and printing internal memos.',
     'Organization Development', 20)
  ) as d(code, name, name_ar, name_en, description_ar, description_en, category, display_order)
  left join public.templates s
    on s.tenant_id = v_reference and s.code = d.code and not s.is_deleted
  where not exists (
    select 1 from public.templates x
    where x.tenant_id = p_tenant_id and x.code = d.code and not x.is_deleted
  );

  -- 4.5 Performance library scaffolding.
  insert into public.proficiency_levels (
    tenant_id, level_no, code, name_ar, name_en, description_ar, description_en,
    display_order, is_active
  )
  select p_tenant_id, v.level_no, v.code, v.name_ar, v.name_en, v.description_ar, v.description_en,
         v.level_no * 10, true
  from (values
    (1, 'L1', 'مبتدئ', 'Beginner',
     'يحتاج توجيهاً مباشراً ومتابعة مستمرة.', 'Requires direct guidance and continuous follow-up.'),
    (2, 'L2', 'أساسي', 'Basic',
     'يطبق الأساسيات في المواقف المعتادة.', 'Applies fundamentals in routine situations.'),
    (3, 'L3', 'متمكن', 'Proficient',
     'ينفذ باستقلالية وبجودة ثابتة.', 'Works independently with consistent quality.'),
    (4, 'L4', 'متقدم', 'Advanced',
     'يتعامل مع الحالات المعقدة ويدعم الآخرين.', 'Handles complex situations and supports others.'),
    (5, 'L5', 'خبير', 'Expert',
     'مرجع معرفي يطور الممارسة والمعايير.', 'A subject reference who advances practice and standards.')
  ) as v(level_no, code, name_ar, name_en, description_ar, description_en)
  where not exists (
    select 1 from public.proficiency_levels x
    where x.tenant_id = p_tenant_id and x.level_no = v.level_no and not x.is_deleted
  );

  -- 4.6 Lookup values and the country list are reference data, not customer
  -- data, so a new company starts from the same catalogue.
  if v_reference is not null then
    insert into public.lookup_values (
      tenant_id, lookup_type, code, name_ar, name_en,
      description_ar, description_en, display_order, is_active
    )
    select p_tenant_id, l.lookup_type, l.code, l.name_ar, l.name_en,
           l.description_ar, l.description_en, l.display_order, l.is_active
    from public.lookup_values l
    where l.tenant_id = v_reference and not l.is_deleted
      and not exists (
        select 1 from public.lookup_values x
        where x.tenant_id = p_tenant_id
          and x.lookup_type = l.lookup_type
          and x.code = l.code
          and not x.is_deleted
      );

    insert into public.countries (
      tenant_id, code, iso_code, name_ar, name_en,
      nationality_ar, nationality_en, dial_code, display_order, is_active
    )
    select p_tenant_id, c.code, c.iso_code, c.name_ar, c.name_en,
           c.nationality_ar, c.nationality_en, c.dial_code, c.display_order, c.is_active
    from public.countries c
    where c.tenant_id = v_reference and not c.is_deleted
      and not exists (
        select 1 from public.countries x
        where x.tenant_id = p_tenant_id
          and lower(x.code) = lower(c.code)
          and not x.is_deleted
      );
  end if;

  -- 4.7 One department and one position, so the first employee has somewhere
  -- to live and the org screens are never empty.
  select id into v_department
  from public.departments
  where tenant_id = p_tenant_id and lower(code) = 'general' and not is_deleted;

  if v_department is null then
    insert into public.departments (
      tenant_id, code, name_ar, name_en, description_ar, description_en, display_order, is_active
    )
    values (
      p_tenant_id, 'GENERAL', 'الإدارة العامة', 'General Management',
      'الإدارة الافتراضية التي ينشأ عليها الحساب.',
      'The default department a new company starts with.',
      10, true
    )
    returning id into v_department;
  end if;

  select id into v_position
  from public.positions
  where tenant_id = p_tenant_id and lower(code) = 'general' and not is_deleted;

  if v_position is null then
    insert into public.positions (
      tenant_id, code, name_ar, name_en, department_id, display_order, is_active
    )
    values (p_tenant_id, 'GENERAL', 'موظف', 'Employee', v_department, 10, true)
    returning id into v_position;
  end if;

  return jsonb_build_object(
    'tenant_id', p_tenant_id,
    'department_id', v_department,
    'position_id', v_position,
    'approval_scheme_id', v_standard
  );
end;
$$;

revoke all on function public.bootstrap_tenant_defaults(uuid) from public;
revoke all on function public.bootstrap_tenant_defaults(uuid) from anon, authenticated;
grant execute on function public.bootstrap_tenant_defaults(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 5. Provisioning
--
--    service_role only. An anonymous caller must never be able to create a
--    company, so the signup page reaches this through an edge function that
--    creates the auth identity first and holds the service key.
-- ----------------------------------------------------------------------------

-- Every company numbers its own employees, so the owner below is always number
-- 1. 012 replaced the global uniqueness of users.employee_no with the
-- per-company index uq_users_employee_no_tenant but left the table constraint
-- created in 001 in place, so the second company provisioned would abort on it.
alter table public.users drop constraint if exists users_employee_no_key;

create or replace function public.provision_tenant(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_slug text;
  v_availability jsonb;
  v_names jsonb;
  v_language text;
  v_company_name text;
  v_timezone text;
  v_country text;
  v_code text;
  v_attempt integer := 0;
  v_tenant uuid;
  v_owner jsonb;
  v_auth_user uuid;
  v_owner_email text;
  v_owner_name text;
  v_role uuid;
  v_department uuid;
  v_position uuid;
  v_template uuid;
  v_platform uuid;
  v_request uuid;
  v_url text;
  v_ip inet;
  v_queue_language text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'PAYLOAD_REQUIRED';
  end if;

  -- 5.1 The address. Permanent, unique, never a platform word.
  v_slug := lower(trim(coalesce(p_payload ->> 'slug', '')));
  v_availability := public.slug_is_available(v_slug);
  if not coalesce((v_availability ->> 'available')::boolean, false) then
    case v_availability ->> 'reason'
      when 'RESERVED' then raise exception 'SLUG_RESERVED';
      when 'TAKEN' then raise exception 'SLUG_UNAVAILABLE';
      else raise exception 'SLUG_INVALID';
    end case;
  end if;

  -- 5.2 The company name. The default language row is the fallback for every
  -- language the company did not fill in, so it cannot be missing.
  v_names := coalesce(p_payload -> 'names', '{}'::jsonb);
  if jsonb_typeof(v_names) <> 'object' then
    v_names := '{}'::jsonb;
  end if;

  v_language := lower(nullif(trim(coalesce(p_payload ->> 'default_language', '')), ''));
  if v_language is null then
    v_language := 'ar';
  end if;

  v_company_name := nullif(trim(coalesce(v_names ->> v_language, '')), '');
  if v_company_name is null then
    raise exception 'COMPANY_NAME_REQUIRED';
  end if;

  -- 5.3 The owner identity, created by the edge function a moment ago. The
  -- email is read back from auth so the users guard trigger cannot reject it.
  v_owner := coalesce(p_payload -> 'owner', '{}'::jsonb);
  if jsonb_typeof(v_owner) <> 'object' then
    v_owner := '{}'::jsonb;
  end if;

  begin
    v_auth_user := nullif(trim(coalesce(v_owner ->> 'auth_user_id', '')), '')::uuid;
  exception when others then
    raise exception 'OWNER_AUTH_USER_INVALID';
  end;

  if v_auth_user is null then
    raise exception 'OWNER_AUTH_USER_REQUIRED';
  end if;

  select lower(trim(u.email)) into v_owner_email from auth.users u where u.id = v_auth_user;
  if v_owner_email is null or v_owner_email = '' then
    raise exception 'OWNER_AUTH_USER_NOT_FOUND';
  end if;

  if exists (select 1 from public.users u where u.id = v_auth_user) then
    raise exception 'OWNER_ALREADY_REGISTERED';
  end if;

  v_owner_name := coalesce(
    nullif(trim(coalesce(v_owner ->> 'name_1', '')), ''),
    nullif(trim(coalesce(v_owner ->> 'name_2', '')), ''),
    v_owner_email
  );

  -- 5.4 The company row.
  v_timezone := nullif(trim(coalesce(p_payload ->> 'timezone', '')), '');
  if v_timezone is null or not exists (select 1 from pg_timezone_names z where z.name = v_timezone) then
    v_timezone := 'Asia/Riyadh';
  end if;

  v_country := upper(nullif(trim(coalesce(p_payload ->> 'country_code', '')), ''));
  if v_country is null or v_country !~ '^[A-Z]{2}$' then
    v_country := 'SA';
  end if;

  v_code := upper(v_slug);
  while exists (select 1 from public.tenants where code = v_code) loop
    v_attempt := v_attempt + 1;
    v_code := upper(v_slug) || v_attempt::text;
  end loop;

  insert into public.tenants (
    slug, code, legal_name, status, license_code, default_language, timezone,
    country_code, tax_number, commercial_register, industry, employee_range,
    is_platform, activated_on
  )
  values (
    v_slug,
    v_code,
    coalesce(nullif(trim(coalesce(p_payload ->> 'legal_name', '')), ''), v_company_name),
    'Active',
    'FREE',
    v_language,
    v_timezone,
    v_country,
    nullif(trim(coalesce(p_payload ->> 'tax_number', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'commercial_register', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'industry', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'employee_range', '')), ''),
    false,
    now()
  )
  returning id into v_tenant;

  -- 5.5 Names, one row per language the form filled in.
  insert into public.tenant_names (tenant_id, language_code, name)
  select v_tenant, lower(e.key), trim(e.value)
  from jsonb_each_text(v_names) as e(key, value)
  where nullif(trim(e.value), '') is not null
    and lower(e.key) ~ '^[a-z]{2}(-[a-z]{2})?$'
  on conflict (tenant_id, language_code) do nothing;

  -- 5.6 Branding. The hero image replaces the bundled portal artwork whenever
  -- the company supplied one; the landing page falls back to the asset when it
  -- is null, so an empty string must not be stored.
  insert into public.tenant_branding (
    tenant_id, logo_light_url, favicon_url, hero_image_url, theme_preset,
    primary_color, secondary_color, support_email, website_url, linkedin_url,
    map_url, address_ar, address_en
  )
  values (
    v_tenant,
    nullif(trim(coalesce(p_payload ->> 'logo_url', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'favicon_url', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'hero_image_url', '')), ''),
    coalesce(nullif(trim(coalesce(p_payload ->> 'theme_preset', '')), ''), 'aurora'),
    coalesce(nullif(trim(coalesce(p_payload ->> 'primary_color', '')), ''), '#0f766e'),
    coalesce(nullif(trim(coalesce(p_payload ->> 'secondary_color', '')), ''), '#0b3b60'),
    v_owner_email,
    nullif(trim(coalesce(p_payload ->> 'website_url', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'linkedin_url', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'map_url', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'address_ar', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'address_en', '')), '')
  )
  on conflict (tenant_id) do nothing;

  insert into public.tenant_settings (tenant_id, rtl_default)
  values (v_tenant, v_language in ('ar', 'ur', 'fa', 'he'))
  on conflict (tenant_id) do nothing;

  -- 5.7 Public contact channels. Only the ones actually filled in exist as
  -- rows, which is what makes the footer hide the rest.
  if jsonb_typeof(p_payload -> 'contacts') = 'array' then
    insert into public.tenant_contacts (tenant_id, channel, value, display_order, is_public)
    select
      v_tenant,
      lower(trim(c ->> 'channel')),
      trim(c ->> 'value'),
      (row_number() over ())::integer * 10,
      true
    from jsonb_array_elements(p_payload -> 'contacts') as t(c)
    where lower(trim(coalesce(c ->> 'channel', ''))) in
          ('email', 'mobile', 'whatsapp', 'phone', 'fax', 'address', 'website')
      and nullif(trim(coalesce(c ->> 'value', '')), '') is not null;
  end if;

  insert into public.tenant_domains (tenant_id, domain, path_slug, is_primary, verified_at)
  values (v_tenant, 'bbnovix.com', v_slug, true, now())
  on conflict (domain, path_slug) do nothing;

  -- 5.8 Roles, chains, templates, libraries, org defaults.
  perform public.bootstrap_tenant_defaults(v_tenant);

  select id into v_role
  from public.roles
  where tenant_id = v_tenant and code = 'PLATFORM_ADMIN' and not is_deleted;

  select id into v_department
  from public.departments
  where tenant_id = v_tenant and lower(code) = 'general' and not is_deleted;

  select id into v_position
  from public.positions
  where tenant_id = v_tenant and lower(code) = 'general' and not is_deleted;

  -- 5.9 The subscriber becomes employee number 1 and the company administrator.
  insert into public.users (
    id, tenant_id, active_tenant_id, email, employee_no, full_name, name_ar, name_en,
    mobile, job_title, job_title_ar, job_title_en, department_id, position_id,
    preferred_language, is_active, invitation_sent, invitation_sent_on, account_activated_on
  )
  values (
    v_auth_user,
    v_tenant,
    v_tenant,
    v_owner_email,
    '1',
    v_owner_name,
    nullif(trim(coalesce(v_owner ->> 'name_1', '')), ''),
    nullif(trim(coalesce(v_owner ->> 'name_2', '')), ''),
    nullif(trim(coalesce(v_owner ->> 'mobile', '')), ''),
    nullif(trim(coalesce(v_owner ->> 'job_title', '')), ''),
    -- The form collects one job title, so it belongs in the column of the
    -- company default language and the localisation helper falls back to it.
    case when v_language = 'ar'
         then nullif(trim(coalesce(v_owner ->> 'job_title', '')), '') end,
    case when v_language <> 'ar'
         then nullif(trim(coalesce(v_owner ->> 'job_title', '')), '') end,
    v_department,
    v_position,
    v_language,
    true,
    true,
    now(),
    now()
  );

  if v_role is not null then
    insert into public.user_roles (tenant_id, user_id, role_id)
    values (v_tenant, v_auth_user, v_role)
    on conflict do nothing;
  end if;

  insert into public.tenant_memberships (tenant_id, user_id, employee_id, role_id, is_owner, status)
  values (
    v_tenant, v_auth_user, v_auth_user, v_role,
    coalesce((v_owner ->> 'is_owner')::boolean, true),
    'Active'
  )
  on conflict (tenant_id, user_id) do update set
    employee_id = excluded.employee_id,
    role_id = coalesce(excluded.role_id, public.tenant_memberships.role_id),
    is_owner = excluded.is_owner,
    status = 'Active',
    updated_on = now();

  -- 5.10 The welcome mail. It is filed under the platform tenant because the
  -- platform sends it in its own name; recipient_user_id is deliberately left
  -- null so the row never points at an employee of another company.
  v_url := 'https://bbnovix.com/' || v_slug || '/';
  v_platform := public.platform_tenant_id();
  v_queue_language := case when v_language in ('ar', 'en') then v_language else 'en' end;

  select id into v_template
  from public.email_templates
  where tenant_id = v_platform and code = 'TENANT_WELCOME' and is_active and not is_deleted
  order by version desc
  limit 1;

  if v_template is not null then
    insert into public.email_queue (
      tenant_id, recipient_email, template_id, language, template_data, priority
    )
    values (
      v_platform,
      v_owner_email,
      v_template,
      v_queue_language,
      jsonb_build_object(
        'tenant_id', v_tenant,
        'slug', v_slug,
        'company_name', v_company_name,
        'company_url', v_url,
        'login_url', v_url || 'login',
        'owner_name', v_owner_name,
        'user_name', v_owner_email,
        'password_link', coalesce(
          nullif(trim(coalesce(p_payload ->> 'password_link', '')), ''),
          nullif(trim(coalesce(v_owner ->> 'password_link', '')), ''),
          v_url || 'reset-password'
        )
      ),
      1
    );
  end if;

  -- 5.11 The audit trail. A submission that came through the public form was
  -- already filed by the edge function; anything else is recorded here.
  begin
    v_ip := nullif(trim(coalesce(p_payload ->> 'ip', '')), '')::inet;
  exception when others then
    v_ip := null;
  end;

  begin
    v_request := nullif(trim(coalesce(p_payload ->> 'signup_request_id', '')), '')::uuid;
  exception when others then
    v_request := null;
  end;

  if v_request is not null then
    update public.tenant_signup_requests
    set status = 'Provisioned',
        provisioned_tenant_id = v_tenant,
        company_name = coalesce(company_name, v_company_name)
    where id = v_request;
  else
    insert into public.tenant_signup_requests (
      slug, company_name, requested_by_name, requested_by_email, requested_by_phone,
      is_owner, payload, status, provisioned_tenant_id, ip, user_agent
    )
    values (
      v_slug,
      v_company_name,
      v_owner_name,
      v_owner_email,
      nullif(trim(coalesce(v_owner ->> 'mobile', '')), ''),
      coalesce((v_owner ->> 'is_owner')::boolean, true),
      (p_payload - 'password_link') || jsonb_build_object('owner', v_owner - 'password_link'),
      'Provisioned',
      v_tenant,
      v_ip,
      nullif(trim(coalesce(p_payload ->> 'user_agent', '')), '')
    )
    returning id into v_request;
  end if;

  -- 5.12 Usage starts from what provisioning itself created.
  update public.tenant_quotas q
  set used_value = case q.resource_code
        when 'EMPLOYEES' then (select count(*) from public.users where tenant_id = v_tenant and not is_deleted)
        when 'DEPARTMENTS' then (select count(*) from public.departments where tenant_id = v_tenant and not is_deleted)
        when 'TEMPLATES' then (select count(*) from public.templates where tenant_id = v_tenant and not is_deleted)
        else q.used_value
      end,
      updated_on = now()
  where q.tenant_id = v_tenant;

  return jsonb_build_object(
    'tenant_id', v_tenant,
    'slug', v_slug,
    'url', v_url,
    'owner_user_id', v_auth_user,
    'signup_request_id', v_request
  );
end;
$$;

revoke all on function public.provision_tenant(jsonb) from public;
revoke all on function public.provision_tenant(jsonb) from anon, authenticated;
grant execute on function public.provision_tenant(jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- 6. Dry run for the subscription form
--
--    Anonymous, writes nothing and returns no company data — only the list of
--    problems with what the visitor typed, so the form can show them field by
--    field before it submits. Deliberately silent about whether an email is
--    already registered: that would turn the public form into an account
--    enumeration oracle.
-- ----------------------------------------------------------------------------

create or replace function public.provision_tenant_preflight(p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_problems jsonb := '[]'::jsonb;
  v_slug text;
  v_availability jsonb;
  v_names jsonb;
  v_language text;
  v_company_name text;
  v_owner jsonb;
  v_email text;
  v_timezone text;
  v_country text;
  v_color text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    p_payload := '{}'::jsonb;
  end if;

  v_slug := lower(trim(coalesce(p_payload ->> 'slug', '')));
  if v_slug = '' then
    v_problems := v_problems || jsonb_build_object('field', 'slug', 'code', 'SLUG_REQUIRED');
  else
    v_availability := public.slug_is_available(v_slug);
    if not coalesce((v_availability ->> 'available')::boolean, false) then
      v_problems := v_problems || jsonb_build_object(
        'field', 'slug',
        'code', case v_availability ->> 'reason'
                  when 'RESERVED' then 'SLUG_RESERVED'
                  when 'TAKEN' then 'SLUG_UNAVAILABLE'
                  else 'SLUG_INVALID'
                end
      );
    end if;
  end if;

  v_names := coalesce(p_payload -> 'names', '{}'::jsonb);
  if jsonb_typeof(v_names) <> 'object' then
    v_names := '{}'::jsonb;
  end if;

  v_language := lower(nullif(trim(coalesce(p_payload ->> 'default_language', '')), ''));
  if v_language is null then
    v_problems := v_problems || jsonb_build_object('field', 'default_language', 'code', 'DEFAULT_LANGUAGE_REQUIRED');
  elsif v_language !~ '^[a-z]{2}(-[a-z]{2})?$' then
    v_problems := v_problems || jsonb_build_object('field', 'default_language', 'code', 'LANGUAGE_CODE_INVALID');
  else
    v_company_name := nullif(trim(coalesce(v_names ->> v_language, '')), '');
    if v_company_name is null then
      v_problems := v_problems || jsonb_build_object('field', 'names', 'code', 'COMPANY_NAME_REQUIRED');
    end if;
  end if;

  if exists (
    select 1 from jsonb_each_text(v_names) as e(key, value)
    where lower(e.key) !~ '^[a-z]{2}(-[a-z]{2})?$'
  ) then
    v_problems := v_problems || jsonb_build_object('field', 'names', 'code', 'LANGUAGE_CODE_INVALID');
  end if;

  v_owner := coalesce(p_payload -> 'owner', '{}'::jsonb);
  if jsonb_typeof(v_owner) <> 'object' then
    v_owner := '{}'::jsonb;
  end if;

  if nullif(trim(coalesce(v_owner ->> 'name_1', '')), '') is null
     and nullif(trim(coalesce(v_owner ->> 'name_2', '')), '') is null then
    v_problems := v_problems || jsonb_build_object('field', 'owner.name_1', 'code', 'OWNER_NAME_REQUIRED');
  end if;

  v_email := lower(nullif(trim(coalesce(v_owner ->> 'email', '')), ''));
  if v_email is null then
    v_problems := v_problems || jsonb_build_object('field', 'owner.email', 'code', 'OWNER_EMAIL_REQUIRED');
  elsif v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' then
    v_problems := v_problems || jsonb_build_object('field', 'owner.email', 'code', 'OWNER_EMAIL_INVALID');
  end if;

  if nullif(trim(coalesce(v_owner ->> 'mobile', '')), '') is null then
    v_problems := v_problems || jsonb_build_object('field', 'owner.mobile', 'code', 'OWNER_PHONE_REQUIRED');
  end if;

  v_timezone := nullif(trim(coalesce(p_payload ->> 'timezone', '')), '');
  if v_timezone is not null
     and not exists (select 1 from pg_timezone_names z where z.name = v_timezone) then
    v_problems := v_problems || jsonb_build_object('field', 'timezone', 'code', 'TIMEZONE_INVALID');
  end if;

  v_country := upper(nullif(trim(coalesce(p_payload ->> 'country_code', '')), ''));
  if v_country is not null and v_country !~ '^[A-Z]{2}$' then
    v_problems := v_problems || jsonb_build_object('field', 'country_code', 'code', 'COUNTRY_CODE_INVALID');
  end if;

  foreach v_color in array array['primary_color', 'secondary_color'] loop
    if nullif(trim(coalesce(p_payload ->> v_color, '')), '') is not null
       and trim(p_payload ->> v_color) !~ '^#[0-9a-fA-F]{6}$' then
      v_problems := v_problems || jsonb_build_object('field', v_color, 'code', 'COLOR_INVALID');
    end if;
  end loop;

  if jsonb_typeof(p_payload -> 'contacts') = 'array'
     and exists (
       select 1
       from jsonb_array_elements(p_payload -> 'contacts') as t(c)
       where nullif(trim(coalesce(c ->> 'value', '')), '') is not null
         and lower(trim(coalesce(c ->> 'channel', ''))) not in
             ('email', 'mobile', 'whatsapp', 'phone', 'fax', 'address', 'website')
     ) then
    v_problems := v_problems || jsonb_build_object('field', 'contacts', 'code', 'CONTACT_CHANNEL_INVALID');
  end if;

  return jsonb_build_object(
    'valid', jsonb_array_length(v_problems) = 0,
    'slug', nullif(v_slug, ''),
    'url', case when v_slug = '' then null else 'https://bbnovix.com/' || v_slug || '/' end,
    'problems', v_problems
  );
end;
$$;

grant execute on function public.provision_tenant_preflight(jsonb) to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. Operator housekeeping
-- ----------------------------------------------------------------------------

create or replace function public.reject_signup_request(p_id uuid, p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  -- Execute is granted to authenticated and service_role only, so a null
  -- auth.uid() here is the edge worker rather than an anonymous visitor.
  if auth.uid() is not null
     and not (public.is_platform_operator() or public.has_permission('Platform.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;

  select status into v_status from public.tenant_signup_requests where id = p_id;
  if v_status is null then
    raise exception 'SIGNUP_REQUEST_NOT_FOUND';
  end if;
  if v_status = 'Provisioned' then
    raise exception 'SIGNUP_REQUEST_ALREADY_PROVISIONED';
  end if;

  update public.tenant_signup_requests
  set status = 'Rejected',
      review_note = nullif(trim(coalesce(p_reason, '')), ''),
      reviewed_by = auth.uid(),
      reviewed_on = now()
  where id = p_id;

  return jsonb_build_object('id', p_id, 'status', 'Rejected');
end;
$$;

-- A new function is executable by PUBLIC until that default is taken away, and
-- anon is a member of PUBLIC with a null auth.uid() — exactly the branch the
-- permission check above skips. Without these revokes any anonymous visitor
-- could reject any pending signup request.
revoke all on function public.reject_signup_request(uuid, text) from public;
revoke all on function public.reject_signup_request(uuid, text) from anon;
grant execute on function public.reject_signup_request(uuid, text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. Backfill
--
--    The operator workspace was created by 012 with roles but without an
--    approval chain, form templates or an org tree, so half the application is
--    unusable inside it. Shalfa is deliberately left alone: it is live customer
--    data and already carries its own equivalents.
-- ----------------------------------------------------------------------------

do $$
declare
  v_platform uuid;
begin
  v_platform := public.platform_tenant_id();
  if v_platform is not null then
    perform public.bootstrap_tenant_defaults(v_platform);
  end if;
end $$;
