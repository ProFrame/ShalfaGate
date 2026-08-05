-- ============================================================================
-- 015 — Notification centre, notification preferences and the personal
--       workspace (home page widgets + user preferences)
--
-- Two ideas drive this file:
--
--   * A notification is only worth sending when the person asked for it.
--     Every delivery goes through public.notify() / public.notify_many(),
--     which consult public.notification_preferences first. Nothing writes to
--     public.notifications directly — there is deliberately no insert policy —
--     so the preference gate can never be bypassed by a client.
--
--   * The home page belongs to the employee, not to the product. The widget
--     catalogue only says what *may* be shown and in which default order; the
--     per-user override table decides what is actually rendered, how wide it
--     is, whether it is collapsed and where it sits after a drag & drop.
--     A user with no overrides still gets a complete, ordered dashboard.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Notification centre
-- ----------------------------------------------------------------------------

-- state is the user's filing cabinet (Unread / Read / Archived / Deleted).
-- It is unrelated to is_deleted, which stays the platform-level soft delete.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  recipient_id uuid not null references public.users(id) on delete cascade,
  category text not null check (category in (
    'Message', 'Circular', 'Announcement', 'Survey', 'Approval', 'Event',
    'System', 'Support', 'Verification'
  )),
  event_code text,
  title_ar text not null,
  title_en text,
  body_ar text,
  body_en text,
  payload jsonb not null default '{}'::jsonb,
  link_path text,
  state text not null default 'Unread'
    check (state in ('Unread', 'Read', 'Archived', 'Deleted')),
  is_pinned boolean not null default false,
  read_on timestamptz,
  archived_on timestamptz,
  expires_on timestamptz,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_notifications_tenant on public.notifications (tenant_id);

-- The one index the bell icon and the centre both ride on.
create index if not exists idx_notifications_recipient_state
  on public.notifications (tenant_id, recipient_id, state, created_on desc)
  where not is_deleted;

create index if not exists idx_notifications_recipient_pinned
  on public.notifications (tenant_id, recipient_id, created_on desc)
  where is_pinned and not is_deleted;

create index if not exists idx_notifications_recipient_category
  on public.notifications (tenant_id, recipient_id, category, created_on desc)
  where not is_deleted;

create index if not exists idx_notifications_expiry
  on public.notifications (expires_on)
  where expires_on is not null and not is_deleted;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_notifications_recipient_same_tenant') then
    alter table public.notifications
      add constraint fk_notifications_recipient_same_tenant
      foreign key (tenant_id, recipient_id) references public.users (tenant_id, id) on delete cascade;
  end if;
end $$;

drop trigger if exists apply_row_defaults on public.notifications;
create trigger apply_row_defaults before insert or update on public.notifications
for each row execute function public.apply_row_defaults();

alter table public.notifications enable row level security;

drop policy if exists "tenant isolation" on public.notifications;
create policy "tenant isolation" on public.notifications
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "users read own notifications" on public.notifications;
create policy "users read own notifications" on public.notifications
  for select to authenticated
  using (recipient_id = auth.uid());

-- Filing (read / archive / pin / trash) is the only write a client may do, and
-- only on rows addressed to itself. Creation is reserved for public.notify().
drop policy if exists "users file own notifications" on public.notifications;
create policy "users file own notifications" on public.notifications
  for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

