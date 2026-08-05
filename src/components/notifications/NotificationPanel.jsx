import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArchiveRestore, BellOff, CalendarDays, CheckCheck, ClipboardList, Inbox,
  LifeBuoy, Mail, Megaphone, MonitorCog, Pin, PinOff, ScrollText, Settings2,
  ShieldCheck, Trash2, Undo2,
} from 'lucide-react';
import { useLocation } from 'wouter';
import { useLanguage } from '../../context/LanguageContext';
import { codeLabel, formatDate, formatRelative, pickLocalized } from '../../utils/localize';
import {
  NOTIFICATION_VIEWS,
  deleteNotification,
  loadNotificationFeed,
  markAllNotificationsRead,
  markNotifications,
  notificationErrorKey,
  pinNotification,
} from '../../data/notificationCenterService';
import './notifications.css';

const CATEGORY_ICONS = {
  Message: Mail,
  Circular: ScrollText,
  Announcement: Megaphone,
  Survey: ClipboardList,
  Approval: Inbox,
  Event: CalendarDays,
  System: MonitorCog,
  Support: LifeBuoy,
  Verification: ShieldCheck,
};

const EMPTY_KEYS = {
  Unread: 'notif_empty_unread',
  Read: 'notif_empty_read',
  Pinned: 'notif_empty_pinned',
  Archived: 'notif_empty_archived',
};

const DAY_MS = 86400000;
const startOfDay = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/**
 * A day heading the reader recognises: today, yesterday, "3 days ago", then a
 * plain date. The relative wording comes from the shared helper, fed a date
 * that is exactly N days away so the formatter picks the day unit.
 */
const useDayLabel = () => {
  const { t, locale } = useLanguage();
  return useCallback((dayStart) => {
    if (dayStart == null) return t('notif_group_earlier');
    const today = startOfDay(Date.now());
    const diff = Math.round((dayStart - today) / DAY_MS);
    if (diff === 0) return t('label_today');
    if (diff === -1) return t('label_yesterday');
    if (diff > -7) return formatRelative(new Date(Date.now() + diff * DAY_MS), locale);
    return formatDate(dayStart, locale, { dateStyle: 'medium' });
  }, [t, locale]);
};

const groupByDay = (rows) => {
  const groups = [];
  rows.forEach((row) => {
    const day = startOfDay(row.created_on);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(row);
    else groups.push({ day, items: [row] });
  });
  return groups;
};

// ---------------------------------------------------------------------------

