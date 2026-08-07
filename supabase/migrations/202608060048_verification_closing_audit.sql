-- ============================================================================
-- 048 — Verification Service: final closing audit fixes
--
-- A dedicated closing audit (6 independent lenses + adversarial verify, every
-- file in the module, no exceptions) found 21 real, in-scope problems. This
-- migration fixes every SQL-side one. Frontend fixes are in the same commit.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. [BLOCKER/Security] "verification managers manage documents" was FOR ALL,
--    gated only on has_permission('Verification.Manage') — it enforced none
--    of attestation_create()'s doc_type/module-license/title validation, so
--    any Verification.Manage holder could INSERT/UPDATE/DELETE
--    verifiable_documents directly via PostgREST, bypassing the approval
--    workflow entirely and forging an 'Active' HR document for anyone, plus
--    hard-deleting rows (contract §20 forbids hard delete on soft-deletable
--    business tables). Every legitimate write already goes through
--    attestation_create/approve/revoke or the publish_form_verification
--    trigger — none of those need direct table access (SECURITY DEFINER
--    functions do not need RLS to permit their own internal writes). Direct
--    client writes were never actually required; downgrading to read-only
--    closes the gap with zero loss of real functionality.
-- ----------------------------------------------------------------------------
drop policy if exists "verification managers manage documents" on public.verifiable_documents;
create policy "verification managers manage documents" on public.verifiable_documents
  for select to authenticated
  using (public.has_permission('Verification.Manage'));

comment on table public.verifiable_documents is
  'Every write goes through attestation_create()/attestation_approve()/'
  'attestation_revoke()/certificate_issue()/publish_form_verification() — '
  'never a direct client insert/update/delete. Fixed in migration 048: the '
  '"verification managers manage documents" policy was FOR ALL and let a '
  'Verification.Manage holder forge an Active document (or hard-delete one) '
  'via direct PostgREST access, bypassing every RPC-level validation.';

-- ----------------------------------------------------------------------------
-- 2. [Major/Security] "certificate managers manage", applied identically to
--    certificate_templates/certificate_template_fields/certificate_batches/
--    certificates by the original wiring loop, let a Certificates.Manage
--    holder insert a `certificates` row (or a `certificate_batches` row)
--    directly, bypassing certificate_issue()'s tenant_has_module/quota/
--    template-active/row-count checks entirely. Only certificate_templates
--    and certificate_template_fields have a real direct-client-write path
--    (saveTemplate()/saveTemplateFields() in verificationService.js) —
--    certificate_batches and certificates are certificate_issue()-only.
-- ----------------------------------------------------------------------------
drop policy if exists "certificate managers manage" on public.certificate_batches;
create policy "certificate managers manage" on public.certificate_batches
  for select to authenticated
  using (public.has_permission('Certificates.Manage'));

drop policy if exists "certificate managers manage" on public.certificates;
create policy "certificate managers manage" on public.certificates
  for select to authenticated
  using (public.has_permission('Certificates.Manage'));

-- certificate_templates / certificate_template_fields keep their FOR ALL
-- policy (real direct client insert/update exists) but gain a restrictive
-- delete block — hard delete was never used (deleteTemplate() only sets
-- is_deleted=true) and contract §20 forbids it on a soft-deletable table.
drop policy if exists "no hard delete" on public.certificate_templates;
create policy "no hard delete" on public.certificate_templates
  as restrictive for delete to authenticated
  using (false);

drop policy if exists "no hard delete" on public.certificate_template_fields;
create policy "no hard delete" on public.certificate_template_fields
  as restrictive for delete to authenticated
  using (false);

comment on table public.certificates is
  'Every write goes through certificate_issue() — never a direct client '
  'insert/update. Fixed in migration 048: "certificate managers manage" was '
  'FOR ALL, letting a Certificates.Manage holder insert a certificate row '
  'directly and bypass certificate_issue()''s quota/template-active/'
  'module-license checks.';

