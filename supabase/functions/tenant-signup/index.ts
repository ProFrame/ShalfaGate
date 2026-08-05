// The public subscription endpoint.
//
// Somebody fills in bbnovix.com/signup and presses save. A second later a
// complete company exists at bbnovix.com/{slug}/, its administrator is employee
// number 1 with an active account, and a welcome message carrying a
// password-set link is on its way. This function is the only thing standing
// between an anonymous visitor and that outcome, so it does the work in an
// order that can always be undone:
//
//   validate → rate limit → file the request → stage the images →
//   create the auth identity → provision (one DB transaction) →
//   move the images under the new company → queue the welcome mail
//
// Everything before the auth identity is harmless on its own. Everything after
// it is compensated: if provisioning fails, the auth user is deleted again so
// the visitor can simply press save a second time.
//
// Answers are 200 with a machine code in the body rather than a 4xx, because
// supabase-js hides the body of a non-2xx answer from the browser and the form
// must be able to say "that address was taken" instead of "something failed".

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import {
  MemoryRateLimiter,
  asErrorCode,
  clientIp,
  errorResponse,
  isPreflight,
  jsonResponse,
  preflightResponse,
  userAgent,
} from '../_shared/cors.ts';

const CORS = { methods: 'POST, OPTIONS' };

const BRANDING_BUCKET = 'tenant-branding';

/** Kept in step with public.platform_reserved_slugs and src/lib/routing.js. */
const RESERVED_SLUGS = new Set([
  'platform', 'portal', 'verify', 'support', 'signup', 'api', 'app', 'admin',
  'login', 'logout', 'auth', 'reset-password', 'assets', 'static', 'data',
  'public', 'www', 'mail', 'cdn', 'status', 'docs', 'help', 'billing',
  'account', 'settings', 'bbnovix', 'null', 'undefined',
]);

const SLUG_PATTERN = /^[a-z0-9]{2,32}$/;
const LANGUAGE_PATTERN = /^[a-z]{2}(-[a-z]{2})?$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Mirrors SIGNUP_LIMITS in src/data/publicService.js; the browser checks the
 *  same numbers first, this is the copy that actually decides. */
const LOGO_MAX_BYTES = 512 * 1024;
const COVER_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon',
]);

const CONTACT_CHANNELS = new Set([
  'email', 'mobile', 'whatsapp', 'phone', 'fax', 'address', 'website',
]);

/** Two ceilings per address: a burst limiter inside this isolate, and a count
 *  of the rows the address actually produced, which survives a cold start. */
const burstLimiter = new MemoryRateLimiter(10, 60_000);
const HOURLY_LIMIT = 5;
const DAILY_LIMIT = 15;

interface AssetInput {
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  content_base64?: string;
}

interface StagedAsset {
  path: string;
  url: string;
}

const text = (value: unknown): string | null => {
  const clean = String(value ?? '').trim();
  return clean ? clean : null;
};

const appUrl = (): string => (Deno.env.get('APP_URL') ?? 'https://bbnovix.com').replace(/\/+$/, '');

const companyUrl = (slug: string): string => `${appUrl()}/${slug}/`;

const passwordSetUrl = (slug: string): string =>
  `${appUrl()}/${slug}/reset-password?auth_action=set-password`;

/**
 * Runs work the caller does not need to wait for. The visitor should see the
 * success screen as soon as the company exists, not after Gmail has answered.
 */
const runInBackground = (work: Promise<unknown>): void => {
  const guarded = work.catch(() => undefined);
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(guarded);
};

// ---------------------------------------------------------------------------
// Validation. Every rejection is a code the form can translate.
// ---------------------------------------------------------------------------

