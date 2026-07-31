-- Employee identity integrity, delegated submissions, and workflow-ready form states.

alter table public.forms
  add column if not exists requested_by uuid references public.users(id),
  add column if not exists submission_mode text not null default 'Self',
  add column if not exists returned_on timestamptz,
  add column if not exists cancelled_on timestamptz;

update public.forms
set requested_by = employee_id
where requested_by is null;

alter table public.forms
  alter column requested_by set not null,
  alter column requested_by set default auth.uid();

alter table public.forms drop constraint if exists forms_submission_mode_check;
alter table public.forms
  add constraint forms_submission_mode_check
  check (submission_mode in ('Self', 'OnBehalf'));

alter table public.forms drop constraint if exists forms_status_check;

update public.forms
set status = case status
  when 'Approved' then 'Submitted'
  when 'Closed' then 'Submitted'
  when 'Rejected' then 'Returned'
  else status
end
where status not in ('Draft', 'Submitted', 'Returned', 'Cancelled');

alter table public.forms
  add constraint forms_status_check
  check (status in ('Draft', 'Submitted', 'Returned', 'Cancelled'));

create index if not exists idx_forms_requested_by_updated
  on public.forms(requested_by, updated_on desc);
create index if not exists idx_forms_beneficiary_updated
  on public.forms(employee_id, updated_on desc);
create index if not exists idx_forms_submission_mode
  on public.forms(submission_mode, status);

create or replace function public.validate_form_submission_scope()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.submission_mode = 'Self' and new.employee_id <> new.requested_by then
    raise exception 'Self submissions must use the requester as beneficiary'
      using errcode = '23514';
  end if;

  if new.status = 'Returned' then
    new.returned_on = coalesce(new.returned_on, now());
  elsif new.status = 'Cancelled' then
    new.cancelled_on = coalesce(new.cancelled_on, now());
  end if;

  return new;
end;
$$;

drop trigger if exists validate_form_submission_scope on public.forms;
create trigger validate_form_submission_scope
before insert or update on public.forms
for each row execute function public.validate_form_submission_scope();

drop policy if exists "employees can read own forms" on public.forms;
drop policy if exists "employees can create own forms" on public.forms;
drop policy if exists "employees can update own draft or submitted forms" on public.forms;
drop policy if exists "employees can delete own drafts" on public.forms;
drop policy if exists "requesters and beneficiaries read forms" on public.forms;
drop policy if exists "employees create requested forms" on public.forms;
drop policy if exists "requesters update editable forms" on public.forms;
drop policy if exists "requesters delete own drafts" on public.forms;

create policy "requesters and beneficiaries read forms" on public.forms
  for select to authenticated
  using (
    auth.uid() = requested_by
    or auth.uid() = employee_id
    or public.has_permission('Forms.View')
  );

create policy "employees create requested forms" on public.forms
  for insert to authenticated
  with check (
    auth.uid() = requested_by
    and (
      (submission_mode = 'Self' and employee_id = auth.uid())
      or submission_mode = 'OnBehalf'
    )
  );

create policy "requesters update editable forms" on public.forms
  for update to authenticated
  using (
    auth.uid() = requested_by
    and status in ('Draft', 'Returned')
  )
  with check (
    auth.uid() = requested_by
    and status in ('Draft', 'Submitted', 'Cancelled')
  );

create policy "requesters delete own drafts" on public.forms
  for delete to authenticated
  using (auth.uid() = requested_by and status = 'Draft');

-- Keep the public employee email aligned with the authoritative Auth identity.
create or replace function public.guard_employee_auth_email()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  auth_email text;
begin
  select lower(email) into auth_email
  from auth.users
  where id = new.id;

  if auth_email is null or lower(trim(new.email)) <> auth_email then
    raise exception 'Employee email must be updated through the identity service'
      using errcode = '23514';
  end if;

  new.email = auth_email;
  return new;
end;
$$;

drop trigger if exists guard_employee_auth_email on public.users;
create trigger guard_employee_auth_email
before insert or update of email on public.users
for each row execute function public.guard_employee_auth_email();

create or replace function public.sync_employee_email_from_auth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is distinct from old.email then
    update public.users
    set email = lower(new.email),
        updated_on = now()
    where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
after update of email on auth.users
for each row execute function public.sync_employee_email_from_auth();

-- Minimal directory for delegated submissions. Sensitive employee fields are omitted.
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
  order by coalesce(u.name_ar, u.name_en, u.full_name);
$$;

revoke all on function public.list_form_recipients() from public;
grant execute on function public.list_form_recipients() to authenticated;

create or replace function public.record_first_login()
returns void
language sql
security definer
set search_path = public
as $$
  update public.users
  set first_login_on = coalesce(first_login_on, now()),
      invitation_accepted_on = coalesce(invitation_accepted_on, now()),
      password_set_on = coalesce(password_set_on, now()),
      account_activated_on = coalesce(account_activated_on, now()),
      updated_on = now()
  where id = auth.uid();
$$;

grant execute on function public.record_first_login() to authenticated;

create unique index if not exists uq_users_email_ci
  on public.users(lower(trim(email)))
  where is_deleted = false;
