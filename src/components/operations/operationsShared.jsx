// Operations — small presentational pieces shared across this module's
// screens (previously copy-pasted verbatim between OperationsPortal.jsx's own
// ExecutionLogAttachments and the inline block ExecutionLogsPanel in
// OperationsListAdmin.jsx carried instead of importing it — closing-audit
// finding). Both screens import from here now instead of carrying their own
// copy.

import { Image as ImageIcon, Paperclip } from 'lucide-react';
import AttachmentsPanel from '../platform/AttachmentsPanel';
import {
  EXECUTION_FILE_ENTITY_TYPE, EXECUTION_PHOTO_ENTITY_TYPE, listExecutionLogAttachments,
} from '../../data/operationsService';

// One execution log's own Photo/File attachment panels, scoped by
// executionLogId. Used both for the portal's "attach to what I just logged"
// prompt (writable) and every read-only history/detail rendering elsewhere.
export const ExecutionLogAttachments = ({
  tenantId, executionLogId, readOnly, t,
}) => (
  <div className="ops-log-attachments">
    <div>
      <h5><ImageIcon aria-hidden="true" /> {t('operations_field_photos')}</h5>
      <AttachmentsPanel
        tenantId={tenantId}
        entityType={EXECUTION_PHOTO_ENTITY_TYPE}
        entityId={executionLogId}
        area="operations"
        readOnly={readOnly}
        listFn={listExecutionLogAttachments}
      />
    </div>
    <div>
      <h5><Paperclip aria-hidden="true" /> {t('operations_field_attachments')}</h5>
      <AttachmentsPanel
        tenantId={tenantId}
        entityType={EXECUTION_FILE_ENTITY_TYPE}
        entityId={executionLogId}
        area="operations"
        readOnly={readOnly}
        listFn={listExecutionLogAttachments}
      />
    </div>
  </div>
);