const validate = (payload: Record<string, unknown>): string | null => {
  const slug = String(payload.slug ?? '').trim().toLowerCase();
  if (!slug) return 'SLUG_REQUIRED';
  if (!SLUG_PATTERN.test(slug)) return 'SLUG_INVALID';
  if (RESERVED_SLUGS.has(slug)) return 'TENANT_SLUG_RESERVED';

  const language = String(payload.default_language ?? '').trim().toLowerCase();
  if (!language) return 'DEFAULT_LANGUAGE_REQUIRED';
  if (!LANGUAGE_PATTERN.test(language)) return 'LANGUAGE_CODE_INVALID';

  const names = (payload.names ?? {}) as Record<string, unknown>;
  if (typeof names !== 'object' || Array.isArray(names)) return 'COMPANY_NAME_REQUIRED';
  if (!text(names[language])) return 'COMPANY_NAME_REQUIRED';
  if (Object.keys(names).some((code) => !LANGUAGE_PATTERN.test(code.toLowerCase()))) {
    return 'LANGUAGE_CODE_INVALID';
  }

  const administrator = (payload.administrator ?? {}) as Record<string, unknown>;
  if (!text(administrator.full_name)) return 'OWNER_NAME_REQUIRED';
  const email = String(administrator.email ?? '').trim().toLowerCase();
  if (!email) return 'OWNER_EMAIL_REQUIRED';
  if (!EMAIL_PATTERN.test(email)) return 'OWNER_EMAIL_INVALID';

  const country = text(payload.country_code);
  if (country && !/^[A-Za-z]{2}$/.test(country)) return 'COUNTRY_CODE_INVALID';

  const branding = (payload.branding ?? {}) as Record<string, unknown>;
  for (const key of ['primary_color', 'secondary_color']) {
    const color = text(branding[key]) ?? text((payload as Record<string, unknown>)[key]);
    if (color && !COLOR_PATTERN.test(color)) return 'COLOR_INVALID';
  }

  const contacts = payload.contacts;
  if (contacts && !Array.isArray(contacts)) return 'CONTACT_CHANNEL_INVALID';
  if (Array.isArray(contacts)) {
    for (const entry of contacts as Array<Record<string, unknown>>) {
      if (!text(entry?.value)) continue;
      if (!CONTACT_CHANNELS.has(String(entry?.channel ?? '').trim().toLowerCase())) {
        return 'CONTACT_CHANNEL_INVALID';
      }
    }
  }

  const assets = (payload.assets ?? {}) as Record<string, AssetInput | null>;
  const logoProblem = validateAsset(assets.logo, LOGO_MAX_BYTES, 'LOGO');
  if (logoProblem) return logoProblem;
  const coverProblem = validateAsset(assets.cover, COVER_MAX_BYTES, 'COVER');
  if (coverProblem) return coverProblem;

  return null;
};

const validateAsset = (asset: AssetInput | null | undefined, maxBytes: number, label: string): string | null => {
  if (!asset || !asset.content_base64) return null;
  const mime = String(asset.mime_type ?? '').trim().toLowerCase();
  if (!mime.startsWith('image/') || !IMAGE_TYPES.has(mime)) return `${label}_TYPE_NOT_ALLOWED`;
  // The declared size is advisory; the decoded length below is what counts, but
  // an obviously oversized declaration is refused before decoding megabytes.
  const declared = Number(asset.file_size ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return `${label}_TOO_LARGE`;
  return null;
};

const decodeBase64 = (value: string): Uint8Array => {
  const clean = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  const binary = atob(clean.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const extensionFor = (mime: string, fileName?: string): string => {
  const fromName = String(fileName ?? '').split('.').pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  return ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/x-icon': 'ico',
  } as Record<string, string>)[mime] ?? 'bin';
};

// ---------------------------------------------------------------------------
// Storage
//
// The images arrive before the company they belong to exists, so they are
// written to a staging folder keyed by the signup request and moved under
// tenants/{tenant_id}/branding/ the moment provisioning returns an id. The
// final layout is the one every other module expects.
// ---------------------------------------------------------------------------

const stageAsset = async (
  admin: SupabaseClient,
  asset: AssetInput | null | undefined,
  requestId: string,
  kind: 'logo' | 'cover',
  maxBytes: number,
): Promise<{ staged: StagedAsset | null; error: string | null }> => {
  if (!asset || !asset.content_base64) return { staged: null, error: null };

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(asset.content_base64);
  } catch {
    return { staged: null, error: 'FILE_READ_FAILED' };
  }
  if (bytes.byteLength === 0) return { staged: null, error: 'FILE_READ_FAILED' };
  if (bytes.byteLength > maxBytes) {
    return { staged: null, error: kind === 'logo' ? 'LOGO_TOO_LARGE' : 'COVER_TOO_LARGE' };
  }

  const mime = String(asset.mime_type ?? 'image/png').toLowerCase();
  const path = `tenants/pending/${requestId}/${kind}.${extensionFor(mime, asset.file_name)}`;
  const { error } = await admin.storage
    .from(BRANDING_BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: true, cacheControl: '3600' });
  if (error) return { staged: null, error: 'ASSET_UPLOAD_FAILED' };

  const { data } = admin.storage.from(BRANDING_BUCKET).getPublicUrl(path);
  return { staged: { path, url: data.publicUrl }, error: null };
};

/** Moves a staged image under the company that now owns it. A failure here is
 *  cosmetic — the staged URL keeps working — so it never fails the signup. */
