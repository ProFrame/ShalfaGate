-- ============================================================================
-- 042 — Tags Engine
--
-- Batch 1, Module 5 (last in this batch). Owner: Platform Core
-- (bbnovix_contract.md §12).
--
-- Confirmed during design (not assumed) that this genuinely needs a new,
-- generic implementation rather than reusing what already exists — three
-- different "tag" shapes were found in the codebase, and none of them fit:
--   1. public.employee_tags / public.employee_tag_assignments (migration
--      202608040013) — a real catalog with color/code, but hardcoded to
--      employees (employee_tag_assignments.employee_id) and already wired
--      into the Audience Engine's 'Tag' dimension
--      (public.audience_matches()). Left untouched here: it is a live,
--      working dependency for Announcements/Surveys/Calendar/Content/
--      Certificates audience targeting, and re-plumbing it onto a generic
--      table is a migration project of its own, not "build the Tags Engine"
--      — same reasoning Module 2 applied to form_attachments.
--   2. public.content_items.tags (a bare `text[]`, no catalog, no color, no
--      reuse) — ad-hoc, also left untouched for the same reason.
--   3. Nothing generic/polymorphic exists for any other entity type
--      (Assets, Operations, ...), even though Shared Platform Services in
--      FourthUpdate.md names Tags as a Platform-Core-owned service.
--
-- This migration adds exactly that generic layer: a per-tenant tag catalog
-- (public.tags) and a polymorphic entity_type/entity_id join table
-- (public.entity_tags) — deliberately NOT merged with employee_tags. Two
-- separate, intentional catalogs for two different concerns, documented
-- here so the separation reads as a decision, not a duplication oversight.
--
-- Authorization model, reasoned explicitly (the lesson from Module 2's
-- review — attachment_list() shipped once with no check at all): a tag is
-- a lightweight label, not sensitive content the way a stored file or a
-- history entry can be. Every RPC here is scoped to the caller's own tenant
-- only, with no additional owner/actor check — any authenticated member of
-- a company may create, attach, list, or detach a tag within it. This is a
-- deliberate, lower-sensitivity default (matches how tagging works in most
-- real systems), not an oversight; do not add an ownership check here
-- without a concrete reason, and do not treat this file as a template for a
-- module whose data actually needs one (storage/attachments/timeline do).
-- ============================================================================

create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name_1 text not null,
  name_2 text,
  color text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_tags_tenant on public.tags (tenant_id);
create unique index if not exists uq_tags_tenant_code
  on public.tags (tenant_id, code) where not is_deleted;
create unique index if not exists uq_tags_tenant_id on public.tags (tenant_id, id);

drop trigger if exists apply_row_defaults on public.tags;
create trigger apply_row_defaults before insert or update on public.tags
for each row execute function public.apply_row_defaults();

alter table public.tags enable row level security;

drop policy if exists "tenant isolation" on public.tags;
create policy "tenant isolation" on public.tags
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "members read active tags" on public.tags;
create policy "members read active tags" on public.tags
  for select to authenticated using (is_active and not is_deleted);

drop policy if exists "members manage tags" on public.tags;
create policy "members manage tags" on public.tags
  for all to authenticated
  using (public.has_permission('Tags.Manage'))
  with check (public.has_permission('Tags.Manage'));

create table if not exists public.entity_tags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tag_id uuid not null references public.tags(id),
  entity_type text not null,
  entity_id uuid not null,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_entity_tags_tag_same_tenant') then
    alter table public.entity_tags
      add constraint fk_entity_tags_tag_same_tenant
      foreign key (tenant_id, tag_id) references public.tags (tenant_id, id);
  end if;
end $$;

create index if not exists idx_entity_tags_tenant on public.entity_tags (tenant_id);
create index if not exists idx_entity_tags_entity
  on public.entity_tags (tenant_id, entity_type, entity_id) where not is_deleted;
create unique index if not exists uq_entity_tags_unique_tag_per_entity
  on public.entity_tags (tenant_id, tag_id, entity_type, entity_id) where not is_deleted;

drop trigger if exists apply_row_defaults on public.entity_tags;
create trigger apply_row_defaults before insert or update on public.entity_tags
for each row execute function public.apply_row_defaults();

alter table public.entity_tags enable row level security;

drop policy if exists "tenant isolation" on public.entity_tags;
create policy "tenant isolation" on public.entity_tags
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- Deliberately no permissive policy at all — found by the Batch-1 closing
-- audit: a `for all ... with check (true)` policy here let a client bypass
-- entity_tag_attach()'s own validation (the target tag must be is_active and
-- not deleted) via a direct PostgREST insert/update against the table.
-- Nothing in this codebase reads or writes public.entity_tags directly
-- (src/lib/platformCore/tags.js only ever calls the RPCs below); with no
-- permissive policy, RLS denies every direct client access outright, and
-- the SECURITY DEFINER RPCs still work because they run as the table owner,
-- bypassing RLS entirely — the exact same shape already used by
-- public.attachments and public.activity_timeline (no permissive write
-- policy, RPC-only), just applied here to reads too since nothing needs a
-- direct read path either.

