// Assets Management — small presentational pieces shared across this
// module's screens (previously copy-pasted verbatim between AssetsPortal.jsx
// and AssetsCatalogueAdmin.jsx — release-gate finding). Both screens import
// from here now instead of carrying their own copy.

import { History } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { codeLabel, formatDateTime, pickLocalized } from '../../utils/localize';

export const AssetStatusBadge = ({ status }) => {
  const { t } = useLanguage();
  return (
    <span className={`status-badge status-${String(status || '').toLowerCase()}`}>
      {codeLabel(t, 'asset_status', status, status)}
    </span>
  );
};

// Every writer in the migration's record_activity() calls only ever
// populates toUserName/fromUserName/toCustodyUnitName (the counterparty),
// reason, and one of transactionId/maintenanceId/reservationId/formId/
// sessionId/reference (the operation number) — this reads exactly those and
// nothing else.
const TIMELINE_TONE = {
  REJECT: 'reject', TRANSFER_REJECTED: 'reject', DISPOSAL_REQUESTED: 'review', DISPOSED: 'reject',
  ACCEPTED: 'approve', RECEIVE: 'approve', FOUND: 'approve', MAINTENANCE_APPROVED: 'approve',
  TRANSFERRED: 'forward', RESERVED: 'review', RESERVATION_RELEASED: 'recall',
};

export const AssetTimelinePanel = ({ rows, loading }) => {
  const { t, lang, locale } = useLanguage();

  if (loading) return <p className="field-note">{t('label_loading')}</p>;
  if (!rows.length) return <div className="empty-table compact"><History aria-hidden="true" /><b>{t('label_no_results')}</b></div>;

  return (
    <div className="assets-timeline">
      <ol>
        {rows.map((row) => {
          const payload = row.payload || {};
          const counterparty = payload.toUserName || payload.fromUserName || payload.toCustodyUnitName;
          const operationNo = payload.reference || payload.transactionId || payload.maintenanceId
            || payload.reservationId || payload.formId || payload.sessionId;
          const tone = TIMELINE_TONE[row.event_code] || 'submit';
          return (
            <li key={row.id} className={`timeline-item tone-${tone}`}>
              <span className="timeline-dot" />
              <div className="timeline-body">
                <div className="timeline-head">
                  <b>{pickLocalized(row, 'title', lang, row.event_code)}</b>
                  {row.actor_name && <span className="timeline-role">{row.actor_name}</span>}
                  {counterparty && <span className="timeline-target">→ {counterparty}</span>}
                </div>
                {payload.reason && <p className="timeline-comment">{payload.reason}</p>}
                <small>
                  {formatDateTime(row.occurred_on, locale)}
                  {operationNo && <code className="assets-op-no">{operationNo}</code>}
                </small>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
};
