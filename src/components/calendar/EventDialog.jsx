// Create or edit one calendar event.
//
// Two audiences use this dialog. An employee works on their own calendar and
// may only pick a reminder, a meeting or a task; a company event opened by an
// employee is rendered read-only with a line explaining why. An administrator
// works on the company calendar and gets every type, the mandatory flag and the
// audience picker.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Lock, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { formatDate, pickLocalized } from '../../utils/localize';
import { engagementErrorMessage } from '../../data/engagementService';
import { AudienceField, StatusLine } from '../announcements/engagementUi';
import {
  COMPANY_EVENT_TYPES,
  EMPLOYEE_EVENT_TYPES,
  REMINDER_CHOICES,
  eventTypeColor,
  eventTypeLabelKey,
  todayKey,
} from './eventTypes';
import './calendar.css';

const emptyEvent = (date, mode) => ({
  id: null,
  title_1: '',
  title_2: '',
  description_1: '',
  description_2: '',
  event_type: mode === 'company' ? 'CompanyEvent' : 'Reminder',
  event_date: date || todayKey(),
  end_date: '',
  all_day: true,
  start_time: '',
  end_time: '',
  is_mandatory: mode === 'company',
  remind_before_minutes: '',
  audience: null,
});

const ReadOnlyEvent = ({ event, onClose }) => {
  const { t, lang, locale } = useLanguage();
  return (
    <>
      <div className="calendar-readonly-note">
        <Lock size={17} aria-hidden="true" />
        <span>{t('cal_company_readonly')}</span>
      </div>

      <div className="calendar-readonly-grid">
        <div>
          <span>{t('label_type')}</span>
          <b>{t(eventTypeLabelKey(event.event_type))}</b>
        </div>
        <div>
          <span>{t('cal_date')}</span>
          <b>{formatDate(event.event_date, locale)}</b>
        </div>
        {event.end_date && (
          <div>
            <span>{t('cal_end_date')}</span>
            <b>{formatDate(event.end_date, locale)}</b>
          </div>
        )}
        {!event.all_day && (
          <div>
            <span>{t('cal_start_time')}</span>
            <b>{[event.start_time, event.end_time].filter(Boolean).join(' – ') || '—'}</b>
          </div>
        )}
        <div>
          <span>{t('label_status')}</span>
          <b>{event.is_mandatory ? t('cal_mandatory') : t('cal_company_event')}</b>
        </div>
      </div>

      {pickLocalized(event, 'description', lang, '') && (
        <p className="announcement-dialog-body">{pickLocalized(event, 'description', lang, '')}</p>
      )}

      <div className="modal-actions">
        <button type="button" className="primary-button" onClick={onClose}>{t('action_close')}</button>
      </div>
    </>
  );
};

