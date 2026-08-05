# bbnovix — deployment runbook

Everything needed to take this repository from a clean GitHub account and a
clean Supabase project to a working `https://bbnovix.com`, in the order it has
to happen. Each step says what to do, what to check afterwards, and what breaks
if it is skipped.

```
 visitor ──► bbnovix.com (GitHub Pages, static)
                │
                ├─ /portal /signup /verify /support        public pages
                ├─ /{company}/…                            company pages
                │
                └─ browser calls ──► Supabase project
                                       ├─ Postgres + RLS
                                       ├─ Storage (tenant-branding, employee-assets)
                                       └─ Edge functions
                                            tenant-signup    public, no JWT
                                            verify-api       public, no JWT
                                            send-email       service_role only
                                            storage-proxy    signed-in users
                                            invite-employee  signed-in admins
```

---

## 0. Before anything — the credential in the plan document

`thirdupdate.md` at the repository root contains the **plain password** of the
`bbnovix@gmail.com` account. Treat it as leaked:

1. **Do not commit `thirdupdate.md`.** It is currently untracked; add it to
   `.gitignore` (or delete it) before the next `git add -A`.
2. **Change that Google account password now.** Anything written into a shared
   planning document has to be assumed public.
3. **Never put an account password into `SMTP_PASS`.** Google has refused plain
   account passwords for SMTP since May 2022. What SMTP needs is an *App
   Password* — see §5.
4. If the value ever reached a commit, rotating the password is not enough on
   its own; the commit has to be rewritten or the repository treated as burned.

Nothing in `supabase/functions/**` contains a credential, and nothing in it ever
should. Every secret is read from the function environment at runtime.

---

## 1. DNS for bbnovix.com

The site is served by GitHub Pages from the `ProFrame/bbnovix` repository, so
the apex domain points at the Pages anycast addresses and `www` points at the
Pages host name.

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `@` | `185.199.108.153` | 3600 |
| A | `@` | `185.199.109.153` | 3600 |
| A | `@` | `185.199.110.153` | 3600 |
| A | `@` | `185.199.111.153` | 3600 |
| AAAA | `@` | `2606:50c0:8000::153` | 3600 |
| AAAA | `@` | `2606:50c0:8001::153` | 3600 |
| AAAA | `@` | `2606:50c0:8002::153` | 3600 |
| AAAA | `@` | `2606:50c0:8003::153` | 3600 |
| CNAME | `www` | `proframe.github.io.` | 3600 |

All four A records (and, if the registrar supports IPv6, all four AAAA records)
are needed: GitHub balances across them and removes one from rotation during
maintenance.

Check with:

```bash
dig +short bbnovix.com A
dig +short www.bbnovix.com CNAME
```

In PowerShell, check more than one resolver while propagation is still fresh:

```powershell
Resolve-DnsName bbnovix.com -Type A -Server 8.8.8.8
Resolve-DnsName bbnovix.com -Type A -Server 1.1.1.1
Resolve-DnsName www.bbnovix.com -Type CNAME -Server 8.8.8.8
```

If any resolver still returns `162.255.119.221` or
`parkingpage.namecheap.com`, remove the conflicting Namecheap parking or URL
redirect record for the same host and wait for DNS propagation. GitHub Pages
will not issue HTTPS until every relevant check reaches the GitHub Pages
records.

> If the domain is later moved behind Cloudflare (see §9) the same records are
> entered in Cloudflare's DNS; leave them **DNS only** (grey cloud) until the
> GitHub Pages certificate has been issued, or the HTTP-01 challenge fails.

---

## 2. GitHub Pages

1. `public/CNAME` already contains `bbnovix.com`. Vite copies everything in
   `public/` into `dist/`, so the built site carries the expected domain. The
   domain must still be saved once in the repository's Pages settings.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.** The
   workflow in `.github/workflows/deploy.yml` builds on every push to `main`.
3. **Settings → Pages → Custom domain:** `bbnovix.com`, then tick **Enforce
   HTTPS** once the certificate has been issued (a few minutes after DNS
   resolves).
4. **Settings → Secrets and variables → Actions**, add:
   - `VITE_SUPABASE_URL` — `https://<project-ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` — the project's anon key
   Both may be repository *variables* rather than secrets; the anon key is
   public by design and is safe only because Supabase RLS and grants decide
   what each user can actually read or write. The workflow fails the build if
   either is missing.
   Do not add `SUPABASE_SERVICE_ROLE_KEY`, SMTP passwords, database passwords or
   storage-provider secret keys to repository variables used by the frontend
   build.
