-- ============================================================================
-- 046 — Global Validation, independent fresh-eyes audit fixes
--
-- A second, genuinely blind review (no access to migration 045's findings or
-- fix history) found 11 further real, independently-verified problems —
-- including a Blocker-severity cross-tenant signature disclosure this
-- project's own prior "accepted gap" reasoning had missed, and a regression
-- this very migration series introduced in 045 while fixing an unrelated bug.
-- Every fix below is re-verified against a freshly rebuilt isolated instance.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. [Blocker/Security] employee_asset_is_known_user() (migration
--    202608050026) gates the "employees read private signatures" storage
--    policy but never checks tenant membership — any authenticated user on
--    the whole platform can read any other tenant's employee's signature
--    image by path, enabling document forgery. Every sibling policy on the
--    same bucket (insert/update/delete) and every other private-asset bucket
--    in the project (employee-assets) correctly scopes to the caller. A
--    signature must stay visible to same-tenant colleagues reviewing a
--    document (approval_form_detail returns actor_signature_url to whoever
--    can see the form), so the fix is same-tenant, not owner-only.
-- ----------------------------------------------------------------------------
create or replace function public.employee_asset_is_known_user(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.users u
    where u.id::text = split_part(coalesce(p_path, ''), '/', 1)
      and not u.is_deleted
      and u.tenant_id = public.current_tenant_id()
  );
$$;

comment on function public.employee_asset_is_known_user(text) is
  'Gates read access to the private employee-signatures bucket: the path''s '
  'first segment must resolve to a real, non-deleted, SAME-TENANT user (not '
  'ownership-only — signatures must stay visible to any colleague reviewing '
  'a document they appear on). Fixed in migration 046 — previously had no '
  'tenant check at all, letting any authenticated platform user read any '
  'other tenant''s employee signatures.';

-- ----------------------------------------------------------------------------
-- 2. [Major/Security] storage_register() (migration 202608040018) trusted a
--    client-supplied owner_id instead of forcing auth.uid(), letting any
--    tenant member plant a storage_objects row misattributed to a colleague.
--    Confirmed zero legitimate callers ever pass a different owner_id — the
--    only real caller (AuthContext.jsx, avatar/signature upload) always
--    passes the caller's own session.user.id — so removing the override
--    entirely is a pure close, not a behavior change for any real flow.
--
--    Same function: storage_register()/storage_unregister() charged the
--    shared STORAGE_BYTES tenant quota for Core-layer uploads too, though
--    storage_can_upload()'s own quota check (and contract §8) only applies
--    it to Extended. Every Core upload (avatars, signatures, tenant
--    branding) was silently inflating the same counter that gates a
--    company's paid Extended-storage uploads.
-- ----------------------------------------------------------------------------
create or replace function public.storage_register(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_layer text := coalesce(nullif(trim(coalesce(p_payload ->> 'layer', '')), ''), 'Extended');
  v_size bigint := coalesce((p_payload ->> 'file_size')::bigint, 0);
  v_mime text := nullif(trim(coalesce(p_payload ->> 'mime_type', '')), '');
  v_path text := nullif(trim(coalesce(p_payload ->> 'path', '')), '');
  v_name text := nullif(trim(coalesce(p_payload ->> 'file_name', '')), '');
  v_provider text;
  v_check jsonb;
  v_row public.storage_objects%rowtype;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  if v_path is null then raise exception 'PATH_REQUIRED'; end if;
  if v_name is null then raise exception 'FILE_NAME_REQUIRED'; end if;

  v_check := public.storage_can_upload(v_layer, v_mime, v_size);
  if not coalesce((v_check ->> 'allowed')::boolean, false) then
    raise exception '%', coalesce(v_check ->> 'reason', 'UPLOAD_REFUSED');
  end if;

  v_provider := coalesce(
    nullif(trim(coalesce(p_payload ->> 'provider_code', '')), ''),
    case when v_layer = 'Core' then 'supabase' else (v_check ->> 'provider') end,
    'supabase'
  );

  insert into public.storage_objects (
    tenant_id, layer, provider_code, bucket, path, external_id, file_name, mime_type,
    file_size, checksum, owner_id, entity_type, entity_id, metadata
  )
  values (
    v_tenant, v_layer, v_provider,
    nullif(trim(coalesce(p_payload ->> 'bucket', '')), ''),
    v_path,
    nullif(trim(coalesce(p_payload ->> 'external_id', '')), ''),
    v_name, v_mime, v_size,
    nullif(trim(coalesce(p_payload ->> 'checksum', '')), ''),
    auth.uid(),
    nullif(trim(coalesce(p_payload ->> 'entity_type', '')), ''),
    nullif(p_payload ->> 'entity_id', '')::uuid,
    coalesce(p_payload -> 'metadata', '{}'::jsonb)
  )
  returning * into v_row;

  if v_layer = 'Extended' then
    perform public.tenant_quota_consume('STORAGE_BYTES', v_size, v_tenant);
    update public.tenant_storage_config
    set used_bytes = greatest(used_bytes + v_size, 0)
    where tenant_id = v_tenant;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'layer', v_row.layer,
    'provider_code', v_row.provider_code,
    'bucket', v_row.bucket,
    'path', v_row.path,
    'file_name', v_row.file_name,
    'file_size', v_row.file_size,
    'created_on', v_row.created_on
  );