-- ----------------------------------------------------------------------------
-- 3. [Major/Security] attestation_revoke() had no doc_type restriction,
--    unlike its sibling attestation_approve() (which rejects doc_type =
--    'FormRequest'). A Verification.Manage holder — deliberately not granted
--    Certificates.Manage, or any approval permission — could revoke a
--    Certificate or an already-Approved FormRequest document directly,
--    crossing into Certificates.Manage's and the Workflow engine's
--    authority. AttestationsScreen.jsx only ever renders the revoke button
--    for MANUAL_DOC_TYPES ('Attestation'/'Letter'/'Custom') — the
--    restriction existed only in the client.
-- ----------------------------------------------------------------------------
create or replace function public.attestation_revoke(p_id uuid, p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_doc public.verifiable_documents%rowtype;
begin
  if v_tenant is null then
    raise exception 'NO_ACTIVE_TENANT';
  end if;
  if not public.has_permission('Verification.Manage') then
    raise exception 'PERMISSION_DENIED';
  end if;

  select * into v_doc from public.verifiable_documents
  where id = p_id and tenant_id = v_tenant and not is_deleted
  for update;
  if not found then
    raise exception 'DOCUMENT_NOT_FOUND';
  end if;
  if v_doc.doc_type not in ('Attestation', 'Letter', 'Custom') then
    raise exception 'DOCUMENT_NOT_MANUAL';
  end if;
  if v_doc.status = 'Revoked' then
    raise exception 'DOCUMENT_ALREADY_REVOKED';
  end if;

  update public.verifiable_documents
  set status = 'Revoked',
      revoked_on = now(),
      revoked_by = auth.uid(),
      revoked_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = p_id
  returning * into v_doc;

  return jsonb_build_object(
    'id', v_doc.id, 'code', v_doc.code, 'status', v_doc.status, 'revoked_on', v_doc.revoked_on
  );
end;
$$;
grant execute on function public.attestation_revoke(uuid, text) to authenticated;

comment on function public.attestation_revoke(uuid, text) is
  'Revokes a manually-created document (Attestation/Letter/Custom) only — '
  'fixed in migration 048 to mirror attestation_approve()''s doc_type guard, '
  'which this function was missing, letting a Verification.Manage holder '
  'revoke a Certificate or an approved FormRequest directly, outside '
  'Certificates.Manage''s and the approval engine''s own authority.';

-- ----------------------------------------------------------------------------
-- 4. [Major/Security] verify_document()'s approval-timeline lookup ran
--    whenever a form_id resolved at all, regardless of the computed
--    v_valid — so reviewer names, roles, actions and timestamps for a
--    Rejected, still-in-approval, or Revoked/cancelled request were
--    returned to any anonymous caller holding the code. The identical
--    defect class migration 202608050035 already fixed for the sibling
--    approval_verify(). file_url/file_mime two lines below already
--    correctly gate on v_valid — the timeline never did.
-- ----------------------------------------------------------------------------
create or replace function public.verify_document(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_code text := trim(coalesce(p_code, ''));
  v_doc public.verifiable_documents%rowtype;
  v_form public.forms%rowtype;
  v_tenant uuid;
  v_company jsonb;
  v_enabled boolean;
  v_days integer;
  v_reason text;
  v_valid boolean := false;
  v_form_id uuid;
  v_timeline jsonb := '[]'::jsonb;
  v_title_ar text;
  v_title_en text;
  v_holder text;
  v_issued timestamptz;
  v_valid_until timestamptz;
  v_status text;
  v_doc_type text;
  v_seal text;
  v_reference text;
  v_not_found constant jsonb := jsonb_build_object('valid', false, 'reason', 'NOT_FOUND');
begin
  if length(v_code) < 4 then
    return v_not_found;
  end if;

  select * into v_doc from public.verifiable_documents d
  where lower(d.code) = lower(v_code) and not d.is_deleted;

  if found then
    v_tenant := v_doc.tenant_id;
  else
    -- Backward compatibility: forms minted verify codes long before documents
    -- existed, and those printouts are still in circulation.
    select * into v_form from public.forms f
    where lower(f.verify_code) = lower(v_code) and not f.is_deleted;
    if not found then
      return v_not_found;
    end if;
    v_tenant := v_form.tenant_id;
  end if;

  select coalesce(s.verification_enabled, true), coalesce(s.verification_validity_days, 0)
  into v_enabled, v_days
  from public.tenants t
  left join public.tenant_settings s on s.tenant_id = t.id
  where t.id = v_tenant;

  select jsonb_build_object(
    'slug', t.slug,
    'names', coalesce((
      select jsonb_object_agg(n.language_code, n.name)
      from public.tenant_names n where n.tenant_id = t.id
    ), '{}'::jsonb),
    'short_names', coalesce((
      select jsonb_object_agg(n.language_code, coalesce(n.short_name, n.name))
      from public.tenant_names n where n.tenant_id = t.id
    ), '{}'::jsonb),
    'logo_light_url', b.logo_light_url,
    'logo_dark_url', b.logo_dark_url
  )
  into v_company
  from public.tenants t
  left join public.tenant_branding b on b.tenant_id = t.id
  where t.id = v_tenant
    and not t.is_deleted
    and t.status <> 'Deleted';

  if v_company is null then
    return v_not_found;
  end if;

  if v_doc.id is not null then
    v_doc_type := v_doc.doc_type;
    v_status := v_doc.status;
    v_seal := v_doc.seal_style;
    v_title_ar := v_doc.title_ar;
    v_title_en := v_doc.title_en;
    v_holder := v_doc.holder_name;
    v_issued := v_doc.issued_on;
    v_valid_until := v_doc.valid_until;
    v_reference := v_doc.metadata ->> 'reference_no';

    -- The company switch governs form requests only; a letter or a certificate
    -- was published deliberately and stays verifiable.
    if v_doc_type = 'FormRequest' and not coalesce(v_enabled, true) then
      return v_not_found;
    end if;

    if v_doc.source_table = 'forms' then
      v_form_id := v_doc.source_id;
    end if;

    if v_status = 'Revoked' then
      v_reason := 'REVOKED';
    elsif v_status in ('Draft', 'PendingApproval') then
      v_reason := 'NOT_PUBLISHED';
    elsif v_status = 'Expired' or (v_valid_until is not null and v_valid_until < now()) then
      v_reason := 'EXPIRED';
    else
      v_valid := true;
    end if;
  else
    if not coalesce(v_enabled, true) then
      return v_not_found;
    end if;

    v_doc_type := 'FormRequest';
    v_form_id := v_form.id;
    v_seal := 'Blue';
    v_reference := v_form.reference_no;
    v_issued := coalesce(v_form.approval_completed_on, v_form.submitted_on);
    v_valid_until := case
      when v_days > 0 and v_form.approval_completed_on is not null
        then v_form.approval_completed_on + make_interval(days => v_days)
      else null
    end;

    select tpl.name_ar, tpl.name_en into v_title_ar, v_title_en
    from public.templates tpl where tpl.id = v_form.template_id;

    select case when u.id is not null then public.approval_display_name(u) end
    into v_holder
    from public.users u where u.id = v_form.employee_id;

    if v_form.status = 'Approved' then
      v_status := 'Active';
      if v_valid_until is not null and v_valid_until < now() then
        v_reason := 'EXPIRED';
      else
        v_valid := true;
      end if;
    elsif v_form.status = 'Cancelled' then
      v_status := 'Revoked';
      v_reason := 'REVOKED';
    else
      v_status := 'PendingApproval';
      v_reason := 'NOT_APPROVED';
    end if;
  end if;

  -- Fixed in migration 048: only a genuinely valid, publicly-verifiable
  -- document discloses its approval timeline (reviewer names/roles/actions)
  -- — a Rejected/InApproval/Revoked request previously still returned its
  -- full timeline even though valid=false, the same defect class 035 fixed
  -- for approval_verify().
  if v_form_id is not null and v_valid then
    select coalesce(jsonb_agg(jsonb_build_object(
      'seq', tx.seq,
      'action', tx.action,
      'actor_name', tx.actor_name,
      'role_name_ar', ar.name_ar,
      'role_name_en', ar.name_en,
      'to_user_name', tx.to_user_name,
      'created_on', tx.created_on
    ) order by tx.seq), '[]'::jsonb)
    into v_timeline
    from public.form_approval_transactions tx
    left join public.approval_roles ar on ar.id = tx.approval_role_id
    where tx.form_id = v_form_id;
  end if;

  return jsonb_build_object(
    'valid', v_valid,
    'reason', v_reason,
    'code', coalesce(v_doc.code, v_form.verify_code),
    'source', case when v_doc.id is not null then 'document' else 'form' end,
    'doc_type', v_doc_type,
    'status', v_status,
    'seal_style', v_seal,
    'title_ar', v_title_ar,
    'title_en', v_title_en,
    'subject_ar', v_doc.subject_ar,
    'subject_en', v_doc.subject_en,
    'holder_name', v_holder,
    'reference_no', v_reference,
    'issued_on', v_issued,
    'valid_until', v_valid_until,
    'file_url', case when v_valid then v_doc.file_url end,
    'file_mime', case when v_valid then v_doc.file_mime end,
    'company', v_company,
    'timeline', v_timeline
  );
end;
$$;
grant execute on function public.verify_document(text) to anon, authenticated;

comment on function public.verify_document(text) is
  'Authentication: anon. Authorization: none beyond knowing the code itself. '
  'Only returns document/company/approval-chain fields already meant for '
  'public verification — fixed in migration 048: the approval timeline '
  '(reviewer names/roles/actions) is now only built when valid=true; '
  'previously a Rejected/still-in-approval/Revoked request still disclosed '
  'its full timeline despite valid=false. Rate limiting: enforced at the '
  'verify-api edge function layer (60 lookups/minute per caller). Expected '
  'errors: none raised — an unknown or invalid code resolves to '
  '{valid:false}, not an exception.';

-- ----------------------------------------------------------------------------
-- 5. [Major/Performance] loadDocuments()/loadCertificates() (the module's
--    two main list screens) filter is_deleted and sort by created_on/
--    issued_on desc with no supporting index — every existing index needs a
--    status or template_id predicate neither query supplies. Contract §17:
--    "A column used in a where/order by on a screen's main query gets an
--    index — add it in the same migration that adds the query."
-- ----------------------------------------------------------------------------
create index if not exists idx_verifiable_documents_tenant_created
  on public.verifiable_documents (tenant_id, created_on desc)
  where not is_deleted;

create index if not exists idx_certificates_tenant_issued
  on public.certificates (tenant_id, issued_on desc)
  where not is_deleted;

-- ----------------------------------------------------------------------------
-- 6. [Major/Database, contract §18] saveTemplateFields() (frontend) replaced
--    a template's whole field layout as one SELECT + one batch soft-delete +
--    N separate per-row insert/update client calls — a failure partway
--    through the loop left the layout half-updated with no rollback, and
--    the frontend also discarded the call's own return value, so a newly
--    added field's real server id never made it back into local state
--    (fixed on the frontend too) — its next save treated the already-
--    inserted row as "removed" and inserted a duplicate. One atomic RPC
--    replaces both the delete-then-insert-loop and the round-trip count.
-- ----------------------------------------------------------------------------
create or replace function public.certificate_template_fields_set(p_template_id uuid, p_fields jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_rows jsonb;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Certificates.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if not exists (
    select 1 from public.certificate_templates
    where id = p_template_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'TEMPLATE_NOT_FOUND';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' then
    raise exception 'INVALID_FIELDS';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_fields) elem
    where not (trim(coalesce(elem ->> 'field_key', '')) ~ '^[A-Za-z][A-Za-z0-9_]{0,40}$')
  ) then
    raise exception 'FIELD_KEY_INVALID';
  end if;
  if (
    select count(distinct lower(trim(elem ->> 'field_key')))
    from jsonb_array_elements(p_fields) elem
  ) <> jsonb_array_length(p_fields) then
    raise exception 'FIELD_KEY_TAKEN';
  end if;

  update public.certificate_template_fields
  set is_deleted = true
  where template_id = p_template_id
    and tenant_id = v_tenant
    and not is_deleted
    and id <> all (
      select (elem ->> 'id')::uuid
      from jsonb_array_elements(p_fields) elem
      where elem ->> 'id' is not null
    );

  with incoming as (
    select
      nullif(elem ->> 'id', '')::uuid as id,
      trim(elem ->> 'field_key') as field_key,
      nullif(elem ->> 'label_ar', '') as label_ar,
      nullif(elem ->> 'label_en', '') as label_en,
      coalesce(nullif(elem ->> 'field_type', ''), 'Text') as field_type,
      coalesce((elem ->> 'pos_x_px')::numeric, 0) as pos_x_px,
      coalesce((elem ->> 'pos_y_px')::numeric, 0) as pos_y_px,
      (elem ->> 'width_px')::numeric as width_px,
      (elem ->> 'height_px')::numeric as height_px,
      nullif(elem ->> 'font_family', '') as font_family,
      coalesce((elem ->> 'font_size_px')::numeric, 16) as font_size_px,
      coalesce(nullif(elem ->> 'font_weight', ''), '400') as font_weight,
      coalesce(nullif(elem ->> 'color', ''), '#111827') as color,
      coalesce(nullif(elem ->> 'align', ''), 'Start') as align,
      coalesce(nullif(elem ->> 'anchor', ''), 'TopStart') as anchor,
      nullif(elem ->> 'default_value', '') as default_value,
      coalesce((elem ->> 'is_required')::boolean, false) as is_required,
      coalesce((elem ->> 'display_order')::integer, (ord)::integer * 10) as display_order
    from jsonb_array_elements(p_fields) with ordinality as t(elem, ord)
  ),
  upserted as (
    insert into public.certificate_template_fields (
      id, tenant_id, template_id, field_key, label_ar, label_en, field_type,
      pos_x_px, pos_y_px, width_px, height_px, font_family, font_size_px,
      font_weight, color, align, anchor, default_value, is_required, display_order
    )
    select
      coalesce(i.id, gen_random_uuid()), v_tenant, p_template_id, i.field_key, i.label_ar, i.label_en, i.field_type,
      i.pos_x_px, i.pos_y_px, i.width_px, i.height_px, i.font_family, i.font_size_px,
      i.font_weight, i.color, i.align, i.anchor, i.default_value, i.is_required, i.display_order
    from incoming i
    on conflict (id) do update set
      field_key = excluded.field_key, label_ar = excluded.label_ar, label_en = excluded.label_en,
      field_type = excluded.field_type, pos_x_px = excluded.pos_x_px, pos_y_px = excluded.pos_y_px,
      width_px = excluded.width_px, height_px = excluded.height_px, font_family = excluded.font_family,
      font_size_px = excluded.font_size_px, font_weight = excluded.font_weight, color = excluded.color,
      align = excluded.align, anchor = excluded.anchor, default_value = excluded.default_value,
      is_required = excluded.is_required, display_order = excluded.display_order, is_deleted = false
    returning *
  )
  select coalesce(jsonb_agg(row_to_json(u) order by u.display_order), '[]'::jsonb) into v_rows
  from upserted u;

  return v_rows;
end;
$$;
revoke all on function public.certificate_template_fields_set(uuid, jsonb) from public;
grant execute on function public.certificate_template_fields_set(uuid, jsonb) to authenticated;

comment on function public.certificate_template_fields_set(uuid, jsonb) is
  'Replaces a certificate template''s ordered field layout atomically (added '
  'in migration 048 — the frontend previously did this as a SELECT + batch '
  'soft-delete + N separate insert/update calls; a mid-loop failure left '
  'the layout half-updated with no rollback, contract §18''s exact '
  '"sequential client calls with partial failure possible in between" '
  'violation). Returns the persisted rows (with real ids) in one round trip '
  'so the caller never has to guess which locally-held field still has a '
  'null id.';

-- ----------------------------------------------------------------------------
-- Mandatory closer: every migration batch ends with this, or a GRANT earlier
-- in the same file (or an earlier migration) re-materializes the function's
-- PUBLIC-execute footgun (see 202608050037's header for what that means).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
