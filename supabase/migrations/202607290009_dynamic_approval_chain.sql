-- ============================================================================
-- Dynamic Approval Chain (DAC)
-- Approval Roles + Approval Schemes + Signature Slots + Approval History.
-- No predefined workflow: every hop is a transaction (Submit / Approve / Reject
-- / RequestReview / Reviewed / Delegate / Forward / Recall / Reassign).
-- All state transitions run through SECURITY DEFINER functions so the chain
-- rules are enforced server-side and cannot be bypassed from the client.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Approval roles (the capacity a person signs with: Direct Manager, HR, ...)
-- ----------------------------------------------------------------------------
create table if not exists public.approval_roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text not null,
  description text,
  display_order smallint not null default 0,
  is_system boolean not null default false,
  is_active boolean not null default true,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. Approval schemes (ordered set of roles = the signature slots of a form)
-- ----------------------------------------------------------------------------
create table if not exists public.approval_schemes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text not null,
  description text,
  is_active boolean not null default true,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create table if not exists public.approval_scheme_roles (
  id uuid primary key default gen_random_uuid(),
  scheme_id uuid not null references public.approval_schemes(id) on delete cascade,
  approval_role_id uuid not null references public.approval_roles(id) on delete cascade,
  display_order smallint not null default 1,
  is_required boolean not null default true,
  unique (scheme_id, approval_role_id)
);

alter table public.templates
  add column if not exists approval_scheme_id uuid references public.approval_schemes(id);

-- ----------------------------------------------------------------------------
-- 3. Forms: live chain state + tamper-proof verification code
-- ----------------------------------------------------------------------------
alter table public.forms
  add column if not exists current_assignee_id uuid references public.users(id),
  add column if not exists current_approval_role_id uuid references public.approval_roles(id),
  add column if not exists return_to_user_id uuid references public.users(id),
  add column if not exists verify_code text unique,
  add column if not exists approval_started_on timestamptz,
  add column if not exists approval_completed_on timestamptz,
  add column if not exists pending_since timestamptz;

alter table public.forms drop constraint if exists forms_status_check;
alter table public.forms
  add constraint forms_status_check
  check (status in ('Draft', 'Submitted', 'Returned', 'Cancelled', 'InApproval', 'Approved', 'Rejected'));

-- Requesters may also edit forms that bounced back as Rejected (fix & resend).
drop policy if exists "requesters update editable forms" on public.forms;
create policy "requesters update editable forms" on public.forms
  for update to authenticated
  using (
    auth.uid() = requested_by
    and status in ('Draft', 'Returned', 'Rejected')
  )
  with check (
    auth.uid() = requested_by
    and status in ('Draft', 'Submitted', 'Cancelled', 'Rejected')
  );

create index if not exists idx_forms_current_assignee
  on public.forms (current_assignee_id, status);

-- ----------------------------------------------------------------------------
-- 4. Approval history: every movement is one immutable transaction
-- ----------------------------------------------------------------------------
create table if not exists public.form_approval_transactions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.forms(id) on delete cascade,
  seq integer not null,
  actor_id uuid not null references public.users(id),
  -- Snapshots: the printed/verified document must not change if the user later
  -- renames themselves or replaces their signature.
  actor_name text not null,
  actor_signature_url text,
  action text not null check (action in (
    'Submit', 'Approve', 'Reject', 'RequestReview', 'Reviewed',
    'Delegate', 'Forward', 'Recall', 'Reassign', 'Cancel'
  )),
  approval_role_id uuid references public.approval_roles(id),
  to_user_id uuid references public.users(id),
  to_user_name text,
  comment text,
  created_on timestamptz not null default now(),
  unique (form_id, seq)
);

create index if not exists idx_form_approval_tx_form on public.form_approval_transactions (form_id, seq);
create index if not exists idx_form_approval_tx_to_user on public.form_approval_transactions (to_user_id);
create index if not exists idx_form_approval_tx_actor on public.form_approval_transactions (actor_id);
create index if not exists idx_form_approval_tx_created on public.form_approval_transactions (created_on);

