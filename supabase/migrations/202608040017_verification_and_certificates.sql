-- ============================================================================
-- 017 — Document verification and the certificate factory
--
-- Two things live here:
--   * verifiable_documents — the single public handle for anything a company
--     wants a third party to be able to check. Approved form requests land here
--     automatically; letters and attestations are entered by hand; certificates
--     are produced in bulk from a template and a spreadsheet.
--   * the certificate factory — a background image plus absolutely positioned
--     fields, so one Excel sheet produces hundreds of identical certificates.
--
-- The verification page is public and cross-company: a visitor types a code and
-- gets the issuing company, the document type and the validity. The code itself
-- is the tenant key (generate_verify_code prefixes it with the company slug), so
-- verify_document is the only read path that is not tenant scoped by session —
-- it resolves the company from the code and returns nothing else about it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Document codes
--    generate_verify_code (012) only avoids collisions inside public.forms.
--    A document code has to be unique across forms AND documents, so allocation
--    retries until both namespaces are clear.
-- ----------------------------------------------------------------------------

create table if not exists public.verifiable_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null unique,
  doc_type text not null default 'Attestation'
    check (doc_type in ('FormRequest', 'Letter', 'Attestation', 'Certificate', 'Custom')),
  -- Polymorphic origin. Deliberately not a foreign key: a document may outlive
  -- the row it was produced from, and it points at several different tables.
  source_table text,
  source_id uuid,
  title_ar text,
  title_en text,
  subject_ar text,
  subject_en text,
  holder_employee_id uuid references public.users(id),
  holder_name text,
  issued_on timestamptz,
  valid_until timestamptz,
  status text not null default 'Draft'
    check (status in ('Draft', 'PendingApproval', 'Active', 'Revoked', 'Expired')),
  seal_style text not null default 'Blue'
    check (seal_style in ('Blue', 'Gold')),
  file_provider text,
  file_external_id text,
  file_url text,
  file_mime text,
  file_size bigint,
  metadata jsonb not null default '{}'::jsonb,
  revoked_on timestamptz,
  revoked_by uuid references auth.users(id),
  revoked_reason text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_verifiable_documents_tenant
  on public.verifiable_documents (tenant_id);

-- The code is the public handle; lookups are case insensitive because it gets
-- typed by hand off a printed page.
create unique index if not exists uq_verifiable_documents_code_lower
  on public.verifiable_documents (lower(code));

-- One document per source row, so re-approving a request refreshes it instead
-- of minting a second code.
create unique index if not exists uq_verifiable_documents_source
  on public.verifiable_documents (tenant_id, source_table, source_id)
  where source_id is not null and not is_deleted;

create index if not exists idx_verifiable_documents_tenant_status
  on public.verifiable_documents (tenant_id, status, issued_on desc)
  where not is_deleted;

create index if not exists idx_verifiable_documents_holder
  on public.verifiable_documents (tenant_id, holder_employee_id)
  where not is_deleted;

create index if not exists idx_verifiable_documents_expiry
  on public.verifiable_documents (valid_until)
  where valid_until is not null and status = 'Active';

create unique index if not exists uq_verifiable_documents_tenant_id
  on public.verifiable_documents (tenant_id, id);

do $guards$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_verifiable_documents_holder_same_tenant') then
    alter table public.verifiable_documents
      add constraint fk_verifiable_documents_holder_same_tenant
      foreign key (tenant_id, holder_employee_id) references public.users (tenant_id, id);
  end if;
end $guards$;

drop trigger if exists apply_row_defaults on public.verifiable_documents;
create trigger apply_row_defaults before insert or update on public.verifiable_documents
for each row execute function public.apply_row_defaults();

alter table public.verifiable_documents enable row level security;

drop policy if exists "tenant isolation" on public.verifiable_documents;
create policy "tenant isolation" on public.verifiable_documents
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "verification managers manage documents" on public.verifiable_documents;
create policy "verification managers manage documents" on public.verifiable_documents
  for all to authenticated
  using (public.has_permission('Verification.Manage'))
  with check (public.has_permission('Verification.Manage'));

