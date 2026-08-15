/**
 * Strictly-parsed knobs for the Playwright-managed Next server.
 *
 * Kept in its own module (not inline in playwright.config.ts) so the parsing
 * can be unit-tested by the node suite without importing the Playwright
 * runtime. Playwright never collects this file: its testMatch only picks up
 * *.spec.ts / *.test.ts.
 */

/** Loopback only. The server must not be reachable off the machine. */
export const WEBSERVER_HOST = '127.0.0.1';

/** Readiness budget for `next build && next start`, in milliseconds. */
export const DEFAULT_WEBSERVER_TIMEOUT_MS = 120_000;

/**
 * Dedicated to this one knob. Deliberately NOT a provider, Vercel, or generic
 * production variable — nothing outside this suite reads it, so setting it in
 * CI cannot change product behaviour.
 */
export const WEBSERVER_TIMEOUT_ENV = 'HSB_E2E_WEBSERVER_TIMEOUT_MS';

/** Positive integer, no sign, no leading zero, no separators, no exponent. */
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

export class InvalidWebServerTimeoutError extends Error {
  constructor(raw: string) {
    super(
      `${WEBSERVER_TIMEOUT_ENV} must be a positive whole number of milliseconds; `
      + `received ${JSON.stringify(raw)}. `
      + `Unset it to use the default of ${DEFAULT_WEBSERVER_TIMEOUT_MS}ms.`,
    );
    this.name = 'InvalidWebServerTimeoutError';
  }
}

/**
 * Resolve the webServer readiness timeout.
 *
 * Absent (or literally undefined) means the default. ANY other value must be a
 * positive whole number of milliseconds; everything else throws rather than
 * being coerced. Failing closed matters here: a silently-mangled timeout would
 * either hang CI or produce a false red that looks like a product failure.
 *
 * Rejected on purpose: '' (empty), whitespace, '0', negatives, fractions,
 * exponent notation, hex, 'Infinity', 'NaN', thousands separators, leading
 * zeros, and anything beyond Number.MAX_SAFE_INTEGER.
 */
export function resolveWebServerTimeoutMs(
  raw: string | undefined = process.env[WEBSERVER_TIMEOUT_ENV],
): number {
  if (raw === undefined) return DEFAULT_WEBSERVER_TIMEOUT_MS;
  if (!POSITIVE_INTEGER.test(raw)) throw new InvalidWebServerTimeoutError(raw);
  const parsed = Number(raw);
  // The regex already excludes non-numerics; this catches overflow past the
  // safe-integer range, where Number() silently rounds.
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new InvalidWebServerTimeoutError(raw);
  return parsed;
}
