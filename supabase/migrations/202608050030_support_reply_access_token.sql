-- ============================================================================
-- 030 — The support reply e-mail never actually carried the access token
--
-- Migration 025 made the access token the only way to read a public support
-- ticket, and tried to put that token into the reply notification e-mail so a
-- requester who closed the confirmation page could still get back in. Two
-- things in that migration missed each other:
--
--   * its UPDATE targeted email_templates.code = 'SUPPORT_TICKET_REPLY', but
--     that code belongs to a different, platform-tenant-only notification
--     (a company's own ticket TO the platform operator, seeded in migration
--     019 with an unrelated placeholder set: {{ticket_code}}, {{ticket_status}}).
--     The template public.support_reply() actually queries — 'SUPPORT_REPLY',
--     one row per company, seeded in migration 018 — was never touched, so
--     its HTML still has no {{access_token}} placeholder;
--   * even if the placeholder had been added, support_reply() never put
--     access_token into the e-mail's template_data, so the substitution would
--     have rendered a literal, empty "{{access_token}}" in the sent e-mail.
--
-- Net effect: since migration 025, a requester who does not stay on the
-- confirmation page has no way back into their own ticket — the e-mail that
-- was supposed to carry the tracking code carries nothing. Fixed here by
-- re-stating support_reply() (identical to migration 018's version, plus the
-- token) and correcting the template patch to the code it was always meant
-- to target.
-- ============================================================================

update public.email_templates
set body_html_ar = replace(
      body_html_ar,
      '{{ticket_no}}',
      '{{ticket_no}}</strong><br><span style="font-size:13px;color:#667085">رمز المتابعة: <code>{{access_token}}</code></span><strong>'
    ),
    body_html_en = replace(
      body_html_en,
      '{{ticket_no}}',
      '{{ticket_no}}</strong><br><span style="font-size:13px;color:#667085">Tracking code: <code>{{access_token}}</code></span><strong>'
    ),
    updated_on = now()
where code = 'SUPPORT_REPLY'
  and body_html_ar like '%{{ticket_no}}%'
  and body_html_ar not like '%{{access_token}}%';

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

comment on function public.support_reply(uuid, text, boolean) is
  'Replies to a support ticket and e-mails the requester through the SUPPORT_REPLY template, '
  'always including access_token so a public requester can get back into support_ticket_status() '
  'after leaving the confirmation page.';
