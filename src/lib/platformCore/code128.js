// Code 128 (Set B) encoder — pure logic, no rendering.
//
// Values 0-105 below and the stop pattern are the ISO/IEC 15417 Code 128
// symbol widths (bar,space,bar,space,bar,space — six widths per symbol,
// eleven modules total; the stop pattern has seven widths, thirteen
// modules). This table is the published specification, not an original
// creative work — cross-checked here against an independent published
// source before shipping, because a transcription error would render a
// barcode that looks plausible but silently fails to scan.
//
// Set B covers ASCII 32 ("space") through 127 as values 0-95, which is
// every character generate_number() can ever produce (NO-{SLUG}-{SOURCE}-
// {########} — uppercase letters, digits, hyphens), so this file only
// implements Set B; Code 128 Sets A and C are not needed here.

const WIDTHS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232',
];
const STOP_WIDTHS = '2331112';
const START_B = 104;

/**
 * @param {string} text - printable ASCII only (Set B: chars 32-127).
 * @returns {{ values: number[], widths: string[], error: string|null }}
 *   widths is the full symbol sequence (start, data..., checksum, stop) as
 *   six/seven-digit width strings, ready to render as alternating bar/space
 *   rectangles starting with a bar.
 */
export function encodeCode128B(text) {
  const input = String(text ?? '');
  if (!input) return { values: [], widths: [], error: 'EMPTY_VALUE' };

  const dataValues = [];
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 127) return { values: [], widths: [], error: `UNSUPPORTED_CHARACTER: ${ch}` };
    dataValues.push(code - 32);
  }

  let checksum = START_B;
  dataValues.forEach((value, index) => { checksum += value * (index + 1); });
  checksum %= 103;

  const values = [START_B, ...dataValues, checksum];
  const widths = [...values.map((value) => WIDTHS[value]), STOP_WIDTHS];

  return { values, widths, error: null };
}

/**
 * Flattens the width sequence into {x, width, isBar} bars only (spaces are
 * gaps, not drawn) — the shape an SVG renderer wants directly.
 * @param {string[]} widths
 * @param {number} moduleWidth - px per unit.
 */
export function code128Bars(widths, moduleWidth = 2) {
  const bars = [];
  let x = 0;
  let isBar = true;
  for (const symbol of widths) {
    for (const digit of symbol) {
      const width = Number(digit) * moduleWidth;
      if (isBar) bars.push({ x, width });
      x += width;
      isBar = !isBar;
    }
  }
  return { bars, totalWidth: x };
}
