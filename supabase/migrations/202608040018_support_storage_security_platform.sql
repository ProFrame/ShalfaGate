-- ============================================================================
-- 018 — Support desk, storage abstraction, security policy and the platform
--       operator console
--
-- Four concerns that all belong to the operator side of the product:
--   * support tickets raised from the public product site (anonymous) and from
--     inside a company (System Administrator only), answered from one console
--   * the storage abstraction: the platform never talks to a vendor, it records
--     providers, per-company configuration and one object ledger, and refuses an
--     upload before it happens instead of failing half way through
--   * the security surface the admin screens read (login attempts, devices,
--     security events) — the policy values themselves already live in
--     tenant_settings
--   * the platform console: overview, company card, module/quota/license
--     switches, health and the daily usage rollup
--
-- Everything the operator reads crosses company boundaries, so it is served by
-- SECURITY DEFINER functions guarded by is_platform_operator(); the tables
-- themselves keep the ordinary RESTRICTIVE tenant isolation of migration 012.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Permissions introduced by this migration
-- ----------------------------------------------------------------------------

insert into public.permissions (code, module, description) values
  ('Support.View', 'Support', 'Read support tickets of the company'),
  ('Storage.Manage', 'Storage', 'Connect a storage provider and manage company files'),
  ('Security.View', 'Security', 'Read login attempts, devices and security events')
on conflict (code) do nothing;

insert into public.role_permissions (tenant_id, role_id, permission_id)
select r.tenant_id, r.id, p.id
from public.roles r
join public.permissions p
  on p.code in ('Support.View', 'Storage.Manage', 'Security.View')
where r.code in ('PLATFORM_ADMIN', 'SYSTEM_ADMIN') and not r.is_deleted
on conflict do nothing;

-- The operator role carries every permission; new codes have to be added to it
-- explicitly because migration 012 granted the set that existed back then.
insert into public.role_permissions (tenant_id, role_id, permission_id)
select r.tenant_id, r.id, p.id
from public.roles r
join public.tenants t on t.id = r.tenant_id and t.is_platform
join public.permissions p on true
where r.code = 'PLATFORM_OPERATOR' and not r.is_deleted
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- 2. Small shared helpers (012 does not provide these)
-- ----------------------------------------------------------------------------

-- The operator workspace. Public tickets and unresolved login attempts belong
-- to it, because a row must always have a company.
create or replace function public.platform_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.tenants where is_platform order by created_on limit 1;
$$;
revoke all on function public.platform_tenant_id() from public;
grant execute on function public.platform_tenant_id() to authenticated, service_role;

-- PostgREST forwards the request headers; anything else (direct SQL, a cron
-- job) simply has no client address.
create or replace function public.request_client_ip()
returns inet
language plpgsql
stable
as $$
declare
  v_raw text;
  v_ip text;
begin
  begin
    v_raw := nullif(current_setting('request.headers', true), '');
  exception when others then
    v_raw := null;
  end;
  if v_raw is null then
    return null;
  end if;
  begin
    v_ip := split_part(
      coalesce(v_raw::jsonb ->> 'x-forwarded-for', v_raw::jsonb ->> 'x-real-ip', ''),
      ',', 1
    );
    return nullif(trim(v_ip), '')::inet;
  exception when others then
    return null;
  end;
end;
$$;
grant execute on function public.request_client_ip() to anon, authenticated;

create or replace function public.request_user_agent()
returns text
language plpgsql
stable
as $$
declare
  v_raw text;
begin
  begin
    v_raw := nullif(current_setting('request.headers', true), '');
  exception when others then
    return null;
  end;
  if v_raw is null then
    return null;
  end if;
  begin
    return left(coalesce(v_raw::jsonb ->> 'user-agent', ''), 400);
  exception when others then
    return null;
  end;
end;
$$;
grant execute on function public.request_user_agent() to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. Support tickets
--
--    tenant_id is the company that owns the conversation: the platform tenant
--    for a ticket raised on the public product site (the company may not exist
--    yet), the company itself for an in-app ticket. requester_tenant_id records
--    which company the person was writing about, when that is known.
-- ----------------------------------------------------------------------------

create sequence if not exists public.support_ticket_no_seq;

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  requester_tenant_id uuid references public.tenants(id) on delete set null,
  ticket_no text not null unique,
  source text not null default 'Public' check (source in ('Public', 'InApp')),
  category text not null default 'Other'
    check (category in ('Technical', 'Billing', 'Feature', 'Account', 'Other')),
  subject text not null,
  body text not null,
  requester_name text not null,
  requester_email citext not null,
  requester_user_id uuid,
  requester_phone text,
  assigned_to uuid references public.users(id),
  status text not null default 'Open'
    check (status in ('Open', 'InProgress', 'Answered', 'Closed')),
  priority text not null default 'Normal'
    check (priority in ('Low', 'Normal', 'High', 'Urgent')),
  -- Returned once, to the anonymous creator, so they can come back to their own
  -- thread. Never exposed by any read RPC.
  access_token text not null default encode(gen_random_bytes(24), 'hex'),
  requester_ip inet,
  user_agent text,
  first_response_on timestamptz,
  closed_on timestamptz,
  closed_by uuid references public.users(id),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_support_tickets_tenant on public.support_tickets (tenant_id);
create index if not exists idx_support_tickets_status
  on public.support_tickets (status, created_on desc) where not is_deleted;
create index if not exists idx_support_tickets_email
  on public.support_tickets (requester_email, created_on desc);
create index if not exists idx_support_tickets_requester
  on public.support_tickets (tenant_id, requester_user_id, created_on desc);
