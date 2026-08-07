// Recent Items — a read-only, most-recent-first list of the screens the
// signed-in person has actually opened, each a link back to it.
//
// Route /app/recent, any signed-in tenant member, no module gate (this
// screen's own app_screens row carries module_code = null) and no permission
// beyond a valid session — recent_screens_list() only ever returns the
// caller's own history (user_id = auth.uid()), the same boundary
// FavoritesScreen.jsx documents for its own RPCs. Rows are recorded by
// AppShell.jsx's own per-navigation effect (touchRecentScreen), not by this
// screen — this screen only ever reads.
//
// recent_screens_list()'s jsonb payload includes visited_on (see
// src/data/navigationAidsService.js's own header), so the relative-time text
// ("2 hours ago") this screen shows next to each row renders against live
// data too. If visited_on is ever missing, formatRelative() returns '' and
// the meta line below already drops empty segments, so this degrades to just
// the group name rather than a broken date.
//
// Data access only ever goes through src/data/navigationAidsService.js.
// Reuses AppShell.jsx's own exported ScreenIcon so a screen's icon matches
// what the nav itself shows. Screen shell reuses verification.css's
// .vf-screen/.vf-panel; row layout reuses favorites.css's own .fav-list/
// .fav-row (FavoritesScreen.jsx's own favorited list uses the identical
// shape), so this file adds no CSS of its own.

import { useEffect, useState } from 'react';
import { Check, History, X } from 'lucide-react';
import { Link } from 'wouter';
import { useLanguage } from '../../context/LanguageContext';
import { ScreenIcon } from '../AppShell';
import { loadRecentScreens, navigationAidsErrorMessage } from '../../data/navigationAidsService';
import { screenPath } from '../../data/notificationCenterService';
import { codeLabel, formatRelative, pickLocalized } from '../../utils/localize';
import './favorites.css';

const RECENT_ITEMS_LIMIT = 20;

const RecentItemsScreen = () => {
  const { t, lang, locale } = useLanguage();
  const [recents, setRecents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadRecentScreens(RECENT_ITEMS_LIMIT).then(({ data, error }) => {
      if (cancelled) return;
      if (error) setNotice({ tone: 'error', text: navigationAidsErrorMessage(t, error) });
      else setRecents(data || []);
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="recent-items-portal-page app-main">
      <div className="vf-screen">
        <div className="vf-screen-head">
          <div>
            <span className="section-kicker">{t('navaids_recent_module_kicker')}</span>
            <h1><History className="fav-page-icon" aria-hidden="true" /> {t('navaids_recent_portal_title')}</h1>
            <p>{t('navaids_recent_intro')}</p>
          </div>
        </div>

        {notice && (
          <div className={`inline-message ${notice.tone === 'error' ? 'error' : ''}`} role="status" aria-live="polite">
            {notice.tone === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
            {notice.text}
            <button type="button" onClick={() => setNotice(null)} aria-label={t('action_close')}><X aria-hidden="true" /></button>
          </div>
        )}

        <section className="vf-panel">
          <div className="vf-panel-head"><h2><History aria-hidden="true" /> {t('navaids_recent_list_title')}</h2></div>
          {loading ? (
            <div className="page-loader inline-loader">
              <span aria-hidden="true" />
              <span className="sr-only" role="status" aria-live="polite">{t('label_loading')}</span>
            </div>
          ) : !recents.length ? (
            <div className="empty-table"><History aria-hidden="true" /><b>{t('navaids_recent_empty')}</b></div>
          ) : (
            <ul className="fav-list">
              {recents.map((screen) => {
                const meta = [
                  codeLabel(t, 'shell_area', screen.group_code, screen.group_code),
                  formatRelative(screen.visited_on, locale),
                ].filter(Boolean).join(' · ');
                return (
                  <li key={screen.code} className="fav-row">
                    <Link href={screenPath(screen.route)} className="fav-row-link">
                      <ScreenIcon name={screen.icon} />
                      <span>
                        <b>{pickLocalized(screen, 'name', lang, screen.code)}</b>
                        {meta && <small>{meta}</small>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
};

export default RecentItemsScreen;
