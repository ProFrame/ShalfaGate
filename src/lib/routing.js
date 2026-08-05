// Address model for the bbnovix platform.
//
//   bbnovix.com/portal              the product site
//   bbnovix.com/signup              the subscription form
//   bbnovix.com/verify/{code}       public document verification
//   bbnovix.com/support             public support desk
//   bbnovix.com/{slug}/             a company landing page
//   bbnovix.com/{slug}/login        a company sign-in page
//   bbnovix.com/{slug}/app/...      the portal application
//
// The first path segment is the company, so it is the one thing no company may
// choose freely. Keep this list in sync with public.platform_reserved_slugs.

// import.meta.env exists under Vite; the optional chain keeps the module
// importable by tooling and tests that run it outside a bundler.
const RAW_BASE = import.meta.env?.BASE_URL || '/';

/** Deployment prefix without its trailing slash: '' at the domain root. */
const githubPagesProjectBase = () => {
  if (!window.location.hostname.endsWith('.github.io')) return '';
  const project = window.location.pathname.split('/').filter(Boolean)[0];
  return project ? `/${project}` : '';
};

export const BASE_PATH = RAW_BASE === './' || RAW_BASE === '.'
  ? githubPagesProjectBase()
  : RAW_BASE === '/'
    ? ''
    : RAW_BASE.replace(/\/$/, '');

/** Companies that existed before the platform did. */
export const DEFAULT_TENANT_SLUG = 'shalfa';
export const PLATFORM_SLUG = 'platform';

export const RESERVED_SLUGS = new Set([
  'platform', 'portal', 'verify', 'support', 'signup', 'api', 'app', 'admin',
  'login', 'logout', 'auth', 'reset-password', 'assets', 'static', 'data',
  'public', 'www', 'mail', 'cdn', 'status', 'docs', 'help', 'billing',
  'account', 'settings', 'bbnovix', 'null', 'undefined',
]);

/** Public areas that live outside any company. */
export const PUBLIC_SECTIONS = new Set(['portal', 'signup', 'verify', 'support']);

export const SLUG_PATTERN = /^[a-z0-9]{2,32}$/;

export const isValidSlug = (value) => SLUG_PATTERN.test(String(value || '').trim().toLowerCase());

export const isReservedSlug = (value) => RESERVED_SLUGS.has(String(value || '').trim().toLowerCase());

const stripBase = (pathname) => {
  if (BASE_PATH && pathname.startsWith(BASE_PATH)) return pathname.slice(BASE_PATH.length) || '/';
  return pathname || '/';
};

/**
 * Legacy links were hash based (`/#/app/forms`). They keep working:
 * the hash route is read once and rewritten onto the founding company.
 */
export const readLegacyHashRoute = () => {
  const hash = window.location.hash || '';
  if (!hash.startsWith('#/')) return null;   // '#access_token=...' is an auth callback, not a route
  return hash.slice(1) || '/';
};

/**
 * Splits the current address into the company it belongs to and the route
 * inside it.
 *
 * @returns {{ scope: 'public'|'tenant', section: string|null, slug: string|null, route: string }}
 */
export const parseLocation = (pathname = window.location.pathname) => {
  const path = stripBase(pathname);
  const segments = path.split('/').filter(Boolean);
  const first = (segments[0] || '').toLowerCase();

  if (!first) {
    return { scope: 'public', section: null, slug: null, route: '/' };
  }

  if (PUBLIC_SECTIONS.has(first)) {
    return {
      scope: 'public',
      section: first,
      slug: null,
      route: `/${segments.join('/')}`,
    };
  }

  if (isValidSlug(first) && !isReservedSlug(first)) {
    return {
      scope: 'tenant',
      section: null,
      slug: first,
      route: `/${segments.slice(1).join('/')}`,
    };
  }

  if (first === PLATFORM_SLUG) {
    return { scope: 'tenant', section: null, slug: PLATFORM_SLUG, route: `/${segments.slice(1).join('/')}` };
  }

  return { scope: 'public', section: null, slug: null, route: `/${segments.join('/')}` };
};

/** Absolute path of a company page: tenantPath('gold', 'login') -> '/gold/login'. */
export const tenantPath = (slug, sub = '') => {
  const clean = String(sub || '').replace(/^\/+/, '');
  return `${BASE_PATH}/${slug}${clean ? `/${clean}` : '/'}`;
};

/** Absolute path of a public page: publicPath('verify/ABC') -> '/verify/ABC'. */
export const publicPath = (sub = '') => {
  const clean = String(sub || '').replace(/^\/+/, '');
  return `${BASE_PATH}/${clean}`;
};

/** Fully qualified URL, for e-mails, QR codes and printed documents. */
export const absoluteUrl = (path) => `${window.location.origin}${path.startsWith('/') ? path : `/${path}`}`;

export const verifyUrl = (code) => absoluteUrl(publicPath(code ? `verify/${encodeURIComponent(code)}` : 'verify'));

export const companyUrl = (slug) => absoluteUrl(tenantPath(slug));

/**
 * Where an unauthenticated visitor should land. A company address keeps its
 * company; anything else goes to the product site.
 */
export const homePathFor = (slug) => (slug ? tenantPath(slug) : publicPath('portal'));