insert into public.permissions (code, module, description) values
  ('Tags.Manage', 'Platform', 'Create, rename, or deactivate tags in the tag catalogue')
on conflict (code) do nothing;

-- ----------------------------------------------------------------------------
-- RPCs
-- ----------------------------------------------------------------------------

create or replace function public.tags_list()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(t) order by t.name_1), '[]'::jsonb)
  from public.tags t
  where t.tenant_id = public.current_tenant_id() and t.is_active and not t.is_deleted;
$$;
revoke all on function public.tags_list() from public;
grant execute on function public.tags_list() to authenticated;

create or replace function public.tag_create(p_code text, p_name_1 text, p_name_2 text default null, p_color text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id uuid;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  if not public.has_permission('Tags.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if p_code is null or trim(p_code) = '' then raise exception 'CODE_REQUIRED'; end if;
  if p_name_1 is null or trim(p_name_1) = '' then raise exception 'NAME_REQUIRED'; end if;

  insert into public.tags (tenant_id, code, name_1, name_2, color)
  values (v_tenant, trim(p_code), trim(p_name_1), nullif(trim(coalesce(p_name_2, '')), ''), p_color)
  returning id into v_id;

  return v_id;
exception
  when unique_violation then raise exception 'TAG_CODE_TAKEN';
end;
$$;
revoke all on function public.tag_create(text, text, text, text) from public;
grant execute on function public.tag_create(text, text, text, text) to authenticated;

create or replace function public.entity_tag_attach(p_tag_id uuid, p_entity_type text, p_entity_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id uuid;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  if p_entity_type is null or trim(p_entity_type) = '' then raise exception 'ENTITY_TYPE_REQUIRED'; end if;
  if p_entity_id is null then raise exception 'ENTITY_ID_REQUIRED'; end if;
  if not exists (select 1 from public.tags where id = p_tag_id and tenant_id = v_tenant and is_active and not is_deleted) then
    raise exception 'TAG_NOT_FOUND';
  end if;

  insert into public.entity_tags (tenant_id, tag_id, entity_type, entity_id)
  values (v_tenant, p_tag_id, trim(p_entity_type), p_entity_id)
  on conflict (tenant_id, tag_id, entity_type, entity_id) where not is_deleted do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.entity_tags
    where tenant_id = v_tenant and tag_id = p_tag_id and entity_type = trim(p_entity_type)
      and entity_id = p_entity_id and not is_deleted;
  end if;

  return v_id;
end;
$$;
revoke all on function public.entity_tag_attach(uuid, text, uuid) from public;
grant execute on function public.entity_tag_attach(uuid, text, uuid) to authenticated;

create or replace function public.entity_tag_detach(p_entity_tag_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;

  update public.entity_tags set is_deleted = true
  where id = p_entity_tag_id and tenant_id = v_tenant and not is_deleted;

  if not found then raise exception 'ENTITY_TAG_NOT_FOUND'; end if;
end;
$$;
revoke all on function public.entity_tag_detach(uuid) from public;
grant execute on function public.entity_tag_detach(uuid) to authenticated;

-- Read authorization is deliberately NOT "any tenant member" like
-- attach/detach above. The reasoning that makes open attach/detach safe —
-- "a tag is a lightweight label, not sensitive content" — only covers tag
-- CONTENT. It does not cover the fact that WHICH labels are on an arbitrary
-- entity_id is itself information about that entity (e.g. an HR case tagged
-- "Under Investigation"), and this RPC has no idea what sensitivity a given
-- entity_type carries — it is a generic Platform Core service, the same
-- position attachment_list() (Module 2) and activity_timeline_list()
-- (Module 4) are in, and both of those keep a baseline read gate for
-- exactly this reason. Tags has no natural per-row owner to gate on (unlike
-- those two), so the conservative default here is Tags.Manage — any
-- business module that wants "everyone who can view this record sees its
-- tags" builds its own wrapping RPC with its own audience check on top,
-- exactly like the deferred pattern already used by the other two.
create or replace function public.entity_tag_list(p_entity_type text, p_entity_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(r) order by r.name_1), '[]'::jsonb)
  from (
    select et.id as entity_tag_id, t.id as tag_id, t.code, t.name_1, t.name_2, t.color
    from public.entity_tags et
    join public.tags t on t.id = et.tag_id and t.tenant_id = et.tenant_id
    where et.tenant_id = public.current_tenant_id()
      and et.entity_type = p_entity_type
      and et.entity_id = p_entity_id
      and not et.is_deleted
      and not t.is_deleted
      and public.has_permission('Tags.Manage')
  ) r;
$$;
revoke all on function public.entity_tag_list(text, uuid) from public;
grant execute on function public.entity_tag_list(text, uuid) to authenticated;

comment on table public.tags is
  'Generic, per-tenant tag catalogue for any business entity — Platform Core
  owned (bbnovix_contract.md §12). Deliberately separate from
  public.employee_tags (an existing, unrelated catalogue wired into the
  Audience Engine''s employee-only Tag dimension) and from
  public.content_items.tags (an ad-hoc text[]). Do not create a fourth.';

revoke execute on all functions in schema public from public;
