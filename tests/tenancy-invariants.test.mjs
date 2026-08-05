// Static guards for the invariants that keep one company's data out of
// another's. They run without a database, in a second, on every push — so the
// class of defect that is easiest to introduce and hardest to notice cannot be
// merged silently.
//
// A live database test is still owed for the runtime behaviour of the policies;
// this suite guards the shape of the code that produces them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const sources = new Map(files.map((f) => [f, readFileSync(join(MIGRATIONS, f), 'utf8')]));
const all = [...sources.values()].join('\n');

/** Migrations from the multi-tenant pivot onwards. Everything before 0012 is
 *  the single-company history and is rewritten by 0012 itself. */
const modern = files.filter((f) => f >= '202608040012');

// ---------------------------------------------------------------------------
// SECURITY DEFINER functions
// ---------------------------------------------------------------------------

/**
 * A definer function runs as its owner, so row level security does not apply to
 * it: whatever it selects, it returns. Every one of them must therefore either
 * scope itself to a company, or be an operator-only function, or appear here
 * with a reason.
 */
const NOT_TENANT_SCOPED_BY_DESIGN = {
  'public.slug_is_available': 'answers whether a slug is free across the whole platform — that is the question',
  'public.audience_can_manage': 'permission predicate only, touches no company data',
  'public.guard_calendar_event': 'trigger function, operates on the row being written',
  'public.support_next_ticket_no': 'allocates a ticket number, reads no company data',
  'public.support_ticket_status': 'public ticket lookup, authenticated by the ticket access token',
  'public.provision_tenant_preflight': 'validates a signup payload before any company exists',
  'public.platform_tenant_id': 'returns the operator workspace id, which is not secret',
  'public.request_client_ip': 'reads the request headers',
  'public.request_user_agent': 'reads the request headers',
  'public.record_login': 'writes an authentication audit row; deliberately reveals nothing',
  'public.notify_approval_assignment':
    'trigger on form_approval_transactions; the composite foreign key (tenant_id, form_id) '
    + 'guarantees the form it reads is the same company, and notify() resolves the recipient tenant',
};

