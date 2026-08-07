# Update 4 — Batch 3: Verification Service (closing)

## Why this batch exists

The mandatory execution order (FourthUpdate.md) places Verification right
after Attachments, and forbids starting the next module (Digital Identity)
before the current one is "fully finished, including its architecture
review and documentation." Investigation found Verification Service was
already a complete, working, closed module — built in migration
`202608040017_verification_and_certificates.sql` with full admin UI
(`VerificationCenter.jsx`: Attestations/Certificates/Templates/Settings),
a working anonymous public verify page (`VerifyRequestPage.jsx`), and a
full RPC surface (`verify_document`, `certificate_issue`,
`attestation_create/approve/revoke`, `generate_document_code`,
`verification_expire_documents`) — but it had never gone through the
formal closing cycle (architecture review + documentation) the other
batches got, and had exactly one real, self-documented gap:
`PORTAL_CERTIFICATES` was registered in the screen registry (migration
`202608040018`) and explicitly parked as `is_active=false`, "planned," by
migration `202608040022` — an employee-facing "my certificates" wallet
that never got built.

Batch 3 = close that gap, then formally close the module.

## What was built

`src/components/verification/PortalCertificates.jsx` — a new employee
self-service screen at `/app/certificates` (module `CERTIFICATES`,
registered `PORTAL_CERTIFICATES` route `certificates`). Zero new backend:

- Reuses `loadCertificates({})`/`loadTemplates({activeOnly:true})`/
  `loadTemplateFields(templateId)` from `verificationService.js` unmodified
  — plain `supabase.from().select()` calls, scoped automatically by
  existing RLS (`"recipients read own certificates"`,
  `recipient_employee_id = auth.uid() OR has_permission('Verification.View')`,
  migration `202608040017:765-774`).
- Reuses `CertificatePreview` (the print/preview modal) and
  `CertificateCanvas` (the field-composition renderer), both already
  built for the admin issuing screen — `CertificatePreview` was changed
  from a local `const` to an `export const` in `CertificatesScreen.jsx` so
  both screens share one rendering implementation, matching the pattern
  already established for `CertificateCanvas`.
- `src/App.jsx`: lazy route, same wrapper nesting as every sibling portal
  route (`ProtectedPage > ModulePage > PageErrorBoundary > LazyPage`).
- `src/components/AppShell.jsx`: added the one missing icon mapping
  (`award: Award`) the registry row already specified.
- `supabase/migrations/202608060047_portal_certificates.sql`: a single
  `UPDATE ... SET is_active = true WHERE code = 'PORTAL_CERTIFICATES'`
  (`code` is the table's primary key — cannot affect any other row).
- `src/i18n/modules/verification.js`: 4 new keys
  (`portal_cert_title/intro/empty/empty_hint`) in all 5 languages.

No new RPC, no new table, no new permission, no duplicate rendering path.

## First review (small-scope, superseded below)

An independent fresh-eyes review of just the new files (diffing against
git HEAD) found zero issues, plus one minor gap (`loadTemplates()`'s error
silently swallowed) fixed in the same pass. This review was scoped to the
new PortalCertificates work only — it did **not** cover the rest of the
already-existing module, which is what the closing audit below actually
did, at the user's explicit request, before allowing the module to be
called done.

## Closing audit (whole module, every file, no exceptions)

A dedicated final audit — 6 independent review lenses (dead code & reuse,
security/RLS/permissions, database/API, React correctness & performance,
UX/accessibility/i18n, architecture/contract/documentation) covering every
SQL and frontend file Verification Service owns, followed by an
adversarial verify pass on every finding — found **23 raw findings, 22
confirmed, 1 refuted**. Of the 22 confirmed, 21 were genuinely inside
Verification Service's own ownership (2 of those 21 described the same
underlying defect from two different lenses, so **20 distinct real
problems**); 1 was correctly identified as belonging to a different
module (Audience Engine — `bbnovix_contract.md` §10/§4 claims
`AudiencePicker` is wired into certificate templates; it factually isn't,
but that's an Audience Engine integration gap, not this module's).

**All 20 distinct in-scope problems were fixed**, migration
`202608060048_verification_closing_audit.sql` plus frontend changes in the
same commit. No new features were added; no refactor beyond what each fix
itself required.

