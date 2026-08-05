// Preserve local preview data and preferences created before the bbnovix
// rebrand. Copy-once is intentionally non-destructive: an older deployed build
// can still read its keys during a rollback, while every current module uses
// the bbnovix namespace.
const LEGACY_PREFIX = 'shalfa_';
const CURRENT_PREFIX = 'bbnovix_';

export const migrateLegacyBrowserState = () => {
  try {
    const copies = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(LEGACY_PREFIX)) continue;
      const nextKey = `${CURRENT_PREFIX}${key.slice(LEGACY_PREFIX.length)}`;
      if (localStorage.getItem(nextKey) == null) copies.push([nextKey, localStorage.getItem(key)]);
    }
    copies.forEach(([key, value]) => localStorage.setItem(key, value));
  } catch {
    // Storage may be blocked; the application already treats that as a
    // recoverable browser limitation.
  }
};
