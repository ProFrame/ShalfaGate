// Storage abstraction.
//
// Two layers, one interface:
//
//   Core storage      logo, cover image, avatar, signature — carried by the
//                     platform, small, always available.
//   Extended storage  documents, certificates, chat attachments, form files —
//                     carried by the company's own provider, or by space the
//                     platform granted it.
//
// No screen and no module ever talks to Supabase Storage, Google Drive,
// OneDrive or S3 directly. They ask for a provider and use the four methods
// below, so swapping a provider changes nothing anywhere else.
//
// @typedef {Object} IStorageProvider
// @property {string} code
// @property {(input: {path: string, file: File|Blob, contentType?: string, upsert?: boolean}) => Promise<{data: {path: string, url: string, externalId?: string}|null, error: Error|null}>} upload
// @property {(path: string, options?: {expiresIn?: number}) => Promise<{data: {url: string}|null, error: Error|null}>} getUrl
// @property {(paths: string[]) => Promise<{error: Error|null}>} remove
// @property {(prefix: string) => Promise<{data: {name: string}[]|null, error: Error|null}>} list
// @property {() => Promise<{data: {ready: boolean, reason?: string}, error: Error|null}>} status

import { supabase, useLocalData } from '../supabaseClient';
import { tenantPath, userPath, uniqueFileName } from './paths';
import { sha256Hex } from './checksum';

export const STORAGE_LAYER = { CORE: 'Core', EXTENDED: 'Extended' };

export const CORE_BUCKETS = {
  branding: 'tenant-branding',
  employee: 'employee-assets',
  employeeSignatures: 'employee-signatures',
};

export const PRIVATE_EMPLOYEE_BUCKET = CORE_BUCKETS.employeeSignatures;

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || '').trim());

/** Resolve a private employee asset only when the caller is authenticated. */
export const resolveEmployeeAssetUrl = async (value, expiresIn = 900) => {
  const asset = String(value || '').trim();
  if (!asset || isHttpUrl(asset) || !supabase) return asset;
  const { data, error } = await supabase.storage
    .from(PRIVATE_EMPLOYEE_BUCKET)
    .createSignedUrl(asset, expiresIn);
  return error ? '' : data?.signedUrl || '';
};

const fail = (code) => ({ data: null, error: new Error(code) });

export { sha256Hex };

// The key rules live in ./paths.js so they can be read, reasoned about and
// tested without dragging a Supabase client in with them. Re-exported here so
// every caller keeps importing from one place.
export { tenantPath, userPath, uniqueFileName, pathBelongsToTenant } from './paths';

// ---------------------------------------------------------------------------
// Supabase-backed provider — the only one that runs entirely in the browser.
// ---------------------------------------------------------------------------

const supabaseProvider = (bucket) => ({
  code: 'supabase',

  async upload({ path, file, contentType, upsert = false }) {
    if (!supabase) return fail('STORAGE_NOT_CONFIGURED');
    const { error } = await supabase.storage
      .from(bucket)
      .upload(path, file, { upsert, contentType: contentType || file.type || 'application/octet-stream', cacheControl: '3600' });
    if (error) return { data: null, error };

    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return { data: { path, url: data.publicUrl }, error: null };
  },

  async getUrl(path, { expiresIn } = {}) {
    if (!supabase) return fail('STORAGE_NOT_CONFIGURED');
    if (expiresIn) {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn);
      if (error) return { data: null, error };
      return { data: { url: data.signedUrl }, error: null };
    }
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return { data: { url: data.publicUrl }, error: null };
  },

  async remove(paths) {
    if (!supabase) return { error: new Error('STORAGE_NOT_CONFIGURED') };
    const { error } = await supabase.storage.from(bucket).remove(paths);
    return { error };
  },

  async list(prefix) {
    if (!supabase) return fail('STORAGE_NOT_CONFIGURED');
    const { data, error } = await supabase.storage.from(bucket).list(prefix);
    if (error) return { data: null, error };
    return { data: (data || []).map((item) => ({ name: item.name })), error: null };
  },

  async status() {
    return { data: { ready: Boolean(supabase) }, error: null };
  },
});

// ---------------------------------------------------------------------------
// External providers (Google Drive, OneDrive, S3, R2, B2, Azure Blob).
//
// Their credentials must never reach the browser, so every call is proxied by
// the `storage-proxy` edge function, which reads the company's connection from
// public.tenant_storage_config and its secret from the function environment.
// ---------------------------------------------------------------------------

