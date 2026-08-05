// The mail queue worker.
//
// Nothing in the product sends an email inline. A module inserts a row into
// public.email_queue and returns; this function is the only thing that ever
// talks to an SMTP server. That separation is what makes a slow or throttled
// Gmail account a delay instead of a failed approval or a failed signup.
//
// One run:
//   1. claims a batch with public.claim_email_queue (FOR UPDATE SKIP LOCKED, so
//      two overlapping runs never send the same message twice);
//   2. renders each row against its template in the row's language;
//   3. writes the outcome back — Sent with a provider_message_id, Retry with an
//      exponentially later next_attempt_on, or Failed with a reason.
//
// Callable by the scheduled trigger and by service_role only. It is deployed
// with --no-verify-jwt because pg_cron presents the service key as a bearer
// token rather than a user JWT, so the check below is the real gate.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

import { asErrorCode, errorResponse, isPreflight, jsonResponse, preflightResponse } from '../_shared/cors.ts';
import { Mailer, mailIsConfigured, sendTemplated, type EmailTemplateRow } from '../_shared/mailer.ts';

const CORS = { methods: 'POST, OPTIONS' };

const DEFAULT_BATCH = 25;
const MAX_BATCH = 100;

/** 1 min, 2, 4, 8, 16 … capped at six hours, with jitter so retries spread out. */
const RETRY_BASE_SECONDS = 60;
const RETRY_CAP_SECONDS = 6 * 60 * 60;

/** Failures that will never succeed on a retry; burning five attempts on them
 *  only delays the rest of the queue. */
const PERMANENT_FAILURES = new Set([
  'EMAIL_TEMPLATE_NOT_FOUND',
  'EMAIL_TEMPLATE_EMPTY',
  'RECIPIENT_INVALID',
  'RECIPIENT_MISSING',
]);

interface QueueRow {
  id: number;
  tenant_id: string | null;
  recipient_email: string;
  recipient_user_id: string | null;
  template_id: string;
  language: string;
  template_data: Record<string, unknown> | null;
  retry_count: number;
  max_retries: number;
}

const backoffSeconds = (attempt: number): number => {
  const raw = Math.min(RETRY_BASE_SECONDS * 2 ** Math.max(attempt, 0), RETRY_CAP_SECONDS);
  const jitter = 0.9 + Math.random() * 0.2;
  return Math.round(raw * jitter);
};

const looksLikeEmail = (value: string): boolean =>
  /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(value.trim());

/**
 * service_role only. The bearer token is compared with the service key itself
 * rather than resolved through auth.getUser, because the service key is not a
 * user JWT and no user should ever be able to drain this queue.
 */
const isAuthorized = (request: Request): boolean => {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
  if (serviceKey && bearer === serviceKey) return true;

  // A scheduler that cannot set an Authorization header may present a shared
  // secret instead; unset means the door stays closed.
  const workerSecret = Deno.env.get('EMAIL_WORKER_SECRET') ?? '';
  const presented = request.headers.get('x-worker-secret') ?? '';
  return Boolean(workerSecret) && presented === workerSecret;
};

const readBatchSize = async (request: Request): Promise<number> => {
  const url = new URL(request.url);
  const fromQuery = Number(url.searchParams.get('batch') ?? '');
  if (Number.isFinite(fromQuery) && fromQuery > 0) return Math.min(fromQuery, MAX_BATCH);

  try {
    const body = await request.json();
    const size = Number(body?.batchSize ?? body?.batch_size ?? NaN);
    if (Number.isFinite(size) && size > 0) return Math.min(size, MAX_BATCH);
  } catch {
    // No body at all is the normal case for a cron trigger.
  }
  return DEFAULT_BATCH;
};

