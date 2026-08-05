-- ============================================================================
-- 020 — Close the tenancy gaps in the pre-existing engine
--
-- Row level security does not protect a SECURITY DEFINER function: the function
-- runs as its owner and sees every row. Every definer function written before
-- the platform became multi-tenant therefore has to be re-stated with an
-- explicit company filter, and every person-to-person routing path has to be
-- constrained so a request can never be handed to somebody in another company.
--
-- The routing constraints are declarative on purpose. A guard that lives in a
-- function only protects the paths that call that function; a composite foreign
-- key protects every path there will ever be.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. A request can only ever move between people of its own company
-- ----------------------------------------------------------------------------

create unique index if not exists uq_form_approval_tx_tenant_id
  on public.form_approval_transactions (tenant_id, id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_forms_assignee_same_tenant') then
    alter table public.forms
      add constraint fk_forms_assignee_same_tenant
      foreign key (tenant_id, current_assignee_id) references public.users (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_forms_return_to_same_tenant') then
    alter table public.forms
      add constraint fk_forms_return_to_same_tenant
      foreign key (tenant_id, return_to_user_id) references public.users (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_forms_approval_role_same_tenant') then
    alter table public.forms
      add constraint fk_forms_approval_role_same_tenant
      foreign key (tenant_id, current_approval_role_id) references public.approval_roles (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_form_tx_form_same_tenant') then
    alter table public.form_approval_transactions
      add constraint fk_form_tx_form_same_tenant
      foreign key (tenant_id, form_id) references public.forms (tenant_id, id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_form_tx_actor_same_tenant') then
    alter table public.form_approval_transactions
      add constraint fk_form_tx_actor_same_tenant
      foreign key (tenant_id, actor_id) references public.users (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_form_tx_to_user_same_tenant') then
    alter table public.form_approval_transactions
      add constraint fk_form_tx_to_user_same_tenant
      foreign key (tenant_id, to_user_id) references public.users (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_attachments_form_same_tenant') then
    alter table public.form_attachments
      add constraint fk_attachments_form_same_tenant
      foreign key (tenant_id, form_id) references public.forms (tenant_id, id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_templates_scheme_same_tenant') then
    alter table public.templates
      add constraint fk_templates_scheme_same_tenant
      foreign key (tenant_id, approval_scheme_id) references public.approval_schemes (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_users_department_same_tenant') then
    alter table public.users
      add constraint fk_users_department_same_tenant
      foreign key (tenant_id, department_id) references public.departments (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_users_project_same_tenant') then
    alter table public.users
      add constraint fk_users_project_same_tenant
      foreign key (tenant_id, project_id) references public.projects (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_users_site_same_tenant') then
    alter table public.users
      add constraint fk_users_site_same_tenant
      foreign key (tenant_id, site_id) references public.sites (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_users_position_same_tenant') then
    alter table public.users
      add constraint fk_users_position_same_tenant
      foreign key (tenant_id, position_id) references public.positions (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_users_manager_same_tenant') then
    alter table public.users
      add constraint fk_users_manager_same_tenant
      foreign key (tenant_id, manager_id) references public.users (tenant_id, id);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. The employee directory used for delegated submissions
--    Previously returned every employee of every company.
-- ----------------------------------------------------------------------------

create or replace function public.list_form_recipients()
returns table (
  id uuid,
  employee_no text,
  full_name text,
  name_ar text,
  name_en text,
  department text,
  job_title text,
  nationality text,
  gender text,
  national_id text,
  project text,
  sector text,
  site text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    u.id,
    u.employee_no,
    u.full_name,
    u.name_ar,
    u.name_en,
    u.department,
    u.job_title,
    u.nationality,
    u.gender,
    u.national_id,
    p.name_ar as project,
    u.sector,
    s.name_ar as site
  from public.users u
  left join public.projects p on p.id = u.project_id
  left join public.sites s on s.id = u.site_id
  where u.is_active
    and not u.is_deleted
    and u.tenant_id = public.current_tenant_id()
  order by coalesce(u.name_ar, u.name_en, u.full_name);
$$;

revoke all on function public.list_form_recipients() from public;
grant execute on function public.list_form_recipients() to authenticated;

-- ----------------------------------------------------------------------------
-- 3. The approval administration dashboard
--    Previously aggregated every request of every company for anybody holding
--    Approvals.Manage in any one of them.
-- ----------------------------------------------------------------------------

create or replace function public.approval_dashboard_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
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
        and f.tenant_id = v_tenant
    ), '[]'::jsonb),
    'completed', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'status', f.status,
        'approval_started_on', f.approval_started_on, 'approval_completed_on', f.approval_completed_on,
        'updated_on', f.updated_on
      ))
      from public.forms f
      where f.status in ('Approved', 'Rejected') and not f.is_deleted
        and f.tenant_id = v_tenant
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
        and tx.tenant_id = v_tenant
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.approval_dashboard_data() to authenticated;

-- ----------------------------------------------------------------------------
-- 4. Public verification must name the issuing company
--    The code alone is public; everything else about the company is not, so the
--    payload carries only the identity a recipient needs to trust the document.
-- ----------------------------------------------------------------------------

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
-- 5. Colleagues need to find each other — but a directory is not a personnel
--    file. public.users carries national_id, gender and mobile, so it stays
--    closed and the directory is a function that returns only the columns a
--    picker needs, inside the caller's company.
-- ----------------------------------------------------------------------------

drop policy if exists "colleagues read directory" on public.users;

create or replace function public.employee_directory(
  p_query text default null,
  p_limit integer default 200
)
returns table (
  id uuid,
  employee_no text,
  full_name text,
  name_ar text,
  name_en text,
  email text,
  job_title text,
  department_id uuid,
  avatar_url text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    u.id,
    u.employee_no,
    u.full_name,
    u.name_ar,
    u.name_en,
    u.email,
    u.job_title,
    u.department_id,
    u.avatar_url
  from public.users u
  where u.tenant_id = public.current_tenant_id()
    and u.is_active
    and not u.is_deleted
    and (
      nullif(trim(coalesce(p_query, '')), '') is null
      or u.full_name ilike '%' || trim(p_query) || '%'
      or coalesce(u.name_ar, '') ilike '%' || trim(p_query) || '%'
      or coalesce(u.name_en, '') ilike '%' || trim(p_query) || '%'
      or coalesce(u.employee_no, '') ilike '%' || trim(p_query) || '%'
      or u.email ilike '%' || trim(p_query) || '%'
    )
  order by coalesce(u.name_ar, u.name_en, u.full_name)
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

revoke all on function public.employee_directory(text, integer) from public;
grant execute on function public.employee_directory(text, integer) to authenticated;

comment on function public.employee_directory(text, integer) is
  'Colleague picker for the caller''s company. Returns display columns only — never national_id, gender or mobile.';

-- ----------------------------------------------------------------------------
-- 6. Maintenance sessions can name the company they are working on
--
--    A seeding or migration script runs as the database owner with no signed-in
--    user, so current_tenant_id() has nothing to resolve. Such a session may
--    declare its company:
--
--        select set_config('bbnovix.tenant_id',
--                          (select id::text from public.tenants where slug = 'shalfa'),
--                          false);
--
--    The setting is honoured ONLY when there is no authenticated user, so it can
--    never be used to escape a real session's company. Application clients
--    cannot set it: PostgREST does not forward arbitrary settings.
-- ----------------------------------------------------------------------------

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is null
      then nullif(current_setting('bbnovix.tenant_id', true), '')::uuid
    else (
      select coalesce(u.active_tenant_id, u.tenant_id)
      from public.users u
      where u.id = auth.uid() and not u.is_deleted
    )
  end;
$$;
grant execute on function public.current_tenant_id() to authenticated;

-- ----------------------------------------------------------------------------
-- 7. Legacy content that predates the audience engine stays visible
--    Rows created before migration 013 carry no audience rule; the engine treats
--    a missing rule as "everyone", so nothing disappears on upgrade.
-- ----------------------------------------------------------------------------

comment on function public.list_form_recipients() is
  'Employee directory for delegated submissions, scoped to the caller''s company.';
comment on function public.approval_dashboard_data() is
  'Approval administration read model, scoped to the caller''s company.';
comment on function public.approval_verify(text) is
  'Public verification of a request by its code; also names the issuing company.';
