/** Accept only schemes intentionally rendered as links. */
export const safeExternalUrl = (value, { allowMail = false, allowTel = false } = {}) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { return ''; }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'http:' || protocol === 'https:') return parsed.href;
  if (allowMail && protocol === 'mailto:') return raw;
  if (allowTel && protocol === 'tel:') return raw;
  return '';
};

export const safeWebsiteUrl = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return safeExternalUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
};
