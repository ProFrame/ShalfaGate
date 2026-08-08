# Production security review — 2026-08-08

## Release decision

The repository has been hardened for production and the automated release gate
passes. This statement covers the reviewed source and generated frontend build;
it is not a promise that any internet-facing system can be made immune to every
future vulnerability.

## Findings fixed in this release

- Removed employee names, business email addresses, phone numbers, internal
  document titles, circular titles, and direct document links from the static
  files under `public/data/`. Those files were anonymously downloadable on the
  deployed site even when the application itself required authentication.
- Updated the dependency lock to remove the high-severity `nanoid` advisory.
- Added a restrictive browser Content Security Policy and no-referrer policy.
- Restricted protected Edge Function CORS to configured/live application
  origins. Anonymous signup and verification are the only explicit open-CORS
  endpoints.
- Closed storage-proxy SSRF: only HTTPS endpoints belonging to the configured
  S3/R2/B2 vendor are accepted, credentials/ports/paths are rejected, and
  redirects are not followed.
- Added request-size ceilings to public signup, employee invitation, and
  extended-storage uploads.
- Public signup images are now passive raster formats only and are verified by
  file signature, not by client filename or declared MIME type. Core storage no
  longer accepts SVG/ICO for new uploads.
- Normalized public branding links client-side and added database constraints
  that reject non-HTTPS links and non-hex theme colors from every write path.
- Disabled public/anonymous Supabase Auth signup in configuration-as-code;
  accounts continue to be created only through the permission-gated service
  workflows. Refresh-token rotation and strict redirect URLs are explicit.
- Made database/config/function deployment wait for audit, lint, tests, and the
  production build. GitHub Actions permissions are now least-privilege per job,
  with serialized production deployments.
- Added release security invariants that prevent public fallback data, server
  secrets in frontend source, weakened CSP/CORS, or removal of the SSRF guard
  from returning unnoticed.
- Added an explicit proprietary notice, kept package publication disabled, and
  made minification/no-source-maps an explicit production invariant.

## Verification evidence

- `npm audit --audit-level=high`: 0 vulnerabilities.
- `npm run lint`: passed.
- `npm test`: 88/88 passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- Production `dist`: no source maps, service-role key names, SMTP/database
  password names, private-key markers, company email addresses, or static
  Google Drive document identifiers.

## Operational requirements

- Rotate any credential that was ever pasted into a scratch/planning file or a
  chat, even if it was never committed. The untracked `scratch_keys.txt` file
  found during this review was deleted and is now ignored.
- Configure `ALLOWED_ORIGINS=https://bbnovix.com,https://www.bbnovix.com` in
  Supabase Function Secrets. Never include `*` for protected functions.
- Configure the three GitHub Actions Supabase deployment secrets documented in
  `docs/bbnovix_deployment.md`. The release workflow now fails closed and will
  not publish a newer frontend while its backend deployment is unavailable.
- Enable GitHub secret scanning/push protection, Dependabot alerts, protected
  `main`, required status checks, and two-person review where the repository
  plan supports them.
- Enable Cloudflare Turnstile or hCaptcha in Supabase Auth and place an
  equivalent challenge/WAF rule in front of the custom public tenant-signup
  Edge Function. CAPTCHA keys and edge/WAF account access are external settings,
  so they are not embedded in this repository.
- Require MFA for GitHub/Supabase administrators. Product-user MFA needs an
  enrollment/challenge UX and AAL2 database policy before it can be mandatory.
- Run `supabase/verification.sql` and `supabase/storage_security_audit.sql`
  against the live project after deployment and retain the results with the
  release record.

## Reverse-engineering boundary

Any JavaScript sent to a visitor can ultimately be inspected, even when it is
minified or obfuscated. Obfuscation is delay, not access control, and aggressive
anti-debug code is bypassable and can break legitimate browsers. The durable
protections used here are: keep the repository private, ship no source maps,
minify production code, keep secrets and privileged logic in Edge Functions/SQL,
enforce authorization with RLS, and state the proprietary rights explicitly.
