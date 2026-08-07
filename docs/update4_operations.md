# Update 4 — Operations — 2026-08-07

## Why this module exists

FourthUpdate.md's own words: a lightweight field-work tracking module — a
manager defines an "Operation" (a work scope: school maintenance, security
patrols, hospital cleaning...), assigns a team, and any assigned team member
logs execution records (what was done, when, completion %, headcount,
photos/files, notes) against it. Deliberately no Work Order engine, no
approval chain, no per-member role — a flat, append-only log per operation.

## What was built

* `supabase/migrations/202608070057_operations.sql` (1,871 lines) — 6 new
  tables (`operations`, `operations_team_members`, `operations_execution_logs`,
  `operations_checklist_items`, `operations_templates`,
  `operations_template_checklist_items`), full RLS, 16 RPCs, 3 permission
  codes (`Operations.Manage`/`Execute`/`View`), 1 new `number_sources` code
  (`OP`), module/screen registration, and a targeted `create or replace`
  extension of `attachment_attach()` (two new branches,
  `OperationExecutionPhoto`/`OperationExecutionFile`, every pre-existing
  branch reproduced byte-identical).
* `src/data/operationsService.js` — the data-access layer, full demo-mode
  (`useLocalData`) parity throughout.
* Four React screens under `src/components/operations/`:
  `OperationsPortal.jsx` (employee "My Operations", `/app/operations`),
  `OperationsListAdmin.jsx` (admin/operations), `OperationsDashboardAdmin.jsx`
  (admin/operations-dashboard), `OperationsTemplatesAdmin.jsx`
  (admin/operations-templates) — plus `operationsShared.jsx`, a small shared
  component extracted during the closing audit, and `operations.css`.
* `src/i18n/modules/operations.js` — the 5-language dictionary (125 keys ×
  5 languages, full parity independently verified twice — once after the
  initial build, once after the closing audit added 3 more keys).
* `src/components/admin/AdminNav.jsx`'s new `operations` nav group (3 items),
  `src/components/AdminCenter.jsx`'s new screen-map entries, and
  `src/App.jsx`'s new `/app/operations` portal route.
* `tests/operations-invariants.test.mjs` — 10 static invariant tests written
  specifically for this module (mirrors the pattern
  `tests/safety-management-invariants.test.mjs` established).

## 1. Architecture — the core decisions

**Flat team membership, no per-member role.** `operations_team_members`
carries only `(operation_id, user_id)` — unlike Assets Management's custody
units (`Owner`/`Custodian`/`BackupCustodian`), a work-scope team has no
internal hierarchy in this module's own design. `operations_team_set_members()`
is a full-replace RPC, same shape as `asset_custody_unit_set_members()`.

**Execution logs are append-only.** No edit/delete RPC exists for
`operations_execution_logs` by design — a field record, once logged, stands.

**Linked records use one nullable FK column per target, never a polymorphic
pair.** `operations_execution_logs.asset_id`/`employee_id`/`form_id`/`site_id`
are each a real `(tenant_id, x_id) references target(tenant_id, id)` foreign
key. The generic `entity_type text + entity_id uuid` shape stays reserved for
the two cross-cutting Platform-Core services (`attachments`,
`activity_timeline`), which by design must attach to any table without schema
knowledge — a real domain relationship never reuses that shape.

**Two attachment entity types instead of one, because `public.attachments`
has no stored "kind" column.** `public.attachments` cannot distinguish a
photo from a file after the fact (confirmed by reading its own `create table`
DDL before design, not assumed), so an execution log's media splits into
`OperationExecutionPhoto`/`OperationExecutionFile` — two `attachment_attach()`
branches instead of one plus a client-side filter.