5. **Leave `VITE_BASE_PATH` unset.** The default `./` emits relative asset URLs,
   so the same artifact works on both `bbnovix.com` and the fallback
   `proframe.github.io/bbnovix/` URL while DNS is being configured.

### Why `404.html` exists

GitHub Pages is a static file server with no SPA rewrite rule: a request for
`/gold/app/forms` looks for that file, does not find it, and serves `404.html`.
The Vite plugin `spa-fallback-404` in `vite.config.js` writes `dist/404.html` as
a byte-for-byte copy of `dist/index.html`, so the application boots on that
response and `src/lib/routing.js` reads the real pathname. Delete the copy and
every deep link — every company address, every verification link, every
password-set link in an email — returns a GitHub 404 page.

---

## 3. Supabase project

Create the project (region close to the users, e.g. `eu-central-1` or
`me-central-1`), then note the project ref, the anon key and the service role
key from **Settings → API**.

```bash
npm install -g supabase        # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref <project-ref>
```

### Migrations, in order

`supabase/migrations/*.sql` are numbered and idempotent. Apply them in filename
order — the sequence is global and each file assumes the ones before it:

```bash
supabase db push
```

| File | What it establishes |
|---|---|
| `202607280001` … `202607300011` | the original single-company portal: users, roles, forms, approvals, content, performance |
| `202608040012_multitenant_foundation` | **the pivot.** Creates `tenants`, adds `tenant_id` + audit columns to every business table, moves every existing row into the `shalfa` tenant, creates the `platform` tenant, RLS, quotas, `tenant-branding` bucket |
| `202608040013_org_dimensions_and_audience_engine` | projects, sectors, sites, countries and the audience engine |
| `202608040014_engagement_modules` | announcements, surveys, calendar, notes |
| `202608040015_notifications_and_workspace` | notification centre, dashboard preferences |
| `202608040016_chat` | chat |
| `202608040017_verification_and_certificates` | verifiable documents, certificates, **`public.verify_document`** |
| `202608040018_support_storage_security_platform` | support desk, storage providers and `tenant_storage_config`, security, platform console |
| `202608040019_tenant_provisioning` | **`public.provision_tenant`**, `tenant_signup_requests`, the `TENANT_WELCOME` email template |
| `202608040020_tenant_hardening_legacy_functions` | tenant-scopes the legacy functions |
| `202608040021_engagement_notifications` | notification wiring for the engagement modules |
| `202608040022_screen_registry_reconciliation` | the screen registry |
| `202608050023_auth_security_hardening` | authenticates successful login-audit events, removes anonymous account enumeration, and prevents duplicate threshold events |

Verify afterwards:

```sql
select slug, is_platform, status from public.tenants order by created_on;
-- expect exactly: platform (is_platform = true) and shalfa

select code from public.email_templates where code = 'TENANT_WELCOME';
select id from storage.buckets where id in ('tenant-branding', 'employee-assets');
```

### Auth settings

**Authentication → URL Configuration:**

- **Site URL:** `https://bbnovix.com`
- **Redirect URLs** (one per line — every company address is a distinct
  redirect target, so a wildcard is required):
  ```
  https://bbnovix.com/**
  http://127.0.0.1:5188/**
  http://localhost:5188/**
  ```

Without the wildcard, the password-set link in the welcome email is rejected
with `redirect_to not allowed` and the new administrator can never sign in.

**Authentication → Email templates:** `inviteUserByEmail` (used by
`tenant-signup` and `invite-employee`) also triggers Supabase's own invite mail.
Either brand it here, or point **Authentication → SMTP Settings** at the same
Gmail account so both messages come from `bbnovix@gmail.com`. Leaving the
built-in sender enabled means a new administrator receives two messages — the
Supabase invite and the bbnovix welcome — which is untidy but harmless; both
links reach the same password screen.

---

## 4. Supabase secrets

Set once per project. `supabase secrets set` writes them into every edge
function's environment; nothing here belongs in the repository.

