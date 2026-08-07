// The wayfinding trail shown above every authenticated screen.
//
// Rendered exactly once, from AppShell's own header area (see AppShell.jsx),
// for both Portal and Admin routes alike — no individual screen file needs
// to import this or know it exists. The trail is derived from the exact
// same navigation data the shell already loads (AppShell's own
// useNavigationGroups(), AdminNav's own useAdminNavigation()) rather than a
// hand-maintained third copy of the route map, per this codebase's own
// no-duplication rule. Reusing useAdminNavigation (instead of the raw
// ADMIN_GROUPS export) matters beyond de-duplication: it is the same
// role/module filter AdminCenter itself renders against, so a section this
// account isn't licensed or permitted to open never surfaces its real name
// or group in the trail either. This component takes no props: it reads the
// current route and the signed-in role itself.

import { memo, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Link, useLocation, useRoute } from 'wouter';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { isScreenActive, useNavigationGroups } from '../AppShell';
import { ADMIN_SECTION_IDS, useAdminNavigation } from '../admin/AdminNav';

/**
 * Routes that live inside the authenticated shell but carry no entry in
 * either AppShell's own Portal groups — useNavigationGroups() only keeps
 * area === 'PORTAL' screens, and its own local-preview fallback list
 * (FALLBACK_SCREENS in notificationCenterService.js) carries no row at all for some of
 * these — or AdminCenter's own :section routing: each is its own
 * top-level route in src/App.jsx instead. A minimal two-level trail beats
 * none; the label reuses the same key the module already shows elsewhere
 * (AppShell's own "Administration"/"Platform console" profile-menu
 * entries, VerificationCenter's own section-kicker) rather than a new one.
 */
const STANDALONE_ROUTES = [
  { path: '/app/verification', labelKey: 'module_verification' },
  { path: '/app/platform', labelKey: 'shell_screen_platform_console' },
  { path: '/app/card', labelKey: 'module_identity' },
];

/** /app/admin/:section — resolved against the role/module-filtered admin groups. */
const adminCrumbs = (t, home, section, adminGroups) => {
  const group = section ? adminGroups.find((entry) => entry.items.some((item) => item.id === section)) : null;
  const item = group?.items.find((entry) => entry.id === section) || null;
  const trail = [home, { key: 'admin', label: t('administration'), href: '/app/admin' }];
  if (group) {
    trail.push({ key: `admin-${group.id}`, label: t(group.labelKey), href: `/app/admin/${group.items[0].id}` });
  }
  if (item) trail.push({ key: `admin-${item.id}`, label: t(item.labelKey), href: `/app/admin/${item.id}` });
  return trail;
};

/** A Portal route — resolved against AppShell's own navigation groups. */
const portalCrumbs = (groups, location, home) => {
  for (const group of groups) {
    const screen = group.screens.find((candidate) => isScreenActive(candidate, location));
    if (screen) {
      return [
        home,
        { key: `group-${group.area}`, label: group.label, href: group.screens[0].path },
        { key: `screen-${screen.code}`, label: screen.label, href: screen.path },
      ];
    }
  }
  return null;
};

/** Neither Portal nor Admin — one of the standalone routes above. */
const standaloneCrumbs = (t, location, home) => {
  const match = STANDALONE_ROUTES.find((entry) => isScreenActive({ path: entry.path }, location));
  return match ? [home, { key: match.path, label: t(match.labelKey), href: match.path }] : null;
};

const Breadcrumb = () => {
  const { t, isRtl } = useLanguage();
  const { profile } = useAuth();
  const [location] = useLocation();
  const [onAdminRoute, adminParams] = useRoute('/app/admin/:section?');
  const groups = useNavigationGroups(profile?.role_code || 'EMPLOYEE');
  const adminGroups = useAdminNavigation({ roleCode: profile?.role_code || 'EMPLOYEE', available: ADMIN_SECTION_IDS });

  const crumbs = useMemo(() => {
    // The app's own landing route: every branch below would resolve to a
    // group + screen crumb that both restate "Home" (PORTAL_HOME's own
    // app_screens row is itself labelled Home), duplicating the home crumb.
    // Say nothing rather than render a redundant "Home > ... > Home" trail.
    if (location === '/app') return null;
    const home = { key: 'home', label: t('home'), href: '/app' };
    return onAdminRoute
      ? adminCrumbs(t, home, adminParams?.section, adminGroups)
      : portalCrumbs(groups, location, home) || standaloneCrumbs(t, location, home);
  }, [location, onAdminRoute, adminParams?.section, groups, adminGroups, t]);

  // Neither branch found a match (the app's own landing route, or a route
  // this component does not yet know about): say nothing rather than render
  // a one-crumb "Home" stub, a redundant "Home > ... > Home" trail, or a guess.
  if (!crumbs) return null;

  const ChevronIcon = isRtl ? ChevronLeft : ChevronRight;

  return (
    <nav className="shell-breadcrumb" aria-label={t('shell_breadcrumb')}>
      <ol>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <li key={crumb.key}>
              {index > 0 && <ChevronIcon aria-hidden="true" />}
              {isLast ? <span aria-current="page">{crumb.label}</span> : <Link href={crumb.href}>{crumb.label}</Link>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

export default memo(Breadcrumb);
