// Data access for the three pages that live outside every company:
// the product site (/portal), the subscription form (/signup) and the public
// support desk (/support).
//
// Everything here is anonymous. There is no session, no tenant and therefore no
// row level security to lean on, so every read and write goes through an RPC or
// an edge function that the platform has explicitly granted to `anon`.
//
// House rules honoured here:
//   * no component ever imports `supabase` — it imports this file;
//   * every function returns `{ data, error }` and never throws;
//   * `useLocalData` keeps the local preview fully usable without a backend.

import { supabase, useLocalData } from '../lib/supabaseClient';
import { CORE_BUCKETS, STORAGE_LAYER } from '../lib/storage';
import { isReservedSlug, isValidSlug } from '../lib/routing';
import { errorFromMessage } from './serviceEnvelope';

// ---------------------------------------------------------------------------
// Reference data. Values are CODES; the label is resolved at render time from
// the publicsite dictionary, so nothing here is user-facing text.
// ---------------------------------------------------------------------------

/** Theme presets offered on the subscription form and applied to the company. */
export const THEME_PRESETS = [
  { code: 'aurora', primary_color: '#0f766e', secondary_color: '#0b3b60', accent_color: '#f59e0b' },
  { code: 'midnight', primary_color: '#1b4f82', secondary_color: '#0d1c33', accent_color: '#38bdf8' },
  { code: 'sand', primary_color: '#a3671b', secondary_color: '#4a3418', accent_color: '#0ea5e9' },
  { code: 'emerald', primary_color: '#15803d', secondary_color: '#0f3d24', accent_color: '#facc15' },
  { code: 'royal', primary_color: '#5b34a8', secondary_color: '#2b1a52', accent_color: '#f472b6' },
  { code: 'graphite', primary_color: '#334155', secondary_color: '#0f172a', accent_color: '#f97316' },
];

export const INDUSTRY_CODES = [
  'construction', 'facilities', 'healthcare', 'education', 'retail', 'technology',
  'finance', 'logistics', 'manufacturing', 'hospitality', 'energy', 'government',
  'nonprofit', 'other',
];

export const COMPANY_SIZE_CODES = ['micro', 'small', 'medium', 'large', 'enterprise'];

/** Public contact channels, matching public.tenant_contacts.channel. */
export const CONTACT_CHANNELS = ['email', 'mobile', 'whatsapp', 'phone', 'fax', 'address'];

export const RELATIONSHIP_CODES = ['owner', 'officer'];

export const SUPPORT_CATEGORIES = [
  'technical', 'subscription', 'account', 'feature', 'billing', 'other',
];

// support_ticket_create()'s category check only knows five values and does not
// recognise "subscription" at all; a licensing question is a billing one as
// far as the ticket queue is concerned. The option itself stays on the form —
// only the stored category is mapped.
const SUPPORT_CATEGORY_DB_VALUE = {
  technical: 'Technical',
  subscription: 'Billing',
  account: 'Account',
  feature: 'Feature',
  billing: 'Billing',
  other: 'Other',
};

/** Countries offered on the form; the label comes from Intl.DisplayNames. */
export const COUNTRY_CODES = [
  'SA', 'AE', 'QA', 'KW', 'BH', 'OM', 'YE', 'JO', 'LB', 'SY', 'IQ', 'PS',
  'EG', 'SD', 'LY', 'TN', 'DZ', 'MA', 'MR', 'SO', 'DJ', 'KM',
  'TR', 'IR', 'PK', 'IN', 'BD', 'LK', 'NP', 'PH', 'ID', 'MY', 'SG', 'TH', 'VN',
  'CN', 'JP', 'KR', 'AU', 'NZ',
  'GB', 'IE', 'FR', 'DE', 'ES', 'PT', 'IT', 'NL', 'BE', 'CH', 'AT', 'SE', 'NO',
  'DK', 'FI', 'PL', 'RO', 'GR', 'RU', 'UA',
  'US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO',
  'NG', 'GH', 'KE', 'ET', 'TZ', 'UG', 'ZA',
];

/** Upload ceilings, enforced in the browser and again by the edge function. */
export const SIGNUP_LIMITS = {
  logoBytes: 512 * 1024,
  coverBytes: 2 * 1024 * 1024,
  logoTypes: ['image/png', 'image/svg+xml', 'image/webp'],
  coverTypes: ['image/jpeg', 'image/png', 'image/webp'],
};

