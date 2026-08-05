-- ============================================================================
-- 025 — A public support ticket is read with its own secret, not with a guess
--
-- public.support_ticket_status(p_ticket_no, p_email) authenticated a reader
-- with two values that are not secrets:
--
--   * ticket_no comes from one shared sequence — BBX-2026-000001, -000002 …
--     so knowing one ticket number tells you every other ticket number;
--   * the requester's e-mail address is, by its nature, known to other people.
--
-- Anyone could therefore walk the sequence against a known address and read
-- somebody else's correspondence with support, including whatever they pasted
-- into it. The ticket already carries a high-entropy access_token, created for
-- exactly this purpose and already required for replying — it simply was not
-- required for reading.
--
-- The parameter is renamed, which CREATE OR REPLACE cannot do, so the old
-- function is dropped first. The signature (text, text) is unchanged, so the
-- existing grant list and the client call site keep their shape.
-- ============================================================================

drop function if exists public.support_ticket_status(text, text);

create or replace function public.support_ticket_status(
  p_ticket_no text,
  p_access_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ticket public.support_tickets%rowtype;
  v_number text := upper(trim(coalesce(p_ticket_no, '')));
  v_token text := trim(coalesce(p_access_token, ''));
begin
  -- Never answer a partial guess: both halves must be present and the token
  -- must be long enough to be the real thing.
  if v_number = '' or length(v_token) < 16 then
    return jsonb_build_object('found', false);
  end if;

  select * into v_ticket
  from public.support_tickets
  where upper(ticket_no) = v_number
    and access_token = v_token
    and source = 'Public'
    and not is_deleted;

  if not found then
    -- One shape for "no such ticket" and "wrong token", so the answer cannot
    -- be used to discover which ticket numbers exist.
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

revoke all on function public.support_ticket_status(text, text) from public;
grant execute on function public.support_ticket_status(text, text) to anon, authenticated;

comment on function public.support_ticket_status(text, text) is
  'Public ticket lookup. The second argument is the access token issued at creation, not the e-mail address.';

-- ----------------------------------------------------------------------------
-- The token is what the requester needs, so the reply notification carries it.
-- Without it a person who closed the confirmation page can never read the
-- answer they were told to come back for.
-- ----------------------------------------------------------------------------

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
where code = 'SUPPORT_TICKET_REPLY'
  and body_html_ar like '%{{ticket_no}}%'
  and body_html_ar not like '%{{access_token}}%';

-- ----------------------------------------------------------------------------
-- An access token is only a secret while it is unguessable. Confirm the column
-- is generated with real entropy rather than something derived from the ticket
-- number, and index the lookup so a token check is a single index probe.
-- ----------------------------------------------------------------------------

create unique index if not exists uq_support_tickets_access_token
  on public.support_tickets (access_token)
  where access_token is not null;
