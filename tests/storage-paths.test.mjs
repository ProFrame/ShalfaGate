// Pure logic, no Supabase client — the object-key rules that keep one
// company's (or one user's) files away from another's. See
// src/lib/storage/paths.js's own header for why these are tested in
// isolation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tenantPath, userPath, uniqueFileName, pathBelongsToTenant } from '../src/lib/storage/paths.js';

test('tenantPath keys an object under tenants/{tenant}/{area}/{file}', () => {
  assert.equal(tenantPath('t1', 'branding', 'logo.png'), 'tenants/t1/branding/logo.png');
});

test('userPath keys an object under {user}/{area}/{file}, matching employee-assets/employee-signatures RLS', () => {
  assert.equal(userPath('u1', 'avatar', 'photo.png'), 'u1/avatar/photo.png');
});

test('userPath and tenantPath share no reserved token, so real ids can never alias', () => {
  // tenantPath always starts with the literal segment "tenants"; userPath
  // starts with a raw id with no fixed prefix. The two shapes are only
  // ambiguous if some id were ever literally the string "tenants" — which
  // cannot happen for a real value, since every id here is a Postgres uuid
  // (auth.uid()/tenants.id), never that literal token. This test documents
  // the (purely theoretical) edge case rather than asserting a guard that
  // does not and should not exist client-side — the real boundary is
  // storage.foldername(name)[1] = auth.uid()::text at the RLS layer, which
  // checks the caller's own id, not the string "tenants".
  const collidesOnlyIfIdWereLiterallyTenants = userPath('tenants', 'x', 'f.png');
  assert.equal(pathBelongsToTenant(collidesOnlyIfIdWereLiterallyTenants, 'x'), true);
});

test('both path builders collapse doubled slashes from empty/odd segments', () => {
  assert.equal(tenantPath('t1', '', 'f.png'), 'tenants/t1/f.png');
  assert.equal(userPath('u1', '', 'f.png'), 'u1/f.png');
});

test('uniqueFileName never trusts the caller-supplied name beyond its extension', () => {
  const a = uniqueFileName('report.pdf');
  const b = uniqueFileName('report.pdf');
  assert.match(a, /\.pdf$/);
  assert.notEqual(a, b, 'two calls must not collide even for the same input name');
});

test('uniqueFileName falls back to a safe extension for anything implausible', () => {
  assert.match(uniqueFileName('no-extension-at-all'), /\.bin$/);
  assert.match(uniqueFileName('../../etc/passwd'), /\.bin$/);
  assert.match(uniqueFileName('a.EXE'), /\.exe$/);
});

test('pathBelongsToTenant rejects traversal and control characters', () => {
  assert.equal(pathBelongsToTenant('tenants/t1/x/f.png', 't1'), true);
  assert.equal(pathBelongsToTenant('tenants/t1/../t2/f.png', 't1'), false);
  assert.equal(pathBelongsToTenant('tenants/t2/x/f.png', 't1'), false);
  assert.equal(pathBelongsToTenant(`tenants/t1/x/f\x00.png`, 't1'), false);
});

test('pathBelongsToTenant has no equivalent guard for userPath — by design, a user path is validated by storage.foldername(name)[1] = auth.uid() at the RLS layer, not client-side', () => {
  // A userPath never satisfies pathBelongsToTenant for any real tenant id
  // (it has no "tenants/" prefix at all), which is exactly why AuthContext
  // never calls pathBelongsToTenant on employee-assets/employee-signatures
  // paths — the client-side guard genuinely does not apply there, this
  // isn't a gap someone forgot to close.
  const path = userPath('u1', 'avatar', 'photo.png');
  assert.equal(pathBelongsToTenant(path, 'u1'), false);
});

test('a userPath object always lives directly inside the {user}/{area} folder its own caller must list', () => {
  // This is the exact invariant AuthContext.jsx's profile-asset cleanup and
  // delete depend on: they list `${userId}/${kind}` (via
  // getStorageProvider().list()) and expect every entry's name to be the
  // bare file name, not a nested path. If userPath() ever grew a deeper
  // structure (e.g. an extra sub-segment) that listing call would silently
  // stop finding old files — this test would catch it, unlike the earlier
  // batch-1 regression where the path shape changed with no test covering
  // the caller side of the contract.
  const userId = 'u1';
  const area = 'avatar';
  const path = userPath(userId, area, 'stamp123.png');
  const folder = `${userId}/${area}`;
  assert.ok(path.startsWith(`${folder}/`), 'the object must live directly inside {user}/{area}');
  const remainder = path.slice(folder.length + 1);
  assert.doesNotMatch(remainder, /\//, 'no further nesting — a single bare file name after {user}/{area}/');
});
