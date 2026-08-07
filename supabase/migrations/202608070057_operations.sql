-- ============================================================================
-- 057 — Operations (field-work tracking)
--
-- Discovery (this session, no prior trust, mirroring Safety Management's own
-- header discipline): a dedicated discovery+design pass read the real current
-- schema before a line of this file was written. Confirmed by direct grep of
-- the whole migrations/ tree:
--   - public.number_sources already carries an 'MS' row (owner_module
--     'Operations', code means "Meeting"), still unused and left
--     byte-identical here. Its sibling 'EV' row (code means "Evaluation")
--     was originally seeded with owner_module 'Operations' too, but migration
--     202608060053 already reassigned it to owner_module 'Workflow Engine'
--     before this file runs — so by the time this migration applies, only
--     'MS' still legitimately carries owner_module 'Operations'. Neither is
--     reused here regardless: 'MS' would mislabel every generated number for
--     this module's header table (an operation is not a meeting). 'OP' is a
--     brand-new code registered in section 5 below, confirmed not to collide
--     with any of the fifteen other codes already in that catalogue
--     (TA/AS/WO/TR/CT/ID/IN/MS/PO/IV/CO/RF/AU/EV/ST, plus Safety
--     Management's own PI/FV).
--   - public.platform_modules' real display_order ledger, re-walked in full
--     rather than trusted from an earlier draft: EMPLOYEE_PORTAL 10 .. up to
--     180 for the foundation modules, DIGITAL_IDENTITY 165, ASSETS 190 (an
--     earlier planning draft assumed 190 too, and that IS the live value —
--     ASSETS was originally seeded at 170 by 202608060054, which collided
--     with the pre-existing PUBLIC_API row also at 170 from 202608040012,
--     and 202608060055's own closing-audit migration corrected ASSETS to
--     190 to resolve that collision), SAFETY 195. 200 is confirmed free and
--     is what this migration uses.
--   - No Operations table, RPC, permission or screen existed anywhere in the
--     migration chain, src/, or docs/ before this file.
-- The schema/RPC design below was handed down complete from that discovery
-- pass and is implemented exactly, using Safety Management (202608070056) as
-- the structural precedent throughout — same table shape, same
-- RESTRICTIVE-tenant-isolation + PERMISSIVE-read policy pairing, same "no
-- direct write policy, RPCs only" rule, same composite (tenant_id, x_id)
-- foreign keys, same SECURITY DEFINER RPC contract, same
-- apply_row_defaults()/write_audit_log() trigger pair on every new table.
--
-- WHAT THIS MODULE IS: a field-work tracking module for "نطاق عمل" (an
-- Operation) — a scope of work at a customer/site, worked by an assigned
-- team over time, narrated by a dated execution log ("سجل التنفيذ") of what
-- was actually done on each visit. Six tables:
--   - public.operations              — the header (customer, site, dates,
--     status lifecycle Draft/Active/OnHold/Completed/Cancelled).
--   - public.operations_team_members — flat membership (no per-member role;
--     per-visit attribution is already captured by created_by/employee_id on
--     each execution-log row, so a role column here would be redundant).
--   - public.operations_execution_logs — the core write: one row per visit,
--     with real typed columns (times, completion %, headcount) because the
--     dashboard needs to range-query and aggregate these, not just narrate
--     them — untyped jsonb inside activity_timeline would not support that.
--     One nullable FK column per linkable target (site/asset/employee/form),
--     never a generic entity_type+entity_id pair: every target here is a
--     known, FK-able table, and the codebase's own established pattern
--     (asset_transactions.related_form_id etc.) already reserves the generic
--     polymorphic shape exclusively for the two cross-cutting Platform-Core
--     services (attachments, activity_timeline) that must, by design, attach
--     to any table without schema knowledge.
--   - public.operations_checklist_items — a per-operation checklist; toggled
--     silently (see section 6's own note on operations_checklist_item_toggle)
--     so near-simultaneous taps during a visit don't flood the timeline.
--   - public.operations_templates / operations_template_checklist_items — a
--     reusable "shape" an operation can be created from
--     (operations_create_from_template, section 6), cloning only the
--     checklist; team assignment is deliberately never cloned (assigned per
--     instance via operations_team_set_members).
-- A thin operations_timeline() wrapper over public.activity_timeline (Safety
-- Management's own safety_timeline() shape, narrowed to this module's single
-- entity type 'Operation') carries only the coarse lifecycle narrative
-- (Created/Updated, StatusChanged, TeamUpdated, ExecutionLogAdded,
-- OperationCreatedFromTemplate) — it is supplementary to, never a substitute
-- for, operations_execution_logs_list(), which is the primary UI Timeline
-- data source for the Operation Detail screen.
--
-- Reused, not reimplemented (bbnovix_contract.md §12 / no-duplicate-service
-- rule) — confirmed by reading each dependency's own migration in full
-- before writing a line of this one:
--   - generate_number('OP', tenant)   registered in section 5 below, called
--     exactly once per operation header — never per execution-log row (this
--     module's execution logs get no independent number series at all, the
--     same "one number per real-world document, not per row" rule Assets
--     Management's and Safety Management's own headers already argued for).
--   - public.activity_timeline / record_activity()   operations_timeline()
--     is this module's own wider-audience wrapper, narrowed to a single
--     entity_type 'Operation' (unlike Safety Management's six-entity-type
--     generic wrapper, this module only ever narrates one kind of record).
--   - public.attachments / attachment_attach() / attachment_list() /
--     attachment_mark_for_removal()   for "صور التنفيذ" (photos) and
--     "مرفقات" (other files), both hung off operations_execution_logs.id as
--     their entity_id, distinguished only by entity_type
--     ('OperationExecutionPhoto' / 'OperationExecutionFile') — confirmed by
--     direct inspection that public.attachments carries no area/kind column
--     at all (that distinction is a client-side-only prop on
--     AttachmentsPanel.jsx affecting the upload storage PATH, never a
--     filterable database column), so two entity_types is the only
--     DB-level way to separate them. attachment_attach() is re-declared in
--     section 8 below (full body, same technique Assets Management and
--     Safety Management both used before it) reproducing every existing
--     branch — the 'Asset' branch (Assets Management's own addition) and
--     all three Safety Management branches ('SafetyPpeType',
--     'SafetyIssuance', 'SafetyFieldVisitCheck') — byte-identical, adding
--     exactly two new narrowing branches for this module's two entity types.
--     attachment_list()/attachment_mark_for_removal() are already generic
--     (they authorize purely against the storage object / attachment row
--     itself, not the parent entity) and are not touched here.
--   - public.notify()   category 'System' throughout — a team-assignment
--     notification when a new member is added by operations_team_set_members
--     (section 6), no new category.
--   - public.has_permission() / public.record_activity() / public.assets /
--     public.users / public.sites / public.forms / public.tenants   same
--     contract as every prior Update-4 module. operations_execution_logs'
--     composite FK to public.forms (tenant_id, form_id) targets
--     uq_forms_tenant_id (202608040012), the exact same target Assets
--     Management's own asset_transactions.related_form_id FK and Workflow
--     Engine Hardening's own composite form FKs already use — re-confirmed
--     by direct grep of the migrations/ tree before writing this file (not
--     assumed): public.forms does carry tenant_id (added by
--     202608040012_multitenant_foundation.sql after its own original
--     202607280001 declaration, which had none) and does carry that unique
--     index, so this composite FK is valid against the real current schema.
--
-- Two resolved design/schema contradictions (documented explicitly here, per
-- this codebase's own "never silently" rule — see Safety Management's own
-- header for the precedent this follows):
--   1. The handed-down RPC signature for operations_create_from_template
--      listed p_start_date (no default) AFTER three parameters that do carry
--      a default (p_name_en/p_site_id/p_customer_name) — invalid Postgres
--      function syntax (every parameter after the first defaulted one must
--      also default). Resolved by reordering p_start_date immediately after
--      p_name_ar, before the three defaulted overrides; the parameter NAMES,
--      types and defaults are otherwise exactly as handed down. Call sites
--      must pass named arguments or the corrected positional order.
--   2. The handed-down description of operations_team_set_members says both
--      "soft-delete rows not in the array, insert new ones" AND "mirror
--      asset_custody_unit_set_members()'s exact shape" (202608060054) — but
--      that cited precedent, checked in full before writing this migration,
--      performs a literal hard `delete from ... where custody_unit_id = ...`
--      on its own table (public.asset_custody_unit_members), DESPITE that
--      table itself carrying the same is_deleted/deleted_by/deleted_date
--      soft-delete columns every table in this codebase gets — a pre-existing
--      inconsistency in that precedent, not touched here. Resolved by
--      following the explicit, specific instruction ("soft-delete") over the
--      generic "mirror its exact shape" phrase: operations_team_set_members
--      below borrows only the general "one atomic full-replace" STRUCTURE
--      from asset_custody_unit_set_members() (a single RPC call replaces the
--      whole membership list), while actually honoring
--      operations_team_members' own is_deleted column and its own
--      "where not is_deleted" partial unique index, exactly as this
--      migration's own table design (section 2.2) requires.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Permission catalogue
-- ----------------------------------------------------------------------------
insert into public.permissions (code, module, description) values
  ('Operations.Manage', 'Operations', 'Manage operations, status transitions, team assignment, checklist definitions and templates'),
  ('Operations.Execute', 'Operations', 'Add execution records and toggle checklist items on operations the caller is assigned to'),
  ('Operations.View', 'Operations', 'Tenant-wide read access to every operation and the Operations dashboard, regardless of team membership')
on conflict (code) do update set module = excluded.module, description = excluded.description;

insert into public.role_permissions (tenant_id, role_id, permission_id)
select r.tenant_id, r.id, p.id
from public.roles r
join public.permissions p on p.code in (
  'Operations.Manage', 'Operations.Execute', 'Operations.View'
)
where r.code in ('PLATFORM_ADMIN', 'SYSTEM_ADMIN') and not r.is_deleted
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- 2. Tables — standard shape (tenant_id + audit/soft-delete/row_version
--    columns), same contract Safety Management's own header cites. Foreign
--    keys are a dedicated section (4) after every table exists.
-- ----------------------------------------------------------------------------

-- 2.1 operations — the header ("نطاق العمل"). Table is bare 'operations'
--     (matches Assets Management's own bare 'assets' precedent), not
--     'operations_operations'.
create table if not exists public.operations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  number text not null,
  name_ar text not null,
  name_en text,
  description_ar text,
  description_en text,
  -- Plain text, deliberately NO customer FK: no customer entity exists
  -- anywhere in this codebase (confirmed by direct research); inventing one
  -- here is explicitly out of scope (see section 10 of the design this
  -- migration implements).
  customer_name text,
  site_id uuid,
  start_date date not null,
  end_date date,
  status text not null default 'Draft'
    check (status in ('Draft', 'Active', 'OnHold', 'Completed', 'Cancelled')),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);
create index if not exists idx_operations_tenant on public.operations (tenant_id);
create index if not exists idx_operations_status on public.operations (tenant_id, status) where not is_deleted;
create index if not exists idx_operations_site on public.operations (tenant_id, site_id) where not is_deleted;
create unique index if not exists uq_operations_number
  on public.operations (tenant_id, number) where not is_deleted;
create unique index if not exists uq_operations_tenant_id on public.operations (tenant_id, id);

-- 2.2 operations_team_members — flat membership, no role_code column. This is
--     final and deliberate: the spec never asks for per-member roles, and
--     per-visit attribution is already captured by created_by/employee_id on
--     each operations_execution_logs row.
create table if not exists public.operations_team_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  operation_id uuid not null,
  user_id uuid not null,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);
create index if not exists idx_operations_team_members_tenant on public.operations_team_members (tenant_id);
create index if not exists idx_operations_team_members_operation
  on public.operations_team_members (tenant_id, operation_id) where not is_deleted;
create unique index if not exists uq_operations_team_members
  on public.operations_team_members (tenant_id, operation_id, user_id) where not is_deleted;

-- 2.3 operations_execution_logs — "سجل التنفيذ", the core write. One
--     nullable FK column per linkable target (site/asset/employee/form) —
--     the "Linked Records" requirement — never a generic entity_type/
--     entity_id pair (see this migration's own header for why).
create table if not exists public.operations_execution_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  operation_id uuid not null,
  log_date date not null,
  start_time time,
  end_time time,
  description text not null,
  completion_percent numeric(5,2)
    check (completion_percent is null or (completion_percent >= 0 and completion_percent <= 100)),
  headcount integer check (headcount is null or headcount >= 0),
  -- Free text, deliberately NOT gps/lat-lng — see this module's own scope
  -- decisions (section 10 of the design this migration implements).
  location_text text,
  site_id uuid,
  asset_id uuid,
  -- An employee this record CONCERNS — distinct from created_by, which is
  -- who logged it.
  employee_id uuid,
  form_id uuid,
  customer_name text,
  notes text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);
create index if not exists idx_operations_execution_logs_tenant on public.operations_execution_logs (tenant_id);
create index if not exists idx_operations_execution_logs_operation
  on public.operations_execution_logs (tenant_id, operation_id, log_date desc) where not is_deleted;
create index if not exists idx_operations_execution_logs_log_date
  on public.operations_execution_logs (tenant_id, log_date desc) where not is_deleted;
create index if not exists idx_operations_execution_logs_employee
  on public.operations_execution_logs (tenant_id, employee_id, log_date desc) where not is_deleted;
create index if not exists idx_operations_execution_logs_created_by
  on public.operations_execution_logs (tenant_id, created_by, log_date desc) where not is_deleted;
create unique index if not exists uq_operations_execution_logs_tenant_id
  on public.operations_execution_logs (tenant_id, id);

-- 2.4 operations_checklist_items
create table if not exists public.operations_checklist_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  operation_id uuid not null,
  title_ar text not null,
  title_en text,
  display_order integer not null default 0,
  is_done boolean not null default false,
  done_by uuid,
  done_on timestamptz,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);
create index if not exists idx_operations_checklist_items_tenant on public.operations_checklist_items (tenant_id);
create index if not exists idx_operations_checklist_items_operation
  on public.operations_checklist_items (tenant_id, operation_id, display_order) where not is_deleted;

-- 2.5 operations_templates — no dates, no team, no status: those are
--     per-instance only.
create table if not exists public.operations_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name_ar text not null,
  name_en text,
  description_ar text,
  description_en text,
  customer_name text,
  site_id uuid,
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
create index if not exists idx_operations_templates_tenant on public.operations_templates (tenant_id);
create index if not exists idx_operations_templates_active
  on public.operations_templates (tenant_id, is_active) where not is_deleted;
create unique index if not exists uq_operations_templates_tenant_id on public.operations_templates (tenant_id, id);

-- 2.6 operations_template_checklist_items
create table if not exists public.operations_template_checklist_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  template_id uuid not null,
  title_ar text not null,
  title_en text,
  display_order integer not null default 0,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);