-- ----------------------------------------------------------------------------
-- 5. Permissions
-- ----------------------------------------------------------------------------
insert into public.permissions (code, module, description)
values ('Approvals.Manage', 'Approvals', 'Manage approval roles, schemes, tracking and reassignment')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'Approvals.Manage'
where r.code in ('PLATFORM_ADMIN', 'SYSTEM_ADMIN')
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- 6. Helper functions (SECURITY DEFINER breaks RLS recursion between
--    forms <-> transactions policies)
-- ----------------------------------------------------------------------------
create or replace function public.is_form_participant(target_form uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.forms f
    where f.id = target_form
      and (f.requested_by = auth.uid() or f.employee_id = auth.uid() or f.current_assignee_id = auth.uid())
  ) or exists (
    select 1 from public.form_approval_transactions tx
    where tx.form_id = target_form
      and (tx.actor_id = auth.uid() or tx.to_user_id = auth.uid())
  );
$$;
grant execute on function public.is_form_participant(uuid) to authenticated;

create or replace function public.approval_display_name(target_user public.users)
returns text
language sql
immutable
as $$
  select coalesce(nullif(target_user.full_name, ''), nullif(target_user.name_ar, ''), nullif(target_user.name_en, ''), target_user.email, 'مستخدم');
$$;

-- Large, non-sequential, hard-to-guess reference for public verification.
create or replace function public.generate_verify_code()
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  candidate text;
begin
  loop
    -- 15 random digits (never starts with 0): ~9x10^14 possibilities.
    candidate := (floor(random() * 8e14) + 1e14)::bigint::text;
    exit when not exists (select 1 from public.forms where verify_code = candidate);
  end loop;
  return candidate;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. RLS for the new tables
-- ----------------------------------------------------------------------------
alter table public.approval_roles enable row level security;
alter table public.approval_schemes enable row level security;
alter table public.approval_scheme_roles enable row level security;
alter table public.form_approval_transactions enable row level security;

drop policy if exists "authenticated read approval roles" on public.approval_roles;
create policy "authenticated read approval roles" on public.approval_roles
  for select to authenticated using (true);
drop policy if exists "approval admins manage roles" on public.approval_roles;
create policy "approval admins manage roles" on public.approval_roles
  for all to authenticated
  using (public.has_permission('Approvals.Manage'))
  with check (public.has_permission('Approvals.Manage'));

drop policy if exists "authenticated read approval schemes" on public.approval_schemes;
create policy "authenticated read approval schemes" on public.approval_schemes
  for select to authenticated using (true);
drop policy if exists "approval admins manage schemes" on public.approval_schemes;
create policy "approval admins manage schemes" on public.approval_schemes
  for all to authenticated
  using (public.has_permission('Approvals.Manage'))
  with check (public.has_permission('Approvals.Manage'));

drop policy if exists "authenticated read scheme roles" on public.approval_scheme_roles;
create policy "authenticated read scheme roles" on public.approval_scheme_roles
  for select to authenticated using (true);
drop policy if exists "approval admins manage scheme roles" on public.approval_scheme_roles;
create policy "approval admins manage scheme roles" on public.approval_scheme_roles
  for all to authenticated
  using (public.has_permission('Approvals.Manage'))
  with check (public.has_permission('Approvals.Manage'));

-- History is read-only for participants; writes happen only via the functions.
drop policy if exists "participants read approval history" on public.form_approval_transactions;
create policy "participants read approval history" on public.form_approval_transactions
  for select to authenticated
  using (public.is_form_participant(form_id) or public.has_permission('Approvals.Manage'));

-- Participants (current assignee, past actors) can read the form itself.
drop policy if exists "approval participants read forms" on public.forms;
create policy "approval participants read forms" on public.forms
  for select to authenticated
  using (public.is_form_participant(id) or public.has_permission('Approvals.Manage'));

-- Approvers can read the evaluation details attached to a form they handle.
drop policy if exists "approval participants read evaluations" on public.performance_evaluations;
create policy "approval participants read evaluations" on public.performance_evaluations
  for select to authenticated
  using (public.is_form_participant(form_id));

