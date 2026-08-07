// Support — small presentational pieces shared between SupportPanel.jsx
// (ADMIN_SUPPORT) and SupportTickets.jsx (PORTAL_SUPPORT), so a ticket's
// status/priority render identically in both places instead of two
// hand-maintained copies (mirrors operationsShared.jsx's own reason for
// existing — see that file's own header).

import { codeLabel } from '../../utils/localize';

/**
 * Tone mapping mirrors SupportConsole.jsx's own StatusChip exactly (Open ->
 * brand, InProgress -> pending, Answered -> active/success, Closed ->
 * disabled/muted) — re-implemented here since platform.css's .pc-chip
 * belongs to that operator-only screen, not either tenant-scoped one. Status
 * labels reuse the shared status_open/status_inprogress/status_answered/
 * status_closed keys (platform.js) — the exact enum they were already
 * seeded for.
 */
export const TicketStatusChip = ({ t, status }) => {
  const tone = status === 'Closed' ? 'sup-chip-disabled'
    : status === 'Answered' ? 'sup-chip-active'
      : status === 'InProgress' ? 'sup-chip-pending' : 'sup-chip-brand';
  return <span className={`sup-chip ${tone}`}>{codeLabel(t, 'status', status, status)}</span>;
};

export const TicketPriorityChip = ({ t, priority }) => (
  <span className={`sup-chip sup-priority-${String(priority || 'normal').toLowerCase()}`}>
    {codeLabel(t, 'support_priority', priority, priority)}
  </span>
);
