// Cross-origin plumbing shared by every bbnovix edge function.
//
// The browser calls these functions from three different origins — the live
// site (https://bbnovix.com), a preview build and a developer's localhost — so
// every function answers the preflight the same way and nobody hand-writes a
// header block again.
//
// Two response conventions live here as well, and they are deliberate:
//
//   * A *handled* outcome always answers 200 with `{ ok, ... }` or
//     `{ ok: false, error: 'SCREAMING_SNAKE_CODE' }`. supabase-js turns any
//     non-2xx status into an opaque "Edge Function returned a non-2xx status
//     code" error and the browser never sees the body, so a business refusal
//     ("that address is taken") must travel in a 200 body or the user is shown
//     a generic failure instead of the reason. `verify-api` is the exception:
//     it is a machine API for other systems, not for our own client, so it uses
//     ordinary HTTP status codes.
//   * A *transport* problem (wrong method, unauthenticated, unexpected throw)
//     uses the real status code, because no useful body exists anyway.

export const DEFAULT_ALLOWED_HEADERS = [
  'authorization',
  'x-client-info',
  'apikey',
  'content-type',
  'x-storage-action',
  'x-worker-secret',
  'x-requested-with',
].join(', ');

/**
 * Origins allowed to call protected browser functions, as a comma separated
 * list in the ALLOWED_ORIGINS secret. Public endpoints must opt in explicitly;
 * a missing secret never turns an authenticated endpoint into open CORS.
 */
const configuredOrigins = (): string[] => {
  const raw = Deno.env.get('ALLOWED_ORIGINS') ?? '';
  const configured = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (configured.length > 0) return configured;

  const appUrl = Deno.env.get('APP_URL') ?? 'https://bbnovix.com';
  try {
    const origin = new URL(appUrl).origin;
    return [...new Set([origin, 'https://bbnovix.com', 'https://www.bbnovix.com'])];
  } catch {
    return ['https://bbnovix.com', 'https://www.bbnovix.com'];
  }
};

/**
 * Echoes a trusted caller's origin. Anonymous public APIs opt into `*`; all
 * other functions omit the header for an untrusted origin so browsers fail
 * the CORS check closed.
 */
export const resolveOrigin = (request?: Request, allowAnyOrigin = false): string | null => {
  if (allowAnyOrigin) return '*';
  const allowed = configuredOrigins();
  const origin = request?.headers.get('origin') ?? '';
  if (!origin) return allowed[0] ?? null;
  return allowed.includes(origin) ? origin : null;
};

export interface CorsOptions {
  /** Methods the endpoint accepts, e.g. 'POST, OPTIONS'. */
  methods?: string;
  /** Extra request headers the browser may send. */
  headers?: string;
  /** Seconds the browser may cache the preflight answer. */
  maxAge?: number;
  /** Only anonymous, intentionally public endpoints may set this. */
  allowAnyOrigin?: boolean;
}

export const corsHeaders = (request?: Request, options: CorsOptions = {}): Record<string, string> => {
  const origin = resolveOrigin(request, options.allowAnyOrigin);
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': options.headers ?? DEFAULT_ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': options.methods ?? 'POST, OPTIONS',
    'Access-Control-Max-Age': String(options.maxAge ?? 86400),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Origin',
  };
};

export const isPreflight = (request: Request): boolean => request.method === 'OPTIONS';

export const preflightResponse = (request: Request, options: CorsOptions = {}): Response =>
  new Response(null, { status: 204, headers: corsHeaders(request, options) });

export interface JsonOptions extends CorsOptions {
  status?: number;
  request?: Request;
  /** Seconds a shared cache may keep the answer; omitted means no-store. */
  cacheSeconds?: number;
  extraHeaders?: Record<string, string>;
}

export const jsonResponse = (body: unknown, options: JsonOptions = {}): Response => {
  const { status = 200, request, cacheSeconds, extraHeaders, ...cors } = options;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request, cors),
      ...(extraHeaders ?? {}),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
    },
  });
};

/**
 * A refusal the caller can translate. `code` is a SCREAMING_SNAKE code and
 * never a sentence: the client maps it to a translation key, so no user-facing
 * text is ever produced here.
 */
export const errorResponse = (
  code: string,
  options: JsonOptions & { detail?: Record<string, unknown> } = {},
): Response => {
  const { detail, ...rest } = options;
  return jsonResponse({ ok: false, error: code, ...(detail ?? {}) }, rest);
};

/**
 * The caller's address as seen by the edge. Supabase sits behind a proxy, so
 * the first hop in x-forwarded-for is the real client; the rest of the chain is
 * infrastructure and must not be trusted for rate limiting.
 */
export const clientIp = (request: Request): string | null => {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-real-ip')
    ?? null;
};

export const userAgent = (request: Request): string | null =>
  request.headers.get('user-agent')?.slice(0, 500) ?? null;

/**
 * A process-local sliding window, used where the database has no counter table
 * to lean on. It survives only as long as the isolate does, so it throttles a
 * burst rather than enforcing a global quota — every endpoint that needs a hard
 * limit also counts rows in Postgres.
 */
export class MemoryRateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** @returns true when the caller is still inside its allowance. */
  take(key: string, now = Date.now()): boolean {
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((stamp) => stamp > since);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);

    // Cheap housekeeping: the map is per isolate and short lived, but a busy
    // endpoint would still accumulate one entry per address without this.
    if (this.hits.size > 5000) {
      for (const [entry, stamps] of this.hits) {
        if (!stamps.some((stamp) => stamp > since)) this.hits.delete(entry);
      }
    }
    return true;
  }

  retryAfterSeconds(): number {
    return Math.ceil(this.windowMs / 1000);
  }
}

/**
 * Postgres raises SCREAMING_SNAKE codes; PostgREST wraps them in prose and the
 * network layer raises prose of its own. Either way the caller only ever sees a
 * code it can translate.
 */
export const asErrorCode = (error: unknown, fallback = 'UNKNOWN_ERROR'): string => {
  const message = typeof error === 'string'
    ? error
    : String((error as { message?: string })?.message ?? '').trim();
  const match = message.match(/[A-Z][A-Z0-9_]{3,}/);
  return match ? match[0] : fallback;
};