**RLS composability**: `operations_team_members`' own SELECT policy carries
`or user_id = auth.uid()` — without it, a plain team member's own membership
row would be invisible even to the nested `exists()` check inside
`operations`' own RLS policy that is supposed to admit them via membership
(Postgres enforces a referenced table's own RLS inside a nested subquery, not
just the outer table's). Found and fixed during the SQL build phase itself,
live-verified before the closing audit began.

| Need | Reused from |
|---|---|
| Reference numbers | `generate_number('OP', tenant)` — once per operation header |
| Event history | `record_activity()` + this module's own `operations_timeline()` wider-audience wrapper |
| Attachments | `public.attachments`/`attachment_attach()` (extended for `OperationExecutionPhoto`/`OperationExecutionFile`) + `operations_execution_log_attachments_list()` |
| Notifications | `public.notify()`, category `'System'` (no new category added to Platform Core) |
| Org dimensions | `public.sites` (site picker on both an operation and a template) |
| Team/roster UI pattern | `AssetCustodyUnitsAdmin.jsx`'s own `CustodyRosterModal` shape (`loadRecipients()`, `useArabicName().employeeName()`), minus the per-member role code |
| Permissions | `has_permission()`, 3 new codes |

## 2. Closing Audit

An independent, no-prior-trust multi-lens audit (Security, Architecture &
Duplication, i18n/Navigation/Icons, Accessibility/UX, Performance &
Correctness) plus adversarial re-verification of every claim before any fix
landed. This module's 4 screens were built by 4 agents working in parallel
from a shared spec — the audit was scoped explicitly to catch the failure
mode that creates (divergence between screens, duplicated logic, inconsistent
choices), on top of the usual checks.

**12 findings raised, 12 confirmed real on independent re-verification, 0
false positives, all 12 fixed:**

* **Security — 1 Major, fixed.** `OperationsPortal.jsx` rendered live write
  controls (checklist checkboxes, the "Add Execution Log" form) to *any*
  caller who could merely **see** an operation — via `Operations.View` alone,
  or team membership without `Operations.Execute` — even though the backing
  RPCs require `Operations.Manage` OR (`Operations.Execute` AND real team
  membership). Fixed with a new read-only predicate RPC,
  `operations_can_write(p_operation_id)`, reusing the exact `v_authorized`
  expression `operations_checklist_item_toggle()`/
  `operations_execution_log_create()` already enforce server-side; the portal
  now renders a static read-only view instead of a doomed-to-fail control
  when the predicate is false. **Live-verified** (see §3) with a dedicated
  4-user fixture: a View-only team member correctly gets `can_write = false`
  despite being able to see and read the operation, while Execute+membership,
  Manage-without-membership, and a true outsider all resolve exactly as
  designed.
* **Architecture/Duplication — 1 Major, 1 Minor, 1 Nit, all fixed.** The
  Execution-log Photo/File attachments block was duplicated near-verbatim
  between `OperationsListAdmin.jsx` and `OperationsPortal.jsx` (an expected
  consequence of 4 agents building in parallel) — extracted into
  `operationsShared.jsx`'s `ExecutionLogAttachments`, both screens now import
  it. The admin execution-log detail was missing headcount/start/end-time
  that the Portal's own log form captures — added. The status-badge markup
  was hand-duplicated twice within `OperationsListAdmin.jsx` itself while
  `OperationsPortal.jsx` had already extracted it as a component — mirrored
  the same extraction locally.
* **Accessibility/UX — 3 Minor, 1 Nit, all fixed.** Checklist/template-item
  remove buttons carried identical, non-parameterized `aria-label`s for every
  row (now interpolate the item's own title). Validation-error blocks were
  inconsistently missing `role="alert"` across the module's dialogs (all six
  now carry it). **`src/utils/useDialogA11y.js`** — the shared hook powering
  all 20 modal consumers app-wide, not just this module — had no focus trap
  and no focus-restore-to-trigger; fixed once in the shared hook (zero
  call-site changes needed), which also closes the same gap for
  `SafetyIssuancesAdmin.jsx`'s four modals and every other consumer. Loading
  spinners carried no accessible name/live-region announcement — added
  `sr-only` + `role="status"` text at all three sites.
* **Performance/Correctness — 2 Major, 2 Minor, all fixed.** The Templates
  screen's nested checklist-item save loop was not idempotent — a retry after
  a partial failure would re-insert already-saved rows or re-delete
  already-removed ones; fixed by patching local state immediately after each
  successful call so a retry only replays what genuinely failed. The Portal's
  execution-log history eagerly mounted two `AttachmentsPanel` instances per
  log unconditionally — an unbounded, append-only list fanning out into
  2N+1 concurrent network calls on load; fixed with the same
  expand-to-mount gating `OperationsListAdmin.jsx`'s own log panel already
  used. A detail-view data-loading effect depended on the whole `operation`
  object instead of its id, double-firing on every status/roster mutation;
  narrowed to `operation?.id`. Checklist add/toggle/remove triggered a full
  4-RPC reload (team+checklist+logs+timeline) instead of refetching just the
  checklist; narrowed to a checklist-only reload.

No findings were raised, and none needed deferring — the smaller scope of
this module (no asset-lifecycle interplay, no compliance math) left less
surface for the kind of judgment-call trade-offs Safety Management's audit
had to weigh.

## 3. Mandatory Verification

* **Migration chain**: the full 58-file chain (through this module) applied
  cleanly against a **fresh** local Postgres 17 instance, twice — once
  immediately after the SQL build (before screens existed), once again after
  the closing audit's security fix added `operations_can_write()`. Zero
  errors both times.
* **Functional tests** against the same live instance
  (`operations_functional_test_v2.sql`, 5 test groups): a manager creating an
  operation and assigning a team; the RLS-composability fix confirmed
  directly (a plain team member sees their own operation AND their own
  membership row via a raw client `select`, not an RPC; an outsider sees
  neither); a team member successfully logging an execution record while a
  non-member is correctly rejected `PERMISSION_DENIED`; the execution-logs
  list wrapper and a valid `Draft→Active` status transition both succeeding
  while `Active→Draft` is correctly rejected `INVALID_STATUS_TRANSITION`; and
  — added specifically to verify the closing audit's security fix —
  `operations_can_write()` returning `false` for a View-permission-only team
  member, `true` for Execute+membership, `true` for Manage alone (no
  membership needed), and `false` for a true outsider. Every expected success
  and every expected error matched exactly.
* **`npm test`**: 83/83 (73 pre-existing + 10 new Operations-specific static
  invariant tests).
* **`npm run lint`**: clean across the **whole repository**, not just this
  module's own files — run deliberately at full scope because the
  accessibility fix touched `src/utils/useDialogA11y.js`, a hook shared by 20
  modal consumers across other modules.
* **`npm run build`**: clean (the one warning present — an i18n chunk over
  700kB — is a pre-existing advisory about code-splitting, not an error).
* **Browser**: dev server loads with no console or server errors on both the
  pre- and post-closing-audit builds. Full authenticated click-through was
  not possible in this environment (no live Supabase credentials available
  to this session) — stated honestly rather than claimed, same limitation
  documented for Assets Management and Safety Management.

## Deferred / out of scope (explicit, final)

* **`Operations.Execute` has no admin UI to grant it to arbitrary roles.**
  It is currently seeded only to `PLATFORM_ADMIN`/`SYSTEM_ADMIN`. The closing
  audit's security fix makes the Portal correctly *read-only* for anyone
  without it, which is the correct behavior — but provisioning that
  permission to ordinary team-member roles is a distinct, pre-existing
  role/permission-management gap this module does not introduce and does not
  resolve.
* **No RPC-level pagination on `operations_execution_logs_list()`.** The
  closing audit's fix for the N+1 attachment-panel fan-out was client-side
  (expand-to-mount gating), which fully resolves the concurrent-network-call
  risk; adding `p_limit`/`p_offset` to the RPC itself was identified as a
  secondary, lower-priority follow-up and intentionally not implemented here.
* **The Dashboard's "latest photos" strip shows metadata cards, not
  thumbnails.** `operations_dashboard_summary()`'s `latestPhotos` sub-query
  deliberately omits `storage_objects.layer`/`provider_code`/`bucket`, so
  there is no honest way to resolve a signed thumbnail URL from that payload
  without a second round-trip per photo; the screen renders
  filename/operation/date/uploader instead of guessing a URL.

## Status

| Review step (contract §16) | Result |
|---|---|
| 1. Architecture review | **PASS** — §12 reuse table above; flat-membership/append-only-log/one-FK-per-target rules verified honored |
| 2. Security review | **PASS** — 1 Major found and fixed (write-control gating), live-verified with a dedicated 4-user permission-matrix test |
| 3. Performance review | **PASS** — 2 Major + 2 Minor findings, all fixed |
| 4. Documentation review | **PASS** — this document |
| 5. Migration review | **PASS** — full chain replay, zero errors, twice (pre- and post-closing-audit) |
| 6. Tests | **PASS** — 83/83, including 10 new module-specific static tests, plus a live-Postgres functional suite covering the security fix directly |

**Operations is Final Closed.**
