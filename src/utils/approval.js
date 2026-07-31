import { useLanguage } from '../context/LanguageContext';

export const ACTION_KEYS = {
  Submit: 'action_submit',
  Approve: 'action_approve',
  Reject: 'action_reject',
  RequestReview: 'action_request_review',
  Reviewed: 'action_reviewed',
  Delegate: 'action_delegate',
  Forward: 'action_forward',
  Recall: 'action_recall',
  Reassign: 'action_reassign',
  Cancel: 'action_cancel',
};

const ERROR_KEYS = [
  'FORM_NOT_FOUND', 'ONLY_REQUESTER_CAN_SUBMIT', 'FORM_NOT_SENDABLE', 'FORM_HELD_BY_ANOTHER_USER',
  'CANNOT_SEND_TO_SELF', 'TARGET_USER_NOT_FOUND', 'APPROVAL_ROLE_NOT_FOUND', 'ROLE_NOT_IN_TEMPLATE_SCHEME',
  'NOT_CURRENT_ASSIGNEE', 'REVIEWER_CAN_ONLY_REVIEW', 'RECIPIENT_ALREADY_ACTED', 'PERMISSION_DENIED',
  'FORM_ALREADY_CANCELLED', 'ONLY_REQUESTER_CAN_CANCEL', 'FORM_CANCELLED',
];

export const approvalErrorMessage = (t, error) => {
  const raw = String(error?.message || error || '');
  const known = ERROR_KEYS.find((code) => raw.includes(code));
  return known ? t(`approval_err_${known.toLowerCase()}`) : raw || t('operation_failed');
};

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
