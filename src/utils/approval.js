import { useLanguage } from '../context/LanguageContext';

export const ACTION_KEYS = {
  Submit: 'action_hist_submit',
  Approve: 'action_approve',
  Reject: 'action_reject',
  RequestReview: 'action_request_review',
  Reviewed: 'action_reviewed',
  Delegate: 'action_delegate',
  Forward: 'action_forward',
  Recall: 'action_recall',
  Reassign: 'action_reassign',
  Cancel: 'action_hist_cancel',
};

const ERROR_KEYS = [
  'FORM_NOT_FOUND', 'ONLY_REQUESTER_CAN_SUBMIT', 'FORM_NOT_SENDABLE', 'FORM_HELD_BY_ANOTHER_USER',
  'CANNOT_SEND_TO_SELF', 'TARGET_USER_NOT_FOUND', 'APPROVAL_ROLE_NOT_FOUND', 'ROLE_NOT_IN_TEMPLATE_SCHEME',
  'NOT_CURRENT_ASSIGNEE', 'REVIEWER_CAN_ONLY_REVIEW', 'RECIPIENT_ALREADY_ACTED', 'PERMISSION_DENIED',
  'FORM_ALREADY_CANCELLED', 'ONLY_REQUESTER_CAN_CANCEL', 'FORM_CANCELLED',
  'SELF_APPROVAL_NOT_ALLOWED', 'FORM_NOT_IN_APPROVAL', 'NO_APPROVAL_TEMPLATE_TAKES_NO_ROUTING',
  'INVALID_COLLABORATOR_ROLE', 'REQUESTER_ALREADY_HAS_ACCESS', 'NO_TENANT_CONTEXT',
];

export const approvalErrorMessage = (t, error) => {
  const raw = String(error?.message || error || '');
  const known = ERROR_KEYS.find((code) => raw.includes(code));
  return known ? t(`approval_err_${known.toLowerCase()}`) : raw || t('operation_failed');
};

/** Hours a pending request has been waiting for the current holder to act. */
export const hoursSince = (value) => (value ? Math.max(0, (Date.now() - new Date(value).getTime()) / 36e5) : 0);

/** "3 days" / "2 hours" — the one aging-display formatter every SLA table/badge uses. */
export const agingLabel = (t, hours) => (
  hours >= 24 ? t('aging_days', { count: Math.floor(hours / 24) }) : t('aging_hours', { count: Math.max(1, Math.round(hours)) })
);

export const useArabicName = () => {
  const { lang } = useLanguage();
  const arabicFirst = lang === 'ar' || lang === 'ur';
  return {
    roleName: (role) => (!role ? '' : arabicFirst ? role.name_ar || role.name_en : role.name_en || role.name_ar),
    roleNameFromRow: (row, prefix = 'role_name') => (arabicFirst ? row?.[`${prefix}_ar`] || row?.[`${prefix}_en`] : row?.[`${prefix}_en`] || row?.[`${prefix}_ar`]),
    employeeName: (employee) => (arabicFirst
      ? employee?.name_ar || employee?.full_name || employee?.name_en
      : employee?.name_en || employee?.full_name || employee?.name_ar),
  };
};