-- Approvers can see attachment metadata of forms in their chain.
drop policy if exists "approval participants read attachments" on public.form_attachments;
create policy "approval participants read attachments" on public.form_attachments
  for select to authenticated
  using (public.is_form_participant(form_id));

-- Approvers can download the attachment files (path = <owner>/<form_id>/<file>).
do $$
begin
  drop policy if exists "approval participants read files" on storage.objects;
  create policy "approval participants read files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'form-attachments'
    and public.is_form_participant(((storage.foldername(name))[2])::uuid)
  );
exception when others then
  raise notice 'storage policy skipped: %', sqlerrm;
end $$;

-- ----------------------------------------------------------------------------
-- 8. Chain engine: submit / act / recall / reassign
-- ----------------------------------------------------------------------------

-- The requester dispatches the form to one person for one approval role.
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
  if v_form.status not in ('Draft', 'Submitted', 'Returned', 'Rejected', 'InApproval') then
    raise exception 'FORM_NOT_SENDABLE';
  end if;
  if v_form.status = 'InApproval' and v_form.current_assignee_id is distinct from auth.uid() then
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
      approval_completed_on = null,
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
  v_completed boolean := false;
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
    v_next_status := 'InApproval';
    v_next_assignee := v_form.requested_by;
    v_next_role := null;
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

  -- Auto-complete: once every required role of the scheme carries an approval,
  -- the request is fully approved.
  if p_action = 'Approve' then
    select not exists (
      select 1
      from public.templates tpl
      join public.approval_scheme_roles sr on sr.scheme_id = tpl.approval_scheme_id
      join public.approval_roles ar on ar.id = sr.approval_role_id
      where tpl.id = v_form.template_id
        and sr.is_required
        and ar.code <> 'REQUESTER'
        and not exists (
          select 1 from public.form_approval_transactions tx
          where tx.form_id = p_form_id and tx.action = 'Approve' and tx.approval_role_id = sr.approval_role_id
        )
    ) into v_completed;
    if v_completed then
      v_next_status := 'Approved';
      v_next_assignee := null;
      v_next_role := null;
    end if;
  end if;

  update public.forms
  set status = v_next_status,
      current_assignee_id = v_next_assignee,
      current_approval_role_id = v_next_role,
      return_to_user_id = v_next_return,
      approval_completed_on = case when v_next_status = 'Approved' then now() else null end,
      pending_since = case when v_next_assignee is not null then now() else pending_since end,
      updated_on = now()
  where id = p_form_id;

  select * into v_form from public.forms where id = p_form_id;
  return jsonb_build_object('id', v_form.id, 'status', v_form.status, 'completed', v_completed);
end;
$$;
grant execute on function public.approval_act(uuid, text, uuid, uuid, text) to authenticated;

