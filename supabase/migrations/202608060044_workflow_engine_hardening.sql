-- ============================================================================
-- 044 — Update 4, Batch 2: Workflow Engine hardening
--
-- Scope decision (see docs/update4_batch2_workflow_engine.md for the full
-- write-up): the platform already has a working Dynamic Approval Chain (DAC,
-- migration 202607290009 onward). FourthUpdate.md's "Workflow" section does
-- not ask for a second engine — Module Ownership rule 2 forbids that outright
-- — it asks for six specific hardenings on top of the one that exists:
--
--   1. Self-approval prevention (per-step opt-in, default No).
--   2. A real, freshly-discovered cross-tenant bug in approval_admin_reassign
--      (same class migration 032 already fixed for approval_form_detail, but
--      never applied here) — fixed as part of touching this engine again.
--   3. "Final Approval" as a template-level concept, decoupled from any role
--      name, including the one case the current engine cannot express at
--      all: a template that needs no approval chain (survey/suggestion/
--      complaint — FourthUpdate.md's own examples).
--   4. Participants / Watchers — a genuinely new concept; nothing to extend.
--   5. Migrating the two live forms off the legacy, write-only, undeletable
--      form_attachments bypass (already flagged as a deliberate follow-up in
--      migration 040's own header) onto the Attachment Framework.
--   6. An admin "every submitted request, filtered" screen — the pending-only
--      approval_dashboard_data() is not that, and never claimed to be.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. approval_submit() and approval_cancel() have been silently broken since
--    202608040012 — a genuinely live, pre-existing bug, found only because
--    this migration's own live-Postgres verification is the first time
--    approval_submit() has actually been exercised end to end since that
--    migration shipped.
--
--    202608040012 added a SECOND overload, generate_verify_code(p_tenant_id
--    uuid default null), and re-pointed the original generate_verify_code()
--    at it as a convenience wrapper — intending both spellings to keep
--    working. But in real PostgreSQL, a bare call generate_verify_code() is
--    genuinely ambiguous between "the true 0-arg overload" and "the 1-arg
--    overload with its default filled in": every call to the bare form
--    raises `function public.generate_verify_code() is not unique`. Verified
--    directly against a live Postgres 17 instance with the full migration
--    chain applied — reproduces on every call, not an artifact of this
--    migration's own test data.
--
--    Both approval_submit() and approval_cancel() (202607300011, still the
--    live bodies today) call the bare, ambiguous form when first assigning a
--    form's verify_code — i.e. every form's first submission into the chain
--    has been failing outright. approval_submit() is redefined below anyway
--    (section 5) with the fix folded in; approval_cancel() gets the same
--    one-line fix here, byte-for-byte identical otherwise. Not fixed at the
--    source (dropping one of the two generate_verify_code() overloads in
--    202608040012 itself) because that migration is already committed
--    history — every call site is fixed to pass the argument explicitly
--    instead, which is unambiguous and, if anything, more correct than
--    relying on the callee's own current_tenant_id() lookup.
-- ----------------------------------------------------------------------------
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
      verify_code = coalesce(verify_code, public.generate_verify_code(v_form.tenant_id)),
      cancelled_on = now(),
      updated_on = now()
  where id = p_form_id;

  return jsonb_build_object('id', p_form_id, 'status', 'Cancelled');
end;
$$;
grant execute on function public.approval_cancel(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 1. Self-approval prevention: per-step opt-in, default No
-- ----------------------------------------------------------------------------
alter table public.approval_scheme_roles
  add column if not exists allow_self_approval boolean not null default false;

-- ----------------------------------------------------------------------------
-- 2. approval_admin_reassign() could act on any company's form
--
-- Identical bug class to the one migration 032 fixed in approval_form_detail:
-- has_permission('Approvals.Manage') only proves the caller manages approvals
-- in their OWN tenant — it says nothing about which tenant p_form_id belongs
-- to. The lookup below had no tenant filter, so any company's admin holding
-- this (commonly granted) permission could reassign ANY other company's
-- in-flight form to any of that other company's own users (the composite FK
-- on forms.current_assignee_id stops redirecting it into the caller's own
-- tenant, but does nothing to stop acting on a foreign tenant's form in the
-- first place, or probing for its existence). Fixed the same way 032 fixed
-- its case: scope the initial lookup to the caller's own tenant.
-- ----------------------------------------------------------------------------
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
  v_tenant uuid := public.current_tenant_id();
  v_form public.forms%rowtype;
  v_actor public.users%rowtype;
  v_target public.users%rowtype;
  v_seq integer;
begin
  if v_tenant is null then
    raise exception 'NO_TENANT_CONTEXT';
  end if;
  if not public.has_permission('Approvals.Manage') then
    raise exception 'PERMISSION_DENIED';
  end if;
  select * into v_form from public.forms
  where id = p_form_id and tenant_id = v_tenant and not is_deleted for update;
  if not found then
    raise exception 'FORM_NOT_FOUND';
  end if;
  if v_form.status <> 'InApproval' then
    raise exception 'FORM_NOT_IN_APPROVAL';
  end if;
  select * into v_target from public.users
  where id = p_to_user and tenant_id = v_tenant and is_active and not coalesce(is_deleted, false);
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

comment on function public.approval_admin_reassign(uuid, uuid, text) is
  'Reassigns a stuck request, scoped to the caller''s own tenant (fixed 044 — '
  'previously matched approval_form_detail''s pre-032 bug: a permission check '
  'with no tenant filter on the row it acts on).';

-- ----------------------------------------------------------------------------
-- 3. approval_act(): self-approval guard + explicit closed-request error
--
-- Two changes to the one existing function, everything else byte-for-byte
-- identical to the live 202607290010 body:
--   a) the combined "wrong status OR wrong assignee" guard is split into two
--      explicit errors — behaviourally identical (both conditions still
--      reject exactly the same calls) but now distinguishable by the client.
--   b) a genuinely new guard: the request's own creator may not Approve or
--      Reject it, even if some other participant legitimately routed it back
--      to them (Forward/Delegate/Reassign — nothing in the engine stops
--      that), unless the specific scheme role they are acting under was
--      configured with Allow Self Approval = Yes. approval_submit already
--      refuses to send a request to yourself, so this cannot happen on the
--      very first hop — it can only happen via a later hop routing back to
--      the requester, which is exactly why the guard has to live at the
--      point of judgement (Approve/Reject), not at the point of routing.
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
      approval_completed_on = case when v_next_status = 'Approved' then now() else approval_completed_on end,
      pending_since = case when v_next_assignee is not null then now() else pending_since end,
      updated_on = now()
  where id = p_form_id;

  select * into v_form from public.forms where id = p_form_id;
  return jsonb_build_object('id', v_form.id, 'status', v_form.status, 'approved', coalesce(v_is_last_role, false));