const settleAsset = async (
  admin: SupabaseClient,
  staged: StagedAsset | null,
  tenantId: string,
  kind: 'logo' | 'cover',
): Promise<StagedAsset | null> => {
  if (!staged) return null;
  const extension = staged.path.split('.').pop() ?? 'png';
  const destination = `tenants/${tenantId}/branding/${kind}.${extension}`;
  const { error } = await admin.storage.from(BRANDING_BUCKET).move(staged.path, destination);
  if (error) return staged;
  const { data } = admin.storage.from(BRANDING_BUCKET).getPublicUrl(destination);
  return { path: destination, url: data.publicUrl };
};

const discardAssets = async (admin: SupabaseClient, staged: Array<StagedAsset | null>): Promise<void> => {
  const paths = staged.filter(Boolean).map((asset) => (asset as StagedAsset).path);
  if (paths.length === 0) return;
  await admin.storage.from(BRANDING_BUCKET).remove(paths);
};

// ---------------------------------------------------------------------------
// Rate limiting — public.tenant_signup_requests is the ledger
// ---------------------------------------------------------------------------

const overRateLimit = async (admin: SupabaseClient, ip: string | null): Promise<boolean> => {
  if (!ip) return false;
  if (!burstLimiter.take(ip)) return true;

  const since = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  const [hour, day] = await Promise.all([
    admin.from('tenant_signup_requests')
      .select('id', { count: 'exact', head: true })
      .eq('ip', ip)
      .gte('created_on', since(60)),
    admin.from('tenant_signup_requests')
      .select('id', { count: 'exact', head: true })
      .eq('ip', ip)
      .gte('created_on', since(60 * 24)),
  ]);

  if ((hour.count ?? 0) >= HOURLY_LIMIT) return true;
  if ((day.count ?? 0) >= DAILY_LIMIT) return true;
  return false;
};

// ---------------------------------------------------------------------------
// The welcome mail
//
// public.provision_tenant queues it inside the same transaction that creates
// the company, which is the behaviour we want: no company exists without its
// welcome message. This is the safety net for the one case the RPC cannot
// cover — the TENANT_WELCOME template missing from the platform tenant.
// ---------------------------------------------------------------------------

const ensureWelcomeEmail = async (
  admin: SupabaseClient,
  options: { tenantId: string; slug: string; companyName: string; ownerName: string; email: string; language: string; passwordLink: string },
): Promise<boolean> => {
  const language = ['ar', 'en'].includes(options.language) ? options.language : 'en';

  const { count } = await admin
    .from('email_queue')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_email', options.email)
    .filter('template_data->>tenant_id', 'eq', options.tenantId);
  if ((count ?? 0) > 0) return true;

  const { data: template } = await admin
    .from('email_templates')
    .select('id, tenant_id')
    .eq('code', 'TENANT_WELCOME')
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!template?.id) return false;

  const { error } = await admin.from('email_queue').insert({
    tenant_id: template.tenant_id,
    recipient_email: options.email,
    template_id: template.id,
    language,
    priority: 1,
    template_data: {
      tenant_id: options.tenantId,
      slug: options.slug,
      company_name: options.companyName,
      company_url: companyUrl(options.slug),
      login_url: `${companyUrl(options.slug)}login`,
      owner_name: options.ownerName,
      user_name: options.email,
      password_link: options.passwordLink,
    },
  });
  return !error;
};

/** Nudges the queue worker so the visitor's message goes out now rather than at
 *  the next scheduled run. Never allowed to affect the answer. */