drop policy if exists "users remove own notifications" on public.notifications;
create policy "users remove own notifications" on public.notifications
  for delete to authenticated
  using (recipient_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 2. Per-user notification preferences
--    A missing row means "yes, in app": people should not have to opt in to
--    the six categories the product is built around.
-- ----------------------------------------------------------------------------

create table if not exists public.notification_preferences (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  category text not null check (category in (
    'Message', 'Circular', 'Announcement', 'Survey', 'Approval', 'Event'
  )),
  in_app boolean not null default true,
  email boolean not null default false,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  primary key (tenant_id, user_id, category)
);

create index if not exists idx_notification_preferences_tenant
  on public.notification_preferences (tenant_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_notification_preferences_user_same_tenant') then
    alter table public.notification_preferences
      add constraint fk_notification_preferences_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id) on delete cascade;
  end if;
end $$;

drop trigger if exists apply_row_defaults on public.notification_preferences;
create trigger apply_row_defaults before insert or update on public.notification_preferences
for each row execute function public.apply_row_defaults();

alter table public.notification_preferences enable row level security;

drop policy if exists "tenant isolation" on public.notification_preferences;
create policy "tenant isolation" on public.notification_preferences
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "users manage own notification preferences" on public.notification_preferences;
create policy "users manage own notification preferences" on public.notification_preferences
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- System / Support / Verification are operational: they are never silenced,
-- which is why they are not part of the preference check constraint.
create or replace function public.notification_enabled(p_user uuid, p_category text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_category is null or p_user is null then false
    when p_category not in ('Message', 'Circular', 'Announcement', 'Survey', 'Approval', 'Event') then true
    else coalesce((
      select np.in_app
      from public.notification_preferences np
      join public.users u on u.id = np.user_id and u.tenant_id = np.tenant_id
      where np.user_id = p_user
        and np.category = p_category
        and not np.is_deleted
        -- A definer function bypasses RLS: without this a signed in user could
        -- read a preference belonging to somebody in another company. A system
        -- context (service role, no session tenant) still sees every row.
        and u.tenant_id = coalesce(public.current_tenant_id(), u.tenant_id)
      limit 1
    ), true)
  end;
$$;
revoke all on function public.notification_enabled(uuid, text) from public;
grant execute on function public.notification_enabled(uuid, text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. Delivery
--    Every producer in the product calls these two and nothing else.
-- ----------------------------------------------------------------------------

-- Returns the new notification id, or null when the category is switched off,
-- the recipient is gone, or the recipient is the actor (nobody needs to be
-- told about their own action).
create or replace function public.notify(
  p_recipient uuid,
  p_category text,
  p_event_code text,
  p_title_ar text,
  p_title_en text,
  p_body_ar text,
  p_body_en text,
  p_link text,
  p_payload jsonb default '{}'::jsonb,
  p_expires_on timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_session_tenant uuid := public.current_tenant_id();
  v_actor uuid := auth.uid();
  v_id uuid;
begin
  if p_recipient is null then
    return null;
  end if;

  if p_category is null or p_category not in (
    'Message', 'Circular', 'Announcement', 'Survey', 'Approval', 'Event',
    'System', 'Support', 'Verification'
  ) then
    raise exception 'INVALID_NOTIFICATION_CATEGORY';
  end if;

  if coalesce(p_title_ar, p_title_en) is null then
    raise exception 'NOTIFICATION_TITLE_REQUIRED';
  end if;

  select u.tenant_id into v_tenant
  from public.users u
  where u.id = p_recipient and not u.is_deleted;

  if v_tenant is null then
    return null;
  end if;

  -- A definer function bypasses RLS, so this is the tenant boundary: a signed
  -- in user can never address somebody in another company. A system context
  -- (service role, no session tenant) is allowed through.
  if v_session_tenant is not null and v_tenant <> v_session_tenant then
    raise exception 'NOTIFICATION_RECIPIENT_NOT_IN_TENANT';
  end if;

  if v_actor is not null and v_actor = p_recipient then
    return null;
  end if;

  if not public.notification_enabled(p_recipient, p_category) then
    return null;
  end if;

  insert into public.notifications (
    tenant_id, recipient_id, category, event_code,
    title_ar, title_en, body_ar, body_en,
    payload, link_path, expires_on
  )
  values (
    v_tenant, p_recipient, p_category, p_event_code,
    coalesce(p_title_ar, p_title_en), p_title_en, p_body_ar, p_body_en,
    coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('actor_id', v_actor),
    p_link, p_expires_on
  )
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function public.notify(uuid, text, text, text, text, text, text, text, jsonb, timestamptz) from public;
grant execute on function public.notify(uuid, text, text, text, text, text, text, text, jsonb, timestamptz) to authenticated, service_role;

-- Broadcast form. One statement, so publishing to a whole company stays a
-- single insert instead of thousands of round trips. Returns how many people
-- were actually notified after the preference gate.
create or replace function public.notify_many(
  p_recipients uuid[],
  p_category text,
  p_event_code text,
  p_title_ar text,
  p_title_en text,
  p_body_ar text,
  p_body_en text,
  p_link text,
  p_payload jsonb default '{}'::jsonb,
  p_expires_on timestamptz default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_session_tenant uuid := public.current_tenant_id();
  v_actor uuid := auth.uid();
  v_count integer := 0;
begin
  if p_recipients is null or cardinality(p_recipients) = 0 then
    return 0;
  end if;

  if p_category is null or p_category not in (
    'Message', 'Circular', 'Announcement', 'Survey', 'Approval', 'Event',
    'System', 'Support', 'Verification'
  ) then
    raise exception 'INVALID_NOTIFICATION_CATEGORY';
  end if;

  if coalesce(p_title_ar, p_title_en) is null then
    raise exception 'NOTIFICATION_TITLE_REQUIRED';
  end if;

  insert into public.notifications (
    tenant_id, recipient_id, category, event_code,
    title_ar, title_en, body_ar, body_en,
    payload, link_path, expires_on
  )
  select
    u.tenant_id, u.id, p_category, p_event_code,
    coalesce(p_title_ar, p_title_en), p_title_en, p_body_ar, p_body_en,
    coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('actor_id', v_actor),
    p_link, p_expires_on
  from public.users u
  where u.id = any (p_recipients)
    and u.is_active
    and not u.is_deleted
    and u.tenant_id = coalesce(v_session_tenant, u.tenant_id)
    and (v_actor is null or u.id <> v_actor)
    and public.notification_enabled(u.id, p_category);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.notify_many(uuid[], text, text, text, text, text, text, text, jsonb, timestamptz) from public;
grant execute on function public.notify_many(uuid[], text, text, text, text, text, text, text, jsonb, timestamptz) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. Reading and filing (the notification centre screen)
-- ----------------------------------------------------------------------------

create or replace function public.notification_feed(
  p_state text default 'Unread',
  p_limit int default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_state text := coalesce(nullif(trim(p_state), ''), 'Unread');
  v_limit int := greatest(1, least(coalesce(p_limit, 50), 200));
  v_result jsonb;
begin
  if v_state not in ('Unread', 'Read', 'Archived', 'Deleted', 'Pinned', 'All') then
    raise exception 'INVALID_NOTIFICATION_STATE';
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', f.id,
             'category', f.category,
             'event_code', f.event_code,
             'title_ar', f.title_ar,
             'title_en', f.title_en,
             'body_ar', f.body_ar,
             'body_en', f.body_en,
             'payload', f.payload,
             'link_path', f.link_path,
             'state', f.state,
             'is_pinned', f.is_pinned,
             'read_on', f.read_on,
             'archived_on', f.archived_on,
             'expires_on', f.expires_on,
             'created_on', f.created_on
           )
           order by f.is_pinned desc, f.created_on desc
         ), '[]'::jsonb)
  into v_result
  from (
    select n.*
    from public.notifications n
    where n.tenant_id = public.current_tenant_id()
      and n.recipient_id = auth.uid()
      and not n.is_deleted
      and (n.expires_on is null or n.expires_on > now())
      and case v_state
            when 'All' then n.state <> 'Deleted'
            when 'Pinned' then n.is_pinned and n.state <> 'Deleted'
            else n.state = v_state
          end
    order by n.is_pinned desc, n.created_on desc
    limit v_limit
  ) f;

  return v_result;
end;
$$;
revoke all on function public.notification_feed(text, int) from public;
grant execute on function public.notification_feed(text, int) to authenticated;

-- p_ids null means "every notification I have" (mark all as read); an empty
-- array deliberately touches nothing, so a stale selection cannot wipe a feed.
create or replace function public.notification_mark(p_ids uuid[], p_state text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  if p_state is null or p_state not in ('Unread', 'Read', 'Archived', 'Deleted') then
    raise exception 'INVALID_NOTIFICATION_STATE';
  end if;

  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  update public.notifications n
  set state = p_state,
      read_on = case
                  when p_state = 'Unread' then null
                  else coalesce(n.read_on, now())
                end,
      archived_on = case
                      when p_state = 'Archived' then coalesce(n.archived_on, now())
                      else null
                    end
  where n.tenant_id = public.current_tenant_id()
    and n.recipient_id = auth.uid()
    and not n.is_deleted
    and n.state is distinct from p_state
    and (p_ids is null or n.id = any (p_ids));

  get diagnostics v_count = row_count;
  return jsonb_build_object('updated', v_count, 'state', p_state);
end;
$$;
revoke all on function public.notification_mark(uuid[], text) from public;
grant execute on function public.notification_mark(uuid[], text) to authenticated;

create or replace function public.notification_pin(p_id uuid, p_pinned boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  if p_id is null then
    raise exception 'NOTIFICATION_NOT_FOUND';
  end if;

  update public.notifications n
  set is_pinned = coalesce(p_pinned, false)
  where n.id = p_id
    and n.tenant_id = public.current_tenant_id()
    and n.recipient_id = auth.uid()
    and not n.is_deleted;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'NOTIFICATION_NOT_FOUND';
  end if;

  return jsonb_build_object('id', p_id, 'is_pinned', coalesce(p_pinned, false));
end;
$$;
revoke all on function public.notification_pin(uuid, boolean) from public;
grant execute on function public.notification_pin(uuid, boolean) to authenticated;

-- Feeds the bell badge and the per-tab counters in one round trip.
create or replace function public.notification_counts()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select n.state, n.category, n.is_pinned
    from public.notifications n
    where n.tenant_id = public.current_tenant_id()
      and n.recipient_id = auth.uid()
      and not n.is_deleted
      and (n.expires_on is null or n.expires_on > now())
  )
  select jsonb_build_object(
    'total', (select count(*) from mine where state <> 'Deleted'),
    'unread', (select count(*) from mine where state = 'Unread'),
    'read', (select count(*) from mine where state = 'Read'),
    'archived', (select count(*) from mine where state = 'Archived'),
    'deleted', (select count(*) from mine where state = 'Deleted'),
    'pinned', (select count(*) from mine where is_pinned and state <> 'Deleted'),
    'by_state', coalesce((
      select jsonb_object_agg(s.state, s.c)
      from (select state, count(*) as c from mine group by state) s
    ), '{}'::jsonb),
    'by_category', coalesce((
      select jsonb_object_agg(c.category, c.c)
      from (select category, count(*) as c from mine where state <> 'Deleted' group by category) c
    ), '{}'::jsonb),
    'unread_by_category', coalesce((
      select jsonb_object_agg(c.category, c.c)
      from (select category, count(*) as c from mine where state = 'Unread' group by category) c
    ), '{}'::jsonb)
  );
$$;
revoke all on function public.notification_counts() from public;
grant execute on function public.notification_counts() to authenticated;

-- The settings screen needs the six switches whether or not a row exists yet.
create or replace function public.notification_preferences_list()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'category', c.category,
             'in_app', coalesce(np.in_app, true),
             'email', coalesce(np.email, false)
           ) order by c.display_order
         ), '[]'::jsonb)
  from (values
    ('Message', 10), ('Circular', 20), ('Announcement', 30),
    ('Survey', 40), ('Approval', 50), ('Event', 60)
  ) as c(category, display_order)
  left join public.notification_preferences np
    on np.category = c.category
   and np.user_id = auth.uid()
   and np.tenant_id = public.current_tenant_id()
   and not np.is_deleted;
$$;
revoke all on function public.notification_preferences_list() from public;
grant execute on function public.notification_preferences_list() to authenticated;

-- p_preferences: [{ "category": "Message", "in_app": true, "email": false }, ...]
create or replace function public.notification_preferences_save(p_preferences jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  if v_tenant is null then
    raise exception 'TENANT_NOT_RESOLVED';
  end if;
  if p_preferences is null or jsonb_typeof(p_preferences) <> 'array' then
    raise exception 'INVALID_PREFERENCES_PAYLOAD';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_preferences) e
    where coalesce(e ->> 'category', '') not in
      ('Message', 'Circular', 'Announcement', 'Survey', 'Approval', 'Event')
  ) then
    raise exception 'INVALID_NOTIFICATION_CATEGORY';
  end if;

  -- distinct on: a payload that repeats a category would otherwise make
  -- ON CONFLICT touch the same row twice in one statement.
  insert into public.notification_preferences (tenant_id, user_id, category, in_app, email)
  select v_tenant, v_user, p.category, p.in_app, p.email
  from (
    select distinct on (a.e ->> 'category')
           a.e ->> 'category' as category,
           coalesce((a.e ->> 'in_app')::boolean, true) as in_app,
           coalesce((a.e ->> 'email')::boolean, false) as email
    from jsonb_array_elements(p_preferences) with ordinality as a(e, ord)
    order by a.e ->> 'category', a.ord desc
  ) p
  on conflict (tenant_id, user_id, category) do update set
    in_app = excluded.in_app,
    email = excluded.email,
    is_deleted = false;

  return public.notification_preferences_list();
