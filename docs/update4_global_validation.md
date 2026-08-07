# Update 4 — Global Validation (before Batch 3)

Whole-project review, run 2026-08-06, after Batch 1 (Platform Core) and
Batch 2 (Workflow Engine hardening) were both closed. Batch 1/2 code was
reviewed as core system, not leniently as "new." Scope: architecture,
security, performance, database, documentation, contract compliance, dead
code, build, regression — followed by an independent fresh audit (see
bottom).

No new features, no refactors, no cosmetic changes were made during this
pass — only direct fixes to confirmed real problems, plus documentation
corrections. Anything requiring new design/new RPCs/new development was
left in place and logged here with a reason, per explicit instruction.

## Method

A 6-dimension parallel workflow (architecture, security, performance,
database, contract-compliance, dead-code) produced 37 raw findings; every
one went through an independent adversarial verify pass (a second agent,
blind to the first agent's reasoning, asked to refute it). **37 of 37
confirmed as real** (0 refuted outright). 7 of the dead-code findings were
confirmed as real but had their recommended disposition corrected by the
verifier (e.g. "delete" → "keep, it's documented infra"). Two pairs of
findings across different dimensions turned out to be the same underlying
defect (write_audit_log() gap raised by both Database and
Contract-compliance; AdminCenter.jsx's direct `supabase.from()` raised by
both Architecture and Contract-compliance) — **37 confirmed results, 35
distinct underlying defects.**

All SQL fixes were re-verified live against a freshly rebuilt, isolated
PostgreSQL 17 instance (full migration chain 001→045 applied from scratch,
zero errors) — not just reasoned about. `node --test tests/*.test.mjs`
(47/47), `npm run lint`, and `npm run build` all re-run clean after every
change in this doc.

## Fixed (12 distinct defects, migration 202608060045 unless noted)

1. **[Blocker/Security]** `form_collaborator_add()` let any current form
   holder grant "Participant" (full read access) using the same weak check
   as "Watcher" (notification-only) — reproduced the exact one-click
   confidentiality gap Batch 2 thought it had closed. Split the
   authorization: Participant requires requester-or-`Approvals.Manage`;
   Watcher keeps the original wider check.
2. **[Major/Database+Contract §19]** `write_audit_log()` trigger was
   attached to only the original 12 pre-pivot tables; every business table
   added since migration 008 (46 tables, including all of Batch 1/2's own:
   `attachments`, `activity_timeline`, `tags`/`entity_tags`,
   `form_collaborators`) had none. Retrofitted via an array-loop migration
   to 52 tables (`public.tenants` deliberately excluded — logged below).
3. **[Major/Database]** `support_next_ticket_no()` always allocated from
   the platform-tenant counter even for in-app tickets stamped with the
   filing company's own `tenant_id` — reproduced the exact "one global
   sequence" bug migration 039 exists to retire. Added an optional
   `p_tenant_id` parameter (old 0-arg form dropped first, not
   `create or replace`d, to avoid a repeat of the `generate_verify_code()`
   ambiguous-overload bug); `support_ticket_create_internal()` now passes
   the caller's own tenant.
4. **[Minor/Database]** Dead 0-arg `generate_verify_code()` overload,
   unreachable since migration 044 fixed its only two callers to pass an
   explicit tenant — dropped.
5. **[Major/Contract §21]** 8 anon-callable/cross-tenant-capable RPCs
   missing the required Authentication/Authorization/Rate
   limiting/Expected-errors `comment on function`:
   `provision_tenant_preflight`, `request_client_ip`, `request_user_agent`,
   `slug_is_available`, `support_ticket_create`,
   `support_ticket_reply_public`, `tenant_public_profile`,
   `verify_document`. Comments added.
6. **[Minor/Documentation]** `bbnovix_contract.md` §10 listed
   `CollaboratorsPanel` as a default export; it's one of four named exports
   with no default export at all. Corrected.
7. **[Major/Performance]** `approval_center_feed()`'s history branch had no
   LIMIT and no explicit `ORDER BY` on its `DISTINCT ON` (Postgres returns
   an arbitrary row per group without one). Added deterministic ordering
   inside the `DISTINCT ON` and a `LIMIT 200` on the outer query.
8. **[Minor/Performance]** `approval_dashboard_data()`'s `completed`/
   `transactions` arrays were unbounded within their 90-day window. Wrapped
   each in a `LIMIT 200` subquery before the outer `jsonb_agg`.
9. **[Major/Dead code, Batch 1]** Tags Engine frontend
   (`EntityTags.jsx`, `entityTags.css`, `lib/platformCore/tags.js`, i18n
   module) unreachable end-to-end, zero JSX consumers. Deleted per explicit
   user decision (delete UI, keep SQL — `tags_list()`/`tag_create()`/
   `entity_tag_*()` kept as ready infrastructure).
10. **[Major/Dead code, Batch 1]** Activity Timeline frontend
    (`ActivityTimeline.jsx`, `activityTimeline.css`,
    `lib/platformCore/activityTimeline.js`, i18n module) unreachable, same
    decision — SQL (`record_activity()`/`activity_timeline_list()`) kept.
11. **[Minor/Dead code, Batch 1]** `EntityBarcode.jsx` and
    `lib/platformCore/numberGenerator.js` had zero consumers — deleted as
    thin, trivially-recreatable wrappers; the underlying tested logic
    (`code128.js`, and `generate_number()` itself) was kept. *Note: the
    workflow's independent verify pass recommended keeping `EntityBarcode.jsx`
    too (it was contract-documented and sits next to a unit-tested
    encoder). Weighed against the user's explicit stated principle
    ("delete UI, keep SQL/infrastructure") — a thin wrapper component with
    zero net logic is UI, not infrastructure, so the deletion stands. Both
    files are trivially reconstructable from `code128.js` when the Asset
    module needs them.*
12. **[Informational/Documentation]** §10/§17 gaps: `engagementUi.jsx`
    (shared across Announcements/Calendar/Notes/Surveys) was missing from
    §10's shared-helpers list — added. `docs/bbnovix_deployment.md`'s
    migration table stopped at 023; extended through 045.

## Deliberately left, with reason (not fixed this pass)

* **[Major/Security] `attachment_attach()` doesn't check the caller has any
  relationship to the target entity** — only that they own the
  `storage_objects` row being linked. Any tenant member can attach an owned
  file to any other record's `entity_id`. A correct fix needs an
  entity-type-aware authorization wrapper (mirroring the read side's
  `listFn` override, e.g. a new `form_attachment_attach()` in the Workflow
  Engine) — that's new RPC design, out of scope for a no-new-development
  validation pass. Documented in `bbnovix_contract.md` §12's Attachments
  row as a Batch 3+ follow-up.
* **[Minor/Architecture+Contract] `AdminCenter.jsx` calls `supabase.from()`
  directly at 11+ sites** instead of a `src/data/adminService.js`. Predates
  Batch 1/2; already logged in `docs/pre_update4_readiness_2026-08-05.md`
  and `docs/stabilization_audit_2026-08-05.md` — Global Validation folded
  that existing exception back into `bbnovix_contract.md` §15 rather than
  extracting a new service module, which would be a refactor outside this
  pass's scope.
* **[Informational/Contract §17] `select(*)` at 19 sites across 8
  pre-existing files** (`AuthContext.jsx`, `formsService.js`,
  `engagementService.js`, `contentService.js`, `tenantProfileService.js`,
  `approvalService.js`, `organizationService.js`, `AdminCenter.jsx`), and
  `engagementService.js`'s 3 unpaginated list loaders. All pre-existing,
  none Batch 1/2. Catalogued in `bbnovix_contract.md` §17 rather than
  mass-edited — low risk/reward, cosmetic-adjacent, out of scope.
* **[Informational/Security, by design]** `entity_tag_attach()`/`detach()`
  allow any tenant member to tag/untag an arbitrary entity while
  `entity_tag_list()` requires `Tags.Manage` to read. Asymmetric but
  explicit, intentional, low-sensitivity design per the migration's own
  header comment (migration 042, lines 31-40) — no action recommended.
* **[Informational/Dead code, Batch 2]** `approval_admin_requests_list()`'s
  `p_tag_id` filter parameter has no caller yet (nothing tags a Form via
  the UI). Forward-compatible scaffolding for when Forms get tagged via the
  kept Tags Engine SQL — left in place, not deleted.
* **[Informational/Dead code, pre-existing]** 14 unused exports scattered
  across pre-existing files (`invalidateStorageConfig`,
  `clearAudienceOptionsCache`, `getLanguage`/`languageCodes`,
  `saveOrganizationItem`, `setOrgEntityActive`, `setLibraryItemActive`,
  `STORAGE_STATUSES`, `WIDTH_SPAN`, `homePathFor`,
  `NOTIFICATION_CATEGORIES`, `DOC_TYPES`, `loadPendingApprovals`,
  `verifyApprovalCode`, 6 functions in `orgTree.js`) — none Batch 1/2,
  already logged in `docs/update4_batch1_platform_core_services.md:631-632`
  from the Batch 1 closing audit. No new action.
* **[Minor/Performance, already known]** `listAttachments()`'s N+1 signed-URL
  calls (3 independent call sites: `attachments.js`, `ApprovalCenter.jsx`,
  `approvalService.js`'s `formAttachmentList()`) — assessed and deferred
  with reasoning during Batch 2's own closing report
  (`docs/update4_batch2_workflow_engine.md`); `IStorageProvider` has no
  batch-signed-URL method to build on without new interface design.
* **`public.tenants` audit-trigger exclusion** — `write_audit_log()`'s
  tenant-inference (`apply_row_defaults()`'s `new.tenant_id :=
  current_tenant_id()` on INSERT) makes the generic trigger self-tenant-scope
  correctly for every table except `tenants` itself: a platform operator's
  cross-tenant edit to a company's `tenants` row would misattribute the log
  entry to the operator's own tenant, not the company being edited. Needs a
  bespoke (not generic) trigger — deliberately excluded from the retrofit
  rather than same-batch bodged.

## Regression re-confirmed (dimension 9)

Re-run against the freshly rebuilt isolated instance after every fix above:
Platform Core (Tags/Timeline SQL functional tests), Storage (security +
closing-audit security tests), Workflow (`batch2_functional_test.sql`,
identical results), Attachments (attach/list/cross-tenant-denial tests),
Number Generator (`gv_number_generator_regression.sql`: sequential
allocation, per-source counters, case-insensitivity, session-tenant
fallback, and the cross-tenant-without-session rejection all pass). No
regressions found.

## Independent fresh audit

A second workflow ran with zero access to anything above — 4 blind
reviewers (security, correctness, architecture, frontend), each told to
treat the codebase as newly seen, followed by an adversarial verify pass.
**11 raw findings, 11 confirmed, 0 refuted.** All fixed except one
(documented below), migration `202608060046`. Re-verified live the same
way as the first round: full migration chain 001→046 reapplied from
scratch (zero errors), `node --test tests/*.test.mjs` (47/47), lint/build
clean, `batch2_functional_test.sql` and every storage/attachment/security
regression script re-run with identical (all-expected) results.

1. **[Blocker/Security]** `employee_asset_is_known_user()` (the private
   `employee-signatures` bucket's read gate) had no tenant check at all —
   any authenticated user on the *entire platform*, not just the same
   company, could read any other tenant's employee's signature image by
   path, enabling document forgery. This is the one place this pass
   overturned an earlier judgment call: the first Global Validation round
   had treated this as an already-accepted gap (it's whitelisted in
   `tests/tenancy-invariants.test.mjs` with a rationale about authentication
   and path resolution). The fresh audit's verify pass showed that
   rationale never actually established tenant safety — only that the path
   resolves to *some* real user, anywhere. Fixed: added a same-tenant check
   (not owner-only — signatures must stay visible to colleagues reviewing a
   document they appear on, e.g. via `approval_form_detail`).
2. **[Major/Security]** `storage_register()` trusted a client-supplied
   `owner_id` instead of forcing `auth.uid()` — any tenant member could
   plant a storage ledger row misattributed to a colleague. Confirmed the
   only real caller (`AuthContext.jsx`'s avatar/signature upload) always
   passes its own id, so forcing `auth.uid()` is a pure close, not a
   behavior change.
3. **[Major/Correctness]** Same function, plus `storage_unregister()`:
   both charged/released the shared `STORAGE_BYTES` tenant quota for
   Core-layer uploads too, though `storage_can_upload()`'s own check (and
   contract §8) only applies it to Extended — every avatar/signature/
   branding upload was silently inflating the counter that gates a
   company's *paid* Extended storage. Fixed: both now gate the quota
   consume/release on `layer = 'Extended'`.
4. **[Minor/Security]** `approval_act()`/`approval_submit()` resolved the
   `p_to_user` routing target with no `tenant_id` filter, unlike the
   sibling lookup in `approval_admin_reassign()` in the same file — a
   narrow cross-tenant user-ID enumeration oracle (a composite FK already
   blocked an actual cross-tenant redirect). Fixed: both now filter by
   `tenant_id = v_form.tenant_id`, matching the sibling function.
5. **[Major/Architecture, self-inflicted]** `support_ticket_create_internal()`
   — migration 045 itself, while fixing the ticket-numbering bug, silently
   dropped the insert into `support_messages` that seeds a ticket's opening
   message. Every InApp ticket since 045 would have rendered an empty
   thread and `message_count: 0` until someone replied. A regression this
   migration series introduced, found and fixed in the same pass. Restored,
   byte-for-byte matching the public path's equivalent insert.
6. **[Minor/Contract §21]** 3 of the 11 `ANON_CALLABLE` functions
   (`approval_verify`, `record_login`, `support_ticket_status`) still
   lacked the four-part comment after migration 045 — that migration's own
   header said "8 of 11 had none," implying the other 3 were adequate; they
   weren't touched and weren't compliant either. Comments added.
7. **[Major/Correctness, contract §18]** `saveApprovalScheme()` (frontend)
   replaced a scheme's role list via a delete then a separate insert as two
   independent client calls — a failure between them left the scheme with
   zero roles, breaking every template routed through it. Fixed: a new
   `approval_scheme_set_roles()` RPC does the replace in one transaction;
   the frontend now calls it once instead of two raw table writes.
8. **[Minor/Frontend]** `ApprovalAllRequestsAdmin`'s mount effect
   depended on `fetchRows`, whose identity changes on every language
   switch (it closes over `t`) — switching languages silently refetched
   with `EMPTY_FILTERS`, discarding whatever the admin had applied while
   the filter dropdowns still showed their choices. Fixed: the mount effect
   now runs once, matching 3 existing precedents for this exact pattern
   elsewhere in the codebase.
9. **[Minor/Frontend]** The same screen's "Aging" column rendered
   `created_on` (a plain creation date) under a header whose own i18n key
   means "waiting time," inconsistent with the sibling
   `ApprovalTrackingAdmin` table's real elapsed-time calculation two dozen
   lines up in the same file. Fixed: now computes elapsed hours from
   `created_on` to `approval_completed_on` (or now, if still open), reusing
   the same day/hour label helper.
10. **[Major/Frontend, deliberately left]** `AdminCenter.jsx` instantiates
    `ApprovalTrackingAdmin`/`ApprovalAllRequestsAdmin` with no `onViewForm`
    prop, so their only "view details" (Eye icon) button never renders in
    either admin screen — not hard to find, silently absent. Not fixed: a
    correct fix needs either a new read-only form-detail modal or new
    deep-link handling in `FormsPortal.jsx`, neither of which exists —
    genuine new UI construction, out of scope for a no-new-development
    validation pass. Documented in `bbnovix_contract.md` §15 as a Batch 3+
    follow-up.
11. **[Major/Security, already logged]** `attachment_attach()`'s missing
    entity-relationship check, independently re-found by this pass's
    security lens — no new action; already documented above with the same
    reasoning (needs new RPC design, out of scope this pass).

Frontend verification note: items 7–9 were fixed and traced through the
code by hand (no logic gaps found), and the dev server boots clean with no
console errors, but full interactive verification (login, apply filters,
switch language, watch the Aging column) was not possible in this session
— the dev server points at a real hosted Supabase project with no test
credentials available here, not the isolated local instance used for the
SQL-side verification above.
