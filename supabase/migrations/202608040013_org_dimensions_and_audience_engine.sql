-- ============================================================================
-- 013 — Organisation dimensions + the shared Audience Targeting Engine
--
-- Two things that only make sense together:
--
--   * The organisation was missing two of its dimensions. Sector lived as free
--     text on the employee record and nationality lived as three unrelated text
--     columns, so neither could ever be picked from a list, filtered on, or
--     targeted. They become first class tables next to departments/projects/
--     sites, and the legacy text is migrated into them.
--
--   * "Who sees this" was decided differently by every module (content_items
--     had publication_level, forms had nothing at all). One engine now answers
--     that question for every module: audience_rules + audience_rule_terms
--     evaluated by public.audience_matches(), which is cheap enough to sit
--     inside RLS. No module ever writes its own targeting logic again.
--
-- The legacy publication_level stays on content_items and is still enforced;
-- the audience rule is ANDed on top, so nothing that used to be hidden becomes
-- visible.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Sectors and countries
-- ----------------------------------------------------------------------------

create table if not exists public.sectors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name_ar text not null,
  name_en text,
  description_ar text,
  description_en text,
  display_order integer not null default 0,
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

create index if not exists idx_sectors_tenant on public.sectors (tenant_id);
create index if not exists idx_sectors_display
  on public.sectors (tenant_id, display_order, name_ar) where not is_deleted;
create unique index if not exists uq_sectors_code_tenant
  on public.sectors (tenant_id, lower(code)) where not is_deleted;
create unique index if not exists uq_sectors_tenant_id on public.sectors (tenant_id, id);

-- A country doubles as the nationality list: the employee screen shows the same
-- rows under two labels, so both spellings live on one row.
create table if not exists public.countries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  iso_code text check (iso_code is null or iso_code ~ '^[A-Z]{2}$'),
  name_ar text not null,
  name_en text,
  nationality_ar text,
  nationality_en text,
  dial_code text,
  description_ar text,
  description_en text,
  display_order integer not null default 0,
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

create index if not exists idx_countries_tenant on public.countries (tenant_id);
create index if not exists idx_countries_display
  on public.countries (tenant_id, display_order, name_ar) where not is_deleted;
create unique index if not exists uq_countries_code_tenant
  on public.countries (tenant_id, lower(code)) where not is_deleted;
create unique index if not exists uq_countries_iso_tenant
  on public.countries (tenant_id, upper(iso_code)) where not is_deleted and iso_code is not null;
create unique index if not exists uq_countries_tenant_id on public.countries (tenant_id, id);

-- ----------------------------------------------------------------------------
-- 2. Employee tags — the free-form dimension the audience engine targets
-- ----------------------------------------------------------------------------

create table if not exists public.employee_tags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name_ar text not null,
  name_en text,
  description_ar text,
  description_en text,
  color text,
  display_order integer not null default 0,
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

create index if not exists idx_employee_tags_tenant on public.employee_tags (tenant_id);
create unique index if not exists uq_employee_tags_code_tenant
  on public.employee_tags (tenant_id, lower(code)) where not is_deleted;
create unique index if not exists uq_employee_tags_tenant_id on public.employee_tags (tenant_id, id);

create table if not exists public.employee_tag_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null,
  tag_id uuid not null,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_employee_tag_assignments_tenant
  on public.employee_tag_assignments (tenant_id);
create index if not exists idx_employee_tag_assignments_employee
  on public.employee_tag_assignments (tenant_id, employee_id) where not is_deleted;
create index if not exists idx_employee_tag_assignments_tag
  on public.employee_tag_assignments (tenant_id, tag_id) where not is_deleted;
create unique index if not exists uq_employee_tag_assignment
  on public.employee_tag_assignments (tenant_id, employee_id, tag_id) where not is_deleted;

-- ----------------------------------------------------------------------------
-- 3. The audience engine tables
-- ----------------------------------------------------------------------------

-- One row per owning record. is_everyone is the default so a record created
-- before anybody opens the picker is visible to the whole company.
create table if not exists public.audience_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  entity_type text not null check (entity_type in (
    'Circular', 'Document', 'Design', 'FormTemplate', 'Announcement',
    'Survey', 'CalendarEvent', 'Certificate', 'Note'
  )),
  entity_id uuid not null,
  match_mode text not null default 'All' check (match_mode in ('All', 'Any')),
  is_everyone boolean not null default true,
  notes text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  unique (tenant_id, entity_type, entity_id)
);

create index if not exists idx_audience_rules_tenant on public.audience_rules (tenant_id);
create unique index if not exists uq_audience_rules_tenant_id
  on public.audience_rules (tenant_id, id);

-- group_no is the bracket: terms inside a group combine with their operator,
-- groups combine with the rule's match_mode. That is what makes
-- "Department = HR AND Project = NEOM NOT Role = Intern" expressible.
create table if not exists public.audience_rule_terms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  rule_id uuid not null,
  group_no smallint not null default 1,
  operator text not null default 'AND' check (operator in ('AND', 'OR', 'NOT')),
  dimension text not null check (dimension in (
    'Everyone', 'Department', 'Project', 'Sector', 'Site', 'Country',
    'Nationality', 'Role', 'Employee', 'PublicationLevel', 'Tag'
  )),
  value_id uuid,
  value_text text,
  display_order integer not null default 0,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now(),
  constraint audience_rule_terms_value_present check (
    dimension = 'Everyone' or value_id is not null or value_text is not null
  )
);

