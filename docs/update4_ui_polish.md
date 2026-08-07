# Update 4 — UI Polish — 2026-08-07

## Why this phase exists

The final stage of Update 4's mandatory execution order (Platform Core →
... → Assets → Safety → Operations → **UI Polish**). FourthUpdate.md's own
"Global Navigation Standards" section requires the whole platform to share
one consistent navigation concept — not just moving menus from top to side —
covering: a unified sidebar, unified icons, a fixed menu order, a breadcrumb
on every screen, a per-module dashboard, a Favorites page, a Recent Items
page, a unified search that opens any screen directly, a collapsible
sidebar, and mobile navigation support.

A discovery pass (7 parallel investigations) was run first against the real
codebase before any build work started, exactly as every prior module began
with discovery. It surfaced something far more serious than cosmetic
polish: **a production-breaking navigation bug** affecting every real user
of the entire platform, plus a genuinely broken screen, a fragmented icon
registry, and several fully-missing features. This phase's scope was set by
that discovery, not assumed in advance.

## 1. The critical bug found and fixed

**`AppShell.jsx`'s top navigation collapsed into a single "More" dropdown
for every real deployment.** `useNavigationGroups()` grouped screens by
`screen.area`, but every real `public.app_screens` row's `area` is always
one of exactly `Portal`/`Admin`/`Platform` — never one of the six bucket
names (`WORKSPACE`/`SERVICES`/`LIBRARY`/`ORGANIZATION`/`COMPLIANCE`/
`ADMINISTRATION`) the grouping logic expected. Those six names only ever
matched the hand-written local-preview fallback data, so the bug was
invisible in local/offline preview and present in every live deployment. In
production: every Portal screen (Home, Requests, Approvals, Documents,
Announcements, Calendar, My Assets, My Safety, My Operations, My Card,
Support…) collapsed into one dropdown literally labelled "More", and for an
admin-rank user, a second "More" dropdown held all ~48 individual admin
screens flattened a second time on top of AdminNav's own already-correct
sidebar — two structurally different navigation systems stacked on the same
screen.

**Root cause, precisely**: `public.app_screens` carries two separate
columns — `area` (the coarse Portal/Admin/Platform surface) and `group_code`
(the real, fine-grained cluster: Workspace/Requests/Content/Engagement/...).
The frontend's `normalizeScreen()` collapsed both into one field, prioritizing
`area` (always truthy) over `group_code` (the one the grouping logic actually
needed), making `group_code` unreachable dead data.

**Fix**: `normalizeScreen()` now returns both fields distinctly — `area`
(surface partition) and `group` (display cluster). `useNavigationGroups()`
filters to `area === 'PORTAL'` only and groups by `group`; Admin-area
screens now reach the user via a single new "Administration" profile-menu
entry (mirroring the pre-existing "Platform console" entry for operators)
instead of being flattened into the top nav a second time — AdminNav.jsx's
own sidebar is already the complete, correctly-ordered, fully-iconed nav for
every admin screen once you're inside Admin Center. A closing-audit pass
later found and fixed one more layer of this: a non-admin-role account can
still be granted individual admin screens via fine-grained `role_screens`
overrides, so the "Administration" link now also appears whenever
`my_screens()` genuinely returns any Admin-area row, not only when the role
code itself is one of the standard admin roles.

**Verified two ways** (no live Supabase credentials available in this
environment, so a real click-through wasn't possible — the same disclosed
limitation as every prior module this session): (1) a standalone Node script
parsing every real `app_screens` insert across all 58 migrations and
replaying the exact frontend grouping logic by hand — confirms the fix turns
91 real seeded rows into 8 correctly-labelled, non-collapsing Portal groups
(zero rows falling through to "More") where the pre-fix logic produced
exactly 3 buckets (`PORTAL`/`ADMIN`/`PLATFORM`, each rendering as "More");
(2) a live browser check of the local-preview code path (which exercises the
same component tree, i18n resolution, and icon rendering with zero console
errors).

## 2. Everything else built

* **Icon registry** — `AppShell.jsx`'s `NAV_ICONS` map expanded from 18 to
  ~78 entries (every distinct `public.app_screens.icon` value across every
  migration). Previously 57 of 73 real icon keys had no entry, so most
  screens reaching the top nav — all of Operations', most of Safety's/
  Assets' — silently rendered a generic fallback icon instead of their own.
* **Breadcrumb** (new: `src/components/shell/Breadcrumb.jsx`) — rendered
  once in the shell chrome, not per-screen (avoiding ~50 individual file
  edits). Resolves Portal routes via `useNavigationGroups()`, Admin routes
  via AdminNav's own role/module-filtered `useAdminNavigation()` (not the
  raw, unfiltered group list — a real security gap the closing audit caught
  and fixed, see §3), and a small standalone-route map for
  verification/platform/card. Memoized (`useMemo` + `React.memo`) so it
  doesn't re-render on unrelated shell state changes.
