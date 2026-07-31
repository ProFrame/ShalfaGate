-- Bilingual master data, governed libraries, and asynchronous onboarding.

alter table public.users
  add column if not exists name_ar text,
  add column if not exists name_en text,
  add column if not exists job_title_ar text,
  add column if not exists job_title_en text,
  add column if not exists nationality_ar text,
  add column if not exists nationality_en text,
  add column if not exists employment_status text not null default 'Active',
  add column if not exists manager_id uuid references public.users(id),
  add column if not exists hire_date date,
  add column if not exists invitation_sent boolean not null default false,
  add column if not exists invitation_sent_on timestamptz,
  add column if not exists invitation_accepted_on timestamptz,
  add column if not exists first_login_on timestamptz,
  add column if not exists password_set_on timestamptz,
  add column if not exists account_activated_on timestamptz;

update public.users
set name_ar = coalesce(name_ar, full_name),
    name_en = coalesce(name_en, full_name)
where name_ar is null or name_en is null;

alter table public.departments
  add column if not exists description_ar text,
  add column if not exists description_en text,
  add column if not exists display_order integer not null default 0;

alter table public.projects
  add column if not exists description_ar text,
  add column if not exists description_en text,
  add column if not exists display_order integer not null default 0;

alter table public.sites
  add column if not exists description_ar text,
  add column if not exists description_en text,
  add column if not exists display_order integer not null default 0;

alter table public.templates
  add column if not exists name_ar text,
  add column if not exists name_en text,
  add column if not exists description_ar text,
  add column if not exists description_en text,
  add column if not exists display_order integer not null default 0;

update public.templates
set name_en = coalesce(name_en, name),
    description_en = coalesce(description_en, description)
where name_en is null or description_en is null;

alter table public.proficiency_levels
  add column if not exists code text,
  add column if not exists display_order integer not null default 0,
  add column if not exists version integer not null default 1,
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists updated_by uuid references auth.users(id);

update public.proficiency_levels
set code = coalesce(code, 'LEVEL-' || level_no::text),
    display_order = case when display_order = 0 then level_no else display_order end;

create unique index if not exists uq_proficiency_levels_code_active
  on public.proficiency_levels(lower(code)) where not is_deleted;

alter table public.competencies
  add column if not exists name_ar text,
  add column if not exists name_en text,
  add column if not exists definition_ar text,
  add column if not exists definition_en text,
  add column if not exists description_ar text,
  add column if not exists description_en text,
  add column if not exists version integer not null default 1,
  add column if not exists display_order integer not null default 0,
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists updated_by uuid references auth.users(id);

update public.competencies
set name_en = coalesce(name_en, name),
    definition_en = coalesce(definition_en, definition, description),
    description_en = coalesce(description_en, description)
where name_en is null or definition_en is null or description_en is null;

alter table public.competency_indicators
  add column if not exists updated_on timestamptz not null default now(),
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists updated_by uuid references auth.users(id);

create unique index if not exists uq_competency_indicator_sequence_active
  on public.competency_indicators(competency_id, indicator_order)
  where not is_deleted;

alter table public.goals
  add column if not exists title_ar text,
  add column if not exists title_en text,
  add column if not exists description_ar text,
  add column if not exists description_en text,
  add column if not exists measurement_unit_ar text,
  add column if not exists measurement_unit_en text,
  add column if not exists measurement_formula text,
  add column if not exists target_formula text,
  add column if not exists frequency text,
  add column if not exists version integer not null default 1,
  add column if not exists display_order integer not null default 0,
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists updated_by uuid references auth.users(id);

update public.goals
set title_en = coalesce(title_en, title, goal),
    description_en = coalesce(description_en, description),
    measurement_unit_en = coalesce(measurement_unit_en, measurement),
    measurement_formula = coalesce(measurement_formula, formula)
where title_en is null
   or description_en is null
   or measurement_unit_en is null
   or measurement_formula is null;

alter table public.evaluation_templates
  add column if not exists description_ar text,
  add column if not exists description_en text,
  add column if not exists allow_custom_competencies boolean not null default false,
  add column if not exists display_order integer not null default 0;

update public.evaluation_templates
set description_en = coalesce(description_en, description)
where description_en is null;

alter table public.evaluation_cycles
  add column if not exists description_ar text,
  add column if not exists description_en text,
  add column if not exists display_order integer not null default 0;

update public.evaluation_cycles
set description_en = coalesce(description_en, description)
where description_en is null;

create table if not exists public.lookup_values (
  id uuid primary key default gen_random_uuid(),
  lookup_type text not null,
  code text not null,
  name_ar text not null,
  name_en text not null,
  description_ar text,
  description_en text,
  display_order integer not null default 0,
  is_active boolean not null default true,
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  created_by uuid references auth.users(id),
  created_on timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_on timestamptz not null default now(),
  unique (lookup_type, code)
);

create index if not exists idx_lookup_values_type_active
  on public.lookup_values(lookup_type, display_order)
  where is_active and not is_deleted;

