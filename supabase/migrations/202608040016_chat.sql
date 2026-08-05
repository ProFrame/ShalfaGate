-- ============================================================================
-- 016 — Chat (bbnovix platform)
--
-- A Facebook-style chat dock: direct conversations, groups, presence,
-- Sent/Delivered/Read receipts, reply, forward, reactions, search and blocks.
--
-- Attachment policy: the platform never stores chat bytes. A message carries
-- only attachment METADATA (provider, external id/url, name, mime, size,
-- checksum, expiry); the bytes live in the tenant's own Extended Storage
-- provider. When the company has no provider configured, attachments are
-- refused with a code the UI can explain. A short-lived relay object is
-- modelled as state = 'PendingSync' plus expires_on, which chat_purge_expired
-- reaps.
--
-- Feature switches are the platform operator's, and they already exist:
-- tenant_modules('CHAT') plus tenant_settings.chat_* from migration 012.
-- Nothing here duplicates them.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Conversations
-- ----------------------------------------------------------------------------

create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null default 'Direct' check (kind in ('Direct', 'Group')),
  title text,
  avatar_url text,
  -- Deterministic "user_a:user_b" key. It is the only thing that makes
  -- "open the direct chat with X" idempotent under concurrent taps.
  direct_key text,
  last_message_id uuid,
  last_message_at timestamptz,
  last_message_preview text,
  is_archived boolean not null default false,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  constraint chat_conversations_direct_shape check (
    (kind = 'Direct' and direct_key is not null) or (kind = 'Group' and direct_key is null)
  )
);

create index if not exists idx_chat_conversations_tenant on public.chat_conversations (tenant_id);
create index if not exists idx_chat_conversations_recent
  on public.chat_conversations (tenant_id, last_message_at desc) where not is_deleted;
create unique index if not exists uq_chat_conversations_tenant_id
  on public.chat_conversations (tenant_id, id);
-- NULL direct_key rows (groups) never collide, so a plain unique index is enough.
create unique index if not exists uq_chat_conversations_direct
  on public.chat_conversations (tenant_id, direct_key);

-- ----------------------------------------------------------------------------
-- 2. Participants — membership, per-user conversation state
-- ----------------------------------------------------------------------------

create table if not exists public.chat_participants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null,
  user_id uuid not null,
  role text not null default 'Member' check (role in ('Owner', 'Admin', 'Member')),
  joined_on timestamptz not null default now(),
  left_on timestamptz,
  is_muted boolean not null default false,
  is_pinned boolean not null default false,
  last_read_message_id uuid,
  last_read_on timestamptz,
  unread_count integer not null default 0 check (unread_count >= 0),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  unique (conversation_id, user_id)
);

create index if not exists idx_chat_participants_tenant on public.chat_participants (tenant_id);
create index if not exists idx_chat_participants_user
  on public.chat_participants (tenant_id, user_id) where left_on is null and not is_deleted;
create index if not exists idx_chat_participants_conversation
  on public.chat_participants (conversation_id) where left_on is null and not is_deleted;

-- ----------------------------------------------------------------------------
-- 3. Messages
-- ----------------------------------------------------------------------------

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null,
  sender_id uuid not null,
  body text,
  message_type text not null default 'Text' check (message_type in ('Text', 'Attachment', 'System')),
  -- System rows carry a translation code in body and its variables in meta, so
  -- "X added Y" is rendered in the reader's language, never stored in one.
  meta jsonb not null default '{}'::jsonb,
  reply_to_id uuid references public.chat_messages(id) on delete set null,
  forwarded_from_id uuid references public.chat_messages(id) on delete set null,
  edited_on timestamptz,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_chat_messages_tenant on public.chat_messages (tenant_id);
create index if not exists idx_chat_messages_conversation
  on public.chat_messages (tenant_id, conversation_id, created_on desc);
create index if not exists idx_chat_messages_sender
  on public.chat_messages (tenant_id, sender_id, created_on desc);
-- Retention sweeps scan by age, not by conversation.
create index if not exists idx_chat_messages_tenant_created
  on public.chat_messages (tenant_id, created_on);
create unique index if not exists uq_chat_messages_tenant_id
  on public.chat_messages (tenant_id, id);

-- Search index: trigram when the extension can be installed (ILIKE '%q%' is
-- how the UI searches), otherwise a plain tsvector GIN so search still scales.
do $do$
begin
  begin
    create extension if not exists pg_trgm;
  exception when others then
    raise notice 'chat: pg_trgm unavailable (%), falling back to tsvector search index', sqlerrm;
  end;

  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    execute $ix$create index if not exists idx_chat_messages_body_trgm
              on public.chat_messages using gin (body gin_trgm_ops)$ix$;
  else
    execute $ix$create index if not exists idx_chat_messages_body_fts
              on public.chat_messages using gin (to_tsvector('simple', coalesce(body, '')))$ix$;
  end if;
end $do$;

