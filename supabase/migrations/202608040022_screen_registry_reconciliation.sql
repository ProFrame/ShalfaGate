-- ============================================================================
-- 022 — Make the screen registry describe the application that exists
--
-- public.app_screens drives the sidebar, so every active row has to resolve to
-- a real route. Migration 018 registered the full roadmap; this migration
-- reconciles it with what src/App.jsx actually serves today:
--
--   * routes are corrected where the page exists under a different address
--   * screens that have no page yet are deactivated rather than deleted, so the
--     roadmap survives and a row can be switched on the day its page ships
--   * the organisation chart, which does have a page, is added
--
-- route is always the sub path inside the shell: /{slug}/app/<route>.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Correct the addresses of pages that do exist
-- ----------------------------------------------------------------------------

update public.app_screens set route = '' where code = 'PORTAL_HOME';
update public.app_screens set route = 'forms' where code = 'PORTAL_MY_REQUESTS';
update public.app_screens set route = 'approvals' where code = 'PORTAL_APPROVALS';
update public.app_screens set route = 'documents' where code = 'PORTAL_DOCUMENTS';
update public.app_screens set route = 'circulars' where code = 'PORTAL_CIRCULARS';
update public.app_screens set route = 'designs' where code = 'PORTAL_DESIGNS';
update public.app_screens set route = 'calendar' where code = 'PORTAL_CALENDAR';
update public.app_screens set route = 'notes' where code = 'PORTAL_NOTES';

-- Verification lives in its own tab, not in the administration centre.
update public.app_screens set route = 'verification/attestations' where code = 'ADMIN_ATTESTATIONS';
update public.app_screens set route = 'verification/certificates' where code = 'ADMIN_CERTIFICATES';
update public.app_screens set route = 'verification/templates' where code = 'ADMIN_CERTIFICATE_TEMPLATES';
update public.app_screens set route = 'verification/settings' where code = 'ADMIN_VERIFICATION_SETTINGS';

-- ----------------------------------------------------------------------------
-- 2. The organisation chart has a page and was missing from the registry
-- ----------------------------------------------------------------------------

insert into public.app_screens (
  code, module_code, area, group_code, name_ar, name_en, icon, route, display_order, min_role_rank
)
values (
  'PORTAL_ORG_CHART', 'EMPLOYEE_PORTAL', 'Portal', 'Workspace',
  'الهيكل التنظيمي', 'Organization Chart', 'network', 'org', 165, 1
)
on conflict (code) do update set
  route = excluded.route,
  module_code = excluded.module_code,
  area = excluded.area,
  group_code = excluded.group_code,
  name_ar = excluded.name_ar,
  name_en = excluded.name_en,
  icon = excluded.icon,
  display_order = excluded.display_order,
  min_role_rank = excluded.min_role_rank,
  is_active = true,
  updated_on = now();

-- ----------------------------------------------------------------------------
-- 3. Park the screens that do not have a page yet
--
--    A navigation entry that leads nowhere is worse than a missing feature, so
--    these stay registered and switched off. Each one is a planned screen:
--
--      PORTAL_NEW_REQUEST     folded into the forms page
--      PORTAL_CHAT            chat is a dock in the header, not a page
--      PORTAL_NOTIFICATIONS   the notification centre is a panel in the header
--      PORTAL_PROFILE         the profile is a panel in the header
--      PORTAL_ANNOUNCEMENTS   shown as a home-page card; no full page yet
--      PORTAL_SURVEYS         shown as a home-page card; no full page yet
--      PORTAL_CERTIFICATES    employee-facing certificate wallet, planned
--      PORTAL_PERFORMANCE     employee-facing evaluation view, planned
--      PORTAL_DIRECTORY       employee directory, planned
--      PORTAL_KNOWLEDGE       knowledge base module, planned
--      PORTAL_SUPPORT         raised from the administration centre instead
-- ----------------------------------------------------------------------------

update public.app_screens
set is_active = false,
    updated_on = now()
where code in (
  'PORTAL_NEW_REQUEST',
  'PORTAL_CHAT',
  'PORTAL_NOTIFICATIONS',
  'PORTAL_PROFILE',
  'PORTAL_ANNOUNCEMENTS',
  'PORTAL_SURVEYS',
  'PORTAL_CERTIFICATES',
  'PORTAL_PERFORMANCE',
  'PORTAL_DIRECTORY',
  'PORTAL_KNOWLEDGE',
  'PORTAL_SUPPORT'
);

-- ----------------------------------------------------------------------------
-- 4. A registry entry must always be an address the shell can open
-- ----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_screens_route_shape_check') then
    alter table public.app_screens
      add constraint app_screens_route_shape_check
      check (route = '' or route ~ '^[a-z0-9]+(?:[-/][a-z0-9]+)*$');
  end if;
end $$;

comment on column public.app_screens.route is
  'Sub path inside the application shell: /{slug}/app/<route>. Empty means the home page.';
