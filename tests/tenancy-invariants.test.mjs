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
  'public.employee_asset_is_known_user':
    'legacy production has no tenant_id on users; the private bucket still requires authentication '
    + 'and only resolves paths belonging to a real, non-deleted user',
  'public.guard_user_self_update':
    'trigger function, operates on the row being written; its entire job is comparing OLD to NEW '
    + 'on a single row, which is what makes it the fix rather than another instance of the problem',
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

// ---------------------------------------------------------------------------
// A caller's own row is still the widest door in the schema
//
// public.users carries the RESTRICTIVE tenant isolation policy like every
// other table, but it ALSO carries a much older, unscoped policy from
// migration 0001 ("users can update own profile" ... using (auth.uid() = id))
// that names no columns. That policy is the one a self-service profile edit
// actually uses, and until 027 it let a caller rewrite active_tenant_id —
// the very column current_tenant_id() trusts to decide which company every
// other table's isolation check runs against. These tests hold the two-part
// fix in place: the trigger that freezes the column, and the membership check
// that makes current_tenant_id() safe even if the trigger were ever removed.
// ---------------------------------------------------------------------------

// create or replace means the LAST definition in migration order is the one
// that actually runs; functionBlocks() over the whole concatenated file
// returns every historical version, so the final applied body is the last
// match, not the first.
const finalDefinition = (name) => functionBlocks(all).filter((f) => f.name === name).at(-1);

test('current_tenant_id() verifies active_tenant_id against a real membership', () => {
  const fn = finalDefinition('public.current_tenant_id');
  assert.ok(fn, 'public.current_tenant_id() must exist');
  assert.match(
    fn.body,
    /tenant_memberships[\s\S]*status\s*=\s*'Active'/,
    'current_tenant_id() must confirm active_tenant_id against an Active tenant_memberships row before '
    + 'trusting it — otherwise any code path that can set the column, however that happens, can move a '
    + 'session into another company outright.',
  );
});

test('a self-update can never move active_tenant_id or the admin-only columns', () => {
  const fn = finalDefinition('public.guard_user_self_update');
  assert.ok(fn, 'public.guard_user_self_update() must exist as a BEFORE UPDATE trigger on public.users');
  assert.match(fn.body, /active_tenant_id/, 'the guard must name active_tenant_id explicitly');
  assert.match(
    fn.body,
    /current_user\s*<>\s*'authenticated'/,
    'the guard must exempt system paths (service_role, SECURITY DEFINER RPCs) so switch_tenant() and '
    + 'record_first_login() are not broken by the same rule that stops a raw client PATCH',
  );

  assert.match(
    all,
    /create trigger guard_user_self_update\s*\n\s*before update on public\.users/,
    'the trigger must be attached to public.users',
  );
});

// ---------------------------------------------------------------------------
// The permission catalogue
//
// public.permissions carries no tenant_id — it is the platform's fixed
// vocabulary. A code referenced by has_permission()/has_permission_for_user()
// that is never INSERTed by a migration fails closed and silently: nobody is
// refused loudly, the capability simply never exists. supabase/seed.sql is not
// part of the documented install (docs/bbnovix_deployment.md §3 runs
// `supabase db push` only), so a definition that lives only there does not
// count.
// ---------------------------------------------------------------------------

const permissionCodesDefinedByMigrations = (() => {
  const codes = new Set();
  for (const block of all.matchAll(/insert into public\.permissions[^;]*?values\s*([\s\S]*?);/g)) {
    for (const m of block[1].matchAll(/\(\s*'([A-Za-z0-9_.]+)'\s*,/g)) codes.add(m[1]);
  }
  return codes;
})();

const permissionCodesReferenced = (() => {
  const codes = new Set();
  for (const m of all.matchAll(/has_permission(?:_for_user)?\(\s*(?:[a-z_]+\s*,\s*)?'([A-Za-z0-9_.]+)'/g)) codes.add(m[1]);
  for (const m of all.matchAll(/permission_code\s*[:=]\s*'([A-Za-z0-9_.]+)'/g)) codes.add(m[1]);
  return codes;
})();

test('every referenced permission code is defined by a migration, not only by seed.sql', () => {
  const missing = [...permissionCodesReferenced].filter((code) => !permissionCodesDefinedByMigrations.has(code));
  assert.deepEqual(
    missing,
    [],
    'These permission codes are checked somewhere but no migration ever inserts them into public.permissions, '
    + 'so has_permission() returns false for everyone on a database built by following the documented install:\n  '
    + missing.join('\n  '),
  );
});

test('a company cannot flip its own tenants row into the platform operator', () => {
  const guard = finalDefinition('public.guard_tenant_slug');
  assert.ok(guard, 'public.guard_tenant_slug() must exist as a BEFORE trigger on public.tenants');
  assert.match(guard.body, /is_platform is distinct from old\.is_platform/, 'is_platform must be frozen for non-operators');
  assert.match(guard.body, /is_platform_operator\s*\(\)/, 'the freeze must be conditioned on is_platform_operator()');

  const operatorCheck = finalDefinition('public.is_platform_operator');
  assert.ok(operatorCheck, 'public.is_platform_operator() must exist');
  assert.match(
    operatorCheck.body,
    /platform_tenant_id\s*\(\)/,
    'is_platform_operator() must compare against the one fixed platform tenant, not a per-row is_platform column '
    + 'a company could otherwise set on itself',
  );

  assert.match(
    all,
    /create unique index if not exists uq_one_platform_tenant\s*\n\s*on public\.tenants/,
    'a partial unique index must make a second is_platform tenant impossible to create',
  );
});

test('the client never spreads an arbitrary object into the users table', () => {
  const authContext = readFileSync(
    join(MIGRATIONS, '..', '..', 'src', 'context', 'AuthContext.jsx'), 'utf8',
  );
  assert.doesNotMatch(
    authContext,
    /\.from\('users'\)\.update\(changes\)/,
    'updateProfile must filter to an explicit allow-list before calling .update() — the database guard is '
    + 'the real boundary, but a request should never carry a field it was not asked to send',
  );
});

test('PUBLIC execute is revoked from every function, not just anon', () => {
  // Verified once against a real Postgres instance (not visible to a static
  // grep, which is why this is a comment and not a self-checking assertion):
  // the moment a function receives ANY explicit GRANT/REVOKE — which is every
  // function here, since the house style is "create function, then grant
  // execute to authenticated/anon" — Postgres re-materializes its ACL from
  // acldefault(), the hardcoded SQL-standard default, which always includes
  // PUBLIC execute. ALTER DEFAULT PRIVILEGES does not prevent this; it only
  // covers a function that is NEVER explicitly granted, which is not the
  // shape of this codebase. Confirmed empirically: before migration 037,
  // 248 of 270 public.* functions carried an implicit PUBLIC (i.e. anonymous,
  // ungated) execute grant that no migration's own GRANT statement intended.
  //
  // This assertion only guards the one blanket fix from being silently lost;
  // it cannot prove the property itself, because that requires a live
  // database (unnest(pg_proc.proacl) for a literal PUBLIC entry) which this
  // suite deliberately does not depend on. Whoever adds Update 4's functions
  // must re-run the same statement at the end of that migration batch —
  // every newly granted function re-opens the same gap the instant it is
  // created, this fix is not retroactive-forever.
  assert.match(
    all,
    /revoke execute on all functions in schema public from public/,
    'a blanket "revoke execute on all functions in schema public from public" must exist (see migration 037) — '
    + 'without it, every SECURITY DEFINER function that was ever explicitly GRANTed is also callable anonymously',
  );
});
