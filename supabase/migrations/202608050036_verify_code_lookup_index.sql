-- ============================================================================
-- 036 — The public verification page's slowest query had no matching index
--
-- forms.verify_code carries a plain unique constraint (migration 0009), which
-- backs an ordinary case-sensitive btree index. public.verify_document() —
-- the RPC the actual public verify page calls — looks a code up with
-- lower(f.verify_code) = lower(v_code), because the code gets typed by hand
-- off a printed page. Wrapping the column in lower() stops the planner from
-- using that index at all, so every lookup that falls through to the forms
-- fallback path (anything without a verifiable_documents row — see the
-- backward-compatibility comment in verify_document itself) does a full scan
-- of forms. A public, unauthenticated, potentially high-traffic endpoint
-- scanning every form in the database on every request is exactly the kind of
-- unindexed hot path the audit asked to find.
-- ============================================================================

create index if not exists idx_forms_verify_code_lower
  on public.forms (lower(verify_code))
  where verify_code is not null and not is_deleted;

-- ============================================================================
-- The audit trail's own tenant index (idx_audit_logs_tenant, migration 0012)
-- only covers tenant_id. Every real screen that reads it — Security.View /
-- Audit.View filtering one company's own trail — orders by created_on too;
-- without the date in the index, that ordering falls back to a sort step
-- over every row the tenant filter matched instead of an index-ordered scan.
-- Composite, so it replaces the narrower index's job rather than sitting
-- beside it.
-- ============================================================================

drop index if exists idx_audit_logs_tenant;
create index if not exists idx_audit_logs_tenant_created
  on public.audit_logs (tenant_id, created_on desc);

