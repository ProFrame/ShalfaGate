// Outbound mail for the whole platform.
//
// Everything the product sends — the welcome message a new company receives,
// an approval notification, a support reply — is a row in public.email_queue
// pointing at a row in public.email_templates. This module turns that pair into
// a rendered message and hands it to Gmail over SMTP.
//
// ---------------------------------------------------------------------------
// CREDENTIALS
// ---------------------------------------------------------------------------
// Nothing here contains a password, and nothing here may ever be given one.
// The five values below are read from the function environment and are set once
// with `supabase secrets set`:
//
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=465
//   SMTP_USER=bbnovix@gmail.com
//   SMTP_PASS=<Gmail App Password>
//   MAIL_FROM=bbnovix <bbnovix@gmail.com>
//
// SMTP_PASS is **not** the Google account password. Google refuses plain
// account passwords for SMTP ("Less secure app access" was withdrawn in 2022);
// the account needs 2-Step Verification switched on and then an App Password
// generated at https://myaccount.google.com/apppasswords. That 16-character
// value is what goes into the SMTP_PASS secret. If a real account password
// appears anywhere in this repository or in a planning document, treat it as
// leaked and rotate it.
//
// Gmail also caps a free account at roughly 500 recipients a day. The queue
// worker is built around that: it claims a small batch, records what happened
// and retries later, so hitting the cap delays mail instead of losing it.

import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

export const SUPPORTED_LANGUAGES = ['ar', 'en'] as const;
export type MailLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export interface EmailTemplateRow {
  id?: string;
  code?: string;
  subject_ar?: string | null;
  subject_en?: string | null;
  body_html_ar?: string | null;
  body_html_en?: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface SmtpSettings {
  hostname: string;
  port: number;
  username: string;
  password: string;
  from: string;
  replyTo?: string;
}

export interface SentMessage {
  messageId: string;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);

/**
 * A placeholder that lands inside `href="…"` must not be able to become a
 * script. Anything that is not an ordinary web or mail address is dropped.
 */
const safeUrl = (value: string): string => {
  const trimmed = value.trim();
  return /^(https?:|mailto:|tel:)/i.test(trimmed) ? trimmed : '';
};

const isUrlKey = (key: string) => /(_url|_link)$/i.test(key);

const flatten = (data: Record<string, unknown>, prefix = ''): Record<string, string> => {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) {
      flat[path] = '';
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(flat, flatten(value as Record<string, unknown>, path));
    } else {
      flat[path] = String(value);
    }
  }
  return flat;
};

/**
 * `{{ placeholder }}` substitution, double braces only — the same contract the
 * React translator honours, so a template author learns one syntax.
 *
 * An unknown placeholder becomes an empty string rather than staying visible in
 * the delivered message.
 */
export const substitute = (
  template: string,
  data: Record<string, unknown>,
  mode: 'html' | 'text' = 'html',
): string => {
  const flat = flatten(data ?? {});
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const raw = flat[key] ?? '';
    if (!raw) return '';
    if (isUrlKey(key)) {
      const url = safeUrl(raw);
      return mode === 'html' ? escapeHtml(url) : url;
    }
    return mode === 'html' ? escapeHtml(raw) : raw;
  });
};

/**
 * Localised column pick with the platform's fallback chain: the requested
 * language, then English, then Arabic. Mirrors `pickLocalized` on the client so
 * a template that exists in one language only still goes out.
 */
const pickLocalized = (
  row: EmailTemplateRow,
  field: 'subject' | 'body_html',
  language: string,
): string => {
  const candidates = [language, 'en', 'ar'];
  for (const code of candidates) {
    const value = (row as Record<string, unknown>)[`${field}_${code}`];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
};

/** A readable plain-text part, so the message is not flagged as HTML-only spam. */
export const htmlToText = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** A subject line may never carry a line break: that is header injection. */
const sanitizeSubject = (value: string): string =>
  value.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 300);

