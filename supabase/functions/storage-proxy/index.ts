// The server half of the storage abstraction.
//
// src/lib/storage/index.js hands every extended-storage call to this function:
// upload, url, remove, status. The browser never learns which vendor is behind
// them and never sees a credential — it sees a path and, when it needs one, a
// short-lived signed link.
//
// What the function decides, in order:
//   1. who is calling            — the caller's JWT
//   2. which company they are in — public.current_tenant_id(), never the body
//   3. what that company connected — public.tenant_storage_config
//   4. whether the file is allowed — public.storage_can_upload
//   5. the vendor call itself
//
// Steps 2 and 3 are why a path is not enough to reach another company's files:
// every path must live under tenants/{caller's tenant}/ or the call is refused
// before a vendor is contacted.
//
// Credentials never live in the database — tenant_storage_config has a check
// constraint that rejects them — they live in the function environment and are
// addressed by `credential_ref`:
//
//   STORAGE_{REF}_ACCESS_KEY_ID       STORAGE_{REF}_SECRET_ACCESS_KEY
//   STORAGE_DEFAULT_ACCESS_KEY_ID     STORAGE_DEFAULT_SECRET_ACCESS_KEY
//
// (Backblaze names its pair keyId / applicationKey; both spellings are read.)

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20';

import { asErrorCode, errorResponse, isPreflight, jsonResponse, preflightResponse } from '../_shared/cors.ts';

const CORS = { methods: 'POST, OPTIONS' };

const DEFAULT_URL_TTL = Number(Deno.env.get('STORAGE_URL_TTL_SECONDS') ?? '3600');
const MAX_URL_TTL = 7 * 24 * 60 * 60; // the SigV4 ceiling

/** Providers this function speaks. Everything else answers NOT_IMPLEMENTED. */
const S3_COMPATIBLE = new Set(['s3', 'r2', 'b2']);

interface StorageConfig {
  tenant_id: string;
  provider_code: string | null;
  is_enabled: boolean;
  config: Record<string, unknown>;
  credential_ref: string | null;
  root_path: string;
}

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

interface S3Target {
  origin: string;
  bucket: string;
  region: string;
  pathStyle: boolean;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const cleanPath = (value: unknown): string =>
  String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
    .trim();

/** A path is only ever accepted inside the caller's own company folder. */
const pathBelongsToTenant = (path: string, tenantId: string): boolean => {
  if (!path || path.includes('..') || /[\u0000-\u001f]/.test(path)) return false;
  return path.startsWith(`tenants/${tenantId}/`);
};

/** The vendor key: the company path, under the configured root when there is
 *  one that is not already part of the path. */
const objectKey = (rootPath: string, path: string): string => {
  const root = cleanPath(rootPath).replace(/\/+$/, '');
  if (!root || path === root || path.startsWith(`${root}/`)) return path;
  return `${root}/${path}`;
};

// ---------------------------------------------------------------------------
// Credentials and endpoints
// ---------------------------------------------------------------------------

const envName = (ref: string, name: string): string =>
  `STORAGE_${ref.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${name}`;

const readEnv = (ref: string | null, names: string[]): string => {
  for (const name of names) {
    if (ref) {
      const scoped = Deno.env.get(envName(ref, name));
      if (scoped) return scoped;
    }
    const shared = Deno.env.get(`STORAGE_DEFAULT_${name}`);
    if (shared) return shared;
  }
  return '';
};

const credentialsFor = (config: StorageConfig): Credentials | null => {
  const accessKeyId = readEnv(config.credential_ref, ['ACCESS_KEY_ID', 'KEY_ID']);
  const secretAccessKey = readEnv(config.credential_ref, ['SECRET_ACCESS_KEY', 'APPLICATION_KEY']);
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey };
};