end;
$$;
revoke all on function public.notification_preferences_save(jsonb) from public;
grant execute on function public.notification_preferences_save(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Producers: the two events that already exist in the product
-- ----------------------------------------------------------------------------

-- A circular reaches the people the audience engine says it reaches. The
-- engine ships in its own migration, so the call is resolved at run time and
-- falls back to the publication-level ranking when it is not installed yet.
create or replace function public.notify_circular_published()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_recipients uuid[];
  v_required smallint;
  v_count integer;
begin
  if to_regprocedure('public.audience_matches(text,uuid,uuid)') is not null then
    execute
      'select coalesce(array_agg(u.id), ''{}''::uuid[])
         from public.users u
        where u.tenant_id = $1
          and u.is_active
          and not u.is_deleted
          and public.audience_matches($2, $3, u.id)'
      into v_recipients
      using new.tenant_id, 'Circular', new.id;
  else
    v_required := case new.publication_level
      when 'PUBLIC' then 1
      when 'ADMINISTRATIVE' then 2
      when 'MANAGER_RESTRICTED' then 3
      when 'PRIVATE_RESTRICTED' then 4
      else 99
    end;

    select coalesce(array_agg(u.id), '{}'::uuid[])
    into v_recipients
    from public.users u
    where u.tenant_id = new.tenant_id
      and u.is_active
      and not u.is_deleted
      and coalesce((
        select max(case r.code
          when 'PLATFORM_OPERATOR' then 4
          when 'PLATFORM_ADMIN' then 4
          when 'SYSTEM_ADMIN' then 4
          when 'DEPARTMENT_MANAGER' then 3
          when 'DEPARTMENT_COORDINATOR' then 2
          when 'EMPLOYEE' then 1
          else 0
        end)
        from public.user_roles ur
        join public.roles r on r.id = ur.role_id
        where ur.user_id = u.id
          and r.tenant_id = u.tenant_id
          and r.is_active
          and not r.is_deleted
      ), 0) >= v_required;
  end if;

  if v_recipients is null or cardinality(v_recipients) = 0 then
    return new;
  end if;

  v_count := public.notify_many(
    v_recipients,
    'Circular',
    'Circular.Published',
    'تعميم جديد: ' || new.title_ar,
    'New circular: ' || coalesce(new.title_en, new.title_ar),
    new.description_ar,
    coalesce(new.description_en, new.description),
    '/app/circulars?item=' || new.id::text,
    jsonb_build_object(
      'content_item_id', new.id,
      'code', new.code,
      'content_type', new.content_type,
      'priority', new.priority,
      'publication_level', new.publication_level,
      'requires_acknowledgement', new.requires_acknowledgement
    ),
    new.expiry_date
  );

  return new;
end;
$fn$;

-- Two triggers rather than one, because a WHEN clause may not mention OLD on
-- insert. Both are gated in the WHEN clause so an ordinary content edit never
-- enters the function at all.
drop trigger if exists notify_circular_published_insert on public.content_items;
create trigger notify_circular_published_insert
after insert on public.content_items
for each row
when (new.is_published and not new.is_deleted and new.content_type = 'Circular')
execute function public.notify_circular_published();

drop trigger if exists notify_circular_published_update on public.content_items;
create trigger notify_circular_published_update
after update on public.content_items
for each row
when (new.is_published and not old.is_published and not new.is_deleted and new.content_type = 'Circular')
execute function public.notify_circular_published();

-- The approval ledger is append-only, so "a request landed on your desk" is
-- exactly one row: the transaction that names the next assignee.
create or replace function public.notify_approval_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_reference text;
  v_name_ar text;
  v_name_en text;
  v_title_ar text;
  v_title_en text;
begin
  if new.to_user_id is null or new.to_user_id = new.actor_id then
    return new;
  end if;

  select f.reference_no,
         coalesce(t.name_ar, t.name),
         coalesce(t.name_en, t.name_ar, t.name)
  into v_reference, v_name_ar, v_name_en
  from public.forms f
  join public.templates t on t.id = f.template_id
  where f.id = new.form_id;

  select
    case new.action
      when 'Submit' then 'طلب جديد بانتظار موافقتك'
      when 'Forward' then 'تمت إحالة طلب إليك'
      when 'Delegate' then 'تم تفويضك بطلب'
      when 'RequestReview' then 'طلب بانتظار مراجعتك'
      when 'Reassign' then 'تم تحويل طلب إليك'
    end,
    case new.action
      when 'Submit' then 'A new request is waiting for your approval'
      when 'Forward' then 'A request was forwarded to you'
      when 'Delegate' then 'A request was delegated to you'
      when 'RequestReview' then 'A request is waiting for your review'
      when 'Reassign' then 'A request was reassigned to you'
    end
  into v_title_ar, v_title_en;

  perform public.notify(
    new.to_user_id,
    'Approval',
    'Approval.' || new.action,
    v_title_ar,
    v_title_en,
    concat_ws(' — ', coalesce(v_name_ar, 'طلب'), v_reference, new.actor_name),
    concat_ws(' — ', coalesce(v_name_en, 'Request'), v_reference, new.actor_name),
    '/app/approvals?form=' || new.form_id::text,
    jsonb_build_object(
      'form_id', new.form_id,
      'transaction_id', new.id,
      'action', new.action,
      'reference_no', v_reference,
      'actor_name', new.actor_name,
      'comment', new.comment
    )
  );

  return new;
end;
$fn$;

drop trigger if exists notify_approval_assignment on public.form_approval_transactions;
create trigger notify_approval_assignment
after insert on public.form_approval_transactions
for each row
when (new.action in ('Submit', 'Forward', 'Delegate', 'RequestReview', 'Reassign'))
execute function public.notify_approval_assignment();

-- ----------------------------------------------------------------------------
-- 6. Workspace: the widget catalogue
--    A platform catalogue like platform_modules — it has no tenant_id, it is
--    the shared vocabulary every company's home page is assembled from.
-- ----------------------------------------------------------------------------

create table if not exists public.dashboard_widgets (
  code text primary key,
  name_ar text not null,
  name_en text,
  description_ar text,
  description_en text,
  module_code text references public.platform_modules(code) on delete set null,
  icon text,
  default_order integer not null default 0,
  default_width text not null default 'Half'
    check (default_width in ('Full', 'Half', 'Third', 'Quarter')),
  default_visible boolean not null default true,
  min_role_rank smallint not null default 1,
  is_active boolean not null default true,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_dashboard_widgets_order
  on public.dashboard_widgets (default_order) where is_active;

alter table public.dashboard_widgets enable row level security;

drop policy if exists "authenticated read widget catalogue" on public.dashboard_widgets;
create policy "authenticated read widget catalogue" on public.dashboard_widgets
  for select to authenticated using (true);

drop policy if exists "platform operators manage widget catalogue" on public.dashboard_widgets;
create policy "platform operators manage widget catalogue" on public.dashboard_widgets
  for all to authenticated
  using (public.is_platform_operator())
  with check (public.is_platform_operator());

insert into public.dashboard_widgets
  (code, name_ar, name_en, description_ar, description_en, module_code, icon, default_order, default_width, default_visible)
values
  ('WELCOME', 'الترحيب', 'Welcome',
   'بطاقة ترحيب باسم الموظف ووقت اليوم', 'Greeting card with the employee name and the time of day',
   'EMPLOYEE_PORTAL', 'sun', 10, 'Full', true),
  ('QUICK_ACTIONS', 'إجراءات سريعة', 'Quick Actions',
   'اختصارات لأكثر الإجراءات استخداماً', 'Shortcuts to the most used actions',
   'EMPLOYEE_PORTAL', 'zap', 20, 'Full', true),
  ('MY_REQUESTS', 'طلباتي', 'My Requests',
   'آخر الطلبات التي قدمتها وحالتها', 'Your latest requests and their status',
   'FORMS', 'file-text', 30, 'Half', true),
  ('APPROVAL_INBOX', 'وارد الموافقات', 'Approval Inbox',
   'الطلبات التي تنتظر إجراءك', 'Requests waiting for your action',
   'APPROVALS', 'inbox', 40, 'Half', true),
  ('ANNOUNCEMENTS', 'الإعلانات', 'Announcements',
   'آخر إعلانات الشركة', 'The latest company announcements',
   'ANNOUNCEMENTS', 'megaphone', 50, 'Half', true),
  ('SURVEY', 'الاستطلاعات', 'Surveys',
   'الاستطلاعات المفتوحة التي تنتظر رأيك', 'Open surveys waiting for your opinion',
   'SURVEY', 'clipboard-list', 60, 'Half', true),
  ('CALENDAR', 'التقويم', 'Calendar',
   'المناسبات والفعاليات القادمة', 'Upcoming events and occasions',
   'CALENDAR', 'calendar', 70, 'Half', true),
  ('NOTES', 'المفكرة', 'Notes',
   'ملاحظاتك الشخصية السريعة', 'Your quick personal notes',
   'NOTES', 'sticky-note', 80, 'Half', true),
  ('DOCUMENTS', 'الوثائق', 'Documents',
   'أحدث الوثائق المنشورة', 'The most recently published documents',
   'DOCUMENTS', 'folder', 90, 'Half', true),
  ('CIRCULARS', 'التعاميم', 'Circulars',
   'أحدث التعاميم الصادرة', 'The most recent circulars',
   'DOCUMENTS', 'scroll-text', 100, 'Half', true),
  ('DESIGNS', 'التصاميم', 'Designs',
   'مكتبة الهوية والتصاميم', 'The identity and design library',
   'DOCUMENTS', 'image', 110, 'Half', false),
  ('ORG_CHART', 'الهيكل التنظيمي', 'Organization Chart',
   'شجرة الإدارات وفرق العمل', 'The department and team tree',
   'EMPLOYEE_PORTAL', 'network', 120, 'Half', false),
  ('PERFORMANCE', 'الأداء', 'Performance',
   'ملخص تقييم الأداء ودورته الحالية', 'Your evaluation summary and current cycle',
   'PERFORMANCE', 'trending-up', 130, 'Half', false),
  ('TIP', 'نصيحة اليوم', 'Tip of the Day',
   'نصيحة قصيرة لاستخدام أفضل للبوابة', 'A short tip for getting more out of the portal',
   'EMPLOYEE_PORTAL', 'lightbulb', 140, 'Third', true)
on conflict (code) do update set
  name_ar = excluded.name_ar,
  name_en = excluded.name_en,
  description_ar = excluded.description_ar,
  description_en = excluded.description_en,
  module_code = excluded.module_code,
  icon = excluded.icon,
  default_order = excluded.default_order,
  default_width = excluded.default_width,
  updated_on = now();

-- ----------------------------------------------------------------------------
-- 7. Workspace: what the employee did to their own home page
-- ----------------------------------------------------------------------------

create table if not exists public.user_widget_preferences (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  widget_code text not null references public.dashboard_widgets(code) on delete cascade,
  is_visible boolean not null default true,
  display_order integer not null default 0,
  width text not null default 'Half' check (width in ('Full', 'Half', 'Third', 'Quarter')),
  is_collapsed boolean not null default false,
  is_pinned boolean not null default false,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  primary key (tenant_id, user_id, widget_code)
);

create index if not exists idx_user_widget_preferences_tenant
  on public.user_widget_preferences (tenant_id);

create index if not exists idx_user_widget_preferences_user
  on public.user_widget_preferences (tenant_id, user_id, display_order)
  where not is_deleted;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_user_widget_preferences_user_same_tenant') then
    alter table public.user_widget_preferences
      add constraint fk_user_widget_preferences_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id) on delete cascade;
  end if;
end $$;

drop trigger if exists apply_row_defaults on public.user_widget_preferences;
create trigger apply_row_defaults before insert or update on public.user_widget_preferences
for each row execute function public.apply_row_defaults();

alter table public.user_widget_preferences enable row level security;

drop policy if exists "tenant isolation" on public.user_widget_preferences;
create policy "tenant isolation" on public.user_widget_preferences
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "users manage own widget layout" on public.user_widget_preferences;
create policy "users manage own widget layout" on public.user_widget_preferences
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 8. Workspace: the personal preference level
--    Platform settings → tenant settings → this. Language and theme mirror the
--    legacy public.users columns so nothing that reads them today breaks.
-- ----------------------------------------------------------------------------

create table if not exists public.user_preferences (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  language_code text,
  theme text not null default 'system' check (theme in ('light', 'dark', 'system')),
  chat_presence text not null default 'Online'
    check (chat_presence in ('Online', 'Away', 'Busy', 'Offline')),
  chat_presence_manual boolean not null default false,
  last_seen_on timestamptz,
  signature_text text,
  timezone text,
  settings_json jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index if not exists idx_user_preferences_tenant
  on public.user_preferences (tenant_id);

-- The chat roster reads presence for a whole company at once.
create index if not exists idx_user_preferences_presence
  on public.user_preferences (tenant_id, chat_presence, last_seen_on desc)
  where not is_deleted;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_user_preferences_user_same_tenant') then
    alter table public.user_preferences
      add constraint fk_user_preferences_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id) on delete cascade;
  end if;
end $$;

drop trigger if exists apply_row_defaults on public.user_preferences;
create trigger apply_row_defaults before insert or update on public.user_preferences
for each row execute function public.apply_row_defaults();

alter table public.user_preferences enable row level security;

drop policy if exists "tenant isolation" on public.user_preferences;
create policy "tenant isolation" on public.user_preferences
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "users manage own preferences" on public.user_preferences;
create policy "users manage own preferences" on public.user_preferences
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No colleague-wide select policy: RLS is row level, and the row also holds a
-- personal signature and a settings blob. Presence is published through the
-- RPC below, which returns those two columns and nothing else.
create or replace function public.tenant_presence(p_user_ids uuid[] default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', p.user_id,
    'chat_presence', p.chat_presence,
    'last_seen_on', p.last_seen_on
  )), '[]'::jsonb)
  from public.user_preferences p
  where p.tenant_id = public.current_tenant_id()
    and not p.is_deleted
    and (p_user_ids is null or p.user_id = any (p_user_ids));
