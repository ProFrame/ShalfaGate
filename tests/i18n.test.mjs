// The platform ships five languages and stores codes, not words. These tests
// hold that line: a missing key renders as raw snake_case on a real screen, and
// a dropped placeholder renders as literal {{name}} to a real user.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const winPath = (url) => new URL(url, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = winPath('../src/');
const MODULES = join(SRC, 'i18n/modules');

const LANGS = ['ar', 'en', 'hi', 'ur', 'tl'];
const dictionaries = new Map();
for (const file of readdirSync(MODULES).filter((f) => f.endsWith('.js')).sort()) {
  dictionaries.set(file, (await import(`file:///${join(MODULES, file).replace(/\\/g, '/')}`)).default);
}

const placeholders = (value) => (String(value).match(/\{\{?\w+\}?\}/g) || []).sort().join(',');

test('every dictionary defines every key in all five languages', () => {
  const gaps = [];
  for (const [file, dict] of dictionaries) {
    const keys = Object.keys(dict.en || {});
    assert.ok(keys.length > 0, `${file} has no English keys`);
    for (const lang of LANGS) {
      const missing = keys.filter((key) => !(key in (dict[lang] || {})));
      if (missing.length) gaps.push(`${file} ${lang}: ${missing.length} missing (${missing.slice(0, 5).join(', ')})`);
    }
  }
  assert.deepEqual(gaps, [], `Untranslated keys fall back to English, which hides the gap until a user reports it:\n${gaps.join('\n')}`);
});

test('interpolation placeholders survive translation', () => {
  const drift = [];
  for (const [file, dict] of dictionaries) {
    for (const key of Object.keys(dict.en || {})) {
      const expected = placeholders(dict.en[key]);
      for (const lang of LANGS) {
        const value = dict[lang]?.[key];
        if (value && placeholders(value) !== expected) {
          drift.push(`${file} ${lang}.${key}: expected ${expected || '(none)'}, got ${placeholders(value) || '(none)'}`);
        }
      }
    }
  }
  assert.deepEqual(drift, [], `A dropped or renamed placeholder renders literally on screen:\n${drift.join('\n')}`);
});

test('Urdu is written in Urdu, not copied from Arabic', () => {
  const suspects = [];
  for (const [file, dict] of dictionaries) {
    // A string carrying no words of its own — a bare placeholder, an e-mail
    // sample — is legitimately identical in both scripts.
    const translatable = Object.keys(dict.en || {}).filter((key) =>
      /[A-Za-z]{2,}/.test(String(dict.en[key]).replace(/\{\{?\w+\}?\}/g, '').replace(/\S+@\S+/g, '')));
    const copied = translatable.filter((key) => dict.ur?.[key] && dict.ur[key] === dict.ar?.[key]);
    if (copied.length > translatable.length * 0.2) {
      suspects.push(`${file}: ${copied.length} of ${translatable.length} Urdu strings are identical to the Arabic`);
    }
  }
  assert.deepEqual(suspects, [], suspects.join('\n'));
});

// ---------------------------------------------------------------------------
// Key resolution across the application
// ---------------------------------------------------------------------------

const walk = (dir) => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

const knownKeys = (() => {
  const known = new Set();
  const context = readFileSync(join(SRC, 'context/LanguageContext.jsx'), 'utf8');
  for (const match of context.matchAll(/([a-z][a-z0-9_]{2,}):\s*'/g)) known.add(match[1]);
  for (const dict of dictionaries.values()) {
    Object.keys(dict.en || {}).forEach((key) => known.add(key));
    Object.keys(dict.ar || {}).forEach((key) => known.add(key));
  }
  return known;
})();

test('every t() key used in the application resolves', () => {
  const missing = new Map();
  for (const file of walk(SRC).filter((f) => /\.jsx?$/.test(f) && !f.includes(`i18n${join('a', 'b')[1]}`) && !f.includes('i18n'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bt\(\s*'([a-z][a-z0-9_]*)'/g)) {
      if (!knownKeys.has(match[1])) {
        const rel = `src${file.split(`src`).pop()}`;
        missing.set(match[1], (missing.get(match[1]) || new Set()).add(rel));
      }
    }
  }
  const report = [...missing].map(([key, files]) => `${key} — ${[...files].join(', ')}`);
  assert.deepEqual(report, [], `These render as raw identifiers on screen:\n${report.join('\n')}`);
});

const ARABIC = /[؀-ۿ]/;

/**
 * Arabic that a user actually reads: text between JSX tags, the attributes that
 * are rendered or announced, and browser dialogs.
 *
 * Demo records — the stand-in rows shown when Supabase is not configured — are
 * deliberately Arabic: they are sample *data*, not labels, and translating them
 * would be meaningless. They live in object literals, which is what the
 * exclusion below recognises.
 */
test('no user-facing Arabic is hardcoded in a component', () => {
  const offenders = [];
  const components = walk(join(SRC, 'components')).filter((f) => f.endsWith('.jsx'));

  for (const file of components) {
    const source = readFileSync(file, 'utf8');
    source.split('\n').forEach((line, index) => {
      if (!ARABIC.test(line)) return;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;                       // comments may explain in Arabic
      if (/^\s*(\{|\[)?\s*\{?\s*\w+\s*:/.test(line) && !/<[A-Za-z]/.test(line)) return;  // object literal: demo data

      const rendered =
        />[^<>{}]*[؀-ۿ][^<>{}]*</.test(line)
        || /(placeholder|aria-label|title|alt|label)\s*=\s*["'][^"']*[؀-ۿ]/.test(line)
        || /(alert|confirm)\s*\(\s*["'][^"']*[؀-ۿ]/.test(line);

      if (rendered) offenders.push(`src${file.split('src').pop()}:${index + 1}  ${line.trim().slice(0, 100)}`);
    });
  }

  assert.deepEqual(offenders, [], `Arabic outside the dictionaries cannot be translated:\n${offenders.join('\n')}`);
});

test('list separators follow the locale instead of being hardcoded', () => {
  const offenders = [];
  for (const file of walk(SRC).filter((f) => /\.jsx?$/.test(f) && !f.includes('i18n'))) {
    const source = readFileSync(file, 'utf8');
    source.split('\n').forEach((line, index) => {
      if (/\.join\(\s*['"][^'"]*[،؛][^'"]*['"]\s*\)/.test(line)) {
        offenders.push(`src${file.split('src').pop()}:${index + 1}  ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `An Arabic comma joined into a list shows up in Hindi, Urdu and Filipino too.\n`
    + `Use formatList(values, locale) from src/utils/localize.js:\n${offenders.join('\n')}`,
  );
});
