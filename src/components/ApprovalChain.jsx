import { useEffect, useMemo, useState } from 'react';
import {
  BadgeCheck, CheckCircle2, CircleDashed, GitPullRequestArrow, Send, ShieldX, Undo2, UserRoundCheck, X,
} from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import {
  actOnApproval, loadApprovalFormDetail, loadRecipients, loadSchemeForTemplate, submitForApproval,
} from '../data/approvalService';
import { ACTION_KEYS, approvalErrorMessage, useArabicName } from '../utils/approval';

const actionTone = {
  Submit: 'submit', Approve: 'approve', Reviewed: 'approve', Reject: 'reject',
  RequestReview: 'review', Delegate: 'forward', Forward: 'forward', Recall: 'recall', Reassign: 'recall', Cancel: 'reject',
};

// ---------------------------------------------------------------------------
// Signature slots + approval timeline. Renders nothing until the form has an
// approval history, so it is safe to mount at the bottom of any document.
// ---------------------------------------------------------------------------
export const ApprovalChainSection = ({ formId, refreshToken = 0, detail: providedDetail }) => {
  const { t, locale } = useLanguage();
  const { roleName, roleNameFromRow } = useArabicName();
  const [fetched, setFetched] = useState(null);
  const detail = providedDetail || (fetched && fetched.id === formId ? fetched.data : null);

  useEffect(() => {
    if (providedDetail || !formId) return undefined;
    let cancelled = false;
    loadApprovalFormDetail(formId)
      .then((data) => { if (!cancelled) setFetched({ id: formId, data }); })
      .catch(() => { if (!cancelled) setFetched({ id: formId, data: null }); });
    return () => { cancelled = true; };
  }, [formId, refreshToken, providedDetail]);

  const transactions = detail?.transactions || [];
  const schemeRoles = detail?.scheme?.roles || [];
  if (!detail || !transactions.length) return null;

  const slotFor = (role) => {
    if (role.code === 'REQUESTER') {
      const submitTx = transactions.find((tx) => tx.action === 'Submit');
      return submitTx ? { ...submitTx, action: 'Approve' } : null;
    }
    return [...transactions].reverse().find(
      (tx) => tx.role_id === role.id && (tx.action === 'Approve' || tx.action === 'Reject')
    ) || null;
  };

  const formatStamp = (value) => new Date(value).toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const formatFull = (value) => new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section className="approval-chain-block">
      {schemeRoles.length > 0 && (
        <div className="approval-slots">
          {schemeRoles.map((role) => {
            const slot = slotFor(role);
            return (
              <div key={role.id} className={`approval-slot ${slot ? (slot.action === 'Reject' ? 'rejected' : 'signed') : 'pending'}`}>
                <b>{roleName(role)}</b>
                {slot ? (
                  <>
                    <span className="approval-slot-name">{slot.actor_name}</span>
                    {slot.actor_signature_url
                      ? <img className="form-signature-image" src={slot.actor_signature_url} alt={t('signature')} />
                      : (
                        <span className={`approval-stamp ${slot.action === 'Reject' ? 'stamp-rejected' : ''}`}>
                          {slot.action === 'Reject' ? <ShieldX /> : <BadgeCheck />}
                          {slot.action === 'Reject' ? t('rejected_stamp') : t('approved_stamp')}
                        </span>
                      )}
                    <small>{formatStamp(slot.created_on)}</small>
                  </>
                ) : (
                  <span className="approval-slot-pending"><CircleDashed /> {t('pending_signature')}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="approval-timeline">
        <h3><GitPullRequestArrow /> {t('approval_history_title')}</h3>
        <ol>
          {transactions.map((tx) => (
            <li key={tx.id || tx.seq} className={`timeline-item tone-${actionTone[tx.action] || 'submit'}`}>
              <span className="timeline-dot" />
              <div className="timeline-body">
                <div className="timeline-head">
                  <b>{tx.actor_name}</b>
                  <span className={`timeline-action tone-${actionTone[tx.action] || 'submit'}`}>{t(ACTION_KEYS[tx.action] || tx.action)}</span>
                  {roleNameFromRow(tx) && <span className="timeline-role">{roleNameFromRow(tx)}</span>}
                  {tx.to_user_name && <span className="timeline-target">← {tx.to_user_name}</span>}
                </div>
                {tx.comment && <p className="timeline-comment">{tx.comment}</p>}
                <small>{formatFull(tx.created_on)}</small>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
};

const EmployeeSelect = ({ employees, value, onChange, excludeId, label, required = true }) => {
  const { t } = useLanguage();
  const { employeeName } = useArabicName();
  return (
    <label className="field-label">{label || t('select_user')}
      <select required={required} className="form-input" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('select_employee_placeholder')}</option>
        {employees.filter((employee) => employee.id !== excludeId).map((employee) => (
          <option key={employee.id} value={employee.id}>
            {employeeName(employee)}{employee.employee_no ? ` · ${employee.employee_no}` : ''}
          </option>
        ))}
      </select>
    </label>
  );
};

// ---------------------------------------------------------------------------
// Send dialog: the requester picks an approval role from the template scheme,
// the recipient, and an optional note.
// ---------------------------------------------------------------------------
export const SendApprovalModal = ({ formId, templateId, currentUserId, onClose, onSent }) => {
  const { t } = useLanguage();
  const { roleName } = useArabicName();
  const [scheme, setScheme] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [roleId, setRoleId] = useState('');
  const [toUserId, setToUserId] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadSchemeForTemplate(templateId), loadRecipients()])
      .then(([schemeData, directory]) => {
        if (cancelled) return;
        setScheme(schemeData);
        setEmployees(directory);
      })
      .catch((loadError) => { if (!cancelled) setError(approvalErrorMessage(t, loadError)); });
    return () => { cancelled = true; };
  }, [templateId, t]);

  const sendableRoles = useMemo(
    () => (scheme?.roles || []).filter((role) => role.code !== 'REQUESTER' && role.is_active !== false),
    [scheme]
  );

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await submitForApproval({ formId, roleId, toUserId, comment });
      window.dispatchEvent(new Event('shalfa-forms-updated'));
      onSent?.();
    } catch (submitError) {
      setError(approvalErrorMessage(t, submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal-card" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="modal-heading">
          <h3>{t('send_for_approval')}</h3>
          <button type="button" className="icon-button" onClick={onClose}><X /></button>
        </div>
        {scheme === null && !error && <p className="field-note">{t('loading')}</p>}
        {scheme !== null && !sendableRoles.length && <div className="modal-error"><X />{t('no_scheme_for_template')}</div>}
        <label className="field-label">{t('approval_role')}
          <select required className="form-input" value={roleId} onChange={(event) => setRoleId(event.target.value)}>
            <option value="">{t('select_approval_role')}</option>
            {sendableRoles.map((role) => <option key={role.id} value={role.id}>{roleName(role)}</option>)}
          </select>
        </label>
        <EmployeeSelect employees={employees} value={toUserId} onChange={setToUserId} excludeId={currentUserId} />
        <label className="field-label">{t('comment_optional')}
          <textarea className="form-input" value={comment} onChange={(event) => setComment(event.target.value)} />
        </label>
        {error && <div className="modal-error"><X />{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('cancel')}</button>
          <button className="primary-button" disabled={busy || !sendableRoles.length}><Send /> {busy ? t('saving') : t('send')}</button>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Action dialog for the current assignee:
// Approve / Reject (comment only) · Request Review (reviewer + comment)
// Delegate (delegate + comment) · Forward (next role -> user + comment).
// A reviewer only sees "Reviewed".
// ---------------------------------------------------------------------------
export const ApprovalActionModal = ({ formId, currentUserId, onClose, onDone }) => {
  const { t } = useLanguage();
  const { roleName } = useArabicName();
  const [detail, setDetail] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [action, setAction] = useState('');
  const [toUserId, setToUserId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadApprovalFormDetail(formId), loadRecipients()])
      .then(([detailData, directory]) => {
        if (cancelled) return;
        setDetail(detailData);
        setEmployees(directory);
        setAction(detailData?.form?.return_to_user_id ? 'Reviewed' : 'Approve');
      })
      .catch((loadError) => { if (!cancelled) setError(approvalErrorMessage(t, loadError)); });
    return () => { cancelled = true; };
  }, [formId, t]);

  const isReviewer = !!detail?.form?.return_to_user_id;
  const forwardRoles = useMemo(
    () => (detail?.scheme?.roles || []).filter((role) => role.code !== 'REQUESTER' && role.is_active !== false),
    [detail]
  );

  const options = isReviewer
    ? [{ value: 'Reviewed', icon: UserRoundCheck, key: 'action_reviewed', hint: 'action_reviewed_hint' }]
    : [
      { value: 'Approve', icon: CheckCircle2, key: 'action_approve', hint: 'action_approve_hint' },
      { value: 'Reject', icon: ShieldX, key: 'action_reject', hint: 'action_reject_hint' },
      { value: 'RequestReview', icon: UserRoundCheck, key: 'action_request_review', hint: 'action_request_review_hint' },
      { value: 'Delegate', icon: Undo2, key: 'action_delegate', hint: 'action_delegate_hint' },
      { value: 'Forward', icon: GitPullRequestArrow, key: 'action_forward', hint: 'action_forward_hint' },
    ];

  const needsUser = ['RequestReview', 'Delegate', 'Forward'].includes(action);
  const needsRole = action === 'Forward';

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await actOnApproval({
        formId,
        action,
        toUserId: needsUser ? toUserId : null,
        roleId: needsRole ? roleId : null,
        comment,
      });
      window.dispatchEvent(new Event('shalfa-forms-updated'));
      onDone?.();
    } catch (actionError) {
      setError(approvalErrorMessage(t, actionError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal-card modal-wide approval-action-modal" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{detail?.form?.reference_no || ''}</span>
            <h3>{t('take_action')}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose}><X /></button>
        </div>
        {!detail && !error && <p className="field-note">{t('loading')}</p>}
        {detail && (
          <>
            <div className="approval-action-options">
              {options.map(({ value, icon: Icon, key, hint }) => (
                <button
                  type="button"
                  key={value}
                  className={`approval-action-option ${action === value ? 'active' : ''} tone-${actionTone[value]}`}
                  onClick={() => { setAction(value); setToUserId(''); setRoleId(''); }}
                >
                  <Icon />
                  <span><b>{t(key)}</b><small>{t(hint)}</small></span>
                </button>
              ))}
            </div>
            {needsRole && (
              <label className="field-label">{t('next_approval_role')}
                <select required className="form-input" value={roleId} onChange={(event) => setRoleId(event.target.value)}>
                  <option value="">{t('select_approval_role')}</option>
                  {forwardRoles.map((role) => <option key={role.id} value={role.id}>{roleName(role)}</option>)}
                </select>
              </label>
            )}
            {needsUser && (
              <EmployeeSelect
                employees={employees}
                value={toUserId}
                onChange={setToUserId}
                excludeId={currentUserId}
                label={action === 'RequestReview' ? t('select_reviewer') : action === 'Delegate' ? t('select_delegate') : t('select_user')}
              />
            )}
            <label className="field-label">{t('comment_optional')}
              <textarea className="form-input" value={comment} onChange={(event) => setComment(event.target.value)} />
            </label>
          </>
        )}
        {error && <div className="modal-error"><X />{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{t('cancel')}</button>
          <button className="primary-button" disabled={busy || !detail}>{busy ? t('saving') : t('submit_action')}</button>
        </div>
      </form>
    </div>
  );
};