const targetFor = (config: StorageConfig): { target: S3Target | null; error: string | null } => {
  const settings = config.config ?? {};
  const bucket = String(settings.bucket ?? '').trim();
  if (!bucket) return { target: null, error: 'STORAGE_BUCKET_NOT_CONFIGURED' };

  const explicitEndpoint = String(settings.endpoint ?? '').trim().replace(/\/+$/, '');
  const region = String(settings.region ?? '').trim();

  if (config.provider_code === 's3') {
    if (!explicitEndpoint && !region) return { target: null, error: 'STORAGE_REGION_NOT_CONFIGURED' };
    // Virtual-hosted addressing is what AWS recommends and what every region
    // supports; the bucket name is already in the host.
    const origin = explicitEndpoint || `https://${bucket}.s3.${region}.amazonaws.com`;
    return {
      target: { origin, bucket, region: region || 'us-east-1', pathStyle: Boolean(explicitEndpoint) },
      error: null,
    };
  }

  if (config.provider_code === 'r2') {
    const accountId = String(settings.account_id ?? '').trim();
    if (!explicitEndpoint && !accountId) return { target: null, error: 'STORAGE_ACCOUNT_NOT_CONFIGURED' };
    const origin = explicitEndpoint || `https://${accountId}.r2.cloudflarestorage.com`;
    // R2 signs with the fixed region 'auto'.
    return { target: { origin, bucket, region: 'auto', pathStyle: true }, error: null };
  }

  if (config.provider_code === 'b2') {
    if (!explicitEndpoint && !region) return { target: null, error: 'STORAGE_REGION_NOT_CONFIGURED' };
    // Backblaze exposes an S3 compatible endpoint per region, e.g.
    // https://s3.us-west-004.backblazeb2.com
    const origin = explicitEndpoint || `https://s3.${region}.backblazeb2.com`;
    return { target: { origin, bucket, region: region || 'us-west-004', pathStyle: true }, error: null };
  }

  return { target: null, error: 'STORAGE_PROVIDER_NOT_SUPPORTED' };
};

const objectUrl = (target: S3Target, key: string): string => {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return target.pathStyle
    ? `${target.origin}/${target.bucket}/${encoded}`
    : `${target.origin}/${encoded}`;
};

const awsClient = (target: S3Target, credentials: Credentials) => new AwsClient({
  accessKeyId: credentials.accessKeyId,
  secretAccessKey: credentials.secretAccessKey,
  service: 's3',
  region: target.region,
});

// ---------------------------------------------------------------------------
// The S3-compatible provider (Amazon S3, Cloudflare R2, Backblaze B2)
// ---------------------------------------------------------------------------