$$;
revoke all on function public.tenant_presence(uuid[]) from public;
grant execute on function public.tenant_presence(uuid[]) to authenticated;

create or replace function public.user_preferences_get()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'tenant_id', public.current_tenant_id(),
    'language_code', coalesce(p.language_code, u.preferred_language, t.default_language, 'ar'),
    'theme', coalesce(p.theme, u.theme, 'system'),
    'chat_presence', coalesce(p.chat_presence, 'Online'),
    'chat_presence_manual', coalesce(p.chat_presence_manual, false),
    'last_seen_on', p.last_seen_on,
    'signature_text', p.signature_text,
    'timezone', coalesce(p.timezone, t.timezone),
    'settings_json', coalesce(p.settings_json, '{}'::jsonb)
  )
  from public.users u
  left join public.tenants t on t.id = coalesce(u.active_tenant_id, u.tenant_id)
  left join public.user_preferences p
    on p.user_id = u.id and p.tenant_id = coalesce(u.active_tenant_id, u.tenant_id) and not p.is_deleted
  where u.id = auth.uid();
$$;
revoke all on function public.user_preferences_get() from public;
grant execute on function public.user_preferences_get() to authenticated;

-- Partial update: only the keys present in p_patch are touched.
create or replace function public.user_preferences_save(p_patch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_theme text;
  v_presence text;
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  if v_tenant is null then
    raise exception 'TENANT_NOT_RESOLVED';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'INVALID_PREFERENCES_PAYLOAD';
  end if;

  v_theme := nullif(p_patch ->> 'theme', '');
  if v_theme is not null and v_theme not in ('light', 'dark', 'system') then
    raise exception 'INVALID_THEME';
  end if;

  v_presence := nullif(p_patch ->> 'chat_presence', '');
  if v_presence is not null and v_presence not in ('Online', 'Away', 'Busy', 'Offline') then
    raise exception 'INVALID_CHAT_PRESENCE';
  end if;

  insert into public.user_preferences as up (
    tenant_id, user_id, language_code, theme, chat_presence, chat_presence_manual,
    signature_text, timezone, settings_json
  )
  values (
    v_tenant, v_user,
    nullif(p_patch ->> 'language_code', ''),
    coalesce(v_theme, 'system'),
    coalesce(v_presence, 'Online'),
    coalesce((p_patch ->> 'chat_presence_manual')::boolean, false),
    p_patch ->> 'signature_text',
    nullif(p_patch ->> 'timezone', ''),
    coalesce(p_patch -> 'settings_json', '{}'::jsonb)
  )
  on conflict (tenant_id, user_id) do update set
    language_code = case when p_patch ? 'language_code' then nullif(p_patch ->> 'language_code', '') else up.language_code end,
    theme = coalesce(v_theme, up.theme),
    chat_presence = coalesce(v_presence, up.chat_presence),
    chat_presence_manual = case when p_patch ? 'chat_presence_manual'
                                then coalesce((p_patch ->> 'chat_presence_manual')::boolean, false)
                                else up.chat_presence_manual end,
    signature_text = case when p_patch ? 'signature_text' then p_patch ->> 'signature_text' else up.signature_text end,
    timezone = case when p_patch ? 'timezone' then nullif(p_patch ->> 'timezone', '') else up.timezone end,
    settings_json = case when p_patch ? 'settings_json'
                         then coalesce(p_patch -> 'settings_json', '{}'::jsonb)
                         else up.settings_json end,
    is_deleted = false;

  -- Keep the legacy columns the shell still reads in step, without writing an
  -- audit row for a value that did not actually change.
  update public.users u
  set preferred_language = coalesce(nullif(p_patch ->> 'language_code', ''), u.preferred_language),
      theme = coalesce(v_theme, u.theme),
      updated_on = now()
  where u.id = v_user
    and (
      (p_patch ? 'language_code' and u.preferred_language is distinct from nullif(p_patch ->> 'language_code', ''))
      or (v_theme is not null and u.theme is distinct from v_theme)
    );

  return public.user_preferences_get();
end;
$$;
revoke all on function public.user_preferences_save(jsonb) from public;
grant execute on function public.user_preferences_save(jsonb) to authenticated;

-- Chat status and "last seen": cheap enough to call on a heartbeat.
create or replace function public.user_presence_set(p_presence text, p_manual boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  if v_tenant is null then
    raise exception 'TENANT_NOT_RESOLVED';
  end if;
  if p_presence is null or p_presence not in ('Online', 'Away', 'Busy', 'Offline') then
    raise exception 'INVALID_CHAT_PRESENCE';
  end if;

  insert into public.user_preferences as up (tenant_id, user_id, chat_presence, chat_presence_manual, last_seen_on)
  values (v_tenant, v_user, p_presence, coalesce(p_manual, true), now())
  on conflict (tenant_id, user_id) do update set
    chat_presence = excluded.chat_presence,
    chat_presence_manual = excluded.chat_presence_manual,
    last_seen_on = now(),
    is_deleted = false;

  return jsonb_build_object('chat_presence', p_presence, 'last_seen_on', now());
end;
$$;
revoke all on function public.user_presence_set(text, boolean) from public;
grant execute on function public.user_presence_set(text, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- 9. Workspace read/write model
-- ----------------------------------------------------------------------------

-- The catalogue with the caller's overrides folded in. Widgets belonging to a
-- switched-off module disappear entirely — a disabled module must not leave a
-- hole on the home page. min_role_rank is floored at 1 so a user whose roles
-- are still being provisioned never lands on an empty dashboard.
create or replace function public.workspace_layout()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'code', w.code,
             'name_ar', w.name_ar,
             'name_en', w.name_en,
             'description_ar', w.description_ar,
             'description_en', w.description_en,
             'module_code', w.module_code,
             'icon', w.icon,
             'is_visible', coalesce(p.is_visible, w.default_visible),
             'display_order', coalesce(p.display_order, w.default_order),
             'width', coalesce(p.width, w.default_width),
             'is_collapsed', coalesce(p.is_collapsed, false),
             'is_pinned', coalesce(p.is_pinned, false),
             'is_customized', p.widget_code is not null
           )
           order by coalesce(p.display_order, w.default_order), w.code
         ), '[]'::jsonb)
  from public.dashboard_widgets w
  left join public.user_widget_preferences p
    on p.widget_code = w.code
   and p.user_id = auth.uid()
   and p.tenant_id = public.current_tenant_id()
   and not p.is_deleted
  where w.is_active
    and (w.module_code is null or public.tenant_has_module(w.module_code))
    and w.min_role_rank <= greatest(public.current_content_access_rank(), 1);
