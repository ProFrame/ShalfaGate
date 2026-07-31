create extension if not exists citext;

-- Enterprise identity and organization
create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text,
  parent_id uuid references public.departments(id),
  is_active boolean not null default true,
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text,
  is_active boolean not null default true,
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id),
  code text not null unique,
  name_ar text not null,
  name_en text,
  is_active boolean not null default true,
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

alter table public.users
  add column if not exists mobile text,
  add column if not exists nationality text,
  add column if not exists gender text,
  add column if not exists national_id text,
  add column if not exists department_id uuid references public.departments(id),
  add column if not exists project_id uuid references public.projects(id),
  add column if not exists site_id uuid references public.sites(id),
  add column if not exists sector text,
  add column if not exists avatar_url text,
  add column if not exists preferred_language text not null default 'ar',
  add column if not exists theme text not null default 'system',
  add column if not exists last_login_on timestamptz,
  add column if not exists is_deleted boolean not null default false,
  add column if not exists deleted_by uuid references auth.users(id),
  add column if not exists deleted_date timestamptz,
  add column if not exists updated_on timestamptz not null default now();

create unique index if not exists uq_users_email_ci
  on public.users (lower(email)) where is_deleted = false;
create unique index if not exists uq_users_employee_no_active
  on public.users (employee_no) where is_deleted = false;
create index if not exists idx_users_department_id on public.users(department_id);
create index if not exists idx_users_project_id on public.users(project_id);
create index if not exists idx_users_is_active on public.users(is_active) where is_deleted = false;

-- RBAC: roles contain permissions; users are assigned roles.
create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text not null,
  description text,
  is_system boolean not null default false,
  is_active boolean not null default true,
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  module text not null,
  description text,
  created_on timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  created_on timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table if not exists public.user_roles (
  user_id uuid not null references public.users(id) on delete cascade,
  role_id uuid not null references public.roles(id),
  assigned_by uuid references auth.users(id),
  assigned_on timestamptz not null default now(),
  primary key (user_id, role_id)
);

create index if not exists idx_user_roles_role_id on public.user_roles(role_id);
create index if not exists idx_role_permissions_permission_id on public.role_permissions(permission_id);

create or replace function public.has_permission(permission_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.is_active and not r.is_deleted
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where ur.user_id = auth.uid() and p.code = permission_code
  );
$$;

grant execute on function public.has_permission(text) to authenticated;

create or replace function public.has_permission_for_user(target_user_id uuid, permission_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.is_active and not r.is_deleted
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where ur.user_id = target_user_id and p.code = permission_code
  );
$$;

revoke all on function public.has_permission_for_user(uuid, text) from public;
grant execute on function public.has_permission_for_user(uuid, text) to service_role;

