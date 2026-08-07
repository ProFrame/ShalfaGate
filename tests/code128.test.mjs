// Code 128 Set B encoder — pure logic, hand-verified against the published
// ISO/IEC 15417 width table (see src/lib/platformCore/code128.js's header
// for why this needed independent verification, not just memory).

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCode128B, code128Bars } from '../src/lib/platformCore/code128.js';

test('encodes a single character with the hand-computed checksum', () => {
  // 'A' = ASCII 65 -> Set B value 33 (65-32). checksum = START_B(104) + 33*1 = 137,
  // 137 mod 103 = 34. Sequence: [Start B=104, 'A'=33, checksum=34].
  const { values, widths, error } = encodeCode128B('A');
  assert.equal(error, null);
  assert.deepEqual(values, [104, 33, 34]);
  assert.equal(widths.length, 4); // start, data, checksum, stop
  assert.equal(widths.at(-1), '2331112'); // stop pattern, fixed
});

test('checksum is a positional weighted sum of Set B values, mod 103', () => {
  // '00' -> both chars are ASCII 48 -> Set B value 16.
  // checksum = 104 + 16*1 + 16*2 = 104 + 16 + 32 = 152, 152 mod 103 = 49.
  const { values } = encodeCode128B('00');
  assert.deepEqual(values, [104, 16, 16, 49]);
});

test('every generate_number() output character is encodable (Set B covers it)', () => {
  // NO-{SLUG}-{SOURCE}-{########}: uppercase letters, digits, hyphens.
  const { error } = encodeCode128B('NO-SHLF-AS-00000125');
  assert.equal(error, null);
});

test('rejects a character outside Set B (control chars, code points > 127)', () => {
  assert.match(encodeCode128B('\t').error, /UNSUPPORTED_CHARACTER/);
  assert.match(encodeCode128B('é').error, /UNSUPPORTED_CHARACTER/);
});

test('rejects an empty value instead of producing a meaningless barcode', () => {
  assert.equal(encodeCode128B('').error, 'EMPTY_VALUE');
  assert.deepEqual(encodeCode128B('').widths, []);
});

test('code128Bars only draws the bar half of the pattern, at the right x offsets', () => {
  // A single symbol '212222': bar(2) space(1) bar(2) space(2) bar(2) space(2).
  // At moduleWidth=1: bars at x=0 (width 2), x=3 (width 2), x=7 (width 2).
  const { bars, totalWidth } = code128Bars(['212222'], 1);
  assert.deepEqual(bars, [{ x: 0, width: 2 }, { x: 3, width: 2 }, { x: 7, width: 2 }]);
  assert.equal(totalWidth, 11);
});

test('code128Bars scales linearly with moduleWidth', () => {
  const at1 = code128Bars(['212222'], 1);
  const at3 = code128Bars(['212222'], 3);
  assert.equal(at3.totalWidth, at1.totalWidth * 3);
  assert.deepEqual(at3.bars.map((b) => b.x), at1.bars.map((b) => b.x * 3));
});
