import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { loadNotificationCounts, subscribeToNotifications } from '../../data/notificationCenterService';
import NotificationPanel from './NotificationPanel';
import './notifications.css';

const POLL_INTERVAL_MS = 60000;

/**
 * The bell owns the counters: it polls once a minute, listens for realtime
 * changes when the database offers them, and hands both the counts and a
 * version stamp to the panel so the open list refreshes with it.
 */
const NotificationBell = ({ onOpenSettings }) => {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const anchorRef = useRef(null);
  const mounted = useRef(true);
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState({ unread: 0, read: 0, archived: 0, pinned: 0, total: 0 });
  const [version, setVersion] = useState(0);

  // Re-armed on every mount: React remounts effects in development, and a flag
  // that only ever went false would freeze the badge after the first pass.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refreshCounts = useCallback(async () => {
    const { data } = await loadNotificationCounts();
    if (mounted.current && data) setCounts(data);
  }, []);

  // Poll, and bump the version so an open panel reloads with the counters.
  useEffect(() => {
    refreshCounts();
    const timer = window.setInterval(() => {
      refreshCounts();
      setVersion((value) => value + 1);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshCounts, profile?.id]);

  useEffect(() => {
    const unsubscribe = subscribeToNotifications(profile?.id, () => {
      refreshCounts();
      setVersion((value) => value + 1);
    });
    return unsubscribe;
  }, [profile?.id, refreshCounts]);

  // The panel is a popover: a click outside it or Escape closes it.
  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutside = (event) => {
      if (!anchorRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const unread = Number(counts.unread) || 0;

  return (
    <div className="menu-anchor" ref={anchorRef}>
      <button
        type="button"
        className="icon-button notification-bell-button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unread ? t('notif_unread_badge', { count: unread }) : t('notif_no_unread_badge')}
        title={t(open ? 'notif_close' : 'notif_open')}
      >
        <Bell aria-hidden="true" />
        {unread > 0 && (
          <span className="notification-bell-count" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>
      {open && (
        <NotificationPanel
          counts={counts}
          version={version}
          onChanged={refreshCounts}
          onClose={() => setOpen(false)}
          onOpenSettings={onOpenSettings}
        />
      )}
    </div>
  );
};

export default NotificationBell;