-- Dynamic performance model
create table if not exists public.proficiency_levels (
  id uuid primary key default gen_random_uuid(),
  level_no smallint not null unique check (level_no between 1 and 5),
  name_ar text not null,
  name_en text not null,
  description_ar text,
  description_en text,
  is_active boolean not null default true,
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

alter table public.competencies
  add column if not exists code text,
  add column if not exists parent_id uuid references public.competencies(id),
  add column if not exists definition text,
  add column if not exists default_level_id uuid references public.proficiency_levels(id),
  add column if not exists applicable_departments jsonb not null default '[]'::jsonb,
  add column if not exists applicable_jobs jsonb not null default '[]'::jsonb,
  add column if not exists is_deleted boolean not null default false,
  add column if not exists deleted_by uuid references auth.users(id),
  add column if not exists deleted_date timestamptz,
  add column if not exists updated_on timestamptz not null default now();

create unique index if not exists uq_competencies_code_active
  on public.competencies(code) where is_deleted = false and code is not null;
create index if not exists idx_competencies_parent_id on public.competencies(parent_id);

create table if not exists public.competency_indicators (
  id uuid primary key default gen_random_uuid(),
  competency_id uuid not null references public.competencies(id) on delete cascade,
  indicator_order smallint not null default 1,
  text_ar text not null,
  text_en text,
  proficiency_level_id uuid references public.proficiency_levels(id),
  is_active boolean not null default true,
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  created_on timestamptz not null default now()
);
create index if not exists idx_competency_indicators_competency_id on public.competency_indicators(competency_id);

alter table public.goals
  add column if not exists code text,
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists measurement text,
  add column if not exists formula text,
  add column if not exists applicable_departments jsonb not null default '[]'::jsonb,
  add column if not exists applicable_jobs jsonb not null default '[]'::jsonb,
  add column if not exists allow_customization boolean not null default false,
  add column if not exists is_deleted boolean not null default false,
  add column if not exists deleted_by uuid references auth.users(id),
  add column if not exists deleted_date timestamptz,
  add column if not exists updated_on timestamptz not null default now();

update public.goals set title = goal where title is null;
create unique index if not exists uq_goals_code_active
  on public.goals(code) where is_deleted = false and code is not null;

create table if not exists public.evaluation_templates (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name_ar text not null,
  name_en text,
  description text,
  version integer not null default 1,
  objectives_weight numeric(5,2) not null default 60 check (objectives_weight between 0 and 100),
  competencies_weight numeric(5,2) not null default 40 check (competencies_weight between 0 and 100),
  allow_custom_goals boolean not null default false,
  is_active boolean not null default true,
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  unique (code, version),
  check (objectives_weight + competencies_weight = 100)
);

create table if not exists public.evaluation_sections (
  id uuid primary key default gen_random_uuid(),
  evaluation_template_id uuid not null references public.evaluation_templates(id) on delete cascade,
  section_code text not null,
  title_ar text not null,
  title_en text,
  section_type text not null check (section_type in ('EmployeeInfo','Objectives','Competencies','Comments','Workflow','Custom')),
  display_order smallint not null,
  config_json jsonb not null default '{}'::jsonb,
  is_required boolean not null default true,
  is_active boolean not null default true,
  unique (evaluation_template_id, section_code)
);

create table if not exists public.evaluation_cycles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text,
  description text,
  start_date date not null,
  end_date date not null,
  status text not null default 'Draft' check (status in ('Draft','Active','Calibration','Closed','Archived')),
  target_employee_ids jsonb not null default '[]'::jsonb,
  target_department_ids jsonb not null default '[]'::jsonb,
  allow_self_evaluation boolean not null default true,
  allow_manager_evaluation boolean not null default true,
  is_active boolean not null default true,
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  check (end_date >= start_date)
);

alter table public.performance_evaluations
  add column if not exists evaluation_cycle_id uuid references public.evaluation_cycles(id),
  add column if not exists evaluation_template_id uuid references public.evaluation_templates(id),
  add column if not exists evaluation_template_version integer,
  add column if not exists evaluator_id uuid references public.users(id),
  add column if not exists reviewer_id uuid references public.users(id),
  add column if not exists director_id uuid references public.users(id),
  add column if not exists department_id uuid references public.departments(id),
  add column if not exists project_id uuid references public.projects(id),
  add column if not exists site_id uuid references public.sites(id),
  add column if not exists objectives_weight numeric(5,2) not null default 60,
  add column if not exists competencies_weight numeric(5,2) not null default 40,
  add column if not exists objectives_score numeric(5,3) not null default 0,
  add column if not exists competencies_score numeric(5,3) not null default 0,
  add column if not exists workflow_status text not null default 'EmployeeDraft',
  add column if not exists is_deleted boolean not null default false,
  add column if not exists deleted_by uuid references auth.users(id),
  add column if not exists deleted_date timestamptz;

