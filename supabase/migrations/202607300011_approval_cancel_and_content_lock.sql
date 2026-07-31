-- ============================================================================
-- Dynamic Approval Chain — cancellation + hard content lock
--
-- Business rule: once a request has been sent into the chain its content is
-- frozen for good. A mistake is not corrected in place — the request is
-- cancelled (it stays visible to everyone as 'Cancelled', permanently out of
-- the chain) and a new request is raised instead.
-- ============================================================================

-- Content is editable only before the request ever entered the chain.
drop policy if exists "requesters update editable forms" on public.forms;
create policy "requesters update editable forms" on public.forms
  for update to authenticated
  using (
    auth.uid() = requested_by
    and status in ('Draft', 'Returned')
    and approval_started_on is null
  )
  with check (
    auth.uid() = requested_by
    and status in ('Draft', 'Submitted', 'Returned')
    and approval_started_on is null
  );

-- The requester cancels a request they currently hold. Terminal state: a
-- cancelled request can never be edited, resent or reopened.
create or replace function public.approval_cancel(
  p_form_id uuid,
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
  v_seq integer;
begin
  select * into v_form from public.forms where id = p_form_id and not is_deleted for update;
  if not found then
    raise exception 'FORM_NOT_FOUND';
  end if;
  if v_form.requested_by <> auth.uid() then
    raise exception 'ONLY_REQUESTER_CAN_CANCEL';
  end if;
  if v_form.status = 'Cancelled' then
    raise exception 'FORM_ALREADY_CANCELLED';
  end if;
  -- Cannot be pulled out of someone else's hands.
  if v_form.current_assignee_id is not null and v_form.current_assignee_id <> auth.uid() then
    raise exception 'FORM_HELD_BY_ANOTHER_USER';
  end if;

  select * into v_actor from public.users where id = auth.uid();
  select coalesce(max(seq), 0) + 1 into v_seq from public.form_approval_transactions where form_id = p_form_id;

  insert into public.form_approval_transactions
    (form_id, seq, actor_id, actor_name, actor_signature_url, action, approval_role_id, comment)
  values
    (p_form_id, v_seq, auth.uid(), public.approval_display_name(v_actor), v_actor.signature_url,
     'Cancel', null, nullif(trim(p_comment), ''));

  update public.forms
  set status = 'Cancelled',
      current_assignee_id = null,
      current_approval_role_id = null,
      return_to_user_id = null,
      -- Cancelled requests stay publicly verifiable so a circulating printout
      -- can always be checked against its real state.
      verify_code = coalesce(verify_code, public.generate_verify_code()),
      cancelled_on = now(),
      updated_on = now()
  where id = p_form_id;

  return jsonb_build_object('id', p_form_id, 'status', 'Cancelled');
end;
$$;
grant execute on function public.approval_cancel(uuid, text) to authenticated;

-- Guard the terminal state at the engine level too.
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
  if v_form.status = 'Cancelled' then
    raise exception 'FORM_CANCELLED';
  end if;
  if v_form.status not in ('Draft', 'Submitted', 'Returned', 'Rejected', 'InApproval', 'Approved') then
    raise exception 'FORM_NOT_SENDABLE';
  end if;
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

-- Expose the flags the client needs to decide what a holder may still do.
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
    select distinct on (f.id) jsonb_build_object(
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
  ) history;

  return jsonb_build_object('inbox', v_inbox, 'outbox', v_outbox, 'history', v_history);
end;
$$;
grant execute on function public.approval_center_feed() to authenticated;

-- Reference lookup for the header search (own requests only).
create or replace function public.approval_search_my_requests(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_needle text := '%' || trim(p_query) || '%';
begin
  if length(coalesce(trim(p_query), '')) < 2 then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(entry)
    from (
      select jsonb_build_object(
        'id', f.id,
        'reference_no', f.reference_no,
        'verify_code', f.verify_code,
        'status', f.status,
        'template_name', tpl.name, 'template_name_ar', tpl.name_ar, 'template_name_en', tpl.name_en,
        'updated_on', f.updated_on
      ) as entry
      from public.forms f
      join public.templates tpl on tpl.id = f.template_id
      where not f.is_deleted
        and (f.requested_by = auth.uid() or f.employee_id = auth.uid() or f.current_assignee_id = auth.uid())
        and (
          f.reference_no ilike v_needle
          or f.verify_code ilike v_needle
          or tpl.name ilike v_needle
          or coalesce(tpl.name_ar, '') ilike v_needle
          or coalesce(tpl.name_en, '') ilike v_needle
        )
      order by f.updated_on desc
      limit 6
    ) matches
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.approval_search_my_requests(text) to authenticated;