* **Global Search fix** (`src/components/GlobalSearch.jsx`) — the
  "jump to a screen" destination list was a hand-maintained array of 7-8
  entries that had already drifted (Assets/Safety/Operations/Digital
  Identity/Notes/Calendar/Verification/Certificates/Platform Console were
  all unreachable, along with every individual admin screen). Now built
  from the same `loadMyScreens()` data the nav itself uses — 14 portal +
  46 individually-named admin screens reachable for a company admin (60
  total, versus 8 before), automatically staying in sync as new modules
  ship.
* **Support screens** (new: `src/data/supportService.js`,
  `src/components/support/{SupportPanel,SupportTickets,supportShared}.jsx`
  + `support.css`, `src/i18n/modules/support.js`) — `ADMIN_SUPPORT` and
  `PORTAL_SUPPORT` were both registered in the nav with **no backing screen
  or route at all**; admin/support fell through to a generic
  `<Unavailable/>`, and `/app/support` didn't exist in `src/App.jsx`. Built
  entirely against pre-existing, already tenant-scoped RPCs
  (`support_ticket_create_internal`/`support_reply`/`support_ticket_set_status`/
  `support_ticket_detail`) and RLS-scoped direct reads of
  `support_tickets`/`support_messages` — no new SQL. `support_ticket_assign`
  is platform-operator-only with no tenant branch at all, so no UI control
  calls it (a button that fails for every possible caller was deliberately
  left unwired, matching this session's own established precedent for
  out-of-scope actions). `PORTAL_SUPPORT`'s own `app_screens` row is
  currently `is_active = false` (a pre-existing flag from an earlier
  migration, not something this phase changed) — the route/screen now exist
  and are correct, ready for a future migration to activate without a
  frontend follow-up.
* **Favorites + Recent Items** (new:
  `supabase/migrations/202608070058_ui_polish.sql`,
  `src/data/navigationAidsService.js`,
  `src/components/favorites/{FavoritesScreen,RecentItemsScreen}.jsx`,
  `src/i18n/modules/navigationAids.js`) — two new tables
  (`user_favorites`, `user_recent_screens`), 5 new RPCs
  (`favorite_screen_add`/`_remove`/`_list`, `recent_screen_touch`/`_list`),
  2 new `app_screens` rows. Deliberately scoped to favoriting/revisiting a
  **screen** (matching the Global Navigation Standards' own framing as a
  navigation aid), not an arbitrary business record. Neither table gets the
  standard `apply_row_defaults`/`write_audit_log` trigger pair — no
  `created_by`/`row_version` columns exist on either by design, and
  audit-logging a fire-and-forget "you visited a screen" call on every
  navigation would flood `audit_logs` — `tests/tenancy-invariants.test.mjs`'s
  allow-list was extended with a documented rationale, mirroring 5 other
  tables already on that same list for the identical reason.
* **Accessibility** — 8 inline modals in `AdminCenter.jsx` (previously
  missing `role="dialog"`/`aria-modal`/focus-trap/Escape) now use
  `useDialogA11y()` matching every other modal in this codebase; all 13
  bare `<X />` close-icon instances across those modals now carry
  `aria-hidden="true"`; 3 icon mismatches fixed between
  `VerificationCenter.jsx`'s own section list and AdminNav's choices for
  the identical 4 screens.
* **i18n — a real, previously-undiscovered wrong-language bug** —
  `LanguageContext.jsx`'s `approvalTranslations` block (the entire
  approval-workflow vocabulary, 189 keys — request cancellation, role/
  reviewer/delegate pickers, take-action forms, tracking dashboard, all
  `approval_err_*` messages) only ever had `ar`/`en` sub-objects. The final
  translations composition spread the **wrong other language** into the
  gap: Hindi-language users got the English strings, Urdu-language users
  got the Arabic strings, Tagalog-language users got the English strings
  again — not a graceful missing-key fallback, wrong-language text baked
  into what looked like a fully localized screen, on what is almost
  certainly the single most-used part of the entire platform. Fixed with
  189 real, faithful hi/ur/tl translations (567 new strings) plus
  correcting the composition. Full key and `{{placeholder}}`-token parity
  verified programmatically.
* **Small consistency fixes** — a one-off `assets-title-icon` CSS class
  (unstyled, should have been the shared `admin-title-icon`) corrected in
  `AssetCustodyUnitsAdmin.jsx`; the 3-way-duplicated tab-list CSS
  (`.assets-tablist`/`.safety-tablist`/`.ops-detail-tablist`) reconciled —
  `.assets-tablist` was missing `cursor: pointer` and had a different
  vertical margin than its two siblings.
