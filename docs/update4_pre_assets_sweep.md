# Update 4 — Pre-Assets-Management sweep

Independent, no-prior-trust re-verification run 2026-08-06, ordered by explicit
instruction before Assets Management could start: "Do not rely on any previous
reports (including your own). Use the current codebase and FourthUpdate.md
only." Re-checked all 7 phases previously claimed closed — Platform Core,
INumberGenerator, Storage, Workflow Engine, Attachments, Verification Service,
Digital Identity — across 23 dimensions (business logic, architecture,
security, RLS, permissions, transactions, number generation, multi-tenancy,
API contracts, React architecture, performance, UX, accessibility, i18n, dead
code, duplicate code, database, documentation, build, tests, migrations,
cross-module integration, cross-module consistency), plus hidden issues that
only appear when modules interact.

## Method

A 12-lens parallel discovery workflow, blind to every prior phase doc's own
claims, produced findings across all 23 dimensions; each went through
adversarial verification before being accepted. 37 confirmed in-scope
problems, including 3 Blockers. Every SQL fix is carried in migration
`202608060053_pre_assets_zero_debt_sweep`, re-verified against a freshly
rebuilt, isolated PostgreSQL 17 instance (full migration chain applied from
scratch) with hand-written functional tests exercising each fix (forged
`storage_objects` insert blocked, cross-tenant scheme wipe blocked, anon
audit-log-growth path fixed, `field_visibility` validation rejects malformed
payloads). Frontend, documentation and test-suite fixes landed in their own
files, not the migration.

## Fixed

**Blockers**

1. **[Security]** `src/components/identity/EmailSignatureScreen.jsx` built the
   HTML email signature by interpolating `tenant_branding.primary_color` (an
   admin-settable, unvalidated value) directly into inline `style` attributes
   with no escaping — a stored-XSS path into every signature-including email.
   Escaped via `escapeHtml()` before interpolation (4 call sites).
2. **[Security, migration 053]** `storage_objects` carried both a RESTRICTIVE
   tenant-isolation policy and a permissive `FOR ALL` "storage managers manage
   storage objects" policy gated only on `Storage.Manage` — the same
   "permissive `FOR ALL` + a validated write RPC on the same table" forgery
   pattern already found and fixed once in Verification's own closing audit
   (migration 048, `verifiable_documents`). Any `Storage.Manage` holder could
   `INSERT`/`UPDATE` a `storage_objects` row directly via PostgREST, forging
   ownership of a file they never uploaded and bypassing `storage_register()`/
   `storage_unregister()`'s own checks entirely. Policy dropped; only the
   RPCs may write this table now.
3. **[Security, migration 053]** `approval_scheme_set_roles()` had no
   `tenant_id` check on either the existence lookup or the role-replace
   `delete` — a caller could wipe and rewrite another tenant's approval
   scheme roles by guessing/enumerating a `scheme_id` UUID. Scoped both to
   `current_tenant_id()`.

**Majors**

4. **[migration 053]** `attachment_list()` / `form_attachment_list()` omitted
   `checksum` from their `select` list even though `storage_objects.checksum`
   is populated on upload (migration 038) — every Attachments Panel consumer
   silently lost the SHA-256 hash the UI is built to show. Added to both.
5. **[migration 053]** `approval_submit()`'s no-approval-chain branch (a
   template with `requires_final_approval = false`) never set
   `approval_started_on`, leaving SLA-aging calculations for those requests
   permanently blank. Added `coalesce(approval_started_on, now())`.
6. **[migration 053]** Digital Identity's `audit_employee_cards` trigger fired
   on every `UPDATE`, including the high-frequency, low-value
   `card_track_event()` counter bump — an unauthenticated-adjacent, anonymous
   caller (the public card page) could grow `audit_logs` without bound simply
   by viewing a card repeatedly. Narrowed to a column-scoped trigger
   (`after update of visibility, template_code, theme, shape, show_logo,
   show_photo, linkedin_url, extension_phone, field_visibility, is_active,
   is_deleted`) so only genuine settings changes audit.
