create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  employee_no text unique,
  full_name text,
  email text unique not null,
  department text,
  job_title text,
  is_active boolean not null default true,
  created_on timestamptz not null default now()
);

create table if not exists public.templates (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  category text not null,
  description text,
  version integer not null default 1,
  is_active boolean not null default true,
  created_on timestamptz not null default now()
);

create table if not exists public.forms (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.templates(id),
  employee_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'Draft' check (status in ('Draft', 'Submitted', 'Approved', 'Rejected', 'Closed')),
  data_json jsonb not null default '{}'::jsonb,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  submitted_on timestamptz
);

create table if not exists public.competencies (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  name text not null,
  description text,
  default_weight numeric(5,2) not null default 0,
  is_active boolean not null default true,
  created_on timestamptz not null default now()
);

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  goal text not null,
  default_weight numeric(5,2) not null default 0,
  is_active boolean not null default true,
  created_on timestamptz not null default now()
);

create table if not exists public.performance_evaluations (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null unique references public.forms(id) on delete cascade,
  period text not null,
  manager text,
  employee_id uuid not null references public.users(id),
  overall_score numeric(4,2) not null default 0,
  overall_rate text,
  employee_comment text,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create table if not exists public.evaluation_goals (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null references public.performance_evaluations(id) on delete cascade,
  goal_id uuid not null references public.goals(id),
  weight numeric(5,2) not null check (weight >= 0 and weight <= 100),
  score numeric(3,1) not null check (score >= 1 and score <= 5),
  comments text
);

create table if not exists public.evaluation_competencies (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null references public.performance_evaluations(id) on delete cascade,
  competency_id uuid not null references public.competencies(id),
  weight numeric(5,2) not null check (weight >= 0 and weight <= 100),
  score numeric(3,1) not null check (score >= 1 and score <= 5),
  comments text
);

create index if not exists idx_forms_employee_id on public.forms(employee_id);
create index if not exists idx_forms_status on public.forms(status);
create index if not exists idx_forms_template_id on public.forms(template_id);
create index if not exists idx_evaluations_form_id on public.performance_evaluations(form_id);
create index if not exists idx_evaluation_goals_evaluation_id on public.evaluation_goals(evaluation_id);
create index if not exists idx_evaluation_competencies_evaluation_id on public.evaluation_competencies(evaluation_id);

create or replace function public.set_updated_on()
returns trigger
language plpgsql
as $$
begin
  new.updated_on = now();
  return new;
end;
$$;

drop trigger if exists set_forms_updated_on on public.forms;
create trigger set_forms_updated_on
before update on public.forms
for each row execute function public.set_updated_on();

drop trigger if exists set_performance_evaluations_updated_on on public.performance_evaluations;
create trigger set_performance_evaluations_updated_on
before update on public.performance_evaluations
for each row execute function public.set_updated_on();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, employee_no, full_name, department, job_title)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'employee_no',
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    new.raw_user_meta_data ->> 'department',
    new.raw_user_meta_data ->> 'job_title'
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public.users.full_name),
    employee_no = coalesce(excluded.employee_no, public.users.employee_no),
    department = coalesce(excluded.department, public.users.department),
    job_title = coalesce(excluded.job_title, public.users.job_title);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.users enable row level security;
alter table public.templates enable row level security;
alter table public.forms enable row level security;
alter table public.competencies enable row level security;
alter table public.goals enable row level security;
alter table public.performance_evaluations enable row level security;
alter table public.evaluation_goals enable row level security;
alter table public.evaluation_competencies enable row level security;

create policy "users can read own profile" on public.users
  for select using (auth.uid() = id);

create policy "users can update own profile" on public.users
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "authenticated users can read active templates" on public.templates
  for select to authenticated using (is_active = true);

create policy "authenticated users can read active competencies" on public.competencies
  for select to authenticated using (is_active = true);

create policy "authenticated users can read active goals" on public.goals
  for select to authenticated using (is_active = true);

create policy "employees can read own forms" on public.forms
  for select using (auth.uid() = employee_id);

create policy "employees can create own forms" on public.forms
  for insert with check (auth.uid() = employee_id);

create policy "employees can update own draft or submitted forms" on public.forms
  for update using (auth.uid() = employee_id and status in ('Draft', 'Submitted'))
  with check (auth.uid() = employee_id and status in ('Draft', 'Submitted'));

create policy "employees can delete own drafts" on public.forms
  for delete using (auth.uid() = employee_id and status = 'Draft');

create policy "employees can read own evaluations" on public.performance_evaluations
  for select using (auth.uid() = employee_id);

create policy "employees can create own evaluations" on public.performance_evaluations
  for insert with check (
    auth.uid() = employee_id and exists (
      select 1 from public.forms where forms.id = form_id and forms.employee_id = auth.uid()
    )
  );

create policy "employees can update own evaluations" on public.performance_evaluations
  for update using (auth.uid() = employee_id)
  with check (auth.uid() = employee_id);

create policy "employees can read own evaluation goals" on public.evaluation_goals
  for select using (
    exists (
      select 1 from public.performance_evaluations
      where performance_evaluations.id = evaluation_id
      and performance_evaluations.employee_id = auth.uid()
    )
  );

create policy "employees can manage own evaluation goals" on public.evaluation_goals
  for all using (
    exists (
      select 1 from public.performance_evaluations
      where performance_evaluations.id = evaluation_id
      and performance_evaluations.employee_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.performance_evaluations
      where performance_evaluations.id = evaluation_id
      and performance_evaluations.employee_id = auth.uid()
    )
  );

create policy "employees can read own evaluation competencies" on public.evaluation_competencies
  for select using (
    exists (
      select 1 from public.performance_evaluations
      where performance_evaluations.id = evaluation_id
      and performance_evaluations.employee_id = auth.uid()
    )
  );

create policy "employees can manage own evaluation competencies" on public.evaluation_competencies
  for all using (
    exists (
      select 1 from public.performance_evaluations
      where performance_evaluations.id = evaluation_id
      and performance_evaluations.employee_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.performance_evaluations
      where performance_evaluations.id = evaluation_id
      and performance_evaluations.employee_id = auth.uid()
    )
  );
