# Update 4 — Safety Management — 2026-08-07

## Why this module exists

FourthUpdate.md's own words: an independent module that depends on Assets
Management and the employee/org-dimension data, focused on tracking Personal
Protective Equipment (PPE) issuance and compliance — without building a
second, competing lifecycle system for the PPE that is already an asset.

## What was built

* `supabase/migrations/202608070056_safety_management.sql` (~2,900 lines) —
  9 new tables (`safety_ppe_types`, `safety_ppe_sets`, `safety_ppe_set_items`,
  `safety_asset_ext`, `safety_issuances`, `safety_issuance_items`,
  `safety_field_visits`, `safety_field_visit_checks`,
  `safety_field_visit_check_missing_items`), full RLS, ~18 RPCs, 4 new
  permission codes (`Safety.Manage`/`Issue`/`Inspect`/`View`), 2 new
  `number_sources` codes (`PI`, `FV`), module/screen registration, and
  targeted `create or replace` extensions of five shared platform functions
  (`attachment_attach()`, `audience_matches()`, `audience_save()`,
  `audience_describe()`, `audience_can_manage()`) — every pre-existing
  branch of each reproduced byte-identical, only new branches added.
* `src/data/safetyService.js` — the data-access layer.
* Nine React screens under `src/components/safety/`: `SafetyPortal.jsx`
  (employee "My Safety", `/app/safety`), `SafetyPpeTypesAdmin.jsx`,
  `SafetyPpeSetsAdmin.jsx`, `SafetyAssetsAdmin.jsx`,
  `SafetyIssuancesAdmin.jsx`, `SafetyFieldVisitsAdmin.jsx`,
  `SafetyExpirationsAdmin.jsx`, `SafetyComplianceAdmin.jsx`,
  `SafetyReportsAdmin.jsx` — all eight admin screens registered under
  `/app/admin/safety-*`, plus two small shared modules
  (`safetyTimeline.jsx`, `safetyDueCell.jsx`) extracted during the closing
  audit to remove triplicated component logic.
* `src/i18n/modules/safety.js` — the 5-language dictionary (251 keys ×
  5 languages, full parity verified).
* `src/components/safety/safety.css`.
* `src/components/admin/AdminNav.jsx`'s new `safety` nav group,
  `src/components/AdminCenter.jsx`'s new screen-map entries, and
  `src/App.jsx`'s new `/app/safety` portal route.
* `tests/safety-management-invariants.test.mjs` — 10 static invariant tests
  written specifically for this module (mirrors the pattern
  `tests/assets-management-invariants.test.mjs` established).

## 1. Architecture — the core decision

**Asset-kind PPE never gets a second record.** A durable, individually
tracked item (a gas detector, a breathing apparatus, a safety harness) is a
real `public.assets` row, owned entirely by Assets Management — created via
`asset_create()`, never a parallel insert. Safety Management adds exactly one
new extension table, `safety_asset_ext`, keyed by `asset_id` (same idiom as
`asset_maintenance`), carrying only safety-specific fields (expiry,
inspection interval/dates, condition). An issuance line becomes "asset-kind"
by supplying that asset's id; the RPC layer requires the caller to also hold
`Assets.Operate`/`Assets.Manage` (not `Safety.Issue` alone) and rejects a
Disposed asset — mirroring `asset_transaction_create()`'s own gate exactly.

**Consumable-kind PPE never becomes an asset row.** Gloves, masks, ear plugs
live entirely inside `safety_issuances`/`safety_issuance_items` — no
`asset_groups` row, no `asset_transactions` entry, ever.

**PPE Set → position/department/project/site targeting reuses the existing
Audience Engine** (`public.audience_rules`/`audience_rule_terms`,
migration 202608040013) rather than a bespoke join table. Two shared-infra
extensions were required and made explicit: `audience_rules.entity_type`
gained `'SafetyPpeSet'`, and `audience_rule_terms.dimension` gained
`'Position'` (the one targeting dimension the engine didn't yet have — every
prior module used the coarser `Role`/`Department`). `AudiencePicker.jsx`
gained an optional `dimensions` prop (default unchanged) so this module could
add `Position` to its own picker without touching any other entity_type's
dimension list.

| Need | Reused from |
|---|---|
| Reference numbers | `generate_number('PI'\|'FV', tenant)` — once per issuance/visit header |
| Event history | `record_activity()` + this module's own `safety_timeline()` wider-audience wrapper |
| Attachments | `public.attachments`/`attachment_attach()` (extended for `SafetyPpeType`/`SafetyIssuance`/`SafetyFieldVisitCheck`) + `safety_attachment_list()` |
| E-signature | `src/components/SignaturePad.jsx` — existing component, new wiring only |
| Notifications | `public.notify()`, category `'System'` (no new category added to Platform Core) |
| Org dimensions + requirement targeting | `public.positions`/`departments`/`projects`/`sites` via the Audience Engine, extended (not duplicated) with `Position`/`SafetyPpeSet` |
| Asset lifecycle (Asset-kind PPE) | `assets`/`asset_transactions` via `asset_create()`/`asset_transaction_create()`/`asset_maintenance_report()` — never reimplemented |
| Permissions | `has_permission()`, 4 new codes |
| QR | No scanner exists anywhere in this codebase (confirmed by direct grep for `getUserMedia`/`BarcodeDetector`/`jsQR`/`zxing`) — Field Visit employee resolution is manual number/name entry, the spec's own explicit fallback, not an oversight |

## 2. Closing Audit

An independent, no-prior-trust multi-lens audit (Security, Architecture &
Duplication, i18n/Navigation/Icons, Accessibility/UX, Performance &
Correctness) plus adversarial re-verification of every claim found:

