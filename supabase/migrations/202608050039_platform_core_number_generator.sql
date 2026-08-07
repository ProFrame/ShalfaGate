-- ============================================================================
-- 039 — Platform Core: INumberGenerator
--
-- Update 4's first mandated step (FourthUpdate.md) is unifying every ad-hoc
-- number allocator into one Platform-Core-owned service, so Update 4's own
-- new entities (Asset, Operation, Inspection, Work Order...) never grow a
-- fourth one. Today there are three independent allocators with three
-- different shapes:
--   generate_verify_code()   SLUG-############ random, collision-checked
--                             against public.forms
--   generate_document_code() wraps generate_verify_code(), same random shape,
--                             collision-checked against verifiable_documents
--   support_next_ticket_no() BBX-YYYY-###### off one GLOBAL sequence shared
--                             by every tenant, hardcoded 'BBX-' prefix
--
-- This migration adds generate_number(source, tenant) — a real per-tenant,
-- per-source running counter producing NO-{TENANT_SLUG}-{SOURCE}-{00000125}.
-- From here on, "a module needs a user-visible number" means exactly:
--   select public.generate_number('AS');
-- and nothing about sequencing, tenant codes or padding lives anywhere else.
--
-- What this migration deliberately does NOT do: touch generate_verify_code()
-- or generate_document_code(). Those exist because verify_document(p_code) is
-- public and unauthenticated — anyone who knows the code sees the document,
-- with no second factor (unlike support_ticket_status, which requires
-- ticket_no + requester email together). A sequential, zero-padded running
-- number is enumerable: NO-SHLF-TA-00000001, 00000002... would let anyone
-- walk every approved document of every tenant. The random 12-digit code
-- exists to prevent exactly that, on purpose (see migration 202607290009's
-- own comment on generate_verify_code). Folding TA/CT into the sequential
-- scheme would silently reopen that hole, so the two concerns stay two
-- functions: generate_number() is the human-readable reference number shown
-- in the UI and on printouts; generate_verify_code()/generate_document_code()
-- stay the dedicated, opaque public-verification secret. Both are still
-- owned by Platform Core — nothing outside this migration reimplements
-- either.
--
-- support_next_ticket_no() is migrated below: a ticket number is never the
-- public-verification secret (support_ticket_status() is already gated by
-- ticket_no + requester email, not by ticket_no alone), and its current
-- global cross-tenant sequence is itself one of the three allocators this
-- migration exists to close.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Source-code catalogue
--    Every module that needs a user-visible number registers its 2-4 letter
--    code here. This is the single place "what is AS / WO / RF" is answered —
--    a module may request a number for a code listed here, never invent its
--    own numbering scheme.
-- ----------------------------------------------------------------------------

create table if not exists public.number_sources (
  code text primary key check (code = upper(code) and length(code) between 2 and 4),
  label_ar text not null,
  label_en text not null,
  owner_module text not null,
  is_active boolean not null default true,
  created_on timestamptz not null default now()
);

comment on table public.number_sources is
  'Catalogue of source codes accepted by generate_number(). One row per '
  'business-entity type; owner_module records which Update-4 module is '
  'responsible for that code, per the platform''s Module Ownership rule.';

insert into public.number_sources (code, label_ar, label_en, owner_module) values
  ('TA', 'معاملة نموذج معتمد', 'Approved Form Transaction', 'Workflow Engine'),
  ('AS', 'أصل', 'Asset', 'Assets'),
  ('WO', 'أمر عمل', 'Work Order', 'Assets'),
  ('TR', 'تدريب', 'Training', 'Digital Identity'),
  ('CT', 'شهادة', 'Certificate', 'Verification Service'),
  ('ID', 'بطاقة موظف', 'Employee Card', 'Digital Identity'),
  ('IN', 'تفتيش', 'Inspection', 'Assets'),
  ('MS', 'اجتماع', 'Meeting', 'Operations'),
  ('PO', 'أمر شراء', 'Purchase Order', 'Assets'),
  ('IV', 'فاتورة', 'Invoice', 'Assets'),
  ('CO', 'عقد', 'Contract', 'Digital Identity'),
  ('RF', 'نموذج مخاطر', 'Risk Form', 'Safety'),
  ('AU', 'تدقيق', 'Audit', 'Platform Core'),
  ('EV', 'تقييم', 'Evaluation', 'Operations'),
  ('ST', 'تذكرة دعم', 'Support Ticket', 'Support')
