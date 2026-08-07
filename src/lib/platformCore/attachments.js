// Platform Core — Attachment Framework (owned by Storage Service, see
// bbnovix_contract.md §12).
//
// The one place a module attaches an already-uploaded file to one of its
// records. It never inserts into a bespoke attachments table and never talks
// to public.storage_objects directly for this — it calls attachFile() to
// create one, listAttachments() to read them back, markAttachmentForRemoval()
// to flag one. Every function resolves with { data, error } and never throws.

import { supabase, useLocalData } from '../supabaseClient';
import { putFile, getStorageProvider } from '../storage';

const DEMO_KEY = 'bbnovix_attachments_demo';

const readDemo = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(DEMO_KEY) || 'null');
    if (Array.isArray(stored)) return stored;
  } catch {
    // A corrupted mirror is simply replaced by a fresh one.
  }
  return [];
};

const writeDemo = (rows) => {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(rows));
  } catch {
    // Preview only: a full/private-mode storage must not break the screens.
  }
};

// A blob: URL (URL.createObjectURL) only resolves for the lifetime of the
// page that created it — persisting one into localStorage and reading it
// back after a reload silently produces a broken image/link. A data: URL is
// pure text, so it survives exactly the same way AuthContext's demo avatar
// upload already relies on (readAsDataURL), which is the established pattern
// for "must still work after F5" demo file previews in this codebase.
const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

/**
 * Uploads a file (via putFile, so it is quota/mime/size checked and ledgered
 * like every other upload) and attaches it to a business record in one call.
 *
 * @param {Object} input
 * @param {File|Blob} input.file
 * @param {string} input.tenantId
 * @param {string} input.area - storage sub-folder, e.g. 'forms', 'assets'.
 * @param {'Core'|'Extended'} [input.layer]
 * @param {string} input.entityType - e.g. 'Form', 'Asset'.
 * @param {string} input.entityId
 * @returns {Promise<{data: {attachmentId: string, path: string, url: string}|null, error: Error|null}>}
 */
export async function attachFile({ file, tenantId, area, layer, entityType, entityId }) {
  if (!entityType || !entityId) return { data: null, error: new Error('ENTITY_REQUIRED') };

  if (useLocalData) {
    const rows = readDemo();
    const dataUrl = await readAsDataUrl(file);
    const row = {
      id: `demo-att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      entity_type: entityType,
      entity_id: entityId,
      file_name: file.name,
      mime_type: file.type,
      file_size: file.size,
      marked_for_removal: false,
      created_by_name: '',
      created_on: new Date().toISOString(),
      display_order: rows.filter((r) => r.entity_type === entityType && r.entity_id === entityId).length,
      _demoUrl: dataUrl,
    };
    writeDemo([...rows, row]);
    return { data: { attachmentId: row.id, path: row._demoUrl, url: row._demoUrl }, error: null };
  }

  const { data: uploaded, error: uploadError } = await putFile({
    layer, tenantId, area, file, entityType, entityId,
  });
  if (uploadError) return { data: null, error: uploadError };
  if (!uploaded.id) return { data: null, error: new Error('STORAGE_REGISTRATION_FAILED') };

  const { data: attachmentId, error: attachError } = await supabase.rpc('attachment_attach', {
    p_storage_object_id: uploaded.id,
    p_entity_type: entityType,
    p_entity_id: entityId,
  });
  if (attachError) return { data: null, error: attachError };

  return { data: { attachmentId, path: uploaded.path, url: uploaded.url }, error: null };
}

/**
 * @returns {Promise<{data: Array<Object>|null, error: Error|null}>} each row
 *   carries the attachment id, entity link, marked_for_removal state, and the
 *   underlying file's name/mime/size/path/provider — plus a resolved `url`
 *   ready to render.
 */
export async function listAttachments(entityType, entityId) {
  if (!entityType || !entityId) return { data: [], error: null };

  if (useLocalData) {
    const rows = readDemo().filter((r) => r.entity_type === entityType && r.entity_id === entityId);
    return { data: rows.map((r) => ({ ...r, url: r._demoUrl })).sort((a, b) => a.display_order - b.display_order), error: null };
  }

  const { data, error } = await supabase.rpc('attachment_list', {
    p_entity_type: entityType,
    p_entity_id: entityId,
  });
  if (error) return { data: null, error };

  const rows = Array.isArray(data) ? data : [];
  const resolved = await Promise.all(rows.map(async (row) => {
    const provider = await getStorageProvider(row.layer, { bucket: row.bucket || undefined });
    // Always request a signed URL, never assume a Core-layer bucket is
    // public — some (employee-signatures) deliberately are not, and a
    // signed URL resolves correctly on a public bucket too, so there is no
    // upside to guessing from `layer` alone (this exact assumption already
    // broke once for employee-signatures before it was fixed, see
    // resolveEmployeeAssetUrl in src/lib/storage/index.js).
    const { data: urlData } = await provider.getUrl(row.path, { expiresIn: 3600 });
    return { ...row, url: urlData?.url || '' };
  }));

  return { data: resolved, error: null };
}

export async function markAttachmentForRemoval(id, marked = true) {
  if (useLocalData) {
    const rows = readDemo().map((r) => (r.id === id ? { ...r, marked_for_removal: marked } : r));
    writeDemo(rows);
    return { data: null, error: null };
  }
  const { error } = await supabase.rpc('attachment_mark_for_removal', { p_id: id, p_marked: marked });
  return { data: null, error };
}
