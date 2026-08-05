-- ============================================================================
-- 014 — Engagement modules: Announcements, Surveys, Calendar, Notes
--
-- The four surfaces the employee meets on the home page right after login.
-- They share three rules:
--   * who sees a record is decided by the audience engine (013), never by
--     module-local logic;
--   * what an administrator may do is decided by a permission code, never by
--     a role code;
--   * the home page reads through SECURITY DEFINER read models, so a single
--     round trip returns everything a card needs (including the caller's own
--     state: read flag, own vote, own events).
--
-- Announcements and Surveys are countable resources, so both consume their
-- tenant quota; the counter is corrected again when a record is soft deleted.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Announcements
-- ----------------------------------------------------------------------------

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  title_ar text not null,
  title_en text,
  body_ar text,
  body_en text,
  -- The card shows the excerpt; "read more" reveals the body.
  excerpt_ar text,
  excerpt_en text,
  image_url text,
  priority text not null default 'Normal'
    check (priority in ('Normal', 'Important', 'Urgent')),
  is_published boolean not null default false,
  is_pinned boolean not null default false,
  publish_from timestamptz,
  publish_to timestamptz,
  display_order integer not null default 0,
  view_count bigint not null default 0,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  constraint announcements_window_check
    check (publish_from is null or publish_to is null or publish_to >= publish_from)
);

-- One row per employee per announcement; the carousel needs the read flag and
-- the admin screen needs the reach.
create table if not exists public.announcement_reads (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  announcement_id uuid not null,
  user_id uuid not null,
  read_on timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

-- ----------------------------------------------------------------------------
-- 2. Surveys
-- ----------------------------------------------------------------------------

create table if not exists public.surveys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  title_ar text not null,
  title_en text,
  description_ar text,
  description_en text,
  question_ar text not null,
  question_en text,
  is_published boolean not null default false,
  starts_on timestamptz,
  ends_on timestamptz,
  allow_change_vote boolean not null default true,
  is_anonymous boolean not null default true,
  display_order integer not null default 0,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  constraint surveys_window_check
    check (starts_on is null or ends_on is null or ends_on >= starts_on)
);

create table if not exists public.survey_options (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  survey_id uuid not null,
  label_ar text not null,
  label_en text,
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

-- One response per employee per survey: changing a vote is an UPDATE, so the
-- aggregate can never be inflated by re-voting.
create table if not exists public.survey_responses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  survey_id uuid not null,
  option_id uuid not null,
  user_id uuid not null,
  voted_on timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  constraint uq_survey_responses_voter unique (survey_id, user_id)
);

-- ----------------------------------------------------------------------------
-- 3. Calendar
-- ----------------------------------------------------------------------------

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  title_ar text not null,
  title_en text,
  description text,
  event_type text not null default 'Reminder'
    check (event_type in (
      'Holiday', 'Meeting', 'Reminder', 'Task',
      'Birthday', 'CompanyEvent', 'Training', 'Maintenance'
    )),
  color text,
  scope text not null default 'Personal' check (scope in ('Personal', 'Company')),
  owner_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz,
  is_all_day boolean not null default false,
  location text,
  remind_before_minutes integer not null default 0 check (remind_before_minutes >= 0),
  is_mandatory boolean not null default false,
  -- Stamped by the notification worker so a reminder is raised exactly once.
  reminder_sent_on timestamptz,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  constraint calendar_events_range_check
    check (ends_at is null or ends_at >= starts_at),
  -- A personal event always has an owner; a company event never does.
  constraint calendar_events_owner_check
    check ((scope = 'Personal' and owner_id is not null)
        or (scope = 'Company' and owner_id is null)),
  -- Only the company can make attendance mandatory.
  constraint calendar_events_mandatory_check
    check (not is_mandatory or scope = 'Company'),
  constraint calendar_events_color_check
    check (color is null or color ~ '^#[0-9a-fA-F]{6}$')
);

-- ----------------------------------------------------------------------------
-- 4. Notes (private notepad)
-- ----------------------------------------------------------------------------

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  owner_id uuid not null default auth.uid(),
  title text,
  body text,
  color text not null default '#ffffff'
    check (color ~ '^#[0-9a-fA-F]{6}$'),
  is_pinned boolean not null default false,
  is_archived boolean not null default false,
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

create table if not exists public.note_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  note_id uuid not null,
  content text not null default '',
  is_checked boolean not null default false,
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

