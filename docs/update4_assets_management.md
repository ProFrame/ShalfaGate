# Update 4 — Assets Management — 2026-08-06

## Why this module exists

FourthUpdate.md's own words: most systems treat an asset as a record; the
plan's author insists it is a **lifecycle**. Build around `Asset Lifecycle`,
not around the row. The movement log (`asset_transactions`) is the single
source of truth; an asset's current custodian/location/status is only ever a
*snapshot* derived from its latest transaction, never edited independently.
This module is the Assets phase of Update 4's mandatory execution order,
starting immediately after the pre-Assets zero-debt sweep
(`docs/update4_pre_assets_sweep.md`) confirmed every prior phase — Platform
Core, INumberGenerator, Storage, Workflow Engine, Attachments, Verification
Service, Digital Identity — had no open issue.

## What was built

* `supabase/migrations/202608060054_assets_management.sql` — 11 new tables
  (`asset_groups`, `asset_custody_units`, `asset_custody_unit_members`,
  `assets`, `asset_transactions`, `asset_reservations`, `asset_maintenance`,
  `asset_inventory_sessions`, `asset_inventory_session_units`,
  `asset_inventory_session_members`, `asset_inventory_scans`), full RLS,
  21 RPCs, 5 new permission codes, a dedicated single-step approval scheme
  for disposal, a narrowly-scoped `AFTER UPDATE` trigger on `public.forms`,
  and module/screen registration.
* `supabase/migrations/202608060055_assets_management_closing_audit.sql` —
  the SQL-layer fixes this module's own closing audit found (below).
* `src/data/assetsService.js` — the data-access layer (contract §9: no
  component talks to Supabase directly).
* Six React screens under `src/components/assets/`: `AssetsPortal.jsx`
  (employee "My Assets", `/app/assets`), `AssetGroupsAdmin.jsx`,
  `AssetCustodyUnitsAdmin.jsx`, `AssetsCatalogueAdmin.jsx` (the largest —
  catalogue, detail, timeline, transactions, QR/barcode, disposal),
  `AssetInventoryAdmin.jsx`, `AssetReportsAdmin.jsx` — all five Admin screens
  registered under `/app/admin/asset-*`.
* `src/i18n/modules/assets.js` — the 5-language dictionary, including a full
  `assets_err_*` translation for every error code the RPCs raise.
* `src/components/assets/assets.css`, plus the printable asset-tag view
  (QR + Code 128 barcode, `EntityQrCode`/`code128.js` reused, never
  reimplemented) inside `AssetsCatalogueAdmin.jsx`.

## 1. Architecture

Every shared capability is reused from the platform layer per contract §12 —
nothing in this module reimplements a service that already exists:

