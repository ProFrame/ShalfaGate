-- ============================================================================
-- 038 — support_reply() reimplemented notification creation instead of
--        calling the one shared function every other module uses
--
-- public.notify() is the platform's single owner of "create an in-app
-- notification" — it validates the category, resolves the recipient's own
-- tenant, and — the part that actually matters here — checks
-- notification_enabled(p_recipient, p_category) before writing anything, so a
-- user who muted a category never gets one. support_reply() never called it;
-- instead it built its own raw INSERT into public.notifications through a
-- dynamic EXECUTE, which skips that preference check entirely. A requester
-- who disabled Support notifications still got one on every reply, because
-- the one place that was supposed to enforce that choice was bypassed by a
-- second, independent implementation of the same job. This is exactly the
-- "Module Ownership" violation the platform is meant to rule out: Notification
-- belongs to the Notification Center; nothing else re-implements it.
--
-- One real wrinkle explains why the original code didn't just call notify()
-- in the first place: notify() refuses to address a recipient outside the
-- caller's own current_tenant_id() unless the session has none at all ("a
-- system context... is allowed through"). A platform operator replying to a
-- ticket is a real, authenticated session — usually still sitting in the
-- platform's own tenant, not switched into the customer's — so a direct call
-- would have raised NOTIFICATION_RECIPIENT_NOT_IN_TENANT on exactly the
-- operator-reply path that matters most. notify() is widened here to extend
-- the same trust it already gives a null session to a verified platform
-- operator too, since that is the same boundary every cross-tenant RPC in
-- this codebase already uses.
-- ============================================================================

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
  -- (service role, no session tenant) or a verified platform operator acting
  -- on the platform's behalf (support replies, platform-console actions) is
  -- allowed through — the same trust every other cross-tenant RPC here uses.
  if v_session_tenant is not null and v_tenant <> v_session_tenant and not public.is_platform_operator() then
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
        '<div dir="rtl"><p>مرحباً {{requester_name}}،</p><p>تم الرد على تذكرة الدعم رقم {{ticket_no}}.</p><p style="font-size:13px;color:#667085">رمز المتابعة: <code>{{access_token}}</code></p><blockquote>{{reply_body}}</blockquote></div>',
        '<div dir="ltr"><p>Hello {{requester_name}},</p><p>Your support ticket {{ticket_no}} has a new reply.</p><p style="font-size:13px;color:#667085">Tracking code: <code>{{access_token}}</code></p><blockquote>{{reply_body}}</blockquote></div>',
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
        'access_token', v_ticket.access_token,
        'requester_name', v_ticket.requester_name,
        'subject', v_ticket.subject,
        'reply_body', v_body,
        'ticket_url', v_url
      ),
      3
    );

    if v_ticket.requester_user_id is not null then
      -- A support reply must never fail because the notification side-channel
      -- did — the message and the e-mail above have already been committed.
      begin
        perform public.notify(
          v_ticket.requester_user_id,
          'Support',
          'Support.Replied',
          v_ticket.subject, v_ticket.subject,
          left(v_body, 400), left(v_body, 400),
          '/app/support?ticket=' || v_ticket.id::text,
          jsonb_build_object('entity_type', 'SupportTicket', 'entity_id', v_ticket.id)
        );
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

comment on function public.support_reply(uuid, text, boolean) is
  'Replies to a support ticket and e-mails the requester through the SUPPORT_REPLY template, '
  'always including access_token so a public requester can get back into support_ticket_status() '
  'after leaving the confirmation page. The in-app notification goes through public.notify() — '
  'never a direct insert — so a requester who muted Support notifications is actually honoured.';
