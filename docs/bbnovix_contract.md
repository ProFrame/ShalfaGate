# bbnovix — implementation contract (third update)

Everything built for the third update follows the rules below. They exist so a
dozen independent modules end up looking and behaving like one product.

---

## 1. Tenancy

* One React app, one Supabase project, shared tables, `tenant_id` everywhere.
* `public.tenants` is the company. `slug` is its permanent address
  (`bbnovix.com/{slug}/`) — validated `^[a-z0-9]{2,32}$`, unique, reserved words
  rejected, immutable after creation (DB trigger).
* Two founding tenants: `platform` (the operator workspace, `is_platform = true`)
  and `shalfa` (every pre-existing row).
* Session tenant = `public.current_tenant_id()`
  (`users.active_tenant_id` → fallback `users.tenant_id`).
* `public.switch_tenant(uuid)` moves a session between companies it belongs to.

### Every new business table MUST have

```sql
create table if not exists public.<name> (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  ...,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  is_deleted boolean not null default false,
  deleted_by uuid references auth.users(id),
  deleted_date timestamptz,
  row_version integer not null default 1,
  created_on timestamptz not null default now(),
  updated_on timestamptz not null default now()
);

create index if not exists idx_<name>_tenant on public.<name> (tenant_id);

drop trigger if exists apply_row_defaults on public.<name>;
create trigger apply_row_defaults before insert or update on public.<name>
for each row execute function public.apply_row_defaults();

alter table public.<name> enable row level security;

drop policy if exists "tenant isolation" on public.<name>;
create policy "tenant isolation" on public.<name>
  as restrictive for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
```

`apply_row_defaults` stamps `tenant_id`, `created_by/updated_by`, timestamps and
bumps `row_version`; it also freezes `tenant_id` on update. Because the isolation
policy is **RESTRICTIVE** it is ANDed with the ordinary permission policies, so
each table still needs its own permissive `select` / `all` policies on top.

Cross-tenant references are blocked structurally with composite foreign keys:

```sql
create unique index if not exists uq_<parent>_tenant_id on public.<parent> (tenant_id, id);
alter table public.<child>
  add constraint fk_<child>_<parent>_same_tenant
  foreign key (tenant_id, <parent>_id) references public.<parent> (tenant_id, id);
```

### Helpers available (migration 012)

| Function | Use |
|---|---|
| `current_tenant_id()` | session company |
| `current_tenant_slug()` | session company slug |
| `is_platform_operator()` | true only for `PLATFORM_OPERATOR` in the platform tenant |
| `is_tenant_member(uuid)` | membership check |
| `tenant_has_module(code, tenant?)` | license ∧ per-tenant switch |
| `has_permission(code)` | User + Tenant + Role + Permission |
| `tenant_quota_check(resource, delta)` / `tenant_quota_consume(...)` | limits |
| `generate_verify_code(tenant?)` | `SLUG-############` document codes |
| `tenant_public_profile(slug)` | anon-readable branding payload |
| `slug_is_available(slug)` | anon-readable signup check |

## 2. Naming and conventions (existing codebase style — do not deviate)

* `snake_case`, plural tables, `is_*` booleans, `display_order`, `code` columns.
* Timestamps are **`created_on` / `updated_on`**, soft delete is
  `is_deleted` + `deleted_by` + `deleted_date`.
* No Postgres enums — `text` + `check (col in (...))` with PascalCase values.
* RPC errors: `raise exception 'SCREAMING_SNAKE_CODE'`; the client maps the code
  to a translation key.
* Bilingual master data uses `name_1` / `name_2` semantics. **New** tables use
  `name_1` (primary) and `name_2` (secondary) — never "Arabic name"/"English
  name" wording in labels. Existing `name_ar` / `name_en` columns stay as they
  are but are **labelled** `name_1` / `name_2` in the UI.
* Migration files: `2026MMDDNNNN_snake_case.sql`, 12-digit prefix, sequence is
  global and continues from `0012`.

## 3. Roles

| Code | Scope |
|---|---|
| `PLATFORM_OPERATOR` | platform tenant only — never visible to a company |
| `PLATFORM_ADMIN` | company administrator (full rights inside their company) |
| `SYSTEM_ADMIN` | company system administrator |
| `DEPARTMENT_MANAGER`, `DEPARTMENT_COORDINATOR`, `EMPLOYEE` | ordinary roles |

Permission codes follow `Area.Action` (`Announcements.Manage`). Never gate on a
role code in SQL — gate on `has_permission()`.

