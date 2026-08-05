import { useCallback, useEffect, useRef, useState } from 'react';
import { Info, Lock } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { codeLabel } from '../../utils/localize';
import {
  EDITABLE_CATEGORIES,
  LOCKED_CATEGORIES,
  loadNotificationPreferences,
  notificationErrorKey,
  saveNotificationPreferences,
} from '../../data/notificationCenterService';
import './notifications.css';

const Switch = ({ checked, disabled, label, onChange }) => (
  <button
    type="button"
    role="switch"
    className="notif-switch"
    aria-checked={Boolean(checked)}
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
  >
    <span aria-hidden="true" />
  </button>
);

/**
 * One switch per notification category, in the portal and by email.
 * The three operational categories are shown so the person knows they exist,
 * but they cannot be silenced — the database refuses to store them.
 */
const NotificationSettings = () => {
  const { t } = useLanguage();
  const [preferences, setPreferences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusKey, setStatusKey] = useState('');
  const [statusTone, setStatusTone] = useState('');
  const mounted = useRef(true);

  // Re-armed on mount so a development remount does not leave the screen mute.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadNotificationPreferences().then(({ data, error }) => {
      if (cancelled || !mounted.current) return;
      setPreferences(data || []);
      if (error) {
        setStatusKey(notificationErrorKey(error));
        setStatusTone('error');
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const categoryLabel = useCallback(
    (category) => codeLabel(t, 'notif_category', category, category),
    [t],
  );

  const update = async (category, field, value) => {
    const next = preferences.map((row) => (row.category === category ? { ...row, [field]: value } : row));
    const previous = preferences;
    setPreferences(next);

    const { error } = await saveNotificationPreferences(next);
    if (!mounted.current) return;
    if (error) {
      setPreferences(previous);
      setStatusKey(notificationErrorKey(error, 'notif_settings_save_failed'));
      setStatusTone('error');
      return;
    }
    setStatusKey('notif_settings_saved');
    setStatusTone('');
  };

  return (
    <section className="notification-settings" aria-busy={loading}>
      <header>
        <h2>{t('notif_settings_title')}</h2>
        <p>{t('notif_settings_intro')}</p>
      </header>

      <div className="notification-settings-scroll">
        <table className="notification-settings-table">
          <thead>
            <tr>
              <th scope="col">{t('notif_settings_column_category')}</th>
              <th scope="col">{t('notif_settings_column_in_app')}</th>
              <th scope="col">{t('notif_settings_column_email')}</th>
            </tr>
          </thead>
          <tbody>
            {EDITABLE_CATEGORIES.map((category) => {
              const row = preferences.find((item) => item.category === category)
                || { category, in_app: true, email: false };
              return (
                <tr key={category}>
                  <th scope="row">{categoryLabel(category)}</th>
                  <td>
                    <Switch
                      checked={row.in_app}
                      disabled={loading}
                      label={t('notif_settings_toggle_in_app', { category: categoryLabel(category) })}
                      onChange={(value) => update(category, 'in_app', value)}
                    />
                  </td>
                  <td>
                    <Switch
                      checked={row.email}
                      disabled={loading}
                      label={t('notif_settings_toggle_email', { category: categoryLabel(category) })}
                      onChange={(value) => update(category, 'email', value)}
                    />
                  </td>
                </tr>
              );
            })}
            {LOCKED_CATEGORIES.map((category) => (
              <tr key={category} className="is-locked">
                <th scope="row">{categoryLabel(category)}</th>
                <td colSpan={2}>
                  <span className="notification-settings-lock">
                    <Lock aria-hidden="true" /> {t('notif_settings_always_on')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="notification-settings-note">
        <Info aria-hidden="true" />
        <span>{t('notif_settings_always_on_hint')}</span>
      </p>

      <p className={`field-note ${statusTone === 'error' ? 'shell-inline-error' : ''}`.trim()} aria-live="polite">
        {loading ? t('label_loading') : statusKey ? t(statusKey) : ''}
      </p>
    </section>
  );
};

export default NotificationSettings;
