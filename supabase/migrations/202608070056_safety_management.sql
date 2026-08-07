-- ============================================================================
-- 056 — Safety Management (PPE tracking)
--
-- Discovery (this session, no prior trust): zero existing code for this
-- module. FourthUpdate.md's own section for it was not available to this
-- migration session — only two pre-reserved facts were confirmed by direct
-- grep before a single line of schema was written:
--   - public.number_sources already carries an 'RF' row (Risk Form) with
--     owner_module = 'Safety' (migration 202608050039) — reserved, unused by
--     this migration, and left byte-identical. 'PI' (PPE Issuance) and 'FV'
--     (Field Visit) are new rows this migration adds under the same
--     owner_module, confirmed not to collide with any of the thirteen other
--     codes already in that catalogue.
--   - No PPE/Safety table, RPC, permission or screen existed anywhere in the
--     migration chain, src/, or docs/ before this file.
-- The schema/RPC design below was therefore built from scratch against this
-- module's own name ("Safety Management (PPE tracking)") and the concrete
-- implementation notes the orchestrating session supplied, using Assets
-- Management (202608060054) as the structural precedent throughout — same
-- table shape, same RESTRICTIVE-tenant-isolation + PERMISSIVE-read policy
-- pairing, same "no direct write policy, RPCs only" rule, same composite
-- (tenant_id, x_id) foreign keys, same SECURITY DEFINER RPC contract.
--
-- WHAT THIS MODULE IS: PPE (Personal Protective Equipment) is tracked two
-- ways, because it is genuinely two different kinds of thing:
--   - Durable, individually-serialled PPE (a specific safety harness, a fire
--     extinguisher) is ALREADY an asset once Assets Management exists —
--     public.assets already owns custody, transactions and the Timeline for
--     it. This module does not duplicate that; safety_asset_ext is a thin
--     1:1 extension row (expiry / inspection interval / condition) hung off
--     an EXISTING public.assets row, the same "extend, never duplicate"
--     relationship attachments has with storage_objects.
--   - Consumable/personal PPE (gloves, a pair of glasses, a disposable
--     respirator) is issued to a specific employee without ever becoming a
--     tracked asset: safety_issuances / safety_issuance_items are that
--     record, structurally the closest sibling to asset_maintenance
--     (an independent header+status lifecycle, reportable/actionable by more
--     than one role) per the orchestrating session's own note.
-- A third concept, safety_ppe_sets, answers "which PPE is REQUIRED for
-- whom" — a named bundle of PPE types bound to an audience (a position, a
-- department, a site...) through the platform's own Audience Engine
-- (202608040013), never a bespoke targeting table. That is why this
-- migration widens audience_rules.entity_type with 'SafetyPpeSet' and
-- audience_rule_terms.dimension with 'Position' (job role was the one
-- targeting dimension the engine did not yet have — every other module that
-- ever needed "by role" used the coarser 'Role' or 'Department' dimensions,
-- but "required PPE" is naturally a property of the POSITION a person holds,
-- not their department or their RBAC role).
-- A fourth concept, safety_field_visits / safety_field_visit_checks, is the
-- inspection side: a Safety.Inspect holder visits a site/project and records
-- one compliance check per employee found there, optionally naming which
-- PPE was missing.
--
-- Reused, not reimplemented (bbnovix_contract.md §12 / no-duplicate-service
-- rule) — confirmed by reading each dependency's own migration in full
-- before writing a line of this one:
--   - generate_number('PI'/'FV', tenant)   registered in section 5 below,
--     called exactly once per issuance header / per field-visit header —
--     never per line item, same "one number per real-world document, not
--     per row" rule Assets Management's own header already argued for AS/WO.
--   - public.activity_timeline / record_activity()   safety_timeline() is
--     this module's own wider-audience wrapper (Assets Management's own
--     documented pattern for asset_timeline()), generic across this
--     module's SIX entity types rather than Assets' single 'Asset' type,
--     since unlike Assets Management this module owns more than one kind of
--     record worth a history.
--   - public.attachments / attachment_attach() / attachment_mark_for_removal()
--     for the three entity types that actually carry file evidence:
--     'SafetyPpeType' (a spec sheet / certification), 'SafetyIssuance' (a
--     signed delivery receipt), 'SafetyFieldVisitCheck' (a non-compliance
--     photo). attachment_attach() is re-declared below (full body, same
--     technique Assets Management used) adding three new narrowing branches;
--     every existing branch, including Assets Management's own 'Asset'
--     branch, is reproduced byte-identical.
--   - public.audience_rules / audience_rule_terms / audience_matches() /
--     audience_save() / audience_describe() / audience_can_manage() for
--     "which employees does this PPE Set apply to". Checked, as instructed,
--     whether audience_save()/audience_describe()/audience_visible_ids() carry
--     entity_type-specific logic that also needed widening:
--       - audience_save() DOES: it hard-codes its own allowed entity_type
--         list AND its own allowed dimension list (independent of the table
--         CHECK constraints, checked before the insert ever reaches them) —
--         re-declared below, adding 'SafetyPpeSet' and 'Position' to those
--         two literal lists. Missing this would have made 'SafetyPpeSet'
--         rules technically insertable at the table level (once the CHECK
--         constraint was widened) but permanently unreachable through the
--         one RPC the frontend actually calls to write one.
--       - audience_describe()'s per-dimension CASE (for label_ar/label_en)
--         had no 'Position' arm — not a correctness bug (it falls back to
--         raw value_text, same as every other id-based dimension's own
--         fallback), but the picker would show a bare id-shaped string
--         instead of a name for a Position term. Re-declared to add the
--         same lookup every other id-based dimension already gets.
--       - audience_visible_ids(p_entity_type) is ALREADY generic for this:
--         it special-cases only 'Circular'/'Document'/'Design' and
--         'FormTemplate'; every other entity_type — 'SafetyPpeSet' included
--         — already falls through to its documented generic branch ("Modules
--         whose tables arrive later: answer from stored rules"). Confirmed
--         by reading its full body; NOT re-declared, and not touched.
--     audience_can_manage() also re-declared: it is the permission gate
--     behind BOTH of audience_rules' RLS policies, and had no Safety.Manage
--     arm — without this addition a Safety.Manage holder with no
--     Audience.Manage grant could create a PPE Set but could never bind an
--     audience to it.
--   - public.notify()   category 'System' throughout (every Safety
--     notification is informational, never an approve/reject action — this
--     module has no approval-chain step of its own). notify() itself already
--     tolerates the "no signed-in session" case explicitly for exactly the
--     reason safety_expiration_scan() (section 6.16) needs it: that function
--     is a service_role-only batch scan with no auth.uid() at all.
--   - public.has_permission() / public.record_activity()   same contract as
--     every prior Update-4 module.
--   - public.assets / public.users / public.positions / public.sites /
--     public.projects   safety_asset_ext hangs off public.assets by asset_id
--     (never a parallel asset table); every employee-facing table points at
--     public.users; safety_field_visits points at public.sites/public.projects
--     the same way asset_custody_units already does.
--
-- safety_expiration_scan() (section 6.16): per the orchestrating session's
-- own scope decision, this codebase has NO pg_cron job and NO scheduled edge
-- function anywhere (confirmed absent by the same grep sweep that found the
-- 'RF' number-source row) — wiring one is a deployment decision, explicitly
-- out of scope here, exactly like Assets Management's own PO/IV precedent.
-- The function itself is a complete, real implementation (walks
-- safety_asset_ext + safety_issuance_items, calls notify() once per affected
-- employee, de-duplicated against the last 7 days so a manual re-run or a
-- future once-a-day schedule doesn't re-spam the same person), granted to
-- service_role only, never to `authenticated` — the same trust boundary
-- record_activity() itself already uses.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Permission catalogue
-- ----------------------------------------------------------------------------
insert into public.permissions (code, module, description) values
  ('Safety.Manage', 'Safety', 'Manage the PPE catalogue, PPE sets and PPE safety-extension data on assets'),
  ('Safety.Issue', 'Safety', 'Issue PPE to employees and manage the lifecycle of what was issued'),
  ('Safety.Inspect', 'Safety', 'Run field visits, record PPE compliance checks, and inspect asset-tracked PPE'),
  ('Safety.View', 'Safety', 'View the PPE catalogue, issuances, field visits and safety reports')
on conflict (code) do update set module = excluded.module, description = excluded.description;

insert into public.role_permissions (tenant_id, role_id, permission_id)
select r.tenant_id, r.id, p.id
from public.roles r
join public.permissions p on p.code in (
  'Safety.Manage', 'Safety.Issue', 'Safety.Inspect', 'Safety.View'
)
where r.code in ('PLATFORM_ADMIN', 'SYSTEM_ADMIN') and not r.is_deleted
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- 2. Tables — standard shape (tenant_id + audit/soft-delete/row_version
--    columns), same contract Assets Management's own header cites. Foreign
--    keys are a dedicated section (4) after every table exists.
-- ----------------------------------------------------------------------------

-- 2.1 safety_ppe_types — the PPE catalogue (Helmet, Safety Glasses, Gloves...).
create table if not exists public.safety_ppe_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text,
  name_ar text not null,
  name_en text,
  -- Exactly the 8 categories the design calls for, plus 'Other' — never
  -- unconstrained free text.
  category text not null
    check (category in ('Head', 'Eye', 'Hand', 'Foot', 'Body', 'Respiratory', 'Hearing', 'Fire', 'Other')),
  description_ar text,
  description_en text,
  -- null = no fixed lifespan (inspected/reused rather than replaced on a
  -- schedule, e.g. a fire extinguisher tracked via safety_asset_ext instead).
  standard_lifespan_days integer check (standard_lifespan_days is null or standard_lifespan_days > 0),
  requires_size boolean not null default false,
  is_active boolean not null default true,
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
create index if not exists idx_safety_ppe_types_tenant on public.safety_ppe_types (tenant_id);
create unique index if not exists uq_safety_ppe_types_code
  on public.safety_ppe_types (tenant_id, lower(code)) where code is not null and not is_deleted;
create unique index if not exists uq_safety_ppe_types_tenant_id on public.safety_ppe_types (tenant_id, id);

-- 2.2 safety_ppe_sets — a named, required bundle of PPE types. "Who this
--     applies to" is answered by the Audience Engine (entity_type
--     'SafetyPpeSet', widened in section 6 below), never a column here.
create table if not exists public.safety_ppe_sets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text,
  name_ar text not null,
  name_en text,
  description_ar text,
  description_en text,
  is_active boolean not null default true,
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
create index if not exists idx_safety_ppe_sets_tenant on public.safety_ppe_sets (tenant_id);
create unique index if not exists uq_safety_ppe_sets_code
  on public.safety_ppe_sets (tenant_id, lower(code)) where code is not null and not is_deleted;
create unique index if not exists uq_safety_ppe_sets_tenant_id on public.safety_ppe_sets (tenant_id, id);

-- 2.3 safety_ppe_set_items — which PPE types (and how many) make up a set.
create table if not exists public.safety_ppe_set_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  set_id uuid not null,
  ppe_type_id uuid not null,
  quantity integer not null default 1 check (quantity > 0),
  reissue_interval_days integer check (reissue_interval_days is null or reissue_interval_days > 0),
  is_mandatory boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);
create index if not exists idx_safety_ppe_set_items_tenant on public.safety_ppe_set_items (tenant_id);
create index if not exists idx_safety_ppe_set_items_set on public.safety_ppe_set_items (tenant_id, set_id);
create unique index if not exists uq_safety_ppe_set_items
  on public.safety_ppe_set_items (tenant_id, set_id, ppe_type_id) where not is_deleted;

-- 2.4 safety_asset_ext — 1:1 safety extension over an EXISTING public.assets
--     row (never a parallel asset table). Only exists for PPE that is itself
--     asset-tracked (durable, individually custodied items).
create table if not exists public.safety_asset_ext (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  asset_id uuid not null,
  ppe_type_id uuid not null,
  expiry_date date,
  inspection_interval_days integer check (inspection_interval_days is null or inspection_interval_days > 0),
  last_inspection_date date,
  next_inspection_due date,
  condition_status text not null default 'Good'
    check (condition_status in ('Good', 'NeedsInspection', 'NeedsReplacement', 'Retired')),
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
create index if not exists idx_safety_asset_ext_tenant on public.safety_asset_ext (tenant_id);
create index if not exists idx_safety_asset_ext_ppe_type on public.safety_asset_ext (tenant_id, ppe_type_id);
create index if not exists idx_safety_asset_ext_expiry
  on public.safety_asset_ext (tenant_id, expiry_date) where not is_deleted and expiry_date is not null;
-- Non-tenant-leading twin of the index above: safety_expiration_scan() (7.16)
-- is a cross-tenant batch job with no tenant_id predicate at all, so a
-- (tenant_id, expiry_date) index can't support its range scan on expiry_date
-- (Postgres can't skip between tenant groups with tenant_id unconstrained).
-- This index exists only for that scan; the tenant-leading one above stays
-- for the interactive per-tenant screen.
create index if not exists idx_safety_asset_ext_expiry_global
  on public.safety_asset_ext (expiry_date) where not is_deleted and expiry_date is not null;
create index if not exists idx_safety_asset_ext_inspection_due
  on public.safety_asset_ext (tenant_id, next_inspection_due) where not is_deleted and next_inspection_due is not null;
-- One safety-extension row per asset; also the ON CONFLICT target for
-- safety_asset_ext_upsert()'s create-or-update shape.
create unique index if not exists uq_safety_asset_ext_asset
  on public.safety_asset_ext (tenant_id, asset_id) where not is_deleted;

-- 2.5 safety_issuances — header. Structural sibling of asset_maintenance per
--     the orchestrating session's own note: an independent status lifecycle,
--     reportable/actionable by more than the warehouse-keeper alone.
create table if not exists public.safety_issuances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  reference text not null,
  employee_id uuid not null,
  ppe_set_id uuid,
  status text not null default 'Issued'
    check (status in ('Issued', 'PartiallyReturned', 'Returned', 'Closed')),
  issued_by uuid not null default auth.uid(),
  issued_on timestamptz not null default now(),
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
create index if not exists idx_safety_issuances_tenant on public.safety_issuances (tenant_id);
create index if not exists idx_safety_issuances_employee on public.safety_issuances (tenant_id, employee_id);
create unique index if not exists uq_safety_issuances_reference
  on public.safety_issuances (tenant_id, reference) where not is_deleted;
create unique index if not exists uq_safety_issuances_tenant_id on public.safety_issuances (tenant_id, id);

-- 2.6 safety_issuance_items — per-item lifecycle. Never Replaced directly by
--     safety_issuance_item_update_status() — only safety_issuance_item_reissue()
--     ever writes that status, mirroring Assets Management's own
--     "Missing is only ever system-generated" precedent for a status value
--     that must never come straight from the generic transition entry point.
create table if not exists public.safety_issuance_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  issuance_id uuid not null,
  ppe_type_id uuid not null,
  -- Set only when this specific issued unit is ALSO an asset-tracked item
  -- (safety_asset_ext exists for it); null for ordinary consumable PPE.
  asset_id uuid,
  quantity integer not null default 1 check (quantity > 0),
  size text,
  issued_date date not null default current_date,
  expiry_date date,
  status text not null default 'Issued'
    check (status in ('Issued', 'Returned', 'Lost', 'Damaged', 'Expired', 'Replaced')),
  replaced_by_item_id uuid,
  returned_on timestamptz,
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
create index if not exists idx_safety_issuance_items_tenant on public.safety_issuance_items (tenant_id);
create index if not exists idx_safety_issuance_items_issuance on public.safety_issuance_items (tenant_id, issuance_id);
create index if not exists idx_safety_issuance_items_status on public.safety_issuance_items (tenant_id, status);
create index if not exists idx_safety_issuance_items_expiry
  on public.safety_issuance_items (tenant_id, expiry_date)
  where not is_deleted and expiry_date is not null and status = 'Issued';
-- Non-tenant-leading twin, same reasoning as idx_safety_asset_ext_expiry_global
-- above — exists only for safety_expiration_scan()'s cross-tenant loop.
create index if not exists idx_safety_issuance_items_expiry_global
  on public.safety_issuance_items (expiry_date)
  where not is_deleted and expiry_date is not null and status = 'Issued';
create unique index if not exists uq_safety_issuance_items_tenant_id on public.safety_issuance_items (tenant_id, id);

-- 2.7 safety_field_visits — header.
create table if not exists public.safety_field_visits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  reference text not null,
  site_id uuid,
  project_id uuid,
  inspector_id uuid not null default auth.uid(),
  visit_date date not null default current_date,
  status text not null default 'Draft' check (status in ('Draft', 'Completed')),
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
create index if not exists idx_safety_field_visits_tenant on public.safety_field_visits (tenant_id);
create index if not exists idx_safety_field_visits_inspector on public.safety_field_visits (tenant_id, inspector_id);
create unique index if not exists uq_safety_field_visits_reference
  on public.safety_field_visits (tenant_id, reference) where not is_deleted;
create unique index if not exists uq_safety_field_visits_tenant_id on public.safety_field_visits (tenant_id, id);

-- 2.8 safety_field_visit_checks — one row per employee checked during a visit.
create table if not exists public.safety_field_visit_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  visit_id uuid not null,
  employee_id uuid not null,
  is_compliant boolean not null default true,
  notes text,
  checked_by uuid not null default auth.uid(),
  checked_on timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);
create index if not exists idx_safety_field_visit_checks_tenant on public.safety_field_visit_checks (tenant_id);
create index if not exists idx_safety_field_visit_checks_visit on public.safety_field_visit_checks (tenant_id, visit_id);
create index if not exists idx_safety_field_visit_checks_employee on public.safety_field_visit_checks (tenant_id, employee_id);
create unique index if not exists uq_safety_field_visit_checks_tenant_id
  on public.safety_field_visit_checks (tenant_id, id);

-- 2.9 safety_field_visit_check_missing_items — which PPE types were missing
--     on a non-compliant check (many-to-many).
create table if not exists public.safety_field_visit_check_missing_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  check_id uuid not null,
  ppe_type_id uuid not null,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);
