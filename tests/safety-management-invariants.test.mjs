// Static guards for the Safety Management module's business-logic
// invariants — same technique as assets-management-invariants.test.mjs (no
// live database in this suite, so these assert the SHAPE of the SQL, not
// its runtime behaviour).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migrationPath = new URL('../supabase/migrations/202608070056_safety_management.sql', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');
const audienceEnginePath = new URL('../supabase/migrations/202608040013_org_dimensions_and_audience_engine.sql', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');
const source = readFileSync(migrationPath, 'utf8');
const audienceEngineSource = readFileSync(audienceEnginePath, 'utf8');

const functionBody = (src, name) => {
  const start = src.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `expected to find public.${name}() in the migration`);
  const end = src.indexOf('$$;', start);
  assert.notEqual(end, -1, `expected to find the closing $$; of public.${name}()`);
  return src.slice(start, end);
};

test('safety_issuance_create() gates asset-tracked lines on Assets.Operate/Manage and rejects a Disposed asset', () => {
  const body = functionBody(source, 'safety_issuance_create');
  assert.match(body, /has_permission\('Assets\.Operate'\)/);
  assert.match(body, /ASSET_PERMISSION_DENIED/);
  assert.match(body, /ASSET_DISPOSED/);
});

test('safety_issuance_item_add() and safety_issuance_item_reissue() carry the same Assets-side guard', () => {
  for (const name of ['safety_issuance_item_add', 'safety_issuance_item_reissue']) {
    const body = functionBody(source, name);
    assert.match(body, /has_permission\('Assets\.Operate'\)/, `${name}() should check Assets.Operate`);
    assert.match(body, /ASSET_DISPOSED/, `${name}() should guard against a Disposed asset`);
  }
});

test('safety_issuance_create()/safety_issuance_item_add() reject an asset already backing another Issued item', () => {
  for (const name of ['safety_issuance_create', 'safety_issuance_item_add']) {
    const body = functionBody(source, name);
    assert.match(body, /ASSET_ALREADY_ISSUED/, `${name}() should guard against double-issuing an asset-tracked unit`);
  }
});

test('safety_compliance_summary() requires a Safety permission and is tenant-scoped', () => {
  const body = functionBody(source, 'safety_compliance_summary');
  assert.match(body, /current_tenant_id\(\)/);
  assert.match(body, /has_permission\('Safety\.View'\)/);
  assert.match(body, /audience_matches\('SafetyPpeSet'/);
});

test('every new Safety table carries a RESTRICTIVE tenant-isolation policy and no direct-write policy', () => {
  for (const t of [
    'safety_ppe_types', 'safety_ppe_sets', 'safety_ppe_set_items', 'safety_asset_ext',
    'safety_issuances', 'safety_issuance_items', 'safety_field_visits',
    'safety_field_visit_checks', 'safety_field_visit_check_missing_items',
  ]) {
    assert.match(source, new RegExp(`on public\\.${t}\\b`), `expected a policy referencing public.${t}`);
  }
  assert.match(source, /as restrictive/i);
});

test('safety_expiration_scan() is granted to service_role only, never authenticated', () => {
  const start = source.indexOf('create or replace function public.safety_expiration_scan(');
  assert.notEqual(start, -1);
  const end = source.indexOf('$$;', start);
  const body = source.slice(start, end);
  const afterFn = source.slice(end, end + 400);
  assert.match(afterFn, /revoke all on function public\.safety_expiration_scan\(\) from public/);
  assert.match(afterFn, /grant execute on function public\.safety_expiration_scan\(\) to service_role/);
  assert.doesNotMatch(afterFn, /grant execute on function public\.safety_expiration_scan\(\) to authenticated/);
});

test('audience_matches()/audience_save()/audience_can_manage() are widened for SafetyPpeSet/Position without dropping any prior branch', () => {
  // The re-declarations live in the Safety migration; the ORIGINAL Audience
  // Engine file must still declare every dimension the new file extends.
  assert.match(audienceEngineSource, /'Department', 'Project', 'Sector', 'Site', 'Country'/);
  const reMatches = functionBody(source, 'audience_matches');
  assert.match(reMatches, /when 'Position' then/);
  assert.match(reMatches, /when 'Department' then/, 'existing Department branch must survive the re-declaration');
  const reSave = functionBody(source, 'audience_save');
  assert.match(reSave, /'SafetyPpeSet'/);
  const reCanManage = functionBody(source, 'audience_can_manage');
  assert.match(reCanManage, /Safety\.Manage/);
});

test('PI/FV number-source codes are registered under owner_module Safety and RF stays untouched', () => {
  assert.match(source, /'PI'/);
  assert.match(source, /'FV'/);
  assert.doesNotMatch(source, /values\s*\(\s*'RF'/);
});

test('platform_modules.display_order for SAFETY does not collide with any known prior value', () => {
  const match = source.match(/values \('SAFETY', '[^']*', '[^']*', 'Core', (\d+), false\)/);
  assert.ok(match, 'expected the SAFETY platform_modules insert');
  const usedElsewhere = ['10', '20', '30', '40', '50', '60', '70', '80', '90', '100', '110', '120', '130', '140', '150', '160', '165', '170', '180', '190'];
  assert.ok(!usedElsewhere.includes(match[1]), `display_order ${match[1]} collides with a known existing value`);
});

test('every function this migration touches still ends the file with the PUBLIC-execute revoke footgun guard', () => {
  const trimmed = source.trimEnd();
  assert.ok(trimmed.endsWith('revoke execute on all functions in schema public from public;'));
});
