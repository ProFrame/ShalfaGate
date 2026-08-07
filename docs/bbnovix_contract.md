# bbnovix — implementation contract

```
Contract Version: 4.0
Effective From: 2026-08-05
```

Breaking changes to a rule below increment the major version; additive or
clarifying changes increment the minor version. A module records the contract
version it was built against in its own phase doc (see
`docs/update4_phase0_platform_core.md` §"الحالة" for the pattern) so a later
reader can tell whether a module predates a rule.

Everything built follows the rules below. They exist so a growing number of
independent modules end up looking and behaving like one product — this
started as coding standards for the third update; from 4.0 it is closer to a
platform architecture contract, because the fourth update adds enough modules
(Assets, Safety, Operations, Digital Identity...) that undocumented governance
stops scaling.

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

### Helpers available (migration 012, extended by later migrations)

| Function | Use |
|---|---|
| `current_tenant_id()` | session company |
| `current_tenant_slug()` | session company slug |
| `is_platform_operator()` | true only for `PLATFORM_OPERATOR` in the platform tenant |
| `is_tenant_member(uuid)` | membership check |
| `tenant_has_module(code, tenant?)` | license ∧ per-tenant switch |
| `has_permission(code)` | User + Tenant + Role + Permission |
| `tenant_quota_check(resource, delta)` / `tenant_quota_consume(...)` | limits |
| `generate_verify_code(tenant?)` | `SLUG-############` document codes — public-verification secret, deliberately non-sequential, do not use for entity numbers |
| `generate_number(source_code, tenant?)` | Platform Core's `INumberGenerator` (migration 039) — `NO-{SLUG}-{SOURCE}-{########}` running number for any entity (Asset, Work Order, Support Ticket...). Catalogue of accepted `source_code`s lives in `public.number_sources`. Every module needing a user-visible number calls this — never its own counter |
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
`Survey`, `CalendarEvent`, `Certificate`, `Note`, `SafetyPpeSet`.

## 5. Modules and feature flags

`platform_modules` (catalogue) → `platform_licenses.module_codes` (what the
license grants) → `tenant_modules` (per-company override by the platform
operator). Check with `tenant_has_module(code)` in SQL and
`useTenant().hasModule(code)` in React. A disabled module must disappear from the
navigation, not merely refuse to load.

Module codes in use: `EMPLOYEE_PORTAL, FORMS, APPROVALS, DOCUMENTS,
ANNOUNCEMENTS, CALENDAR, SURVEY, NOTES, CHAT, PERFORMANCE, KNOWLEDGE_BASE,
CERTIFICATES, VERIFICATION, SUPPORT, MARKETPLACE, STORAGE_EXTENDED, PUBLIC_API,
AI, DIGITAL_IDENTITY, ASSETS, SAFETY, OPERATIONS` (ASSETS added by migration
202608060054; SAFETY and OPERATIONS added by migrations 202608070056 and
202608070057 respectively, each appended to the FREE license's
`module_codes` the same way every earlier module was).

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

Helpers live in `src/lib/routing.js` (full list in §10's shared-helpers
bullet — `appPath`/`publicUrl` named here in earlier contract drafts never
existed; the real names are `publicPath`/`verifyUrl`/`cardUrl`/`companyUrl`/
`absoluteUrl`/`homePathFor`). **Never** hand-build a URL in a component.

## 7. Internationalisation

* `src/i18n/index.js` merges module dictionaries. Each module ships
  `src/i18n/modules/<module>.js` exporting
  `{ ar: {...}, en: {...}, hi: {...}, ur: {...}, tl: {...} }`.
  Never edit another module's dictionary; never add keys inline in a component.
* Zero hardcoded user-facing strings — including `placeholder`, `aria-label`,
  `alt`, `title`, `alert()`, Excel headers and error text.
* Stored values are **codes**; the label is resolved at render time
  (`t('status_' + row.status.toLowerCase())`).
* Localised database text uses the shared helper
  `pickLocalized(row, 'name', lang)` from `src/utils/localize.js`, which walks
  `name_{lang} → name_2 → name_en → name_1 → name_ar → name` (the exact order
  is `FALLBACK_SUFFIXES = ['2', 'en', '1', 'ar']` in that file — read it
  before assuming the order from memory).
* `t(key, vars)` interpolates `{{var}}` (double braces only).

## 8. Storage