* **Security**: zero confirmed defects — every RPC's authorization,
  every re-declared shared function, every table's RLS, and the
  PUBLIC-execute revoke footgun all checked out correct on first build.
* **Architecture**: one **Major** real gap — a serial-tracked PPE asset
  could be issued to two employees simultaneously (nothing excluded an
  asset already backing another `Issued` item). **Fixed**: added an
  `ASSET_ALREADY_ISSUED` guard to `safety_issuance_create()`/
  `safety_issuance_item_add()` (both a within-batch duplicate check and an
  against-existing-Issued-items check), verified end-to-end against live
  Postgres. Also found and fixed: `SafetyTimelinePanel` triplicated across
  three screens with diverging behavior (consolidated into
  `safetyTimeline.jsx`), a byte-identical `daysUntil()`/`<DueCell>` copy
  (consolidated into `safetyDueCell.jsx`), and three dead exports
  (`ISSUANCE_ITEM_STATUSES`, `addIssuanceItem()`, the `module_safety` i18n
  key) — all removed after confirming zero remaining references.
* **i18n/Navigation/Icons**: two real gaps, both fixed — `AppShell.jsx`'s
  `NAV_ICONS` map had no `shield` entry for the portal's own registered
  icon, and one decorative icon in `SafetyPortal.jsx` was missing
  `aria-hidden`. Every other screen-registration/AdminNav/AdminCenter/App.jsx
  wiring checked out correct, and all 251 i18n keys resolve in all 5
  languages.
* **Accessibility/UX**: one real gap, fixed — `SafetyFieldVisitsAdmin.jsx`
  was missing the list↔detail focus-restoration pattern its two sibling
  screens already implement correctly; added the same
  `returnFocusRowIdRef`/`tableWrapRef` pattern.
* **Performance/Correctness**: three real defects, two fixed, one deferred.
  Fixed: an N+1 burst in the Reports screen's Lost/Most-replaced/
  Distribution tabs (replaced a `Promise.all` loop of up to 150 requests
  with one bulk `.in()` query); a silent data-loss bug where an expiring
  item belonging to an issuance outside the most-recent-200 page rendered a
  blank employee/reference (fixed with a targeted by-id backfill query).
  Deferred: a smaller, user-triggered (button-click, capped at 100) N+1 in
  the Compliance report tab — genuinely needs a new bulk RPC rather than a
  client-side fix, called out explicitly as a follow-up rather than
  guessed at.

Two items were deliberately left as documented, lower-severity
maintainability debt rather than "fixed" — two structurally different
employee-search widgets (different a11y contracts, unsafe to merge without
separate validation) and per-file id→label lookup closures repeated across
3-4 screens (cosmetic, not a bug).

## 3. Mandatory Verification

* **Migration chain**: the full 56-file chain (through this module) applied
  cleanly against a **fresh** local Postgres 17 instance, twice — once
  immediately after the build, once again after every closing-audit fix
  landed. Zero errors both times.
* **Functional tests** against the same live instance: PPE type/set
  creation, Position-targeted audience rule → correct requirement
  resolution (covered employee gets the set's items, uncovered employee
  gets none), compliance summary transitioning correctly through
  not-issued → partially-issued → fully-issued as items are issued,
  asset-tracked issuance requiring `Assets.Operate`/`Manage` and rejecting
  a Disposed asset, a non-Safety-permission caller correctly denied, and —
  added after the closing audit — the new double-issuance guard rejecting
  both a within-batch duplicate and a second issuance of an
  already-`Issued` asset. Every expected success and every expected error
  matched exactly.
* **`npm test`**: 73/73 (63 pre-existing + 10 new Safety-specific static
  invariant tests).
* **`npm run lint`**: clean.
* **`npm run build`**: clean (the one warning present — an i18n chunk over
  700kB — is a pre-existing advisory about code-splitting, not an error).
* **Browser**: dev server loads with no console or server errors. Full
  authenticated click-through was not possible in this environment (no live
  Supabase credentials available to this session) — stated honestly rather
  than claimed.

## Deferred / out of scope (explicit, final)

* **No QR/camera scanner.** Confirmed absent anywhere in this codebase;
  Field Visit employee resolution is manual number/name entry, the spec's
  own stated fallback.
* **No scheduler wired for `safety_expiration_scan()`.** The RPC's full
  scan/notify logic is implemented and callable (`service_role` only,
  de-duplicated against the last 7 days), but this codebase has no
  pg_cron job or scheduled Edge Function anywhere yet — wiring one is a
  deployment-time decision outside this module's scope, exactly like
  Assets Management's own PO/IV precedent.
* **Consumable stock/warehouse quantity tracking.** The spec asks for
  distribution/consumption records per employee, not a storeroom ledger —
  mirrors Assets' own "not described, not built" precedent.
* **A bulk RPC for the Compliance report's row-level drill-down.** The
  4-KPI Compliance Dashboard is complete; a full per-employee breakdown
  in the Reports screen currently does client-side N+1 (capped,
  button-triggered) pending a dedicated bulk RPC as a follow-up.

## Status

| Review step (contract §16) | Result |
|---|---|
| 1. Architecture review | **PASS** — §12 reuse table above; core Asset-vs-Consumable rule verified honored after the double-issuance fix |
| 2. Security review | **PASS** — zero confirmed defects on first build, re-verified adversarially |
| 3. Performance review | **PASS** — 2 of 3 real N+1/correctness findings fixed, 1 explicitly deferred with reasoning |
| 4. Documentation review | **PASS** — this document |
| 5. Migration review | **PASS** — full chain replay, zero errors, twice |
| 6. Tests | **PASS** — 73/73, including 10 new module-specific static tests |

**Safety Management is Final Closed.**
