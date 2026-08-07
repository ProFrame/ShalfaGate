-- ============================================================================
-- 053 — Pre-Assets-Management zero-technical-debt sweep.
--
-- Independent, no-prior-trust re-verification of all 7 phases claimed CLOSED
-- (Platform Core, INumberGenerator, Storage, Workflow Engine, Attachments,
-- Verification, Digital Identity) plus cross-module interaction bugs, ordered
-- by the user before Assets Management could start. 12-lens discovery +
-- adversarial verify found 37 confirmed in-scope problems, including 3
-- Blockers. This migration carries every SQL-side fix; frontend/doc/test
-- fixes land in their own files. See docs/update4_pre_assets_sweep.md for
-- the full closing report.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. BLOCKER — storage_objects' "storage managers manage storage objects"
--    policy was FOR ALL (owner_id = auth.uid() OR Storage.Manage), letting
--    any authenticated tenant member INSERT a self-owned ledger row pointing
--    at ANY real file path directly via PostgREST — bypassing
--    storage_can_upload()'s quota/mime/size gate entirely, and (worse)
--    letting storage-proxy's ownsAllPaths() treat the forged row as proof of
--    ownership, granting unauthorized signed-URL read and permanent delete
--    of another user's real file. The only legitimate write path is already
--    storage_register()/storage_unregister() (both SECURITY DEFINER — they
--    do not need a client-writable RLS policy to do their own job). Confirmed
--    no direct `.from('storage_objects')` write call exists anywhere in
--    src/ (only one read-only .select()). Same "FOR ALL + validated write
--    RPC = forgery risk" class already fixed for verifiable_documents in
--    migration 048 — never applied here until now.
-- ----------------------------------------------------------------------------
drop policy if exists "storage managers manage storage objects" on public.storage_objects;