Nothing talks to a storage vendor directly. `src/lib/storage/index.js` exposes:

```js
const provider = await getStorageProvider(STORAGE_LAYER.CORE);  // STORAGE_LAYER = { CORE: 'Core', EXTENDED: 'Extended' }
await provider.upload({ path, file, contentType });
await provider.getUrl(path);
await provider.remove(paths);
await provider.list(prefix);  // added Batch 1 Module 1
```

* **Core storage** (platform-paid): tenant logo, hero image, favicon
  (`CORE_BUCKETS.branding` = `tenant-branding`), employee avatar
  (`CORE_BUCKETS.employee` = `employee-assets`), employee signature
  (`CORE_BUCKETS.employeeSignatures` = `employee-signatures`).
* **Path scope, two and only two** (Batch 1 Module 1 — see
  `src/lib/storage/paths.js`): `tenantPath()` (`tenants/{tenant_id}/...`,
  the default) for company-wide assets like branding; `userPath()`
  (`{userId}/{area}/...`) for the employee-assets/employee-signatures
  buckets specifically, whose RLS is keyed on the uploader's own auth id, not
  the tenant — `putFile({..., pathScope: 'user', ownerId})` selects it. Never
  invent a third path convention.
* **Extended storage** (company-paid or platform-granted): documents,
  certificates, chat attachments — form attachments are the one exception,
  see §15. Routed through the tenant's configured provider; when
  `storage_provider = 'none'` the feature degrades gracefully — the UI
  explains it instead of failing.
* Every upload passes `tenant_quota_check('STORAGE_BYTES', size)` first — Core
  layer is size/mime-gated via `storage_policies` but not quota-gated (platform
  pays for it; see `storage_can_upload()`'s `if v_layer = 'Extended' then`
  branch, which is where the quota check specifically lives).
