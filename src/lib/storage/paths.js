// Object-key rules for stored files.
//
// These are pure string functions with no vendor and no client behind them,
// which is the point: the key layout is what keeps one company's files away
// from another's, so it has to be readable, testable and impossible to get
// wrong by accident. supabase/functions/storage-proxy enforces the same prefix
// rule on the server, because a rule that only exists in the browser is not a
// rule.

/** Every object lives under its own company: tenants/{tenant}/{area}/{file}. */
export const tenantPath = (tenantId, area, fileName) =>
  `tenants/${tenantId}/${area}/${fileName}`.replace(/\/+/g, '/');

/**
 * The stored name is generated, never the uploaded one. An uploaded name is
 * attacker-controlled and is the usual way a key escapes its folder; keeping
 * only a plausible extension removes the question entirely.
 */
export const uniqueFileName = (originalName = 'file') => {
  const name = String(originalName);
  const dot = name.lastIndexOf('.');
  const rawExtension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const extension = /^[a-z0-9]{1,8}$/.test(rawExtension) ? rawExtension : 'bin';
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${stamp}.${extension}`;
};

/** A control character in a key is always an attempt to confuse a parser. */
const hasControlCharacter = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * The rule the storage proxy applies server-side, stated once so both sides
 * agree: a key is only ever accepted inside the caller's own company folder.
 */
export const pathBelongsToTenant = (path, tenantId) => {
  if (!path || !tenantId) return false;
  if (path.includes('..')) return false;
  if (hasControlCharacter(path)) return false;
  return path.startsWith(`tenants/${tenantId}/`);
};
