// Safety Management — shared safety_timeline() renderer. Previously
// implemented three times with diverging read/render shapes
// (SafetyAssetsAdmin.jsx's own INSPECTED-only tone map reading
// payload.conditionStatus, SafetyIssuancesAdmin.jsx's own broader substring
// heuristic reading payload.toUserName/fromUserName/reason/reference/
// transactionId, and SafetyPortal.jsx's own copy with no tone logic at all —
// every row rendered in the same neutral colour there). Hoisted into one
// component so every screen that renders safety_timeline() rows gets the
// same tone-coding and the same payload fields resolved, covering the union
// of what all three call sites actually read out of `payload`.
import { History } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { codeLabel, formatDateTime, pickLocalized } from '../../utils/localize';

const timelineTone = (eventCode) => {
  const upper = String(eventCode || '').toUpperCase();
  if (upper === 'INSPECTED') return 'approve';
  if (upper.includes('REJECT') || upper.includes('LOST') || upper.includes('DAMAGED')) return 'reject';
  if (upper.includes('CLOSE') || upper.includes('RETURN') || upper.includes('COMPLETE')) return 'approve';
  if (upper.includes('REISSUE') || upper.includes('REPLACE')) return 'forward';
  if (upper.includes('EXPIRE')) return 'review';
  return 'submit';
};

export const SafetyTimelinePanel = ({ rows, loading }) => {
  const { t, lang, locale } = useLanguage();

  if (loading) return <p className="field-note">{t('label_loading')}</p>;
  if (!rows.length) return <div className="empty-table compact"><History aria-hidden="true" /><b>{t('label_no_results')}</b></div>;

  return (
    <div className="safety-timeline">
      <ol>
        {rows.map((row) => {
          const payload = row.payload || {};
          const counterparty = payload.toUserName || payload.fromUserName || payload.toCustodyUnitName;
          const operationNo = payload.reference || payload.transactionId || payload.formId || payload.sessionId;
          const tone = timelineTone(row.event_code);
          return (
            <li key={row.id} className={`timeline-item tone-${tone}`}>
              <span className="timeline-dot" />
              <div className="timeline-body">
                <div className="timeline-head">
                  <b>{pickLocalized(row, 'title', lang, row.event_code)}</b>
                  {row.actor_name && <span className="timeline-role">{row.actor_name}</span>}
                  {counterparty && <span className="timeline-target">→ {counterparty}</span>}
                </div>
                {payload.conditionStatus && (
                  <p className="timeline-comment">{codeLabel(t, 'safety_condition', payload.conditionStatus, payload.conditionStatus)}</p>
                )}
                {payload.reason && <p className="timeline-comment">{payload.reason}</p>}
                <small>
                  {formatDateTime(row.occurred_on, locale)}
                  {operationNo && <code className="safety-op-no">{operationNo}</code>}
                </small>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
};
