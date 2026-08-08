import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { safeExternalUrl, safeWebsiteUrl } from '../src/utils/safeUrl.js';

const rootPath = (relative) => new URL(`../${relative}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (relative) => readFileSync(rootPath(relative), 'utf8');

test('public fallback assets never publish employee or internal document data', () => {
  const site = JSON.parse(read('public/data/site-data.json'));
  const org = JSON.parse(read('public/data/org-chart.json'));

  assert.deepEqual(site.orgChart, []);
  assert.deepEqual(site.documents, []);
  assert.deepEqual(site.circulars, []);
  assert.deepEqual(site.designs, []);
  assert.deepEqual(org.items, []);
  assert.doesNotMatch(JSON.stringify({ site, org }), /@|drive\.google\.com|employeeName|phone/i);
});

test('frontend source contains no service-role or server credential access', () => {
  const srcRoot = rootPath('src');
  const files = readdirSync(srcRoot, { recursive: true })
    .filter((name) => /\.(?:js|jsx|ts|tsx)$/.test(String(name)));
  const source = files.map((name) => readFileSync(join(srcRoot, String(name)), 'utf8')).join('\n');
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE|SERVICE_ROLE_KEY|SMTP_PASS|DB_PASSWORD/);
});

test('the static entry point enforces a CSP that blocks injected scripts and plugins', () => {
  const html = read('index.html');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /base-uri 'none'/);
  assert.doesNotMatch(html, /script-src[^;]*(?:'unsafe-inline'|'unsafe-eval')/);
});

test('external URL helpers reject executable and credential-bearing schemes', () => {
  assert.equal(safeExternalUrl('javascript:alert(1)'), '');
  assert.equal(safeExternalUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(safeWebsiteUrl('javascript:alert(1)'), '');
  assert.equal(safeExternalUrl('mailto:person@example.com', { allowMail: true }), 'mailto:person@example.com');
  assert.match(safeWebsiteUrl('example.com'), /^https:\/\/example\.com\/?$/);
});

test('protected Edge Functions fail CORS closed and storage blocks SSRF redirects', () => {
  const cors = read('supabase/functions/_shared/cors.ts');
  const storage = read('supabase/functions/storage-proxy/index.ts');
  const signup = read('supabase/functions/tenant-signup/index.ts');

  assert.match(cors, /allowAnyOrigin = false/);
  assert.match(cors, /return allowed\.includes\(origin\) \? origin : null/);
  assert.match(signup, /allowAnyOrigin: true/);
  assert.match(storage, /STORAGE_ENDPOINT_NOT_ALLOWED/);
  assert.match(storage, /url\.protocol !== 'https:'/);
  assert.match(storage, /redirect: 'error'/);
});