end;
$$;
grant execute on function public.storage_register(jsonb) to authenticated;

comment on function public.storage_register(jsonb) is
  'Registers an already-uploaded object in the storage ledger. owner_id is '
  'always auth.uid() (fixed in migration 046 — previously a client-supplied '
  'owner_id in the payload was trusted, letting any tenant member plant a '
  'ledger row misattributed to a colleague; no real caller ever needed the '
  'override). STORAGE_BYTES quota is only charged for layer=Extended (fixed '
  'in migration 046 — Core uploads were silently inflating the same quota '
  'counter that gates paid Extended-storage uploads, contradicting contract '
  '§8''s documented "Core is platform-paid, not quota-gated" design).';

create or replace function public.storage_unregister(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_row public.storage_objects%rowtype;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;

  select * into v_row from public.storage_objects
  where id = p_id and tenant_id = v_tenant and not is_deleted;
  if not found then raise exception 'STORAGE_OBJECT_NOT_FOUND'; end if;

  if not (
    v_row.owner_id = auth.uid()
    or v_row.created_by = auth.uid()
    or public.has_permission('Storage.Manage')
    or public.is_platform_operator()
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  update public.storage_objects set is_deleted = true where id = v_row.id;

  if v_row.layer = 'Extended' then
    perform public.tenant_quota_consume('STORAGE_BYTES', -v_row.file_size, v_tenant);
    update public.tenant_storage_config
    set used_bytes = greatest(used_bytes - v_row.file_size, 0)
    where tenant_id = v_tenant;
  end if;

  return jsonb_build_object('id', v_row.id, 'released_bytes', v_row.file_size);
end;
$$;
grant execute on function public.storage_unregister(uuid) to authenticated;

comment on function public.storage_unregister(uuid) is
  'Releases a storage ledger row. STORAGE_BYTES quota is only released for '
  'layer=Extended, matching storage_register()''s Extended-only charge '
  '(fixed in migration 046 alongside it).';

-- ----------------------------------------------------------------------------
-- 3. [Minor/Security] approval_act()/approval_submit() (migration 044)
--    resolved the p_to_user routing target with no tenant_id filter, unlike
--    the sibling lookup in approval_admin_reassign() a few dozen lines
--    earlier in the same file. The composite FK on forms.current_assignee_id
--    already blocks an actual cross-tenant redirect, but the unfiltered
--    lookup is still a narrow cross-tenant user-ID enumeration oracle
--    (FK-violation vs TARGET_USER_NOT_FOUND leaks whether a UUID is an
--    active user anywhere on the platform, not just the caller's own).
--    Every other line below is byte-for-byte identical to the live 044 body
--    — only the one target-user lookup in each function gains
--    "and tenant_id = v_form.tenant_id".
-- ----------------------------------------------------------------------------
create or replace function public.approval_act(
  p_form_id uuid,
  p_action text,
  p_to_user uuid default null,
  p_role_id uuid default null,
  p_comment text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_form public.forms%rowtype;
  v_actor public.users%rowtype;
  v_target public.users%rowtype;
  v_seq integer;
  v_role_id uuid;
  v_next_status text;
  v_next_assignee uuid;
  v_next_role uuid;
  v_next_return uuid;
  v_is_last_role boolean := false;
  v_allow_self boolean;
begin
  select * into v_form from public.forms where id = p_form_id and not is_deleted for update;
  if not found then
    raise exception 'FORM_NOT_FOUND';
  end if;
  if v_form.status <> 'InApproval' then
    raise exception 'FORM_NOT_IN_APPROVAL';
  end if;
  if v_form.current_assignee_id is distinct from auth.uid() then
    raise exception 'NOT_CURRENT_ASSIGNEE';
  end if;

  -- A reviewer (RequestReview target) has exactly one exit: Reviewed.
  if v_form.return_to_user_id is not null and p_action <> 'Reviewed' then
    raise exception 'REVIEWER_CAN_ONLY_REVIEW';
  end if;
  if v_form.return_to_user_id is null and p_action = 'Reviewed' then
    raise exception 'NO_REVIEW_REQUESTED';
  end if;

  select * into v_actor from public.users where id = auth.uid();
  v_role_id := v_form.current_approval_role_id;
  v_next_return := null;

  -- Workflow Governance Rule (FourthUpdate.md): "منع اعتماد المنشئ لنفس الطلب
  -- إلا إذا سمحت خطوة الاعتماد بذلك صراحة".
  if p_action in ('Approve', 'Reject') and auth.uid() = v_form.requested_by then
    select coalesce(sr.allow_self_approval, false) into v_allow_self
    from public.templates tpl
    join public.approval_scheme_roles sr
      on sr.scheme_id = tpl.approval_scheme_id and sr.approval_role_id = v_role_id
    where tpl.id = v_form.template_id;
    if not coalesce(v_allow_self, false) then
      raise exception 'SELF_APPROVAL_NOT_ALLOWED';
    end if;
  end if;

  if p_action = 'Approve' then
    v_next_assignee := v_form.requested_by;
    v_next_role := null;
    select v_role_id = (
      select sr.approval_role_id
      from public.templates tpl
      join public.approval_scheme_roles sr on sr.scheme_id = tpl.approval_scheme_id
      join public.approval_roles ar on ar.id = sr.approval_role_id and ar.code <> 'REQUESTER'
      where tpl.id = v_form.template_id
      order by sr.display_order desc
      limit 1
    ) into v_is_last_role;
    v_next_status := case when coalesce(v_is_last_role, false) then 'Approved' else 'InApproval' end;
  elsif p_action = 'Reject' then
    v_next_status := 'Rejected';
    v_next_assignee := v_form.requested_by;
    v_next_role := null;
  elsif p_action = 'Reviewed' then
    v_next_status := 'InApproval';
    v_next_assignee := v_form.return_to_user_id;
    v_next_role := v_form.current_approval_role_id;
  elsif p_action = 'RequestReview' then
    if p_to_user is null then raise exception 'REVIEWER_REQUIRED'; end if;
    v_next_status := 'InApproval';
    v_next_assignee := p_to_user;
    v_next_role := v_form.current_approval_role_id;
    v_next_return := auth.uid();
  elsif p_action = 'Delegate' then
    if p_to_user is null then raise exception 'DELEGATE_REQUIRED'; end if;
    v_next_status := 'InApproval';
    v_next_assignee := p_to_user;
    v_next_role := v_form.current_approval_role_id;
  elsif p_action = 'Forward' then
    if p_to_user is null then raise exception 'FORWARD_TARGET_REQUIRED'; end if;
    if p_role_id is null then raise exception 'FORWARD_ROLE_REQUIRED'; end if;
    if not exists (
      select 1
      from public.templates tpl
      join public.approval_scheme_roles sr on sr.scheme_id = tpl.approval_scheme_id
      join public.approval_roles ar on ar.id = sr.approval_role_id and ar.code <> 'REQUESTER'
      where tpl.id = v_form.template_id and sr.approval_role_id = p_role_id
    ) then
      raise exception 'ROLE_NOT_IN_TEMPLATE_SCHEME';
    end if;
    v_next_status := 'InApproval';
    v_next_assignee := p_to_user;
    v_next_role := p_role_id;
    v_role_id := p_role_id;
  else
    raise exception 'UNSUPPORTED_ACTION';
  end if;

  if p_to_user is not null then
    if p_to_user = auth.uid() then
      raise exception 'CANNOT_SEND_TO_SELF';
    end if;
    select * into v_target from public.users
    where id = p_to_user and tenant_id = v_form.tenant_id and is_active and not coalesce(is_deleted, false);
    if not found then
      raise exception 'TARGET_USER_NOT_FOUND';
    end if;
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq from public.form_approval_transactions where form_id = p_form_id;

  insert into public.form_approval_transactions
    (form_id, seq, actor_id, actor_name, actor_signature_url, action, approval_role_id, to_user_id, to_user_name, comment)
  values
    (p_form_id, v_seq, auth.uid(), public.approval_display_name(v_actor), v_actor.signature_url,
     p_action, v_role_id, p_to_user,
     case when v_target.id is not null then public.approval_display_name(v_target) end,
     nullif(trim(p_comment), ''));

  update public.forms
  set status = v_next_status,
      current_assignee_id = v_next_assignee,
      current_approval_role_id = v_next_role,
      return_to_user_id = v_next_return,
      approval_completed_on = case when v_next_status = 'Approved' then now() else approval_completed_on end,
      pending_since = case when v_next_assignee is not null then now() else pending_since end,
      updated_on = now()
  where id = p_form_id;

  select * into v_form from public.forms where id = p_form_id;
  return jsonb_build_object('id', v_form.id, 'status', v_form.status, 'approved', coalesce(v_is_last_role, false));
end;
$$;
grant execute on function public.approval_act(uuid, text, uuid, uuid, text) to authenticated;

create or replace function public.approval_submit(
  p_form_id uuid,
  p_role_id uuid,
  p_to_user uuid,
  p_comment text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_form public.forms%rowtype;
  v_actor public.users%rowtype;
  v_target public.users%rowtype;
  v_role public.approval_roles%rowtype;
  v_seq integer;
  v_requires_final boolean;
begin
  select * into v_form from public.forms where id = p_form_id and not is_deleted for update;
  if not found then
    raise exception 'FORM_NOT_FOUND';
  end if;
  if v_form.requested_by <> auth.uid() then
    raise exception 'ONLY_REQUESTER_CAN_SUBMIT';
  end if;
  if v_form.status = 'Cancelled' then
    raise exception 'FORM_CANCELLED';
  end if;
  if v_form.status not in ('Draft', 'Submitted', 'Returned', 'Rejected', 'InApproval', 'Approved') then
    raise exception 'FORM_NOT_SENDABLE';
  end if;
  if v_form.current_assignee_id is not null and v_form.current_assignee_id <> auth.uid() then
    raise exception 'FORM_HELD_BY_ANOTHER_USER';
  end if;

  select requires_final_approval into v_requires_final
  from public.templates where id = v_form.template_id;

  if coalesce(v_requires_final, true) = false then
    if p_role_id is not null or p_to_user is not null then
      raise exception 'NO_APPROVAL_TEMPLATE_TAKES_NO_ROUTING';
    end if;

    select * into v_actor from public.users where id = auth.uid();
    select coalesce(max(seq), 0) + 1 into v_seq from public.form_approval_transactions where form_id = p_form_id;

    insert into public.form_approval_transactions
      (form_id, seq, actor_id, actor_name, actor_signature_url, action, comment)
    values
      (p_form_id, v_seq, auth.uid(), public.approval_display_name(v_actor), v_actor.signature_url,
       'Submit', nullif(trim(p_comment), ''));

    update public.forms
    set status = 'Submitted',
        current_assignee_id = null,
        current_approval_role_id = null,
        return_to_user_id = null,
        submitted_on = coalesce(submitted_on, now()),
        updated_on = now()
    where id = p_form_id;

    select * into v_form from public.forms where id = p_form_id;
    return jsonb_build_object('id', v_form.id, 'status', v_form.status, 'verify_code', v_form.verify_code);
  end if;

  if p_to_user = auth.uid() then
    raise exception 'CANNOT_SEND_TO_SELF';
  end if;

  select * into v_target from public.users
  where id = p_to_user and tenant_id = v_form.tenant_id and is_active and not coalesce(is_deleted, false);
  if not found then
    raise exception 'TARGET_USER_NOT_FOUND';
  end if;

  select ar.* into v_role from public.approval_roles ar where ar.id = p_role_id and ar.is_active;
  if not found then
    raise exception 'APPROVAL_ROLE_NOT_FOUND';
  end if;
  if v_role.code = 'REQUESTER' then
    raise exception 'REQUESTER_ROLE_NOT_SENDABLE';
  end if;

  if not exists (
    select 1
    from public.templates tpl
    join public.approval_scheme_roles sr on sr.scheme_id = tpl.approval_scheme_id
    where tpl.id = v_form.template_id and sr.approval_role_id = p_role_id
  ) then
    raise exception 'ROLE_NOT_IN_TEMPLATE_SCHEME';
  end if;

  select * into v_actor from public.users where id = auth.uid();
  select coalesce(max(seq), 0) + 1 into v_seq from public.form_approval_transactions where form_id = p_form_id;

  insert into public.form_approval_transactions
    (form_id, seq, actor_id, actor_name, actor_signature_url, action, approval_role_id, to_user_id, to_user_name, comment)
  values
    (p_form_id, v_seq, auth.uid(), public.approval_display_name(v_actor), v_actor.signature_url,
     'Submit', p_role_id, p_to_user, public.approval_display_name(v_target), nullif(trim(p_comment), ''));

  update public.forms
  set status = 'InApproval',
      current_assignee_id = p_to_user,
      current_approval_role_id = p_role_id,
      return_to_user_id = null,
      verify_code = coalesce(verify_code, public.generate_verify_code(v_form.tenant_id)),
      approval_started_on = coalesce(approval_started_on, now()),
      pending_since = now(),
      submitted_on = coalesce(submitted_on, now()),
      updated_on = now()
  where id = p_form_id;

  select * into v_form from public.forms where id = p_form_id;
  return jsonb_build_object('id', v_form.id, 'status', v_form.status, 'verify_code', v_form.verify_code);
end;
$$;
grant execute on function public.approval_submit(uuid, uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. [Major/Architecture] support_ticket_create_internal() — migration 045
--    itself, while fixing the ticket-numbering bug, silently dropped the
--    insert into support_messages that seeds the thread with the ticket's
--    opening message (present in the version it replaced, and still present
--    in the public path support_ticket_create()). Restoring it: without it,
--    support_ticket_detail()/support_console() (built purely from
--    support_messages) show an empty thread and message_count=0 for every
--    InApp ticket until someone replies, even though the requester's actual
--    complaint text exists in support_tickets.body — a silent regression
--    introduced in this migration series, found and fixed in the same pass.
-- ----------------------------------------------------------------------------
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

  insert into public.support_messages (tenant_id, ticket_id, author_type, author_user_id, author_name, body, is_internal)
  values (v_tenant, v_ticket.id, 'Requester', v_user.id, v_ticket.requester_name, v_ticket.body, false);

  return jsonb_build_object('id', v_ticket.id, 'ticket_no', v_ticket.ticket_no, 'status', v_ticket.status);
end;
$$;
grant execute on function public.support_ticket_create_internal(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. [Minor/Contract §21] 3 of the 11 ANON_CALLABLE functions
--    (tests/tenancy-invariants.test.mjs) still lacked the four-part comment
--    after migration 045 — that migration's own header said "8 of the 11
--    ... had none at all," implying the other 3 were adequate, but they
--    weren't touched and aren't compliant either.
-- ----------------------------------------------------------------------------
comment on function public.approval_verify(text) is
  'Authentication: anon. Authorization: none beyond knowing the code itself '
  '— returns only whether a request is a validly Approved form, no internal '
  'data_json. Rate limiting: none yet — todo (this RPC is unused by the '
  'client; public.verify_document is what the verify page actually calls, '
  'and that one already has verify-api edge-function rate limiting). '
  'Expected errors: none raised — an unknown/invalid code resolves to '
  '{valid:false}, not an exception.';

comment on function public.record_login(boolean, text, text, text) is
  'Authentication: anon or authenticated — this IS the login-attempt '
  'recorder, called both before and after auth resolves. Authorization: a '
  'successful-login event requires auth.uid() to match the account being '
  'recorded; failed-login events require no auth. Rate limiting: none on '
  'this RPC itself — it is what login_attempts/security_events use to '
  'detect abuse downstream, not something rate-limited in front of. '
  'Expected errors: none raised — always returns {recorded:true}, with '
  'account-existence never revealed to an anonymous caller.';

comment on function public.support_ticket_status(text, text) is
  'Authentication: anon. Authorization: the second argument is the '
  'per-ticket access token issued at creation (not the requester''s email) '
  '— it must match the ticket''s own stored access_token. Rate limiting: '
  'none yet — todo. Expected errors: none raised — a wrong ticket_no or '
  'token resolves to {found:false}, not an exception, so a guess is '
  'indistinguishable from a typo.';

-- ----------------------------------------------------------------------------
-- 6. [Major/Correctness, contract §18] saveApprovalScheme() (src/data/
--    approvalService.js) replaced a scheme's role list with a delete then a
--    separate insert as two independent, non-transactional client calls —
--    a failure between them (network blip, bad role id, transient RLS
--    error) leaves the scheme with zero roles, breaking every template
--    routed through it until someone notices and re-saves it correctly.
--    This wraps the replace in one RPC, one transaction — the scheme row
--    itself (upsertByCode, a single-row upsert, already atomic on its own)
--    is untouched by this change.
-- ----------------------------------------------------------------------------
create or replace function public.approval_scheme_set_roles(p_scheme_id uuid, p_roles jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not public.has_permission('Approvals.Manage') then
    raise exception 'PERMISSION_DENIED';
  end if;
  if not exists (select 1 from public.approval_schemes where id = p_scheme_id) then
    raise exception 'APPROVAL_SCHEME_NOT_FOUND';
  end if;

  delete from public.approval_scheme_roles where scheme_id = p_scheme_id;

  insert into public.approval_scheme_roles (scheme_id, approval_role_id, display_order, allow_self_approval)
  select
    p_scheme_id,
    (entry ->> 'roleId')::uuid,
    coalesce((entry ->> 'displayOrder')::integer, 1),
    coalesce((entry ->> 'allowSelfApproval')::boolean, false)
  from jsonb_array_elements(coalesce(p_roles, '[]'::jsonb)) as entry;
end;
$$;
revoke all on function public.approval_scheme_set_roles(uuid, jsonb) from public;
grant execute on function public.approval_scheme_set_roles(uuid, jsonb) to authenticated;

comment on function public.approval_scheme_set_roles(uuid, jsonb) is
  'Replaces an approval scheme''s ordered role list atomically (added in '
  'migration 046 — the frontend previously did this as a separate delete '
  'then insert, two independent client calls; a failure between them left '
  'the scheme with zero roles, contract §18''s exact "sequential client '
  'calls with partial failure possible in between" violation). p_roles is '
  'a jsonb array of {roleId, displayOrder, allowSelfApproval?}.';

-- ----------------------------------------------------------------------------
-- Mandatory closer: every migration batch ends with this, or a GRANT earlier
-- in the same file (or an earlier migration) re-materializes the function's
-- PUBLIC-execute footgun (see 202608050037's header for what that means).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