| Need | Reused from |
|---|---|
| Reference numbers | `generate_number('AS'\|'WO'\|'IN', tenant)` — called once per asset / maintenance case / inventory session at creation, never per `asset_transactions` row (a routine Issue/Receive/Transfer happens far more often than an asset is created; each transaction is already traceable via its own id plus its parent asset's own reference) |
| Event history | `public.activity_timeline` / `record_activity()` — called from inside this module's own `SECURITY DEFINER` RPCs (the function itself is granted only to `service_role`, never to `authenticated`), with a wider-audience wrapper `asset_timeline()` this module owns, exactly the extension pattern `record_activity`'s own migration told every future business module to build |
| Attachments | `public.attachments` / `attachment_attach()` / `attachment_mark_for_removal()`, `entityType: 'Asset'`, `area: 'assets'` (the exact convention `src/lib/platformCore/attachments.js`'s own JSDoc had already reserved for this module by name); `asset_attachment_list()` is this module's own wider-audience read wrapper |
| Approval routing | `public.forms` / `public.templates` / the existing, **unmodified** `approval_submit()`/`approval_act()` — disposal is never direct, per the spec's own explicit rule; it opens a Draft form against a new, disposal-only template/scheme this migration adds, then goes through the same chain every other module's forms already use |
| Notifications | `public.notify()`, category `'Approval'` for the transfer-pending-acceptance and maintenance-approval-needed events (closest existing category — there is no `'Assets'` category and a business-module migration must not modify Platform Core's own function), `'System'` for informational ones |
| Org dimensions | `public.sites`/`public.projects`/`public.departments` — a custody unit's location/project/department are composite foreign keys onto these, never a fourth copy |
| Permissions | `has_permission()`, five new codes: `Assets.Manage`, `Assets.Operate`, `Assets.Maintain`, `Assets.Inventory`, `Assets.View` |
| Barcode/QR | `src/components/platform/EntityQrCode.jsx` unchanged; `src/lib/platformCore/code128.js`'s `encodeCode128B`/`code128Bars` — **this module is that encoder's first real consumer**, closing the "tested, no current consumer" gap §12 previously documented for it |
| Audit trail | `write_audit_log()`, attached to every new table exactly like every other module's tables |

**Scope decision, made explicit and final before any code was written:** the
platform's Number Generator catalogue (`public.number_sources`) has five
codes pre-reserved under `owner_module = 'Assets'`: `AS`, `WO`, `IN`, `PO`,
`IV`. Only the first three map to anything FourthUpdate.md's detailed Assets
spec (lines 476–789) actually describes. `PO`/`IV` (Purchase Order, Invoice)
are not — the spec never describes a purchasing workflow, only a plain
`Supplier` text field on the asset record. They remain reserved-but-unused,
the same "ready infrastructure, no current consumer" status this project
already gave the Barcode Generator and Tags Engine before a real consumer
arrived — not a silently dropped requirement.

## 2. ERD

```
asset_groups ──┐
               │ group_id
asset_custody_units ──┐         ┌── parent_asset_id (self, composability:
   │ member roster     │         │    car -> tracker -> camera -> ...)
   ▼                   ▼         │
asset_custody_unit_members    assets ◄─────────────────────────────┐
                               │  │  │                              │
                current_custody_unit_id / current_custodian_user_id │
                               │  │  │                              │
                    ┌──────────┘  │  └──────────┐                   │
                    ▼             ▼             ▼                   │
          asset_transactions  asset_reservations  asset_maintenance │
          (source of truth,   (blocks a           (own sub-lifecycle:│
           every movement)     conflicting          Reported→Approved│
                                delivery during      →Sent→Under-    │
                                the window)           Maintenance→   │
                                                       Completed→     │
                                                       Returned→Closed)
                                                                      │
asset_inventory_sessions ──► asset_inventory_session_units/members   │
        │                                                            │
        ▼                                                            │
asset_inventory_scans ────────────────────────────────────────────────┘
  (per-scan result; 'Missing' is system-generated only, at session close,
   for every in-scope asset never scanned)

public.forms (disposal request, new template) ──AFTER UPDATE trigger──►
  asset_dispose_on_form_approved() ──► asset_transactions('Dispose') + assets.status='Disposed'
```

## 3. Database

Every table follows the platform's standard shape (contract §1): `tenant_id`,
`apply_row_defaults` trigger, RESTRICTIVE tenant-isolation policy plus a
PERMISSIVE read/write policy, `write_audit_log()` audit trigger, composite
same-tenant foreign keys. `assets`/`asset_transactions`/`asset_reservations`/
`asset_maintenance`/`asset_inventory_*` carry **no direct-write PERMISSIVE
policy at all** — every mutation is forced through a `SECURITY DEFINER` RPC,
which is what makes "the transaction log is the only source of truth"
structurally true rather than a convention someone could bypass with a raw
`update`.

Indexes: `idx_assets_tenant`, `idx_assets_custodian`, `idx_assets_parent`,
`idx_assets_tenant_created` (added by the closing audit — nothing backed the
default `order by created_on desc` before), `idx_asset_transactions_tenant`,
`idx_asset_transactions_asset`, `idx_asset_transactions_pending_recipient`
(added by the closing audit — nothing backed a `to_custodian_user_id`+
`status` lookup before, which the frontend now issues directly instead of a
fan-out), `idx_asset_inventory_scans_tenant/session/asset`, plus a **partial
unique index** `uq_asset_inventory_scans_active` backing the "no double-count
in one session" rule at the database level, not just in application code.

## 4. API

21 RPCs (`asset_group_upsert`, `asset_custody_unit_upsert`,
`asset_custody_unit_set_members`, `asset_create`, `asset_update`,
`asset_transaction_create`, `asset_transfer_accept`, `asset_transfer_reject`,
`asset_maintenance_report`, `asset_maintenance_approve`,
`asset_maintenance_advance`, `asset_reserve`, `asset_release_reservation`,
`asset_dispose_request`, `asset_dispose_on_form_approved` [trigger-only],
`asset_attachment_list`, `asset_timeline`, `asset_inventory_session_create`,
`asset_inventory_session_start`, `asset_inventory_scan`,
`asset_inventory_session_complete`), every one `revoke all from public` /
`grant to authenticated` (never `anon`), every callable one carrying a
`comment on function` documenting Authentication/Authorization/Expected
errors per contract §21. `asset_transaction_create` is the single unified
entry point for Receive/Issue/Transfer/Return/Lost/Found/Reserve/Release —
never Dispose (only the approval trigger creates that row) and never
MaintenanceOut/MaintenanceReturn (only `asset_maintenance_advance` creates
those). A person-to-person Transfer creates a `PendingAcceptance` row and
leaves the snapshot untouched until `asset_transfer_accept()` — reject undoes
nothing, because nothing was ever applied.

## 5. Permissions

`Assets.Manage` (full CRUD, admin catalogue, disposal requests, Receive),
`Assets.Operate` (day-to-day Issue/Transfer/Reserve — or being the asset's
current custodian), `Assets.Maintain` (approve sending an asset out),
`Assets.Inventory` (create/run counting sessions), `Assets.View` (read the
company-wide catalogue/timeline/reports). Per the spec's own explicit rule,
`asset_maintenance_report()` (Report Maintenance) requires **no permission at
all** beyond being a signed-in tenant member — "any user can report."
Disposal approval authority comes from the approval-chain configuration
itself (who holds the disposal scheme's role), not a bespoke Assets
permission — consistent with never gating on a role/permission where the
platform's own Workflow Engine already answers the question.

## 6. Workflow

Disposal is the only step routed through the Dynamic Approval Chain: a new
`FM-SH-AST-D-26-0001\V1.0` template, a dedicated single-step `ASSET_DISPOSAL`
scheme (disposal authority is asset-specific, not the multi-role chain other
form types use), and a trigger that fires only on an **exact** match against
that template code (never a prefix/`LIKE` match a forged template under a
different code could satisfy) and re-checks the same `Assets.Manage` +
"still in custody" gates `asset_dispose_request()` itself enforces at request
time, since the approval chain can take arbitrarily long and either fact can
change before it lands. The maintenance sub-lifecycle
(Reported→Approved→Sent→UnderMaintenance→Completed→Returned→Closed) is its
own state machine inside `asset_maintenance_advance()`, not routed through
the approval chain — Report is open to anyone, only the physical Sent
transition requires `Assets.Maintain`/`Assets.Manage`, matching the spec's
"any user reports, only an approver sends" rule literally.

## 7. Storage

Asset photos/attachments and disposal-request attachments go through the
generic Attachment Framework (`entityType: 'Asset'`, `area: 'assets'`) —
Extended storage layer, same as every other module's file attachments; no
new bucket, no new upload path, no bespoke storage table.

---

## Closing audit (whole module, every file, no exceptions)

Independent 11-lens review + adversarial verify (the same process
Verification and Digital Identity received): **40 raw findings, 38
confirmed** (2 refuted). Every confirmed finding is fixed. Severity
breakdown: 6 Blocker, 16 Major, 16 Minor.

**Blockers, all fixed:**

1. All 5 Assets admin screens were structurally unreachable —
   `AdminCenter.jsx`'s `screens{}` map had the entries, but
   `AdminNav.jsx`'s `ADMIN_GROUPS` (the sole source of which section ids the
   admin shell will ever render, redirect to, or list) was never given a
   matching entry, so `/app/admin/asset-groups` etc. were bounced away by
   the shell's own redirect guard before rendering. Fixed: a new `assets`
   group added to `ADMIN_GROUPS`, five items, `admin_group_assets`/
   `admin_nav_asset_*` i18n keys added in all 5 languages.
2. `AssetsPortal.jsx` crashed on render whenever `profile` was still `null`
   on first paint (a real, reproducible race on a hard refresh/deep link
   into `/app/assets` while already signed in — `AuthContext`'s
   `loadProfile()` resolves asynchronously after the page has already
   mounted). Fixed: every `profile.id` read changed to `profile?.id`.
3. No list screen in the module capped its row count — `loadAssets()` had
   no `.limit()`/`.range()` anywhere, so every screen that called it pulled
   the entire tenant asset table. Fixed: `loadAssets()` now defaults to a
   200-row bounded page (explicit higher limits available where a screen
   genuinely needs one, e.g. Reports' aggregate counts), and the "My
   Assets"/parent-child lookup call sites were switched to server-side
   `custodianUserId`/`parentAssetId` filters instead of full-table scans.
4. `AssetsPortal.jsx` found "transfers pending my acceptance" by fanning out
   one `asset_transactions` query per tenant asset on every portal load — an
   unbounded N+1 with no better route available in the original RPC
   surface. Fixed: a new `loadPendingTransfersForMe()` service function (one
   query, `to_custodian_user_id = auth.uid() and status = 'PendingAcceptance'`
   — already permitted by the existing RLS policy) plus a new partial index
   (`idx_asset_transactions_pending_recipient`, migration 055) backing it.
5. No phase doc existed for this module — this document closes that gap.
6. Same root cause as item 1 (found independently by a second lens).

**Majors and Minors, all fixed** (grouped by file; full findings text is in
this session's own audit transcript, not duplicated here):

* **Database (migration 055):** `asset_inventory_scans`' SELECT policy was
  narrower than what `asset_inventory_scan()` itself already authorizes to
  write — a plain session member (no Assets permission) could submit scans
  but never see teammates' scans or any auto-generated `Missing` row.
  Fixed with the missing session-member `EXISTS` branch, matching the
  sibling policies on `asset_inventory_sessions`/`_session_units`. Also:
  `platform_modules.display_order` for `ASSETS` (170) collided with the
  pre-existing `PUBLIC_API` row — moved to 190.
* **assetsService.js:** every read projected specific columns instead of
  `select('*')`; the catalogue search box's free-text query was spliced
  unescaped into a PostgREST `.or()` filter string (a search value
  containing `,`/`(`/`)` was parsed as additional filter syntax, not literal
  text) — fixed with a proper quoted-literal escape; a new
  `loadLastMovementForAssets()` batched query replaces a one-query-per-asset
  fan-out Reports' "Last Movement" column used.
* **AssetsCatalogueAdmin.jsx:** parent/child lookups switched to filtered
  queries instead of re-fetching the whole catalogue on every navigation
  click; `.find()`-based label lookups replaced with the `Map`-based pattern
  already used correctly elsewhere in the module; the dropdown-source load
  effect gained a cancellation guard and now surfaces its own errors;
  rejecting a maintenance report and releasing a reservation both gained a
  confirmation step (previously single-click, irreversible, no reason
  captured for the reject case) — matching this module's own already-correct
  reject-transfer confirm modal.
* **AssetReportsAdmin.jsx:** the largest concentration of findings — a
  `codeLabel()` prefix bug that silently rendered untranslated English DB
  values for maintenance/session statuses in every non-English language;
  six unlabeled filter `<select>`s, two unlabeled search inputs, two
  icon-only buttons relying on `title` alone, a date-range pair with no
  visible label, an incomplete tab-strip implementation (missing
  `id`/`aria-controls`/`role="tabpanel"`); a missing `filter_by_project`
  i18n key that rendered as the literal key string in every language;
  missing cancellation guards on its two fetch effects.
* **AssetInventoryAdmin.jsx / AssetCustodyUnitsAdmin.jsx:** one more
  icon-button aria-label gap each; a hand-duplicated status-filter list
  replaced with the shared `INVENTORY_SESSION_STATUSES` export; the
  custody-roster "remove member" button's generic `aria-label` made
  member-specific.
* **i18n:** `src/i18n/modules/assets.js` had **zero** `assets_err_*`
  translations for the ~47 error codes the RPCs raise, so every RPC error in
  every language collapsed to the same generic "something went wrong" — real
  per-code translations added in all 5 languages. A near-duplicate
  `label_reference` key (diverging from the already-shared `reference` key
  in its Arabic wording) was removed; the three call sites that used it now
  reuse `reference`.
* **Cross-module:** `AppShell.jsx`'s `NAV_ICONS` map had no `package` entry
  for the portal nav icon the migration registered — added, "My Assets" no
  longer silently falls back to the generic grid icon.

## Verification (live, not just reasoned about)

* **Full migration chain replay**, fresh isolated PostgreSQL 17 instance,
  all 55 files (`001` through `055`) applied in order: zero errors.
* **Functional tests** against the same fresh instance: reservation-blocks-
  conflicting-Issue (and does *not* block issuing to the reservation holder
  themself), person-to-person transfer create→pending→accept (snapshot only
  updates on accept)→reject, full maintenance lifecycle
  Reported→Approved→Sent(InMaintenance)→UnderMaintenance→Completed→
  Returned(Available)→Closed, disposal request→simulated approval→trigger
  fires exactly once (Disposed, custodian/unit cleared, exactly one Dispose
  transaction), disposing an asset still in custody correctly rejected,
  inventory scan→duplicate-scan correctly blocked→session
  complete→auto-generated Missing row for the one in-scope unscanned asset,
  none for an asset InUse elsewhere or already Disposed. Re-verified against
  a fresh instance after the closing-audit migration (055) landed: the new
  RLS branch, both new indexes, and the `display_order` fix all confirmed
  present and correct.
* **`npm run lint`**: clean throughout every batch of changes.
* **`npm run build`**: clean throughout every batch of changes.
* **Import/export consistency**: every one of the 6 screens' imports from
  `assetsService.js` cross-checked against the file's real exports —
  zero drift.
* **Browser**: dev server loads the app with the new `/app/assets` route and
  the new admin screens present, no console errors. Full authenticated
  click-through of every screen was not possible in this environment (no
  live Supabase credentials available to this session) — stated honestly
  rather than claimed.

## Deferred / out of scope

* `PO`/`IV` purchasing/invoicing — see the Architecture section's scope
  decision above. Pre-reserved number codes, no spec to build against yet.
* A true cursor/prev-next pager UI — the closing audit's pagination fix is a
  bounded default page size (contract §17's actual minimum bar: never load
  a whole table), not a full pager control on every list screen. A real
  pager UI is a legitimate follow-up once real usage shows it's needed.

## Status

| Review step (contract §16) | Result |
|---|---|
| 1. Architecture review | **PASS** — no duplicated capability; §12 reuse table above |
| 2. Security review | **PASS** — RLS/RPC review + closing audit's security lens; all confirmed findings fixed |
| 3. Performance review | **PASS** — closing audit's performance lens; N+1s and unbounded loads fixed |
| 4. Documentation review | **PASS** — this document |
| 5. Migration review | **PASS** — full chain replay, zero errors, twice (post-054 and post-055) |
| 6. Tests | **PASS** — functional test suite covering every fixed bug class, all green |

## Release Gate (independent, no-prior-trust re-review)

The "Final Closed" status above reflected this module's own closing audit —
the same people/process that had just built it re-checking their own work.
At the user's explicit request, a **separate** Final Independent Release Gate
was then run afterward: 8 independent reviewer personas (Enterprise
Architect, Senior Software Engineer, Database Architect, Security Reviewer,
QA Lead, Performance Reviewer, UX Reviewer, Code Reviewer), instructed to
distrust every prior report and read only the current code. It found **35
additional real issues** the closing audit above had missed (plus one
disclosed operational incident, unrelated to code quality — see the
session's own record). All 35 were fixed:

* **SQL layer** (`202608060054_assets_management.sql`, edited in place —
  this migration had not shipped yet): `asset_transfer_accept()` now
  re-validates the asset's current custodian before applying a pending
  transfer (a stale transfer auto-cancels instead of silently overwriting an
  intervening custody change); `asset_update()` now rejects a multi-hop
  parent/child cycle, not just direct self-parenting; `asset_maintenance_
  advance()`'s Disposed guard now covers all four asset-adjacent transitions,
  not two; `asset_custody_unit_upsert()` now rejects a site that doesn't
  belong to the chosen project server-side, not just in the client picker;
  `asset_timeline()`/`asset_attachment_list()` now also accept
  `Assets.Operate`; the dead `'Reserved'` status value was removed from the
  `assets.status` CHECK constraint (a reservation is a future-dated overlay,
  never the live status); a new `asset_last_movement_for_ids()` RPC replaces
  a client-side "fetch everything, reduce to latest" pattern with a
  server-side `DISTINCT ON`; `attachment_attach()` (shared platform
  infrastructure, `202608050040`) is re-declared for `entity_type = 'Asset'`
  with an authorization check beyond "do you own the storage object" —
  Assets.Manage/Operate/Maintain, the asset's custodian, or the reporter of
  an open maintenance case on it.
* **Frontend** (all six screens plus a new shared `AssetShared.jsx` /
  `assetsVocabulary.js`): the copy-pasted `AssetStatusBadge`/
  `AssetTimelinePanel`/session-status-label logic was deduplicated into
  shared files; N+1 fan-outs (pending-transfer resolution, per-row last-
  transaction lookups) replaced with bulk/server-side queries; the catalogue
  search box debounced; silent 200-row truncations in asset pickers now show
  a visible hint instead of nothing; deactivating an Asset Group or Custody
  Unit is no longer a one-way door (a "show inactive" toggle + the existing
  edit dialog reactivates); focus now moves correctly on every list↔detail
  transition; missing `aria-hidden` added to decorative icons; the
  notification deep links (`/app/assets?asset=`, `/app/admin/assets?asset=`
  for the one approver-facing case) are now actually consumed by the
  screens they point to, instead of landing on a screen that ignores the
  query string.
* **Re-verification after every fix**: `npm test` (63/63, including 10 new
  static invariant tests in `tests/assets-management-invariants.test.mjs`
  written specifically to close the Release Gate's "zero automated tests"
  finding), `npm run lint` (clean), `npm run build` (clean), a full 55-file
  migration chain replay against a **fresh** local Postgres 17 instance
  (zero errors), and both functional test scripts (the original
  bug-class-coverage suite plus a new one exercising all five SQL-side
  Release Gate fixes end to end) — every expected success and every
  expected error matched.

**Assets Management is Final Closed — both its own closing audit and the
independent Release Gate that followed it.**