create unique index if not exists uq_support_tickets_tenant_id
  on public.support_tickets (tenant_id, id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_support_tickets_requester_same_tenant') then
    alter table public.support_tickets
      add constraint fk_support_tickets_requester_same_tenant
      foreign key (tenant_id, requester_user_id) references public.users (tenant_id, id);
  end if;
end $$;

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  author_type text not null check (author_type in ('Requester', 'Operator')),
  -- No composite key here on purpose: an operator answering a company ticket
  -- belongs to the platform tenant, not to the tenant of the message.
  author_user_id uuid references public.users(id),
  author_name text,
  body text not null,
  is_internal boolean not null default false,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_support_messages_tenant on public.support_messages (tenant_id);
create index if not exists idx_support_messages_ticket
  on public.support_messages (ticket_id, created_on) where not is_deleted;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_support_messages_ticket_same_tenant') then
    alter table public.support_messages
      add constraint fk_support_messages_ticket_same_tenant
      foreign key (tenant_id, ticket_id) references public.support_tickets (tenant_id, id) on delete cascade;
  end if;
end $$;

drop trigger if exists apply_row_defaults on public.support_tickets;
create trigger apply_row_defaults before insert or update on public.support_tickets
for each row execute function public.apply_row_defaults();

drop trigger if exists apply_row_defaults on public.support_messages;
create trigger apply_row_defaults before insert or update on public.support_messages
for each row execute function public.apply_row_defaults();

alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;

drop policy if exists "tenant isolation" on public.support_tickets;
create policy "tenant isolation" on public.support_tickets
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "tenant isolation" on public.support_messages;
create policy "tenant isolation" on public.support_messages
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "support readers read tickets" on public.support_tickets;
create policy "support readers read tickets" on public.support_tickets
  for select to authenticated
  using (
    requester_user_id = auth.uid()
    or public.has_permission('Support.View')
    or public.has_permission('Support.Manage')
  );

drop policy if exists "support managers manage tickets" on public.support_tickets;
create policy "support managers manage tickets" on public.support_tickets
  for all to authenticated
  using (public.has_permission('Support.Manage'))
  with check (public.has_permission('Support.Manage'));

-- Internal notes are the operator's scratch pad and never leave the console.
drop policy if exists "support readers read messages" on public.support_messages;
create policy "support readers read messages" on public.support_messages
  for select to authenticated
  using (
    not is_internal
    and exists (
      select 1 from public.support_tickets t
      where t.id = support_messages.ticket_id
        and (
          t.requester_user_id = auth.uid()
          or public.has_permission('Support.View')
          or public.has_permission('Support.Manage')
        )
    )
  );

drop policy if exists "support managers manage messages" on public.support_messages;
create policy "support managers manage messages" on public.support_messages
  for all to authenticated
  using (public.has_permission('Support.Manage'))
  with check (public.has_permission('Support.Manage'));

-- The reply notification e-mail. One template per company so a company can
-- rewrite the wording without touching anybody else.
insert into public.email_templates (
  tenant_id, code, version, subject_ar, subject_en, body_html_ar, body_html_en, is_active
)
select
  t.id, 'SUPPORT_REPLY', 1,
  'رد على تذكرة الدعم {{ticket_no}}',
  'Reply to support ticket {{ticket_no}}',
  '<div dir="rtl"><p>مرحباً {{requester_name}}،</p><p>تم الرد على تذكرة الدعم رقم <strong>{{ticket_no}}</strong>.</p><blockquote>{{reply_body}}</blockquote><p>يمكنك متابعة حالة التذكرة عبر الرابط: <a href="{{ticket_url}}">{{ticket_url}}</a></p></div>',
  '<div dir="ltr"><p>Hello {{requester_name}},</p><p>Your support ticket <strong>{{ticket_no}}</strong> has a new reply.</p><blockquote>{{reply_body}}</blockquote><p>You can follow the ticket here: <a href="{{ticket_url}}">{{ticket_url}}</a></p></div>',
  true
from public.tenants t
where not t.is_deleted
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- 4. Support RPCs
-- ----------------------------------------------------------------------------

create or replace function public.support_next_ticket_no()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  candidate text;
begin
  loop
    candidate := 'BBX-' || to_char(now(), 'YYYY') || '-'
                 || lpad(nextval('public.support_ticket_no_seq')::text, 6, '0');
    exit when not exists (select 1 from public.support_tickets where ticket_no = candidate);
  end loop;
  return candidate;
end;
$$;
revoke all on function public.support_next_ticket_no() from public;

-- Anonymous creation from the public product site.
create or replace function public.support_ticket_create(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.platform_tenant_id();
  v_requester_tenant uuid;
  v_email citext;
  v_name text := nullif(trim(coalesce(p_payload ->> 'requester_name', '')), '');
  v_subject text := nullif(trim(coalesce(p_payload ->> 'subject', '')), '');
  v_body text := nullif(trim(coalesce(p_payload ->> 'body', '')), '');
  v_category text := coalesce(nullif(trim(coalesce(p_payload ->> 'category', '')), ''), 'Other');
  v_priority text := coalesce(nullif(trim(coalesce(p_payload ->> 'priority', '')), ''), 'Normal');
  v_ticket public.support_tickets%rowtype;
begin
  if v_tenant is null then
    raise exception 'PLATFORM_TENANT_MISSING';
  end if;

  v_email := lower(trim(coalesce(p_payload ->> 'requester_email', '')));
  if v_name is null then raise exception 'REQUESTER_NAME_REQUIRED'; end if;
  if v_email is null or v_email::text !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'REQUESTER_EMAIL_INVALID';
  end if;
  if v_subject is null then raise exception 'SUBJECT_REQUIRED'; end if;
  if v_body is null then raise exception 'BODY_REQUIRED'; end if;
  if v_category not in ('Technical', 'Billing', 'Feature', 'Account', 'Other') then
    raise exception 'CATEGORY_INVALID';
  end if;
  if v_priority not in ('Low', 'Normal', 'High', 'Urgent') then
    v_priority := 'Normal';
  end if;

  -- The endpoint is open to the world; a single address may not flood it.
  if (
    select count(*) from public.support_tickets
    where requester_email = v_email and created_on > now() - interval '1 hour'
  ) >= 5 then
    raise exception 'TOO_MANY_TICKETS';
  end if;

  select id into v_requester_tenant from public.tenants
  where slug = lower(trim(coalesce(p_payload ->> 'tenant_slug', ''))) and not is_deleted;

  insert into public.support_tickets (
    tenant_id, requester_tenant_id, ticket_no, source, category, subject, body,
    requester_name, requester_email, requester_phone, status, priority,
    requester_ip, user_agent
  )
  values (
    v_tenant, v_requester_tenant, public.support_next_ticket_no(), 'Public', v_category,
    left(v_subject, 300), v_body, left(v_name, 160), v_email,
    nullif(trim(coalesce(p_payload ->> 'requester_phone', '')), ''), 'Open', v_priority,
    public.request_client_ip(), public.request_user_agent()
  )
  returning * into v_ticket;

  insert into public.support_messages (tenant_id, ticket_id, author_type, author_name, body, is_internal)
  values (v_tenant, v_ticket.id, 'Requester', v_ticket.requester_name, v_ticket.body, false);

  return jsonb_build_object(
    'ticket_no', v_ticket.ticket_no,
    'access_token', v_ticket.access_token,
    'status', v_ticket.status,
    'created_on', v_ticket.created_on
  );
end;
$$;
grant execute on function public.support_ticket_create(jsonb) to anon, authenticated;

-- Status lookup from the public header: ticket number plus the address it was
-- raised with, so no secret has to travel by e-mail. Internal notes are never
-- part of the answer. Only tickets raised on the public site are reachable this
-- way: ticket numbers run off one sequence and are therefore guessable, so an
-- in-app conversation must never be readable from an anonymous session.
create or replace function public.support_ticket_status(p_ticket_no text, p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ticket public.support_tickets%rowtype;
begin
  select * into v_ticket from public.support_tickets
  where upper(trim(ticket_no)) = upper(trim(coalesce(p_ticket_no, '')))
    and requester_email = lower(trim(coalesce(p_email, '')))
    and source = 'Public'
    and not is_deleted;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true,
    'ticket_no', v_ticket.ticket_no,
    'status', v_ticket.status,
    'category', v_ticket.category,
    'priority', v_ticket.priority,
    'subject', v_ticket.subject,
    'created_on', v_ticket.created_on,
    'first_response_on', v_ticket.first_response_on,
    'closed_on', v_ticket.closed_on,
    'answered', v_ticket.first_response_on is not null,
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'author_type', m.author_type,
        'author_name', m.author_name,
        'body', m.body,
        'created_on', m.created_on
      ) order by m.created_on)
      from public.support_messages m
      where m.ticket_id = v_ticket.id and not m.is_internal and not m.is_deleted
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.support_ticket_status(text, text) to anon, authenticated;

-- The token issued at creation is what lets an anonymous requester write back.
create or replace function public.support_ticket_reply_public(
  p_ticket_no text,
  p_access_token text,
  p_body text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ticket public.support_tickets%rowtype;
  v_body text := nullif(trim(coalesce(p_body, '')), '');
begin
  if v_body is null then raise exception 'BODY_REQUIRED'; end if;

  select * into v_ticket from public.support_tickets
  where upper(trim(ticket_no)) = upper(trim(coalesce(p_ticket_no, '')))
    and access_token = coalesce(p_access_token, '')
    and not is_deleted;

  if not found then raise exception 'TICKET_NOT_FOUND'; end if;
  if v_ticket.status = 'Closed' then raise exception 'TICKET_CLOSED'; end if;

  insert into public.support_messages (tenant_id, ticket_id, author_type, author_name, body, is_internal)
  values (v_ticket.tenant_id, v_ticket.id, 'Requester', v_ticket.requester_name, v_body, false);

  update public.support_tickets
  set status = case when status = 'Answered' then 'Open' else status end
  where id = v_ticket.id;

  return jsonb_build_object('ticket_no', v_ticket.ticket_no, 'status', 'Open');
end;
$$;
grant execute on function public.support_ticket_reply_public(text, text, text) to anon, authenticated;

-- In-app creation. The plan reserves this for the System Administrator, which
-- is expressed as the Support.Manage permission, never as a role code.
create or replace function public.support_ticket_create_internal(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user public.users%rowtype;
  v_subject text := nullif(trim(coalesce(p_payload ->> 'subject', '')), '');
  v_body text := nullif(trim(coalesce(p_payload ->> 'body', '')), '');
  v_category text := coalesce(nullif(trim(coalesce(p_payload ->> 'category', '')), ''), 'Other');
  v_priority text := coalesce(nullif(trim(coalesce(p_payload ->> 'priority', '')), ''), 'Normal');
  v_ticket public.support_tickets%rowtype;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  if not public.has_permission('Support.Manage') then raise exception 'PERMISSION_DENIED'; end if;
  if v_subject is null then raise exception 'SUBJECT_REQUIRED'; end if;
  if v_body is null then raise exception 'BODY_REQUIRED'; end if;
  if v_category not in ('Technical', 'Billing', 'Feature', 'Account', 'Other') then
    raise exception 'CATEGORY_INVALID';
  end if;
  if v_priority not in ('Low', 'Normal', 'High', 'Urgent') then v_priority := 'Normal'; end if;

  select * into v_user from public.users where id = auth.uid();
  if not found then raise exception 'USER_NOT_FOUND'; end if;

  insert into public.support_tickets (
    tenant_id, requester_tenant_id, ticket_no, source, category, subject, body,
    requester_name, requester_email, requester_user_id, status, priority,
    requester_ip, user_agent
  )
  values (
    v_tenant, v_tenant, public.support_next_ticket_no(), 'InApp', v_category,
    left(v_subject, 300), v_body,
    coalesce(v_user.full_name, v_user.name_ar, v_user.name_en, v_user.email),
    lower(v_user.email), v_user.id, 'Open', v_priority,
    public.request_client_ip(), public.request_user_agent()
  )
  returning * into v_ticket;

  insert into public.support_messages (tenant_id, ticket_id, author_type, author_user_id, author_name, body, is_internal)
  values (v_tenant, v_ticket.id, 'Requester', v_user.id, v_ticket.requester_name, v_ticket.body, false);

  return jsonb_build_object(
    'id', v_ticket.id,
    'ticket_no', v_ticket.ticket_no,
    'status', v_ticket.status
  );
end;
$$;
grant execute on function public.support_ticket_create_internal(jsonb) to authenticated;

create or replace function public.support_reply(
  p_ticket_id uuid,
  p_body text,
  p_is_internal boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ticket public.support_tickets%rowtype;
  v_body text := nullif(trim(coalesce(p_body, '')), '');
  v_is_operator boolean := public.is_platform_operator();
  v_is_requester boolean;
  v_is_manager boolean;
  v_internal boolean;
  v_author_type text;
  v_author public.users%rowtype;
  v_message_id uuid;
  v_status text;
  v_template uuid;
  v_language text;
  v_url text;
begin
  if v_body is null then raise exception 'BODY_REQUIRED'; end if;

  select * into v_ticket from public.support_tickets where id = p_ticket_id and not is_deleted;
  if not found then raise exception 'TICKET_NOT_FOUND'; end if;

  select * into v_author from public.users where id = auth.uid();

  v_is_requester := v_ticket.requester_user_id is not null and v_ticket.requester_user_id = auth.uid();
  v_is_manager := v_ticket.tenant_id = public.current_tenant_id() and public.has_permission('Support.Manage');

  if not (v_is_operator or v_is_requester or v_is_manager) then
    raise exception 'PERMISSION_DENIED';
  end if;

  -- Only the operator side keeps private notes.
  v_internal := coalesce(p_is_internal, false) and v_is_operator;
  v_author_type := case when v_is_operator then 'Operator' else 'Requester' end;

  insert into public.support_messages (
    tenant_id, ticket_id, author_type, author_user_id, author_name, body, is_internal
  )
  values (
    v_ticket.tenant_id, v_ticket.id, v_author_type, v_author.id,
    coalesce(v_author.full_name, v_author.name_ar, v_author.name_en, v_author.email),
    v_body, v_internal
  )
  returning id into v_message_id;

  if v_author_type = 'Operator' and not v_internal then
    v_status := 'Answered';
  elsif v_author_type = 'Operator' then
    v_status := case when v_ticket.status = 'Open' then 'InProgress' else v_ticket.status end;
  else
    v_status := case when v_ticket.status in ('Answered', 'Closed') then 'Open' else v_ticket.status end;
  end if;

  update public.support_tickets
  set status = v_status,
      first_response_on = case
        when v_author_type = 'Operator' and not v_internal
        then coalesce(first_response_on, now()) else first_response_on end,
      closed_on = case when v_status <> 'Closed' then null else closed_on end
  where id = v_ticket.id;

  -- An answer leaves the product: e-mail always, in-app notification when the
  -- requester is a known user.
  if v_author_type = 'Operator' and not v_internal then
    select id into v_template from public.email_templates
    where tenant_id = v_ticket.tenant_id and code = 'SUPPORT_REPLY' and not is_deleted
    order by version desc limit 1;

    if v_template is null then
      insert into public.email_templates (
        tenant_id, code, version, subject_ar, subject_en, body_html_ar, body_html_en, is_active
      )
      values (
        v_ticket.tenant_id, 'SUPPORT_REPLY', 1,
        'رد على تذكرة الدعم {{ticket_no}}',
        'Reply to support ticket {{ticket_no}}',
        '<div dir="rtl"><p>مرحباً {{requester_name}}،</p><p>تم الرد على تذكرة الدعم رقم {{ticket_no}}.</p><blockquote>{{reply_body}}</blockquote></div>',
        '<div dir="ltr"><p>Hello {{requester_name}},</p><p>Your support ticket {{ticket_no}} has a new reply.</p><blockquote>{{reply_body}}</blockquote></div>',
        true
      )
      returning id into v_template;
    end if;

    select case when coalesce(u.preferred_language, t.default_language) = 'ar' then 'ar' else 'en' end
    into v_language
    from public.tenants t
    left join public.users u on u.id = v_ticket.requester_user_id
    where t.id = v_ticket.tenant_id;

    v_url := 'https://bbnovix.com/support/' || v_ticket.ticket_no;

    insert into public.email_queue (
      tenant_id, recipient_email, recipient_user_id, template_id, language, template_data, priority
    )
    values (
      v_ticket.tenant_id, v_ticket.requester_email, v_ticket.requester_user_id, v_template,
      coalesce(v_language, 'ar'),
      jsonb_build_object(
        'ticket_no', v_ticket.ticket_no,
        'requester_name', v_ticket.requester_name,
        'subject', v_ticket.subject,
        'reply_body', v_body,
        'ticket_url', v_url
      ),
      3
    );

    if v_ticket.requester_user_id is not null and to_regclass('public.notifications') is not null then
      -- The notification module ships in its own migration; a support reply must
      -- never fail because that table is absent or shaped differently.
      begin
        execute
          'insert into public.notifications
             (tenant_id, recipient_id, category, event_code,
              title_ar, title_en, body_ar, body_en, link_path, payload)
           values ($1, $2, $3, $4, $5, $5, $6, $6, $7, $8)'
        using v_ticket.tenant_id, v_ticket.requester_user_id, 'Support', 'Support.Replied',
              v_ticket.subject, left(v_body, 400),
              '/app/support?ticket=' || v_ticket.id::text,
              jsonb_build_object('entity_type', 'SupportTicket', 'entity_id', v_ticket.id);
      exception when others then
        null;
      end;
    end if;
  end if;

  return jsonb_build_object(
    'ticket_id', v_ticket.id,
    'message_id', v_message_id,
    'status', v_status,
    'author_type', v_author_type,
    'is_internal', v_internal
  );
end;
$$;
grant execute on function public.support_reply(uuid, text, boolean) to authenticated;

create or replace function public.support_ticket_set_status(p_ticket_id uuid, p_status text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ticket public.support_tickets%rowtype;
  v_status text := trim(coalesce(p_status, ''));
begin
  if v_status not in ('Open', 'InProgress', 'Answered', 'Closed') then
    raise exception 'STATUS_INVALID';
  end if;

  select * into v_ticket from public.support_tickets where id = p_ticket_id and not is_deleted;
  if not found then raise exception 'TICKET_NOT_FOUND'; end if;

  if not (
    public.is_platform_operator()
    or (v_ticket.tenant_id = public.current_tenant_id() and public.has_permission('Support.Manage'))
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  update public.support_tickets
  set status = v_status,
      closed_on = case when v_status = 'Closed' then coalesce(closed_on, now()) else null end,
      closed_by = case when v_status = 'Closed' then coalesce(closed_by, auth.uid()) else null end
  where id = v_ticket.id;

  return jsonb_build_object('ticket_id', v_ticket.id, 'status', v_status);
end;
$$;
grant execute on function public.support_ticket_set_status(uuid, text) to authenticated;

create or replace function public.support_ticket_assign(p_ticket_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not public.is_platform_operator() then raise exception 'PERMISSION_DENIED'; end if;
  if not exists (select 1 from public.support_tickets where id = p_ticket_id and not is_deleted) then
    raise exception 'TICKET_NOT_FOUND';
  end if;
  if p_user_id is not null and not exists (select 1 from public.users where id = p_user_id and not is_deleted) then
    raise exception 'USER_NOT_FOUND';
  end if;

  update public.support_tickets
  set assigned_to = p_user_id,
      status = case when status = 'Open' and p_user_id is not null then 'InProgress' else status end
  where id = p_ticket_id;

  return jsonb_build_object('ticket_id', p_ticket_id, 'assigned_to', p_user_id);
end;
$$;
grant execute on function public.support_ticket_assign(uuid, uuid) to authenticated;

-- One thread, for the console and for the in-app screen.
create or replace function public.support_ticket_detail(p_ticket_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ticket public.support_tickets%rowtype;
  v_is_operator boolean := public.is_platform_operator();
  v_can_read boolean;
begin
  select * into v_ticket from public.support_tickets where id = p_ticket_id and not is_deleted;
  if not found then raise exception 'TICKET_NOT_FOUND'; end if;

  v_can_read := v_is_operator
    or (v_ticket.tenant_id = public.current_tenant_id()
        and (v_ticket.requester_user_id = auth.uid()
             or public.has_permission('Support.View')
             or public.has_permission('Support.Manage')));

  if not v_can_read then raise exception 'PERMISSION_DENIED'; end if;

  return jsonb_build_object(
    'ticket', jsonb_build_object(
      'id', v_ticket.id,
      'ticket_no', v_ticket.ticket_no,
      'tenant_id', v_ticket.tenant_id,
      'requester_tenant_id', v_ticket.requester_tenant_id,
      'source', v_ticket.source,
      'category', v_ticket.category,
      'status', v_ticket.status,
      'priority', v_ticket.priority,
      'subject', v_ticket.subject,
      'body', v_ticket.body,
      'requester_name', v_ticket.requester_name,
      'requester_email', v_ticket.requester_email,
      'requester_user_id', v_ticket.requester_user_id,
      'assigned_to', v_ticket.assigned_to,
      'first_response_on', v_ticket.first_response_on,
      'closed_on', v_ticket.closed_on,
      'created_on', v_ticket.created_on,
      'updated_on', v_ticket.updated_on
    ),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'author_type', m.author_type,
        'author_user_id', m.author_user_id,
        'author_name', m.author_name,
        'body', m.body,
        'is_internal', m.is_internal,
        'created_on', m.created_on
      ) order by m.created_on)
      from public.support_messages m
      where m.ticket_id = v_ticket.id and not m.is_deleted
        and (v_is_operator or not m.is_internal)
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.support_ticket_detail(uuid) to authenticated;

-- The operator console: every ticket, inside and outside the app.
create or replace function public.support_console(p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_status text := nullif(trim(coalesce(p_status, '')), '');
begin
  if not public.is_platform_operator() then raise exception 'PERMISSION_DENIED'; end if;

  return jsonb_build_object(
    'counts', (
      select jsonb_build_object(
        'total', count(*),
        'open', count(*) filter (where status = 'Open'),
        'in_progress', count(*) filter (where status = 'InProgress'),
        'answered', count(*) filter (where status = 'Answered'),
        'closed', count(*) filter (where status = 'Closed'),
        'unassigned', count(*) filter (where assigned_to is null and status <> 'Closed'),
        'public', count(*) filter (where source = 'Public'),
        'in_app', count(*) filter (where source = 'InApp'),
        'unanswered', count(*) filter (where first_response_on is null and status <> 'Closed')
      )
      from public.support_tickets where not is_deleted
    ),
    'tickets', coalesce((
      select jsonb_agg(x order by x ->> 'created_on' desc)
      from (
        select jsonb_build_object(
          'id', t.id,
          'ticket_no', t.ticket_no,
          'source', t.source,
          'category', t.category,
          'status', t.status,
          'priority', t.priority,
          'subject', t.subject,
          'body', left(t.body, 500),
          'requester_name', t.requester_name,
          'requester_email', t.requester_email,
          'requester_user_id', t.requester_user_id,
          'assigned_to', t.assigned_to,
          'tenant_id', t.tenant_id,
          'tenant_slug', tn.slug,
          'requester_tenant_id', t.requester_tenant_id,
          'requester_tenant_slug', rt.slug,
          'tenant_names', coalesce((
            select jsonb_object_agg(n.language_code, n.name)
            from public.tenant_names n where n.tenant_id = coalesce(t.requester_tenant_id, t.tenant_id)
          ), '{}'::jsonb),
          'message_count', (
            select count(*) from public.support_messages m
            where m.ticket_id = t.id and not m.is_deleted
          ),
          'last_message_on', (
            select max(m.created_on) from public.support_messages m
            where m.ticket_id = t.id and not m.is_deleted
          ),
          'first_response_on', t.first_response_on,
          'closed_on', t.closed_on,
          'created_on', t.created_on
        ) as x
        from public.support_tickets t
        join public.tenants tn on tn.id = t.tenant_id
        left join public.tenants rt on rt.id = t.requester_tenant_id
        where not t.is_deleted
          and (v_status is null or t.status = v_status)
        order by t.created_on desc
        limit 500
      ) s
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.support_console(text) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Storage: the catalogue of providers, the per-company configuration, the
--    object ledger and the policy defaults.
--
--    The database never speaks to a vendor. It describes what is connected and
--    keeps the ledger; the edge function behind IStorageProvider does the I/O.
-- ----------------------------------------------------------------------------

create table if not exists public.storage_providers (
  code text primary key,
  name_ar text not null,
  name_en text not null,
  kind text not null default 'Extended' check (kind in ('Core', 'Extended', 'Both')),
  is_active boolean not null default true,
  requires_oauth boolean not null default false,
  display_order integer not null default 0,
  -- Describes the fields the connection screen renders. Secrets are declared
  -- here but never stored here.
  config_schema jsonb not null default '{}'::jsonb,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

insert into public.storage_providers (code, name_ar, name_en, kind, requires_oauth, display_order, config_schema) values
  ('supabase', 'تخزين Supabase', 'Supabase Storage', 'Both', false, 10,
   '{"fields":[{"key":"bucket","type":"text","required":true},{"key":"root_path","type":"text","required":false}]}'::jsonb),
  ('google_drive', 'جوجل درايف', 'Google Drive', 'Extended', true, 20,
   '{"fields":[{"key":"folder_id","type":"text","required":true},{"key":"client_id","type":"text","required":true},{"key":"client_secret","type":"secret","required":true},{"key":"refresh_token","type":"secret","required":true}]}'::jsonb),
  ('onedrive', 'ون درايف', 'OneDrive', 'Extended', true, 30,
   '{"fields":[{"key":"drive_id","type":"text","required":true},{"key":"folder_path","type":"text","required":false},{"key":"client_id","type":"text","required":true},{"key":"client_secret","type":"secret","required":true},{"key":"refresh_token","type":"secret","required":true}]}'::jsonb),
  ('s3', 'أمازون S3', 'Amazon S3', 'Extended', false, 40,
   '{"fields":[{"key":"region","type":"text","required":true},{"key":"bucket","type":"text","required":true},{"key":"access_key_id","type":"secret","required":true},{"key":"secret_access_key","type":"secret","required":true}]}'::jsonb),
  ('r2', 'كلاودفلير R2', 'Cloudflare R2', 'Extended', false, 50,
   '{"fields":[{"key":"account_id","type":"text","required":true},{"key":"bucket","type":"text","required":true},{"key":"access_key_id","type":"secret","required":true},{"key":"secret_access_key","type":"secret","required":true}]}'::jsonb),
  ('b2', 'باكبليز B2', 'Backblaze B2', 'Extended', false, 60,
   '{"fields":[{"key":"bucket","type":"text","required":true},{"key":"key_id","type":"secret","required":true},{"key":"application_key","type":"secret","required":true}]}'::jsonb),
  ('azure_blob', 'أزور بلوب', 'Azure Blob Storage', 'Extended', false, 70,
   '{"fields":[{"key":"account_name","type":"text","required":true},{"key":"container","type":"text","required":true},{"key":"sas_token","type":"secret","required":true}]}'::jsonb)
on conflict (code) do update set
  name_ar = excluded.name_ar,
  name_en = excluded.name_en,
  kind = excluded.kind,
  requires_oauth = excluded.requires_oauth,
  display_order = excluded.display_order,
  config_schema = excluded.config_schema,
  updated_on = now();

-- The fourth tab of the Storage Management screen: what a file may be, and what
-- a brand new company starts with.
create table if not exists public.storage_policies (
  layer text primary key check (layer in ('Core', 'Extended')),
  max_file_bytes bigint not null default 10485760,
  allowed_mime_types text[] not null default '{}',
  default_quota_bytes bigint not null default 0,
  notes text,
  updated_by uuid references auth.users(id),
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

insert into public.storage_policies (layer, max_file_bytes, allowed_mime_types, default_quota_bytes, notes) values
  ('Core', 5242880,
   array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml', 'image/x-icon'],
   52428800,
   'Platform paid. Logos, cover images, avatars and signatures only.'),
  ('Extended', 26214400,
   array['image/*', 'application/pdf', 'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/vnd.ms-powerpoint',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation',
         'text/plain', 'text/csv', 'application/zip'],
   209715200,
   'Company provider or platform granted space. Documents, certificates, chat and form attachments.')
on conflict (layer) do nothing;

create table if not exists public.tenant_storage_config (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  provider_code text references public.storage_providers(code),
  is_enabled boolean not null default false,
  -- Connection settings only. Credentials live in the edge function
  -- environment and are addressed by credential_ref; the check keeps a secret
  -- from being pasted in here by accident.
  config jsonb not null default '{}'::jsonb,
  credential_ref text,
  root_path text not null default 'tenants',
  quota_bytes bigint not null default 0,
  used_bytes bigint not null default 0,
  max_file_bytes bigint,
  allowed_mime_types text[] not null default '{}',
  connected_on timestamptz,
  connected_by uuid references auth.users(id),
  last_check_on timestamptz,
  last_check_status text check (last_check_status in ('Unknown', 'Ok', 'Failed', 'Suspended')),
  last_check_message text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  constraint chk_tenant_storage_config_no_plain_secrets check (
    not jsonb_exists_any(config, array[
      'secret', 'secret_key', 'secret_access_key', 'access_key', 'access_key_id',
      'client_secret', 'password', 'private_key', 'refresh_token', 'sas_token',
      'application_key', 'api_key', 'token'
    ])
  )
);

create index if not exists idx_tenant_storage_config_tenant
  on public.tenant_storage_config (tenant_id);

-- The ledger. Used storage, file counts and the per-type breakdown are all
-- computed from here, whichever vendor actually holds the bytes.
create table if not exists public.storage_objects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  layer text not null default 'Extended' check (layer in ('Core', 'Extended')),
  provider_code text references public.storage_providers(code),
  bucket text,
  path text not null,
  external_id text,
  file_name text not null,
  mime_type text,
  file_size bigint not null default 0 check (file_size >= 0),
  checksum text,
  owner_id uuid,
  -- Free text on purpose: every module names its own entity
  -- (Document, Certificate, ChatMessage, FormAttachment, Avatar, ...).
  entity_type text,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_storage_objects_tenant on public.storage_objects (tenant_id);
create index if not exists idx_storage_objects_tenant_layer
  on public.storage_objects (tenant_id, layer) where not is_deleted;
create index if not exists idx_storage_objects_entity
  on public.storage_objects (tenant_id, entity_type, entity_id) where not is_deleted;
create index if not exists idx_storage_objects_owner
  on public.storage_objects (tenant_id, owner_id, created_on desc) where not is_deleted;
create unique index if not exists uq_storage_objects_path
  on public.storage_objects (tenant_id, coalesce(provider_code, 'supabase'), coalesce(bucket, ''), path)
  where not is_deleted;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_storage_objects_owner_same_tenant') then
    alter table public.storage_objects
      add constraint fk_storage_objects_owner_same_tenant
      foreign key (tenant_id, owner_id) references public.users (tenant_id, id);
  end if;
end $$;

drop trigger if exists apply_row_defaults on public.tenant_storage_config;
create trigger apply_row_defaults before insert or update on public.tenant_storage_config
for each row execute function public.apply_row_defaults();

drop trigger if exists apply_row_defaults on public.storage_objects;
create trigger apply_row_defaults before insert or update on public.storage_objects
for each row execute function public.apply_row_defaults();

alter table public.storage_providers enable row level security;
alter table public.storage_policies enable row level security;
alter table public.tenant_storage_config enable row level security;
alter table public.storage_objects enable row level security;

drop policy if exists "authenticated read storage providers" on public.storage_providers;
create policy "authenticated read storage providers" on public.storage_providers
  for select to authenticated using (true);

drop policy if exists "platform operators manage storage providers" on public.storage_providers;
create policy "platform operators manage storage providers" on public.storage_providers
  for all to authenticated
  using (public.is_platform_operator()) with check (public.is_platform_operator());

drop policy if exists "authenticated read storage policies" on public.storage_policies;
create policy "authenticated read storage policies" on public.storage_policies
  for select to authenticated using (true);

drop policy if exists "platform operators manage storage policies" on public.storage_policies;
create policy "platform operators manage storage policies" on public.storage_policies
  for all to authenticated
  using (public.is_platform_operator()) with check (public.is_platform_operator());

drop policy if exists "tenant isolation" on public.tenant_storage_config;
create policy "tenant isolation" on public.tenant_storage_config
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- Connection details stay with the administrators; everyone else asks
-- storage_can_upload() whether a file may go up.
drop policy if exists "members read storage config" on public.tenant_storage_config;
create policy "members read storage config" on public.tenant_storage_config
  for select to authenticated
  using (public.has_permission('Storage.Manage') or public.has_permission('Settings.Manage'));

drop policy if exists "storage managers manage storage config" on public.tenant_storage_config;
create policy "storage managers manage storage config" on public.tenant_storage_config
  for all to authenticated
  using (public.has_permission('Storage.Manage') or public.has_permission('Settings.Manage'))
  with check (public.has_permission('Storage.Manage') or public.has_permission('Settings.Manage'));

drop policy if exists "tenant isolation" on public.storage_objects;
create policy "tenant isolation" on public.storage_objects
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- The ledger carries file names and paths, so it is not public inside the
-- company: a module that shows a file to a wider audience does it through its
-- own definer RPC, after its own audience check.
drop policy if exists "members read storage objects" on public.storage_objects;
create policy "members read storage objects" on public.storage_objects
  for select to authenticated
  using (not is_deleted and (owner_id = auth.uid() or created_by = auth.uid() or public.has_permission('Storage.Manage')));

drop policy if exists "storage managers manage storage objects" on public.storage_objects;
create policy "storage managers manage storage objects" on public.storage_objects
  for all to authenticated
  using (owner_id = auth.uid() or public.has_permission('Storage.Manage'))
  with check (owner_id = auth.uid() or public.has_permission('Storage.Manage'));

-- Every company gets a row so the storage screens always have something to
-- read; disabled with no provider is the correct default.
insert into public.tenant_storage_config (tenant_id, provider_code, is_enabled, quota_bytes, last_check_status)
select t.id,
       nullif(s.storage_provider, 'none'),
       coalesce(s.extended_storage_enabled, false),
       coalesce((select limit_value from public.tenant_quotas q
                 where q.tenant_id = t.id and q.resource_code = 'STORAGE_BYTES'), 0),
       'Unknown'
from public.tenants t
left join public.tenant_settings s on s.tenant_id = t.id
where not t.is_deleted
on conflict (tenant_id) do nothing;

-- ----------------------------------------------------------------------------
-- 6. Storage RPCs
-- ----------------------------------------------------------------------------

-- The five pre-upload checks of the plan, in one place, before a single byte
-- moves. Reasons are codes; the client turns them into a sentence.
create or replace function public.storage_can_upload(
  p_layer text default 'Extended',
  p_mime text default null,
  p_size bigint default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_layer text := coalesce(nullif(trim(coalesce(p_layer, '')), ''), 'Extended');
  v_mime text := lower(coalesce(nullif(trim(coalesce(p_mime, '')), ''), ''));
  v_size bigint := coalesce(p_size, 0);
  v_cfg public.tenant_storage_config%rowtype;
  v_policy public.storage_policies%rowtype;
  v_settings public.tenant_settings%rowtype;
  v_provider public.storage_providers%rowtype;
  v_max_bytes bigint;
  v_types text[];
  v_limit bigint := 0;
  v_used bigint := 0;
  v_type_ok boolean;
  v_result jsonb;
begin
  if v_tenant is null then
    return jsonb_build_object('allowed', false, 'reason', 'NO_TENANT_CONTEXT');
  end if;
  if v_layer not in ('Core', 'Extended') then
    return jsonb_build_object('allowed', false, 'reason', 'INVALID_LAYER');
  end if;
  if v_size < 0 then
    return jsonb_build_object('allowed', false, 'reason', 'INVALID_FILE_SIZE');
  end if;

  select * into v_policy from public.storage_policies where layer = v_layer;
  select * into v_settings from public.tenant_settings where tenant_id = v_tenant;
  select * into v_cfg from public.tenant_storage_config where tenant_id = v_tenant;

  if v_layer = 'Core' then
    v_max_bytes := coalesce(v_policy.max_file_bytes, 5242880);
    v_types := coalesce(v_policy.allowed_mime_types, '{}');
  else
    v_max_bytes := coalesce(nullif(v_cfg.max_file_bytes, 0), v_policy.max_file_bytes, 10485760);
    v_types := coalesce(
      nullif(v_cfg.allowed_mime_types, '{}'::text[]),
      v_policy.allowed_mime_types,
      '{}'::text[]
    );
  end if;

  v_limit := coalesce(
    nullif(v_cfg.quota_bytes, 0),
    (select q.limit_value from public.tenant_quotas q
     where q.tenant_id = v_tenant and q.resource_code = 'STORAGE_BYTES' and q.is_enforced),
    0
  );
  v_used := coalesce(
    (select q.used_value from public.tenant_quotas q
     where q.tenant_id = v_tenant and q.resource_code = 'STORAGE_BYTES'),
    v_cfg.used_bytes,
    0
  );

  v_result := jsonb_build_object(
    'layer', v_layer,
    'provider', v_cfg.provider_code,
    'limit_bytes', v_limit,
    'used_bytes', v_used,
    'remaining_bytes', case when v_limit > 0 then greatest(v_limit - v_used, 0) else null end,
    'max_file_bytes', v_max_bytes,
    'allowed_mime_types', to_jsonb(v_types)
  );

  if v_layer = 'Extended' then
    -- 1. is extended storage switched on for this company
    if not coalesce(v_settings.extended_storage_enabled, false) then
      return v_result || jsonb_build_object('allowed', false, 'reason', 'EXTENDED_STORAGE_DISABLED');
    end if;

    -- 2. is there a valid provider
    if v_cfg.tenant_id is null or v_cfg.provider_code is null or v_cfg.provider_code = 'none' then
      return v_result || jsonb_build_object('allowed', false, 'reason', 'STORAGE_PROVIDER_NOT_CONFIGURED');
    end if;
    if not v_cfg.is_enabled then
      return v_result || jsonb_build_object('allowed', false, 'reason', 'STORAGE_SUSPENDED');
    end if;
    select * into v_provider from public.storage_providers where code = v_cfg.provider_code;
    if not found or not v_provider.is_active then
      return v_result || jsonb_build_object('allowed', false, 'reason', 'STORAGE_PROVIDER_INACTIVE');
    end if;
    if v_cfg.last_check_status = 'Failed' then
      return v_result || jsonb_build_object('allowed', false, 'reason', 'STORAGE_PROVIDER_UNREACHABLE');
    end if;

    -- 3. is the company over its limit
    if v_limit > 0 and (v_used + v_size) > v_limit then
      return v_result || jsonb_build_object('allowed', false, 'reason', 'STORAGE_QUOTA_EXCEEDED');
    end if;
  end if;

  -- 4. is the file type allowed
  if array_length(v_types, 1) is not null and not ('*/*' = any (v_types)) then
    v_type_ok := v_mime <> '' and (
      v_mime = any (v_types)
      or exists (
        select 1 from unnest(v_types) x
        where x like '%/*' and v_mime like (replace(x, '/*', '/') || '%')
      )
    );
    if not v_type_ok then
      return v_result || jsonb_build_object('allowed', false, 'reason', 'FILE_TYPE_NOT_ALLOWED');
    end if;
  end if;

  -- 5. is the file size within limits
  if v_max_bytes > 0 and v_size > v_max_bytes then
    return v_result || jsonb_build_object('allowed', false, 'reason', 'FILE_TOO_LARGE');
  end if;

  return v_result || jsonb_build_object('allowed', true, 'reason', null);
end;
$$;
grant execute on function public.storage_can_upload(text, text, bigint) to authenticated;

create or replace function public.storage_register(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_layer text := coalesce(nullif(trim(coalesce(p_payload ->> 'layer', '')), ''), 'Extended');
  v_size bigint := coalesce((p_payload ->> 'file_size')::bigint, 0);
  v_mime text := nullif(trim(coalesce(p_payload ->> 'mime_type', '')), '');
  v_path text := nullif(trim(coalesce(p_payload ->> 'path', '')), '');
  v_name text := nullif(trim(coalesce(p_payload ->> 'file_name', '')), '');
  v_provider text;
  v_check jsonb;
  v_row public.storage_objects%rowtype;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  if v_path is null then raise exception 'PATH_REQUIRED'; end if;
  if v_name is null then raise exception 'FILE_NAME_REQUIRED'; end if;

  v_check := public.storage_can_upload(v_layer, v_mime, v_size);
  if not coalesce((v_check ->> 'allowed')::boolean, false) then
    raise exception '%', coalesce(v_check ->> 'reason', 'UPLOAD_REFUSED');
  end if;

  v_provider := coalesce(
    nullif(trim(coalesce(p_payload ->> 'provider_code', '')), ''),
    case when v_layer = 'Core' then 'supabase' else (v_check ->> 'provider') end,
    'supabase'
  );

  insert into public.storage_objects (
    tenant_id, layer, provider_code, bucket, path, external_id, file_name, mime_type,
    file_size, checksum, owner_id, entity_type, entity_id, metadata
  )
  values (
    v_tenant, v_layer, v_provider,
    nullif(trim(coalesce(p_payload ->> 'bucket', '')), ''),
    v_path,
    nullif(trim(coalesce(p_payload ->> 'external_id', '')), ''),
    v_name, v_mime, v_size,
    nullif(trim(coalesce(p_payload ->> 'checksum', '')), ''),
    coalesce(nullif(p_payload ->> 'owner_id', '')::uuid, auth.uid()),
    nullif(trim(coalesce(p_payload ->> 'entity_type', '')), ''),
    nullif(p_payload ->> 'entity_id', '')::uuid,
    coalesce(p_payload -> 'metadata', '{}'::jsonb)
  )
  returning * into v_row;

  perform public.tenant_quota_consume('STORAGE_BYTES', v_size, v_tenant);

  update public.tenant_storage_config
  set used_bytes = greatest(used_bytes + v_size, 0)
  where tenant_id = v_tenant;

  return jsonb_build_object(
    'id', v_row.id,
    'layer', v_row.layer,
    'provider_code', v_row.provider_code,
    'bucket', v_row.bucket,
    'path', v_row.path,
    'file_name', v_row.file_name,
    'file_size', v_row.file_size,
    'created_on', v_row.created_on
  );
end;
$$;
grant execute on function public.storage_register(jsonb) to authenticated;

create or replace function public.storage_unregister(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_row public.storage_objects%rowtype;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;

  select * into v_row from public.storage_objects
  where id = p_id and tenant_id = v_tenant and not is_deleted;
  if not found then raise exception 'STORAGE_OBJECT_NOT_FOUND'; end if;

  if not (
    v_row.owner_id = auth.uid()
    or v_row.created_by = auth.uid()
    or public.has_permission('Storage.Manage')
    or public.is_platform_operator()
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  update public.storage_objects set is_deleted = true where id = v_row.id;

  perform public.tenant_quota_consume('STORAGE_BYTES', -v_row.file_size, v_tenant);

  update public.tenant_storage_config
  set used_bytes = greatest(used_bytes - v_row.file_size, 0)
  where tenant_id = v_tenant;

  return jsonb_build_object('id', v_row.id, 'released_bytes', v_row.file_size);
end;
$$;
grant execute on function public.storage_unregister(uuid) to authenticated;

-- The company facing storage tab. Same numbers as the platform screen, one
-- company only.
create or replace function public.storage_my_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;

  return jsonb_build_object(
    'config', coalesce((
      select to_jsonb(c) - 'config' - 'credential_ref'
      from public.tenant_storage_config c where c.tenant_id = v_tenant
    ), '{}'::jsonb),
    'policies', coalesce((
      select jsonb_object_agg(p.layer, jsonb_build_object(
        'max_file_bytes', p.max_file_bytes,
        'allowed_mime_types', to_jsonb(p.allowed_mime_types)
      )) from public.storage_policies p
    ), '{}'::jsonb),
    'quota', coalesce((
      select jsonb_build_object('limit', q.limit_value, 'used', q.used_value, 'enforced', q.is_enforced)
      from public.tenant_quotas q
      where q.tenant_id = v_tenant and q.resource_code = 'STORAGE_BYTES'
    ), '{}'::jsonb),
    'objects', (
      select jsonb_build_object(
        'files', count(*),
        'bytes', coalesce(sum(file_size), 0),
        'core_bytes', coalesce(sum(file_size) filter (where layer = 'Core'), 0),
        'extended_bytes', coalesce(sum(file_size) filter (where layer = 'Extended'), 0),
        'images', count(*) filter (where mime_type like 'image/%'),
        'documents', count(*) filter (where mime_type like 'application/%' or mime_type like 'text/%'),
        'chat_attachments', count(*) filter (where entity_type = 'ChatMessage')
      )
      from public.storage_objects where tenant_id = v_tenant and not is_deleted
    )
  );
end;
$$;
grant execute on function public.storage_my_usage() to authenticated;

-- Connecting a provider is a company action; quota and suspension are the
-- platform operator's.
create or replace function public.storage_set_tenant_config(p_tenant_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := coalesce(p_tenant_id, public.current_tenant_id());
  v_is_operator boolean := public.is_platform_operator();
  v_provider text := nullif(trim(coalesce(p_payload ->> 'provider_code', '')), '');
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;

  if not v_is_operator then
    if v_tenant <> public.current_tenant_id() then raise exception 'PERMISSION_DENIED'; end if;
    if not (public.has_permission('Storage.Manage') or public.has_permission('Settings.Manage')) then
      raise exception 'PERMISSION_DENIED';
    end if;
  end if;

  if v_provider is not null and v_provider <> 'none'
     and not exists (select 1 from public.storage_providers where code = v_provider) then
    raise exception 'STORAGE_PROVIDER_UNKNOWN';
  end if;

  insert into public.tenant_storage_config (tenant_id) values (v_tenant)
  on conflict (tenant_id) do nothing;

  update public.tenant_storage_config c
  set provider_code = case when p_payload ? 'provider_code' then nullif(v_provider, 'none') else c.provider_code end,
      is_enabled = case when p_payload ? 'is_enabled' then coalesce((p_payload ->> 'is_enabled')::boolean, c.is_enabled) else c.is_enabled end,
      config = case when p_payload ? 'config' then coalesce(p_payload -> 'config', '{}'::jsonb) else c.config end,
      credential_ref = case when p_payload ? 'credential_ref' then nullif(trim(coalesce(p_payload ->> 'credential_ref', '')), '') else c.credential_ref end,
      root_path = case when p_payload ? 'root_path' then coalesce(nullif(trim(coalesce(p_payload ->> 'root_path', '')), ''), 'tenants') else c.root_path end,
      max_file_bytes = case when p_payload ? 'max_file_bytes' then nullif(p_payload ->> 'max_file_bytes', '')::bigint else c.max_file_bytes end,
      allowed_mime_types = case
        when p_payload ? 'allowed_mime_types'
        then coalesce(
          (select array_agg(t.mt) from jsonb_array_elements_text(p_payload -> 'allowed_mime_types') as t(mt)),
          '{}'::text[])
        else c.allowed_mime_types end,
      -- Only the platform decides how much space a company gets.
      quota_bytes = case when v_is_operator and p_payload ? 'quota_bytes'
                         then coalesce((p_payload ->> 'quota_bytes')::bigint, c.quota_bytes) else c.quota_bytes end,
      last_check_on = case when p_payload ? 'last_check_status' then now() else c.last_check_on end,
      last_check_status = case when p_payload ? 'last_check_status'
                               then nullif(trim(coalesce(p_payload ->> 'last_check_status', '')), '') else c.last_check_status end,
      last_check_message = case when p_payload ? 'last_check_message'
                                then nullif(trim(coalesce(p_payload ->> 'last_check_message', '')), '') else c.last_check_message end,
      connected_on = case when p_payload ? 'provider_code' and v_provider is not null and v_provider <> 'none'
                          then coalesce(c.connected_on, now()) else c.connected_on end,
      connected_by = case when p_payload ? 'provider_code' and v_provider is not null and v_provider <> 'none'
                          then coalesce(c.connected_by, auth.uid()) else c.connected_by end
  where c.tenant_id = v_tenant;

  -- tenant_settings stays the single source of truth for the two switches the
  -- rest of the product reads.
  update public.tenant_settings s
  set storage_provider = case when p_payload ? 'provider_code'
                              then coalesce(v_provider, 'none') else s.storage_provider end,
      extended_storage_enabled = case when p_payload ? 'is_enabled'
                                      then coalesce((p_payload ->> 'is_enabled')::boolean, s.extended_storage_enabled)
                                      else s.extended_storage_enabled end,
      updated_on = now()
  where s.tenant_id = v_tenant
    and (p_payload ? 'provider_code' or p_payload ? 'is_enabled');

  if v_is_operator and p_payload ? 'quota_bytes' then
    insert into public.tenant_quotas (tenant_id, resource_code, limit_value)
    values (v_tenant, 'STORAGE_BYTES', coalesce((p_payload ->> 'quota_bytes')::bigint, 0))
    on conflict (tenant_id, resource_code) do update
      set limit_value = excluded.limit_value, updated_on = now();
  end if;

  return jsonb_build_object(
    'tenant_id', v_tenant,
    'config', (select to_jsonb(c) - 'config' - 'credential_ref'
               from public.tenant_storage_config c where c.tenant_id = v_tenant)
  );
end;
$$;
grant execute on function public.storage_set_tenant_config(uuid, jsonb) to authenticated;

-- Company Storage and Storage Usage tabs of the platform screen.
create or replace function public.storage_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_operator() then raise exception 'PERMISSION_DENIED'; end if;

  return jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'tenants', (select count(*) from public.tenants where not is_deleted),
        'files', count(*),
        'bytes', coalesce(sum(file_size), 0),
        'images', count(*) filter (where mime_type like 'image/%'),
        'documents', count(*) filter (where mime_type like 'application/%' or mime_type like 'text/%'),
        'chat_attachments', count(*) filter (where entity_type = 'ChatMessage'),
        'core_bytes', coalesce(sum(file_size) filter (where layer = 'Core'), 0),
        'extended_bytes', coalesce(sum(file_size) filter (where layer = 'Extended'), 0)
      )
      from public.storage_objects where not is_deleted
    ),
    'providers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', p.code, 'name_ar', p.name_ar, 'name_en', p.name_en,
        'kind', p.kind, 'is_active', p.is_active,
        'tenants', (select count(*) from public.tenant_storage_config c where c.provider_code = p.code),
        'bytes', (select coalesce(sum(o.file_size), 0) from public.storage_objects o
                  where o.provider_code = p.code and not o.is_deleted)
      ) order by p.display_order)
      from public.storage_providers p
    ), '[]'::jsonb),
    'tenants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tenant_id', t.id,
        'slug', t.slug,
        'status', t.status,
        'names', coalesce((select jsonb_object_agg(n.language_code, n.name)
                           from public.tenant_names n where n.tenant_id = t.id), '{}'::jsonb),
        'provider', c.provider_code,
        'storage_status', case
          when c.tenant_id is null then 'NotConfigured'
          when c.provider_code is null then 'NotConfigured'
          when not c.is_enabled then 'Suspended'
          else coalesce(c.last_check_status, 'Unknown') end,
        'extended_enabled', coalesce(s.extended_storage_enabled, false),
        'chat_attachments_enabled', coalesce(s.chat_attachments_enabled, false),
        'allocated_bytes', coalesce(nullif(c.quota_bytes, 0), q.limit_value, 0),
        'used_bytes', coalesce(o.bytes, 0),
        'percent', case
          when coalesce(nullif(c.quota_bytes, 0), q.limit_value, 0) > 0
          then round((coalesce(o.bytes, 0)::numeric * 100) / coalesce(nullif(c.quota_bytes, 0), q.limit_value), 2)
          else null end,
        'files', coalesce(o.files, 0),
        'images', coalesce(o.images, 0),
        'documents', coalesce(o.documents, 0),
        'chat_attachments', coalesce(o.chat_attachments, 0),
        'last_check_on', c.last_check_on
      ) order by coalesce(o.bytes, 0) desc)
      from public.tenants t
      left join public.tenant_storage_config c on c.tenant_id = t.id
      left join public.tenant_settings s on s.tenant_id = t.id
      left join public.tenant_quotas q on q.tenant_id = t.id and q.resource_code = 'STORAGE_BYTES'
      left join lateral (
        select count(*) as files,
               coalesce(sum(file_size), 0) as bytes,
               count(*) filter (where mime_type like 'image/%') as images,
               count(*) filter (where mime_type like 'application/%' or mime_type like 'text/%') as documents,
               count(*) filter (where entity_type = 'ChatMessage') as chat_attachments
        from public.storage_objects so
        where so.tenant_id = t.id and not so.is_deleted
      ) o on true
      where not t.is_deleted
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.storage_overview() to authenticated;

-- ----------------------------------------------------------------------------
-- 7. Security: the policy values live in tenant_settings, these are the facts
--    the Security screen reports on.
-- ----------------------------------------------------------------------------

create table if not exists public.login_attempts (
  id uuid primary key default gen_random_uuid(),
  -- The company of the address when it can be resolved, the platform workspace
  -- when the address belongs to nobody: a row always has a company.
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid,
  email citext not null,
  succeeded boolean not null default false,
  failure_reason text,
  ip inet,
  user_agent text,
  device_hash text,
  attempted_on timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_login_attempts_tenant on public.login_attempts (tenant_id);
-- The rate limiting read path: recent attempts for one address.
create index if not exists idx_login_attempts_email_time
  on public.login_attempts (email, attempted_on desc);
create index if not exists idx_login_attempts_tenant_time
  on public.login_attempts (tenant_id, attempted_on desc);

create table if not exists public.user_devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null,
  device_hash text not null,
  device_label text,
  user_agent text,
  ip inet,
  first_seen_on timestamptz not null default now(),
  last_seen_on timestamptz not null default now(),
  is_trusted boolean not null default false,
  revoked_on timestamptz,
  revoked_by uuid references auth.users(id),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  constraint uq_user_devices_hash unique (tenant_id, user_id, device_hash)
);

create index if not exists idx_user_devices_tenant on public.user_devices (tenant_id);
create index if not exists idx_user_devices_user
  on public.user_devices (tenant_id, user_id, last_seen_on desc) where not is_deleted;

create table if not exists public.security_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid,
  event_code text not null,
  severity text not null default 'Info' check (severity in ('Info', 'Warning', 'Critical')),
  detail jsonb not null default '{}'::jsonb,
  ip inet,
  user_agent text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_security_events_tenant on public.security_events (tenant_id);
create index if not exists idx_security_events_recent
  on public.security_events (tenant_id, created_on desc) where not is_deleted;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_login_attempts_user_same_tenant') then
    alter table public.login_attempts
      add constraint fk_login_attempts_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_user_devices_user_same_tenant') then
    alter table public.user_devices
      add constraint fk_user_devices_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_security_events_user_same_tenant') then
    alter table public.security_events
      add constraint fk_security_events_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id);
  end if;
end $$;

drop trigger if exists apply_row_defaults on public.login_attempts;
create trigger apply_row_defaults before insert or update on public.login_attempts
for each row execute function public.apply_row_defaults();

drop trigger if exists apply_row_defaults on public.user_devices;
create trigger apply_row_defaults before insert or update on public.user_devices
for each row execute function public.apply_row_defaults();

drop trigger if exists apply_row_defaults on public.security_events;
create trigger apply_row_defaults before insert or update on public.security_events
for each row execute function public.apply_row_defaults();

alter table public.login_attempts enable row level security;
alter table public.user_devices enable row level security;
alter table public.security_events enable row level security;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['login_attempts', 'user_devices', 'security_events'] loop
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

drop policy if exists "security readers read login attempts" on public.login_attempts;
create policy "security readers read login attempts" on public.login_attempts
  for select to authenticated
  using (public.has_permission('Security.View') or public.has_permission('Audit.View'));

drop policy if exists "users read own devices" on public.user_devices;
create policy "users read own devices" on public.user_devices
  for select to authenticated
  using (user_id = auth.uid() or public.has_permission('Security.View'));

drop policy if exists "users manage own devices" on public.user_devices;
create policy "users manage own devices" on public.user_devices
  for update to authenticated
  using (user_id = auth.uid() or public.has_permission('Settings.Manage'))
  with check (user_id = auth.uid() or public.has_permission('Settings.Manage'));

drop policy if exists "security readers read events" on public.security_events;
create policy "security readers read events" on public.security_events
  for select to authenticated
  using (user_id = auth.uid() or public.has_permission('Security.View') or public.has_permission('Audit.View'));

-- ----------------------------------------------------------------------------
-- 8. Security RPCs
-- ----------------------------------------------------------------------------

-- Called after every sign-in attempt, including the failed ones, which arrive
-- without a session: the company is resolved from the address.
create or replace function public.record_login(
  p_success boolean,
  p_email text,
  p_device_hash text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email citext := lower(trim(coalesce(p_email, '')));
  v_user public.users%rowtype;
  v_tenant uuid;
  v_ip inet := public.request_client_ip();
  v_agent text := left(coalesce(nullif(trim(coalesce(p_user_agent, '')), ''), public.request_user_agent(), ''), 400);
  v_hash text := nullif(trim(coalesce(p_device_hash, '')), '');
  v_max smallint := 5;
  v_failures integer := 0;
  v_new_device boolean := false;
begin
  if v_email::text = '' then raise exception 'EMAIL_REQUIRED'; end if;

  select * into v_user from public.users
  where lower(trim(email)) = lower(trim(p_email)) and not is_deleted
  order by last_login_on desc nulls last
  limit 1;

  v_tenant := coalesce(v_user.tenant_id, public.platform_tenant_id());
  if v_tenant is null then raise exception 'PLATFORM_TENANT_MISSING'; end if;

  -- The endpoint is reachable anonymously; it may not become a write amplifier.
  if (
    select count(*) from public.login_attempts
    where email = v_email and attempted_on > now() - interval '5 minutes'
  ) >= 50 then
    return jsonb_build_object('recorded', false, 'reason', 'TOO_MANY_ATTEMPTS', 'locked', true);
  end if;

  insert into public.login_attempts (
    tenant_id, user_id, email, succeeded, ip, user_agent, device_hash, failure_reason
  )
  values (
    v_tenant, v_user.id, v_email, coalesce(p_success, false), v_ip, nullif(v_agent, ''), v_hash,
    case when coalesce(p_success, false) then null
         when v_user.id is null then 'UNKNOWN_ACCOUNT' else 'INVALID_CREDENTIALS' end
  );

  select coalesce(max_login_attempts, 5) into v_max
  from public.tenant_settings where tenant_id = v_tenant;
  v_max := coalesce(v_max, 5);

  select count(*) into v_failures
  from public.login_attempts
  where email = v_email
    and not succeeded
    and attempted_on > now() - interval '15 minutes'
    and attempted_on > coalesce((
      select max(attempted_on) from public.login_attempts
      where email = v_email and succeeded
    ), now() - interval '100 years');

  if coalesce(p_success, false) and v_user.id is not null then
    update public.users set last_login_on = now() where id = v_user.id;

    if v_hash is not null then
      v_new_device := not exists (
        select 1 from public.user_devices
        where tenant_id = v_tenant and user_id = v_user.id and device_hash = v_hash
      );

      insert into public.user_devices (tenant_id, user_id, device_hash, user_agent, ip)
      values (v_tenant, v_user.id, v_hash, nullif(v_agent, ''), v_ip)
      on conflict (tenant_id, user_id, device_hash) do update
        set last_seen_on = now(),
            user_agent = coalesce(excluded.user_agent, public.user_devices.user_agent),
            ip = coalesce(excluded.ip, public.user_devices.ip),
            revoked_on = null;

      if v_new_device then
        insert into public.security_events (tenant_id, user_id, event_code, severity, detail, ip, user_agent)
        values (v_tenant, v_user.id, 'NEW_DEVICE_SIGN_IN', 'Warning',
                jsonb_build_object('device_hash', v_hash), v_ip, nullif(v_agent, ''));
      end if;
    end if;
  elsif not coalesce(p_success, false) and v_failures >= v_max then
    insert into public.security_events (tenant_id, user_id, event_code, severity, detail, ip, user_agent)
    values (v_tenant, v_user.id, 'LOGIN_ATTEMPTS_EXCEEDED', 'Critical',
            jsonb_build_object('email', v_email, 'failures', v_failures, 'limit', v_max),
            v_ip, nullif(v_agent, ''));
  end if;

  return jsonb_build_object(
    'recorded', true,
    'tenant_id', v_tenant,
    'known_account', v_user.id is not null,
    'failed_attempts', v_failures,
    'max_attempts', v_max,
    'remaining_attempts', greatest(v_max - v_failures, 0),
    'locked', (not coalesce(p_success, false)) and v_failures >= v_max,
    'new_device', v_new_device
  );
end;
$$;
grant execute on function public.record_login(boolean, text, text, text) to anon, authenticated;

create or replace function public.security_revoke_device(p_device_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_device public.user_devices%rowtype;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;

  select * into v_device from public.user_devices
  where id = p_device_id and tenant_id = v_tenant and not is_deleted;
  if not found then raise exception 'DEVICE_NOT_FOUND'; end if;

  if not (v_device.user_id = auth.uid() or public.has_permission('Settings.Manage')) then
    raise exception 'PERMISSION_DENIED';
  end if;

  update public.user_devices
  set revoked_on = now(), revoked_by = auth.uid(), is_trusted = false
  where id = v_device.id;

  insert into public.security_events (tenant_id, user_id, event_code, severity, detail)
  values (v_tenant, v_device.user_id, 'DEVICE_REVOKED', 'Warning',
          jsonb_build_object('device_id', v_device.id, 'by', auth.uid()));

  return jsonb_build_object('device_id', v_device.id, 'revoked_on', now());
end;
$$;
grant execute on function public.security_revoke_device(uuid) to authenticated;

-- The company Security screen: policy, attempts, devices, events, audit.
create or replace function public.security_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  if not (
    public.has_permission('Security.View')
    or public.has_permission('Settings.Manage')
    or public.is_platform_operator()
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  return jsonb_build_object(
    'policy', coalesce((
      select jsonb_build_object(
        'password_min_length', s.password_min_length,
        'password_require_upper', s.password_require_upper,
        'password_require_number', s.password_require_number,
        'password_require_symbol', s.password_require_symbol,
        'session_timeout_minutes', s.session_timeout_minutes,
        'mfa_required', s.mfa_required,
        'max_login_attempts', s.max_login_attempts,
        'ip_allow_list', to_jsonb(s.ip_allow_list)
      )
      from public.tenant_settings s where s.tenant_id = v_tenant
    ), '{}'::jsonb),
    'stats', (
      select jsonb_build_object(
        'attempts_24h', count(*) filter (where attempted_on > now() - interval '24 hours'),
        'failures_24h', count(*) filter (where not succeeded and attempted_on > now() - interval '24 hours'),
        'failures_7d', count(*) filter (where not succeeded and attempted_on > now() - interval '7 days'),
        'logins_30d', count(*) filter (where succeeded and attempted_on > now() - interval '30 days'),
        'distinct_users_30d', count(distinct user_id) filter (where succeeded and attempted_on > now() - interval '30 days')
      )
      from public.login_attempts where tenant_id = v_tenant
    ),
    'blocked', coalesce((
      select jsonb_agg(x order by x ->> 'failures' desc)
      from (
        select jsonb_build_object(
          'email', a.email,
          'failures', count(*),
          'last_attempt_on', max(a.attempted_on)
        ) as x
        from public.login_attempts a
        where a.tenant_id = v_tenant and not a.succeeded
          and a.attempted_on > now() - interval '15 minutes'
        group by a.email
        having count(*) >= coalesce((select max_login_attempts from public.tenant_settings where tenant_id = v_tenant), 5)
      ) s
    ), '[]'::jsonb),
    'attempts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'email', a.email, 'succeeded', a.succeeded,
        'failure_reason', a.failure_reason, 'ip', host(a.ip),
        'user_agent', a.user_agent, 'attempted_on', a.attempted_on
      ) order by a.attempted_on desc)
      from (
        select * from public.login_attempts
        where tenant_id = v_tenant
        order by attempted_on desc limit 100
      ) a
    ), '[]'::jsonb),
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'user_id', d.user_id,
        'user_name', coalesce(u.full_name, u.name_ar, u.name_en, u.email),
        'device_hash', left(d.device_hash, 12),
        'device_label', d.device_label,
        'user_agent', d.user_agent, 'ip', host(d.ip),
        'first_seen_on', d.first_seen_on, 'last_seen_on', d.last_seen_on,
        'is_trusted', d.is_trusted, 'revoked_on', d.revoked_on
      ) order by d.last_seen_on desc)
      from (
        select * from public.user_devices
        where tenant_id = v_tenant and not is_deleted
        order by last_seen_on desc limit 200
      ) d
      left join public.users u on u.id = d.user_id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'user_id', e.user_id, 'event_code', e.event_code,
        'severity', e.severity, 'detail', e.detail, 'ip', host(e.ip),
        'created_on', e.created_on
      ) order by e.created_on desc)
      from (
        select * from public.security_events
        where tenant_id = v_tenant and not is_deleted
        order by created_on desc limit 100
      ) e
    ), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'actor_id', l.actor_id, 'action', l.action,
        'entity_type', l.entity_type, 'entity_id', l.entity_id, 'created_on', l.created_on
      ) order by l.created_on desc)
      from (
        select * from public.audit_logs
        where tenant_id = v_tenant
        order by created_on desc limit 50
      ) l
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.security_overview() to authenticated;

-- ----------------------------------------------------------------------------
-- 9. Screen registry
--
--    One catalogue of everything the application can open, plus a per-role
--    override table. The sidebar renders my_screens(); nothing is hard coded in
--    React any more. route is the sub path inside the app shell
--    (/{slug}/app/<route>, /platform/app/<route>).
-- ----------------------------------------------------------------------------

create table if not exists public.app_screens (
  code text primary key,
  module_code text references public.platform_modules(code) on delete set null,
  area text not null default 'Portal' check (area in ('Portal', 'Admin', 'Platform')),
  group_code text not null default 'General',
  name_ar text not null,
  name_en text not null,
  icon text,
  route text not null,
  display_order integer not null default 0,
  -- Falls back on current_content_access_rank(): 1 employee ... 4 administrator.
  min_role_rank smallint not null default 1,
  is_active boolean not null default true,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_app_screens_area on public.app_screens (area, display_order);

create table if not exists public.role_screens (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  screen_code text not null references public.app_screens(code) on delete cascade,
  is_enabled boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  primary key (tenant_id, role_id, screen_code)
);

create index if not exists idx_role_screens_tenant on public.role_screens (tenant_id);
create index if not exists idx_role_screens_role on public.role_screens (tenant_id, role_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_role_screens_role_same_tenant') then
    alter table public.role_screens
      add constraint fk_role_screens_role_same_tenant
      foreign key (tenant_id, role_id) references public.roles (tenant_id, id) on delete cascade;
  end if;
end $$;

drop trigger if exists apply_row_defaults on public.role_screens;
create trigger apply_row_defaults before insert or update on public.role_screens
for each row execute function public.apply_row_defaults();

alter table public.app_screens enable row level security;
alter table public.role_screens enable row level security;

drop policy if exists "authenticated read screens" on public.app_screens;
create policy "authenticated read screens" on public.app_screens
  for select to authenticated using (true);

drop policy if exists "platform operators manage screens" on public.app_screens;
create policy "platform operators manage screens" on public.app_screens
  for all to authenticated
  using (public.is_platform_operator()) with check (public.is_platform_operator());

drop policy if exists "tenant isolation" on public.role_screens;
create policy "tenant isolation" on public.role_screens
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "members read role screens" on public.role_screens;
create policy "members read role screens" on public.role_screens
  for select to authenticated using (true);

drop policy if exists "screen admins manage role screens" on public.role_screens;
create policy "screen admins manage role screens" on public.role_screens
  for all to authenticated
  using (public.has_permission('Screens.Manage'))
  with check (public.has_permission('Screens.Manage'));

insert into public.app_screens (code, module_code, area, group_code, name_ar, name_en, icon, route, display_order, min_role_rank) values
  -- Employee portal
  ('PORTAL_HOME', 'EMPLOYEE_PORTAL', 'Portal', 'Workspace', 'الرئيسية', 'Home', 'home', 'home', 10, 1),
  ('PORTAL_NEW_REQUEST', 'FORMS', 'Portal', 'Requests', 'طلب جديد', 'New Request', 'file-plus', 'requests/new', 20, 1),
  ('PORTAL_MY_REQUESTS', 'FORMS', 'Portal', 'Requests', 'طلباتي', 'My Requests', 'files', 'requests', 30, 1),
  ('PORTAL_APPROVALS', 'APPROVALS', 'Portal', 'Requests', 'مركز الموافقات', 'Approval Center', 'check-circle', 'approvals', 40, 1),
  ('PORTAL_DOCUMENTS', 'DOCUMENTS', 'Portal', 'Content', 'الوثائق', 'Documents', 'folder', 'documents', 50, 1),
  ('PORTAL_CIRCULARS', 'DOCUMENTS', 'Portal', 'Content', 'التعاميم', 'Circulars', 'scroll-text', 'circulars', 60, 1),
  ('PORTAL_DESIGNS', 'DOCUMENTS', 'Portal', 'Content', 'التصاميم', 'Designs', 'palette', 'designs', 70, 1),
  ('PORTAL_ANNOUNCEMENTS', 'ANNOUNCEMENTS', 'Portal', 'Engagement', 'الإعلانات', 'Announcements', 'megaphone', 'announcements', 80, 1),
  ('PORTAL_CALENDAR', 'CALENDAR', 'Portal', 'Engagement', 'التقويم', 'Calendar', 'calendar', 'calendar', 90, 1),
  ('PORTAL_SURVEYS', 'SURVEY', 'Portal', 'Engagement', 'الاستطلاعات', 'Surveys', 'clipboard-list', 'surveys', 100, 1),
  ('PORTAL_NOTES', 'NOTES', 'Portal', 'Productivity', 'المفكرة', 'Notes', 'sticky-note', 'notes', 110, 1),
  ('PORTAL_CHAT', 'CHAT', 'Portal', 'Collaboration', 'الدردشة', 'Chat', 'message-circle', 'chat', 120, 1),
  ('PORTAL_KNOWLEDGE', 'KNOWLEDGE_BASE', 'Portal', 'Content', 'قاعدة المعرفة', 'Knowledge Base', 'book-open', 'knowledge', 130, 1),
  ('PORTAL_CERTIFICATES', 'CERTIFICATES', 'Portal', 'Verification', 'شهاداتي', 'My Certificates', 'award', 'certificates', 140, 1),
  ('PORTAL_PERFORMANCE', 'PERFORMANCE', 'Portal', 'Performance', 'تقييمي', 'My Evaluation', 'gauge', 'performance', 150, 1),
  ('PORTAL_DIRECTORY', 'EMPLOYEE_PORTAL', 'Portal', 'Workspace', 'دليل الموظفين', 'Employee Directory', 'contact', 'directory', 160, 1),
  ('PORTAL_NOTIFICATIONS', null, 'Portal', 'Workspace', 'الإشعارات', 'Notifications', 'bell', 'notifications', 170, 1),
  ('PORTAL_PROFILE', null, 'Portal', 'Workspace', 'ملفي الشخصي', 'My Profile', 'user', 'profile', 180, 1),
  ('PORTAL_SUPPORT', 'SUPPORT', 'Portal', 'Workspace', 'تذاكر الدعم', 'Support Tickets', 'life-buoy', 'support', 190, 4),

  -- Company administration: organization
  ('ADMIN_EMPLOYEES', 'EMPLOYEE_PORTAL', 'Admin', 'Organization', 'الموظفون', 'Employees', 'users', 'admin/employees', 210, 3),
  ('ADMIN_DEPARTMENTS', 'EMPLOYEE_PORTAL', 'Admin', 'Organization', 'الإدارات', 'Departments', 'network', 'admin/departments', 220, 3),
  ('ADMIN_POSITIONS', 'EMPLOYEE_PORTAL', 'Admin', 'Organization', 'المناصب', 'Positions', 'id-card', 'admin/positions', 230, 3),
  ('ADMIN_SECTORS', 'EMPLOYEE_PORTAL', 'Admin', 'Organization', 'القطاعات', 'Sectors', 'layers', 'admin/sectors', 240, 3),
  ('ADMIN_PROJECTS', 'EMPLOYEE_PORTAL', 'Admin', 'Organization', 'المشاريع', 'Projects', 'briefcase', 'admin/projects', 250, 3),
  ('ADMIN_SITES', 'EMPLOYEE_PORTAL', 'Admin', 'Organization', 'المواقع', 'Sites', 'map-pin', 'admin/sites', 260, 3),
  ('ADMIN_COUNTRIES', 'EMPLOYEE_PORTAL', 'Admin', 'Organization', 'الدول', 'Countries', 'globe', 'admin/countries', 270, 3),
  ('ADMIN_COMPANY_PROFILE', null, 'Admin', 'Organization', 'ملف الشركة', 'Company Profile', 'building-2', 'admin/company', 280, 4),

  -- Company administration: access
  ('ADMIN_ROLES', null, 'Admin', 'Access', 'الأدوار والصلاحيات', 'Roles and Permissions', 'shield', 'admin/roles', 290, 4),
  ('ADMIN_SCREENS', null, 'Admin', 'Access', 'الشاشات والخدمات', 'Screens and Services', 'layout-grid', 'admin/screens', 300, 4),
  ('ADMIN_SECURITY', null, 'Admin', 'Access', 'الأمن', 'Security', 'lock', 'admin/security', 310, 4),
  ('ADMIN_AUDIT', null, 'Admin', 'Access', 'سجل التدقيق', 'Audit Log', 'file-search', 'admin/audit', 320, 4),

  -- Company administration: approvals and forms
  ('ADMIN_APPROVAL_ROLES', 'APPROVALS', 'Admin', 'Approvals', 'صفات الاعتماد', 'Approval Roles', 'user-check', 'admin/approval-roles', 330, 4),
  ('ADMIN_APPROVAL_SCHEMES', 'APPROVALS', 'Admin', 'Approvals', 'مخططات الاعتماد', 'Approval Schemes', 'git-branch', 'admin/approval-schemes', 340, 4),
  ('ADMIN_APPROVAL_TRACKING', 'APPROVALS', 'Admin', 'Approvals', 'متابعة الموافقات', 'Approval Tracking', 'activity', 'admin/approval-tracking', 350, 3),
  ('ADMIN_TEMPLATES', 'FORMS', 'Admin', 'Forms', 'قوالب النماذج', 'Form Templates', 'file-text', 'admin/templates', 360, 4),
  ('ADMIN_FORMS', 'FORMS', 'Admin', 'Forms', 'الطلبات', 'Requests', 'inbox', 'admin/forms', 370, 3),

  -- Company administration: content
  ('ADMIN_CONTENT', 'DOCUMENTS', 'Admin', 'Content', 'إدارة المحتوى', 'Content Management', 'folder-open', 'admin/content', 380, 3),
  ('ADMIN_ANNOUNCEMENTS', 'ANNOUNCEMENTS', 'Admin', 'Content', 'إدارة الإعلانات', 'Announcements', 'megaphone', 'admin/announcements', 390, 3),
  ('ADMIN_SURVEYS', 'SURVEY', 'Admin', 'Content', 'إدارة الاستطلاعات', 'Surveys', 'bar-chart-3', 'admin/surveys', 400, 3),
  ('ADMIN_CALENDAR', 'CALENDAR', 'Admin', 'Content', 'مناسبات الشركة', 'Company Events', 'calendar-days', 'admin/calendar', 410, 3),

  -- Company administration: verification
  ('ADMIN_CERTIFICATES', 'CERTIFICATES', 'Admin', 'Verification', 'الشهادات', 'Certificates', 'award', 'admin/certificates', 420, 3),
  ('ADMIN_CERTIFICATE_TEMPLATES', 'CERTIFICATES', 'Admin', 'Verification', 'قوالب الشهادات', 'Certificate Templates', 'stamp', 'admin/certificate-templates', 430, 4),
  ('ADMIN_ATTESTATIONS', 'VERIFICATION', 'Admin', 'Verification', 'التوثيقات', 'Attestations', 'file-badge', 'admin/attestations', 440, 3),
  ('ADMIN_VERIFICATION_SETTINGS', 'VERIFICATION', 'Admin', 'Verification', 'إعدادات التحقق', 'Verification Settings', 'shield-check', 'admin/verification', 450, 4),

  -- Company administration: performance
  ('ADMIN_PERFORMANCE_CYCLES', 'PERFORMANCE', 'Admin', 'Performance', 'دورات التقييم', 'Evaluation Cycles', 'refresh-cw', 'admin/cycles', 460, 4),
  ('ADMIN_EVALUATION_TEMPLATES', 'PERFORMANCE', 'Admin', 'Performance', 'قوالب التقييم', 'Evaluation Templates', 'file-spreadsheet', 'admin/evaluation-templates', 470, 4),
  ('ADMIN_GOALS', 'PERFORMANCE', 'Admin', 'Performance', 'بنك الأهداف', 'Goal Bank', 'target', 'admin/goals', 480, 4),
  ('ADMIN_COMPETENCIES', 'PERFORMANCE', 'Admin', 'Performance', 'بنك الجدارات', 'Competency Bank', 'brain', 'admin/competencies', 490, 4),
  ('ADMIN_PROFICIENCY', 'PERFORMANCE', 'Admin', 'Performance', 'مستويات الإتقان', 'Proficiency Levels', 'bar-chart-2', 'admin/proficiency', 500, 4),
  ('ADMIN_PERFORMANCE_DASHBOARD', 'PERFORMANCE', 'Admin', 'Performance', 'لوحة الأداء', 'Performance Dashboard', 'line-chart', 'admin/performance', 510, 3),

  -- Company administration: settings
  ('ADMIN_SETTINGS', null, 'Admin', 'Settings', 'إعدادات الشركة', 'Company Settings', 'settings', 'admin/settings', 520, 4),
  ('ADMIN_LOOKUPS', null, 'Admin', 'Settings', 'القوائم المرجعية', 'Lookups', 'list', 'admin/lookups', 530, 4),
  ('ADMIN_EMAIL_TEMPLATES', null, 'Admin', 'Settings', 'قوالب الرسائل', 'Email Templates', 'mail', 'admin/email-templates', 540, 4),
  ('ADMIN_EMAIL_QUEUE', null, 'Admin', 'Settings', 'طابور الرسائل', 'Email Queue', 'send', 'admin/email-queue', 550, 4),
  ('ADMIN_IMPORTS', null, 'Admin', 'Settings', 'استيراد البيانات', 'Data Import', 'upload', 'admin/imports', 560, 4),
  ('ADMIN_STORAGE', null, 'Admin', 'Settings', 'التخزين', 'Storage', 'hard-drive', 'admin/storage', 570, 4),
  ('ADMIN_NOTIFICATIONS', null, 'Admin', 'Settings', 'إعدادات الإشعارات', 'Notification Settings', 'bell-ring', 'admin/notifications', 580, 4),
  ('ADMIN_SUPPORT', 'SUPPORT', 'Admin', 'Settings', 'تذاكر الدعم', 'Support Tickets', 'life-buoy', 'admin/support', 590, 4),

  -- Platform operator console
  ('PLATFORM_OVERVIEW', null, 'Platform', 'Platform', 'لوحة المنصة', 'Platform Overview', 'layout-dashboard', 'platform/overview', 610, 4),
  ('PLATFORM_TENANTS', null, 'Platform', 'Platform', 'الشركات', 'Companies', 'building', 'platform/tenants', 620, 4),
  ('PLATFORM_LICENSES', null, 'Platform', 'Platform', 'التراخيص', 'Licenses', 'key', 'platform/licenses', 630, 4),
  ('PLATFORM_MODULES', null, 'Platform', 'Platform', 'الوحدات', 'Modules', 'blocks', 'platform/modules', 640, 4),
  ('PLATFORM_QUOTAS', null, 'Platform', 'Platform', 'حدود الاستخدام', 'Company Limits', 'gauge', 'platform/quotas', 650, 4),
  ('PLATFORM_STORAGE', null, 'Platform', 'Platform', 'إدارة التخزين', 'Storage Management', 'database', 'platform/storage', 660, 4),
  ('PLATFORM_SUPPORT', null, 'Platform', 'Platform', 'مركز الدعم', 'Support Console', 'headphones', 'platform/support', 670, 4),
  ('PLATFORM_HEALTH', null, 'Platform', 'Platform', 'صحة النظام', 'System Health', 'activity', 'platform/health', 680, 4),
  ('PLATFORM_USAGE', null, 'Platform', 'Platform', 'إحصائيات الاستخدام', 'Usage Statistics', 'trending-up', 'platform/usage', 690, 4),
  ('PLATFORM_SECURITY', null, 'Platform', 'Platform', 'الأمن', 'Security', 'shield-alert', 'platform/security', 700, 4),
  ('PLATFORM_SCREENS', null, 'Platform', 'Platform', 'سجل الشاشات', 'Screen Registry', 'layout-grid', 'platform/screens', 710, 4),
  ('PLATFORM_AUDIT', null, 'Platform', 'Platform', 'سجل التدقيق', 'Audit Log', 'file-search', 'platform/audit', 720, 4)
on conflict (code) do update set
  module_code = excluded.module_code,
  area = excluded.area,
  group_code = excluded.group_code,
  name_ar = excluded.name_ar,
  name_en = excluded.name_en,
  icon = excluded.icon,
  route = excluded.route,
  display_order = excluded.display_order,
  min_role_rank = excluded.min_role_rank,
  updated_on = now();

-- ----------------------------------------------------------------------------
-- 10. Screen RPCs
-- ----------------------------------------------------------------------------

-- What the sidebar renders: the licensed modules, minus what the role override
-- switched off, plus what it switched on above the default rank.
create or replace function public.my_screens()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select public.current_tenant_id() as tenant_id,
           public.current_content_access_rank() as rank,
           public.is_platform_operator() as is_operator
  ),
  my_roles as (
    select ur.role_id
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.is_active and not r.is_deleted
    where ur.user_id = auth.uid()
      and r.tenant_id = (select tenant_id from me)
  ),
  overrides as (
    select rs.screen_code, bool_or(rs.is_enabled) as any_enabled
    from public.role_screens rs
    join my_roles mr on mr.role_id = rs.role_id
    where rs.tenant_id = (select tenant_id from me) and not rs.is_deleted
    group by rs.screen_code
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', s.code,
    'area', s.area,
    'group_code', s.group_code,
    'module_code', s.module_code,
    'name_ar', s.name_ar,
    'name_en', s.name_en,
    'icon', s.icon,
    'route', s.route,
    'display_order', s.display_order
  ) order by s.area, s.display_order, s.code), '[]'::jsonb)
  from public.app_screens s
  cross join me
  left join overrides o on o.screen_code = s.code
  where s.is_active
    and (s.module_code is null or public.tenant_has_module(s.module_code, me.tenant_id))
    and (s.area <> 'Platform' or me.is_operator)
    and coalesce(o.any_enabled, me.rank >= s.min_role_rank);
$$;
grant execute on function public.my_screens() to authenticated;

-- The whole matrix for the assignment screen, in one call.
create or replace function public.role_screens_matrix()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  if not (public.has_permission('Screens.Manage') or public.has_permission('Roles.View')) then
    raise exception 'PERMISSION_DENIED';
  end if;

  return jsonb_build_object(
    'screens', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', s.code, 'area', s.area, 'group_code', s.group_code,
        'module_code', s.module_code,
        'module_enabled', s.module_code is null or public.tenant_has_module(s.module_code, v_tenant),
        'name_ar', s.name_ar, 'name_en', s.name_en, 'icon', s.icon,
        'route', s.route, 'display_order', s.display_order, 'min_role_rank', s.min_role_rank
      ) order by s.area, s.display_order, s.code)
      from public.app_screens s
      where s.is_active
        and (s.area <> 'Platform' or public.is_platform_operator())
    ), '[]'::jsonb),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'code', r.code, 'name_ar', r.name_ar, 'name_en', r.name_en,
        'is_system', r.is_system
      ) order by r.code)
      from public.roles r
      where r.tenant_id = v_tenant and not r.is_deleted and r.is_active
    ), '[]'::jsonb),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'role_id', rs.role_id, 'screen_code', rs.screen_code, 'is_enabled', rs.is_enabled
      ))
      from public.role_screens rs
      where rs.tenant_id = v_tenant and not rs.is_deleted
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.role_screens_matrix() to authenticated;

