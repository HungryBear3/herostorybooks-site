// HSB cover-image A/B test (Variant A = current illustrative, Variant B = realistic).
// Pure helpers — no DOM/cookie I/O at this layer. Server middleware sets the cookie;
// client components read it via `getClientVariant()` in cover-variant-client.ts.

export type CoverVariant = 'A' | 'B';

export const COVER_VARIANT_COOKIE = 'cover-variant';
export const COVER_VARIANT_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

const REALISTIC_PREFIX = '/assets/covers/realistic/';
const ASSETS_PREFIX = '/assets/';

/**
 * Parse a cookie value into a CoverVariant. Tolerant of casing. Returns null for
 * anything else so the middleware can decide to (re)assign.
 */
export function parseVariantCookie(value: string | undefined | null): CoverVariant | null {
  if (!value) return null;
  if (value === 'A' || value === 'B') return value;
  const upper = value.toUpperCase();
  if (upper === 'A') return 'A';
  if (upper === 'B') return 'B';
  return null;
}

/**
 * Deterministic 50/50 split. With no seed, uses Math.random() (good enough for a
 * marketing A/B). With a seed, hashes the seed so the same input → same variant —
 * useful when you want logged-in users sticky across sessions.
 */
export function pickVariant(seed?: string): CoverVariant {
  if (seed === undefined) {
    return Math.random() < 0.5 ? 'A' : 'B';
  }
  // FNV-1a 32-bit hash — fast, deterministic, no crypto dep needed for an A/B coin.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Use the low bit of the hash as the coin.
  return (h & 1) === 0 ? 'A' : 'B';
}

/**
 * Map an illustrative cover path to its realistic counterpart for variant B.
 * - `/assets/foo.png` → `/assets/covers/realistic/foo.png`
 * - already-realistic paths and non-/assets/ URLs pass through unchanged.
 */
export function realisticUrlFor(src: string): string {
  if (!src) return src;
  if (src.startsWith(REALISTIC_PREFIX)) return src;
  if (!src.startsWith(ASSETS_PREFIX)) return src;
  const basename = src.slice(ASSETS_PREFIX.length);
  return `${REALISTIC_PREFIX}${basename}`;
}

/**
 * Pick the URL to render for a given variant.
 */
export function coverUrlForVariant(src: string, variant: CoverVariant): string {
  return variant === 'B' ? realisticUrlFor(src) : src;
}