-- The requester can pull the form back only while the recipient has not acted.
create or replace function public.approval_recall(p_form_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_form public.forms%rowtype;
  v_actor public.users%rowtype;
  v_last public.form_approval_transactions%rowtype;
  v_seq integer;
begin
  select * into v_form from public.forms where id = p_form_id and not is_deleted for update;
  if not found then
    raise exception 'FORM_NOT_FOUND';
  end if;
  if v_form.requested_by <> auth.uid() then
    raise exception 'ONLY_REQUESTER_CAN_RECALL';
  end if;
  if v_form.status <> 'InApproval' then
    raise exception 'FORM_NOT_IN_APPROVAL';
  end if;

  select * into v_last from public.form_approval_transactions
  where form_id = p_form_id order by seq desc limit 1;
  if v_last.action <> 'Submit' or v_last.actor_id <> auth.uid() then
    raise exception 'RECIPIENT_ALREADY_ACTED';
  end if;

  select * into v_actor from public.users where id = auth.uid();
  select coalesce(max(seq), 0) + 1 into v_seq from public.form_approval_transactions where form_id = p_form_id;

  insert into public.form_approval_transactions
    (form_id, seq, actor_id, actor_name, actor_signature_url, action, approval_role_id, comment)
  values
    (p_form_id, v_seq, auth.uid(), public.approval_display_name(v_actor), v_actor.signature_url, 'Recall', v_form.current_approval_role_id, null);

  update public.forms
  set current_assignee_id = auth.uid(),
      current_approval_role_id = null,
      return_to_user_id = null,
      pending_since = now(),
      updated_on = now()
  where id = p_form_id;

  return jsonb_build_object('id', p_form_id, 'status', 'InApproval');
end;
$$;
grant execute on function public.approval_recall(uuid) to authenticated;

-- Administrators can move a stuck request to another user.
create or replace function public.approval_admin_reassign(
  p_form_id uuid,
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
  v_seq integer;
begin
  if not public.has_permission('Approvals.Manage') then
    raise exception 'PERMISSION_DENIED';
  end if;
  select * into v_form from public.forms where id = p_form_id and not is_deleted for update;
  if not found then
    raise exception 'FORM_NOT_FOUND';
  end if;
  if v_form.status <> 'InApproval' then
    raise exception 'FORM_NOT_IN_APPROVAL';
  end if;
  select * into v_target from public.users where id = p_to_user and is_active and not coalesce(is_deleted, false);
  if not found then
    raise exception 'TARGET_USER_NOT_FOUND';
  end if;

  select * into v_actor from public.users where id = auth.uid();
  select coalesce(max(seq), 0) + 1 into v_seq from public.form_approval_transactions where form_id = p_form_id;

  insert into public.form_approval_transactions
    (form_id, seq, actor_id, actor_name, actor_signature_url, action, approval_role_id, to_user_id, to_user_name, comment)
  values
    (p_form_id, v_seq, auth.uid(), public.approval_display_name(v_actor), v_actor.signature_url,
     'Reassign', v_form.current_approval_role_id, p_to_user, public.approval_display_name(v_target), nullif(trim(p_comment), ''));

  update public.forms
  set current_assignee_id = p_to_user,
      return_to_user_id = null,
      pending_since = now(),
      updated_on = now()
  where id = p_form_id;

  return jsonb_build_object('id', p_form_id, 'assignee', p_to_user);
end;
$$;
grant execute on function public.approval_admin_reassign(uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 9. Read models: Approval Center feed, form detail, dashboard, verification
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
      'template_name', tpl.name, 'template_name_ar', tpl.name_ar, 'template_name_en', tpl.name_en,
      'assignee_id', f.current_assignee_id,
      'assignee_name', case when asg.id is not null then public.approval_display_name(asg) end,
      'role_code', ar.code, 'role_name_ar', ar.name_ar, 'role_name_en', ar.name_en,
      'pending_since', f.pending_since,
      'approval_started_on', f.approval_started_on,
      'approval_completed_on', f.approval_completed_on,
      'updated_on', f.updated_on,
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

create or replace function public.approval_form_detail(p_form_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_form public.forms%rowtype;
  v_result jsonb;
begin
  select * into v_form from public.forms where id = p_form_id and not is_deleted;
  if not found then
    raise exception 'FORM_NOT_FOUND';
  end if;
  if not (public.is_form_participant(p_form_id) or public.has_permission('Approvals.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;

  select jsonb_build_object(
    'form', jsonb_build_object(
      'id', f.id,
      'reference_no', f.reference_no,
      'verify_code', f.verify_code,
      'status', f.status,
      'data_json', f.data_json,
      'submission_mode', f.submission_mode,
      'created_on', f.created_on,
      'submitted_on', f.submitted_on,
      'approval_started_on', f.approval_started_on,
      'approval_completed_on', f.approval_completed_on,
      'pending_since', f.pending_since,
      'requested_by', f.requested_by,
      'requester_name', public.approval_display_name(req),
      'employee_name', case when emp.id is not null then public.approval_display_name(emp) end,
      'current_assignee_id', f.current_assignee_id,
      'current_assignee_name', case when asg.id is not null then public.approval_display_name(asg) end,
      'current_role_id', f.current_approval_role_id,
      'return_to_user_id', f.return_to_user_id,
      'template_id', f.template_id,
      'template_code', tpl.code,
      'template_name', tpl.name, 'template_name_ar', tpl.name_ar, 'template_name_en', tpl.name_en
    ),
    'scheme', (
      select jsonb_build_object(
        'id', s.id, 'code', s.code, 'name_ar', s.name_ar, 'name_en', s.name_en,
        'roles', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', ar.id, 'code', ar.code, 'name_ar', ar.name_ar, 'name_en', ar.name_en,
            'display_order', sr.display_order, 'is_required', sr.is_required
          ) order by sr.display_order)
          from public.approval_scheme_roles sr
          join public.approval_roles ar on ar.id = sr.approval_role_id
          where sr.scheme_id = s.id
        ), '[]'::jsonb)
      )
      from public.approval_schemes s
      where s.id = tpl.approval_scheme_id
    ),
    'transactions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', tx.id, 'seq', tx.seq, 'action', tx.action,
        'actor_id', tx.actor_id, 'actor_name', tx.actor_name, 'actor_signature_url', tx.actor_signature_url,
        'role_id', tx.approval_role_id, 'role_code', txar.code, 'role_name_ar', txar.name_ar, 'role_name_en', txar.name_en,
        'to_user_id', tx.to_user_id, 'to_user_name', tx.to_user_name,
        'comment', tx.comment, 'created_on', tx.created_on
      ) order by tx.seq)
      from public.form_approval_transactions tx
      left join public.approval_roles txar on txar.id = tx.approval_role_id
      where tx.form_id = f.id
    ), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'storage_path', a.storage_path, 'file_size', a.file_size))
      from public.form_attachments a where a.form_id = f.id
    ), '[]'::jsonb)
  ) into v_result
  from public.forms f
  join public.templates tpl on tpl.id = f.template_id
  left join public.users req on req.id = f.requested_by
  left join public.users emp on emp.id = f.employee_id
  left join public.users asg on asg.id = f.current_assignee_id
  where f.id = p_form_id;

  return v_result;
