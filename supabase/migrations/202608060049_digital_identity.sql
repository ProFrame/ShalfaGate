-- ============================================================================
-- 049 — Digital Identity (Digital Business Card)
--
-- FourthUpdate.md's mandatory order: Digital Identity is next after
-- Verification (Final Closed, see docs/update4_batch3_verification.md).
-- Discovery (this session) confirmed zero existing code for this module —
-- only three pre-reserved Number Generator source codes ('ID'/'TR'/'CO',
-- owner_module='Digital Identity' in migration 039) and the FourthUpdate.md
-- spec text (lines 298-436) itself.
--
-- Reused, not reimplemented, per bbnovix_contract.md §12 / the platform's
-- no-duplicate-service rule:
--   - generate_number('ID', tenant)      the card's human-readable reference
--   - generate_verify_code()'s shape     the public link's unguessable token
--     (mirrored, not called directly — this module's public code is checked
--     for uniqueness against ITS OWN table, exactly how generate_document_code()
--     wraps the same generator for verifiable_documents.code)
--   - src/components/platform/EntityQrCode.jsx   the card's QR (frontend)
--   - public.is_tenant_member() / current_tenant_slug()   visibility checks
--   - public.write_audit_log()           explicit trigger (new tables don't
--                                         inherit the Global Validation retrofit)
--
-- Deliberately NOT reused: Activity Timeline. record_activity()'s "who did
-- this" actor model doesn't fit "an anonymous stranger opened your card" —
-- the spec's Analytics requirement (opens/VCF downloads/site visits/calls/
-- emails) is a set of COUNTS, not a narrative feed, so it's four counter
-- columns incremented by a dedicated RPC instead, matching the tool to the
-- actual job rather than forcing a narrative-feed service in to check a box.
--
-- Lesson carried over from Verification Service's closing audit (migration
-- 048): a permissive FOR ALL policy on a table with a validated write RPC is
-- how a Blocker happens. employee_cards ships with a single narrow SELECT
-- policy (the owner reading their own row) and NO direct write policy at
-- all — every write goes through card_get_mine()/card_save_settings(),
-- both SECURITY DEFINER, which don't need an RLS grant to do their own job.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Module registration — existing tenants get it automatically via the
--    FREE license's module_codes array, matching how every other module
--    (VERIFICATION, CERTIFICATES, ...) was rolled out with zero per-tenant
--    provisioning step.
-- ----------------------------------------------------------------------------
insert into public.platform_modules (code, name_ar, name_en, category, display_order, is_core)
values ('DIGITAL_IDENTITY', 'الهوية الرقمية', 'Digital Identity', 'Core', 165, false)
on conflict (code) do nothing;

update public.platform_licenses
set module_codes = array_append(module_codes, 'DIGITAL_IDENTITY')
where code = 'FREE' and not ('DIGITAL_IDENTITY' = any (module_codes));

-- ----------------------------------------------------------------------------
-- 2. public.employee_cards — one row per employee, created on first access
-- ----------------------------------------------------------------------------
create table if not exists public.employee_cards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  card_no text,
  public_code text not null,

  visibility text not null default 'CompanyOnly'
    check (visibility in ('Private', 'CompanyOnly', 'Public')),
  template_code text not null default 'Classic'
    check (template_code in ('Classic', 'Modern', 'Minimal', 'Bold')),
  theme text not null default 'Light'
    check (theme in ('Light', 'Dark')),
  shape text not null default 'Rounded'
    check (shape in ('Rounded', 'Square')),
  show_logo boolean not null default true,
  show_photo boolean not null default true,

  -- Not on public.users: card-specific, no other module needs them.
  linkedin_url text,
  extension_phone text,

  -- {"mobile": false, "email": true, ...} — a missing key means "visible"
  -- (the default), so turning a field ON never requires a migration.
  field_visibility jsonb not null default '{}'::jsonb,

  opens_count integer not null default 0,
  vcf_downloads_count integer not null default 0,
  website_clicks_count integer not null default 0,
  calls_count integer not null default 0,
  emails_count integer not null default 0,

  is_active boolean not null default true,

  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

do $guards$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_employee_cards_user_same_tenant') then
    alter table public.employee_cards
      add constraint fk_employee_cards_user_same_tenant
      foreign key (tenant_id, user_id) references public.users (tenant_id, id);
  end if;
end $guards$;

create unique index if not exists uq_employee_cards_user
  on public.employee_cards (user_id) where not is_deleted;
create unique index if not exists uq_employee_cards_public_code
  on public.employee_cards (public_code) where not is_deleted;
create index if not exists idx_employee_cards_tenant
  on public.employee_cards (tenant_id) where not is_deleted;

drop trigger if exists apply_row_defaults on public.employee_cards;
create trigger apply_row_defaults before insert or update on public.employee_cards
for each row execute function public.apply_row_defaults();

drop trigger if exists audit_employee_cards on public.employee_cards;
create trigger audit_employee_cards after insert or update or delete on public.employee_cards
for each row execute function public.write_audit_log();

alter table public.employee_cards enable row level security;

drop policy if exists "tenant isolation" on public.employee_cards;
create policy "tenant isolation" on public.employee_cards
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- The only direct-table access any client ever needs: reading your own card
-- for the "My Card" settings screen. Every write — including creating the
-- row the first time — goes through card_get_mine()/card_save_settings()
-- below; there is deliberately no INSERT/UPDATE/DELETE policy on this table.
drop policy if exists "owners read own card" on public.employee_cards;
create policy "owners read own card" on public.employee_cards
  for select to authenticated
  using (user_id = auth.uid() and not is_deleted);

