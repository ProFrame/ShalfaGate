-- ============================================================================
-- 055 — Assets Management closing audit fixes
--
-- Same closing-audit process as Verification (048) and Digital Identity
-- (050): 11 independent lenses + adversarial verify over the whole module
-- (migration 054, assetsService.js, all 6 screens), then fix everything
-- confirmed in-scope. 38 confirmed findings; this migration carries the
-- SQL-layer ones. Frontend/doc fixes are in their own files, not here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. [Major/Database] asset_inventory_scans' own SELECT policy was narrower
--    than what asset_inventory_scan() itself already authorizes to WRITE. The
--    RPC lets any session member (added via p_member_user_ids at session
--    creation, no Assets permission required) record a scan, but the read
--    policy only let a scan's own scanner, or an Assets.Inventory/Manage
--    holder, read it back — missing the session-member branch that the
--    sibling policies on asset_inventory_sessions and
--    asset_inventory_session_units both already have. A plain session member
--    could therefore submit scans but never see teammates' scans, and could
--    never see the auto-generated 'Missing' rows either (scanned_by is null
--    on those, which never equals auth.uid()) — silently incomplete tallies,
--    no error anywhere in the path.
-- ----------------------------------------------------------------------------
drop policy if exists "members read inventory scans" on public.asset_inventory_scans;
create policy "members read inventory scans" on public.asset_inventory_scans
  for select to authenticated
  using (
    not is_deleted and (
      scanned_by = auth.uid()
      or public.has_permission('Assets.Inventory')
      or public.has_permission('Assets.Manage')
      or exists (
        select 1 from public.asset_inventory_session_members m
        where m.session_id = asset_inventory_scans.session_id
          and m.tenant_id = asset_inventory_scans.tenant_id
          and m.user_id = auth.uid()
          and not m.is_deleted
      )
    )
  );

-- ----------------------------------------------------------------------------
-- 2. [Blocker/Performance] AssetsPortal.jsx had no way to find "transfers
--    pending my acceptance" other than fanning out one asset_transactions
--    query per tenant asset (contract §17 N+1). asset_transactions' own RLS
--    already lets a caller read rows where they are to_custodian_user_id, so
--    the frontend fix (a plain filtered select, landing in the same commit as
--    this migration) needs no new RPC — only an index backing that filter,
--    which did not exist: the table's two indexes (tenant-only, and
--    tenant+asset+performed_on) support neither a to_custodian_user_id nor a
--    status lookup.
-- ----------------------------------------------------------------------------
create index if not exists idx_asset_transactions_pending_recipient
  on public.asset_transactions (tenant_id, to_custodian_user_id, performed_on desc)
  where status = 'PendingAcceptance';

-- ----------------------------------------------------------------------------
-- 3. [Major/Database] loadAssets() never had a supporting index for its own
--    default sort (order by created_on desc) — only idx_assets_tenant
--    (tenant_id alone) existed, so every catalogue/report read had to sort
--    the whole RLS-filtered result set in memory on every call.
-- ----------------------------------------------------------------------------
create index if not exists idx_assets_tenant_created
  on public.assets (tenant_id, created_on desc);

-- ----------------------------------------------------------------------------
-- 4. [Minor/Cross-module] platform_modules.display_order for 'ASSETS' (170)
--    collided with the pre-existing 'PUBLIC_API' row seeded in migration
--    202608040012 (also 170) — every other module in that catalogue uses a
--    distinct multiple of 10; Digital Identity correctly slotted into the
--    165 gap for exactly this reason and Assets should have picked an unused
--    value the same way instead of reusing 170 outright.
-- ----------------------------------------------------------------------------
update public.platform_modules set display_order = 190 where code = 'ASSETS';

revoke execute on all functions in schema public from public;
