-- ============================================================================
-- Dynamic Approval Chain — open-ended semantics
--
-- Correction to 202607290009: there is NO "final approval" and NO closing.
-- A request becomes 'Approved' as soon as ONE approval is recorded against the
-- LAST approval role of its scheme, and it stays fully routable afterwards:
--   * three different people may all approve under the same last role, and
--   * the company may still add a fourth approver later (e.g. a large amount),
-- without the request ever being locked out of the chain.
-- The governing record is always the printed approval-role chain itself.
-- ============================================================================

-- The requester dispatches the form to one person for one approval role.
-- Sendable in every state the requester physically holds it, including Approved.
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
begin
  select * into v_form from public.forms where id = p_form_id and not is_deleted for update;
  if not found then
    raise exception 'FORM_NOT_FOUND';
  end if;
  if v_form.requested_by <> auth.uid() then
    raise exception 'ONLY_REQUESTER_CAN_SUBMIT';
  end if;
  if v_form.status not in ('Draft', 'Submitted', 'Returned', 'Rejected', 'InApproval', 'Approved') then
    raise exception 'FORM_NOT_SENDABLE';
  end if;
  -- The request can only be dispatched by whoever physically holds it.
  if v_form.current_assignee_id is not null and v_form.current_assignee_id <> auth.uid() then
    raise exception 'FORM_HELD_BY_ANOTHER_USER';
  end if;
  if p_to_user = auth.uid() then
    raise exception 'CANNOT_SEND_TO_SELF';
  end if;

  select * into v_target from public.users where id = p_to_user and is_active and not coalesce(is_deleted, false);
  if not found then
    raise exception 'TARGET_USER_NOT_FOUND';
  end if;

  select ar.* into v_role
  from public.approval_roles ar
  where ar.id = p_role_id and ar.is_active;
  if not found then
    raise exception 'APPROVAL_ROLE_NOT_FOUND';
  end if;
  if v_role.code = 'REQUESTER' then
    raise exception 'REQUESTER_ROLE_NOT_SENDABLE';
  end if;

  -- The chosen role must belong to the scheme linked to the form template.
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
      verify_code = coalesce(verify_code, public.generate_verify_code()),
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

-- The current assignee acts on the form.
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
begin
  select * into v_form from public.forms where id = p_form_id and not is_deleted for update;
  if not found then
    raise exception 'FORM_NOT_FOUND';
  end if;
  if v_form.status <> 'InApproval' or v_form.current_assignee_id is distinct from auth.uid() then
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

  if p_action = 'Approve' then
    v_next_assignee := v_form.requested_by;
    v_next_role := null;
    -- Approved once the acting role is the last role of the template scheme.
    -- No completion, no lock: further approvals of the same or another role
    -- can still be requested afterwards.
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
    select * into v_target from public.users where id = p_to_user and is_active and not coalesce(is_deleted, false);
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
      -- Timestamp of the most recent last-role approval; never cleared, since
      -- an approved request may keep moving through the chain.
      approval_completed_on = case when v_next_status = 'Approved' then now() else approval_completed_on end,
      pending_since = case when v_next_assignee is not null then now() else pending_since end,
      updated_on = now()
  where id = p_form_id;

  select * into v_form from public.forms where id = p_form_id;
  return jsonb_build_object('id', v_form.id, 'status', v_form.status, 'approved', coalesce(v_is_last_role, false));
end;
$$;
grant execute on function public.approval_act(uuid, text, uuid, uuid, text) to authenticated;

-- An approved request stays with its requester so it can be routed further.
update public.forms
set current_assignee_id = requested_by
where status = 'Approved' and current_assignee_id is null and not is_deleted;
