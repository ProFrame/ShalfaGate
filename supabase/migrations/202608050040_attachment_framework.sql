-- ============================================================================
-- 040 — Attachment Framework
--
-- Batch 1, Module 2. Owner: Storage Service (see bbnovix_contract.md §12 —
-- "Attachments" is owned by Storage Service, a thin consumer of the storage
-- ledger Module 1 already hardened, not a second storage implementation).
--
-- FourthUpdate.md's attachment UX rule (section "ايقونة المرفقات في كل النماذج"):
-- every attachment is a card (name/size/type/uploader/date) with a preview
-- (zoom/rotate/download/print, next/previous), and — the rule that actually
-- needed new schema — a file is never replaced or hard-deleted from a
-- request; a user can only mark it for removal, still visible, still
-- openable, until whatever approves the parent record processes it.
--
-- public.storage_objects (migration 202608040018) already IS the file
-- ledger — path, provider, mime, size, checksum, owner, a free-text
-- entity_type/entity_id pair. This migration does not duplicate it. It adds
-- one thin table for the one thing storage_objects deliberately does not
-- have an opinion about: "this file is attached to this business record,
-- in this order, possibly marked for removal" — a different lifecycle than
-- "this file exists and someone owns it", which is why it is a separate
-- table rather than four more nullable columns bolted onto storage_objects
-- for every future non-attachment consumer of that table to carry around.
--
-- Deliberately NOT done here: migrating the pre-existing, ad-hoc
-- form_attachments table/form-attachments bucket (src/data/formsService.js)
-- onto this framework. That bypass is real (writes straight to
-- supabase.storage, no quota/mime check, no storage_objects row — the same
-- class of gap Module 1 fixed for profile assets) but migrating a live,
-- already-shipped screen's read AND write paths is a feature migration in
-- its own right, not "build the framework" — logged as a follow-up, exactly
-- like FormsPortal.jsx's Date.now() reference numbers were logged in Phase 0
-- rather than fixed inline. See bbnovix_contract.md §15 (Forbidden) for both
-- entries.
-- ============================================================================

-- storage_objects.id is already globally unique (primary key), but a
-- composite FK target needs an explicit unique index on the exact tuple.
create unique index if not exists uq_storage_objects_tenant_id
  on public.storage_objects (tenant_id, id);

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  storage_object_id uuid not null references public.storage_objects(id),
  entity_type text not null,
  entity_id uuid not null,
  display_order integer not null default 0,
  marked_for_removal boolean not null default false,
  marked_for_removal_by uuid references auth.users(id),
  marked_for_removal_on timestamptz,
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
  if not exists (select 1 from pg_constraint where conname = 'fk_attachments_storage_object_same_tenant') then
    alter table public.attachments
      add constraint fk_attachments_storage_object_same_tenant
      foreign key (tenant_id, storage_object_id) references public.storage_objects (tenant_id, id);
  end if;
end $$;

create index if not exists idx_attachments_tenant on public.attachments (tenant_id);
create index if not exists idx_attachments_entity
  on public.attachments (tenant_id, entity_type, entity_id, display_order)
  where not is_deleted;
create unique index if not exists uq_attachments_storage_object
  on public.attachments (tenant_id, storage_object_id) where not is_deleted;

drop trigger if exists apply_row_defaults on public.attachments;
create trigger apply_row_defaults before insert or update on public.attachments
for each row execute function public.apply_row_defaults();

alter table public.attachments enable row level security;

drop policy if exists "tenant isolation" on public.attachments;
create policy "tenant isolation" on public.attachments
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- Same visibility rule as storage_objects itself: not admin-only, but not
-- "everyone in the company either" — a module that wants to show an
-- attachment to a wider audience (e.g. all approval participants) does so
-- through its own definer RPC and its own audience check, same as
-- storage_objects' comment already states.
drop policy if exists "members read own or permitted attachments" on public.attachments;
create policy "members read own or permitted attachments" on public.attachments
  for select to authenticated
  using (not is_deleted and (created_by = auth.uid() or public.has_permission('Storage.Manage')));

-- ----------------------------------------------------------------------------
-- RPCs
-- ----------------------------------------------------------------------------