alter table public.evaluation_goals
  add column if not exists priority_level smallint not null default 3 check (priority_level between 1 and 5),
  add column if not exists relative_weight numeric(7,4) not null default 0,
  add column if not exists measurement_standard text,
  add column if not exists target_output numeric,
  add column if not exists actual_output numeric,
  add column if not exists weighted_score numeric(7,4) not null default 0,
  add column if not exists custom_goal_title text,
  add column if not exists is_deleted boolean not null default false,
  add column if not exists deleted_by uuid references auth.users(id),
  add column if not exists deleted_date timestamptz;

alter table public.evaluation_goals drop constraint if exists evaluation_goals_score_check;
alter table public.evaluation_goals add constraint evaluation_goals_score_check check (score between 0 and 5);

alter table public.evaluation_competencies
  add column if not exists priority_level smallint not null default 3 check (priority_level between 1 and 5),
  add column if not exists relative_weight numeric(7,4) not null default 0,
  add column if not exists weighted_score numeric(7,4) not null default 0,
  add column if not exists proficiency_level_id uuid references public.proficiency_levels(id),
  add column if not exists is_deleted boolean not null default false,
  add column if not exists deleted_by uuid references auth.users(id),
  add column if not exists deleted_date timestamptz;

alter table public.evaluation_competencies drop constraint if exists evaluation_competencies_score_check;
alter table public.evaluation_competencies add constraint evaluation_competencies_score_check check (score between 0 and 5);

create unique index if not exists uq_employee_cycle_template_evaluation
  on public.performance_evaluations(employee_id, evaluation_cycle_id, evaluation_template_id)
  where is_deleted = false and evaluation_cycle_id is not null and evaluation_template_id is not null;
create index if not exists idx_evaluations_employee_cycle on public.performance_evaluations(employee_id, evaluation_cycle_id);
create index if not exists idx_evaluations_department_cycle on public.performance_evaluations(department_id, evaluation_cycle_id);
create index if not exists idx_evaluations_project_cycle on public.performance_evaluations(project_id, evaluation_cycle_id);
create index if not exists idx_evaluations_status_cycle on public.performance_evaluations(workflow_status, evaluation_cycle_id);
create index if not exists idx_evaluations_submitted_date on public.forms(submitted_on);
create index if not exists idx_evaluation_cycles_status on public.evaluation_cycles(status) where is_deleted = false;

create table if not exists public.evaluation_workflow_steps (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null references public.performance_evaluations(id) on delete cascade,
  step_order smallint not null,
  step_type text not null check (step_type in ('Employee','Evaluator','Reviewer','DepartmentManager','HR')),
  assigned_user_id uuid references public.users(id),
  status text not null default 'Pending' check (status in ('Pending','InProgress','Approved','Rejected','Skipped')),
  action_comment text,
  action_on timestamptz,
  due_on timestamptz,
  created_on timestamptz not null default now(),
  unique (evaluation_id, step_order)
);
create index if not exists idx_workflow_steps_assignee_status on public.evaluation_workflow_steps(assigned_user_id, status);

-- Content portal metadata
create table if not exists public.content_items (
  id uuid primary key default gen_random_uuid(),
  content_type text not null check (content_type in ('Document','Circular','Design')),
  code text,
  title_ar text not null,
  title_en text,
  description text,
  category text,
  tags text[] not null default '{}',
  version text,
  owner_id uuid references public.users(id),
  storage_path text,
  preview_path text,
  priority text check (priority in ('Normal','Important','Urgent')),
  publish_date timestamptz,
  expiry_date timestamptz,
  requires_acknowledgement boolean not null default false,
  download_count bigint not null default 0,
  is_published boolean not null default false,
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);
create index if not exists idx_content_type_publish on public.content_items(content_type, is_published, publish_date desc);
create index if not exists idx_content_expiry on public.content_items(expiry_date) where expiry_date is not null;
create index if not exists idx_content_tags on public.content_items using gin(tags);

create table if not exists public.content_receipts (
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  read_on timestamptz not null default now(),
  acknowledged_on timestamptz,
  primary key (content_item_id, user_id)
);