const FALLBACK_TIMEZONES = [
  'Asia/Riyadh', 'Asia/Dubai', 'Asia/Qatar', 'Asia/Kuwait', 'Asia/Bahrain',
  'Asia/Muscat', 'Asia/Amman', 'Asia/Beirut', 'Asia/Baghdad', 'Africa/Cairo',
  'Africa/Khartoum', 'Africa/Tunis', 'Africa/Algiers', 'Africa/Casablanca',
  'Europe/Istanbul', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Manila',
  'Asia/Jakarta', 'Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Shanghai',
  'Asia/Tokyo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
  'Europe/Rome', 'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Australia/Sydney', 'UTC',
];

/**
 * Every IANA zone the runtime knows about, or a curated list when the browser
 * does not expose `Intl.supportedValuesOf`. Zone identifiers are codes, not
 * translated text, so they are rendered as-is next to their current offset.
 */
export const listTimezones = () => {
  try {
    const zones = Intl.supportedValuesOf?.('timeZone');
    if (Array.isArray(zones) && zones.length) return zones;
  } catch {
    // Older engines simply do not have it; the curated list covers them.
  }
  return FALLBACK_TIMEZONES;
};

/** "UTC+03:00" for a zone, computed rather than stored. */
export const timezoneOffsetLabel = (timezone) => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(new Date());
    return parts.find((part) => part.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
};

/** Country label in the active language, without shipping a country dictionary. */
export const countryLabel = (code, locale) => {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
};

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const fail = (code) => ({ data: null, error: new Error(code) });
const ok = (data) => ({ data, error: null });

/**
 * Postgres RPCs raise SCREAMING_SNAKE codes; the network layer raises prose.
 * Either way the caller only ever sees a code it can hand to `t()`.
 */
const asCode = errorFromMessage;

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Files travel to the signup function as base64: an anonymous visitor has no
 *  storage session of its own, so the server writes them into core storage
 *  (STORAGE_LAYER.CORE / CORE_BUCKETS.branding) on the new company's behalf. */
const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error('FILE_READ_FAILED'));
  reader.onload = () => {
    const result = String(reader.result || '');
    resolve(result.slice(result.indexOf(',') + 1));
  };
  reader.readAsDataURL(file);
});

const describeFile = async (file) => {
  if (!file) return null;
  return {
    file_name: file.name,
    mime_type: file.type || 'application/octet-stream',
    file_size: file.size,
    layer: STORAGE_LAYER.CORE,
    bucket: CORE_BUCKETS.branding,
    content_base64: await fileToBase64(file),
  };
};

// ---------------------------------------------------------------------------
// Slug availability — public.slug_is_available(p_slug text)
// ---------------------------------------------------------------------------

/**
 * @param {string} slug
 * @returns {Promise<{ data: { available: boolean, reason: string|null }|null, error: Error|null }>}
 *          reason is one of INVALID_FORMAT | RESERVED | TAKEN, or null when free.
 */
export const checkSlug = async (slug) => {
  const value = String(slug || '').trim().toLowerCase();

  // The two cheap answers never need a round trip.
  if (!isValidSlug(value)) return ok({ available: false, reason: 'INVALID_FORMAT' });
  if (isReservedSlug(value)) return ok({ available: false, reason: 'RESERVED' });

  if (useLocalData || !supabase) {
    await delay(220);
    const taken = ['shalfa', 'demo', 'test', 'gold'].includes(value);
    return ok({ available: !taken, reason: taken ? 'TAKEN' : null });
  }

  const { data, error } = await supabase.rpc('slug_is_available', { p_slug: value });
  if (error) return { data: null, error: asCode(error, 'CHECK_FAILED') };
  return ok({ available: Boolean(data?.available), reason: data?.reason ?? null });
};

// ---------------------------------------------------------------------------
// Signup preflight — public.provision_tenant_preflight(p_payload jsonb)
// ---------------------------------------------------------------------------

/**
 * A last server-side look before provisioning: the slug is still free, the
 * administrator email is not already registered, the payload is complete.
 * Returning `{ ok: true }` is advisory — the edge function checks again inside
 * its transaction, which is the check that actually decides.
 */