export default {
  async fetch(request: Request): Promise<Response> {
    if (isPreflight(request)) return preflightResponse(request, CORS);
    if (request.method !== 'POST' && request.method !== 'GET') {
      return errorResponse('METHOD_NOT_ALLOWED', { status: 405, request, ...CORS });
    }
    if (!isAuthorized(request)) {
      return errorResponse('UNAUTHORIZED', { status: 401, request, ...CORS });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!supabaseUrl || !serviceKey) {
      return errorResponse('SUPABASE_NOT_CONFIGURED', { status: 500, request, ...CORS });
    }

    // Checked before claiming: a row claimed while the mailer is misconfigured
    // would sit in Processing until something released it.
    if (!mailIsConfigured()) {
      return errorResponse('MAIL_NOT_CONFIGURED', { status: 503, request, ...CORS });
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });

    const batchSize = await readBatchSize(request);
    const workerName = Deno.env.get('EMAIL_WORKER_NAME') ?? 'edge-worker';

    const { data: claimed, error: claimError } = await admin.rpc('claim_email_queue', {
      batch_size: batchSize,
      worker_name: workerName,
    });
    if (claimError) {
      return errorResponse(asErrorCode(claimError, 'EMAIL_QUEUE_CLAIM_FAILED'), { status: 500, request, ...CORS });
    }

    const rows = (claimed ?? []) as QueueRow[];
    if (rows.length === 0) {
      return jsonResponse({ ok: true, claimed: 0, sent: 0, retried: 0, failed: 0 }, { request, ...CORS });
    }

    // One read for every template the batch touches.
    const templateIds = [...new Set(rows.map((row) => row.template_id).filter(Boolean))];
    const { data: templateRows, error: templateError } = await admin
      .from('email_templates')
      .select('id, code, subject_ar, subject_en, body_html_ar, body_html_en')
      .in('id', templateIds);
    if (templateError) {
      // Release the batch: nothing was attempted, so nothing should count as a
      // retry against the messages.
      await admin
        .from('email_queue')
        .update({ status: 'Retry', locked_on: null, locked_by: null, next_attempt_on: new Date().toISOString() })
        .in('id', rows.map((row) => row.id));
      return errorResponse(asErrorCode(templateError, 'EMAIL_TEMPLATE_READ_FAILED'), { status: 500, request, ...CORS });
    }

    const templates = new Map<string, EmailTemplateRow>(
      (templateRows ?? []).map((row: EmailTemplateRow) => [String(row.id), row]),
    );

    const appUrl = Deno.env.get('APP_URL') ?? 'https://bbnovix.com';
    const mailer = Mailer.fromEnv();
    const summary = { claimed: rows.length, sent: 0, retried: 0, failed: 0 };
    const failures: Array<{ id: number; reason: string }> = [];

    for (const row of rows) {
      const nowIso = new Date().toISOString();
      let reason: string | null = null;
      let messageId: string | null = null;

      try {
        const recipient = String(row.recipient_email ?? '').trim();
        if (!recipient) throw new Error('RECIPIENT_MISSING');
        if (!looksLikeEmail(recipient)) throw new Error('RECIPIENT_INVALID');

        const template = templates.get(String(row.template_id));
        if (!template) throw new Error('EMAIL_TEMPLATE_NOT_FOUND');

        const sent = await sendTemplated(mailer, template, {
          to: recipient,
          language: row.language ?? 'en',
          data: {
            ...(row.template_data ?? {}),
            // Available to every template without the queueing module having
            // to remember them.
            app_url: appUrl,
            portal_url: `${appUrl}/portal`,
            support_url: `${appUrl}/support`,
            year: new Date().getFullYear(),
          },
        });
        messageId = sent.messageId;
      } catch (error) {
        reason = asErrorCode(error, 'EMAIL_SEND_FAILED');
        // A transport error carries prose worth keeping, but only a trimmed
        // amount of it and never the credentials used to connect.
        const detail = String((error as { message?: string })?.message ?? '').slice(0, 400);
        if (detail && detail !== reason) reason = `${reason}: ${detail}`;
        // The SMTP conversation may be half dead after a failure; drop it so
        // the next message in the batch opens a fresh one.
        await mailer.close();
      }

      if (!reason) {
        summary.sent += 1;
        await admin
          .from('email_queue')
          .update({
            status: 'Sent',
            sent_on: nowIso,
            provider_message_id: messageId,
            failure_reason: null,
            locked_on: null,
            locked_by: null,
            updated_on: nowIso,
          })
          .eq('id', row.id);
        continue;
      }

      const attempt = Number(row.retry_count ?? 0) + 1;
      const maxRetries = Number(row.max_retries ?? 5);
      const permanent = PERMANENT_FAILURES.has(reason.split(':')[0]);
      const giveUp = permanent || attempt >= maxRetries;

      if (giveUp) summary.failed += 1; else summary.retried += 1;
      failures.push({ id: row.id, reason });

      await admin
        .from('email_queue')
        .update({
          status: giveUp ? 'Failed' : 'Retry',
          retry_count: attempt,
          next_attempt_on: giveUp
            ? nowIso
            : new Date(Date.now() + backoffSeconds(attempt) * 1000).toISOString(),
          failure_reason: reason.slice(0, 500),
          provider_message_id: null,
          locked_on: null,
          locked_by: null,
          updated_on: nowIso,
        })
        .eq('id', row.id);
    }

    await mailer.close();

    return jsonResponse({ ok: true, ...summary, failures }, { request, ...CORS });
  },
};