-- Replaces the whole override set of one role. An empty array means "no
-- override", which puts the role back on the default rank behaviour.
create or replace function public.role_screens_save(p_role_id uuid, p_screens jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_input jsonb := coalesce(p_screens, '[]'::jsonb);
  v_bad integer := 0;
  v_count integer := 0;
begin
  if v_tenant is null then raise exception 'NO_TENANT_CONTEXT'; end if;
  if not public.has_permission('Screens.Manage') then raise exception 'PERMISSION_DENIED'; end if;

  if jsonb_typeof(v_input) <> 'array' then
    raise exception 'SCREENS_PAYLOAD_INVALID';
  end if;

  if not exists (
    select 1 from public.roles
    where id = p_role_id and tenant_id = v_tenant and not is_deleted
  ) then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  -- The payload is either ["CODE", ...] or [{"code": "...", "is_enabled": bool}, ...].
  select count(*) into v_bad
  from (
    select case when jsonb_typeof(e.value) = 'string' then e.value #>> '{}' else e.value ->> 'code' end as code
    from jsonb_array_elements(v_input) as e(value)
  ) x
  where coalesce(x.code, '') = ''
     or not exists (select 1 from public.app_screens s where s.code = x.code);

  if v_bad > 0 then raise exception 'SCREEN_NOT_FOUND'; end if;

  delete from public.role_screens rs
  where rs.tenant_id = v_tenant
    and rs.role_id = p_role_id
    and rs.screen_code not in (
      select case when jsonb_typeof(e.value) = 'string' then e.value #>> '{}' else e.value ->> 'code' end
      from jsonb_array_elements(v_input) as e(value)
    );

  insert into public.role_screens (tenant_id, role_id, screen_code, is_enabled)
  select distinct on (x.code) v_tenant, p_role_id, x.code, x.is_enabled
  from (
    select
      case when jsonb_typeof(e.value) = 'string' then e.value #>> '{}' else e.value ->> 'code' end as code,
      case when jsonb_typeof(e.value) = 'string' then true
           else coalesce((e.value ->> 'is_enabled')::boolean, true) end as is_enabled
    from jsonb_array_elements(v_input) as e(value)
  ) x
  on conflict (tenant_id, role_id, screen_code) do update
    set is_enabled = excluded.is_enabled, is_deleted = false;

  select jsonb_array_length(v_input) into v_count;

  return jsonb_build_object('role_id', p_role_id, 'screens', v_count);
end;
$$;
grant execute on function public.role_screens_save(uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 11. Platform operator console
--
--     These read and write across every company, so each one starts with
--     is_platform_operator(); there is no RLS behind a definer function.
-- ----------------------------------------------------------------------------

create or replace function public.platform_write_audit(
  p_tenant_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_old jsonb,
  p_new jsonb
)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  insert into public.audit_logs (tenant_id, actor_id, action, entity_type, entity_id, old_data, new_data, ip_address)
  values (p_tenant_id, auth.uid(), p_action, p_entity_type, p_entity_id, p_old, p_new, public.request_client_ip());
$$;
revoke all on function public.platform_write_audit(uuid, text, text, text, jsonb, jsonb) from public;

create or replace function public.platform_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_chat bigint;
  v_notifications bigint;
begin
  if not public.is_platform_operator() then raise exception 'PERMISSION_DENIED'; end if;

  -- Modules that ship in their own migrations are counted only when present.
  if to_regclass('public.chat_messages') is not null then
    begin
      execute 'select count(*) from public.chat_messages' into v_chat;
    exception when others then v_chat := null;
    end;
  end if;
  if to_regclass('public.notifications') is not null then
    begin
      execute 'select count(*) from public.notifications' into v_notifications;
    exception when others then v_notifications := null;
    end;
  end if;

  return jsonb_build_object(
    'tenants', (
      select jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (where status = 'Active'),
        'pending', count(*) filter (where status = 'Pending'),
        'suspended', count(*) filter (where status = 'Suspended'),
        'disabled', count(*) filter (where status = 'Disabled'),
        'platform', count(*) filter (where is_platform),
        'new_30d', count(*) filter (where created_on > now() - interval '30 days')
      )
      from public.tenants where not is_deleted
    ),
    'users', (
      select jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (where is_active),
        'active_30d', count(*) filter (where last_login_on > now() - interval '30 days'),
        'never_logged_in', count(*) filter (where last_login_on is null)
      )
      from public.users where not is_deleted
    ),
    'storage', (
      select jsonb_build_object(
        'bytes', coalesce(sum(file_size), 0),
        'files', count(*),
        'core_bytes', coalesce(sum(file_size) filter (where layer = 'Core'), 0),
        'extended_bytes', coalesce(sum(file_size) filter (where layer = 'Extended'), 0)
      )
      from public.storage_objects where not is_deleted
    ),
    'forms', (
      select jsonb_build_object(
        'total', count(*),
        'submitted', count(*) filter (where submitted_on is not null),
        'submitted_30d', count(*) filter (where submitted_on > now() - interval '30 days'),
        'approved', count(*) filter (where status = 'Approved')
      )
      from public.forms where not is_deleted
    ),
    'emails', (
      select jsonb_build_object(
        'sent', count(*) filter (where status = 'Sent'),
        'pending', count(*) filter (where status in ('Pending', 'Retry')),
        'failed', count(*) filter (where status = 'Failed'),
        'sent_30d', count(*) filter (where status = 'Sent' and sent_on > now() - interval '30 days')
      )
      from public.email_queue
    ),
    'support', (
      select jsonb_build_object(
        'open', count(*) filter (where status <> 'Closed'),
        'unanswered', count(*) filter (where first_response_on is null and status <> 'Closed'),
        'closed', count(*) filter (where status = 'Closed'),
        'total', count(*)
      )
      from public.support_tickets where not is_deleted
    ),
    'chat_messages', v_chat,
    'notifications', v_notifications,
    'logins', (
      select jsonb_build_object(
        'today', count(*) filter (where succeeded and attempted_on >= date_trunc('day', now())),
        'last_30d', count(*) filter (where succeeded and attempted_on > now() - interval '30 days'),
        'failures_24h', count(*) filter (where not succeeded and attempted_on > now() - interval '24 hours')
      )
      from public.login_attempts
    ),
    'top_tenants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tenant_id', t.id,
        'slug', t.slug,
        'status', t.status,
        'names', coalesce((select jsonb_object_agg(n.language_code, n.name)
                           from public.tenant_names n where n.tenant_id = t.id), '{}'::jsonb),
        'users', (select count(*) from public.users u where u.tenant_id = t.id and not u.is_deleted),
        'active_users', (select count(*) from public.users u
                         where u.tenant_id = t.id and not u.is_deleted
                           and u.last_login_on > now() - interval '30 days'),
        'storage_bytes', (select coalesce(sum(o.file_size), 0) from public.storage_objects o
                          where o.tenant_id = t.id and not o.is_deleted),
        'license_code', t.license_code,
        'created_on', t.created_on
      ) order by (select count(*) from public.users u where u.tenant_id = t.id and not u.is_deleted) desc)
      from public.tenants t
      where not t.is_deleted
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.platform_overview() to authenticated;