create table if not exists public.system_settings (
  setting_key text primary key,
  value_json jsonb not null,
  name_ar text not null,
  name_en text not null,
  description_ar text,
  description_en text,
  is_public boolean not null default false,
  updated_by uuid references auth.users(id),
  updated_on timestamptz not null default now()
);

create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  version integer not null default 1,
  subject_ar text not null,
  subject_en text not null,
  body_html_ar text not null,
  body_html_en text not null,
  is_active boolean not null default true,
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  created_by uuid references auth.users(id),
  created_on timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_on timestamptz not null default now(),
  unique (code, version)
);

create table if not exists public.email_queue (
  id bigint generated always as identity primary key,
  recipient_email citext not null,
  recipient_user_id uuid references public.users(id),
  template_id uuid not null references public.email_templates(id),
  language text not null default 'ar' check (language in ('ar', 'en')),
  template_data jsonb not null default '{}'::jsonb,
  status text not null default 'Pending'
    check (status in ('Pending', 'Processing', 'Sent', 'Retry', 'Failed', 'Cancelled')),
  priority smallint not null default 5 check (priority between 1 and 9),
  retry_count smallint not null default 0,
  max_retries smallint not null default 5,
  next_attempt_on timestamptz not null default now(),
  locked_on timestamptz,
  locked_by text,
  last_attempt_on timestamptz,
  sent_on timestamptz,
  provider_message_id text,
  failure_reason text,
  created_by uuid references auth.users(id),
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_email_queue_worker
  on public.email_queue(status, priority, next_attempt_on, id)
  where status in ('Pending', 'Retry');
create index if not exists idx_email_queue_recipient
  on public.email_queue(recipient_user_id, created_on desc);

create table if not exists public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  import_type text not null check (import_type in ('Employees', 'Goals', 'Competencies', 'ProficiencyLevels')),
  file_name text not null,
  storage_path text,
  conflict_strategy text check (conflict_strategy in ('Skip', 'Update', 'Replace')),
  status text not null default 'Validating'
    check (status in ('Validating', 'Ready', 'Processing', 'Completed', 'Failed', 'Cancelled')),
  total_rows integer not null default 0,
  new_rows integer not null default 0,
  update_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  error_rows integer not null default 0,
  result_json jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id),
  created_on timestamptz not null default now(),
  completed_on timestamptz
);

create table if not exists public.import_job_rows (
  id bigint generated always as identity primary key,
  import_job_id uuid not null references public.import_jobs(id) on delete cascade,
  row_number integer not null,
  source_data jsonb not null,
  normalized_data jsonb,
  action text check (action in ('Insert', 'Update', 'Skip', 'Error')),
  validation_errors jsonb not null default '[]'::jsonb,
  processed_on timestamptz,
  unique (import_job_id, row_number)
);

create index if not exists idx_import_job_rows_action
  on public.import_job_rows(import_job_id, action);
create index if not exists idx_import_jobs_created_by
  on public.import_jobs(created_by, created_on desc);

alter table public.lookup_values enable row level security;
alter table public.system_settings enable row level security;
alter table public.email_templates enable row level security;
alter table public.email_queue enable row level security;
alter table public.import_jobs enable row level security;
alter table public.import_job_rows enable row level security;

create policy "authenticated read active lookups" on public.lookup_values
  for select to authenticated using (is_active and not is_deleted);
create policy "administrators manage lookups" on public.lookup_values
  for all to authenticated
  using (public.has_permission('Settings.Manage'))
  with check (public.has_permission('Settings.Manage'));

create policy "authenticated read public settings" on public.system_settings
  for select to authenticated
  using (is_public or public.has_permission('Settings.Manage'));
create policy "administrators manage settings" on public.system_settings
  for all to authenticated
  using (public.has_permission('Settings.Manage'))
  with check (public.has_permission('Settings.Manage'));

create policy "administrators manage email templates" on public.email_templates
  for all to authenticated
  using (public.has_permission('Email.Manage'))
  with check (public.has_permission('Email.Manage'));
create policy "administrators view email queue" on public.email_queue
  for select to authenticated
  using (public.has_permission('Email.Manage'));

create policy "administrators manage import jobs" on public.import_jobs
  for all to authenticated
  using (
    created_by = auth.uid()
    and (
      public.has_permission('Employees.Manage')
      or public.has_permission('Goals.Manage')
      or public.has_permission('Competencies.Manage')
    )
  )
  with check (
    created_by = auth.uid()
    and (
      public.has_permission('Employees.Manage')
      or public.has_permission('Goals.Manage')
      or public.has_permission('Competencies.Manage')
    )
  );
create policy "administrators manage import rows" on public.import_job_rows
  for all to authenticated
  using (
    exists (
      select 1 from public.import_jobs j
      where j.id = import_job_id
        and j.created_by = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.import_jobs j
      where j.id = import_job_id
        and j.created_by = auth.uid()
    )
  );

