/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { supabase, useLocalData } from '../lib/supabaseClient';
import { useLanguage } from './LanguageContext';
import { pickFromMap } from '../utils/localize';
import { DEFAULT_TENANT_SLUG } from '../lib/routing';

const TenantContext = createContext(null);

// Used for local preview and whenever Supabase is not configured, so the app
// still renders something coherent instead of an empty shell.
const demoTenant = {
  id: 'demo-tenant',
  slug: DEFAULT_TENANT_SLUG,
  status: 'Active',
  default_language: 'ar',
  timezone: 'Asia/Riyadh',
  country_code: 'SA',
  is_platform: false,
  names: { ar: 'شلفا', en: 'Shalfa' },
  short_names: { ar: 'شلفا', en: 'Shalfa' },
  branding: {
    logo_light_url: null,
    logo_dark_url: null,
    favicon_url: null,
    hero_image_url: null,
    theme_preset: 'aurora',
    primary_color: '#0f766e',
    secondary_color: '#0b3b60',
    accent_color: '#f59e0b',
    support_email: null,
    website_url: null,
    linkedin_url: null,
    map_url: null,
    address_ar: null,
    address_en: null,
  },
  contacts: [],
  // Local preview shows the whole product, so every module is on. A real
  // company gets this map from tenant_public_profile, where it is the licence
  // intersected with whatever the platform switched off for it.
  modules: Object.fromEntries([
    'EMPLOYEE_PORTAL', 'FORMS', 'APPROVALS', 'DOCUMENTS', 'ANNOUNCEMENTS',
    'CALENDAR', 'SURVEY', 'NOTES', 'CHAT', 'PERFORMANCE', 'KNOWLEDGE_BASE',
    'CERTIFICATES', 'VERIFICATION', 'SUPPORT',
  ].map((code) => [code, true])),
  settings: {
    rtl_default: true,
    allow_user_language: true,
    chat_private_enabled: true,
    chat_groups_enabled: true,
    chat_attachments_enabled: false,
    chat_max_attachment_mb: 5,
    verification_enabled: true,
  },
};

// The company's colours drive the whole design system, not a decorative accent:
// --brand is what every button, link and focus ring already reads.
const applyBrandColors = (branding) => {
  const root = document.documentElement;
  const primary = branding?.primary_color;
  const secondary = branding?.secondary_color;
  const accent = branding?.accent_color;

  const entries = {
    '--tenant-primary': primary,
    '--tenant-secondary': secondary,
    '--tenant-accent': accent,
    '--brand': primary,
    '--brand-dark': secondary || primary,
    '--brand-soft': primary ? `color-mix(in srgb, ${primary} 14%, var(--surface))` : null,
    '--amber': accent,
  };

  Object.entries(entries).forEach(([name, value]) => {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  });

  if (branding?.theme_preset) root.dataset.tenantTheme = branding.theme_preset;
};

const applyFavicon = (url) => {
  if (!url) return;
  let link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = url;
};

export const TenantProvider = ({ slug, children }) => {
  const { lang, t } = useLanguage();

  // The company comes from the address, so it is fixed for the lifetime of the
  // page: the cases that need no request are resolved before the first render
  // rather than through an effect.
  const [state, setState] = useState(() => {
    if (!slug) return { profile: null, loading: false, error: null };
    if (useLocalData || !supabase) return { profile: { ...demoTenant, slug }, loading: false, error: null };
    return { profile: null, loading: true, error: null };
  });

  const [reloadToken, setReloadToken] = useState(0);
  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!slug || useLocalData || !supabase) return undefined;

    let cancelled = false;
    supabase
      .rpc('tenant_public_profile', { p_slug: slug })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setState({ profile: null, loading: false, error: 'LOOKUP_FAILED' });
        else if (!data) setState({ profile: null, loading: false, error: 'NOT_FOUND' });
        else setState({ profile: data, loading: false, error: null });
      });

    return () => { cancelled = true; };
  }, [slug, reloadToken]);

  const profile = state.profile;

  useEffect(() => {
    if (!profile) return;
    applyBrandColors(profile.branding);
    applyFavicon(profile.branding?.favicon_url);
  }, [profile]);

  const tenantName = useMemo(
    () => pickFromMap(profile?.names, lang, profile?.default_language || 'ar', ''),
    [profile, lang],
  );

  useEffect(() => {
    if (!profile) return;
    const brand = t('employee_portal_brand');
    document.title = tenantName ? `${tenantName} · ${brand}` : brand;
  }, [profile, tenantName, t]);

  const value = useMemo(() => ({
    slug: slug || null,
    tenant: profile
      ? {
          id: profile.id,
          slug: profile.slug,
          status: profile.status,
          default_language: profile.default_language,
          timezone: profile.timezone,
          country_code: profile.country_code,
          is_platform: profile.is_platform,
        }
      : null,
    names: profile?.names || {},
    tenantName,
    shortName: pickFromMap(profile?.short_names, lang, profile?.default_language || 'ar', tenantName),
    branding: profile?.branding || {},
    contacts: profile?.contacts || [],
    settings: profile?.settings || {},
    modules: profile?.modules || {},
    hasModule: (code) => Boolean(profile?.modules?.[code]),
    // A company whose profile carries no module map at all (local preview, or
    // a profile that predates licensing) is treated as "everything on"; a
    // company that does declare its modules is filtered strictly. Shared here
    // so every nav/search surface applies the same "unknown module map" rule
    // instead of each re-deriving it.
    isModuleAllowed: (code) => (
      !code || Object.keys(profile?.modules || {}).length === 0 || Boolean(profile?.modules?.[code])
    ),
    isPlatform: Boolean(profile?.is_platform),
    isSuspended: profile?.status === 'Suspended' || profile?.status === 'Disabled',
    loading: state.loading,
    error: state.error,
    refresh,
  }), [slug, profile, tenantName, lang, state.loading, state.error, refresh]);

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
};

export const useTenant = () => useContext(TenantContext) || {
  slug: null,
  tenant: null,
  names: {},
  tenantName: '',
  shortName: '',
  branding: {},
  contacts: [],
  settings: {},
  modules: {},
  hasModule: () => false,
  isModuleAllowed: () => true,
  isPlatform: false,
  isSuspended: false,
  loading: false,
  error: null,
  refresh: () => {},
};