create or replace function public.attachment_attach(
  p_storage_object_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_display_order integer default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_object public.storage_objects%rowtype;
  v_order integer;
  v_id uuid;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  if p_entity_type is null or trim(p_entity_type) = '' then raise exception 'ENTITY_TYPE_REQUIRED'; end if;
  if p_entity_id is null then raise exception 'ENTITY_ID_REQUIRED'; end if;

  select * into v_object from public.storage_objects
  where id = p_storage_object_id and tenant_id = v_tenant and not is_deleted;
  if not found then raise exception 'STORAGE_OBJECT_NOT_FOUND'; end if;

  if not (
    v_object.owner_id = auth.uid()
    or v_object.created_by = auth.uid()
    or public.has_permission('Storage.Manage')
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  v_order := coalesce(
    p_display_order,
    (select coalesce(max(display_order), -1) + 1 from public.attachments
     where tenant_id = v_tenant and entity_type = p_entity_type and entity_id = p_entity_id and not is_deleted)
  );

  insert into public.attachments (tenant_id, storage_object_id, entity_type, entity_id, display_order)
  values (v_tenant, p_storage_object_id, trim(p_entity_type), p_entity_id, v_order)
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function public.attachment_attach(uuid, text, uuid, integer) from public;
grant execute on function public.attachment_attach(uuid, text, uuid, integer) to authenticated;

-- SECURITY DEFINER bypasses the table's own RLS entirely, so this WHERE
-- clause — not the "members read own or permitted attachments" policy above
-- — is the real authorization boundary. It must therefore reproduce that
-- same rule (owner or Storage.Manage) explicitly; tenant scoping alone is
-- not enough, or any employee could read any other employee's attachments
-- on any record in the same company just by knowing its entity_id. A
-- business module that legitimately needs a wider audience (e.g. "anyone
-- who can view this Asset can see its attachments") builds its own
-- definer RPC with its own audience check on top of this one — it does not
-- get that by this shared RPC being permissive by default.
create or replace function public.attachment_list(p_entity_type text, p_entity_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(r) order by r.display_order, r.created_on), '[]'::jsonb)
  from (
    select
      a.id, a.storage_object_id, a.entity_type, a.entity_id, a.display_order,
      a.marked_for_removal, a.marked_for_removal_by, a.marked_for_removal_on,
      a.created_by, a.created_on,
      coalesce(u.full_name, u.name_ar, u.name_en, u.email) as created_by_name,
      o.layer, o.provider_code, o.bucket, o.path, o.file_name, o.mime_type, o.file_size, o.owner_id
    from public.attachments a
    join public.storage_objects o on o.id = a.storage_object_id and o.tenant_id = a.tenant_id
    left join public.users u on u.id = a.created_by
    where a.tenant_id = public.current_tenant_id()
      and a.entity_type = p_entity_type
      and a.entity_id = p_entity_id
      and not a.is_deleted
      and not o.is_deleted
      and (
        a.created_by = auth.uid()
        or o.owner_id = auth.uid()
        or public.has_permission('Storage.Manage')
      )
  ) r;
$$;
revoke all on function public.attachment_list(text, uuid) from public;
grant execute on function public.attachment_list(text, uuid) to authenticated;

create or replace function public.attachment_mark_for_removal(p_id uuid, p_marked boolean default true)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_row public.attachments%rowtype;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;

  select * into v_row from public.attachments where id = p_id and tenant_id = v_tenant and not is_deleted;
  if not found then raise exception 'ATTACHMENT_NOT_FOUND'; end if;

  if not (
    v_row.created_by = auth.uid()
    or public.has_permission('Storage.Manage')
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  update public.attachments
  set marked_for_removal = coalesce(p_marked, true),
      marked_for_removal_by = case when coalesce(p_marked, true) then auth.uid() else null end,
      marked_for_removal_on = case when coalesce(p_marked, true) then now() else null end
  where id = p_id;
end;
$$;
revoke all on function public.attachment_mark_for_removal(uuid, boolean) from public;
grant execute on function public.attachment_mark_for_removal(uuid, boolean) to authenticated;

comment on table public.attachments is
  'Links an already-uploaded public.storage_objects row to a business record '
  '(entity_type/entity_id). Owned by Storage Service (bbnovix_contract.md §12) — '
  'every module that shows a list of files attached to one of its records uses '
  'this, never a bespoke table. marked_for_removal is a UX flag, not a delete: '
  'the file stays visible and openable until the owning module''s own workflow '
  'processes the removal.';

revoke execute on all functions in schema public from public;