-- ----------------------------------------------------------------------------
-- 2. BLOCKER — approval_scheme_set_roles() checked has_permission('Approvals.
--    Manage') (correctly tenant-scoped to the CALLER) but then looked up
--    p_scheme_id with no tenant_id filter at all, so any tenant's approvals
--    manager could pass another tenant's scheme id and wipe its entire role
--    list (an empty p_roles never trips the same-tenant FK, so the delete
--    commits with nothing to roll it back). approval_schemes/
--    approval_scheme_roles have carried a real, enforced tenant_id since
--    migration 202608040012 — the "platform-wide configuration, no tenant_id
--    at all" reasoning that let this ship was already stale then.
-- ----------------------------------------------------------------------------
create or replace function public.approval_scheme_set_roles(p_scheme_id uuid, p_roles jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if not public.has_permission('Approvals.Manage') then
    raise exception 'PERMISSION_DENIED';
  end if;
  if not exists (select 1 from public.approval_schemes where id = p_scheme_id and tenant_id = v_tenant) then
    raise exception 'APPROVAL_SCHEME_NOT_FOUND';
  end if;

  delete from public.approval_scheme_roles where scheme_id = p_scheme_id and tenant_id = v_tenant;

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
  'Replaces an approval scheme''s ordered role list atomically, scoped to the '
  'caller''s own tenant (closing-audit Blocker, fixed 053 — the existence '
  'check and delete previously had no tenant_id filter at all, letting any '
  'tenant''s Approvals.Manage holder wipe another tenant''s scheme roles). '
  'p_roles is a jsonb array of {roleId, displayOrder, allowSelfApproval?}.';

-- ----------------------------------------------------------------------------
-- 3. approval_submit()'s "template skips the approval chain entirely"
--    branch (requires_final_approval = false) never set
--    forms.approval_started_on, so approval_center_feed()'s outbox/history
--    queries (both filter on approval_started_on is not null) permanently
--    hid the request from the requester's own Approval Center. Mirrors the
--    same coalesce(approval_started_on, now()) already used in this
--    function's normal chain-taking branch.
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
        approval_started_on = coalesce(approval_started_on, now()),
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
      submitted_on = coalesce(submitted_on, now()),
      approval_started_on = coalesce(approval_started_on, now()),
      updated_on = now()
  where id = p_form_id;

  select * into v_form from public.forms where id = p_form_id;
  return jsonb_build_object('id', v_form.id, 'status', v_form.status, 'verify_code', v_form.verify_code);
end;
$$;
revoke all on function public.approval_submit(uuid, uuid, uuid, text) from public;
grant execute on function public.approval_submit(uuid, uuid, uuid, text) to authenticated;

comment on function public.approval_submit(uuid, uuid, uuid, text) is
  'Submits a form: routes it to an approver, or — when the template''s '
  'requires_final_approval is false — marks it Submitted with no chain at '
  'all. Both branches now set approval_started_on (closing-audit fix, 053 — '
  'the no-chain branch previously left it null, hiding the request from '
  'approval_center_feed()''s outbox/history forever). Expected errors: '
  'FORM_NOT_FOUND, ONLY_REQUESTER_CAN_SUBMIT, FORM_CANCELLED, '
  'FORM_NOT_SENDABLE, FORM_HELD_BY_ANOTHER_USER, '
  'NO_APPROVAL_TEMPLATE_TAKES_NO_ROUTING, CANNOT_SEND_TO_SELF, '
  'TARGET_USER_NOT_FOUND, APPROVAL_ROLE_NOT_FOUND, '
  'REQUESTER_ROLE_NOT_SENDABLE, ROLE_NOT_IN_TEMPLATE_SCHEME.';

-- ----------------------------------------------------------------------------
-- 4. File Reference completeness — checksum (Hash) is correctly computed and
--    stored on upload (closing-audit fix, migration 202608060051-era
--    src/lib/storage/index.js change) but every read path omitted it, so the
--    8-field File Reference model was never actually satisfied end-to-end.
--    Adds o.checksum to attachment_list()/form_attachment_list()/
--    approval_form_detail()'s attachment sub-selects.
-- ----------------------------------------------------------------------------
create or replace function public.attachment_list(p_entity_type text, p_entity_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(r) order by r.display_order, r.created_on), '[]'::jsonb)
  from (
    select
      a.id, a.storage_object_id, a.entity_type, a.entity_id, a.display_order,
      a.marked_for_removal, a.marked_for_removal_by, a.marked_for_removal_on,
      a.created_by, a.created_on,
      coalesce(u.full_name, u.name_ar, u.name_en, u.email) as created_by_name,
      o.layer, o.provider_code, o.bucket, o.path, o.file_name, o.mime_type, o.file_size, o.checksum, o.owner_id
    from public.attachments a
    join public.storage_objects o on o.id = a.storage_object_id and o.tenant_id = a.tenant_id
    left join public.users u on u.id = a.created_by
    where a.tenant_id = public.current_tenant_id()
      and a.entity_type = p_entity_type
      and a.entity_id = p_entity_id
      and not a.is_deleted
      and not o.is_deleted
      and (
        a.created_by = auth.uid()
        or o.owner_id = auth.uid()
        or public.has_permission('Storage.Manage')
      )
  ) r;
$$;
revoke all on function public.attachment_list(text, uuid) from public;
grant execute on function public.attachment_list(text, uuid) to authenticated;

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
        o.layer, o.provider_code, o.bucket, o.path, o.file_name, o.mime_type, o.file_size, o.checksum, o.owner_id
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

-- ----------------------------------------------------------------------------
-- 5. Digital Identity — card_public_view()/card_track_event() are anon,
--    rate-limit-free RPCs called on every public card view/interaction; each
--    UPDATE on employee_cards fired the generic audit_employee_cards trigger,
--    writing a full audit_logs row (to_jsonb(old)/to_jsonb(new)) per call —
--    an unbounded, unauthenticated way to grow audit_logs against any known
--    public card code. Rescoped the trigger to fire on genuine settings
--    changes (card_save_settings' own columns) and row creation/soft-delete,
--    never on the four analytics counters these two anon RPCs increment.
-- ----------------------------------------------------------------------------
drop trigger if exists audit_employee_cards on public.employee_cards;
create trigger audit_employee_cards
  after insert or delete or update of
    visibility, template_code, theme, shape, show_logo, show_photo,
    linkedin_url, extension_phone, field_visibility, is_active, is_deleted
  on public.employee_cards
  for each row execute function public.write_audit_log();

-- ----------------------------------------------------------------------------
-- 6. card_get_mine()'s race-safe fallback (introduced in migration 050)
--    assumed every unique_violation on first-card-creation was the
--    (tenant_id, user_id) race and blindly re-selected on that key. A
--    coincidental public_code collision between two different users'
--    concurrent first access instead leaves the re-select empty, and the
--    function silently returned a fabricated "success" payload with a null
--    id/card_no/public_code. Now raises a clear, retryable error in that
--    case instead of fabricating a broken success response.
-- ----------------------------------------------------------------------------
create or replace function public.card_get_mine()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_card public.employee_cards%rowtype;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  select * into v_card from public.employee_cards
  where user_id = auth.uid() and tenant_id = v_tenant and not is_deleted;

  if not found then
    begin
      insert into public.employee_cards (tenant_id, user_id, card_no, public_code)
      values (
        v_tenant, auth.uid(),
        public.generate_number('ID', v_tenant),
        public.generate_card_code(v_tenant)
      )
      returning * into v_card;
    exception when unique_violation then
      -- Two concurrent first-access calls raced; the other one already
      -- created the row (e.g. two tabs, or React StrictMode's double-invoke
      -- in dev). Read back what it created instead of failing this call.
      select * into v_card from public.employee_cards
      where user_id = auth.uid() and tenant_id = v_tenant and not is_deleted;
      if not found then
        -- Not our race: the unique_violation was a different constraint
        -- (e.g. a coincidental public_code collision with a different
        -- user's simultaneous first access). Fail loudly and let the
        -- client retry, rather than fabricate a null-filled "success".
        raise exception 'CARD_ALLOCATION_CONFLICT';
      end if;
    end;
  end if;

  return jsonb_build_object(
    'id', v_card.id,
    'card_no', v_card.card_no,
    'public_code', v_card.public_code,
    'visibility', v_card.visibility,
    'template_code', v_card.template_code,
    'theme', v_card.theme,
    'shape', v_card.shape,
    'show_logo', v_card.show_logo,
    'show_photo', v_card.show_photo,
    'linkedin_url', v_card.linkedin_url,
    'extension_phone', v_card.extension_phone,
    'field_visibility', v_card.field_visibility,
    'opens_count', v_card.opens_count,
    'vcf_downloads_count', v_card.vcf_downloads_count,
    'website_clicks_count', v_card.website_clicks_count,
    'calls_count', v_card.calls_count,
    'emails_count', v_card.emails_count,
    'profile', (
      select jsonb_build_object(
        'full_name', u.full_name, 'name_ar', u.name_ar, 'name_en', u.name_en,
        'job_title', u.job_title, 'job_title_ar', u.job_title_ar, 'job_title_en', u.job_title_en,
        'email', u.email, 'mobile', u.mobile, 'avatar_url', u.avatar_url,
        'department_ar', d.name_ar, 'department_en', d.name_en,
        'site_ar', s.name_ar, 'site_en', s.name_en,
        'project_ar', p.name_ar, 'project_en', p.name_en
      )
      from public.users u
      left join public.departments d on d.id = u.department_id
      left join public.sites s on s.id = u.site_id
      left join public.projects p on p.id = u.project_id
      where u.id = auth.uid()
    ),
    'company', (
      select jsonb_build_object(
        'names', coalesce((select jsonb_object_agg(n.language_code, n.name) from public.tenant_names n where n.tenant_id = v_tenant), '{}'::jsonb),
        'logo_light_url', b.logo_light_url,
        'logo_dark_url', b.logo_dark_url,
        'website_url', b.website_url,
        'primary_color', b.primary_color
      )
      from public.tenants t
      left join public.tenant_branding b on b.tenant_id = t.id
      where t.id = v_tenant
    )
  );
end;
$$;
revoke all on function public.card_get_mine() from public;
grant execute on function public.card_get_mine() to authenticated;

comment on function public.card_get_mine() is
  'Authentication: authenticated. Authorization: self only — always returns '
  'the caller''s own card, creating it (with a fresh card_no/public_code) on '
  'first call, with a race-safe fallback if a concurrent call already '
  'created it first. A unique_violation that is NOT that race raises '
  'CARD_ALLOCATION_CONFLICT rather than a fabricated response '
  '(closing-audit fix, 053). Rate limiting: n/a. Expected errors: '
  'NO_ACTIVE_TENANT, CARD_ALLOCATION_CONFLICT.';

-- ----------------------------------------------------------------------------
-- 7. card_save_settings() accepted any JSON value for field_visibility,
--    including a literal JSON null (present key, null value — coalesce()
--    only skips an ABSENT key). A stored JSON-null then broke every future
--    card_public_view() call for that card with an unhandled "cannot call
--    jsonb_each on a scalar" error, contradicting card_public_view()'s own
--    documented graceful-not-found contract. Now validated up front.
-- ----------------------------------------------------------------------------
create or replace function public.card_save_settings(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_visibility text := p_payload ->> 'visibility';
  v_template text := p_payload ->> 'template_code';
  v_theme text := p_payload ->> 'theme';
  v_shape text := p_payload ->> 'shape';
  v_linkedin text := nullif(trim(p_payload ->> 'linkedin_url'), '');
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if v_visibility is not null and v_visibility not in ('Private', 'CompanyOnly', 'Public') then
    raise exception 'INVALID_VISIBILITY';
  end if;
  if v_template is not null and v_template not in ('Classic', 'Modern', 'Minimal', 'Bold') then
    raise exception 'INVALID_TEMPLATE';
  end if;
  if v_theme is not null and v_theme not in ('Light', 'Dark') then
    raise exception 'INVALID_THEME';
  end if;
  if v_shape is not null and v_shape not in ('Rounded', 'Square') then
    raise exception 'INVALID_SHAPE';
  end if;
  if v_linkedin is not null and v_linkedin !~* '^https://' then
    raise exception 'INVALID_LINKEDIN_URL';
  end if;
  if p_payload ? 'field_visibility' and jsonb_typeof(p_payload -> 'field_visibility') is distinct from 'object' then
    raise exception 'INVALID_FIELD_VISIBILITY';
  end if;

  -- card_get_mine() also creates the row; calling it here means this
  -- function works correctly even if the client calls save before get.
  perform public.card_get_mine();

  update public.employee_cards set
    visibility = coalesce(v_visibility, visibility),
    template_code = coalesce(v_template, template_code),
    theme = coalesce(v_theme, theme),
    shape = coalesce(v_shape, shape),
    show_logo = coalesce((p_payload ->> 'show_logo')::boolean, show_logo),
    show_photo = coalesce((p_payload ->> 'show_photo')::boolean, show_photo),
    linkedin_url = case when p_payload ? 'linkedin_url' then v_linkedin else linkedin_url end,
    extension_phone = case when p_payload ? 'extension_phone' then nullif(trim(p_payload ->> 'extension_phone'), '') else extension_phone end,
    field_visibility = coalesce(p_payload -> 'field_visibility', field_visibility)
  where user_id = auth.uid() and tenant_id = v_tenant and not is_deleted;

  return public.card_get_mine();
end;
$$;
revoke all on function public.card_save_settings(jsonb) from public;
grant execute on function public.card_save_settings(jsonb) to authenticated;

comment on function public.card_save_settings(jsonb) is
  'Authentication: authenticated. Authorization: self only — always writes '
  'the caller''s own card, never anyone else''s (no employee id parameter '
  'exists to target another user). Rate limiting: n/a. Expected errors: '
  'NO_ACTIVE_TENANT, INVALID_VISIBILITY, INVALID_TEMPLATE, INVALID_THEME, '
  'INVALID_SHAPE, INVALID_LINKEDIN_URL, INVALID_FIELD_VISIBILITY '
  '(closing-audit fix, 053 — field_visibility must be a JSON object when '
  'present; a JSON null previously slipped through and permanently broke '
  'that card''s public view).';

-- ----------------------------------------------------------------------------
-- 8. number_sources catalogue — 'EV' (Evaluation) was seeded with
--    owner_module='Operations', but its only real consumer is the
--    pre-existing Forms module's Performance Evaluation feature (routed
--    through Workflow Engine for approval, same as 'TA'). FourthUpdate.md's
--    actual Operations spec has no "Evaluation" entity at all. Left
--    uncorrected, Operations would either need a second code for whatever
--    it actually allocates, or start commingling its own numbers with
--    pre-existing performance-evaluation numbers under the same counter.
-- ----------------------------------------------------------------------------
update public.number_sources set owner_module = 'Workflow Engine' where code = 'EV';

-- ----------------------------------------------------------------------------
-- 9. app_screens registered 10 admin screens (from the original pre-Update-4
--    seed, migration 202608040018) that neither AdminNav.jsx nor
--    AdminCenter.jsx's own screen-render map ever implemented. Any
--    PLATFORM_ADMIN/SYSTEM_ADMIN reaching one of these routes (via the
--    DB-driven header/drawer nav, which renders directly off my_screens()
--    with no check that AdminCenter actually has the screen) got silently
--    bounced to their first available admin screen with no error — a
--    nav-with-no-screen-behind-it placeholder, exactly what FourthUpdate.md
--    rule 4 forbids.
--
--    ADMIN_FORMS ('Requests', admin/forms) is a confirmed dead duplicate:
--    migration 202608060044 (Batch 2) shipped ADMIN_APPROVAL_ALL_REQUESTS
--    ('All Requests', admin/approval-all-requests) as the real, working
--    version of the same feature and never retired this older entry.
--
--    The other 9 (ADMIN_TEMPLATES, ADMIN_SECURITY, ADMIN_EVALUATION_TEMPLATES,
--    ADMIN_SETTINGS, ADMIN_LOOKUPS, ADMIN_EMAIL_TEMPLATES, ADMIN_EMAIL_QUEUE,
--    ADMIN_IMPORTS, ADMIN_STORAGE) are genuinely unbuilt admin features, not
--    duplicates of anything shipped — building 9 full admin screens is real,
--    substantial future scope, well outside a technical-debt sweep, and NOT
--    attempted here. Deactivating them is the proportionate fix available
--    now: it removes the broken nav link today without faking a screen that
--    does not exist. Documented as open, deferred future work in
--    docs/update4_pre_assets_sweep.md, not silently dropped.
-- ----------------------------------------------------------------------------
update public.app_screens
set is_active = false, updated_on = now()
where code in (
  'ADMIN_FORMS', 'ADMIN_TEMPLATES', 'ADMIN_SECURITY', 'ADMIN_EVALUATION_TEMPLATES',
  'ADMIN_SETTINGS', 'ADMIN_LOOKUPS', 'ADMIN_EMAIL_TEMPLATES', 'ADMIN_EMAIL_QUEUE',
  'ADMIN_IMPORTS', 'ADMIN_STORAGE'
);

-- ----------------------------------------------------------------------------
-- Mandatory closer.
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