7. **[React architecture]** `VerificationCenter.jsx`'s own `SECTIONS` array
   already gated its Attestations/Certificates sub-screens by two different
   module codes, but `App.jsx`'s outer `<ModulePage module="VERIFICATION">`
   wrapper checked only one — a tenant licensed for `CERTIFICATES` alone
   could never reach the route at all. `ModulePage` now accepts `module` as
   either a string or an array (OR semantics); the route passes
   `['VERIFICATION', 'CERTIFICATES']`.

**Minors**

8. **[migration 053]** `number_sources` row for the `EV` (Performance
   Evaluation) source code still carried its original `owner_module` from
   before the Workflow Engine took over evaluation numbering. Corrected to
   `'Workflow Engine'`.
9. **[frontend]** `formsService.js`'s `allocateReferenceNumber` threw instead
   of returning `{ data, error }` (contract §9: "every service function
   returns `{ data, error }` and never throws"). Now returns the pair; a new
   `allocateReferenceNumberOrThrow()` wraps it for the two internal call
   sites that want throw-on-failure semantics.
10. **[migration 053]** `card_get_mine()`'s `unique_violation` fallback
    re-select had no guard for the (theoretical but real) case where the row
    still isn't found after the retry — added `if not found then raise
    exception 'CARD_ALLOCATION_CONFLICT'`.
11. **[migration 053]** `card_save_settings()` accepted a `field_visibility`
    payload of any JSON shape, including a non-object, with no validation —
    added a `jsonb_typeof(...) is distinct from 'object'` rejection.
12. **[React/dead code]** `AdminNav.jsx` registers 11 `app_screens` rows with
    no implementing admin screen. Investigated each: `ADMIN_FORMS` is a
    confirmed dead duplicate of `ADMIN_APPROVAL_ALL_REQUESTS` (migration
    044); the other 9 (`ADMIN_TEMPLATES`, `ADMIN_SECURITY`,
    `ADMIN_EVALUATION_TEMPLATES`, `ADMIN_SETTINGS`, `ADMIN_LOOKUPS`,
    `ADMIN_EMAIL_TEMPLATES`, `ADMIN_EMAIL_QUEUE`, `ADMIN_IMPORTS`,
    `ADMIN_STORAGE`) are genuinely unbuilt future scope, not duplicates of
    anything that exists. Building 9 new admin screens is out of proportion
    for a zero-debt sweep; all 10 rows deactivated (`is_active = false`) so
    they stop appearing as dead nav links, per `my_screens()`'s existing
    `is_active` filter — none are deleted, so re-activating one is a single
    migration away from whoever builds it.

**Duplicate/dead code**

13. `listFormAttachments` was independently reimplemented in both
    `FormsPortal.jsx` and `ApprovalCenter.jsx`. Consolidated into one export
    from `src/data/approvalService.js`; both components now import it.
14. `hoursSince`/`agingLabel` (SLA aging display) were reimplemented a third
    time in `ApprovalAdmin.jsx` on top of the two copies already
    consolidated earlier in Update 4. Moved to `src/utils/approval.js`
    (`hoursSince`, `agingLabel`) as the single source; `ApprovalCenter.jsx`
    and `ApprovalAdmin.jsx` both now import it (kept `ApprovalAdmin.jsx`'s
    genuinely-distinct `hoursBetween` helper, which computes an interval
    between two arbitrary timestamps, not "now minus one").
15. `LanguageContext.jsx`'s `workflowTranslations` block defined
    `role_system_administrator` and `role_platform_administrator` in all 5
    languages, but `src/i18n/index.js` merges `moduleTranslations`
    (`src/i18n/modules/*.js`) **after** `workflowTranslations`, so
    `platform.js`'s versions always win. For `role_platform_administrator`
    the two disagreed ("Platform Administrator" vs "Organization
    Administrator" in English; different Arabic text too) — the
    `workflowTranslations` copies were pure dead weight, never rendered.
    Removed from all 5 language blocks; `platform.js` is now the only
    source.
16. `src/i18n/modules/platform.js` defined 9 `action_*` keys with zero live
    `t()` consumers anywhere in the frontend (`action_retry`, `action_back`,
    `action_more`, `action_less`, `action_select`, `action_send`,
    `action_submit`, `action_manage`, `action_view` — confirmed by grepping
    every `.jsx`/`.js` file for each literal key, including a check for
    dynamic `` `action_${x}` `` template construction, which does not occur
    anywhere in the codebase). Removed from all 5 language blocks.

**Accessibility**

17. None of the ~13 modal dialogs across `FormsPortal.jsx`,
    `ApprovalCenter.jsx`, `ApprovalChain.jsx`, `ApprovalAdmin.jsx` had
    `role="dialog"`, `aria-modal`, an `aria-label`, initial focus, or an
    Escape-to-close handler — every one of them was previously-audited and
    fixed in `AttestationsScreen.jsx` (Verification's own closing audit) but
    the pattern was never propagated to the Workflow Engine's own modals.
    Extracted the shared logic into `src/utils/useDialogA11y.js` (matching
    `AttestationsScreen.jsx`'s existing lighter, non-Tab-trap pattern rather
    than inventing a third variant) and applied it to all of them, including
    extracting `ApprovalCenter.jsx`'s previously-inline cancel-confirmation
    JSX into a proper `CancelConfirmModal` component (a custom hook cannot be
    called conditionally inside inline JSX).
18. Inline dismissible notice banners across the same 4 files were missing
    `role="status" aria-live="polite"` on the wrapper and `type="button"`/
    `aria-label` on the close button. Fixed on every occurrence.
19. `FormsPortal.jsx`'s catalog category filter, "My Requests" status filter,
    and Self/On-Behalf submission-mode toggle, plus its view-switcher
    sidebar, had no ARIA role/state at all on the underlying
    `.segmented`/nav button groups. Filter-style groups now carry
    `role="group"` + per-button `aria-pressed`; the sidebar view switcher
    (which navigates, rather than filters, matching `AdminNav.jsx`'s own
    pattern) carries `aria-current="page"` on the active item.

**i18n**

20. `ACTION_KEYS` in `src/utils/approval.js` (used to label approval-history
    timeline entries — `VerifyRequestPage.jsx`, `ApprovalChain.jsx`) mapped
    `Submit`/`Cancel` to the keys `action_submit`/`action_cancel` — the exact
    same key names `platform.js` uses for its generic imperative dialog
    buttons ("Submit"/"Cancel"). Because `src/i18n/index.js` merges
    `moduleTranslations` last, `platform.js`'s imperative text always won,
    so every approval-history timeline showed "Submit"/"Cancel" instead of
    the intended past-tense "Submitted"/"Cancelled" — live on both the
    internal Approval Chain view and the public `/verify/:code` page, in
    every language. Renamed the timeline-specific keys to
    `action_hist_submit`/`action_hist_cancel` in `LanguageContext.jsx` and
    updated `ACTION_KEYS` to match; `platform.js`'s generic keys are
    untouched and still serve every ordinary Cancel/Submit button.
21. `FormsPortal.jsx` had 4 `catch` blocks (`refresh()`, the initial-load
    `useEffect`, `save()`, `saveMemo()`) that surfaced the raw
    `error.message` instead of running it through `approvalErrorMessage()`
    like every other error path in the same file — a raw
    `SCREAMING_SNAKE_CODE` (or an empty message) could leak straight to the
    UI instead of its translated text. All 4 now use
    `approvalErrorMessage(t, error)`.

**RTL**

22. Six rules in `src/index.css` used physical `border-left`/`border-right`
    for a leading-edge accent bar (`.auth-message`, `.welcome-meta`,
    `.forms-sidebar > button` active state and its mobile-breakpoint reset,
    `.inline-message`, `.mobile-drawer > a` active state) instead of the
    `border-inline-start`/`-end` logical properties already established
    elsewhere in the same file (`.timeline-comment`,
    `.pending-approvals-panel`, `.content-browser`) — the accent bar rendered
    on the wrong physical side for an English (LTR) reader. Converted all
    six. **Not touched:** `.employee-info-grid`/`.info-field` and
    `.cycle-print .info-field`, which use a different, direction-agnostic
    construction (every cell gets its own `border-left`, the container
    supplies only `border-top`/`border-right`) that was verified — by
    measuring actual rendered `getBoundingClientRect()` positions under both
    `dir="ltr"` and `dir="rtl"` — to already produce the correct outer edges
    in both directions, because CSS Grid reverses item visual order under
    `direction: rtl` while each cell's own physical border-left moves with
    it. Converting these two to logical properties would have broken them.

**Documentation**

23. `bbnovix_contract.md` §5's module-code list was missing
    `DIGITAL_IDENTITY` (added by migration 202608060049, after the list was
    last written). Added.
24. `bbnovix_contract.md` §6/§10 listed `src/lib/routing.js`'s real helper
    names but omitted `cardUrl` (added for Digital Identity's public card
    page, actively used by `MyCardScreen.jsx`/`EmailSignatureScreen.jsx`).
    Added to both.
25. `bbnovix_contract.md` §15 stated `FormsPortal.jsx`'s `blankForm()`/
    `blankMemo()` "still" built references from `Date.now()` "as of Update 4
    Phase 0" — true when written, fixed since (Update 4 work item, this
    update: reference numbers now allocate server-side via
    `generate_number()`). Updated to describe the fix and to clarify that
    the `Date.now()`-based placeholder ids in `useLocalData` demo-mode
    fallbacks across `src/data/*Service.js` are a deliberate, established
    pattern (§9), not a violation of this rule.
26. `bbnovix_deployment.md` had two sections both numbered "## 8." —
    "Scheduling `verification_expire_documents`" and "Extended storage
    credentials" — and its migration table stopped at
    `202608060044_workflow_engine_hardening`, nine migrations behind. Fixed
    the duplicate numbering (renumbered 8→14 through the rest of the
    document, including its own internal `§8`/`§9` cross-references) and
    added table rows for migrations 045 through 053.

**Tests**

27. `src/lib/storage/index.js`'s `sha256Hex()` (storage_objects.checksum's one
    intended source, item 4 above depends on it being correct) had no unit
    test — every existing test either exercises pure logic with no Supabase
    import, or reads migration SQL as text, because `node --test` has no
    bundler or loader to resolve this project's Vite-style extensionless
    imports through a file that touches `window`/Supabase. Split the pure
    hashing logic into `src/lib/storage/checksum.js` (no imports of its own,
    matching `paths.js`'s existing precedent for the same reason) and added
    `tests/storage-checksum.test.mjs` — 4 tests against known SHA-256 vectors
    (`""`, `"abc"`), determinism, and output shape. `index.js` now imports
    and re-exports `sha256Hex` from the new file; its one internal call site
    is unchanged.
28. `listFormAttachments()` (item 13 above) had no test. Its own module,
    `approvalService.js`, cannot be imported under `node --test` at all
    (transitively imports `supabaseClient.js`, which is browser-only by
    design and reached only through extensionless relative imports Node's
    loader can't resolve without a bundler) — confirmed by trying, not
    assumed. Added `tests/approval-attachments-adapter.test.mjs`, which
    verifies the adapter's contract by parsing `approvalService.js`'s own
    source text, the same technique `tests/tenancy-invariants.test.mjs`
    already uses for migration SQL it likewise cannot execute in this
    environment: `listFormAttachments` must be the exact one-line shape
    `(entityType, entityId) => formAttachmentList(entityId)`, its unused
    first parameter must be underscore-prefixed, and `formAttachmentList`
    must still exist with the signature it forwards to.
29. `tests/tenancy-invariants.test.mjs`'s `NOT_TENANT_SCOPED_BY_DESIGN`
    allow-list carried three entries that were verified (by removing each and
    re-running the suite) to no longer do anything: `record_login` — every
    one of its three historical redefinitions already writes an explicit
    `tenant_id` derived from the target user's own row, so the "documented"
    escape hatch was never actually needed; `request_client_ip` and
    `request_user_agent` — neither function is `security definer`, so the
    test's own outer filter (`if (!/security definer/i.test(fn.body))
    continue`) skips them before the allow-list is ever consulted. Removed
    all three. `approval_scheme_set_roles` (item 3's Blocker) was
    **not** removed, despite being the one this sweep initially expected to
    remove: its migration-046 definition, which is immutable history now
    that migration 053 exists, genuinely has zero `tenant_id` reference in
    its body — the entry is still required for that historical occurrence to
    pass. Its reasoning text was rewritten instead, since the old text's
    claim ("carry no tenant_id at all") was already false before this sweep
    and is now additionally misleading about a gap that has since been
    fixed. `node --test` went from 47 to 53 passing tests across items
    27–29, all green.

## Deliberately left, with reason

Nothing found this sweep was left unfixed. Every confirmed problem across all
26 items above has a landed fix — either in migration
`202608060053_pre_assets_zero_debt_sweep`, or in the frontend/i18n/CSS/doc
files named next to it.

## Verification

* **Full migration chain replay from a clean instance** — a brand new,
  isolated local PostgreSQL 17 database, bootstrapped with the minimal
  Supabase stand-in (`auth`/`storage` schemas, `anon`/`authenticated`/
  `service_role` roles), then all 53 migration files applied in filename
  order with `ON_ERROR_STOP=1`: **zero errors, zero warnings, all 53
  files applied.** Post-chain checks: `platform`/`shalfa` tenants present
  and `Active`; `DIGITAL_IDENTITY` present in `platform_modules`; 293
  functions in `public`; **zero** functions still grant `EXECUTE` to
  `PUBLIC` (checked directly via `aclexplode`, not just the migration
  chain's own closing `revoke`).
* **`node --test`** — 53/53 passing (up from 47 at the start of this sweep;
  the 6 new tests are items 27–28 above), re-run after every change in this
  sweep and once more as the final step.
* **`npm run lint`** — clean, re-run as the final step after every change in
  this document.
* **`npm run build`** — clean (production build succeeds), re-run as the
  final step.
* **Browser check** — the dev server's `/shalfa/login` page loads cleanly
  with no console errors, renders the "Digital Workplace Platform" branding
  and all 5 language options. The RTL logical-property conversions (item 22)
  were verified directly against the live stylesheet: an `.auth-message`
  element renders `border-left: 3px` under `dir="ltr"` and
  `border-right: 3px` under `dir="rtl"` — confirming `border-inline-start`
  flips to the correct physical side in both directions, not just one.

## Result

37 confirmed problems from the original discovery pass, 29 distinct fixes
(several findings shared one root cause; 3 more items were added afterward
while closing the Tests deliverable itself), 3 Blockers, 0 deferred. Combined
with the fixes already closed and documented in the phase docs this sweep
re-verified (`docs/update4_phase0_platform_core.md`,
`docs/update4_batch1_platform_core_services.md`,
`docs/update4_batch2_workflow_engine.md`,
`docs/update4_batch3_verification.md`, `docs/update4_digital_identity.md`),
Platform Core, INumberGenerator, Storage, Workflow Engine, Attachments,
Verification Service and Digital Identity have no confirmed open issue as of
this sweep, and every verification step above has been re-run clean as of
2026-08-06. **This phase is Final Closed.**