end;
$$;
grant execute on function public.approval_form_detail(uuid) to authenticated;

-- Raw material for the Approval Center dashboard (admins only).
create or replace function public.approval_dashboard_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
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
    ), '[]'::jsonb),
    'completed', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'status', f.status,
        'approval_started_on', f.approval_started_on, 'approval_completed_on', f.approval_completed_on,
        'updated_on', f.updated_on
      ))
      from public.forms f
      where f.status in ('Approved', 'Rejected') and not f.is_deleted
        and f.updated_on >= now() - interval '90 days'
    ), '[]'::jsonb),
    'transactions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'action', tx.action, 'actor_id', tx.actor_id, 'actor_name', tx.actor_name,
        'department', coalesce(dep.name_ar, u.department),
        'created_on', tx.created_on
      ))
      from public.form_approval_transactions tx
      left join public.users u on u.id = tx.actor_id
      left join public.departments dep on dep.id = u.department_id
      where tx.created_on >= now() - interval '90 days'
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.approval_dashboard_data() to authenticated;

-- Public verification: anyone with the code can confirm the request and its
-- approval chain (names, roles, actions and dates — no form content, no
-- comments) to detect forged printouts.
create or replace function public.approval_verify(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'valid', true,
    'reference_no', f.reference_no,
    'verify_code', f.verify_code,
    'status', f.status,
    'template_name', tpl.name, 'template_name_ar', tpl.name_ar, 'template_name_en', tpl.name_en,
    'requester_name', public.approval_display_name(req),
    'employee_name', case when emp.id is not null then public.approval_display_name(emp) end,
    'submitted_on', f.submitted_on,
    'approval_started_on', f.approval_started_on,
    'approval_completed_on', f.approval_completed_on,
    'timeline', coalesce((
      select jsonb_agg(jsonb_build_object(
        'seq', tx.seq, 'action', tx.action, 'actor_name', tx.actor_name,
        'role_name_ar', ar.name_ar, 'role_name_en', ar.name_en,
        'to_user_name', tx.to_user_name, 'created_on', tx.created_on
      ) order by tx.seq)
      from public.form_approval_transactions tx
      left join public.approval_roles ar on ar.id = tx.approval_role_id
      where tx.form_id = f.id
    ), '[]'::jsonb)
  ) into v_result
  from public.forms f
  join public.templates tpl on tpl.id = f.template_id
  left join public.users req on req.id = f.requested_by
  left join public.users emp on emp.id = f.employee_id
  where f.verify_code = trim(p_code) and not f.is_deleted;

  if v_result is null then
    return jsonb_build_object('valid', false);
  end if;
  return v_result;
