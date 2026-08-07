-- ============================================================================
-- 051 — "Digital Workplace Platform" rebrand of the EMPLOYEE_PORTAL module's
-- display name.
--
-- FourthUpdate.md's own instruction (read fresh during the whole-plan
-- discovery pass that preceded Assets Management): every displayed
-- "Employee Portal" / "بوابة الموظف(ين)" string across the product must
-- become "Digital Workplace Platform" / "منصة العمل الرقمية". The frontend
-- i18n strings were fixed in the same pass (src/i18n/modules/*.js,
-- src/context/LanguageContext.jsx) — this migration is the one piece of that
-- rename that lives in seed data, not translated UI text.
--
-- Only the DISPLAY NAME columns (name_ar/name_en) change. The module CODE
-- itself, 'EMPLOYEE_PORTAL', is an internal identifier referenced by dozens
-- of app_screens rows and by tenant_has_module()/module-gating logic across
-- the whole platform — renaming the code would be a structural, high-risk
-- change for zero user-visible benefit (the code is never shown to anyone).
-- Only the label a human actually reads changes here.
-- ============================================================================
update public.platform_modules
set name_ar = 'منصة العمل الرقمية', name_en = 'Digital Workplace Platform'
where code = 'EMPLOYEE_PORTAL';

revoke execute on all functions in schema public from public;