const s3Upload = async (
  target: S3Target,
  credentials: Credentials,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<{ ok: boolean; status: number; etag: string | null }> => {
  const response = await awsClient(target, credentials).fetch(objectUrl(target, key), {
    method: 'PUT',
    body,
    headers: { 'content-type': contentType || 'application/octet-stream' },
  });
  // The body is drained so the connection can be reused.
  await response.body?.cancel();
  return {
    ok: response.ok,
    status: response.status,
    etag: response.headers.get('etag')?.replace(/"/g, '') ?? null,
  };
};

/**
 * A signed link the browser may follow for a limited time. It carries a
 * signature, never the secret that produced it, and it expires — which is why
 * extended-storage URLs are fetched on demand instead of being stored.
 */
const s3SignedUrl = async (
  target: S3Target,
  credentials: Credentials,
  key: string,
  expiresIn: number,
): Promise<string> => {
  const ttl = Math.min(Math.max(Math.round(expiresIn) || DEFAULT_URL_TTL, 60), MAX_URL_TTL);
  const signed = await awsClient(target, credentials).sign(
    `${objectUrl(target, key)}?X-Amz-Expires=${ttl}`,
    { method: 'GET', aws: { signQuery: true } },
  );
  return signed.url;
};

const s3Remove = async (
  target: S3Target,
  credentials: Credentials,
  keys: string[],
): Promise<{ removed: string[]; failed: string[] }> => {
  const client = awsClient(target, credentials);
  const removed: string[] = [];
  const failed: string[] = [];
  for (const key of keys) {
    const response = await client.fetch(objectUrl(target, key), { method: 'DELETE' });
    await response.body?.cancel();
    // S3 answers 204 for a delete and also for a key that was never there.
    if (response.ok || response.status === 404) removed.push(key); else failed.push(key);
  }
  return { removed, failed };
};

const s3Reachable = async (
  target: S3Target,
  credentials: Credentials,
): Promise<{ ready: boolean; reason: string | null }> => {
  const listUrl = target.pathStyle
    ? `${target.origin}/${target.bucket}?list-type=2&max-keys=1`
    : `${target.origin}?list-type=2&max-keys=1`;
  const response = await awsClient(target, credentials).fetch(listUrl, { method: 'GET' });
  await response.body?.cancel();
  if (response.ok) return { ready: true, reason: null };
  if (response.status === 403) return { ready: false, reason: 'STORAGE_CREDENTIALS_REJECTED' };
  if (response.status === 404) return { ready: false, reason: 'STORAGE_BUCKET_NOT_FOUND' };
  return { ready: false, reason: 'STORAGE_PROVIDER_UNREACHABLE' };
};

// ---------------------------------------------------------------------------
// Providers that are declared but not implemented
//
// These are honest stubs, not silent failures. Each one needs a piece of
// machinery this function does not have yet:
//
// google_drive
//   OAuth 2.0 with an offline refresh token per company. An implementation
//   needs: (a) a token endpoint call — POST https://oauth2.googleapis.com/token
//   with client_id, client_secret and the stored refresh_token — cached until
//   it expires; (b) resumable uploads — POST to
//   https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable with
//   the parent folder_id, then PUT the bytes to the session URI it returns;
//   (c) file ids rather than paths, so storage_objects.external_id becomes the
//   identity and `path` stays a display name; (d) permissions.create for a
//   shareable link, or a proxied download through this function.
//
// onedrive
//   The same OAuth dance against https://login.microsoftonline.com/common/
//   oauth2/v2.0/token with scope Files.ReadWrite.All offline_access, then the
//   Graph upload session — POST /v1.0/drives/{drive_id}/root:/{path}:/
//   createUploadSession and PUT the chunks. Short-lived links come from
//   /createLink with type=view and scope=anonymous.
//
// azure_blob
//   Storage account plus SAS. An implementation needs: (a) PUT
//   https://{account}.blob.core.windows.net/{container}/{blob}?{sas} with the
//   header x-ms-blob-type: BlockBlob; (b) a *user delegation* or account SAS
//   minted per request rather than the long-lived token pasted into the
//   connection screen, so a leaked link expires; (c) DELETE for removal.
//
// Until one of those exists the honest answer is a code the UI can explain, so
// the company is told its provider is not supported yet instead of watching an
// upload fail silently.
// ---------------------------------------------------------------------------

const NOT_IMPLEMENTED_PROVIDERS = new Set(['google_drive', 'onedrive', 'azure_blob']);

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

interface Caller {
  userId: string;
  tenantId: string;
  client: SupabaseClient;
}

const resolveCaller = async (
  request: Request,
  supabaseUrl: string,
  anonKey: string,
  admin: SupabaseClient,
): Promise<{ caller: Caller | null; error: string | null }> => {
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { caller: null, error: 'UNAUTHORIZED' };

  const { data: user, error } = await admin.auth.getUser(token);
  if (error || !user?.user) return { caller: null, error: 'UNAUTHORIZED' };

  // The caller's own client, so every RLS policy and every permission check
  // applies exactly as it would in the browser.
  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: tenantId, error: tenantError } = await client.rpc('current_tenant_id');
  if (tenantError || !tenantId) return { caller: null, error: 'NO_TENANT_CONTEXT' };

  return { caller: { userId: user.user.id, tenantId: String(tenantId), client }, error: null };
};

/**
 * The tenant check on a path only proves the file is inside the caller's own
 * company folder, not that this particular employee may reach it — every
 * upload made by every colleague lives under the same tenants/{id}/ prefix.
 * public.storage_objects already carries that finer boundary (owner_id /
 * created_by / Storage.Manage) as an RLS policy; querying it through the
 * caller's own client, instead of the admin client used for everything else
 * here, reuses that policy as the actual authorization check rather than
 * re-deriving it.
 */
const hasStorageManage = async (caller: Caller): Promise<boolean> => {
  const { data } = await caller.client.rpc('has_permission', { permission_code: 'Storage.Manage' });
  return Boolean(data);
};

/** True once every path is backed by a ledger row the caller is allowed to see. */
// Reads through caller.client (the caller's own JWT, not the admin client),
// so this is RLS-scoped by construction: since storage_objects' only write
// path is now the SECURITY DEFINER storage_register()/storage_unregister()
// RPCs (direct client INSERT/UPDATE/DELETE closed off, closing-audit
// Blocker), every row this query can even see is one the caller genuinely
// owns or created — not a self-forged row pointing at someone else's real
// path. tenant_id is filtered explicitly too, not left to RLS alone, since
// this result gates a real delete/signed-URL grant.
const ownsAllPaths = async (caller: Caller, paths: string[]): Promise<boolean> => {
  if (paths.length === 0) return false;
  const { data } = await caller.client
    .from('storage_objects')
    .select('path')
    .eq('tenant_id', caller.tenantId)
    .eq('is_deleted', false)
    .in('path', paths);
  const owned = new Set((data ?? []).map((row) => (row as { path: string }).path));
  return paths.every((path) => owned.has(path));
};

const loadConfig = async (
  admin: SupabaseClient,
  tenantId: string,
): Promise<{ config: StorageConfig | null; error: string | null }> => {
  const { data, error } = await admin
    .from('tenant_storage_config')
    .select('tenant_id, provider_code, is_enabled, config, credential_ref, root_path')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) return { config: null, error: asErrorCode(error, 'STORAGE_CONFIG_READ_FAILED') };
  if (!data) return { config: null, error: 'STORAGE_PROVIDER_NOT_CONFIGURED' };

  const config = data as StorageConfig;
  if (!config.provider_code || config.provider_code === 'none') {
    return { config: null, error: 'STORAGE_PROVIDER_NOT_CONFIGURED' };
  }
  if (!config.is_enabled) return { config: null, error: 'STORAGE_SUSPENDED' };
  return { config, error: null };
};