create index if not exists idx_operations_tpl_checklist_items_tenant
  on public.operations_template_checklist_items (tenant_id);
create index if not exists idx_operations_tpl_checklist_items_template
  on public.operations_template_checklist_items (tenant_id, template_id, display_order) where not is_deleted;

-- ----------------------------------------------------------------------------
-- 3. Triggers (apply_row_defaults + write_audit_log) and RLS — one pass
--    across all 6 new tables, same idiom Safety Management's own migration
--    used (itself borrowed from multitenant_foundation's business_tables loop).
-- ----------------------------------------------------------------------------
do $$
declare
  tbl text;
  business_tables text[] := array[
    'operations', 'operations_team_members', 'operations_execution_logs',
    'operations_checklist_items', 'operations_templates', 'operations_template_checklist_items'
  ];
begin
  foreach tbl in array business_tables loop
    execute format('drop trigger if exists apply_row_defaults on public.%I', tbl);
    execute format(
      'create trigger apply_row_defaults before insert or update on public.%I
       for each row execute function public.apply_row_defaults()', tbl);

    execute format('drop trigger if exists audit_%s on public.%I', tbl, tbl);
    execute format(
      'create trigger audit_%s after insert or update or delete on public.%I
       for each row execute function public.write_audit_log()', tbl, tbl);

    execute format('alter table public.%I enable row level security', tbl);
    execute format('drop policy if exists "tenant isolation" on public.%I', tbl);
    execute format(
      'create policy "tenant isolation" on public.%I
         as restrictive for all to authenticated
         using (tenant_id = public.current_tenant_id())
         with check (tenant_id = public.current_tenant_id())', tbl);
  end loop;
end $$;

-- operations / operations_execution_logs / operations_checklist_items:
-- team-membership visibility IS directly enforceable via RLS — a tenant-wide
-- View/Manage holder sees everything, and any assigned team member sees the
-- operations (and their execution logs / checklist items) they are actually
-- on. No table gets a write policy: every write goes through the RPCs in
-- section 6, all SECURITY DEFINER, all revalidating the caller themselves.
drop policy if exists "members read operations" on public.operations;
create policy "members read operations" on public.operations
  for select to authenticated
  using (
    not is_deleted and (
      public.has_permission('Operations.View')
      or public.has_permission('Operations.Manage')
      or exists (
        select 1 from public.operations_team_members m
        where m.operation_id = operations.id
          and m.tenant_id = operations.tenant_id
          and m.user_id = auth.uid()
          and not m.is_deleted
      )
    )
  );

drop policy if exists "members read operations execution logs" on public.operations_execution_logs;
create policy "members read operations execution logs" on public.operations_execution_logs
  for select to authenticated
  using (
    not is_deleted and (
      public.has_permission('Operations.View')
      or public.has_permission('Operations.Manage')
      or exists (
        select 1 from public.operations_team_members m
        where m.operation_id = operations_execution_logs.operation_id
          and m.tenant_id = operations_execution_logs.tenant_id
          and m.user_id = auth.uid()
          and not m.is_deleted
      )
    )
  );

drop policy if exists "members read operations checklist items" on public.operations_checklist_items;
create policy "members read operations checklist items" on public.operations_checklist_items
  for select to authenticated
  using (
    not is_deleted and (
      public.has_permission('Operations.View')
      or public.has_permission('Operations.Manage')
      or exists (
        select 1 from public.operations_team_members m
        where m.operation_id = operations_checklist_items.operation_id
          and m.tenant_id = operations_checklist_items.tenant_id
          and m.user_id = auth.uid()
          and not m.is_deleted
      )
    )
  );

-- operations_templates / operations_team_members: simpler policy, no
-- membership carve-out — templates aren't per-team, and seeing a roster you
-- are already a member of is implied by seeing the parent operation via the
-- client's own join, not a separate RLS branch needed here.
drop policy if exists "members read operations templates" on public.operations_templates;
create policy "members read operations templates" on public.operations_templates
  for select to authenticated
  using (not is_deleted and (public.has_permission('Operations.View') or public.has_permission('Operations.Manage')));

-- Carries a self-row carve-out (user_id = auth.uid()), unlike the templates
-- policy above: the sibling SELECT policies on operations/
-- operations_execution_logs/operations_checklist_items each read this very
-- table via a nested exists() subquery to admit a plain assigned team
-- member. Postgres enforces RLS on that subquery too (against this table's
-- own policy, evaluated as the calling user — there is no SECURITY DEFINER
-- bypass inside a policy expression), so without this carve-out a caller
-- holding only Operations.Execute could never see their own membership row,
-- which means the exists() checks on those sibling tables always evaluate
-- to false for exactly the audience they're meant to admit, and those
-- tables return zero rows for a plain team member. The carve-out closes
-- that trap while still only ever exposing a user their own row (or
-- everything, to a View/Manage holder).
drop policy if exists "members read operations team members" on public.operations_team_members;
create policy "members read operations team members" on public.operations_team_members
  for select to authenticated
  using (
    not is_deleted and (
      public.has_permission('Operations.View')
      or public.has_permission('Operations.Manage')
      or user_id = auth.uid()
    )
  );

-- operations_template_checklist_items: extends the templates policy above to
-- their own child table, same reasoning Safety Management's own "members
-- read ppe set items" policy already established alongside "members read
-- ppe sets".
drop policy if exists "members read operations template checklist items" on public.operations_template_checklist_items;
create policy "members read operations template checklist items" on public.operations_template_checklist_items
  for select to authenticated
  using (not is_deleted and (public.has_permission('Operations.View') or public.has_permission('Operations.Manage')));

-- ----------------------------------------------------------------------------
-- 4. Cross-tenant relationship guards — composite foreign keys everywhere,
--    same idiom as multitenant_foundation.sql section 8 / Assets Management
--    section 4 / Safety Management section 4.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_operations_site_same_tenant') then
    alter table public.operations
      add constraint fk_operations_site_same_tenant
      foreign key (tenant_id, site_id) references public.sites (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_operations_team_members_operation_same_tenant') then
    alter table public.operations_team_members
      add constraint fk_operations_team_members_operation_same_tenant
      foreign key (tenant_id, operation_id) references public.operations (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_operations_team_members_user_same_tenant') then
    alter table public.operations_team_members
      add constraint fk_operations_team_members_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_operations_execution_logs_operation_same_tenant') then
    alter table public.operations_execution_logs
      add constraint fk_operations_execution_logs_operation_same_tenant
      foreign key (tenant_id, operation_id) references public.operations (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_operations_execution_logs_site_same_tenant') then
    alter table public.operations_execution_logs
      add constraint fk_operations_execution_logs_site_same_tenant
      foreign key (tenant_id, site_id) references public.sites (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_operations_execution_logs_asset_same_tenant') then
    alter table public.operations_execution_logs
      add constraint fk_operations_execution_logs_asset_same_tenant
      foreign key (tenant_id, asset_id) references public.assets (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_operations_execution_logs_employee_same_tenant') then
    alter table public.operations_execution_logs
      add constraint fk_operations_execution_logs_employee_same_tenant
      foreign key (tenant_id, employee_id) references public.users (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_operations_execution_logs_form_same_tenant') then
    alter table public.operations_execution_logs
      add constraint fk_operations_execution_logs_form_same_tenant
      foreign key (tenant_id, form_id) references public.forms (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_operations_checklist_items_operation_same_tenant') then
    alter table public.operations_checklist_items
      add constraint fk_operations_checklist_items_operation_same_tenant
      foreign key (tenant_id, operation_id) references public.operations (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_operations_checklist_items_done_by_same_tenant') then
    alter table public.operations_checklist_items
      add constraint fk_operations_checklist_items_done_by_same_tenant
      foreign key (tenant_id, done_by) references public.users (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_operations_templates_site_same_tenant') then
    alter table public.operations_templates
      add constraint fk_operations_templates_site_same_tenant
      foreign key (tenant_id, site_id) references public.sites (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_operations_tpl_checklist_items_template_same_tenant') then
    alter table public.operations_template_checklist_items
      add constraint fk_operations_tpl_checklist_items_template_same_tenant
      foreign key (tenant_id, template_id) references public.operations_templates (tenant_id, id) on delete cascade;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 5. Number Generator catalogue — this module's one reserved code. Confirmed
--    via grep of the whole migrations/ tree before writing this: 'MS'
--    (Meeting) still carries owner_module 'Operations' (migration
--    202608050039) and is untouched here; its sibling 'EV' (Evaluation) was
--    reassigned to owner_module 'Workflow Engine' by migration 202608060053
--    before this file runs and is likewise untouched here. Neither means
--    "Operation" and reusing either would mislabel every generated number
--    this module issues; 'OP' is new and does not collide with any of the
--    fifteen other codes already in that table (including Safety
--    Management's own PI/FV).
-- ----------------------------------------------------------------------------
insert into public.number_sources (code, label_ar, label_en, owner_module) values
  ('OP', 'نطاق عمل', 'Operation', 'Operations')
on conflict (code) do nothing;

-- ----------------------------------------------------------------------------
-- 6. RPCs
-- ----------------------------------------------------------------------------

-- 6.1 operations_upsert
create or replace function public.operations_upsert(
  p_id uuid, p_name_ar text, p_name_en text, p_description_ar text, p_description_en text,
  p_customer_name text, p_site_id uuid, p_start_date date, p_end_date date
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id uuid;
  v_number text;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Operations.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if p_name_ar is null or trim(p_name_ar) = '' then raise exception 'NAME_AR_REQUIRED'; end if;
  if p_start_date is null then raise exception 'START_DATE_REQUIRED'; end if;
  if p_end_date is not null and p_end_date < p_start_date then raise exception 'INVALID_DATE_RANGE'; end if;
  if p_site_id is not null and not exists (
    select 1 from public.sites where id = p_site_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'SITE_NOT_FOUND';
  end if;

  if p_id is null then
    v_number := public.generate_number('OP', v_tenant);
    insert into public.operations (
      tenant_id, number, name_ar, name_en, description_ar, description_en,
      customer_name, site_id, start_date, end_date, status
    ) values (
      v_tenant, v_number, trim(p_name_ar), nullif(trim(p_name_en), ''), p_description_ar, p_description_en,
      nullif(trim(p_customer_name), ''), p_site_id, p_start_date, p_end_date, 'Draft'
    ) returning id into v_id;
  else
    update public.operations set
      name_ar = trim(p_name_ar),
      name_en = nullif(trim(p_name_en), ''),
      description_ar = p_description_ar,
      description_en = p_description_en,
      customer_name = nullif(trim(p_customer_name), ''),
      site_id = p_site_id,
      start_date = p_start_date,
      end_date = p_end_date
    where id = p_id and tenant_id = v_tenant and not is_deleted
    returning id into v_id;
    if v_id is null then raise exception 'OPERATION_NOT_FOUND'; end if;
  end if;

  perform public.record_activity('Operation', v_id, case when p_id is null then 'Created' else 'Updated' end,
    case when p_id is null then 'تم إنشاء نطاق عمل' else 'تم تحديث نطاق العمل' end,
    case when p_id is null then 'Operation created' else 'Operation updated' end,
    jsonb_build_object('nameAr', trim(p_name_ar), 'startDate', p_start_date, 'endDate', p_end_date));

  return v_id;
end;
$$;
revoke all on function public.operations_upsert(uuid, text, text, text, text, text, uuid, date, date) from public;
grant execute on function public.operations_upsert(uuid, text, text, text, text, text, uuid, date, date) to authenticated;

comment on function public.operations_upsert(uuid, text, text, text, text, text, uuid, date, date) is
  'Creates or updates an operation header. Create assigns a fresh generate_number(''OP'') '
  'reference and starts status at Draft (status is never set here afterwards — use '
  'operations_set_status). Authentication: authenticated. Authorization: Operations.Manage. '
  'Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, NAME_AR_REQUIRED, START_DATE_REQUIRED, '
  'INVALID_DATE_RANGE, SITE_NOT_FOUND, OPERATION_NOT_FOUND.';

-- 6.2 operations_set_status — fixed transition map; StatusChanged is the one
--     event_code this writes (including the transition to Completed) —
--     narrating "an operation reached Completed" is the same shape of event
--     as narrating any other status change, distinguished by payload.status,
--     not by a second event_code.
create or replace function public.operations_set_status(p_operation_id uuid, p_status text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_op public.operations%rowtype;
  v_allowed text[];
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Operations.Manage') then raise exception 'PERMISSION_DENIED'; end if;

  select * into v_op from public.operations
  where id = p_operation_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'OPERATION_NOT_FOUND'; end if;

  v_allowed := case v_op.status
    when 'Draft' then array['Active', 'Cancelled']
    when 'Active' then array['OnHold', 'Completed', 'Cancelled']
    when 'OnHold' then array['Active', 'Cancelled']
    else array[]::text[]
  end;

  if p_status is null or not (p_status = any (v_allowed)) then
    raise exception 'INVALID_STATUS_TRANSITION';
  end if;

  update public.operations set status = p_status where id = p_operation_id;

  perform public.record_activity('Operation', p_operation_id, 'StatusChanged',
    'تغيرت حالة نطاق العمل إلى ' || p_status, 'Operation status changed to ' || p_status,
    jsonb_build_object('previousStatus', v_op.status, 'status', p_status));
end;
$$;
revoke all on function public.operations_set_status(uuid, text) from public;
grant execute on function public.operations_set_status(uuid, text) to authenticated;

comment on function public.operations_set_status(uuid, text) is
  'Validates and applies a status transition against a fixed map: Draft->Active|Cancelled, '
  'Active->OnHold|Completed|Cancelled, OnHold->Active|Cancelled; Completed/Cancelled are '
  'terminal. Authentication: authenticated. Authorization: Operations.Manage. Expected errors: '
  'NO_ACTIVE_TENANT, PERMISSION_DENIED, OPERATION_NOT_FOUND, INVALID_STATUS_TRANSITION.';

-- 6.3 operations_team_set_members — full-replace, honoring this table's own
--     soft-delete columns (see this migration's own header, resolution #2,
--     for why this does NOT literally copy asset_custody_unit_set_members()'s
--     hard-delete body). Notifies each newly-added member.
create or replace function public.operations_team_set_members(p_operation_id uuid, p_user_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_ids uuid[];
  v_new_user_ids uuid[];
  v_new_user_id uuid;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Operations.Manage') then raise exception 'PERMISSION_DENIED'; end if;

  if not exists (
    select 1 from public.operations where id = p_operation_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'OPERATION_NOT_FOUND';
  end if;

  select coalesce(array_agg(distinct u), '{}'::uuid[]) into v_ids
  from unnest(coalesce(p_user_ids, '{}'::uuid[])) as u
  where u is not null;

  if exists (
    select 1 from unnest(v_ids) as uid
    left join public.users usr on usr.id = uid and usr.tenant_id = v_tenant and not usr.is_deleted
    where usr.id is null
  ) then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- Soft-delete every currently-active member not present in the new array.
  update public.operations_team_members set
    is_deleted = true, deleted_by = auth.uid(), deleted_date = now()
  where operation_id = p_operation_id and tenant_id = v_tenant and not is_deleted
    and not (user_id = any (v_ids));

  -- Insert only users who are not already an active member (a previously
  -- removed-and-re-added user gets a fresh row; the old soft-deleted row is
  -- left in place as history, same as every other soft-delete table here) —
  -- as one set-based INSERT ... SELECT (mirrors
  -- asset_custody_unit_set_members()'s own batch-insert shape, per this
  -- migration's own header), not a per-row loop. Notification is inherently
  -- per-recipient, so only that part stays a loop, over the ids the INSERT
  -- itself just returned.
  with inserted as (
    insert into public.operations_team_members (tenant_id, operation_id, user_id)
    select v_tenant, p_operation_id, uid
    from unnest(v_ids) as uid
    where not exists (
      select 1 from public.operations_team_members m
      where m.tenant_id = v_tenant and m.operation_id = p_operation_id and m.user_id = uid and not m.is_deleted
    )
    returning user_id
  )
  select array_agg(user_id) into v_new_user_ids from inserted;

  if v_new_user_ids is not null then
    foreach v_new_user_id in array v_new_user_ids loop
      perform public.notify(
        v_new_user_id, 'System', 'OPERATIONS_TEAM_ASSIGNED',
        'تم تعيينك ضمن فريق نطاق عمل', 'You were assigned to an operation''s team',
        'تم تعيينك ضمن فريق العمل لنطاق العمل.', 'You have been assigned to this operation''s team.',
        '/app/operations?operation=' || p_operation_id::text,
        jsonb_build_object('operationId', p_operation_id)
      );
    end loop;
  end if;

  perform public.record_activity('Operation', p_operation_id, 'TeamUpdated',
    'تم تحديث فريق نطاق العمل', 'Operation team updated',
    jsonb_build_object('memberCount', coalesce(array_length(v_ids, 1), 0)));
end;
$$;
revoke all on function public.operations_team_set_members(uuid, uuid[]) from public;
grant execute on function public.operations_team_set_members(uuid, uuid[]) to authenticated;

comment on function public.operations_team_set_members(uuid, uuid[]) is
  'Replaces an operation''s full team-member list atomically: soft-deletes any currently-'
  'active member not present in p_user_ids, inserts (and notifies, category System) any '
  'user in p_user_ids not already an active member. Authentication: authenticated. '
  'Authorization: Operations.Manage. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, '
  'OPERATION_NOT_FOUND, USER_NOT_FOUND.';

-- 6.4 operations_checklist_item_upsert — no record_activity call: checklist
--     item DEFINITION changes are not one of the five coarse lifecycle events
--     operations_timeline() narrates (see this migration's own header,
--     "WHAT THIS MODULE IS"); the standard write_audit_log trigger already
--     captures the raw change. Same boundary as operations_checklist_item_
--     remove and _toggle below.
create or replace function public.operations_checklist_item_upsert(
  p_id uuid, p_operation_id uuid, p_title_ar text, p_title_en text, p_display_order integer
)
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
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Operations.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if p_title_ar is null or trim(p_title_ar) = '' then raise exception 'TITLE_AR_REQUIRED'; end if;

  if not exists (
    select 1 from public.operations where id = p_operation_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'OPERATION_NOT_FOUND';
  end if;

  if p_id is null then
    insert into public.operations_checklist_items (tenant_id, operation_id, title_ar, title_en, display_order)
    values (v_tenant, p_operation_id, trim(p_title_ar), nullif(trim(p_title_en), ''), coalesce(p_display_order, 0))
    returning id into v_id;
  else
    update public.operations_checklist_items set
      title_ar = trim(p_title_ar),
      title_en = nullif(trim(p_title_en), ''),
      display_order = coalesce(p_display_order, display_order)
    where id = p_id and operation_id = p_operation_id and tenant_id = v_tenant and not is_deleted
    returning id into v_id;
    if v_id is null then raise exception 'CHECKLIST_ITEM_NOT_FOUND'; end if;
  end if;

  return v_id;
end;
$$;
revoke all on function public.operations_checklist_item_upsert(uuid, uuid, text, text, integer) from public;
grant execute on function public.operations_checklist_item_upsert(uuid, uuid, text, text, integer) to authenticated;

comment on function public.operations_checklist_item_upsert(uuid, uuid, text, text, integer) is
  'Creates or updates one checklist item definition on an operation. Update requires the item '
  'to belong to the given p_operation_id. Authentication: authenticated. Authorization: '
  'Operations.Manage. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, TITLE_AR_REQUIRED, '
  'OPERATION_NOT_FOUND, CHECKLIST_ITEM_NOT_FOUND.';

-- 6.5 operations_checklist_item_remove — soft-delete.
create or replace function public.operations_checklist_item_remove(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id uuid;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Operations.Manage') then raise exception 'PERMISSION_DENIED'; end if;

  update public.operations_checklist_items set
    is_deleted = true, deleted_by = auth.uid(), deleted_date = now()
  where id = p_id and tenant_id = v_tenant and not is_deleted
  returning id into v_id;
  if v_id is null then raise exception 'CHECKLIST_ITEM_NOT_FOUND'; end if;
end;
$$;
revoke all on function public.operations_checklist_item_remove(uuid) from public;
grant execute on function public.operations_checklist_item_remove(uuid) to authenticated;

comment on function public.operations_checklist_item_remove(uuid) is
  'Soft-deletes one checklist item definition. Authentication: authenticated. Authorization: '
  'Operations.Manage. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, '
  'CHECKLIST_ITEM_NOT_FOUND.';

-- 6.6 operations_checklist_item_toggle — silent field update (is_done/
--     done_by/done_on), deliberately never pushed into record_activity()/
--     activity_timeline: toggling happens near-simultaneously, multiple
--     times per visit, and would flood the narrative feed. The standard
--     write_audit_log trigger already captures the raw change.
create or replace function public.operations_checklist_item_toggle(p_id uuid, p_is_done boolean)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_item public.operations_checklist_items%rowtype;
  v_authorized boolean;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  select * into v_item from public.operations_checklist_items
  where id = p_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'CHECKLIST_ITEM_NOT_FOUND'; end if;

  v_authorized := public.has_permission('Operations.Manage')
    or (
      public.has_permission('Operations.Execute')
      and exists (
        select 1 from public.operations_team_members m
        where m.operation_id = v_item.operation_id and m.tenant_id = v_tenant
          and m.user_id = auth.uid() and not m.is_deleted
      )
    );
  if not v_authorized then raise exception 'PERMISSION_DENIED'; end if;

  update public.operations_checklist_items set
    is_done = coalesce(p_is_done, false),
    done_by = case when coalesce(p_is_done, false) then auth.uid() else null end,
    done_on = case when coalesce(p_is_done, false) then now() else null end
  where id = p_id;
end;
$$;
revoke all on function public.operations_checklist_item_toggle(uuid, boolean) from public;
grant execute on function public.operations_checklist_item_toggle(uuid, boolean) to authenticated;

comment on function public.operations_checklist_item_toggle(uuid, boolean) is
  'Toggles one checklist item''s is_done (and done_by/done_on) as a silent field update — never '
  'recorded on the Operation timeline (see this function''s own header note). Authentication: '
  'authenticated. Authorization: Operations.Manage, or an assigned team member of the item''s '
  'own operation holding Operations.Execute. Expected errors: NO_ACTIVE_TENANT, '
  'CHECKLIST_ITEM_NOT_FOUND, PERMISSION_DENIED.';

-- 6.7 operations_execution_log_create — the core write ("سجل التنفيذ"). An
--     asset_id reference here is a passive link, never a custody-touching
--     write (unlike Safety Management's own asset-tracked-issuance case), so
--     this deliberately does NOT require any Assets.* permission — only that
--     the referenced asset exists in this tenant.
create or replace function public.operations_execution_log_create(
  p_operation_id uuid, p_log_date date, p_start_time time, p_end_time time, p_description text,
  p_completion_percent numeric, p_headcount integer, p_location_text text, p_site_id uuid,
  p_asset_id uuid, p_employee_id uuid, p_form_id uuid, p_customer_name text, p_notes text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id uuid;
  v_authorized boolean;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  if not exists (
    select 1 from public.operations where id = p_operation_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'OPERATION_NOT_FOUND';
  end if;

  v_authorized := public.has_permission('Operations.Manage')
    or (
      public.has_permission('Operations.Execute')
      and exists (
        select 1 from public.operations_team_members m
        where m.operation_id = p_operation_id and m.tenant_id = v_tenant
          and m.user_id = auth.uid() and not m.is_deleted
      )
    );
  if not v_authorized then raise exception 'PERMISSION_DENIED'; end if;

  if p_description is null or trim(p_description) = '' then raise exception 'DESCRIPTION_REQUIRED'; end if;
  if p_completion_percent is not null and (p_completion_percent < 0 or p_completion_percent > 100) then
    raise exception 'INVALID_COMPLETION_PERCENT';
  end if;
  if p_headcount is not null and p_headcount < 0 then raise exception 'INVALID_HEADCOUNT'; end if;
  if p_log_date is null then raise exception 'LOG_DATE_REQUIRED'; end if;

  if p_site_id is not null and not exists (
    select 1 from public.sites where id = p_site_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'SITE_NOT_FOUND';
  end if;
  if p_asset_id is not null and not exists (
    select 1 from public.assets where id = p_asset_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'ASSET_NOT_FOUND';
  end if;
  if p_employee_id is not null and not exists (
    select 1 from public.users where id = p_employee_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'EMPLOYEE_NOT_FOUND';
  end if;
  if p_form_id is not null and not exists (
    select 1 from public.forms where id = p_form_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'FORM_NOT_FOUND';
  end if;

  insert into public.operations_execution_logs (
    tenant_id, operation_id, log_date, start_time, end_time, description, completion_percent,
    headcount, location_text, site_id, asset_id, employee_id, form_id, customer_name, notes
  ) values (
    v_tenant, p_operation_id, p_log_date, p_start_time, p_end_time, trim(p_description), p_completion_percent,
    p_headcount, p_location_text, p_site_id, p_asset_id, p_employee_id, p_form_id,
    nullif(trim(p_customer_name), ''), p_notes
  ) returning id into v_id;

  perform public.record_activity('Operation', p_operation_id, 'ExecutionLogAdded',
    'تمت إضافة سجل تنفيذ', 'Execution log added',
    jsonb_build_object('executionLogId', v_id, 'logDate', p_log_date));

  return v_id;
end;
$$;
revoke all on function public.operations_execution_log_create(
  uuid, date, time, time, text, numeric, integer, text, uuid, uuid, uuid, uuid, text, text
) from public;
grant execute on function public.operations_execution_log_create(
  uuid, date, time, time, text, numeric, integer, text, uuid, uuid, uuid, uuid, text, text
) to authenticated;

comment on function public.operations_execution_log_create(
  uuid, date, time, time, text, numeric, integer, text, uuid, uuid, uuid, uuid, text, text
) is
  'Adds one execution-log row ("سجل التنفيذ") to an operation — this module''s core write. '
  'p_asset_id/p_site_id/p_employee_id/p_form_id, when supplied, must each exist in this '
  'tenant; p_asset_id is a passive reference link only and requires no Assets.* permission '
  '(unlike Safety Management''s own asset-tracked-issuance case). Authentication: '
  'authenticated. Authorization: Operations.Manage, or an assigned team member of '
  'p_operation_id holding Operations.Execute. Expected errors: NO_ACTIVE_TENANT, '
  'OPERATION_NOT_FOUND, PERMISSION_DENIED, DESCRIPTION_REQUIRED, INVALID_COMPLETION_PERCENT, '
  'INVALID_HEADCOUNT, LOG_DATE_REQUIRED, SITE_NOT_FOUND, ASSET_NOT_FOUND, EMPLOYEE_NOT_FOUND, '
  'FORM_NOT_FOUND.';

-- 6.8 operations_execution_logs_list — wider-audience READ wrapper (SECURITY
--     DEFINER bypasses RLS, so the membership-or-permission check below is
--     the real authorization boundary — same technique safety_timeline()/
--     asset_timeline() already use). This is the PRIMARY UI Timeline data
--     source for the Operation Detail screen; operations_timeline() (6.9) is
--     supplementary, not a substitute for this.
create or replace function public.operations_execution_logs_list(p_operation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_authorized boolean;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  if not exists (
    select 1 from public.operations where id = p_operation_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'OPERATION_NOT_FOUND';
  end if;

  v_authorized := public.has_permission('Operations.View')
    or public.has_permission('Operations.Manage')
    or exists (
      select 1 from public.operations_team_members m
      where m.operation_id = p_operation_id and m.tenant_id = v_tenant
        and m.user_id = auth.uid() and not m.is_deleted
    );
  if not v_authorized then raise exception 'PERMISSION_DENIED'; end if;

  return coalesce((
    select jsonb_agg(row_to_json(r) order by r.log_date desc, r.created_on desc)
    from (
      select
        el.id, el.operation_id, el.log_date, el.start_time, el.end_time, el.description,
        el.completion_percent, el.headcount, el.location_text,
        el.site_id, s.name_ar as site_name_ar, s.name_en as site_name_en,
        el.asset_id, a.reference as asset_reference, a.name_ar as asset_name_ar, a.name_en as asset_name_en,
        el.employee_id, coalesce(emp.full_name, emp.name_ar, emp.name_en, emp.email) as employee_name,
        el.form_id, f.reference_no as form_reference_no,
        el.customer_name, el.notes,
        el.created_by, coalesce(cu.full_name, cu.name_ar, cu.name_en, cu.email) as created_by_name,
        el.created_on
      from public.operations_execution_logs el
      left join public.sites s on s.id = el.site_id and s.tenant_id = el.tenant_id
      left join public.assets a on a.id = el.asset_id and a.tenant_id = el.tenant_id
      left join public.users emp on emp.id = el.employee_id
      left join public.forms f on f.id = el.form_id and f.tenant_id = el.tenant_id
      left join public.users cu on cu.id = el.created_by
      where el.tenant_id = v_tenant and el.operation_id = p_operation_id and not el.is_deleted
    ) r
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.operations_execution_logs_list(uuid) from public;
grant execute on function public.operations_execution_logs_list(uuid) to authenticated;

comment on function public.operations_execution_logs_list(uuid) is
  'Every execution-log row for one operation, newest log_date first, with joined site/asset/'
  'employee/form/creator labels — the primary UI Timeline data source for the Operation Detail '
  'screen. SECURITY DEFINER bypasses table RLS, so this function reimplements the same '
  'membership-or-permission gate by hand. Authentication: authenticated. Authorization: '
  'Operations.View/Manage, or an assigned team member of p_operation_id. Expected errors: '
  'NO_ACTIVE_TENANT, OPERATION_NOT_FOUND, PERMISSION_DENIED.';

-- 6.9 operations_timeline — thin wrapper over public.activity_timeline,
--     entity_type 'Operation' only (mirrors safety_timeline()'s shape,
--     narrowed to this module's single entity type). Supplementary coarse-
--     event feed (Created/Updated, StatusChanged, TeamUpdated,
--     ExecutionLogAdded, OperationCreatedFromTemplate) — never a replacement
--     for operations_execution_logs_list() above.
create or replace function public.operations_timeline(p_operation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_authorized boolean;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  if not exists (
    select 1 from public.operations where id = p_operation_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'OPERATION_NOT_FOUND';
  end if;

  v_authorized := public.has_permission('Operations.View')
    or public.has_permission('Operations.Manage')
    or exists (
      select 1 from public.operations_team_members m
      where m.operation_id = p_operation_id and m.tenant_id = v_tenant
        and m.user_id = auth.uid() and not m.is_deleted
    );
  if not v_authorized then raise exception 'PERMISSION_DENIED'; end if;

  return coalesce((
    select jsonb_agg(row_to_json(r) order by r.occurred_on, r.created_on)
    from (
      select
        at.id, at.entity_type, at.entity_id, at.event_code, at.title_ar, at.title_en,
        at.actor_id, coalesce(u.full_name, u.name_ar, u.name_en, u.email) as actor_name,
        at.payload, at.occurred_on, at.created_on
      from public.activity_timeline at
      left join public.users u on u.id = at.actor_id
      where at.tenant_id = v_tenant
        and at.entity_type = 'Operation'
        and at.entity_id = p_operation_id
        and not at.is_deleted
    ) r
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.operations_timeline(uuid) from public;
grant execute on function public.operations_timeline(uuid) to authenticated;

comment on function public.operations_timeline(uuid) is
  'Wider-audience wrapper over public.activity_timeline for entity_type ''Operation'' only — '
  'the coarse lifecycle feed (Created/Updated, StatusChanged, TeamUpdated, ExecutionLogAdded, '
  'OperationCreatedFromTemplate), supplementary to operations_execution_logs_list(). '
  'SECURITY DEFINER bypasses table RLS, so this function reimplements the same '
  'membership-or-permission gate by hand, mirroring operations_execution_logs_list()''s own. '
  'Authentication: authenticated. Authorization: Operations.View/Manage, or an assigned team '
  'member of p_operation_id. Expected errors: NO_ACTIVE_TENANT, OPERATION_NOT_FOUND, '
  'PERMISSION_DENIED.';

-- 6.10 operations_templates_upsert
create or replace function public.operations_templates_upsert(
  p_id uuid, p_name_ar text, p_name_en text, p_description_ar text, p_description_en text,
  p_customer_name text, p_site_id uuid, p_is_active boolean
)
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
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Operations.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if p_name_ar is null or trim(p_name_ar) = '' then raise exception 'NAME_AR_REQUIRED'; end if;
  if p_site_id is not null and not exists (
    select 1 from public.sites where id = p_site_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'SITE_NOT_FOUND';
  end if;

  if p_id is null then
    insert into public.operations_templates (
      tenant_id, name_ar, name_en, description_ar, description_en, customer_name, site_id, is_active
    ) values (
      v_tenant, trim(p_name_ar), nullif(trim(p_name_en), ''), p_description_ar, p_description_en,
      nullif(trim(p_customer_name), ''), p_site_id, coalesce(p_is_active, true)
    ) returning id into v_id;
  else
    update public.operations_templates set
      name_ar = trim(p_name_ar),
      name_en = nullif(trim(p_name_en), ''),
      description_ar = p_description_ar,
      description_en = p_description_en,
      customer_name = nullif(trim(p_customer_name), ''),
      site_id = p_site_id,
      is_active = coalesce(p_is_active, is_active)
    where id = p_id and tenant_id = v_tenant and not is_deleted
    returning id into v_id;
    if v_id is null then raise exception 'TEMPLATE_NOT_FOUND'; end if;
  end if;

  return v_id;
end;
$$;
revoke all on function public.operations_templates_upsert(uuid, text, text, text, text, text, uuid, boolean) from public;
grant execute on function public.operations_templates_upsert(uuid, text, text, text, text, text, uuid, boolean) to authenticated;

comment on function public.operations_templates_upsert(uuid, text, text, text, text, text, uuid, boolean) is
  'Creates or updates an operation template header (its checklist item list is managed '
  'separately by operations_template_checklist_item_upsert/_remove). No record_activity call '
  '— templates are not narrated on any Operation''s own timeline. Authentication: '
  'authenticated. Authorization: Operations.Manage. Expected errors: NO_ACTIVE_TENANT, '
  'PERMISSION_DENIED, NAME_AR_REQUIRED, SITE_NOT_FOUND, TEMPLATE_NOT_FOUND.';

-- 6.11 operations_template_checklist_item_upsert
create or replace function public.operations_template_checklist_item_upsert(
  p_id uuid, p_template_id uuid, p_title_ar text, p_title_en text, p_display_order integer
)
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
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Operations.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if p_title_ar is null or trim(p_title_ar) = '' then raise exception 'TITLE_AR_REQUIRED'; end if;

  if not exists (
    select 1 from public.operations_templates where id = p_template_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'TEMPLATE_NOT_FOUND';
  end if;

  if p_id is null then
    insert into public.operations_template_checklist_items (tenant_id, template_id, title_ar, title_en, display_order)
    values (v_tenant, p_template_id, trim(p_title_ar), nullif(trim(p_title_en), ''), coalesce(p_display_order, 0))
    returning id into v_id;
  else
    update public.operations_template_checklist_items set
      title_ar = trim(p_title_ar),
      title_en = nullif(trim(p_title_en), ''),
      display_order = coalesce(p_display_order, display_order)
    where id = p_id and template_id = p_template_id and tenant_id = v_tenant and not is_deleted
    returning id into v_id;
    if v_id is null then raise exception 'TEMPLATE_ITEM_NOT_FOUND'; end if;
  end if;

  return v_id;
end;
$$;
revoke all on function public.operations_template_checklist_item_upsert(uuid, uuid, text, text, integer) from public;
grant execute on function public.operations_template_checklist_item_upsert(uuid, uuid, text, text, integer) to authenticated;

comment on function public.operations_template_checklist_item_upsert(uuid, uuid, text, text, integer) is
  'Creates or updates one checklist item definition on a template. Update requires the item to '
  'belong to the given p_template_id. Authentication: authenticated. Authorization: '
  'Operations.Manage. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, TITLE_AR_REQUIRED, '
  'TEMPLATE_NOT_FOUND, TEMPLATE_ITEM_NOT_FOUND.';

-- 6.12 operations_template_checklist_item_remove — soft-delete.
create or replace function public.operations_template_checklist_item_remove(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id uuid;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Operations.Manage') then raise exception 'PERMISSION_DENIED'; end if;

  update public.operations_template_checklist_items set
    is_deleted = true, deleted_by = auth.uid(), deleted_date = now()
  where id = p_id and tenant_id = v_tenant and not is_deleted
  returning id into v_id;
  if v_id is null then raise exception 'TEMPLATE_ITEM_NOT_FOUND'; end if;
end;
$$;
revoke all on function public.operations_template_checklist_item_remove(uuid) from public;
grant execute on function public.operations_template_checklist_item_remove(uuid) to authenticated;

comment on function public.operations_template_checklist_item_remove(uuid) is
  'Soft-deletes one template checklist item definition. Authentication: authenticated. '
  'Authorization: Operations.Manage. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, '
  'TEMPLATE_ITEM_NOT_FOUND.';

-- 6.13 operations_create_from_template — see this migration's own header,
--      resolution #1, for why p_start_date is positioned before the three
--      defaulted override parameters (p_name_en/p_site_id/p_customer_name)
--      rather than after them as originally handed down: Postgres requires
--      every parameter after the first one with a DEFAULT to also carry one,
--      and p_start_date has none. Every parameter NAME, TYPE and default
--      value is otherwise exactly as specified. Team assignment is NOT
--      cloned (set separately via operations_team_set_members).
create or replace function public.operations_create_from_template(
  p_template_id uuid,
  p_name_ar text,
  p_start_date date,
  p_name_en text default null,
  p_site_id uuid default null,
  p_customer_name text default null,
  p_end_date date default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_tpl public.operations_templates%rowtype;
  v_id uuid;
  v_number text;
  v_site_id uuid;
  v_customer_name text;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Operations.Manage') then raise exception 'PERMISSION_DENIED'; end if;

  select * into v_tpl from public.operations_templates
  where id = p_template_id and tenant_id = v_tenant and not is_deleted and is_active;
  if not found then raise exception 'TEMPLATE_NOT_FOUND'; end if;

  if p_name_ar is null or trim(p_name_ar) = '' then raise exception 'NAME_AR_REQUIRED'; end if;
  if p_start_date is null then raise exception 'START_DATE_REQUIRED'; end if;
  if p_end_date is not null and p_end_date < p_start_date then raise exception 'INVALID_DATE_RANGE'; end if;

  v_site_id := coalesce(p_site_id, v_tpl.site_id);
  v_customer_name := coalesce(nullif(trim(p_customer_name), ''), v_tpl.customer_name);

  if v_site_id is not null and not exists (
    select 1 from public.sites where id = v_site_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'SITE_NOT_FOUND';
  end if;

  v_number := public.generate_number('OP', v_tenant);

  insert into public.operations (
    tenant_id, number, name_ar, name_en, description_ar, description_en,
    customer_name, site_id, start_date, end_date, status
  ) values (
    v_tenant, v_number, trim(p_name_ar), nullif(trim(p_name_en), ''), v_tpl.description_ar, v_tpl.description_en,
    v_customer_name, v_site_id, p_start_date, p_end_date, 'Draft'
  ) returning id into v_id;

  insert into public.operations_checklist_items (tenant_id, operation_id, title_ar, title_en, display_order, is_done)
  select v_tenant, v_id, ti.title_ar, ti.title_en, ti.display_order, false
  from public.operations_template_checklist_items ti
  where ti.template_id = p_template_id and ti.tenant_id = v_tenant and not ti.is_deleted;

  perform public.record_activity('Operation', v_id, 'OperationCreatedFromTemplate',
    'تم إنشاء نطاق عمل من قالب', 'Operation created from template',
    jsonb_build_object('templateId', p_template_id, 'nameAr', trim(p_name_ar)));

  return v_id;
end;
$$;
revoke all on function public.operations_create_from_template(uuid, text, date, text, uuid, text, date) from public;
grant execute on function public.operations_create_from_template(uuid, text, date, text, uuid, text, date) to authenticated;

comment on function public.operations_create_from_template(uuid, text, date, text, uuid, text, date) is
  'Creates a new Draft operation from an active template: copies description from the '
  'template verbatim, and site/customer as defaults overridable by p_site_id/p_customer_name; '
  'clones every template checklist item (is_done reset to false). Team assignment is NOT '
  'cloned. Parameter order corrected from the originally-specified one — see this migration''s '
  'own header, resolution #1. Authentication: authenticated. Authorization: Operations.Manage. '
  'Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, TEMPLATE_NOT_FOUND, NAME_AR_REQUIRED, '
  'START_DATE_REQUIRED, INVALID_DATE_RANGE, SITE_NOT_FOUND.';

-- 6.14 operations_dashboard_summary — the Manager Dashboard screen's own
--      data source: ONE aggregate RPC, not several list-returning functions
--      the client composes (mirrors Safety Management's own
--      safety_compliance_summary() "one dashboard, one call, one consistent
--      snapshot" precedent). Both Operations.View and Operations.Manage are
--      tenant-wide read roles per this module's own permission table (only
--      a team member holding neither would need scoping, and they don't
--      get this RPC's gate at all) — every sub-query below is therefore a
--      plain tenant_id = v_tenant scope, no membership scoping needed.
create or replace function public.operations_dashboard_summary(p_stale_days integer default 3)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_stale_days integer := greatest(coalesce(p_stale_days, 3), 0);
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not (public.has_permission('Operations.View') or public.has_permission('Operations.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;

  return jsonb_build_object(
    'operationsCount', (
      select count(*) from public.operations where tenant_id = v_tenant and not is_deleted
    ),
    'activeCount', (
      select count(*) from public.operations where tenant_id = v_tenant and not is_deleted and status = 'Active'
    ),
    'completedCount', (
      select count(*) from public.operations where tenant_id = v_tenant and not is_deleted and status = 'Completed'
    ),
    'onHoldCount', (
      select count(*) from public.operations where tenant_id = v_tenant and not is_deleted and status = 'OnHold'
    ),
    'avgCompletionPercent', (
      select round(avg(el.completion_percent), 2)
      from public.operations_execution_logs el
      where el.tenant_id = v_tenant and not el.is_deleted and el.completion_percent is not null
    ),
    'latestRecords', coalesce((
      select jsonb_agg(row_to_json(r) order by r.log_date desc, r.created_on desc)
      from (
        select
          el.id, el.operation_id, o.number as operation_number, o.name_ar as operation_name_ar,
          o.name_en as operation_name_en, el.log_date, el.description, el.completion_percent,
          el.employee_id, coalesce(emp.full_name, emp.name_ar, emp.name_en, emp.email) as employee_name,
          el.created_by, coalesce(cu.full_name, cu.name_ar, cu.name_en, cu.email) as created_by_name,
          el.created_on
        from public.operations_execution_logs el
        join public.operations o on o.id = el.operation_id and o.tenant_id = el.tenant_id
        left join public.users emp on emp.id = el.employee_id
        left join public.users cu on cu.id = el.created_by
        where el.tenant_id = v_tenant and not el.is_deleted and not o.is_deleted
        order by el.log_date desc, el.created_on desc
        limit 10
      ) r
    ), '[]'::jsonb),
    'latestPhotos', coalesce((
      select jsonb_agg(row_to_json(r) order by r.created_on desc)
      from (
        select
          att.id, att.entity_id as execution_log_id, el.operation_id,
          o.number as operation_number, el.log_date,
          so.path, so.file_name, so.mime_type, so.file_size,
          att.created_by, coalesce(cu.full_name, cu.name_ar, cu.name_en, cu.email) as created_by_name,
          att.created_on
        from public.attachments att
        join public.operations_execution_logs el on el.id = att.entity_id and el.tenant_id = att.tenant_id
        join public.operations o on o.id = el.operation_id and o.tenant_id = el.tenant_id
        join public.storage_objects so on so.id = att.storage_object_id and so.tenant_id = att.tenant_id
        left join public.users cu on cu.id = att.created_by
        where att.tenant_id = v_tenant and att.entity_type = 'OperationExecutionPhoto'
          and not att.is_deleted and not el.is_deleted and not o.is_deleted and not so.is_deleted
        order by att.created_on desc
        limit 10
      ) r
    ), '[]'::jsonb),
    'mostActiveEmployees', coalesce((
      select jsonb_agg(row_to_json(r) order by r.log_count desc)
      from (
        select
          el.created_by as employee_id,
          coalesce(u.full_name, u.name_ar, u.name_en, u.email) as employee_name,
          count(*) as log_count
        from public.operations_execution_logs el
        left join public.users u on u.id = el.created_by
        where el.tenant_id = v_tenant and not el.is_deleted
          and el.created_by is not null
          and el.log_date >= current_date - 30
        group by el.created_by, u.full_name, u.name_ar, u.name_en, u.email
        order by count(*) desc
        limit 10
      ) r
    ), '[]'::jsonb),
    'staleOperations', coalesce((
      select jsonb_agg(row_to_json(r) order by r.last_log_date nulls first)
      from (
        select
          o.id, o.number, o.name_ar, o.name_en, o.status,
          max(el.log_date) as last_log_date
        from public.operations o
        left join public.operations_execution_logs el
          on el.operation_id = o.id and el.tenant_id = o.tenant_id and not el.is_deleted
        where o.tenant_id = v_tenant and not o.is_deleted and o.status = 'Active'
        group by o.id, o.number, o.name_ar, o.name_en, o.status
        having max(el.log_date) is null or max(el.log_date) < current_date - v_stale_days
      ) r
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.operations_dashboard_summary(integer) from public;
grant execute on function public.operations_dashboard_summary(integer) to authenticated;

comment on function public.operations_dashboard_summary(integer) is
  'Single aggregate snapshot for the Operations Manager Dashboard: operationsCount/activeCount/'
  'completedCount/onHoldCount, avgCompletionPercent, latestRecords (10 most recent execution '
  'logs), latestPhotos (10 most recent OperationExecutionPhoto attachments), '
  'mostActiveEmployees (top 10 by execution-log count in the trailing 30 days, by created_by), '
  'and staleOperations (Active operations with no execution log in more than p_stale_days '
  'days, default 3, including operations with zero logs at all). Both Operations.View and '
  'Operations.Manage are tenant-wide read roles, so no membership scoping is applied. '
  'Authentication: authenticated. Authorization: Operations.View or Operations.Manage. '
  'Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED.';

-- Supports operations_dashboard_summary()'s latestPhotos sub-query above:
-- idx_attachments_entity (202608050040) is (tenant_id, entity_type,
-- entity_id, display_order) and does not cover created_on, so a "newest N
-- attachments of one entity_type, tenant-wide" query — exactly what
-- latestPhotos runs — would otherwise re-scan and sort the tenant's entire
-- OperationExecutionPhoto history to return 10 rows. Operations is the
-- first module to need this access shape.
create index if not exists idx_attachments_type_created
  on public.attachments (tenant_id, entity_type, created_on desc) where not is_deleted;

-- 6.15 operations_execution_log_attachments_list — read wrapper closing the
--      gap attachment_list()'s own generic authorization leaves for this
--      module's two attachment entity types. attachment_list() only ever
--      admits the storage object's own uploader/owner or a Storage.Manage
--      holder (see this migration's own header) — completely unrelated to
--      Operations.* permissions or operations_team_members. Without this
--      wrapper, a photo/file one team member uploads to an execution log is
--      invisible to every other team member on the same operation, and to
--      an Operations.Manage holder who doesn't separately hold the
--      unrelated Storage.Manage permission. Mirrors
--      operations_execution_logs_list()'s own membership-or-permission gate
--      (SECURITY DEFINER bypasses table RLS, so this function reimplements
--      it by hand) and attachment_list()'s own row shape/signature
--      convention (p_entity_type, p_entity_id-equivalent).
create or replace function public.operations_execution_log_attachments_list(
  p_entity_type text, p_execution_log_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_log public.operations_execution_logs%rowtype;
  v_authorized boolean;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if p_entity_type not in ('OperationExecutionPhoto', 'OperationExecutionFile') then
    raise exception 'INVALID_ENTITY_TYPE';
  end if;

  select * into v_log from public.operations_execution_logs
  where id = p_execution_log_id and tenant_id = v_tenant and not is_deleted;
  if not found then raise exception 'EXECUTION_LOG_NOT_FOUND'; end if;

  v_authorized := public.has_permission('Operations.View')
    or public.has_permission('Operations.Manage')
    or exists (
      select 1 from public.operations_team_members m
      where m.operation_id = v_log.operation_id and m.tenant_id = v_tenant
        and m.user_id = auth.uid() and not m.is_deleted
    );
  if not v_authorized then raise exception 'PERMISSION_DENIED'; end if;

  return coalesce((
    select jsonb_agg(row_to_json(r) order by r.display_order, r.created_on)
    from (
      select
        a.id, a.storage_object_id, a.entity_type, a.entity_id, a.display_order,
        a.marked_for_removal, a.marked_for_removal_by, a.marked_for_removal_on,
        a.created_by, a.created_on,
        coalesce(u.full_name, u.name_ar, u.name_en, u.email) as created_by_name,
        o.layer, o.provider_code, o.bucket, o.path, o.file_name, o.mime_type, o.file_size,
        o.checksum, o.owner_id
      from public.attachments a
      join public.storage_objects o on o.id = a.storage_object_id and o.tenant_id = a.tenant_id
      left join public.users u on u.id = a.created_by
      where a.tenant_id = v_tenant
        and a.entity_type = p_entity_type
        and a.entity_id = p_execution_log_id
        and not a.is_deleted
        and not o.is_deleted
    ) r
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.operations_execution_log_attachments_list(text, uuid) from public;
grant execute on function public.operations_execution_log_attachments_list(text, uuid) to authenticated;

comment on function public.operations_execution_log_attachments_list(text, uuid) is
  'Lists every attachment of p_entity_type (''OperationExecutionPhoto'' or '
  '''OperationExecutionFile'') on one execution log, joined to its storage object — same row '
  'shape as attachment_list(). Closes the read-side gap attachment_list()''s own generic '
  'authorization (uploader/owner or Storage.Manage only) leaves for this module''s two '
  'attachment entity types. SECURITY DEFINER bypasses table RLS, so this function '
  'reimplements the same membership-or-permission gate operations_execution_logs_list() uses. '
  'Authentication: authenticated. Authorization: Operations.View/Manage, or an assigned team '
  'member of the log''s own operation. Expected errors: NO_ACTIVE_TENANT, INVALID_ENTITY_TYPE, '
  'EXECUTION_LOG_NOT_FOUND, PERMISSION_DENIED.';

-- Reused as-is, no re-declaration: attachment_list(), attachment_mark_for_removal()
-- (both already generic — they authorize purely against the storage object /
-- attachment row itself, never against the parent entity — the wrapper above
-- adds the missing per-operation authorization layer on top for this
-- module's two entity types), and notify() (already called above by
-- operations_team_set_members).

-- 6.16 operations_can_write — read-only predicate the Portal calls once per
--      opened operation to tell a genuinely write-capable caller apart from
--      one merely admitted by "members read operations" (section 3) via
--      Operations.View or team membership alone — neither of which, on its
--      own, clears operations_checklist_item_toggle() (6.6) / operations_
--      execution_log_create() (6.7)'s own v_authorized bar. Reuses that same
--      expression verbatim so the three can never drift apart. Closing-audit
--      finding: without this, OperationsPortal.jsx rendered live checklist
--      checkboxes and an Add Execution Log form for every operation it could
--      merely SEE, including for an Operations.View holder or a team member
--      never granted Operations.Execute — both of whom would have every
--      submission unconditionally rejected PERMISSION_DENIED by the two RPCs
--      above. STABLE (no write); unlike operations_execution_logs_list()/
--      operations_timeline() this returns a boolean rather than raising
--      PERMISSION_DENIED, because asking "can I write" is itself allowed for
--      anyone who can already see the operation — the answer, not the
--      asking, is what's gated.
create or replace function public.operations_can_write(p_operation_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  if not exists (
    select 1 from public.operations where id = p_operation_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'OPERATION_NOT_FOUND';
  end if;

  return public.has_permission('Operations.Manage')
    or (
      public.has_permission('Operations.Execute')
      and exists (
        select 1 from public.operations_team_members m
        where m.operation_id = p_operation_id and m.tenant_id = v_tenant
          and m.user_id = auth.uid() and not m.is_deleted
      )
    );
end;
$$;
revoke all on function public.operations_can_write(uuid) from public;
grant execute on function public.operations_can_write(uuid) to authenticated;

comment on function public.operations_can_write(uuid) is
  'Read-only predicate: true if the caller currently holds Operations.Manage, or holds '
  'Operations.Execute AND actual team membership of p_operation_id — the same v_authorized bar '
  'operations_checklist_item_toggle()/operations_execution_log_create() each enforce '
  'server-side, reused verbatim. Lets the Portal render live checklist/execution-log write '
  'controls only for callers who will actually pass those RPCs'' own check, instead of showing '
  'them to every caller "members read operations" (section 3) admits, which also includes '
  'Operations.View holders and team members without Operations.Execute. Authentication: '
  'authenticated. Authorization: any caller who can see the operation per this migration''s own '
  'read policy. Expected errors: NO_ACTIVE_TENANT, OPERATION_NOT_FOUND.';

-- ----------------------------------------------------------------------------
-- 7. Module registration + navigation (mirrors migration 202608070056's own
--    SAFETY registration exactly).
-- ----------------------------------------------------------------------------
-- display_order 200: re-walked the whole platform_modules ledger before
-- writing this (not trusted from an earlier draft) — 10 through 180 are the
-- foundation modules, 165 is DIGITAL_IDENTITY, 170 is ASSETS (an earlier
-- planning draft assumed 190; the live chain places it at 170 — see this
-- migration's own header), 195 is SAFETY. 200 is confirmed unused across the
-- whole platform_modules catalogue.
insert into public.platform_modules (code, name_ar, name_en, category, display_order, is_core)
values ('OPERATIONS', 'العمليات', 'Operations', 'Core', 200, false)
on conflict (code) do nothing;

update public.platform_licenses
set module_codes = array_append(module_codes, 'OPERATIONS')
where code = 'FREE' and not ('OPERATIONS' = any (module_codes));

insert into public.app_screens (code, module_code, area, group_code, name_ar, name_en, icon, route, display_order, min_role_rank)
values
  -- No permission code: visibility is enforced entirely by RLS/RPC
  -- membership (this module's own design decision — any tenant member may
  -- open the screen; what they see inside it is governed by
  -- operations_team_members / Operations.View / Operations.Manage).
  ('PORTAL_OPERATIONS', 'OPERATIONS', 'Portal', 'Workspace', 'عملياتي', 'My Operations', 'clipboard-list', 'operations', 210, 1),
  ('ADMIN_OPERATIONS_LIST', 'OPERATIONS', 'Admin', 'Operations', 'نطاقات العمل', 'Operations', 'clipboard-list', 'admin/operations', 10, 3),
  ('ADMIN_OPERATIONS_DASHBOARD', 'OPERATIONS', 'Admin', 'Operations', 'لوحة العمليات', 'Operations Dashboard', 'gauge', 'admin/operations-dashboard', 20, 3),
  ('ADMIN_OPERATIONS_TEMPLATES', 'OPERATIONS', 'Admin', 'Operations', 'قوالب العمليات', 'Operation Templates', 'copy', 'admin/operations-templates', 30, 3)
on conflict (code) do update set
  module_code = excluded.module_code, area = excluded.area, group_code = excluded.group_code,
  name_ar = excluded.name_ar, name_en = excluded.name_en, icon = excluded.icon,
  route = excluded.route, display_order = excluded.display_order, min_role_rank = excluded.min_role_rank,
  is_active = true, updated_on = now();

-- ----------------------------------------------------------------------------
-- 8. attachment_attach() hardening for this module's two attachable entity
--    types.
--
-- attachment_attach() (202608050040, already hardened for entity_type
-- = 'Asset' by 202608060054, then for 'SafetyPpeType'/'SafetyIssuance'/
-- 'SafetyFieldVisitCheck' by 202608070056) only ever checked the CALLER'S
-- relationship to the storage object — never the caller's relationship to
-- the entity being attached to, for any entity_type it doesn't explicitly
-- narrow. Without this section, any tenant member who has ever uploaded any
-- file could attach it to any OperationExecutionPhoto/OperationExecutionFile
-- row, with zero Operations permission and no relationship to it. This full
-- re-declaration adds two new narrowing branches, one per entity_type this
-- module owns; the pre-existing 'Asset' branch and all three Safety
-- Management branches, and every other line of the function, are reproduced
-- byte-identical. Placed in this migration (not any earlier one) because
-- this module's own tables don't exist until now.
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

  if p_entity_type = 'Asset' and not (
    public.has_permission('Assets.Manage')
    or public.has_permission('Assets.Operate')
    or public.has_permission('Assets.Maintain')
    or exists (
      select 1 from public.assets a
      where a.id = p_entity_id and a.tenant_id = v_tenant and a.current_custodian_user_id = auth.uid()
    )
    or exists (
      select 1 from public.asset_maintenance m
      where m.asset_id = p_entity_id and m.tenant_id = v_tenant and m.reported_by = auth.uid()
        and m.status not in ('Rejected', 'Closed') and not m.is_deleted
    )
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if p_entity_type = 'SafetyPpeType' and not public.has_permission('Safety.Manage') then
    raise exception 'PERMISSION_DENIED';
  end if;

  if p_entity_type = 'SafetyIssuance' and not (
    public.has_permission('Safety.Issue')
    or public.has_permission('Safety.Manage')
    or exists (
      select 1 from public.safety_issuances i
      where i.id = p_entity_id and i.tenant_id = v_tenant
        and (i.employee_id = auth.uid() or i.issued_by = auth.uid())
    )
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if p_entity_type = 'SafetyFieldVisitCheck' and not (
    public.has_permission('Safety.Inspect')
    or public.has_permission('Safety.Manage')
    or exists (
      select 1 from public.safety_field_visit_checks c
      join public.safety_field_visits fv on fv.id = c.visit_id and fv.tenant_id = c.tenant_id
      where c.id = p_entity_id and c.tenant_id = v_tenant
        and (c.checked_by = auth.uid() or fv.inspector_id = auth.uid())
    )
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  -- New: both of this module's attachable entity types share the identical
  -- authorization rule — an assigned team member of the parent execution
  -- log's own operation holding Operations.Execute, or any Operations.Manage
  -- holder.
  if p_entity_type in ('OperationExecutionPhoto', 'OperationExecutionFile') and not (
    public.has_permission('Operations.Manage')
    or (
      public.has_permission('Operations.Execute')
      and exists (
        select 1 from public.operations_execution_logs el
        join public.operations_team_members m on m.operation_id = el.operation_id and m.tenant_id = el.tenant_id
        where el.id = p_entity_id and el.tenant_id = v_tenant and not el.is_deleted
          and m.user_id = auth.uid() and not m.is_deleted
      )
    )
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

comment on function public.attachment_attach(uuid, text, uuid, integer) is
  'Attaches an already-uploaded storage object to an entity. Authentication: authenticated. '
  'Authorization: storage object owner/creator or Storage.Manage, PLUS a per-entity_type '
  'narrowing: for ''Asset'' — Assets.Manage/Operate/Maintain, the asset''s current custodian, '
  'or the reporter of an open maintenance case on it; for ''SafetyPpeType'' — Safety.Manage; '
  'for ''SafetyIssuance'' — Safety.Issue/Manage or the issuance''s own employee/issuer; for '
  '''SafetyFieldVisitCheck'' — Safety.Inspect/Manage or the check''s own checker/visit '
  'inspector; for ''OperationExecutionPhoto''/''OperationExecutionFile'' — Operations.Manage, '
  'or an assigned team member of the parent execution log''s own operation holding '
  'Operations.Execute. Every other entity_type keeps the original, unnarrowed owner/'
  'Storage.Manage-only check. Expected errors: NO_TENANT_CONTEXT, ENTITY_TYPE_REQUIRED, '
  'ENTITY_ID_REQUIRED, STORAGE_OBJECT_NOT_FOUND, PERMISSION_DENIED.';

-- ----------------------------------------------------------------------------
-- Mandatory closer: every migration batch ends with this, or a GRANT earlier
-- in the same file (or an earlier migration) re-materializes the function's
-- PUBLIC-execute footgun (see 202608050037's header for what that means).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
