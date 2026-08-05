-- bbnovix security hardening
--
-- record_login must accept anonymous failed attempts, but an anonymous caller
-- must never be able to claim that another account signed in successfully.
-- The original implementation also returned account-existence details. This
-- replacement authenticates success events and returns a uniform public shape.

create or replace function public.record_login(
  p_success boolean,
  p_email text,
  p_device_hash text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email citext := lower(trim(coalesce(p_email, '')));
  v_user public.users%rowtype;
  v_tenant uuid;
  v_ip inet := public.request_client_ip();
  v_agent text := left(coalesce(nullif(trim(coalesce(p_user_agent, '')), ''), public.request_user_agent(), ''), 400);
  v_hash text := nullif(trim(coalesce(p_device_hash, '')), '');
  v_max smallint := 5;
  v_failures integer := 0;
  v_new_device boolean := false;
begin
  if v_email::text = '' then raise exception 'EMAIL_REQUIRED'; end if;

  select * into v_user from public.users
  where lower(trim(email)) = v_email::text and not is_deleted
  order by last_login_on desc nulls last
  limit 1;

  -- A successful credential check can only be reported by the authenticated
  -- identity itself. This prevents anonymous callers from forging activity,
  -- devices and usage statistics for a known address.
  if coalesce(p_success, false)
     and (auth.uid() is null or v_user.id is null or auth.uid() <> v_user.id) then
    raise exception 'UNAUTHORIZED';
  end if;

  v_tenant := coalesce(v_user.tenant_id, public.platform_tenant_id());
  if v_tenant is null then raise exception 'PLATFORM_TENANT_MISSING'; end if;

  if (
    select count(*) from public.login_attempts
    where email = v_email and attempted_on > now() - interval '5 minutes'
  ) >= 50 then
    return jsonb_build_object('recorded', false, 'reason', 'TOO_MANY_ATTEMPTS');
  end if;

  insert into public.login_attempts (
    tenant_id, user_id, email, succeeded, ip, user_agent, device_hash, failure_reason
  )
  values (
    v_tenant, v_user.id, v_email, coalesce(p_success, false), v_ip, nullif(v_agent, ''), v_hash,
    case when coalesce(p_success, false) then null
         when v_user.id is null then 'UNKNOWN_ACCOUNT' else 'INVALID_CREDENTIALS' end
  );

  select coalesce(max_login_attempts, 5) into v_max
  from public.tenant_settings where tenant_id = v_tenant;
  v_max := coalesce(v_max, 5);

  select count(*) into v_failures
  from public.login_attempts
  where email = v_email
    and not succeeded
    and attempted_on > now() - interval '15 minutes'
    and attempted_on > coalesce((
      select max(attempted_on) from public.login_attempts
      where email = v_email and succeeded
    ), now() - interval '100 years');

  if coalesce(p_success, false) then
    update public.users set last_login_on = now() where id = v_user.id;

    if v_hash is not null then
      v_new_device := not exists (
        select 1 from public.user_devices
        where tenant_id = v_tenant and user_id = v_user.id and device_hash = v_hash
      );

      insert into public.user_devices (tenant_id, user_id, device_hash, user_agent, ip)
      values (v_tenant, v_user.id, v_hash, nullif(v_agent, ''), v_ip)
      on conflict (tenant_id, user_id, device_hash) do update
        set last_seen_on = now(),
            user_agent = coalesce(excluded.user_agent, public.user_devices.user_agent),
            ip = coalesce(excluded.ip, public.user_devices.ip),
            revoked_on = null;

      if v_new_device then
        insert into public.security_events (tenant_id, user_id, event_code, severity, detail, ip, user_agent)
        values (v_tenant, v_user.id, 'NEW_DEVICE_SIGN_IN', 'Warning',
                jsonb_build_object('device_hash', v_hash), v_ip, nullif(v_agent, ''));
      end if;
    end if;
  elsif v_user.id is not null and v_failures = v_max then
    -- Emit one threshold event, not another event on every later failure.
    insert into public.security_events (tenant_id, user_id, event_code, severity, detail, ip, user_agent)
    values (v_tenant, v_user.id, 'LOGIN_ATTEMPTS_EXCEEDED', 'Critical',
            jsonb_build_object('failures', v_failures, 'limit', v_max),
            v_ip, nullif(v_agent, ''));
  end if;

  if auth.uid() is null then
    -- Uniform answer prevents public account enumeration.
    return jsonb_build_object('recorded', true);
  end if;

  return jsonb_build_object(
    'recorded', true,
    'new_device', v_new_device
  );
end;
$$;

revoke all on function public.record_login(boolean, text, text, text) from public;
grant execute on function public.record_login(boolean, text, text, text) to anon, authenticated;

comment on function public.record_login(boolean, text, text, text) is
  'Records auth outcomes; successful events require auth.uid() to match the account and anonymous responses never reveal account existence.';
