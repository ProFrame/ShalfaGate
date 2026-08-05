// Shared pieces of the {data, error} envelope every data/*.js service returns.
//
// Extracted from four near-identical copies (engagementService.js,
// audienceService.js, orgDimensionsService.js, tenantProfileService.js each
// defined the same asError/ok/ko trio, differing only in the fallback error
// code) and from platformService.js/publicService.js's identical asCode.

/** A service's own asError(value), parameterized by its fallback error code. */
export const makeAsError = (fallbackCode) => (value) => {
  if (value instanceof Error) return value;
  const message = value?.message || value?.error_description || value;
  return new Error(String(message || fallbackCode));
};

/** platformService.js/publicService.js's asCode: always mints a fresh Error. */
export const errorFromMessage = (error, fallbackCode) => {
  const raw = String(error?.message || '').trim();
  const match = raw.match(/[A-Z][A-Z0-9_]{3,}/);
  return new Error(match ? match[0] : fallbackCode);
};

/** The SCREAMING_SNAKE code an RPC/trigger raised, shared by every *ErrorMessage helper. */
export const extractScreamingSnakeCode = (error) => {
  const raw = String(error?.message || error || '').trim();
  return raw.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/)?.[0];
};
