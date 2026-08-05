// The announcements board on the home page.
//
// One announcement is one card. Two are two cards. Beyond that the cards become
// a carousel that advances every seven seconds, pauses while the pointer or the
// keyboard is inside it, can be swiped, and stops advancing entirely when the
// visitor asked for reduced motion.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Megaphone, Pause, Play, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { formatDate, pickLocalized } from '../../utils/localize';
import {
  engagementErrorMessage,
  loadAnnouncementFeed,
  markAnnouncementRead,
  readAnnouncementIds,
} from '../../data/engagementService';
import AnnouncementCard from './AnnouncementCard';
import { StatusLine } from './engagementUi';
import './announcements.css';

const AUTO_ADVANCE_MS = 7000;
const SWIPE_THRESHOLD = 45;

const useReducedMotion = () => {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return undefined;
    const onChange = (event) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
};

const AnnouncementDialog = ({ announcement, onClose }) => {
  const { t, lang, locale } = useLanguage();
  const closeRef = useRef(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const title = pickLocalized(announcement, 'title', lang, t('ann_untitled'));
  const body = pickLocalized(announcement, 'body', lang, '');
  const priority = announcement.priority || 'Normal';

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card announcement-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('ann_board_title')}</span>
            <h3>{title}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="announcement-dialog-meta">
          {priority !== 'Normal' && (
            <span className={`announcement-flag priority-${priority}`}>
              {t(`ann_priority_${priority.toLowerCase()}`)}
            </span>
          )}
          {(announcement.publish_from || announcement.created_on) && (
            <span className="announcement-card-date">
              {t('ann_published_on', {
                date: formatDate(announcement.publish_from || announcement.created_on, locale),
              })}
            </span>
          )}
        </div>

        {announcement.image_url && (
          <div className="announcement-media">
            <img src={announcement.image_url} alt={t('ann_image_alt', { title })} />
          </div>
        )}

        <p className="announcement-dialog-body">{body}</p>

        <div className="modal-actions">
          <button type="button" className="primary-button" onClick={onClose}>{t('action_close')}</button>
        </div>
      </div>
    </div>
  );
};

