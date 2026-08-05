-- ============================================================================
-- 037 — Every function that was ever explicitly GRANTed was also, silently,
--        granted to PUBLIC — i.e. to anyone, including an anonymous caller
--
-- This is not a mistake any single migration made. It is a PostgreSQL ACL
-- mechanic none of them could see:
--
--   * A freshly created function's pg_proc.proacl is NULL — "still at
--     defaults" — and while it stays NULL, has_function_privilege() for
--     PUBLIC correctly reports false, so a function that is never touched by
--     any GRANT/REVOKE really is authenticated/anon-only if that's all it
--     was ever given.
--   * The moment ANY explicit GRANT or REVOKE runs on that function — which
--     is every function in this codebase, since the house style is
--     "create function, then grant execute to authenticated/anon" — Postgres
--     materializes proacl starting from acldefault('function', owner), the
--     hardcoded SQL-standard default. That default always includes
--     `=X/owner`: PUBLIC execute. ALTER DEFAULT PRIVILEGES cannot prevent
--     this; it only governs the pre-materialization state, which a single
--     GRANT statement immediately leaves.
--
-- Confirmed against a from-scratch local Postgres instance with the full
-- migration chain applied: 248 of 270 public.* functions carry the PUBLIC
-- entry. Every one of those is SECURITY DEFINER, so PUBLIC execute means an
-- anonymous connection (Supabase's `anon` role, which is a PUBLIC member like
-- every role) can invoke it. Most fail closed anyway because they separately
-- check auth.uid() is null — but that makes the correct behaviour an accident
-- of each function's own body, not a property of the grant system, and the
-- handful of functions that do NOT carry that check (this session already
-- found and fixed one instance of exactly that shape in
-- 202608050031_tenant_quota_consume_hardening.sql) had no privilege boundary
-- at all until now.
--
-- The fix has to be blanket and retroactive: ALTER DEFAULT PRIVILEGES only
-- affects objects created after it runs that are NEVER explicitly granted —
-- it cannot repair the 248 that already exist and have already been granted.
-- REVOKE EXECUTE ... FROM PUBLIC does not touch any grant to a named role
-- (authenticated, anon, service_role), so every intentional grant survives
-- untouched — this removes only the implicit "and also literally everyone"
-- that PostgreSQL added on the side.
-- ============================================================================

revoke execute on all functions in schema public from public;

-- Belt and suspenders for anything created after this point without an
-- explicit grant: keeps a function that is never touched by GRANT/REVOKE
-- private by default instead of implicitly public.
alter default privileges in schema public revoke execute on functions from public;

comment on schema public is
  'Functions here are executable only by roles explicitly granted (authenticated/anon/service_role) — '
  'PUBLIC execute is revoked in migration 037. Any new function still needs its own explicit grant; '
  'the moment one is added, re-run "revoke execute on function ... from public" for that function too, '
  'since a single GRANT re-materializes PostgreSQL''s default ACL, which includes PUBLIC.';