export const preflightSignup = async (payload) => {
  if (useLocalData || !supabase) {
    await delay(180);
    return ok({ ok: true, issues: [] });
  }

  const { data, error } = await supabase.rpc('provision_tenant_preflight', {
    p_payload: buildSignupPayload(payload),
  });
  if (error) return { data: null, error: asCode(error, 'PREFLIGHT_FAILED') };
  return ok({ ok: data?.ok !== false, issues: data?.issues || [] });
};

// ---------------------------------------------------------------------------
// Signup — edge function `tenant-signup`
// ---------------------------------------------------------------------------

const cleanText = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

/** The wire shape shared by the preflight RPC and the edge function. */
const buildSignupPayload = (form) => ({
  slug: String(form.slug || '').trim().toLowerCase(),
  default_language: form.defaultLanguage,
  names: Object.entries(form.names || {}).reduce((acc, [code, value]) => {
    const name = cleanText(value);
    return name ? { ...acc, [code]: name } : acc;
  }, {}),
  legal_name: cleanText(form.legalName),
  country_code: form.countryCode,
  timezone: form.timezone,
  industry: cleanText(form.industry),
  employee_range: cleanText(form.companySize),
  tax_number: cleanText(form.taxNumber),
  commercial_register: cleanText(form.commercialRegister),
  branding: {
    theme_preset: form.themePreset,
    ...(THEME_PRESETS.find((preset) => preset.code === form.themePreset) || THEME_PRESETS[0]),
    map_url: cleanText(form.mapUrl),
  },
  contacts: CONTACT_CHANNELS
    .map((channel, index) => ({ channel, value: cleanText(form.contacts?.[channel]), display_order: (index + 1) * 10 }))
    .filter((row) => row.value),
  administrator: {
    relationship: form.relationship,
    full_name: cleanText(form.adminName),
    phone: cleanText(form.adminPhone),
    email: String(form.adminEmail || '').trim().toLowerCase(),
  },
});

/**
 * Creates the company, its administrator and the welcome email in one server
 * call. On success the caller receives the permanent company address and the
 * address the password-setup message was sent to.
 *
 * @returns {Promise<{ data: { slug: string, tenant_id: string|null, admin_email: string, email_sent: boolean }|null, error: Error|null }>}
 */
export const submitSignup = async (form) => {
  const payload = buildSignupPayload(form);

  let assets;
  try {
    assets = {
      logo: await describeFile(form.logoFile),
      cover: await describeFile(form.coverFile),
    };
  } catch {
    return fail('FILE_READ_FAILED');
  }

  if (useLocalData || !supabase) {
    await delay(900);
    return ok({
      slug: payload.slug,
      tenant_id: null,
      admin_email: payload.administrator.email,
      email_sent: false,
      local_preview: true,
    });
  }

  const { data, error } = await supabase.functions.invoke('tenant-signup', {
    body: { ...payload, assets },
  });
  if (error) return { data: null, error: asCode(error, 'SIGNUP_FAILED') };
  if (data?.error) return { data: null, error: asCode({ message: data.error }, 'SIGNUP_FAILED') };

  return ok({
    slug: data?.slug || payload.slug,
    tenant_id: data?.tenant_id ?? null,
    admin_email: data?.admin_email || payload.administrator.email,
    email_sent: data?.email_sent !== false,
    local_preview: false,
  });
};

// ---------------------------------------------------------------------------
// Support desk — public.support_ticket_create / public.support_ticket_status
// ---------------------------------------------------------------------------

const localTicketKey = 'bbnovix_public_tickets';

const readLocalTickets = () => {
  try {
    return JSON.parse(localStorage.getItem(localTicketKey) || '[]');
  } catch {
    return [];
  }
};

const writeLocalTickets = (rows) => {
  try {
    localStorage.setItem(localTicketKey, JSON.stringify(rows));
  } catch {
    // A private-mode browser simply loses the preview history; nothing breaks.
  }
};

const localTicketNumber = () =>
  `BBX-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 900000) + 100000)}`;

/**
 * The access token returned here is the requester's only credential for reading
 * the ticket afterwards, so it has to reach them — see PublicSupportPage.
 */
