// Assets Management — small shared vocabulary (not components — kept out of
// AssetShared.jsx so that file can stay component-only, per the
// react-refresh/only-export-components lint rule).

// Inventory sessions and Reports both resolve a session's status label the
// same way — sharing it here closes the release-gate's "4th undocumented
// instance of the status-label-duplication pattern" finding.
export const SESSION_STATUS_KEYS = {
  Draft: 'status_draft',
  InProgress: 'status_inprogress',
  Completed: 'assets_status_completed',
  Cancelled: 'status_cancelled',
};

export const sessionStatusLabel = (t, status) => (
  SESSION_STATUS_KEYS[status] ? t(SESSION_STATUS_KEYS[status]) : status
);
