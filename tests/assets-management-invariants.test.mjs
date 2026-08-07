// Static guards for the Assets Management module's business-logic invariants
// — same technique as tenancy-invariants.test.mjs (no live database in this
// suite, so these assert the SHAPE of the SQL, not its runtime behaviour).
// Written to close the release-gate finding that this large, high-risk
// module (21 RPCs, several state machines) had zero automated coverage.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migrationPath = new URL('../supabase/migrations/202608060054_assets_management.sql', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');
const attachmentFrameworkPath = new URL('../supabase/migrations/202608050040_attachment_framework.sql', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');
const source = readFileSync(migrationPath, 'utf8');
const attachmentFrameworkSource = readFileSync(attachmentFrameworkPath, 'utf8');

/** Slices out one `create or replace function <name>(...` body up to its closing `$$;`. */
const functionBody = (src, name) => {
  const start = src.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `expected to find public.${name}() in the migration`);
  const end = src.indexOf('$$;', start);
  assert.notEqual(end, -1, `expected to find the closing $$; of public.${name}()`);
  return src.slice(start, end);
};

test('assets.status never accepts Reserved — a reservation is a future-dated overlay, not a status', () => {
  const tableStart = source.indexOf('create table if not exists public.assets');
  assert.notEqual(tableStart, -1);
  const tableEnd = source.indexOf(');', tableStart);
  const tableBody = source.slice(tableStart, tableEnd);
  const checkClauseMatch = tableBody.match(/check \(status in \(([^)]*)\)\)/);
  assert.ok(checkClauseMatch, 'expected to find the assets.status CHECK constraint');
  assert.equal(checkClauseMatch[1], "'Available', 'InUse', 'InMaintenance', 'Lost', 'Disposed'");
});

test('asset_transfer_accept() re-validates custody before applying a pending transfer', () => {
  const body = functionBody(source, 'asset_transfer_accept');
  assert.match(body, /current_custodian_user_id is distinct from v_txn\.from_custodian_user_id/);
  assert.match(body, /TRANSFER_STALE_CUSTODY_CHANGED/);
  // The stale branch must cancel the transaction, not silently fall through
  // to the unconditional update below it.
  const staleIdx = body.indexOf('TRANSFER_STALE_CUSTODY_CHANGED');
  const cancelIdx = body.lastIndexOf("status = 'Cancelled'", staleIdx);
  assert.ok(cancelIdx !== -1 && cancelIdx < staleIdx, 'expected the stale-custody branch to cancel the transaction before raising');
});

test('asset_update() rejects a multi-hop cycle in the parent/child hierarchy, not just direct self-parenting', () => {
  const body = functionBody(source, 'asset_update');
  assert.match(body, /ASSET_CANNOT_BE_OWN_PARENT/);
  assert.match(body, /with recursive ancestors as/);
  assert.match(body, /ASSET_HIERARCHY_CYCLE/);
});

test('asset_maintenance_advance() blocks every asset-adjacent transition once the asset is Disposed', () => {
  const body = functionBody(source, 'asset_maintenance_advance');
  assert.match(body, /if v_asset\.status = 'Disposed' and p_new_status in \('Sent', 'UnderMaintenance', 'Completed', 'Returned'\)/);
});

test('asset_custody_unit_upsert() enforces the site belongs to the chosen project server-side', () => {
  const body = functionBody(source, 'asset_custody_unit_upsert');
  assert.match(body, /SITE_PROJECT_MISMATCH/);
  assert.match(body, /project_id = p_project_id/);
});

test('asset_timeline() and asset_attachment_list() both accept Assets.Operate, matching the RLS they wrap', () => {
  for (const name of ['asset_timeline', 'asset_attachment_list']) {
    const body = functionBody(source, name);
    assert.match(body, /has_permission\('Assets\.Operate'\)/, `${name}() should check Assets.Operate`);
  }
});

test('asset_last_movement_for_ids() exists, is tenant-scoped, and requires some Assets permission', () => {
  const start = source.indexOf('create or replace function public.asset_last_movement_for_ids(');
  assert.notEqual(start, -1);
  const end = source.indexOf('$$;', start);
  const body = source.slice(start, end);
  assert.match(body, /current_tenant_id\(\)/);
  assert.match(body, /has_permission\('Assets\.View'\)/);
  assert.match(body, /distinct on \(t\.asset_id\)/);
});

test('attachment_attach() is re-declared for entity_type = Asset with an authorization check beyond storage-object ownership', () => {
  // The original 202608050040 declaration must still exist (other modules'
  // behavior is unchanged) ...
  assert.match(attachmentFrameworkSource, /create or replace function public\.attachment_attach\(/);
  // ... and this migration must re-declare it with the Asset-specific branch.
  const start = source.indexOf('create or replace function public.attachment_attach(');
  assert.notEqual(start, -1, 'expected assets_management.sql to re-declare attachment_attach()');
  const end = source.indexOf('$$;', start);
  const body = source.slice(start, end);
  assert.match(body, /p_entity_type = 'Asset'/);
  assert.match(body, /Assets\.Manage/);
  assert.match(body, /current_custodian_user_id = auth\.uid\(\)/);
  assert.match(body, /reported_by = auth\.uid\(\)/);
});

test('maintenance-approval notifications route to the admin screen; reporter-facing ones stay on the portal', () => {
  const approveNeeded = source.slice(
    source.indexOf("'AS_MAINTENANCE_APPROVAL_NEEDED'"),
    source.indexOf("'AS_MAINTENANCE_APPROVAL_NEEDED'") + 1200,
  );
  assert.match(approveNeeded, /\/app\/admin\/assets\?asset=/);

  const approved = source.slice(
    source.indexOf("'AS_MAINTENANCE_APPROVED'"),
    source.indexOf("'AS_MAINTENANCE_APPROVED'") + 1200,
  );
  assert.match(approved, /\/app\/assets\?asset=/);

  const completed = source.slice(
    source.indexOf("'AS_MAINTENANCE_COMPLETED'"),
    source.indexOf("'AS_MAINTENANCE_COMPLETED'") + 1200,
  );
  assert.match(completed, /\/app\/assets\?asset=/);
});

test('every function this migration touches still ends the file with the PUBLIC-execute revoke footgun guard', () => {
  const trimmed = source.trimEnd();
  assert.ok(trimmed.endsWith('revoke execute on all functions in schema public from public;'));
});