**Two real security Blockers, closed:**
1. `verifiable_documents`' "verification managers manage documents" RLS
   policy was `FOR ALL` on nothing but `has_permission('Verification.Manage')`
   — enforcing none of `attestation_create()`'s validation and permitting
   hard deletes. Every legitimate write already goes through the RPCs
   (SECURITY DEFINER writes don't need RLS grants); downgraded to
   `SELECT`-only. Verified live: a direct forged INSERT that would have
   created a fake "Active" HR document now fails with
   `new row violates row-level security policy`.
2. **Self-inflicted this batch**: `PortalCertificates.jsx` never imported
   `verification.css`. The lazy chunk still builds and boots — nothing
   throws — but the certificate canvas's positioning rules (`.vf-canvas-*`)
   live only in that stylesheet, so the one screen this whole batch exists
   to ship would have rendered visually broken (fields stacked in plain
   document flow instead of composited on the certificate background) for
   its only realistic audience — every employee without admin access, who
   would never have already loaded the admin Verification Center's CSS.
   Fixed with the missing import; verified two ways: (a) an initial raw
   `import()` test gave a false negative (it bypasses Vite's real
   `__vite__mapDeps` preload mechanism, which lives in the *caller*, not
   the target chunk) — caught and corrected before trusting it; (b) traced
   the actual built `index-*.js`'s `__vite__mapDeps` array and confirmed
   `verification-Bvy1pkFZ.css` is index 33 of `PortalCertificates`'s own
   dependency list, exactly the mechanism that makes the real
   `React.lazy()` load correctly.

**Other Majors, closed:** a second RLS gap (`certificates`/
`certificate_batches` similarly bypassable, bypassing `certificate_issue()`'s
quota/module/template-active checks); `attestation_revoke()` missing the
doc_type guard its sibling `attestation_approve()` already had (let
Verification.Manage escalate into Certificates.Manage's and the approval
engine's territory); `verify_document()` disclosing a Rejected/
InApproval/Revoked request's full approval timeline (reviewer names,
roles, actions) to anonymous callers despite `valid:false` — the same
defect class migration 035 already fixed for the sibling
`approval_verify()`; two missing indexes for the module's two main list
screens' actual query shape (contract §17); `saveTemplateFields()`'s
non-atomic delete+insert-loop (contract §18) replaced by one atomic RPC
(`certificate_template_fields_set()`), which also fixes the real bug it
caused — a newly-added template field's id never made it back into local
state, so a second save duplicated it; a certificate preview falling back
to the *wrong* template (or a blank one) once the certificate's real
template was deactivated, which also silently hid the entire admin
certificate list once every template in use had been deactivated (same
root cause: the lists were loaded `activeOnly`, fixed by loading every
template and filtering only the issuing picker); missing pagination
(contract §17) on the module's two capped-at-300 list screens, now with a
"Load more" control on both plus the new portal screen;
`verification_expire_documents()` never actually scheduled anywhere —
documented in `docs/bbnovix_deployment.md` §8 with the exact `pg_cron`
statement to run, mirroring the send-email worker's already-established
pattern (this one needs no edge function/service key, just `select
public.verification_expire_documents();` on a cron).

**Minors/Informational, closed:** a stale-response race in
`VerifyRequestPage.jsx` (request sequencing added); a duplicated
screen-reader announcement on the same page; 4 modal dialogs across the
module missing focus-trap/Escape handling (now matching the
`EventDialog.jsx`/`AttachmentsPanel.jsx` pattern already established
elsewhere); `PortalCertificates.jsx`'s error notice missing
`aria-live`/dismiss (now matching every sibling notice in the module); a
dead exported constant (`DOC_TYPES`); 11 dead i18n keys (55 lines across 5
languages — a mix of pre-existing cruft and leftovers of two abandoned
designer UI fields); duplicate `openPreview()` glue logic between
`CertificatesScreen.jsx` and `PortalCertificates.jsx` (extracted to one
shared `resolveCertificatePreview()` in `verificationService.js`).

## Verification (live, not just reasoned about)

- Full migration chain (001→048, 48 files) reapplied from scratch on a
  freshly rebuilt isolated PostgreSQL 17 instance — zero errors, twice
  (once before the closing audit's fixes, once after).
- While verifying, found and fixed a genuine gap in the local test harness
  itself (not a product bug): `bootstrap.sql` never granted
  `authenticated`/`anon` table-level privileges the way a real Supabase
  project does automatically, so a direct `.from().select()` read failed
  with a misleading "permission denied for table X" unrelated to RLS.
  Confirmed this affected even long-working tables like `forms`
  identically before the fix. Re-ran the full existing regression suite
  afterward with identical, all-expected results — confirming RLS is the
  real access boundary, not the grant.
- 7 targeted functional tests for the closing audit's fixes, all passing:
  legitimate attestation create→approve still works end to end; a direct
  forged `verifiable_documents` insert is now blocked by RLS;
  `attestation_revoke()` now rejects a Certificate-type document;
  `verify_document()` returns an empty timeline for a Rejected form;
  `certificate_template_fields_set()` replaces a layout atomically and a
  second save with the real returned id updates in place rather than
  duplicating; the same RPC rejects a caller without `Certificates.Manage`;
  both new indexes exist.
- Full existing regression suite (Batch 2 functional tests, attachment
  tests, security tests, number-generator regression, the earlier
  PortalCertificates RLS test) re-run against the fully-fixed database —
  identical, all-expected results, no regressions.
- `node --test tests/*.test.mjs`: 47/47.
- `npm run lint`: clean (caught and fixed two issues introduced while
  writing the fixes themselves: a `setState`-in-effect warning, and a
  Fast-Refresh violation from exporting a non-component helper alongside
  components — both fixed before this was called done, not after).
- `npm run build`: succeeds. `PortalCertificates` builds as its own
  lazy-loaded chunk with `verification.css` correctly wired into its
  dependency graph (see the CSS Blocker above for how this was verified).
- Browser: dev server and a full production (`vite preview`) build both
  boot clean, zero console errors. Full interactive verification (login,
  viewing a real certificate) wasn't possible — no credentials for the
  real hosted Supabase backend, same disclosed limitation as Global
  Validation's Browser check.

## Deferred / out of scope

One finding — `bbnovix_contract.md` §10/§4 documents `AudiencePicker` as
wired into certificate templates when it factually isn't — is a real,
confirmed doc/code mismatch, but the gap itself belongs to Audience
Engine's own integration surface, not Verification Service. Not fixed
here; noted for whoever next touches Audience Engine or does that
module's own closing audit.

## Status

**Verification Service: FINAL CLOSED.** Every confirmed in-scope problem
— including 2 real security Blockers — is fixed and live-verified; zero
deferred within the module's own scope. Digital Identity may now start
per the mandatory execution order.
