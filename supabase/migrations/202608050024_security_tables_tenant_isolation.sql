-- ============================================================================
-- 024 — Close a cross-company leak in the three security tables
--
-- public.login_attempts, public.user_devices and public.security_events were
-- created with tenant_id and the full audit column set, but migration 0018
-- never gave them the RESTRICTIVE "tenant isolation" policy that every other
-- company-scoped table has, and never attached apply_row_defaults.
--
-- Their permissive policies read, in effect:
--
--     using (public.has_permission('Security.View') or public.has_permission('Audit.View'))
--
-- has_permission() is company-aware — it answers "does this caller hold
-- Security.View *inside their own company*" — but the policy then places no
-- restriction on which rows come back. So any company administrator holding
-- that permission could read EVERY company's login history: employee e-mail
-- addresses, IP addresses, user agents and device fingerprints.
--
-- Rows are already filed under the right company: record_login() stamps the
-- signing-in user's tenant, and attempts against an address that belongs to no
-- account are filed under the platform tenant. So adding the missing isolation
-- hides nothing a company administrator legitimately needs.
-- ============================================================================

do $$
declare
  security_tables text[] := array['login_attempts', 'user_devices', 'security_events'];
  tbl text;
begin
  foreach tbl in array security_tables loop
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

    execute format('drop trigger if exists apply_row_defaults on public.%I', tbl);
    execute format(
      'create trigger apply_row_defaults before insert or update on public.%I
       for each row execute function public.apply_row_defaults()',
      tbl
    );
  end loop;
end $$;

-- The permissive policies are restated with the company predicate written out.
-- The restrictive policy above already enforces it; saying it here as well
-- means the next person to read these policies sees the intent instead of
-- having to know that a second policy is being ANDed in.

drop policy if exists "security readers read login attempts" on public.login_attempts;
create policy "security readers read login attempts" on public.login_attempts
  for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and (public.has_permission('Security.View') or public.has_permission('Audit.View'))
  );

drop policy if exists "users read own devices" on public.user_devices;
create policy "users read own devices" on public.user_devices
  for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and (user_id = auth.uid() or public.has_permission('Security.View'))
  );

drop policy if exists "users manage own devices" on public.user_devices;
create policy "users manage own devices" on public.user_devices
  for update to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and (user_id = auth.uid() or public.has_permission('Settings.Manage'))
  )
  with check (
    tenant_id = public.current_tenant_id()
    and (user_id = auth.uid() or public.has_permission('Settings.Manage'))
  );

drop policy if exists "security readers read events" on public.security_events;
create policy "security readers read events" on public.security_events
  for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and (
      user_id = auth.uid()
      or public.has_permission('Security.View')
      or public.has_permission('Audit.View')
    )
  );

-- ----------------------------------------------------------------------------
-- The read model over these tables, public.security_overview(), was checked and
-- already filters every subquery by public.current_tenant_id(); it needs no
-- change. The leak was in the table policies alone.
-- ----------------------------------------------------------------------------
