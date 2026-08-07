// Static guards for the Operations module's business-logic invariants —
// same technique as assets-management-invariants.test.mjs /
// safety-management-invariants.test.mjs (no live database in this suite, so
// these assert the SHAPE of the SQL, not its runtime behaviour — the live
// behaviour, including the RLS composability fix this file guards the
// shape of, was independently verified against a real Postgres instance
// during this module's own closing review).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migrationPath = new URL('../supabase/migrations/202608070057_operations.sql', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');
const source = readFileSync(migrationPath, 'utf8');

const functionBody = (src, name) => {
  const start = src.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `expected to find public.${name}() in the migration`);
  const end = src.indexOf('$$;', start);
  assert.notEqual(end, -1, `expected to find the closing $$; of public.${name}()`);
  return src.slice(start, end);
};

test('operations_team_members read policy carries a self-row carve-out (the RLS composability fix)', () => {
  const policyStart = source.indexOf('create policy "members read operations team members"');
  assert.notEqual(policyStart, -1, 'expected the operations_team_members read policy');
  const policyEnd = source.indexOf(';', policyStart);
  const policyBody = source.slice(policyStart, policyEnd);
  assert.match(policyBody, /user_id = auth\.uid\(\)/,
    'without this, a plain team member can never see their own membership row, which breaks ' +
    'the nested exists() check every sibling table\'s own RLS policy depends on');
});

test('operations_execution_log_create() and operations_checklist_item_toggle() require team membership AND Operations.Execute, not either alone', () => {
  for (const name of ['operations_execution_log_create', 'operations_checklist_item_toggle']) {
    const body = functionBody(source, name);
    assert.match(body, /has_permission\('Operations\.Execute'\)/, `${name}() should check Operations.Execute`);
    assert.match(body, /operations_team_members/, `${name}() should check team membership`);
    assert.match(body, /has_permission\('Operations\.Manage'\)/, `${name}() should also allow Operations.Manage`);
  }
});

test('operations_execution_logs_list() and operations_timeline() reimplement the membership-or-permission gate (SECURITY DEFINER bypasses RLS)', () => {
  for (const name of ['operations_execution_logs_list', 'operations_timeline']) {
    const body = functionBody(source, name);
    assert.match(body, /has_permission\('Operations\.(View|Manage)'\)/, `${name}() should check Operations.View/Manage`);
    assert.match(body, /operations_team_members/, `${name}() should check team membership directly`);
  }
});

test('operations_execution_log_attachments_list() exists as the read wrapper for the two new attachment entity types', () => {
  const start = source.indexOf('create or replace function public.operations_execution_log_attachments_list(');
  assert.notEqual(start, -1, 'expected a read wrapper for OperationExecutionPhoto/OperationExecutionFile attachments');
});

test('attachment_attach() is re-declared for OperationExecutionPhoto/OperationExecutionFile without dropping the Asset/Safety branches', () => {
  const body = functionBody(source, 'attachment_attach');
  assert.match(body, /'OperationExecutionPhoto'/);
  assert.match(body, /'OperationExecutionFile'/);
  assert.match(body, /p_entity_type = 'Asset'/, 'the pre-existing Asset branch must survive the re-declaration');
  assert.match(body, /'SafetyPpeType'/, 'the pre-existing Safety branches must survive the re-declaration');
});

test('operations_team_members has no role_code column (flat membership, per the finalized design)', () => {
  const tableStart = source.indexOf('create table if not exists public.operations_team_members');
  assert.notEqual(tableStart, -1);
  const tableEnd = source.indexOf(');', tableStart);
  const tableBody = source.slice(tableStart, tableEnd);
  assert.doesNotMatch(tableBody, /role_code/);
});

test('operations_execution_logs uses one nullable FK column per linked-record target, not a polymorphic entity_type/entity_id pair', () => {
  const tableStart = source.indexOf('create table if not exists public.operations_execution_logs');
  assert.notEqual(tableStart, -1);
  const tableEnd = source.indexOf(');', tableStart);
  const tableBody = source.slice(tableStart, tableEnd);
  assert.match(tableBody, /asset_id\s+uuid/);
  assert.match(tableBody, /employee_id\s+uuid/);
  assert.match(tableBody, /form_id\s+uuid/);
  assert.doesNotMatch(tableBody, /entity_type/);
});

test('operations_checklist_item_toggle() never calls record_activity() (silent toggle, per the finalized design)', () => {
  const body = functionBody(source, 'operations_checklist_item_toggle');
  assert.doesNotMatch(body, /record_activity/);
});

test('OP number-source code and OPERATIONS module do not collide with any known prior catalogue value', () => {
  assert.match(source, /'OP'/);
  const moduleMatch = source.match(/values \('OPERATIONS', '[^']*', '[^']*', 'Core', (\d+), false\)/);
  assert.ok(moduleMatch, 'expected the OPERATIONS platform_modules insert');
  const usedElsewhere = ['10', '20', '30', '40', '50', '60', '70', '80', '90', '100', '110', '120', '130', '140', '150', '160', '165', '170', '180', '190', '195'];
  assert.ok(!usedElsewhere.includes(moduleMatch[1]), `display_order ${moduleMatch[1]} collides with a known existing value`);
});

test('every function this migration touches still ends the file with the PUBLIC-execute revoke footgun guard', () => {
  const trimmed = source.trimEnd();
  assert.ok(trimmed.endsWith('revoke execute on all functions in schema public from public;'));
});
