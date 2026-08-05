// Administration of the company calendar.
//
// Only company events live here: holidays, occasions, training, maintenance.
// They appear in every matching employee's calendar and employees can never
// change them, which is why the mandatory flag and the audience live on this
// screen and nowhere else.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { formatDate, pickLocalized } from '../../utils/localize';
import {
  deleteCompanyEvent,
  engagementErrorMessage,
  loadCompanyEvents,
  saveCompanyEvent,
} from '../../data/engagementService';
import { ConfirmDialog, ModuleOffNotice, StatusLine } from '../announcements/engagementUi';
import EventDialog from './EventDialog';
import { EVENT_TYPES, eventTypeColor, eventTypeLabelKey } from './eventTypes';
import './calendar.css';

const CalendarAdmin = () => {
  const { t, lang, locale } = useLanguage();
  const { hasModule } = useTenant();

  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState('info');

  // A token drives reloading, so nothing sets state synchronously in an effect.
  const [reloadToken, setReloadToken] = useState(0);
  const refresh = useCallback(() => { setLoading(true); setReloadToken((token) => token + 1); }, []);

  useEffect(() => {
    let cancelled = false;
    loadCompanyEvents().then(({ data, error }) => {
      if (cancelled) return;
      setRows(Array.isArray(data) ? data : []);
      if (error) { setMessage(engagementErrorMessage(t, error)); setTone('error'); }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [reloadToken, t]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (typeFilter && row.event_type !== typeFilter) return false;
      if (!needle) return true;
      return `${row.title_1 || ''} ${row.title_2 || ''}`.toLowerCase().includes(needle);
    });
  }, [rows, search, typeFilter]);

  const submit = async (draft) => {
    const result = await saveCompanyEvent(draft);
    if (!result.error) {
      setMessage(t('cal_saved'));
      setTone('info');
      refresh();
    }
    return result;
  };

  const confirmDelete = async () => {
    setBusy(true);
    const { error } = await deleteCompanyEvent(pendingDelete.id);
    setBusy(false);
    setPendingDelete(null);
    if (error) { setMessage(engagementErrorMessage(t, error)); setTone('error'); return; }
    setMessage(t('cal_deleted'));
    setTone('info');
    refresh();
  };

  if (!hasModule('CALENDAR')) return <ModuleOffNotice />;

  return (
    <section className="calendar-admin">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('module_calendar')}</span>
          <h1>{t('cal_company_event')}</h1>
          <p>{t('cal_admin_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="primary-button" onClick={() => setDialog({ event: null })}>
            <Plus size={17} aria-hidden="true" />
            {t('cal_new_event')}
          </button>
        </div>
      </div>

      <div className="calendar-admin-toolbar">
        <div className="search-control">
          <Search aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('action_search')}
            aria-label={t('action_search')}
          />
          {search && (
            <button type="button" className="search-clear" onClick={() => setSearch('')} aria-label={t('action_clear')}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <label className="sr-only" htmlFor="cal-type-filter">{t('label_type')}</label>
        <select
          id="cal-type-filter"
          className="form-input calendar-type-filter"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
        >
          <option value="">{t('label_all')}</option>
          {EVENT_TYPES.map((code) => (
            <option key={code} value={code}>{t(eventTypeLabelKey(code))}</option>
          ))}
        </select>
        <span className="result-count">{t('cal_events_count', { count: filtered.length })}</span>
      </div>

      <StatusLine message={message} tone={tone} />

      <div className="data-table-wrap">
        <table className="enterprise-table">
          <thead>
            <tr>
              <th scope="col">{t('cal_title_1')}</th>
              <th scope="col">{t('label_type')}</th>
              <th scope="col">{t('cal_date')}</th>
              <th scope="col">{t('cal_all_day')}</th>
              <th scope="col">{t('cal_mandatory')}</th>
              <th scope="col">{t('label_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6}><div className="empty-table compact">{t('label_loading')}</div></td></tr>}
            {!loading && !filtered.length && (
              <tr>
                <td colSpan={6}>
                  <div className="empty-table compact">
                    <CalendarDays aria-hidden="true" />
                    <b>{t('cal_none_yet')}</b>
                  </div>
                </td>
              </tr>
            )}
            {!loading && filtered.map((row) => (
              <tr key={row.id}>
                <td><b>{pickLocalized(row, 'title', lang, t('cal_untitled'))}</b></td>
                <td>
                  <span className="calendar-type-cell">
                    <i style={{ background: eventTypeColor(row.event_type) }} aria-hidden="true" />
                    {t(eventTypeLabelKey(row.event_type))}
                  </span>
                </td>
                <td>
                  {formatDate(row.event_date, locale)}
                  {row.end_date ? ` – ${formatDate(row.end_date, locale)}` : ''}
                </td>
                <td>
                  {row.all_day
                    ? t('action_yes')
                    : [row.start_time, row.end_time].filter(Boolean).join(' – ') || t('action_no')}
                </td>
                <td>{row.is_mandatory ? t('action_yes') : t('action_no')}</td>
                <td>
                  <div className="table-actions">
                    <button
                      type="button"
                      onClick={() => setDialog({ event: row })}
                      aria-label={t('action_edit')}
                      title={t('action_edit')}
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setPendingDelete(row)}
                      aria-label={t('action_delete')}
                      title={t('action_delete')}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dialog && (
        <EventDialog
          event={dialog.event}
          mode="company"
          onClose={() => setDialog(null)}
          onSubmit={submit}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t('action_delete')}
          message={t('cal_delete_confirm')}
          confirmLabel={t('action_delete')}
          busy={busy}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
};

export default CalendarAdmin;