-- ----------------------------------------------------------------------------
-- 3. generate_card_code() — mirrors generate_document_code()'s wrapper shape
--    exactly: reuse generate_verify_code()'s random SLUG-{12 digits} token,
--    collision-checked against this table specifically.
-- ----------------------------------------------------------------------------
create or replace function public.generate_card_code(p_tenant_id uuid default null)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := coalesce(p_tenant_id, public.current_tenant_id());
  v_code text;
  v_attempts integer := 0;
begin
  loop
    v_code := public.generate_verify_code(v_tenant);
    v_attempts := v_attempts + 1;
    exit when not exists (
      select 1 from public.employee_cards where lower(public_code) = lower(v_code)
    );
    if v_attempts >= 50 then
      raise exception 'CARD_CODE_ALLOCATION_FAILED';
    end if;
  end loop;
  return v_code;
end;
$$;
revoke all on function public.generate_card_code(uuid) from public;
grant execute on function public.generate_card_code(uuid) to authenticated;

comment on function public.generate_card_code(uuid) is
  'Authentication: authenticated. Authorization: none beyond having a '
  'session — only ever called internally by card_get_mine(), never directly '
  'from the client. Reuses generate_verify_code()''s random, non-enumerable '
  'shape (not generate_number()''s sequential one) because this code is a '
  'public secret with no second factor, exactly like a verification code. '
  'Rate limiting: n/a, authenticated-only, no external effect by itself. '
  'Expected errors: CARD_CODE_ALLOCATION_FAILED after 50 collisions.';

-- ----------------------------------------------------------------------------
-- 4. card_get_mine() — loads (creating on first access) the caller's own
--    card, merged with the profile fields it displays but does not own.
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
    insert into public.employee_cards (tenant_id, user_id, card_no, public_code)
    values (
      v_tenant, auth.uid(),
      public.generate_number('ID', v_tenant),
      public.generate_card_code(v_tenant)
    )
    returning * into v_card;
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
  'first call. Rate limiting: n/a. Expected errors: NO_ACTIVE_TENANT.';

-- ----------------------------------------------------------------------------
-- 5. card_save_settings() — the only write path for the card owner
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
    linkedin_url = case when p_payload ? 'linkedin_url' then nullif(trim(p_payload ->> 'linkedin_url'), '') else linkedin_url end,
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
  'INVALID_SHAPE.';

-- ----------------------------------------------------------------------------
-- 6. card_public_view() — the public card page's one data source
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

  v_allowed := case v_card.visibility
    when 'Public' then true
    when 'CompanyOnly' then auth.uid() = v_card.user_id or public.is_tenant_member(v_card.tenant_id)
    when 'Private' then auth.uid() = v_card.user_id
    else false
  end;
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

  if v_hidden is not null then
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
  'anyone) — checked here, not left to the client. Per-field visibility '
  'overrides strip hidden fields server-side before the response is built, '
  'never just client-side. Rate limiting: none yet — todo, same gap noted '
  'for several other anon RPCs in this codebase. Expected errors: none '
  'raised — an unknown, inactive, or not-visible-to-this-caller code '
  'resolves to {found:false}, not an exception, matching verify_document()''s '
  'graceful-not-found convention.';

-- ----------------------------------------------------------------------------
-- 7. card_track_event() — increments one interaction counter
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
begin
  if p_event_type not in ('vcf_download', 'website_click', 'call', 'email') then
    raise exception 'INVALID_EVENT_TYPE';
  end if;

  update public.employee_cards set
    vcf_downloads_count = case when p_event_type = 'vcf_download' then vcf_downloads_count + 1 else vcf_downloads_count end,
    website_clicks_count = case when p_event_type = 'website_click' then website_clicks_count + 1 else website_clicks_count end,
    calls_count = case when p_event_type = 'call' then calls_count + 1 else calls_count end,
    emails_count = case when p_event_type = 'email' then emails_count + 1 else emails_count end
  where lower(public_code) = lower(v_code) and not is_deleted and is_active;
end;
$$;
revoke all on function public.card_track_event(text, text) from public;
grant execute on function public.card_track_event(text, text) to anon, authenticated;

comment on function public.card_track_event(text, text) is
  'Authentication: anon. Authorization: the code is the credential, same as '
  'card_public_view() — a caller who could not see the card already has no '
  'code to track events against. Rate limiting: none yet — todo. Expected '
  'errors: INVALID_EVENT_TYPE; an unknown/inactive code silently updates '
  'zero rows rather than raising, matching card_public_view()''s graceful '
  'not-found convention.';

-- ----------------------------------------------------------------------------
-- 8. Screen registry + reserved slug
-- ----------------------------------------------------------------------------
insert into public.app_screens (code, module_code, area, group_code, name_ar, name_en, icon, route, display_order, min_role_rank)
values ('PORTAL_IDENTITY', 'DIGITAL_IDENTITY', 'Portal', 'Workspace', 'بطاقتي', 'My Card', 'id-card', 'card', 185, 1)
on conflict (code) do update set
  module_code = excluded.module_code, area = excluded.area, group_code = excluded.group_code,
  name_ar = excluded.name_ar, name_en = excluded.name_en, icon = excluded.icon,
  route = excluded.route, display_order = excluded.display_order, min_role_rank = excluded.min_role_rank,
  is_active = true, updated_on = now();

insert into public.platform_reserved_slugs (slug, reason) values
  ('card', 'Public digital business card')
on conflict (slug) do nothing;

-- ----------------------------------------------------------------------------
-- Mandatory closer: every migration batch ends with this, or a GRANT earlier
-- in the same file (or an earlier migration) re-materializes the function's
-- PUBLIC-execute footgun (see 202608050037's header for what that means).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