const functionBlocks = (src) => {
  const blocks = [];
  const re = /create or replace function\s+(public\.\w+)\s*\(/g;
  let match;
  while ((match = re.exec(src))) {
    const start = match.index;
    // A function body ends at the closing dollar-quote of its own tag.
    const tagMatch = src.slice(start).match(/as\s+(\$\w*\$)/);
    if (!tagMatch) continue;
    const tag = tagMatch[1];
    const bodyStart = start + tagMatch.index + tagMatch[0].length;
    const bodyEnd = src.indexOf(tag, bodyStart);
    if (bodyEnd === -1) continue;
    blocks.push({ name: match[1], body: src.slice(start, bodyEnd + tag.length) });
  }
  return blocks;
};

test('every SECURITY DEFINER function scopes itself to a company, guards on the operator role, or is documented', () => {
  const offenders = [];

  for (const file of modern) {
    for (const fn of functionBlocks(sources.get(file))) {
      if (!/security definer/i.test(fn.body)) continue;

      const scoped = /current_tenant_id\s*\(\)/.test(fn.body)
        || /\btenant_id\b/.test(fn.body)
        || /p_tenant_id/.test(fn.body);
      const operatorOnly = /is_platform_operator\s*\(\)/.test(fn.body);
      const documented = Object.hasOwn(NOT_TENANT_SCOPED_BY_DESIGN, fn.name);

      if (!scoped && !operatorOnly && !documented) offenders.push(`${file} :: ${fn.name}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `These SECURITY DEFINER functions bypass RLS without scoping to a company.\n`
    + `Either filter by public.current_tenant_id(), guard with public.is_platform_operator(),\n`
    + `or add the function to NOT_TENANT_SCOPED_BY_DESIGN in this test with the reason why:\n  `
    + offenders.join('\n  '),
  );
});

// ---------------------------------------------------------------------------
// The anonymous surface
// ---------------------------------------------------------------------------

/** Everything an unauthenticated visitor can call. Adding to this list is a
 *  security decision and must be a deliberate, reviewed edit. */
const ANON_CALLABLE = new Set([
  'public.approval_verify(text)',
  'public.provision_tenant_preflight(jsonb)',
  'public.record_login(boolean, text, text, text)',
  'public.request_client_ip()',
  'public.request_user_agent()',
  'public.slug_is_available(text)',
  'public.support_ticket_create(jsonb)',
  'public.support_ticket_reply_public(text, text, text)',
  'public.support_ticket_status(text, text)',
  'public.tenant_public_profile(text)',
  'public.verify_document(text)',
]);

test('nothing new is exposed to anonymous callers without review', () => {
  const granted = new Set();
  for (const line of all.split('\n')) {
    const match = line.match(/^grant execute on function\s+(.+?)\s+to\s+(.+);$/i);
    if (match && /\banon\b/.test(match[2])) granted.add(match[1].trim());
  }

  const added = [...granted].filter((g) => !ANON_CALLABLE.has(g));
  assert.deepEqual(
    added,
    [],
    'New functions were granted to anon. Confirm each one is safe for an unauthenticated\n'
    + 'caller — including what it reveals about which accounts and companies exist — then\n'
    + 'add it to ANON_CALLABLE in this test:\n  ' + added.join('\n  '),
  );
});

// ---------------------------------------------------------------------------
// Table plumbing
// ---------------------------------------------------------------------------

/**
 * Table names listed inside a `text[] := array[...]` block, which is how the
 * migrations apply policies and triggers in bulk. Collected across every
 * migration, because a later one may legitimately fix an earlier omission.
 */
const LOOP_COVERED = (() => {
  const names = new Set();
  for (const block of all.matchAll(/text\[\]\s*:=\s*array\[([\s\S]*?)\]/g)) {
    for (const name of block[1].matchAll(/'(\w+)'/g)) names.add(name[1]);
  }
  return names;
})();

/**
 * Company infrastructure, not company content. These carry tenant_id but are
 * governed by hand-written policies instead of the generic pair, because their
 * access rules are not "rows of the current company":
 *   tenant_memberships  a person must see their own membership of EVERY company
 *                       they belong to, otherwise they can never switch into one
 *   tenant_modules      readable by members, writable only by the operator
 *   tenant_quotas       same
 *   tenant_usage_daily  same
 * They also have no created_by / row_version columns, so apply_row_defaults
 * does not apply to them.
 */
const TENANT_INFRASTRUCTURE = new Set([
  'tenant_memberships',
  'tenant_modules',
  'tenant_quotas',
  'tenant_usage_daily',
]);

const tenantTables = () => {
  const found = [];
  for (const file of modern) {
    const src = sources.get(file);
    for (const match of src.matchAll(/create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
      const [, name, columns] = match;
      if (TENANT_INFRASTRUCTURE.has(name)) continue;
      if (/tenant_id uuid not null references public\.tenants/.test(columns)) found.push({ file, name });
    }
  }
  return found;
};

test('the company infrastructure tables still have row level security and an explicit policy', () => {
  const offenders = [...TENANT_INFRASTRUCTURE].filter((name) => {
    const enabled = all.includes(`alter table public.${name} enable row level security`);
    const policy = new RegExp(`create policy "[^"]+" on public\\.${name}`).test(all);
    return !enabled || !policy;
  });

  assert.deepEqual(
    offenders,
    [],
    'These tables are exempt from the generic isolation policy, so they must carry their own.',
  );
});

test('every company-scoped table carries the restrictive isolation policy', () => {
  const offenders = tenantTables().filter(({ name }) =>
    !all.includes(`"tenant isolation" on public.${name}`) && !LOOP_COVERED.has(name));

  assert.deepEqual(
    offenders.map((o) => `${o.file} :: ${o.name}`),
    [],
    'A table with tenant_id but no RESTRICTIVE "tenant isolation" policy is readable across companies\n'
    + 'as soon as any permissive policy matches. Add the policy, or add the table to the DO-loop array.',
  );
});

test('every company-scoped table stamps tenant_id and the audit columns on write', () => {
  const offenders = tenantTables().filter(({ name }) =>
    !all.includes(`apply_row_defaults on public.${name}`) && !LOOP_COVERED.has(name));

  assert.deepEqual(
    offenders.map((o) => `${o.file} :: ${o.name}`),
    [],
    'Without the apply_row_defaults trigger a row can be written with the wrong tenant_id,\n'
    + 'and tenant_id is not frozen on update.',
  );
});

test('every company-scoped table has RLS enabled', () => {
  const offenders = tenantTables().filter(({ name }) =>
    !all.includes(`alter table public.${name} enable row level security`) && !LOOP_COVERED.has(name));

  assert.deepEqual(offenders.map((o) => `${o.file} :: ${o.name}`), [], 'RLS is not enabled on these tables.');
});