-- Immutable audit trail
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  old_data jsonb,
  new_data jsonb,
  ip_address inet,
  user_agent text,
  created_on timestamptz not null default now()
);
create index if not exists idx_audit_actor_date on public.audit_logs(actor_id, created_on desc);
create index if not exists idx_audit_entity on public.audit_logs(entity_type, entity_id, created_on desc);
create index if not exists idx_audit_action_date on public.audit_logs(action, created_on desc);

alter table public.templates
  add column if not exists is_deleted boolean not null default false,
  add column if not exists deleted_by uuid references auth.users(id),
  add column if not exists deleted_date timestamptz,
  add column if not exists updated_on timestamptz not null default now();
alter table public.forms
  add column if not exists reference_no text,
  add column if not exists is_deleted boolean not null default false,
  add column if not exists deleted_by uuid references auth.users(id),
  add column if not exists deleted_date timestamptz;
create unique index if not exists uq_forms_reference_no on public.forms(reference_no) where reference_no is not null and is_deleted = false;

-- RLS for all enterprise tables
alter table public.departments enable row level security;
alter table public.projects enable row level security;
alter table public.sites enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_roles enable row level security;
alter table public.proficiency_levels enable row level security;
alter table public.competency_indicators enable row level security;
alter table public.evaluation_templates enable row level security;
alter table public.evaluation_sections enable row level security;
alter table public.evaluation_cycles enable row level security;
alter table public.evaluation_workflow_steps enable row level security;
alter table public.content_items enable row level security;
alter table public.content_receipts enable row level security;
alter table public.audit_logs enable row level security;

create policy "authenticated read organization" on public.departments for select to authenticated using (not is_deleted);
create policy "authenticated read projects" on public.projects for select to authenticated using (not is_deleted);
create policy "authenticated read sites" on public.sites for select to authenticated using (not is_deleted);
create policy "authenticated read proficiency" on public.proficiency_levels for select to authenticated using (is_active and not is_deleted);
create policy "authenticated read competency indicators" on public.competency_indicators for select to authenticated using (is_active and not is_deleted);
create policy "authenticated read active evaluation templates" on public.evaluation_templates for select to authenticated using (is_active and not is_deleted);
create policy "authenticated read evaluation sections" on public.evaluation_sections for select to authenticated using (is_active);
create policy "authenticated read active cycles" on public.evaluation_cycles for select to authenticated using (is_active and not is_deleted);
create policy "authenticated read published content" on public.content_items for select to authenticated using (is_published and not is_deleted and (expiry_date is null or expiry_date > now()));
create policy "users manage own content receipts" on public.content_receipts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "users read assigned workflow steps" on public.evaluation_workflow_steps for select to authenticated
  using (assigned_user_id = auth.uid() or exists (
    select 1 from public.performance_evaluations pe
    where pe.id = evaluation_id and pe.employee_id = auth.uid()
  ));

create policy "employee managers manage users" on public.users for all to authenticated
  using (public.has_permission('Employees.Manage')) with check (public.has_permission('Employees.Manage'));
create policy "rbac managers read roles" on public.roles for select to authenticated
  using (public.has_permission('Roles.View') or exists (select 1 from public.user_roles where user_id = auth.uid() and role_id = roles.id));
create policy "rbac managers manage roles" on public.roles for all to authenticated
  using (public.has_permission('Roles.Manage')) with check (public.has_permission('Roles.Manage'));
create policy "users read own role assignments" on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.has_permission('Roles.View'));
create policy "rbac managers manage assignments" on public.user_roles for all to authenticated
  using (public.has_permission('Roles.Assign')) with check (public.has_permission('Roles.Assign'));
create policy "authenticated read permissions" on public.permissions for select to authenticated using (true);
create policy "authenticated read role permissions" on public.role_permissions for select to authenticated using (true);
create policy "rbac managers manage role permissions" on public.role_permissions for all to authenticated
  using (public.has_permission('Roles.Manage')) with check (public.has_permission('Roles.Manage'));