const recordCheck = async (
  admin: SupabaseClient,
  tenantId: string,
  status: 'Ok' | 'Failed',
  message: string | null,
): Promise<void> => {
  await admin
    .from('tenant_storage_config')
    .update({ last_check_on: new Date().toISOString(), last_check_status: status, last_check_message: message })
    .eq('tenant_id', tenantId);
};

const handle = async (request: Request): Promise<Response> => {
  if (isPreflight(request)) return preflightResponse(request, CORS);
  if (request.method !== 'POST') {
    return errorResponse('METHOD_NOT_ALLOWED', { status: 405, request, ...CORS });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return errorResponse('SUPABASE_NOT_CONFIGURED', { status: 500, request, ...CORS });
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  const { caller, error: callerError } = await resolveCaller(request, supabaseUrl, anonKey, admin);
  if (!caller) {
    return errorResponse(callerError ?? 'UNAUTHORIZED', {
      status: callerError === 'UNAUTHORIZED' ? 401 : 200,
      request,
      ...CORS,
    });
  }

  // The action travels in a header so a multipart upload does not have to be
  // parsed before it is known what to do with it.
  const headerAction = (request.headers.get('x-storage-action') ?? '').trim().toLowerCase();
  const contentType = request.headers.get('content-type') ?? '';
  const isMultipart = contentType.includes('multipart/form-data');

  let body: Record<string, unknown> = {};
  let form: FormData | null = null;
  if (isMultipart) {
    form = await request.formData();
  } else {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  }

  const action = headerAction || String(body.action ?? '').trim().toLowerCase() || (isMultipart ? 'upload' : '');
  if (!['upload', 'url', 'remove', 'status'].includes(action)) {
    return errorResponse('STORAGE_ACTION_INVALID', { request, ...CORS });
  }

  const { config, error: configError } = await loadConfig(admin, caller.tenantId);
  if (!config) {
    // `status` answers rather than refuses: the UI asks it precisely to find
    // out that nothing is connected.
    if (action === 'status') {
      return jsonResponse({ ok: true, ready: false, reason: configError }, { request, ...CORS });
    }
    return errorResponse(configError ?? 'STORAGE_PROVIDER_NOT_CONFIGURED', { request, ...CORS });
  }

  if (NOT_IMPLEMENTED_PROVIDERS.has(config.provider_code ?? '')) {
    const payload = { ok: false, error: 'STORAGE_PROVIDER_NOT_IMPLEMENTED', provider: config.provider_code };
    return action === 'status'
      ? jsonResponse({ ...payload, ok: true, ready: false, reason: 'STORAGE_PROVIDER_NOT_IMPLEMENTED' }, { request, ...CORS })
      : jsonResponse(payload, { request, ...CORS });
  }

  if (!S3_COMPATIBLE.has(config.provider_code ?? '')) {
    return errorResponse('STORAGE_PROVIDER_NOT_SUPPORTED', { request, ...CORS, detail: { provider: config.provider_code } });
  }

  const { target, error: targetError } = targetFor(config);
  if (!target) {
    if (action === 'status') {
      return jsonResponse({ ok: true, ready: false, reason: targetError }, { request, ...CORS });
    }
    return errorResponse(targetError ?? 'STORAGE_PROVIDER_NOT_CONFIGURED', { request, ...CORS });
  }

  const credentials = credentialsFor(config);
  if (!credentials) {
    if (action === 'status') {
      return jsonResponse({ ok: true, ready: false, reason: 'STORAGE_CREDENTIALS_MISSING' }, { request, ...CORS });
    }
    return errorResponse('STORAGE_CREDENTIALS_MISSING', { request, ...CORS });
  }

  // ---- status ------------------------------------------------------------
  if (action === 'status') {
    let ready = false;
    let reason: string | null = 'STORAGE_PROVIDER_UNREACHABLE';
    try {
      const check = await s3Reachable(target, credentials);
      ready = check.ready;
      reason = check.reason;
    } catch (error) {
      reason = asErrorCode(error, 'STORAGE_PROVIDER_UNREACHABLE');
    }
    await recordCheck(admin, caller.tenantId, ready ? 'Ok' : 'Failed', reason);
    return jsonResponse({ ok: true, ready, reason, provider: config.provider_code }, { request, ...CORS });
  }

  // ---- upload ------------------------------------------------------------
  if (action === 'upload') {
    if (!form) return errorResponse('STORAGE_UPLOAD_INVALID', { request, ...CORS });
    const file = form.get('file');
    const path = cleanPath(form.get('path'));
    const declaredType = String(form.get('contentType') ?? '').trim();

    if (!(file instanceof File)) return errorResponse('STORAGE_FILE_REQUIRED', { request, ...CORS });
    if (!pathBelongsToTenant(path, caller.tenantId)) {
      return errorResponse('STORAGE_PATH_NOT_ALLOWED', { request, ...CORS });
    }

    const mime = declaredType || file.type || 'application/octet-stream';

    // The same five checks the browser was told about, decided by the database
    // this time: extended storage on, provider healthy, quota, type, size.
    const { data: allowance, error: allowanceError } = await caller.client.rpc('storage_can_upload', {
      p_layer: 'Extended',
      p_mime: mime,
      p_size: file.size,
    });
    if (allowanceError) {
      return errorResponse(asErrorCode(allowanceError, 'STORAGE_CHECK_FAILED'), { request, ...CORS });
    }
    if (!allowance?.allowed) {
      return errorResponse(String(allowance?.reason ?? 'UPLOAD_REFUSED'), { request, ...CORS });
    }

    const key = objectKey(config.root_path, path);
    const bytes = new Uint8Array(await file.arrayBuffer());

    let result;
    try {
      result = await s3Upload(target, credentials, key, bytes, mime);
    } catch (error) {
      await recordCheck(admin, caller.tenantId, 'Failed', asErrorCode(error, 'STORAGE_PROVIDER_UNREACHABLE'));
      return errorResponse('STORAGE_UPLOAD_FAILED', { request, ...CORS });
    }
    if (!result.ok) {
      await recordCheck(admin, caller.tenantId, 'Failed', `HTTP ${result.status}`);
      return errorResponse(result.status === 403 ? 'STORAGE_CREDENTIALS_REJECTED' : 'STORAGE_UPLOAD_FAILED', {
        request,
        ...CORS,
      });
    }

    await recordCheck(admin, caller.tenantId, 'Ok', null);

    // The ledger row (public.storage_register) is written by the caller, which
    // already knows the entity the file belongs to.
    return jsonResponse({
      ok: true,
      path,
      url: await s3SignedUrl(target, credentials, key, DEFAULT_URL_TTL),
      externalId: result.etag,
      expiresIn: DEFAULT_URL_TTL,
    }, { request, ...CORS });
  }

  // ---- url ---------------------------------------------------------------
  if (action === 'url') {
    const path = cleanPath(body.path);
    if (!pathBelongsToTenant(path, caller.tenantId)) {
      return errorResponse('STORAGE_PATH_NOT_ALLOWED', { request, ...CORS });
    }
    if (!(await hasStorageManage(caller)) && !(await ownsAllPaths(caller, [path]))) {
      return errorResponse('STORAGE_ACCESS_DENIED', { request, ...CORS });
    }
    const expiresIn = Number(body.expiresIn ?? DEFAULT_URL_TTL);
    try {
      const url = await s3SignedUrl(target, credentials, objectKey(config.root_path, path), expiresIn);
      return jsonResponse({ ok: true, path, url, expiresIn }, { request, ...CORS });
    } catch (error) {
      return errorResponse(asErrorCode(error, 'STORAGE_URL_FAILED'), { request, ...CORS });
    }
  }

  // ---- remove ------------------------------------------------------------
  const rawPaths = Array.isArray(body.paths) ? body.paths : [body.path];
  const paths = rawPaths.map(cleanPath).filter(Boolean);
  if (paths.length === 0) return errorResponse('STORAGE_PATH_REQUIRED', { request, ...CORS });
  if (paths.some((path) => !pathBelongsToTenant(path, caller.tenantId))) {
    return errorResponse('STORAGE_PATH_NOT_ALLOWED', { request, ...CORS });
  }
  if (!(await hasStorageManage(caller)) && !(await ownsAllPaths(caller, paths))) {
    return errorResponse('STORAGE_ACCESS_DENIED', { request, ...CORS });
  }

  try {
    const outcome = await s3Remove(target, credentials, paths.map((path) => objectKey(config.root_path, path)));
    if (outcome.failed.length > 0) {
      return errorResponse('STORAGE_REMOVE_FAILED', { request, ...CORS, detail: { failed: outcome.failed.length } });
    }
    return jsonResponse({ ok: true, removed: paths.length }, { request, ...CORS });
  } catch (error) {
    return errorResponse(asErrorCode(error, 'STORAGE_REMOVE_FAILED'), { request, ...CORS });
  }
};

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handle(request);
    } catch (error) {
      return errorResponse(asErrorCode(error, 'STORAGE_PROXY_FAILED'), { status: 500, request, ...CORS });
    }
  },
};