create or replace function public.claim_email_queue(batch_size integer default 25, worker_name text default 'edge-worker')
returns setof public.email_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select q.id
    from public.email_queue q
    where q.status in ('Pending', 'Retry')
      and q.next_attempt_on <= now()
    order by q.priority, q.next_attempt_on, q.id
    for update skip locked
    limit greatest(1, least(batch_size, 100))
  )
  update public.email_queue q
  set status = 'Processing',
      locked_on = now(),
      locked_by = worker_name,
      last_attempt_on = now(),
      updated_on = now()
  from claimed
  where q.id = claimed.id
  returning q.*;
end;
$$;

revoke all on function public.claim_email_queue(integer, text) from public;
grant execute on function public.claim_email_queue(integer, text) to service_role;

create or replace function public.record_first_login()
returns void
language sql
security definer
set search_path = public
as $$
  update public.users
  set first_login_on = coalesce(first_login_on, now()),
      invitation_accepted_on = coalesce(invitation_accepted_on, now()),
      account_activated_on = coalesce(account_activated_on, now()),
      updated_on = now()
  where id = auth.uid();
$$;

grant execute on function public.record_first_login() to authenticated;

create or replace function public.set_updated_by()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_on = now();
  if tg_op = 'INSERT' and new.created_by is null then
    new.created_by = auth.uid();
  end if;
  new.updated_by = auth.uid();
  return new;
end;
$$;

drop trigger if exists set_competencies_updated_by on public.competencies;
create trigger set_competencies_updated_by
before insert or update on public.competencies
for each row execute function public.set_updated_by();

drop trigger if exists set_goals_updated_by on public.goals;
create trigger set_goals_updated_by
before insert or update on public.goals
for each row execute function public.set_updated_by();

drop trigger if exists set_proficiency_levels_updated_by on public.proficiency_levels;
create trigger set_proficiency_levels_updated_by
before insert or update on public.proficiency_levels
for each row execute function public.set_updated_by();

drop trigger if exists set_competency_indicators_updated_by on public.competency_indicators;
create trigger set_competency_indicators_updated_by
before insert or update on public.competency_indicators
for each row execute function public.set_updated_by();

drop trigger if exists audit_email_templates on public.email_templates;
create trigger audit_email_templates
after insert or update or delete on public.email_templates
for each row execute function public.write_audit_log();

drop trigger if exists audit_system_settings on public.system_settings;
create trigger audit_system_settings
after insert or update or delete on public.system_settings
for each row execute function public.write_audit_log();

drop trigger if exists audit_competencies on public.competencies;
create trigger audit_competencies
after insert or update or delete on public.competencies
for each row execute function public.write_audit_log();

drop trigger if exists audit_goals on public.goals;
create trigger audit_goals
after insert or update or delete on public.goals
for each row execute function public.write_audit_log();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  employee_role_id uuid;
begin
  insert into public.users (
    id, email, employee_no, full_name, name_ar, name_en, mobile,
    department, job_title, job_title_ar, job_title_en, is_active,
    account_activated_on
  )
  values (
    new.id,
    lower(new.email),
    new.raw_user_meta_data ->> 'employee_no',
    coalesce(
      new.raw_user_meta_data ->> 'name_ar',
      new.raw_user_meta_data ->> 'name_en',
      new.raw_user_meta_data ->> 'full_name',
      new.email
    ),
    new.raw_user_meta_data ->> 'name_ar',
    new.raw_user_meta_data ->> 'name_en',
    new.raw_user_meta_data ->> 'mobile',
    new.raw_user_meta_data ->> 'department',
    coalesce(
      new.raw_user_meta_data ->> 'job_title_ar',
      new.raw_user_meta_data ->> 'job_title_en',
      new.raw_user_meta_data ->> 'job_title'
    ),
    new.raw_user_meta_data ->> 'job_title_ar',
    new.raw_user_meta_data ->> 'job_title_en',
    coalesce((new.raw_user_meta_data ->> 'is_active')::boolean, true),
    case
      when coalesce((new.raw_user_meta_data ->> 'is_active')::boolean, true) then now()
      else null
    end
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public.users.full_name),
    name_ar = coalesce(excluded.name_ar, public.users.name_ar),
    name_en = coalesce(excluded.name_en, public.users.name_en),
    mobile = coalesce(excluded.mobile, public.users.mobile),
    employee_no = coalesce(excluded.employee_no, public.users.employee_no),
    department = coalesce(excluded.department, public.users.department),
    job_title = coalesce(excluded.job_title, public.users.job_title),
    job_title_ar = coalesce(excluded.job_title_ar, public.users.job_title_ar),
    job_title_en = coalesce(excluded.job_title_en, public.users.job_title_en),
    updated_on = now();

  select id into employee_role_id
  from public.roles
  where code = 'EMPLOYEE' and not is_deleted
  limit 1;

  if employee_role_id is not null then
    insert into public.user_roles(user_id, role_id)
    values (new.id, employee_role_id)
    on conflict do nothing;
  end if;

  return new;
end;
$$;

create index if not exists idx_users_manager_id on public.users(manager_id);
create index if not exists idx_users_employment_status on public.users(employment_status)
  where not is_deleted;
create index if not exists idx_users_invitation_pending on public.users(invitation_sent, invitation_accepted_on)
  where is_active and not is_deleted;