create policy "performance admins manage cycles" on public.evaluation_cycles for all to authenticated
  using (public.has_permission('Performance.Cycles.Manage')) with check (public.has_permission('Performance.Cycles.Manage'));
create policy "performance admins manage templates" on public.evaluation_templates for all to authenticated
  using (public.has_permission('Performance.Templates.Manage')) with check (public.has_permission('Performance.Templates.Manage'));
create policy "performance admins manage sections" on public.evaluation_sections for all to authenticated
  using (public.has_permission('Performance.Templates.Manage')) with check (public.has_permission('Performance.Templates.Manage'));
create policy "library admins manage proficiency" on public.proficiency_levels for all to authenticated
  using (public.has_permission('Competencies.Manage')) with check (public.has_permission('Competencies.Manage'));
create policy "library admins manage indicators" on public.competency_indicators for all to authenticated
  using (public.has_permission('Competencies.Manage')) with check (public.has_permission('Competencies.Manage'));
create policy "library admins manage competencies" on public.competencies for all to authenticated
  using (public.has_permission('Competencies.Manage')) with check (public.has_permission('Competencies.Manage'));
create policy "library admins manage goals" on public.goals for all to authenticated
  using (public.has_permission('Goals.Manage')) with check (public.has_permission('Goals.Manage'));
create policy "content admins manage content" on public.content_items for all to authenticated
  using (public.has_permission('Content.Manage')) with check (public.has_permission('Content.Manage'));
create policy "auditors read audit logs" on public.audit_logs for select to authenticated
  using (public.has_permission('Audit.View'));

-- Audit logs cannot be changed through the public API.
revoke update, delete on public.audit_logs from authenticated;

create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, old_data, new_data)
  values (
    auth.uid(),
    tg_op,
    tg_table_name,
    coalesce((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'id', ''),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists audit_users on public.users;
create trigger audit_users after insert or update or delete on public.users for each row execute function public.write_audit_log();
drop trigger if exists audit_forms on public.forms;
create trigger audit_forms after insert or update or delete on public.forms for each row execute function public.write_audit_log();
drop trigger if exists audit_evaluation_cycles on public.evaluation_cycles;
create trigger audit_evaluation_cycles after insert or update or delete on public.evaluation_cycles for each row execute function public.write_audit_log();
drop trigger if exists audit_roles on public.roles;
create trigger audit_roles after insert or update or delete on public.roles for each row execute function public.write_audit_log();
drop trigger if exists audit_user_roles on public.user_roles;
create trigger audit_user_roles after insert or update or delete on public.user_roles for each row execute function public.write_audit_log();

-- Extend the auth trigger: users are provisioned by administrators and receive Employee by default.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  employee_role_id uuid;
begin
  insert into public.users (id, email, employee_no, full_name, mobile, department, job_title, is_active)
  values (
    new.id,
    lower(new.email),
    new.raw_user_meta_data ->> 'employee_no',
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    new.raw_user_meta_data ->> 'mobile',
    new.raw_user_meta_data ->> 'department',
    new.raw_user_meta_data ->> 'job_title',
    coalesce((new.raw_user_meta_data ->> 'is_active')::boolean, true)
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public.users.full_name),
    mobile = coalesce(excluded.mobile, public.users.mobile),
    employee_no = coalesce(excluded.employee_no, public.users.employee_no),
    department = coalesce(excluded.department, public.users.department),
    job_title = coalesce(excluded.job_title, public.users.job_title),
    updated_on = now();

  select id into employee_role_id from public.roles where code = 'EMPLOYEE' and not is_deleted limit 1;
  if employee_role_id is not null then
    insert into public.user_roles(user_id, role_id) values (new.id, employee_role_id)
    on conflict do nothing;
  end if;
  return new;
end;
$$;