drop policy if exists "holders and viewers read documents" on public.verifiable_documents;
create policy "holders and viewers read documents" on public.verifiable_documents
  for select to authenticated
  using (
    not is_deleted
    and (
      holder_employee_id = auth.uid()
      or created_by = auth.uid()
      or public.has_permission('Verification.View')
      or public.has_permission('Certificates.Manage')
    )
  );

create or replace function public.generate_document_code(p_tenant_id uuid default null)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := coalesce(p_tenant_id, public.current_tenant_id());
  v_candidate text;
  v_attempts integer := 0;
begin
  loop
    v_candidate := public.generate_verify_code(v_tenant);
    exit when not exists (
      select 1 from public.verifiable_documents d where lower(d.code) = lower(v_candidate)
    );
    v_attempts := v_attempts + 1;
    if v_attempts > 50 then
      raise exception 'DOCUMENT_CODE_ALLOCATION_FAILED';
    end if;
  end loop;
  return v_candidate;
end;
$$;
grant execute on function public.generate_document_code(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. Type one — approved form requests publish themselves
--    The form keeps its own verify_code as the document code so printouts that
--    are already circulating keep resolving.
-- ----------------------------------------------------------------------------

create or replace function public.publish_form_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
  v_days integer;
  v_code text;
  v_doc_id uuid;
  v_name_ar text;
  v_name_en text;
  v_tpl_code text;
  v_holder text;
  v_valid_until timestamptz;
begin
  -- A cancelled request is terminal: whatever was published stops being valid.
  if new.status = 'Cancelled' then
    update public.verifiable_documents
    set status = 'Revoked',
        revoked_on = coalesce(revoked_on, now()),
        revoked_reason = coalesce(revoked_reason, 'FORM_CANCELLED')
    where tenant_id = new.tenant_id
      and source_table = 'forms'
      and source_id = new.id
      and status <> 'Revoked';
    return null;
  end if;

  if new.status <> 'Approved' or new.approval_completed_on is null then
    return null;
  end if;

  select coalesce(s.verification_enabled, true), coalesce(s.verification_validity_days, 0)
  into v_enabled, v_days
  from public.tenants t
  left join public.tenant_settings s on s.tenant_id = t.id
  where t.id = new.tenant_id;

  if not coalesce(v_enabled, true) then
    return null;
  end if;
  if not public.tenant_has_module('VERIFICATION', new.tenant_id) then
    return null;
  end if;

  select tpl.name_ar, tpl.name_en, tpl.code
  into v_name_ar, v_name_en, v_tpl_code
  from public.templates tpl
  where tpl.id = new.template_id;

  select case when u.id is not null then public.approval_display_name(u) end
  into v_holder
  from public.users u
  where u.id = new.employee_id;

  v_valid_until := case
    when v_days > 0 then new.approval_completed_on + make_interval(days => v_days)
    else null
  end;

  -- Pick the row to refresh explicitly: a document that was soft deleted still
  -- owns the form's code, so reviving it beats minting a second one.
  select d.id into v_doc_id
  from public.verifiable_documents d
  where d.tenant_id = new.tenant_id
    and d.source_table = 'forms'
    and d.source_id = new.id
  order by d.is_deleted, d.created_on desc
  limit 1;

  if v_doc_id is not null then
    update public.verifiable_documents
    set status = 'Active',
        doc_type = 'FormRequest',
        title_ar = v_name_ar,
        title_en = v_name_en,
        holder_employee_id = new.employee_id,
        holder_name = v_holder,
        issued_on = new.approval_completed_on,
        valid_until = v_valid_until,
        revoked_on = null,
        revoked_by = null,
        revoked_reason = null,
        is_deleted = false,
        metadata = jsonb_build_object(
          'reference_no', new.reference_no,
          'template_code', v_tpl_code,
          'form_id', new.id,
          'submitted_on', new.submitted_on
        )
    where id = v_doc_id;
    return null;
  end if;

  v_code := coalesce(nullif(trim(new.verify_code), ''), public.generate_document_code(new.tenant_id));

  insert into public.verifiable_documents (
    tenant_id, code, doc_type, source_table, source_id,
    title_ar, title_en, holder_employee_id, holder_name,
    issued_on, valid_until, status, seal_style, metadata,
    created_by, updated_by
  )
  values (
    new.tenant_id, v_code, 'FormRequest', 'forms', new.id,
    v_name_ar, v_name_en, new.employee_id, v_holder,
    new.approval_completed_on, v_valid_until, 'Active', 'Blue',
    jsonb_build_object(
      'reference_no', new.reference_no,
      'template_code', v_tpl_code,
      'form_id', new.id,
      'submitted_on', new.submitted_on
    ),
    new.requested_by, new.requested_by
  )
  -- Publication is a side effect of approving; a code clash must never abort
  -- the approval itself.
  on conflict (code) do nothing;

  return null;
end;
$$;

drop trigger if exists publish_form_verification on public.forms;
create trigger publish_form_verification
after update on public.forms
for each row
when (
  (
    new.status = 'Approved'
    and new.approval_completed_on is not null
    and (
      old.status is distinct from new.status
      or old.approval_completed_on is distinct from new.approval_completed_on
    )
  )
  or (new.status = 'Cancelled' and old.status is distinct from 'Cancelled')
)
execute function public.publish_form_verification();

-- ----------------------------------------------------------------------------
-- 3. Type two — manual attestations (the chamber-of-commerce pattern)
-- ----------------------------------------------------------------------------

create or replace function public.attestation_create(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id uuid := nullif(p_payload ->> 'id', '')::uuid;
  v_doc public.verifiable_documents%rowtype;
  v_doc_type text := coalesce(nullif(p_payload ->> 'doc_type', ''), 'Attestation');
  v_status text;
  v_seal text := coalesce(nullif(p_payload ->> 'seal_style', ''), 'Blue');
  v_title_ar text := nullif(trim(coalesce(p_payload ->> 'title_ar', '')), '');
  v_code text;
begin
  if v_tenant is null then
    raise exception 'NO_ACTIVE_TENANT';
  end if;
  if not public.has_permission('Verification.Manage') then
    raise exception 'PERMISSION_DENIED';
  end if;
  if not public.tenant_has_module('VERIFICATION', v_tenant) then
    raise exception 'MODULE_NOT_ENABLED';
  end if;

  -- FormRequest and Certificate documents are machine produced; the manual
  -- screen may not forge one.
  if v_doc_type not in ('Letter', 'Attestation', 'Custom') then
    raise exception 'INVALID_DOC_TYPE';
  end if;
  if v_seal not in ('Blue', 'Gold') then
    raise exception 'INVALID_SEAL_STYLE';
  end if;
  if v_title_ar is null then
    raise exception 'TITLE_REQUIRED';
  end if;

  v_status := case
    when coalesce((p_payload ->> 'submit')::boolean, false) then 'PendingApproval'
    else 'Draft'
  end;

  if v_id is not null then
    select * into v_doc from public.verifiable_documents
    where id = v_id and tenant_id = v_tenant and not is_deleted;
    if not found then
      raise exception 'DOCUMENT_NOT_FOUND';
    end if;
    if v_doc.status not in ('Draft', 'PendingApproval') then
      raise exception 'DOCUMENT_LOCKED';
    end if;

    update public.verifiable_documents
    set doc_type = v_doc_type,
        title_ar = v_title_ar,
        title_en = nullif(trim(coalesce(p_payload ->> 'title_en', '')), ''),
        subject_ar = nullif(trim(coalesce(p_payload ->> 'subject_ar', '')), ''),
        subject_en = nullif(trim(coalesce(p_payload ->> 'subject_en', '')), ''),
        holder_employee_id = nullif(p_payload ->> 'holder_employee_id', '')::uuid,
        holder_name = nullif(trim(coalesce(p_payload ->> 'holder_name', '')), ''),
        valid_until = nullif(p_payload ->> 'valid_until', '')::timestamptz,
        seal_style = v_seal,
        file_provider = nullif(p_payload ->> 'file_provider', ''),
        file_external_id = nullif(p_payload ->> 'file_external_id', ''),
        file_url = nullif(p_payload ->> 'file_url', ''),
        file_mime = nullif(p_payload ->> 'file_mime', ''),
        file_size = nullif(p_payload ->> 'file_size', '')::bigint,
        metadata = coalesce(p_payload -> 'metadata', v_doc.metadata),
        status = v_status
    where id = v_id
    returning * into v_doc;

    return jsonb_build_object('id', v_doc.id, 'code', v_doc.code, 'status', v_doc.status);
  end if;

  v_code := public.generate_document_code(v_tenant);

  insert into public.verifiable_documents (
    tenant_id, code, doc_type, source_table, source_id,
    title_ar, title_en, subject_ar, subject_en,
    holder_employee_id, holder_name, issued_on, valid_until,
    status, seal_style, file_provider, file_external_id, file_url,
    file_mime, file_size, metadata
  )
  values (
    v_tenant, v_code, v_doc_type, 'attestations', null,
    v_title_ar,
    nullif(trim(coalesce(p_payload ->> 'title_en', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'subject_ar', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'subject_en', '')), ''),
    nullif(p_payload ->> 'holder_employee_id', '')::uuid,
    nullif(trim(coalesce(p_payload ->> 'holder_name', '')), ''),
    nullif(p_payload ->> 'issued_on', '')::timestamptz,
    nullif(p_payload ->> 'valid_until', '')::timestamptz,
    v_status, v_seal,
    nullif(p_payload ->> 'file_provider', ''),
    nullif(p_payload ->> 'file_external_id', ''),
    nullif(p_payload ->> 'file_url', ''),
    nullif(p_payload ->> 'file_mime', ''),
    nullif(p_payload ->> 'file_size', '')::bigint,
    coalesce(p_payload -> 'metadata', '{}'::jsonb)
  )
  returning * into v_doc;

  return jsonb_build_object('id', v_doc.id, 'code', v_doc.code, 'status', v_doc.status);
end;
$$;
grant execute on function public.attestation_create(jsonb) to authenticated;

create or replace function public.attestation_approve(p_id uuid)
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
  if v_doc.doc_type = 'FormRequest' then
    raise exception 'DOCUMENT_NOT_MANUAL';
  end if;
  if v_doc.status not in ('Draft', 'PendingApproval') then
    raise exception 'DOCUMENT_NOT_PENDING';
  end if;

  update public.verifiable_documents
  set status = 'Active',
      issued_on = coalesce(issued_on, now()),
      revoked_on = null,
      revoked_by = null,
      revoked_reason = null
  where id = p_id
  returning * into v_doc;

  return jsonb_build_object(
    'id', v_doc.id, 'code', v_doc.code, 'status', v_doc.status,
    'issued_on', v_doc.issued_on, 'valid_until', v_doc.valid_until
  );
end;
$$;
grant execute on function public.attestation_approve(uuid) to authenticated;

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

-- ----------------------------------------------------------------------------
-- 4. The certificate factory
--    A template is a background image plus absolutely positioned fields. The
--    designer drags a field onto the image and stores the pixel offset; the
--    renderer replays those offsets over the same background.
-- ----------------------------------------------------------------------------

create table if not exists public.certificate_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name_ar text not null,
  name_en text,
  description_ar text,
  description_en text,
  background_url text,
  background_provider text,
  background_external_id text,
  page_width_px integer not null default 1123,
  page_height_px integer not null default 794,
  orientation text not null default 'Landscape'
    check (orientation in ('Portrait', 'Landscape')),
  seal_style text not null default 'Gold'
    check (seal_style in ('Blue', 'Gold')),
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_certificate_templates_tenant
  on public.certificate_templates (tenant_id);

create unique index if not exists uq_certificate_templates_code_tenant
  on public.certificate_templates (tenant_id, lower(code)) where not is_deleted;

create unique index if not exists uq_certificate_templates_tenant_id
  on public.certificate_templates (tenant_id, id);

create table if not exists public.certificate_template_fields (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  template_id uuid not null references public.certificate_templates(id) on delete cascade,
  field_key text not null,
  label_ar text,
  label_en text,
  field_type text not null default 'Text'
    check (field_type in ('Text', 'Date', 'Number', 'Image', 'QR', 'Code')),
  -- Offsets are stored exactly as the designer dropped them; anchor decides
  -- which corner pos_x_px is measured from, so RTL layouts stay honest.
  pos_x_px numeric(10, 2) not null default 0,
  pos_y_px numeric(10, 2) not null default 0,
  width_px numeric(10, 2),
  height_px numeric(10, 2),
  font_family text,
  font_size_px numeric(10, 2) not null default 16,
  font_weight text not null default '400',
  color text not null default '#111827',
  align text not null default 'Start'
    check (align in ('Start', 'Center', 'End')),
  anchor text not null default 'TopStart'
    check (anchor in ('TopStart', 'TopEnd', 'TopCenter')),
  default_value text,
  is_required boolean not null default false,
  display_order integer not null default 0,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_certificate_template_fields_tenant
  on public.certificate_template_fields (tenant_id);

create index if not exists idx_certificate_template_fields_template
  on public.certificate_template_fields (tenant_id, template_id, display_order)
  where not is_deleted;

create unique index if not exists uq_certificate_template_fields_key
  on public.certificate_template_fields (tenant_id, template_id, lower(field_key))
  where not is_deleted;

create table if not exists public.certificate_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  template_id uuid not null references public.certificate_templates(id),
  name text,
  source_file_name text,
  total_rows integer not null default 0,
  generated_rows integer not null default 0,
  failed_rows integer not null default 0,
  status text not null default 'Pending'
    check (status in ('Pending', 'Processing', 'Completed', 'Failed', 'Cancelled')),
  errors_json jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_certificate_batches_tenant
  on public.certificate_batches (tenant_id);

create index if not exists idx_certificate_batches_template
  on public.certificate_batches (tenant_id, template_id, created_on desc)
  where not is_deleted;

create unique index if not exists uq_certificate_batches_tenant_id
  on public.certificate_batches (tenant_id, id);

create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  template_id uuid not null references public.certificate_templates(id),
  batch_id uuid references public.certificate_batches(id),
  document_id uuid references public.verifiable_documents(id),
  recipient_name text not null,
  recipient_employee_id uuid references public.users(id),
  data_json jsonb not null default '{}'::jsonb,
  issued_on timestamptz not null default now(),
  valid_until timestamptz,
  status text not null default 'Active'
    check (status in ('Draft', 'Active', 'Revoked')),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_certificates_tenant
  on public.certificates (tenant_id);

create index if not exists idx_certificates_batch
  on public.certificates (tenant_id, batch_id, created_on)
  where not is_deleted;

create index if not exists idx_certificates_template
  on public.certificates (tenant_id, template_id, issued_on desc)
  where not is_deleted;

create index if not exists idx_certificates_recipient
  on public.certificates (tenant_id, recipient_employee_id)
  where not is_deleted;

create index if not exists idx_certificates_document
  on public.certificates (document_id);

do $guards$
begin
  -- Both foreign keys on this pair cascade, so a hard template delete has a
  -- single well defined outcome instead of racing a NO ACTION check.
  if not exists (select 1 from pg_constraint where conname = 'fk_cert_fields_template_same_tenant') then
    alter table public.certificate_template_fields
      add constraint fk_cert_fields_template_same_tenant
      foreign key (tenant_id, template_id) references public.certificate_templates (tenant_id, id)
      on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_cert_batches_template_same_tenant') then
    alter table public.certificate_batches
      add constraint fk_cert_batches_template_same_tenant
      foreign key (tenant_id, template_id) references public.certificate_templates (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_certificates_template_same_tenant') then
    alter table public.certificates
      add constraint fk_certificates_template_same_tenant
      foreign key (tenant_id, template_id) references public.certificate_templates (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_certificates_batch_same_tenant') then
    alter table public.certificates
      add constraint fk_certificates_batch_same_tenant
      foreign key (tenant_id, batch_id) references public.certificate_batches (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_certificates_document_same_tenant') then
    alter table public.certificates
      add constraint fk_certificates_document_same_tenant
      foreign key (tenant_id, document_id) references public.verifiable_documents (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_certificates_recipient_same_tenant') then
    alter table public.certificates
      add constraint fk_certificates_recipient_same_tenant
      foreign key (tenant_id, recipient_employee_id) references public.users (tenant_id, id);
  end if;
end $guards$;

do $wiring$
declare
  certificate_tables text[] := array[
    'certificate_templates', 'certificate_template_fields',
    'certificate_batches', 'certificates'
  ];
  tbl text;
begin
  foreach tbl in array certificate_tables loop
    execute format('drop trigger if exists apply_row_defaults on public.%I', tbl);
    execute format(
      'create trigger apply_row_defaults before insert or update on public.%I
       for each row execute function public.apply_row_defaults()',
      tbl
    );
    execute format('alter table public.%I enable row level security', tbl);
    execute format('drop policy if exists "tenant isolation" on public.%I', tbl);
    execute format(
      'create policy "tenant isolation" on public.%I
         as restrictive for all to authenticated
         using (tenant_id = public.current_tenant_id())
         with check (tenant_id = public.current_tenant_id())',
      tbl
    );
    execute format('drop policy if exists "certificate managers manage" on public.%I', tbl);
    execute format(
      'create policy "certificate managers manage" on public.%I
         for all to authenticated
         using (public.has_permission(''Certificates.Manage''))
         with check (public.has_permission(''Certificates.Manage''))',
      tbl
    );
  end loop;
end $wiring$;

-- Templates and their fields are rendering instructions, not private data: any
-- member of the company may read them to draw a certificate they own.
drop policy if exists "members read certificate templates" on public.certificate_templates;
create policy "members read certificate templates" on public.certificate_templates
  for select to authenticated
  using (not is_deleted);

drop policy if exists "members read certificate fields" on public.certificate_template_fields;
create policy "members read certificate fields" on public.certificate_template_fields
  for select to authenticated
  using (not is_deleted);

drop policy if exists "recipients read own certificates" on public.certificates;
create policy "recipients read own certificates" on public.certificates
  for select to authenticated
  using (
    not is_deleted
    and (
      recipient_employee_id = auth.uid()
      or public.has_permission('Verification.View')
    )
  );

drop policy if exists "verification viewers read batches" on public.certificate_batches;
create policy "verification viewers read batches" on public.certificate_batches
  for select to authenticated
  using (not is_deleted and public.has_permission('Verification.View'));

-- ----------------------------------------------------------------------------
-- 5. Bulk issue — one Excel sheet in, one verifiable document per row out
-- ----------------------------------------------------------------------------

create or replace function public.certificate_issue(p_template_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_tpl public.certificate_templates%rowtype;
  v_batch_id uuid;
  v_total integer;
  v_generated integer := 0;
  v_failed integer := 0;
  v_row jsonb;
  v_index integer := 0;
  v_name text;
  v_cert_id uuid;
  v_doc_id uuid;
  v_code text;
  v_issued timestamptz;
  v_valid_until timestamptz;
  v_quota jsonb;
  v_codes jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
begin
  if v_tenant is null then
    raise exception 'NO_ACTIVE_TENANT';
  end if;
  if not public.has_permission('Certificates.Manage') then
    raise exception 'PERMISSION_DENIED';
  end if;
  if not public.tenant_has_module('CERTIFICATES', v_tenant) then
    raise exception 'MODULE_NOT_ENABLED';
  end if;

  select * into v_tpl from public.certificate_templates
  where id = p_template_id and tenant_id = v_tenant and not is_deleted;
  if not found then
    raise exception 'TEMPLATE_NOT_FOUND';
  end if;
  if not v_tpl.is_active then
    raise exception 'TEMPLATE_INACTIVE';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'INVALID_ROWS';
  end if;

  v_total := jsonb_array_length(p_rows);
  if v_total = 0 then
    raise exception 'NO_ROWS';
  end if;
  if v_total > 5000 then
    raise exception 'TOO_MANY_ROWS';
  end if;

  v_quota := public.tenant_quota_check('CERTIFICATES', v_total);
  if not coalesce((v_quota ->> 'allowed')::boolean, true) then
    raise exception 'QUOTA_EXCEEDED';
  end if;

  insert into public.certificate_batches (
    tenant_id, template_id, name, source_file_name, total_rows, status
  )
  values (
    v_tenant,
    p_template_id,
    nullif(trim(coalesce(p_rows #>> '{0,batch_name}', '')), ''),
    nullif(trim(coalesce(p_rows #>> '{0,source_file_name}', '')), ''),
    v_total,
    'Processing'
  )
  returning id into v_batch_id;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_index := v_index + 1;

    -- One bad spreadsheet row must not lose the whole sheet.
    begin
      v_name := coalesce(
        nullif(trim(coalesce(v_row ->> 'recipient_name', '')), ''),
        nullif(trim(coalesce(v_row ->> 'name', '')), ''),
        nullif(trim(coalesce(v_row ->> 'full_name', '')), '')
      );
      if v_name is null then
        raise exception 'RECIPIENT_NAME_REQUIRED';
      end if;

      v_issued := coalesce(nullif(v_row ->> 'issued_on', '')::timestamptz, now());
      v_valid_until := nullif(v_row ->> 'valid_until', '')::timestamptz;
      v_cert_id := gen_random_uuid();
      v_code := public.generate_document_code(v_tenant);

      insert into public.verifiable_documents (
        tenant_id, code, doc_type, source_table, source_id,
        title_ar, title_en, holder_employee_id, holder_name,
        issued_on, valid_until, status, seal_style, metadata
      )
      values (
        v_tenant, v_code, 'Certificate', 'certificates', v_cert_id,
        v_tpl.name_ar, v_tpl.name_en,
        nullif(v_row ->> 'recipient_employee_id', '')::uuid,
        v_name,
        v_issued, v_valid_until, 'Active', v_tpl.seal_style,
        jsonb_build_object('template_id', p_template_id, 'batch_id', v_batch_id)
      )
      returning id into v_doc_id;

      insert into public.certificates (
        id, tenant_id, template_id, batch_id, document_id,
        recipient_name, recipient_employee_id, data_json,
        issued_on, valid_until, status
      )
      values (
        v_cert_id, v_tenant, p_template_id, v_batch_id, v_doc_id,
        v_name,
        nullif(v_row ->> 'recipient_employee_id', '')::uuid,
        v_row,
        v_issued, v_valid_until, 'Active'
      );

      v_generated := v_generated + 1;
      v_codes := v_codes || jsonb_build_object(
        'row', v_index, 'certificate_id', v_cert_id, 'code', v_code, 'recipient_name', v_name
      );
    exception when others then
      v_failed := v_failed + 1;
      v_errors := v_errors || jsonb_build_object('row', v_index, 'error', sqlerrm);
    end;
  end loop;

  update public.certificate_batches
  set generated_rows = v_generated,
      failed_rows = v_failed,
      errors_json = v_errors,
      status = case when v_generated = 0 then 'Failed' else 'Completed' end
  where id = v_batch_id;

  if v_generated > 0 then
    perform public.tenant_quota_consume('CERTIFICATES', v_generated, v_tenant);
  end if;

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'total_rows', v_total,
    'generated_rows', v_generated,
    'failed_rows', v_failed,
    'codes', v_codes,
    'errors', v_errors
  );
end;
$$;
grant execute on function public.certificate_issue(uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. The public verification endpoint
--    Anonymous, cross-company, and the only read path that is not scoped by the
--    session tenant: the code itself carries the company. Everything returned
--    is deliberately minimal — identity of the document and of the issuer, and
--    for a form request the same approval timeline approval_verify publishes.
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

  if v_form_id is not null then
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

-- approval_verify (0009) keeps its own payload shape because the approval
-- screens already consume it; delegating here would change that contract.

-- Maintenance sweep for the stored 'Expired' status. Never returns data, so it
-- stays a service_role job rather than an RPC.
create or replace function public.verification_expire_documents(p_tenant_id uuid default null)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.verifiable_documents
  set status = 'Expired'
  where status = 'Active'
    and valid_until is not null
    and valid_until < now()
    and (p_tenant_id is null or tenant_id = p_tenant_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.verification_expire_documents(uuid) from public;
grant execute on function public.verification_expire_documents(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 7. Permissions
-- ----------------------------------------------------------------------------

insert into public.permissions (code, module, description) values
  ('Certificates.Manage', 'Certificates', 'Design certificate templates and issue certificates'),
  ('Verification.View', 'Verification', 'Browse the company verifiable documents and certificates')
on conflict (code) do nothing;

insert into public.role_permissions (tenant_id, role_id, permission_id)
select r.tenant_id, r.id, p.id
from public.roles r
join public.permissions p on p.code in ('Certificates.Manage', 'Verification.View')
where r.code in ('PLATFORM_ADMIN', 'SYSTEM_ADMIN')
  and not r.is_deleted
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- 8. Backfill: requests that were already approved become verifiable now
-- ----------------------------------------------------------------------------

insert into public.verifiable_documents (
  tenant_id, code, doc_type, source_table, source_id,
  title_ar, title_en, holder_employee_id, holder_name,
  issued_on, valid_until, status, seal_style, metadata,
  created_by, updated_by
)
select
  f.tenant_id,
  f.verify_code,
  'FormRequest',
  'forms',
  f.id,
  tpl.name_ar,
  tpl.name_en,
  f.employee_id,
  case when emp.id is not null then public.approval_display_name(emp) end,
  coalesce(f.approval_completed_on, f.updated_on),
  case
    when coalesce(s.verification_validity_days, 0) > 0
      then coalesce(f.approval_completed_on, f.updated_on)
           + make_interval(days => s.verification_validity_days)
    else null
  end,
  'Active',
  'Blue',
  jsonb_build_object(
    'reference_no', f.reference_no,
    'template_code', tpl.code,
    'form_id', f.id,
    'submitted_on', f.submitted_on
  ),
  f.created_by,
  f.updated_by
from public.forms f
join public.templates tpl on tpl.id = f.template_id
left join public.users emp on emp.id = f.employee_id
left join public.tenant_settings s on s.tenant_id = f.tenant_id
where f.status = 'Approved'
  and not f.is_deleted
  and f.verify_code is not null
  and coalesce(s.verification_enabled, true)
-- Untargeted, so every unique index arbitrates: the code, its case insensitive
-- twin, and uq_verifiable_documents_source. A form whose document was minted
-- with a generated code (verify_code was still null at approval time) would
-- otherwise pass the code check and abort the whole migration on the source
-- index when the file is applied a second time.
on conflict do nothing;