## 4. Audience targeting

Every module that decides "who sees this" uses the shared engine, never its own
logic:

* `public.audience_rules` — one row per owning record
  (`entity_type`, `entity_id`, `match_mode`).
* `public.audience_rule_terms` — `group_no`, `operator` (`AND` / `OR` / `NOT`),
  `dimension` (`Everyone`, `Department`, `Project`, `Sector`, `Site`, `Country`,
  `Nationality`, `Role`, `Employee`, `PublicationLevel`, `Tag`), `value_id` /
  `value_text`.
* `public.audience_matches(entity_type, entity_id, user_id default auth.uid())`
  → boolean, used inside RLS and inside feed RPCs.
* React: `<AudiencePicker value={rule} onChange={...} />` from
  `src/components/audience/AudiencePicker.jsx`.

Entity types: `Circular`, `Document`, `Design`, `FormTemplate`, `Announcement`,
`Survey`, `CalendarEvent`, `Certificate`.

## 5. Modules and feature flags

`platform_modules` (catalogue) → `platform_licenses.module_codes` (what the
license grants) → `tenant_modules` (per-company override by the platform
operator). Check with `tenant_has_module(code)` in SQL and
`useTenant().hasModule(code)` in React. A disabled module must disappear from the
navigation, not merely refuse to load.

Module codes in use: `EMPLOYEE_PORTAL, FORMS, APPROVALS, DOCUMENTS,
ANNOUNCEMENTS, CALENDAR, SURVEY, NOTES, CHAT, PERFORMANCE, KNOWLEDGE_BASE,
CERTIFICATES, VERIFICATION, SUPPORT, MARKETPLACE, STORAGE_EXTENDED, PUBLIC_API,
AI`.

## 6. Routing (path based, no more hash)

`bbnovix.com` serves the SPA from the root; `404.html` is emitted as a copy of
`index.html` so deep links work on GitHub Pages.

| Path | Page |
|---|---|
| `/` | redirect to `/portal` |
| `/portal` | bbnovix product site (public) |
| `/signup` | subscription form (public) |
| `/verify`, `/verify/:code` | document verification (public) |
| `/support`, `/support/:ticket` | public support desk |
| `/{slug}/` | company landing page (public, branded) |
| `/{slug}/login`, `/{slug}/reset-password` | branded auth |
| `/{slug}/app/...` | the portal application |
| `/platform/app/...` | operator console (platform tenant only) |

Helpers live in `src/lib/routing.js`:
`parseLocation()`, `tenantPath(slug, sub)`, `appPath(sub)`, `publicUrl(path)`,
`RESERVED_SLUGS`. **Never** hand-build a URL in a component.

## 7. Internationalisation

* `src/i18n/index.js` merges module dictionaries. Each module ships
  `src/i18n/<module>.js` exporting
  `{ ar: {...}, en: {...}, hi: {...}, ur: {...}, tl: {...} }`.
  Never edit another module's dictionary; never add keys inline in a component.
* Zero hardcoded user-facing strings — including `placeholder`, `aria-label`,
  `alt`, `title`, `alert()`, Excel headers and error text.
* Stored values are **codes**; the label is resolved at render time
  (`t('status_' + row.status.toLowerCase())`).
* Localised database text uses the shared helper
  `pickLocalized(row, 'name', lang)` from `src/utils/localize.js`, which walks
  `name_{lang} → name_2 → name_1 → name_en → name_ar`.
* `t(key, vars)` interpolates `{{var}}` (double braces only).

## 8. Storage

Nothing talks to a storage vendor directly. `src/lib/storage/index.js` exposes:

```js
const provider = await getStorageProvider(kind);  // 'core' | 'extended'
await provider.upload({ path, file, contentType });
await provider.getUrl(path);
await provider.remove(paths);
```

* **Core storage** (platform-paid): tenant logo, hero image, favicon, employee
  avatar, employee signature. Bucket `tenant-branding` and `employee-assets`,
  path `tenants/{tenant_id}/...`.
* **Extended storage** (company-paid or platform-granted): documents,
  certificates, chat attachments, form attachments. Routed through the tenant's
  configured provider; when `storage_provider = 'none'` the feature degrades
  gracefully — the UI explains it instead of failing.
* Every upload passes `tenant_quota_check('STORAGE_BYTES', size)` first.

## 9. React conventions

* Function components, hooks, no class components except error boundaries.
* Data access lives in `src/data/<module>Service.js`; components never call
  `supabase` directly.
