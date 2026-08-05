// The full calendar: the same month grid at full size, an agenda alternative,
// a side panel with the selected day and what is coming up, and the event
// dialog for the employee's own reminders, meetings and tasks.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, LayoutGrid, List, Plus } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { formatDate } from '../../utils/localize';
import {
  deletePersonalEvent,
  engagementErrorMessage,
  loadCalendarMonth,
  savePersonalEvent,
} from '../../data/engagementService';
import { StatusLine } from '../announcements/engagementUi';
import EventDialog from './EventDialog';
import { EventRow, MonthGrid, MonthHeader } from './CalendarWidget';
import {
  EVENT_TYPES,
  eventTypeColor,
  eventTypeLabelKey,
  eventsOnDay,
  sortEvents,
  todayKey,
} from './eventTypes';
import './calendar.css';

const CalendarPage = () => {
  const { t, locale } = useLanguage();

  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [view, setView] = useState('month');
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(() => todayKey());
  const [dialog, setDialog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  // A token drives reloading, so nothing sets state synchronously in an effect.
  const [reloadToken, setReloadToken] = useState(0);
  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    loadCalendarMonth(cursor.year, cursor.month).then(({ data, error }) => {
      if (cancelled) return;
      setEvents(Array.isArray(data) ? data : []);
      setMessage(error ? engagementErrorMessage(t, error) : '');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [cursor, reloadToken, t]);

  const shift = (delta) => {
    setLoading(true);
    setCursor((current) => {
      const date = new Date(current.year, current.month + delta, 1);
      return { year: date.getFullYear(), month: date.getMonth() };
    });
  };

  const goToday = () => {
    const now = new Date();
    setLoading(true);
    setCursor({ year: now.getFullYear(), month: now.getMonth() });
    setSelected(todayKey());
  };

  const agenda = useMemo(() => {
    const grouped = new Map();
    sortEvents(events).forEach((event) => {
      const list = grouped.get(event.event_date) || [];
      list.push(event);
      grouped.set(event.event_date, list);
    });
    return [...grouped.entries()];
  }, [events]);

  const dayEvents = useMemo(() => sortEvents(eventsOnDay(events, selected)), [events, selected]);

  const upcoming = useMemo(() => {
    const today = todayKey();
    return sortEvents(events.filter((event) => (event.end_date || event.event_date) >= today)).slice(0, 5);
  }, [events]);

  const submit = async (draft) => {
    const result = await savePersonalEvent(draft);
    if (!result.error) refresh();
    return result;
  };

  const remove = async (draft) => {
    const result = await deletePersonalEvent(draft.id);
    if (!result.error) refresh();
    return result;
  };

  return (
    <main className="app-main calendar-page">
      <div className="admin-toolbar">
        <div>
          <span className="section-kicker">{t('module_calendar')}</span>
          <h1>{t('module_calendar')}</h1>
          <p>{t('cal_intro')}</p>
        </div>
        <div className="toolbar-actions">
          <div className="segmented" role="group" aria-label={t('label_type')}>
            <button
              type="button"
              className={view === 'month' ? 'active' : ''}
              onClick={() => setView('month')}
              aria-pressed={view === 'month'}
            >
              <LayoutGrid size={14} aria-hidden="true" /> {t('cal_month_view')}
            </button>
            <button
              type="button"
              className={view === 'agenda' ? 'active' : ''}
              onClick={() => setView('agenda')}
              aria-pressed={view === 'agenda'}
            >
              <List size={14} aria-hidden="true" /> {t('cal_agenda_view')}
            </button>
          </div>
          <button
            type="button"
            className="primary-button"
            onClick={() => setDialog({ event: null, date: selected })}
          >
            <Plus size={17} aria-hidden="true" />
            {t('cal_add_event')}
          </button>
        </div>
      </div>

      <StatusLine message={message} tone="error" />

      <div className="calendar-page-layout">
        <section className="calendar-box calendar-large" aria-label={t('module_calendar')}>
          <MonthHeader year={cursor.year} month={cursor.month} onShift={shift} onToday={goToday} large />

          {loading && <p className="field-note">{t('label_loading')}</p>}

          {view === 'month' ? (
            <MonthGrid
              year={cursor.year}
              month={cursor.month}
              events={events}
              selected={selected}
              onSelect={setSelected}
              large
            />
          ) : (
            <div className="calendar-agenda">
              {!agenda.length && !loading && (
                <div className="engagement-empty">
                  <CalendarDays aria-hidden="true" />
                  <b>{t('cal_no_events')}</b>
                </div>
              )}
              {agenda.map(([day, items]) => (
                <article key={day} className="calendar-agenda-day">
                  <h3>{formatDate(day, locale, { dateStyle: 'full' })}</h3>
                  <ul className="calendar-event-list">
                    {items.map((event) => (
                      <EventRow
                        key={event.id}
                        event={event}
                        locked={event.scope === 'Company'}
                        onEdit={(target) => setDialog({ event: target })}
                      />
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          )}

          <div className="calendar-legend" aria-label={t('cal_legend')}>
            {EVENT_TYPES.map((type) => (
              <span key={type}>
                <i style={{ background: eventTypeColor(type) }} aria-hidden="true" />
                {t(eventTypeLabelKey(type))}
              </span>
            ))}
          </div>
        </section>

        <aside className="calendar-side">
          <section className="engagement-panel">
            <header className="engagement-panel-head">
              <span className="engagement-panel-icon"><CalendarDays aria-hidden="true" /></span>
              <div>
                <h2>{t('cal_day_title', { date: formatDate(selected, locale) })}</h2>
                <p>{t('cal_events_count', { count: dayEvents.length })}</p>
              </div>
            </header>
            <div className="calendar-day-panel">
              {dayEvents.length ? (
                <ul className="calendar-event-list">
                  {dayEvents.map((event) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      locked={event.scope === 'Company'}
                      onEdit={(target) => setDialog({ event: target })}
                    />
                  ))}
                </ul>
              ) : (
                <p className="field-note">{t('cal_no_events_day')}</p>
              )}
              <button
                type="button"
                className="secondary-button"
                onClick={() => setDialog({ event: null, date: selected })}
              >
                <Plus size={16} aria-hidden="true" />
                {t('cal_add_event')}
              </button>
            </div>
          </section>

          <section className="engagement-panel">
            <header className="engagement-panel-head">
              <div>
                <h2>{t('cal_upcoming')}</h2>
              </div>
            </header>
            <div className="calendar-day-panel">
              {upcoming.length ? (
                <ul className="calendar-event-list">
                  {upcoming.map((event) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      locked={event.scope === 'Company'}
                      onEdit={(target) => setDialog({ event: target })}
                    />
                  ))}
                </ul>
              ) : (
                <p className="field-note">{t('cal_no_events')}</p>
              )}
            </div>
          </section>
        </aside>
      </div>

      {dialog && (
        <EventDialog
          event={dialog.event}
          defaultDate={dialog.date}
          mode="employee"
          onClose={() => setDialog(null)}
          onSubmit={submit}
          onDelete={remove}
        />
      )}
    </main>
  );
};

export default CalendarPage;
