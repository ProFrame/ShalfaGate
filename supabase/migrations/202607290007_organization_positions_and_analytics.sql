-- Managed organization lookups, optional employee assignments, and analytics access.

alter table public.departments
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists updated_by uuid references auth.users(id);

create table if not exists public.positions (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name_ar text not null,
  name_en text,
  description_ar text,
  description_en text,
  department_id uuid references public.departments(id),
  display_order integer not null default 0,
  is_active boolean not null default true,
  is_deleted boolean not null default false,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create unique index if not exists uq_positions_code_active
  on public.positions(lower(code))
  where not is_deleted;
create index if not exists idx_positions_department
  on public.positions(department_id, display_order)
  where not is_deleted;
create index if not exists idx_departments_display
  on public.departments(display_order, name_ar)
  where not is_deleted;

alter table public.users
  add column if not exists position_id uuid references public.positions(id);

create index if not exists idx_users_position_id
  on public.users(position_id)
  where not is_deleted;

insert into public.positions(code, name_ar, name_en, is_active)
select
  'POS-' || upper(substr(md5(trim(u.job_title)), 1, 10)),
  trim(u.job_title),
  trim(u.job_title),
  true
from public.users u
where nullif(trim(u.job_title), '') is not null
on conflict do nothing;

update public.users u
set department_id = d.id
from public.departments d
where u.department_id is null
  and not d.is_deleted
  and lower(trim(d.name_ar)) = lower(trim(u.department));

update public.users u
set position_id = p.id
from public.positions p
where u.position_id is null
  and not p.is_deleted
  and lower(trim(p.name_ar)) = lower(trim(u.job_title));

alter table public.positions enable row level security;

drop policy if exists "authenticated read positions" on public.positions;
create policy "authenticated read positions"
on public.positions for select to authenticated
using (not is_deleted);

drop policy if exists "employee managers manage departments" on public.departments;
create policy "employee managers manage departments"
on public.departments for all to authenticated
using (public.has_permission('Employees.Manage'))
with check (public.has_permission('Employees.Manage'));

drop policy if exists "employee managers manage positions" on public.positions;
create policy "employee managers manage positions"
on public.positions for all to authenticated
using (public.has_permission('Employees.Manage'))
with check (public.has_permission('Employees.Manage'));

drop policy if exists "performance analysts read all evaluations" on public.performance_evaluations;
create policy "performance analysts read all evaluations"
on public.performance_evaluations for select to authenticated
using (public.has_permission('Performance.Analytics.View'));

drop trigger if exists set_positions_updated_on on public.positions;
create trigger set_positions_updated_on
before update on public.positions
for each row execute function public.set_updated_on();

drop trigger if exists audit_departments on public.departments;
create trigger audit_departments
after insert or update or delete on public.departments
for each row execute function public.write_audit_log();

drop trigger if exists audit_positions on public.positions;
create trigger audit_positions
after insert or update or delete on public.positions
for each row execute function public.write_audit_log();
