-- ============================================================================
-- 027 — Close a company-hopping hole in the employee's own profile row
--
-- Migration 0001 gave every employee this policy and nothing since has
-- narrowed it:
--
--     create policy "users can update own profile" on public.users
--       for update using (auth.uid() = id) with check (auth.uid() = id);
--
-- It names no columns, so any authenticated employee can PATCH their own row
-- with ANY column, including active_tenant_id. current_tenant_id() trusts that
-- column outright:
--
--     select coalesce(u.active_tenant_id, u.tenant_id) ...
--
-- and the RESTRICTIVE "tenant isolation" policy on every table checks the
-- row's tenant_id against current_tenant_id() — which the same PATCH just
-- redefined. tenant_id itself is frozen by apply_row_defaults, so the check
-- ends up comparing the frozen tenant_id against a current_tenant_id() that
-- is now free to say anything: the WITH CHECK passes because both sides trace
-- back to a value the request itself controls. From the next request on, every
-- table in the platform believes the caller belongs to whatever company they
-- named — a complete cross-tenant breach reachable by any employee of any
-- company, using only the public anon RPC tenant_public_profile(slug) to learn
-- the target's tenant id.
--
-- Two independent fixes, because either one alone would still leave a way in
-- if the other were ever weakened by a future change:
--
--   1. current_tenant_id() stops trusting active_tenant_id blindly. It is only
--      honoured when a real, active tenant_memberships row backs it up —
--      exactly the check switch_tenant() already performs before setting it.
--   2. A guard trigger freezes the columns a self-update must never touch,
--      the same way guard_employee_auth_email already freezes email. It only
--      applies to a direct client request on the caller's own row; it does not
--      apply to service_role (the admin edge functions), to SECURITY DEFINER
--      RPCs such as switch_tenant() and record_first_login() (their internal
--      UPDATE runs as the function owner, not as 'authenticated'), or to an
--      administrator editing SOMEONE ELSE'S row under Employees.Manage.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. current_tenant_id() verifies membership instead of trusting the column
-- ----------------------------------------------------------------------------

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is null
      then nullif(current_setting('bbnovix.tenant_id', true), '')::uuid
    else (
      select coalesce(
        (
          select u.active_tenant_id
          from public.users u
          where u.id = auth.uid()
            and not u.is_deleted
            and u.active_tenant_id is not null
            and exists (
              select 1 from public.tenant_memberships m
              where m.user_id = u.id
                and m.tenant_id = u.active_tenant_id
                and m.status = 'Active'
            )
        ),
        (
          select u.tenant_id
          from public.users u
          where u.id = auth.uid() and not u.is_deleted
        )
      )
    )
  end;
$$;
grant execute on function public.current_tenant_id() to authenticated;

-- ----------------------------------------------------------------------------
-- 2. A self-update can never change the columns below
-- ----------------------------------------------------------------------------

create or replace function public.guard_user_self_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Not a self-edit: a manager updating a colleague, or a system path
  -- (service_role, or a SECURITY DEFINER RPC running as its owner). Neither
  -- is this trigger's concern.
  if current_user <> 'authenticated' or auth.uid() is distinct from old.id then
    return new;
  end if;

  -- active_tenant_id has exactly one legitimate writer: switch_tenant(), which
  -- checks tenant_memberships before setting it, and switch_tenant's own
  -- UPDATE runs as the function owner (current_user <> 'authenticated'), so it
  -- never reaches this branch. No genuine client flow issues a raw PATCH of
  -- this column, so raising here — rather than silently freezing, as the rest
  -- of this trigger does — turns a company-hopping attempt into a loud,
  -- auditable failure instead of a quiet no-op.
  if new.active_tenant_id is distinct from old.active_tenant_id then
    raise exception 'ACTIVE_TENANT_MUST_BE_SET_THROUGH_SWITCH_TENANT'
      using errcode = '23514';
  end if;

  -- Everything else in this list is either assigned by an administrator
  -- (Employees.Manage), stamped by a system RPC, or a security-relevant flag.
  -- A caller who does hold Employees.Manage may still be reassigning their own
  -- record legitimately, so those columns pass through for that case; every
  -- other self-update keeps its old values.
  if not public.has_permission('Employees.Manage') then
    new.is_active          := old.is_active;
    new.employee_no        := old.employee_no;
    new.department_id      := old.department_id;
    new.position_id        := old.position_id;
    new.sector_id          := old.sector_id;
    new.project_id         := old.project_id;
    new.site_id            := old.site_id;
    new.country_id         := old.country_id;
    new.manager_id         := old.manager_id;
    new.national_id        := old.national_id;
    new.gender              := old.gender;
    new.nationality         := old.nationality;
    new.nationality_ar      := old.nationality_ar;
    new.nationality_en      := old.nationality_en;
    new.employment_status   := old.employment_status;
    new.hire_date            := old.hire_date;
    new.is_deleted           := old.is_deleted;
    new.deleted_by           := old.deleted_by;
    new.deleted_date         := old.deleted_date;
  end if;

  -- These five are written exclusively by record_first_login() and by the
  -- invite/import paths, never by a person editing their own profile form.
  new.invitation_sent          := old.invitation_sent;
  new.invitation_sent_on       := old.invitation_sent_on;
  new.invitation_accepted_on   := old.invitation_accepted_on;
  new.account_activated_on     := old.account_activated_on;
  new.first_login_on           := old.first_login_on;
  new.password_set_on          := old.password_set_on;
  new.last_login_on            := old.last_login_on;

  return new;
end;
$$;

drop trigger if exists guard_user_self_update on public.users;
create trigger guard_user_self_update
before update on public.users
for each row execute function public.guard_user_self_update();

comment on function public.guard_user_self_update() is
  'Freezes the columns a self-service profile edit must never change, most importantly active_tenant_id.';