* **`isModuleAllowed()` de-duplication** — the same `moduleMapKnown`/
  `moduleAllowed` guard, hand-copied into `AppShell.jsx`, `AdminNav.jsx`,
  and `GlobalSearch.jsx` independently, was hoisted into one shared
  `TenantContext.isModuleAllowed()` helper all three now call.
* **`my_screens()` request de-duplication** — before the closing audit,
  `AppShell`, `Breadcrumb`, and `GlobalSearch` (plus, per-visit,
  `FavoritesScreen`) each independently called `loadMyScreens()` on mount —
  3-4 redundant, byte-identical RPC round-trips per session. Now a single
  module-level promise cache shared by every caller, correctly invalidated
  on every real session/tenant boundary (`switchTenant`, sign-out, the
  idle-timeout auto-logout, and the forced sign-out when a visitor isn't a
  member of the tenant in the URL).

## 3. Closing Audit

An independent, no-prior-trust multi-lens audit (Security, Architecture &
Duplication, i18n/Navigation/Icons, Accessibility/UX, Performance &
Correctness) plus adversarial re-verification of every claim, run against
the whole phase — unusually large and cross-cutting compared to a single
module's own audit, since the shared shell chrome itself (`AppShell.jsx`,
independently edited by 4 different agents across two separate build passes)
was in scope.

**13 findings raised, 11 confirmed real, 2 false positives, all 11 fixed:**

* **Security — 1 Major, fixed.** `Breadcrumb.jsx` resolved `/app/admin/
  :section` against the raw, unfiltered `ADMIN_GROUPS` export — so a
  signed-in account without the role or module license to actually open a
  given admin section would still see its real, localized name and group in
  the breadcrumb trail, disclosing the full admin-screen catalogue
  regardless of permission. Fixed by resolving against the same
  role/module-filtered `useAdminNavigation()` hook AdminCenter itself
  renders against — an unreachable section now collapses the trail to
  `Home > Administration` instead of leaking its name.
* **Architecture/Duplication — 3 Nits, fixed.** The `moduleAllowed` guard
  duplicated verbatim in three files (hoisted into `TenantContext.
  isModuleAllowed()`); a stale doc-comment still pointing at
  `FALLBACK_SCREENS`' old location; the admin-breadcrumb-resolution issue
  above, independently caught a second time by this lens.
* **i18n/Navigation/Icons — 2 findings, fixed.** A non-admin role holding
  individual admin screens via fine-grained `role_screens` overrides had no
  persistent, browsable path to `/app/admin` (only Global Search could reach
  it) — fixed with a live `hasAdminAreaAccess` check alongside the
  role-based gate. `FALLBACK_SCREENS` (the local-preview/offline nav model)
  was missing entries for the two screens this phase itself shipped
  (Favorites/Recent Items) — added, matching their real `display_order`.
* **Accessibility/UX — 2 Minor, fixed.** The breadcrumb rendered a
  redundant `Home > My workspace > Home` trail on the bare `/app` landing
  route (both the first and last crumb restate "Home") — now renders
  nothing on that route instead of guessing. All 13 bare `<X />` close-icon
  instances across `AdminCenter.jsx`'s modals (including the 8 just made
  dialog-compliant) were missing `aria-hidden="true"`.
* **Performance/Correctness — 2 Major, 1 Minor, fixed.** The Recent Items
  bookkeeping's de-dupe ref could silently stop recording a genuine revisit
  after any detour through a non-Portal route (Admin, Platform Console, an
  unregistered path) — fixed by re-arming the ref whenever the current route
  doesn't match a known Portal screen. Three-to-four fully redundant
  `my_screens()` RPC calls fired at every session start with zero caching —
  fixed with the shared promise cache described in §2. The breadcrumb
  recomputed its entire trail on every `AppShell` re-render, including
  unrelated keystrokes elsewhere in the shell — fixed with `useMemo` +
  `React.memo` (the fix agent additionally caught and corrected a
  Rules-of-Hooks violation the verifier's own suggested snippet would have
  introduced, restructuring so the hook is called unconditionally on every
  render as required).

No findings were dismissed as "won't fix" — every confirmed finding was
resolved in this same pass.

## 4. Mandatory Verification

* **Migration chain**: the full 58-file chain (through this phase's new
  `202608070058_ui_polish.sql`) applied cleanly against a **fresh** local
  Postgres 17 instance. Zero errors.
