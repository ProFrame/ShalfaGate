/* eslint-disable react-refresh/only-export-components */
// Shared building blocks for the engagement bundle (announcements, surveys,
// calendar, notes). They live next to the announcements module because that is
// the first of the four folders this bundle owns; every screen in the bundle
// imports them from here rather than repeating the same markup four times.

import { Component, Suspense, lazy } from 'react';
import { CircleAlert, Info, TriangleAlert, Users } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import './engagement-ui.css';

// The audience engine is a separate module and may not be installed yet, so it
// is resolved through a glob: an unmatched glob yields an empty map instead of
// an unresolved-import build failure, and the screens keep working without it.
const audienceModules = import.meta.glob('../audience/AudiencePicker.jsx');
const audienceLoader = audienceModules['../audience/AudiencePicker.jsx'];
const AudiencePicker = audienceLoader ? lazy(audienceLoader) : null;

/** Keeps a failure inside the shared picker from taking down the whole editor. */
class PickerBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

/**
 * "Who sees this record" — Department / Project / Sector / Site and the rest,
 * handled entirely by the shared audience engine.
 */
export const AudienceField = ({ entityType, entityId, value, onChange }) => {
  const { t } = useLanguage();
  const unavailable = <p className="field-note">{t('eng_audience_unavailable')}</p>;

  return (
    <section className="engagement-audience">
      <div className="engagement-audience-head">
        <Users size={16} aria-hidden="true" />
        <b>{t('eng_audience')}</b>
      </div>
      {AudiencePicker ? (
        <PickerBoundary fallback={unavailable}>
          <Suspense fallback={<p className="field-note">{t('label_loading')}</p>}>
            <AudiencePicker entityType={entityType} entityId={entityId} value={value} onChange={onChange} />
          </Suspense>
        </PickerBoundary>
      ) : unavailable}
      <p className="field-note">{t('eng_audience_hint')}</p>
    </section>
  );
};

/** A destructive action always asks first, in the user's language. */
export const ConfirmDialog = ({ title, message, confirmLabel, onConfirm, onCancel, busy = false }) => {
  const { t } = useLanguage();
  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal-card confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <h3>{title}</h3>
        </div>
        <div className="confirm-body">
          <TriangleAlert aria-hidden="true" />
          <p>{message}</p>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>{t('action_cancel')}</button>
          <button type="button" className="primary-button" onClick={onConfirm} disabled={busy}>
            {confirmLabel || t('action_confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};

/** One polite live region per screen, so async results are announced. */
export const StatusLine = ({ message, tone = 'info' }) => (
  <p className={`engagement-status${tone === 'error' ? ' is-error' : ''}`} role="status" aria-live="polite">
    {message ? <CircleAlert size={16} aria-hidden="true" /> : null}
    {message}
  </p>
);

/** Shown in place of an administration screen whose module is switched off. */
export const ModuleOffNotice = () => {
  const { t } = useLanguage();
  return (
    <div className="engagement-off">
      <Info size={18} aria-hidden="true" />
      <span>{t('error_module_disabled')}</span>
    </div>
  );
};

/**
 * Live / Scheduled / Ended, derived from a publishing window. The value stored
 * in the database is only the two dates; the label is resolved here.
 */
export const publishingState = (row, fromField = 'publish_from', toField = 'publish_to') => {
  if (!row?.is_published) return 'hidden';
  const today = new Date().toISOString().slice(0, 10);
  const from = row[fromField] ? String(row[fromField]).slice(0, 10) : null;
  const to = row[toField] ? String(row[toField]).slice(0, 10) : null;
  if (from && from > today) return 'scheduled';
  if (to && to < today) return 'ended';
  return 'live';
};

export const WindowBadge = ({ state }) => {
  const { t } = useLanguage();
  const labels = {
    live: t('eng_window_live'),
    scheduled: t('eng_window_scheduled'),
    ended: t('eng_window_ended'),
    hidden: t('eng_window_hidden'),
  };
  return <span className={`engagement-window-badge ${state}`}>{labels[state] || labels.hidden}</span>;
};