const proxyProvider = (code) => ({
  code,

  async upload({ path, file, contentType }) {
    if (!supabase) return fail('STORAGE_NOT_CONFIGURED');
    const form = new FormData();
    form.append('path', path);
    form.append('contentType', contentType || file.type || 'application/octet-stream');
    form.append('file', file);

    const { data, error } = await supabase.functions.invoke('storage-proxy', {
      body: form,
      headers: { 'x-storage-action': 'upload' },
    });
    if (error) return { data: null, error };
    if (data?.error) return { data: null, error: new Error(data.error) };
    return { data: { path: data.path, url: data.url, externalId: data.externalId }, error: null };
  },

  async getUrl(path, { expiresIn = 3600 } = {}) {
    if (!supabase) return fail('STORAGE_NOT_CONFIGURED');
    const { data, error } = await supabase.functions.invoke('storage-proxy', {
      body: { action: 'url', path, expiresIn },
      headers: { 'x-storage-action': 'url' },
    });
    if (error) return { data: null, error };
    if (data?.error) return { data: null, error: new Error(data.error) };
    return { data: { url: data.url }, error: null };
  },

  async remove(paths) {
    if (!supabase) return { error: new Error('STORAGE_NOT_CONFIGURED') };
    const { data, error } = await supabase.functions.invoke('storage-proxy', {
      body: { action: 'remove', paths },
      headers: { 'x-storage-action': 'remove' },
    });
    if (error) return { error };
    if (data?.error) return { error: new Error(data.error) };
    return { error: null };
  },

  // storage-proxy has no 'list' action — nothing currently needs folder
  // listing on an external provider (Core layer, the only caller of list()
  // today, always resolves to the Supabase provider). Fail explicitly rather
  // than silently returning an empty list, which would look like "nothing to
  // clean up" instead of "this isn't supported yet".
  async list() {
    return fail('LIST_NOT_SUPPORTED_FOR_PROVIDER');
  },

  async status() {
    if (!supabase) return { data: { ready: false, reason: 'STORAGE_NOT_CONFIGURED' }, error: null };
    const { data, error } = await supabase.functions.invoke('storage-proxy', {
      body: { action: 'status' },
      headers: { 'x-storage-action': 'status' },
    });
    if (error) return { data: { ready: false, reason: 'PROVIDER_UNREACHABLE' }, error: null };
    return { data: { ready: Boolean(data?.ready), reason: data?.reason }, error: null };
  },
});

// A provider that politely refuses, so the UI can explain instead of crashing
// when a company has connected nothing.
const disabledProvider = (reason) => ({
  code: 'none',
  upload: async () => fail(reason),
  getUrl: async () => fail(reason),
  remove: async () => ({ error: new Error(reason) }),
  list: async () => fail(reason),
  status: async () => ({ data: { ready: false, reason }, error: null }),
});

