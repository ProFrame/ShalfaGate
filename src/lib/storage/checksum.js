// Pure hashing logic, no Supabase client — split out from index.js so it can
// be read, reasoned about and tested in isolation, same rationale as
// ./paths.js's own header comment.

/** SHA-256 of the file's bytes, hex-encoded — storage_objects.checksum's one intended source. */
export const sha256Hex = async (file) => {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