end;
$$;
grant execute on function public.approval_verify(text) to authenticated;
grant execute on function public.approval_verify(text) to anon;

-- ----------------------------------------------------------------------------
-- 10. updated_on triggers
-- ----------------------------------------------------------------------------
drop trigger if exists set_approval_roles_updated_on on public.approval_roles;
create trigger set_approval_roles_updated_on
  before update on public.approval_roles
  for each row execute function public.set_updated_on();

drop trigger if exists set_approval_schemes_updated_on on public.approval_schemes;
create trigger set_approval_schemes_updated_on
  before update on public.approval_schemes
  for each row execute function public.set_updated_on();

-- ----------------------------------------------------------------------------
-- 11. Seed roles, schemes and template links
-- ----------------------------------------------------------------------------
insert into public.approval_roles (code, name_ar, name_en, display_order, is_system) values
  ('REQUESTER', 'منشئ الطلب', 'Requester', 0, true),
  ('DIRECT_MANAGER', 'المدير المباشر', 'Direct Manager', 10, true),
  ('HR', 'الموارد البشرية', 'Human Resources', 20, true),
  ('RECOMMENDATION', 'التوصية', 'Recommendation', 30, true),
  ('WAREHOUSE_OFFICER', 'مسؤول المستودع', 'Warehouse Officer', 40, true),
  ('PURCHASING_MANAGER', 'مدير المشتريات', 'Purchasing Manager', 50, true),
  ('FINAL_APPROVAL', 'الاعتماد', 'Final Approval', 60, true)
on conflict (code) do nothing;

insert into public.approval_schemes (code, name_ar, name_en, description) values
  ('STANDARD', 'الاعتماد القياسي', 'Standard Approval', 'منشئ الطلب ثم التوصية ثم الاعتماد'),
  ('HR_CHAIN', 'سلسلة الموارد البشرية', 'HR Chain', 'منشئ الطلب ثم المدير المباشر ثم الموارد البشرية ثم الاعتماد'),
  ('PURCHASING_CHAIN', 'سلسلة المشتريات', 'Purchasing Chain', 'منشئ الطلب ثم مسؤول المستودع ثم مدير المشتريات')
on conflict (code) do nothing;

insert into public.approval_scheme_roles (scheme_id, approval_role_id, display_order)
select s.id, r.id, v.display_order
from (values
  ('STANDARD', 'REQUESTER', 1),
  ('STANDARD', 'RECOMMENDATION', 2),
  ('STANDARD', 'FINAL_APPROVAL', 3),
  ('HR_CHAIN', 'REQUESTER', 1),
  ('HR_CHAIN', 'DIRECT_MANAGER', 2),
  ('HR_CHAIN', 'HR', 3),
  ('HR_CHAIN', 'FINAL_APPROVAL', 4),
  ('PURCHASING_CHAIN', 'REQUESTER', 1),
  ('PURCHASING_CHAIN', 'WAREHOUSE_OFFICER', 2),
  ('PURCHASING_CHAIN', 'PURCHASING_MANAGER', 3)
) as v(scheme_code, role_code, display_order)
join public.approval_schemes s on s.code = v.scheme_code
join public.approval_roles r on r.code = v.role_code
on conflict (scheme_id, approval_role_id) do nothing;

-- Existing templates use the standard scheme by default.
update public.templates
set approval_scheme_id = (select id from public.approval_schemes where code = 'STANDARD')
where approval_scheme_id is null
  and code in ('FM-SH-PER-O-24-0053\V1.3', 'FM-SH-INM-R-23-0025\V1.2');