end;
$$;
grant execute on function public.approval_act(uuid, text, uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. Final Approval as a template-level concept
--
-- requires_final_approval defaults to true so every EXISTING template keeps
-- needing its assigned scheme exactly as today (non-breaking). Setting it to
-- false is the new capability: a template that legitimately needs zero
-- approval steps (FourthUpdate.md's own examples — استبيان/اقتراح/بلاغ). This
-- is not a duplicate of the scheme mechanism: the engine already decides
-- "decisive approval" by scheme display_order, not by a role's name (see
-- v_is_last_role above), so "final" was already decoupled from role naming —
-- the gap was only ever "can a template skip the chain entirely."
--
-- final_approver_user_id is a non-enforcing suggestion only: when set, the
-- send-to-final-role UI can pre-select this user, but the fully manual,
-- pick-anyone-from-the-directory routing model every other hop already has
-- is unchanged — nothing forces the suggestion to be used.
--
-- Position-, Attribute-, and Role-based final approver resolution (all three
-- named in FourthUpdate.md alongside Employee) are deliberately NOT built
-- here: all need a "who currently holds X" resolution service that does not
-- exist for this purpose anywhere in the platform yet (every scheme-role
-- assignee today is a manually-picked uuid, see the DAC research this
-- migration is based on) — building one as a side effect of hardening the
-- approval engine would itself be exactly the kind of undeclared new module
-- this batch's own governance rules forbid. Logged as a genuine, named gap,
-- not a silent omission (a fresh-eyes review caught that an earlier version
-- of this comment named only Position/Attribute and dropped Role).
-- ----------------------------------------------------------------------------
alter table public.templates
  add column if not exists requires_final_approval boolean not null default true,
  add column if not exists final_approver_user_id uuid references public.users(id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_templates_final_approver_same_tenant') then
    alter table public.templates
      add constraint fk_templates_final_approver_same_tenant
      foreign key (tenant_id, final_approver_user_id) references public.users (tenant_id, id);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 5. approval_submit(): templates with requires_final_approval = false skip
--    the chain entirely and go straight to a terminal 'Submitted' status.
--
-- 'Submitted' is already a valid forms.status value (present in the CHECK
-- constraint since 202607290009) but was never actually reachable as a rest
-- state before this — every existing path goes Draft -> InApproval directly.
-- It is a safe terminal choice: the forms UPDATE policy's USING clause only
-- ever allows edits while status is Draft or Returned, so a form landing on
-- Submitted is already correctly locked from further edits by existing RLS,
-- with no policy change needed.
--
-- No verify_code is generated for this path — there is no approval chain to
-- publicly verify, and generating one for content nobody approved would be
-- misleading on the public verification page.
--
-- Every other line below is byte-for-byte identical to the live
-- 202607300011 body.
-- ----------------------------------------------------------------------------
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
-- 6. Participants / Watchers
--
-- Nothing to extend — the DAC research behind this migration confirmed zero
-- existing "can view but not approve" or "notify-only" concept anywhere.
-- Approver stays exactly what it already is (a scheme-role slot). Participant
-- = can open and read the form (folded into is_form_participant() below, the
-- same read-gate every other form-reading policy/RPC already trusts — see
-- that function's own comment for why this matters beyond just this table).
-- Watcher = gets notified on every subsequent transaction, matching
-- FourthUpdate.md's literal wording ("يستقبل إشعار فقط" — notification only)
-- exactly: NOT folded into is_form_participant(), on purpose (a fresh-eyes
-- review caught that the first draft of this migration granted Watchers the
-- same read access as Participants, which transitively exposed
-- performance_evaluations/attachments to anyone a chain-holder chose to add
-- as a Watcher — a real confidentiality gap, not a hypothetical one; see that
-- function's comment). The consequence — a Watcher who clicks their own
-- notification link gets PERMISSION_DENIED instead of the form — is a real,
-- known UX gap, logged here rather than silently accepted, and left for a
-- follow-up that can scope a narrower "read the chain status only" grant
-- instead of full form read.
-- ----------------------------------------------------------------------------
create table if not exists public.form_collaborators (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  form_id uuid not null references public.forms(id) on delete cascade,
  user_id uuid not null references public.users(id),
  role text not null check (role in ('Participant', 'Watcher')),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  unique (form_id, user_id)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_form_collaborators_form_same_tenant') then
    alter table public.form_collaborators
      add constraint fk_form_collaborators_form_same_tenant
      foreign key (tenant_id, form_id) references public.forms (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_form_collaborators_user_same_tenant') then
    alter table public.form_collaborators
      add constraint fk_form_collaborators_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id);
  end if;
end $$;

-- Every current access path (form_collaborator_add/remove/list,
-- is_form_participant, notify_form_watchers) filters by form_id; nothing
-- queries by user_id alone yet, so a (tenant_id, user_id) index would be
-- pure write-path overhead with no read benefit today (fresh-eyes
-- performance review) — add it if/when a "forms I'm watching" screen
-- actually needs it, not speculatively.
create index if not exists idx_form_collaborators_form on public.form_collaborators (tenant_id, form_id) where not is_deleted;

drop trigger if exists apply_row_defaults on public.form_collaborators;
create trigger apply_row_defaults before insert or update on public.form_collaborators
for each row execute function public.apply_row_defaults();

alter table public.form_collaborators enable row level security;

drop policy if exists "tenant isolation" on public.form_collaborators;
create policy "tenant isolation" on public.form_collaborators
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "participants read collaborators" on public.form_collaborators;
create policy "participants read collaborators" on public.form_collaborators
  for select to authenticated
  using (not is_deleted and (user_id = auth.uid() or public.is_form_participant(form_id) or public.has_permission('Approvals.Manage')));

-- Widens who counts as a form participant to also include collaborators —
-- but ONLY role = 'Participant' ("يشاهد" / view), never 'Watcher'
-- ("يستقبل إشعار فقط" / notification only, FourthUpdate.md). This function is
-- not local to this feature: it is also the sole gate on the pre-existing
-- "approval participants read evaluations" RLS policy on
-- public.performance_evaluations (202607290009), the legacy form_attachments
-- read policy, and the form-attachments storage.objects read policy (same
-- migration) — none of which have any other condition. A first fresh-eyes
-- review of this file found that including Watchers here let whoever
-- currently holds a Performance Evaluation (or any Approvals.Manage holder)
-- grant an arbitrary same-tenant employee full read access to another
-- employee's scores/comments/attachments with one click in the shipped
-- CollaboratorsPanel UI — a real confidentiality gap, not a hypothetical one.
-- Excluding Watchers here means a Watcher who clicks through their own
-- notification link gets PERMISSION_DENIED rather than the form — a real,
-- known UX gap (logged, not fixed in this batch) — but the safe default when
-- "notify-only" and "grant confidential read access" conflict is to notify
-- without granting read, not the reverse.
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
  ) or exists (
    select 1 from public.form_collaborators c
    where c.form_id = target_form and c.user_id = auth.uid() and c.role = 'Participant' and not c.is_deleted
  );
$$;
grant execute on function public.is_form_participant(uuid) to authenticated;

-- Who may add a collaborator: the requester, or whoever currently holds the
-- form — the same boundary the engine already trusts for Forward/Delegate,
-- and adding a watcher is a strictly lighter action than either of those.
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
  if not (
    auth.uid() = v_form.requested_by
    or auth.uid() = v_form.current_assignee_id
    or public.has_permission('Approvals.Manage')
  ) then
    raise exception 'PERMISSION_DENIED';
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

create or replace function public.form_collaborator_remove(p_form_id uuid, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_form public.forms%rowtype;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  select * into v_form from public.forms where id = p_form_id and tenant_id = v_tenant and not is_deleted;
  if not found then raise exception 'FORM_NOT_FOUND'; end if;
  if not (
    auth.uid() = v_form.requested_by
    or auth.uid() = v_form.current_assignee_id
    or auth.uid() = p_user_id
    or public.has_permission('Approvals.Manage')
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  update public.form_collaborators
  set is_deleted = true, deleted_by = auth.uid(), deleted_date = now(), updated_on = now()
  where form_id = p_form_id and user_id = p_user_id and tenant_id = v_tenant and not is_deleted;
end;
$$;
revoke all on function public.form_collaborator_remove(uuid, uuid) from public;
grant execute on function public.form_collaborator_remove(uuid, uuid) to authenticated;

create or replace function public.form_collaborator_list(p_form_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_form_participant(p_form_id) then
    raise exception 'PERMISSION_DENIED';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'user_id', c.user_id, 'role', c.role,
      'user_name', coalesce(u.full_name, u.name_ar, u.name_en, u.email),
      'created_on', c.created_on
    ) order by c.created_on)
    from public.form_collaborators c
    join public.users u on u.id = c.user_id
    where c.tenant_id = public.current_tenant_id() and c.form_id = p_form_id and not c.is_deleted
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.form_collaborator_list(uuid) from public;
grant execute on function public.form_collaborator_list(uuid) to authenticated;

-- FourthUpdate.md's Watcher tier exists specifically to "receive a
-- notification only". notify_approval_assignment() (migration 202608040015)
-- already notifies the NEXT assignee on Submit/Forward/Delegate/
-- RequestReview/Reassign; it deliberately says nothing about Approve/Reject/
-- Reviewed/Cancel, and nothing at all reaches a Watcher, who by definition
-- never becomes an assignee. This trigger is additive and disjoint from that
-- one: it only ever notifies form_collaborators rows with role = 'Watcher',
-- on every transaction (including the final Approve/Reject that the existing
-- trigger is silent on), and never notifies the actor about their own action.
create or replace function public.notify_form_watchers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_watchers uuid[];
begin
  select array_agg(c.user_id) into v_watchers
  from public.form_collaborators c
  where c.form_id = new.form_id and c.role = 'Watcher' and not c.is_deleted and c.user_id <> new.actor_id;

  if v_watchers is not null and array_length(v_watchers, 1) > 0 then
    perform public.notify_many(
      v_watchers, 'Approval', 'form_watcher_update',
      'تحديث على طلب تتابعه', 'Update on a request you are watching',
      coalesce(new.actor_name, '') || ' — ' || new.action, coalesce(new.actor_name, '') || ' — ' || new.action,
      '/app/approvals?form=' || new.form_id::text
    );
  end if;
  return new;
end;
$$;

drop trigger if exists notify_form_watchers on public.form_approval_transactions;
create trigger notify_form_watchers
after insert on public.form_approval_transactions
for each row execute function public.notify_form_watchers();

-- ----------------------------------------------------------------------------
-- 7. Admin: every submitted request, filtered
--
-- approval_dashboard_data() is pending-only and takes no filters — it was
-- never meant to be this screen. Tenant-scoped from its very first line,
-- unlike approval_admin_reassign's gap fixed at the top of this migration:
-- the lesson from that bug is applied here on day one, not retrofitted.
--
-- Tag filtering reads public.entity_tags directly rather than calling a
-- separate Tags RPC: this function is already its own audience-checked
-- wrapper (gated on Approvals.Manage), exactly the pattern entity_tags'
-- own migration (042) documents for any module that needs a different
-- audience than entity_tag_list()'s Tags.Manage-only default — introducing
-- a second RPC just to re-check a different permission for the same read
-- would add friction (an admin without Tags.Manage could not filter their
-- own approvals list) without adding any real safety. Nothing in the shipped
-- app tags a Form yet (Tags stays scoped to what Batch 1 wired it into), so
-- this parameter is inert today by construction, same as attachFile()/
-- tagCreate() being complete primitives ahead of a UI consumer elsewhere in
-- this codebase — the corresponding frontend filter control was removed
-- (fresh-eyes review: a filter that can never match looks broken, not
-- forward-looking, when it's the only thing presented to an admin).
--
-- Two supporting indexes a fresh-eyes performance review found missing:
-- the admin list's core access path (tenant + non-Draft, ordered by
-- created_on) had no index at all, and the approver-filter subquery had no
-- composite covering (form_id, actor_id).
-- ----------------------------------------------------------------------------
create index if not exists idx_forms_tenant_created
  on public.forms (tenant_id, created_on desc)
  where not is_deleted;

create index if not exists idx_form_approval_tx_form_actor
  on public.form_approval_transactions (form_id, actor_id);

create or replace function public.approval_admin_requests_list(
  p_template_id uuid default null,
  p_status text default null,
  p_department_id uuid default null,
  p_requester_id uuid default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_tag_id uuid default null,
  p_approver_id uuid default null,
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  if not public.has_permission('Approvals.Manage') then
    raise exception 'PERMISSION_DENIED';
  end if;

  -- jsonb_agg() with no GROUP BY collapses its FROM/WHERE row set into ONE
  -- output row (the array) before any outer LIMIT is ever evaluated — a
  -- trailing "limit N" on a bare aggregate query is a silent no-op, not a
  -- row cap (caught by a fresh-eyes performance review: the very first,
  -- unfiltered load of this screen was fetching, joining, and serializing
  -- the tenant's ENTIRE non-Draft form history every time). Filtering,
  -- ordering, and limiting now happen in the subquery, which produces one
  -- row per form — LIMIT there genuinely bounds the row set the aggregate
  -- then folds into a single JSON array.
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', page.id, 'reference_no', page.reference_no, 'status', page.status,
      'template_id', page.template_id,
      'template_name', page.template_name, 'template_name_ar', page.template_name_ar, 'template_name_en', page.template_name_en,
      'requester_id', page.requested_by,
      'requester_name', public.approval_display_name(page.req_row),
      'requester_department', coalesce(page.dep_name_ar, page.req_department),
      'current_assignee_name', case when page.asg_id is not null then public.approval_display_name(page.asg_row) end,
      'submitted_on', page.submitted_on, 'approval_started_on', page.approval_started_on,
      'approval_completed_on', page.approval_completed_on, 'created_on', page.created_on
    ) order by page.created_on desc)
    from (
      select
        f.id, f.reference_no, f.status, f.template_id, f.requested_by, f.submitted_on,
        f.approval_started_on, f.approval_completed_on, f.created_on,
        tpl.name as template_name, tpl.name_ar as template_name_ar, tpl.name_en as template_name_en,
        req as req_row, req.department as req_department,
        asg.id as asg_id, asg as asg_row,
        dep.name_ar as dep_name_ar
      from public.forms f
      join public.templates tpl on tpl.id = f.template_id
      left join public.users req on req.id = f.requested_by
      left join public.users asg on asg.id = f.current_assignee_id
      left join public.departments dep on dep.id = req.department_id
      where f.tenant_id = v_tenant
        and not f.is_deleted
        and f.status <> 'Draft'
        and (p_template_id is null or f.template_id = p_template_id)
        and (p_status is null or f.status = p_status)
        and (p_department_id is null or req.department_id = p_department_id)
        and (p_requester_id is null or f.requested_by = p_requester_id)
        and (p_date_from is null or f.created_on >= p_date_from)
        -- p_date_to arrives as a bare date cast to midnight (00:00:00) of
        -- that day — "<=" would silently exclude every request created
        -- later that same day. Treat it as an inclusive end-of-day bound.
        and (p_date_to is null or f.created_on < p_date_to + interval '1 day')
        and (p_approver_id is null or exists (
          select 1 from public.form_approval_transactions tx
          where tx.form_id = f.id and tx.actor_id = p_approver_id and tx.action in ('Approve', 'Reject')
        ))
        and (p_tag_id is null or exists (
          select 1 from public.entity_tags et
          where et.tenant_id = v_tenant and et.entity_type = 'Form' and et.entity_id = f.id
            and et.tag_id = p_tag_id and not et.is_deleted
        ))
      order by f.created_on desc
      limit greatest(1, least(coalesce(p_limit, 200), 500))
    ) page
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.approval_admin_requests_list(uuid, text, uuid, uuid, timestamptz, timestamptz, uuid, uuid, integer) from public;
grant execute on function public.approval_admin_requests_list(uuid, text, uuid, uuid, timestamptz, timestamptz, uuid, uuid, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- 8. Forms onto the Attachment Framework
--
-- attachment_list()'s own authorization (owner/creator/Storage.Manage only —
-- see migration 040's header) is deliberately narrower than "any form
-- participant". Reusing it as-is for forms would mean an approver could
-- never see the memo's attachments they are supposed to be reviewing — that
-- authorization check runs on auth.uid() inside attachment_list() itself, so
-- a thin wrapper calling it would not widen anything. This is therefore a
-- full independent read RPC with the wider, form-appropriate audience check
-- (is_form_participant), exactly the pattern migration 040's own comment
-- anticipates ("a business module that legitimately needs a wider audience
-- builds its own definer RPC with its own audience check on top").
-- attachFile()/attachment_attach() and markAttachmentForRemoval()/
-- attachment_mark_for_removal() need no such wrapper — "whoever uploaded it
-- owns it" is already the correct rule for both attach and mark-for-removal.
-- ----------------------------------------------------------------------------
create or replace function public.form_attachment_list(p_form_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_form_participant(p_form_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  return coalesce((
    select jsonb_agg(row_to_json(r) order by r.display_order, r.created_on)
    from (
      select
        a.id, a.storage_object_id, a.entity_type, a.entity_id, a.display_order,
        a.marked_for_removal, a.marked_for_removal_by, a.marked_for_removal_on,
        a.created_by, a.created_on,
        coalesce(u.full_name, u.name_ar, u.name_en, u.email) as created_by_name,
        o.layer, o.provider_code, o.bucket, o.path, o.file_name, o.mime_type, o.file_size, o.owner_id
      from public.attachments a
      join public.storage_objects o on o.id = a.storage_object_id and o.tenant_id = a.tenant_id
      left join public.users u on u.id = a.created_by
      where a.tenant_id = public.current_tenant_id()
        and a.entity_type = 'FormSubmission'
        and a.entity_id = p_form_id
        and not a.is_deleted
        and not o.is_deleted
    ) r
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.form_attachment_list(uuid) from public;
grant execute on function public.form_attachment_list(uuid) to authenticated;

-- approval_form_detail() (migration 032) still embedded its own attachments
-- read straight from the legacy form_attachments table. Left alone, every
-- approver opening a request through ApprovalCenter.jsx would see zero
-- attachments for any memo or evaluation saved after this migration — the
-- write side moved to the Attachment Framework above, but this read side did
-- not, which is a real functional regression, not just a cosmetic gap.
-- Everything else in the function is byte-for-byte identical to 032's body;
-- only the 'attachments' sub-select changes, and now returns enough of the
-- storage_objects row (layer/provider_code/bucket/path/mime_type) for the
-- client to resolve a real, working URL the same way form_attachment_list()
-- and formAttachmentList() already do — the old shape (file_name, file_size
-- only) could never actually be opened, per the audit that found this gap.
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
  select * into v_form from public.forms
  where id = p_form_id and tenant_id = public.current_tenant_id() and not is_deleted;
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
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'file_name', o.file_name, 'mime_type', o.mime_type, 'file_size', o.file_size,
        'layer', o.layer, 'provider_code', o.provider_code, 'bucket', o.bucket, 'path', o.path
      ) order by a.display_order, a.created_on)
      from public.attachments a
      join public.storage_objects o on o.id = a.storage_object_id and o.tenant_id = a.tenant_id
      where a.tenant_id = f.tenant_id and a.entity_type = 'FormSubmission' and a.entity_id = f.id
        and not a.is_deleted and not o.is_deleted
    ), '[]'::jsonb)
  ) into v_result
  from public.forms f
  join public.templates tpl on tpl.id = f.template_id
  left join public.users req on req.id = f.requested_by
  left join public.users emp on emp.id = f.employee_id
  left join public.users asg on asg.id = f.current_assignee_id
  where f.id = p_form_id and f.tenant_id = public.current_tenant_id();

  return v_result;
end;
$$;
grant execute on function public.approval_form_detail(uuid) to authenticated;

comment on function public.approval_form_detail(uuid) is
  'Returns one form''s full approval detail, scoped to the caller''s own tenant. '
  'Attachments come from the Attachment Framework (migration 044), not the legacy '
  'form_attachments table — see this migration''s header for why that read side had '
  'to move too, not just the write side.';

-- One-time backfill: register each existing form_attachments row's already-
-- uploaded file into storage_objects at its EXISTING bucket/path (no
-- re-upload, no new bytes), then link it into the Attachment Framework, so
-- the Internal Memo screen's new AttachmentsPanel shows pre-existing files
-- instead of orphaning them. Idempotent on both inserts (checked via
-- NOT EXISTS / the framework's own uq_attachments_storage_object index), so
-- safe if this migration is ever re-applied to the same database.
do $$
declare
  v_row record;
  v_object_id uuid;
begin
  for v_row in
    select fa.*, f.tenant_id
    from public.form_attachments fa
    join public.forms f on f.id = fa.form_id
    where not fa.is_deleted
  loop
    v_object_id := null;

    insert into public.storage_objects (
      tenant_id, layer, provider_code, bucket, path, file_name, mime_type,
      file_size, owner_id, entity_type, entity_id, created_by
    )
    select
      v_row.tenant_id, 'Extended', 'supabase', 'form-attachments', v_row.storage_path, v_row.file_name,
      v_row.mime_type, coalesce(v_row.file_size, 0), v_row.uploaded_by, 'FormSubmission', v_row.form_id, v_row.uploaded_by
    where not exists (
      select 1 from public.storage_objects so
      where so.tenant_id = v_row.tenant_id and coalesce(so.bucket, '') = 'form-attachments' and so.path = v_row.storage_path
        and not so.is_deleted
    )
    returning id into v_object_id;

    if v_object_id is null then
      select id into v_object_id from public.storage_objects
      where tenant_id = v_row.tenant_id and bucket = 'form-attachments' and path = v_row.storage_path and not is_deleted
      limit 1;
    end if;

    if v_object_id is not null then
      insert into public.attachments (tenant_id, storage_object_id, entity_type, entity_id, created_by)
      select v_row.tenant_id, v_object_id, 'FormSubmission', v_row.form_id, v_row.uploaded_by
      where not exists (
        select 1 from public.attachments a
        where a.tenant_id = v_row.tenant_id and a.storage_object_id = v_object_id and not a.is_deleted
      );
    end if;
  end loop;
end $$;

comment on table public.form_attachments is
  'Legacy, pre-Attachment-Framework table (migration 202607290008). As of '
  'migration 044, new form attachments are written through public.attachments '
  '(entity_type = FormSubmission) via form_attachment_list()/attachFile() '
  'instead. Existing rows here were re-registered there by that migration''s '
  'backfill. Kept, unwritten, as a historical record: storage_path here is '
  'the source of truth the backfill read from, so dropping this table would '
  'not be reversible.';

-- ----------------------------------------------------------------------------
-- 9. Admin nav entry for the new "All Requests" screen (src/components/
--    ApprovalAdmin.jsx's ApprovalAllRequestsAdmin). Without this row,
--    my_screens() never returns its code and useAdminNavigation() hides the
--    item for every tenant whose database already answers for admin screens
--    (see AdminNav.jsx) — an unreachable screen, not a working one. Same
--    module/rank as its sibling ADMIN_APPROVAL_TRACKING (operational
--    admin, not configuration).
-- ----------------------------------------------------------------------------
insert into public.app_screens (code, module_code, area, group_code, name_ar, name_en, icon, route, display_order, min_role_rank)
values ('ADMIN_APPROVAL_ALL_REQUESTS', 'APPROVALS', 'Admin', 'Approvals', 'جميع الطلبات', 'All Requests', 'list-checks', 'admin/approval-all-requests', 355, 3)
on conflict (code) do update set
  module_code = excluded.module_code, area = excluded.area, group_code = excluded.group_code,
  name_ar = excluded.name_ar, name_en = excluded.name_en, icon = excluded.icon, route = excluded.route,
  display_order = excluded.display_order, min_role_rank = excluded.min_role_rank, updated_on = now();

-- ----------------------------------------------------------------------------
-- Mandatory closer: every migration batch ends with this, or a GRANT earlier
-- in the same file (or an earlier migration) re-materializes the function's
-- ACL to include PUBLIC. See docs' "PUBLIC-execute footgun" note.
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
