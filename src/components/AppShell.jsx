import { useEffect, useRef, useState } from 'react';
import { Bell, Camera, CheckCircle2, ChevronDown, LockKeyhole, LogOut, Menu, PenLine, Search, Settings, Sun, Trash2, Upload, UserRound, X } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { usePreferences } from '../context/PreferencesContext';
import LanguageSwitcher from './LanguageSwitcher';
import SignaturePad from './SignaturePad';
import { loadNotifications, markAllNotificationsRead, markNotificationRead } from '../data/notificationService';
import logo from '../assets/logo.png';

const nav = [
  { to: '/app', labelKey: 'home', end: true },
  { to: '/app/forms', labelKey: 'forms' },
  { to: '/app/approvals', labelKey: 'approval_center' },
  { to: '/app/documents', labelKey: 'docs' },
  { to: '/app/circulars', labelKey: 'circulars' },
  { to: '/app/designs', labelKey: 'designs' },
];

const NavItem = ({ item, location, onClick, t }) => {
  const active = item.end ? location === item.to : location.startsWith(item.to);
  return <Link href={item.to} className={active ? 'active' : ''} onClick={onClick}>{t(item.labelKey)}</Link>;
};

const roleKeys = {
  EMPLOYEE: 'role_employee',
  DEPARTMENT_COORDINATOR: 'role_department_coordinator',
  DEPARTMENT_MANAGER: 'role_department_manager',
  SYSTEM_ADMIN: 'role_system_administrator',
  PLATFORM_ADMIN: 'role_platform_administrator',
};

