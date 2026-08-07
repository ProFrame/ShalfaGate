-- ============================================================================
-- 041 — Activity Timeline
--
-- Batch 1, Module 4. Owner: Platform Core (bbnovix_contract.md §12).
--
-- Confirmed during design (not guessed): public.audit_logs (migration
-- 202607280002/202608040012) cannot serve this need. It is a raw technical
-- diff log — action = tg_op ('INSERT'/'UPDATE'/'DELETE'), entity_type =
-- tg_table_name, entity_id = the row's own id, old_data/new_data = the whole
-- row as jsonb — with no human-authored title, no event code, gated for read
-- by Audit.View as one flat admin screen (AdminCenter.jsx), not a per-record
-- narrative feed. FourthUpdate.md's Timeline concept ("Created -> Received ->
-- Transferred -> Accepted -> ...") needs a human-readable event with a title
-- a normal user reads, scoped to one entity, which audit_logs was never
-- designed to be — this is why Shared Platform Services lists Audit Trail
-- and Activity Timeline as two separate Platform-Core-owned rows, not one.
--
-- Read authorization mirrors the lesson from Module 2's review: a timeline
-- event has no natural "owner" the way a storage_objects/attachments row
-- does (an event is a fact about the entity, not something one person owns),
-- so the safe generic default here is actor-of-the-event-or-Audit.View, and
-- ANY business module that wants "everyone who can view this record can see
-- its timeline" builds its OWN wrapping RPC with its OWN audience check on
-- top of this one — the exact same deferred-audience pattern already used by
-- storage_objects and attachments. This module does not, and should not,
-- guess a business module's visibility rules for it.
-- ============================================================================

create table if not exists public.activity_timeline (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  event_code text not null,
  title_ar text not null,
  title_en text not null,
  actor_id uuid references auth.users(id),
  payload jsonb not null default '{}'::jsonb,
  occurred_on timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_activity_timeline_tenant on public.activity_timeline (tenant_id);
create index if not exists idx_activity_timeline_entity
  on public.activity_timeline (tenant_id, entity_type, entity_id, occurred_on)
  where not is_deleted;

drop trigger if exists apply_row_defaults on public.activity_timeline;
create trigger apply_row_defaults before insert or update on public.activity_timeline
for each row execute function public.apply_row_defaults();

alter table public.activity_timeline enable row level security;

drop policy if exists "tenant isolation" on public.activity_timeline;
create policy "tenant isolation" on public.activity_timeline
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "members read own activity or with Audit.View" on public.activity_timeline;
create policy "members read own activity or with Audit.View" on public.activity_timeline
  for select to authenticated
  using (not is_deleted and (actor_id = auth.uid() or public.has_permission('Audit.View')));

-- ----------------------------------------------------------------------------
-- RPCs
-- ----------------------------------------------------------------------------

create or replace function public.record_activity(
  p_entity_type text,
  p_entity_id uuid,
  p_event_code text,
  p_title_ar text,
  p_title_en text,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_title_ar text := nullif(trim(coalesce(p_title_ar, '')), '');
  v_title_en text := nullif(trim(coalesce(p_title_en, '')), '');
  v_id uuid;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  if p_entity_type is null or trim(p_entity_type) = '' then raise exception 'ENTITY_TYPE_REQUIRED'; end if;
  if p_entity_id is null then raise exception 'ENTITY_ID_REQUIRED'; end if;
  if p_event_code is null or trim(p_event_code) = '' then raise exception 'EVENT_CODE_REQUIRED'; end if;
  if coalesce(v_title_ar, v_title_en) is null then
    raise exception 'TITLE_REQUIRED';
  end if;

  -- title_ar/title_en are both NOT NULL — a caller supplying only one
  -- language (the documented, supported case) backfills the other with the
  -- same text rather than hitting a raw not-null-violation at insert time.
  insert into public.activity_timeline (
    tenant_id, entity_type, entity_id, event_code, title_ar, title_en, actor_id, payload
  )
  values (
    v_tenant, trim(p_entity_type), p_entity_id, upper(trim(p_event_code)),
    coalesce(v_title_ar, v_title_en), coalesce(v_title_en, v_title_ar),
    auth.uid(), coalesce(p_payload, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function public.record_activity(text, uuid, text, text, text, jsonb) from public;
-- NOT granted to `authenticated` — found by the Batch-1 closing audit: this
-- function has no check tying the caller to p_entity_id at all (there is
-- nothing generic to check — Activity Timeline is a Platform Layer service
-- with no knowledge of any business module's permission model), so any
-- signed-in tenant member could otherwise write a permanent, indistinguishable-
-- from-genuine event onto any entity_id in the tenant. Same fix migration
-- 202608050031 applied to tenant_quota_consume(): revoke the client grant
-- entirely, since nothing in the product calls this directly yet (confirmed:
-- src/lib/platformCore/activityTimeline.js's recordActivity() has zero
-- business-module callers). A future business RPC (its own SECURITY DEFINER
-- function, already authorized to act on that entity) calls this internally
-- as an implementation detail — that call succeeds regardless of this grant,
-- since it runs as the function owner, not as `authenticated`. If a real
-- user-facing "post a manual note" feature is ever wanted, it needs its own
-- wrapping RPC with its own permission check before calling this, not a
-- blanket re-grant here.
grant execute on function public.record_activity(text, uuid, text, text, text, jsonb) to service_role;

-- Read authorization is reproduced explicitly here (not just left to the RLS
-- policy above) because SECURITY DEFINER bypasses table RLS entirely — the
-- exact gap Module 2's review found in attachment_list(). Do not remove this
-- WHERE clause and rely on the policy alone.
create or replace function public.activity_timeline_list(p_entity_type text, p_entity_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(r) order by r.occurred_on, r.created_on), '[]'::jsonb)
  from (
    select
      at.id, at.entity_type, at.entity_id, at.event_code, at.title_ar, at.title_en,
      at.actor_id, coalesce(u.full_name, u.name_ar, u.name_en, u.email) as actor_name,
      at.payload, at.occurred_on, at.created_on
    from public.activity_timeline at
    left join public.users u on u.id = at.actor_id
    where at.tenant_id = public.current_tenant_id()
      and at.entity_type = p_entity_type
      and at.entity_id = p_entity_id
      and not at.is_deleted
      and (at.actor_id = auth.uid() or public.has_permission('Audit.View'))
  ) r;
$$;
revoke all on function public.activity_timeline_list(text, uuid) from public;
grant execute on function public.activity_timeline_list(text, uuid) to authenticated;

comment on table public.activity_timeline is
  'Human-readable, per-entity event history — Platform Core owned
  (bbnovix_contract.md §12). Distinct from public.audit_logs (raw technical
  row diffs, admin-only, not per-record). Every module needing "what
  happened to this record" calls record_activity()/activity_timeline_list(),
  never a bespoke log table.';

revoke execute on all functions in schema public from public;
