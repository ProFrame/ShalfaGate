-- ============================================================================
-- 035 — approval_verify() reported every form as valid
--
-- 'valid', true was hardcoded into the jsonb payload; the WHERE clause only
-- ever checked verify_code and is_deleted, never status. Every form gets a
-- verify_code at creation (generate_verify_code(), migration 0009's own
-- form_submit path), so a Draft never submitted, a request still InApproval,
-- and — the case that actually matters — a form a reviewer REJECTED all
-- reported back 'valid: true', together with the requester's and employee's
-- real names and the full approval timeline. The function is also granted to
-- anon, so this was reachable by anyone who had ever seen a verify_code
-- printed on a document, with no sign-in and no company boundary beyond the
-- code itself.
--
-- The client never actually calls this RPC — src/data/approvalService.js's
-- verifyApprovalCode() wraps it but has no caller anywhere in the app; the
-- public verify page (VerifyRequestPage.jsx) already goes through the correct,
-- status-aware public.verify_document(). Left live and unfixed, though, it was
-- a second, unguarded path to the same data. Fixed at the smallest possible
-- diff: the WHERE clause now requires status = 'Approved', so anything else
-- falls into the function's own existing "not found" branch — the same
-- privacy posture the correct endpoint already has, without disclosing that a
-- non-approved code exists at all.
-- ============================================================================

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
    'company', jsonb_build_object(
      'slug', t.slug,
      'names', coalesce((
        select jsonb_object_agg(n.language_code, n.name)
        from public.tenant_names n where n.tenant_id = t.id
      ), '{}'::jsonb),
      'logo_url', (select b.logo_light_url from public.tenant_branding b where b.tenant_id = t.id)
    ),
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
  join public.tenants t on t.id = f.tenant_id
  left join public.users req on req.id = f.requested_by
  left join public.users emp on emp.id = f.employee_id
  where f.verify_code = trim(p_code) and not f.is_deleted and f.status = 'Approved';

  if v_result is null then
    return jsonb_build_object('valid', false);
  end if;
  return v_result;
end;
$$;
grant execute on function public.approval_verify(text) to authenticated;
grant execute on function public.approval_verify(text) to anon;

comment on function public.approval_verify(text) is
  'Public verification of a request by its code; only reports valid for an Approved form. '
  'Unused by the client (see public.verify_document, which the verify page actually calls) but '
  'kept correct rather than removed, since it is still exported and still granted to anon.';