create index if not exists idx_audience_rule_terms_tenant on public.audience_rule_terms (tenant_id);
create index if not exists idx_audience_rule_terms_rule
  on public.audience_rule_terms (tenant_id, rule_id, group_no, display_order) where not is_deleted;
-- "which records target this department" for the admin impact screens.
create index if not exists idx_audience_rule_terms_value
  on public.audience_rule_terms (tenant_id, dimension, value_id) where value_id is not null and not is_deleted;

-- ----------------------------------------------------------------------------
-- 4. Cross-tenant guards, triggers, RLS
-- ----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_tag_assignments_employee_same_tenant') then
    alter table public.employee_tag_assignments
      add constraint fk_tag_assignments_employee_same_tenant
      foreign key (tenant_id, employee_id) references public.users (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_tag_assignments_tag_same_tenant') then
    alter table public.employee_tag_assignments
      add constraint fk_tag_assignments_tag_same_tenant
      foreign key (tenant_id, tag_id) references public.employee_tags (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_audience_terms_rule_same_tenant') then
    alter table public.audience_rule_terms
      add constraint fk_audience_terms_rule_same_tenant
      foreign key (tenant_id, rule_id) references public.audience_rules (tenant_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_users_sector_same_tenant') then
    alter table public.users
      add constraint fk_users_sector_same_tenant
      foreign key (tenant_id, sector_id) references public.sectors (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_users_country_same_tenant') then
    alter table public.users
      add constraint fk_users_country_same_tenant
      foreign key (tenant_id, country_id) references public.countries (tenant_id, id);
  end if;
end $$;

create index if not exists idx_users_sector_id on public.users (tenant_id, sector_id) where not is_deleted;
create index if not exists idx_users_country_id on public.users (tenant_id, country_id) where not is_deleted;

do $$
declare
  new_tables text[] := array[
    'sectors', 'countries', 'employee_tags', 'employee_tag_assignments',
    'audience_rules', 'audience_rule_terms'
  ];
  tbl text;
begin
  foreach tbl in array new_tables loop
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

-- Organisation dimensions read like departments do: everybody sees the list,
-- only administrators change it. Employees.Manage stays accepted so the
-- existing company administrators keep working before the new code is granted.
do $$
declare
  dimension_tables text[] := array['sectors', 'countries', 'employee_tags'];
  tbl text;
begin
  foreach tbl in array dimension_tables loop
    execute format('drop policy if exists "authenticated read organization dimension" on public.%I', tbl);
    execute format(
      'create policy "authenticated read organization dimension" on public.%I
         for select to authenticated using (not is_deleted)',
      tbl
    );
    execute format('drop policy if exists "organization admins manage dimension" on public.%I', tbl);
    execute format(
      'create policy "organization admins manage dimension" on public.%I
         for all to authenticated
         using (public.has_permission(''Organization.Manage'') or public.has_permission(''Employees.Manage''))
         with check (public.has_permission(''Organization.Manage'') or public.has_permission(''Employees.Manage''))',
      tbl
    );
  end loop;
end $$;

drop policy if exists "authenticated read tag assignments" on public.employee_tag_assignments;
create policy "authenticated read tag assignments" on public.employee_tag_assignments
  for select to authenticated using (not is_deleted);

drop policy if exists "organization admins manage tag assignments" on public.employee_tag_assignments;
create policy "organization admins manage tag assignments" on public.employee_tag_assignments
  for all to authenticated
  using (public.has_permission('Organization.Manage') or public.has_permission('Employees.Manage'))
  with check (public.has_permission('Organization.Manage') or public.has_permission('Employees.Manage'));

-- ----------------------------------------------------------------------------
-- 5. Seed the country list for Shalfa
--    New companies receive theirs from the provisioning migration, so this is
--    deliberately restricted to the one tenant that predates the platform.
-- ----------------------------------------------------------------------------

do $$
declare
  v_shalfa uuid;
begin
  select id into v_shalfa from public.tenants where slug = 'shalfa';
  if v_shalfa is null then
    return;
  end if;

  insert into public.countries (
    tenant_id, code, iso_code, name_ar, name_en,
    nationality_ar, nationality_en, dial_code, display_order
  )
  select v_shalfa, c.iso, c.iso, c.name_ar, c.name_en, c.nat_ar, c.nat_en, c.dial, c.ord
  from (values
    ('SA', 'المملكة العربية السعودية', 'Saudi Arabia', 'سعودي', 'Saudi', '+966', 10),
    ('AE', 'الإمارات العربية المتحدة', 'United Arab Emirates', 'إماراتي', 'Emirati', '+971', 20),
    ('KW', 'الكويت', 'Kuwait', 'كويتي', 'Kuwaiti', '+965', 30),
    ('QA', 'قطر', 'Qatar', 'قطري', 'Qatari', '+974', 40),
    ('BH', 'البحرين', 'Bahrain', 'بحريني', 'Bahraini', '+973', 50),
    ('OM', 'سلطنة عُمان', 'Oman', 'عُماني', 'Omani', '+968', 60),
    ('YE', 'اليمن', 'Yemen', 'يمني', 'Yemeni', '+967', 70),
    ('EG', 'مصر', 'Egypt', 'مصري', 'Egyptian', '+20', 80),
    ('SD', 'السودان', 'Sudan', 'سوداني', 'Sudanese', '+249', 90),
    ('JO', 'الأردن', 'Jordan', 'أردني', 'Jordanian', '+962', 100),
    ('SY', 'سوريا', 'Syria', 'سوري', 'Syrian', '+963', 110),
    ('LB', 'لبنان', 'Lebanon', 'لبناني', 'Lebanese', '+961', 120),
    ('PS', 'فلسطين', 'Palestine', 'فلسطيني', 'Palestinian', '+970', 130),
    ('IQ', 'العراق', 'Iraq', 'عراقي', 'Iraqi', '+964', 140),
    ('MA', 'المغرب', 'Morocco', 'مغربي', 'Moroccan', '+212', 150),
    ('TN', 'تونس', 'Tunisia', 'تونسي', 'Tunisian', '+216', 160),
    ('DZ', 'الجزائر', 'Algeria', 'جزائري', 'Algerian', '+213', 170),
    ('LY', 'ليبيا', 'Libya', 'ليبي', 'Libyan', '+218', 180),
    ('MR', 'موريتانيا', 'Mauritania', 'موريتاني', 'Mauritanian', '+222', 190),
    ('SO', 'الصومال', 'Somalia', 'صومالي', 'Somali', '+252', 200),
    ('DJ', 'جيبوتي', 'Djibouti', 'جيبوتي', 'Djiboutian', '+253', 210),
    ('ER', 'إريتريا', 'Eritrea', 'إريتري', 'Eritrean', '+291', 220),
    ('ET', 'إثيوبيا', 'Ethiopia', 'إثيوبي', 'Ethiopian', '+251', 230),
    ('KE', 'كينيا', 'Kenya', 'كيني', 'Kenyan', '+254', 240),
    ('NG', 'نيجيريا', 'Nigeria', 'نيجيري', 'Nigerian', '+234', 250),
    ('IN', 'الهند', 'India', 'هندي', 'Indian', '+91', 260),
    ('PK', 'باكستان', 'Pakistan', 'باكستاني', 'Pakistani', '+92', 270),
    ('BD', 'بنغلاديش', 'Bangladesh', 'بنغلاديشي', 'Bangladeshi', '+880', 280),
    ('LK', 'سريلانكا', 'Sri Lanka', 'سريلانكي', 'Sri Lankan', '+94', 290),
    ('NP', 'نيبال', 'Nepal', 'نيبالي', 'Nepali', '+977', 300),
    ('PH', 'الفلبين', 'Philippines', 'فلبيني', 'Filipino', '+63', 310),
    ('ID', 'إندونيسيا', 'Indonesia', 'إندونيسي', 'Indonesian', '+62', 320),
    ('MY', 'ماليزيا', 'Malaysia', 'ماليزي', 'Malaysian', '+60', 330),
    ('TR', 'تركيا', 'Turkiye', 'تركي', 'Turkish', '+90', 340),
    ('US', 'الولايات المتحدة الأمريكية', 'United States', 'أمريكي', 'American', '+1', 350),
    ('GB', 'المملكة المتحدة', 'United Kingdom', 'بريطاني', 'British', '+44', 360),
    ('CA', 'كندا', 'Canada', 'كندي', 'Canadian', '+1', 370),
    ('FR', 'فرنسا', 'France', 'فرنسي', 'French', '+33', 380),
    ('DE', 'ألمانيا', 'Germany', 'ألماني', 'German', '+49', 390)
  ) as c(iso, name_ar, name_en, nat_ar, nat_en, dial, ord)
  where not exists (
    select 1 from public.countries x
    where x.tenant_id = v_shalfa and upper(x.iso_code) = c.iso
  );
end $$;

-- ----------------------------------------------------------------------------
-- 6. Migrate the legacy employee text into the new dimensions
-- ----------------------------------------------------------------------------

do $$
declare
  v_shalfa uuid;
begin
  select id into v_shalfa from public.tenants where slug = 'shalfa';
  if v_shalfa is null then
    return;
  end if;

  -- Every distinct users.sector value becomes a sector row, case-insensitively.
  -- The legacy value is free Arabic text, so a readable code cannot always be
  -- derived from it; the hash suffix keeps the code unique and the migration
  -- re-runnable, and the administrator renames it from the new screen.
  insert into public.sectors (tenant_id, code, name_ar, display_order)
  select
    v_shalfa,
    coalesce(
      nullif(left(upper(regexp_replace(u.sector_name, '[^a-zA-Z0-9]+', '_', 'g')), 24), '_'),
      'SEC'
    ) || '_' || upper(left(md5(lower(u.sector_name)), 6)),
    u.sector_name,
    0
  from (
    select distinct on (lower(trim(sector))) trim(sector) as sector_name
    from public.users
    where tenant_id = v_shalfa and coalesce(trim(sector), '') <> ''
    order by lower(trim(sector))
  ) u
  where not exists (
    select 1 from public.sectors s
    where s.tenant_id = v_shalfa
      and not s.is_deleted
      and lower(s.name_ar) = lower(u.sector_name)
  );

  update public.users u
  set sector_id = m.sector_id
  from (
    select
      x.id as user_id,
      (
        select s.id from public.sectors s
        where s.tenant_id = v_shalfa
          and not s.is_deleted
          and lower(s.name_ar) = lower(trim(x.sector))
        order by s.display_order, s.created_on
        limit 1
      ) as sector_id
    from public.users x
    where x.tenant_id = v_shalfa
      and x.sector_id is null
      and coalesce(trim(x.sector), '') <> ''
  ) m
  where u.id = m.user_id and m.sector_id is not null;

  -- Nationality was stored three different ways; accept any of them, plus the
  -- ISO code, and pick one country deterministically.
  update public.users u
  set country_id = m.country_id
  from (
    select
      x.id as user_id,
      (
        select c.id from public.countries c
        where c.tenant_id = v_shalfa
          and not c.is_deleted
          and (
            lower(nullif(trim(x.nationality_ar), '')) = lower(c.nationality_ar)
            or lower(nullif(trim(x.nationality_en), '')) = lower(c.nationality_en)
            or lower(nullif(trim(x.nationality), '')) in (
                 lower(c.nationality_ar), lower(c.nationality_en),
                 lower(c.name_ar), lower(c.name_en)
               )
            or upper(nullif(trim(x.nationality), '')) = c.iso_code
          )
        order by c.display_order, c.iso_code
        limit 1
      ) as country_id
    from public.users x
    where x.tenant_id = v_shalfa
      and x.country_id is null
      and coalesce(x.nationality, x.nationality_ar, x.nationality_en) is not null
  ) m
  where u.id = m.user_id and m.country_id is not null;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Permissions
-- ----------------------------------------------------------------------------

insert into public.permissions (code, module, description) values
  ('Organization.Manage', 'Organization', 'Manage departments, sectors, sites, projects and countries'),
  ('Audience.Manage', 'Organization', 'Decide who sees a record through the audience engine'),
  ('Forms.Manage', 'Forms', 'Manage form templates and the audience bound to them')
on conflict (code) do nothing;

insert into public.role_permissions (tenant_id, role_id, permission_id)
select r.tenant_id, r.id, p.id
from public.roles r
join public.permissions p
  on p.code in ('Organization.Manage', 'Audience.Manage', 'Forms.Manage')
where r.code in ('PLATFORM_ADMIN', 'SYSTEM_ADMIN')
  and not r.is_deleted
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- 8. The engine
-- ----------------------------------------------------------------------------

-- Editing an audience is allowed to whoever may publish the owning record;
-- the engine deliberately has no permission code of its own per module.
create or replace function public.audience_can_manage()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission('Audience.Manage')
      or public.has_permission('Content.Manage')
      or public.has_permission('Announcements.Manage')
      or public.has_permission('Surveys.Manage')
      or public.has_permission('Calendar.Manage')
      or public.has_permission('Forms.Manage')
      or public.has_permission('Verification.Manage');
$$;
grant execute on function public.audience_can_manage() to authenticated;

-- The single question every module asks. Called from RLS, so the unbound case
-- (no rule, or is_everyone) has to cost one index probe and nothing more.
create or replace function public.audience_matches(
  p_entity_type text,
  p_entity_id uuid,
  p_user_id uuid default auth.uid()
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_user public.users%rowtype;
  v_rule public.audience_rules%rowtype;
  v_term public.audience_rule_terms%rowtype;
  v_group smallint;
  v_hit boolean;
  v_group_ok boolean;
  v_and_ok boolean;
  v_or_seen boolean;
  v_or_ok boolean;
  v_any_group boolean := false;
  v_all_ok boolean := true;
  v_any_ok boolean := false;
  v_rank integer := -1;
  v_dept_ids uuid[];
  v_role_ids uuid[];
  v_role_codes text[];
begin
  if p_entity_id is null or p_user_id is null then
    return false;
  end if;

  select * into v_user from public.users u where u.id = p_user_id and not u.is_deleted;
  if not found then
    return false;
  end if;

  v_tenant := coalesce(public.current_tenant_id(), v_user.active_tenant_id, v_user.tenant_id);
  if v_tenant is null then
    return false;
  end if;

  -- Definer rights bypass RLS, so the company boundary has to be re-checked by
  -- hand: p_user_id is caller supplied and an employee of another company must
  -- never be evaluated against this company's rule.
  if coalesce(v_user.active_tenant_id, v_user.tenant_id) is distinct from v_tenant then
    return false;
  end if;

  select * into v_rule
  from public.audience_rules r
  where r.tenant_id = v_tenant
    and r.entity_type = p_entity_type
    and r.entity_id = p_entity_id
    and not r.is_deleted;

  -- A record nobody has targeted belongs to the whole company.
  if not found or v_rule.is_everyone then
    return true;
  end if;

  for v_group in
    select distinct t.group_no
    from public.audience_rule_terms t
    where t.tenant_id = v_tenant and t.rule_id = v_rule.id and not t.is_deleted
    order by 1
  loop
    v_any_group := true;
    v_group_ok := true;
    v_and_ok := true;
    v_or_seen := false;
    v_or_ok := false;

    for v_term in
      select *
      from public.audience_rule_terms t
      where t.tenant_id = v_tenant
        and t.rule_id = v_rule.id
        and not t.is_deleted
        and t.group_no = v_group
      order by t.display_order, t.created_on
    loop
      case v_term.dimension
        when 'Everyone' then
          v_hit := true;

        when 'Department' then
          if v_dept_ids is null then
            -- Walking up from the employee once is the same answer as expanding
            -- every targeted department downwards, and it is bounded by depth.
            v_dept_ids := (
              with recursive chain as (
                select d.id, d.parent_id, 1 as depth
                from public.departments d
                where d.tenant_id = v_tenant and d.id = v_user.department_id and not d.is_deleted
                union all
                select p.id, p.parent_id, c.depth + 1
                from public.departments p
                join chain c on p.id = c.parent_id
                where p.tenant_id = v_tenant and not p.is_deleted and c.depth < 20
              )
              select coalesce(array_agg(chain.id), '{}'::uuid[]) from chain
            );
          end if;
          v_hit := v_term.value_id is not null and v_term.value_id = any (v_dept_ids);

        when 'Project' then
          v_hit := v_term.value_id is not null and v_user.project_id = v_term.value_id;

        when 'Sector' then
          v_hit := v_term.value_id is not null and v_user.sector_id = v_term.value_id;

        when 'Site' then
          v_hit := v_term.value_id is not null and v_user.site_id = v_term.value_id;

        when 'Country', 'Nationality' then
          v_hit := (v_term.value_id is not null and v_user.country_id = v_term.value_id)
            or (
              v_term.value_text is not null
              and (
                upper(trim(v_term.value_text)) in (
                  upper(nullif(trim(v_user.nationality), '')),
                  upper(nullif(trim(v_user.nationality_ar), '')),
                  upper(nullif(trim(v_user.nationality_en), ''))
                )
                or exists (
                  select 1 from public.countries c
                  where c.tenant_id = v_tenant
                    and c.id = v_user.country_id
                    and upper(trim(v_term.value_text)) in (upper(c.iso_code), upper(c.code))
                )
              )
            );

        when 'Role' then
          if v_role_ids is null then
            select
              coalesce(array_agg(r.id), '{}'::uuid[]),
              coalesce(array_agg(upper(r.code)), '{}'::text[])
            into v_role_ids, v_role_codes
            from public.user_roles ur
            join public.roles r on r.id = ur.role_id
            where ur.user_id = p_user_id
              and r.tenant_id = v_tenant
              and r.is_active
              and not r.is_deleted;
          end if;
          v_hit := (v_term.value_id is not null and v_term.value_id = any (v_role_ids))
            or (v_term.value_text is not null and upper(trim(v_term.value_text)) = any (v_role_codes));

        when 'Employee' then
          v_hit := (v_term.value_id is not null and v_term.value_id = p_user_id)
            or (v_term.value_text is not null and trim(v_term.value_text) = v_user.employee_no);

        when 'PublicationLevel' then
          if v_rank < 0 then
            if p_user_id = auth.uid() then
              v_rank := public.current_content_access_rank();
            else
              select coalesce(max(
                case r.code
                  when 'PLATFORM_OPERATOR' then 4
                  when 'PLATFORM_ADMIN' then 4
                  when 'SYSTEM_ADMIN' then 4
                  when 'DEPARTMENT_MANAGER' then 3
                  when 'DEPARTMENT_COORDINATOR' then 2
                  when 'EMPLOYEE' then 1
                  else 0
                end
              ), 0) into v_rank
              from public.user_roles ur
              join public.roles r on r.id = ur.role_id
              where ur.user_id = p_user_id
                and r.tenant_id = v_tenant
                and r.is_active
                and not r.is_deleted;
            end if;
          end if;
          v_hit := v_rank >= case upper(coalesce(v_term.value_text, ''))
                               when 'PUBLIC' then 1
                               when 'ADMINISTRATIVE' then 2
                               when 'MANAGER_RESTRICTED' then 3
                               when 'PRIVATE_RESTRICTED' then 4
                               else 99
                             end;

        when 'Tag' then
          v_hit := exists (
            select 1
            from public.employee_tag_assignments a
            left join public.employee_tags g
              on g.id = a.tag_id and g.tenant_id = a.tenant_id
            where a.tenant_id = v_tenant
              and a.employee_id = p_user_id
              and not a.is_deleted
              and (
                (v_term.value_id is not null and a.tag_id = v_term.value_id)
                or (v_term.value_text is not null and upper(g.code) = upper(trim(v_term.value_text)))
              )
          );

        else
          v_hit := false;
      end case;

      v_hit := coalesce(v_hit, false);

      if v_term.operator = 'NOT' then
        if v_hit then
          v_group_ok := false;
        end if;
      elsif v_term.operator = 'OR' then
        v_or_seen := true;
        if v_hit then
          v_or_ok := true;
        end if;
      else
        if not v_hit then
          v_and_ok := false;
        end if;
      end if;
    end loop;

    v_group_ok := v_group_ok and v_and_ok and (not v_or_seen or v_or_ok);

    if v_group_ok then
      if v_rule.match_mode = 'Any' then
        return true;
      end if;
      v_any_ok := true;
    else
      if v_rule.match_mode <> 'Any' then
        return false;
      end if;
      v_all_ok := false;
    end if;
  end loop;

  -- A rule that was narrowed but left without terms is treated as unrestricted
  -- rather than as "nobody"; losing a record is worse than over-sharing it
  -- inside one company, and the picker never saves this shape.
  if not v_any_group then
    return true;
  end if;

  if v_rule.match_mode = 'Any' then
    return v_any_ok;
  end if;
  return v_all_ok;
end;
$$;
-- The user_id argument makes this the one engine function that must never be
-- reachable without a session: execute defaults to PUBLIC, which would let an
-- anonymous caller ask the definer about any employee of any company.
revoke all on function public.audience_matches(text, uuid, uuid) from public;
grant execute on function public.audience_matches(text, uuid, uuid) to authenticated, service_role;

-- The shape <AudiencePicker /> renders and hands straight back to audience_save.
create or replace function public.audience_describe(p_entity_type text, p_entity_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ctx as (
    select public.current_tenant_id() as tid
  ),
  bound_rule as (
    select r.*
    from public.audience_rules r, ctx
    where r.tenant_id = ctx.tid
      and r.entity_type = p_entity_type
      and r.entity_id = p_entity_id
      and not r.is_deleted
  ),
  term as (
    select
      t.group_no,
      t.display_order,
      jsonb_build_object(
        'id', t.id,
        'group_no', t.group_no,
        'operator', t.operator,
        'dimension', t.dimension,
        'value_id', t.value_id,
        'value_text', t.value_text,
        'display_order', t.display_order,
        'label_ar', case
          when t.dimension = 'Department' then (select d.name_ar from public.departments d where d.id = t.value_id and d.tenant_id = ctx.tid)
          when t.dimension = 'Project' then (select pr.name_ar from public.projects pr where pr.id = t.value_id and pr.tenant_id = ctx.tid)
          when t.dimension = 'Sector' then (select se.name_ar from public.sectors se where se.id = t.value_id and se.tenant_id = ctx.tid)
          when t.dimension = 'Site' then (select si.name_ar from public.sites si where si.id = t.value_id and si.tenant_id = ctx.tid)
          when t.dimension in ('Country', 'Nationality') then (select co.name_ar from public.countries co where co.id = t.value_id and co.tenant_id = ctx.tid)
          when t.dimension = 'Role' then (select ro.name_ar from public.roles ro where ro.id = t.value_id and ro.tenant_id = ctx.tid)
          when t.dimension = 'Employee' then (select coalesce(us.name_ar, us.full_name, us.email) from public.users us where us.id = t.value_id and us.tenant_id = ctx.tid)
          when t.dimension = 'Tag' then (select tg.name_ar from public.employee_tags tg where tg.id = t.value_id and tg.tenant_id = ctx.tid)
          else t.value_text
        end,
        'label_en', case
          when t.dimension = 'Department' then (select d.name_en from public.departments d where d.id = t.value_id and d.tenant_id = ctx.tid)
          when t.dimension = 'Project' then (select pr.name_en from public.projects pr where pr.id = t.value_id and pr.tenant_id = ctx.tid)
          when t.dimension = 'Sector' then (select se.name_en from public.sectors se where se.id = t.value_id and se.tenant_id = ctx.tid)
          when t.dimension = 'Site' then (select si.name_en from public.sites si where si.id = t.value_id and si.tenant_id = ctx.tid)
          when t.dimension in ('Country', 'Nationality') then (select co.name_en from public.countries co where co.id = t.value_id and co.tenant_id = ctx.tid)
          when t.dimension = 'Role' then (select ro.name_en from public.roles ro where ro.id = t.value_id and ro.tenant_id = ctx.tid)
          when t.dimension = 'Employee' then (select coalesce(us.name_en, us.full_name, us.email) from public.users us where us.id = t.value_id and us.tenant_id = ctx.tid)
          when t.dimension = 'Tag' then (select tg.name_en from public.employee_tags tg where tg.id = t.value_id and tg.tenant_id = ctx.tid)
          else t.value_text
        end
      ) as payload
    from public.audience_rule_terms t
    join bound_rule on bound_rule.id = t.rule_id
    cross join ctx
    where t.tenant_id = ctx.tid and not t.is_deleted
  )
  select jsonb_build_object(
    'entity_type', p_entity_type,
    'entity_id', p_entity_id,
    'rule_id', (select id from bound_rule),
    'has_rule', exists (select 1 from bound_rule),
    'match_mode', coalesce((select match_mode from bound_rule), 'All'),
    'is_everyone', coalesce((select is_everyone from bound_rule), true),
    'terms', coalesce((
      select jsonb_agg(payload order by group_no, display_order) from term
    ), '[]'::jsonb),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object('group_no', g.group_no, 'terms', g.terms) order by g.group_no)
      from (
        select group_no, jsonb_agg(payload order by display_order) as terms
        from term
        group by group_no
      ) g
    ), '[]'::jsonb)
  );
$$;
grant execute on function public.audience_describe(text, uuid) to authenticated;

-- Replaces the whole rule for one record. Any failure aborts the call, so a
-- half-written audience can never reach the table.
create or replace function public.audience_save(p_entity_type text, p_entity_id uuid, p_rule jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_rule_id uuid;
  v_mode text;
  v_everyone boolean;
  v_terms jsonb;
  v_term jsonb;
  v_dimension text;
  v_operator text;
  v_group smallint;
  v_order integer := 0;
begin
  if v_tenant is null then
    raise exception 'TENANT_NOT_RESOLVED';
  end if;
  if not public.audience_can_manage() then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_entity_id is null then
    raise exception 'ENTITY_REQUIRED';
  end if;
  if coalesce(p_entity_type, '') not in (
    'Circular', 'Document', 'Design', 'FormTemplate', 'Announcement',
    'Survey', 'CalendarEvent', 'Certificate', 'Note'
  ) then
    raise exception 'INVALID_ENTITY_TYPE';
  end if;

  p_rule := coalesce(p_rule, '{}'::jsonb);
  v_mode := coalesce(nullif(trim(p_rule ->> 'match_mode'), ''), 'All');
  if v_mode not in ('All', 'Any') then
    raise exception 'INVALID_MATCH_MODE';
  end if;
  v_everyone := coalesce((p_rule ->> 'is_everyone')::boolean, false);

  v_terms := coalesce(p_rule -> 'terms', '[]'::jsonb);
  if jsonb_typeof(v_terms) <> 'array' then
    raise exception 'INVALID_TERMS';
  end if;

  -- audience_describe returns both shapes; accept the grouped one too.
  if jsonb_array_length(v_terms) = 0 and jsonb_typeof(p_rule -> 'groups') = 'array' then
    select coalesce(jsonb_agg(
             t.item || jsonb_build_object(
               'group_no',
               coalesce((t.item ->> 'group_no')::int, (g.grp ->> 'group_no')::int, 1)
             )
           ), '[]'::jsonb)
    into v_terms
    from jsonb_array_elements(p_rule -> 'groups') as g(grp)
    cross join lateral jsonb_array_elements(coalesce(g.grp -> 'terms', '[]'::jsonb)) as t(item);
  end if;

  insert into public.audience_rules (tenant_id, entity_type, entity_id, match_mode, is_everyone, notes)
  values (v_tenant, p_entity_type, p_entity_id, v_mode, v_everyone, nullif(trim(p_rule ->> 'notes'), ''))
  on conflict (tenant_id, entity_type, entity_id) do update
    set match_mode = excluded.match_mode,
        is_everyone = excluded.is_everyone,
        notes = excluded.notes,
        is_deleted = false
  returning id into v_rule_id;

  delete from public.audience_rule_terms
  where tenant_id = v_tenant and rule_id = v_rule_id;

  for v_term in select e.item from jsonb_array_elements(v_terms) as e(item) loop
    v_dimension := nullif(trim(v_term ->> 'dimension'), '');
    if v_dimension is null then
      raise exception 'DIMENSION_REQUIRED';
    end if;
    if v_dimension not in (
      'Everyone', 'Department', 'Project', 'Sector', 'Site', 'Country',
      'Nationality', 'Role', 'Employee', 'PublicationLevel', 'Tag'
    ) then
      raise exception 'INVALID_DIMENSION';
    end if;

    v_operator := upper(coalesce(nullif(trim(v_term ->> 'operator'), ''), 'AND'));
    if v_operator not in ('AND', 'OR', 'NOT') then
      raise exception 'INVALID_OPERATOR';
    end if;

    v_group := coalesce((nullif(trim(v_term ->> 'group_no'), ''))::smallint, 1);

    if v_dimension <> 'Everyone'
       and nullif(trim(v_term ->> 'value_id'), '') is null
       and nullif(trim(v_term ->> 'value_text'), '') is null then
      raise exception 'TERM_VALUE_REQUIRED';
    end if;

    v_order := v_order + 1;

    insert into public.audience_rule_terms (
      tenant_id, rule_id, group_no, operator, dimension, value_id, value_text, display_order
    )
    values (
      v_tenant,
      v_rule_id,
      v_group,
      v_operator,
      v_dimension,
      nullif(trim(v_term ->> 'value_id'), '')::uuid,
      nullif(trim(v_term ->> 'value_text'), ''),
      coalesce((nullif(trim(v_term ->> 'display_order'), ''))::integer, v_order)
    );
  end loop;

  -- "Everyone" and "no terms" are the same audience; store it once so the
  -- read path stops at the rule row.
  if v_order = 0 then
    update public.audience_rules set is_everyone = true where id = v_rule_id;
  end if;

  return public.audience_describe(p_entity_type, p_entity_id);
end;
$$;
grant execute on function public.audience_save(text, uuid, jsonb) to authenticated;

-- Feed helper. For the entity types already bound to a table it answers from
-- that table, so a record without a rule is correctly included.
create or replace function public.audience_visible_ids(p_entity_type text)
returns setof uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then
    return;
  end if;

  if p_entity_type in ('Circular', 'Document', 'Design') then
    return query
      select c.id
      from public.content_items c
      where c.tenant_id = v_tenant
        and not c.is_deleted
        and c.content_type = p_entity_type
        -- Definer rights bypass the read policy, so the publication gate that
        -- policy applies has to be repeated here or this helper hands every
        -- employee the ids of unpublished and restricted records.
        and c.is_published
        and (c.expiry_date is null or c.expiry_date > now())
        and public.current_content_access_rank() >=
          case c.publication_level
            when 'PUBLIC' then 1
            when 'ADMINISTRATIVE' then 2
            when 'MANAGER_RESTRICTED' then 3
            when 'PRIVATE_RESTRICTED' then 4
            else 99
          end
        and public.audience_matches(p_entity_type, c.id);
    return;
  end if;

  if p_entity_type = 'FormTemplate' then
    return query
      select t.id
      from public.templates t
      where t.tenant_id = v_tenant
        and not t.is_deleted
        and t.is_active
        and public.audience_matches('FormTemplate', t.id);
    return;
  end if;

  -- Modules whose tables arrive later: answer from the stored rules. Records
  -- of those types that carry no rule are visible to everyone by definition.
  return query
    select r.entity_id
    from public.audience_rules r
    where r.tenant_id = v_tenant
      and r.entity_type = p_entity_type
      and not r.is_deleted
      and public.audience_matches(p_entity_type, r.entity_id);
end;
$$;
grant execute on function public.audience_visible_ids(text) to authenticated;

-- Rules are metadata about who is being targeted; only the people who may
-- publish read them directly. Everyone else goes through the definer RPCs.
drop policy if exists "audience managers read rules" on public.audience_rules;
create policy "audience managers read rules" on public.audience_rules
  for select to authenticated
  using (not is_deleted and public.audience_can_manage());

drop policy if exists "audience managers manage rules" on public.audience_rules;
create policy "audience managers manage rules" on public.audience_rules
  for all to authenticated
  using (public.audience_can_manage())
  with check (public.audience_can_manage());

drop policy if exists "audience managers read terms" on public.audience_rule_terms;
create policy "audience managers read terms" on public.audience_rule_terms
  for select to authenticated
  using (not is_deleted and public.audience_can_manage());

drop policy if exists "audience managers manage terms" on public.audience_rule_terms;
create policy "audience managers manage terms" on public.audience_rule_terms
  for all to authenticated
  using (public.audience_can_manage())
  with check (public.audience_can_manage());

-- ----------------------------------------------------------------------------
-- 9. Bind the engine to what already exists
--
--    Both replacements DROP the previous permissive read policy: permissive
--    policies are ORed, so leaving the old one in place would let every row
--    back in through the side door.
-- ----------------------------------------------------------------------------

-- content_items keeps publication_level for backward compatibility; the
-- audience rule is an additional gate, never a looser one. The entity type is
-- the content_type itself (Circular / Document / Design).
drop policy if exists "role governed read published content" on public.content_items;
drop policy if exists "authenticated read published content" on public.content_items;
drop policy if exists "audience governed read published content" on public.content_items;
create policy "audience governed read published content" on public.content_items
  for select to authenticated
  using (
    is_published
    and not is_deleted
    and (expiry_date is null or expiry_date > now())
    and public.current_content_access_rank() >=
      case publication_level
        when 'PUBLIC' then 1
        when 'ADMINISTRATIVE' then 2
        when 'MANAGER_RESTRICTED' then 3
        when 'PRIVATE_RESTRICTED' then 4
        else 99
      end
    and public.audience_matches(content_type, id)
  );

-- A form template is offered only to the audience bound to it. Administrators
-- keep seeing the whole catalogue so they can bind one in the first place.
drop policy if exists "authenticated users can read active templates" on public.templates;
drop policy if exists "audience governed read templates" on public.templates;
create policy "audience governed read templates" on public.templates
  for select to authenticated
  using (
    not is_deleted
    and (
      (is_active and public.audience_matches('FormTemplate', id))
      or public.has_permission('Forms.Manage')
      or public.audience_can_manage()
    )
  );

-- templates had no write policy at all (service_role only); the new admin
-- screen needs one.
drop policy if exists "template admins manage templates" on public.templates;
create policy "template admins manage templates" on public.templates
  for all to authenticated
  using (public.has_permission('Forms.Manage'))
  with check (public.has_permission('Forms.Manage'));