```bash
supabase secrets set \
  APP_URL="https://bbnovix.com" \
  SMTP_HOST="smtp.gmail.com" \
  SMTP_PORT="465" \
  SMTP_USER="bbnovix@gmail.com" \
  SMTP_PASS="<16-character Gmail App Password>" \
  MAIL_FROM="bbnovix <bbnovix@gmail.com>"
```

| Secret | Used by | Notes |
|---|---|---|
| `SUPABASE_URL` | all | injected by the platform, do not set |
| `SUPABASE_ANON_KEY` | `verify-api`, `storage-proxy` | injected by the platform |
| `SUPABASE_SERVICE_ROLE_KEY` | `tenant-signup`, `send-email`, `storage-proxy`, `invite-employee` | injected by the platform. If your CLI version does not inject it, set it explicitly — and never expose it to the browser |
| `APP_URL` | all | `https://bbnovix.com`, no trailing slash. Every company URL and password-set link is built from it |
| `SMTP_HOST` | `send-email` | `smtp.gmail.com` |
| `SMTP_PORT` | `send-email` | `465` (implicit TLS). `587` also works and negotiates STARTTLS |
| `SMTP_USER` | `send-email` | `bbnovix@gmail.com` |
| `SMTP_PASS` | `send-email` | **App Password only** — see §5 |
| `MAIL_FROM` | `send-email` | `bbnovix <bbnovix@gmail.com>`. Gmail rewrites a From that is not the authenticated account |
| `MAIL_REPLY_TO` | `send-email` | optional |
| `ALLOWED_ORIGINS` | all | optional comma-separated allow list. Unset means any origin, which is what the public endpoints want |
| `EMAIL_WORKER_SECRET` | `send-email` | optional shared secret for a scheduler that cannot send an `Authorization` header |
| `EMAIL_WORKER_NAME` | `send-email` | optional, appears in `email_queue.locked_by` |
| `SEND_EMAIL_ON_SIGNUP` | `tenant-signup` | `false` to stop signup nudging the queue worker; the scheduled run then picks the message up |
| `STORAGE_URL_TTL_SECONDS` | `storage-proxy` | signed-link lifetime, default `3600` |
| `STORAGE_{REF}_ACCESS_KEY_ID` / `STORAGE_{REF}_SECRET_ACCESS_KEY` | `storage-proxy` | per-company extended storage, see §8 |

Check what is set:

```bash
supabase secrets list
```

---

## 5. The Gmail App Password

1. Sign in as `bbnovix@gmail.com`.
2. **Google Account → Security → 2-Step Verification** — turn it on. App
   passwords do not exist without it.
