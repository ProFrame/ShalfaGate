-- ============================================================================
-- 058 — UI Polish: Favorites + Recent Items (Global Navigation Standards)
--
-- Discovery (this session, no prior trust, mirroring every prior Update-4
-- migration's own header discipline): before a line of this file was
-- written, the migrations/ tree was read directly, not assumed:
--   - public.workspace_layouts does not exist anywhere in this codebase — it
--     was only offered as an illustrative example of "a simple per-user
--     table's RLS idiom". The real precedents, found by grepping every
--     "user_id = auth.uid()" RLS policy in the tree, are
--     public.user_widget_preferences / public.user_preferences /
--     public.notification_preferences (all 202608040015). All three predate
--     the "no direct table write policy, RPCs only" rule this migration was
--     handed (first established by Assets Management, 202608060054, and
--     followed by every module since), so all three still carry a
--     PERMISSIVE "for all ... using (user_id = auth.uid())" policy that
--     allows a direct client write — NOT copied here. Instead, each table
--     below gets only a PERMISSIVE SELECT-only "user_id = auth.uid()"
--     policy, the read half of Operations' own "members read operations
--     team members" policy (202608070057), narrowed: no has_permission()
--     branch, because favoriting/revisiting a screen is personal state every
--     authenticated user manages for themselves regardless of role (per
--     this migration's own spec: "no company-wide read of another user's
--     favorites/recents is ever needed for this feature").
--   - public.my_screens() (202608040018) is the jsonb_agg/jsonb_build_object
--     shape favorite_screens_list()/recent_screens_list() mirror below for
--     the joined app_screens fields — re-read in full before writing
--     section 4, not assumed from memory.
--   - The handed-down rationale for display_order 15/25 ("right after
--     Home(10)/before Notes(20)/Calendar(30) in the existing Workspace
--     group's own ordering") does not match the real data: PORTAL_NOTES is
--     group_code 'Productivity' at display_order 110, and PORTAL_CALENDAR is
--     group_code 'Engagement' at display_order 90 — neither is in
--     'Workspace'. The real 'Workspace' group (grepped directly) is
--     PORTAL_HOME(10), PORTAL_DIRECTORY(160), PORTAL_NOTIFICATIONS(170),
--     PORTAL_PROFILE(180), PORTAL_SUPPORT(190). This changes nothing this
--     migration does — 15 and 25 still land correctly between HOME(10) and
--     the group's real next member DIRECTORY(160), so both new rows sort
--     correctly and no existing row is renumbered — but the "before
--     Notes/Calendar" justification itself is corrected here rather than
--     repeated silently.
--
-- WHAT THIS MIGRATION IS: two small GLOBAL/cross-module navigation aids from
-- FourthUpdate.md's "Global Navigation Standards" list. Both favorite/track a
-- SCREEN (an app_screens.code), never a business record — there is no
-- entity_type/entity_id pair because the thing being remembered is always
-- the same kind of thing. Two tables:
--   - user_favorites       — a user's starred screens; favorite_screens_list
--     orders by created_on desc (most recently favorited first).
--   - user_recent_screens  — a rolling per-screen LAST-visited timestamp, one
--     row per (tenant, user, screen) — deliberately not an append-only visit
--     log, which is why recent_screen_touch is an upsert on the same
--     (tenant_id, user_id, screen_code) uniqueness user_favorites uses.
--
-- Both tables are the exact minimal shape handed down — id/tenant_id/
-- user_id/screen_code/one timestamp/a uniqueness constraint — with none of
-- the created_by/updated_by/is_deleted/deleted_by/deleted_date/row_version
-- columns a business table in this codebase otherwise carries. Consequence,
-- documented rather than left silent:
--   - public.apply_row_defaults() (202608040012) unconditionally writes
--     new.created_by/updated_by/updated_on/row_version and branches on
--     new.is_deleted/old.is_deleted; user_recent_screens has none of those
--     fields (not even created_on — its own timestamp column is
--     visited_on), and user_favorites has all but created_on. Attaching
--     that trigger to either table would fail every INSERT/UPDATE at
--     runtime ("record \"new\" has no field ..."), not merely be
--     unnecessary, so it is NOT attached to either table here — unlike
--     every business table in every Update-4 migration before this one.
--   - write_audit_log() (202608040012) has no such column dependency (it
--     reads via to_jsonb(new)/to_jsonb(old), tolerating any shape) and
--     could be attached without erroring, but is deliberately left off
--     anyway: recent_screen_touch fires on essentially every in-app
--     navigation, and this codebase already has a direct precedent for
--     keeping exactly that kind of near-continuous, low-value write off an
--     audit trail — operations_checklist_item_toggle (202608070057) skips
--     record_activity() for the identical reason ("would flood the
--     narrative feed"). user_favorites is left equally trigger-free for
--     consistency between the two sibling tables, not because favoriting
--     itself is high-frequency.
--   - Neither omission is a tenant-safety gap: no policy on either table
--     ever permits a direct client write (section 2 below adds only a
--     SELECT policy), so the one thing apply_row_defaults structurally
--     guards against — a client-supplied tenant_id smuggled through a
--     direct table write — has no write path to travel through here. Every
--     real write is a SECURITY DEFINER RPC (section 4) that sources
--     tenant_id from current_tenant_id() and user_id from auth.uid() alone;
--     no RPC below accepts a caller-supplied tenant_id or user_id.
--   - Consequence for tests/tenancy-invariants.test.mjs: both tables carry
--     `tenant_id uuid not null references public.tenants`, so that suite's
--     tenantTables() scan picks them up, and its "stamps tenant_id and the
--     audit columns on write" test expects every such table to appear in an
--     `apply_row_defaults on public.<name>` trigger (or be DO-loop-covered,
--     or sit in that test's own TENANT_INFRASTRUCTURE allow-list — whose
--     existing comment already documents this exact situation: "no
--     created_by / row_version columns, so apply_row_defaults does not
--     apply to them"). Neither trigger is attached here, so that test would
--     flag both new tables red. This SQL file cannot itself fix a .mjs test
--     (and does not try to), so tests/tenancy-invariants.test.mjs was
--     extended, as a companion edit alongside this migration, adding
--     user_favorites/user_recent_screens to TENANT_INFRASTRUCTURE with the
--     same reasoning already on record there for its other five entries —
--     verified afterwards by actually running `node --test
--     tests/tenancy-invariants.test.mjs` (12/12) and the full `npm test`
--     (83/83), not assumed. Flagged explicitly here so the decision to
--     touch a shared test file is visible in the one place a future reader
--     of this migration will actually look, not just in a commit message.
--
-- Reused, not reimplemented: public.current_tenant_id()/auth.uid() (same
-- v_tenant-null-check convention as every RPC since 202608040012);
-- public.app_screens, read-only from every RPC below and not altered beyond
-- the two new rows in section 3 (it carries no tenant_id — the platform's
-- fixed screen catalogue, same as public.permissions — so no RLS on it is
-- touched).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables — exact minimal shape (see header for why neither table carries
--    the standard business-table audit columns or trigger pair).
-- ----------------------------------------------------------------------------

-- 1.1 user_favorites — a user's starred screens.
create table if not exists public.user_favorites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.users(id),
  screen_code text not null references public.app_screens(code),
  created_on timestamptz not null default now(),
  unique (tenant_id, user_id, screen_code)
);
create index if not exists idx_user_favorites_tenant on public.user_favorites (tenant_id);
create index if not exists idx_user_favorites_user
  on public.user_favorites (tenant_id, user_id, created_on desc);

-- 1.2 user_recent_screens — one row per (tenant, user, screen): the most
--     recent visit only, kept fresh by recent_screen_touch's own upsert (see
--     header — deliberately not an append-only visit log).
create table if not exists public.user_recent_screens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.users(id),
  screen_code text not null references public.app_screens(code),
  visited_on timestamptz not null default now(),
  unique (tenant_id, user_id, screen_code)
);
create index if not exists idx_user_recent_screens_tenant on public.user_recent_screens (tenant_id);
create index if not exists idx_user_recent_screens_user
  on public.user_recent_screens (tenant_id, user_id, visited_on desc);

-- ----------------------------------------------------------------------------
-- 2. RLS — RESTRICTIVE tenant isolation (same idiom as every table in this
--    codebase) + one PERMISSIVE SELECT-only "own rows" policy each. No write
--    policy on either table, by design (see header): every write goes
--    through the SECURITY DEFINER RPCs in section 4.
-- ----------------------------------------------------------------------------
alter table public.user_favorites enable row level security;

drop policy if exists "tenant isolation" on public.user_favorites;
create policy "tenant isolation" on public.user_favorites
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "users read own favorites" on public.user_favorites;
create policy "users read own favorites" on public.user_favorites
  for select to authenticated
  using (user_id = auth.uid());

alter table public.user_recent_screens enable row level security;

drop policy if exists "tenant isolation" on public.user_recent_screens;
create policy "tenant isolation" on public.user_recent_screens
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "users read own recent screens" on public.user_recent_screens;
create policy "users read own recent screens" on public.user_recent_screens
  for select to authenticated
  using (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 3. Screen registry — Favorites + Recent Items, both group_code 'Workspace'
--    (see header for why the handed-down "before Notes/Calendar"
--    justification for display_order 15/25 does not match the real data,
--    and why 15/25 are still correct regardless: right after
--    PORTAL_HOME(10), well before the group's real next member,
--    PORTAL_DIRECTORY(160) — no existing row is renumbered).
-- ----------------------------------------------------------------------------
insert into public.app_screens (code, module_code, area, group_code, name_ar, name_en, icon, route, display_order, min_role_rank)
values
  ('PORTAL_FAVORITES', null, 'Portal', 'Workspace', 'المفضلة', 'Favorites', 'star', 'favorites', 15, 1),
  ('PORTAL_RECENT', null, 'Portal', 'Workspace', 'الأخيرة', 'Recent Items', 'history', 'recent', 25, 1)
on conflict (code) do update set
  module_code = excluded.module_code, area = excluded.area, group_code = excluded.group_code,
  name_ar = excluded.name_ar, name_en = excluded.name_en, icon = excluded.icon,
  route = excluded.route, display_order = excluded.display_order, min_role_rank = excluded.min_role_rank,
  is_active = true, updated_on = now();

-- ----------------------------------------------------------------------------
-- 4. RPCs — all SECURITY DEFINER, all tenant-scoped via current_tenant_id(),
--    same v_tenant-null-check convention as every RPC since 202608040012. No
--    has_permission() gate on any of the five: favoriting/revisiting a
--    screen is personal state every authenticated user manages for
--    themselves regardless of role, the same boundary
--    public.user_preferences_get()/public.tenant_presence() (202608040015)
--    already draw for personal-preference RPCs.
-- ----------------------------------------------------------------------------

-- 4.1 favorite_screen_add
create or replace function public.favorite_screen_add(p_screen_code text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if p_screen_code is null or trim(p_screen_code) = '' then raise exception 'SCREEN_CODE_REQUIRED'; end if;
  if not exists (select 1 from public.app_screens where code = p_screen_code and is_active) then
    raise exception 'SCREEN_NOT_FOUND';
  end if;

  insert into public.user_favorites (tenant_id, user_id, screen_code)
  values (v_tenant, auth.uid(), p_screen_code)
  on conflict (tenant_id, user_id, screen_code) do nothing;
end;
$$;
revoke all on function public.favorite_screen_add(text) from public;
grant execute on function public.favorite_screen_add(text) to authenticated;

comment on function public.favorite_screen_add(text) is
  'Favorites a screen for the caller. Idempotent: favoriting an already-favorited screen is a '
  'silent no-op (on conflict do nothing), never an error. Authentication: authenticated. '
  'Authorization: none beyond a valid session — every caller manages only their own favorites '
  '(user_id is always auth.uid(), never caller-supplied). Expected errors: NO_ACTIVE_TENANT, '
  'SCREEN_CODE_REQUIRED, SCREEN_NOT_FOUND.';

-- 4.2 favorite_screen_remove
create or replace function public.favorite_screen_remove(p_screen_code text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  delete from public.user_favorites
  where tenant_id = v_tenant and user_id = auth.uid() and screen_code = p_screen_code;
end;
$$;
revoke all on function public.favorite_screen_remove(text) from public;
grant execute on function public.favorite_screen_remove(text) to authenticated;

comment on function public.favorite_screen_remove(text) is
  'Un-favorites a screen for the caller. Idempotent: a p_screen_code that was never favorited (or '
  'names no real screen, or is null) deletes zero rows silently, never an error. Authentication: '
  'authenticated. Authorization: none beyond a valid session — the function''s own WHERE clause '
  '(tenant_id = current tenant, user_id = auth.uid()) is what scopes the delete to the caller''s '
  'own row, since this SECURITY DEFINER function bypasses RLS entirely; a direct client delete on '
  'this table would independently still match zero rows regardless, since no permissive DELETE '
  'policy exists on it (section 2). Expected errors: NO_ACTIVE_TENANT.';

-- 4.3 favorite_screens_list
create or replace function public.favorite_screens_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', t.code,
      'area', t.area,
      'group_code', t.group_code,
      'name_ar', t.name_ar,
      'name_en', t.name_en,
      'icon', t.icon,
      'route', t.route,
      'display_order', t.display_order,
      'favorited_on', t.favorited_on
    ) order by t.favorited_on desc)
    from (
      select s.code, s.area, s.group_code, s.name_ar, s.name_en, s.icon, s.route, s.display_order,
             f.created_on as favorited_on
      from public.user_favorites f
      join public.app_screens s on s.code = f.screen_code and s.is_active
      where f.tenant_id = v_tenant and f.user_id = auth.uid()
    ) t
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.favorite_screens_list() from public;
grant execute on function public.favorite_screens_list() to authenticated;

comment on function public.favorite_screens_list() is
  'Returns the caller''s own favorited screens, each joined against app_screens for code/area/'
  'group_code/name_ar/name_en/icon/route/display_order plus favorited_on (user_favorites.'
  'created_on), ordered by favorited-on descending — most recently favorited first. A screen favorited and '
  'later deactivated is silently excluded (inner join filtered on app_screens.is_active), never '
  'surfaced as a dead link. Authentication: authenticated. Authorization: none beyond a valid '
  'session — always the caller''s own favorites (user_id = auth.uid()). Expected errors: '
  'NO_ACTIVE_TENANT.';

-- 4.4 recent_screen_touch
create or replace function public.recent_screen_touch(p_screen_code text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  -- Silent no-op for a stale/renamed/blank/null screen code — see header:
  -- navigation must never break because this bookkeeping call missed. NULL
  -- p_screen_code falls into this branch on its own (code = null matches
  -- nothing), so no separate null-guard is needed.
  if not exists (select 1 from public.app_screens where code = p_screen_code) then
    return;
  end if;

  insert into public.user_recent_screens (tenant_id, user_id, screen_code, visited_on)
  values (v_tenant, auth.uid(), p_screen_code, now())
  on conflict (tenant_id, user_id, screen_code) do update set visited_on = now();
end;
$$;
revoke all on function public.recent_screen_touch(text) from public;
grant execute on function public.recent_screen_touch(text) to authenticated;

comment on function public.recent_screen_touch(text) is
  'Records that the caller just visited a screen: upserts user_recent_screens, refreshing '
  'visited_on to now() if the (tenant, user, screen) row already exists. A p_screen_code that '
  'names no row in app_screens (stale/renamed code, or null) is a silent no-op, never an error — '
  'a navigation-triggered call must never fail because of this bookkeeping. Authentication: '
  'authenticated. Authorization: none beyond a valid session — always the caller''s own history '
  '(user_id = auth.uid()). Expected errors: NO_ACTIVE_TENANT.';

-- 4.5 recent_screens_list
create or replace function public.recent_screens_list(p_limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', t.code,
      'area', t.area,
      'group_code', t.group_code,
      'name_ar', t.name_ar,
      'name_en', t.name_en,
      'icon', t.icon,
      'route', t.route,
      'display_order', t.display_order,
      'visited_on', t.visited_on
    ) order by t.visited_on desc)
    from (
      select s.code, s.area, s.group_code, s.name_ar, s.name_en, s.icon, s.route, s.display_order,
             r.visited_on
      from public.user_recent_screens r
      join public.app_screens s on s.code = r.screen_code and s.is_active
      where r.tenant_id = v_tenant and r.user_id = auth.uid()
      order by r.visited_on desc
      limit v_limit
    ) t
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.recent_screens_list(integer) from public;
grant execute on function public.recent_screens_list(integer) to authenticated;

comment on function public.recent_screens_list(integer) is
  'Returns the caller''s own most-recently-visited screens, same joined shape as '
  'favorite_screens_list() plus visited_on (user_recent_screens.visited_on), ordered by '
  'visited_on descending — most recent first. p_limit is '
  'clamped server-side to [1, 50] (default 20) regardless of what the caller passes, including '
  'null or out-of-range values. A screen visited and later deactivated is silently excluded '
  '(inner join filtered on app_screens.is_active). Authentication: authenticated. Authorization: '
  'none beyond a valid session — always the caller''s own history (user_id = auth.uid()). '
  'Expected errors: NO_ACTIVE_TENANT.';

-- ----------------------------------------------------------------------------
-- Mandatory closer: every migration batch ends with this, or a GRANT earlier
-- in the same file (or an earlier migration) re-materializes the function's
-- PUBLIC-execute footgun (see 202608050037's header for what that means).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