const AnnouncementsWidget = () => {
  const { t, isRtl } = useLanguage();
  const { hasModule } = useTenant();
  const { profile } = useAuth();
  const reducedMotion = useReducedMotion();

  const [announcements, setAnnouncements] = useState([]);
  const [sessionReads, setSessionReads] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [paused, setPaused] = useState(false);
  const [manuallyPaused, setManuallyPaused] = useState(false);
  const [openItem, setOpenItem] = useState(null);
  const pointerStart = useRef(null);
  const userId = profile?.id || profile?.user_id || null;

  useEffect(() => {
    let cancelled = false;
    loadAnnouncementFeed().then(({ data, error: loadError }) => {
      if (cancelled) return;
      setAnnouncements(Array.isArray(data) ? data : []);
      setError(loadError ? engagementErrorMessage(t, loadError) : '');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [t]);

  // What this browser already marked as read, plus whatever was marked during
  // the current visit — derived, so no effect has to synchronise the two.
  const storedReads = useMemo(() => readAnnouncementIds(userId), [userId]);
  const isRead = useCallback(
    (id) => storedReads.has(id) || sessionReads.has(id),
    [storedReads, sessionReads],
  );

  const total = announcements.length;
  const isCarousel = total > 2;
  const safeIndex = total ? Math.min(index, total - 1) : 0;

  const go = useCallback((next) => {
    if (!total) return;
    setDirection(next > safeIndex || (safeIndex === total - 1 && next === 0) ? 1 : -1);
    setIndex(((next % total) + total) % total);
  }, [safeIndex, total]);

  const autoplayOn = isCarousel && !reducedMotion && !paused && !manuallyPaused && !openItem;

  useEffect(() => {
    if (!autoplayOn) return undefined;
    const timer = window.setInterval(() => {
      setDirection(1);
      setIndex((current) => (current + 1) % total);
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(timer);
  }, [autoplayOn, total]);

  const markRead = useCallback((announcement) => {
    setSessionReads((current) => new Set(current).add(announcement.id));
    // A failed mirror to the server never changes what the employee sees.
    markAnnouncementRead(announcement.id, userId);
  }, [userId]);

  const openFull = useCallback((announcement) => {
    setOpenItem(announcement);
    markRead(announcement);
  }, [markRead]);

  const onPointerDown = (event) => { pointerStart.current = event.clientX; };
  const onPointerUp = (event) => {
    if (pointerStart.current == null) return;
    const delta = event.clientX - pointerStart.current;
    pointerStart.current = null;
    if (Math.abs(delta) < SWIPE_THRESHOLD) return;
    const forward = isRtl ? delta > 0 : delta < 0;
    go(forward ? safeIndex + 1 : safeIndex - 1);
  };

  const slideVariants = useMemo(() => {
    const offset = isRtl ? -64 : 64;
    return {
      enter: (dir) => ({ opacity: 0, x: dir > 0 ? offset : -offset }),
      center: { opacity: 1, x: 0 },
      exit: (dir) => ({ opacity: 0, x: dir > 0 ? -offset : offset }),
    };
  }, [isRtl]);

  if (!hasModule('ANNOUNCEMENTS')) return null;

  const Header = (
    <header className="announcements-board-head">
      <span className="announcements-board-icon"><Megaphone aria-hidden="true" /></span>
      <div>
        <h2>{t('ann_board_title')}</h2>
        <p>{t('ann_board_intro')}</p>
      </div>
      {isCarousel && (
        <div className="announcements-controls">
          <button
            type="button"
            className="icon-button"
            onClick={() => setManuallyPaused((current) => !current)}
            aria-label={manuallyPaused || reducedMotion ? t('ann_play') : t('ann_pause')}
          >
            {manuallyPaused || reducedMotion ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          </button>
          <button type="button" className="icon-button" onClick={() => go(safeIndex - 1)} aria-label={t('ann_prev')}>
            {isRtl ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}
          </button>
          <button type="button" className="icon-button" onClick={() => go(safeIndex + 1)} aria-label={t('ann_next')}>
            {isRtl ? <ChevronLeft aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </button>
        </div>
      )}
    </header>
  );

  if (loading) {
    return (
      <section className="announcements-board" aria-busy="true">
        {Header}
        <p className="field-note">{t('label_loading')}</p>
      </section>
    );
  }

  if (!total) {
    return (
      <section className="announcements-board">
        {Header}
        <div className="engagement-panel">
          <div className="engagement-empty">
            <Megaphone aria-hidden="true" />
            <b>{t('ann_empty_title')}</b>
            <p>{t('ann_empty_hint')}</p>
          </div>
        </div>
        <StatusLine message={error} tone="error" />
      </section>
    );
  }

  return (
    <section className="announcements-board">
      {Header}

      {!isCarousel ? (
        <div className={`announcement-grid count-${total}`}>
          {announcements.map((announcement) => (
            <AnnouncementCard
              key={announcement.id}
              announcement={announcement}
              isRead={isRead(announcement.id)}
              onOpen={openFull}
              onMarkRead={markRead}
            />
          ))}
        </div>
      ) : (
        <div
          className="announcement-carousel"
          role="group"
          aria-roledescription="carousel"
          aria-label={t('ann_carousel')}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocusCapture={() => setPaused(true)}
          onBlurCapture={() => setPaused(false)}
        >
          <div
            className="announcement-viewport"
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { pointerStart.current = null; }}
          >
            <AnimatePresence initial={false} custom={direction} mode="wait">
              <motion.div
                key={announcements[safeIndex].id}
                className="announcement-slide"
                custom={direction}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={reducedMotion ? { duration: 0 } : { duration: 0.32, ease: 'easeOut' }}
                aria-roledescription="slide"
                aria-label={t('ann_goto', { index: safeIndex + 1, total })}
              >
                <AnnouncementCard
                  announcement={announcements[safeIndex]}
                  isRead={isRead(announcements[safeIndex].id)}
                  onOpen={openFull}
                  onMarkRead={markRead}
                />
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="announcement-dots">
            {announcements.map((announcement, position) => (
              <button
                key={announcement.id}
                type="button"
                className={`announcement-dot${position === safeIndex ? ' active' : ''}`}
                onClick={() => go(position)}
                aria-label={t('ann_goto', { index: position + 1, total })}
                aria-current={position === safeIndex}
              />
            ))}
          </div>
        </div>
      )}

      <StatusLine message={error} tone="error" />

      {openItem && <AnnouncementDialog announcement={openItem} onClose={() => setOpenItem(null)} />}
    </section>
  );
};

export default AnnouncementsWidget;