create index if not exists idx_safety_fvc_missing_items_tenant
  on public.safety_field_visit_check_missing_items (tenant_id);
create index if not exists idx_safety_fvc_missing_items_check
  on public.safety_field_visit_check_missing_items (tenant_id, check_id);
create unique index if not exists uq_safety_fvc_missing_items
  on public.safety_field_visit_check_missing_items (tenant_id, check_id, ppe_type_id) where not is_deleted;

-- ----------------------------------------------------------------------------
-- 3. Triggers (apply_row_defaults + write_audit_log) and RLS — one pass
--    across all 9 new tables, same idiom Assets Management's own migration
--    used (itself borrowed from multitenant_foundation's business_tables loop).
-- ----------------------------------------------------------------------------
do $$
declare
  tbl text;
  business_tables text[] := array[
    'safety_ppe_types', 'safety_ppe_sets', 'safety_ppe_set_items', 'safety_asset_ext',
    'safety_issuances', 'safety_issuance_items', 'safety_field_visits',
    'safety_field_visit_checks', 'safety_field_visit_check_missing_items'
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

-- Catalogue tables: broadly readable to any tenant member, same openness as
-- asset_groups/asset_custody_units — any employee needs to browse what PPE
-- exists and what a set requires. No write policy on any of these three
-- (or any table in this migration): every write goes through the RPCs in
-- section 6, all SECURITY DEFINER, all revalidating the caller themselves.
drop policy if exists "members read ppe types" on public.safety_ppe_types;
create policy "members read ppe types" on public.safety_ppe_types
  for select to authenticated using (not is_deleted);

drop policy if exists "members read ppe sets" on public.safety_ppe_sets;
create policy "members read ppe sets" on public.safety_ppe_sets
  for select to authenticated using (not is_deleted);

drop policy if exists "members read ppe set items" on public.safety_ppe_set_items;
create policy "members read ppe set items" on public.safety_ppe_set_items
  for select to authenticated using (not is_deleted);

-- safety_asset_ext: readable by the underlying asset's own current custodian,
-- or any Safety.* permission holder — narrower than the catalogue tables
-- because expiry/inspection data is operational, not a public catalogue.
drop policy if exists "members read safety asset ext" on public.safety_asset_ext;
create policy "members read safety asset ext" on public.safety_asset_ext
  for select to authenticated
  using (
    not is_deleted and (
      public.has_permission('Safety.View')
      or public.has_permission('Safety.Inspect')
      or public.has_permission('Safety.Manage')
      or exists (
        select 1 from public.assets a
        where a.id = safety_asset_ext.asset_id
          and a.tenant_id = safety_asset_ext.tenant_id
          and a.current_custodian_user_id = auth.uid()
      )
    )
  );

-- Transactional tables: readable by the employee it concerns, whoever
-- performed the action, or a Safety.* permission holder — the same "own row
-- or permitted" shape asset_maintenance/asset_transactions already use.
drop policy if exists "members read safety issuances" on public.safety_issuances;
create policy "members read safety issuances" on public.safety_issuances
  for select to authenticated
  using (
    not is_deleted and (
      employee_id = auth.uid()
      or issued_by = auth.uid()
      or public.has_permission('Safety.View')
      or public.has_permission('Safety.Issue')
      or public.has_permission('Safety.Manage')
    )
  );

drop policy if exists "members read safety issuance items" on public.safety_issuance_items;
create policy "members read safety issuance items" on public.safety_issuance_items
  for select to authenticated
  using (
    not is_deleted and (
      public.has_permission('Safety.View')
      or public.has_permission('Safety.Issue')
      or public.has_permission('Safety.Manage')
      or exists (
        select 1 from public.safety_issuances i
        where i.id = safety_issuance_items.issuance_id
          and i.tenant_id = safety_issuance_items.tenant_id
          and i.employee_id = auth.uid()
      )
    )
  );

drop policy if exists "members read field visits" on public.safety_field_visits;
create policy "members read field visits" on public.safety_field_visits
  for select to authenticated
  using (
    not is_deleted and (
      inspector_id = auth.uid()
      or public.has_permission('Safety.View')
      or public.has_permission('Safety.Inspect')
      or public.has_permission('Safety.Manage')
    )
  );

drop policy if exists "members read field visit checks" on public.safety_field_visit_checks;
create policy "members read field visit checks" on public.safety_field_visit_checks
  for select to authenticated
  using (
    not is_deleted and (
      employee_id = auth.uid()
      or checked_by = auth.uid()
      or public.has_permission('Safety.View')
      or public.has_permission('Safety.Inspect')
      or public.has_permission('Safety.Manage')
      or exists (
        select 1 from public.safety_field_visits v
        where v.id = safety_field_visit_checks.visit_id
          and v.tenant_id = safety_field_visit_checks.tenant_id
          and v.inspector_id = auth.uid()
      )
    )
  );

drop policy if exists "members read field visit missing items" on public.safety_field_visit_check_missing_items;
create policy "members read field visit missing items" on public.safety_field_visit_check_missing_items
  for select to authenticated
  using (
    not is_deleted and (
      public.has_permission('Safety.View')
      or public.has_permission('Safety.Inspect')
      or public.has_permission('Safety.Manage')
      or exists (
        select 1 from public.safety_field_visit_checks c
        join public.safety_field_visits v on v.id = c.visit_id and v.tenant_id = c.tenant_id
        where c.id = safety_field_visit_check_missing_items.check_id
          and c.tenant_id = safety_field_visit_check_missing_items.tenant_id
          and (c.employee_id = auth.uid() or c.checked_by = auth.uid() or v.inspector_id = auth.uid())
      )
    )
  );

-- ----------------------------------------------------------------------------
-- 4. Cross-tenant relationship guards — composite foreign keys everywhere,
--    same idiom as multitenant_foundation.sql section 8 / Assets Management
--    section 4.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_safety_ppe_set_items_set_same_tenant') then
    alter table public.safety_ppe_set_items
      add constraint fk_safety_ppe_set_items_set_same_tenant
      foreign key (tenant_id, set_id) references public.safety_ppe_sets (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_safety_ppe_set_items_type_same_tenant') then
    alter table public.safety_ppe_set_items
      add constraint fk_safety_ppe_set_items_type_same_tenant
      foreign key (tenant_id, ppe_type_id) references public.safety_ppe_types (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_safety_asset_ext_asset_same_tenant') then
    alter table public.safety_asset_ext
      add constraint fk_safety_asset_ext_asset_same_tenant
      foreign key (tenant_id, asset_id) references public.assets (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_safety_asset_ext_type_same_tenant') then
    alter table public.safety_asset_ext
      add constraint fk_safety_asset_ext_type_same_tenant
      foreign key (tenant_id, ppe_type_id) references public.safety_ppe_types (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_safety_issuances_employee_same_tenant') then
    alter table public.safety_issuances
      add constraint fk_safety_issuances_employee_same_tenant
      foreign key (tenant_id, employee_id) references public.users (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_safety_issuances_set_same_tenant') then
    alter table public.safety_issuances
      add constraint fk_safety_issuances_set_same_tenant
      foreign key (tenant_id, ppe_set_id) references public.safety_ppe_sets (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_safety_issuances_issued_by_same_tenant') then
    alter table public.safety_issuances
      add constraint fk_safety_issuances_issued_by_same_tenant
      foreign key (tenant_id, issued_by) references public.users (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_safety_issuance_items_issuance_same_tenant') then
    alter table public.safety_issuance_items
      add constraint fk_safety_issuance_items_issuance_same_tenant
      foreign key (tenant_id, issuance_id) references public.safety_issuances (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_safety_issuance_items_type_same_tenant') then
    alter table public.safety_issuance_items
      add constraint fk_safety_issuance_items_type_same_tenant
      foreign key (tenant_id, ppe_type_id) references public.safety_ppe_types (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_safety_issuance_items_asset_same_tenant') then
    alter table public.safety_issuance_items
      add constraint fk_safety_issuance_items_asset_same_tenant
      foreign key (tenant_id, asset_id) references public.assets (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_safety_issuance_items_replaced_by_same_tenant') then
    alter table public.safety_issuance_items
      add constraint fk_safety_issuance_items_replaced_by_same_tenant
      foreign key (tenant_id, replaced_by_item_id) references public.safety_issuance_items (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_safety_field_visits_site_same_tenant') then
    alter table public.safety_field_visits
      add constraint fk_safety_field_visits_site_same_tenant
      foreign key (tenant_id, site_id) references public.sites (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_safety_field_visits_project_same_tenant') then
    alter table public.safety_field_visits
      add constraint fk_safety_field_visits_project_same_tenant
      foreign key (tenant_id, project_id) references public.projects (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_safety_field_visits_inspector_same_tenant') then
    alter table public.safety_field_visits
      add constraint fk_safety_field_visits_inspector_same_tenant
      foreign key (tenant_id, inspector_id) references public.users (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_safety_fv_checks_visit_same_tenant') then
    alter table public.safety_field_visit_checks
      add constraint fk_safety_fv_checks_visit_same_tenant
      foreign key (tenant_id, visit_id) references public.safety_field_visits (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_safety_fv_checks_employee_same_tenant') then
    alter table public.safety_field_visit_checks
      add constraint fk_safety_fv_checks_employee_same_tenant
      foreign key (tenant_id, employee_id) references public.users (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_safety_fv_checks_checked_by_same_tenant') then
    alter table public.safety_field_visit_checks
      add constraint fk_safety_fv_checks_checked_by_same_tenant
      foreign key (tenant_id, checked_by) references public.users (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_safety_fvc_missing_check_same_tenant') then
    alter table public.safety_field_visit_check_missing_items
      add constraint fk_safety_fvc_missing_check_same_tenant
      foreign key (tenant_id, check_id) references public.safety_field_visit_checks (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_safety_fvc_missing_type_same_tenant') then
    alter table public.safety_field_visit_check_missing_items
      add constraint fk_safety_fvc_missing_type_same_tenant
      foreign key (tenant_id, ppe_type_id) references public.safety_ppe_types (tenant_id, id);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 5. Number Generator catalogue — this module's two reserved codes.
--    Confirmed via grep of the whole migrations/ tree before writing this:
--    the existing 'RF' row already carries owner_module = 'Safety' (Risk
--    Form, migration 202608050039) and is untouched here; 'PI'/'FV' are new
--    and do not collide with any of the thirteen other codes in that table.
-- ----------------------------------------------------------------------------
insert into public.number_sources (code, label_ar, label_en, owner_module) values
  ('PI', 'صرف مهمات وقاية', 'PPE Issuance', 'Safety'),
  ('FV', 'زيارة ميدانية', 'Field Visit', 'Safety')
on conflict (code) do nothing;

-- ----------------------------------------------------------------------------
-- 6. Audience Engine extension (202608040013) — widen the two CHECK
--    constraints and re-declare the four functions that carry
--    entity_type/dimension-specific logic. Constraint names are looked up
--    dynamically (never assumed) because both were originally declared
--    inline without an explicit name, and audience_rule_terms carries a
--    SECOND, explicitly-named check (audience_rule_terms_value_present) that
--    also happens to mention "dimension" in its own definition text — the
--    lookup below excludes it by name so the wrong constraint is never
--    dropped.
-- ----------------------------------------------------------------------------
do $$
declare
  v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.audience_rules'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%entity_type%';
  if v_conname is not null then
    execute format('alter table public.audience_rules drop constraint %I', v_conname);
  end if;
  alter table public.audience_rules
    add constraint audience_rules_entity_type_check check (entity_type in (
      'Circular', 'Document', 'Design', 'FormTemplate', 'Announcement',
      'Survey', 'CalendarEvent', 'Certificate', 'Note', 'SafetyPpeSet'
    ));

  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.audience_rule_terms'::regclass
    and contype = 'c'
    and conname <> 'audience_rule_terms_value_present'
    and pg_get_constraintdef(oid) ilike '%dimension%';
  if v_conname is not null then
    execute format('alter table public.audience_rule_terms drop constraint %I', v_conname);
  end if;
  alter table public.audience_rule_terms
    add constraint audience_rule_terms_dimension_check check (dimension in (
      'Everyone', 'Department', 'Project', 'Sector', 'Site', 'Country',
      'Nationality', 'Role', 'Employee', 'PublicationLevel', 'Tag', 'Position'
    ));
end $$;

-- 6.1 audience_can_manage() — add the Safety.Manage arm. Every other line is
--     byte-identical to migration 202608040013's own body.
create or replace function public.audience_can_manage()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission('Audience.Manage')
      or public.has_permission('Content.Manage')
      or public.has_permission('Announcements.Manage')
      or public.has_permission('Surveys.Manage')
      or public.has_permission('Calendar.Manage')
      or public.has_permission('Forms.Manage')
      or public.has_permission('Verification.Manage')
      or public.has_permission('Safety.Manage');
$$;
grant execute on function public.audience_can_manage() to authenticated;

-- 6.2 audience_matches() — add one 'Position' branch to the dimension CASE.
--     Every other branch, and everything outside the CASE, is byte-identical
--     to migration 202608040013's own body.
create or replace function public.audience_matches(
  p_entity_type text,
  p_entity_id uuid,
  p_user_id uuid default auth.uid()
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_user public.users%rowtype;
  v_rule public.audience_rules%rowtype;
  v_term public.audience_rule_terms%rowtype;
  v_group smallint;
  v_hit boolean;
  v_group_ok boolean;
  v_and_ok boolean;
  v_or_seen boolean;
  v_or_ok boolean;
  v_any_group boolean := false;
  v_all_ok boolean := true;
  v_any_ok boolean := false;
  v_rank integer := -1;
  v_dept_ids uuid[];
  v_role_ids uuid[];
  v_role_codes text[];
begin
  if p_entity_id is null or p_user_id is null then
    return false;
  end if;

  select * into v_user from public.users u where u.id = p_user_id and not u.is_deleted;
  if not found then
    return false;
  end if;

  v_tenant := coalesce(public.current_tenant_id(), v_user.active_tenant_id, v_user.tenant_id);
  if v_tenant is null then
    return false;
  end if;

  -- Definer rights bypass RLS, so the company boundary has to be re-checked by
  -- hand: p_user_id is caller supplied and an employee of another company must
  -- never be evaluated against this company's rule.
  if coalesce(v_user.active_tenant_id, v_user.tenant_id) is distinct from v_tenant then
    return false;
  end if;

  select * into v_rule
  from public.audience_rules r
  where r.tenant_id = v_tenant
    and r.entity_type = p_entity_type
    and r.entity_id = p_entity_id
    and not r.is_deleted;

  -- A record nobody has targeted belongs to the whole company.
  if not found or v_rule.is_everyone then
    return true;
  end if;

  for v_group in
    select distinct t.group_no
    from public.audience_rule_terms t
    where t.tenant_id = v_tenant and t.rule_id = v_rule.id and not t.is_deleted
    order by 1
  loop
    v_any_group := true;
    v_group_ok := true;
    v_and_ok := true;
    v_or_seen := false;
    v_or_ok := false;

    for v_term in
      select *
      from public.audience_rule_terms t
      where t.tenant_id = v_tenant
        and t.rule_id = v_rule.id
        and not t.is_deleted
        and t.group_no = v_group
      order by t.display_order, t.created_on
    loop
      case v_term.dimension
        when 'Everyone' then
          v_hit := true;

        when 'Department' then
          if v_dept_ids is null then
            -- Walking up from the employee once is the same answer as expanding
            -- every targeted department downwards, and it is bounded by depth.
            v_dept_ids := (
              with recursive chain as (
                select d.id, d.parent_id, 1 as depth
                from public.departments d
                where d.tenant_id = v_tenant and d.id = v_user.department_id and not d.is_deleted
                union all
                select p.id, p.parent_id, c.depth + 1
                from public.departments p
                join chain c on p.id = c.parent_id
                where p.tenant_id = v_tenant and not p.is_deleted and c.depth < 20
              )
              select coalesce(array_agg(chain.id), '{}'::uuid[]) from chain
            );
          end if;
          v_hit := v_term.value_id is not null and v_term.value_id = any (v_dept_ids);

        when 'Project' then
          v_hit := v_term.value_id is not null and v_user.project_id = v_term.value_id;

        when 'Sector' then
          v_hit := v_term.value_id is not null and v_user.sector_id = v_term.value_id;

        when 'Site' then
          v_hit := v_term.value_id is not null and v_user.site_id = v_term.value_id;

        -- New: matches the employee's own position, by id or by code text.
        when 'Position' then
          v_hit := (v_term.value_id is not null and v_user.position_id = v_term.value_id)
            or (
              v_term.value_text is not null
              and exists (
                select 1 from public.positions p
                where p.tenant_id = v_tenant
                  and p.id = v_user.position_id
                  and not p.is_deleted
                  and upper(trim(v_term.value_text)) = upper(p.code)
              )
            );

        when 'Country', 'Nationality' then
          v_hit := (v_term.value_id is not null and v_user.country_id = v_term.value_id)
            or (
              v_term.value_text is not null
              and (
                upper(trim(v_term.value_text)) in (
                  upper(nullif(trim(v_user.nationality), '')),
                  upper(nullif(trim(v_user.nationality_ar), '')),
                  upper(nullif(trim(v_user.nationality_en), ''))
                )
                or exists (
                  select 1 from public.countries c
                  where c.tenant_id = v_tenant
                    and c.id = v_user.country_id
                    and upper(trim(v_term.value_text)) in (upper(c.iso_code), upper(c.code))
                )
              )
            );

        when 'Role' then
          if v_role_ids is null then
            select
              coalesce(array_agg(r.id), '{}'::uuid[]),
              coalesce(array_agg(upper(r.code)), '{}'::text[])
            into v_role_ids, v_role_codes
            from public.user_roles ur
            join public.roles r on r.id = ur.role_id
            where ur.user_id = p_user_id
              and r.tenant_id = v_tenant
              and r.is_active
              and not r.is_deleted;
          end if;
          v_hit := (v_term.value_id is not null and v_term.value_id = any (v_role_ids))
            or (v_term.value_text is not null and upper(trim(v_term.value_text)) = any (v_role_codes));

        when 'Employee' then
          v_hit := (v_term.value_id is not null and v_term.value_id = p_user_id)
            or (v_term.value_text is not null and trim(v_term.value_text) = v_user.employee_no);

        when 'PublicationLevel' then
          if v_rank < 0 then
            if p_user_id = auth.uid() then
              v_rank := public.current_content_access_rank();
            else
              select coalesce(max(
                case r.code
                  when 'PLATFORM_OPERATOR' then 4
                  when 'PLATFORM_ADMIN' then 4
                  when 'SYSTEM_ADMIN' then 4
                  when 'DEPARTMENT_MANAGER' then 3
                  when 'DEPARTMENT_COORDINATOR' then 2
                  when 'EMPLOYEE' then 1
                  else 0
                end
              ), 0) into v_rank
              from public.user_roles ur
              join public.roles r on r.id = ur.role_id
              where ur.user_id = p_user_id
                and r.tenant_id = v_tenant
                and r.is_active
                and not r.is_deleted;
            end if;
          end if;
          v_hit := v_rank >= case upper(coalesce(v_term.value_text, ''))
                               when 'PUBLIC' then 1
                               when 'ADMINISTRATIVE' then 2
                               when 'MANAGER_RESTRICTED' then 3
                               when 'PRIVATE_RESTRICTED' then 4
                               else 99
                             end;

        when 'Tag' then
          v_hit := exists (
            select 1
            from public.employee_tag_assignments a
            left join public.employee_tags g
              on g.id = a.tag_id and g.tenant_id = a.tenant_id
            where a.tenant_id = v_tenant
              and a.employee_id = p_user_id
              and not a.is_deleted
              and (
                (v_term.value_id is not null and a.tag_id = v_term.value_id)
                or (v_term.value_text is not null and upper(g.code) = upper(trim(v_term.value_text)))
              )
          );

        else
          v_hit := false;
      end case;

      v_hit := coalesce(v_hit, false);

      if v_term.operator = 'NOT' then
        if v_hit then
          v_group_ok := false;
        end if;
      elsif v_term.operator = 'OR' then
        v_or_seen := true;
        if v_hit then
          v_or_ok := true;
        end if;
      else
        if not v_hit then
          v_and_ok := false;
        end if;
      end if;
    end loop;

    v_group_ok := v_group_ok and v_and_ok and (not v_or_seen or v_or_ok);

    if v_group_ok then
      if v_rule.match_mode = 'Any' then
        return true;
      end if;
      v_any_ok := true;
    else
      if v_rule.match_mode <> 'Any' then
        return false;
      end if;
      v_all_ok := false;
    end if;
  end loop;

  -- A rule that was narrowed but left without terms is treated as unrestricted
  -- rather than as "nobody"; losing a record is worse than over-sharing it
  -- inside one company, and the picker never saves this shape.
  if not v_any_group then
    return true;
  end if;

  if v_rule.match_mode = 'Any' then
    return v_any_ok;
  end if;
  return v_all_ok;
end;
$$;
revoke all on function public.audience_matches(text, uuid, uuid) from public;
grant execute on function public.audience_matches(text, uuid, uuid) to authenticated, service_role;

-- 6.3 audience_describe() — add one 'Position' label lookup (both languages),
--     placed alongside every other id-based dimension's own lookup. Every
--     other line is byte-identical to migration 202608040013's own body.
create or replace function public.audience_describe(p_entity_type text, p_entity_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ctx as (
    select public.current_tenant_id() as tid
  ),
  bound_rule as (
    select r.*
    from public.audience_rules r, ctx
    where r.tenant_id = ctx.tid
      and r.entity_type = p_entity_type
      and r.entity_id = p_entity_id
      and not r.is_deleted
  ),
  term as (
    select
      t.group_no,
      t.display_order,
      jsonb_build_object(
        'id', t.id,
        'group_no', t.group_no,
        'operator', t.operator,
        'dimension', t.dimension,
        'value_id', t.value_id,
        'value_text', t.value_text,
        'display_order', t.display_order,
        'label_ar', case
          when t.dimension = 'Department' then (select d.name_ar from public.departments d where d.id = t.value_id and d.tenant_id = ctx.tid)
          when t.dimension = 'Project' then (select pr.name_ar from public.projects pr where pr.id = t.value_id and pr.tenant_id = ctx.tid)
          when t.dimension = 'Sector' then (select se.name_ar from public.sectors se where se.id = t.value_id and se.tenant_id = ctx.tid)
          when t.dimension = 'Site' then (select si.name_ar from public.sites si where si.id = t.value_id and si.tenant_id = ctx.tid)
          when t.dimension = 'Position' then (select po.name_ar from public.positions po where po.id = t.value_id and po.tenant_id = ctx.tid)
          when t.dimension in ('Country', 'Nationality') then (select co.name_ar from public.countries co where co.id = t.value_id and co.tenant_id = ctx.tid)
          when t.dimension = 'Role' then (select ro.name_ar from public.roles ro where ro.id = t.value_id and ro.tenant_id = ctx.tid)
          when t.dimension = 'Employee' then (select coalesce(us.name_ar, us.full_name, us.email) from public.users us where us.id = t.value_id and us.tenant_id = ctx.tid)
          when t.dimension = 'Tag' then (select tg.name_ar from public.employee_tags tg where tg.id = t.value_id and tg.tenant_id = ctx.tid)
          else t.value_text
        end,
        'label_en', case
          when t.dimension = 'Department' then (select d.name_en from public.departments d where d.id = t.value_id and d.tenant_id = ctx.tid)
          when t.dimension = 'Project' then (select pr.name_en from public.projects pr where pr.id = t.value_id and pr.tenant_id = ctx.tid)
          when t.dimension = 'Sector' then (select se.name_en from public.sectors se where se.id = t.value_id and se.tenant_id = ctx.tid)
          when t.dimension = 'Site' then (select si.name_en from public.sites si where si.id = t.value_id and si.tenant_id = ctx.tid)
          when t.dimension = 'Position' then (select po.name_en from public.positions po where po.id = t.value_id and po.tenant_id = ctx.tid)
          when t.dimension in ('Country', 'Nationality') then (select co.name_en from public.countries co where co.id = t.value_id and co.tenant_id = ctx.tid)
          when t.dimension = 'Role' then (select ro.name_en from public.roles ro where ro.id = t.value_id and ro.tenant_id = ctx.tid)
          when t.dimension = 'Employee' then (select coalesce(us.name_en, us.full_name, us.email) from public.users us where us.id = t.value_id and us.tenant_id = ctx.tid)
          when t.dimension = 'Tag' then (select tg.name_en from public.employee_tags tg where tg.id = t.value_id and tg.tenant_id = ctx.tid)
          else t.value_text
        end
      ) as payload
    from public.audience_rule_terms t
    join bound_rule on bound_rule.id = t.rule_id
    cross join ctx
    where t.tenant_id = ctx.tid and not t.is_deleted
  )
  select jsonb_build_object(
    'entity_type', p_entity_type,
    'entity_id', p_entity_id,
    'rule_id', (select id from bound_rule),
    'has_rule', exists (select 1 from bound_rule),
    'match_mode', coalesce((select match_mode from bound_rule), 'All'),
    'is_everyone', coalesce((select is_everyone from bound_rule), true),
    'terms', coalesce((
      select jsonb_agg(payload order by group_no, display_order) from term
    ), '[]'::jsonb),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object('group_no', g.group_no, 'terms', g.terms) order by g.group_no)
      from (
        select group_no, jsonb_agg(payload order by display_order) as terms
        from term
        group by group_no
      ) g
    ), '[]'::jsonb)
  );
$$;
grant execute on function public.audience_describe(text, uuid) to authenticated;

-- 6.4 audience_save() — add 'SafetyPpeSet' to the entity_type allowlist and
--     'Position' to the dimension allowlist. Every other line is
--     byte-identical to migration 202608040013's own body.
create or replace function public.audience_save(p_entity_type text, p_entity_id uuid, p_rule jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_rule_id uuid;
  v_mode text;
  v_everyone boolean;
  v_terms jsonb;
  v_term jsonb;
  v_dimension text;
  v_operator text;
  v_group smallint;
  v_order integer := 0;
begin
  if v_tenant is null then
    raise exception 'TENANT_NOT_RESOLVED';
  end if;
  if not public.audience_can_manage() then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_entity_id is null then
    raise exception 'ENTITY_REQUIRED';
  end if;
  if coalesce(p_entity_type, '') not in (
    'Circular', 'Document', 'Design', 'FormTemplate', 'Announcement',
    'Survey', 'CalendarEvent', 'Certificate', 'Note', 'SafetyPpeSet'
  ) then
    raise exception 'INVALID_ENTITY_TYPE';
  end if;

  p_rule := coalesce(p_rule, '{}'::jsonb);
  v_mode := coalesce(nullif(trim(p_rule ->> 'match_mode'), ''), 'All');
  if v_mode not in ('All', 'Any') then
    raise exception 'INVALID_MATCH_MODE';
  end if;
  v_everyone := coalesce((p_rule ->> 'is_everyone')::boolean, false);

  v_terms := coalesce(p_rule -> 'terms', '[]'::jsonb);
  if jsonb_typeof(v_terms) <> 'array' then
    raise exception 'INVALID_TERMS';
  end if;

  -- audience_describe returns both shapes; accept the grouped one too.
  if jsonb_array_length(v_terms) = 0 and jsonb_typeof(p_rule -> 'groups') = 'array' then
    select coalesce(jsonb_agg(
             t.item || jsonb_build_object(
               'group_no',
               coalesce((t.item ->> 'group_no')::int, (g.grp ->> 'group_no')::int, 1)
             )
           ), '[]'::jsonb)
    into v_terms
    from jsonb_array_elements(p_rule -> 'groups') as g(grp)
    cross join lateral jsonb_array_elements(coalesce(g.grp -> 'terms', '[]'::jsonb)) as t(item);
  end if;

  insert into public.audience_rules (tenant_id, entity_type, entity_id, match_mode, is_everyone, notes)
  values (v_tenant, p_entity_type, p_entity_id, v_mode, v_everyone, nullif(trim(p_rule ->> 'notes'), ''))
  on conflict (tenant_id, entity_type, entity_id) do update
    set match_mode = excluded.match_mode,
        is_everyone = excluded.is_everyone,
        notes = excluded.notes,
        is_deleted = false
  returning id into v_rule_id;

  delete from public.audience_rule_terms
  where tenant_id = v_tenant and rule_id = v_rule_id;

  for v_term in select e.item from jsonb_array_elements(v_terms) as e(item) loop
    v_dimension := nullif(trim(v_term ->> 'dimension'), '');
    if v_dimension is null then
      raise exception 'DIMENSION_REQUIRED';
    end if;
    if v_dimension not in (
      'Everyone', 'Department', 'Project', 'Sector', 'Site', 'Country',
      'Nationality', 'Role', 'Employee', 'PublicationLevel', 'Tag', 'Position'
    ) then
      raise exception 'INVALID_DIMENSION';
    end if;

    v_operator := upper(coalesce(nullif(trim(v_term ->> 'operator'), ''), 'AND'));
    if v_operator not in ('AND', 'OR', 'NOT') then
      raise exception 'INVALID_OPERATOR';
    end if;

    v_group := coalesce((nullif(trim(v_term ->> 'group_no'), ''))::smallint, 1);

    if v_dimension <> 'Everyone'
       and nullif(trim(v_term ->> 'value_id'), '') is null
       and nullif(trim(v_term ->> 'value_text'), '') is null then
      raise exception 'TERM_VALUE_REQUIRED';
    end if;

    v_order := v_order + 1;

    insert into public.audience_rule_terms (
      tenant_id, rule_id, group_no, operator, dimension, value_id, value_text, display_order
    )
    values (
      v_tenant,
      v_rule_id,
      v_group,
      v_operator,
      v_dimension,
      nullif(trim(v_term ->> 'value_id'), '')::uuid,
      nullif(trim(v_term ->> 'value_text'), ''),
      coalesce((nullif(trim(v_term ->> 'display_order'), ''))::integer, v_order)
    );
  end loop;

  -- "Everyone" and "no terms" are the same audience; store it once so the
  -- read path stops at the rule row.
  if v_order = 0 then
    update public.audience_rules set is_everyone = true where id = v_rule_id;
  end if;

  return public.audience_describe(p_entity_type, p_entity_id);
end;
$$;
grant execute on function public.audience_save(text, uuid, jsonb) to authenticated;

-- audience_visible_ids(p_entity_type) was read in full and confirmed
-- already generic for 'SafetyPpeSet': it special-cases only
-- 'Circular'/'Document'/'Design' and 'FormTemplate', and every other
-- entity_type — this one included — already falls through to its own
-- documented generic branch ("Modules whose tables arrive later: answer
-- from stored rules"). Not re-declared; not touched.

-- ----------------------------------------------------------------------------
-- 7. RPCs
-- ----------------------------------------------------------------------------

-- 7.1 safety_ppe_type_upsert
create or replace function public.safety_ppe_type_upsert(
  p_id uuid, p_code text, p_name_ar text, p_name_en text, p_category text,
  p_description_ar text, p_description_en text, p_standard_lifespan_days integer,
  p_requires_size boolean, p_display_order integer, p_is_active boolean
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
  if not public.has_permission('Safety.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if p_name_ar is null or trim(p_name_ar) = '' then raise exception 'NAME_AR_REQUIRED'; end if;
  if p_category is null or p_category not in (
    'Head', 'Eye', 'Hand', 'Foot', 'Body', 'Respiratory', 'Hearing', 'Fire', 'Other'
  ) then
    raise exception 'INVALID_CATEGORY';
  end if;
  if p_standard_lifespan_days is not null and p_standard_lifespan_days <= 0 then
    raise exception 'INVALID_LIFESPAN_DAYS';
  end if;

  if p_id is null then
    insert into public.safety_ppe_types (
      tenant_id, code, name_ar, name_en, category, description_ar, description_en,
      standard_lifespan_days, requires_size, display_order, is_active
    ) values (
      v_tenant, nullif(trim(p_code), ''), trim(p_name_ar), nullif(trim(p_name_en), ''), p_category,
      p_description_ar, p_description_en, p_standard_lifespan_days, coalesce(p_requires_size, false),
      coalesce(p_display_order, 0), coalesce(p_is_active, true)
    ) returning id into v_id;
  else
    update public.safety_ppe_types set
      code = nullif(trim(p_code), ''),
      name_ar = trim(p_name_ar),
      name_en = nullif(trim(p_name_en), ''),
      category = p_category,
      description_ar = p_description_ar,
      description_en = p_description_en,
      standard_lifespan_days = p_standard_lifespan_days,
      requires_size = coalesce(p_requires_size, requires_size),
      display_order = coalesce(p_display_order, display_order),
      is_active = coalesce(p_is_active, is_active)
    where id = p_id and tenant_id = v_tenant and not is_deleted
    returning id into v_id;
    if v_id is null then raise exception 'PPE_TYPE_NOT_FOUND'; end if;
  end if;

  perform public.record_activity('SafetyPpeType', v_id, case when p_id is null then 'CREATED' else 'UPDATED' end,
    case when p_id is null then 'تم إنشاء نوع مهمة وقاية' else 'تم تحديث نوع مهمة وقاية' end,
    case when p_id is null then 'PPE type created' else 'PPE type updated' end,
    jsonb_build_object('nameAr', trim(p_name_ar), 'category', p_category));

  return v_id;
end;
$$;
revoke all on function public.safety_ppe_type_upsert(uuid, text, text, text, text, text, text, integer, boolean, integer, boolean) from public;
grant execute on function public.safety_ppe_type_upsert(uuid, text, text, text, text, text, text, integer, boolean, integer, boolean) to authenticated;

comment on function public.safety_ppe_type_upsert(uuid, text, text, text, text, text, text, integer, boolean, integer, boolean) is
  'Creates or updates a PPE catalogue type. Authentication: authenticated. Authorization: '
  'Safety.Manage. category must be one of Head/Eye/Hand/Foot/Body/Respiratory/Hearing/Fire/'
  'Other. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, NAME_AR_REQUIRED, '
  'INVALID_CATEGORY, INVALID_LIFESPAN_DAYS, PPE_TYPE_NOT_FOUND.';

-- 7.2 safety_ppe_set_upsert
create or replace function public.safety_ppe_set_upsert(
  p_id uuid, p_code text, p_name_ar text, p_name_en text,
  p_description_ar text, p_description_en text, p_display_order integer, p_is_active boolean
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
  if not public.has_permission('Safety.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if p_name_ar is null or trim(p_name_ar) = '' then raise exception 'NAME_AR_REQUIRED'; end if;

  if p_id is null then
    insert into public.safety_ppe_sets (
      tenant_id, code, name_ar, name_en, description_ar, description_en, display_order, is_active
    ) values (
      v_tenant, nullif(trim(p_code), ''), trim(p_name_ar), nullif(trim(p_name_en), ''),
      p_description_ar, p_description_en, coalesce(p_display_order, 0), coalesce(p_is_active, true)
    ) returning id into v_id;
  else
    update public.safety_ppe_sets set
      code = nullif(trim(p_code), ''),
      name_ar = trim(p_name_ar),
      name_en = nullif(trim(p_name_en), ''),
      description_ar = p_description_ar,
      description_en = p_description_en,
      display_order = coalesce(p_display_order, display_order),
      is_active = coalesce(p_is_active, is_active)
    where id = p_id and tenant_id = v_tenant and not is_deleted
    returning id into v_id;
    if v_id is null then raise exception 'PPE_SET_NOT_FOUND'; end if;
  end if;

  perform public.record_activity('SafetyPpeSet', v_id, case when p_id is null then 'CREATED' else 'UPDATED' end,
    case when p_id is null then 'تم إنشاء مجموعة مهمات وقاية' else 'تم تحديث مجموعة مهمات وقاية' end,
    case when p_id is null then 'PPE set created' else 'PPE set updated' end,
    jsonb_build_object('nameAr', trim(p_name_ar)));

  return v_id;
end;
$$;
revoke all on function public.safety_ppe_set_upsert(uuid, text, text, text, text, text, integer, boolean) from public;
grant execute on function public.safety_ppe_set_upsert(uuid, text, text, text, text, text, integer, boolean) to authenticated;

comment on function public.safety_ppe_set_upsert(uuid, text, text, text, text, text, integer, boolean) is
  'Creates or updates a PPE set header (its item list is managed separately by '
  'safety_ppe_set_set_items(); who it applies to is managed by audience_save('
  '''SafetyPpeSet'', id, rule)). Authentication: authenticated. Authorization: Safety.Manage. '
  'Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, NAME_AR_REQUIRED, PPE_SET_NOT_FOUND.';

-- 7.3 safety_ppe_set_set_items — atomic replace, same delete-then-insert
--     shape as Assets Management's own asset_custody_unit_set_members().
create or replace function public.safety_ppe_set_set_items(p_set_id uuid, p_items jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Safety.Manage') then raise exception 'PERMISSION_DENIED'; end if;

  if not exists (
    select 1 from public.safety_ppe_sets where id = p_set_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'PPE_SET_NOT_FOUND';
  end if;

  -- Batch-validate the whole array in a handful of set-based queries instead
  -- of one existence probe per item (each raises once for the whole batch,
  -- same PPE_TYPE_ID_REQUIRED/INVALID_QUANTITY/PPE_TYPE_NOT_FOUND codes as
  -- before, just no longer O(n) round trips).
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as e(item)
    where nullif(e.item ->> 'ppeTypeId', '') is null
  ) then
    raise exception 'PPE_TYPE_ID_REQUIRED';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as e(item)
    where coalesce((e.item ->> 'quantity')::integer, 1) <= 0
  ) then
    raise exception 'INVALID_QUANTITY';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as e(item)
    left join public.safety_ppe_types t
      on t.id = (e.item ->> 'ppeTypeId')::uuid and t.tenant_id = v_tenant and not t.is_deleted
    where t.id is null
  ) then
    raise exception 'PPE_TYPE_NOT_FOUND';
  end if;

  delete from public.safety_ppe_set_items
  where set_id = p_set_id and tenant_id = v_tenant;

  -- distinct on (ppe_type_id), keeping the first occurrence by array
  -- position: a caller-supplied duplicate ppeTypeId would otherwise hit
  -- uq_safety_ppe_set_items as a raw unique_violation instead of a clean
  -- business error.
  insert into public.safety_ppe_set_items (tenant_id, set_id, ppe_type_id, quantity, reissue_interval_days, is_mandatory)
  select v_tenant, p_set_id, ppe_type_id, quantity, reissue_interval_days, is_mandatory
  from (
    select distinct on (entry.item ->> 'ppeTypeId')
      (entry.item ->> 'ppeTypeId')::uuid as ppe_type_id,
      coalesce((entry.item ->> 'quantity')::integer, 1) as quantity,
      nullif(entry.item ->> 'reissueIntervalDays', '')::integer as reissue_interval_days,
      coalesce((entry.item ->> 'isMandatory')::boolean, true) as is_mandatory,
      entry.ord
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as entry(item, ord)
    order by entry.item ->> 'ppeTypeId', entry.ord
  ) dedup;

  perform public.record_activity('SafetyPpeSet', p_set_id, 'ITEMS_REPLACED', 'تم تحديث أصناف مجموعة مهمات الوقاية', 'PPE set items updated',
    jsonb_build_object('itemCount', coalesce(jsonb_array_length(p_items), 0)));
end;
$$;
revoke all on function public.safety_ppe_set_set_items(uuid, jsonb) from public;
grant execute on function public.safety_ppe_set_set_items(uuid, jsonb) to authenticated;

comment on function public.safety_ppe_set_set_items(uuid, jsonb) is
  'Replaces a PPE set''s full item list atomically. Authentication: authenticated. '
  'Authorization: Safety.Manage. p_items is a jsonb array of {ppeTypeId, quantity, '
  'reissueIntervalDays, isMandatory}. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, '
  'PPE_SET_NOT_FOUND, PPE_TYPE_ID_REQUIRED, INVALID_QUANTITY, PPE_TYPE_NOT_FOUND.';

-- 7.4 safety_asset_ext_upsert — attaches/updates safety extension data on an
--     EXISTING public.assets row; never creates an asset itself (that stays
--     Assets Management's own asset_create()).
create or replace function public.safety_asset_ext_upsert(
  p_asset_id uuid, p_ppe_type_id uuid, p_expiry_date date,
  p_inspection_interval_days integer, p_last_inspection_date date,
  p_condition_status text, p_notes text
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
  v_next_due date;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Safety.Manage') then raise exception 'PERMISSION_DENIED'; end if;

  if not exists (select 1 from public.assets where id = p_asset_id and tenant_id = v_tenant and not is_deleted) then
    raise exception 'ASSET_NOT_FOUND';
  end if;
  if p_ppe_type_id is null or not exists (
    select 1 from public.safety_ppe_types where id = p_ppe_type_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'PPE_TYPE_NOT_FOUND';
  end if;
  if p_condition_status is not null and p_condition_status not in (
    'Good', 'NeedsInspection', 'NeedsReplacement', 'Retired'
  ) then
    raise exception 'INVALID_CONDITION_STATUS';
  end if;
  if p_inspection_interval_days is not null and p_inspection_interval_days <= 0 then
    raise exception 'INVALID_INSPECTION_INTERVAL';
  end if;

  v_next_due := case
    when p_inspection_interval_days is not null and p_last_inspection_date is not null
      then (p_last_inspection_date + (p_inspection_interval_days || ' days')::interval)::date
    else null
  end;

  insert into public.safety_asset_ext (
    tenant_id, asset_id, ppe_type_id, expiry_date, inspection_interval_days,
    last_inspection_date, next_inspection_due, condition_status, notes
  ) values (
    v_tenant, p_asset_id, p_ppe_type_id, p_expiry_date, p_inspection_interval_days,
    p_last_inspection_date, v_next_due, coalesce(p_condition_status, 'Good'), p_notes
  )
  on conflict (tenant_id, asset_id) where not is_deleted do update set
    ppe_type_id = excluded.ppe_type_id,
    expiry_date = excluded.expiry_date,
    inspection_interval_days = excluded.inspection_interval_days,
    last_inspection_date = excluded.last_inspection_date,
    next_inspection_due = excluded.next_inspection_due,
    condition_status = excluded.condition_status,
    notes = excluded.notes
  returning id into v_id;

  perform public.record_activity('SafetyAssetExt', v_id, 'UPSERTED', 'تم تحديث بيانات السلامة للأصل', 'Safety extension data updated',
    jsonb_build_object('assetId', p_asset_id, 'ppeTypeId', p_ppe_type_id, 'expiryDate', p_expiry_date));

  return v_id;
end;
$$;
revoke all on function public.safety_asset_ext_upsert(uuid, uuid, date, integer, date, text, text) from public;
grant execute on function public.safety_asset_ext_upsert(uuid, uuid, date, integer, date, text, text) to authenticated;

comment on function public.safety_asset_ext_upsert(uuid, uuid, date, integer, date, text, text) is
  'Creates or updates the 1:1 safety-extension row for an existing asset (expiry / '
  'inspection interval / condition). Never creates or modifies the underlying '
  'public.assets row itself. Authentication: authenticated. Authorization: Safety.Manage. '
  'Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, ASSET_NOT_FOUND, PPE_TYPE_NOT_FOUND, '
  'INVALID_CONDITION_STATUS, INVALID_INSPECTION_INTERVAL.';

-- 7.5 safety_asset_ext_inspect — records a periodic inspection event.
create or replace function public.safety_asset_ext_inspect(
  p_asset_id uuid, p_inspection_date date, p_condition_status text,
  p_next_inspection_due date, p_notes text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_ext public.safety_asset_ext%rowtype;
  v_computed_due date;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not (public.has_permission('Safety.Inspect') or public.has_permission('Safety.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_inspection_date is null then raise exception 'INSPECTION_DATE_REQUIRED'; end if;
  if p_condition_status is not null and p_condition_status not in (
    'Good', 'NeedsInspection', 'NeedsReplacement', 'Retired'
  ) then
    raise exception 'INVALID_CONDITION_STATUS';
  end if;

  select * into v_ext from public.safety_asset_ext
  where asset_id = p_asset_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'SAFETY_EXT_NOT_FOUND'; end if;

  v_computed_due := coalesce(
    p_next_inspection_due,
    case when v_ext.inspection_interval_days is not null
      then (p_inspection_date + (v_ext.inspection_interval_days || ' days')::interval)::date
      else null
    end
  );

  update public.safety_asset_ext set
    last_inspection_date = p_inspection_date,
    next_inspection_due = v_computed_due,
    condition_status = coalesce(p_condition_status, condition_status),
    notes = coalesce(p_notes, notes)
  where id = v_ext.id;

  perform public.record_activity('SafetyAssetExt', v_ext.id, 'INSPECTED', 'تم تفتيش معدة الوقاية', 'PPE item inspected',
    jsonb_build_object(
      'assetId', p_asset_id, 'inspectionDate', p_inspection_date,
      'conditionStatus', coalesce(p_condition_status, v_ext.condition_status)
    ));
end;
$$;
revoke all on function public.safety_asset_ext_inspect(uuid, date, text, date, text) from public;
grant execute on function public.safety_asset_ext_inspect(uuid, date, text, date, text) to authenticated;

comment on function public.safety_asset_ext_inspect(uuid, date, text, date, text) is
  'Records a periodic inspection for an asset-tracked PPE item: updates last_inspection_date, '
  'condition_status, and next_inspection_due (explicit p_next_inspection_due, or computed '
  'from the extension row''s own inspection_interval_days when omitted). Authentication: '
  'authenticated. Authorization: Safety.Inspect or Safety.Manage. Expected errors: '
  'NO_ACTIVE_TENANT, PERMISSION_DENIED, INSPECTION_DATE_REQUIRED, INVALID_CONDITION_STATUS, '
  'SAFETY_EXT_NOT_FOUND.';

-- 7.6 safety_issuance_create
--
-- Scope decision on asset custody sync: an asset-tracked line here (assetId
-- set) is gated by the same Assets.Operate/Manage + non-Disposed check
-- asset_transaction_create() itself enforces (see the loop below and in
-- safety_issuance_item_add()/safety_issuance_item_reissue()), but this
-- migration deliberately does NOT call asset_transaction_create() to also
-- flip public.assets.status/current_custodian_user_id on Issue, nor on the
-- later Returned/Lost/Damaged/Expired transitions in
-- safety_issuance_item_update_status(). Assets Management's own
-- transaction_type enum (Receive/Issue/Transfer/Return/Lost/Found/Reserve/
-- Release) has no Damaged/Expired equivalent, so a partial sync (Issue only,
-- never Damaged/Expired) would leave the asset snapshot silently wrong in
-- exactly the cases that matter most for PPE. This is a real, acknowledged
-- design gap (public.assets can diverge from what Safety believes about an
-- asset-tracked item once it leaves Issued status) — closing it properly
-- requires extending Assets Management's own transaction_type vocabulary,
-- which is out of this migration's scope; the Assets-side permission and
-- Disposed checks below are the containment this migration does take on.
create or replace function public.safety_issuance_create(
  p_employee_id uuid, p_ppe_set_id uuid, p_notes text, p_items jsonb
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
  v_ref text;
  v_item jsonb;
  v_asset_id uuid;
  v_asset_status text;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not (public.has_permission('Safety.Issue') or public.has_permission('Safety.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_employee_id is null or not exists (
    select 1 from public.users where id = p_employee_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'EMPLOYEE_NOT_FOUND';
  end if;
  if p_ppe_set_id is not null and not exists (
    select 1 from public.safety_ppe_sets where id = p_ppe_set_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'PPE_SET_NOT_FOUND';
  end if;
  if coalesce(jsonb_array_length(p_items), 0) = 0 then raise exception 'ITEMS_REQUIRED'; end if;

  -- An asset-tracked serial unit can only ever back one currently-Issued
  -- item at a time — reject the same assetId appearing twice in this one
  -- batch before it ever reaches the per-row loop below.
  if exists (
    select 1 from (
      select nullif(e.item ->> 'assetId', '')::uuid as asset_id
      from jsonb_array_elements(p_items) as e(item)
    ) x
    where x.asset_id is not null
    group by x.asset_id
    having count(*) > 1
  ) then
    raise exception 'ASSET_ALREADY_ISSUED';
  end if;

  -- Batch-validate ppeTypeId/quantity across the whole array in one pass each
  -- (was one query per item); asset-tracked lines still get a per-row check
  -- below, since each referenced asset needs its own Assets-side permission
  -- and Disposed check, not just an existence probe.
  if exists (
    select 1 from jsonb_array_elements(p_items) as e(item)
    where nullif(e.item ->> 'ppeTypeId', '') is null
  ) then
    raise exception 'PPE_TYPE_ID_REQUIRED';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) as e(item)
    left join public.safety_ppe_types t
      on t.id = (e.item ->> 'ppeTypeId')::uuid and t.tenant_id = v_tenant and not t.is_deleted
    where t.id is null
  ) then
    raise exception 'PPE_TYPE_NOT_FOUND';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) as e(item)
    where coalesce((e.item ->> 'quantity')::integer, 1) <= 0
  ) then
    raise exception 'INVALID_QUANTITY';
  end if;

  -- Asset-tracked lines (assetId present): binding an asset into this
  -- issuance is a write that touches public.assets' own single source of
  -- truth, so it needs the same Assets-side gate asset_transaction_create()
  -- itself enforces for any asset-touching write — Assets.Operate/Manage,
  -- plus rejecting a Disposed asset — never just Safety.Issue alone.
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_asset_id := nullif(v_item ->> 'assetId', '')::uuid;
    if v_asset_id is not null then
      select status into v_asset_status from public.assets
      where id = v_asset_id and tenant_id = v_tenant and not is_deleted;
      if v_asset_status is null then raise exception 'ASSET_NOT_FOUND'; end if;
      if not (public.has_permission('Assets.Operate') or public.has_permission('Assets.Manage')) then
        raise exception 'ASSET_PERMISSION_DENIED';
      end if;
      if v_asset_status = 'Disposed' then raise exception 'ASSET_DISPOSED'; end if;
      -- One asset-tracked unit can never back two simultaneously-Issued
      -- items — mirrors Assets Management's own single-custodian invariant.
      if exists (
        select 1 from public.safety_issuance_items
        where tenant_id = v_tenant and asset_id = v_asset_id and status = 'Issued' and not is_deleted
      ) then
        raise exception 'ASSET_ALREADY_ISSUED';
      end if;
    end if;
  end loop;

  v_ref := public.generate_number('PI', v_tenant);

  insert into public.safety_issuances (tenant_id, reference, employee_id, ppe_set_id, status, issued_by, notes)
  values (v_tenant, v_ref, p_employee_id, p_ppe_set_id, 'Issued', auth.uid(), p_notes)
  returning id into v_id;

  insert into public.safety_issuance_items (
    tenant_id, issuance_id, ppe_type_id, asset_id, quantity, size, issued_date, expiry_date, status
  )
  select
    v_tenant, v_id,
    (entry ->> 'ppeTypeId')::uuid,
    nullif(entry ->> 'assetId', '')::uuid,
    coalesce((entry ->> 'quantity')::integer, 1),
    nullif(entry ->> 'size', ''),
    coalesce((entry ->> 'issuedDate')::date, current_date),
    nullif(entry ->> 'expiryDate', '')::date,
    'Issued'
  from jsonb_array_elements(p_items) as entry;

  perform public.record_activity('SafetyIssuance', v_id, 'CREATED', 'تم صرف مهمات الوقاية', 'PPE issuance created',
    jsonb_build_object('reference', v_ref, 'employeeId', p_employee_id, 'itemCount', jsonb_array_length(p_items)));

  perform public.notify(
    p_employee_id, 'System', 'SAFETY_PPE_ISSUED',
    'تم صرف مهمات وقاية لك', 'PPE has been issued to you',
    'تم صرف مهمات وقاية لك ضمن العملية ' || v_ref || '.',
    'PPE has been issued to you under issuance ' || v_ref || '.',
    '/app/safety?issuance=' || v_id::text,
    jsonb_build_object('issuanceId', v_id, 'reference', v_ref)
  );

  return v_id;
end;
$$;
revoke all on function public.safety_issuance_create(uuid, uuid, text, jsonb) from public;
grant execute on function public.safety_issuance_create(uuid, uuid, text, jsonb) to authenticated;

comment on function public.safety_issuance_create(uuid, uuid, text, jsonb) is
  'Creates an issuance header with a fresh generate_number(''PI'') reference and its initial '
  'item lines (status Issued). p_items is a jsonb array of {ppeTypeId, assetId, quantity, '
  'size, issuedDate, expiryDate} — at least one item is required. A line with assetId set '
  'additionally requires Assets.Operate or Assets.Manage (Safety.Issue alone is not enough '
  'to bind an existing asset into an issuance) and the asset must not be Disposed. '
  'Authentication: authenticated. Authorization: Safety.Issue or Safety.Manage. Expected '
  'errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, EMPLOYEE_NOT_FOUND, PPE_SET_NOT_FOUND, '
  'ITEMS_REQUIRED, PPE_TYPE_ID_REQUIRED, PPE_TYPE_NOT_FOUND, ASSET_NOT_FOUND, '
  'ASSET_PERMISSION_DENIED, ASSET_DISPOSED, ASSET_ALREADY_ISSUED, INVALID_QUANTITY.';

-- 7.7 safety_issuance_item_add — add one item to an already-open issuance
--     (a later top-up, distinct from the initial batch in _create and from
--     the loss/damage replacement path in _reissue below).
create or replace function public.safety_issuance_item_add(
  p_issuance_id uuid, p_ppe_type_id uuid, p_asset_id uuid, p_quantity integer,
  p_size text, p_expiry_date date
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_issuance public.safety_issuances%rowtype;
  v_id uuid;
  v_asset_status text;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not (public.has_permission('Safety.Issue') or public.has_permission('Safety.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;

  select * into v_issuance from public.safety_issuances
  where id = p_issuance_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'ISSUANCE_NOT_FOUND'; end if;
  if v_issuance.status = 'Closed' then raise exception 'ISSUANCE_CLOSED'; end if;

  if p_ppe_type_id is null or not exists (
    select 1 from public.safety_ppe_types where id = p_ppe_type_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'PPE_TYPE_NOT_FOUND';
  end if;
  -- Same Assets-side gate as safety_issuance_create(): binding an asset here
  -- needs Assets.Operate/Manage, not just Safety.Issue, and must not be
  -- Disposed — mirrors asset_transaction_create()'s own ASSET_DISPOSED guard.
  if p_asset_id is not null then
    select status into v_asset_status from public.assets
    where id = p_asset_id and tenant_id = v_tenant and not is_deleted;
    if v_asset_status is null then raise exception 'ASSET_NOT_FOUND'; end if;
    if not (public.has_permission('Assets.Operate') or public.has_permission('Assets.Manage')) then
      raise exception 'ASSET_PERMISSION_DENIED';
    end if;
    if v_asset_status = 'Disposed' then raise exception 'ASSET_DISPOSED'; end if;
    -- Same single-custodian invariant as safety_issuance_create(): this
    -- asset must not already back another currently-Issued item.
    if exists (
      select 1 from public.safety_issuance_items
      where tenant_id = v_tenant and asset_id = p_asset_id and status = 'Issued' and not is_deleted
    ) then
      raise exception 'ASSET_ALREADY_ISSUED';
    end if;
  end if;
  if coalesce(p_quantity, 1) <= 0 then raise exception 'INVALID_QUANTITY'; end if;

  insert into public.safety_issuance_items (
    tenant_id, issuance_id, ppe_type_id, asset_id, quantity, size, issued_date, expiry_date, status
  ) values (
    v_tenant, p_issuance_id, p_ppe_type_id, p_asset_id, coalesce(p_quantity, 1), p_size,
    current_date, p_expiry_date, 'Issued'
  ) returning id into v_id;

  -- A fully-returned issuance that receives a new item is open again.
  update public.safety_issuances set status = 'Issued'
  where id = p_issuance_id and status = 'Returned';

  perform public.record_activity('SafetyIssuance', p_issuance_id, 'ITEM_ADDED', 'تمت إضافة صنف لعملية الصرف', 'Item added to issuance',
    jsonb_build_object('itemId', v_id, 'ppeTypeId', p_ppe_type_id));

  return v_id;
end;
$$;
revoke all on function public.safety_issuance_item_add(uuid, uuid, uuid, integer, text, date) from public;
grant execute on function public.safety_issuance_item_add(uuid, uuid, uuid, integer, text, date) to authenticated;

comment on function public.safety_issuance_item_add(uuid, uuid, uuid, integer, text, date) is
  'Adds one new item line to an already-open (not Closed) issuance. Reopens a fully-Returned '
  'issuance back to Issued. Setting p_asset_id additionally requires Assets.Operate or '
  'Assets.Manage and a non-Disposed asset. Authentication: authenticated. Authorization: '
  'Safety.Issue or Safety.Manage. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, '
  'ISSUANCE_NOT_FOUND, ISSUANCE_CLOSED, PPE_TYPE_NOT_FOUND, ASSET_NOT_FOUND, '
  'ASSET_PERMISSION_DENIED, ASSET_DISPOSED, ASSET_ALREADY_ISSUED, INVALID_QUANTITY.';

-- 7.8 safety_issuance_item_update_status — the unified item-lifecycle entry
--     point, mirroring Assets Management's own asset_transaction_create()
--     shape: one RPC, a closed set of target statuses, re-derives the
--     parent header's own status as a side effect. 'Replaced' is
--     deliberately NOT a reachable target here — only
--     safety_issuance_item_reissue() (7.9) ever writes it, the same
--     "system/dedicated-path-only status" rule Assets Management's own
--     'Missing' inventory-scan status already established.
create or replace function public.safety_issuance_item_update_status(
  p_item_id uuid, p_new_status text, p_notes text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_item public.safety_issuance_items%rowtype;
  v_issuance public.safety_issuances%rowtype;
  v_authorized boolean;
  v_any_issued boolean;
  v_all_returned boolean;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if p_new_status not in ('Returned', 'Lost', 'Damaged', 'Expired') then
    raise exception 'UNSUPPORTED_ITEM_STATUS';
  end if;

  select * into v_item from public.safety_issuance_items
  where id = p_item_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  if v_item.status <> 'Issued' then raise exception 'ITEM_NOT_ISSUED'; end if;

  select * into v_issuance from public.safety_issuances
  where id = v_item.issuance_id and tenant_id = v_tenant for update;
  if not found then raise exception 'ISSUANCE_NOT_FOUND'; end if;

  -- The affected employee may self-report Lost/Damaged on their own item;
  -- every other transition (including their own Returned) needs a
  -- Safety.Issue/Manage holder to countersign it.
  v_authorized := public.has_permission('Safety.Issue')
    or public.has_permission('Safety.Manage')
    or (p_new_status in ('Lost', 'Damaged') and v_issuance.employee_id = auth.uid());
  if not v_authorized then raise exception 'PERMISSION_DENIED'; end if;

  update public.safety_issuance_items set
    status = p_new_status,
    returned_on = case when p_new_status = 'Returned' then now() else returned_on end,
    notes = coalesce(p_notes, notes)
  where id = p_item_id;

  perform public.record_activity('SafetyIssuance', v_item.issuance_id, 'ITEM_' || upper(p_new_status),
    'صنف: ' || p_new_status, 'Item: ' || p_new_status,
    jsonb_build_object('itemId', p_item_id, 'ppeTypeId', v_item.ppe_type_id, 'status', p_new_status));

  select
    exists (
      select 1 from public.safety_issuance_items
      where issuance_id = v_issuance.id and tenant_id = v_tenant and not is_deleted and status = 'Issued'
    ),
    bool_and(status = 'Returned')
  into v_any_issued, v_all_returned
  from public.safety_issuance_items
  where issuance_id = v_issuance.id and tenant_id = v_tenant and not is_deleted;

  -- PartiallyReturned also covers the fully-resolved-but-mixed-outcome case
  -- (every item left Issued, but not every one was literally Returned —
  -- some are Lost/Damaged/Expired/Replaced): that case is left for an
  -- administrator to close explicitly via safety_issuance_close(), never
  -- auto-promoted to Returned.
  update public.safety_issuances set
    status = case
      when v_any_issued then 'PartiallyReturned'
      when v_all_returned then 'Returned'
      else 'PartiallyReturned'
    end
  where id = v_issuance.id and status <> 'Closed';

  if p_new_status in ('Lost', 'Damaged') then
    perform public.notify(
      v_issuance.issued_by, 'System', 'SAFETY_PPE_ITEM_' || upper(p_new_status),
      case when p_new_status = 'Lost' then 'تم الإبلاغ عن صنف وقاية مفقود' else 'تم الإبلاغ عن صنف وقاية تالف' end,
      'A PPE item was reported ' || lower(p_new_status),
      'أبلغ الموظف عن صنف من عملية الصرف ' || coalesce(v_issuance.reference, '') || '.',
      'The employee reported an item from issuance ' || coalesce(v_issuance.reference, '') || '.',
      '/app/admin/safety-issuances?issuance=' || v_issuance.id::text,
      jsonb_build_object('issuanceId', v_issuance.id, 'itemId', p_item_id)
    );
  end if;
end;
$$;
revoke all on function public.safety_issuance_item_update_status(uuid, text, text) from public;
grant execute on function public.safety_issuance_item_update_status(uuid, text, text) to authenticated;

comment on function public.safety_issuance_item_update_status(uuid, text, text) is
  'Unified entry point for an issued item''s terminal transitions: Returned/Lost/Damaged/'
  'Expired (never Replaced — only safety_issuance_item_reissue() writes that). Re-derives '
  'the parent issuance''s own status as a side effect. Authentication: authenticated. '
  'Authorization: Safety.Issue or Safety.Manage; the issuance''s own employee may also '
  'self-report Lost or Damaged on their own item. Expected errors: NO_ACTIVE_TENANT, '
  'UNSUPPORTED_ITEM_STATUS, ITEM_NOT_FOUND, ITEM_NOT_ISSUED, ISSUANCE_NOT_FOUND, '
  'PERMISSION_DENIED.';

-- 7.9 safety_issuance_item_reissue — replaces a Lost/Damaged/Expired item
--     with a fresh one; the only place 'Replaced' is ever written.
create or replace function public.safety_issuance_item_reissue(
  p_item_id uuid, p_new_expiry_date date, p_notes text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_old public.safety_issuance_items%rowtype;
  v_issuance public.safety_issuances%rowtype;
  v_new_id uuid;
  v_asset_status text;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not (public.has_permission('Safety.Issue') or public.has_permission('Safety.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;

  select * into v_old from public.safety_issuance_items
  where id = p_item_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  if v_old.status not in ('Lost', 'Damaged', 'Expired') then raise exception 'ITEM_NOT_REISSUABLE'; end if;

  select * into v_issuance from public.safety_issuances
  where id = v_old.issuance_id and tenant_id = v_tenant for update;
  if not found then raise exception 'ISSUANCE_NOT_FOUND'; end if;
  if v_issuance.status = 'Closed' then raise exception 'ISSUANCE_CLOSED'; end if;

  -- The old item's asset_id is carried forward onto the new Issued row
  -- unchanged (same physical unit, now presumed found/repaired) — but it
  -- must be re-checked against the SAME Assets-side gate every other
  -- asset-touching write in this module enforces: Assets.Operate/Manage,
  -- and not Disposed (the asset could have been disposed via Assets
  -- Management at any point while this item sat Lost/Damaged/Expired here).
  if v_old.asset_id is not null then
    select status into v_asset_status from public.assets
    where id = v_old.asset_id and tenant_id = v_tenant and not is_deleted;
    if v_asset_status is null then raise exception 'ASSET_NOT_FOUND'; end if;
    if not (public.has_permission('Assets.Operate') or public.has_permission('Assets.Manage')) then
      raise exception 'ASSET_PERMISSION_DENIED';
    end if;
    if v_asset_status = 'Disposed' then raise exception 'ASSET_DISPOSED'; end if;
  end if;

  insert into public.safety_issuance_items (
    tenant_id, issuance_id, ppe_type_id, asset_id, quantity, size, issued_date, expiry_date, status
  ) values (
    v_tenant, v_old.issuance_id, v_old.ppe_type_id, v_old.asset_id, v_old.quantity, v_old.size,
    current_date, p_new_expiry_date, 'Issued'
  ) returning id into v_new_id;

  update public.safety_issuance_items set
    status = 'Replaced', replaced_by_item_id = v_new_id, notes = coalesce(p_notes, notes)
  where id = p_item_id;

  update public.safety_issuances set status = 'Issued' where id = v_issuance.id and status <> 'Closed';

  perform public.record_activity('SafetyIssuance', v_issuance.id, 'ITEM_REISSUED', 'تمت إعادة صرف صنف بديل', 'Item reissued',
    jsonb_build_object('oldItemId', p_item_id, 'newItemId', v_new_id, 'ppeTypeId', v_old.ppe_type_id));

  return v_new_id;
end;
$$;
revoke all on function public.safety_issuance_item_reissue(uuid, date, text) from public;
grant execute on function public.safety_issuance_item_reissue(uuid, date, text) to authenticated;

comment on function public.safety_issuance_item_reissue(uuid, date, text) is
  'Replaces a Lost/Damaged/Expired item with a fresh Issued item carrying the same PPE type/'
  'asset/quantity/size; marks the old row Replaced and links replaced_by_item_id. When the '
  'old item was asset-tracked, re-checks the same Assets.Operate/Manage + non-Disposed gate '
  'safety_issuance_create()/safety_issuance_item_add() enforce, since the asset may have '
  'been disposed via Assets Management while this item sat Lost/Damaged/Expired. Reopens a '
  'Closed-adjacent issuance back to Issued. Authentication: authenticated. Authorization: '
  'Safety.Issue or Safety.Manage. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, '
  'ITEM_NOT_FOUND, ITEM_NOT_REISSUABLE, ISSUANCE_NOT_FOUND, ISSUANCE_CLOSED, ASSET_NOT_FOUND, '
  'ASSET_PERMISSION_DENIED, ASSET_DISPOSED.';

-- 7.10 safety_issuance_close
create or replace function public.safety_issuance_close(p_issuance_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_issuance public.safety_issuances%rowtype;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not (public.has_permission('Safety.Issue') or public.has_permission('Safety.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;

  select * into v_issuance from public.safety_issuances
  where id = p_issuance_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'ISSUANCE_NOT_FOUND'; end if;
  if v_issuance.status = 'Closed' then raise exception 'ISSUANCE_ALREADY_CLOSED'; end if;

  if exists (
    select 1 from public.safety_issuance_items
    where issuance_id = p_issuance_id and tenant_id = v_tenant and not is_deleted and status = 'Issued'
  ) then
    raise exception 'ISSUANCE_HAS_OPEN_ITEMS';
  end if;

  update public.safety_issuances set status = 'Closed' where id = p_issuance_id;

  perform public.record_activity('SafetyIssuance', p_issuance_id, 'CLOSED', 'تم إغلاق عملية الصرف', 'Issuance closed',
    jsonb_build_object('reference', v_issuance.reference));
end;
$$;
revoke all on function public.safety_issuance_close(uuid) from public;
grant execute on function public.safety_issuance_close(uuid) to authenticated;

comment on function public.safety_issuance_close(uuid) is
  'Closes an issuance once every item has left the Issued state (Returned/Lost/Damaged/'
  'Expired/Replaced). Authentication: authenticated. Authorization: Safety.Issue or '
  'Safety.Manage. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, ISSUANCE_NOT_FOUND, '
  'ISSUANCE_ALREADY_CLOSED, ISSUANCE_HAS_OPEN_ITEMS.';

-- 7.11 safety_field_visit_create
create or replace function public.safety_field_visit_create(
  p_site_id uuid, p_project_id uuid, p_visit_date date, p_notes text
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
  v_ref text;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not (public.has_permission('Safety.Inspect') or public.has_permission('Safety.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_site_id is not null and not exists (
    select 1 from public.sites where id = p_site_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'SITE_NOT_FOUND';
  end if;
  if p_project_id is not null and not exists (
    select 1 from public.projects where id = p_project_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'PROJECT_NOT_FOUND';
  end if;

  v_ref := public.generate_number('FV', v_tenant);

  insert into public.safety_field_visits (tenant_id, reference, site_id, project_id, inspector_id, visit_date, status, notes)
  values (v_tenant, v_ref, p_site_id, p_project_id, auth.uid(), coalesce(p_visit_date, current_date), 'Draft', p_notes)
  returning id into v_id;

  perform public.record_activity('SafetyFieldVisit', v_id, 'CREATED', 'تم إنشاء زيارة ميدانية', 'Field visit created',
    jsonb_build_object('reference', v_ref));

  return v_id;
end;
$$;
revoke all on function public.safety_field_visit_create(uuid, uuid, date, text) from public;
grant execute on function public.safety_field_visit_create(uuid, uuid, date, text) to authenticated;

comment on function public.safety_field_visit_create(uuid, uuid, date, text) is
  'Creates a Draft field visit with a fresh generate_number(''FV'') reference. Authentication: '
  'authenticated. Authorization: Safety.Inspect or Safety.Manage. Expected errors: '
  'NO_ACTIVE_TENANT, PERMISSION_DENIED, SITE_NOT_FOUND, PROJECT_NOT_FOUND.';

-- 7.12 safety_field_visit_check_record
create or replace function public.safety_field_visit_check_record(
  p_visit_id uuid, p_employee_id uuid, p_is_compliant boolean,
  p_missing_ppe_type_ids uuid[], p_notes text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_visit public.safety_field_visits%rowtype;
  v_id uuid;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not (public.has_permission('Safety.Inspect') or public.has_permission('Safety.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;

  select * into v_visit from public.safety_field_visits
  where id = p_visit_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'FIELD_VISIT_NOT_FOUND'; end if;
  if v_visit.status = 'Completed' then raise exception 'FIELD_VISIT_COMPLETED'; end if;
  if v_visit.inspector_id <> auth.uid() and not public.has_permission('Safety.Manage') then
    raise exception 'PERMISSION_DENIED';
  end if;

  if p_employee_id is null or not exists (
    select 1 from public.users where id = p_employee_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'EMPLOYEE_NOT_FOUND';
  end if;
  if coalesce(p_is_compliant, true) = false and coalesce(array_length(p_missing_ppe_type_ids, 1), 0) = 0 then
    raise exception 'MISSING_PPE_REQUIRED_WHEN_NOT_COMPLIANT';
  end if;

  insert into public.safety_field_visit_checks (tenant_id, visit_id, employee_id, is_compliant, notes, checked_by)
  values (v_tenant, p_visit_id, p_employee_id, coalesce(p_is_compliant, true), p_notes, auth.uid())
  returning id into v_id;

  -- distinct: a caller-supplied duplicate id in p_missing_ppe_type_ids would
  -- otherwise hit uq_safety_fvc_missing_items as a raw unique_violation
  -- instead of a clean business error.
  insert into public.safety_field_visit_check_missing_items (tenant_id, check_id, ppe_type_id)
  select distinct v_tenant, v_id, pt
  from unnest(coalesce(p_missing_ppe_type_ids, '{}'::uuid[])) as pt
  where exists (select 1 from public.safety_ppe_types where id = pt and tenant_id = v_tenant and not is_deleted);

  -- The array-non-empty check above only rules out an empty/null array; a
  -- caller could still pass ids that are all garbage or cross-tenant, none
  -- of which the filtered insert above would ever land. Re-check that at
  -- least one row actually landed so a non-compliant check can never persist
  -- with zero real missing-PPE evidence behind it, matching this function's
  -- own documented invariant.
  if not coalesce(p_is_compliant, true) and not exists (
    select 1 from public.safety_field_visit_check_missing_items
    where tenant_id = v_tenant and check_id = v_id
  ) then
    raise exception 'MISSING_PPE_REQUIRED_WHEN_NOT_COMPLIANT';
  end if;

  perform public.record_activity(
    'SafetyFieldVisitCheck', v_id,
    case when coalesce(p_is_compliant, true) then 'COMPLIANT' else 'NON_COMPLIANT' end,
    case when coalesce(p_is_compliant, true) then 'مطابق لمتطلبات السلامة' else 'غير مطابق لمتطلبات السلامة' end,
    case when coalesce(p_is_compliant, true) then 'Compliant' else 'Non-compliant' end,
    jsonb_build_object('visitId', p_visit_id, 'employeeId', p_employee_id)
  );

  if not coalesce(p_is_compliant, true) then
    perform public.notify(
      p_employee_id, 'System', 'SAFETY_NON_COMPLIANCE_RECORDED',
      'تم تسجيل ملاحظة سلامة عليك', 'A safety observation was recorded for you',
      'أثناء زيارة ميدانية، لوحظ نقص في مهمات الوقاية الشخصية المطلوبة.',
      'A field visit found you missing required PPE.',
      '/app/safety?check=' || v_id::text,
      jsonb_build_object('visitId', p_visit_id, 'checkId', v_id)
    );
  end if;

  return v_id;
end;
$$;
revoke all on function public.safety_field_visit_check_record(uuid, uuid, boolean, uuid[], text) from public;
grant execute on function public.safety_field_visit_check_record(uuid, uuid, boolean, uuid[], text) to authenticated;

comment on function public.safety_field_visit_check_record(uuid, uuid, boolean, uuid[], text) is
  'Records one employee''s PPE compliance check within an open (Draft) field visit; a false '
  'p_is_compliant requires at least one recognised entry in p_missing_ppe_type_ids. '
  'Authentication: authenticated. Authorization: Safety.Manage, or the visit''s own '
  'inspector holding Safety.Inspect. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, '
  'FIELD_VISIT_NOT_FOUND, FIELD_VISIT_COMPLETED, EMPLOYEE_NOT_FOUND, '
  'MISSING_PPE_REQUIRED_WHEN_NOT_COMPLIANT.';

-- 7.13 safety_field_visit_complete
create or replace function public.safety_field_visit_complete(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_visit public.safety_field_visits%rowtype;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  select * into v_visit from public.safety_field_visits
  where id = p_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'FIELD_VISIT_NOT_FOUND'; end if;
  if v_visit.status <> 'Draft' then raise exception 'FIELD_VISIT_NOT_DRAFT'; end if;
  if v_visit.inspector_id <> auth.uid() and not public.has_permission('Safety.Manage') then
    raise exception 'PERMISSION_DENIED';
  end if;

  update public.safety_field_visits set status = 'Completed' where id = p_id;

  perform public.record_activity('SafetyFieldVisit', p_id, 'COMPLETED', 'اكتملت الزيارة الميدانية', 'Field visit completed',
    jsonb_build_object('reference', v_visit.reference));
end;
$$;
revoke all on function public.safety_field_visit_complete(uuid) from public;
grant execute on function public.safety_field_visit_complete(uuid) to authenticated;

comment on function public.safety_field_visit_complete(uuid) is
  'Moves a Draft field visit to Completed, closing it to further checks. Authentication: '
  'authenticated. Authorization: the visit''s own inspector, or Safety.Manage. Expected '
  'errors: NO_ACTIVE_TENANT, FIELD_VISIT_NOT_FOUND, FIELD_VISIT_NOT_DRAFT, PERMISSION_DENIED.';

-- 7.14 safety_attachment_list — wider-audience wrapper over public.attachments,
--      mirroring Assets Management's own asset_attachment_list() shape, but
--      generic across this module's three attachable entity types.
create or replace function public.safety_attachment_list(p_entity_type text, p_entity_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_authorized boolean := false;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if p_entity_type not in ('SafetyPpeType', 'SafetyIssuance', 'SafetyFieldVisitCheck') then
    raise exception 'UNSUPPORTED_ENTITY_TYPE';
  end if;

  if p_entity_type = 'SafetyPpeType' then
    v_authorized := exists (
      select 1 from public.safety_ppe_types where id = p_entity_id and tenant_id = v_tenant and not is_deleted
    );
  elsif p_entity_type = 'SafetyIssuance' then
    v_authorized := exists (
      select 1 from public.safety_issuances iss
      where iss.id = p_entity_id and iss.tenant_id = v_tenant and not iss.is_deleted
        and (
          iss.employee_id = auth.uid() or iss.issued_by = auth.uid()
          or public.has_permission('Safety.View') or public.has_permission('Safety.Issue') or public.has_permission('Safety.Manage')
        )
    );
  elsif p_entity_type = 'SafetyFieldVisitCheck' then
    v_authorized := exists (
      select 1 from public.safety_field_visit_checks chk
      join public.safety_field_visits fv on fv.id = chk.visit_id and fv.tenant_id = chk.tenant_id
      where chk.id = p_entity_id and chk.tenant_id = v_tenant and not chk.is_deleted
        and (
          chk.employee_id = auth.uid() or chk.checked_by = auth.uid() or fv.inspector_id = auth.uid()
          or public.has_permission('Safety.View') or public.has_permission('Safety.Inspect') or public.has_permission('Safety.Manage')
        )
    );
  end if;

  if not v_authorized then raise exception 'PERMISSION_DENIED'; end if;

  return coalesce((
    select jsonb_agg(row_to_json(r) order by r.display_order, r.created_on)
    from (
      select
        a.id, a.storage_object_id, a.entity_type, a.entity_id, a.display_order,
        a.marked_for_removal, a.marked_for_removal_by, a.marked_for_removal_on,
        a.created_by, a.created_on,
        coalesce(u.full_name, u.name_ar, u.name_en, u.email) as created_by_name,
        o.layer, o.provider_code, o.bucket, o.path, o.file_name, o.mime_type, o.file_size, o.checksum, o.owner_id
      from public.attachments a
      join public.storage_objects o on o.id = a.storage_object_id and o.tenant_id = a.tenant_id
      left join public.users u on u.id = a.created_by
      where a.tenant_id = v_tenant
        and a.entity_type = p_entity_type
        and a.entity_id = p_entity_id
        and not a.is_deleted
        and not o.is_deleted
    ) r
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.safety_attachment_list(text, uuid) from public;
grant execute on function public.safety_attachment_list(text, uuid) to authenticated;

comment on function public.safety_attachment_list(text, uuid) is
  'Wider-audience wrapper over public.attachments for this module''s three attachable entity '
  'types (SafetyPpeType/SafetyIssuance/SafetyFieldVisitCheck) — attachment_list()''s own gate '
  '(owner/Storage.Manage) is too narrow for "anyone who can view this record sees its files". '
  'Authentication: authenticated. Authorization: per entity_type — SafetyPpeType is the '
  'broadly-readable catalogue; SafetyIssuance is its own employee/issuer or Safety.View/'
  'Issue/Manage; SafetyFieldVisitCheck is its own checked employee/inspector or Safety.View/'
  'Inspect/Manage. Expected errors: NO_ACTIVE_TENANT, UNSUPPORTED_ENTITY_TYPE, '
  'PERMISSION_DENIED.';

-- 7.15 safety_timeline — wider-audience wrapper over public.activity_timeline,
--      mirroring Assets Management's own asset_timeline() shape, generic
--      across all six of this module's entity types.
create or replace function public.safety_timeline(p_entity_type text, p_entity_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_authorized boolean := false;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if p_entity_type not in (
    'SafetyPpeType', 'SafetyPpeSet', 'SafetyAssetExt', 'SafetyIssuance', 'SafetyFieldVisit', 'SafetyFieldVisitCheck'
  ) then
    raise exception 'UNSUPPORTED_ENTITY_TYPE';
  end if;

  if p_entity_type in ('SafetyPpeType', 'SafetyPpeSet') then
    -- Catalogue entities: same broad "any tenant member" visibility as their
    -- own tables' own read policies in section 3 above.
    v_authorized := true;
  elsif p_entity_type = 'SafetyAssetExt' then
    v_authorized := exists (
      select 1 from public.safety_asset_ext ext
      join public.assets a on a.id = ext.asset_id and a.tenant_id = ext.tenant_id
      where ext.id = p_entity_id and ext.tenant_id = v_tenant and not ext.is_deleted
        and (
          a.current_custodian_user_id = auth.uid()
          or public.has_permission('Safety.View') or public.has_permission('Safety.Inspect') or public.has_permission('Safety.Manage')
        )
    );
  elsif p_entity_type = 'SafetyIssuance' then
    v_authorized := exists (
      select 1 from public.safety_issuances iss
      where iss.id = p_entity_id and iss.tenant_id = v_tenant and not iss.is_deleted
        and (
          iss.employee_id = auth.uid() or iss.issued_by = auth.uid()
          or public.has_permission('Safety.View') or public.has_permission('Safety.Issue') or public.has_permission('Safety.Manage')
        )
    );
  elsif p_entity_type = 'SafetyFieldVisit' then
    v_authorized := exists (
      select 1 from public.safety_field_visits fv
      where fv.id = p_entity_id and fv.tenant_id = v_tenant and not fv.is_deleted
        and (
          fv.inspector_id = auth.uid()
          or public.has_permission('Safety.View') or public.has_permission('Safety.Inspect') or public.has_permission('Safety.Manage')
        )
    );
  elsif p_entity_type = 'SafetyFieldVisitCheck' then
    v_authorized := exists (
      select 1 from public.safety_field_visit_checks chk
      join public.safety_field_visits fv on fv.id = chk.visit_id and fv.tenant_id = chk.tenant_id
      where chk.id = p_entity_id and chk.tenant_id = v_tenant and not chk.is_deleted
        and (
          chk.employee_id = auth.uid() or chk.checked_by = auth.uid() or fv.inspector_id = auth.uid()
          or public.has_permission('Safety.View') or public.has_permission('Safety.Inspect') or public.has_permission('Safety.Manage')
        )
    );
  end if;

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
        and at.entity_type = p_entity_type
        and at.entity_id = p_entity_id
        and not at.is_deleted
    ) r
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.safety_timeline(text, uuid) from public;
grant execute on function public.safety_timeline(text, uuid) to authenticated;

comment on function public.safety_timeline(text, uuid) is
  'Wider-audience wrapper over public.activity_timeline, generic across all six of this '
  'module''s entity types — activity_timeline_list()''s actor-or-Audit.View gate is too '
  'narrow here, same reasoning as Assets Management''s own asset_timeline(). Authentication: '
  'authenticated. Authorization: per entity_type, mirroring safety_attachment_list()''s own '
  'per-type gates, plus SafetyPpeSet (broadly readable) and SafetyFieldVisit/SafetyAssetExt '
  '(own row or Safety.View/Inspect/Manage). Expected errors: NO_ACTIVE_TENANT, '
  'UNSUPPORTED_ENTITY_TYPE, PERMISSION_DENIED.';

-- 7.16 safety_expiration_scan — service_role-only batch scan. See this
--      migration's own header for why record_activity() is deliberately
--      never called here, and why no scheduler is wired.
create or replace function public.safety_expiration_scan()
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_due_soon_days constant integer := 30;
  v_rec record;
  v_already_notified boolean;
begin
  -- Asset-tracked PPE (safety_asset_ext.expiry_date): notify the asset's
  -- current custodian, if it has one.
  for v_rec in
    select
      e.id as ext_id, e.asset_id, e.expiry_date, a.current_custodian_user_id as recipient_id,
      a.reference as asset_reference
    from public.safety_asset_ext e
    join public.assets a on a.id = e.asset_id and a.tenant_id = e.tenant_id
    where not e.is_deleted and not a.is_deleted
      and e.expiry_date is not null
      and e.expiry_date <= current_date + v_due_soon_days
      and a.current_custodian_user_id is not null
  loop
    select exists (
      select 1 from public.notifications n
      where n.recipient_id = v_rec.recipient_id
        and n.event_code = case when v_rec.expiry_date < current_date then 'SAFETY_PPE_OVERDUE' else 'SAFETY_PPE_EXPIRING' end
        and (n.payload ->> 'safetyExtId') = v_rec.ext_id::text
        and n.created_on > now() - interval '7 days'
        and not n.is_deleted
    ) into v_already_notified;

    if not v_already_notified then
      perform public.notify(
        v_rec.recipient_id, 'System',
        case when v_rec.expiry_date < current_date then 'SAFETY_PPE_OVERDUE' else 'SAFETY_PPE_EXPIRING' end,
        case when v_rec.expiry_date < current_date then 'انتهت صلاحية معدة وقاية' else 'اقتراب انتهاء صلاحية معدة وقاية' end,
        case when v_rec.expiry_date < current_date then 'A PPE item has expired' else 'A PPE item is expiring soon' end,
        'الأصل ' || coalesce(v_rec.asset_reference, '') || ' — تاريخ الانتهاء ' || v_rec.expiry_date::text || '.',
        'Asset ' || coalesce(v_rec.asset_reference, '') || ' — expiry date ' || v_rec.expiry_date::text || '.',
        '/app/safety?asset=' || v_rec.asset_id::text,
        jsonb_build_object('safetyExtId', v_rec.ext_id, 'assetId', v_rec.asset_id, 'expiryDate', v_rec.expiry_date)
      );
    end if;
  end loop;

  -- Directly-issued PPE (safety_issuance_items.expiry_date): notify the
  -- employee it was issued to.
  for v_rec in
    select it.id as item_id, it.expiry_date, iss.employee_id as recipient_id, iss.reference as issuance_reference
    from public.safety_issuance_items it
    join public.safety_issuances iss on iss.id = it.issuance_id and iss.tenant_id = it.tenant_id
    where not it.is_deleted and not iss.is_deleted
      and it.status = 'Issued'
      and it.expiry_date is not null
      and it.expiry_date <= current_date + v_due_soon_days
  loop
    select exists (
      select 1 from public.notifications n
      where n.recipient_id = v_rec.recipient_id
        and n.event_code = case when v_rec.expiry_date < current_date then 'SAFETY_PPE_OVERDUE' else 'SAFETY_PPE_EXPIRING' end
        and (n.payload ->> 'issuanceItemId') = v_rec.item_id::text
        and n.created_on > now() - interval '7 days'
        and not n.is_deleted
    ) into v_already_notified;

    if not v_already_notified then
      perform public.notify(
        v_rec.recipient_id, 'System',
        case when v_rec.expiry_date < current_date then 'SAFETY_PPE_OVERDUE' else 'SAFETY_PPE_EXPIRING' end,
        case when v_rec.expiry_date < current_date then 'انتهت صلاحية معدة وقاية بحوزتك' else 'اقتراب انتهاء صلاحية معدة وقاية بحوزتك' end,
        case when v_rec.expiry_date < current_date then 'A PPE item issued to you has expired' else 'A PPE item issued to you is expiring soon' end,
        'ضمن عملية الصرف ' || coalesce(v_rec.issuance_reference, '') || ' — تاريخ الانتهاء ' || v_rec.expiry_date::text || '.',
        'Under issuance ' || coalesce(v_rec.issuance_reference, '') || ' — expiry date ' || v_rec.expiry_date::text || '.',
        '/app/safety?issuance=' || v_rec.item_id::text,
        jsonb_build_object('issuanceItemId', v_rec.item_id, 'expiryDate', v_rec.expiry_date)
      );
    end if;
  end loop;
end;
$$;
revoke all on function public.safety_expiration_scan() from public;
grant execute on function public.safety_expiration_scan() to service_role;

comment on function public.safety_expiration_scan() is
  'Scans safety_asset_ext and safety_issuance_items for PPE due within 30 days or already '
  'past its expiry date, and calls public.notify() once per affected employee (category '
  'System, event_code SAFETY_PPE_EXPIRING or SAFETY_PPE_OVERDUE), de-duplicated against any '
  'matching notification already sent in the last 7 days. Deliberately does NOT call '
  'public.record_activity() — that function requires public.current_tenant_id(), which is '
  'session-derived and always null for a service-role batch job with no signed-in actor; '
  'public.notify() tolerates that by design (see its own "system context" comment) and '
  'resolves each recipient''s own tenant straight from the recipient row. No pg_cron job or '
  'scheduled edge function invokes this anywhere in the current codebase (confirmed absent) — '
  'wiring one is a deployment decision, out of scope here, exactly like Assets Management''s '
  'own PO/IV precedent. Authentication: service_role only, never granted to authenticated. '
  'Scans across every tenant (a global batch job, not scoped to a session tenant).';

-- 7.17 safety_my_ppe — "My Safety" portal screen data.
create or replace function public.safety_my_ppe(p_employee_id uuid default auth.uid())
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if p_employee_id is distinct from auth.uid()
     and not (public.has_permission('Safety.View') or public.has_permission('Safety.Issue') or public.has_permission('Safety.Manage'))
  then
    raise exception 'PERMISSION_DENIED';
  end if;
  if not exists (select 1 from public.users where id = p_employee_id and tenant_id = v_tenant and not is_deleted) then
    raise exception 'EMPLOYEE_NOT_FOUND';
  end if;

  return coalesce((
    select jsonb_agg(row_to_json(r) order by r.issued_date desc, r.created_on desc)
    from (
      select
        it.id, it.issuance_id, it.ppe_type_id, it.asset_id, it.quantity, it.size,
        it.issued_date, it.expiry_date, it.status,
        pt.name_ar as ppe_type_name_ar, pt.name_en as ppe_type_name_en, pt.category,
        iss.reference as issuance_reference, it.created_on
      from public.safety_issuance_items it
      join public.safety_issuances iss on iss.id = it.issuance_id and iss.tenant_id = it.tenant_id
      join public.safety_ppe_types pt on pt.id = it.ppe_type_id and pt.tenant_id = it.tenant_id
      where it.tenant_id = v_tenant
        and iss.employee_id = p_employee_id
        and not it.is_deleted
    ) r
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.safety_my_ppe(uuid) from public;
grant execute on function public.safety_my_ppe(uuid) to authenticated;

comment on function public.safety_my_ppe(uuid) is
  'Every PPE item ever issued to one employee, newest first, with its PPE-type label and '
  'current status. Authentication: authenticated. Authorization: the caller viewing their '
  'own record (default), or Safety.View/Issue/Manage to view another employee''s. Expected '
  'errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, EMPLOYEE_NOT_FOUND.';

-- 7.18 safety_ppe_requirements_for_employee — resolves which PPE sets (and
--      therefore which PPE types) currently apply to an employee via the
--      Audience Engine's own 'SafetyPpeSet'/'Position' extension above.
create or replace function public.safety_ppe_requirements_for_employee(p_employee_id uuid default auth.uid())
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if p_employee_id is distinct from auth.uid()
     and not (public.has_permission('Safety.View') or public.has_permission('Safety.Issue') or public.has_permission('Safety.Manage'))
  then
    raise exception 'PERMISSION_DENIED';
  end if;
  if not exists (select 1 from public.users where id = p_employee_id and tenant_id = v_tenant and not is_deleted) then
    raise exception 'EMPLOYEE_NOT_FOUND';
  end if;

  return coalesce((
    select jsonb_agg(distinct jsonb_build_object(
      'ppeTypeId', pt.id, 'nameAr', pt.name_ar, 'nameEn', pt.name_en, 'category', pt.category,
      'ppeSetId', s.id, 'ppeSetNameAr', s.name_ar, 'ppeSetNameEn', s.name_en,
      'quantity', si.quantity, 'reissueIntervalDays', si.reissue_interval_days, 'isMandatory', si.is_mandatory
    ))
    from public.safety_ppe_sets s
    join public.safety_ppe_set_items si on si.set_id = s.id and si.tenant_id = s.tenant_id and not si.is_deleted
    join public.safety_ppe_types pt on pt.id = si.ppe_type_id and pt.tenant_id = s.tenant_id and not pt.is_deleted
    where s.tenant_id = v_tenant
      and not s.is_deleted
      and s.is_active
      and public.audience_matches('SafetyPpeSet', s.id, p_employee_id)
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.safety_ppe_requirements_for_employee(uuid) from public;
grant execute on function public.safety_ppe_requirements_for_employee(uuid) to authenticated;

comment on function public.safety_ppe_requirements_for_employee(uuid) is
  'Every PPE type required for one employee, resolved from every active PPE Set whose own '
  'Audience Engine rule (entity_type ''SafetyPpeSet'') matches them — including, since this '
  'migration''s own Audience Engine extension, sets targeted by their Position. Authentication: '
  'authenticated. Authorization: the caller resolving their own requirements (default), or '
  'Safety.View/Issue/Manage to resolve another employee''s. Expected errors: '
  'NO_ACTIVE_TENANT, PERMISSION_DENIED, EMPLOYEE_NOT_FOUND.';

-- 7.19 safety_compliance_summary — the Compliance Dashboard screen's own data
-- source (spec: "عدد الموظفين المطلوب منهم معدات / عدد الذين استلموا / عدد
-- الناقص لديهم أدوات"). This is exactly safety_ppe_requirements_for_employee()
-- (7.18)'s own audience_matches() loop, batched across every candidate
-- employee instead of one — no dedicated report table, no duplicated
-- requirement logic. Bounded by the caller's own department/project/site/
-- position filter; an unfiltered call scans the tenant's active employees
-- once, the same bounded-default precedent Assets Management's own report
-- screen already established (never literally unbounded across tenants).
create or replace function public.safety_compliance_summary(
  p_department_id uuid default null,
  p_project_id uuid default null,
  p_site_id uuid default null,
  p_position_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_required_count integer := 0;
  v_covered_count integer := 0;
  v_partial_count integer := 0;
  v_missing_count integer := 0;
  v_employee record;
  v_required_types uuid[];
  v_issued_types uuid[];
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not (public.has_permission('Safety.View') or public.has_permission('Safety.Issue') or public.has_permission('Safety.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;

  for v_employee in
    select u.id
    from public.users u
    where u.tenant_id = v_tenant and not u.is_deleted and u.is_active
      and (p_department_id is null or u.department_id = p_department_id)
      and (p_project_id is null or u.project_id = p_project_id)
      and (p_site_id is null or u.site_id = p_site_id)
      and (p_position_id is null or u.position_id = p_position_id)
  loop
    select coalesce(array_agg(distinct si.ppe_type_id), array[]::uuid[])
    into v_required_types
    from public.safety_ppe_sets s
    join public.safety_ppe_set_items si on si.set_id = s.id and si.tenant_id = s.tenant_id and not si.is_deleted
    where s.tenant_id = v_tenant and not s.is_deleted and s.is_active
      and public.audience_matches('SafetyPpeSet', s.id, v_employee.id);

    if array_length(v_required_types, 1) is null then
      continue; -- not covered by any active PPE Set at all — excluded from the denominator
    end if;
    v_required_count := v_required_count + 1;

    select coalesce(array_agg(distinct ii.ppe_type_id), array[]::uuid[])
    into v_issued_types
    from public.safety_issuance_items ii
    join public.safety_issuances i on i.id = ii.issuance_id and i.tenant_id = ii.tenant_id
    where ii.tenant_id = v_tenant and not ii.is_deleted and ii.status = 'Issued'
      and i.employee_id = v_employee.id;

    if v_issued_types @> v_required_types then
      v_covered_count := v_covered_count + 1;
    elsif v_issued_types && v_required_types then
      v_partial_count := v_partial_count + 1;
    else
      v_missing_count := v_missing_count + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'requiredCount', v_required_count,
    'fullyIssuedCount', v_covered_count,
    'partiallyIssuedCount', v_partial_count,
    'notIssuedCount', v_missing_count
  );
end;
$$;
revoke all on function public.safety_compliance_summary(uuid, uuid, uuid, uuid) from public;
grant execute on function public.safety_compliance_summary(uuid, uuid, uuid, uuid) to authenticated;

comment on function public.safety_compliance_summary(uuid, uuid, uuid, uuid) is
  'Aggregate PPE compliance across every active employee matching the given department/'
  'project/site/position filter (all optional; omitting every filter scans the whole '
  'tenant''s active employees once). For each employee covered by at least one active PPE '
  'Set, compares required vs currently-Issued PPE types (fully issued / partially issued / '
  'not issued at all). Authentication: authenticated. Authorization: Safety.View, '
  'Safety.Issue, or Safety.Manage. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED.';

-- ----------------------------------------------------------------------------
-- 8. Module registration + navigation (mirrors migration 202608060054's own
--    ASSETS registration exactly).
-- ----------------------------------------------------------------------------
-- display_order 195: 180 is already taken by 'AI' (202608040012) and 190 by
-- 'ASSETS' (202608060055's own closing-audit fix for its earlier collision
-- with 'PUBLIC_API' at 170) — 195 is confirmed unused across the whole
-- platform_modules catalogue.
insert into public.platform_modules (code, name_ar, name_en, category, display_order, is_core)
values ('SAFETY', 'إدارة السلامة', 'Safety Management', 'Core', 195, false)
on conflict (code) do nothing;

update public.platform_licenses
set module_codes = array_append(module_codes, 'SAFETY')
where code = 'FREE' and not ('SAFETY' = any (module_codes));

insert into public.app_screens (code, module_code, area, group_code, name_ar, name_en, icon, route, display_order, min_role_rank)
values
  ('PORTAL_SAFETY', 'SAFETY', 'Portal', 'Workspace', 'سلامتي', 'My Safety', 'shield', 'safety', 200, 1),
  ('ADMIN_SAFETY_PPE_TYPES', 'SAFETY', 'Admin', 'Safety', 'أنواع مهمات الوقاية', 'PPE Types', 'hard-hat', 'admin/safety-ppe-types', 10, 3),
  ('ADMIN_SAFETY_PPE_SETS', 'SAFETY', 'Admin', 'Safety', 'مجموعات مهمات الوقاية', 'PPE Sets', 'shield-check', 'admin/safety-ppe-sets', 20, 3),
  ('ADMIN_SAFETY_ASSETS', 'SAFETY', 'Admin', 'Safety', 'مهمات الوقاية كأصول', 'PPE Assets', 'package-check', 'admin/safety-assets', 30, 3),
  ('ADMIN_SAFETY_ISSUANCES', 'SAFETY', 'Admin', 'Safety', 'صرف مهمات الوقاية', 'PPE Issuances', 'clipboard-list', 'admin/safety-issuances', 40, 3),
  ('ADMIN_SAFETY_FIELD_VISITS', 'SAFETY', 'Admin', 'Safety', 'الزيارات الميدانية', 'Field Visits', 'map-pin-check', 'admin/safety-field-visits', 50, 3),
  ('ADMIN_SAFETY_EXPIRATIONS', 'SAFETY', 'Admin', 'Safety', 'صلاحيات على وشك الانتهاء', 'Expiring PPE', 'alarm-clock', 'admin/safety-expirations', 60, 3),
  ('ADMIN_SAFETY_COMPLIANCE', 'SAFETY', 'Admin', 'Safety', 'متابعة الالتزام', 'Compliance', 'gauge', 'admin/safety-compliance', 70, 3),
  ('ADMIN_SAFETY_REPORTS', 'SAFETY', 'Admin', 'Safety', 'تقارير السلامة', 'Safety Reports', 'bar-chart-3', 'admin/safety-reports', 80, 3)
on conflict (code) do update set
  module_code = excluded.module_code, area = excluded.area, group_code = excluded.group_code,
  name_ar = excluded.name_ar, name_en = excluded.name_en, icon = excluded.icon,
  route = excluded.route, display_order = excluded.display_order, min_role_rank = excluded.min_role_rank,
  is_active = true, updated_on = now();

-- ----------------------------------------------------------------------------
-- 9. attachment_attach() hardening for this module's three attachable
--    entity types.
--
-- attachment_attach() (202608050040, already hardened once for entity_type
-- = 'Asset' by migration 202608060054) only ever checked the CALLER'S
-- relationship to the storage object — never the caller's relationship to
-- the entity being attached to, for any entity_type it doesn't explicitly
-- narrow. Without this section, any tenant member who has ever uploaded any
-- file could attach it to any SafetyPpeType/SafetyIssuance/
-- SafetyFieldVisitCheck row, with zero Safety permission and no relationship
-- to it. This full re-declaration adds three new narrowing branches, one per
-- entity_type this module owns; the pre-existing 'Asset' branch (Assets
-- Management's own addition) and every other line of the function are
-- reproduced byte-identical. Placed in this migration (not 202608050040 or
-- 202608060054) because this module's own tables don't exist until now.
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
  'or the reporter of an open maintenance case on it (Assets Management''s own hardening); '
  'for ''SafetyPpeType'' — Safety.Manage; for ''SafetyIssuance'' — Safety.Issue/Manage or the '
  'issuance''s own employee/issuer; for ''SafetyFieldVisitCheck'' — Safety.Inspect/Manage or '
  'the check''s own checker/visit inspector. Every other entity_type keeps the original, '
  'unnarrowed owner/Storage.Manage-only check. Expected errors: NO_TENANT_CONTEXT, '
  'ENTITY_TYPE_REQUIRED, ENTITY_ID_REQUIRED, STORAGE_OBJECT_NOT_FOUND, PERMISSION_DENIED.';

-- ----------------------------------------------------------------------------
-- Mandatory closer: every migration batch ends with this, or a GRANT earlier
-- in the same file (or an earlier migration) re-materializes the function's
-- PUBLIC-execute footgun (see 202608050037's header for what that means).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
