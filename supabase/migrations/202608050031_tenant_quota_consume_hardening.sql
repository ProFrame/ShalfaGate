-- ============================================================================
-- 031 — tenant_quota_consume() trusted a caller-supplied tenant
--
-- public.tenant_quota_consume(p_resource, p_delta, p_tenant_id) is SECURITY
-- DEFINER and was granted to `authenticated` — every signed-in user of every
-- company, not just the triggers that actually call it (consume_engagement_quota
-- and its siblings in the chat, verification and storage modules, all of which
-- pass their own row's tenant_id and never reach the client). Nothing in the
-- product calls this RPC directly:
--
--   grep -rn "tenant_quota_consume" src/   ->   no matches
--
-- so the grant was pure attack surface. Any authenticated employee of any one
-- company could call it directly with another company's tenant id and an
-- arbitrary delta — inflating a rival's usage past its plan limit to trip
-- quota enforcement, or driving it back to zero to erase real consumption.
-- Two independent fixes: the grant is revoked (nothing legitimate needs it),
-- and p_tenant_id is only honoured for a platform operator, so a future
-- console feature that does need to adjust another company's quota can still
-- pass it explicitly without reopening this for everyone else.
-- ============================================================================

create or replace function public.tenant_quota_consume(
  p_resource text,
  p_delta bigint default 1,
  p_tenant_id uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
begin
  v_tenant := case
    when p_tenant_id is not null and public.is_platform_operator() then p_tenant_id
    else public.current_tenant_id()
  end;

  if v_tenant is null then
    raise exception 'TENANT_REQUIRED';
  end if;

  insert into public.tenant_quotas (tenant_id, resource_code, limit_value, used_value)
  values (v_tenant, p_resource, 0, greatest(p_delta, 0))
  on conflict (tenant_id, resource_code) do update
    set used_value = greatest(public.tenant_quotas.used_value + p_delta, 0),
        updated_on = now();
end;
$$;

revoke all on function public.tenant_quota_consume(text, bigint, uuid) from public, anon, authenticated;

comment on function public.tenant_quota_consume(text, bigint, uuid) is
  'Internal bookkeeping only, called from the per-module quota triggers as the row owner. '
  'Not granted to authenticated: nothing in the client calls it, and p_tenant_id is honoured '
  'only for a platform operator so it cannot be used to tamper with another company''s usage.';