3. **Security → App passwords** (<https://myaccount.google.com/apppasswords>),
   create one named `bbnovix-supabase`.
4. Copy the 16 characters — spaces optional, Google shows them in groups of
   four — and put them in `SMTP_PASS`. This is the only place that value ever
   exists.
5. Revoking the app password from that same screen instantly stops all outbound
   mail without touching the account; that is the kill switch if the key leaks.

Limits worth knowing: a free Gmail account sends roughly 500 recipients a day
and throttles bursts. `send-email` is built for that — it claims a small batch,
records the outcome and retries with exponential backoff — so hitting the cap
delays mail instead of losing it. If the platform outgrows the cap, the only
change needed is `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` pointing at a
transactional provider; nothing in the application changes.

---

## 6. Deploying the edge functions

```bash
# Public: reached by anonymous visitors, so JWT verification is off and the
# function does its own validation, rate limiting and authorisation.
supabase functions deploy tenant-signup --no-verify-jwt
supabase functions deploy verify-api    --no-verify-jwt

# service_role only: the function compares the bearer token with the service
# key itself, which pg_cron and the scheduler can present but a user cannot.
supabase functions deploy send-email    --no-verify-jwt

# Signed-in users: the platform verifies the JWT before the function runs.
supabase functions deploy storage-proxy
supabase functions deploy invite-employee
```

`supabase/functions/_shared/*` is bundled automatically with every function that
imports it; it is not deployed on its own.

| Function | Verify JWT | Who may call it | What it does |
|---|---|---|---|
| `tenant-signup` | no | anyone | validates the subscription form, rate-limits by IP, stores the request, uploads the logo and cover, creates the administrator's auth identity, calls `provision_tenant`, queues `TENANT_WELCOME`, and deletes the auth user again if anything after it fails |
| `verify-api` | no | anyone | `GET /verify-api/{code}` → `public.verify_document` in a stable shape |
| `send-email` | no (self-checked) | service_role | claims `email_queue` batches and sends them over SMTP |
| `storage-proxy` | yes | signed-in users | the server half of extended storage: upload / url / remove / status |
| `invite-employee` | yes | `Employees.Manage` | creates or updates an employee account inside the caller's company |

Smoke test each one:

```bash
# verification (no key needed)
curl -s https://<ref>.supabase.co/functions/v1/verify-api/GOLD-000000000001 | jq

# signup validation — a deliberately reserved slug must answer TENANT_SLUG_RESERVED
curl -s -X POST https://<ref>.supabase.co/functions/v1/tenant-signup \
  -H 'content-type: application/json' \
  -d '{"slug":"admin","default_language":"ar","names":{"ar":"تجربة"},"administrator":{"full_name":"Test","email":"test@example.com"}}' | jq

# the queue worker
curl -s -X POST https://<ref>.supabase.co/functions/v1/send-email \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq
# → {"ok":true,"claimed":0,"sent":0,"retried":0,"failed":0} on an empty queue
```

Logs: **Dashboard → Edge Functions → *function* → Logs**, or
`supabase functions logs tenant-signup`.

---

## 7. Scheduling `send-email`

Nothing sends mail until the worker runs. Every minute is a good cadence: the
queue is normally empty and an empty run costs one `claim_email_queue` call.

**Option A — pg_cron + pg_net inside the database** (works on every plan):

```sql
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- Store the key once instead of pasting it into the job definition.
select vault.create_secret('<service-role-key>', 'service_role_key');

select cron.schedule(
  'send-email-worker',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/send-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body    := jsonb_build_object('batchSize', 25),
    timeout_milliseconds := 55000
  );
  $$
);

-- afterwards
select jobid, jobname, schedule, active from cron.job;
select * from cron.job_run_details order by start_time desc limit 10;
```

**Option B — Supabase scheduled functions / any external cron** (GitHub Actions,
Uptime Robot, cron-job.org): POST to the same URL every minute with either the
service-role bearer token or the `x-worker-secret` header matching
`EMAIL_WORKER_SECRET`.

Signup does not wait for the schedule: `tenant-signup` nudges the worker in the
background so the welcome message leaves within seconds. The schedule is what
catches retries and everything queued by the rest of the application.

Watch the queue:

```sql
select status, count(*) from public.email_queue group by status;
select id, recipient_email, status, retry_count, failure_reason, next_attempt_on
from public.email_queue
where status in ('Retry', 'Failed')
order by updated_on desc limit 20;
```

A row stuck in `Processing` means a worker died mid-send; release it with

```sql
update public.email_queue
set status = 'Retry', locked_on = null, locked_by = null, next_attempt_on = now()
where status = 'Processing' and locked_on < now() - interval '15 minutes';
```

---

## 8. Extended storage credentials (`storage-proxy`)

Core storage — logos, cover images, avatars, signatures — lives in Supabase
Storage and needs no configuration. Extended storage — documents, certificates,
chat and form attachments — is routed to whatever the company connected, and
that connection is split in two on purpose:

* **`public.tenant_storage_config`** holds the *settings*: provider code,
  bucket, region or account id, root path, quota. A database check constraint
  rejects anything that looks like a secret.
* **The function environment** holds the *secret*, addressed by
  `tenant_storage_config.credential_ref`.

For a company whose `credential_ref` is `acme_r2`:

```bash
supabase secrets set \
  STORAGE_ACME_R2_ACCESS_KEY_ID="…" \
  STORAGE_ACME_R2_SECRET_ACCESS_KEY="…"
```

`STORAGE_DEFAULT_ACCESS_KEY_ID` / `STORAGE_DEFAULT_SECRET_ACCESS_KEY` are used
when a company has no `credential_ref` of its own — that is the platform-granted
space.

| `provider_code` | `config` keys | Status |
|---|---|---|
| `s3` | `bucket`, `region` (or `endpoint`) | implemented, SigV4 |
| `r2` | `bucket`, `account_id` (or `endpoint`) | implemented, SigV4, region `auto` |
| `b2` | `bucket`, `region` (or `endpoint`) | implemented, SigV4 against the S3-compatible endpoint |
| `google_drive` | — | `STORAGE_PROVIDER_NOT_IMPLEMENTED` |
| `onedrive` | — | `STORAGE_PROVIDER_NOT_IMPLEMENTED` |
| `azure_blob` | — | `STORAGE_PROVIDER_NOT_IMPLEMENTED` |

The three unimplemented ones need an OAuth token cache (Drive, OneDrive) or a
per-request SAS mint (Azure); `supabase/functions/storage-proxy/index.ts`
documents exactly what each would take. They answer with a clear code rather
than pretending to work, so the UI can tell the company its provider is not
supported yet.

Every company can check its own connection from the storage screen, which calls
the `status` action and writes the result to `last_check_status` /
`last_check_message`.

---

## 9. Exposing the verification API as `/api/verify/{code}`

Other systems should be able to call a stable, branded address:

```
GET https://bbnovix.com/api/verify/GOLD-000000000001
```

The function itself already accepts both `/verify-api/{code}` and
`?code={code}`, and ignores a leading `verify` segment, so any of the routes
below work without changing the code.

**Option A — Supabase custom domain (cleanest, paid add-on).**
Add `api.bbnovix.com` under **Settings → Custom Domains**, create the CNAME the
dashboard asks for, and the endpoint becomes

```
https://api.bbnovix.com/functions/v1/verify-api/{code}
```

Publish that as the integration address.

**Option B — Cloudflare in front of the domain (free).**
Move the bbnovix.com nameservers to Cloudflare, keep the GitHub Pages records
from §1, and set the apex record to **Proxied** *after* the Pages certificate
has been issued. Then add a rule:

* *Rules → Redirect/Rewrite Rules → Origin rule*, or a small Worker:

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/verify/')) {
      const code = url.pathname.slice('/api/verify/'.length);
      return fetch(`https://<project-ref>.supabase.co/functions/v1/verify-api/${code}`, {
        headers: { 'accept-language': request.headers.get('accept-language') ?? 'en' },
      });
    }
    return fetch(request);        // everything else stays on GitHub Pages
  },
};
```

Route the Worker at `bbnovix.com/api/*`. SSL mode must be **Full (strict)**.

**Option C — no proxy at all.**
Publish the function URL directly:

```
https://<project-ref>.supabase.co/functions/v1/verify-api/{code}
```

GitHub Pages cannot rewrite or proxy anything, so `bbnovix.com/api/...` is
simply not available without option A or B. The in-app verification page at
`bbnovix.com/verify/{code}` is unaffected either way — it is a normal SPA route
that calls the RPC directly.

### The answer shape

```json
{
  "valid": true,
  "code": "GOLD-000000000001",
  "status": "Active",
  "reason": null,
  "company": { "slug": "gold", "name": "…", "short_name": "…", "logo_url": "…" },
  "document": { "type": "Certificate", "title": "…", "subject": "…",
                "holder_name": "…", "reference_no": "…", "file_url": "…" },
  "issued_on": "2026-08-04T09:12:00Z",
  "valid_until": null,
  "verify_url": "https://bbnovix.com/verify/GOLD-000000000001",
  "checked_on": "2026-08-04T10:00:00Z",
  "language": "en",
  "details": { … the untouched public.verify_document payload, including the approval timeline … }
}
```

`200` for a document that exists, `404` for an unknown code, `400` for a missing
code, `429` when the caller exceeds 60 lookups a minute. `?lang=ar` selects the
language of `company.name`, `document.title` and `document.subject`.

---

## 10. The first platform operator

The `platform` tenant and the `PLATFORM_OPERATOR` role are created by migration
`0012`, but nobody is in it yet — and there is deliberately no way to sign up
into it, because the operator console can see every company.

1. **Dashboard → Authentication → Users → Add user.** Email + a strong password,
   tick *Auto Confirm User*. Copy the new user's UUID.
2. Run this in the SQL editor, replacing the address:

```sql
do $$
declare
  v_platform uuid;
  v_user uuid;
  v_role uuid;
begin
  select id into v_platform from public.tenants where is_platform and not is_deleted
  order by created_on limit 1;

  select id into v_user from auth.users where lower(email) = lower('operator@bbnovix.com');
  if v_user is null then raise exception 'AUTH_USER_NOT_FOUND'; end if;

  select id into v_role from public.roles
  where tenant_id = v_platform and code = 'PLATFORM_OPERATOR' and not is_deleted;

  insert into public.users (
    id, tenant_id, active_tenant_id, email, employee_no, full_name,
    preferred_language, is_active, account_activated_on
  )
  select v_user, v_platform, v_platform, lower(u.email), '1', 'Platform Operator',
         'ar', true, now()
  from auth.users u where u.id = v_user
  on conflict (id) do update set
    tenant_id = excluded.tenant_id,
    active_tenant_id = excluded.active_tenant_id,
    is_active = true;

  insert into public.user_roles (tenant_id, user_id, role_id)
  values (v_platform, v_user, v_role)
  on conflict do nothing;

  insert into public.tenant_memberships (tenant_id, user_id, employee_id, role_id, is_owner, status)
  values (v_platform, v_user, v_user, v_role, true, 'Active')
  on conflict (tenant_id, user_id) do update set
    role_id = excluded.role_id, is_owner = true, status = 'Active';
end $$;
```

3. Sign in at `https://bbnovix.com/platform/login` and open
   `https://bbnovix.com/platform/app/platform`.

Check:

```sql
select u.email, t.slug, r.code
from public.users u
join public.tenants t on t.id = u.tenant_id
join public.user_roles ur on ur.user_id = u.id
join public.roles r on r.id = ur.role_id
where t.is_platform;
```

---

## 11. End-to-end check after a release

1. `https://bbnovix.com/portal` loads and the language switcher works.
2. `https://bbnovix.com/gold/app/forms` (any deep link) loads instead of a
   GitHub 404 — this is the `404.html` copy doing its job.
3. `https://bbnovix.com/signup`: fill the form with a fresh address and a real
   inbox. Expect within a minute:
   - `select slug, status from public.tenants order by created_on desc limit 1;`
   - `select employee_no, email, is_active from public.users where tenant_id = '…';`
     → employee number `1`, active
   - `select status, sent_on from public.email_queue order by id desc limit 1;`
     → `Sent`
   - a welcome message in the inbox containing the company link and a working
     **set password** button
   - the logo under `tenants/{tenant_id}/branding/` in the `tenant-branding`
     bucket
4. Set the password from the email, sign in, and confirm the company landing
   page shows the uploaded logo and the chosen colours.
5. Issue a document, then call `/verify-api/{code}` and confirm `valid: true`.

---

## 12. When something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Deep links return a GitHub 404 page | `dist/404.html` missing | the `spa-fallback-404` plugin in `vite.config.js` was removed, or the artifact was built by something other than `npm run build` |
| Site loads at `/bbnovix/…` | `VITE_BASE_PATH` is set | clear the repository variable and redeploy |
| Custom domain resets after a deploy | `public/CNAME` missing from the artifact | restore the file; Pages reads it on every deployment |
| Signup answers `SLUG_TAKEN` for a free address | a previous attempt provisioned and failed later | check `public.tenant_signup_requests` for the slug; the tenant row is the source of truth |
| Signup answers `EMAIL_IN_USE` | the address already has an auth identity, possibly from a failed attempt | delete the user in **Authentication → Users** and retry, or use another address |
| Signup answers `RATE_LIMITED` | more than 5 submissions an hour from one address | expected; wait, or clear the recent rows in `tenant_signup_requests` while testing |
| Welcome mail never arrives | worker not scheduled, or SMTP refused | `select status, failure_reason from public.email_queue order by id desc limit 5;` — `535` means the App Password is wrong; `MAIL_NOT_CONFIGURED` means a secret is missing |
| The administrator's link says "invalid or expired" | the redirect URL is not on the allow list, or the link was already used | §3, Redirect URLs. Ask them to use *forgot password* on `/{slug}/login` |
| Uploads fail with `STORAGE_PROVIDER_NOT_CONFIGURED` | extended storage is not connected | company storage screen, or the platform console grants space |
| Uploads fail with `STORAGE_CREDENTIALS_MISSING` | `credential_ref` has no matching secret | §8 |
| `verify-api` answers `SUPABASE_NOT_CONFIGURED` | the function was deployed into a project without `SUPABASE_ANON_KEY` | redeploy, or set the secret explicitly |

---

## 13. Rollback

The frontend rolls back by re-running the Pages workflow on an earlier commit.
Edge functions roll back by deploying the previous source. Migrations do **not**
roll back automatically: every file is written to be re-runnable, so the safe
recovery from a bad migration is a forward-fixing migration, never editing one
that has already been applied to production.