const localProvider = () => ({
  code: 'local',
  async upload({ path, file }) {
    const url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    return { data: { path, url }, error: null };
  },
  async getUrl(path) { return { data: { url: path }, error: null }; },
  async remove() { return { error: null }; },
  async list() { return { data: [], error: null }; },
  async status() { return { data: { ready: true }, error: null }; },
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

let extendedConfigCache = null;

export const invalidateStorageConfig = () => { extendedConfigCache = null; };

const loadExtendedConfig = async () => {
  if (extendedConfigCache) return extendedConfigCache;
  if (!supabase) return null;
  const { data } = await supabase
    .from('tenant_storage_config')
    .select('provider_code, is_enabled, quota_bytes, used_bytes, last_check_status')
    .maybeSingle();
  extendedConfigCache = data || { provider_code: 'none', is_enabled: false };
  return extendedConfigCache;
};

/**
 * @param {'Core'|'Extended'} layer
 * @param {{ bucket?: string }} [options]
 * @returns {Promise<IStorageProvider>}
 */
export const getStorageProvider = async (layer = STORAGE_LAYER.CORE, options = {}) => {
  if (useLocalData) return localProvider();

  if (layer === STORAGE_LAYER.CORE) {
    return supabaseProvider(options.bucket || CORE_BUCKETS.branding);
  }

  const config = await loadExtendedConfig();
  if (!config || !config.is_enabled || !config.provider_code || config.provider_code === 'none') {
    return disabledProvider('STORAGE_NOT_ENABLED');
  }
  if (config.provider_code === 'supabase') {
    return supabaseProvider(options.bucket || 'tenant-files');
  }
  return proxyProvider(config.provider_code);
};

/**
 * The five checks the platform owes the user before any upload:
 * is extended storage on, is there a provider, is the company under its limit,
 * is the type allowed, is the size allowed.
 *
 * @returns {Promise<{allowed: boolean, reason: string|null}>}
 */
export const canUpload = async ({ layer = STORAGE_LAYER.EXTENDED, mimeType, size }) => {
  if (useLocalData || !supabase) return { allowed: true, reason: null };

  const { data, error } = await supabase.rpc('storage_can_upload', {
    p_layer: layer,
    p_mime: mimeType || 'application/octet-stream',
    p_size: Math.max(Number(size) || 0, 0),
  });

  if (error) return { allowed: false, reason: 'STORAGE_CHECK_FAILED' };
  return { allowed: Boolean(data?.allowed), reason: data?.reason || null };
};

/** Records an uploaded object so usage, quotas and the platform screens agree. */
export const registerObject = async (payload) => {
  if (useLocalData || !supabase) return { data: null, error: null };
  return supabase.rpc('storage_register', { p_payload: payload });
};

export const unregisterObject = async (id) => {
  if (useLocalData || !supabase) return { data: null, error: null };
  return supabase.rpc('storage_unregister', { p_id: id });
};

/**
 * One call that does the whole dance: check, upload, register.
 * Every module uses this rather than reimplementing the sequence.
 *
 * @param {Object} input
 * @param {'Core'|'Extended'} [input.layer]
 * @param {string} input.tenantId
 * @param {string} input.area
 * @param {File|Blob} input.file
 * @param {string} [input.bucket]
 * @param {string|null} [input.entityType]
 * @param {string|null} [input.entityId]
 * @param {'tenant'|'user'} [input.pathScope] - 'tenant' (default) keys the object
 *   under tenants/{tenantId}/..., matching every ordinary bucket's RLS. 'user'
 *   keys it under {ownerId}/..., the shape the employee-assets/employee-signatures
 *   buckets' RLS requires — use it only for those, never invent a third scope.
 * @param {string} [input.ownerId] - required when pathScope is 'user'.
 */
export const putFile = async ({
  layer = STORAGE_LAYER.EXTENDED,
  tenantId,
  area,
  file,
  bucket,
  entityType = null,
  entityId = null,
  pathScope = 'tenant',
  ownerId,
}) => {
  if (pathScope === 'user' && !ownerId) return fail('OWNER_ID_REQUIRED');

  const check = await canUpload({ layer, mimeType: file.type, size: file.size });
  if (!check.allowed) return { data: null, error: new Error(check.reason || 'UPLOAD_REFUSED') };

  const provider = await getStorageProvider(layer, { bucket });
  const path = pathScope === 'user'
    ? userPath(ownerId, area, uniqueFileName(file.name))
    : tenantPath(tenantId, area, uniqueFileName(file.name));
  const [{ data, error }, checksum] = await Promise.all([
    provider.upload({ path, file, contentType: file.type }),
    sha256Hex(file).catch(() => null), // integrity metadata only — never block an upload on it
  ]);
  if (error) return { data: null, error };

  const { data: registered, error: registerError } = await registerObject({
    layer,
    provider_code: provider.code,
    bucket: bucket || (layer === STORAGE_LAYER.CORE ? CORE_BUCKETS.branding : null),
    path: data.path,
    external_id: data.externalId || null,
    file_name: file.name,
    mime_type: file.type,
    file_size: file.size,
    checksum,
    owner_id: pathScope === 'user' ? ownerId : null,
    entity_type: entityType,
    entity_id: entityId,
  });

  // The bytes are already on the provider; if the ledger write fails the
  // upload is not "done" (no quota accounting, no id for a caller like
  // attachFile() to link against) — undo it rather than report success with
  // a hidden orphaned file and a null id.
  if (registerError) {
    await provider.remove([data.path]);
    return { data: null, error: registerError };
  }

  return { data: { ...data, id: registered?.id || null }, error: null };
};

/**
 * Best-effort: unregister every storage_objects ledger row at these exact
 * paths. Used when a caller replaces or deletes a file it manages outside the
 * ledger's own id (e.g. "the current avatar", identified by path, not by the
 * storage_objects id it isn't holding onto).
 */
export const unregisterObjectsByPath = async (paths) => {
  if (useLocalData || !supabase || !paths?.length) return;
  const { data } = await supabase
    .from('storage_objects')
    .select('id')
    .in('path', paths)
    .eq('is_deleted', false);
  await Promise.all((data || []).map((row) => unregisterObject(row.id)));
};
