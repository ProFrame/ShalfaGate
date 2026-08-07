# Update 4 — Digital Identity (Digital Business Card) — 2026-08-06

## Why this module exists

FourthUpdate.md's mandatory order puts Digital Identity immediately after
Verification Service (Final Closed, `docs/update4_batch3_verification.md`).
The spec (FourthUpdate.md lines ~298-436): every employee gets a shareable
digital business card — a public link + QR code carrying their contact
details, company branding, and an owner-controlled visibility/field-privacy
model — plus an HTML/image email-signature builder driven by the same card
data (no second source of truth).

## What was built

- `public.employee_cards` — one row per employee, created lazily on first
  access (never provisioned in bulk).
- RPCs: `generate_card_code()`, `card_get_mine()`, `card_save_settings()`,
  `card_public_view()`, `card_track_event()`.
- Self-service: `src/components/identity/IdentityCenter.jsx` — two tabs,
  "My Card" (`MyCardScreen.jsx`) and "Email Signature"
  (`EmailSignatureScreen.jsx`), at `/app/card/:section?`
  (`PORTAL_IDENTITY` registry row, `card` reserved slug).
- Public: `src/components/PublicCardPage.jsx` at `/card/:code?` — anonymous,
  no auth required, sole data source is `card_public_view()`.
- Shared renderer: `src/components/identity/BusinessCard.jsx` — the one
  card-rendering implementation, used by both the owner's live-editing
  preview and the public page (no second implementation).
- `src/data/digitalIdentityService.js`, `src/i18n/modules/identity.js`
  (5 languages), `src/components/identity/identity.css`.

## 1. Architecture

Digital Identity is a business module, not a shared platform service — it
owns `employee_cards` and its five RPCs outright and appears in nobody
else's ownership table. It reuses, rather than reimplements, four existing
platform capabilities (bbnovix_contract.md §12):

- `generate_number('ID', tenant)` — the card's human-readable reference
  (`card_no`).
- `generate_verify_code()`'s random `SLUG-{12 digits}` shape, wrapped the
  same way `generate_document_code()` wraps it for `verifiable_documents` —
  called internally, uniqueness checked against `employee_cards` itself, not
  `forms.verify_code`.
- `src/components/platform/EntityQrCode.jsx` — the card's QR, never a
  second `qrcode.react` wrapper.
- `public.is_tenant_member()` — the `CompanyOnly` visibility check.

Deliberately **not** reused: Activity Timeline. `record_activity()`'s "who
did this" actor model doesn't fit "an anonymous stranger opened your card" —
the spec's analytics requirement (opens / vCard downloads / website clicks /
calls / emails) is a set of counts, not a narrative feed, so it's four
counter columns on `employee_cards` incremented by `card_track_event()`
instead. Documented in migration 049's own header so a future auditor sees
the reasoning, not just the absence.

## 2. ERD

```
tenants ──┐
          │ tenant_id (FK, cascade)
users ────┼──> employee_cards ──> (no children — leaf table)
  │       │
  │ tenant_id, id (composite FK: fk_employee_cards_user_same_tenant)
  └───────┘
```

`employee_cards` also reads (never writes) `departments` / `sites` /
`projects` (via `users.department_id` etc.) and `tenant_branding` /
`tenant_names` for company display data — all read-only joins inside the
RPCs, no new FKs to those tables.

## 3. Database

- `employee_cards`: `tenant_id`, `user_id`, `card_no`, `public_code`,
  `visibility` (Private/CompanyOnly/Public), `template_code`
  (Classic/Modern/Minimal/Bold), `theme` (Light/Dark), `shape`
  (Rounded/Square), `show_logo`, `show_photo`, `linkedin_url`,
  `extension_phone`, `field_visibility` (jsonb, missing key = visible),
  5 analytics counters, standard soft-delete/audit columns.
- Indexes (as of migration 050 — see the closing-audit fixes below):
  `uq_employee_cards_user` unique on `(tenant_id, user_id)`,
  `uq_employee_cards_public_code_lower` unique functional index on
  `lower(public_code)`, `idx_employee_cards_tenant` on `tenant_id`.
- RLS: `"tenant isolation"` (restrictive, `FOR ALL`) plus exactly one
  narrow policy, `"owners read own card"` (`FOR SELECT`, own row only). No
  INSERT/UPDATE/DELETE policy exists at all — every write goes through the
  two SECURITY DEFINER RPCs below, which don't need table grants to do
  their own job (the lesson carried over from Verification's own closing
  audit: a permissive `FOR ALL` policy alongside a validated write RPC is
  how a forgery Blocker happens).
