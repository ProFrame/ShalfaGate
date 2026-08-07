/* eslint-disable react-refresh/only-export-components */
// Safety Management — shared "days until a date" helpers and the date +
// aging-badge cell they back. Previously defined independently (byte-
// identical) in both SafetyExpirationsAdmin.jsx and SafetyReportsAdmin.jsx;
// hoisted here so there is a single implementation both screens import.
import { formatDate } from '../../utils/localize';

export const WARNING_WINDOW_DAYS = 30;

/** Whole-day difference between an ISO date string and today, ignoring time of day. */
export const daysUntil = (dateStr) => {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target.getTime() - today.getTime()) / 86400000);
};

export const isOverdue = (dateStr) => {
  const diff = daysUntil(dateStr);
  return diff !== null && diff < 0;
};

/** Date value plus its color-coded days-remaining/overdue badge — red once
 * past due, amber inside the warning window, neutral otherwise. Reuses
 * index.css's own .aging-badge/.warning/.late modifiers rather than inventing
 * new status colours. */
export const DueCell = ({ dateStr, locale, t }) => {
  const diff = daysUntil(dateStr);
  if (diff === null) return <span className="field-note">—</span>;
  const tone = diff < 0 ? 'late' : diff <= WARNING_WINDOW_DAYS ? 'warning' : '';
  const label = diff < 0
    ? t('safety_expirations_overdue_by', { count: Math.abs(diff) })
    : t('safety_expirations_due_in', { count: diff });
  return (
    <div className="safety-due-cell">
      <span>{formatDate(dateStr, locale)}</span>
      <span className={`aging-badge${tone ? ` ${tone}` : ''}`}>{label}</span>
    </div>
  );
};