export const renderTemplate = (
  template: EmailTemplateRow,
  language: string,
  data: Record<string, unknown> = {},
): RenderedEmail => {
  const subjectSource = pickLocalized(template, 'subject', language);
  const bodySource = pickLocalized(template, 'body_html', language);
  if (!subjectSource || !bodySource) {
    throw new Error('EMAIL_TEMPLATE_EMPTY');
  }
  const html = substitute(bodySource, data, 'html');
  return {
    subject: sanitizeSubject(substitute(subjectSource, data, 'text')),
    html,
    text: htmlToText(html),
  };
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export const smtpSettingsFromEnv = (): SmtpSettings => {
  const hostname = Deno.env.get('SMTP_HOST')?.trim();
  const port = Number(Deno.env.get('SMTP_PORT') ?? '465');
  const username = Deno.env.get('SMTP_USER')?.trim();
  const password = Deno.env.get('SMTP_PASS') ?? '';
  const from = Deno.env.get('MAIL_FROM')?.trim() || (username ? `bbnovix <${username}>` : '');
  const replyTo = Deno.env.get('MAIL_REPLY_TO')?.trim() || undefined;

  if (!hostname || !username || !password || !from || !Number.isFinite(port)) {
    throw new Error('MAIL_NOT_CONFIGURED');
  }
  return { hostname, port, username, password, from, replyTo };
};

/** Whether the environment is complete enough to send anything at all. */
export const mailIsConfigured = (): boolean => {
  try {
    smtpSettingsFromEnv();
    return true;
  } catch {
    return false;
  }
};

const messageIdDomain = (from: string): string => {
  const match = from.match(/@([^>\s]+)/);
  return match?.[1] ?? 'bbnovix.com';
};

/**
 * One SMTP conversation reused for a whole batch. Gmail is happier with one
 * authenticated session sending twenty messages than with twenty sessions.
 */
export class Mailer {
  private client: SMTPClient | null = null;

  constructor(private readonly settings: SmtpSettings) {}

  static fromEnv(): Mailer {
    return new Mailer(smtpSettingsFromEnv());
  }

  private connect(): SMTPClient {
    if (this.client) return this.client;
    this.client = new SMTPClient({
      connection: {
        hostname: this.settings.hostname,
        port: this.settings.port,
        // 465 is implicit TLS; 587 starts plain and upgrades with STARTTLS,
        // which denomailer negotiates on its own.
        tls: this.settings.port === 465,
        auth: {
          username: this.settings.username,
          password: this.settings.password,
        },
      },
    });
    return this.client;
  }

  async send(message: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
  }): Promise<SentMessage> {
    const client = this.connect();
    const messageId = `<${crypto.randomUUID()}@${messageIdDomain(this.settings.from)}>`;

    // Typed loosely on purpose: the extra `headers` field is accepted by
    // denomailer but is not part of the narrow SendConfig overload it exports.
    const payload: Record<string, unknown> = {
      from: this.settings.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      content: message.text ?? htmlToText(message.html),
      replyTo: message.replyTo ?? this.settings.replyTo,
      headers: { 'Message-ID': messageId },
    };

    await client.send(payload as unknown as Parameters<SMTPClient['send']>[0]);
    return { messageId };
  }

  /** Ends the SMTP conversation. Safe to call twice, and safe to call on a
   *  connection that has already broken — closing is never the interesting
   *  failure, so it is swallowed. */
  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.close();
    } catch {
      // The socket is gone; that is what we were asking for anyway.
    }
  }
}

/**
 * Renders a queue row and sends it in one step, so both the worker and any
 * future direct sender behave identically.
 */
export const sendTemplated = async (
  mailer: Mailer,
  template: EmailTemplateRow,
  options: { to: string; language: string; data: Record<string, unknown>; replyTo?: string },
): Promise<SentMessage> => {
  const rendered = renderTemplate(template, options.language, options.data);
  return mailer.send({
    to: options.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: options.replyTo,
  });
};
