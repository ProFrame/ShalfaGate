-- ============================================================================
-- 028 — Move the permission catalogue into the migration chain
--
-- The whole authorisation surface is gated on has_permission('<code>'), but 15
-- of the codes it checks were only ever inserted by supabase/seed.sql:
--
--   Audit.View, Competencies.Manage, Content.Manage, Email.Manage,
--   Employees.Manage, Forms.Approve, Forms.View, Goals.Manage,
--   Performance.Analytics.View, Performance.Cycles.Manage,
--   Performance.Templates.Manage, Roles.Assign, Roles.Manage, Roles.View,
--   Settings.Manage
--
-- docs/bbnovix_deployment.md documents `supabase db push` as the whole install
-- step and never runs seed.sql; there is no supabase/config.toml [db.seed]
-- entry either. On a project built by following that runbook, has_permission()
-- returns false for all 15 codes because the rows do not exist — not because
-- access was refused, but because the permission itself was never defined. A
-- fresh company can then never manage employees, roles, settings or content:
-- signup succeeds and the company is a dead end.
--
-- public.permissions carries no tenant_id — it is the platform's fixed
-- vocabulary, the same list every company's roles draw from — so this is a
-- plain forward migration, not a per-tenant fix. What IS per-tenant is
-- role_permissions, and every company provisioned before today ran
-- bootstrap_tenant_defaults against an incomplete catalogue: its joins on
-- these codes matched nothing, so PLATFORM_ADMIN and SYSTEM_ADMIN in every
-- existing tenant are missing the grants those codes represent. Both parts are
-- fixed here.
-- ============================================================================

insert into public.permissions (code, module, description)
values
  ('Forms.View', 'Forms', 'View forms'),
  ('Forms.Approve', 'Forms', 'Approve workflow items'),
  ('Employees.Manage', 'Administration', 'Manage employee identities and invitations'),
  ('Roles.View', 'Administration', 'View roles and permissions'),
  ('Roles.Manage', 'Administration', 'Manage roles and permission sets'),
  ('Roles.Assign', 'Administration', 'Assign roles to users'),
  ('Goals.Manage', 'Performance', 'Manage goal library'),
  ('Competencies.Manage', 'Performance', 'Manage competency library'),
  ('Performance.Cycles.Manage', 'Performance', 'Manage evaluation cycles'),
  ('Performance.Templates.Manage', 'Performance', 'Manage evaluation templates'),
  ('Performance.Analytics.View', 'Performance', 'View enterprise performance analytics'),
  ('Content.Manage', 'Content', 'Manage documents, circulars, and designs'),
  ('Audit.View', 'Security', 'View audit trail'),
  ('Settings.Manage', 'Administration', 'Manage system settings and bilingual lookup values'),
  ('Email.Manage', 'Administration', 'Manage email templates and inspect delivery queue')
on conflict (code) do update set
  module = excluded.module,
  description = excluded.description;

-- ----------------------------------------------------------------------------
-- Backfill: every tenant provisioned before this migration is missing the
-- role_permissions rows that reference the codes above. Re-run exactly the
-- grant shape bootstrap_tenant_defaults already uses, for every tenant that
-- exists today — including the ones this migration is what makes correct from
-- now on.
-- ----------------------------------------------------------------------------

-- The baseline every employee holds.
insert into public.role_permissions (tenant_id, role_id, permission_id)
select r.tenant_id, r.id, p.id
from public.roles r
join public.permissions p on p.code in (
  'Dashboard.View', 'Forms.View', 'Forms.Create', 'Forms.Update', 'Forms.Delete',
  'Profile.Update', 'Notes.Use'
)
where r.code in ('EMPLOYEE', 'DEPARTMENT_COORDINATOR', 'DEPARTMENT_MANAGER',
                 'SYSTEM_ADMIN', 'PLATFORM_ADMIN')
  and not r.is_deleted
on conflict do nothing;

-- The company system administrator.
insert into public.role_permissions (tenant_id, role_id, permission_id)
select r.tenant_id, r.id, p.id
from public.roles r
join public.permissions p on p.code in (
  'Employees.Manage', 'Performance.Analytics.View', 'Approvals.Manage',
  'Tenant.Profile.Manage', 'Screens.Manage', 'Support.Manage', 'Support.View',
  'Announcements.Manage', 'Surveys.Manage', 'Calendar.Manage',
  'Verification.Manage', 'Verification.View', 'Certificates.Manage',
  'Organization.Manage', 'Audience.Manage', 'Forms.Manage', 'Chat.Manage',
  'Storage.Manage', 'Security.View'
)
where r.code = 'SYSTEM_ADMIN' and not r.is_deleted
on conflict do nothing;

-- The company administrator: everything except the platform surface.
insert into public.role_permissions (tenant_id, role_id, permission_id)
select r.tenant_id, r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'PLATFORM_ADMIN' and not r.is_deleted
  and p.module <> 'Platform'
on conflict do nothing;

comment on table public.permissions is
  'The platform-wide permission vocabulary. Not tenant-scoped — every company''s roles draw from this one list. '
  'Every code referenced anywhere by has_permission()/has_permission_for_user() must be inserted by a migration '
  '(never only by supabase/seed.sql, which the documented install does not run).';
