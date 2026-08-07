// Favorites — a user's own starred screens, plus a picker to add more.
//
// Route /app/favorites, any signed-in tenant member, no module gate (this
// screen's own app_screens row carries module_code = null — see the
// migration's own header) and no permission beyond a valid session:
// favoriting a screen is personal state every authenticated user manages for
// themselves, the same boundary src/data/navigationAidsService.js's own RPCs
// draw server-side.
//
// The "add a favorite" picker never builds a second screen-listing
// mechanism: it reuses AppShell.jsx's own exported useNavigationGroups(roleCode)
// — the exact same grouped, module/role-filtered, already-localized screens
// this person's own header/drawer nav renders — filtered down to whatever is
// not already favorited. ScreenIcon (also exported from AppShell.jsx) is
// reused for both panels so a screen's icon is drawn identically everywhere
// in the shell.
//
// Data access only ever goes through src/data/navigationAidsService.js.
// Screen shell reuses verification.css's .vf-screen/.vf-panel, the same
// generic non-admin furniture every other portal screen borrows; this
// module's own favorites.css (fav- prefix) carries only what is unique to
// these two screens.

import { useEffect, useMemo, useState } from 'react';
import { Check, Search, Star, X } from 'lucide-react';
import { Link } from 'wouter';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { ScreenIcon, useNavigationGroups } from '../AppShell';
import {
  addFavoriteScreen, loadFavoriteScreens, navigationAidsErrorMessage, removeFavoriteScreen, screenSnapshotFromNav,
} from '../../data/navigationAidsService';
import { screenPath } from '../../data/notificationCenterService';
import { codeLabel, pickLocalized } from '../../utils/localize';
import './favorites.css';

const FavoritesScreen = () => {
  const { t, lang } = useLanguage();
  const { profile } = useAuth();
  const roleCode = profile?.role_code || 'EMPLOYEE';
  const groups = useNavigationGroups(roleCode);

  const [favorites, setFavorites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [busyCode, setBusyCode] = useState('');
  const [pickerQuery, setPickerQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadFavoriteScreens().then(({ data, error }) => {
      if (cancelled) return;
      if (error) setNotice({ tone: 'error', text: navigationAidsErrorMessage(t, error) });
      else setFavorites(data || []);
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const favoriteCodes = useMemo(() => new Set(favorites.map((row) => row.code)), [favorites]);

  // Every screen this person's own nav already contains, grouped the same
  // way the nav groups them, minus whatever is already favorited — computed
  // before the search box's own filter (below) so the empty state can tell
  // "nothing left to favorite" apart from "no match for this search", same
  // `list.length ? label_no_results : <module>_empty` idiom
  // OperationsPortal.jsx's own visibleOperations/operations pair uses.
  const candidateGroups = useMemo(() => groups
    .map((group) => ({ ...group, screens: group.screens.filter((screen) => !favoriteCodes.has(screen.code)) }))
    .filter((group) => group.screens.length > 0), [groups, favoriteCodes]);

  const pickerGroups = useMemo(() => {
    const needle = pickerQuery.trim().toLocaleLowerCase();
    if (!needle) return candidateGroups;
    return candidateGroups
      .map((group) => ({ ...group, screens: group.screens.filter((screen) => screen.label.toLocaleLowerCase().includes(needle)) }))
      .filter((group) => group.screens.length > 0);
  }, [candidateGroups, pickerQuery]);

  const handleAdd = async (screen) => {
    setBusyCode(screen.code);
    const { error } = await addFavoriteScreen(screen.code, screenSnapshotFromNav(screen));
    if (error) {
      setBusyCode('');
      setNotice({ tone: 'error', text: navigationAidsErrorMessage(t, error) });
      return;
    }
    const { data, error: listError } = await loadFavoriteScreens();
    setBusyCode('');
    if (listError) { setNotice({ tone: 'error', text: navigationAidsErrorMessage(t, listError) }); return; }
    setFavorites(data || []);
    setNotice({ tone: 'success', text: t('navaids_fav_added', { name: screen.label }) });
  };

  const handleRemove = async (screen) => {
    setBusyCode(screen.code);
    const { error } = await removeFavoriteScreen(screen.code);
    setBusyCode('');
    if (error) { setNotice({ tone: 'error', text: navigationAidsErrorMessage(t, error) }); return; }
    setFavorites((current) => current.filter((row) => row.code !== screen.code));
    setNotice({ tone: 'success', text: t('navaids_fav_removed', { name: screen.label }) });
  };

  return (
    <main className="favorites-portal-page app-main">
      <div className="vf-screen">
        <div className="vf-screen-head">
          <div>
            <span className="section-kicker">{t('navaids_fav_module_kicker')}</span>
            <h1><Star className="fav-page-icon" aria-hidden="true" /> {t('navaids_fav_portal_title')}</h1>
            <p>{t('navaids_fav_intro')}</p>
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
          <div className="vf-panel-head"><h2><Star aria-hidden="true" /> {t('navaids_fav_list_title')}</h2></div>
          {loading ? (
            <div className="page-loader inline-loader">
              <span aria-hidden="true" />
              <span className="sr-only" role="status" aria-live="polite">{t('label_loading')}</span>
            </div>
          ) : !favorites.length ? (
            <div className="empty-table compact"><Star aria-hidden="true" /><b>{t('navaids_fav_empty')}</b></div>
          ) : (
            <ul className="fav-list">
              {favorites.map((screen) => {
                const name = pickLocalized(screen, 'name', lang, screen.code);
                return (
                  <li key={screen.code} className="fav-row">
                    <Link href={screenPath(screen.route)} className="fav-row-link">
                      <ScreenIcon name={screen.icon} />
                      <span>
                        <b>{name}</b>
                        <small>{codeLabel(t, 'shell_area', screen.group_code, screen.group_code)}</small>
                      </span>
                    </Link>
                    <button
                      type="button"
                      className="icon-button fav-remove-button"
                      disabled={busyCode === screen.code}
                      aria-label={t('navaids_fav_remove', { name })}
                      onClick={() => handleRemove({ code: screen.code, label: name })}
                    >
                      <Star aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="vf-panel">
          <div className="vf-panel-head">
            <h2>{t('navaids_fav_add_title')}</h2>
            <div className="search-control compact">
              <Search aria-hidden="true" />
              <input
                value={pickerQuery}
                onChange={(event) => setPickerQuery(event.target.value)}
                placeholder={t('navaids_fav_add_search_placeholder')}
                aria-label={t('action_search')}
              />
              {pickerQuery && (
                <button type="button" className="search-clear" onClick={() => setPickerQuery('')} aria-label={t('action_clear')}>
                  <X size={15} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          {!pickerGroups.length ? (
            <div className="empty-table compact">
              <Star aria-hidden="true" />
              <b>{candidateGroups.length ? t('label_no_results') : t('navaids_fav_add_empty')}</b>
            </div>
          ) : (
            <div className="fav-picker">
              {pickerGroups.map((group) => (
                <div className="fav-picker-group" key={group.area}>
                  <h3>{group.label}</h3>
                  <ul className="fav-picker-list">
                    {group.screens.map((screen) => (
                      <li key={screen.code} className="fav-picker-row">
                        <ScreenIcon name={screen.icon} />
                        <span>{screen.label}</span>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busyCode === screen.code}
                          aria-label={t('navaids_fav_add_button', { name: screen.label })}
                          onClick={() => handleAdd(screen)}
                        >
                          <Star aria-hidden="true" /> {t('add')}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
};

export default FavoritesScreen;
