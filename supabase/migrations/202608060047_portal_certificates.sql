-- ============================================================================
-- 047 — Batch 3: My Certificates (employee portal)
--
-- Closes the one real gap Global Validation's independent fresh audit found
-- in an otherwise complete, closed Verification Service: PORTAL_CERTIFICATES
-- was registered in migration 202608040018 and parked (is_active=false) by
-- 202608040022 as "employee-facing certificate wallet, planned" — no page
-- existed yet. src/components/verification/PortalCertificates.jsx now exists,
-- reusing loadCertificates()/loadTemplates()/loadTemplateFields() and the
-- CertificatePreview/CertificateCanvas rendering already built for the admin
-- issuing screen — no new RPC, no new table, no second rendering path. The
-- RLS this depends on ("recipients read own certificates",
-- 202608040017:765-774) already scopes an unprivileged caller to
-- recipient_employee_id = auth.uid(), so nothing here needs a schema change.
-- ============================================================================

update public.app_screens
set is_active = true,
    updated_on = now()
where code = 'PORTAL_CERTIFICATES';
