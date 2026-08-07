-- ============================================================================
-- 054 — Assets Management
--
-- FourthUpdate.md's Assets Management spec (lines 476-789). Discovery
-- confirmed zero existing code for this module — only three pre-reserved
-- Number Generator source codes owned by 'Assets' ('AS'/'WO'/'IN', migration
-- 202608050039) and the spec text itself. Two more codes are pre-reserved
-- under the same owner_module ('PO'/'IV', Purchase Order / Invoice) but the
-- spec never describes a purchasing workflow anywhere — the asset record
-- only carries a plain "Supplier" text field. Per the orchestrating session's
-- own scope decision, PO/IV are OUT OF SCOPE here: no purchase-order or
-- invoice table, RPC, or generate_number('PO'/'IV', ...) call exists in this
-- migration, and none should be added later without a real purchasing spec
-- to build against.
--
-- PHILOSOPHY (the spec's own words): this module is not built around "the
-- asset" as an editable record. It is built around the asset LIFECYCLE.
-- public.asset_transactions is the single source of truth; public.assets'
-- current_status/current_custodian_user_id/current_custody_unit_id columns
-- are only a derived snapshot of the latest transaction. That rule is
-- enforced structurally, not just by convention: public.assets carries a
-- RESTRICTIVE tenant-isolation policy and a PERMISSIVE read policy, but no
-- direct-write policy of any kind — every column on that row, including at
-- creation, can only ever be touched by this migration's own SECURITY
-- DEFINER RPCs, which apply the spec's business rules before ever moving the
-- snapshot. The same is true of asset_transactions/asset_reservations/
-- asset_maintenance/asset_inventory_* — all read-only to PostgREST, all
-- write-only through an RPC.
--
-- Reused, not reimplemented (bbnovix_contract.md §12 / the platform's
-- no-duplicate-service rule):
--   - generate_number('AS'/'WO'/'IN', tenant)   the three number sources this
--     module owns. Called exactly ONCE per asset / per maintenance case / per
--     inventory session, at creation time — never per asset_transactions row.
--     A routine Issue/Receive/Transfer/Return happens far more often than an
--     asset is created, and each such row is already fully traceable via its
--     own uuid id plus its parent asset's own 'AS' reference (and, where
--     relevant, related_maintenance_id/related_inventory_session_id/
--     related_form_id) — minting a fresh human-readable number for every
--     single movement would be allocator overhead with no one who ever reads
--     it, exactly the "number for the sake of a number" anti-pattern
--     INumberGenerator's own header warns against.
--   - public.activity_timeline / record_activity()   the Timeline screen
--     (explicitly called "the most important screen" by the spec) is this,
--     not a bespoke log. record_activity() is granted only to service_role
--     (migration 202608050041), so every call here happens from inside this
--     module's own SECURITY DEFINER RPCs, which already validated the
--     caller's authorization on that specific asset — the RPC runs as its
--     owner (the same role that owns record_activity itself), so no extra
--     grant is needed or given. asset_timeline() is this module's own
--     wider-audience wrapper (Assets.View OR current custodian OR
--     Assets.Manage), exactly the pattern activity_timeline's own migration
--     document told every future business module to build for itself,
--     because activity_timeline_list()'s actor-or-Audit.View gate is too
--     narrow for "anyone who can see this asset can see its history".
--   - public.attachments / attachment_attach() / attachment_mark_for_removal()
--     for photos/attachments on assets, disposal requests, and inventory
--     scans (entityType 'Asset', area 'assets' — src/lib/platformCore/
--     attachments.js's JSDoc already anticipated this module by name).
--     asset_attachment_list() is this module's own wider-audience wrapper,
--     same reasoning as asset_timeline().
--   - public.forms / public.templates / approval_submit() / approval_act()
--     for Disposal. Disposal is never direct (spec's own explicit rule): this
--     migration adds one new template per tenant (code 'FM-SH-AST-D-26-0001
--     \V1.0', category 'Assets') routed through a brand new, disposal-only
--     approval_scheme ('ASSET_DISPOSAL') built from each tenant's own
--     already-existing 'FINAL_APPROVAL' signing capacity — a single-step
--     chain, since disposal approval authority is asset-specific, not a
--     multi-role workflow the spec ever describes. asset_dispose_request()
--     only ever inserts a Draft form; approval_submit()/approval_act() (both
--     pre-existing, both UNCHANGED here) do the actual routing. The only new
--     code this migration adds to public.forms' own lifecycle is a single
--     AFTER UPDATE trigger, asset_dispose_on_form_approved(), narrowly scoped
--     by an EXACT match against this module's own disposal template code
--     (never a prefix/LIKE match, which a forged template under a different
--     code could satisfy) and re-checking the same Assets.Manage/in-custody
--     gates asset_dispose_request() itself enforces — it never reads or
--     assumes anything about any other module's forms, the same safe pattern
--     already established by Verification's publish_form_verification
--     trigger (migration 202608040017).
--   - public.notify()   category 'Approval' for AS_TRANSFER_PENDING_ACCEPT
--     and AS_MAINTENANCE_APPROVAL_NEEDED (both are literally "awaiting your
--     approve/reject action", exactly what 'Approval' already means
--     elsewhere), category 'System' for AS_TRANSFER_ACCEPTED/
--     AS_MAINTENANCE_COMPLETED (informational only). notify() has no
--     'Assets' category and, per the platform's own layering rule, a
--     business-module migration never modifies a Platform Core function —
--     the closest existing category is used instead, disambiguated by
--     p_event_code.
--   - public.departments / public.projects / public.sites   custody units'
--     site/project/department are FKs onto these, never a third copy.
--   - public.has_permission()   five new codes, Assets.Manage/Operate/
--     Maintain/Inventory/View, granted to PLATFORM_ADMIN/SYSTEM_ADMIN in
--     every existing tenant, same insert-then-role_permissions-join shape
--     migration 202608040017 already used for Certificates.Manage/
--     Verification.View.
--
-- PERSON-TO-PERSON TRANSFER (spec's own explicit flow): asset_transaction_
-- create() is the one unified entry point for Receive/Issue/Transfer/Return/
-- Lost/Found/Reserve/Release (never Dispose — only the approval trigger below
-- creates that row — and never MaintenanceOut/MaintenanceReturn — only
-- asset_maintenance_advance() creates those). A 'Transfer' naming an actual
-- person creates the row as PendingAcceptance and does NOT touch the assets
-- snapshot; asset_transfer_accept() is what finally applies it; asset_
-- transfer_reject() marks it Rejected with nothing to undo, because nothing
-- was ever applied in the first place — exactly the spec's own "the snapshot
-- was never changed to begin with" description of a rejection.
--
-- Two RPC parameter lists in the locked design put a required parameter
-- after an optional (default-valued) one — Postgres requires every
-- parameter after the first DEFAULT to also carry a default, so
-- asset_reserve()'s and asset_inventory_scan()'s parameter ORDER (only the
-- order — every parameter name and semantics is unchanged, and both were
-- always meant to be called with named arguments from the client, same as
-- every other multi-optional-parameter RPC in this codebase) is adjusted
-- here to the minimum reordering that makes the function definition valid
-- SQL: required parameters first, defaulted ones trailing.
--
-- The new 'ASSET_DISPOSAL' approval_scheme/approval_scheme_roles/template
-- rows are backfilled below for every tenant that exists TODAY (section 5),
-- and kept in sync for every tenant provisioned AFTER this migration ships
-- by a dedicated trigger (section 5.1) that reacts to that tenant's own
-- FINAL_APPROVAL approval_role row being created — without this migration
-- ever needing to edit bootstrap_tenant_defaults() itself (supabase/
-- migrations/202608040019_tenant_provisioning.sql), out of scope to touch
-- from this single-file migration.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Permission catalogue
-- ----------------------------------------------------------------------------
insert into public.permissions (code, module, description) values
  ('Assets.Manage', 'Assets', 'Manage asset groups, custody units, and the full asset catalogue'),
  ('Assets.Operate', 'Assets', 'Issue, receive, transfer and reserve assets in day-to-day operation'),
  ('Assets.Maintain', 'Assets', 'Approve sending an asset out for maintenance'),
  ('Assets.Inventory', 'Assets', 'Create and run asset inventory (counting) sessions'),
  ('Assets.View', 'Assets', 'View the company-wide asset catalogue, timeline and reports')
on conflict (code) do update set module = excluded.module, description = excluded.description;

insert into public.role_permissions (tenant_id, role_id, permission_id)
select r.tenant_id, r.id, p.id
from public.roles r
join public.permissions p on p.code in (
  'Assets.Manage', 'Assets.Operate', 'Assets.Maintain', 'Assets.Inventory', 'Assets.View'
)
where r.code in ('PLATFORM_ADMIN', 'SYSTEM_ADMIN') and not r.is_deleted
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- 2. Tables — standard shape (tenant_id + audit/soft-delete/row_version
--    columns) per the platform's own hard contract, section 10 of the
--    reusable-infrastructure brief this migration was built against.
--    Cross-table foreign keys are added as a dedicated section (4) after
--    every table exists, so forward references (e.g. asset_transactions ->
--    asset_maintenance, created later in this same list) never need the
--    tables reordered.
-- ----------------------------------------------------------------------------

-- 2.1 asset_groups
create table if not exists public.asset_groups (
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
create index if not exists idx_asset_groups_tenant on public.asset_groups (tenant_id);
create unique index if not exists uq_asset_groups_code
  on public.asset_groups (tenant_id, lower(code)) where code is not null and not is_deleted;
create unique index if not exists uq_asset_groups_tenant_id on public.asset_groups (tenant_id, id);

-- 2.2 asset_custody_units — "Asset Custody Unit" / "Asset Store", deliberately
--     not always literally a warehouse (spec's own wording).
create table if not exists public.asset_custody_units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name_ar text not null,
  name_en text,
  site_id uuid,
  project_id uuid,
  department_id uuid,
  notes text,
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
create index if not exists idx_asset_custody_units_tenant on public.asset_custody_units (tenant_id);
create unique index if not exists uq_asset_custody_units_code
  on public.asset_custody_units (tenant_id, lower(code)) where not is_deleted;
create unique index if not exists uq_asset_custody_units_tenant_id on public.asset_custody_units (tenant_id, id);

-- 2.3 asset_custody_unit_members — plural, on purpose: Owner, Custodian and
--     Backup Custodian are all assignable, and all many-to-many (spec rule:
--     "not one person").
create table if not exists public.asset_custody_unit_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  custody_unit_id uuid not null,
  user_id uuid not null,
  role_code text not null check (role_code in ('Owner', 'Custodian', 'BackupCustodian')),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);
create index if not exists idx_asset_custody_unit_members_tenant on public.asset_custody_unit_members (tenant_id);
create index if not exists idx_asset_custody_unit_members_unit
  on public.asset_custody_unit_members (tenant_id, custody_unit_id);
create unique index if not exists uq_asset_custody_unit_members
  on public.asset_custody_unit_members (tenant_id, custody_unit_id, user_id, role_code);

-- 2.4 assets — the registry row. Every field below is descriptive only;
--     status/current_custodian_user_id/current_custody_unit_id are the
--     lifecycle SNAPSHOT and are never written directly outside this
--     migration's own transaction-applying RPCs (see header).
create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  group_id uuid,
  reference text not null,
  name_ar text not null,
  name_en text,
  -- 'Reserved' is deliberately not a status value: a reservation is a
  -- future-dated overlay (asset_reservations) that coexists with whatever
  -- the asset's live status already is (usually Available) rather than
  -- replacing it — see asset_reserve(), which never writes assets.status.
  status text not null default 'Available'
    check (status in ('Available', 'InUse', 'InMaintenance', 'Lost', 'Disposed')),
  color text,
  brand text,
  model text,
  serial_no text,
  imei text,
  manufacturer text,
  purchase_date date,
  warranty_until date,
  supplier text,
  current_custody_unit_id uuid,
  current_custodian_user_id uuid,
  parent_asset_id uuid,
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
create index if not exists idx_assets_tenant on public.assets (tenant_id);
create unique index if not exists uq_assets_reference
  on public.assets (tenant_id, reference) where not is_deleted;
create unique index if not exists uq_assets_tenant_id on public.assets (tenant_id, id);
create index if not exists idx_assets_custodian on public.assets (tenant_id, current_custodian_user_id);
create index if not exists idx_assets_custody_unit on public.assets (tenant_id, current_custody_unit_id);
create index if not exists idx_assets_group on public.assets (tenant_id, group_id);
create index if not exists idx_assets_status on public.assets (tenant_id, status);
create index if not exists idx_assets_parent on public.assets (tenant_id, parent_asset_id);

-- 2.5 asset_maintenance — an independent lifecycle (Reported -> Approved ->
--     Sent -> UnderMaintenance -> Completed -> Returned -> Closed), not a
--     screen restricted to the warehouse keeper: any user may report.
create table if not exists public.asset_maintenance (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  asset_id uuid not null,
  reference text not null,
  status text not null default 'Reported'
    check (status in ('Reported', 'Approved', 'Sent', 'UnderMaintenance', 'Completed', 'Returned', 'Closed', 'Rejected')),
  issue_description text not null,
  reported_by uuid not null default auth.uid(),
  reported_on timestamptz not null default now(),
  approved_by uuid,
  approved_on timestamptz,
  vendor_text text,
  sent_on timestamptz,
  expected_return_date date,
  completed_on timestamptz,
  returned_on timestamptz,
  closed_on timestamptz,
  cost numeric(12,2),
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
create index if not exists idx_asset_maintenance_tenant on public.asset_maintenance (tenant_id);
create index if not exists idx_asset_maintenance_asset on public.asset_maintenance (tenant_id, asset_id);
create unique index if not exists uq_asset_maintenance_reference
  on public.asset_maintenance (tenant_id, reference) where not is_deleted;
create unique index if not exists uq_asset_maintenance_tenant_id on public.asset_maintenance (tenant_id, id);

-- 2.6 asset_inventory_sessions — "الجرد": a counting/verification cycle.
create table if not exists public.asset_inventory_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  reference text not null,
  name_ar text not null,
  name_en text,
  status text not null default 'Draft'
    check (status in ('Draft', 'InProgress', 'Completed', 'Cancelled')),
  start_date date,
  end_date date,
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
create index if not exists idx_asset_inventory_sessions_tenant on public.asset_inventory_sessions (tenant_id);
create unique index if not exists uq_asset_inventory_sessions_reference
  on public.asset_inventory_sessions (tenant_id, reference) where not is_deleted;
create unique index if not exists uq_asset_inventory_sessions_tenant_id
  on public.asset_inventory_sessions (tenant_id, id);

-- 2.7 asset_transactions — THE single source of truth for the whole module.
create table if not exists public.asset_transactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  asset_id uuid not null,
  transaction_type text not null check (transaction_type in (
    'Receive', 'Issue', 'Transfer', 'Return', 'Dispose',
    'MaintenanceOut', 'MaintenanceReturn', 'Lost', 'Found', 'Reserve', 'Release'
  )),
  status text not null default 'Completed'
    check (status in ('Completed', 'PendingAcceptance', 'Rejected', 'Cancelled')),
  from_custodian_user_id uuid,
  to_custodian_user_id uuid,
  from_custody_unit_id uuid,
  to_custody_unit_id uuid,
  reason text,
  notes text,
  related_maintenance_id uuid,
  related_inventory_session_id uuid,
  related_form_id uuid,
  performed_by uuid not null default auth.uid(),
  performed_on timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);
create index if not exists idx_asset_transactions_tenant on public.asset_transactions (tenant_id);
create index if not exists idx_asset_transactions_asset
  on public.asset_transactions (tenant_id, asset_id, performed_on desc);

-- 2.8 asset_reservations — a claim on an asset before physical delivery;
--     any conflicting delivery during the window must be blocked (enforced
--     in asset_reserve() below, not by a DB exclusion constraint, to keep
--     the conflict check's error message ownership inside the RPC layer).
create table if not exists public.asset_reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  asset_id uuid not null,
  reserved_for_user_id uuid,
  reserved_for_project_id uuid,
  purpose text,
  start_date date not null,
  end_date date not null,
  status text not null default 'Active'
    check (status in ('Active', 'Fulfilled', 'Released', 'Cancelled')),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  constraint chk_asset_reservations_date_range check (end_date >= start_date)
);
create index if not exists idx_asset_reservations_tenant on public.asset_reservations (tenant_id);
create index if not exists idx_asset_reservations_asset
  on public.asset_reservations (tenant_id, asset_id, status);

-- 2.9 asset_inventory_session_units — custody units in an inventory session's scope.
create table if not exists public.asset_inventory_session_units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  session_id uuid not null,
  custody_unit_id uuid not null,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);
create index if not exists idx_asset_inv_session_units_tenant on public.asset_inventory_session_units (tenant_id);
create unique index if not exists uq_asset_inv_session_units
  on public.asset_inventory_session_units (tenant_id, session_id, custody_unit_id);

-- 2.10 asset_inventory_session_members — member users who will scan.
create table if not exists public.asset_inventory_session_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  session_id uuid not null,
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
create index if not exists idx_asset_inv_session_members_tenant on public.asset_inventory_session_members (tenant_id);
create unique index if not exists uq_asset_inv_session_members
  on public.asset_inventory_session_members (tenant_id, session_id, user_id);

-- 2.11 asset_inventory_scans — one row per scan. 'Missing' is never inserted
--      by a scanner (spec's own explicit rule — "you cannot scan something
--      absent"); it is only ever produced by asset_inventory_session_
--      complete()'s auto-generation pass below.
create table if not exists public.asset_inventory_scans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  session_id uuid not null,
  asset_id uuid,
  scanned_code text,
  result_status text not null check (result_status in (
    'Found', 'Missing', 'Damaged', 'WrongLocation', 'WrongCustodian',
    'NeedsMaintenance', 'Disposed', 'UnexpectedAsset', 'BarcodeMissing'
  )),
  expected_custody_unit_id uuid,
  expected_custodian_user_id uuid,
  notes text,
  scanned_by uuid,
  scanned_on timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);
create index if not exists idx_asset_inventory_scans_tenant on public.asset_inventory_scans (tenant_id);
create index if not exists idx_asset_inventory_scans_session on public.asset_inventory_scans (tenant_id, session_id);
create index if not exists idx_asset_inventory_scans_asset on public.asset_inventory_scans (tenant_id, asset_id);
-- Backs asset_inventory_scan()'s "already scanned this session" rule at the
-- database level (not just the app-level check-then-insert), so two
-- concurrent scans of the same asset in the same session can't both slip
-- past the check before either commits.
create unique index if not exists uq_asset_inventory_scans_active
  on public.asset_inventory_scans (tenant_id, session_id, asset_id)
  where asset_id is not null and result_status <> 'Missing' and not is_deleted;

-- ----------------------------------------------------------------------------
-- 3. Triggers (apply_row_defaults + write_audit_log) and RLS — one pass
--    across all 11 new tables, same idiom as multitenant_foundation's own
--    business_tables loop.
-- ----------------------------------------------------------------------------
do $$
declare
  tbl text;
  business_tables text[] := array[
    'asset_groups', 'asset_custody_units', 'asset_custody_unit_members', 'assets',
    'asset_maintenance', 'asset_inventory_sessions', 'asset_transactions',
    'asset_reservations', 'asset_inventory_session_units', 'asset_inventory_session_members',
    'asset_inventory_scans'
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

-- Registry-style tables: broadly readable to any tenant member (same
-- openness as public.departments/public.projects/public.sites), because the
-- spec requires ANY user to be able to identify an asset to report
-- maintenance on it, with no separate "browse" permission gate. No write
-- policy exists on any of these three — see header, "never edit the
-- snapshot directly".
drop policy if exists "members read asset groups" on public.asset_groups;
create policy "members read asset groups" on public.asset_groups
  for select to authenticated using (not is_deleted);

drop policy if exists "members read custody units" on public.asset_custody_units;
create policy "members read custody units" on public.asset_custody_units
  for select to authenticated using (not is_deleted);

drop policy if exists "members read custody unit members" on public.asset_custody_unit_members;
create policy "members read custody unit members" on public.asset_custody_unit_members
  for select to authenticated using (not is_deleted);

drop policy if exists "members read assets" on public.assets;
create policy "members read assets" on public.assets
  for select to authenticated using (not is_deleted);

-- Transactional/log tables: readable by whoever holds an Assets permission,
-- or is a party to the specific row (the same "own row or permitted" shape
-- already used by public.attachments/public.activity_timeline).
drop policy if exists "members read asset transactions" on public.asset_transactions;
create policy "members read asset transactions" on public.asset_transactions
  for select to authenticated
  using (
    not is_deleted and (
      performed_by = auth.uid()
      or from_custodian_user_id = auth.uid()
      or to_custodian_user_id = auth.uid()
      or public.has_permission('Assets.View')
      or public.has_permission('Assets.Manage')
      or public.has_permission('Assets.Operate')
    )
  );

drop policy if exists "members read asset reservations" on public.asset_reservations;
create policy "members read asset reservations" on public.asset_reservations
  for select to authenticated
  using (
    not is_deleted and (
      reserved_for_user_id = auth.uid()
      or public.has_permission('Assets.View')
      or public.has_permission('Assets.Manage')
      or public.has_permission('Assets.Operate')
    )
  );

drop policy if exists "members read asset maintenance" on public.asset_maintenance;
create policy "members read asset maintenance" on public.asset_maintenance
  for select to authenticated
  using (
    not is_deleted and (
      reported_by = auth.uid()
      or approved_by = auth.uid()
      or public.has_permission('Assets.View')
      or public.has_permission('Assets.Manage')
      or public.has_permission('Assets.Maintain')
    )
  );

drop policy if exists "members read inventory sessions" on public.asset_inventory_sessions;
create policy "members read inventory sessions" on public.asset_inventory_sessions
  for select to authenticated
  using (
    not is_deleted and (
      public.has_permission('Assets.Inventory')
      or public.has_permission('Assets.Manage')
      or exists (
        select 1 from public.asset_inventory_session_members m
        where m.session_id = asset_inventory_sessions.id
          and m.tenant_id = asset_inventory_sessions.tenant_id
          and m.user_id = auth.uid()
          and not m.is_deleted
      )
    )
  );

drop policy if exists "members read inventory session units" on public.asset_inventory_session_units;
create policy "members read inventory session units" on public.asset_inventory_session_units
  for select to authenticated
  using (
    not is_deleted and (
      public.has_permission('Assets.Inventory')
      or public.has_permission('Assets.Manage')
      or exists (
        select 1 from public.asset_inventory_session_members m
        where m.session_id = asset_inventory_session_units.session_id
          and m.tenant_id = asset_inventory_session_units.tenant_id
          and m.user_id = auth.uid()
          and not m.is_deleted
      )
    )
  );

drop policy if exists "members read inventory session members" on public.asset_inventory_session_members;
create policy "members read inventory session members" on public.asset_inventory_session_members
  for select to authenticated
  using (
    not is_deleted and (
      user_id = auth.uid()
      or public.has_permission('Assets.Inventory')
      or public.has_permission('Assets.Manage')
    )
  );

drop policy if exists "members read inventory scans" on public.asset_inventory_scans;
create policy "members read inventory scans" on public.asset_inventory_scans
  for select to authenticated
  using (
    not is_deleted and (
      scanned_by = auth.uid()
      or public.has_permission('Assets.Inventory')
      or public.has_permission('Assets.Manage')
    )
  );

-- ----------------------------------------------------------------------------
-- 4. Cross-tenant relationship guards — composite foreign keys everywhere,
--    same idiom as multitenant_foundation.sql section 8.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_custody_units_site_same_tenant') then
    alter table public.asset_custody_units
      add constraint fk_asset_custody_units_site_same_tenant
      foreign key (tenant_id, site_id) references public.sites (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_custody_units_project_same_tenant') then
    alter table public.asset_custody_units
      add constraint fk_asset_custody_units_project_same_tenant
      foreign key (tenant_id, project_id) references public.projects (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_custody_units_department_same_tenant') then
    alter table public.asset_custody_units
      add constraint fk_asset_custody_units_department_same_tenant
      foreign key (tenant_id, department_id) references public.departments (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_acu_members_unit_same_tenant') then
    alter table public.asset_custody_unit_members
      add constraint fk_acu_members_unit_same_tenant
      foreign key (tenant_id, custody_unit_id) references public.asset_custody_units (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_acu_members_user_same_tenant') then
    alter table public.asset_custody_unit_members
      add constraint fk_acu_members_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_assets_group_same_tenant') then
    alter table public.assets
      add constraint fk_assets_group_same_tenant
      foreign key (tenant_id, group_id) references public.asset_groups (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_assets_custody_unit_same_tenant') then
    alter table public.assets
      add constraint fk_assets_custody_unit_same_tenant
      foreign key (tenant_id, current_custody_unit_id) references public.asset_custody_units (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_assets_custodian_same_tenant') then
    alter table public.assets
      add constraint fk_assets_custodian_same_tenant
      foreign key (tenant_id, current_custodian_user_id) references public.users (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_assets_parent_same_tenant') then
    alter table public.assets
      add constraint fk_assets_parent_same_tenant
      foreign key (tenant_id, parent_asset_id) references public.assets (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_asset_maintenance_asset_same_tenant') then
    alter table public.asset_maintenance
      add constraint fk_asset_maintenance_asset_same_tenant
      foreign key (tenant_id, asset_id) references public.assets (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_maintenance_reported_by_same_tenant') then
    alter table public.asset_maintenance
      add constraint fk_asset_maintenance_reported_by_same_tenant
      foreign key (tenant_id, reported_by) references public.users (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_maintenance_approved_by_same_tenant') then
    alter table public.asset_maintenance
      add constraint fk_asset_maintenance_approved_by_same_tenant
      foreign key (tenant_id, approved_by) references public.users (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_asset_transactions_asset_same_tenant') then
    alter table public.asset_transactions
      add constraint fk_asset_transactions_asset_same_tenant
      foreign key (tenant_id, asset_id) references public.assets (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_transactions_from_custodian_same_tenant') then
    alter table public.asset_transactions
      add constraint fk_asset_transactions_from_custodian_same_tenant
      foreign key (tenant_id, from_custodian_user_id) references public.users (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_transactions_to_custodian_same_tenant') then
    alter table public.asset_transactions
      add constraint fk_asset_transactions_to_custodian_same_tenant
      foreign key (tenant_id, to_custodian_user_id) references public.users (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_transactions_from_unit_same_tenant') then
    alter table public.asset_transactions
      add constraint fk_asset_transactions_from_unit_same_tenant
      foreign key (tenant_id, from_custody_unit_id) references public.asset_custody_units (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_transactions_to_unit_same_tenant') then
    alter table public.asset_transactions
      add constraint fk_asset_transactions_to_unit_same_tenant
      foreign key (tenant_id, to_custody_unit_id) references public.asset_custody_units (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_transactions_maintenance_same_tenant') then
    alter table public.asset_transactions
      add constraint fk_asset_transactions_maintenance_same_tenant
      foreign key (tenant_id, related_maintenance_id) references public.asset_maintenance (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_transactions_session_same_tenant') then
    alter table public.asset_transactions
      add constraint fk_asset_transactions_session_same_tenant
      foreign key (tenant_id, related_inventory_session_id) references public.asset_inventory_sessions (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_transactions_form_same_tenant') then
    alter table public.asset_transactions
      add constraint fk_asset_transactions_form_same_tenant
      foreign key (tenant_id, related_form_id) references public.forms (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_transactions_performed_by_same_tenant') then
    alter table public.asset_transactions
      add constraint fk_asset_transactions_performed_by_same_tenant
      foreign key (tenant_id, performed_by) references public.users (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_asset_reservations_asset_same_tenant') then
    alter table public.asset_reservations
      add constraint fk_asset_reservations_asset_same_tenant
      foreign key (tenant_id, asset_id) references public.assets (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_reservations_user_same_tenant') then
    alter table public.asset_reservations
      add constraint fk_asset_reservations_user_same_tenant
      foreign key (tenant_id, reserved_for_user_id) references public.users (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_asset_reservations_project_same_tenant') then
    alter table public.asset_reservations
      add constraint fk_asset_reservations_project_same_tenant
      foreign key (tenant_id, reserved_for_project_id) references public.projects (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_aisu_session_same_tenant') then
    alter table public.asset_inventory_session_units
      add constraint fk_aisu_session_same_tenant
      foreign key (tenant_id, session_id) references public.asset_inventory_sessions (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_aisu_unit_same_tenant') then
    alter table public.asset_inventory_session_units
      add constraint fk_aisu_unit_same_tenant
      foreign key (tenant_id, custody_unit_id) references public.asset_custody_units (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_aism_session_same_tenant') then
    alter table public.asset_inventory_session_members
      add constraint fk_aism_session_same_tenant
      foreign key (tenant_id, session_id) references public.asset_inventory_sessions (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_aism_user_same_tenant') then
    alter table public.asset_inventory_session_members
      add constraint fk_aism_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_ais_session_same_tenant') then
    alter table public.asset_inventory_scans
      add constraint fk_ais_session_same_tenant
      foreign key (tenant_id, session_id) references public.asset_inventory_sessions (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_ais_asset_same_tenant') then
    alter table public.asset_inventory_scans
      add constraint fk_ais_asset_same_tenant
      foreign key (tenant_id, asset_id) references public.assets (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_ais_expected_unit_same_tenant') then
    alter table public.asset_inventory_scans
      add constraint fk_ais_expected_unit_same_tenant
      foreign key (tenant_id, expected_custody_unit_id) references public.asset_custody_units (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_ais_expected_custodian_same_tenant') then
    alter table public.asset_inventory_scans
      add constraint fk_ais_expected_custodian_same_tenant
      foreign key (tenant_id, expected_custodian_user_id) references public.users (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_ais_scanned_by_same_tenant') then
    alter table public.asset_inventory_scans
      add constraint fk_ais_scanned_by_same_tenant
      foreign key (tenant_id, scanned_by) references public.users (tenant_id, id);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 5. Disposal approval infrastructure — one new approval_scheme + one
--    approval_scheme_roles row (reusing each tenant's own pre-existing
--    'FINAL_APPROVAL' signing capacity, never a new approval_roles row) +
--    one templates row, backfilled for every tenant that exists today.
-- ----------------------------------------------------------------------------
insert into public.approval_schemes (tenant_id, code, name_ar, name_en, description, is_active)
select t.id, 'ASSET_DISPOSAL', 'اعتماد إتلاف الأصول', 'Asset Disposal Approval',
       'مخطط اعتماد مخصص لطلبات إتلاف الأصول عبر دور الاعتماد النهائي.', true
from public.tenants t
where not t.is_deleted and t.status <> 'Deleted'
  and not exists (
    select 1 from public.approval_schemes s
    where s.tenant_id = t.id and s.code = 'ASSET_DISPOSAL' and not s.is_deleted
  );

insert into public.approval_scheme_roles (tenant_id, scheme_id, approval_role_id, display_order, is_required, allow_self_approval)
select ar.tenant_id, s.id, ar.id, 1, true, false
from public.approval_roles ar
join public.approval_schemes s
  on s.tenant_id = ar.tenant_id and s.code = 'ASSET_DISPOSAL' and not s.is_deleted
where ar.code = 'FINAL_APPROVAL' and not ar.is_deleted
  and not exists (
    select 1 from public.approval_scheme_roles sr
    where sr.scheme_id = s.id and sr.approval_role_id = ar.id
  );

insert into public.templates (
  tenant_id, code, name, name_ar, name_en,
  description, description_ar, description_en,
  category, version, display_order, is_active, approval_scheme_id, requires_final_approval
)
select
  s.tenant_id, 'FM-SH-AST-D-26-0001\V1.0',
  'Asset Disposal Request', 'طلب إتلاف أصل', 'Asset Disposal Request',
  'Requests approval to permanently dispose of an asset already returned to store.',
  'طلب اعتماد إتلاف أصل تم إرجاعه للمخزن.',
  'Requests approval to permanently dispose of an asset already returned to store.',
  'Assets', 1, 900, true, s.id, true
from public.approval_schemes s
where s.code = 'ASSET_DISPOSAL' and not s.is_deleted
  and not exists (
    select 1 from public.templates x
    where x.tenant_id = s.tenant_id and x.code = 'FM-SH-AST-D-26-0001\V1.0' and not x.is_deleted
  );

-- 5.1 Keep future tenants in sync. bootstrap_tenant_defaults() (supabase/
--     migrations/202608040019_tenant_provisioning.sql) is not itself taught
--     this module's scheme/template shape — out of scope for this single-file
--     migration to edit. Instead, this reacts to the one signal every
--     tenant's provisioning path already produces (its own FINAL_APPROVAL
--     approval_role row, inserted by that same function) and applies the
--     exact same backfill as above to that tenant, so a tenant created after
--     this migration ships is never left without the ASSET_DISPOSAL scheme.
create or replace function public.assets_bootstrap_disposal_scheme()
returns trigger
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_scheme_id uuid;
begin
  insert into public.approval_schemes (tenant_id, code, name_ar, name_en, description, is_active)
  select new.tenant_id, 'ASSET_DISPOSAL', 'اعتماد إتلاف الأصول', 'Asset Disposal Approval',
         'مخطط اعتماد مخصص لطلبات إتلاف الأصول عبر دور الاعتماد النهائي.', true
  where not exists (
    select 1 from public.approval_schemes s
    where s.tenant_id = new.tenant_id and s.code = 'ASSET_DISPOSAL' and not s.is_deleted
  );

  select id into v_scheme_id from public.approval_schemes
  where tenant_id = new.tenant_id and code = 'ASSET_DISPOSAL' and not is_deleted;

  if v_scheme_id is not null then
    insert into public.approval_scheme_roles (tenant_id, scheme_id, approval_role_id, display_order, is_required, allow_self_approval)
    select new.tenant_id, v_scheme_id, new.id, 1, true, false
    where not exists (
      select 1 from public.approval_scheme_roles sr
      where sr.scheme_id = v_scheme_id and sr.approval_role_id = new.id
    );

    insert into public.templates (
      tenant_id, code, name, name_ar, name_en,
      description, description_ar, description_en,
      category, version, display_order, is_active, approval_scheme_id, requires_final_approval
    )
    select
      new.tenant_id, 'FM-SH-AST-D-26-0001\V1.0',
      'Asset Disposal Request', 'طلب إتلاف أصل', 'Asset Disposal Request',
      'Requests approval to permanently dispose of an asset already returned to store.',
      'طلب اعتماد إتلاف أصل تم إرجاعه للمخزن.',
      'Requests approval to permanently dispose of an asset already returned to store.',
      'Assets', 1, 900, true, v_scheme_id, true
    where not exists (
      select 1 from public.templates x
      where x.tenant_id = new.tenant_id and x.code = 'FM-SH-AST-D-26-0001\V1.0' and not x.is_deleted
    );
  end if;

  return null;
end;
$$;

drop trigger if exists assets_bootstrap_disposal_scheme on public.approval_roles;
create trigger assets_bootstrap_disposal_scheme
after insert on public.approval_roles
for each row
when (new.code = 'FINAL_APPROVAL' and not new.is_deleted)
execute function public.assets_bootstrap_disposal_scheme();

-- ----------------------------------------------------------------------------
-- 6. RPCs
-- ----------------------------------------------------------------------------

-- 6.1 asset_group_upsert
create or replace function public.asset_group_upsert(
  p_id uuid, p_code text, p_name_ar text, p_name_en text,
  p_description_ar text, p_description_en text,
  p_display_order integer, p_is_active boolean
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
  if not public.has_permission('Assets.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if p_name_ar is null or trim(p_name_ar) = '' then raise exception 'NAME_AR_REQUIRED'; end if;

  if p_id is null then
    insert into public.asset_groups (
      tenant_id, code, name_ar, name_en, description_ar, description_en, display_order, is_active
    ) values (
      v_tenant, nullif(trim(p_code), ''), trim(p_name_ar), nullif(trim(p_name_en), ''),
      p_description_ar, p_description_en, coalesce(p_display_order, 0), coalesce(p_is_active, true)
    ) returning id into v_id;
  else
    update public.asset_groups set
      code = nullif(trim(p_code), ''),
      name_ar = trim(p_name_ar),
      name_en = nullif(trim(p_name_en), ''),
      description_ar = p_description_ar,
      description_en = p_description_en,
      display_order = coalesce(p_display_order, display_order),
      is_active = coalesce(p_is_active, is_active)
    where id = p_id and tenant_id = v_tenant and not is_deleted
    returning id into v_id;
    if v_id is null then raise exception 'ASSET_GROUP_NOT_FOUND'; end if;
  end if;

  return v_id;
end;
$$;
revoke all on function public.asset_group_upsert(uuid, text, text, text, text, text, integer, boolean) from public;
grant execute on function public.asset_group_upsert(uuid, text, text, text, text, text, integer, boolean) to authenticated;

comment on function public.asset_group_upsert(uuid, text, text, text, text, text, integer, boolean) is
  'Creates or updates an asset group. Authentication: authenticated. Authorization: '
  'Assets.Manage. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, NAME_AR_REQUIRED, '
  'ASSET_GROUP_NOT_FOUND.';

-- 6.2 asset_custody_unit_upsert
create or replace function public.asset_custody_unit_upsert(
  p_id uuid, p_code text, p_name_ar text, p_name_en text,
  p_site_id uuid, p_project_id uuid, p_department_id uuid,
  p_notes text, p_is_active boolean
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
  if not public.has_permission('Assets.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if p_code is null or trim(p_code) = '' then raise exception 'CODE_REQUIRED'; end if;
  if p_name_ar is null or trim(p_name_ar) = '' then raise exception 'NAME_AR_REQUIRED'; end if;

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
  if p_department_id is not null and not exists (
    select 1 from public.departments where id = p_department_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'DEPARTMENT_NOT_FOUND';
  end if;
  -- The client narrows its Site picker to the chosen Project, but that's a
  -- UX affordance only — enforce the same relationship server-side so a
  -- mismatched pair can never be persisted regardless of client state.
  if p_site_id is not null and p_project_id is not null and not exists (
    select 1 from public.sites where id = p_site_id and tenant_id = v_tenant and project_id = p_project_id
  ) then
    raise exception 'SITE_PROJECT_MISMATCH';
  end if;

  if p_id is null then
    insert into public.asset_custody_units (
      tenant_id, code, name_ar, name_en, site_id, project_id, department_id, notes, is_active
    ) values (
      v_tenant, trim(p_code), trim(p_name_ar), nullif(trim(p_name_en), ''),
      p_site_id, p_project_id, p_department_id, p_notes, coalesce(p_is_active, true)
    ) returning id into v_id;
  else
    update public.asset_custody_units set
      code = trim(p_code),
      name_ar = trim(p_name_ar),
      name_en = nullif(trim(p_name_en), ''),
      site_id = p_site_id,
      project_id = p_project_id,
      department_id = p_department_id,
      notes = p_notes,
      is_active = coalesce(p_is_active, is_active)
    where id = p_id and tenant_id = v_tenant and not is_deleted
    returning id into v_id;
    if v_id is null then raise exception 'CUSTODY_UNIT_NOT_FOUND'; end if;
  end if;

  return v_id;
end;
$$;
revoke all on function public.asset_custody_unit_upsert(uuid, text, text, text, uuid, uuid, uuid, text, boolean) from public;
grant execute on function public.asset_custody_unit_upsert(uuid, text, text, text, uuid, uuid, uuid, text, boolean) to authenticated;

comment on function public.asset_custody_unit_upsert(uuid, text, text, text, uuid, uuid, uuid, text, boolean) is
  'Creates or updates an asset custody unit. Authentication: authenticated. '
  'Authorization: Assets.Manage. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, '
  'CODE_REQUIRED, NAME_AR_REQUIRED, SITE_NOT_FOUND, PROJECT_NOT_FOUND, '
  'DEPARTMENT_NOT_FOUND, SITE_PROJECT_MISMATCH, CUSTODY_UNIT_NOT_FOUND.';

-- 6.3 asset_custody_unit_set_members — atomic replace, same delete-then-
--     insert-in-one-function-body shape as approval_scheme_set_roles()
--     (migration 202608060053's own already-fixed pattern).
create or replace function public.asset_custody_unit_set_members(p_custody_unit_id uuid, p_members jsonb)
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
  if not public.has_permission('Assets.Manage') then raise exception 'PERMISSION_DENIED'; end if;

  if not exists (
    select 1 from public.asset_custody_units
    where id = p_custody_unit_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'CUSTODY_UNIT_NOT_FOUND';
  end if;

  delete from public.asset_custody_unit_members
  where custody_unit_id = p_custody_unit_id and tenant_id = v_tenant;

  insert into public.asset_custody_unit_members (tenant_id, custody_unit_id, user_id, role_code)
  select v_tenant, p_custody_unit_id, (entry ->> 'userId')::uuid, entry ->> 'roleCode'
  from jsonb_array_elements(coalesce(p_members, '[]'::jsonb)) as entry;
end;
$$;
revoke all on function public.asset_custody_unit_set_members(uuid, jsonb) from public;
grant execute on function public.asset_custody_unit_set_members(uuid, jsonb) to authenticated;

comment on function public.asset_custody_unit_set_members(uuid, jsonb) is
  'Replaces a custody unit''s full Owner/Custodian/BackupCustodian member '
  'list atomically. Authentication: authenticated. Authorization: Assets.Manage. '
  'p_members is a jsonb array of {userId, roleCode}. Expected errors: '
  'NO_ACTIVE_TENANT, PERMISSION_DENIED, CUSTODY_UNIT_NOT_FOUND.';

-- 6.4 asset_create
create or replace function public.asset_create(
  p_group_id uuid, p_name_ar text, p_name_en text, p_color text, p_brand text, p_model text,
  p_serial_no text, p_imei text, p_manufacturer text, p_purchase_date date, p_warranty_until date,
  p_supplier text, p_parent_asset_id uuid, p_notes text, p_initial_custody_unit_id uuid
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
  v_txn_id uuid;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Assets.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if p_name_ar is null or trim(p_name_ar) = '' then raise exception 'NAME_AR_REQUIRED'; end if;

  if p_group_id is not null and not exists (
    select 1 from public.asset_groups where id = p_group_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'ASSET_GROUP_NOT_FOUND';
  end if;
  if p_parent_asset_id is not null and not exists (
    select 1 from public.assets where id = p_parent_asset_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'PARENT_ASSET_NOT_FOUND';
  end if;
  if p_initial_custody_unit_id is not null and not exists (
    select 1 from public.asset_custody_units where id = p_initial_custody_unit_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'CUSTODY_UNIT_NOT_FOUND';
  end if;

  v_ref := public.generate_number('AS', v_tenant);

  insert into public.assets (
    tenant_id, group_id, reference, name_ar, name_en, status, color, brand, model,
    serial_no, imei, manufacturer, purchase_date, warranty_until, supplier,
    current_custody_unit_id, current_custodian_user_id, parent_asset_id, notes
  ) values (
    v_tenant, p_group_id, v_ref, trim(p_name_ar), nullif(trim(p_name_en), ''), 'Available',
    p_color, p_brand, p_model, p_serial_no, p_imei, p_manufacturer, p_purchase_date, p_warranty_until,
    p_supplier, p_initial_custody_unit_id, null, p_parent_asset_id, p_notes
  ) returning id into v_id;

  if p_initial_custody_unit_id is not null then
    insert into public.asset_transactions (
      tenant_id, asset_id, transaction_type, status, to_custody_unit_id
    ) values (
      v_tenant, v_id, 'Receive', 'Completed', p_initial_custody_unit_id
    ) returning id into v_txn_id;
  end if;

  perform public.record_activity(
    'Asset', v_id, 'CREATED', 'تم إنشاء الأصل', 'Asset created',
    jsonb_build_object(
      'reference', v_ref, 'transactionId', v_txn_id, 'custodyUnitId', p_initial_custody_unit_id,
      'custodyUnitName', (
        select coalesce(cu.name_ar, cu.name_en, cu.code) from public.asset_custody_units cu
        where cu.id = p_initial_custody_unit_id and cu.tenant_id = v_tenant
      )
    )
  );

  return v_id;
end;
$$;
revoke all on function public.asset_create(uuid, text, text, text, text, text, text, text, text, date, date, text, uuid, text, uuid) from public;
grant execute on function public.asset_create(uuid, text, text, text, text, text, text, text, text, date, date, text, uuid, text, uuid) to authenticated;

comment on function public.asset_create(uuid, text, text, text, text, text, text, text, text, date, date, text, uuid, text, uuid) is
  'Creates an asset with a fresh generate_number(''AS'') reference. Authentication: '
  'authenticated. Authorization: Assets.Manage. When p_initial_custody_unit_id is '
  'given also creates the first Receive transaction (status Completed) and sets '
  'current_custody_unit_id. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, '
  'NAME_AR_REQUIRED, ASSET_GROUP_NOT_FOUND, PARENT_ASSET_NOT_FOUND, CUSTODY_UNIT_NOT_FOUND.';

-- 6.5 asset_update — descriptive fields only; never touches the lifecycle snapshot.
create or replace function public.asset_update(
  p_id uuid, p_group_id uuid, p_name_ar text, p_name_en text, p_color text, p_brand text, p_model text,
  p_serial_no text, p_imei text, p_manufacturer text, p_purchase_date date, p_warranty_until date,
  p_supplier text, p_parent_asset_id uuid, p_notes text
)
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
  if not public.has_permission('Assets.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if p_name_ar is null or trim(p_name_ar) = '' then raise exception 'NAME_AR_REQUIRED'; end if;
  if p_parent_asset_id is not null and p_parent_asset_id = p_id then raise exception 'ASSET_CANNOT_BE_OWN_PARENT'; end if;

  if p_group_id is not null and not exists (
    select 1 from public.asset_groups where id = p_group_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'ASSET_GROUP_NOT_FOUND';
  end if;
  if p_parent_asset_id is not null and not exists (
    select 1 from public.assets where id = p_parent_asset_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'PARENT_ASSET_NOT_FOUND';
  end if;

  -- Reject not just p_id being its own direct parent, but p_id appearing
  -- anywhere in the new parent's own ancestor chain (A->B->C->A).
  if p_parent_asset_id is not null and exists (
    with recursive ancestors as (
      select a.id, a.parent_asset_id from public.assets a
      where a.id = p_parent_asset_id and a.tenant_id = v_tenant
      union all
      select a.id, a.parent_asset_id from public.assets a
      join ancestors x on a.id = x.parent_asset_id
      where a.tenant_id = v_tenant
    )
    select 1 from ancestors where id = p_id
  ) then
    raise exception 'ASSET_HIERARCHY_CYCLE';
  end if;

  update public.assets set
    group_id = p_group_id,
    name_ar = trim(p_name_ar),
    name_en = nullif(trim(p_name_en), ''),
    color = p_color,
    brand = p_brand,
    model = p_model,
    serial_no = p_serial_no,
    imei = p_imei,
    manufacturer = p_manufacturer,
    purchase_date = p_purchase_date,
    warranty_until = p_warranty_until,
    supplier = p_supplier,
    parent_asset_id = p_parent_asset_id,
    notes = p_notes
  where id = p_id and tenant_id = v_tenant and not is_deleted
  returning id into v_id;

  if v_id is null then raise exception 'ASSET_NOT_FOUND'; end if;
end;
$$;
revoke all on function public.asset_update(uuid, uuid, text, text, text, text, text, text, text, text, date, date, text, uuid, text) from public;
grant execute on function public.asset_update(uuid, uuid, text, text, text, text, text, text, text, text, date, date, text, uuid, text) to authenticated;

comment on function public.asset_update(uuid, uuid, text, text, text, text, text, text, text, text, date, date, text, uuid, text) is
  'Updates an asset''s descriptive fields only — never touches the lifecycle snapshot '
  '(status/current_custodian_user_id/current_custody_unit_id), see asset_transaction_'
  'create() for that. Authentication: authenticated. Authorization: Assets.Manage. '
  'Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, NAME_AR_REQUIRED, '
  'ASSET_CANNOT_BE_OWN_PARENT, ASSET_GROUP_NOT_FOUND, PARENT_ASSET_NOT_FOUND, '
  'ASSET_HIERARCHY_CYCLE, ASSET_NOT_FOUND.';

-- 6.6 asset_transaction_create — the unified movement entry point.
create or replace function public.asset_transaction_create(
  p_asset_id uuid,
  p_transaction_type text,
  p_to_custodian_user_id uuid default null,
  p_to_custody_unit_id uuid default null,
  p_reason text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_asset public.assets%rowtype;
  v_from_custodian uuid;
  v_from_unit uuid;
  v_id uuid;
  v_new_status text;
  v_title_ar text;
  v_title_en text;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if p_transaction_type not in ('Receive', 'Issue', 'Transfer', 'Return', 'Lost', 'Found', 'Reserve', 'Release') then
    raise exception 'UNSUPPORTED_TRANSACTION_TYPE';
  end if;

  select * into v_asset from public.assets where id = p_asset_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'ASSET_NOT_FOUND'; end if;

  if v_asset.status = 'Disposed' then raise exception 'ASSET_DISPOSED'; end if;
  if v_asset.status = 'Lost' and p_transaction_type in ('Transfer', 'Issue') then
    raise exception 'ASSET_LOST_CANNOT_MOVE';
  end if;

  if p_transaction_type = 'Receive' then
    if not public.has_permission('Assets.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  else
    if not (
      v_asset.current_custodian_user_id = auth.uid()
      or public.has_permission('Assets.Operate')
      or public.has_permission('Assets.Manage')
    ) then
      raise exception 'PERMISSION_DENIED';
    end if;
  end if;

  if p_transaction_type = 'Issue' and p_to_custodian_user_id is null then
    raise exception 'TARGET_USER_REQUIRED';
  end if;
  if p_to_custodian_user_id is not null and not exists (
    select 1 from public.users where id = p_to_custodian_user_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'TARGET_USER_NOT_FOUND';
  end if;
  if p_to_custody_unit_id is not null and not exists (
    select 1 from public.asset_custody_units where id = p_to_custody_unit_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'CUSTODY_UNIT_NOT_FOUND';
  end if;

  -- Architectural recommendation #4: block a conflicting delivery during
  -- another party's active reservation window. Issue is the immediate,
  -- unconditional delivery path (Transfer-to-a-person's own delivery moment
  -- is asset_transfer_accept(), which carries the equivalent check).
  if p_transaction_type = 'Issue' and exists (
    select 1 from public.asset_reservations r
    where r.tenant_id = v_tenant and r.asset_id = p_asset_id and r.status = 'Active' and not r.is_deleted
      and r.start_date <= current_date and r.end_date >= current_date
      and r.reserved_for_user_id is distinct from p_to_custodian_user_id
  ) then
    raise exception 'ASSET_RESERVED_CONFLICT';
  end if;

  v_from_custodian := v_asset.current_custodian_user_id;
  v_from_unit := v_asset.current_custody_unit_id;

  select
    case p_transaction_type when 'Reserve' then 'تم حجز الأصل' when 'Release' then 'تم إلغاء حجز الأصل'
      when 'Receive' then 'تم استلام الأصل' when 'Issue' then 'تم صرف الأصل' when 'Transfer' then 'بانتظار قبول النقل'
      when 'Return' then 'تم إرجاع الأصل' when 'Lost' then 'تم تسجيل الأصل كمفقود' when 'Found' then 'تم العثور على الأصل'
    end,
    case p_transaction_type when 'Reserve' then 'Asset reserved' when 'Release' then 'Asset reservation released'
      when 'Receive' then 'Asset received' when 'Issue' then 'Asset issued' when 'Transfer' then 'Transfer pending acceptance'
      when 'Return' then 'Asset returned' when 'Lost' then 'Asset marked lost' when 'Found' then 'Asset found'
    end
  into v_title_ar, v_title_en;

  -- Reserve/Release are administrative log entries: no physical custody
  -- change, so the snapshot is never touched. The dedicated asset_reserve()/
  -- asset_release_reservation() RPCs write the actual asset_reservations row
  -- and enforce the overlap-conflict rule; this branch only exists so a
  -- caller reaching this generic entry point directly still gets a
  -- consistent transaction log row and timeline entry.
  if p_transaction_type in ('Reserve', 'Release') then
    insert into public.asset_transactions (
      tenant_id, asset_id, transaction_type, status,
      from_custodian_user_id, to_custodian_user_id, from_custody_unit_id, to_custody_unit_id, reason
    ) values (
      v_tenant, p_asset_id, p_transaction_type, 'Completed',
      v_from_custodian, v_from_custodian, v_from_unit, v_from_unit, p_reason
    ) returning id into v_id;

    perform public.record_activity('Asset', p_asset_id, upper(p_transaction_type), v_title_ar, v_title_en,
      jsonb_build_object('transactionId', v_id, 'reason', p_reason));
    return v_id;
  end if;

  -- Transfer to a specific person: pending-acceptance handshake. The
  -- snapshot is intentionally NOT updated here — asset_transfer_accept()
  -- is the only place that ever applies it.
  if p_transaction_type = 'Transfer' and p_to_custodian_user_id is not null then
    if p_to_custodian_user_id = v_asset.current_custodian_user_id then
      raise exception 'ALREADY_CURRENT_CUSTODIAN';
    end if;

    insert into public.asset_transactions (
      tenant_id, asset_id, transaction_type, status,
      from_custodian_user_id, to_custodian_user_id, from_custody_unit_id, to_custody_unit_id, reason
    ) values (
      v_tenant, p_asset_id, 'Transfer', 'PendingAcceptance',
      v_from_custodian, p_to_custodian_user_id, v_from_unit, p_to_custody_unit_id, p_reason
    ) returning id into v_id;

    perform public.record_activity('Asset', p_asset_id, 'TRANSFERRED', v_title_ar, v_title_en,
      jsonb_build_object(
        'transactionId', v_id, 'toUserId', p_to_custodian_user_id, 'reason', p_reason,
        'toUserName', (
          select coalesce(u.full_name, u.name_ar, u.name_en, u.email) from public.users u
          where u.id = p_to_custodian_user_id and u.tenant_id = v_tenant
        )
      ));

    perform public.notify(
      p_to_custodian_user_id, 'Approval', 'AS_TRANSFER_PENDING_ACCEPT',
      'لديك أصل بانتظار قبول الاستلام', 'An asset transfer is awaiting your acceptance',
      'الأصل ' || coalesce(v_asset.reference, '') || ' بانتظار موافقتك على الاستلام.',
      'Asset ' || coalesce(v_asset.reference, '') || ' is waiting for you to accept custody.',
      '/app/assets?asset=' || p_asset_id::text,
      jsonb_build_object('assetId', p_asset_id, 'transactionId', v_id)
    );

    return v_id;
  end if;

  -- Everything else completes immediately and updates the snapshot now.
  v_new_status := case p_transaction_type
    when 'Receive' then 'Available'
    when 'Issue' then 'InUse'
    when 'Return' then 'Available'
    when 'Lost' then 'Lost'
    when 'Found' then case when v_asset.current_custodian_user_id is not null then 'InUse' else 'Available' end
    when 'Transfer' then 'Available' -- custody-unit-to-custody-unit move, no personal custodian
    else v_asset.status
  end;

  insert into public.asset_transactions (
    tenant_id, asset_id, transaction_type, status,
    from_custodian_user_id, to_custodian_user_id, from_custody_unit_id, to_custody_unit_id, reason
  ) values (
    v_tenant, p_asset_id, p_transaction_type, 'Completed',
    v_from_custodian,
    case p_transaction_type when 'Issue' then p_to_custodian_user_id else null end,
    v_from_unit, coalesce(p_to_custody_unit_id, v_from_unit), p_reason
  ) returning id into v_id;

  update public.assets set
    status = v_new_status,
    current_custodian_user_id = case p_transaction_type
      when 'Issue' then p_to_custodian_user_id
      when 'Return' then null
      when 'Receive' then null
      when 'Transfer' then null
      else current_custodian_user_id
    end,
    current_custody_unit_id = coalesce(p_to_custody_unit_id, current_custody_unit_id)
  where id = p_asset_id and tenant_id = v_tenant;

  perform public.record_activity('Asset', p_asset_id, upper(p_transaction_type), v_title_ar, v_title_en,
    jsonb_build_object(
      'transactionId', v_id, 'toUserId', p_to_custodian_user_id, 'toCustodyUnitId', p_to_custody_unit_id, 'reason', p_reason,
      'toUserName', (
        select coalesce(u.full_name, u.name_ar, u.name_en, u.email) from public.users u
        where u.id = p_to_custodian_user_id and u.tenant_id = v_tenant
      ),
      'toCustodyUnitName', (
        select coalesce(cu.name_ar, cu.name_en, cu.code) from public.asset_custody_units cu
        where cu.id = p_to_custody_unit_id and cu.tenant_id = v_tenant
      )
    ));

  return v_id;
end;
$$;
revoke all on function public.asset_transaction_create(uuid, text, uuid, uuid, text) from public;
grant execute on function public.asset_transaction_create(uuid, text, uuid, uuid, text) to authenticated;

comment on function public.asset_transaction_create(uuid, text, uuid, uuid, text) is
  'Unified entry point for Receive/Issue/Transfer/Return/Lost/Found/Reserve/Release. '
  'Never Dispose (only the disposal-approval trigger creates that) and never '
  'MaintenanceOut/MaintenanceReturn (only asset_maintenance_advance() creates those). '
  'Authentication: authenticated. Authorization: current custodian, or Assets.Operate, '
  'or Assets.Manage — except Receive, which requires Assets.Manage specifically (no '
  'prior custodian exists to authorize it). A Transfer naming a real person creates a '
  'PendingAcceptance row and leaves the snapshot untouched until asset_transfer_accept(). '
  'Issue always requires a target custodian (never completes with a null one). Blocks '
  'Issue against any other party''s Active reservation covering today (architectural '
  'recommendation #4). Expected errors: NO_ACTIVE_TENANT, UNSUPPORTED_TRANSACTION_TYPE, '
  'ASSET_NOT_FOUND, ASSET_DISPOSED, ASSET_LOST_CANNOT_MOVE, PERMISSION_DENIED, '
  'TARGET_USER_REQUIRED, TARGET_USER_NOT_FOUND, CUSTODY_UNIT_NOT_FOUND, '
  'ASSET_RESERVED_CONFLICT, ALREADY_CURRENT_CUSTODIAN.';

-- 6.7 asset_transfer_accept
create or replace function public.asset_transfer_accept(p_transaction_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn public.asset_transactions%rowtype;
  v_asset public.assets%rowtype;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  select * into v_txn from public.asset_transactions
  where id = p_transaction_id and tenant_id = v_tenant for update;
  if not found then raise exception 'TRANSACTION_NOT_FOUND'; end if;
  if v_txn.status <> 'PendingAcceptance' then raise exception 'TRANSFER_NOT_PENDING'; end if;
  if v_txn.to_custodian_user_id is distinct from auth.uid() then raise exception 'ONLY_RECIPIENT_CAN_ACCEPT'; end if;

  -- Accepting is functionally a delivery: re-check the asset's CURRENT
  -- status (it may have become Disposed/Lost since this transfer was
  -- created — the pending window can be arbitrarily long) the same way
  -- asset_transaction_create() does, instead of trusting the transaction
  -- row alone.
  select * into v_asset from public.assets where id = v_txn.asset_id and tenant_id = v_tenant for update;
  if not found then raise exception 'ASSET_NOT_FOUND'; end if;
  if v_asset.status = 'Disposed' then raise exception 'ASSET_DISPOSED'; end if;
  if v_asset.status = 'Lost' then raise exception 'ASSET_LOST_CANNOT_MOVE'; end if;

  -- The snapshot is intentionally frozen while PendingAcceptance, but a
  -- realistic gap can be arbitrarily long: the original custodian can Return
  -- the asset, and it can then be Issued to someone else entirely, before
  -- this Accept is ever clicked. Blindly overwriting the snapshot at that
  -- point would silently dispossess whoever holds it now, with no
  -- notification to them and no record reflecting what actually happened —
  -- exactly the "transaction log is the source of truth" principle this
  -- module is built around, violated. If reality has moved on since this
  -- transfer was created, the transfer itself is stale: cancel it instead of
  -- applying it, and tell the intended recipient why.
  if v_asset.current_custodian_user_id is distinct from v_txn.from_custodian_user_id then
    update public.asset_transactions set status = 'Cancelled' where id = p_transaction_id;
    perform public.record_activity('Asset', v_txn.asset_id, 'TRANSFER_STALE_CANCELLED',
      'أُلغيت عملية النقل تلقائياً (تغيّرت العهدة قبل القبول)', 'Transfer auto-cancelled (custody changed before acceptance)',
      jsonb_build_object('transactionId', p_transaction_id));
    raise exception 'TRANSFER_STALE_CUSTODY_CHANGED';
  end if;

  if exists (
    select 1 from public.asset_reservations r
    where r.tenant_id = v_tenant and r.asset_id = v_txn.asset_id and r.status = 'Active' and not r.is_deleted
      and r.start_date <= current_date and r.end_date >= current_date
      and r.reserved_for_user_id is distinct from v_txn.to_custodian_user_id
  ) then
    raise exception 'ASSET_RESERVED_CONFLICT';
  end if;

  update public.asset_transactions set status = 'Completed' where id = p_transaction_id;

  update public.assets set
    current_custodian_user_id = v_txn.to_custodian_user_id,
    current_custody_unit_id = coalesce(v_txn.to_custody_unit_id, current_custody_unit_id),
    status = 'InUse'
  where id = v_txn.asset_id and tenant_id = v_tenant
  returning * into v_asset;

  perform public.record_activity('Asset', v_txn.asset_id, 'ACCEPTED', 'تم قبول استلام الأصل', 'Asset transfer accepted',
    jsonb_build_object(
      'transactionId', p_transaction_id, 'fromUserId', v_txn.from_custodian_user_id,
      'fromUserName', (
        select coalesce(u.full_name, u.name_ar, u.name_en, u.email) from public.users u
        where u.id = v_txn.from_custodian_user_id and u.tenant_id = v_tenant
      )
    ));

  if v_txn.from_custodian_user_id is not null then
    perform public.notify(
      v_txn.from_custodian_user_id, 'System', 'AS_TRANSFER_ACCEPTED',
      'تم قبول نقل الأصل', 'Your asset transfer was accepted',
      'قام المستلم بقبول استلام الأصل ' || coalesce(v_asset.reference, ''),
      'The recipient accepted custody of asset ' || coalesce(v_asset.reference, ''),
      '/app/assets?asset=' || v_txn.asset_id::text,
      jsonb_build_object('assetId', v_txn.asset_id, 'transactionId', p_transaction_id)
    );
  end if;
end;
$$;
revoke all on function public.asset_transfer_accept(uuid) from public;
grant execute on function public.asset_transfer_accept(uuid) to authenticated;

comment on function public.asset_transfer_accept(uuid) is
  'Authentication: authenticated. Authorization: caller must equal the transaction''s '
  'to_custodian_user_id. Applies the snapshot now (never before), after re-checking the '
  'asset''s current status and any conflicting Active reservation — accepting is '
  'functionally a delivery, so it is re-validated the same way asset_transaction_create() '
  'validates a fresh one. Expected errors: NO_ACTIVE_TENANT, TRANSACTION_NOT_FOUND, '
  'TRANSFER_NOT_PENDING, ONLY_RECIPIENT_CAN_ACCEPT, ASSET_NOT_FOUND, ASSET_DISPOSED, '
  'ASSET_LOST_CANNOT_MOVE, ASSET_RESERVED_CONFLICT.';

-- 6.8 asset_transfer_reject
create or replace function public.asset_transfer_reject(p_transaction_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn public.asset_transactions%rowtype;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  select * into v_txn from public.asset_transactions
  where id = p_transaction_id and tenant_id = v_tenant for update;
  if not found then raise exception 'TRANSACTION_NOT_FOUND'; end if;
  if v_txn.status <> 'PendingAcceptance' then raise exception 'TRANSFER_NOT_PENDING'; end if;
  if v_txn.to_custodian_user_id is distinct from auth.uid() then raise exception 'ONLY_RECIPIENT_CAN_ACCEPT'; end if;

  -- The snapshot was never changed for a pending transfer, so there is
  -- nothing to revert here — only the transaction row itself moves.
  update public.asset_transactions set status = 'Rejected' where id = p_transaction_id;

  perform public.record_activity('Asset', v_txn.asset_id, 'TRANSFER_REJECTED', 'تم رفض استلام الأصل', 'Asset transfer rejected',
    jsonb_build_object(
      'transactionId', p_transaction_id, 'toUserId', v_txn.to_custodian_user_id,
      'toUserName', (
        select coalesce(u.full_name, u.name_ar, u.name_en, u.email) from public.users u
        where u.id = v_txn.to_custodian_user_id and u.tenant_id = v_tenant
      )
    ));

  if v_txn.from_custodian_user_id is not null then
    perform public.notify(
      v_txn.from_custodian_user_id, 'System', 'AS_TRANSFER_REJECTED',
      'تم رفض نقل الأصل', 'Your asset transfer was rejected',
      'رفض المستلم استلام الأصل، ولم يتغير عهدة الأصل.',
      'The recipient declined custody; the asset''s custody is unchanged.',
      '/app/assets?asset=' || v_txn.asset_id::text,
      jsonb_build_object('assetId', v_txn.asset_id, 'transactionId', p_transaction_id)
    );
  end if;
end;
$$;
revoke all on function public.asset_transfer_reject(uuid) from public;
grant execute on function public.asset_transfer_reject(uuid) to authenticated;

comment on function public.asset_transfer_reject(uuid) is
  'Rejects a PendingAcceptance transfer. The snapshot was never changed for a pending '
  'transfer, so nothing is reverted — only the transaction row moves to Rejected. '
  'Authentication: authenticated. Authorization: caller must equal the transaction''s '
  'to_custodian_user_id. Expected errors: NO_ACTIVE_TENANT, TRANSACTION_NOT_FOUND, '
  'TRANSFER_NOT_PENDING, ONLY_RECIPIENT_CAN_ACCEPT.';

-- 6.9 asset_maintenance_report — any authenticated tenant member, no permission gate.
create or replace function public.asset_maintenance_report(p_asset_id uuid, p_issue_description text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_asset public.assets%rowtype;
  v_ref text;
  v_id uuid;
  v_approver record;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if p_issue_description is null or trim(p_issue_description) = '' then raise exception 'ISSUE_DESCRIPTION_REQUIRED'; end if;

  select * into v_asset from public.assets where id = p_asset_id and tenant_id = v_tenant and not is_deleted;
  if not found then raise exception 'ASSET_NOT_FOUND'; end if;
  if v_asset.status = 'Disposed' then raise exception 'ASSET_DISPOSED'; end if;

  v_ref := public.generate_number('WO', v_tenant);

  insert into public.asset_maintenance (tenant_id, asset_id, reference, status, issue_description, reported_by)
  values (v_tenant, p_asset_id, v_ref, 'Reported', trim(p_issue_description), auth.uid())
  returning id into v_id;

  perform public.record_activity('Asset', p_asset_id, 'MAINTENANCE_REPORTED', 'تم الإبلاغ عن صيانة', 'Maintenance reported',
    jsonb_build_object('maintenanceId', v_id, 'reference', v_ref));

  for v_approver in
    select distinct ur.user_id
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.tenant_id = v_tenant and r.is_active and not r.is_deleted
    join public.role_permissions rp on rp.role_id = r.id and rp.tenant_id = v_tenant
    join public.permissions p on p.id = rp.permission_id and p.code in ('Assets.Maintain', 'Assets.Manage')
    where ur.user_id <> auth.uid()
  loop
    perform public.notify(
      v_approver.user_id, 'Approval', 'AS_MAINTENANCE_APPROVAL_NEEDED',
      'طلب صيانة بانتظار الاعتماد', 'A maintenance case needs your approval',
      'تم الإبلاغ عن صيانة للأصل ' || coalesce(v_asset.reference, '') || ' (' || v_ref || ').',
      'A maintenance case for asset ' || coalesce(v_asset.reference, '') || ' (' || v_ref || ') needs your approval.',
      -- The recipient here is always an Assets.Maintain/Manage holder — the
      -- approve action only exists on the admin catalogue screen, never the
      -- employee portal — so this is the one deep link in the module that
      -- targets /app/admin/assets rather than /app/assets. Keyed by asset
      -- (not maintenanceId): the admin screen resolves ?asset= into that
      -- asset's own detail view, which surfaces the maintenance case.
      '/app/admin/assets?asset=' || p_asset_id::text,
      jsonb_build_object('maintenanceId', v_id, 'assetId', p_asset_id)
    );
  end loop;

  return v_id;
end;
$$;
revoke all on function public.asset_maintenance_report(uuid, text) from public;
grant execute on function public.asset_maintenance_report(uuid, text) to authenticated;

comment on function public.asset_maintenance_report(uuid, text) is
  'Authentication: authenticated. Authorization: none beyond being a tenant member — '
  'the spec''s own explicit rule is that ANY user may report maintenance; only sending '
  'it out afterwards is gated. Expected errors: NO_ACTIVE_TENANT, '
  'ISSUE_DESCRIPTION_REQUIRED, ASSET_NOT_FOUND, ASSET_DISPOSED.';

-- 6.10 asset_maintenance_approve — the one authorized-approver gate the spec requires.
create or replace function public.asset_maintenance_approve(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_m public.asset_maintenance%rowtype;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not (public.has_permission('Assets.Maintain') or public.has_permission('Assets.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;

  select * into v_m from public.asset_maintenance where id = p_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'MAINTENANCE_NOT_FOUND'; end if;
  if v_m.status <> 'Reported' then raise exception 'MAINTENANCE_NOT_REPORTED'; end if;

  update public.asset_maintenance set status = 'Approved', approved_by = auth.uid(), approved_on = now()
  where id = p_id;

  perform public.record_activity('Asset', v_m.asset_id, 'MAINTENANCE_APPROVED', 'تم اعتماد إرسال الأصل للصيانة', 'Maintenance send approved',
    jsonb_build_object('maintenanceId', p_id, 'reference', v_m.reference));

  perform public.notify(
    v_m.reported_by, 'System', 'AS_MAINTENANCE_APPROVED',
    'تم اعتماد طلب الصيانة', 'Your maintenance report was approved',
    'تم اعتماد إرسال الأصل للصيانة لطلب ' || v_m.reference || '.',
    'Sending the asset out for maintenance case ' || v_m.reference || ' has been approved.',
    -- The reporter can be any tenant member (asset_maintenance_report() has
    -- no permission gate), so this must stay on the employee portal, not
    -- the admin screen — and keyed by asset (portal reads ?asset=, not a
    -- maintenanceId nothing consumes) so it actually lands on the asset's
    -- own detail/Timeline, which shows this approval event.
    '/app/assets?asset=' || v_m.asset_id::text,
    jsonb_build_object('maintenanceId', p_id, 'assetId', v_m.asset_id)
  );
end;
$$;
revoke all on function public.asset_maintenance_approve(uuid) from public;
grant execute on function public.asset_maintenance_approve(uuid) to authenticated;

comment on function public.asset_maintenance_approve(uuid) is
  'Authorizes SENDING an asset out for maintenance (does not itself move it — see '
  'asset_maintenance_advance()). Authentication: authenticated. Authorization: '
  'Assets.Maintain or Assets.Manage. Expected errors: NO_ACTIVE_TENANT, '
  'PERMISSION_DENIED, MAINTENANCE_NOT_FOUND, MAINTENANCE_NOT_REPORTED.';

-- 6.11 asset_maintenance_advance
create or replace function public.asset_maintenance_advance(
  p_id uuid,
  p_new_status text,
  p_vendor_text text default null,
  p_expected_return_date date default null,
  p_cost numeric default null,
  p_notes text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_m public.asset_maintenance%rowtype;
  v_asset public.assets%rowtype;
  v_is_maintainer boolean;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if p_new_status not in ('Sent', 'UnderMaintenance', 'Completed', 'Returned', 'Closed', 'Rejected') then
    raise exception 'INVALID_MAINTENANCE_STATUS';
  end if;

  select * into v_m from public.asset_maintenance where id = p_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'MAINTENANCE_NOT_FOUND'; end if;

  v_is_maintainer := public.has_permission('Assets.Maintain') or public.has_permission('Assets.Manage');
  if p_new_status in ('UnderMaintenance', 'Completed') then
    if not (v_is_maintainer or v_m.reported_by = auth.uid()) then raise exception 'PERMISSION_DENIED'; end if;
  else
    if not v_is_maintainer then raise exception 'PERMISSION_DENIED'; end if;
  end if;

  if p_new_status = 'Rejected' then
    if v_m.status not in ('Reported', 'Approved') then raise exception 'MAINTENANCE_NOT_REJECTABLE'; end if;
  elsif p_new_status = 'Sent' then
    if v_m.status <> 'Approved' then raise exception 'MAINTENANCE_NOT_APPROVED'; end if;
  elsif p_new_status = 'UnderMaintenance' then
    if v_m.status <> 'Sent' then raise exception 'MAINTENANCE_NOT_SENT'; end if;
  elsif p_new_status = 'Completed' then
    if v_m.status <> 'UnderMaintenance' then raise exception 'MAINTENANCE_NOT_IN_PROGRESS'; end if;
  elsif p_new_status = 'Returned' then
    if v_m.status <> 'Completed' then raise exception 'MAINTENANCE_NOT_COMPLETED'; end if;
  elsif p_new_status = 'Closed' then
    if v_m.status <> 'Returned' then raise exception 'MAINTENANCE_NOT_RETURNED'; end if;
  end if;

  select * into v_asset from public.assets where id = v_m.asset_id and tenant_id = v_tenant for update;
  if not found then raise exception 'ASSET_NOT_FOUND'; end if;
  -- Spec's own rule: never perform maintenance on an asset that has been
  -- Disposed/ended. The asset may have been disposed after this case was
  -- Reported/Approved (that only checks status at report time), so it is
  -- re-checked here before every transition that keeps the case attached to
  -- a live asset (Sent/UnderMaintenance/Completed/Returned) — Rejected/Closed
  -- never touch the asset and can still close out an in-flight case
  -- administratively even after it was disposed elsewhere.
  if v_asset.status = 'Disposed' and p_new_status in ('Sent', 'UnderMaintenance', 'Completed', 'Returned') then
    raise exception 'ASSET_DISPOSED';
  end if;

  update public.asset_maintenance set
    status = p_new_status,
    vendor_text = coalesce(p_vendor_text, vendor_text),
    expected_return_date = coalesce(p_expected_return_date, expected_return_date),
    cost = coalesce(p_cost, cost),
    notes = coalesce(p_notes, notes),
    sent_on = case when p_new_status = 'Sent' then now() else sent_on end,
    completed_on = case when p_new_status = 'Completed' then now() else completed_on end,
    returned_on = case when p_new_status = 'Returned' then now() else returned_on end,
    closed_on = case when p_new_status = 'Closed' then now() else closed_on end
  where id = p_id and tenant_id = v_tenant;

  if p_new_status = 'Sent' then
    insert into public.asset_transactions (
      tenant_id, asset_id, transaction_type, status,
      from_custodian_user_id, from_custody_unit_id, reason, related_maintenance_id
    ) values (
      v_tenant, v_m.asset_id, 'MaintenanceOut', 'Completed',
      v_asset.current_custodian_user_id, v_asset.current_custody_unit_id, v_m.issue_description, p_id
    );
    update public.assets set status = 'InMaintenance' where id = v_m.asset_id and tenant_id = v_tenant;

  elsif p_new_status = 'Returned' then
    insert into public.asset_transactions (
      tenant_id, asset_id, transaction_type, status,
      to_custodian_user_id, to_custody_unit_id, reason, related_maintenance_id
    ) values (
      v_tenant, v_m.asset_id, 'MaintenanceReturn', 'Completed',
      v_asset.current_custodian_user_id, v_asset.current_custody_unit_id, p_notes, p_id
    );
    update public.assets
    set status = case when current_custodian_user_id is not null then 'InUse' else 'Available' end
    where id = v_m.asset_id and tenant_id = v_tenant;
  end if;

  perform public.record_activity('Asset', v_m.asset_id, 'MAINTENANCE_' || upper(p_new_status),
    'صيانة: ' || p_new_status, 'Maintenance: ' || p_new_status,
    jsonb_build_object('maintenanceId', p_id, 'reference', v_m.reference, 'status', p_new_status));

  if p_new_status = 'Completed' then
    perform public.notify(
      v_m.reported_by, 'System', 'AS_MAINTENANCE_COMPLETED',
      'اكتملت صيانة الأصل', 'Asset maintenance completed',
      'تم إنجاز أعمال الصيانة لطلب ' || coalesce(v_m.reference, ''),
      'Maintenance work for case ' || coalesce(v_m.reference, '') || ' has been completed.',
      -- Same reasoning as AS_MAINTENANCE_APPROVED above: reporter may be any
      -- tenant member, so portal route, keyed by asset.
      '/app/assets?asset=' || v_m.asset_id::text,
      jsonb_build_object('maintenanceId', p_id, 'assetId', v_m.asset_id)
    );
  end if;
end;
$$;
revoke all on function public.asset_maintenance_advance(uuid, text, text, date, numeric, text) from public;
grant execute on function public.asset_maintenance_advance(uuid, text, text, date, numeric, text) to authenticated;

comment on function public.asset_maintenance_advance(uuid, text, text, date, numeric, text) is
  'Advances a maintenance case one step: Approved->Sent->UnderMaintenance->Completed->'
  'Returned->Closed, or Reported/Approved->Rejected. Authentication: authenticated. '
  'Authorization: Assets.Maintain or Assets.Manage, except the UnderMaintenance/Completed '
  'transitions which the case''s own reporter may also perform. Creates the MaintenanceOut '
  'transaction (asset.status -> InMaintenance) on entering Sent, and MaintenanceReturn '
  '(asset.status -> InUse/Available) on entering Returned. Expected errors: '
  'NO_ACTIVE_TENANT, INVALID_MAINTENANCE_STATUS, MAINTENANCE_NOT_FOUND, PERMISSION_DENIED, '
  'MAINTENANCE_NOT_REJECTABLE, MAINTENANCE_NOT_APPROVED, MAINTENANCE_NOT_SENT, '
  'MAINTENANCE_NOT_IN_PROGRESS, MAINTENANCE_NOT_COMPLETED, MAINTENANCE_NOT_RETURNED, '
  'ASSET_NOT_FOUND, ASSET_DISPOSED (asset was disposed after this case was reported/approved).';

-- 6.12 asset_reserve — parameters reordered (required first, defaults
--      trailing) versus the prose spec purely to satisfy Postgres's own
--      function-definition rule; call it with named arguments, as intended.
create or replace function public.asset_reserve(
  p_asset_id uuid,
  p_start_date date,
  p_end_date date,
  p_reserved_for_user_id uuid default null,
  p_reserved_for_project_id uuid default null,
  p_purpose text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_asset public.assets%rowtype;
  v_id uuid;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not (public.has_permission('Assets.Operate') or public.has_permission('Assets.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_start_date is null or p_end_date is null then raise exception 'RESERVATION_DATES_REQUIRED'; end if;
  if p_end_date < p_start_date then raise exception 'INVALID_DATE_RANGE'; end if;

  select * into v_asset from public.assets where id = p_asset_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'ASSET_NOT_FOUND'; end if;
  if v_asset.status in ('Lost', 'Disposed') then raise exception 'ASSET_NOT_RESERVABLE'; end if;

  if exists (
    select 1 from public.asset_reservations r
    where r.tenant_id = v_tenant and r.asset_id = p_asset_id and r.status = 'Active' and not r.is_deleted
      and r.start_date <= p_end_date and r.end_date >= p_start_date
  ) then
    raise exception 'ASSET_ALREADY_RESERVED';
  end if;

  insert into public.asset_reservations (
    tenant_id, asset_id, reserved_for_user_id, reserved_for_project_id, purpose, start_date, end_date, status
  ) values (
    v_tenant, p_asset_id, p_reserved_for_user_id, p_reserved_for_project_id, p_purpose, p_start_date, p_end_date, 'Active'
  ) returning id into v_id;

  insert into public.asset_transactions (tenant_id, asset_id, transaction_type, status, reason)
  values (v_tenant, p_asset_id, 'Reserve', 'Completed', p_purpose);

  perform public.record_activity('Asset', p_asset_id, 'RESERVED', 'تم حجز الأصل', 'Asset reserved',
    jsonb_build_object('reservationId', v_id, 'startDate', p_start_date, 'endDate', p_end_date));

  return v_id;
end;
$$;
revoke all on function public.asset_reserve(uuid, date, date, uuid, uuid, text) from public;
grant execute on function public.asset_reserve(uuid, date, date, uuid, uuid, text) to authenticated;

comment on function public.asset_reserve(uuid, date, date, uuid, uuid, text) is
  'Reserves an asset for a future user/project window; blocks any overlapping Active '
  'reservation on the same asset. Authentication: authenticated. Authorization: '
  'Assets.Operate or Assets.Manage. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, '
  'RESERVATION_DATES_REQUIRED, INVALID_DATE_RANGE, ASSET_NOT_FOUND, ASSET_NOT_RESERVABLE, '
  'ASSET_ALREADY_RESERVED.';

-- 6.13 asset_release_reservation
create or replace function public.asset_release_reservation(p_reservation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_r public.asset_reservations%rowtype;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  select * into v_r from public.asset_reservations where id = p_reservation_id and tenant_id = v_tenant for update;
  if not found then raise exception 'RESERVATION_NOT_FOUND'; end if;
  if not (
    public.has_permission('Assets.Operate')
    or public.has_permission('Assets.Manage')
    or v_r.reserved_for_user_id = auth.uid()
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if v_r.status <> 'Active' then raise exception 'RESERVATION_NOT_ACTIVE'; end if;

  update public.asset_reservations set status = 'Released' where id = p_reservation_id;

  insert into public.asset_transactions (tenant_id, asset_id, transaction_type, status)
  values (v_tenant, v_r.asset_id, 'Release', 'Completed');

  perform public.record_activity('Asset', v_r.asset_id, 'RESERVATION_RELEASED', 'تم إلغاء حجز الأصل', 'Reservation released',
    jsonb_build_object('reservationId', p_reservation_id));
end;
$$;
revoke all on function public.asset_release_reservation(uuid) from public;
grant execute on function public.asset_release_reservation(uuid) to authenticated;

comment on function public.asset_release_reservation(uuid) is
  'Releases an Active reservation before its window is fulfilled. Authentication: '
  'authenticated. Authorization: Assets.Operate, Assets.Manage, or the user the '
  'reservation was made for. Expected errors: NO_ACTIVE_TENANT, RESERVATION_NOT_FOUND, '
  'PERMISSION_DENIED, RESERVATION_NOT_ACTIVE.';

-- 6.14 asset_dispose_request — never direct; routes through the existing
--      approval chain (see section 5 above and the trigger in 6.15 below).
create or replace function public.asset_dispose_request(p_asset_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_asset public.assets%rowtype;
  v_template_id uuid;
  v_form_id uuid;
  v_ref text;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Assets.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if p_reason is null or trim(p_reason) = '' then raise exception 'DISPOSAL_REASON_REQUIRED'; end if;

  select * into v_asset from public.assets where id = p_asset_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'ASSET_NOT_FOUND'; end if;
  if v_asset.status = 'Disposed' then raise exception 'ASSET_ALREADY_DISPOSED'; end if;
  if v_asset.current_custodian_user_id is not null then raise exception 'ASSET_STILL_IN_CUSTODY'; end if;

  select id into v_template_id from public.templates
  where tenant_id = v_tenant and code = 'FM-SH-AST-D-26-0001\V1.0' and not is_deleted;
  if v_template_id is null then raise exception 'ASSET_DISPOSAL_TEMPLATE_NOT_FOUND'; end if;

  v_ref := public.generate_number('TA', v_tenant);

  insert into public.forms (
    tenant_id, template_id, employee_id, status, data_json, reference_no, requested_by, submission_mode
  ) values (
    v_tenant, v_template_id, auth.uid(), 'Draft',
    jsonb_build_object('assetId', p_asset_id, 'assetReference', v_asset.reference, 'reason', p_reason),
    v_ref, auth.uid(), 'Self'
  ) returning id into v_form_id;

  perform public.record_activity('Asset', p_asset_id, 'DISPOSAL_REQUESTED', 'تم تقديم طلب إتلاف', 'Disposal requested',
    jsonb_build_object('formId', v_form_id, 'reason', p_reason));

  return v_form_id;
end;
$$;
revoke all on function public.asset_dispose_request(uuid, text) from public;
grant execute on function public.asset_dispose_request(uuid, text) to authenticated;

comment on function public.asset_dispose_request(uuid, text) is
  'Creates a Draft Asset Disposal form; the frontend then calls the existing, UNCHANGED '
  'approval_submit()/approval_act() to route it. Actual disposal only happens via '
  'asset_dispose_on_form_approved() once the form reaches Approved. Authentication: '
  'authenticated. Authorization: Assets.Manage. Expected errors: NO_ACTIVE_TENANT, '
  'PERMISSION_DENIED, DISPOSAL_REASON_REQUIRED, ASSET_NOT_FOUND, ASSET_ALREADY_DISPOSED, '
  'ASSET_STILL_IN_CUSTODY (spec''s own rule: must be returned first), '
  'ASSET_DISPOSAL_TEMPLATE_NOT_FOUND.';

-- 6.15 asset_dispose_on_form_approved — trigger function; not directly callable.
create or replace function public.asset_dispose_on_form_approved()
returns trigger
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_is_disposal boolean;
  v_asset_id uuid;
  v_reason text;
  v_asset public.assets%rowtype;
begin
  select exists (
    select 1 from public.templates t
    where t.id = new.template_id and t.tenant_id = new.tenant_id and t.code = 'FM-SH-AST-D-26-0001\V1.0'
  ) into v_is_disposal;

  if not v_is_disposal then
    return null;
  end if;

  -- Re-check the same Assets.Manage gate asset_dispose_request() itself
  -- requires at request time. The exact-code match above already stops a
  -- differently-coded forged template from reaching this branch at all, but
  -- this re-check additionally guards against a form whose requester never
  -- held Assets.Manage in the first place.
  if not public.has_permission_for_user(new.requested_by, 'Assets.Manage') then
    return null;
  end if;

  v_asset_id := nullif(new.data_json ->> 'assetId', '')::uuid;
  v_reason := new.data_json ->> 'reason';
  if v_asset_id is null then
    return null;
  end if;

  select * into v_asset from public.assets where id = v_asset_id and tenant_id = new.tenant_id for update;
  if not found or v_asset.status = 'Disposed' then
    return null;
  end if;
  -- Re-check "still in custody" at actual disposal time, not just at
  -- request time — the approval chain can take an arbitrary amount of time,
  -- during which the asset may have been issued/transferred to someone.
  if v_asset.current_custodian_user_id is not null then
    return null;
  end if;

  insert into public.asset_transactions (
    tenant_id, asset_id, transaction_type, status, reason, related_form_id
  ) values (
    new.tenant_id, v_asset_id, 'Dispose', 'Completed', v_reason, new.id
  );

  update public.assets set status = 'Disposed', current_custodian_user_id = null, current_custody_unit_id = null
  where id = v_asset_id and tenant_id = new.tenant_id;

  perform public.record_activity('Asset', v_asset_id, 'DISPOSED', 'تم إتلاف الأصل', 'Asset disposed',
    jsonb_build_object('formId', new.id, 'reason', v_reason));

  return null;
end;
$$;

drop trigger if exists asset_dispose_on_form_approved on public.forms;
create trigger asset_dispose_on_form_approved
after update on public.forms
for each row
when (new.status = 'Approved' and old.status is distinct from new.status)
execute function public.asset_dispose_on_form_approved();

comment on function public.asset_dispose_on_form_approved() is
  'AFTER UPDATE trigger on public.forms, narrowly scoped to this module''s own '
  'FM-SH-AST-D-26-0001\V1.0 disposal template by EXACT code match (never a prefix/LIKE '
  'match, so a forged template under a different code can never reach this branch). '
  'Also re-checks that the form''s requester holds Assets.Manage and that the asset is '
  'still not in anyone''s custody, the same two gates asset_dispose_request() enforces '
  'at request time, since the approval chain can take arbitrarily long and either fact '
  'can change before approval lands. Fires the Dispose transaction and flips the asset '
  'snapshot to Disposed only once, idempotently (a second Approved transition on an '
  'already-Disposed asset, or one failing either re-check, is a no-op).';

-- 6.16 asset_attachment_list — wider-audience wrapper over public.attachments.
create or replace function public.asset_attachment_list(p_asset_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_asset public.assets%rowtype;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  select * into v_asset from public.assets where id = p_asset_id and tenant_id = v_tenant and not is_deleted;
  if not found then raise exception 'ASSET_NOT_FOUND'; end if;

  if not (
    public.has_permission('Assets.View')
    or public.has_permission('Assets.Manage')
    or public.has_permission('Assets.Operate')
    or v_asset.current_custodian_user_id = auth.uid()
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

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
        and a.entity_type = 'Asset'
        and a.entity_id = p_asset_id
        and not a.is_deleted
        and not o.is_deleted
    ) r
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.asset_attachment_list(uuid) from public;
grant execute on function public.asset_attachment_list(uuid) to authenticated;

comment on function public.asset_attachment_list(uuid) is
  'Wider-audience wrapper over public.attachments (entityType ''Asset''), per that '
  'module''s own documented pattern — attachment_list()''s own gate (owner/Storage.Manage) '
  'is too narrow for "anyone who can view this asset sees its photos". Authentication: '
  'authenticated. Authorization: Assets.View, Assets.Operate, or Assets.Manage, OR the '
  'asset''s current custodian. Expected errors: NO_ACTIVE_TENANT, ASSET_NOT_FOUND, '
  'PERMISSION_DENIED.';

-- 6.17 asset_timeline — "the most important screen" (spec's own words).
create or replace function public.asset_timeline(p_asset_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_asset public.assets%rowtype;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  select * into v_asset from public.assets where id = p_asset_id and tenant_id = v_tenant and not is_deleted;
  if not found then raise exception 'ASSET_NOT_FOUND'; end if;

  if not (
    public.has_permission('Assets.View')
    or public.has_permission('Assets.Manage')
    or public.has_permission('Assets.Operate')
    or v_asset.current_custodian_user_id = auth.uid()
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

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
        and at.entity_type = 'Asset'
        and at.entity_id = p_asset_id
        and not at.is_deleted
    ) r
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.asset_timeline(uuid) from public;
grant execute on function public.asset_timeline(uuid) to authenticated;

comment on function public.asset_timeline(uuid) is
  'Wider-audience wrapper over public.activity_timeline (entityType ''Asset''), per that '
  'module''s own documented pattern — activity_timeline_list()''s actor-or-Audit.View gate '
  'is too narrow here. Authentication: authenticated. Authorization: Assets.View, '
  'Assets.Operate, or Assets.Manage, OR the asset''s current custodian. Expected errors: '
  'NO_ACTIVE_TENANT, ASSET_NOT_FOUND, PERMISSION_DENIED.';

-- 6.18 asset_inventory_session_create
create or replace function public.asset_inventory_session_create(
  p_name_ar text, p_name_en text, p_start_date date, p_end_date date, p_notes text,
  p_custody_unit_ids uuid[], p_member_user_ids uuid[]
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
  if not public.has_permission('Assets.Inventory') then raise exception 'PERMISSION_DENIED'; end if;
  if p_name_ar is null or trim(p_name_ar) = '' then raise exception 'NAME_AR_REQUIRED'; end if;

  v_ref := public.generate_number('IN', v_tenant);

  insert into public.asset_inventory_sessions (tenant_id, reference, name_ar, name_en, status, start_date, end_date, notes)
  values (v_tenant, v_ref, trim(p_name_ar), nullif(trim(p_name_en), ''), 'Draft', p_start_date, p_end_date, p_notes)
  returning id into v_id;

  insert into public.asset_inventory_session_units (tenant_id, session_id, custody_unit_id)
  select v_tenant, v_id, cu
  from unnest(coalesce(p_custody_unit_ids, '{}'::uuid[])) as cu
  where exists (select 1 from public.asset_custody_units where id = cu and tenant_id = v_tenant and not is_deleted);

  insert into public.asset_inventory_session_members (tenant_id, session_id, user_id)
  select v_tenant, v_id, u
  from unnest(coalesce(p_member_user_ids, '{}'::uuid[])) as u
  where exists (select 1 from public.users where id = u and tenant_id = v_tenant and not is_deleted);

  perform public.record_activity('AssetInventorySession', v_id, 'CREATED', 'تم إنشاء جلسة جرد', 'Inventory session created',
    jsonb_build_object('reference', v_ref));

  return v_id;
end;
$$;
revoke all on function public.asset_inventory_session_create(text, text, date, date, text, uuid[], uuid[]) from public;
grant execute on function public.asset_inventory_session_create(text, text, date, date, text, uuid[], uuid[]) to authenticated;

comment on function public.asset_inventory_session_create(text, text, date, date, text, uuid[], uuid[]) is
  'Creates a Draft inventory (counting) session with a fresh generate_number(''IN'') '
  'reference, and its custody-unit/member scope. Authentication: authenticated. '
  'Authorization: Assets.Inventory. Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, '
  'NAME_AR_REQUIRED.';

-- 6.19 asset_inventory_session_start
create or replace function public.asset_inventory_session_start(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_s public.asset_inventory_sessions%rowtype;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Assets.Inventory') then raise exception 'PERMISSION_DENIED'; end if;

  select * into v_s from public.asset_inventory_sessions where id = p_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'INVENTORY_SESSION_NOT_FOUND'; end if;
  if v_s.status <> 'Draft' then raise exception 'INVENTORY_SESSION_NOT_DRAFT'; end if;

  update public.asset_inventory_sessions set status = 'InProgress' where id = p_id;

  perform public.record_activity('AssetInventorySession', p_id, 'STARTED', 'بدأت جلسة الجرد', 'Inventory session started',
    jsonb_build_object('reference', v_s.reference));
end;
$$;
revoke all on function public.asset_inventory_session_start(uuid) from public;
grant execute on function public.asset_inventory_session_start(uuid) to authenticated;

comment on function public.asset_inventory_session_start(uuid) is
  'Moves a Draft inventory session to InProgress, opening it up for scans. '
  'Authentication: authenticated. Authorization: Assets.Inventory. Expected errors: '
  'NO_ACTIVE_TENANT, PERMISSION_DENIED, INVENTORY_SESSION_NOT_FOUND, '
  'INVENTORY_SESSION_NOT_DRAFT.';

-- 6.20 asset_inventory_scan — parameters reordered (required first) for the
--      same Postgres-syntax reason as asset_reserve() above; 'Missing' is
--      rejected here on purpose (spec's own rule — it is never hand-scanned).
create or replace function public.asset_inventory_scan(
  p_session_id uuid,
  p_result_status text,
  p_scanned_code text default null,
  p_asset_id uuid default null,
  p_notes text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_session public.asset_inventory_sessions%rowtype;
  v_asset public.assets%rowtype;
  v_authorized boolean;
  v_id uuid;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if p_result_status not in (
    'Found', 'Missing', 'Damaged', 'WrongLocation', 'WrongCustodian',
    'NeedsMaintenance', 'Disposed', 'UnexpectedAsset', 'BarcodeMissing'
  ) then
    raise exception 'INVALID_RESULT_STATUS';
  end if;
  if p_result_status = 'Missing' then raise exception 'MISSING_IS_SYSTEM_GENERATED'; end if;

  select * into v_session from public.asset_inventory_sessions where id = p_session_id and tenant_id = v_tenant and not is_deleted;
  if not found then raise exception 'INVENTORY_SESSION_NOT_FOUND'; end if;
  if v_session.status <> 'InProgress' then raise exception 'INVENTORY_SESSION_NOT_IN_PROGRESS'; end if;

  v_authorized := public.has_permission('Assets.Inventory') or public.has_permission('Assets.Manage')
    or exists (
      select 1 from public.asset_inventory_session_members m
      where m.session_id = p_session_id and m.tenant_id = v_tenant and m.user_id = auth.uid() and not m.is_deleted
    );
  if not v_authorized then raise exception 'PERMISSION_DENIED'; end if;

  if p_asset_id is not null then
    select * into v_asset from public.assets where id = p_asset_id and tenant_id = v_tenant and not is_deleted;
    if not found then raise exception 'ASSET_NOT_FOUND'; end if;

    if exists (
      select 1 from public.asset_inventory_scans s
      where s.session_id = p_session_id and s.tenant_id = v_tenant and s.asset_id = p_asset_id
        and s.result_status <> 'Missing' and not s.is_deleted
    ) then
      raise exception 'ASSET_ALREADY_SCANNED_THIS_SESSION';
    end if;
  end if;

  begin
    insert into public.asset_inventory_scans (
      tenant_id, session_id, asset_id, scanned_code, result_status,
      expected_custody_unit_id, expected_custodian_user_id, notes, scanned_by
    ) values (
      v_tenant, p_session_id, p_asset_id, nullif(trim(p_scanned_code), ''), p_result_status,
      v_asset.current_custody_unit_id, v_asset.current_custodian_user_id, p_notes, auth.uid()
    ) returning id into v_id;
  exception when unique_violation then
    -- uq_asset_inventory_scans_active is the database-level backstop for the
    -- exists()-check above, closing the race between two concurrent scans of
    -- the same asset in the same session.
    raise exception 'ASSET_ALREADY_SCANNED_THIS_SESSION';
  end;

  if p_asset_id is not null then
    perform public.record_activity('Asset', p_asset_id, 'INVENTORY', 'تم جرد الأصل', 'Asset scanned in inventory',
      jsonb_build_object('sessionId', p_session_id, 'scanId', v_id, 'resultStatus', p_result_status));
  end if;

  return v_id;
end;
$$;
revoke all on function public.asset_inventory_scan(uuid, text, text, uuid, text) from public;
grant execute on function public.asset_inventory_scan(uuid, text, text, uuid, text) to authenticated;

comment on function public.asset_inventory_scan(uuid, text, text, uuid, text) is
  'Records one inventory scan result. Authentication: authenticated. Authorization: '
  'session member, or Assets.Inventory, or Assets.Manage. Expected errors: '
  'NO_ACTIVE_TENANT, INVALID_RESULT_STATUS, MISSING_IS_SYSTEM_GENERATED (Missing is only '
  'ever produced by asset_inventory_session_complete()), INVENTORY_SESSION_NOT_FOUND, '
  'INVENTORY_SESSION_NOT_IN_PROGRESS, PERMISSION_DENIED, ASSET_NOT_FOUND, '
  'ASSET_ALREADY_SCANNED_THIS_SESSION.';

-- 6.21 asset_inventory_session_complete
create or replace function public.asset_inventory_session_complete(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_s public.asset_inventory_sessions%rowtype;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not (public.has_permission('Assets.Inventory') or public.has_permission('Assets.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;

  select * into v_s from public.asset_inventory_sessions where id = p_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then raise exception 'INVENTORY_SESSION_NOT_FOUND'; end if;
  if v_s.status <> 'InProgress' then raise exception 'INVENTORY_SESSION_NOT_IN_PROGRESS'; end if;

  -- Missing is never hand-scanned (spec's own rule): every asset in this
  -- session's custody-unit scope that received no scan row at all gets one
  -- now, auto-generated, exactly once, at close time.
  insert into public.asset_inventory_scans (
    tenant_id, session_id, asset_id, scanned_code, result_status,
    expected_custody_unit_id, expected_custodian_user_id, notes, scanned_by
  )
  select
    v_tenant, p_id, a.id, null, 'Missing',
    a.current_custody_unit_id, a.current_custodian_user_id,
    'auto-generated: not scanned before session closed', null
  from public.assets a
  where a.tenant_id = v_tenant
    and not a.is_deleted
    and a.current_custody_unit_id in (
      select su.custody_unit_id from public.asset_inventory_session_units su
      where su.session_id = p_id and su.tenant_id = v_tenant and not su.is_deleted
    )
    and not exists (
      select 1 from public.asset_inventory_scans sc
      where sc.session_id = p_id and sc.tenant_id = v_tenant and sc.asset_id = a.id and not sc.is_deleted
    );

  update public.asset_inventory_sessions
  set status = 'Completed', end_date = coalesce(end_date, current_date)
  where id = p_id;

  perform public.record_activity('AssetInventorySession', p_id, 'COMPLETED', 'اكتملت جلسة الجرد', 'Inventory session completed',
    jsonb_build_object('reference', v_s.reference));
end;
$$;
revoke all on function public.asset_inventory_session_complete(uuid) from public;
grant execute on function public.asset_inventory_session_complete(uuid) to authenticated;

comment on function public.asset_inventory_session_complete(uuid) is
  'Closes an inventory session and auto-generates Missing scan rows for every in-scope '
  'asset that was never scanned (spec''s own rule — Missing can never be hand-scanned). '
  'Authentication: authenticated. Authorization: Assets.Inventory or Assets.Manage. '
  'Expected errors: NO_ACTIVE_TENANT, PERMISSION_DENIED, INVENTORY_SESSION_NOT_FOUND, '
  'INVENTORY_SESSION_NOT_IN_PROGRESS.';

-- 6.24 asset_last_movement_for_ids — one row per asset, its single most
-- recent transaction timestamp, computed server-side with DISTINCT ON
-- instead of the client fetching every matching transaction row and
-- reducing to latest-per-asset itself (closing-audit/release-gate finding —
-- assetsService.js's loadLastMovementForAssets()/AssetInventoryAdmin.jsx's
-- LastTransactionInfo both used to pull whole histories for a single
-- column's worth of data).
create or replace function public.asset_last_movement_for_ids(p_asset_ids uuid[])
returns table (asset_id uuid, performed_on timestamptz, transaction_type text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (t.asset_id) t.asset_id, t.performed_on, t.transaction_type
  from public.asset_transactions t
  where t.tenant_id = public.current_tenant_id()
    and t.asset_id = any(coalesce(p_asset_ids, array[]::uuid[]))
    and (
      public.has_permission('Assets.View') or public.has_permission('Assets.Operate')
      or public.has_permission('Assets.Manage') or public.has_permission('Assets.Maintain')
      or public.has_permission('Assets.Inventory')
    )
  order by t.asset_id, t.performed_on desc;
$$;
revoke all on function public.asset_last_movement_for_ids(uuid[]) from public;
grant execute on function public.asset_last_movement_for_ids(uuid[]) to authenticated;

comment on function public.asset_last_movement_for_ids(uuid[]) is
  'One row per input asset id: that asset''s single most recent transaction (timestamp + '
  'type). Authentication: authenticated. Authorization: any Assets.* permission (View/'
  'Operate/Manage/Maintain/Inventory) — returns no rows at all for a caller holding none, '
  'rather than raising, so callers can treat an empty result the same as "nothing found".';

-- ----------------------------------------------------------------------------
-- 7. Module registration + navigation (mirrors migration 202608060049's
--    DIGITAL_IDENTITY registration exactly).
-- ----------------------------------------------------------------------------
insert into public.platform_modules (code, name_ar, name_en, category, display_order, is_core)
values ('ASSETS', 'إدارة الأصول', 'Assets Management', 'Core', 170, false)
on conflict (code) do nothing;

update public.platform_licenses
set module_codes = array_append(module_codes, 'ASSETS')
where code = 'FREE' and not ('ASSETS' = any (module_codes));

insert into public.app_screens (code, module_code, area, group_code, name_ar, name_en, icon, route, display_order, min_role_rank)
values
  ('PORTAL_ASSETS', 'ASSETS', 'Portal', 'Workspace', 'أصولي', 'My Assets', 'package', 'assets', 190, 1),
  ('ADMIN_ASSET_GROUPS', 'ASSETS', 'Admin', 'Assets', 'مجموعات الأصول', 'Asset Groups', 'layers', 'admin/asset-groups', 10, 3),
  ('ADMIN_ASSET_CUSTODY_UNITS', 'ASSETS', 'Admin', 'Assets', 'وحدات العهدة', 'Custody Units', 'warehouse', 'admin/asset-custody-units', 20, 3),
  ('ADMIN_ASSETS_CATALOGUE', 'ASSETS', 'Admin', 'Assets', 'كتالوج الأصول', 'Assets Catalogue', 'boxes', 'admin/assets', 30, 3),
  ('ADMIN_ASSET_INVENTORY', 'ASSETS', 'Admin', 'Assets', 'جرد الأصول', 'Asset Inventory', 'clipboard-check', 'admin/asset-inventory', 40, 3),
  ('ADMIN_ASSET_REPORTS', 'ASSETS', 'Admin', 'Assets', 'تقارير الأصول', 'Asset Reports', 'bar-chart-3', 'admin/asset-reports', 50, 3)
on conflict (code) do update set
  module_code = excluded.module_code, area = excluded.area, group_code = excluded.group_code,
  name_ar = excluded.name_ar, name_en = excluded.name_en, icon = excluded.icon,
  route = excluded.route, display_order = excluded.display_order, min_role_rank = excluded.min_role_rank,
  is_active = true, updated_on = now();

-- ----------------------------------------------------------------------------
-- 8. attachment_attach() hardening for entity_type = 'Asset'.
--
-- attachment_attach() (202608050040) only ever checked the CALLER'S
-- relationship to the storage object (owner/creator/Storage.Manage) — never
-- the caller's relationship to the entity being attached to. That means any
-- tenant member who has ever uploaded any file could attach it to any
-- asset, with zero Assets permission and no custody of it. Assets is the
-- only module wired into this shared RPC whose write surface actually
-- needs narrowing here (Digital Identity/Forms/Approval callers keep their
-- exact original behavior — this full re-declaration only adds one new
-- conditional branch gated on p_entity_type = 'Asset', it does not touch
-- the shared owner/Storage.Manage check above it). Placed in this migration
-- (not 202608050040) because public.assets/asset_maintenance don't exist
-- yet at that earlier point in the chain.
--
-- The reporter of an open maintenance case is deliberately still allowed:
-- asset_maintenance_report() itself has no permission gate (anyone can
-- report an issue), so whoever reported it must still be able to attach
-- their own photo evidence.
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
  'Authorization: storage object owner/creator or Storage.Manage, PLUS — for entity_type '
  '''Asset'' only — Assets.Manage/Operate/Maintain, the asset''s current custodian, or the '
  'reporter of an open maintenance case on that asset. Expected errors: NO_TENANT_CONTEXT, '
  'ENTITY_TYPE_REQUIRED, ENTITY_ID_REQUIRED, STORAGE_OBJECT_NOT_FOUND, PERMISSION_DENIED.';

-- ----------------------------------------------------------------------------
-- Mandatory closer: every migration batch ends with this, or a GRANT earlier
-- in the same file (or an earlier migration) re-materializes the function's
-- PUBLIC-execute footgun (see 202608050037's header for what that means).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;