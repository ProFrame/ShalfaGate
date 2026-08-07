// listFormAttachments() is the AttachmentsPanel-shaped adapter
// (entityType, entityId) => Promise<{data, error}> that FormsPortal.jsx and
// ApprovalCenter.jsx both pass as `listFn` for form attachments — it exists
// only to discard the entityType argument (a form's attachments are always
// read by form id alone, never by entityType+entityId like the generic
// attachment_list()) and forward to formAttachmentList(). See
// src/data/approvalService.js's own comment above formAttachmentList().
//
// approvalService.js pulls in src/lib/supabaseClient.js (browser-only —
// reads window.location at module-evaluation time, fine for this SPA with no
// SSR path) via an extensionless relative import, which Vite resolves but
// Node's own ESM loader cannot without a bundler or loader hook — neither of
// which this project's `node --test` setup has. So, same rationale as
// tests/tenancy-invariants.test.mjs (which reads migration SQL as text
// because there is no live Postgres in this test run either): this adapter
// is verified by parsing its own source text, not by importing and calling
// it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/data/approvalService.js', import.meta.url), 'utf8');

test('listFormAttachments is exported and delegates to formAttachmentList by formId alone', () => {
  const match = src.match(/export const listFormAttachments = \(([^)]*)\) => formAttachmentList\(([^)]*)\);/);
  assert.ok(match, 'listFormAttachments must be a one-line adapter forwarding to formAttachmentList — source shape changed, update this test alongside it');

  const [, params, forwarded] = match;
  const paramNames = params.split(',').map((p) => p.trim());
  assert.equal(paramNames.length, 2, 'must accept exactly (entityType, entityId) to match AttachmentsPanel\'s listFn contract');

  const [entityTypeParam, entityIdParam] = paramNames;
  assert.match(entityTypeParam, /^_/, 'the entityType parameter must be named with a leading underscore to document that it is intentionally unused, not forgotten');
  assert.equal(forwarded.trim(), entityIdParam, 'must forward exactly the entityId parameter — and nothing else — to formAttachmentList');
});

test('formAttachmentList exists as the single implementation listFormAttachments wraps', () => {
  assert.match(src, /export async function formAttachmentList\(formId\)/, 'formAttachmentList\'s own signature changed — listFormAttachments\'s forwarding contract needs re-checking against it');
});
