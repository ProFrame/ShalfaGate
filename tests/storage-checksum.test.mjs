// sha256Hex is storage_objects.checksum's one intended source (see
// src/lib/storage/checksum.js's own comment) — tested in isolation so a
// future change to the hashing logic is caught without needing a live upload.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../src/lib/storage/checksum.js';

const fileOf = (bytes) => new Blob([bytes]);

test('sha256Hex matches the known SHA-256 of an empty file', async () => {
  const digest = await sha256Hex(fileOf(new Uint8Array()));
  assert.equal(digest, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256Hex matches the known SHA-256 of "abc"', async () => {
  const digest = await sha256Hex(fileOf(new TextEncoder().encode('abc')));
  assert.equal(digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256Hex is deterministic and content-sensitive', async () => {
  const a = await sha256Hex(fileOf(new TextEncoder().encode('same content')));
  const b = await sha256Hex(fileOf(new TextEncoder().encode('same content')));
  const c = await sha256Hex(fileOf(new TextEncoder().encode('different content')));
  assert.equal(a, b, 'same bytes must hash identically');
  assert.notEqual(a, c, 'different bytes must not collide');
});

test('sha256Hex returns lowercase hex, 64 characters (32 bytes)', async () => {
  const digest = await sha256Hex(fileOf(new TextEncoder().encode('x')));
  assert.match(digest, /^[0-9a-f]{64}$/);
});