on conflict (code) do nothing;

alter table public.number_sources enable row level security;
drop policy if exists "number sources are readable by any authenticated session" on public.number_sources;
create policy "number sources are readable by any authenticated session" on public.number_sources
  for select to authenticated using (true);

-- ----------------------------------------------------------------------------
-- 2. Per-tenant, per-source running counter
--    Infrastructure, not tenant content: written exclusively by
--    generate_number() below with an explicit p_tenant_id argument (some
--    callers — support ticket creation, service-role batch jobs — have no
--    session tenant at all), so apply_row_defaults' session-derived tenant_id
--    would be wrong here. Same category as tenant_quotas (see
--    tests/tenancy-invariants.test.mjs TENANT_INFRASTRUCTURE).
-- ----------------------------------------------------------------------------

create table if not exists public.number_sequences (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_code text not null references public.number_sources(code),
  next_value bigint not null default 1,
  updated_on timestamptz not null default now(),
  primary key (tenant_id, source_code)
);

alter table public.number_sequences enable row level security;
drop policy if exists "number sequences readable by owning tenant" on public.number_sequences;
create policy "number sequences readable by owning tenant" on public.number_sequences
  for select to authenticated using (tenant_id = public.current_tenant_id());

-- ----------------------------------------------------------------------------
-- 3. generate_number — the one and only entry point
--    GenerateNumber(SourceCode, TenantId) -> NO-{TENANT_SLUG}-{SOURCE}-{########}
--    No module is allowed to know how the number is built; it only calls
--    public.generate_number('AS') and gets back a finished string. The
--    increment is atomic under concurrency: the INSERT ... ON CONFLICT DO
--    UPDATE takes a row lock on (tenant_id, source_code), the same pattern
--    already used by tenant_quota_consume().
--
--    Granted to `authenticated` (every future module's screen calls this
--    directly for its own tenant), so p_tenant_id cannot be trusted blindly —
--    it is only honoured for a tenant other than the caller's own session
--    when the caller is a platform operator, or the request is exactly 'ST'
--    against the fixed platform tenant (support_next_ticket_no()'s only real
--    use of the parameter). See the in-function comment for the full
--    reasoning; this is the same cross-tenant bug class migration
--    202608050031 already fixed for tenant_quota_consume(), applied here
--    before it ever shipped.
-- ----------------------------------------------------------------------------

create or replace function public.generate_number(p_source_code text, p_tenant_id uuid default null)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_session_tenant uuid := public.current_tenant_id();
  v_tenant uuid := coalesce(p_tenant_id, v_session_tenant);
  v_source text := upper(trim(coalesce(p_source_code, '')));
  v_slug text;
  v_value bigint;
begin
  if v_tenant is null then
    raise exception 'NUMBER_GENERATOR_TENANT_REQUIRED';
  end if;

  -- A caller may only allocate a number against a tenant other than its own
  -- session tenant if it is a platform operator, or the request is exactly
  -- 'ST' (Support Ticket) against the fixed platform tenant — the one case
  -- support_next_ticket_no() needs, regardless of who (anon, or any
  -- authenticated employee of any company) is filing the ticket, because
  -- every support ticket belongs to the platform tenant by design (see
  -- support_tickets.tenant_id = platform_tenant_id() in migration
  -- 202608040018). This is deliberately narrow — NOT "any source against the
  -- platform tenant" — otherwise any authenticated user of any company could
  -- still burn the platform tenant's own counters for sources that are not
  -- support tickets. A future module with a genuine equivalent need should
  -- extend this exact allow-list explicitly, never widen it to "the platform
  -- tenant is always fair game". Anything outside these cases would
  -- reproduce the cross-tenant bug already found and fixed for
  -- tenant_quota_consume() in migration 202608050031: this RPC is granted to
  -- `authenticated` (every future module's screen calls it directly for its
  -- own tenant), so an ungated p_tenant_id override would let any signed-in
  -- user of any company burn, and learn the slug of, any other company's
  -- counter just by passing its id.
  --
  -- IS DISTINCT FROM, not <>: found by the Batch-1 closing audit as a
  -- blocker. `v_session_tenant is not null and v_tenant <> v_session_tenant`
  -- fails open the moment v_session_tenant is null for ANY reason (not just
  -- a genuine anon/no-JWT caller — current_tenant_id() can also resolve to
  -- null for a signed-in, still-authenticated user with no resolvable
  -- membership) — the whole guard was skipped, accepting an arbitrary
  -- p_tenant_id unconditionally. IS DISTINCT FROM treats "v_tenant differs
  -- from a null session" as true, so the guard now correctly still requires
  -- the ST+platform-tenant carve-out or is_platform_operator() in that case
  -- too, while the legitimate anon support-ticket path (v_session_tenant
  -- null, v_tenant = platform_tenant_id(), v_source = 'ST') still matches
  -- the carve-out and passes, exactly as before.
  if v_tenant is distinct from v_session_tenant
     and not (v_source = 'ST' and v_tenant = public.platform_tenant_id())
     and not public.is_platform_operator() then
    raise exception 'NUMBER_GENERATOR_TENANT_NOT_AUTHORIZED';
  end if;

  if not exists (select 1 from public.number_sources s where s.code = v_source and s.is_active) then
    raise exception 'NUMBER_GENERATOR_UNKNOWN_SOURCE';
  end if;

  select t.slug into v_slug from public.tenants t where t.id = v_tenant;
  if v_slug is null then
    raise exception 'NUMBER_GENERATOR_TENANT_NOT_FOUND';
  end if;

  insert into public.number_sequences (tenant_id, source_code, next_value)
  values (v_tenant, v_source, 2)
  on conflict (tenant_id, source_code) do update
    set next_value = public.number_sequences.next_value + 1,
        updated_on = now()
  returning next_value - 1 into v_value;

  return 'NO-' || upper(v_slug) || '-' || v_source || '-' || lpad(v_value::text, 8, '0');
end;
$$;

revoke all on function public.generate_number(text, uuid) from public;
grant execute on function public.generate_number(text, uuid) to authenticated, service_role;

comment on function public.generate_number(text, uuid) is
  'Platform Core''s single number allocator. Every module that needs a '
  'user-visible entity number calls generate_number(source_code) — never '
  'its own counter, sequence, or random string. Format: '
  'NO-{TENANT_SLUG}-{SOURCE_CODE}-{8-digit running number}, unique per '
  '(tenant_id, source_code). Not for public-verification secrets — those '
  'stay on generate_verify_code()/generate_document_code(), which are '
  'deliberately non-sequential. p_tenant_id is honoured for a company other '
  'than the caller''s own session only for a platform operator, or an ''ST'' '
  'request against the fixed platform tenant (NUMBER_GENERATOR_TENANT_NOT_AUTHORIZED '
  'otherwise) — see migration 202608050031''s identical fix for tenant_quota_consume().';

-- ----------------------------------------------------------------------------
-- 4. Retire the ad-hoc, non-tenant-scoped support ticket sequence
--    Same visible entry point (support_ticket_create/_internal are
--    unchanged), new implementation. Tickets already issued keep their
--    BBX-YYYY-###### shape; only numbers issued from here on use the
--    unified format, scoped to the one platform tenant every ticket already
--    belongs to (support_tickets.tenant_id = platform_tenant_id()).
-- ----------------------------------------------------------------------------

create or replace function public.support_next_ticket_no()
returns text
language sql
volatile
security definer
set search_path = public
as $$
  select public.generate_number('ST', public.platform_tenant_id());
$$;

revoke all on function public.support_next_ticket_no() from public;

drop sequence if exists public.support_ticket_no_seq;

comment on function public.support_next_ticket_no() is
  'Delegates to the shared public.generate_number(''ST'', platform tenant) '
  'instead of its own global sequence, so support tickets follow the same '
  'Platform-Core numbering as every other entity.';

-- ----------------------------------------------------------------------------
-- 5. Close the PUBLIC-execute gap this batch just reopened
--    (see docs/pre_update4_readiness_2026-08-05.md and migration 037 — every
--    explicit GRANT/REVOKE re-materializes PUBLIC into the function's ACL,
--    so every migration batch must end with this exact statement.)
-- ----------------------------------------------------------------------------

revoke execute on all functions in schema public from public;