-- ----------------------------------------------------------------------------
-- 5. Cross-tenant relationship guards
--    A vote may never point at an option of another company, and so on.
-- ----------------------------------------------------------------------------

create unique index if not exists uq_announcements_tenant_id
  on public.announcements (tenant_id, id);
create unique index if not exists uq_surveys_tenant_id
  on public.surveys (tenant_id, id);
create unique index if not exists uq_notes_tenant_id
  on public.notes (tenant_id, id);
-- Lets a response prove structurally that its option belongs to its survey.
create unique index if not exists uq_survey_options_survey_option
  on public.survey_options (survey_id, id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_announcement_reads_announcement_same_tenant') then
    alter table public.announcement_reads
      add constraint fk_announcement_reads_announcement_same_tenant
      foreign key (tenant_id, announcement_id)
      references public.announcements (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_announcement_reads_user_same_tenant') then
    alter table public.announcement_reads
      add constraint fk_announcement_reads_user_same_tenant
      foreign key (tenant_id, user_id)
      references public.users (tenant_id, id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_survey_options_survey_same_tenant') then
    alter table public.survey_options
      add constraint fk_survey_options_survey_same_tenant
      foreign key (tenant_id, survey_id)
      references public.surveys (tenant_id, id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_survey_responses_survey_same_tenant') then
    alter table public.survey_responses
      add constraint fk_survey_responses_survey_same_tenant
      foreign key (tenant_id, survey_id)
      references public.surveys (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_survey_responses_option_in_survey') then
    alter table public.survey_responses
      add constraint fk_survey_responses_option_in_survey
      foreign key (survey_id, option_id)
      references public.survey_options (survey_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_survey_responses_user_same_tenant') then
    alter table public.survey_responses
      add constraint fk_survey_responses_user_same_tenant
      foreign key (tenant_id, user_id)
      references public.users (tenant_id, id) on delete cascade;
  end if;

  -- owner_id is null on company events; MATCH SIMPLE leaves those unchecked.
  if not exists (select 1 from pg_constraint where conname = 'fk_calendar_events_owner_same_tenant') then
    alter table public.calendar_events
      add constraint fk_calendar_events_owner_same_tenant
      foreign key (tenant_id, owner_id)
      references public.users (tenant_id, id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_notes_owner_same_tenant') then
    alter table public.notes
      add constraint fk_notes_owner_same_tenant
      foreign key (tenant_id, owner_id)
      references public.users (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_note_items_note_same_tenant') then
    alter table public.note_items
      add constraint fk_note_items_note_same_tenant
      foreign key (tenant_id, note_id)
      references public.notes (tenant_id, id) on delete cascade;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 6. Indexes for the read paths the home page and the admin screens use
-- ----------------------------------------------------------------------------

create index if not exists idx_announcements_feed
  on public.announcements (tenant_id, is_pinned desc, display_order, publish_from desc)
  where is_published and not is_deleted;
create index if not exists idx_announcements_window
  on public.announcements (tenant_id, publish_to)
  where is_published and not is_deleted;
create index if not exists idx_announcement_reads_user
  on public.announcement_reads (tenant_id, user_id, read_on desc);

-- Only one published survey may exist per company at any moment.
create unique index if not exists uq_surveys_published_tenant
  on public.surveys (tenant_id)
  where is_published and not is_deleted;
create index if not exists idx_surveys_window
  on public.surveys (tenant_id, starts_on desc, ends_on)
  where not is_deleted;
create index if not exists idx_survey_options_survey
  on public.survey_options (survey_id, display_order)
  where not is_deleted;
create index if not exists idx_survey_responses_tally
  on public.survey_responses (survey_id, option_id)
  where not is_deleted;
create index if not exists idx_survey_responses_user
  on public.survey_responses (tenant_id, user_id);

create index if not exists idx_calendar_events_range
  on public.calendar_events (tenant_id, starts_at)
  where not is_deleted;
create index if not exists idx_calendar_events_owner
  on public.calendar_events (tenant_id, owner_id, starts_at)
  where scope = 'Personal' and not is_deleted;
create index if not exists idx_calendar_events_due
  on public.calendar_events (starts_at)
  where not is_deleted and reminder_sent_on is null;

create index if not exists idx_notes_owner
  on public.notes (tenant_id, owner_id, is_archived, is_pinned desc, display_order)
  where not is_deleted;
create index if not exists idx_note_items_note
  on public.note_items (note_id, display_order)
  where not is_deleted;

-- ----------------------------------------------------------------------------
-- 7. Standard plumbing: tenant index, row defaults, RLS, isolation policy
-- ----------------------------------------------------------------------------

do $$
declare
  engagement_tables text[] := array[
    'announcements', 'announcement_reads',
    'surveys', 'survey_options', 'survey_responses',
    'calendar_events', 'notes', 'note_items'
  ];
  tbl text;
begin
  foreach tbl in array engagement_tables loop
    execute format('create index if not exists idx_%s_tenant on public.%I (tenant_id)', tbl, tbl);

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
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 8. Quota accounting
--    Creating an announcement or a survey consumes the company allowance;
--    soft deleting one gives it back, otherwise the counter only ever grows.
-- ----------------------------------------------------------------------------

create or replace function public.consume_engagement_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if not coalesce(new.is_deleted, false) then
      perform public.tenant_quota_consume(tg_argv[0], 1::bigint, new.tenant_id);
    end if;
  elsif tg_op = 'UPDATE' then
    if new.is_deleted and not old.is_deleted then
      perform public.tenant_quota_consume(tg_argv[0], -1::bigint, new.tenant_id);
    elsif old.is_deleted and not new.is_deleted then
      perform public.tenant_quota_consume(tg_argv[0], 1::bigint, new.tenant_id);
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists consume_announcement_quota on public.announcements;
create trigger consume_announcement_quota
after insert or update of is_deleted on public.announcements
for each row execute function public.consume_engagement_quota('ANNOUNCEMENTS');

drop trigger if exists consume_survey_quota on public.surveys;
create trigger consume_survey_quota
after insert or update of is_deleted on public.surveys
for each row execute function public.consume_engagement_quota('SURVEYS');

-- ----------------------------------------------------------------------------
-- 9. Behaviour triggers
-- ----------------------------------------------------------------------------

-- Reading an announcement bumps view_count, and that is not an edit: keep the
-- audit columns of the administrator who actually wrote the row.
create or replace function public.announcement_view_is_not_an_edit()
returns trigger
language plpgsql
as $$
begin
  if new.view_count is distinct from old.view_count
     and (to_jsonb(new) - 'view_count' - 'updated_on' - 'updated_by' - 'row_version')
       = (to_jsonb(old) - 'view_count' - 'updated_on' - 'updated_by' - 'row_version')
  then
    new.updated_on := old.updated_on;
    new.updated_by := old.updated_by;
    new.row_version := old.row_version;
  end if;
  return new;
end;
$$;

-- Named to sort after apply_row_defaults so it undoes that stamping.
drop trigger if exists zz_announcement_view_is_not_an_edit on public.announcements;
create trigger zz_announcement_view_is_not_an_edit
before update on public.announcements
for each row execute function public.announcement_view_is_not_an_edit();

-- The partial unique index already makes a second published survey impossible;
-- this only turns the failure into a code the client can translate.
create or replace function public.guard_single_published_survey()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_published and not new.is_deleted then
    if exists (
      select 1 from public.surveys s
      where s.tenant_id = new.tenant_id
        and s.id <> new.id
        and s.is_published
        and not s.is_deleted
    ) then
      raise exception 'ANOTHER_SURVEY_IS_PUBLISHED' using errcode = '23505';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_single_published_survey on public.surveys;
create trigger guard_single_published_survey
before insert or update on public.surveys
for each row execute function public.guard_single_published_survey();

-- Employees own their personal events and may only create the three light
-- types; everything company wide belongs to Calendar.Manage. This lives in a
-- trigger and not only in a policy so no write path can bypass it.
create or replace function public.guard_calendar_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_can_manage boolean;
begin
  if new.color is null then
    new.color := case new.event_type
      when 'Holiday' then '#dc2626'
      when 'Meeting' then '#16a34a'
      when 'Reminder' then '#2563eb'
      when 'Task' then '#f59e0b'
      when 'Birthday' then '#db2777'
      when 'CompanyEvent' then '#7c3aed'
      when 'Training' then '#0891b2'
      when 'Maintenance' then '#64748b'
      else '#2563eb'
    end;
  end if;

  -- Migrations and the service role have no session identity; RLS does not
  -- apply to them either, so there is nothing to guard here.
  if auth.uid() is null then
    return new;
  end if;

  v_can_manage := public.has_permission('Calendar.Manage');

  if new.scope = 'Personal' and new.owner_id is null then
    new.owner_id := auth.uid();
  end if;

  if tg_op = 'UPDATE' and old.scope = 'Company' and not v_can_manage then
    raise exception 'COMPANY_EVENT_IS_READ_ONLY' using errcode = '42501';
  end if;

  if new.scope = 'Company' then
    if not v_can_manage then
      raise exception 'CALENDAR_MANAGE_REQUIRED' using errcode = '42501';
    end if;
    return new;
  end if;

  if not v_can_manage then
    if new.owner_id <> auth.uid() then
      raise exception 'NOT_EVENT_OWNER' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and old.owner_id <> new.owner_id then
      raise exception 'NOT_EVENT_OWNER' using errcode = '42501';
    end if;
    if new.event_type not in ('Reminder', 'Meeting', 'Task') then
      raise exception 'EVENT_TYPE_NOT_ALLOWED' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_calendar_event on public.calendar_events;
create trigger guard_calendar_event
before insert or update on public.calendar_events
for each row execute function public.guard_calendar_event();

-- ----------------------------------------------------------------------------
-- 10. Access policies
--     The RESTRICTIVE isolation policy above is ANDed with everything here.
-- ----------------------------------------------------------------------------

-- Announcements ---------------------------------------------------------------

drop policy if exists "audience reads published announcements" on public.announcements;
create policy "audience reads published announcements" on public.announcements
  for select to authenticated
  using (
    is_published
    and not is_deleted
    and (publish_from is null or publish_from <= now())
    and (publish_to is null or publish_to >= now())
    and public.audience_matches('Announcement', id)
  );

drop policy if exists "announcement managers manage announcements" on public.announcements;
create policy "announcement managers manage announcements" on public.announcements
  for all to authenticated
  using (public.has_permission('Announcements.Manage'))
  with check (public.has_permission('Announcements.Manage'));

drop policy if exists "users manage own announcement reads" on public.announcement_reads;
create policy "users manage own announcement reads" on public.announcement_reads
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Reach reporting on the admin screen.
drop policy if exists "announcement managers read reach" on public.announcement_reads;
create policy "announcement managers read reach" on public.announcement_reads
  for select to authenticated
  using (public.has_permission('Announcements.Manage'));

-- Surveys ---------------------------------------------------------------------

drop policy if exists "audience reads open surveys" on public.surveys;
create policy "audience reads open surveys" on public.surveys
  for select to authenticated
  using (
    is_published
    and not is_deleted
    and (starts_on is null or starts_on <= now())
    and (ends_on is null or ends_on >= now())
    and public.audience_matches('Survey', id)
  );

drop policy if exists "survey managers manage surveys" on public.surveys;
create policy "survey managers manage surveys" on public.surveys
  for all to authenticated
  using (public.has_permission('Surveys.Manage'))
  with check (public.has_permission('Surveys.Manage'));

-- An option is visible exactly when its survey is: the parent lookup is itself
-- filtered by the policies above.
drop policy if exists "audience reads options of visible surveys" on public.survey_options;
create policy "audience reads options of visible surveys" on public.survey_options
  for select to authenticated
  using (
    not is_deleted
    and exists (select 1 from public.surveys s where s.id = survey_options.survey_id)
  );

drop policy if exists "survey managers manage options" on public.survey_options;
create policy "survey managers manage options" on public.survey_options
  for all to authenticated
  using (public.has_permission('Surveys.Manage'))
  with check (public.has_permission('Surveys.Manage'));

drop policy if exists "voters manage own response" on public.survey_responses;
create policy "voters manage own response" on public.survey_responses
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.surveys s where s.id = survey_responses.survey_id)
  );

-- An anonymous survey never exposes who voted, not even to its owner; the
-- aggregate is served by survey_snapshot instead.
drop policy if exists "survey managers read named responses" on public.survey_responses;
create policy "survey managers read named responses" on public.survey_responses
  for select to authenticated
  using (
    public.has_permission('Surveys.Manage')
    and exists (
      select 1 from public.surveys s
      where s.id = survey_responses.survey_id and not s.is_anonymous
    )
  );

-- Calendar --------------------------------------------------------------------

drop policy if exists "employees read own and targeted events" on public.calendar_events;
create policy "employees read own and targeted events" on public.calendar_events
  for select to authenticated
  using (
    not is_deleted
    and (
      (scope = 'Personal' and owner_id = auth.uid())
      or (scope = 'Company' and public.audience_matches('CalendarEvent', id))
    )
  );

drop policy if exists "employees write own personal events" on public.calendar_events;
create policy "employees write own personal events" on public.calendar_events
  for all to authenticated
  using (scope = 'Personal' and owner_id = auth.uid())
  with check (scope = 'Personal' and owner_id = auth.uid());

drop policy if exists "calendar managers manage events" on public.calendar_events;
create policy "calendar managers manage events" on public.calendar_events
  for all to authenticated
  using (public.has_permission('Calendar.Manage'))
  with check (public.has_permission('Calendar.Manage'));

-- Notes -----------------------------------------------------------------------

drop policy if exists "owners manage own notes" on public.notes;
create policy "owners manage own notes" on public.notes
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists "owners manage own note items" on public.note_items;
create policy "owners manage own note items" on public.note_items
  for all to authenticated
  using (exists (
    select 1 from public.notes n
    where n.id = note_items.note_id and n.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.notes n
    where n.id = note_items.note_id and n.owner_id = auth.uid()
  ));

-- ----------------------------------------------------------------------------
-- 11. Read models for the home page
--     Every one of these is SECURITY DEFINER, so RLS no longer protects them;
--     the tenant filter below is the isolation.
-- ----------------------------------------------------------------------------

-- Published, in window, audience matched. Pinned first, then the admin order,
-- then newest. Carries the caller's own read flag for the carousel badge.
create or replace function public.announcement_feed()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'title_ar', a.title_ar,
      'title_en', a.title_en,
      'body_ar', a.body_ar,
      'body_en', a.body_en,
      'excerpt_ar', a.excerpt_ar,
      'excerpt_en', a.excerpt_en,
      'image_url', a.image_url,
      'priority', a.priority,
      'is_pinned', a.is_pinned,
      'publish_from', a.publish_from,
      'publish_to', a.publish_to,
      'display_order', a.display_order,
      'view_count', a.view_count,
      'created_on', a.created_on,
      'is_read', r.user_id is not null,
      'read_on', r.read_on
    )
    order by a.is_pinned desc, a.display_order, a.publish_from desc nulls last, a.created_on desc
  ), '[]'::jsonb)
  from public.announcements a
  left join public.announcement_reads r
    on r.announcement_id = a.id
   and r.tenant_id = a.tenant_id
   and r.user_id = auth.uid()
  where a.tenant_id = public.current_tenant_id()
    and public.tenant_has_module('ANNOUNCEMENTS')
    and a.is_published
    and not a.is_deleted
    and (a.publish_from is null or a.publish_from <= now())
    and (a.publish_to is null or a.publish_to >= now())
    and public.audience_matches('Announcement', a.id);
$$;
revoke all on function public.announcement_feed() from public, anon;
grant execute on function public.announcement_feed() to authenticated;

-- "Read more" marks the card as read once and counts the view once.
create or replace function public.announcement_mark_read(p_announcement_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_first boolean := false;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  if not exists (
    select 1 from public.announcements a
    where a.id = p_announcement_id and a.tenant_id = v_tenant and not a.is_deleted
  ) then
    raise exception 'ANNOUNCEMENT_NOT_FOUND';
  end if;

  insert into public.announcement_reads (tenant_id, announcement_id, user_id, read_on)
  values (v_tenant, p_announcement_id, auth.uid(), now())
  on conflict (announcement_id, user_id) do nothing;

  if found then
    v_first := true;
    update public.announcements
    set view_count = view_count + 1
    where id = p_announcement_id and tenant_id = v_tenant;
  end if;

  return jsonb_build_object(
    'announcement_id', p_announcement_id,
    'is_read', true,
    'first_read', v_first
  );
end;
$$;
revoke all on function public.announcement_mark_read(uuid) from public, anon;
grant execute on function public.announcement_mark_read(uuid) to authenticated;

-- The survey plus its tally. Per-option counts only — a response row is never
-- exposed, so an anonymous survey stays anonymous.
create or replace function public.survey_snapshot(p_survey_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_survey public.surveys%rowtype;
  v_total bigint := 0;
  v_my_option uuid;
  v_options jsonb;
begin
  select * into v_survey
  from public.surveys s
  where s.id = p_survey_id and s.tenant_id = v_tenant and not s.is_deleted;

  if not found then
    return jsonb_build_object(
      'survey', null, 'options', '[]'::jsonb, 'total_votes', 0,
      'my_option_id', null, 'has_voted', false, 'can_change_vote', false
    );
  end if;

  -- An owner sees the tally of any of their surveys (that is the results
  -- screen, and it is the only way to read an anonymous one); everybody else
  -- only sees a survey that is actually aimed at them and open.
  if not public.has_permission('Surveys.Manage')
     and not (
       v_survey.is_published
       and (v_survey.starts_on is null or v_survey.starts_on <= now())
       and (v_survey.ends_on is null or v_survey.ends_on >= now())
       and public.audience_matches('Survey', v_survey.id)
     ) then
    raise exception 'SURVEY_NOT_VISIBLE';
  end if;

  select count(*) into v_total
  from public.survey_responses r
  where r.survey_id = v_survey.id and r.tenant_id = v_tenant and not r.is_deleted;

  select r.option_id into v_my_option
  from public.survey_responses r
  where r.survey_id = v_survey.id
    and r.tenant_id = v_tenant
    and r.user_id = auth.uid()
    and not r.is_deleted;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', o.id,
      'label_ar', o.label_ar,
      'label_en', o.label_en,
      'display_order', o.display_order,
      'votes', v.votes,
      'percent', case when v_total > 0
                      then round((v.votes * 100.0) / v_total, 1)
                      else 0 end
    )
    order by o.display_order, o.created_on
  ), '[]'::jsonb)
  into v_options
  from public.survey_options o
  cross join lateral (
    select count(*) as votes
    from public.survey_responses r
    where r.option_id = o.id and r.tenant_id = v_tenant and not r.is_deleted
  ) v
  where o.survey_id = v_survey.id
    and o.tenant_id = v_tenant
    and not o.is_deleted;

  return jsonb_build_object(
    'survey', jsonb_build_object(
      'id', v_survey.id,
      'title_ar', v_survey.title_ar,
      'title_en', v_survey.title_en,
      'description_ar', v_survey.description_ar,
      'description_en', v_survey.description_en,
      'question_ar', v_survey.question_ar,
      'question_en', v_survey.question_en,
      'starts_on', v_survey.starts_on,
      'ends_on', v_survey.ends_on,
      'is_anonymous', v_survey.is_anonymous,
      'allow_change_vote', v_survey.allow_change_vote
    ),
    'options', v_options,
    'total_votes', v_total,
    'my_option_id', v_my_option,
    'has_voted', v_my_option is not null,
    'can_change_vote', v_survey.allow_change_vote
  );
end;
$$;
revoke all on function public.survey_snapshot(uuid) from public, anon;
grant execute on function public.survey_snapshot(uuid) to authenticated;

-- At most one survey is published per company; the card renders its empty
-- state when this returns a null survey.
create or replace function public.survey_current()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.tenant_has_module('SURVEY') then
    return jsonb_build_object(
      'survey', null, 'options', '[]'::jsonb, 'total_votes', 0,
      'my_option_id', null, 'has_voted', false, 'can_change_vote', false
    );
  end if;

  select s.id into v_id
  from public.surveys s
  where s.tenant_id = public.current_tenant_id()
    and s.is_published
    and not s.is_deleted
    and (s.starts_on is null or s.starts_on <= now())
    and (s.ends_on is null or s.ends_on >= now())
    and public.audience_matches('Survey', s.id)
  order by s.starts_on desc nulls last, s.created_on desc
  limit 1;

  if v_id is null then
    return jsonb_build_object(
      'survey', null, 'options', '[]'::jsonb, 'total_votes', 0,
      'my_option_id', null, 'has_voted', false, 'can_change_vote', false
    );
  end if;

  return public.survey_snapshot(v_id);
end;
$$;
revoke all on function public.survey_current() from public, anon;
grant execute on function public.survey_current() to authenticated;

create or replace function public.survey_vote(p_survey_id uuid, p_option_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_survey public.surveys%rowtype;
  v_existing uuid;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select * into v_survey
  from public.surveys s
  where s.id = p_survey_id and s.tenant_id = v_tenant and not s.is_deleted;

  if not found then
    raise exception 'SURVEY_NOT_FOUND';
  end if;

  if not v_survey.is_published
     or (v_survey.starts_on is not null and v_survey.starts_on > now())
     or (v_survey.ends_on is not null and v_survey.ends_on < now()) then
    raise exception 'SURVEY_NOT_OPEN';
  end if;

  if not public.audience_matches('Survey', v_survey.id) then
    raise exception 'SURVEY_NOT_VISIBLE';
  end if;

  if not exists (
    select 1 from public.survey_options o
    where o.id = p_option_id
      and o.survey_id = p_survey_id
      and o.tenant_id = v_tenant
      and not o.is_deleted
  ) then
    raise exception 'INVALID_SURVEY_OPTION';
  end if;

  select r.option_id into v_existing
  from public.survey_responses r
  where r.survey_id = p_survey_id and r.user_id = auth.uid() and r.tenant_id = v_tenant;

  if v_existing is not null
     and v_existing is distinct from p_option_id
     and not v_survey.allow_change_vote then
    raise exception 'VOTE_CHANGE_NOT_ALLOWED';
  end if;

  insert into public.survey_responses (tenant_id, survey_id, option_id, user_id, voted_on)
  values (v_tenant, p_survey_id, p_option_id, auth.uid(), now())
  on conflict (survey_id, user_id) do update
    set option_id = excluded.option_id,
        voted_on = now(),
        is_deleted = false;

  return public.survey_snapshot(p_survey_id);
end;
$$;
revoke all on function public.survey_vote(uuid, uuid) from public, anon;
grant execute on function public.survey_vote(uuid, uuid) to authenticated;

-- Every event of one month the caller may see: their own personal events plus
-- the company events targeted at them. The month is bounded in the company
-- timezone, so a grid drawn locally and the rows returned here agree.
create or replace function public.calendar_month(p_year integer, p_month integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
  v_events jsonb;
begin
  if p_year is null or p_month is null or p_month < 1 or p_month > 12
     or p_year < 1970 or p_year > 3000 then
    raise exception 'INVALID_MONTH';
  end if;

  if not public.tenant_has_module('CALENDAR') then
    return '[]'::jsonb;
  end if;

  select coalesce(t.timezone, 'UTC') into v_tz
  from public.tenants t where t.id = v_tenant;
  v_tz := coalesce(v_tz, 'UTC');

  v_from := (make_date(p_year, p_month, 1))::timestamp at time zone v_tz;
  v_to := (make_date(p_year, p_month, 1) + interval '1 month')::timestamp at time zone v_tz;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', e.id,
      'title_ar', e.title_ar,
      'title_en', e.title_en,
      'description', e.description,
      'event_type', e.event_type,
      'color', e.color,
      'scope', e.scope,
      'event_date', (e.starts_at at time zone v_tz)::date,
      'end_date', (coalesce(e.ends_at, e.starts_at) at time zone v_tz)::date,
      'starts_at', e.starts_at,
      'ends_at', e.ends_at,
      'is_all_day', e.is_all_day,
      'location', e.location,
      'remind_before_minutes', e.remind_before_minutes,
      'is_mandatory', e.is_mandatory,
      'is_own', coalesce(e.owner_id = auth.uid(), false),
      'can_edit', coalesce(e.scope = 'Personal' and e.owner_id = auth.uid(), false)
    )
    order by e.starts_at, e.event_type
  ), '[]'::jsonb)
  into v_events
  from public.calendar_events e
  where e.tenant_id = v_tenant
    and not e.is_deleted
    and e.starts_at < v_to
    and coalesce(e.ends_at, e.starts_at) >= v_from
    and (
      (e.scope = 'Personal' and e.owner_id = auth.uid())
      or (e.scope = 'Company' and public.audience_matches('CalendarEvent', e.id))
    );

  return v_events;
end;
$$;
revoke all on function public.calendar_month(integer, integer) from public, anon;
grant execute on function public.calendar_month(integer, integer) to authenticated;

-- The only write path an employee has into the calendar: their own event, of
-- one of the three light types, never mandatory.
create or replace function public.calendar_upsert_personal(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id uuid := nullif(p_payload ->> 'id', '')::uuid;
  v_type text := coalesce(nullif(p_payload ->> 'event_type', ''), 'Reminder');
  v_title_ar text := nullif(p_payload ->> 'title_ar', '');
  v_title_en text := nullif(p_payload ->> 'title_en', '');
  v_starts timestamptz := nullif(p_payload ->> 'starts_at', '')::timestamptz;
  v_ends timestamptz := nullif(p_payload ->> 'ends_at', '')::timestamptz;
  v_row public.calendar_events%rowtype;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  if not public.tenant_has_module('CALENDAR') then
    raise exception 'MODULE_NOT_ENABLED';
  end if;
  if v_type not in ('Reminder', 'Meeting', 'Task') then
    raise exception 'EVENT_TYPE_NOT_ALLOWED';
  end if;
  if coalesce(v_title_ar, v_title_en) is null then
    raise exception 'EVENT_TITLE_REQUIRED';
  end if;
  if v_starts is null then
    raise exception 'EVENT_START_REQUIRED';
  end if;
  if v_ends is not null and v_ends < v_starts then
    raise exception 'INVALID_EVENT_RANGE';
  end if;

  if v_id is null then
    insert into public.calendar_events (
      tenant_id, title_ar, title_en, description, event_type, color,
      scope, owner_id, starts_at, ends_at, is_all_day, location,
      remind_before_minutes, is_mandatory
    )
    values (
      v_tenant,
      coalesce(v_title_ar, v_title_en),
      v_title_en,
      nullif(p_payload ->> 'description', ''),
      v_type,
      nullif(p_payload ->> 'color', ''),
      'Personal',
      auth.uid(),
      v_starts,
      v_ends,
      coalesce((p_payload ->> 'is_all_day')::boolean, false),
      nullif(p_payload ->> 'location', ''),
      coalesce((p_payload ->> 'remind_before_minutes')::integer, 0),
      false
    )
    returning * into v_row;
  else
    update public.calendar_events e set
      title_ar = coalesce(v_title_ar, v_title_en),
      title_en = v_title_en,
      description = nullif(p_payload ->> 'description', ''),
      event_type = v_type,
      color = nullif(p_payload ->> 'color', ''),
      starts_at = v_starts,
      ends_at = v_ends,
      is_all_day = coalesce((p_payload ->> 'is_all_day')::boolean, false),
      location = nullif(p_payload ->> 'location', ''),
      remind_before_minutes = coalesce((p_payload ->> 'remind_before_minutes')::integer, 0),
      reminder_sent_on = null
    where e.id = v_id
      and e.tenant_id = v_tenant
      and e.scope = 'Personal'
      and e.owner_id = auth.uid()
      and not e.is_deleted
    returning * into v_row;

    if not found then
      raise exception 'EVENT_NOT_FOUND';
    end if;
  end if;

  return to_jsonb(v_row) - 'created_by' - 'updated_by' - 'deleted_by' - 'row_version';
end;
$$;
revoke all on function public.calendar_upsert_personal(jsonb) from public, anon;
grant execute on function public.calendar_upsert_personal(jsonb) to authenticated;

create or replace function public.calendar_delete_personal(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  update public.calendar_events e
  set is_deleted = true,
      deleted_by = auth.uid(),
      deleted_date = now()
  where e.id = p_id
    and e.tenant_id = v_tenant
    and e.scope = 'Personal'
    and e.owner_id = auth.uid()
    and not e.is_deleted;

  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  return jsonb_build_object('id', p_id, 'deleted', true);
end;
$$;
revoke all on function public.calendar_delete_personal(uuid) from public, anon;
grant execute on function public.calendar_delete_personal(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 12. Permissions
--     The three management codes were declared in 012; Notes.Use is new and
--     belongs to everyone, because the notepad is private by construction.
-- ----------------------------------------------------------------------------

insert into public.permissions (code, module, description) values
  ('Announcements.Manage', 'Announcements', 'Publish and manage announcements'),
  ('Surveys.Manage', 'Surveys', 'Publish and manage surveys'),
  ('Calendar.Manage', 'Calendar', 'Manage company calendar events'),
  ('Notes.Use', 'Notes', 'Use the private notepad')
on conflict (code) do nothing;

insert into public.role_permissions (tenant_id, role_id, permission_id)
select r.tenant_id, r.id, p.id
from public.roles r
join public.permissions p
  on p.code in ('Announcements.Manage', 'Surveys.Manage', 'Calendar.Manage')
where r.code in ('PLATFORM_ADMIN', 'SYSTEM_ADMIN')
  and not r.is_deleted
on conflict do nothing;

insert into public.role_permissions (tenant_id, role_id, permission_id)
select r.tenant_id, r.id, p.id
from public.roles r
join public.permissions p on p.code = 'Notes.Use'
where not r.is_deleted
on conflict do nothing;