export const createTicket = async ({ category, subject, message, name, email, companySlug }) => {
  const payload = {
    category: SUPPORT_CATEGORY_DB_VALUE[category] || 'Other',
    subject: cleanText(subject),
    body: cleanText(message),
    requester_name: cleanText(name),
    requester_email: String(email || '').trim().toLowerCase(),
    tenant_slug: cleanText(companySlug)?.toLowerCase() || null,
  };

  if (!payload.subject || !payload.body || !payload.requester_email) {
    return fail('VALIDATION_FAILED');
  }

  if (useLocalData || !supabase) {
    await delay(600);
    const ticket = {
      ticket_no: localTicketNumber(),
      status: 'Open',
      email: payload.requester_email,
      subject: payload.subject,
      message: payload.body,
      category: payload.category,
      created_on: new Date().toISOString(),
      updated_on: new Date().toISOString(),
      replies: [],
    };
    ticket.access_token = `local-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    writeLocalTickets([ticket, ...readLocalTickets()].slice(0, 20));
    return ok({
      ticket_no: ticket.ticket_no,
      access_token: ticket.access_token,
      status: ticket.status,
      email: ticket.email,
    });
  }

  const { data, error } = await supabase.rpc('support_ticket_create', { p_payload: payload });
  if (error) return { data: null, error: asCode(error, 'TICKET_CREATE_FAILED') };
  return ok({
    ticket_no: data?.ticket_no || data?.ticket_number || '',
    access_token: data?.access_token || '',
    status: data?.status || 'Open',
    email: payload.requester_email,
  });
};

/**
 * Looks a ticket up by its number and the access token issued when it was
 * opened. The e-mail address is deliberately NOT the credential: ticket
 * numbers come from one shared sequence and an address is not a secret, so
 * that pair would let anyone walk the sequence and read other people's
 * correspondence.
 *
 * @returns {Promise<{ data: { ticket_no, subject, category, status, created_on, updated_on, messages: [] }|null, error: Error|null }>}
 */
export const ticketStatus = async ({ ticketNo, accessToken }) => {
  const number = String(ticketNo || '').trim().toUpperCase();
  const token = String(accessToken || '').trim();
  if (!number || !token) return fail('VALIDATION_FAILED');

  if (useLocalData || !supabase) {
    await delay(500);
    const found = readLocalTickets().find(
      (row) => row.ticket_no.toUpperCase() === number && row.access_token === token,
    );
    if (!found) return fail('NOT_FOUND');
    return ok({
      ticket_no: found.ticket_no,
      subject: found.subject,
      category: found.category,
      status: found.status,
      created_on: found.created_on,
      updated_on: found.updated_on,
      messages: [
        { id: 'first', author: 'Requester', body: found.message, created_on: found.created_on },
        ...(found.replies || []),
      ],
    });
  }

  const { data, error } = await supabase.rpc('support_ticket_status', {
    p_ticket_no: number,
    p_access_token: token,
  });
  if (error) return { data: null, error: asCode(error, 'TICKET_LOOKUP_FAILED') };
  if (!data || data.found === false) return fail('NOT_FOUND');

  return ok({
    ticket_no: data.ticket_no || number,
    subject: data.subject || '',
    category: data.category || 'other',
    status: data.status || 'Open',
    created_on: data.created_on || null,
    updated_on: data.updated_on || data.created_on || null,
    messages: Array.isArray(data.messages) ? data.messages : [],
  });
};

// ---------------------------------------------------------------------------
// Document verification — public.verify_document(p_code text)
// ---------------------------------------------------------------------------

/**
 * Kept here so the public pages have one door to every anonymous read. The
 * verification screen itself lives in its own module and may call this too.
 */
export const verifyDocument = async (code) => {
  const value = String(code || '').trim();
  if (value.length < 4) return ok({ valid: false, reason: 'NOT_FOUND' });

  if (useLocalData || !supabase) {
    await delay(400);
    return ok({ valid: false, reason: 'NOT_FOUND', code: value });
  }

  const { data, error } = await supabase.rpc('verify_document', { p_code: value });
  if (error) return { data: null, error: asCode(error, 'VERIFY_FAILED') };
  return ok(data || { valid: false, reason: 'NOT_FOUND', code: value });
};