-- The conversation header and the read cursor point back at a message. These
-- stay single-column FKs on purpose: a composite one would have to null
-- tenant_id when the message is purged.
do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_chat_conversations_last_message') then
    alter table public.chat_conversations
      add constraint fk_chat_conversations_last_message
      foreign key (last_message_id) references public.chat_messages(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_chat_participants_last_read_message') then
    alter table public.chat_participants
      add constraint fk_chat_participants_last_read_message
      foreign key (last_read_message_id) references public.chat_messages(id) on delete set null;
  end if;
end $do$;

-- ----------------------------------------------------------------------------
-- 4. Receipts — the only source of truth for Sent / Delivered / Read
-- ----------------------------------------------------------------------------

create table if not exists public.chat_message_receipts (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  message_id uuid not null,
  user_id uuid not null,
  delivered_on timestamptz,
  read_on timestamptz,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index if not exists idx_chat_message_receipts_tenant on public.chat_message_receipts (tenant_id);
create index if not exists idx_chat_message_receipts_unread
  on public.chat_message_receipts (user_id) where read_on is null;

-- ----------------------------------------------------------------------------
-- 5. Reactions
-- ----------------------------------------------------------------------------

create table if not exists public.chat_reactions (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  message_id uuid not null,
  user_id uuid not null,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create index if not exists idx_chat_reactions_tenant on public.chat_reactions (tenant_id);

-- ----------------------------------------------------------------------------
-- 6. Attachments — metadata only, never bytes
-- ----------------------------------------------------------------------------

create table if not exists public.chat_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  message_id uuid not null,
  storage_provider text not null default 'none'
    check (storage_provider in ('none', 'supabase', 'google_drive', 'onedrive', 's3', 'r2', 'b2', 'azure_blob')),
  external_id text,
  external_url text,
  file_name text not null,
  mime_type text,
  file_size bigint not null default 0 check (file_size >= 0),
  checksum text,
  state text not null default 'Ready' check (state in ('Ready', 'PendingSync', 'Expired', 'Failed')),
  -- Only meaningful for PendingSync relay objects: after this the object is
  -- purged and the row with it.
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

create index if not exists idx_chat_attachments_tenant on public.chat_attachments (tenant_id);
create index if not exists idx_chat_attachments_message on public.chat_attachments (message_id);
create index if not exists idx_chat_attachments_expiry
  on public.chat_attachments (expires_on) where expires_on is not null;

-- ----------------------------------------------------------------------------
-- 7. Blocks
-- ----------------------------------------------------------------------------

create table if not exists public.chat_blocks (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  blocker_id uuid not null,
  blocked_id uuid not null,
  reason text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  primary key (tenant_id, blocker_id, blocked_id),
  constraint chat_blocks_not_self check (blocker_id <> blocked_id)
);

create index if not exists idx_chat_blocks_tenant on public.chat_blocks (tenant_id);
create index if not exists idx_chat_blocks_blocked on public.chat_blocks (tenant_id, blocked_id);

-- ----------------------------------------------------------------------------
-- 8. Presence
-- ----------------------------------------------------------------------------

create table if not exists public.chat_presence (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null,
  status text not null default 'Offline' check (status in ('Online', 'Away', 'Busy', 'Offline')),
  last_seen_on timestamptz not null default now(),
  typing_in_conversation uuid references public.chat_conversations(id) on delete set null,
  typing_until timestamptz,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  primary key (user_id)
);

create index if not exists idx_chat_presence_tenant on public.chat_presence (tenant_id);

-- ----------------------------------------------------------------------------
-- 9. Cross-tenant guards
--    Composite keys make a conversation with a member of another company
--    structurally impossible. They cascade, so no second single-column FK is
--    needed (two FKs to the same parent would race on cascade).
-- ----------------------------------------------------------------------------

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_chat_participants_conversation_same_tenant') then
    alter table public.chat_participants
      add constraint fk_chat_participants_conversation_same_tenant
      foreign key (tenant_id, conversation_id) references public.chat_conversations (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_chat_participants_user_same_tenant') then
    alter table public.chat_participants
      add constraint fk_chat_participants_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_chat_messages_conversation_same_tenant') then
    alter table public.chat_messages
      add constraint fk_chat_messages_conversation_same_tenant
      foreign key (tenant_id, conversation_id) references public.chat_conversations (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_chat_messages_sender_same_tenant') then
    alter table public.chat_messages
      add constraint fk_chat_messages_sender_same_tenant
      foreign key (tenant_id, sender_id) references public.users (tenant_id, id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_chat_receipts_message_same_tenant') then
    alter table public.chat_message_receipts
      add constraint fk_chat_receipts_message_same_tenant
      foreign key (tenant_id, message_id) references public.chat_messages (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_chat_receipts_user_same_tenant') then
    alter table public.chat_message_receipts
      add constraint fk_chat_receipts_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_chat_reactions_message_same_tenant') then
    alter table public.chat_reactions
      add constraint fk_chat_reactions_message_same_tenant
      foreign key (tenant_id, message_id) references public.chat_messages (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_chat_reactions_user_same_tenant') then
    alter table public.chat_reactions
      add constraint fk_chat_reactions_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_chat_attachments_message_same_tenant') then
    alter table public.chat_attachments
      add constraint fk_chat_attachments_message_same_tenant
      foreign key (tenant_id, message_id) references public.chat_messages (tenant_id, id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_chat_blocks_blocker_same_tenant') then
    alter table public.chat_blocks
      add constraint fk_chat_blocks_blocker_same_tenant
      foreign key (tenant_id, blocker_id) references public.users (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_chat_blocks_blocked_same_tenant') then
    alter table public.chat_blocks
      add constraint fk_chat_blocks_blocked_same_tenant
      foreign key (tenant_id, blocked_id) references public.users (tenant_id, id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fk_chat_presence_user_same_tenant') then
    alter table public.chat_presence
      add constraint fk_chat_presence_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id) on delete cascade;
  end if;
end $do$;

-- ----------------------------------------------------------------------------
-- 10. Row defaults (tenant_id, audit columns, row_version) on every chat table
-- ----------------------------------------------------------------------------

do $do$
declare
  chat_tables text[] := array[
    'chat_conversations', 'chat_participants', 'chat_messages',
    'chat_message_receipts', 'chat_reactions', 'chat_attachments',
    'chat_blocks', 'chat_presence'
  ];
  tbl text;
begin
  foreach tbl in array chat_tables loop
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
end $do$;

-- ----------------------------------------------------------------------------
-- 11. Permissions
--     Chatting itself is membership based, never permission based; the
--     permission exists for moderation only.
-- ----------------------------------------------------------------------------

insert into public.permissions (code, module, description) values
  ('Chat.Manage', 'Chat', 'Moderate conversations, remove messages and manage chat policy')
on conflict (code) do nothing;

insert into public.role_permissions (tenant_id, role_id, permission_id)
select r.tenant_id, r.id, p.id
from public.roles r
join public.permissions p on p.code = 'Chat.Manage'
where r.code in ('PLATFORM_ADMIN', 'SYSTEM_ADMIN')
  and not r.is_deleted
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- 12. Access helpers
--     RLS on conversations must ask about participants and vice versa; these
--     definer helpers break the recursion the same way is_form_participant does.
-- ----------------------------------------------------------------------------

create or replace function public.chat_is_participant(p_conversation uuid, p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.chat_participants p
    where p.conversation_id = p_conversation
      and p.user_id = p_user
      and p.left_on is null
      and not p.is_deleted
      and p.tenant_id = public.current_tenant_id()
  );
$fn$;
grant execute on function public.chat_is_participant(uuid, uuid) to authenticated;

create or replace function public.chat_can_manage_conversation(p_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.chat_participants p
    where p.conversation_id = p_conversation
      and p.user_id = auth.uid()
      and p.left_on is null
      and not p.is_deleted
      and p.role in ('Owner', 'Admin')
      and p.tenant_id = public.current_tenant_id()
  );
$fn$;
grant execute on function public.chat_can_manage_conversation(uuid) to authenticated;

create or replace function public.chat_can_see_message(p_message uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.chat_messages m
    join public.chat_participants p
      on p.conversation_id = m.conversation_id
     and p.user_id = auth.uid()
     and p.left_on is null
     and not p.is_deleted
    where m.id = p_message
      and m.tenant_id = public.current_tenant_id()
  );
$fn$;
grant execute on function public.chat_can_see_message(uuid) to authenticated;

-- Every RPC starts here: module off means the whole feature is invisible.
create or replace function public.chat_assert_enabled()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  v_tenant := public.current_tenant_id();
  if v_tenant is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  if not public.tenant_has_module('CHAT') then
    raise exception 'CHAT_DISABLED';
  end if;
  return v_tenant;
end;
$fn$;
revoke all on function public.chat_assert_enabled() from public;

-- Names are returned raw so the client can localise with pickLocalized().
create or replace function public.chat_user_card(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    'id', u.id,
    'name_ar', u.name_ar,
    'name_en', u.name_en,
    'full_name', u.full_name,
    'avatar_url', u.avatar_url,
    'job_title_ar', u.job_title_ar,
    'job_title_en', u.job_title_en,
    'is_active', u.is_active
  )
  from public.users u
  where u.id = p_user
    and u.tenant_id = public.current_tenant_id();
$fn$;
revoke all on function public.chat_user_card(uuid) from public;

create or replace function public.chat_presence_card(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    'status', case
        when pr.status is null then 'Offline'
        when pr.status <> 'Offline' and pr.last_seen_on < now() - interval '5 minutes' then 'Away'
        else pr.status
      end,
    'last_seen_on', pr.last_seen_on,
    'typing_in_conversation', case when pr.typing_until > now() then pr.typing_in_conversation else null end
  )
  from public.chat_presence pr
  where pr.user_id = p_user
    and pr.tenant_id = public.current_tenant_id();
$fn$;
revoke all on function public.chat_presence_card(uuid) from public;

-- One shape for a message everywhere it is rendered.
create or replace function public.chat_message_json(p_message uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    'id', m.id,
    'conversation_id', m.conversation_id,
    'sender_id', m.sender_id,
    'sender', public.chat_user_card(m.sender_id),
    'body', case when m.is_deleted then null else m.body end,
    'message_type', m.message_type,
    'meta', m.meta,
    'is_deleted', m.is_deleted,
    'is_mine', m.sender_id = auth.uid(),
    'edited_on', m.edited_on,
    'created_on', m.created_on,
    'reply_to', case when m.reply_to_id is null then null else (
      select jsonb_build_object(
        'id', r.id,
        'sender_id', r.sender_id,
        'sender', public.chat_user_card(r.sender_id),
        'message_type', r.message_type,
        'body', case when r.is_deleted then null else left(coalesce(r.body, ''), 200) end
      )
      from public.chat_messages r where r.id = m.reply_to_id
    ) end,
    'forwarded_from_id', m.forwarded_from_id,
    'is_forwarded', m.forwarded_from_id is not null,
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'storage_provider', a.storage_provider,
        'external_id', a.external_id,
        'external_url', a.external_url,
        'file_name', a.file_name,
        'mime_type', a.mime_type,
        'file_size', a.file_size,
        'checksum', a.checksum,
        'state', a.state,
        'expires_on', a.expires_on
      ) order by a.created_on)
      from public.chat_attachments a
      where a.message_id = m.id and not a.is_deleted
    ), '[]'::jsonb),
    'reactions', coalesce((
      select jsonb_agg(jsonb_build_object('emoji', x.emoji, 'count', x.cnt, 'mine', x.mine) order by x.emoji)
      from (
        select rc.emoji, count(*) as cnt, bool_or(rc.user_id = auth.uid()) as mine
        from public.chat_reactions rc
        where rc.message_id = m.id and not rc.is_deleted
        group by rc.emoji
      ) x
    ), '[]'::jsonb),
    'recipient_count', (select count(*) from public.chat_message_receipts rr where rr.message_id = m.id),
    'delivered_count', (select count(*) from public.chat_message_receipts rr where rr.message_id = m.id and rr.delivered_on is not null),
    'read_count', (select count(*) from public.chat_message_receipts rr where rr.message_id = m.id and rr.read_on is not null),
    -- Sent / Delivered / Read is only meaningful to the sender.
    'state', case
      when m.sender_id <> auth.uid() then null
      when (select count(*) from public.chat_message_receipts rr where rr.message_id = m.id) = 0 then 'Sent'
      when not exists (select 1 from public.chat_message_receipts rr where rr.message_id = m.id and rr.read_on is null) then 'Read'
      when exists (select 1 from public.chat_message_receipts rr where rr.message_id = m.id and rr.delivered_on is not null) then 'Delivered'
      else 'Sent'
    end
  )
  from public.chat_messages m
  where m.id = p_message
    and m.tenant_id = public.current_tenant_id();
$fn$;
revoke all on function public.chat_message_json(uuid) from public;

-- System rows keep a translation code, never a rendered sentence.
create or replace function public.chat_write_system_message(
  p_conversation uuid,
  p_code text,
  p_meta jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id uuid;
begin
  insert into public.chat_messages (tenant_id, conversation_id, sender_id, body, message_type, meta)
  values (v_tenant, p_conversation, auth.uid(), p_code, 'System', coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;

  update public.chat_conversations c
  set last_message_id = v_id,
      last_message_at = now(),
      last_message_preview = p_code
  where c.id = p_conversation and c.tenant_id = v_tenant;

  return v_id;
end;
$fn$;
revoke all on function public.chat_write_system_message(uuid, text, jsonb) from public;

-- Fan-out shared by send and forward: receipts, unread counters, conversation
-- header and the notification for every participant who is not muted.
create or replace function public.chat_deliver(
  p_tenant uuid,
  p_conversation uuid,
  p_message uuid,
  p_sender uuid,
  p_preview text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_sender_name text;
  v_link text := 'chat?conversation=' || p_conversation::text;
  r record;
begin
  insert into public.chat_message_receipts (tenant_id, message_id, user_id)
  select p_tenant, p_message, p.user_id
  from public.chat_participants p
  where p.tenant_id = p_tenant
    and p.conversation_id = p_conversation
    and p.left_on is null
    and not p.is_deleted
    and p.user_id <> p_sender
  on conflict (message_id, user_id) do nothing;

  update public.chat_participants p
  set unread_count = p.unread_count + 1
  where p.tenant_id = p_tenant
    and p.conversation_id = p_conversation
    and p.left_on is null
    and not p.is_deleted
    and p.user_id <> p_sender;

  update public.chat_conversations c
  set last_message_id = p_message,
      last_message_at = now(),
      last_message_preview = p_preview
  where c.id = p_conversation and c.tenant_id = p_tenant;

  select coalesce(u.name_ar, u.name_en, u.full_name, u.email)
  into v_sender_name
  from public.users u where u.id = p_sender;

  for r in
    select p.user_id
    from public.chat_participants p
    where p.tenant_id = p_tenant
      and p.conversation_id = p_conversation
      and p.left_on is null
      and not p.is_deleted
      and not p.is_muted
      and p.user_id <> p_sender
  loop
    -- public.notify belongs to the notification module (migration 015). Its
    -- signature is (recipient, category, event_code, title_ar, title_en,
    -- body_ar, body_en, link, payload); the sender's name is the title in both
    -- languages because a person's name is not translated.
    begin
      perform public.notify(
        r.user_id,
        'Message',
        'ChatMessage',
        v_sender_name,
        v_sender_name,
        p_preview,
        p_preview,
        v_link,
        jsonb_build_object('conversation_id', p_conversation, 'message_id', p_message)
      );
    exception
      -- Keeps chat usable in an environment where the notification module has
      -- not been deployed yet; a missing bell must never lose a message.
      when undefined_function then null;
    end;
  end loop;
end;
$fn$;
revoke all on function public.chat_deliver(uuid, uuid, uuid, uuid, text) from public;

-- ----------------------------------------------------------------------------
-- 13. RLS policies
--     Writes to conversations, participants and messages happen through the
--     RPCs below; the client is deliberately given read paths plus the two
--     edits it owns (its own message, its own presence/reactions/blocks).
-- ----------------------------------------------------------------------------

drop policy if exists "participants read conversations" on public.chat_conversations;
create policy "participants read conversations" on public.chat_conversations
  for select to authenticated
  using (public.chat_is_participant(id) or public.has_permission('Chat.Manage'));

drop policy if exists "group managers update conversations" on public.chat_conversations;
create policy "group managers update conversations" on public.chat_conversations
  for update to authenticated
  using (public.chat_can_manage_conversation(id) or public.has_permission('Chat.Manage'))
  with check (public.chat_can_manage_conversation(id) or public.has_permission('Chat.Manage'));

drop policy if exists "participants read membership" on public.chat_participants;
create policy "participants read membership" on public.chat_participants
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.chat_is_participant(conversation_id)
    or public.has_permission('Chat.Manage')
  );

-- Owners and admins manage the roster. A member never edits its own row
-- directly: RLS cannot restrict columns, and that would let anyone promote
-- itself to Owner. Mute, pin and read state go through the RPCs.
drop policy if exists "group managers manage membership" on public.chat_participants;
create policy "group managers manage membership" on public.chat_participants
  for all to authenticated
  using (public.chat_can_manage_conversation(conversation_id) or public.has_permission('Chat.Manage'))
  with check (public.chat_can_manage_conversation(conversation_id) or public.has_permission('Chat.Manage'));

drop policy if exists "participants read messages" on public.chat_messages;
create policy "participants read messages" on public.chat_messages
  for select to authenticated
  using (public.chat_is_participant(conversation_id) or public.has_permission('Chat.Manage'));

drop policy if exists "senders edit own messages" on public.chat_messages;
create policy "senders edit own messages" on public.chat_messages
  for update to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid() and public.chat_is_participant(conversation_id));

drop policy if exists "chat moderators manage messages" on public.chat_messages;
create policy "chat moderators manage messages" on public.chat_messages
  for update to authenticated
  using (public.has_permission('Chat.Manage'))
  with check (public.has_permission('Chat.Manage'));

drop policy if exists "participants read receipts" on public.chat_message_receipts;
create policy "participants read receipts" on public.chat_message_receipts
  for select to authenticated
  using (public.chat_can_see_message(message_id));

drop policy if exists "recipients write own receipts" on public.chat_message_receipts;
create policy "recipients write own receipts" on public.chat_message_receipts
  for insert to authenticated
  with check (user_id = auth.uid() and public.chat_can_see_message(message_id));

drop policy if exists "recipients update own receipts" on public.chat_message_receipts;
create policy "recipients update own receipts" on public.chat_message_receipts
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "participants read reactions" on public.chat_reactions;
create policy "participants read reactions" on public.chat_reactions
  for select to authenticated
  using (public.chat_can_see_message(message_id));

drop policy if exists "participants manage own reactions" on public.chat_reactions;
create policy "participants manage own reactions" on public.chat_reactions
  for all to authenticated
  using (user_id = auth.uid() and public.chat_can_see_message(message_id))
  with check (user_id = auth.uid() and public.chat_can_see_message(message_id));

drop policy if exists "participants read attachments" on public.chat_attachments;
create policy "participants read attachments" on public.chat_attachments
  for select to authenticated
  using (public.chat_can_see_message(message_id));

-- The uploader flips PendingSync to Ready (or Failed) once the tenant provider
-- confirms the object.
drop policy if exists "senders sync own attachments" on public.chat_attachments;
create policy "senders sync own attachments" on public.chat_attachments
  for update to authenticated
  using (exists (select 1 from public.chat_messages m where m.id = message_id and m.sender_id = auth.uid()))
  with check (exists (select 1 from public.chat_messages m where m.id = message_id and m.sender_id = auth.uid()));

drop policy if exists "users manage own blocks" on public.chat_blocks;
create policy "users manage own blocks" on public.chat_blocks
  for all to authenticated
  using (blocker_id = auth.uid())
  with check (blocker_id = auth.uid());

drop policy if exists "members read presence" on public.chat_presence;
create policy "members read presence" on public.chat_presence
  for select to authenticated
  using (true);

drop policy if exists "users manage own presence" on public.chat_presence;
create policy "users manage own presence" on public.chat_presence
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 14. Conversations
-- ----------------------------------------------------------------------------

create or replace function public.chat_open_direct(p_other_user uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
  v_private boolean;
  v_key text;
  v_conversation uuid;
  v_created boolean := true;
begin
  select coalesce(s.chat_private_enabled, true) into v_private
  from public.tenant_settings s where s.tenant_id = v_tenant;
  if not coalesce(v_private, true) then
    raise exception 'PRIVATE_CHAT_DISABLED';
  end if;

  if p_other_user is null then
    raise exception 'USER_NOT_FOUND';
  end if;
  if p_other_user = v_uid then
    raise exception 'CANNOT_CHAT_WITH_SELF';
  end if;
  if not exists (
    select 1 from public.users u
    where u.id = p_other_user and u.tenant_id = v_tenant and not u.is_deleted and u.is_active
  ) then
    raise exception 'USER_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.chat_blocks b
    where b.tenant_id = v_tenant
      and ((b.blocker_id = v_uid and b.blocked_id = p_other_user)
        or (b.blocker_id = p_other_user and b.blocked_id = v_uid))
  ) then
    raise exception 'CONVERSATION_BLOCKED';
  end if;

  v_key := case when v_uid::text < p_other_user::text
                then v_uid::text || ':' || p_other_user::text
                else p_other_user::text || ':' || v_uid::text end;

  insert into public.chat_conversations (tenant_id, kind, direct_key, created_by)
  values (v_tenant, 'Direct', v_key, v_uid)
  on conflict (tenant_id, direct_key) do nothing
  returning id into v_conversation;

  if v_conversation is null then
    v_created := false;
    select c.id into v_conversation
    from public.chat_conversations c
    where c.tenant_id = v_tenant and c.direct_key = v_key;
  end if;

  -- Re-opening a direct chat also un-leaves it for both sides.
  insert into public.chat_participants (tenant_id, conversation_id, user_id, role)
  values (v_tenant, v_conversation, v_uid, 'Member'), (v_tenant, v_conversation, p_other_user, 'Member')
  on conflict (conversation_id, user_id) do update
    set left_on = null, is_deleted = false;

  update public.chat_conversations set is_deleted = false, is_archived = false
  where id = v_conversation and tenant_id = v_tenant and (is_deleted or is_archived);

  return jsonb_build_object(
    'id', v_conversation,
    'kind', 'Direct',
    'created', v_created,
    'other_user', public.chat_user_card(p_other_user),
    'presence', public.chat_presence_card(p_other_user)
  );
end;
$fn$;
grant execute on function public.chat_open_direct(uuid) to authenticated;

create or replace function public.chat_create_group(p_title text, p_member_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
  v_groups boolean;
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
  v_conversation uuid;
  v_added uuid[] := '{}';
  v_member uuid;
begin
  select coalesce(s.chat_groups_enabled, true) into v_groups
  from public.tenant_settings s where s.tenant_id = v_tenant;
  if not coalesce(v_groups, true) then
    raise exception 'GROUPS_DISABLED';
  end if;

  if v_title is null then
    raise exception 'TITLE_REQUIRED';
  end if;

  insert into public.chat_conversations (tenant_id, kind, title, created_by)
  values (v_tenant, 'Group', v_title, v_uid)
  returning id into v_conversation;

  insert into public.chat_participants (tenant_id, conversation_id, user_id, role)
  values (v_tenant, v_conversation, v_uid, 'Owner');

  foreach v_member in array coalesce(p_member_ids, '{}'::uuid[]) loop
    if v_member is null or v_member = v_uid then
      continue;
    end if;
    if not exists (
      select 1 from public.users u
      where u.id = v_member and u.tenant_id = v_tenant and not u.is_deleted and u.is_active
    ) then
      continue;
    end if;
    if exists (
      select 1 from public.chat_blocks b
      where b.tenant_id = v_tenant
        and ((b.blocker_id = v_uid and b.blocked_id = v_member)
          or (b.blocker_id = v_member and b.blocked_id = v_uid))
    ) then
      continue;
    end if;

    insert into public.chat_participants (tenant_id, conversation_id, user_id, role)
    values (v_tenant, v_conversation, v_member, 'Member')
    on conflict (conversation_id, user_id) do nothing;
    v_added := v_added || v_member;
  end loop;

  perform public.chat_write_system_message(
    v_conversation, 'ChatSystem.GroupCreated',
    jsonb_build_object('actor', v_uid, 'title', v_title, 'members', to_jsonb(v_added))
  );

  return jsonb_build_object(
    'id', v_conversation,
    'kind', 'Group',
    'title', v_title,
    'member_ids', to_jsonb(v_added)
  );
end;
$fn$;
grant execute on function public.chat_create_group(text, uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- 15. Sending
-- ----------------------------------------------------------------------------

create or replace function public.chat_send(
  p_conversation uuid,
  p_body text,
  p_reply_to uuid default null,
  p_attachment jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
  v_settings public.tenant_settings%rowtype;
  v_conv public.chat_conversations%rowtype;
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
  v_type text := 'Text';
  v_preview text;
  v_message uuid;
  v_other uuid;
  v_quota jsonb;
  v_has_attachment boolean := p_attachment is not null
                              and jsonb_typeof(p_attachment) = 'object'
                              and p_attachment <> '{}'::jsonb;
  v_mime text;
  v_size bigint;
  v_state text;
  v_provider text;
begin
  select * into v_settings from public.tenant_settings where tenant_id = v_tenant;

  select * into v_conv from public.chat_conversations
  where id = p_conversation and tenant_id = v_tenant and not is_deleted;
  if not found then
    raise exception 'CONVERSATION_NOT_FOUND';
  end if;
  if not public.chat_is_participant(p_conversation, v_uid) then
    raise exception 'NOT_A_PARTICIPANT';
  end if;

  if v_conv.kind = 'Direct' then
    if not coalesce(v_settings.chat_private_enabled, true) then
      raise exception 'PRIVATE_CHAT_DISABLED';
    end if;
    select p.user_id into v_other from public.chat_participants p
    where p.conversation_id = p_conversation and p.user_id <> v_uid and p.left_on is null
    limit 1;
    if v_other is not null and exists (
      select 1 from public.chat_blocks b
      where b.tenant_id = v_tenant
        and ((b.blocker_id = v_uid and b.blocked_id = v_other)
          or (b.blocker_id = v_other and b.blocked_id = v_uid))
    ) then
      raise exception 'CONVERSATION_BLOCKED';
    end if;
  elsif not coalesce(v_settings.chat_groups_enabled, true) then
    raise exception 'GROUPS_DISABLED';
  end if;

  if v_has_attachment then
    if not coalesce(v_settings.chat_attachments_enabled, false) then
      raise exception 'ATTACHMENTS_DISABLED';
    end if;
    v_provider := coalesce(nullif(p_attachment ->> 'storage_provider', ''), v_settings.storage_provider, 'none');
    -- Bytes never land in platform storage: without a tenant provider there is
    -- nowhere legitimate to put them.
    if v_provider = 'none' or coalesce(v_settings.storage_provider, 'none') = 'none' then
      raise exception 'STORAGE_PROVIDER_NOT_CONFIGURED';
    end if;

    if nullif(p_attachment ->> 'file_name', '') is null then
      raise exception 'ATTACHMENT_NAME_REQUIRED';
    end if;

    v_state := coalesce(nullif(p_attachment ->> 'state', ''), 'Ready');
    if v_state not in ('Ready', 'PendingSync', 'Expired', 'Failed') then
      raise exception 'INVALID_ATTACHMENT_STATE';
    end if;
    if v_state = 'Ready'
       and nullif(p_attachment ->> 'external_id', '') is null
       and nullif(p_attachment ->> 'external_url', '') is null then
      raise exception 'ATTACHMENT_REFERENCE_REQUIRED';
    end if;

    v_mime := nullif(p_attachment ->> 'mime_type', '');
    v_size := coalesce((p_attachment ->> 'file_size')::bigint, 0);

    if v_mime is not null
       and array_length(v_settings.chat_allowed_file_types, 1) is not null
       and not (v_mime = any (v_settings.chat_allowed_file_types)) then
      raise exception 'FILE_TYPE_NOT_ALLOWED';
    end if;
    if coalesce(v_settings.chat_max_attachment_mb, 0) > 0
       and v_size > v_settings.chat_max_attachment_mb::bigint * 1048576 then
      raise exception 'FILE_TOO_LARGE';
    end if;

    v_type := 'Attachment';
  end if;

  if v_body is null and not v_has_attachment then
    raise exception 'MESSAGE_EMPTY';
  end if;

  if p_reply_to is not null and not exists (
    select 1 from public.chat_messages m
    where m.id = p_reply_to and m.conversation_id = p_conversation and m.tenant_id = v_tenant
  ) then
    raise exception 'REPLY_TARGET_NOT_FOUND';
  end if;

  v_quota := public.tenant_quota_check('CHAT_MESSAGES', 1);
  if not coalesce((v_quota ->> 'allowed')::boolean, true) then
    raise exception 'QUOTA_EXCEEDED';
  end if;

  insert into public.chat_messages (tenant_id, conversation_id, sender_id, body, message_type, reply_to_id)
  values (v_tenant, p_conversation, v_uid, v_body, v_type, p_reply_to)
  returning id into v_message;

  if v_has_attachment then
    insert into public.chat_attachments (
      tenant_id, message_id, storage_provider, external_id, external_url,
      file_name, mime_type, file_size, checksum, state, expires_on
    )
    values (
      v_tenant, v_message, v_provider,
      nullif(p_attachment ->> 'external_id', ''),
      nullif(p_attachment ->> 'external_url', ''),
      p_attachment ->> 'file_name',
      v_mime,
      v_size,
      nullif(p_attachment ->> 'checksum', ''),
      v_state,
      nullif(p_attachment ->> 'expires_on', '')::timestamptz
    );
  end if;

  v_preview := case
    when v_type = 'Attachment' then p_attachment ->> 'file_name'
    else left(coalesce(v_body, ''), 160)
  end;

  perform public.chat_deliver(v_tenant, p_conversation, v_message, v_uid, v_preview);
  perform public.tenant_quota_consume('CHAT_MESSAGES', 1);

  return public.chat_message_json(v_message);
end;
$fn$;
grant execute on function public.chat_send(uuid, text, uuid, jsonb) to authenticated;

create or replace function public.chat_forward(p_message_id uuid, p_conversation_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
  v_settings public.tenant_settings%rowtype;
  v_source public.chat_messages%rowtype;
  v_target uuid;
  v_new uuid;
  v_preview text;
  v_origin uuid;
  v_quota jsonb;
  v_result jsonb := '[]'::jsonb;
begin
  select * into v_settings from public.tenant_settings where tenant_id = v_tenant;

  select * into v_source from public.chat_messages
  where id = p_message_id and tenant_id = v_tenant and not is_deleted;
  if not found or not public.chat_is_participant(v_source.conversation_id, v_uid) then
    raise exception 'MESSAGE_NOT_FOUND';
  end if;
  if v_source.message_type = 'System' then
    raise exception 'MESSAGE_NOT_FORWARDABLE';
  end if;
  if v_source.message_type = 'Attachment' and not coalesce(v_settings.chat_attachments_enabled, false) then
    raise exception 'ATTACHMENTS_DISABLED';
  end if;

  v_origin := coalesce(v_source.forwarded_from_id, v_source.id);

  foreach v_target in array coalesce(p_conversation_ids, '{}'::uuid[]) loop
    if v_target is null or not public.chat_is_participant(v_target, v_uid) then
      continue;
    end if;

    v_quota := public.tenant_quota_check('CHAT_MESSAGES', 1);
    if not coalesce((v_quota ->> 'allowed')::boolean, true) then
      raise exception 'QUOTA_EXCEEDED';
    end if;

    insert into public.chat_messages (
      tenant_id, conversation_id, sender_id, body, message_type, meta, forwarded_from_id
    )
    values (
      v_tenant, v_target, v_uid, v_source.body, v_source.message_type, v_source.meta, v_origin
    )
    returning id into v_new;

    -- The copy points at the same external object; no bytes are duplicated.
    insert into public.chat_attachments (
      tenant_id, message_id, storage_provider, external_id, external_url,
      file_name, mime_type, file_size, checksum, state, expires_on
    )
    select v_tenant, v_new, a.storage_provider, a.external_id, a.external_url,
           a.file_name, a.mime_type, a.file_size, a.checksum, a.state, a.expires_on
    from public.chat_attachments a
    where a.message_id = v_source.id and not a.is_deleted;

    v_preview := case
      when v_source.message_type = 'Attachment'
        then (select a.file_name from public.chat_attachments a where a.message_id = v_new limit 1)
      else left(coalesce(v_source.body, ''), 160)
    end;

    perform public.chat_deliver(v_tenant, v_target, v_new, v_uid, v_preview);
    perform public.tenant_quota_consume('CHAT_MESSAGES', 1);

    v_result := v_result || jsonb_build_array(public.chat_message_json(v_new));
  end loop;

  return v_result;
end;
$fn$;
grant execute on function public.chat_forward(uuid, uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- 16. Reading
-- ----------------------------------------------------------------------------

create or replace function public.chat_mark_read(p_conversation uuid, p_up_to_message uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
  v_cutoff timestamptz;
  v_last uuid := p_up_to_message;
  v_unread integer;
begin
  if not public.chat_is_participant(p_conversation, v_uid) then
    raise exception 'NOT_A_PARTICIPANT';
  end if;

  if v_last is not null then
    select m.created_on into v_cutoff from public.chat_messages m
    where m.id = v_last and m.conversation_id = p_conversation and m.tenant_id = v_tenant;
    if v_cutoff is null then
      raise exception 'MESSAGE_NOT_FOUND';
    end if;
  else
    select m.id, m.created_on into v_last, v_cutoff from public.chat_messages m
    where m.conversation_id = p_conversation and m.tenant_id = v_tenant
    order by m.created_on desc limit 1;
    v_cutoff := coalesce(v_cutoff, now());
  end if;

  update public.chat_message_receipts r
  set delivered_on = coalesce(r.delivered_on, now()),
      read_on = coalesce(r.read_on, now())
  from public.chat_messages m
  where m.id = r.message_id
    and m.conversation_id = p_conversation
    and r.user_id = v_uid
    and r.read_on is null
    and m.created_on <= v_cutoff;

  update public.chat_participants p
  set last_read_message_id = v_last,
      last_read_on = greatest(coalesce(p.last_read_on, v_cutoff), v_cutoff),
      unread_count = (
        select count(*) from public.chat_messages m
        where m.conversation_id = p_conversation
          and not m.is_deleted
          and m.sender_id <> v_uid
          and m.created_on > v_cutoff
      )
  where p.conversation_id = p_conversation and p.user_id = v_uid
  returning p.unread_count into v_unread;

  return jsonb_build_object('conversation_id', p_conversation, 'unread_count', coalesce(v_unread, 0));
end;
$fn$;
grant execute on function public.chat_mark_read(uuid, uuid) to authenticated;

create or replace function public.chat_conversations_feed()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  select coalesce(jsonb_agg(t.card order by t.is_pinned desc, t.sort_at desc nulls last), '[]'::jsonb)
  into v_result
  from (
    select
      p.is_pinned,
      coalesce(c.last_message_at, p.joined_on) as sort_at,
      jsonb_build_object(
        'id', c.id,
        'kind', c.kind,
        'title', c.title,
        'avatar_url', c.avatar_url,
        'is_archived', c.is_archived,
        'is_pinned', p.is_pinned,
        'is_muted', p.is_muted,
        'my_role', p.role,
        'joined_on', p.joined_on,
        'unread_count', p.unread_count,
        'last_read_message_id', p.last_read_message_id,
        'last_message_at', c.last_message_at,
        'last_message_preview', c.last_message_preview,
        'last_message', case when c.last_message_id is null then null
                             else public.chat_message_json(c.last_message_id) end,
        'participant_count', (
          select count(*) from public.chat_participants x
          where x.conversation_id = c.id and x.left_on is null and not x.is_deleted
        ),
        'other_user', case when c.kind = 'Direct' then public.chat_user_card(o.user_id) else null end,
        'presence', case when c.kind = 'Direct' then public.chat_presence_card(o.user_id) else null end,
        'is_blocked', case when c.kind = 'Direct' then exists (
            select 1 from public.chat_blocks b
            where b.tenant_id = v_tenant and b.blocker_id = v_uid and b.blocked_id = o.user_id
          ) else false end,
        'has_blocked_me', case when c.kind = 'Direct' then exists (
            select 1 from public.chat_blocks b
            where b.tenant_id = v_tenant and b.blocker_id = o.user_id and b.blocked_id = v_uid
          ) else false end,
        'members', case when c.kind = 'Group' then coalesce((
            select jsonb_agg(jsonb_build_object(
              'user', public.chat_user_card(m.user_id),
              'role', m.role,
              'presence', public.chat_presence_card(m.user_id)
            ) order by m.joined_on)
            from public.chat_participants m
            where m.conversation_id = c.id and m.left_on is null and not m.is_deleted
          ), '[]'::jsonb) else '[]'::jsonb end
      ) as card
    from public.chat_participants p
    join public.chat_conversations c
      on c.id = p.conversation_id and c.tenant_id = p.tenant_id and not c.is_deleted
    left join lateral (
      select x.user_id from public.chat_participants x
      where x.conversation_id = c.id and x.user_id <> v_uid
      order by x.joined_on limit 1
    ) o on c.kind = 'Direct'
    where p.tenant_id = v_tenant
      and p.user_id = v_uid
      and p.left_on is null
      and not p.is_deleted
  ) t;

  return v_result;
end;
$fn$;
grant execute on function public.chat_conversations_feed() to authenticated;

create or replace function public.chat_history(
  p_conversation uuid,
  p_before timestamptz default null,
  p_limit int default 40
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
  v_limit int := greatest(1, least(coalesce(p_limit, 40), 100));
  v_messages jsonb;
  v_count int;
begin
  if not public.chat_is_participant(p_conversation, v_uid) then
    raise exception 'NOT_A_PARTICIPANT';
  end if;

  -- Opening the thread is what "Delivered" means for the reader.
  update public.chat_message_receipts r
  set delivered_on = now()
  from public.chat_messages m
  where m.id = r.message_id
    and m.conversation_id = p_conversation
    and r.user_id = v_uid
    and r.delivered_on is null;

  select coalesce(jsonb_agg(x.card order by x.created_on), '[]'::jsonb), count(*)
  into v_messages, v_count
  from (
    select m.created_on, public.chat_message_json(m.id) as card
    from public.chat_messages m
    where m.conversation_id = p_conversation
      and m.tenant_id = v_tenant
      and (p_before is null or m.created_on < p_before)
    order by m.created_on desc
    limit v_limit
  ) x;

  return jsonb_build_object(
    'conversation_id', p_conversation,
    'messages', v_messages,
    'has_more', v_count >= v_limit
  );
end;
$fn$;
grant execute on function public.chat_history(uuid, timestamptz, int) to authenticated;

create or replace function public.chat_search(p_query text, p_limit int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
  v_q text := btrim(coalesce(p_query, ''));
  v_limit int := greatest(1, least(coalesce(p_limit, 30), 100));
  v_result jsonb;
begin
  if char_length(v_q) < 2 then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(x.card order by x.created_on desc), '[]'::jsonb)
  into v_result
  from (
    select m.created_on,
      jsonb_build_object(
        'message_id', m.id,
        'conversation_id', c.id,
        'kind', c.kind,
        'title', c.title,
        'body', m.body,
        'message_type', m.message_type,
        'created_on', m.created_on,
        'sender', public.chat_user_card(m.sender_id),
        'other_user', case when c.kind = 'Direct' then public.chat_user_card((
            select x.user_id from public.chat_participants x
            where x.conversation_id = c.id and x.user_id <> v_uid
            order by x.joined_on limit 1
          )) else null end
      ) as card
    from public.chat_messages m
    join public.chat_conversations c on c.id = m.conversation_id and c.tenant_id = m.tenant_id
    join public.chat_participants p
      on p.conversation_id = m.conversation_id
     and p.user_id = v_uid
     and p.left_on is null
     and not p.is_deleted
    where m.tenant_id = v_tenant
      and not m.is_deleted
      and not c.is_deleted
      and m.message_type <> 'System'
      and m.body ilike '%' || v_q || '%'
    order by m.created_on desc
    limit v_limit
  ) x;

  return v_result;
end;
$fn$;
grant execute on function public.chat_search(text, int) to authenticated;

-- ----------------------------------------------------------------------------
-- 17. Presence and typing
-- ----------------------------------------------------------------------------

create or replace function public.chat_set_presence(p_status text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
begin
  if p_status is null or p_status not in ('Online', 'Away', 'Busy', 'Offline') then
    raise exception 'INVALID_STATUS';
  end if;

  insert into public.chat_presence (tenant_id, user_id, status, last_seen_on)
  values (v_tenant, v_uid, p_status, now())
  on conflict (user_id) do update
    set status = excluded.status,
        last_seen_on = now(),
        typing_in_conversation = case when excluded.status = 'Offline' then null
                                      else public.chat_presence.typing_in_conversation end,
        typing_until = case when excluded.status = 'Offline' then null
                            else public.chat_presence.typing_until end;

  return jsonb_build_object('status', p_status, 'last_seen_on', now());
end;
$fn$;
grant execute on function public.chat_set_presence(text) to authenticated;

create or replace function public.chat_set_typing(p_conversation uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
  v_until timestamptz := now() + interval '8 seconds';
begin
  if not public.chat_is_participant(p_conversation, v_uid) then
    raise exception 'NOT_A_PARTICIPANT';
  end if;

  insert into public.chat_presence (tenant_id, user_id, status, last_seen_on, typing_in_conversation, typing_until)
  values (v_tenant, v_uid, 'Online', now(), p_conversation, v_until)
  on conflict (user_id) do update
    set status = case when public.chat_presence.status = 'Offline' then 'Online' else public.chat_presence.status end,
        last_seen_on = now(),
        typing_in_conversation = excluded.typing_in_conversation,
        typing_until = excluded.typing_until;

  return jsonb_build_object('conversation_id', p_conversation, 'typing_until', v_until);
end;
$fn$;
grant execute on function public.chat_set_typing(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 18. Group membership
-- ----------------------------------------------------------------------------

-- Leaving only checks the module: a member must never be trapped inside a
-- group because the company switched group creation off.
create or replace function public.chat_leave_group(p_conversation uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
  v_conv public.chat_conversations%rowtype;
  v_role text;
  v_heir uuid;
  v_remaining int;
begin
  select * into v_conv from public.chat_conversations
  where id = p_conversation and tenant_id = v_tenant and not is_deleted;
  if not found then
    raise exception 'CONVERSATION_NOT_FOUND';
  end if;
  if v_conv.kind <> 'Group' then
    raise exception 'NOT_A_GROUP';
  end if;

  select p.role into v_role from public.chat_participants p
  where p.conversation_id = p_conversation and p.user_id = v_uid and p.left_on is null and not p.is_deleted;
  if v_role is null then
    raise exception 'NOT_A_PARTICIPANT';
  end if;

  update public.chat_participants p
  set left_on = now(), unread_count = 0, is_pinned = false
  where p.conversation_id = p_conversation and p.user_id = v_uid;

  select count(*) into v_remaining from public.chat_participants p
  where p.conversation_id = p_conversation and p.left_on is null and not p.is_deleted;

  if v_remaining = 0 then
    -- Nobody left to own it.
    update public.chat_conversations set is_deleted = true
    where id = p_conversation and tenant_id = v_tenant;
    return jsonb_build_object('conversation_id', p_conversation, 'left', true, 'closed', true);
  end if;

  -- The group always keeps exactly one Owner.
  if v_role = 'Owner' then
    select p.user_id into v_heir from public.chat_participants p
    where p.conversation_id = p_conversation and p.left_on is null and not p.is_deleted
    order by case p.role when 'Admin' then 0 else 1 end, p.joined_on
    limit 1;

    if v_heir is not null then
      update public.chat_participants set role = 'Owner'
      where conversation_id = p_conversation and user_id = v_heir;
    end if;
  end if;

  perform public.chat_write_system_message(
    p_conversation, 'ChatSystem.MemberLeft',
    jsonb_build_object('actor', v_uid, 'new_owner', v_heir)
  );

  return jsonb_build_object(
    'conversation_id', p_conversation,
    'left', true,
    'closed', false,
    'new_owner', v_heir
  );
end;
$fn$;
grant execute on function public.chat_leave_group(uuid) to authenticated;

create or replace function public.chat_add_members(p_conversation uuid, p_user_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
  v_groups boolean;
  v_conv public.chat_conversations%rowtype;
  v_member uuid;
  v_added uuid[] := '{}';
begin
  select coalesce(s.chat_groups_enabled, true) into v_groups
  from public.tenant_settings s where s.tenant_id = v_tenant;
  if not coalesce(v_groups, true) then
    raise exception 'GROUPS_DISABLED';
  end if;

  select * into v_conv from public.chat_conversations
  where id = p_conversation and tenant_id = v_tenant and not is_deleted;
  if not found then
    raise exception 'CONVERSATION_NOT_FOUND';
  end if;
  if v_conv.kind <> 'Group' then
    raise exception 'NOT_A_GROUP';
  end if;
  if not public.chat_can_manage_conversation(p_conversation) then
    raise exception 'NOT_ALLOWED';
  end if;

  foreach v_member in array coalesce(p_user_ids, '{}'::uuid[]) loop
    if v_member is null then
      continue;
    end if;
    if not exists (
      select 1 from public.users u
      where u.id = v_member and u.tenant_id = v_tenant and not u.is_deleted and u.is_active
    ) then
      continue;
    end if;
    if exists (
      select 1 from public.chat_blocks b
      where b.tenant_id = v_tenant
        and ((b.blocker_id = v_uid and b.blocked_id = v_member)
          or (b.blocker_id = v_member and b.blocked_id = v_uid))
    ) then
      continue;
    end if;

    insert into public.chat_participants (tenant_id, conversation_id, user_id, role, joined_on)
    values (v_tenant, p_conversation, v_member, 'Member', now())
    on conflict (conversation_id, user_id) do update
      set left_on = null,
          is_deleted = false,
          joined_on = case when public.chat_participants.left_on is not null then now()
                           else public.chat_participants.joined_on end;
    v_added := v_added || v_member;
  end loop;

  if array_length(v_added, 1) is not null then
    perform public.chat_write_system_message(
      p_conversation, 'ChatSystem.MembersAdded',
      jsonb_build_object('actor', v_uid, 'members', to_jsonb(v_added))
    );
  end if;

  return jsonb_build_object('conversation_id', p_conversation, 'added', to_jsonb(v_added));
end;
$fn$;
grant execute on function public.chat_add_members(uuid, uuid[]) to authenticated;

create or replace function public.chat_remove_member(p_conversation uuid, p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
  v_groups boolean;
  v_conv public.chat_conversations%rowtype;
  v_my_role text;
  v_target_role text;
begin
  select coalesce(s.chat_groups_enabled, true) into v_groups
  from public.tenant_settings s where s.tenant_id = v_tenant;
  if not coalesce(v_groups, true) then
    raise exception 'GROUPS_DISABLED';
  end if;

  select * into v_conv from public.chat_conversations
  where id = p_conversation and tenant_id = v_tenant and not is_deleted;
  if not found then
    raise exception 'CONVERSATION_NOT_FOUND';
  end if;
  if v_conv.kind <> 'Group' then
    raise exception 'NOT_A_GROUP';
  end if;

  select p.role into v_my_role from public.chat_participants p
  where p.conversation_id = p_conversation and p.user_id = v_uid and p.left_on is null and not p.is_deleted;
  if v_my_role is null or v_my_role not in ('Owner', 'Admin') then
    raise exception 'NOT_ALLOWED';
  end if;

  select p.role into v_target_role from public.chat_participants p
  where p.conversation_id = p_conversation and p.user_id = p_user_id and p.left_on is null and not p.is_deleted;
  if v_target_role is null then
    raise exception 'NOT_A_PARTICIPANT';
  end if;
  if v_target_role = 'Owner' then
    raise exception 'CANNOT_REMOVE_OWNER';
  end if;
  if v_target_role = 'Admin' and v_my_role <> 'Owner' then
    raise exception 'NOT_ALLOWED';
  end if;

  update public.chat_participants p
  set left_on = now(), unread_count = 0, is_pinned = false
  where p.conversation_id = p_conversation and p.user_id = p_user_id;

  perform public.chat_write_system_message(
    p_conversation, 'ChatSystem.MemberRemoved',
    jsonb_build_object('actor', v_uid, 'member', p_user_id)
  );

  return jsonb_build_object('conversation_id', p_conversation, 'removed', p_user_id);
end;
$fn$;
grant execute on function public.chat_remove_member(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 19. Blocking, mute and pin
-- ----------------------------------------------------------------------------

create or replace function public.chat_block(p_user uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
begin
  if p_user is null or p_user = v_uid then
    raise exception 'INVALID_TARGET';
  end if;
  if not exists (
    select 1 from public.users u where u.id = p_user and u.tenant_id = v_tenant and not u.is_deleted
  ) then
    raise exception 'USER_NOT_FOUND';
  end if;

  insert into public.chat_blocks (tenant_id, blocker_id, blocked_id)
  values (v_tenant, v_uid, p_user)
  on conflict (tenant_id, blocker_id, blocked_id) do nothing;

  -- A blocked thread stops ringing immediately.
  update public.chat_participants p
  set is_muted = true
  where p.tenant_id = v_tenant
    and p.user_id = v_uid
    and p.conversation_id in (
      select c.id from public.chat_conversations c
      where c.tenant_id = v_tenant and c.kind = 'Direct'
        and c.direct_key = case when v_uid::text < p_user::text
                                then v_uid::text || ':' || p_user::text
                                else p_user::text || ':' || v_uid::text end
    );

  return jsonb_build_object('blocked', true, 'user_id', p_user);
end;
$fn$;
grant execute on function public.chat_block(uuid) to authenticated;

create or replace function public.chat_unblock(p_user uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
begin
  delete from public.chat_blocks
  where tenant_id = v_tenant and blocker_id = v_uid and blocked_id = p_user;

  return jsonb_build_object('blocked', false, 'user_id', p_user);
end;
$fn$;
grant execute on function public.chat_unblock(uuid) to authenticated;

create or replace function public.chat_toggle_mute(p_conversation uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
  v_value boolean;
begin
  if not public.chat_is_participant(p_conversation, v_uid) then
    raise exception 'NOT_A_PARTICIPANT';
  end if;

  update public.chat_participants p
  set is_muted = not p.is_muted
  where p.tenant_id = v_tenant and p.conversation_id = p_conversation and p.user_id = v_uid
  returning p.is_muted into v_value;

  return jsonb_build_object('conversation_id', p_conversation, 'is_muted', v_value);
end;
$fn$;
grant execute on function public.chat_toggle_mute(uuid) to authenticated;

create or replace function public.chat_toggle_pin(p_conversation uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_tenant uuid := public.chat_assert_enabled();
  v_uid uuid := auth.uid();
  v_value boolean;
begin
  if not public.chat_is_participant(p_conversation, v_uid) then
    raise exception 'NOT_A_PARTICIPANT';
  end if;

  update public.chat_participants p
  set is_pinned = not p.is_pinned
  where p.tenant_id = v_tenant and p.conversation_id = p_conversation and p.user_id = v_uid
  returning p.is_pinned into v_value;

  return jsonb_build_object('conversation_id', p_conversation, 'is_pinned', v_value);
end;
$fn$;
grant execute on function public.chat_toggle_pin(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 20. Retention
--     Runs from a scheduled worker, never from a session: it crosses tenants
--     by design, which is exactly why it is service_role only.
-- ----------------------------------------------------------------------------

create or replace function public.chat_purge_expired()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  r record;
  v_messages bigint := 0;
  v_attachments bigint := 0;
  v_batch bigint;
begin
  for r in
    select s.tenant_id, s.chat_retention_days
    from public.tenant_settings s
    where coalesce(s.chat_retention_days, 0) > 0
  loop
    delete from public.chat_messages m
    where m.tenant_id = r.tenant_id
      and m.created_on < now() - make_interval(days => r.chat_retention_days);
    get diagnostics v_batch = row_count;
    v_messages := v_messages + v_batch;
  end loop;

  delete from public.chat_attachments a
  where a.expires_on is not null and a.expires_on < now();
  get diagnostics v_batch = row_count;
  v_attachments := v_batch;

  -- A message that no longer exists must not stay in the conversation header.
  if v_messages > 0 then
    update public.chat_conversations c
    set last_message_id = s.id,
        last_message_at = s.created_on,
        last_message_preview = left(coalesce(s.body, ''), 160)
    from (
      select distinct on (m.conversation_id)
        m.conversation_id, m.id, m.created_on, m.body
      from public.chat_messages m
      order by m.conversation_id, m.created_on desc
    ) s
    where s.conversation_id = c.id
      and c.last_message_id is distinct from s.id;

    update public.chat_conversations c
    set last_message_id = null, last_message_at = null, last_message_preview = null
    where c.last_message_id is not null
      and not exists (select 1 from public.chat_messages m where m.conversation_id = c.id);

    update public.chat_participants p
    set unread_count = (
      select count(*) from public.chat_messages m
      where m.conversation_id = p.conversation_id
        and not m.is_deleted
        and m.sender_id <> p.user_id
        and m.created_on > coalesce(p.last_read_on, p.joined_on)
    )
    where p.unread_count > 0;
  end if;

  return jsonb_build_object(
    'messages_deleted', v_messages,
    'attachments_deleted', v_attachments,
    'ran_on', now()
  );
end;
$fn$;
revoke all on function public.chat_purge_expired() from public;
grant execute on function public.chat_purge_expired() to service_role;

-- ----------------------------------------------------------------------------
-- 21. Realtime
--     The dock listens instead of polling; the publication may not exist in a
--     bare Postgres, so it is added defensively.
-- ----------------------------------------------------------------------------

do $do$
declare
  chat_tables text[] := array[
    'chat_conversations', 'chat_participants', 'chat_messages',
    'chat_message_receipts', 'chat_reactions', 'chat_presence'
  ];
  tbl text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach tbl in array chat_tables loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = tbl
    ) then
      execute format('alter publication supabase_realtime add table public.%I', tbl);
    end if;
  end loop;
exception when others then
  raise notice 'chat: realtime publication not updated (%)', sqlerrm;
end $do$;