const EventDialog = ({
  event,
  defaultDate,
  mode = 'employee',
  onClose,
  onSubmit,
  onDelete,
}) => {
  const { t } = useLanguage();
  const [draft, setDraft] = useState(() => ({ ...emptyEvent(defaultDate, mode), ...(event || {}) }));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const closeRef = useRef(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (keyEvent) => { if (keyEvent.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const types = useMemo(
    () => (mode === 'company' ? COMPANY_EVENT_TYPES : EMPLOYEE_EVENT_TYPES),
    [mode],
  );

  // A company event never becomes editable inside the employee calendar.
  const readOnly = mode === 'employee' && event?.scope === 'Company';
  const title = readOnly
    ? t('cal_event_details')
    : (draft.id ? t('cal_edit_event') : t('cal_new_event'));

  const save = async () => {
    setBusy(true);
    const { error } = await onSubmit(draft);
    setBusy(false);
    if (error) { setMessage(engagementErrorMessage(t, error)); return; }
    onClose();
  };

  const remove = async () => {
    setBusy(true);
    const { error } = await onDelete(draft);
    setBusy(false);
    if (error) { setMessage(engagementErrorMessage(t, error)); return; }
    onClose();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card calendar-event-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{t('module_calendar')}</span>
            <h3>{title}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}>
            <X aria-hidden="true" />
          </button>
        </div>

        {readOnly ? (
          <ReadOnlyEvent event={draft} onClose={onClose} />
        ) : (
          <>
            <div className="calendar-event-fields">
              <label className="field-label" htmlFor="cal-title-1">
                {t('cal_title_1')}
                <input
                  id="cal-title-1"
                  className="form-input"
                  value={draft.title_1}
                  onChange={(inputEvent) => setDraft({ ...draft, title_1: inputEvent.target.value })}
                  placeholder={t('cal_title_1')}
                  required
                />
              </label>

              <label className="field-label" htmlFor="cal-title-2">
                {t('cal_title_2')}
                <input
                  id="cal-title-2"
                  className="form-input"
                  value={draft.title_2 || ''}
                  onChange={(inputEvent) => setDraft({ ...draft, title_2: inputEvent.target.value })}
                  placeholder={t('cal_title_2')}
                />
              </label>

              <fieldset className="calendar-fieldset">
                <legend>{t('label_type')}</legend>
                <div className="calendar-type-picker">
                  {types.map((code) => (
                    <button
                      key={code}
                      type="button"
                      className={`calendar-type-option${draft.event_type === code ? ' active' : ''}`}
                      onClick={() => setDraft({ ...draft, event_type: code })}
                      aria-pressed={draft.event_type === code}
                    >
                      <i style={{ background: eventTypeColor(code) }} aria-hidden="true" />
                      {t(eventTypeLabelKey(code))}
                    </button>
                  ))}
                </div>
                {mode === 'employee' && <p className="field-note">{t('cal_employee_types_hint')}</p>}
              </fieldset>

              <div className="form-grid">
                <label className="field-label" htmlFor="cal-date">
                  {t('cal_date')}
                  <input
                    id="cal-date"
                    type="date"
                    className="form-input"
                    value={draft.event_date || ''}
                    onChange={(inputEvent) => setDraft({ ...draft, event_date: inputEvent.target.value })}
                    required
                  />
                </label>
                <label className="field-label" htmlFor="cal-end-date">
                  {t('cal_end_date')}
                  <input
                    id="cal-end-date"
                    type="date"
                    className="form-input"
                    value={draft.end_date || ''}
                    onChange={(inputEvent) => setDraft({ ...draft, end_date: inputEvent.target.value })}
                  />
                </label>
              </div>

              <div className="engagement-toggle-row">
                <label className="engagement-toggle" htmlFor="cal-all-day">
                  <input
                    id="cal-all-day"
                    type="checkbox"
                    checked={Boolean(draft.all_day)}
                    onChange={(inputEvent) => setDraft({ ...draft, all_day: inputEvent.target.checked })}
                  />
                  {t('cal_all_day')}
                </label>
                {mode === 'company' && (
                  <label className="engagement-toggle" htmlFor="cal-mandatory">
                    <input
                      id="cal-mandatory"
                      type="checkbox"
                      checked={Boolean(draft.is_mandatory)}
                      onChange={(inputEvent) => setDraft({ ...draft, is_mandatory: inputEvent.target.checked })}
                    />
                    {t('cal_mandatory')}
                  </label>
                )}
              </div>
              {mode === 'company' && <p className="field-note">{t('cal_mandatory_hint')}</p>}

              {!draft.all_day && (
                <div className="form-grid">
                  <label className="field-label" htmlFor="cal-start-time">
                    {t('cal_start_time')}
                    <input
                      id="cal-start-time"
                      type="time"
                      className="form-input"
                      value={draft.start_time || ''}
                      onChange={(inputEvent) => setDraft({ ...draft, start_time: inputEvent.target.value })}
                    />
                  </label>
                  <label className="field-label" htmlFor="cal-end-time">
                    {t('cal_end_time')}
                    <input
                      id="cal-end-time"
                      type="time"
                      className="form-input"
                      value={draft.end_time || ''}
                      onChange={(inputEvent) => setDraft({ ...draft, end_time: inputEvent.target.value })}
                    />
                  </label>
                </div>
              )}

              <label className="field-label" htmlFor="cal-description-1">
                {t('cal_description_1')}
                <textarea
                  id="cal-description-1"
                  className="form-input"
                  rows={3}
                  value={draft.description_1 || ''}
                  onChange={(inputEvent) => setDraft({ ...draft, description_1: inputEvent.target.value })}
                />
              </label>

              {mode === 'company' && (
                <label className="field-label" htmlFor="cal-description-2">
                  {t('cal_description_2')}
                  <textarea
                    id="cal-description-2"
                    className="form-input"
                    rows={3}
                    value={draft.description_2 || ''}
                    onChange={(inputEvent) => setDraft({ ...draft, description_2: inputEvent.target.value })}
                  />
                </label>
              )}

              <label className="field-label" htmlFor="cal-reminder">
                {t('cal_remind_me')}
                <select
                  id="cal-reminder"
                  className="form-input"
                  value={draft.remind_before_minutes ?? ''}
                  onChange={(inputEvent) => setDraft({ ...draft, remind_before_minutes: inputEvent.target.value })}
                >
                  {REMINDER_CHOICES.map((choice) => (
                    <option key={choice.labelKey} value={choice.value}>{t(choice.labelKey)}</option>
                  ))}
                </select>
              </label>
              <p className="field-note">{t('cal_reminder_hint')}</p>

              {mode === 'company' && (
                <AudienceField
                  entityType="CalendarEvent"
                  entityId={draft.id}
                  value={draft.audience}
                  onChange={(audience) => setDraft({ ...draft, audience })}
                />
              )}
            </div>

            <StatusLine message={message} tone="error" />

            <div className="modal-actions">
              {draft.id && onDelete && (
                <button
                  type="button"
                  className="secondary-button danger calendar-delete-action"
                  onClick={remove}
                  disabled={busy}
                >
                  {t('action_delete')}
                </button>
              )}
              <button type="button" className="secondary-button" onClick={onClose}>{t('action_cancel')}</button>
              <button
                type="button"
                className="primary-button"
                onClick={save}
                disabled={busy || !String(draft.title_1 || '').trim() || !draft.event_date}
              >
                {busy ? t('eng_saving') : t('action_save')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default EventDialog;
