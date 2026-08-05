/* eslint-disable react-refresh/only-export-components */
// The company logo, everywhere it appears.
//
// Three rules, and they never change per screen:
//   1. A company that stored no logo renders NOTHING — no placeholder box, no
//      alt-text frame, no reserved space. The screen must look as if the logo
//      was never part of the design.
//   2. On a dark surface the dark logo wins when the company supplied one;
//      otherwise the light one is used, and the other way round.
//   3. The alternative text is the company name in the reading language.
//
// `variant` names the SURFACE the logo sits on, not the file to load:
//   'auto'  follow the resolved colour theme (default)
//   'light' a light surface — prefer logo_light_url
//   'dark'  a dark surface  — prefer logo_dark_url

import { useEffect, useMemo, useState } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { usePreferences } from '../../context/PreferencesContext';
import { useTenant } from '../../context/TenantContext';
import './branding.css';

const systemPrefersDark = () => {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

const clean = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
};

/** 'light' | 'dark' — the theme actually on screen, including 'system'. */
const useResolvedTheme = () => {
  const { theme } = usePreferences() || {};
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  // Subscribed unconditionally: the system preference can change while the user
  // is on a fixed theme, and must already be right the moment they switch back
  // to 'system'.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event) => setPrefersDark(event.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
};

/**
 * The resolved logo for a surface, for screens that must lay themselves out
 * differently when a company has no logo (a header keeps its spacing, a link
 * is not rendered empty).
 *
 * @param {'auto'|'light'|'dark'} [variant]
 * @returns {{ src: string|null, alt: string, hasLogo: boolean }}
 */
export const useTenantLogo = (variant = 'auto') => {
  const { branding, tenantName } = useTenant();
  const { t } = useLanguage();
  const resolvedTheme = useResolvedTheme();
  const surface = variant === 'light' || variant === 'dark' ? variant : resolvedTheme;

  return useMemo(() => {
    const light = clean(branding?.logo_light_url);
    const dark = clean(branding?.logo_dark_url);
    const src = surface === 'dark' ? dark || light : light || dark;
    return {
      src,
      alt: tenantName || t('label_company'),
      hasLogo: Boolean(src),
    };
  }, [branding, surface, tenantName, t]);
};

const TenantLogo = ({ variant = 'auto', className = '' }) => {
  const { src, alt } = useTenantLogo(variant);

  if (!src) return null;

  return (
    <img
      className={`tenant-logo ${className}`.trim()}
      src={src}
      alt={alt}
      decoding="async"
    />
  );
};

export default TenantLogo;
