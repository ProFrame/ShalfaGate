-- ============================================================================
-- 045 — Global Validation before Batch 3
--
-- A whole-project review (architecture, security, performance, database,
-- contract compliance, dead code — Batch 1/2 now treated as core system, not
-- reviewed leniently as "new") found 37 confirmed issues. This migration
-- fixes every one of them that is a genuine code/schema problem. Frontend
-- fixes (dead component deletion, AdminCenter.jsx direct-Supabase calls) and
-- documentation fixes are separate, non-SQL changes — see this batch's
-- closing report for the full list, including what was deliberately left
-- with a stated reason rather than rushed under a "no new development"
-- constraint.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. support_next_ticket_no() always drew from the PLATFORM tenant's counter,
--    even for "InApp" tickets that support_ticket_create_internal() itself
--    stamps with the real company's own tenant_id — reproducing exactly the
--    "one global sequence shared by every tenant" problem migration 039
--    states it exists to retire (039's own comment: "its current global
--    cross-tenant sequence is itself one of the three allocators this
--    migration exists to close"). The PUBLIC path (support_ticket_create())
--    is unaffected and correctly platform-scoped by design — every anonymous
--    ticket belongs to the platform's own support queue regardless of which
--    company the requester claims to be from. Only the INTERNAL/InApp path,
--    which already uses the caller's own real tenant for the ticket ROW, was
--    inconsistently drawing its NUMBER from a different (platform) tenant.
--
--    Fixed by giving support_next_ticket_no() an optional tenant parameter,
--    defaulting to platform_tenant_id() so the public path's call site (and
--    its behavior, and every existing ticket number it has ever produced)
--    needs no change at all. The old zero-arg function is explicitly DROPped
--    first, not left alongside the new one — a bare zero-arg call next to a
--    one-arg-with-default overload is exactly the ambiguous-overload trap
--    already found and fixed once this batch for generate_verify_code().
--
--    generate_number()'s own authorization guard (migration 039) does not
--    need to change for this: when p_tenant_id equals the caller's own
--    current_tenant_id() (true for the InApp path, since
--    support_ticket_create_internal() runs as the real caller's own session),
--    "v_tenant IS DISTINCT FROM v_session_tenant" is false and the whole
--    cross-tenant guard clause never engages — this is just an ordinary
--    same-tenant number request, indistinguishable from any other module
--    asking for its own tenant's next 'AS' or 'WO' number.
-- ----------------------------------------------------------------------------
drop function if exists public.support_next_ticket_no();

create or replace function public.support_next_ticket_no(p_tenant_id uuid default null)
returns text
language sql
volatile
security definer
set search_path = public
as $$
  select public.generate_number('ST', coalesce(p_tenant_id, public.platform_tenant_id()));
$$;

revoke all on function public.support_next_ticket_no(uuid) from public;

comment on function public.support_next_ticket_no(uuid) is
  'Delegates to the shared public.generate_number(''ST'', tenant). Defaults to '
  'the platform tenant (the public support path''s correct, unchanged '
  'behavior); the internal/InApp path passes its own real tenant explicitly '
  '(fixed in migration 045 — it previously always drew from the platform '
  'tenant''s counter even for tickets already stamped with a real company''s '
  'own tenant_id).';

create or replace function public.support_ticket_create_internal(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user public.users%rowtype;
  v_subject text := nullif(trim(coalesce(p_payload ->> 'subject', '')), '');
  v_body text := nullif(trim(coalesce(p_payload ->> 'body', '')), '');
  v_category text := coalesce(nullif(trim(coalesce(p_payload ->> 'category', '')), ''), 'Other');
  v_priority text := coalesce(nullif(trim(coalesce(p_payload ->> 'priority', '')), ''), 'Normal');
  v_ticket public.support_tickets%rowtype;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  if not public.has_permission('Support.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if v_subject is null then raise exception 'SUBJECT_REQUIRED'; end if;
  if v_body is null then raise exception 'BODY_REQUIRED'; end if;
  if v_category not in ('Technical', 'Billing', 'Feature', 'Account', 'Other') then
    raise exception 'CATEGORY_INVALID';
  end if;
  if v_priority not in ('Low', 'Normal', 'High', 'Urgent') then v_priority := 'Normal'; end if;

  select * into v_user from public.users where id = auth.uid();
  if not found then raise exception 'USER_NOT_FOUND'; end if;

  insert into public.support_tickets (
    tenant_id, requester_tenant_id, ticket_no, source, category, subject, body,
    requester_name, requester_email, requester_user_id, status, priority,
    requester_ip, user_agent
  )
  values (
    v_tenant, v_tenant, public.support_next_ticket_no(v_tenant), 'InApp', v_category,
    left(v_subject, 300), v_body,
    coalesce(v_user.full_name, v_user.name_ar, v_user.name_en, v_user.email),
    lower(v_user.email), v_user.id, 'Open', v_priority,
    public.request_client_ip(), public.request_user_agent()
  )
  returning * into v_ticket;

  return jsonb_build_object('id', v_ticket.id, 'ticket_no', v_ticket.ticket_no, 'status', v_ticket.status);
end;
$$;
grant execute on function public.support_ticket_create_internal(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. form_collaborator_add(): the 'Participant' role grants real read access
--    (folded into is_form_participant() — see migration 044's comment on that
--    function for why Watcher was deliberately excluded from the same grant
--    after a prior review found it a confidentiality gap). But the
--    authorization on WHO may add a collaborator never varied by which role
--    they're granting: any current holder of the form — not just its
--    requester or an admin — could add an arbitrary same-tenant employee as
--    'Participant' and hand them the exact same one-click full-read access
--    the Watcher exclusion was meant to close off. Watcher (notification
--    only, no read grant) keeps the wider "requester, current holder, or
--    Approvals.Manage" authorization, since it carries no confidentiality
--    exposure — that justification never applied to Participant once
--    Participant became the tier that actually grants access.
-- ----------------------------------------------------------------------------
create or replace function public.form_collaborator_add(p_form_id uuid, p_user_id uuid, p_role text default 'Watcher')
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_form public.forms%rowtype;
  v_id uuid;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  if p_role not in ('Participant', 'Watcher') then raise exception 'INVALID_COLLABORATOR_ROLE'; end if;

  select * into v_form from public.forms where id = p_form_id and tenant_id = v_tenant and not is_deleted;
  if not found then raise exception 'FORM_NOT_FOUND'; end if;

  if p_role = 'Participant' then
    if not (auth.uid() = v_form.requested_by or public.has_permission('Approvals.Manage')) then
      raise exception 'PERMISSION_DENIED';
    end if;
  else
    if not (
      auth.uid() = v_form.requested_by
      or auth.uid() = v_form.current_assignee_id
      or public.has_permission('Approvals.Manage')
    ) then
      raise exception 'PERMISSION_DENIED';
    end if;
  end if;

  if p_user_id = v_form.requested_by then
    raise exception 'REQUESTER_ALREADY_HAS_ACCESS';
  end if;
  if not exists (select 1 from public.users where id = p_user_id and tenant_id = v_tenant and is_active and not coalesce(is_deleted, false)) then
    raise exception 'TARGET_USER_NOT_FOUND';
  end if;

  insert into public.form_collaborators (tenant_id, form_id, user_id, role)
  values (v_tenant, p_form_id, p_user_id, p_role)
  on conflict (form_id, user_id) do update
    set role = excluded.role, is_deleted = false, deleted_by = null, deleted_date = null, updated_on = now()
  returning id into v_id;

  perform public.notify(
    p_user_id, 'Approval', 'form_collaborator_added',
    'أُضفت كمتابع لطلب', 'You were added to a request',
    'يمكنك الآن الاطلاع على هذا الطلب.', 'You can now follow this request.',
    '/app/approvals?form=' || p_form_id::text
  );

  return v_id;
end;
$$;
revoke all on function public.form_collaborator_add(uuid, uuid, text) from public;
grant execute on function public.form_collaborator_add(uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. The zero-argument generate_verify_code() overload is dead: its only two
--    call sites were fixed in migration 044 to pass an explicit tenant
--    argument (the exact fix for the ambiguous-overload bug this same
--    zero-arg function caused). Its mere existence is a footgun — any future
--    bare call reproduces "function is not unique" again. Removed outright
--    rather than left as unreachable dead SQL.
-- ----------------------------------------------------------------------------
drop function if exists public.generate_verify_code();

-- ----------------------------------------------------------------------------
-- 4. approval_center_feed(): the 'history' branch had no LIMIT at all — every
--    non-Draft form the caller has ever touched, unbounded, reloaded on
--    every Approval Center / dashboard visit. Also gives DISTINCT ON an
--    explicit ORDER BY (it previously had none, so which single transaction
--    date "won" per form was unspecified by Postgres, not necessarily the
--    most recent) — a prerequisite for "most recent 200" to mean anything.
--    inbox/outbox are naturally bounded by "currently InApproval, assigned to
--    me" / "requests I'm actively tracking" and are left as-is.
-- ----------------------------------------------------------------------------
create or replace function public.approval_center_feed()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_inbox jsonb;
  v_outbox jsonb;
  v_history jsonb;
begin
  select coalesce(jsonb_agg(entry order by entry->>'pending_since' desc), '[]'::jsonb) into v_inbox
  from (
    select jsonb_build_object(
      'id', f.id,
      'reference_no', f.reference_no,
      'verify_code', f.verify_code,
      'status', f.status,
      'template_id', f.template_id,
      'template_name', tpl.name, 'template_name_ar', tpl.name_ar, 'template_name_en', tpl.name_en,
      'requester_id', f.requested_by,
      'requester_name', public.approval_display_name(req),
      'role_code', ar.code, 'role_name_ar', ar.name_ar, 'role_name_en', ar.name_en,
      'is_review', (f.return_to_user_id is not null),
      'is_own_return', (f.requested_by = auth.uid()),
      'pending_since', f.pending_since,
      'approval_started_on', f.approval_started_on,
      'last_comment', (select tx.comment from public.form_approval_transactions tx where tx.form_id = f.id order by tx.seq desc limit 1),
      'last_action', (select tx.action from public.form_approval_transactions tx where tx.form_id = f.id order by tx.seq desc limit 1),
      'last_actor_name', (select tx.actor_name from public.form_approval_transactions tx where tx.form_id = f.id order by tx.seq desc limit 1)
    ) as entry
    from public.forms f
    join public.templates tpl on tpl.id = f.template_id
    left join public.users req on req.id = f.requested_by
    left join public.approval_roles ar on ar.id = f.current_approval_role_id
    where f.current_assignee_id = auth.uid() and f.status = 'InApproval' and not f.is_deleted
  ) inbox;

  select coalesce(jsonb_agg(entry order by entry->>'updated_on' desc), '[]'::jsonb) into v_outbox
  from (
    select jsonb_build_object(
      'id', f.id,
      'reference_no', f.reference_no,
      'verify_code', f.verify_code,
      'status', f.status,
      'template_id', f.template_id,
      'template_name', tpl.name, 'template_name_ar', tpl.name_ar, 'template_name_en', tpl.name_en,
      'assignee_id', f.current_assignee_id,
      'assignee_name', case when asg.id is not null then public.approval_display_name(asg) end,
      'role_code', ar.code, 'role_name_ar', ar.name_ar, 'role_name_en', ar.name_en,
      'pending_since', f.pending_since,
      'approval_started_on', f.approval_started_on,
      'approval_completed_on', f.approval_completed_on,
      'updated_on', f.updated_on,
      'held_by_me', (f.status <> 'Cancelled' and coalesce(f.current_assignee_id, f.requested_by) = auth.uid()),
      'can_recall', (
        f.status = 'InApproval' and f.current_assignee_id <> auth.uid()
        and (select tx.action = 'Submit' and tx.actor_id = auth.uid()
             from public.form_approval_transactions tx
             where tx.form_id = f.id order by tx.seq desc limit 1)
      ),
      'last_action', (select tx.action from public.form_approval_transactions tx where tx.form_id = f.id order by tx.seq desc limit 1),
      'last_actor_name', (select tx.actor_name from public.form_approval_transactions tx where tx.form_id = f.id order by tx.seq desc limit 1)
    ) as entry
    from public.forms f
    join public.templates tpl on tpl.id = f.template_id
    left join public.users asg on asg.id = f.current_assignee_id
    left join public.approval_roles ar on ar.id = f.current_approval_role_id
    where f.requested_by = auth.uid() and f.approval_started_on is not null and not f.is_deleted
  ) outbox;

  select coalesce(jsonb_agg(entry order by entry->>'updated_on' desc), '[]'::jsonb) into v_history
  from (
    select entry from (
      select distinct on (f.id)
        f.updated_on,
        jsonb_build_object(
          'id', f.id,
          'reference_no', f.reference_no,
          'verify_code', f.verify_code,
          'status', f.status,
          'template_id', f.template_id,
          'template_name', tpl.name, 'template_name_ar', tpl.name_ar, 'template_name_en', tpl.name_en,
          'requester_name', public.approval_display_name(req),
          'assignee_name', case when asg.id is not null then public.approval_display_name(asg) end,
          'approval_started_on', f.approval_started_on,
          'approval_completed_on', f.approval_completed_on,
          'updated_on', f.updated_on
        ) as entry
      from public.forms f
      join public.templates tpl on tpl.id = f.template_id
      left join public.users req on req.id = f.requested_by
      left join public.users asg on asg.id = f.current_assignee_id
      where not f.is_deleted
        and f.approval_started_on is not null
        and (
          f.requested_by = auth.uid()
          or f.employee_id = auth.uid()
          or exists (
            select 1 from public.form_approval_transactions tx
            where tx.form_id = f.id and (tx.actor_id = auth.uid() or tx.to_user_id = auth.uid())
          )
        )
      order by f.id, f.updated_on desc
    ) deduped
    order by updated_on desc
    limit 200
  ) history;

  return jsonb_build_object('inbox', v_inbox, 'outbox', v_outbox, 'history', v_history);
end;
$$;
grant execute on function public.approval_center_feed() to authenticated;

-- ----------------------------------------------------------------------------
-- 5. approval_dashboard_data(): 'completed' and 'transactions' were bounded
--    only by a 90-day time window, not a row count — a busy tenant's entire
--    quarter of approval history serializes on every admin dashboard load.
--    Capped at 200 each, matching the safety clamp already used by
--    approval_admin_requests_list() and notification_feed().
-- ----------------------------------------------------------------------------
create or replace function public.approval_dashboard_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if not public.has_permission('Approvals.Manage') then
    raise exception 'PERMISSION_DENIED';
  end if;

  return jsonb_build_object(
    'pending', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'reference_no', f.reference_no, 'status', f.status,
        'template_name', tpl.name, 'template_name_ar', tpl.name_ar, 'template_name_en', tpl.name_en,
        'requester_name', public.approval_display_name(req),
        'assignee_id', f.current_assignee_id,
        'assignee_name', case when asg.id is not null then public.approval_display_name(asg) end,
        'assignee_department', coalesce(dep.name_ar, asg.department),
        'role_name_ar', ar.name_ar, 'role_name_en', ar.name_en,
        'is_review', (f.return_to_user_id is not null),
        'pending_since', f.pending_since, 'approval_started_on', f.approval_started_on
      ) order by f.pending_since asc)
      from public.forms f
      join public.templates tpl on tpl.id = f.template_id
      left join public.users req on req.id = f.requested_by
      left join public.users asg on asg.id = f.current_assignee_id
      left join public.departments dep on dep.id = asg.department_id
      left join public.approval_roles ar on ar.id = f.current_approval_role_id
      where f.status = 'InApproval' and not f.is_deleted
        and f.tenant_id = v_tenant
    ), '[]'::jsonb),
    'completed', coalesce((
      select jsonb_agg(entry) from (
        select jsonb_build_object(
          'id', f.id, 'status', f.status,
          'approval_started_on', f.approval_started_on, 'approval_completed_on', f.approval_completed_on,
          'updated_on', f.updated_on
        ) as entry
        from public.forms f
        where f.status in ('Approved', 'Rejected') and not f.is_deleted
          and f.tenant_id = v_tenant
          and f.updated_on >= now() - interval '90 days'
        order by f.updated_on desc
        limit 200
      ) capped
    ), '[]'::jsonb),
    'transactions', coalesce((
      select jsonb_agg(entry) from (
        select jsonb_build_object(
          'action', tx.action, 'actor_id', tx.actor_id, 'actor_name', tx.actor_name,
          'department', coalesce(dep.name_ar, u.department),
          'created_on', tx.created_on
        ) as entry
        from public.form_approval_transactions tx
        left join public.users u on u.id = tx.actor_id
        left join public.departments dep on dep.id = u.department_id
        where tx.created_on >= now() - interval '90 days'
          and tx.tenant_id = v_tenant
        order by tx.created_on desc
        limit 200
      ) capped
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.approval_dashboard_data() to authenticated;

-- ----------------------------------------------------------------------------
-- 6. write_audit_log() audit triggers were only ever attached to 12 tables,
--    all in the three earliest, pre-multi-tenant-pivot migrations. Every
--    business table added since the pivot (202608040012 onward) — 52 tables,
--    including this project's own Batch 1/2 work (attachments, tags,
--    form_collaborators) — has had zero audit coverage, in direct violation
--    of contract §19 ("every mutation of a business entity produces an audit
--    trail entry via write_audit_log()... if a table is business data, it is
--    audited"). write_audit_log() is fully generic (keys off tg_table_name,
--    needs no per-table configuration), so this is the exact same
--    "add a trigger" pattern already proven on the 12 tables that have it —
--    not new logic, closing a coverage gap in an existing one.
--
--    public.tenants is deliberately EXCLUDED from this loop: write_audit_log()
--    lets apply_row_defaults() infer tenant_id on the nested audit_logs
--    insert from current_tenant_id() (the ACTOR's own tenant) when not
--    explicit — correct for every other table, where the actor's tenant and
--    the row's tenant are the same by construction. tenants has no tenant_id
--    column (the row's own id IS the tenant), and is legitimately edited
--    cross-tenant by platform operators — current_tenant_id() at that moment
--    is the operator's own (platform) tenant, not the company row being
--    edited, which would misfile the log entry under the wrong company.
--    Auditing tenants correctly needs a bespoke trigger that sets tenant_id
--    from NEW.id directly, not this generic one — logged as a real,
--    named follow-up rather than given an inconsistent, half-correct fix
--    here under this review's "no new development" constraint.
--
--    Tables intentionally left unaudited, with reasons (do not add to the
--    loop below without updating this comment): platform-wide operator-owned
--    catalogues with no tenant_id (permissions, platform_modules,
--    platform_licenses, platform_quota_resources, platform_reserved_slugs,
--    dashboard_widgets, storage_providers, storage_policies, app_screens,
--    number_sources); tables tests/tenancy-invariants.test.mjs already
--    documents as TENANT_INFRASTRUCTURE (tenant_memberships, tenant_modules,
--    tenant_quotas, tenant_usage_daily, number_sequences); tables that are
--    themselves already an immutable, purpose-built audit/history ledger —
--    auditing the audit trail is redundant (audit_logs itself,
--    form_approval_transactions, login_attempts, security_events,
--    activity_timeline); delivery/read-receipt/presence/session tables
--    (content_receipts, email_queue, announcement_reads, notifications,
--    notification_preferences, chat_message_receipts, chat_presence,
--    chat_participants, chat_reactions, user_devices); personal/private,
--    owner-scoped, not a shared company record (user_widget_preferences,
--    user_preferences, notes, note_items); and entity_tags specifically,
--    whose own migration (042) already documents "a tag is a lightweight
--    label, not sensitive content" as a deliberate low-sensitivity design
--    choice (unlike its sibling employee_tag_assignments, which IS audited
--    below); import_job_rows, whose own action/validation_errors columns
--    already serve as that row's own record of what happened to it.
-- ----------------------------------------------------------------------------
do $$
declare
  needs_audit text[] := array[
    'templates', 'form_attachments', 'role_permissions',
    'approval_roles', 'approval_schemes', 'approval_scheme_roles',
    'projects', 'sites',
    'competency_indicators', 'proficiency_levels',
    'evaluation_templates', 'evaluation_sections', 'evaluation_workflow_steps',
    'performance_evaluations', 'evaluation_goals', 'evaluation_competencies',
    'lookup_values', 'import_jobs',
    'sectors', 'countries', 'employee_tags', 'employee_tag_assignments',
    'audience_rules', 'audience_rule_terms',
    'announcements', 'surveys', 'survey_options', 'survey_responses', 'calendar_events',
    'chat_conversations', 'chat_messages', 'chat_attachments', 'chat_blocks',
    'verifiable_documents', 'certificate_templates', 'certificate_template_fields',
    'certificate_batches', 'certificates',
    'support_tickets', 'support_messages', 'tenant_storage_config', 'storage_objects', 'role_screens',
    'tenant_signup_requests',
    'tenant_names', 'tenant_branding', 'tenant_contacts', 'tenant_settings', 'tenant_domains',
    'attachments', 'tags', 'form_collaborators'
  ];
  tbl text;
begin
  foreach tbl in array needs_audit loop
    if to_regclass('public.' || tbl) is null then
      continue;
    end if;
    execute format('drop trigger if exists %I on public.%I', 'audit_' || tbl, tbl);
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.write_audit_log()',
      'audit_' || tbl, tbl
    );
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 7. §21 (Public RPC contract) requires every anon/cross-tenant-reachable RPC
--    to state Authentication/Authorization/Rate limiting/Expected errors in
--    its comment on function. 8 of the 11 ANON_CALLABLE functions
--    (tests/tenancy-invariants.test.mjs) had none at all.
-- ----------------------------------------------------------------------------
comment on function public.provision_tenant_preflight(jsonb) is
  'Authentication: anon. Authorization: none — read-only validation of a '
  'not-yet-submitted signup payload, returns only which fields are invalid '
  'and whether the chosen slug is free, never another tenant''s data. '
  'Rate limiting: none yet — relies on provision_tenant()/tenant-signup''s '
  'own per-IP/per-email throttling at actual submission time. '
  'Expected errors: none raised — invalid fields are returned in the '
  'response payload, not as exceptions.';

comment on function public.request_client_ip() is
  'Authentication: any (anon or authenticated) — reads PostgREST''s own '
  'request.headers setting, not a table. Authorization: none — the caller '
  'only ever learns its own connecting IP address. Rate limiting: n/a, no '
  'external effect. Expected errors: none — resolves to null if the header '
  'is unavailable rather than raising.';

comment on function public.request_user_agent() is
  'Authentication: any (anon or authenticated) — reads PostgREST''s own '
  'request.headers setting, not a table. Authorization: none — the caller '
  'only ever learns its own request''s user agent string. Rate limiting: '
  'n/a, no external effect. Expected errors: none — resolves to null if the '
  'header is unavailable rather than raising.';

comment on function public.slug_is_available(text) is
  'Authentication: anon. Authorization: none — answers only "is this slug '
  'free", never any tenant''s actual data. Rate limiting: none yet — relies '
  'on tenant-signup''s own per-IP throttling for the flow this feeds. '
  'Expected errors: none raised — invalid format is returned as '
  '{available:false, reason:''INVALID_FORMAT''} in the payload, not an '
  'exception.';

comment on function public.support_ticket_create(jsonb) is
  'Authentication: anon. Authorization: none beyond the request itself — '
  'this IS the public ticket-submission entry point; every ticket it '
  'creates is filed under the platform tenant''s own support queue '
  '(tenant_id = platform_tenant_id()), never a company''s data. Rate '
  'limiting: yes — max 5 tickets per requester_email per rolling hour, '
  'enforced in-function. Expected errors: REQUESTER_NAME_REQUIRED, '
  'REQUESTER_EMAIL_INVALID, SUBJECT_REQUIRED, BODY_REQUIRED, '
  'CATEGORY_INVALID, TOO_MANY_TICKETS, PLATFORM_TENANT_MISSING.';

comment on function public.support_ticket_reply_public(text, text, text) is
  'Authentication: anon, authenticated by a per-ticket access token (not a '
  'session) — see migration 202608050025''s header for why ticket_no+email '
  'alone was replaced with this token. Authorization: the token must match '
  'the ticket''s own stored access_token; wrong or missing token is '
  'indistinguishable from a not-found ticket in the response. Rate '
  'limiting: none yet — todo, tracked here rather than assumed. Expected '
  'errors: TICKET_NOT_FOUND, ACCESS_TOKEN_INVALID, TICKET_CLOSED, '
  'BODY_REQUIRED.';

comment on function public.tenant_public_profile(text) is
  'Authentication: anon. Authorization: none — returns only a company''s '
  'already-public branding/identity fields (name, logo, theme, contact '
  'channels), the same information its own public landing page renders to '
  'anyone. Rate limiting: none yet — todo. Expected errors: none raised — '
  'an unknown or suspended slug resolves to null/empty fields rather than '
  'an exception, so the public site can render a graceful "not found" state.';

comment on function public.verify_document(text) is
  'Authentication: anon. Authorization: none beyond knowing the verification '
  'code itself — the code is the credential (see generate_verify_code()''s '
  'own comment on why it is a random, non-enumerable 12-digit value, not a '
  'sequential one). Only returns document/company/approval-chain fields '
  'already meant for public verification, never internal form data_json. '
  'Rate limiting: enforced at the verify-api edge function layer (60 '
  'lookups/minute per caller), not in this RPC itself. Expected errors: '
  'none raised — an unknown or invalid code resolves to {valid:false}, not '
  'an exception, so a forged printout fails verification gracefully rather '
  'than with a stack trace.';

-- ----------------------------------------------------------------------------
-- Mandatory closer: every migration batch ends with this, or a GRANT earlier
-- in the same file (or an earlier migration) re-materializes the function's
-- ACL to include PUBLIC. See docs' "PUBLIC-execute footgun" note.
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