const AppShell = ({ children }) => {
  const { profile, signOut, updatePassword, updateProfile, uploadProfileAsset, deleteProfileAsset } = useAuth();
  const { lang, t } = useLanguage();
  const { theme, setTheme } = usePreferences();
  const [location, navigate] = useLocation();
  const menuRef = useRef(null);
  const avatarInputRef = useRef(null);
  const signatureInputRef = useRef(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [modal, setModal] = useState(null);
  const [profileDraft, setProfileDraft] = useState({ full_name: profile?.full_name || '', mobile: profile?.mobile || '' });
  const [password, setPassword] = useState('');
  const [assetBusy, setAssetBusy] = useState(false);
  const [drawingSignature, setDrawingSignature] = useState(false);
  const [assetNotice, setAssetNotice] = useState('');
  const isAdmin = profile?.role_code === 'PLATFORM_ADMIN' || profile?.role_code === 'SYSTEM_ADMIN';

  useEffect(() => {
    const close = (event) => {
      if (!menuRef.current?.contains(event.target)) setProfileOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => loadNotifications(profile?.id).then((items) => {
      if (active) setNotifications(items);
    });
    refresh();
    window.addEventListener('shalfa-content-updated', refresh);
    window.addEventListener('shalfa-forms-updated', refresh);
    return () => {
      active = false;
      window.removeEventListener('shalfa-content-updated', refresh);
      window.removeEventListener('shalfa-forms-updated', refresh);
    };
  }, [profile?.id]);

  const displayName = lang === 'en' && profile?.full_name_en ? profile.full_name_en : profile?.full_name || profile?.full_name_ar || t('employee');
  const initials = displayName.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('');
  const roleLabel = t(roleKeys[profile?.role_code] || 'role_employee');
  const unreadNotifications = notifications.filter((item) => !item.read).length;
  const openNotification = (item) => {
    markNotificationRead(profile?.id, item.id);
    setNotifications((current) => current.map((row) => row.id === item.id ? { ...row, read: true } : row));
    setNotificationsOpen(false);
    navigate(item.href);
  };

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
        <Link href="/app" className="app-logo"><img src={logo} alt="Shalfa" /></Link>
        <nav className="app-nav">
          {nav.map((item) => <NavItem key={item.to} item={item} location={location} t={t} />)}
          {isAdmin && <Link href="/app/admin" className={location.startsWith('/app/admin') ? 'active' : ''}>{t('administration')}</Link>}
        </nav>
        <div className="global-search"><Search size={18} /><input placeholder={t('search_portal')} /></div>
        <div className="header-actions">
          <LanguageSwitcher className="header-language-switcher" />
          <div className="menu-anchor">
            <button className="icon-button notification-button" onClick={() => setNotificationsOpen((value) => !value)} aria-label={t('notifications')}><Bell />{unreadNotifications > 0 && <span className="notification-count">{unreadNotifications > 9 ? '9+' : unreadNotifications}</span>}</button>
            {notificationsOpen && (
              <div className="popover notification-popover">
                <div className="popover-title"><strong>{t('notifications')}</strong><span>{t('unread_count', { count: unreadNotifications })}</span></div>
                {notifications.length ? notifications.map((item) => (
                  <button key={item.id} className={!item.read ? 'unread' : ''} onClick={() => openNotification(item)}>
                    <b>{lang === 'ar' || lang === 'ur' ? item.title_ar : item.title_en || item.title_ar}</b>
                    <small>{t(item.messageKey)}</small>
                  </button>
                )) : <div className="notification-empty">{t('no_notifications')}</div>}
                {unreadNotifications > 0 && <button className="notification-mark-all" onClick={() => {
                  markAllNotificationsRead(profile?.id, notifications);
                  setNotifications((current) => current.map((item) => ({ ...item, read: true })));
                }}>{t('mark_all_read')}</button>}
              </div>
            )}
          </div>
          <div className="menu-anchor" ref={menuRef}>
            <button className="profile-trigger" onClick={() => setProfileOpen((value) => !value)}>
              <span className="avatar">{profile?.avatar_url ? <img src={profile.avatar_url} alt="" /> : initials}</span>
              <span className="profile-summary"><b>{displayName}</b><small>{roleLabel}</small></span>
              <ChevronDown size={16} />
            </button>
            {profileOpen && (
              <div className="popover profile-popover">
                <div className="profile-card"><span className="avatar avatar-lg">{profile?.avatar_url ? <img src={profile.avatar_url} alt="" /> : initials}</span><div><b>{displayName}</b><small>{profile?.email}</small></div></div>
                <button onClick={() => {
                  setProfileDraft({ full_name: profile?.full_name || '', mobile: profile?.mobile || '' });
                  setModal('profile');
                }}><UserRound /> {t('profile')}</button>
                <button onClick={() => setModal('security')}><LockKeyhole /> {t('security_password')}</button>
                <div className="menu-row">
                  <Sun size={17} /><span>{t('appearance')}</span>
                  <select value={theme} onChange={(event) => setTheme(event.target.value)}>
                    <option value="light">{t('light')}</option>
                    <option value="dark">{t('dark')}</option>
                    <option value="system">{t('system')}</option>
                  </select>
                </div>
                <button onClick={logout} className="danger-menu"><LogOut /> {t('logout')}</button>
              </div>
            )}
          </div>
        </div>
      </header>

      {mobileOpen && <div className="mobile-drawer-overlay" onClick={() => setMobileOpen(false)} />}
      <aside className={`mobile-drawer ${mobileOpen ? 'open' : ''}`}>
        <div><img src={logo} alt="Shalfa" /><button className="icon-button" onClick={() => setMobileOpen(false)}><X /></button></div>
        <LanguageSwitcher className="drawer-language-switcher" />
        {nav.map((item) => <NavItem onClick={() => setMobileOpen(false)} key={item.to} item={item} location={location} t={t} />)}
        {isAdmin && <Link href="/app/admin" className={location.startsWith('/app/admin') ? 'active' : ''} onClick={() => setMobileOpen(false)}><Settings /> {t('administration')}</Link>}
      </aside>

      {children}

      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <form className="modal-card" onSubmit={async (event) => {
            event.preventDefault();
            if (modal === 'profile') await updateProfile(profileDraft);
            if (modal === 'security' && password) await updatePassword(password);
            setModal(null);
          }} onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <h3>{modal === 'profile' ? t('profile') : t('reset_password')}</h3>
              <button type="button" className="icon-button" onClick={() => setModal(null)}><X /></button>
            </div>
            {modal === 'profile' ? (
              <>
                <section className="profile-assets">
                  <div className="profile-asset-row">
                    <span className="avatar profile-photo-preview">{profile?.avatar_url ? <img src={profile.avatar_url} alt={t('profile_photo')} /> : initials}</span>
                    <div><b>{t('profile_photo')}</b><button type="button" className="secondary-button" disabled={assetBusy} onClick={() => avatarInputRef.current?.click()}><Camera /> {t('upload_photo')}</button></div>
                    <input ref={avatarInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { uploadAsset(event.target.files?.[0], 'avatar'); event.target.value = ''; }} />
                  </div>
                  <div className="profile-signature-block">
                    <div className="profile-signature-heading"><b>{t('signature')}</b><div>
                      <button type="button" className="secondary-button" disabled={assetBusy} onClick={() => signatureInputRef.current?.click()}><Upload /> {t(profile?.signature_url ? 'replace_signature' : 'upload_signature')}</button>
                      <button type="button" className="secondary-button" onClick={() => setDrawingSignature((value) => !value)}><PenLine /> {t('draw_signature')}</button>
                      {profile?.signature_url && <button type="button" className="secondary-button danger" disabled={assetBusy} onClick={async () => { setAssetBusy(true); const { error } = await deleteProfileAsset('signature'); setAssetBusy(false); setAssetNotice(t(error ? 'operation_failed' : 'signature_deleted')); }}><Trash2 /> {t('delete_signature')}</button>}
                    </div></div>
                    {profile?.signature_url ? <div className="signature-preview"><span className="signature-saved"><CheckCircle2 /> {t('signature_saved')}</span><img src={profile.signature_url} alt={t('signature')} /></div> : <p className="field-note">{t('no_signature_saved')}</p>}
                    {drawingSignature && <SignaturePad busy={assetBusy} onSave={(file) => uploadAsset(file, 'signature')} />}
                    <input ref={signatureInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { uploadAsset(event.target.files?.[0], 'signature'); event.target.value = ''; }} />
                    <p className="field-note">{t('profile_assets_note')}</p>
                    {assetNotice && <div className="inline-message">{assetNotice}</div>}
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
