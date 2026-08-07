/* eslint-disable react-refresh/only-export-components */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlarmClock, Award, BarChart2, BarChart3, BellRing, Blocks, BookOpen, Boxes, Brain, Briefcase,
  Building, Building2, CalendarDays, Camera, CheckCircle2, ChevronDown, ClipboardCheck,
  ClipboardList, Contact, Copy, Database, FileBadge, FilePlus, FileSearch, FileSpreadsheet, FileText, Files,
  Folder, FolderOpen, Gauge, GitBranch, Globe, HardDrive, HardHat, Headphones, History, Home, IdCard, Inbox, Image,
  Key, LayoutDashboard, LayoutGrid, LifeBuoy, LineChart, List, ListChecks, Lock, LockKeyhole, LogOut, Mail,
  MapPin, MapPinCheck, Megaphone, Menu, MessageCircle, MonitorCog, Moon, Network, Package, PackageCheck,
  Palette, PenLine, RefreshCw, ScanSearch, ScrollText, Send, Settings, Settings2, Shield, ShieldAlert,
  ShieldCheck, Stamp, Star, StickyNote, Sun, Target, Trash2, TrendingUp, Upload, User, UserCheck, UserRound, Users,
  Warehouse, X,
} from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { isAdminRole, useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { usePreferences } from '../context/PreferencesContext';
import { useTenant } from '../context/TenantContext';
import LanguageSwitcher from './LanguageSwitcher';
import GlobalSearch from './GlobalSearch';
import SignaturePad from './SignaturePad';
import Breadcrumb from './shell/Breadcrumb';
import TenantLogo, { useTenantLogo } from './branding/TenantLogo';
import NotificationBell from './notifications/NotificationBell';
import NotificationSettings from './notifications/NotificationSettings';
import { FALLBACK_SCREENS, loadMyScreens } from '../data/notificationCenterService';
import { screenSnapshotFromNav, touchRecentScreen } from '../data/navigationAidsService';
import { codeLabel, pickFromMap, pickLocalized } from '../utils/localize';
import { verifyUrl } from '../lib/routing';
import './notifications/notifications.css';

// The chat panel is a whole module of its own; it must not sit in the shell
// bundle, and it only exists for companies that licensed CHAT.
const ChatLauncher = lazy(() => import('./chat/ChatLauncher'));

const ROLE_LABEL_KEYS = {
  PLATFORM_OPERATOR: 'role_platform_operator',
  PLATFORM_ADMIN: 'role_platform_administrator',
  SYSTEM_ADMIN: 'role_system_administrator',
  DEPARTMENT_MANAGER: 'role_department_manager',
  DEPARTMENT_COORDINATOR: 'role_department_coordinator',
  EMPLOYEE: 'role_employee',
};

/**
 * Nav clusters render in this order; anything unknown is collected under
 * "More". These are public.app_screens.group_code values (uppercased) — the
 * fine-grained cluster the DB actually seeds per screen — NOT the coarse
 * area partition (Portal/Admin/Platform), which useNavigationGroups() below
 * uses separately to decide which screens ever reach this nav at all. Kept
 * in one flat order across every Portal-area module so a user moving
 * between Assets/Safety/Operations/Forms/etc. sees the same cluster order
 * every time, per FourthUpdate.md's own Global Navigation Standards.
 */
const GROUP_ORDER = [
  'WORKSPACE', 'REQUESTS', 'CONTENT', 'ENGAGEMENT', 'PRODUCTIVITY', 'COLLABORATION', 'VERIFICATION', 'PERFORMANCE',
];

// One entry per distinct public.app_screens.icon string value across every
// migration (confirmed via a full scan of every insert into app_screens —
// see docs/update4_ui_polish.md). ScreenIcon's own `|| LayoutGrid` fallback
// below stays as a defensive last resort for a future screen shipped with a
// typo'd icon string, not as this map's normal behavior.
const NAV_ICONS = {
  activity: Activity,
  'alarm-clock': AlarmClock,
  award: Award,
  'bar-chart-2': BarChart2,
  'bar-chart-3': BarChart3,
  bell: BellRing,
  'bell-ring': BellRing,
  blocks: Blocks,
  'book-open': BookOpen,
  boxes: Boxes,
  brain: Brain,
  briefcase: Briefcase,
  building: Building,
  'building-2': Building2,
  calendar: CalendarDays,
  'calendar-days': CalendarDays,
  'check-circle': CheckCircle2,
  'clipboard-check': ClipboardCheck,
  'clipboard-list': ClipboardList,
  contact: Contact,
  copy: Copy,
  database: Database,
  'file-badge': FileBadge,
  'file-plus': FilePlus,
  'file-search': FileSearch,
  'file-spreadsheet': FileSpreadsheet,
  'file-text': FileText,
  files: Files,
  folder: Folder,
  'folder-open': FolderOpen,
  gauge: Gauge,
  'git-branch': GitBranch,
  globe: Globe,
  'hard-drive': HardDrive,
  'hard-hat': HardHat,
  headphones: Headphones,
  history: History,
  home: Home,
  'id-card': IdCard,
  image: Image,
  inbox: Inbox,
  key: Key,
  layers: Boxes,
  'layout-dashboard': LayoutDashboard,
  'layout-grid': LayoutGrid,
  'life-buoy': LifeBuoy,
  'line-chart': LineChart,
  list: List,
  'list-checks': ListChecks,
  lock: Lock,
  mail: Mail,
  'map-pin': MapPin,
  'map-pin-check': MapPinCheck,
  megaphone: Megaphone,
  'message-circle': MessageCircle,
  network: Network,
  package: Package,
  'package-check': PackageCheck,
  palette: Palette,
  'refresh-cw': RefreshCw,
  'scan-search': ScanSearch,
  'scroll-text': ScrollText,
  send: Send,
  settings: Settings,
  shield: Shield,
  'shield-alert': ShieldAlert,
  'shield-check': ShieldCheck,
  stamp: Stamp,
  star: Star,
  'sticky-note': StickyNote,
  target: Target,
  'trending-up': TrendingUp,
  upload: Upload,
  user: User,
  'user-check': UserCheck,
  users: Users,
  warehouse: Warehouse,
};

export const isScreenActive = (screen, location) => (
  screen.is_exact || screen.path === '/app'
    ? location === screen.path
    : location === screen.path || location.startsWith(`${screen.path}/`) || location.startsWith(`${screen.path}?`)
);

// ---------------------------------------------------------------------------
// Navigation model
// ---------------------------------------------------------------------------

/**
 * Reads the screens the role may open, keeps only the ones belonging to the
 * Portal surface (Admin/Platform screens have their own dedicated entry
 * points — AdminNav.jsx's own sidebar, and the "Platform console"
 * profile-menu item below — rather than being flattened into this nav a
 * second time), groups what's left by group_code, and drops any cluster
 * left empty once modules and roles have been applied.
 *
 * A prior version of this hook grouped by `screen.area` directly. Every
 * real row's `area` is one of exactly Portal/Admin/Platform (never one of
 * GROUP_ORDER's own values), so every group used to collapse into a single
 * "More" bucket for every real deployment — this only ever looked correct
 * in local preview, where FALLBACK_SCREENS' hand-written values happened to
 * already match a since-removed area vocabulary. See
 * docs/update4_ui_polish.md for the full writeup.
 */
export const useNavigationGroups = (roleCode) => {
  const { t, lang } = useLanguage();
  const { isModuleAllowed } = useTenant();
  const [screens, setScreens] = useState(FALLBACK_SCREENS);

  useEffect(() => {
    let cancelled = false;
    loadMyScreens().then(({ data }) => {
      // `null` means the server could not answer: keep the static list rather
      // than leaving the person without navigation.
      if (!cancelled && data?.length) setScreens(data);
    });
    return () => { cancelled = true; };
  }, []);

  return useMemo(() => {
    const roleAllowed = (roles) => !roles || roles.includes(roleCode);

    const byGroup = new Map();
    screens
      .filter((screen) => (
        screen.path
        && String(screen.area || 'PORTAL').toUpperCase() === 'PORTAL'
        && isModuleAllowed(screen.module_code)
        && roleAllowed(screen.roles)
      ))
      .forEach((screen) => {
        const group = String(screen.group || screen.area || 'OTHER').toUpperCase();
        if (!byGroup.has(group)) byGroup.set(group, { group, sample: screen, screens: [] });
        byGroup.get(group).screens.push({
          ...screen,
          label: pickLocalized(screen, 'name', lang, screen.labelKey ? t(screen.labelKey) : screen.code),
        });
      });

    return [...byGroup.values()]
      .filter((group) => group.screens.length > 0)
      .map((group) => ({
        area: group.group,
        label: pickLocalized(
          group.sample,
          'area_name',
          lang,
          codeLabel(t, 'shell_area', group.group, t('shell_area_other')),
        ),
        screens: [...group.screens].sort((a, b) => (a.display_order || 0) - (b.display_order || 0)),
      }))
      .sort((a, b) => {
        const rank = (group) => {
          const index = GROUP_ORDER.indexOf(group);
          return index === -1 ? GROUP_ORDER.length : index;
        };
        return rank(a.area) - rank(b.area);
      });
  }, [screens, roleCode, isModuleAllowed, lang, t]);
};

// Exported: FavoritesScreen.jsx/RecentItemsScreen.jsx render the same
// per-screen icon this shell's own nav uses (from the SAME NAV_ICONS
// vocabulary above), rather than maintaining a second icon lookup for the
// exact same public.app_screens.icon values.
export const ScreenIcon = ({ name }) => {
  const Icon = NAV_ICONS[name] || LayoutGrid;
  return <Icon aria-hidden="true" />;
};

const HeaderNav = ({ groups, location }) => {
  const { t } = useLanguage();
  const navRef = useRef(null);
  const [openArea, setOpenArea] = useState(null);
  const [lastLocation, setLastLocation] = useState(location);

  // Navigating anywhere — including from the global search — closes the menu.
  if (lastLocation !== location) {
    setLastLocation(location);
    setOpenArea(null);
  }

  useEffect(() => {
    if (!openArea) return undefined;
    const closeOnOutside = (event) => {
      if (!navRef.current?.contains(event.target)) setOpenArea(null);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpenArea(null);
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [openArea]);

  return (
    <nav className="app-nav" ref={navRef} aria-label={t('shell_primary_navigation')}>
      {groups.map((group) => {
        // A group of one is a plain link: no one should open a menu to reach
        // the only thing inside it.
        if (group.screens.length === 1) {
          const screen = group.screens[0];
          return (
            <Link key={group.area} href={screen.path} className={isScreenActive(screen, location) ? 'active' : ''}>
              {screen.label}
            </Link>
          );
        }

        const active = group.screens.some((screen) => isScreenActive(screen, location));
        const open = openArea === group.area;
        return (
          <div className="shell-nav-group" key={group.area}>
            <button
              type="button"
              className={`shell-nav-trigger ${active ? 'active' : ''}`.trim()}
              aria-expanded={open}
              aria-haspopup="true"
              onClick={() => setOpenArea(open ? null : group.area)}
            >
              {group.label}
              <ChevronDown className="shell-nav-caret" aria-hidden="true" />
            </button>
            {open && (
              <div className="popover shell-nav-popover">
                {group.screens.map((screen) => (
                  <Link
                    key={screen.code}
                    href={screen.path}
                    className={isScreenActive(screen, location) ? 'active' : ''}
                    onClick={() => setOpenArea(null)}
                  >
                    <ScreenIcon name={screen.icon} />
                    {screen.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
};

const DrawerNav = ({ groups, location, onNavigate }) => (
  <div className="shell-drawer-nav">
    {groups.map((group) => (
      <section className="shell-drawer-group" key={group.area}>
        <h2>{group.label}</h2>
        {group.screens.map((screen) => (
          <Link
            key={screen.code}
            href={screen.path}
            className={isScreenActive(screen, location) ? 'active' : ''}
            onClick={onNavigate}
          >
            <ScreenIcon name={screen.icon} />
            {screen.label}
          </Link>
        ))}
      </section>
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// Header controls
// ---------------------------------------------------------------------------

const THEME_CYCLE = { light: 'dark', dark: 'system', system: 'light' };
const THEME_ICONS = { light: Sun, dark: Moon, system: MonitorCog };
const THEME_ACTION_KEYS = {
  light: 'shell_theme_switch_to_dark',
  dark: 'shell_theme_switch_to_system',
  system: 'shell_theme_switch_to_light',
};

/**
 * The company mark. TenantLogo renders nothing for a company that stored no
 * logo, so the shell falls back to the company name rather than leaving an
 * empty, clickable gap in the header.
 */
const ShellBrand = () => {
  const { hasLogo } = useTenantLogo('auto');
  const { tenantName } = useTenant();
  const { t } = useLanguage();

  if (hasLogo) return <TenantLogo variant="auto" className="shell-logo" />;
  return <span className="shell-logo-text">{tenantName || t('employee_portal_brand')}</span>;
};

const ThemeControl = () => {
  const { t } = useLanguage();
  const { theme, setTheme } = usePreferences();
  const current = THEME_ICONS[theme] ? theme : 'system';
  const Icon = THEME_ICONS[current];
  const label = t(THEME_ACTION_KEYS[current]);

  return (
    <button
      type="button"
      className="icon-button shell-theme-button"
      onClick={() => setTheme(THEME_CYCLE[current])}
      aria-label={label}
      title={`${t('shell_theme')} — ${label}`}
    >
      <Icon aria-hidden="true" />
    </button>
  );
};

const CompanySwitcher = ({ memberships, onError }) => {
  const { t, lang } = useLanguage();
  const { switchTenant } = useAuth();
  const { slug } = useTenant();

  return (
    <div className="shell-company-switch">
      <span>{t('my_companies')}</span>
      {memberships.map((membership) => {
        const current = membership.slug === slug;
        return (
          <button
            key={membership.tenant_id || membership.slug}
            type="button"
            aria-current={current}
            onClick={async () => {
              if (current) return;
              const { error } = await switchTenant(membership.tenant_id);
              if (error) onError('shell_switch_company_failed');
            }}
          >
            <Building2 aria-hidden="true" />
            <span>{pickFromMap(membership.names, lang, 'ar', membership.slug)}</span>
            <small>{membership.slug}</small>
          </button>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------

const AppShell = ({ children }) => {
  const {
    profile, memberships, signOut, updatePassword, updateProfile, uploadProfileAsset, deleteProfileAsset,
  } = useAuth();
  const { lang, t } = useLanguage();
  const { theme, setTheme } = usePreferences();
  const { hasModule } = useTenant();
  const [location, navigate] = useLocation();
  const menuRef = useRef(null);
  const avatarInputRef = useRef(null);
  const signatureInputRef = useRef(null);
  const touchedLocationRef = useRef(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [modal, setModal] = useState(null);
  const [profileDraft, setProfileDraft] = useState({ full_name: profile?.full_name || '', mobile: profile?.mobile || '' });
  const [password, setPassword] = useState('');
  const [assetBusy, setAssetBusy] = useState(false);
  const [drawingSignature, setDrawingSignature] = useState(false);
  const [assetNotice, setAssetNotice] = useState('');
  const [menuErrorKey, setMenuErrorKey] = useState('');
  const [lastLocation, setLastLocation] = useState(location);

  const roleCode = profile?.role_code || 'EMPLOYEE';
  const isAdmin = isAdminRole(roleCode);
  const isPlatformOperator = roleCode === 'PLATFORM_OPERATOR';
  const groups = useNavigationGroups(roleCode);

  // Coarse role codes (isAdmin above) miss the fine-grained case: a role_screens
  // override or min_role_rank grant (public.my_screens(), migration
  // 202608040018) can hand a non-admin role a single Admin-area screen. Without
  // this, that person has no persistent, browsable path to /app/admin — only
  // Global Search surfaces it. Mirrors AdminNav.jsx's own useAdminNavigation,
  // which likewise reads my_screens() rather than trusting the role code.
  const [hasAdminAreaAccess, setHasAdminAreaAccess] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadMyScreens().then(({ data }) => {
      if (!cancelled && data?.some((screen) => screen.area === 'ADMIN')) setHasAdminAreaAccess(true);
    });
    return () => { cancelled = true; };
  }, []);

  // Recent Items bookkeeping — records that the signed-in person just landed
  // on a real screen, once per actual route change. Reuses isScreenActive()
  // (above) against this SAME groups data to resolve "which screen is this",
  // the identical test the nav itself uses to decide what to highlight, so
  // this can never disagree with what the header/drawer nav shows as active.
  // touchedLocationRef (not React state) is the de-dupe key rather than
  // `location` alone: `groups` is a useMemo that gets a new reference on
  // every language switch (its own deps include `lang`) with `location`
  // unchanged, and a naive `[location]`-only effect would either miss a
  // direct deep-link opened before the async my_screens() screens arrive (no
  // match yet on first run) or, keyed on both, would need to fire a second
  // time for the very language change this bookkeeping has nothing to do
  // with. Comparing against the ref instead lets the effect safely re-run
  // when `groups` resolves without re-touching on every incidental
  // recompute, while still recording a screen the moment it becomes
  // resolvable. A location matching no known screen (still loading, or truly
  // not a registered screen) is left untouched rather than sent to the RPC,
  // which would just no-op on it anyway.
  useEffect(() => {
    if (touchedLocationRef.current === location) return;
    const screen = groups.flatMap((group) => group.screens).find((candidate) => isScreenActive(candidate, location));
    if (!screen) { touchedLocationRef.current = null; return; }
    touchedLocationRef.current = location;
    touchRecentScreen(screen.code, screenSnapshotFromNav(screen));
  }, [location, groups]);

  useEffect(() => {
    const close = (event) => {
      if (!menuRef.current?.contains(event.target)) setProfileOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // The drawer never survives a route change, whoever triggered it.
  if (lastLocation !== location) {
    setLastLocation(location);
    setMobileOpen(false);
  }

  const displayName = pickLocalized(profile, 'full_name', lang, t('employee'));
  const initials = displayName.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('');
  const roleLabel = t(ROLE_LABEL_KEYS[roleCode] || 'role_employee');

  const openNotificationSettings = useCallback(() => {
    setProfileOpen(false);
    setModal('notifications');
  }, []);

  const logout = async () => {
    await signOut();
    navigate('/');
  };

  const uploadAsset = async (file, kind) => {
    if (!file) return;
    setAssetBusy(true);
    try {
      const { error } = await uploadProfileAsset(file, kind);
      if (error) throw error;
      setAssetNotice(t(kind === 'signature' ? 'signature_saved' : 'photo_saved'));
      if (kind === 'signature') setDrawingSignature(false);
    } catch {
      setAssetNotice(t('operation_failed'));
    } finally {
      setAssetBusy(false);
    }
  };

  return (
    <div className="app-layout">
      <header className="app-header">
        <button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label={t('open_menu')}><Menu /></button>
        <Link href="/app" className="app-logo" aria-label={t('home')}><ShellBrand /></Link>

        <HeaderNav groups={groups} location={location} />

        <GlobalSearch />

        <div className="header-actions">
          <LanguageSwitcher className="header-language-switcher" />
          <ThemeControl />
          <NotificationBell onOpenSettings={openNotificationSettings} />
          {hasModule('CHAT') && (
            <Suspense fallback={null}>
              <ChatLauncher />
            </Suspense>
          )}

          <div className="menu-anchor" ref={menuRef}>
            <button
              className="profile-trigger"
              onClick={() => { setMenuErrorKey(''); setProfileOpen((value) => !value); }}
              aria-expanded={profileOpen}
              aria-haspopup="true"
              aria-label={`${t('shell_account_menu')} — ${displayName}`}
            >
              <span className="avatar">{profile?.avatar_url ? <img src={profile.avatar_url} alt="" /> : initials}</span>
              <span className="profile-summary"><b>{displayName}</b><small>{roleLabel}</small></span>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
            {profileOpen && (
              <div className="popover profile-popover">
                <div className="profile-card">
                  <span className="avatar avatar-lg">{profile?.avatar_url ? <img src={profile.avatar_url} alt="" /> : initials}</span>
                  <div><b>{displayName}</b><small>{profile?.email}</small></div>
                </div>
                <button onClick={() => {
                  setProfileDraft({ full_name: profile?.full_name || '', mobile: profile?.mobile || '' });
                  setModal('profile');
                }}><UserRound /> {t('profile')}</button>
                <button onClick={() => setModal('security')}><LockKeyhole /> {t('security_password')}</button>
                <button onClick={openNotificationSettings}><Settings2 /> {t('shell_notification_settings')}</button>
                <button onClick={() => { setProfileOpen(false); window.open(verifyUrl(), '_blank', 'noopener'); }}>
                  <ScanSearch /> {t('verify_requests')}
                </button>
                {/* Every admin screen already has its own correctly-ordered,
                    fully-iconed nav — AdminNav.jsx's own sidebar, once inside
                    Admin Center — so this is a single entry point into it,
                    not the ~45 individual admin screens flattened a second
                    time into this menu. */}
                {(isAdmin || hasAdminAreaAccess) && (
                  <button onClick={() => { setProfileOpen(false); navigate('/app/admin'); }}>
                    <Settings /> {t('administration')}
                  </button>
                )}
                {/* The operator console belongs to the platform company alone. */}
                {isPlatformOperator && (
                  <button onClick={() => { setProfileOpen(false); navigate('/app/platform'); }}>
                    <ShieldCheck /> {t('shell_screen_platform_console')}
                  </button>
                )}
                <div className="menu-row">
                  <Sun size={17} aria-hidden="true" />
                  <label htmlFor="shell-appearance">{t('appearance')}</label>
                  <select id="shell-appearance" value={theme} onChange={(event) => setTheme(event.target.value)}>
                    <option value="light">{t('light')}</option>
                    <option value="dark">{t('dark')}</option>
                    <option value="system">{t('system')}</option>
                  </select>
                </div>
                {memberships?.length > 1 && (
                  <CompanySwitcher memberships={memberships} onError={setMenuErrorKey} />
                )}
                {menuErrorKey && <p className="shell-inline-error" role="alert">{t(menuErrorKey)}</p>}
                <button onClick={logout} className="danger-menu"><LogOut /> {t('logout')}</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <Breadcrumb />

      {mobileOpen && <div className="mobile-drawer-overlay" onClick={() => setMobileOpen(false)} />}
      <aside className={`mobile-drawer ${mobileOpen ? 'open' : ''}`} aria-label={t('shell_primary_navigation')}>
        <div>
          <ShellBrand />
          <button className="icon-button" onClick={() => setMobileOpen(false)} aria-label={t('shell_close_navigation')}><X /></button>
        </div>
        <LanguageSwitcher className="drawer-language-switcher" />
        <DrawerNav groups={groups} location={location} onNavigate={() => setMobileOpen(false)} />
      </aside>

      {children}

      {modal === 'notifications' && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal-card shell-settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <h3>{t('shell_notification_settings')}</h3>
              <button type="button" className="icon-button" onClick={() => setModal(null)} aria-label={t('action_close')}><X /></button>
            </div>
            <NotificationSettings />
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setModal(null)}>{t('action_close')}</button>
            </div>
          </div>
        </div>
      )}

      {(modal === 'profile' || modal === 'security') && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <form className="modal-card" onSubmit={async (event) => {
            event.preventDefault();
            if (modal === 'profile') await updateProfile(profileDraft);
            if (modal === 'security' && password) await updatePassword(password);
            setModal(null);
          }} onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <h3>{modal === 'profile' ? t('profile') : t('reset_password')}</h3>
              <button type="button" className="icon-button" onClick={() => setModal(null)} aria-label={t('action_close')}><X /></button>
            </div>
            {modal === 'profile' ? (
              <>
                <section className="profile-assets">
                  <div className="profile-asset-row">
                    <span className="avatar profile-photo-preview">{profile?.avatar_url ? <img src={profile.avatar_url} alt={t('profile_photo')} /> : initials}</span>
                    <div><b>{t('profile_photo')}</b><button type="button" className="secondary-button" disabled={assetBusy} onClick={() => avatarInputRef.current?.click()}><Camera /> {t('upload_photo')}</button></div>
                    <input ref={avatarInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label={t('upload_photo')} onChange={(event) => { uploadAsset(event.target.files?.[0], 'avatar'); event.target.value = ''; }} />
                  </div>
                  <div className="profile-signature-block">
                    <div className="profile-signature-heading"><b>{t('signature')}</b><div>
                      <button type="button" className="secondary-button" disabled={assetBusy} onClick={() => signatureInputRef.current?.click()}><Upload /> {t(profile?.signature_url ? 'replace_signature' : 'upload_signature')}</button>
                      <button type="button" className="secondary-button" onClick={() => setDrawingSignature((value) => !value)}><PenLine /> {t('draw_signature')}</button>
                      {profile?.signature_url && <button type="button" className="secondary-button danger" disabled={assetBusy} onClick={async () => { setAssetBusy(true); const { error } = await deleteProfileAsset('signature'); setAssetBusy(false); setAssetNotice(t(error ? 'operation_failed' : 'signature_deleted')); }}><Trash2 /> {t('delete_signature')}</button>}
                    </div></div>
                    {profile?.signature_url ? <div className="signature-preview"><span className="signature-saved"><CheckCircle2 /> {t('signature_saved')}</span><img src={profile.signature_url} alt={t('signature')} /></div> : <p className="field-note">{t('no_signature_saved')}</p>}
                    {drawingSignature && <SignaturePad busy={assetBusy} onSave={(file) => uploadAsset(file, 'signature')} />}
                    <input ref={signatureInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label={t('upload_signature')} onChange={(event) => { uploadAsset(event.target.files?.[0], 'signature'); event.target.value = ''; }} />
                    <p className="field-note">{t('profile_assets_note')}</p>
                    {assetNotice && <div className="inline-message" aria-live="polite">{assetNotice}</div>}
                  </div>
                </section>
                <label className="field-label">{t('display_name')}<input className="form-input" value={profileDraft.full_name} onChange={(event) => setProfileDraft({ ...profileDraft, full_name: event.target.value })} /></label>
                <label className="field-label">{t('mobile')}<input className="form-input" value={profileDraft.mobile} onChange={(event) => setProfileDraft({ ...profileDraft, mobile: event.target.value })} /></label>
                <label className="field-label">{t('work_email')}<input className="form-input readonly" value={profile?.email || ''} readOnly /></label>
                <p className="field-note">{t('email_change_note')}</p>
              </>
            ) : <label className="field-label">{t('new_password')}<input type="password" minLength="8" required className="form-input" value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
            <button className="primary-button">{t('save_changes')}</button>
          </form>
        </div>
      )}
    </div>
  );
};

export default AppShell;