-- The company card.
create or replace function public.platform_tenant_detail(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_t public.tenants%rowtype;
  v_license_modules text[];
begin
  if not public.is_platform_operator() then raise exception 'PERMISSION_DENIED'; end if;

  select * into v_t from public.tenants where id = p_tenant_id;
  if not found then raise exception 'TENANT_NOT_FOUND'; end if;

  select coalesce(module_codes, '{}') into v_license_modules
  from public.platform_licenses where code = v_t.license_code;

  return jsonb_build_object(
    'tenant', to_jsonb(v_t),
    'names', coalesce((select jsonb_object_agg(n.language_code, n.name)
                       from public.tenant_names n where n.tenant_id = v_t.id), '{}'::jsonb),
    'branding', coalesce((select to_jsonb(b) from public.tenant_branding b where b.tenant_id = v_t.id), '{}'::jsonb),
    'settings', coalesce((select to_jsonb(s) from public.tenant_settings s where s.tenant_id = v_t.id), '{}'::jsonb),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object('channel', c.channel, 'value', c.value, 'display_order', c.display_order)
                       order by c.display_order)
      from public.tenant_contacts c where c.tenant_id = v_t.id
    ), '[]'::jsonb),
    'license', coalesce((select to_jsonb(l) from public.platform_licenses l where l.code = v_t.license_code), '{}'::jsonb),
    'licenses', coalesce((
      select jsonb_agg(jsonb_build_object('code', l.code, 'name_ar', l.name_ar, 'name_en', l.name_en)
                       order by l.display_order)
      from public.platform_licenses l where l.is_active
    ), '[]'::jsonb),
    'modules', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', m.code, 'name_ar', m.name_ar, 'name_en', m.name_en,
        'category', m.category, 'is_core', m.is_core,
        'in_license', m.code = any (v_license_modules),
        'enabled', public.tenant_has_module(m.code, v_t.id),
        'override', (select tm.is_enabled from public.tenant_modules tm
                     where tm.tenant_id = v_t.id and tm.module_code = m.code)
      ) order by m.display_order)
      from public.platform_modules m where m.is_active
    ), '[]'::jsonb),
    'quotas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', r.code, 'name_ar', r.name_ar, 'name_en', r.name_en, 'unit', r.unit,
        'limit', coalesce(q.limit_value, 0),
        'used', coalesce(q.used_value, 0),
        'enforced', coalesce(q.is_enforced, true),
        'percent', case when coalesce(q.limit_value, 0) > 0
                        then round((coalesce(q.used_value, 0)::numeric * 100) / q.limit_value, 2)
                        else null end
      ) order by r.display_order)
      from public.platform_quota_resources r
      left join public.tenant_quotas q on q.tenant_id = v_t.id and q.resource_code = r.code
      where r.is_active
    ), '[]'::jsonb),
    'users', (
      select jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (where is_active),
        'invited', count(*) filter (where invitation_sent and invitation_accepted_on is null),
        'active_30d', count(*) filter (where last_login_on > now() - interval '30 days'),
        'last_login', max(last_login_on)
      )
      from public.users where tenant_id = v_t.id and not is_deleted
    ),
    'storage', (
      select jsonb_build_object(
        'files', count(*),
        'bytes', coalesce(sum(file_size), 0),
        'images', count(*) filter (where mime_type like 'image/%'),
        'documents', count(*) filter (where mime_type like 'application/%' or mime_type like 'text/%'),
        'chat_attachments', count(*) filter (where entity_type = 'ChatMessage'),
        'provider', (select c.provider_code from public.tenant_storage_config c where c.tenant_id = v_t.id),
        'allocated', coalesce((select nullif(c.quota_bytes, 0) from public.tenant_storage_config c where c.tenant_id = v_t.id),
                              (select q.limit_value from public.tenant_quotas q
                               where q.tenant_id = v_t.id and q.resource_code = 'STORAGE_BYTES'), 0),
        'status', coalesce((select case when c.provider_code is null then 'NotConfigured'
                                        when not c.is_enabled then 'Suspended'
                                        else coalesce(c.last_check_status, 'Unknown') end
                            from public.tenant_storage_config c where c.tenant_id = v_t.id), 'NotConfigured')
      )
      from public.storage_objects where tenant_id = v_t.id and not is_deleted
    ),
    'activity', jsonb_build_object(
      'created_on', v_t.created_on,
      'activated_on', v_t.activated_on,
      'last_login', (select max(last_login_on) from public.users where tenant_id = v_t.id),
      'last_form_on', (select max(updated_on) from public.forms where tenant_id = v_t.id),
      'forms_30d', (select count(*) from public.forms
                    where tenant_id = v_t.id and created_on > now() - interval '30 days'),
      'emails_30d', (select count(*) from public.email_queue
                     where tenant_id = v_t.id and created_on > now() - interval '30 days'),
      'open_tickets', (select count(*) from public.support_tickets
                       where (tenant_id = v_t.id or requester_tenant_id = v_t.id)
                         and status <> 'Closed' and not is_deleted)
    ),
    'usage', coalesce((
      select jsonb_agg(jsonb_build_object(
        'usage_date', d.usage_date, 'metric_code', d.metric_code, 'metric_value', d.metric_value
      ) order by d.usage_date desc, d.metric_code)
      from public.tenant_usage_daily d
      where d.tenant_id = v_t.id and d.usage_date > current_date - 30
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.platform_tenant_detail(uuid) to authenticated;

create or replace function public.platform_set_tenant_status(
  p_tenant_id uuid,
  p_status text,
  p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_old public.tenants%rowtype;
  v_status text := trim(coalesce(p_status, ''));
begin
  if not public.is_platform_operator() then raise exception 'PERMISSION_DENIED'; end if;
  if v_status not in ('Pending', 'Active', 'Suspended', 'Disabled', 'Deleted') then
    raise exception 'STATUS_INVALID';
  end if;

  select * into v_old from public.tenants where id = p_tenant_id;
  if not found then raise exception 'TENANT_NOT_FOUND'; end if;
  if v_old.is_platform and v_status <> 'Active' then raise exception 'PLATFORM_TENANT_IMMUTABLE'; end if;

  update public.tenants
  set status = v_status,
      activated_on = case when v_status = 'Active' then coalesce(activated_on, now()) else activated_on end,
      suspended_on = case when v_status in ('Suspended', 'Disabled') then now() else null end,
      suspended_reason = case when v_status in ('Suspended', 'Disabled') then p_reason else null end,
      is_deleted = (v_status = 'Deleted'),
      deleted_date = case when v_status = 'Deleted' then coalesce(deleted_date, now()) else null end,
      deleted_by = case when v_status = 'Deleted' then coalesce(deleted_by, auth.uid()) else null end,
      updated_by = auth.uid(),
      updated_on = now()
  where id = p_tenant_id;

  perform public.platform_write_audit(
    p_tenant_id, 'PLATFORM_SET_TENANT_STATUS', 'tenants', p_tenant_id::text,
    jsonb_build_object('status', v_old.status),
    jsonb_build_object('status', v_status, 'reason', p_reason)
  );

  return jsonb_build_object('tenant_id', p_tenant_id, 'status', v_status);
end;
$$;
grant execute on function public.platform_set_tenant_status(uuid, text, text) to authenticated;

create or replace function public.platform_set_module(
  p_tenant_id uuid,
  p_module_code text,
  p_enabled boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_old boolean;
begin
  if not public.is_platform_operator() then raise exception 'PERMISSION_DENIED'; end if;
  if not exists (select 1 from public.tenants where id = p_tenant_id) then
    raise exception 'TENANT_NOT_FOUND';
  end if;
  if not exists (select 1 from public.platform_modules where code = p_module_code) then
    raise exception 'MODULE_NOT_FOUND';
  end if;

  select is_enabled into v_old from public.tenant_modules
  where tenant_id = p_tenant_id and module_code = p_module_code;

  insert into public.tenant_modules (tenant_id, module_code, is_enabled, enabled_by, updated_on)
  values (p_tenant_id, p_module_code, coalesce(p_enabled, true), auth.uid(), now())
  on conflict (tenant_id, module_code) do update
    set is_enabled = excluded.is_enabled, enabled_by = excluded.enabled_by, updated_on = now();

  perform public.platform_write_audit(
    p_tenant_id, 'PLATFORM_SET_MODULE', 'tenant_modules', p_module_code,
    jsonb_build_object('module_code', p_module_code, 'is_enabled', v_old),
    jsonb_build_object('module_code', p_module_code, 'is_enabled', coalesce(p_enabled, true))
  );

  return jsonb_build_object('tenant_id', p_tenant_id, 'module_code', p_module_code, 'enabled', coalesce(p_enabled, true));
end;
$$;
grant execute on function public.platform_set_module(uuid, text, boolean) to authenticated;

create or replace function public.platform_set_quota(
  p_tenant_id uuid,
  p_resource text,
  p_limit bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_old bigint;
begin
  if not public.is_platform_operator() then raise exception 'PERMISSION_DENIED'; end if;
  if not exists (select 1 from public.tenants where id = p_tenant_id) then
    raise exception 'TENANT_NOT_FOUND';
  end if;
  if not exists (select 1 from public.platform_quota_resources where code = p_resource) then
    raise exception 'QUOTA_RESOURCE_NOT_FOUND';
  end if;
  if coalesce(p_limit, 0) < 0 then raise exception 'QUOTA_LIMIT_INVALID'; end if;

  select limit_value into v_old from public.tenant_quotas
  where tenant_id = p_tenant_id and resource_code = p_resource;

  insert into public.tenant_quotas (tenant_id, resource_code, limit_value)
  values (p_tenant_id, p_resource, coalesce(p_limit, 0))
  on conflict (tenant_id, resource_code) do update
    set limit_value = excluded.limit_value, updated_on = now();

  -- Storage keeps its own copy for the storage screens.
  if p_resource = 'STORAGE_BYTES' then
    update public.tenant_storage_config
    set quota_bytes = coalesce(p_limit, 0)
    where tenant_id = p_tenant_id;
  end if;

  perform public.platform_write_audit(
    p_tenant_id, 'PLATFORM_SET_QUOTA', 'tenant_quotas', p_resource,
    jsonb_build_object('resource', p_resource, 'limit', v_old),
    jsonb_build_object('resource', p_resource, 'limit', coalesce(p_limit, 0))
  );

  return jsonb_build_object('tenant_id', p_tenant_id, 'resource', p_resource, 'limit', coalesce(p_limit, 0));
end;
$$;
grant execute on function public.platform_set_quota(uuid, text, bigint) to authenticated;

create or replace function public.platform_set_license(p_tenant_id uuid, p_license_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_old text;
  v_license public.platform_licenses%rowtype;
begin
  if not public.is_platform_operator() then raise exception 'PERMISSION_DENIED'; end if;

  select * into v_license from public.platform_licenses where code = p_license_code and is_active;
  if not found then raise exception 'LICENSE_NOT_FOUND'; end if;

  select license_code into v_old from public.tenants where id = p_tenant_id;
  if v_old is null then raise exception 'TENANT_NOT_FOUND'; end if;

  update public.tenants
  set license_code = p_license_code, updated_by = auth.uid(), updated_on = now()
  where id = p_tenant_id;

  -- A new license grants modules and raises limits; existing overrides that
  -- switched a module off are left alone.
  insert into public.tenant_modules (tenant_id, module_code, is_enabled)
  select p_tenant_id, m.code, true
  from public.platform_modules m
  where m.code = any (v_license.module_codes)
  on conflict (tenant_id, module_code) do nothing;

  insert into public.tenant_quotas (tenant_id, resource_code, limit_value)
  select p_tenant_id, r.code, coalesce((v_license.quota_defaults ->> r.code)::bigint, 0)
  from public.platform_quota_resources r
  on conflict (tenant_id, resource_code) do update
    set limit_value = excluded.limit_value, updated_on = now();

  update public.tenant_storage_config
  set quota_bytes = coalesce((v_license.quota_defaults ->> 'STORAGE_BYTES')::bigint, quota_bytes)
  where tenant_id = p_tenant_id;

  perform public.platform_write_audit(
    p_tenant_id, 'PLATFORM_SET_LICENSE', 'tenants', p_tenant_id::text,
    jsonb_build_object('license_code', v_old),
    jsonb_build_object('license_code', p_license_code)
  );

  return jsonb_build_object('tenant_id', p_tenant_id, 'license_code', p_license_code);
end;
$$;
grant execute on function public.platform_set_license(uuid, text) to authenticated;

-- System Health. Postgres cannot see the host CPU or memory, so those are
-- returned as null and the screen labels them unavailable instead of inventing
-- a number.
create or replace function public.platform_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_db_size bigint;
  v_tables bigint;
  v_rows bigint;
begin
  if not public.is_platform_operator() then raise exception 'PERMISSION_DENIED'; end if;

  select pg_database_size(current_database()) into v_db_size;
  select count(*), coalesce(sum(n_live_tup), 0) into v_tables, v_rows
  from pg_stat_user_tables where schemaname = 'public';

  return jsonb_build_object(
    'measured_on', now(),
    'host', jsonb_build_object('cpu_percent', null, 'memory_percent', null, 'available', false),
    'database', jsonb_build_object(
      'name', current_database(),
      'size_bytes', v_db_size,
      'tables', v_tables,
      'live_rows', v_rows,
      'connections', (select count(*) from pg_stat_activity where datname = current_database()),
      'largest_tables', coalesce((
        select jsonb_agg(jsonb_build_object(
          'table', relname,
          'rows', n_live_tup,
          'size_bytes', pg_total_relation_size(relid)
        ) order by pg_total_relation_size(relid) desc)
        from (
          select relid, relname, n_live_tup
          from pg_stat_user_tables where schemaname = 'public'
          order by pg_total_relation_size(relid) desc limit 10
        ) t
      ), '[]'::jsonb)
    ),
    'storage', (
      select jsonb_build_object(
        'files', count(*),
        'bytes', coalesce(sum(file_size), 0),
        'tenants_with_provider', (select count(*) from public.tenant_storage_config
                                  where provider_code is not null and is_enabled),
        'providers_failing', (select count(*) from public.tenant_storage_config
                              where last_check_status = 'Failed')
      )
      from public.storage_objects where not is_deleted
    ),
    'emails', jsonb_build_object(
      'by_status', coalesce((
        select jsonb_object_agg(status, cnt)
        from (select status, count(*) as cnt from public.email_queue group by status) s
      ), '{}'::jsonb),
      'queue_depth', (select count(*) from public.email_queue where status in ('Pending', 'Retry')),
      'failed', (select count(*) from public.email_queue where status = 'Failed'),
      'oldest_pending_on', (select min(created_on) from public.email_queue where status in ('Pending', 'Retry')),
      'stuck_processing', (select count(*) from public.email_queue
                           where status = 'Processing' and locked_on < now() - interval '30 minutes')
    ),
    'jobs', jsonb_build_object(
      'imports_failed', (select count(*) from public.import_jobs where status = 'Failed'),
      'imports_running', (select count(*) from public.import_jobs where status in ('Validating', 'Processing')),
      'last_usage_snapshot', (select max(usage_date) from public.tenant_usage_daily)
    ),
    'support', jsonb_build_object(
      'open', (select count(*) from public.support_tickets where status <> 'Closed' and not is_deleted),
      'unanswered_24h', (select count(*) from public.support_tickets
                         where first_response_on is null and status <> 'Closed'
                           and created_on < now() - interval '24 hours' and not is_deleted)
    ),
    'security', jsonb_build_object(
      'failed_logins_24h', (select count(*) from public.login_attempts
                            where not succeeded and attempted_on > now() - interval '24 hours'),
      'critical_events_7d', (select count(*) from public.security_events
                             where severity = 'Critical' and created_on > now() - interval '7 days')
    )
  );
end;
$$;
grant execute on function public.platform_health() to authenticated;

-- Recomputes today's rollup for every company and re-synchronises the counted
-- quotas. Meant for a nightly cron running as service_role; an operator may
-- also trigger it from the usage screen.
create or replace function public.tenant_usage_snapshot()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  r record;
  v_metrics jsonb;
  v_value bigint;
  v_tenants integer := 0;
begin
  if auth.uid() is not null and not public.is_platform_operator() then
    raise exception 'PERMISSION_DENIED';
  end if;

  for r in select id from public.tenants where not is_deleted loop
    v_metrics := jsonb_build_object(
      'USERS', (select count(*) from public.users where tenant_id = r.id and not is_deleted),
      'ACTIVE_USERS', (select count(*) from public.users
                       where tenant_id = r.id and not is_deleted and is_active),
      'ACTIVE_USERS_30D', (select count(*) from public.users
                           where tenant_id = r.id and not is_deleted
                             and last_login_on > now() - interval '30 days'),
      'LOGINS_TODAY', (select count(*) from public.login_attempts
                       where tenant_id = r.id and succeeded and attempted_on >= date_trunc('day', now())),
      'LOGINS_30D', (select count(*) from public.login_attempts
                     where tenant_id = r.id and succeeded and attempted_on > now() - interval '30 days'),
      'STORAGE_BYTES', (select coalesce(sum(file_size), 0) from public.storage_objects
                        where tenant_id = r.id and not is_deleted),
      'FILES', (select count(*) from public.storage_objects where tenant_id = r.id and not is_deleted),
      'FORMS_TOTAL', (select count(*) from public.forms where tenant_id = r.id and not is_deleted),
      'FORMS_SUBMITTED', (select count(*) from public.forms
                          where tenant_id = r.id and not is_deleted and submitted_on is not null),
      'EMAILS_SENT', (select count(*) from public.email_queue
                      where tenant_id = r.id and status = 'Sent'),
      'EMAILS_TODAY', (select count(*) from public.email_queue
                       where tenant_id = r.id and created_on >= date_trunc('day', now())),
      'DOCUMENTS', (select count(*) from public.content_items where tenant_id = r.id and not is_deleted),
      'OPEN_TICKETS', (select count(*) from public.support_tickets
                       where (tenant_id = r.id or requester_tenant_id = r.id)
                         and status <> 'Closed' and not is_deleted)
    );

    -- Modules delivered by other migrations contribute only when deployed.
    if to_regclass('public.chat_messages') is not null then
      begin
        execute 'select count(*) from public.chat_messages where tenant_id = $1' into v_value using r.id;
        v_metrics := v_metrics || jsonb_build_object('CHAT_MESSAGES', v_value);
      exception when others then null;
      end;
    end if;
    if to_regclass('public.notifications') is not null then
      begin
        execute 'select count(*) from public.notifications where tenant_id = $1' into v_value using r.id;
        v_metrics := v_metrics || jsonb_build_object('NOTIFICATIONS_SENT', v_value);
      exception when others then null;
      end;
    end if;

    insert into public.tenant_usage_daily (tenant_id, usage_date, metric_code, metric_value)
    select r.id, current_date, e.key, coalesce((e.value #>> '{}')::bigint, 0)
    from jsonb_each(v_metrics) as e(key, value)
    on conflict (tenant_id, usage_date, metric_code) do update
      set metric_value = excluded.metric_value;

    -- Keep the enforced counters honest.
    update public.tenant_quotas q
    set used_value = case q.resource_code
      when 'STORAGE_BYTES' then coalesce((v_metrics ->> 'STORAGE_BYTES')::bigint, q.used_value)
      when 'EMPLOYEES' then coalesce((v_metrics ->> 'USERS')::bigint, q.used_value)
      when 'FORMS' then coalesce((v_metrics ->> 'FORMS_TOTAL')::bigint, q.used_value)
      when 'DOCUMENTS' then coalesce((v_metrics ->> 'DOCUMENTS')::bigint, q.used_value)
      when 'DEPARTMENTS' then (select count(*) from public.departments where tenant_id = r.id and not is_deleted)
      when 'PROJECTS' then (select count(*) from public.projects where tenant_id = r.id and not is_deleted)
      when 'SITES' then (select count(*) from public.sites where tenant_id = r.id and not is_deleted)
      when 'TEMPLATES' then (select count(*) from public.templates where tenant_id = r.id and not is_deleted)
      when 'CHAT_MESSAGES' then coalesce((v_metrics ->> 'CHAT_MESSAGES')::bigint, q.used_value)
      when 'NOTIFICATIONS' then coalesce((v_metrics ->> 'NOTIFICATIONS_SENT')::bigint, q.used_value)
      else q.used_value
    end,
    updated_on = now()
    where q.tenant_id = r.id;

    v_tenants := v_tenants + 1;
  end loop;

  return jsonb_build_object('usage_date', current_date, 'tenants', v_tenants);
end;
$$;
-- The guard above lets a session without auth.uid() through, because that is
-- what the nightly service_role run looks like. EXECUTE therefore has to be
-- taken away from PUBLIC, otherwise an anonymous caller would match the same
-- branch and could rewrite every company's rollup on demand.
revoke all on function public.tenant_usage_snapshot() from public;
grant execute on function public.tenant_usage_snapshot() to service_role, authenticated;

-- Usage Statistics screen: the rollup plus the live figures it is compared to.
create or replace function public.platform_usage(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days integer := greatest(least(coalesce(p_days, 30), 365), 1);
begin
  if not public.is_platform_operator() then raise exception 'PERMISSION_DENIED'; end if;

  return jsonb_build_object(
    'from', current_date - v_days,
    'to', current_date,
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'usage_date', d.usage_date, 'metric_code', d.metric_code, 'metric_value', d.total
      ) order by d.usage_date, d.metric_code)
      from (
        select usage_date, metric_code, sum(metric_value) as total
        from public.tenant_usage_daily
        where usage_date > current_date - v_days
        group by usage_date, metric_code
      ) d
    ), '[]'::jsonb),
    'by_tenant', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tenant_id', t.id,
        'slug', t.slug,
        'metrics', coalesce((
          select jsonb_object_agg(u.metric_code, u.metric_value)
          from public.tenant_usage_daily u
          where u.tenant_id = t.id and u.usage_date = (
            select max(usage_date) from public.tenant_usage_daily where tenant_id = t.id
          )
        ), '{}'::jsonb),
        'last_login', (select max(last_login_on) from public.users where tenant_id = t.id)
      ) order by t.slug)
      from public.tenants t where not t.is_deleted
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.platform_usage(integer) to authenticated;