const NotificationRow = ({ row, onOpen, onMark, onPin, onDelete }) => {
  const { t, lang, locale } = useLanguage();
  const Icon = CATEGORY_ICONS[row.category] || Megaphone;
  const title = pickLocalized(row, 'title', lang, '');
  const body = pickLocalized(row, 'body', lang, '');
  const isUnread = row.state === 'Unread';
  const isArchived = row.state === 'Archived';

  return (
    <li className={`notification-item ${isUnread ? 'is-unread' : ''}`.trim()}>
      <span className="notification-icon" aria-hidden="true"><Icon /></span>
      <div className="notification-body">
        <button type="button" className="notification-open" onClick={() => onOpen(row)} title={t('notif_open_item')}>
          <b>{title}</b>
          {body ? <p>{body}</p> : null}
        </button>
        <div className="notification-meta">
          <span className="notification-category">{codeLabel(t, 'notif_category', row.category, row.category)}</span>
          <span>{formatRelative(row.created_on, locale)}</span>
          {row.is_pinned ? (
            <span className="notification-pinned-flag"><Pin aria-hidden="true" /> {t('notif_pinned_flag')}</span>
          ) : null}
        </div>
        <div className="notification-actions">
          <button
            type="button"
            onClick={() => onMark(row, isUnread ? 'Read' : 'Unread')}
            aria-label={t(isUnread ? 'notif_mark_read' : 'notif_mark_unread')}
            title={t(isUnread ? 'notif_mark_read' : 'notif_mark_unread')}
          >
            {isUnread ? <CheckCheck aria-hidden="true" /> : <Undo2 aria-hidden="true" />}
          </button>
          <button
            type="button"
            className={row.is_pinned ? 'is-on' : ''}
            onClick={() => onPin(row, !row.is_pinned)}
            aria-pressed={Boolean(row.is_pinned)}
            aria-label={t(row.is_pinned ? 'notif_unpin' : 'notif_pin')}
            title={t(row.is_pinned ? 'notif_unpin' : 'notif_pin')}
          >
            {row.is_pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={() => onMark(row, isArchived ? 'Read' : 'Archived')}
            aria-label={t(isArchived ? 'notif_unarchive' : 'notif_archive')}
            title={t(isArchived ? 'notif_unarchive' : 'notif_archive')}
          >
            {isArchived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => onDelete(row)}
            aria-label={t('notif_delete')}
            title={t('notif_delete')}
          >
            <Trash2 aria-hidden="true" />
          </button>
        </div>
      </div>
    </li>
  );
};

const PanelEmpty = ({ view }) => {
  const { t } = useLanguage();
  return (
    <div className="notification-panel-empty">
      <BellOff aria-hidden="true" />
      <b>{t(EMPTY_KEYS[view] || 'label_no_results')}</b>
      <small>{t('notif_empty_hint')}</small>
    </div>
  );
};

// ---------------------------------------------------------------------------

/**
 * @param {object} props
 * @param {{unread:number, read:number, archived:number, pinned:number}} props.counts
 * @param {number} props.version         bumped by the bell on poll / realtime
 * @param {() => void} props.onChanged   ask the bell to refresh its counters
 * @param {() => void} props.onClose
 * @param {() => void} [props.onOpenSettings]
 */
const NotificationPanel = ({ counts, version, onChanged, onClose, onOpenSettings }) => {
  const { t } = useLanguage();
  const [, navigate] = useLocation();
  const [view, setView] = useState('Unread');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorKey, setErrorKey] = useState('');
  const dayLabel = useDayLabel();
  const mounted = useRef(true);

  // Set on the way in as well as cleared on the way out: React remounts effects
  // in development, and a one-way flag would leave the panel permanently mute.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const apply = useCallback(({ data, error }) => {
    if (!mounted.current) return;
    setRows(data || []);
    setErrorKey(error ? notificationErrorKey(error, 'notif_err_load_failed') : '');
    setLoading(false);
  }, []);

  /** Used by the filing actions; the spinner is theirs to start. */
  const refresh = useCallback(async (nextView) => {
    apply(await loadNotificationFeed(nextView, 50));
  }, [apply]);

  // Tab changes and the bell's poll / realtime stamp both reload the list.
  useEffect(() => {
    let cancelled = false;
    loadNotificationFeed(view, 50).then((result) => {
      if (!cancelled) apply(result);
    });
    return () => { cancelled = true; };
  }, [apply, view, version]);

  const tabCounts = useMemo(() => ({
    Unread: counts?.unread || 0,
    Read: counts?.read || 0,
    Pinned: counts?.pinned || 0,
    Archived: counts?.archived || 0,
  }), [counts]);

  // Every filing action funnels through here so one place owns the error
  // wording, the reload and the counter refresh.
  const applied = async (result) => {
    if (result?.error) {
      setErrorKey(notificationErrorKey(result.error));
      return;
    }
    setErrorKey('');
    await refresh(view);
    onChanged?.();
  };

  const handleMark = async (row, state) => applied(await markNotifications([row.id], state));
  const handlePin = async (row, pinned) => applied(await pinNotification(row.id, pinned));

  const handleDelete = async (row) => {
    if (!window.confirm(t('notif_delete_confirm'))) return;
    applied(await deleteNotification(row.id));
  };

  const handleMarkAll = async () => applied(await markAllNotificationsRead());

  const handleOpen = async (row) => {
    if (row.state === 'Unread') {
      await markNotifications([row.id], 'Read');
      onChanged?.();
    }
    onClose?.();
    if (row.link_path) navigate(row.link_path);
  };

  const groups = useMemo(() => groupByDay(rows), [rows]);

  return (
    <div className="popover notification-panel" role="dialog" aria-label={t('notif_center')}>
      <div className="notification-panel-head">
        <h2>{t('notif_center')}</h2>
        {tabCounts.Unread > 0 && (
          <button type="button" className="text-button" onClick={handleMarkAll}>
            <CheckCheck size={15} aria-hidden="true" /> {t('notif_mark_all_read')}
          </button>
        )}
      </div>

      <div className="notification-tabs" role="tablist" aria-label={t('notif_center')}>
        {NOTIFICATION_VIEWS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            id={`notification-tab-${item}`}
            aria-selected={view === item}
            aria-controls="notification-feed"
            onClick={() => { setLoading(true); setView(item); }}
          >
            {t(`notif_tab_${item.toLowerCase()}`)}
            {tabCounts[item] > 0 && <span className="notification-tab-count">{tabCounts[item]}</span>}
          </button>
        ))}
      </div>

      <div
        className="notification-feed"
        id="notification-feed"
        role="tabpanel"
        aria-labelledby={`notification-tab-${view}`}
        aria-busy={loading}
      >
        <p className="sr-only" aria-live="polite">
          {loading ? t('notif_loading') : errorKey ? t(errorKey) : t('notif_live_updates')}
        </p>
        {errorKey ? <div className="notification-status error">{t(errorKey)}</div> : null}
        {loading && !rows.length ? <div className="notification-status">{t('notif_loading')}</div> : null}
        {!loading && !rows.length && !errorKey ? <PanelEmpty view={view} /> : null}
        {groups.map((group) => (
          <section key={group.day ?? 'unknown'}>
            <h3 className="notification-day">{dayLabel(group.day)}</h3>
            <ul className="notification-list">
              {group.items.map((row) => (
                <NotificationRow
                  key={row.id}
                  row={row}
                  onOpen={handleOpen}
                  onMark={handleMark}
                  onPin={handlePin}
                  onDelete={handleDelete}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="notification-panel-foot">
        <button type="button" onClick={() => { onClose?.(); onOpenSettings?.(); }}>
          <Settings2 aria-hidden="true" /> {t('shell_notification_settings')}
        </button>
        <button type="button" onClick={onClose}>{t('action_close')}</button>
      </div>
    </div>
  );
};

export default NotificationPanel;
