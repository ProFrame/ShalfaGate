-- ============================================================================
-- 032 — approval_form_detail() could read any company's form
--
-- The lookup that decides whether the form even exists never filtered by
-- tenant:
--
--   select * into v_form from public.forms where id = p_form_id and not is_deleted;
--
-- and the only gate afterwards was
--   is_form_participant(p_form_id) OR has_permission('Approvals.Manage')
--
-- has_permission() answers "does the caller hold this permission in their own
-- active tenant" — it has no idea which company p_form_id belongs to. Because
-- Approvals.Manage is an ordinary, commonly granted permission (every company's
-- own SYSTEM_ADMIN and PLATFORM_ADMIN hold it by default, from migration 028's
-- backfill), any manager in any one company who could reach or guess another
-- company's form id got that company's full form — data_json, the requester
-- and current assignee's names, and the entire approval transaction history —
-- back from this SECURITY DEFINER function, RLS notwithstanding. Fixed by
-- scoping both queries to the caller's own tenant, exactly like every other
-- form-reading RPC in this migration already does; the approval chain has no
-- platform-operator cross-tenant use case; is_form_participant() was already
-- tenant-safe by construction (it only matches the caller's own auth.uid()
-- against the form's own participant columns).
-- ============================================================================

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
      select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'storage_path', a.storage_path, 'file_size', a.file_size))
      from public.form_attachments a where a.form_id = f.id
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
  'has_permission(''Approvals.Manage'') only proves the caller manages approvals in their '
  'own company — it says nothing about which company p_form_id belongs to, so the tenant '
  'filter on the lookup itself is the actual boundary.';
