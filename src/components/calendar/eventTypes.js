// One source of truth for the calendar event types.
//
// The widget, the full page and the administration screen all read the colours
// and the ordering from here, so a red holiday is the same red everywhere. The
// database only ever stores the code; the label is resolved at render time
// through `eventTypeLabelKey`.

export const EVENT_TYPES = [
  'Holiday',
  'Meeting',
  'Reminder',
  'Task',
  'Birthday',
  'CompanyEvent',
  'Training',
  'Maintenance',
];

/** Types an employee may create on their own calendar. */
export const EMPLOYEE_EVENT_TYPES = ['Reminder', 'Meeting', 'Task'];

/** Types the company creates for everyone. */
export const COMPANY_EVENT_TYPES = EVENT_TYPES;

export const EVENT_TYPE_COLORS = {
  Holiday: '#d1494f',
  Meeting: '#1d7a4f',
  Reminder: '#2563a7',
  Task: '#b7791f',
  Birthday: '#c026d3',
  CompanyEvent: '#6b46c1',
  Training: '#0891b2',
  Maintenance: '#64748b',
};

export const eventTypeColor = (code) => EVENT_TYPE_COLORS[code] || EVENT_TYPE_COLORS.Reminder;

export const eventTypeLabelKey = (code) => `event_type_${String(code || 'Reminder').toLowerCase()}`;

export const REMINDER_CHOICES = [
  { value: '', labelKey: 'cal_reminder_none' },
  { value: '0', labelKey: 'cal_reminder_same_day' },
  { value: '1440', labelKey: 'cal_reminder_day_before' },
  { value: '10080', labelKey: 'cal_reminder_week_before' },
];

// ---------------------------------------------------------------------------
// Date helpers. The calendar is a plain Gregorian grid whose week starts on
// Sunday, matching the working week in the region the platform ships to.
// ---------------------------------------------------------------------------

const pad = (value) => String(value).padStart(2, '0');

export const dateKey = (value) => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const todayKey = () => dateKey(new Date());

/** Six rows of seven days covering the month, with the neighbours greyed out. */
export const monthMatrix = (year, month) => {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, offset) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    return {
      key: dateKey(date),
      date,
      day: date.getDate(),
      inMonth: date.getMonth() === month,
    };
  });
};

/** Weekday initials in the reader's own locale, so nothing needs translating. */
export const weekdayInitials = (locale) => {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(2024, 8, 1 + index); // 1 Sep 2024 is a Sunday
    return { key: index, label: formatter.format(date) };
  });
};

export const monthLabel = (year, month, locale) =>
  new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(year, month, 1));

/** True when the event covers the given day, single day or multi-day. */
export const eventCoversDay = (event, key) => {
  const start = event.event_date;
  const end = event.end_date || event.event_date;
  return Boolean(start) && start <= key && end >= key;
};

export const eventsOnDay = (events, key) => events.filter((event) => eventCoversDay(event, key));

export const sortEvents = (events) => [...events].sort((a, b) => {
  if (a.event_date !== b.event_date) return a.event_date.localeCompare(b.event_date);
  if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
  return String(a.start_time || '').localeCompare(String(b.start_time || ''));
});
