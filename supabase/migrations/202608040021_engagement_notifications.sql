-- ============================================================================
-- 021 — Wire the engagement modules into the notification centre
--
-- Migration 015 raises a notification when a circular is published and when a
-- request lands in somebody's approval inbox. The rest of what the plan asks
-- for — an announcement is published, a survey opens, an event falls due —
-- belongs to the engagement modules created in 014, so it is wired here, once
-- both sides exist.
--
-- Fan-out always goes through the audience engine: a notification reaches
-- exactly the people who can see the record, never the whole company by
-- default.
-- ============================================================================

-- Everybody in the company who may see one targeted record.
create or replace function public.audience_recipients(p_entity_type text, p_entity_id uuid, p_tenant_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(u.id), '{}'::uuid[])
  from public.users u
  where u.tenant_id = p_tenant_id
    and u.is_active
    and not u.is_deleted
    and public.audience_matches(p_entity_type, p_entity_id, u.id);
$$;

revoke all on function public.audience_recipients(text, uuid, uuid) from public;
grant execute on function public.audience_recipients(text, uuid, uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Announcements
-- ----------------------------------------------------------------------------

create or replace function public.notify_announcement_published()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipients uuid[];
begin
  -- Only the moment of publication, and only inside the publishing window.
  if not new.is_published or coalesce(new.is_deleted, false) then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.is_published and not coalesce(old.is_deleted, false) then
    return new;
  end if;
  if new.publish_from is not null and new.publish_from > now() then
    return new;
  end if;
  if new.publish_to is not null and new.publish_to < now() then
    return new;
  end if;

  v_recipients := public.audience_recipients('Announcement', new.id, new.tenant_id);
  if cardinality(v_recipients) = 0 then
    return new;
  end if;

  perform public.notify_many(
    v_recipients,
    'Announcement',
    'AnnouncementPublished',
    new.title_ar,
    coalesce(new.title_en, new.title_ar),
    coalesce(new.excerpt_ar, left(coalesce(new.body_ar, ''), 160)),
    coalesce(new.excerpt_en, new.excerpt_ar, left(coalesce(new.body_en, new.body_ar, ''), 160)),
    'app?announcement=' || new.id::text,
    jsonb_build_object('announcement_id', new.id, 'priority', new.priority),
    new.publish_to
  );

  return new;
end;
$$;

drop trigger if exists notify_announcement_published on public.announcements;
create trigger notify_announcement_published
after insert or update of is_published, publish_from, publish_to on public.announcements
for each row execute function public.notify_announcement_published();

-- ----------------------------------------------------------------------------
-- Surveys
-- ----------------------------------------------------------------------------

create or replace function public.notify_survey_published()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipients uuid[];
begin
  if not new.is_published or coalesce(new.is_deleted, false) then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.is_published and not coalesce(old.is_deleted, false) then
    return new;
  end if;
  if new.starts_on is not null and new.starts_on > now() then
    return new;
  end if;
  if new.ends_on is not null and new.ends_on < now() then
    return new;
  end if;

  v_recipients := public.audience_recipients('Survey', new.id, new.tenant_id);
  if cardinality(v_recipients) = 0 then
    return new;
  end if;

  perform public.notify_many(
    v_recipients,
    'Survey',
    'SurveyOpened',
    new.title_ar,
    coalesce(new.title_en, new.title_ar),
    new.question_ar,
    coalesce(new.question_en, new.question_ar),
    'app?survey=' || new.id::text,
    jsonb_build_object('survey_id', new.id),
    new.ends_on
  );

  return new;
end;
$$;

drop trigger if exists notify_survey_published on public.surveys;
create trigger notify_survey_published
after insert or update of is_published, starts_on, ends_on on public.surveys
for each row execute function public.notify_survey_published();

-- ----------------------------------------------------------------------------
-- Calendar reminders
--
-- An event cannot notify itself when its time arrives, so a worker sweeps the
-- due ones. reminder_sent_on makes the sweep idempotent: a reminder is raised
-- exactly once however often the job runs.
-- ----------------------------------------------------------------------------

create or replace function public.calendar_due_reminders(p_horizon_minutes integer default 5)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_event record;
  v_recipients uuid[];
  v_count integer := 0;
begin
  for v_event in
    select e.*
    from public.calendar_events e
    where not e.is_deleted
      and e.reminder_sent_on is null
      and e.starts_at is not null
      and e.starts_at - make_interval(mins => coalesce(e.remind_before_minutes, 0))
            <= now() + make_interval(mins => greatest(p_horizon_minutes, 0))
      and e.starts_at >= now() - interval '1 day'
    order by e.starts_at
    limit 500
  loop
    if v_event.scope = 'Personal' then
      v_recipients := case when v_event.owner_id is null then '{}'::uuid[] else array[v_event.owner_id] end;
    else
      v_recipients := public.audience_recipients('CalendarEvent', v_event.id, v_event.tenant_id);
    end if;

    if cardinality(v_recipients) > 0 then
      perform public.notify_many(
        v_recipients,
        'Event',
        'EventDue',
        v_event.title_ar,
        coalesce(v_event.title_en, v_event.title_ar),
        coalesce(v_event.description, ''),
        coalesce(v_event.description, ''),
        'app/calendar?event=' || v_event.id::text,
        jsonb_build_object(
          'event_id', v_event.id,
          'event_type', v_event.event_type,
          'starts_at', v_event.starts_at,
          'is_mandatory', v_event.is_mandatory
        ),
        v_event.starts_at + interval '2 days'
      );
      v_count := v_count + 1;
    end if;

    update public.calendar_events
    set reminder_sent_on = now()
    where id = v_event.id;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.calendar_due_reminders(integer) from public;
grant execute on function public.calendar_due_reminders(integer) to service_role;

comment on function public.calendar_due_reminders(integer) is
  'Raises Event notifications for calendar entries falling due. Schedule every five minutes.';