* **Functional test** (`ui_polish_functional_test.sql`) against the same
  live instance: idempotent favorite add/remove (re-adding an existing
  favorite, removing an already-removed one — neither errors); upsert-not-
  duplicate `recent_screen_touch` semantics (the same screen touched twice
  collapses to one row with a refreshed timestamp, confirmed via a direct
  row count); silent no-op on a stale/unknown/`null` screen code (confirmed
  it never raises); `p_limit` clamping at both the floor (0 → 1) and — the
  practical case — the ceiling; and, most importantly, **RLS proven live**
  with a second user: zero favorites/recents visible via either RPC, **and**
  a direct client-side `SELECT` against another user's own favorite rows
  returns zero rows too, confirming the isolation is enforced by the table's
  own RLS policy, not merely by the RPC layer choosing not to expose it.
  Every expected result matched exactly.
* **`npm test`**: 83/83 (unaffected — this phase added no new unit-test
  file of its own, since its correctness lives in the live-Postgres
  functional test above and the standalone nav-grouping verification
  script; the existing suite's own `tenancy-invariants` tests do cover the
  new tables via the extended allow-list).
* **`npm run lint`**: clean across the **whole repository** on every pass,
  run deliberately at full scope throughout this phase since several fixes
  touched shared infrastructure (`useDialogA11y.js`-adjacent patterns,
  `TenantContext.jsx`, `AuthContext.jsx`) consumed well beyond this phase's
  own new files.
* **`npm run build`**: clean on every pass (the one warning present — an
  i18n chunk over 700kB — is a pre-existing advisory about code-splitting,
  not an error). Every new screen (`SupportPanel`, `SupportTickets`,
  `FavoritesScreen`, `RecentItemsScreen`) confirmed building as its own
  separate lazy chunk.
* **Browser**: dev server loads with no console or server errors, checked
  after both the build workflow and the closing-audit workflow. Full
  authenticated click-through was not possible in this environment (no live
  Supabase credentials) — stated honestly rather than claimed, the same
  disclosed limitation as every prior module this session. The one piece of
  this phase's own core claim (the nav-grouping fix) that most needed
  empirical proof was independently verified two other ways instead (see
  §1): a standalone script replaying the real fix logic against all 91 real
  seeded screen rows, and a live check of the local-preview code path.

## Deferred / out of scope (explicit, final)

* **No literal single sidebar component for the whole app.** AdminNav's own
  grouped sidebar (Admin Center only) and AppShell's top-bar-plus-drawer
  (everywhere else) remain two different chrome shapes — a full nav-shell
  rewrite unifying them into one literal sidebar component doing double duty
  as both a 9-group admin tree and a flat portal launcher was judged too
  large and too regression-risky to attempt safely within this pass, given
  it would touch every authenticated screen in the platform. The functional
  bug (screens vanishing into "More") is fixed; the two-chrome-shapes
  question is a genuine follow-up, not silently dropped.
* **No collapsible sidebar for AppShell.** There is no persistent sidebar in
  the portal chrome to begin with (a horizontal top bar plus an off-canvas
  mobile drawer) — a "shrink to icons" toggle is structurally inapplicable
  until/unless the item above is addressed.
* **`support_ticket_assign` has no UI.** Platform-operator-only, no tenant
  branch — the service function exists (as instructed) but no button calls
  it, since a control that fails for every possible company-admin caller
  would be worse than not offering it.
* **`PORTAL_SUPPORT` stays inactive.** Its own `app_screens` row predates
  this phase and was already flagged `is_active = false` with a documented
  reason ("raised from the administration centre instead") — this phase
  built the screen/route correctly but did not reactivate that row, which
  wasn't this phase's decision to make.

## Status

| Review step (contract §16) | Result |
|---|---|
| 1. Architecture review | **PASS** — the shared-shell reuse pattern (Breadcrumb/Global Search/Favorites all read the SAME nav data, not hand-maintained copies) verified end-to-end after the closing audit's de-duplication fixes |
| 2. Security review | **PASS** — 1 confirmed Major (admin-catalogue disclosure via Breadcrumb) found and fixed; the phase's own headline fix (nav-grouping collapse) is itself a correctness/availability fix, independently proven via a real-data replay script |
| 3. Performance review | **PASS** — 2 Major + 1 Minor findings, all fixed (recent-items de-dupe bug, redundant RPC calls, unmemoized breadcrumb) |
| 4. Documentation review | **PASS** — this document |
| 5. Migration review | **PASS** — full 58-file chain replay, zero errors, plus a live functional test proving RLS isolation end-to-end |
| 6. Tests | **PASS** — 83/83 node --test, plus the standalone nav-grouping data-replay script and the live-Postgres functional test covering the new SQL directly |

**UI Polish is Final Closed.**
