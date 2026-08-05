// The public verification API.
//
//   GET /functions/v1/verify-api/{code}
//   GET /functions/v1/verify-api?code={code}
//
// Anonymous, cross-company and read only. A ministry, a bank or a customer's
// own HR system asks whether a document bbnovix printed is genuine, and gets a
// small, stable JSON answer it can parse without knowing anything about the
// platform. The answer never depends on who is asking: the code itself carries
// the company.
//
// docs/bbnovix_deployment.md explains how to expose it publicly as
// /api/verify/{code}.
//
// Unlike the browser-facing functions, this one uses ordinary HTTP status
// codes — it is consumed by machines, not by supabase-js.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

import {
  MemoryRateLimiter,
  asErrorCode,
  clientIp,
  isPreflight,
  jsonResponse,
  preflightResponse,
} from '../_shared/cors.ts';

// Public data, so the allow list is deliberately open for this endpoint only.
const CORS = { methods: 'GET, HEAD, OPTIONS', headers: 'content-type, apikey, authorization' };

/** 60 lookups a minute per address is generous for a real integration and slow
 *  enough that guessing a 12-digit code is pointless. */
const limiter = new MemoryRateLimiter(60, 60_000);

const SUPPORTED_LANGUAGES = ['ar', 'en'];

interface VerifyResult {
  valid?: boolean;
  reason?: string | null;
  code?: string | null;
  source?: string | null;
  doc_type?: string | null;
  status?: string | null;
  seal_style?: string | null;
  title_ar?: string | null;
  title_en?: string | null;
  subject_ar?: string | null;
  subject_en?: string | null;
  holder_name?: string | null;
  reference_no?: string | null;
  issued_on?: string | null;
  valid_until?: string | null;
  file_url?: string | null;
  company?: {
    slug?: string;
    names?: Record<string, string>;
    short_names?: Record<string, string>;
    logo_light_url?: string | null;
    logo_dark_url?: string | null;
  } | null;
  timeline?: unknown[];
}

/**
 * The platform's localisation fallback, applied to a language map that arrives
 * from the database: the asked-for language, then English, then Arabic, then
 * whatever exists.
 */
const pickName = (names: Record<string, string> | undefined, language: string): string | null => {
  if (!names) return null;
  const ordered = [language, 'en', 'ar', ...Object.keys(names)];
  for (const code of ordered) {
    const value = names[code];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

const pickLocalizedField = (
  row: VerifyResult,
  field: 'title' | 'subject',
  language: string,
): string | null => {
  const ordered = [language, 'en', 'ar'];
  for (const code of ordered) {
    const value = (row as Record<string, unknown>)[`${field}_${code}`];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

/** The code may arrive as the last path segment or as ?code=. */
const readCode = (url: URL): string => {
  const fromQuery = url.searchParams.get('code');
  if (fromQuery) return fromQuery.trim();

  const segments = url.pathname.split('/').filter(Boolean);
  const anchor = segments.lastIndexOf('verify-api');
  const tail = anchor >= 0 ? segments.slice(anchor + 1) : segments.slice(-1);
  // /api/verify/{code} arrives rewritten, so 'verify' can still lead the tail.
  const candidate = tail.filter((segment) => segment.toLowerCase() !== 'verify').pop() ?? '';
  return decodeURIComponent(candidate).trim();
};

const readLanguage = (url: URL, request: Request): string => {
  const asked = (url.searchParams.get('lang') ?? '').trim().toLowerCase().slice(0, 2);
  if (SUPPORTED_LANGUAGES.includes(asked)) return asked;
  const header = (request.headers.get('accept-language') ?? '').trim().toLowerCase().slice(0, 2);
  return SUPPORTED_LANGUAGES.includes(header) ? header : 'en';
};

export default {
  async fetch(request: Request): Promise<Response> {
    if (isPreflight(request)) return preflightResponse(request, CORS);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ valid: false, error: 'METHOD_NOT_ALLOWED' }, { status: 405, request, ...CORS });
    }

    const url = new URL(request.url);
    const code = readCode(url);
    const language = readLanguage(url, request);

    const ip = clientIp(request) ?? 'unknown';
    if (!limiter.take(ip)) {
      return jsonResponse({ valid: false, error: 'RATE_LIMITED' }, {
        status: 429,
        request,
        ...CORS,
        extraHeaders: { 'Retry-After': String(limiter.retryAfterSeconds()) },
      });
    }

    if (!code || code.length < 4 || code.length > 64) {
      return jsonResponse({ valid: false, error: 'CODE_REQUIRED' }, { status: 400, request, ...CORS });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    // The anon key is enough: public.verify_document is a security definer
    // function granted to anon, and it decides for itself what a stranger may
    // see. Using the service key here would only widen the blast radius.
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    if (!supabaseUrl || !anonKey) {
      return jsonResponse({ valid: false, error: 'SUPABASE_NOT_CONFIGURED' }, { status: 500, request, ...CORS });
    }

    const client = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });

    const { data, error } = await client.rpc('verify_document', { p_code: code });
    if (error) {
      return jsonResponse({ valid: false, error: asErrorCode(error, 'VERIFY_FAILED') }, {
        status: 502,
        request,
        ...CORS,
      });
    }

    const result = (data ?? {}) as VerifyResult;
    const found = result.reason !== 'NOT_FOUND' || result.valid === true;
    const appUrl = (Deno.env.get('APP_URL') ?? 'https://bbnovix.com').replace(/\/+$/, '');

    // The stable shape. Other systems read these keys and nothing else, so they
    // keep their names and their types even when the underlying tables change.
    const body = {
      valid: Boolean(result.valid),
      code: result.code ?? code,
      status: result.status ?? (found ? 'Unknown' : 'NotFound'),
      reason: result.reason ?? null,
      company: found && result.company
        ? {
          slug: result.company.slug ?? null,
          name: pickName(result.company.names, language),
          short_name: pickName(result.company.short_names, language),
          logo_url: result.company.logo_light_url ?? null,
        }
        : null,
      document: found
        ? {
          type: result.doc_type ?? null,
          title: pickLocalizedField(result, 'title', language),
          subject: pickLocalizedField(result, 'subject', language),
          holder_name: result.holder_name ?? null,
          reference_no: result.reference_no ?? null,
          // Only a valid document exposes its file; verify_document already
          // withholds it otherwise, and this mirrors that decision.
          file_url: result.file_url ?? null,
        }
        : null,
      issued_on: result.issued_on ?? null,
      valid_until: result.valid_until ?? null,
      verify_url: `${appUrl}/verify/${encodeURIComponent(result.code ?? code)}`,
      checked_on: new Date().toISOString(),
      language,
      // The untouched RPC answer, for callers that want the approval timeline
      // or the seal style the printed document used.
      details: result,
    };

    return jsonResponse(body, {
      status: found ? 200 : 404,
      request,
      ...CORS,
      // A genuine document rarely changes; a miss is never cached, because a
      // document issued a second later must not keep answering "not found".
      cacheSeconds: found && result.valid ? 300 : undefined,
    });
  },
};
