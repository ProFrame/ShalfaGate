-- ============================================================================
-- 033 — A company could point its own storage connection at anyone's secret
--
-- storage_set_tenant_config(p_tenant_id, p_payload) lets a company's own
-- Storage.Manage or Settings.Manage holder configure their bucket, region and
-- provider — reasonable, that is a company setting. But the same unrestricted
-- write also covered credential_ref, a free-text string with no allowlist and
-- no ownership check:
--
--   credential_ref = case when p_payload ? 'credential_ref'
--                    then nullif(trim(coalesce(p_payload ->> 'credential_ref', '')), '')
--                    else c.credential_ref end,
--
-- The storage-proxy edge function resolves real S3/R2/B2 credentials from the
-- function's own environment by this exact string — STORAGE_{REF}_ACCESS_KEY_ID
-- / STORAGE_{REF}_SECRET_ACCESS_KEY — never from anything in the database. Any
-- company that learned or guessed another tenant's credential_ref (support
-- correspondence, a shared consultant, plain enumeration of short human-chosen
-- names) could set their own credential_ref to that value and their own
-- config.bucket to whatever they liked: every upload, download and delete
-- their company then made would run under the OTHER company's real cloud
-- credentials — someone else's bill, and if the bucket name was also guessed
-- or already known, someone else's files.
--
-- credential_ref is a platform provisioning decision — which secret an
-- operator has put in the function's environment for a given enterprise
-- customer — not a company self-service setting, exactly like quota_bytes
-- three lines below it (which was already operator-gated). Fixed by gating it
-- the same way; provider_code, config (bucket/region/endpoint) and everything
-- else a company legitimately owns are unchanged.
-- ============================================================================

create or replace function public.storage_set_tenant_config(p_tenant_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := coalesce(p_tenant_id, public.current_tenant_id());
  v_is_operator boolean := public.is_platform_operator();
  v_provider text := nullif(trim(coalesce(p_payload ->> 'provider_code', '')), '');
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;

  if not v_is_operator then
    if v_tenant <> public.current_tenant_id() then raise exception 'PERMISSION_DENIED'; end if;
    if not (public.has_permission('Storage.Manage') or public.has_permission('Settings.Manage')) then
      raise exception 'PERMISSION_DENIED';
    end if;
  end if;

  if v_provider is not null and v_provider <> 'none'
     and not exists (select 1 from public.storage_providers where code = v_provider) then
    raise exception 'STORAGE_PROVIDER_UNKNOWN';
  end if;

  insert into public.tenant_storage_config (tenant_id) values (v_tenant)
  on conflict (tenant_id) do nothing;

  update public.tenant_storage_config c
  set provider_code = case when p_payload ? 'provider_code' then nullif(v_provider, 'none') else c.provider_code end,
      is_enabled = case when p_payload ? 'is_enabled' then coalesce((p_payload ->> 'is_enabled')::boolean, c.is_enabled) else c.is_enabled end,
      config = case when p_payload ? 'config' then coalesce(p_payload -> 'config', '{}'::jsonb) else c.config end,
      -- Which secret in the function's environment gets used is an operator
      -- decision, never a value the company itself supplies.
      credential_ref = case when v_is_operator and p_payload ? 'credential_ref'
                            then nullif(trim(coalesce(p_payload ->> 'credential_ref', '')), '') else c.credential_ref end,
      root_path = case when p_payload ? 'root_path' then coalesce(nullif(trim(coalesce(p_payload ->> 'root_path', '')), ''), 'tenants') else c.root_path end,
      max_file_bytes = case when p_payload ? 'max_file_bytes' then nullif(p_payload ->> 'max_file_bytes', '')::bigint else c.max_file_bytes end,
      allowed_mime_types = case
        when p_payload ? 'allowed_mime_types'
        then coalesce(
          (select array_agg(t.mt) from jsonb_array_elements_text(p_payload -> 'allowed_mime_types') as t(mt)),
          '{}'::text[])
        else c.allowed_mime_types end,
      -- Only the platform decides how much space a company gets.
      quota_bytes = case when v_is_operator and p_payload ? 'quota_bytes'
                         then coalesce((p_payload ->> 'quota_bytes')::bigint, c.quota_bytes) else c.quota_bytes end,
      last_check_on = case when p_payload ? 'last_check_status' then now() else c.last_check_on end,
      last_check_status = case when p_payload ? 'last_check_status'
                               then nullif(trim(coalesce(p_payload ->> 'last_check_status', '')), '') else c.last_check_status end,
      last_check_message = case when p_payload ? 'last_check_message'
                                then nullif(trim(coalesce(p_payload ->> 'last_check_message', '')), '') else c.last_check_message end,
      connected_on = case when p_payload ? 'provider_code' and v_provider is not null and v_provider <> 'none'
                          then coalesce(c.connected_on, now()) else c.connected_on end,
      connected_by = case when p_payload ? 'provider_code' and v_provider is not null and v_provider <> 'none'
                          then coalesce(c.connected_by, auth.uid()) else c.connected_by end
  where c.tenant_id = v_tenant;

  -- tenant_settings stays the single source of truth for the two switches the
  -- rest of the product reads.
  update public.tenant_settings s
  set storage_provider = case when p_payload ? 'provider_code'
                              then coalesce(v_provider, 'none') else s.storage_provider end,
      extended_storage_enabled = case when p_payload ? 'is_enabled'
                                      then coalesce((p_payload ->> 'is_enabled')::boolean, s.extended_storage_enabled)
                                      else s.extended_storage_enabled end,
      updated_on = now()
  where s.tenant_id = v_tenant
    and (p_payload ? 'provider_code' or p_payload ? 'is_enabled');

  if v_is_operator and p_payload ? 'quota_bytes' then
    insert into public.tenant_quotas (tenant_id, resource_code, limit_value)
    values (v_tenant, 'STORAGE_BYTES', coalesce((p_payload ->> 'quota_bytes')::bigint, 0))
    on conflict (tenant_id, resource_code) do update
      set limit_value = excluded.limit_value, updated_on = now();
  end if;

  return jsonb_build_object(
    'tenant_id', v_tenant,
    'config', (select to_jsonb(c) - 'config' - 'credential_ref'
               from public.tenant_storage_config c where c.tenant_id = v_tenant)
  );
end;
$$;
grant execute on function public.storage_set_tenant_config(uuid, jsonb) to authenticated;

comment on function public.storage_set_tenant_config(uuid, jsonb) is
  'Company storage connection settings, self-service for Storage.Manage/Settings.Manage on the '
  'caller''s own tenant. credential_ref and quota_bytes are operator-only: the first names which '
  'real cloud secret the proxy signs with, the second is the platform''s own allocation decision.';
