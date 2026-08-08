-- Production release security hardening.
--
-- Browser-side URL filtering is defense in depth, not an authorization
-- boundary. These constraints stop executable schemes and malformed branding
-- data at the shared data layer, including writes made outside the React app.

update public.tenant_branding
set website_url = null
where nullif(trim(website_url), '') is not null
  and trim(website_url) !~* '^https://[^[:space:]]+$';

update public.tenant_branding
set linkedin_url = null
where nullif(trim(linkedin_url), '') is not null
  and trim(linkedin_url) !~* '^https://[^[:space:]]+$';

update public.tenant_branding
set map_url = null
where nullif(trim(map_url), '') is not null
  and trim(map_url) !~* '^https://[^[:space:]]+$';

update public.tenant_branding
set primary_color = '#0f766e'
where primary_color !~* '^#[0-9a-f]{6}$';

update public.tenant_branding
set secondary_color = '#0b3b60'
where secondary_color !~* '^#[0-9a-f]{6}$';

update public.tenant_branding
set accent_color = '#f59e0b'
where accent_color !~* '^#[0-9a-f]{6}$';

alter table public.tenant_branding
  drop constraint if exists tenant_branding_safe_links,
  add constraint tenant_branding_safe_links check (
    (nullif(trim(website_url), '') is null or trim(website_url) ~* '^https://[^[:space:]]+$')
    and (nullif(trim(linkedin_url), '') is null or trim(linkedin_url) ~* '^https://[^[:space:]]+$')
    and (nullif(trim(map_url), '') is null or trim(map_url) ~* '^https://[^[:space:]]+$')
  ),
  drop constraint if exists tenant_branding_safe_colors,
  add constraint tenant_branding_safe_colors check (
    primary_color ~* '^#[0-9a-f]{6}$'
    and secondary_color ~* '^#[0-9a-f]{6}$'
    and accent_color ~* '^#[0-9a-f]{6}$'
  );

comment on constraint tenant_branding_safe_links on public.tenant_branding is
  'Publicly rendered links must use HTTPS; blocks javascript:, data:, credentials, and scheme-relative payloads.';

comment on constraint tenant_branding_safe_colors on public.tenant_branding is
  'CSS theme values are six-digit hexadecimal colors only.';

-- Public/core images must be passive raster formats. SVG is active XML and can
-- execute script when opened directly; ICO adds no capability the platform
-- needs because browsers accept PNG favicons.
update public.storage_policies
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'],
    updated_on = now()
where layer = 'Core';
