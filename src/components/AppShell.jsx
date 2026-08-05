import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2, CalendarDays, Camera, CheckCircle2, ChevronDown, FileText, Folder, Home, Inbox,
  Image, LayoutGrid, LockKeyhole, LogOut, Megaphone, Menu, MonitorCog, Moon, Network, PenLine,
  ScanSearch, ScrollText, Settings, Settings2, ShieldCheck, StickyNote, Sun, Trash2, Upload,
  UserRound, X,
} from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { usePreferences } from '../context/PreferencesContext';
import { useTenant } from '../context/TenantContext';
import LanguageSwitcher from './LanguageSwitcher';
import GlobalSearch from './GlobalSearch';
import SignaturePad from './SignaturePad';
import TenantLogo, { useTenantLogo } from './branding/TenantLogo';
import NotificationBell from './notifications/NotificationBell';
import NotificationSettings from './notifications/NotificationSettings';
import { loadMyScreens } from '../data/notificationCenterService';
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

/** Areas render in this order; anything unknown is collected under "More". */
const AREA_ORDER = ['WORKSPACE', 'SERVICES', 'LIBRARY', 'ORGANIZATION', 'COMPLIANCE', 'ADMINISTRATION'];

const NAV_ICONS = {
  home: Home,
  'file-text': FileText,
  inbox: Inbox,
  folder: Folder,
  'scroll-text': ScrollText,
  image: Image,
  'sticky-note': StickyNote,
  calendar: CalendarDays,
  network: Network,
  'scan-search': ScanSearch,
  megaphone: Megaphone,
  settings: Settings,
  'shield-check': ShieldCheck,
  building: Building2,
};

/**
 * What the application looks like when public.my_screens() cannot answer —
 * an unmigrated database, a network blip, or local preview. Every entry maps to
 * a route that already exists in src/App.jsx.
 */
const FALLBACK_SCREENS = [
  { code: 'HOME', path: '/app', area: 'WORKSPACE', labelKey: 'home', icon: 'home', is_exact: true, display_order: 10 },
  { code: 'NOTES', path: '/app/notes', area: 'WORKSPACE', labelKey: 'module_notes', icon: 'sticky-note', module_code: 'NOTES', display_order: 20 },
  { code: 'CALENDAR', path: '/app/calendar', area: 'WORKSPACE', labelKey: 'module_calendar', icon: 'calendar', module_code: 'CALENDAR', display_order: 30 },
  { code: 'FORMS', path: '/app/forms', area: 'SERVICES', labelKey: 'forms', icon: 'file-text', module_code: 'FORMS', display_order: 10 },
  { code: 'APPROVALS', path: '/app/approvals', area: 'SERVICES', labelKey: 'approval_center', icon: 'inbox', module_code: 'APPROVALS', display_order: 20 },
  { code: 'DOCUMENTS', path: '/app/documents', area: 'LIBRARY', labelKey: 'docs', icon: 'folder', module_code: 'DOCUMENTS', display_order: 10 },
  { code: 'CIRCULARS', path: '/app/circulars', area: 'LIBRARY', labelKey: 'circulars', icon: 'scroll-text', module_code: 'DOCUMENTS', display_order: 20 },
  { code: 'DESIGNS', path: '/app/designs', area: 'LIBRARY', labelKey: 'designs', icon: 'image', module_code: 'DOCUMENTS', display_order: 30 },
  { code: 'ORG_CHART', path: '/app/org', area: 'ORGANIZATION', labelKey: 'shell_screen_org_chart', icon: 'network', display_order: 10 },
  { code: 'VERIFICATION', path: '/app/verification', area: 'COMPLIANCE', labelKey: 'module_verification', icon: 'scan-search', module_code: 'VERIFICATION', display_order: 10 },
  { code: 'ADMIN', path: '/app/admin', area: 'ADMINISTRATION', labelKey: 'administration', icon: 'settings', roles: ['PLATFORM_ADMIN', 'SYSTEM_ADMIN'], display_order: 10 },
  // Reserved for the operator workspace and never rendered anywhere else.
  { code: 'PLATFORM', path: '/app/platform', area: 'ADMINISTRATION', labelKey: 'shell_screen_platform_console', icon: 'shield-check', roles: ['PLATFORM_OPERATOR'], display_order: 20 },
];

const isScreenActive = (screen, location) => (
  screen.is_exact || screen.path === '/app'
    ? location === screen.path
    : location === screen.path || location.startsWith(`${screen.path}/`) || location.startsWith(`${screen.path}?`)
);

// ---------------------------------------------------------------------------
// Navigation model
// ---------------------------------------------------------------------------

/**
 * Reads the screens the role may open, groups them by area and drops any group
 * left empty once modules and roles have been applied.
 */
const useNavigationGroups = (roleCode) => {
  const { t, lang } = useLanguage();
  const { hasModule, modules } = useTenant();
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
    // A company whose profile carries no module map at all (local preview, or a
    // profile that predates licensing) is treated as "everything on"; a company
    // that does declare its modules is filtered strictly.
    const moduleMapKnown = Object.keys(modules || {}).length > 0;
    const moduleAllowed = (code) => !code || !moduleMapKnown || hasModule(code);
    const roleAllowed = (roles) => !roles || roles.includes(roleCode);

    const byArea = new Map();
    screens
      .filter((screen) => screen.path && moduleAllowed(screen.module_code) && roleAllowed(screen.roles))
      .forEach((screen) => {
        const area = String(screen.area || 'OTHER').toUpperCase();
        if (!byArea.has(area)) byArea.set(area, { area, sample: screen, screens: [] });
        byArea.get(area).screens.push({
          ...screen,
          label: pickLocalized(screen, 'name', lang, screen.labelKey ? t(screen.labelKey) : screen.code),
        });
      });

    return [...byArea.values()]
      .filter((group) => group.screens.length > 0)
      .map((group) => ({
        area: group.area,
        label: pickLocalized(
          group.sample,
          'area_name',
          lang,
          codeLabel(t, 'shell_area', group.area, t('shell_area_other')),
        ),
        screens: [...group.screens].sort((a, b) => (a.display_order || 0) - (b.display_order || 0)),
      }))
      .sort((a, b) => {
        const rank = (area) => {
          const index = AREA_ORDER.indexOf(area);
          return index === -1 ? AREA_ORDER.length : index;
        };
        return rank(a.area) - rank(b.area);
      });
  }, [screens, roleCode, hasModule, modules, lang, t]);
};

const ScreenIcon = ({ name }) => {
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
  const isAdmin = roleCode === 'PLATFORM_ADMIN' || roleCode === 'SYSTEM_ADMIN';
  const isPlatformOperator = roleCode === 'PLATFORM_OPERATOR';
  const groups = useNavigationGroups(roleCode);

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

        <GlobalSearch isAdmin={isAdmin} />

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
