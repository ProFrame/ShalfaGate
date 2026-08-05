// The compact calendar box on the home page: one month at a time, today
// highlighted, arrows to travel, a coloured dot for every kind of event on a
// day, and a day list that opens when a day is clicked.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Lock, Pencil, Plus } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { formatDate, pickLocalized } from '../../utils/localize';
import {
  deletePersonalEvent,
  engagementErrorMessage,
  loadCalendarMonth,
  savePersonalEvent,
} from '../../data/engagementService';
import { StatusLine } from '../announcements/engagementUi';
import EventDialog from './EventDialog';
import {
  dateKey,
  eventTypeColor,
  eventTypeLabelKey,
  eventsOnDay,
  monthLabel,
  monthMatrix,
  sortEvents,
  todayKey,
  weekdayInitials,
} from './eventTypes';
import './calendar.css';

export const EventRow = ({ event, onEdit, locked }) => {
  const { t, lang } = useLanguage();
  const time = event.all_day
    ? t('cal_all_day')
    : [event.start_time, event.end_time].filter(Boolean).join(' – ');

  return (
    <li className={`calendar-event${locked ? ' locked' : ''}`}>
      <i style={{ background: eventTypeColor(event.event_type) }} aria-hidden="true" />
      <div>
        <b>{pickLocalized(event, 'title', lang, t('cal_untitled'))}</b>
        <small>
          {t(eventTypeLabelKey(event.event_type))}
          {time ? ` · ${time}` : ''}
          {event.scope === 'Company' ? ` · ${t('cal_company_event')}` : ''}
        </small>
      </div>
      <div className="calendar-event-actions">
        <button
          type="button"
          onClick={() => onEdit(event)}
          aria-label={locked ? t('cal_event_details') : t('action_edit')}
          title={locked ? t('cal_event_details') : t('action_edit')}
        >
          {locked ? <Lock size={14} aria-hidden="true" /> : <Pencil size={14} aria-hidden="true" />}
        </button>
      </div>
    </li>
  );
};

/**
 * The month grid itself, reused by the home widget and the full page.
 * `renderDay` lets the page draw event chips where the widget draws dots.
 */
export const MonthGrid = ({ year, month, events, selected, onSelect, large = false }) => {
  const { t, locale } = useLanguage();
  const cells = useMemo(() => monthMatrix(year, month), [year, month]);
  const weekdays = useMemo(() => weekdayInitials(locale), [locale]);
  const today = todayKey();

  return (
    <>
      <div className="calendar-weekdays" aria-hidden="true">
        {weekdays.map((weekday) => <span key={weekday.key}>{weekday.label}</span>)}
      </div>
      <div className="calendar-grid" role="grid">
        {cells.map((cell) => {
          const dayEvents = sortEvents(eventsOnDay(events, cell.key));
          const types = [...new Set(dayEvents.map((event) => event.event_type))];
          const label = `${formatDate(cell.date, locale, { dateStyle: 'full' })}${
            dayEvents.length ? ` · ${t('cal_events_count', { count: dayEvents.length })}` : ''
          }`;
          return (
            <button
              key={cell.key}
              type="button"
              role="gridcell"
              className={[
                'calendar-day',
                cell.inMonth ? '' : 'outside',
                cell.key === today ? 'today' : '',
                cell.key === selected ? 'selected' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onSelect(cell.key)}
              aria-label={label}
              aria-current={cell.key === today ? 'date' : undefined}
              aria-pressed={cell.key === selected}
            >
              <span>{cell.day}</span>
              {large ? (
                <span className="calendar-day-events">
                  {dayEvents.slice(0, 3).map((event) => (
                    <span key={event.id} className="calendar-chip">
                      <i style={{ background: eventTypeColor(event.event_type) }} aria-hidden="true" />
                      <span>{event.title_1}</span>
                    </span>
                  ))}
                  {dayEvents.length > 3 && (
                    <span className="calendar-more">{t('cal_events_count', { count: dayEvents.length - 3 })}</span>
                  )}
                </span>
              ) : (
                <span className="calendar-dots">
                  {types.slice(0, 4).map((type) => (
                    <i key={type} style={{ background: eventTypeColor(type) }} aria-hidden="true" />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
};

/** Month navigation shared by the widget and the page. */
export const MonthHeader = ({ year, month, onShift, onToday, large = false }) => {
  const { t, locale, isRtl } = useLanguage();
  return (
    <header className="calendar-head">
      <button type="button" className="icon-button" onClick={() => onShift(-1)} aria-label={t('cal_prev_month')}>
        {isRtl ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}
      </button>
      <h2>{monthLabel(year, month, locale)}</h2>
      <button type="button" className="icon-button" onClick={() => onShift(1)} aria-label={t('cal_next_month')}>
        {isRtl ? <ChevronLeft aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
      </button>
      {large && (
        <button type="button" className="secondary-button" onClick={onToday}>{t('cal_go_today')}</button>
      )}
    </header>
  );
};

const CalendarWidget = () => {
  const { t, locale, isRtl } = useLanguage();
  const { hasModule } = useTenant();

  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(() => todayKey());
  const [dialog, setDialog] = useState(null);
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
    });
    return () => { cancelled = true; };
  }, [cursor, reloadToken, t]);

  const shift = (delta) => setCursor((current) => {
    const date = new Date(current.year, current.month + delta, 1);
    return { year: date.getFullYear(), month: date.getMonth() };
  });

  const dayEvents = useMemo(() => sortEvents(eventsOnDay(events, selected)), [events, selected]);
  const legendTypes = useMemo(() => [...new Set(events.map((event) => event.event_type))], [events]);

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

  if (!hasModule('CALENDAR')) return null;

  return (
    <section className="calendar-box" aria-label={t('module_calendar')}>
      <MonthHeader year={cursor.year} month={cursor.month} onShift={shift} />

      <MonthGrid
        year={cursor.year}
        month={cursor.month}
        events={events}
        selected={selected}
        onSelect={(key) => setSelected(key)}
      />

      {legendTypes.length > 0 && (
        <div className="calendar-legend" aria-label={t('cal_legend')}>
          {legendTypes.map((type) => (
            <span key={type}>
              <i style={{ background: eventTypeColor(type) }} aria-hidden="true" />
              {t(eventTypeLabelKey(type))}
            </span>
          ))}
        </div>
      )}

      <div className="calendar-day-panel">
        <h3>{t('cal_day_title', { date: formatDate(selected, locale) })}</h3>
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
      </div>

      <div className="calendar-box-foot">
        <button
          type="button"
          className="secondary-button"
          onClick={() => setDialog({ event: null, date: selected || dateKey(new Date()) })}
        >
          <Plus size={16} aria-hidden="true" />
          {t('cal_add_event')}
        </button>
        <Link href="/app/calendar" className="engagement-link">
          {t('cal_open_full')}
          {isRtl ? <ArrowLeft size={15} aria-hidden="true" /> : <ArrowRight size={15} aria-hidden="true" />}
        </Link>
      </div>

      <StatusLine message={message} tone="error" />

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

    </section>
  );
};

export default CalendarWidget;