- Triggers: `apply_row_defaults`, `write_audit_log` (explicit — new tables
  don't inherit the Global Validation retrofit automatically).

## 4. API

| RPC | Auth | Purpose |
| --- | --- | --- |
| `generate_card_code(uuid)` | authenticated | internal only, never called directly from the client |
| `card_get_mine()` | authenticated | self only; creates the row on first access (race-safe as of migration 050) |
| `card_save_settings(jsonb)` | authenticated | self only; validates visibility/template/theme/shape/linkedin_url server-side |
| `card_public_view(text)` | anon, authenticated | the code is the credential; visibility- and per-field-gated (both gates hardened in migration 050) |
| `card_track_event(text, text)` | anon, authenticated | increments one of 4 counters; now visibility-gated the same way as `card_public_view()` (migration 050) |

## 5. Permissions

No new permission code — self-service only (same model as the existing
`Profile.Update` self-edit flow: no employee-id parameter exists anywhere
in the write path to target another user's card). `PORTAL_IDENTITY`'s
`min_role_rank` is 1 (every authenticated employee).

## 6. Workflow

None — this module has no approval/workflow surface.

## 7. Storage

None — avatars reuse `users.avatar_url` / the existing `employee-assets`
bucket directly; company logos reuse `tenant_branding`. No new storage
bucket, no `attachment_attach()` usage (the card photo isn't a
generic attachment).

## Closing audit (whole module, every file, no exceptions)

Same process as Verification Service's own closing audit: 6 independent
review lenses (dead code/reuse, security/RLS/permissions, database/API,
React correctness/performance, UX/accessibility/i18n, architecture/contract/
docs) across every file the module owns, then an adversarial verify pass on
every raw finding (re-read the live code, try to refute, judge in-scope vs.
out-of-scope).

- 35 raw findings, 34 confirmed, 1 refuted (a claimed request-race in
  `MyCardScreen.jsx`'s `patch()` — refuted because every control capable of
  calling `patch()` is already `disabled={saving}`, so a second call can
  never be in flight concurrently).
- 33 confirmed findings were in-scope (fixed, migration 202608060050 +
  frontend edits below); 1 (the `bbnovix_contract.md` §12 stale-row finding)
  was correctly ruled out-of-scope by the audit itself, since the contract
  file was explicitly marked reference-only for that audit — fixed anyway
  as routine documentation upkeep, not counted against the module's own
  in-scope total.

**Two Blockers, both in `card_public_view()`:**

1. SQL three-valued-logic NULL propagation: for an anonymous caller
   (`auth.uid()` is `NULL`), `auth.uid() = user_id` and `NULL OR false`
   both evaluate to `NULL`, not `false`. `if not v_allowed` skips the
   branch on `NULL` exactly like it does on `false`, so **Private and
   CompanyOnly cards were returned in full to any anonymous visitor**, not
   denied. Fixed by wrapping the whole visibility `CASE` in
   `coalesce(..., false)`.
2. Per-field visibility only stripped the exact toggled key
   (`department_ar` / `site_ar` / `project_ar` — the only keys the UI ever
   writes) and left the paired `_en` column untouched, so turning off
   "Department" never actually hid it — it leaked back through
   `department_en` regardless of viewing language. Fixed by also stripping
   the `_en` counterpart whenever its `_ar` twin is hidden.

**A third Blocker**, unrelated to the RPC: `EmailSignatureScreen.jsx`'s
`buildSignatureHtml()` interpolated HR-managed profile fields (name, title,
company, mobile, email, avatar URL) into a raw HTML string with zero
escaping, then rendered it via the codebase's only `dangerouslySetInnerHTML`
— a stored-XSS sink reachable by anyone who can set an employee's own
`job_title`/`full_name` (an admin, or a poisoned CSV import), executing in
that employee's own authenticated session the instant they open Email
Signature, and propagating into any real outgoing signature via Copy/
Download HTML. Fixed with a dedicated `escapeHtml()` applied to every
interpolated value.

**Majors:** `linkedin_url` rendered as a raw unvalidated `<a href>` with no
server-side scheme check (a `javascript:` URI stored-XSS vector — fixed
with both a server-side `https://`-only validation in
`card_save_settings()` and a defensive scheme check in `BusinessCard.jsx`);
the tenant brand color (`company.primary_color`, already fetched by both
RPCs for exactly this purpose) was never wired to the Modern/Bold
templates' `--di-color` CSS variable; `uq_employee_cards_user` was unique on
`user_id` alone instead of `(tenant_id, user_id)`, breaking card creation
for a genuine multi-tenant member's second company (rescoped to match the
established `tenant_memberships` convention — the residual case where a
member's *active* tenant differs from their *home* `users.tenant_id` still
meets the pre-existing, platform-wide `fk_*_same_tenant` pattern used by a
dozen other tables since migration 202608040012; redesigning that pattern
is out of this module's scope, documented in migration 050's own comment,
not fixed here); `card_track_event()` had no visibility gate at all,
letting a code observed while a card was briefly Public keep inflating
analytics after the owner switched to Private/CompanyOnly (fixed — mirrors
`card_public_view()`'s gate now); the absolutely-positioned QR badge shared
the avatar's corner and fully covered the employee's photo whenever both a
logo and a photo were shown (moved to the opposite corner with reserved
padding); the field-visibility checkboxes and template/theme/shape/
signature-size swatches had no accessible name/state (`<label>` wrapping
and `aria-pressed` added); the QR code's SVG had no accessible name on the
card itself (title added, mirroring Verification's own `VerificationQr`
precedent); `MyCardScreen.jsx`'s `patch()` never rolled back a failed save,
leaving unsaved LinkedIn/extension-phone edits on screen looking saved
(fixed — reloads confirmed server state on error); `uq_employee_cards_public_code`
was a plain (case-sensitive) index while every lookup filters on
`lower(public_code)`, forcing a full sequential scan on every public
QR-scan/shared-link/vCard-download request (replaced with a functional
unique index on `lower(public_code)`, mirroring the same fix already
applied to `verifiable_documents.code`).

**Minors/Informational:** duplicated Blob/anchor VCF-download logic across
two screens (centralized into `digitalIdentityService.js`'s
`downloadVcfFile()`); a hand-rolled, differently-truncated company-name
fallback chain in three places instead of the existing `pickFromMap()`
helper (all three now use it); `card_get_mine()`'s SELECT-then-INSERT first
-access race surfaced a raw `unique_violation` to the losing concurrent call
(now caught, re-selects the winner's row); a translated copy-link success
string (`di_share_link_copied`) that was never rendered (now swaps the
button's visible text); a dead `.di-signature-table` CSS rule (removed);
the tablist on `IdentityCenter.jsx` had no `aria-label` (added); the
company website was never shown on the card itself, only as a separate
public-page button (added to `BusinessCard.jsx`'s field list, the
now-redundant separate button on `PublicCardPage.jsx` removed);
`card_no` was returned by the RPC but never displayed anywhere (added a
"Card reference" line to My Card); a stale JSDoc comment referencing a
nonexistent `fieldVisibility` prop (reworded to match the actual
`card.field_visibility` mechanism); this phase doc itself didn't exist yet
(written now).

## Verification (live, not just reasoned about)

- Fresh Postgres 17 database, full migration chain replayed from scratch
  through 202608060050 — zero errors.
- Functional test suite (12 scenarios covering visibility branches,
  per-field redaction, tenant isolation, cross-employee read/write denial,
  analytics counters, race-safe first access) — all passing against the
  fixed RPCs.
- `node --test` — full existing regression suite green, including
  `tenancy-invariants.test.mjs`'s two automated guard tests (the
  `card_track_event`/`card_public_view` anon-callable and
  not-tenant-scoped-by-design exemptions already recorded there from the
  original build remain accurate — no new exemption needed for this
  migration's changes, since the fixed functions kept the same signatures
  and grants).
- Lint — clean.
- Build — clean; `IdentityCenter`/`PublicCardPage` lazy chunks confirmed
  wired to `identity-*.css` via the `__vite__mapDeps` method (the
  false-negative lesson from Verification's own audit).
- Browser — dev server, zero console errors on My Card / Email Signature /
  public card page; QR-avatar layout collision confirmed resolved via
  `getBoundingClientRect()` on both elements, LTR and RTL.

## Deferred / out of scope

- The pre-existing `fk_*_same_tenant` foreign-key pattern's interaction with
  `switch_tenant()` (a user's *active* tenant can differ from their *home*
  `users.tenant_id`) is a platform-wide characteristic spanning a dozen
  tables since migration 202608040012 — not introduced by, or fixable
  within, this module. Documented in migration 050's own comment.
- `attachment_attach()`'s missing entity-relationship check (Global
  Validation, still open) — Digital Identity doesn't call it at all, so
  it's unaffected either way.

## Status

**Digital Identity: FINAL CLOSED.**
