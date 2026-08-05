// One helper for every "which language column do I show?" decision.
//
// The platform supports five languages but master data rarely carries five
// columns. The walk is: the exact language, then the secondary name, then the
// primary name — so a Hindi user reading a record that only has two names still
// sees something meaningful instead of an empty cell.

const FALLBACK_SUFFIXES = ['2', 'en', '1', 'ar'];

/**
 * @param {object} row      the database record
 * @param {string} field    base column name, e.g. 'name' for name_ar / name_en
 * @param {string} lang     active language code
 * @param {string} [fallback] value when nothing is present
 */
export const pickLocalized = (row, field, lang, fallback = '') => {
  if (!row) return fallback;

  const candidates = [
    `${field}_${lang}`,
    ...FALLBACK_SUFFIXES.map((suffix) => `${field}_${suffix}`),
    field,
  ];

  for (const key of candidates) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (value != null && typeof value !== 'string') return String(value);
  }

  return fallback;
};

/**
 * Same walk for a plain map keyed by language code, which is how company names
 * are stored ({ ar: 'شلفا', en: 'Shalfa' }).
 */
export const pickFromMap = (map, lang, defaultLang = 'ar', fallback = '') => {
  if (!map || typeof map !== 'object') return fallback;
  return (
    map[lang]
    || map[defaultLang]
    || map.en
    || map.ar
    || Object.values(map).find((value) => typeof value === 'string' && value.trim())
    || fallback
  );
};

/**
 * Labels for values stored as codes. Everything the user reads is translated at
 * render time; the database only ever holds the code.
 */
export const codeLabel = (t, prefix, code, fallback) => {
  if (!code) return fallback ?? '';
  const key = `${prefix}_${String(code).toLowerCase()}`;
  const label = t(key);
  return label === key ? (fallback ?? code) : label;
};

/** Intl-driven date and number formatting, so no module rolls its own. */
export const formatDate = (value, locale, options = { dateStyle: 'medium' }) => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, options).format(date);
};

export const formatDateTime = (value, locale) =>
  formatDate(value, locale, { dateStyle: 'medium', timeStyle: 'short' });

export const formatNumber = (value, locale, options = {}) => {
  if (value == null || value === '') return '';
  const num = Number(value);
  if (Number.isNaN(num)) return '';
  return new Intl.NumberFormat(locale, options).format(num);
};

export const formatBytes = (bytes, locale) => {
  const value = Number(bytes || 0);
  if (!value) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** exponent;
  return `${formatNumber(scaled, locale, { maximumFractionDigits: scaled >= 100 ? 0 : 1 })} ${units[exponent]}`;
};

/**
 * Joins values the way the reading language joins them. Arabic separates with
 * "،", English with ",", and Intl knows the rest — so a list built once reads
 * correctly in all five languages instead of carrying an Arabic comma into
 * Hindi.
 */
export const formatList = (values, locale, type = 'conjunction') => {
  const items = (Array.isArray(values) ? values : [values])
    .map((value) => (value == null ? '' : String(value).trim()))
    .filter(Boolean);
  if (!items.length) return '';

  try {
    return new Intl.ListFormat(locale, { style: 'long', type }).format(items);
  } catch {
    // Intl.ListFormat is widely supported, but never let a list break a screen.
    return items.join(locale?.startsWith('ar') || locale?.startsWith('ur') ? '، ' : ', ');
  }
};

/** Relative time ("3 minutes ago") without pulling in a date library. */
export const formatRelative = (value, locale) => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const thresholds = [
    ['second', 60], ['minute', 60], ['hour', 24], ['day', 7],
    ['week', 4.34524], ['month', 12], ['year', Infinity],
  ];

  let duration = seconds;
  for (const [unit, limit] of thresholds) {
    if (Math.abs(duration) < limit) {
      return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(duration), unit);
    }
    duration /= limit;
  }
  return '';
};
