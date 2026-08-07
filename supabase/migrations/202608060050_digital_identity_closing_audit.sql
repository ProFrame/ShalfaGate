-- ============================================================================
-- 050 — Digital Identity closing audit fixes
--
-- Same closing-audit process as Verification Service (migration 048):
-- independent multi-lens review + adversarial verify, then fix everything
-- confirmed in-scope. 8 SQL-layer findings fixed here; frontend findings are
-- fixed in their own files, not this migration.
--
-- Two Blockers:
--   1) card_public_view()'s v_allowed check used SQL three-valued logic
--      (auth.uid() = user_id, is_tenant_member OR) with no coalesce — for an
--      ANONYMOUS caller (auth.uid() IS NULL) both Private and CompanyOnly
--      cards evaluated v_allowed to NULL, not false. `if not v_allowed` skips
--      the branch on NULL exactly like it does on false, so the function fell
--      through and returned the full card to anyone, regardless of the
--      owner's visibility setting. Fixed by coalescing the whole CASE result.
--   2) The per-field visibility strip only ever removed the exact toggled key
--      (department_ar/site_ar/project_ar — the only keys the UI ever writes)
--      and left the paired _en column untouched, so hiding "Department" never
--      actually hid the data — it leaked back through department_en in every
--      viewing language. Fixed by also stripping the _en counterpart.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. card_public_view() — fix both Blockers at once (same function body).
-- ----------------------------------------------------------------------------
create or replace function public.card_public_view(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_code text := trim(coalesce(p_code, ''));
  v_card public.employee_cards%rowtype;
  v_allowed boolean;
  v_hidden text[];
  v_profile jsonb;
  v_company jsonb;
begin
  if length(v_code) < 4 then
    return jsonb_build_object('found', false);
  end if;

  select * into v_card from public.employee_cards
  where lower(public_code) = lower(v_code) and not is_deleted and is_active;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  -- coalesce(..., false): auth.uid() is NULL for an anonymous caller, and
  -- `null = uuid` / `null or false` both evaluate to NULL under SQL's
  -- three-valued logic — never let that NULL fall through as "allowed".
  v_allowed := coalesce(
    case v_card.visibility
      when 'Public' then true
      when 'CompanyOnly' then (auth.uid() = v_card.user_id) or public.is_tenant_member(v_card.tenant_id)
      when 'Private' then (auth.uid() = v_card.user_id)
      else false
    end,
    false
  );
  if not v_allowed then
    return jsonb_build_object('found', false);
  end if;

  update public.employee_cards set opens_count = opens_count + 1 where id = v_card.id;

  select jsonb_build_object(
    'full_name', u.full_name, 'name_ar', u.name_ar, 'name_en', u.name_en,
    'job_title', u.job_title, 'job_title_ar', u.job_title_ar, 'job_title_en', u.job_title_en,
    'email', u.email, 'mobile', u.mobile, 'avatar_url', u.avatar_url,
    'department_ar', d.name_ar, 'department_en', d.name_en,
    'site_ar', s.name_ar, 'site_en', s.name_en,
    'project_ar', p.name_ar, 'project_en', p.name_en
  )
  into v_profile
  from public.users u
  left join public.departments d on d.id = u.department_id
  left join public.sites s on s.id = u.site_id
  left join public.projects p on p.id = u.project_id
  where u.id = v_card.user_id;

  select jsonb_build_object(
    'names', coalesce((select jsonb_object_agg(n.language_code, n.name) from public.tenant_names n where n.tenant_id = v_card.tenant_id), '{}'::jsonb),
    'logo_light_url', b.logo_light_url,
    'logo_dark_url', b.logo_dark_url,
    'website_url', b.website_url,
    'primary_color', b.primary_color
  )
  into v_company
  from public.tenants t
  left join public.tenant_branding b on b.tenant_id = t.id
  where t.id = v_card.tenant_id;

  -- Per-field visibility: strip any key the owner turned off before this
  -- ever leaves the database, not just hide it client-side.
  select coalesce(array_agg(key), '{}') into v_hidden
  from jsonb_each(v_card.field_visibility) as kv(key, value)
  where value = 'false'::jsonb;

  if v_hidden is not null and array_length(v_hidden, 1) > 0 then
    -- The UI only ever toggles the "_ar" key for these three bilingual
    -- fields (department/site/project — see TOGGLEABLE_FIELDS in
    -- digitalIdentityService.js). Stripping only that key left the value
    -- fully readable through its "_en" twin in every viewing language.
    if 'department_ar' = any (v_hidden) then v_hidden := v_hidden || 'department_en'::text; end if;
    if 'site_ar' = any (v_hidden) then v_hidden := v_hidden || 'site_en'::text; end if;
    if 'project_ar' = any (v_hidden) then v_hidden := v_hidden || 'project_en'::text; end if;
    v_profile := v_profile - v_hidden;
  end if;

  return jsonb_build_object(
    'found', true,
    'public_code', v_card.public_code,
    'template_code', v_card.template_code,
    'theme', v_card.theme,
    'shape', v_card.shape,
    'show_logo', v_card.show_logo,
    'show_photo', v_card.show_photo,
    'linkedin_url', case when not ('linkedin_url' = any (v_hidden)) then v_card.linkedin_url end,
    'extension_phone', case when not ('extension_phone' = any (v_hidden)) then v_card.extension_phone end,
    'profile', v_profile,
    'company', v_company
  );
end;
$$;
revoke all on function public.card_public_view(text) from public;
grant execute on function public.card_public_view(text) to anon, authenticated;

comment on function public.card_public_view(text) is
  'Authentication: anon. Authorization: the code is the credential, further '
  'narrowed by the card owner''s own visibility setting (Private: owner '
  'only; CompanyOnly: any authenticated same-tenant member; Public: '
  'anyone) — checked here via a coalesced boolean, not left to the client '
  'and not vulnerable to SQL NULL-propagation for anonymous callers (closing '
  'audit Blocker, fixed 050). Per-field visibility overrides strip hidden '
  'fields server-side, including the paired _en column for the three '
  'bilingual fields (closing audit Blocker, fixed 050). Rate limiting: none '
  'yet — todo, same gap noted for several other anon RPCs in this codebase. '
  'Expected errors: none raised — an unknown, inactive, or '
  'not-visible-to-this-caller code resolves to {found:false}, not an '
  'exception, matching verify_document()''s graceful-not-found convention.';

-- ----------------------------------------------------------------------------
-- 2. card_track_event() — apply the same visibility gate as card_public_view.
--    Without it, a code observed while a card was Public keeps inflating
--    analytics forever even after the owner switches to Private/CompanyOnly.
-- ----------------------------------------------------------------------------
create or replace function public.card_track_event(p_code text, p_event_type text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_code text := trim(coalesce(p_code, ''));
  v_card public.employee_cards%rowtype;
  v_allowed boolean;
begin
  if p_event_type not in ('vcf_download', 'website_click', 'call', 'email') then
    raise exception 'INVALID_EVENT_TYPE';
  end if;

  select * into v_card from public.employee_cards
  where lower(public_code) = lower(v_code) and not is_deleted and is_active;
  if not found then
    return;
  end if;

  v_allowed := coalesce(
    case v_card.visibility
      when 'Public' then true
      when 'CompanyOnly' then (auth.uid() = v_card.user_id) or public.is_tenant_member(v_card.tenant_id)
      when 'Private' then (auth.uid() = v_card.user_id)
      else false
    end,
    false
  );
  if not v_allowed then
    return;
  end if;

  update public.employee_cards set
    vcf_downloads_count = case when p_event_type = 'vcf_download' then vcf_downloads_count + 1 else vcf_downloads_count end,
    website_clicks_count = case when p_event_type = 'website_click' then website_clicks_count + 1 else website_clicks_count end,
    calls_count = case when p_event_type = 'call' then calls_count + 1 else calls_count end,
    emails_count = case when p_event_type = 'email' then emails_count + 1 else emails_count end
  where id = v_card.id;
end;
$$;
revoke all on function public.card_track_event(text, text) from public;
grant execute on function public.card_track_event(text, text) to anon, authenticated;

comment on function public.card_track_event(text, text) is
  'Authentication: anon. Authorization: the code is the credential, same '
  'visibility gate as card_public_view() (closing audit finding, fixed 050 '
  '— previously any caller who had ever seen a public_code could keep '
  'inflating analytics after the owner switched to Private/CompanyOnly). '
  'Rate limiting: none yet — todo. Expected errors: INVALID_EVENT_TYPE; an '
  'unknown/inactive/not-visible-to-this-caller code silently updates zero '
  'rows rather than raising, matching card_public_view()''s graceful '
  'not-found convention.';

-- ----------------------------------------------------------------------------
-- 3. card_save_settings() — validate linkedin_url server-side. Without this,
--    a javascript: URI stored here renders as a raw, unvalidated <a href> on
--    the public card page (BusinessCard.jsx also gained a defensive scheme
--    check as a second layer, but the authoritative check belongs here).
-- ----------------------------------------------------------------------------
create or replace function public.card_save_settings(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_visibility text := p_payload ->> 'visibility';
  v_template text := p_payload ->> 'template_code';
  v_theme text := p_payload ->> 'theme';
  v_shape text := p_payload ->> 'shape';
  v_linkedin text := nullif(trim(p_payload ->> 'linkedin_url'), '');
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;
  if v_visibility is not null and v_visibility not in ('Private', 'CompanyOnly', 'Public') then
    raise exception 'INVALID_VISIBILITY';
  end if;
  if v_template is not null and v_template not in ('Classic', 'Modern', 'Minimal', 'Bold') then
    raise exception 'INVALID_TEMPLATE';
  end if;
  if v_theme is not null and v_theme not in ('Light', 'Dark') then
    raise exception 'INVALID_THEME';
  end if;
  if v_shape is not null and v_shape not in ('Rounded', 'Square') then
    raise exception 'INVALID_SHAPE';
  end if;
  if v_linkedin is not null and v_linkedin !~* '^https://' then
    raise exception 'INVALID_LINKEDIN_URL';
  end if;

  -- card_get_mine() also creates the row; calling it here means this
  -- function works correctly even if the client calls save before get.
  perform public.card_get_mine();

  update public.employee_cards set
    visibility = coalesce(v_visibility, visibility),
    template_code = coalesce(v_template, template_code),
    theme = coalesce(v_theme, theme),
    shape = coalesce(v_shape, shape),
    show_logo = coalesce((p_payload ->> 'show_logo')::boolean, show_logo),
    show_photo = coalesce((p_payload ->> 'show_photo')::boolean, show_photo),
    linkedin_url = case when p_payload ? 'linkedin_url' then v_linkedin else linkedin_url end,
    extension_phone = case when p_payload ? 'extension_phone' then nullif(trim(p_payload ->> 'extension_phone'), '') else extension_phone end,
    field_visibility = coalesce(p_payload -> 'field_visibility', field_visibility)
  where user_id = auth.uid() and tenant_id = v_tenant and not is_deleted;

  return public.card_get_mine();
end;
$$;
revoke all on function public.card_save_settings(jsonb) from public;
grant execute on function public.card_save_settings(jsonb) to authenticated;

comment on function public.card_save_settings(jsonb) is
  'Authentication: authenticated. Authorization: self only — always writes '
  'the caller''s own card, never anyone else''s (no employee id parameter '
  'exists to target another user). Rate limiting: n/a. Expected errors: '
  'NO_ACTIVE_TENANT, INVALID_VISIBILITY, INVALID_TEMPLATE, INVALID_THEME, '
  'INVALID_SHAPE, INVALID_LINKEDIN_URL (closing audit finding, fixed 050 — '
  'must start with https://, blocking javascript: URI stored-XSS payloads).';

-- ----------------------------------------------------------------------------
-- 4. card_get_mine() — handle the first-access create race gracefully
--    instead of surfacing a raw unique_violation to a losing concurrent call.
-- ----------------------------------------------------------------------------
create or replace function public.card_get_mine()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_card public.employee_cards%rowtype;
begin
  if v_tenant is null then raise exception 'NO_ACTIVE_TENANT'; end if;

  select * into v_card from public.employee_cards
  where user_id = auth.uid() and tenant_id = v_tenant and not is_deleted;

  if not found then
    begin
      insert into public.employee_cards (tenant_id, user_id, card_no, public_code)
      values (
        v_tenant, auth.uid(),
        public.generate_number('ID', v_tenant),
        public.generate_card_code(v_tenant)
      )
      returning * into v_card;
    exception when unique_violation then
      -- Two concurrent first-access calls raced; the other one already
      -- created the row (e.g. two tabs, or React StrictMode's double-invoke
      -- in dev). Read back what it created instead of failing this call.
      select * into v_card from public.employee_cards
      where user_id = auth.uid() and tenant_id = v_tenant and not is_deleted;
    end;
  end if;

  return jsonb_build_object(
    'id', v_card.id,
    'card_no', v_card.card_no,
    'public_code', v_card.public_code,
    'visibility', v_card.visibility,
    'template_code', v_card.template_code,
    'theme', v_card.theme,
    'shape', v_card.shape,
    'show_logo', v_card.show_logo,
    'show_photo', v_card.show_photo,
    'linkedin_url', v_card.linkedin_url,
    'extension_phone', v_card.extension_phone,
    'field_visibility', v_card.field_visibility,
    'opens_count', v_card.opens_count,
    'vcf_downloads_count', v_card.vcf_downloads_count,
    'website_clicks_count', v_card.website_clicks_count,
    'calls_count', v_card.calls_count,
    'emails_count', v_card.emails_count,
    'profile', (
      select jsonb_build_object(
        'full_name', u.full_name, 'name_ar', u.name_ar, 'name_en', u.name_en,
        'job_title', u.job_title, 'job_title_ar', u.job_title_ar, 'job_title_en', u.job_title_en,
        'email', u.email, 'mobile', u.mobile, 'avatar_url', u.avatar_url,
        'department_ar', d.name_ar, 'department_en', d.name_en,
        'site_ar', s.name_ar, 'site_en', s.name_en,
        'project_ar', p.name_ar, 'project_en', p.name_en
      )
      from public.users u
      left join public.departments d on d.id = u.department_id
      left join public.sites s on s.id = u.site_id
      left join public.projects p on p.id = u.project_id
      where u.id = auth.uid()
    ),
    'company', (
      select jsonb_build_object(
        'names', coalesce((select jsonb_object_agg(n.language_code, n.name) from public.tenant_names n where n.tenant_id = v_tenant), '{}'::jsonb),
        'logo_light_url', b.logo_light_url,
        'logo_dark_url', b.logo_dark_url,
        'website_url', b.website_url,
        'primary_color', b.primary_color
      )
      from public.tenants t
      left join public.tenant_branding b on b.tenant_id = t.id
      where t.id = v_tenant
    )
  );
end;
$$;
revoke all on function public.card_get_mine() from public;
grant execute on function public.card_get_mine() to authenticated;

comment on function public.card_get_mine() is
  'Authentication: authenticated. Authorization: self only — always returns '
  'the caller''s own card, creating it (with a fresh card_no/public_code) on '
  'first call, with a race-safe fallback if a concurrent call already '
  'created it first (closing audit finding, fixed 050). Rate limiting: n/a. '
  'Expected errors: NO_ACTIVE_TENANT.';

-- ----------------------------------------------------------------------------
-- 5. Indexes — two closing-audit findings:
--
--    a) uq_employee_cards_user was unique on user_id ALONE (no tenant_id),
--       so a genuine multi-tenant member (tenant_memberships lets one person
--       hold Active rows in more than one tenant, exactly like every other
--       tenant-scoped table's unique(tenant_id, x) convention — e.g.
--       tenant_memberships itself) could never have more than one card
--       across all their tenants: the second INSERT always raised
--       unique_violation. Rescoped to (tenant_id, user_id), matching that
--       established convention.
--
--       NOTE (documented, not fixed here — pre-existing, platform-wide, not
--       introduced by this module): fk_employee_cards_user_same_tenant
--       requires employee_cards.tenant_id to match users.tenant_id (the
--       user's HOME tenant — switch_tenant() only ever updates
--       active_tenant_id, never users.tenant_id). A user whose currently
--       ACTIVE tenant differs from their home tenant will still hit that FK
--       on first card access in the non-home tenant. The identical
--       fk_*_same_tenant foreign key (tenant_id, user_id/employee_id)
--       references public.users (tenant_id, id) pattern is used across many
--       pre-existing tables from migration 202608040012 (forms, user_roles,
--       scheme_roles, ...) — this is a platform-wide tenant-switching
--       characteristic, not something employee_cards introduced, and
--       redesigning it is out of this module's scope.
--
--    b) uq_employee_cards_public_code was a plain (case-sensitive) index on
--       the raw column, but every lookup (generate_card_code's collision
--       check, card_public_view, card_track_event) filters on
--       lower(public_code) — a plain index cannot serve that predicate, so
--       every public QR-scan/shared-link/vCard-download request forced a
--       full sequential scan. Replaced with a functional unique index on
--       lower(public_code), mirroring the identical, already-established
--       fix for verifiable_documents.code (202608040017 /
--       202608050036_verify_code_lookup_index.sql) — this also correctly
--       tightens uniqueness to be case-insensitive, matching the
--       case-insensitive lookup semantics (two codes differing only by case
--       were not actually a collision under the old index).
-- ----------------------------------------------------------------------------
drop index if exists public.uq_employee_cards_user;
create unique index if not exists uq_employee_cards_user
  on public.employee_cards (tenant_id, user_id) where not is_deleted;

drop index if exists public.uq_employee_cards_public_code;
create unique index if not exists uq_employee_cards_public_code_lower
  on public.employee_cards (lower(public_code)) where not is_deleted;

-- ----------------------------------------------------------------------------
-- Mandatory closer.
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
