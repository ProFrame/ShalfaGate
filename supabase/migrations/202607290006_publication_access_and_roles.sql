-- Governed content visibility and the approved five-role access matrix.

alter table public.content_items
  add column if not exists publication_level text not null default 'PUBLIC';

alter table public.content_items
  drop constraint if exists content_items_publication_level_check;

alter table public.content_items
  add constraint content_items_publication_level_check
  check (publication_level in (
    'PUBLIC',
    'ADMINISTRATIVE',
    'MANAGER_RESTRICTED',
    'PRIVATE_RESTRICTED'
  ));

create index if not exists idx_content_items_publication_access
  on public.content_items(publication_level, content_type, publish_date desc)
  where is_published and not is_deleted;

create or replace function public.current_content_access_rank()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(max(
    case r.code
      when 'PLATFORM_ADMIN' then 4
      when 'SYSTEM_ADMIN' then 4
      when 'DEPARTMENT_MANAGER' then 3
      when 'DEPARTMENT_COORDINATOR' then 2
      when 'EMPLOYEE' then 1
      else 0
    end
  ), 0)
  from public.user_roles ur
  join public.roles r on r.id = ur.role_id
  where ur.user_id = auth.uid()
    and r.is_active
    and not r.is_deleted;
$$;

grant execute on function public.current_content_access_rank() to authenticated;

drop policy if exists "authenticated read published content" on public.content_items;
drop policy if exists "role governed read published content" on public.content_items;

create policy "role governed read published content"
on public.content_items
for select
to authenticated
using (
  is_published
  and not is_deleted
  and (expiry_date is null or expiry_date > now())
  and public.current_content_access_rank() >=
    case publication_level
      when 'PUBLIC' then 1
      when 'ADMINISTRATIVE' then 2
      when 'MANAGER_RESTRICTED' then 3
      when 'PRIVATE_RESTRICTED' then 4
      else 99
    end
);

-- Keep only the permissions approved for each non-platform role.
delete from public.role_permissions rp
using public.roles r
where r.id = rp.role_id
  and r.code in (
    'EMPLOYEE',
    'DEPARTMENT_COORDINATOR',
    'DEPARTMENT_MANAGER',
    'SYSTEM_ADMIN'
  );

insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in (
  'Dashboard.View',
  'Forms.View',
  'Forms.Create',
  'Forms.Update',
  'Forms.Delete',
  'Profile.Update'
)
where r.code = 'EMPLOYEE'
on conflict do nothing;

insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in (
  'Dashboard.View',
  'Forms.View',
  'Forms.Create',
  'Forms.Update',
  'Forms.Delete',
  'Profile.Update'
)
where r.code = 'DEPARTMENT_COORDINATOR'
on conflict do nothing;

insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in (
  'Dashboard.View',
  'Forms.View',
  'Forms.Create',
  'Forms.Update',
  'Forms.Delete',
  'Profile.Update'
)
where r.code = 'DEPARTMENT_MANAGER'
on conflict do nothing;

insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in (
  'Dashboard.View',
  'Forms.View',
  'Forms.Create',
  'Forms.Update',
  'Forms.Delete',
  'Employees.Manage',
  'Performance.Analytics.View',
  'Profile.Update'
)
where r.code = 'SYSTEM_ADMIN'
on conflict do nothing;

-- Platform administrators retain every registered permission.
insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'PLATFORM_ADMIN'
on conflict do nothing;
