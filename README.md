# bbnovix

**Next · Organization · Vision · Innovation · eXcellence**

A free, multi-tenant employee-portal platform. Any company subscribes from the
public site, gets its own address at `bbnovix.com/{company}/`, its own identity,
and a full workspace: employee services, forms and approvals, documents,
announcements, surveys, calendar, notes, chat, certificates and public document
verification.

## Addresses

| Address | What it is |
|---|---|
| `bbnovix.com/portal` | the product site |
| `bbnovix.com/signup` | self-service subscription |
| `bbnovix.com/verify/{code}` | public document verification |
| `bbnovix.com/support` | public support desk |
| `bbnovix.com/{company}/` | a company landing page |
| `bbnovix.com/{company}/login` | a company sign-in page |
| `bbnovix.com/{company}/app/…` | the portal application |
| `bbnovix.com/platform/app/platform` | the operator console |

The first path segment **is** the company, which is why it is validated,
reserved-word checked, unique and immutable.

## Architecture

One React app is served by GitHub Pages. Supabase is the managed backend:
Postgres, Auth, Storage, row-level security and Edge Functions. There is no
Node/C# application server in this repository, so production secrets must not be
placed in frontend files. The browser build may contain only public `VITE_*`
values such as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`; service-role,
SMTP and storage-provider secrets belong in Supabase function secrets.

The data model uses shared tables, `tenant_id` on every row, and isolation
enforced by a RESTRICTIVE row-level-security policy on every table. The full
rules are in [`docs/bbnovix_contract.md`](docs/bbnovix_contract.md); deployment
steps are in [`docs/bbnovix_deployment.md`](docs/bbnovix_deployment.md).

```
src/
  i18n/               language list + one dictionary file per module
  lib/routing.js      the address model — never build a URL by hand
  lib/storage/        the storage abstraction (core vs extended layers)
  context/            language, preferences, tenant, auth
  data/               every Supabase call, one service per module
  components/         one folder per module
supabase/
  migrations/         numbered, idempotent SQL
  functions/          signup, e-mail, verification API, storage proxy
```

## Running locally

```bash
npm install
cp .env.example .env      # fill in the Supabase URL and anon key
npm run dev               # http://127.0.0.1:5188/shalfa/
```

Without Supabase credentials the app runs on built-in demo data.

## Building

```bash
npm run build
```

The build emits `dist/404.html` as a copy of `index.html`, which is what makes
deep links work on GitHub Pages. `public/CNAME` points the Pages site at
`bbnovix.com`. Set the `VITE_BASE_PATH` repository variable only when publishing
under a sub-directory instead of a domain root.

## Migrations

Apply `supabase/migrations/*.sql` in filename order. Migration `0012` converts
the single-company portal into the platform: it creates the `platform` and
`shalfa` tenants and moves every existing row into `shalfa`.
