import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BadgeCheck, CheckCircle2, CircleDashed, Eye, GitPullRequestArrow, Send, ShieldX, Undo2, UserPlus, UserRoundCheck, X,
} from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import {
  actOnApproval, addFormCollaborator, listFormCollaborators, loadApprovalFormDetail, loadRecipients,
  loadSchemeForTemplate, loadTemplateApprovalMeta, removeFormCollaborator, submitForApproval,
} from '../data/approvalService';
import { ACTION_KEYS, approvalErrorMessage, useArabicName } from '../utils/approval';
import { resolveEmployeeAssetUrl } from '../lib/storage';
import { formatDate, formatDateTime } from '../utils/localize';
import { useDialogA11y } from '../utils/useDialogA11y';

const actionTone = {
  Submit: 'submit', Approve: 'approve', Reviewed: 'approve', Reject: 'reject',
  RequestReview: 'review', Delegate: 'forward', Forward: 'forward', Recall: 'recall', Reassign: 'recall', Cancel: 'reject',
};

// ---------------------------------------------------------------------------
// Signature slots + approval timeline. Renders nothing until the form has an
// approval history, so it is safe to mount at the bottom of any document.
// ---------------------------------------------------------------------------
// The signature slots are the form's official approval boxes: they render from
// the template scheme even before anything is sent, so a blank printed form
// already carries the right boxes.
export const ApprovalChainSection = ({ formId, templateId, refreshToken = 0, detail: providedDetail }) => {
  const { t, locale } = useLanguage();
  const { roleName, roleNameFromRow } = useArabicName();
  const [fetched, setFetched] = useState(null);
  const [resolvedTransactions, setResolvedTransactions] = useState([]);
  const cacheKey = formId || `template:${templateId}`;
  const detail = providedDetail || (fetched?.key === cacheKey ? fetched.data : null);

  useEffect(() => {
    if (providedDetail || (!formId && !templateId)) return undefined;
    let cancelled = false;
    const request = formId
      ? loadApprovalFormDetail(formId)
      : loadSchemeForTemplate(templateId).then((scheme) => ({ scheme, transactions: [] }));
    request
      .then((data) => { if (!cancelled) setFetched({ key: cacheKey, data }); })
      .catch(() => { if (!cancelled) setFetched({ key: cacheKey, data: null }); });
    return () => { cancelled = true; };
  }, [formId, templateId, cacheKey, refreshToken, providedDetail]);

  useEffect(() => {
    let cancelled = false;
    const source = detail?.transactions || [];
    Promise.resolve().then(() => source.length
      ? Promise.all(source.map(async (transaction) => ({
        ...transaction,
        actor_signature_url: transaction.actor_signature_url
          ? await resolveEmployeeAssetUrl(transaction.actor_signature_url)
          : transaction.actor_signature_url,
      })))
      : []).then((next) => {
      if (!cancelled) setResolvedTransactions(next);
    });
    return () => { cancelled = true; };
  }, [detail]);

  const transactions = detail ? resolvedTransactions : [];
  const schemeRoles = detail?.scheme?.roles || [];
  if (!detail || (!schemeRoles.length && !transactions.length)) return null;

  const slotFor = (role) => {
    if (role.code === 'REQUESTER') {
      const submitTx = transactions.find((tx) => tx.action === 'Submit');
      return submitTx ? { ...submitTx, action: 'Approve' } : null;
    }
    return [...transactions].reverse().find(
      (tx) => tx.role_id === role.id && (tx.action === 'Approve' || tx.action === 'Reject')
    ) || null;
  };

  const formatStamp = (value) => formatDate(value, locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const formatFull = (value) => formatDateTime(value, locale);

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

      {transactions.length > 0 && (
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
      )}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Participants / Watchers (migration 044): people who can see the request or
// follow its updates without being part of the approval chain. Renders
// nothing until the request actually exists (no formId while drafting).
// ---------------------------------------------------------------------------
export const CollaboratorsPanel = ({ formId, currentUserId }) => {
  const { t } = useLanguage();
  const { employeeName } = useArabicName();
  const [collaborators, setCollaborators] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [role, setRole] = useState('Watcher');
  const [userId, setUserId] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    if (!formId) return;
    listFormCollaborators(formId).then(setCollaborators).catch(() => setCollaborators([]));
  }, [formId]);

  useEffect(() => { refresh(); loadRecipients().then(setEmployees).catch(() => setEmployees([])); }, [refresh]);

  if (!formId) return null;

  const add = async () => {
    if (!userId) return;
    try {
      await addFormCollaborator(formId, userId, role);
      setUserId('');
      setError('');
      refresh();
    } catch (addError) {
      setError(approvalErrorMessage(t, addError));
    }
  };

  const remove = async (id) => {
    try {
      await removeFormCollaborator(formId, id);
      refresh();
    } catch (removeError) {
      setError(approvalErrorMessage(t, removeError));
    }
  };

  return (
    <section className="collaborators-panel">
      <h4><Eye size={16} /> {t('collaborators_title')}</h4>
      <p className="field-note">{t('collaborators_hint')}</p>
      <ul className="collaborators-list">
        {collaborators.map((item) => (
          <li key={item.user_id}>
            <span>{item.user_name}</span>
            <span className="collaborator-role">{item.role === 'Watcher' ? t('collaborator_role_watcher') : t('collaborator_role_participant')}</span>
            {item.user_id !== currentUserId && (
              <button type="button" className="icon-button" onClick={() => remove(item.user_id)} title={t('remove_collaborator')}><X size={14} /></button>
            )}
          </li>
        ))}
        {!collaborators.length && <li className="field-note">{t('no_collaborators')}</li>}
      </ul>
      <div className="collaborators-add">
        <select className="form-input" value={userId} onChange={(event) => setUserId(event.target.value)}>
          <option value="">{t('select_employee_placeholder')}</option>
          {employees.filter((employee) => !collaborators.some((c) => c.user_id === employee.id)).map((employee) => (
            <option key={employee.id} value={employee.id}>{employeeName(employee)}</option>
          ))}
        </select>
        <select className="form-input" value={role} onChange={(event) => setRole(event.target.value)}>
          <option value="Watcher">{t('collaborator_role_watcher')}</option>
          <option value="Participant">{t('collaborator_role_participant')}</option>
        </select>
        <button type="button" className="secondary-button" onClick={add} disabled={!userId}><UserPlus size={14} /> {t('add_collaborator')}</button>
      </div>
      {error && <p className="modal-error"><X size={14} />{error}</p>}
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
  const closeRef = useDialogA11y(onClose);
  const [scheme, setScheme] = useState(null);
  // A no-scheme template is a legitimate, permanent state (loadSchemeForTemplate
  // resolves to null the moment the fetch completes, same as "still loading"
  // resolves to null before it completes) — `scheme !== null` can therefore
  // never distinguish the two. `metaLoaded` is the actual "fetch finished"
  // flag; a fresh-eyes review caught the original version of this component
  // using `scheme !== null` for that job, which left a requires_final_approval
  // = false + no-scheme template (exactly what that setting exists for) stuck
  // on "Loading..." forever, with no submit control and no error.
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [requiresFinalApproval, setRequiresFinalApproval] = useState(true);
  const [employees, setEmployees] = useState([]);
  const [roleId, setRoleId] = useState('');
  const [toUserId, setToUserId] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadSchemeForTemplate(templateId), loadRecipients(), loadTemplateApprovalMeta(templateId)])
      .then(([schemeData, directory, meta]) => {
        if (cancelled) return;
        setScheme(schemeData);
        setEmployees(directory);
        setRequiresFinalApproval(meta.requiresFinalApproval);
        setMetaLoaded(true);
      })
      .catch((loadError) => { if (!cancelled) { setError(approvalErrorMessage(t, loadError)); setMetaLoaded(true); } });
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
      await submitForApproval(requiresFinalApproval
        ? { formId, roleId, toUserId, comment }
        : { formId, roleId: null, toUserId: null, comment });
      window.dispatchEvent(new Event('bbnovix-forms-updated'));
      onSent?.();
    } catch (submitError) {
      setError(approvalErrorMessage(t, submitError));
    } finally {
      setBusy(false);
    }
  };

  // A template configured with Requires Final Approval = No has no chain to
  // route into at all (survey/suggestion/complaint — FourthUpdate.md) — the
  // request is complete the moment it is sent, so this is a plain "send"
  // confirmation rather than a role/recipient picker.
  if (metaLoaded && !requiresFinalApproval) {
    return (
      <div className="modal-backdrop" role="presentation" onClick={onClose}>
        <form className="modal-card" role="dialog" aria-modal="true" aria-label={t('submit_direct')} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
          <div className="modal-heading">
            <h3>{t('submit_direct')}</h3>
            <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}><X /></button>
          </div>
          <p className="field-note">{t('submit_direct_hint')}</p>
          <label className="field-label">{t('comment_optional')}
            <textarea className="form-input" value={comment} onChange={(event) => setComment(event.target.value)} />
          </label>
          {error && <div className="modal-error"><X />{error}</div>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>{t('cancel')}</button>
            <button className="primary-button" disabled={busy}><Send /> {busy ? t('saving') : t('send')}</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form className="modal-card" role="dialog" aria-modal="true" aria-label={t('send_for_approval')} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="modal-heading">
          <h3>{t('send_for_approval')}</h3>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}><X /></button>
        </div>
        {!metaLoaded && !error && <p className="field-note">{t('loading')}</p>}
        {metaLoaded && !sendableRoles.length && <div className="modal-error"><X />{t('no_scheme_for_template')}</div>}
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
  const closeRef = useDialogA11y(onClose);
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
      window.dispatchEvent(new Event('bbnovix-forms-updated'));
      onDone?.();
    } catch (actionError) {
      setError(approvalErrorMessage(t, actionError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form className="modal-card modal-wide approval-action-modal" role="dialog" aria-modal="true" aria-label={t('take_action')} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{detail?.form?.reference_no || ''}</span>
            <h3>{t('take_action')}</h3>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={t('action_close')}><X /></button>
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