* Every service function returns `{ data, error }` and never throws.
* Local/demo mode: services honour `useLocalData` from `src/lib/supabaseClient`.
* Styling: the existing design language — soft cards, `--surface` /
  `--border` / `--brand` CSS variables from `src/index.css`, `framer-motion`
  for entrance animation, `lucide-react` icons. Each new module ships its own
  `src/components/<module>/<module>.css` imported from its entry component.
* Icons: `lucide-react` only.
* Company colours come from `useTenant().branding.primary_color` and are applied
  as CSS custom properties on `:root` by `TenantContext` — never hardcode a
  brand colour.

## 10. Cross-module component contract

Modules are written independently, so the components they hand to each other are
fixed. Export exactly these paths and names; import them from exactly these
paths and nowhere else.

| Path | Default export | Consumed by |
|---|---|---|
| `src/components/branding/TenantLogo.jsx` | `TenantLogo` (`{ variant, className }`) | landing, login, shell, footer, print chrome |
| `src/components/branding/ContactChannels.jsx` | `ContactChannels` (`{ compact }`) | footer, portal site |
| `src/components/audience/AudiencePicker.jsx` | `AudiencePicker` (`{ entityType, entityId, value, onChange }`) | content, announcements, surveys, calendar, templates, certificates |
| `src/components/announcements/AnnouncementsWidget.jsx` | `AnnouncementsWidget` | dashboard |
| `src/components/announcements/AnnouncementsAdmin.jsx` | `AnnouncementsAdmin` | admin centre |
| `src/components/surveys/SurveyWidget.jsx` | `SurveyWidget` | dashboard |
| `src/components/surveys/SurveysAdmin.jsx` | `SurveysAdmin` | admin centre |
| `src/components/calendar/CalendarWidget.jsx` | `CalendarWidget` | dashboard |
| `src/components/calendar/CalendarAdmin.jsx` | `CalendarAdmin` | admin centre |
| `src/components/calendar/CalendarPage.jsx` | `CalendarPage` | route `/app/calendar` |
| `src/components/notes/NotesWidget.jsx` | `NotesWidget` | dashboard |
| `src/components/notes/NotesBoard.jsx` | `NotesBoard` | route `/app/notes` |
| `src/components/chat/ChatLauncher.jsx` | `ChatLauncher` | app shell header |
| `src/components/notifications/NotificationBell.jsx` | `NotificationBell` | app shell header |
| `src/components/notifications/NotificationSettings.jsx` | `NotificationSettings` | profile panel |
| `src/components/platform/PlatformConsole.jsx` | `PlatformConsole` | route `/app/platform` |
| `src/components/verification/VerificationCenter.jsx` | `VerificationCenter` | route `/app/verification` |
| `src/components/public/PortalSite.jsx` | `PortalSite` | route `/portal` |
| `src/components/public/SignupPage.jsx` | `SignupPage` | route `/signup` |
| `src/components/public/PublicSupportPage.jsx` | `PublicSupportPage` | route `/support` |
| `src/components/support/SupportPanel.jsx` | `SupportPanel` | admin centre |

Shared helpers already written and ready to use:

* `src/lib/routing.js` — `parseLocation`, `tenantPath`, `publicPath`, `verifyUrl`, `companyUrl`, `RESERVED_SLUGS`, `isValidSlug`.
* `src/utils/localize.js` — `pickLocalized`, `pickFromMap`, `codeLabel`, `formatDate`, `formatDateTime`, `formatNumber`, `formatBytes`, `formatRelative`.
* `src/lib/storage/index.js` — `getStorageProvider`, `canUpload`, `putFile`, `STORAGE_LAYER`, `CORE_BUCKETS`.
* `src/i18n/modules/platform.js` — shared vocabulary (`action_*`, `label_*`, `status_*`, `role_*`, `error_*`, `module_*`, `contact_*`). Reuse these keys instead of inventing duplicates.

## 11. Contexts available

```js
const { lang, locale, isRtl, t, setLang, languages } = useLanguage();
const { profile, session, isAuthenticated, signOut, ... }  = useAuth();
const { theme, setTheme } = usePreferences();
const {
  tenant,          // { id, slug, status, default_language, timezone, ... }
  branding,        // logo_light_url, hero_image_url, primary_color, map_url, ...
  contacts,        // [{ channel, value }]
  settings,        // date_format, rtl_default, chat_*, password_*, ...
  tenantName,      // company name in the active language, with fallback
  hasModule,       // (code) => boolean
  loading, error, refresh,
} = useTenant();
```