* Attachments (a file linked to a specific business record, e.g. a form or an
  asset) are a further Platform-Core-owned layer on top of raw storage —
  `public.attachments` + `attachment_attach/list/mark_for_removal()`
  (Batch 1 Module 2), never a bespoke per-module attachment table. See §12.

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
| `src/components/platform/AttachmentsPanel.jsx` | `AttachmentsPanel` (`{ tenantId, entityType, entityId, area?, layer?, readOnly?, listFn? }`) | any module showing files attached to one of its records. `listFn` defaults to the generic owner/creator-only read; a module with a wider natural audience (e.g. Workflow's `form_attachment_list()` — any current form participant) passes its own, per §12's Attachments row |
| `src/components/platform/EntityQrCode.jsx` | `EntityQrCode` (`{ value, size?, level?, bgColor?, fgColor?, title? }`) | any module rendering a QR for a URL or a unified entity number |
| `src/components/ApprovalChain.jsx` | `CollaboratorsPanel` (named export, no default export) (`{ formId, currentUserId }`) | Workflow Engine only (Batch 2) — Participants/Watchers on one form; not registered as a cross-module Platform component, listed here for completeness |

Shared helpers already written and ready to use:

* `src/lib/routing.js` — `parseLocation`, `tenantPath`, `publicPath`, `verifyUrl`, `cardUrl`, `companyUrl`, `RESERVED_SLUGS`, `isValidSlug`.
* `src/utils/localize.js` — `pickLocalized`, `pickFromMap`, `codeLabel`, `formatDate`, `formatDateTime`, `formatNumber`, `formatBytes`, `formatRelative`.
* `src/lib/storage/index.js` — `getStorageProvider`, `canUpload`, `putFile`, `registerObject`, `unregisterObject`, `unregisterObjectsByPath`, `resolveEmployeeAssetUrl`, `STORAGE_LAYER`, `CORE_BUCKETS`, `tenantPath`/`userPath`/`uniqueFileName`/`pathBelongsToTenant` (re-exported from `./paths`).
* `src/lib/platformCore/` — one file per Platform Core service a screen can call directly: `attachments.js` (`attachFile`/`listAttachments`/`markAttachmentForRemoval`), `code128.js` (`encodeCode128B`/`code128Bars`). Tags and Activity Timeline RPCs (`tags_list()`/`tag_create()`/`entity_tag_*()`, `activity_timeline_list()`) have no frontend wrapper — no screen consumes them yet (Global Validation removed the unused `tags.js`/`activityTimeline.js` wrappers and their components as dead code; see §12). `numberGenerator.js` was removed for the same reason — `generate_number()` itself is called directly from SQL by other RPCs, never from the frontend.
* `src/components/announcements/engagementUi.jsx` — shared Engagement-module (Announcements/Calendar/Notes/Surveys) presentational helpers: `AudienceField`, `ConfirmDialog`, `StatusLine`, `ModuleOffNotice`, `WindowBadge`, `publishingState`.
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

## 12. Platform layer ownership

Every shared capability has exactly one owner. A business module (Assets,
Safety, Operations, Digital Identity, or anything built after them) **never**
reimplements one of these under any name — no parallel "helper", no second
RPC, no local copy "just for this screen":

| Capability | Owner | Entry point |
|---|---|---|
| Number Generator | Platform Core | `generate_number()` (§1) |
| Attachments | Storage Service | `attachment_attach()` / `attachment_list()` / `attachment_mark_for_removal()` (migration 040, Batch 1 Module 2) — links an already-uploaded `storage_objects` row to a business record; never a bespoke per-module attachment table. `src/lib/platformCore/attachments.js`, `src/components/platform/AttachmentsPanel.jsx`. Read requires the caller be the attachment's own creator, the file's owner, or hold `Storage.Manage`; a wider-audience read is each business module's own responsibility to build on top (§13), same pattern as `form_attachment_list()` below. **Known gap, Global Validation (not fixed here):** `attachment_attach()` only checks the caller owns the `storage_objects` row being linked — it never checks the caller has any relationship to the target `entity_type`/`entity_id`, so any tenant member can attach an owned file to any other record's entity id, including one they have no read access to. Closing it properly needs an entity-type-aware authorization wrapper (mirroring `listFn`'s override pattern on the read side, e.g. a `form_attachment_attach()` in the Workflow Engine) — new RPC design, out of scope for a no-new-development validation pass; logged as a Batch 3+ follow-up |
| Public verification codes | Platform Core / Verification | `generate_verify_code()` / `generate_document_code()` / `verify_document()` (§1) |
| Verification / Certificates | Verification Service | Batch 3 (2026-08-06) closed this module — see `docs/update4_batch3_verification.md`. Admin: `src/components/verification/VerificationCenter.jsx` (Attestations/Certificates/Templates/Settings, `/app/verification/:section`). Public: `src/components/VerifyRequestPage.jsx` (`/verify/:code`). Employee self-service: `src/components/verification/PortalCertificates.jsx` ("My Certificates", `/app/certificates`, `PORTAL_CERTIFICATES` registry row, activated in migration 202608060047) — reuses `loadCertificates()`/`loadTemplates()`/`loadTemplateFields()` and the exported `CertificatePreview`/`CertificateCanvas` renderer from `CertificatesScreen.jsx`/`CertificateDesigner.jsx`, no new RPC or table; RLS already scoped an unprivileged caller to `recipient_employee_id = auth.uid()` (migration 202608040017) |
| Audit Trail | Platform Core | `write_audit_log()` trigger + `public.audit_logs` |
| QR Generator | Platform Core | `src/components/platform/EntityQrCode.jsx` (Batch 1 Module 3). `VerifiedSeal`'s `VerificationQr` wraps it, does not reimplement it |
| Barcode Generator | Platform Core | Code 128 Set B encoder, `src/lib/platformCore/code128.js`. First real consumer: Assets Management's printable asset tag (`AssetsCatalogueAdmin.jsx`'s local barcode-rendering wrapper, following the same "one shared low-level module, module-specific thin wrapper" pattern `VerifiedSeal.jsx` already established for `EntityQrCode`) |
| Tags | Platform Core | `tags_list()` / `tag_create()` / `entity_tag_attach()` / `entity_tag_list()` / `entity_tag_detach()` (migration 042, Batch 1 Module 5) — separate from `employee_tags` (Audience Engine dependency, left alone) and `content_items.tags`. Attach/detach open to any tenant member; `entity_tag_list()` requires `Tags.Manage` (no natural per-row owner to gate reads on otherwise). No frontend consumer — `EntityTags.jsx`/`tags.js` were removed as dead code (Global Validation); SQL kept as ready infrastructure, not reimplemented elsewhere |
| Activity Timeline | Platform Core | `record_activity()` / `activity_timeline_list()` (migration 041, Batch 1 Module 4) — distinct from Audit Trail (technical row diffs). `record_activity()` is `service_role`-only (not `authenticated` — closing-audit fix, migration 041: nothing generic can check whether a caller may write an event about an arbitrary `entity_id`); a business module's own RPC calls it internally after its own authorization check. Read requires the caller be the event's own actor or hold `Audit.View`. No frontend consumer — `ActivityTimeline.jsx`/`activityTimeline.js` were removed as dead code (Global Validation); SQL kept as ready infrastructure, not reimplemented elsewhere |
| Storage | Storage Service | `src/lib/storage/index.js`, `IStorageProvider` (§8) |
| Workflow / approvals | Workflow Engine | the Dynamic Approval Chain RPCs (`approval_submit`, `approval_act`, `approval_admin_reassign`, `approval_cancel`, `approval_recall`, `approval_form_detail`, `approval_dashboard_data`, `approval_admin_requests_list` — migration 044, Batch 2). `approval_scheme_roles.allow_self_approval` (default false) is the only per-step governance override; `templates.requires_final_approval`/`final_approver_user_id` let a template skip the chain entirely. Participants/Watchers: `form_collaborator_add()` / `form_collaborator_remove()` / `form_collaborator_list()` — a new concept, not a duplicate of Approvers. Only `role = 'Participant'` is folded into `is_form_participant()`'s read gate; `Watcher` is notification-only by design (a fresh-eyes review caught the first draft granting Watchers the same read access as Participants, which transitively exposed `performance_evaluations`/attachments to anyone a chain-holder added as a Watcher). Form attachments (Internal Memo, Performance Evaluation) route through the Attachments row below via `form_attachment_list()`, a wider-audience wrapper (`src/data/approvalService.js`), never the legacy `form_attachments` table |
| Notifications | Notification Center | `public.notify()` — see migration `202608050038`'s header comment for what happens when a module reimplements this instead |
| Permissions | Permission Engine | `has_permission()` (§3) |
| Audience targeting | Audience Engine | §4 |
| Modules / feature flags | Platform Core | `tenant_has_module()` / `useTenant().hasModule()` (§5) |
| Verification | Verification Service | §1, `verify_document()` |
| Digital Identity | Identity Module | Final Closed (2026-08-06) — see `docs/update4_digital_identity.md`. `public.employee_cards` + `card_get_mine()` / `card_save_settings()` / `card_public_view()` / `card_track_event()` (migrations 202608060049, 202608060050). Self-service: `src/components/identity/IdentityCenter.jsx` ("My Card" + "Email Signature", `/app/card/:section?`, `PORTAL_IDENTITY` registry row). Public: `src/components/PublicCardPage.jsx` (`/card/:code?`). Reuses `generate_number('ID', tenant)`, `generate_verify_code()`'s wrapper shape (mirroring `generate_document_code()`), `src/components/platform/EntityQrCode.jsx`, `is_tenant_member()`; deliberately does not reuse Activity Timeline (counter columns + `card_track_event()` instead — see migration 049's header) |
| Assets Management | Assets Module | Final Closed (2026-08-06) — see `docs/update4_assets_management.md`. Asset lifecycle built around a unified `asset_transactions` log as the single source of truth (`assets`'s own current-status columns are a derived snapshot, never directly writable — no table has a direct-write permissive RLS policy, every mutation goes through a `SECURITY DEFINER` RPC). `public.assets` + `asset_transaction_create()` / `asset_transfer_accept()` / `asset_maintenance_advance()` / `asset_dispose_request()` / `asset_inventory_scan()` (migrations 202608060054, 202608060055). Portal: `src/components/assets/AssetsPortal.jsx` ("My Assets", `/app/assets`, `PORTAL_ASSETS` registry row). Admin: `AssetGroupsAdmin.jsx` / `AssetCustodyUnitsAdmin.jsx` / `AssetsCatalogueAdmin.jsx` / `AssetInventoryAdmin.jsx` / `AssetReportsAdmin.jsx` (`/app/admin/asset-*`). Reuses `generate_number('AS'\|'WO'\|'IN', tenant)`, `record_activity()` (own `asset_timeline()` wider-audience wrapper), the Attachment Framework, the existing Dynamic Approval Chain for disposal (new single-step `ASSET_DISPOSAL` scheme, never a second workflow engine), `public.notify()`, `code128.js` (first real consumer) + `EntityQrCode.jsx` |
| Safety Management | Safety Module | Final Closed (2026-08-07) — see `docs/update4_safety_management.md`. PPE issuance/compliance tracking built around two kinds of PPE: asset-kind (a real `public.assets` row via `asset_create()`, extended by the new `safety_asset_ext` table, never a parallel insert) and consumable-kind (lives entirely inside `safety_issuances`/`safety_issuance_items`, never an asset row). `public.safety_ppe_types` + `safety_issuance_create()` / `safety_issuance_item_add()` / `safety_field_visit_create()` / `safety_expiration_scan()` (migration 202608070056). Portal: `src/components/safety/SafetyPortal.jsx` ("My Safety", `/app/safety`). Admin: `SafetyPpeTypesAdmin.jsx` / `SafetyPpeSetsAdmin.jsx` / `SafetyAssetsAdmin.jsx` / `SafetyIssuancesAdmin.jsx` / `SafetyFieldVisitsAdmin.jsx` / `SafetyExpirationsAdmin.jsx` / `SafetyComplianceAdmin.jsx` / `SafetyReportsAdmin.jsx` (`/app/admin/safety-*`). Reuses `generate_number('PI'\|'FV', tenant)`, `record_activity()` (own `safety_timeline()` wider-audience wrapper), the Attachment Framework (extended for `SafetyPpeType`/`SafetyIssuance`/`SafetyFieldVisitCheck`), the Audience Engine (extended with a `Position` targeting dimension and a `SafetyPpeSet` entity_type, rather than a bespoke join table), `public.notify()`, and `assets`/`asset_transactions` via `asset_create()`/`asset_transaction_create()`/`asset_maintenance_report()` for asset-kind PPE — never reimplemented |
| Operations | Operations Module | Final Closed (2026-08-07) — see `docs/update4_operations.md`. A flat, append-only field-work execution log per operation — deliberately no Work Order engine, no approval chain, no per-member role. `public.operations` + `operations_team_set_members()` / `operations_execution_log_create()` / `operations_checklist_item_toggle()` / `operations_can_write()` (migration 202608070057). Portal: `src/components/operations/OperationsPortal.jsx` ("My Operations", `/app/operations`). Admin: `OperationsListAdmin.jsx` / `OperationsDashboardAdmin.jsx` / `OperationsTemplatesAdmin.jsx` (`/app/admin/operations*`). Reuses `generate_number('OP', tenant)`, `record_activity()` (own `operations_timeline()` wider-audience wrapper), the Attachment Framework (extended for `OperationExecutionPhoto`/`OperationExecutionFile`, since `public.attachments` has no stored "kind" column to distinguish a photo from a file after the fact), `public.notify()`, `public.sites` |

If a module needs a capability not in this table, add the row here (and to
`FourthUpdate.md`'s Shared Platform Services table, if it names an owner)
before writing the implementation — not after.

## 13. Dependency direction

```
Business Module (Assets, Safety, Operations, ...)
        ↓ may call
Platform Layer (table above)
        ↓ may call
Infrastructure (current_tenant_id, has_permission, apply_row_defaults, ...)
        ↓ runs on
Supabase (Postgres, Auth, Storage)
```

A lower layer never calls upward and never imports from a business module. A
Platform Layer function may not know Assets or Safety exist. If a fix seems to
require an upward call, the real fix is almost always to move the shared
piece down a layer, not to add the call.

## 14. Database ownership

Only a migration file (`supabase/migrations/*.sql`) may `create table`,
`alter table`, `create index`, `create trigger`, `create policy`, or
`create function` in `public`. `supabase/seed.sql` is data only and is not
part of the documented install (`supabase db push` runs migrations only) — a
definition that lives only in seed data does not exist for anyone following
the documented setup. No screen, script, or one-off console command may create
or change schema.

## 15. Forbidden

* `console.log` / `debugger` left in committed code.
* `Date.now()` or `Math.random()` used to build an id or a reference number —
  use `generate_number()` (§1/§12). `src/components/FormsPortal.jsx`'s
  `blankForm()`/`blankMemo()` did this as of Update 4 Phase 0; fixed since —
  `reference` now stays `null` until first save, allocated server-side by
  `generate_number('EV'|'TA')` via `formsService.js`'s
  `allocateReferenceNumberOrThrow()`. Local/demo-mode fallbacks (`useLocalData`,
  §9) still mint a `Date.now()`-derived placeholder id — that is the
  established, deliberate pattern for offline demo data across every
  `src/data/*Service.js` file, not a violation of this rule.
* `ApprovalTrackingAdmin`/`ApprovalAllRequestsAdmin` (`src/components/
  ApprovalAdmin.jsx`) both accept an `onViewForm` prop that gates their only
  "view details" (Eye icon) button — `src/components/AdminCenter.jsx`
  instantiates both with no props, so the button silently never renders and
  there is no other way to open a request's detail from either admin screen.
  Found by Global Validation's independent fresh audit; not fixed in that
  pass — a correct fix needs either a new read-only form-detail modal or new
  deep-link handling in `FormsPortal.jsx` to open a specific form by id,
  neither of which exists today. That is new UI construction, out of scope
  for a no-new-development validation pass — logged as a Batch 3+ follow-up.
* A component calling `supabase` directly instead of going through
  `src/data/<module>Service.js` (§9). `src/components/AdminCenter.jsx` does
  this at 11+ sites (`evaluation_cycles`, `performance_evaluations`,
  `audit_logs`, `users`) — pre-existing, predates Batch 1/2, already logged in
  `docs/pre_update4_readiness_2026-08-05.md` and
  `docs/stabilization_audit_2026-08-05.md`; Global Validation re-confirmed it
  and folds it back in here rather than extracting a new `adminService.js`,
  which would be a refactor outside this validation pass's no-new-development
  scope — logged as a follow-up for whichever module next touches
  AdminCenter.jsx.
* A hand-built URL instead of `src/lib/routing.js` (§6).
* A hardcoded user-facing string instead of `t()` (§7).
* A second implementation of anything in the §12 ownership table, under any
  name.
* A component or RPC writing to `storage.objects`/a bucket directly instead of
  `IStorageProvider` (§8). `src/data/formsService.js`'s form-attachment upload
  (`supabase.storage.from('form-attachments').upload(...)`, writing to its own
  `form_attachments` table) was a known, live instance of this — flagged by
  the Batch 1 closing audit as out of proportion to fix in that batch, and
  resolved in Batch 2 (migration 044): both forms now use the Attachment
  Framework, existing rows were backfilled into it, and `form_attachments` is
  kept only as an unwritten historical record.
* A direct `update` on an approval/workflow table instead of the Workflow
  Engine's own RPCs (§12).
* A direct `insert` into `public.notifications` instead of `public.notify()`
  (§12) — see migration `202608050038` for exactly what breaks when this rule
  is skipped. `supabase/functions/invite-employee/index.ts` still inserts
  directly into `public.audit_logs` instead of relying on the
  `write_audit_log()` trigger (found by the Batch 1 closing audit) — a Deno
  edge function outside this batch's scope, logged rather than changed here.
* An edge function or server-side script writing to a storage bucket outside
  `IStorageProvider`/`storage-proxy`. `supabase/functions/tenant-signup/
  index.ts`'s `stageAsset()`/`settleAsset()`/`discardAssets()` write the
  `tenant-branding` bucket directly during signup, before any tenant/session
  exists (so the normal session-scoped `putFile()` path cannot apply as-is) —
  found by the Batch 1 closing audit, logged as a known gap (no
  `storage_objects` ledger row, no quota accounting for a tenant's first
  branding assets) rather than fixed here; a real fix needs a pre-tenant
  staged-upload mode in `storage-proxy`, which is a feature project on its
  own.

## 16. Required review before the next module starts

A module is not done when its code runs. Before starting the next module in
the execution order, it needs, in order:

1. **Architecture review** — matches §12/§13, no duplicated capability.
2. **Security review** — tenant isolation, `SECURITY DEFINER` scoping, anon
   surface (`tests/tenancy-invariants.test.mjs` is the mechanical half of
   this; it does not replace reading the function body).
3. **Performance review** — §17.
4. **Documentation review** — the module's own phase doc covers Architecture,
   ERD, Database, API, Permissions, Workflow and Storage (the seven headings
   `docs/update4_phase0_platform_core.md` uses), updated now, not deferred to
   the end of Update 4; and this contract, if the module needed a new shared
   rule.
5. **Migration review** — applies cleanly against a real database, not just a
   syntax read (`docs/update4_phase0_platform_core.md` §3 shows the pattern:
   full chain applied to an isolated local Postgres instance).
6. **Tests** — the existing suite still passes, and new invariants this
   module introduces are covered.

Record the outcome as **PASS / FAIL** per step in the module's phase doc; a
FAIL blocks the next module, it does not get carried forward as a TODO.

## 17. Performance

* No `select *` in an RPC or a client query — project the columns the caller
  actually uses. Violated at 19 pre-existing (older than Batch 1/2) call
  sites: `src/context/AuthContext.jsx`, `src/data/formsService.js`,
  `src/data/engagementService.js`, `src/data/contentService.js`,
  `src/data/tenantProfileService.js`, `src/data/approvalService.js`,
  `src/data/organizationService.js`, `src/components/AdminCenter.jsx` —
  Global Validation catalogued these rather than editing them; each is a
  low-risk-reward, out-of-scope mechanical change for a validation pass with
  no new-development mandate, logged as a follow-up for whichever module next
  touches each file.
* Any list screen paginates; it never loads a whole table into the browser.
  `src/data/engagementService.js`'s `loadAnnouncements`/`loadSurveys`/
  `loadCompanyEvents` don't (same pre-existing, logged-not-fixed status as
  above).
* A column used in a `where`/`order by` on a screen's main query gets an
  index — add it in the same migration that adds the query.
* No N+1: a list screen fetches its rows and their related data in one RPC
  (or one batched query), not one query per row.

## 18. Transactions

An operation that changes more than one business entity runs inside a single
database transaction — in practice, this means it is one `plpgsql` function
(a single top-level SQL statement, or a function body, is one implicit
transaction), not a sequence of separate client-side RPC calls with partial
failure possible in between. If a screen needs to create a request and its
first approval step, that is one RPC (see `approval_submit`), not two.

## 19. Audit

Every mutation of a business entity produces an audit trail entry via
`write_audit_log()` (§12) — not a bespoke log table, not a `console.log`, not
skipped because "it's a small change". If a table is business data
(has `tenant_id`, is not in a `TENANT_INFRASTRUCTURE`-style exception list —
see `tests/tenancy-invariants.test.mjs`), it is audited.

## 20. Soft delete vs hard delete

* **Business data** (a customer's records — forms, assets, employees,
  requests, ...) is soft-deleted: `is_deleted` + `deleted_by` + `deleted_date`
  (§1/§2). It is never physically removed by product code.
* **Infrastructure tables** (counters, quota usage, sequence bookkeeping —
  `public.number_sequences`, `public.tenant_quotas`) have no soft-delete
  columns at all and may be hard-deleted when genuinely safe (e.g. cascading
  from a deleted tenant), because they hold no content a company needs to
  recover — they are re-derivable or simply restart at zero.

## 21. Public RPC contract

Every RPC reachable by `anon` or by any `authenticated` caller outside its own
tenant (`ANON_CALLABLE` in `tests/tenancy-invariants.test.mjs`, or any
`SECURITY DEFINER` function with a cross-tenant `p_tenant_id` path — see
`generate_number()`'s authorization comment for the current worked example)
states, in its `comment on function`:

* **Authentication** — anon, authenticated, or operator-only.
* **Authorization** — what it checks before acting (membership, permission
  code, `is_platform_operator()`, or "none — read-only and not secret").
* **Rate limiting** — the current, honest posture (e.g. "none yet — relies on
  `tenant_quota_check`" or "todo"). Do not imply a limiter exists if one does
  not; state the gap instead so it is tracked, not assumed.
* **Expected errors** — the `SCREAMING_SNAKE_CODE`s it raises (§2).

## 22. New-module integration checklist

Before a new business module is considered feature-complete, confirm it goes
through every one of these rather than inventing its own:

* Permissions (§3) — `has_permission()`, never a role-code check in SQL.
* Workflow (§12) — if it has an approval step, it is a Workflow Engine RPC.
* Notifications (§12) — `public.notify()`.
* Audit (§19).
* Storage (§8/§12) — `IStorageProvider`, correct layer (Core vs Extended).
* Number Generator (§1/§12) — `generate_number()` for every user-visible id.
* Localization (§7) — no hardcoded strings, dictionary shipped under
  `src/i18n/modules/<module>.js`.
* Audience Engine (§4) — if the module has a "who sees this" concept.
* Modules / feature flags (§5) — a module code registered and checked via
  `tenant_has_module()`.