$$;
revoke all on function public.workspace_layout() from public;
grant execute on function public.workspace_layout() to authenticated;

-- p_layout: the whole board after a drag & drop, as
-- [{ "code": "MY_REQUESTS", "is_visible": true, "display_order": 30,
--    "width": "Half", "is_collapsed": false, "is_pinned": false }, ...]
-- Unknown or inactive codes are ignored so an old browser tab cannot resurrect
-- a retired widget.
create or replace function public.workspace_layout_save(p_layout jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  if v_tenant is null then
    raise exception 'TENANT_NOT_RESOLVED';
  end if;
  if p_layout is null or jsonb_typeof(p_layout) <> 'array' then
    raise exception 'INVALID_LAYOUT_PAYLOAD';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_layout) e
    where e ? 'width' and coalesce(e ->> 'width', '') not in ('Full', 'Half', 'Third', 'Quarter')
  ) then
    raise exception 'INVALID_WIDGET_WIDTH';
  end if;

  -- distinct on: the same widget sent twice must not make ON CONFLICT touch
  -- one row twice in a single statement; the last entry wins.
  insert into public.user_widget_preferences (
    tenant_id, user_id, widget_code, is_visible, display_order, width, is_collapsed, is_pinned
  )
  select v_tenant, v_user, x.code, x.is_visible, x.display_order, x.width, x.is_collapsed, x.is_pinned
  from (
    select distinct on (w.code)
      w.code as code,
      coalesce((a.e ->> 'is_visible')::boolean, w.default_visible) as is_visible,
      coalesce((a.e ->> 'display_order')::integer, w.default_order) as display_order,
      coalesce(nullif(a.e ->> 'width', ''), w.default_width) as width,
      coalesce((a.e ->> 'is_collapsed')::boolean, false) as is_collapsed,
      coalesce((a.e ->> 'is_pinned')::boolean, false) as is_pinned
    from jsonb_array_elements(p_layout) with ordinality as a(e, ord)
    join public.dashboard_widgets w on w.code = a.e ->> 'code' and w.is_active
    order by w.code, a.ord desc
  ) x
  on conflict (tenant_id, user_id, widget_code) do update set
    is_visible = excluded.is_visible,
    display_order = excluded.display_order,
    width = excluded.width,
    is_collapsed = excluded.is_collapsed,
    is_pinned = excluded.is_pinned,
    is_deleted = false;

  return public.workspace_layout();
end;
$$;
revoke all on function public.workspace_layout_save(jsonb) from public;
grant execute on function public.workspace_layout_save(jsonb) to authenticated;

-- "Put it back the way it was": drop the overrides, keep the catalogue.
create or replace function public.workspace_layout_reset()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  if v_tenant is null then
    raise exception 'TENANT_NOT_RESOLVED';
  end if;

  delete from public.user_widget_preferences
  where tenant_id = v_tenant and user_id = v_user;

  return public.workspace_layout();
end;
$$;
revoke all on function public.workspace_layout_reset() from public;
grant execute on function public.workspace_layout_reset() to authenticated;