const kickMailWorker = (supabaseUrl: string, serviceKey: string): void => {
  if ((Deno.env.get('SEND_EMAIL_ON_SIGNUP') ?? 'true').toLowerCase() === 'false') return;
  runInBackground(fetch(`${supabaseUrl}/functions/v1/send-email`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ batchSize: 5 }),
  }));
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const handle = async (request: Request): Promise<Response> => {
  if (isPreflight(request)) return preflightResponse(request, CORS);
  if (request.method !== 'POST') {
    return errorResponse('METHOD_NOT_ALLOWED', { status: 405, request, ...CORS });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceKey) {
    return errorResponse('SUPABASE_NOT_CONFIGURED', { status: 500, request, ...CORS });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return errorResponse('PAYLOAD_INVALID', { request, ...CORS });
  }

  const problem = validate(payload);
  if (problem) return errorResponse(problem, { request, ...CORS });

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  const ip = clientIp(request);
  const agent = userAgent(request);
  if (await overRateLimit(admin, ip)) {
    return errorResponse('RATE_LIMITED', {
      request,
      ...CORS,
      detail: { retry_after_seconds: 3600 },
    });
  }

  // ---- normalised inputs -------------------------------------------------
  const slug = String(payload.slug).trim().toLowerCase();
  const language = String(payload.default_language).trim().toLowerCase();
  const names = payload.names as Record<string, string>;
  const companyName = String(text(names[language]));
  const administrator = payload.administrator as Record<string, unknown>;
  const ownerEmail = String(administrator.email).trim().toLowerCase();
  const ownerName = String(text(administrator.full_name));
  const ownerPhone = text(administrator.phone);
  const branding = (payload.branding ?? {}) as Record<string, unknown>;
  const assets = (payload.assets ?? {}) as Record<string, AssetInput | null>;

  // ---- the address is still free ----------------------------------------
  const { data: availability, error: availabilityError } = await admin.rpc('slug_is_available', { p_slug: slug });
  if (availabilityError) {
    return errorResponse(asErrorCode(availabilityError, 'SIGNUP_FAILED'), { request, ...CORS });
  }
  if (!availability?.available) {
    const reason = String(availability?.reason ?? 'SLUG_INVALID');
    const mapped = reason === 'TAKEN' ? 'SLUG_TAKEN' : reason === 'RESERVED' ? 'TENANT_SLUG_RESERVED' : 'SLUG_INVALID';
    return errorResponse(mapped, { request, ...CORS });
  }

  // ---- 1. the raw request, filed before anything is created --------------
  // The base64 blobs are deliberately stripped: the audit trail keeps what
  // was asked for, not several megabytes of image.
  const auditPayload = {
    ...payload,
    assets: {
      logo: assets.logo ? { file_name: assets.logo.file_name, mime_type: assets.logo.mime_type, file_size: assets.logo.file_size } : null,
      cover: assets.cover ? { file_name: assets.cover.file_name, mime_type: assets.cover.mime_type, file_size: assets.cover.file_size } : null,
    },
  };

  const { data: signupRequest, error: requestError } = await admin
    .from('tenant_signup_requests')
    .insert({
      slug,
      company_name: companyName,
      requested_by_name: ownerName,
      requested_by_email: ownerEmail,
      requested_by_phone: ownerPhone,
      is_owner: String(administrator.relationship ?? 'owner').toLowerCase() === 'owner',
      payload: auditPayload,
      status: 'Pending',
      ip,
      user_agent: agent,
    })
    .select('id')
    .single();
  if (requestError || !signupRequest?.id) {
    return errorResponse(asErrorCode(requestError, 'SIGNUP_REQUEST_FAILED'), { request, ...CORS });
  }
  const requestId = String(signupRequest.id);

  const abandon = async (code: string, staged: Array<StagedAsset | null>, authUserId?: string | null) => {
    if (authUserId) await admin.auth.admin.deleteUser(authUserId).catch(() => undefined);
    await discardAssets(admin, staged);
    await admin
      .from('tenant_signup_requests')
      .update({ status: 'Rejected', review_note: code })
      .eq('id', requestId);
    return errorResponse(code, { request, ...CORS });
  };

  // ---- 2. the images -----------------------------------------------------
  const logoResult = await stageAsset(admin, assets.logo, requestId, 'logo', LOGO_MAX_BYTES);
  if (logoResult.error) return abandon(logoResult.error, [logoResult.staged]);
  const coverResult = await stageAsset(admin, assets.cover, requestId, 'cover', COVER_MAX_BYTES);
  if (coverResult.error) return abandon(coverResult.error, [logoResult.staged, coverResult.staged]);
  const stagedAssets = [logoResult.staged, coverResult.staged];

  // ---- 3. the administrator's identity -----------------------------------
  // No tenant_id in the metadata on purpose: handle_new_user does nothing
  // when it cannot resolve a company, which is exactly the state we need —
  // provision_tenant creates the employee row itself and refuses to run if
  // one already exists.
  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(ownerEmail, {
    redirectTo: passwordSetUrl(slug),
    data: {
      full_name: ownerName,
      mobile: ownerPhone,
      signup_slug: slug,
      signup_request_id: requestId,
      preferred_language: language,
    },
  });

  let authUserId: string | null = invited?.user?.id ?? null;
  // True only when this request is what created the identity. It decides
  // whether a later failure may delete it again — deleting somebody else's
  // account because our provisioning failed would be unforgivable.
  const createdIdentity = Boolean(authUserId);
  let passwordLink = passwordSetUrl(slug);

  // The recovery link serves two purposes. It is the branded "set your
  // password" address for the welcome message, and — when the invitation
  // failed *after* creating the identity, which is what a bounced built-in
  // invite mail looks like — it is how that identity is found again, so a
  // half-finished attempt can be completed instead of dead-ending.
  const { data: link } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: ownerEmail,
    options: { redirectTo: passwordSetUrl(slug) },
  });
  const actionLink = (link?.properties as { action_link?: string } | undefined)?.action_link;
  if (actionLink) passwordLink = actionLink;
  if (!authUserId && link?.user?.id) authUserId = link.user.id;

  if (!authUserId) {
    const raw = String(inviteError?.message ?? '').toLowerCase();
    const alreadyRegistered = raw.includes('already been registered')
      || raw.includes('already registered')
      || raw.includes('email_exists')
      || raw.includes('user already exists');
    return abandon(alreadyRegistered ? 'EMAIL_IN_USE' : asErrorCode(inviteError, 'OWNER_INVITE_FAILED'), stagedAssets);
  }

  // ---- 4. the company ----------------------------------------------------
  const provisionPayload = {
    slug,
    default_language: language,
    names,
    legal_name: text(payload.legal_name),
    country_code: text(payload.country_code),
    timezone: text(payload.timezone),
    industry: text(payload.industry),
    employee_range: text(payload.employee_range),
    tax_number: text(payload.tax_number),
    commercial_register: text(payload.commercial_register),
    theme_preset: text(branding.theme_preset) ?? text(branding.code),
    primary_color: text(branding.primary_color),
    secondary_color: text(branding.secondary_color),
    map_url: text(branding.map_url),
    website_url: text(branding.website_url),
    logo_url: logoResult.staged?.url ?? null,
    hero_image_url: coverResult.staged?.url ?? null,
    contacts: Array.isArray(payload.contacts)
      ? (payload.contacts as Array<Record<string, unknown>>)
        .filter((entry) => text(entry?.value))
        .map((entry) => ({ channel: String(entry.channel).toLowerCase(), value: String(entry.value).trim() }))
      : [],
    owner: {
      auth_user_id: authUserId,
      name_1: ownerName,
      email: ownerEmail,
      mobile: ownerPhone,
      is_owner: String(administrator.relationship ?? 'owner').toLowerCase() === 'owner',
      password_link: passwordLink,
    },
    password_link: passwordLink,
    signup_request_id: requestId,
    ip,
    user_agent: agent,
  };

  const { data: provisioned, error: provisionError } = await admin.rpc('provision_tenant', {
    p_payload: provisionPayload,
  });

  if (provisionError || !provisioned?.tenant_id) {
    const code = asErrorCode(provisionError, 'SIGNUP_FAILED');
    const mapped = code === 'SLUG_UNAVAILABLE'
      ? 'SLUG_TAKEN'
      : code === 'SLUG_RESERVED'
        ? 'TENANT_SLUG_RESERVED'
        : code === 'OWNER_ALREADY_REGISTERED'
          ? 'EMAIL_IN_USE'
          : code;
    return abandon(mapped, stagedAssets, createdIdentity ? authUserId : null);
  }

  const tenantId = String(provisioned.tenant_id);

  // ---- 5. the images move in with their company --------------------------
  const [logoFinal, coverFinal] = await Promise.all([
    settleAsset(admin, logoResult.staged, tenantId, 'logo'),
    settleAsset(admin, coverResult.staged, tenantId, 'cover'),
  ]);
  if (logoFinal?.url !== logoResult.staged?.url || coverFinal?.url !== coverResult.staged?.url) {
    await admin
      .from('tenant_branding')
      .update({
        logo_light_url: logoFinal?.url ?? null,
        hero_image_url: coverFinal?.url ?? null,
      })
      .eq('tenant_id', tenantId);
  }

  // ---- 6. the welcome message -------------------------------------------
  const queued = await ensureWelcomeEmail(admin, {
    tenantId,
    slug,
    companyName,
    ownerName,
    email: ownerEmail,
    language,
    passwordLink,
  });
  if (queued) kickMailWorker(supabaseUrl, serviceKey);

  return jsonResponse({
    ok: true,
    slug,
    url: String(provisioned.url ?? companyUrl(slug)),
    ownerEmail,
    // The browser client reads these names; both spellings describe the same
    // administrator so neither side has to translate the other's wire format.
    admin_email: ownerEmail,
    tenant_id: tenantId,
    owner_user_id: authUserId,
    signup_request_id: requestId,
    email_sent: queued,
  }, { request, ...CORS });
};

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handle(request);
    } catch (error) {
      // Even an unexpected throw answers with CORS headers and a code, so the
      // form shows a message instead of a browser console error.
      return errorResponse(asErrorCode(error, 'SIGNUP_FAILED'), { status: 500, request, ...CORS });
    }
  },
};
