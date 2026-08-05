-- ============================================================================
-- 029 — A company cannot promote itself to the platform operator
--
-- The update policy on public.tenants checks row identity and one permission:
--
--     create policy "tenant admins update own tenant" on public.tenants
--       for update to authenticated
--       using (id = public.current_tenant_id() and public.has_permission('Settings.Manage'))
--       with check (id = public.current_tenant_id() and public.has_permission('Settings.Manage'));
--
-- Row level security cannot restrict which COLUMNS a matching row may change,
-- and guard_tenant_slug only ever protected the slug. Every company's own
-- PLATFORM_ADMIN holds Settings.Manage, so any of them could already:
--
--   PATCH /rest/v1/tenants?id=eq.<own tenant>  { "is_platform": true }
--
-- public.is_platform_operator() (migration 0012) then trusts that column
-- outright — `t.is_platform` on whichever tenant a PLATFORM_OPERATOR role
-- happens to sit in — and "rbac managers manage roles" / "rbac managers
-- manage assignments" (migration 0002) already let a company administrator
-- create a role and assign it to themselves. Three ordinary authenticated
-- requests were therefore enough to become a platform operator over every
-- company: every tenant, storage config and quota on the platform has no
-- RESTRICTIVE isolation policy of its own and instead ORs `is_platform_operator()`
-- into its permissive policies, exactly so the real operator can reach them all.
--
-- Two independent fixes:
--   1. The columns that define platform identity — is_platform, license_code,
--      status, code — can only be changed by a session that is ALREADY a
--      platform operator. Folded into guard_tenant_slug, which already runs
--      on every insert and update of this table.
--   2. is_platform_operator() stops trusting a per-row boolean and compares
--      against the one fixed platform tenant instead, with a partial unique
--      index making a second `is_platform = true` row impossible to create in
--      the first place. Fix 1 alone is enough once applied, but a boolean that
--      only one row may ever set truthfully is a narrower, structurally
--      enforced claim than a boolean any row can carry.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Freeze platform-identity columns for anyone who is not already an
--    operator. tenants has no created_by/row_version (it predates
--    apply_row_defaults), so the guard belongs here rather than in that
--    shared trigger.
-- ----------------------------------------------------------------------------

create or replace function public.guard_tenant_slug()
returns trigger
language plpgsql
security definer
set search_path = public
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

  if tg_op = 'UPDATE' and not public.is_platform_operator() then
    if new.is_platform is distinct from old.is_platform
       or new.license_code is distinct from old.license_code
       or new.status is distinct from old.status
       or new.code is distinct from old.code
    then
      raise exception 'TENANT_IDENTITY_COLUMNS_ARE_OPERATOR_ONLY' using errcode = '23514';
    end if;
  end if;

  new.updated_on := now();
  return new;
end;
$$;

-- The trigger already exists from migration 0012; re-created here only
-- because the function body changed. security definer is added so the
-- is_platform_operator() lookup inside it runs consistently regardless of
-- what RLS the calling session would otherwise see on user_roles/roles.
drop trigger if exists guard_tenant_slug on public.tenants;
create trigger guard_tenant_slug
before insert or update on public.tenants
for each row execute function public.guard_tenant_slug();

-- ----------------------------------------------------------------------------
-- 2. Platform identity is one fixed tenant, not a column any row can carry.
--    A partial unique index makes "a second is_platform tenant" a constraint
--    violation rather than a policy question, and is_platform_operator() is
--    restated to compare against that one row explicitly — so even a future
--    bug that manages to flip is_platform on some other row (a direct SQL
--    script, a service-role mistake) still cannot mint a second operator
--    tenant, and cannot make is_platform_operator() trust it.
-- ----------------------------------------------------------------------------

create unique index if not exists uq_one_platform_tenant
  on public.tenants ((true))
  where is_platform and not is_deleted;

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
    where ur.user_id = auth.uid()
      and r.code = 'PLATFORM_OPERATOR'
      and r.tenant_id = public.platform_tenant_id()
      and r.is_active
      and not r.is_deleted
  );
$$;
grant execute on function public.is_platform_operator() to authenticated;

comment on function public.is_platform_operator() is
  'True only for a PLATFORM_OPERATOR role held inside the one fixed platform tenant (public.platform_tenant_id()), '
  'never derived from a per-row is_platform flag a company could otherwise flip on itself.';
