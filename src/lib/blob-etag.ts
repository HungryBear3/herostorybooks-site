/**
 * Canonicalize an HTTP ETag validator so the same underlying version compares
 * equal across Blob subsystems that decorate it differently. Private `get()`,
 * metadata `list()`, and the CDN can represent identical bytes as `"abc"`,
 * `W/"abc"`, or `abc`; raw comparison turns those equivalent validators into
 * false CAS conflicts.
 */
export function normalizeEtag(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  const weak = /^W\//i.test(value);
  if (weak) value = value.slice(2);
  const quoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2;
  if (weak && !quoted) return null;
  if (quoted) {
    value = value.slice(1, -1);
  } else if (value.includes('"')) {
    return null;
  }
  // RFC 9110 opaque-tag ASCII range: visible bytes except DQUOTE. Vercel also
  // emits the same opaque token unquoted in some metadata/CDN responses.
  return /^[\x21\x23-\x7e]+$/.test(value) ? value : null;
}

/** Convert equivalent validators into the strong quoted shape Blob `ifMatch` accepts. */
export function normalizeEtagForIfMatch(raw: string | null | undefined): string | null {
  const value = normalizeEtag(raw);
  return value ? `"${value}"` : null;
}
