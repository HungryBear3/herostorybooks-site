/**
 * GA anonymous identity, read fail-closed from bounded first-party cookies.
 *
 * `_ga` carries the anonymous client id shared by every GA property on the
 * site. The session id and session number belong to ONE property and live in
 * that property's own `_ga_<container>` cookie, so they are read only from the
 * exact cookie name derived from the property's measurement id — never from a
 * look-alike, a differently-cased name, or another property's cookie.
 *
 * Cookies are browser- and third-party-writable. Every rule here answers the
 * same way when it cannot be sure: nothing. A duplicated cookie is ambiguous
 * (which one is ours?), a malformed percent escape or an unknown layout is
 * unreadable, and an oversized header is not scanned at all. The GS2 `h`
 * segment (a hashed user id) is never read.
 *
 * Isomorphic and dependency-free: the checkout form and the server share it.
 */

/** The GA4 property the root layout loads (src/app/layout.tsx). */
export const HSB_GA4_MEASUREMENT_ID = 'G-68FKEDZEG3';

export const GA_COOKIE_HEADER_MAX_LENGTH = 16_384;
export const GA_COOKIE_MAX_PAIRS = 200;
export const GA_COOKIE_VALUE_MAX_LENGTH = 256;

export interface GaCookieIdentity {
  clientId: string | null;
  sessionId: string | null;
  sessionNumber: string | null;
}

const NO_IDENTITY: GaCookieIdentity = Object.freeze({ clientId: null, sessionId: null, sessionNumber: null });

const MEASUREMENT_ID_RE = /^G-([A-Z0-9]{4,20})$/;
const CLIENT_COOKIE_RE = /^GA1\.\d{1,2}\.(\d{1,20}\.\d{1,20})$/;
/** A GA session id is the session's start time in Unix seconds. */
const SESSION_ID_RE = /^[1-9]\d{9}$/;
const SESSION_NUMBER_RE = /^[1-9]\d{0,5}$/;
const GS1_FIELD_RE = /^\d{1,20}$/;
const GS2_TOKEN_RE = /^([a-z])([A-Za-z0-9._~+/=-]{0,128})$/;
const GS2_MAX_TOKENS = 24;

/** The server-side shape check for a client id already extracted from `_ga`. */
export function sanitizeGaClientId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{1,20}\.\d{1,20}$/.test(trimmed) ? trimmed : null;
}

export function sanitizeGaSessionId(value: unknown): string | null {
  return typeof value === 'string' && SESSION_ID_RE.test(value) ? value : null;
}

export function sanitizeGaSessionNumber(value: unknown): string | null {
  return typeof value === 'string' && SESSION_NUMBER_RE.test(value) ? value : null;
}

/** `_ga_<container>` for a well-formed GA4 measurement id, else null. */
export function gaSessionCookieName(measurementId: unknown): string | null {
  if (typeof measurementId !== 'string') return null;
  const match = MEASUREMENT_ID_RE.exec(measurementId);
  return match ? `_ga_${match[1]}` : null;
}

function decodeCookieValue(raw: string): string | null {
  if (raw.length > GA_COOKIE_VALUE_MAX_LENGTH) return null;
  if (!raw.includes('%')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Every value carried by `name`, or null when the header cannot be scanned
 * within bounds. Names match exactly: no case folding, no decoding.
 */
function cookieValues(header: string, names: readonly string[]): Map<string, string[]> | null {
  if (header.length > GA_COOKIE_HEADER_MAX_LENGTH) return null;
  const parts = header.split(';');
  if (parts.length > GA_COOKIE_MAX_PAIRS) return null;
  const found = new Map<string, string[]>(names.map((name) => [name, []]));
  for (const part of parts) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    const name = part.slice(0, equals).trim();
    const values = found.get(name);
    if (values) values.push(part.slice(equals + 1).trim());
  }
  return found;
}

/** Exactly one occurrence, decodable, within bounds — otherwise nothing. */
function onlyValue(values: string[] | undefined): string | null {
  if (!values || values.length !== 1) return null;
  return decodeCookieValue(values[0]);
}

function clientIdFrom(value: string | null): string | null {
  if (value === null) return null;
  return CLIENT_COOKIE_RE.exec(value)?.[1] ?? null;
}

function sessionFrom(value: string | null): Pick<GaCookieIdentity, 'sessionId' | 'sessionNumber'> | null {
  if (value === null) return null;
  if (value.startsWith('GS1.')) {
    const fields = value.split('.');
    if (fields.length < 5 || fields.length > 12) return null;
    if (!fields.slice(1).every((field) => GS1_FIELD_RE.test(field))) return null;
    const sessionId = sanitizeGaSessionId(fields[2]);
    const sessionNumber = sanitizeGaSessionNumber(fields[3]);
    return sessionId && sessionNumber ? { sessionId, sessionNumber } : null;
  }
  const gs2 = /^GS2\.\d{1,2}\.(.+)$/.exec(value);
  if (!gs2) return null;
  const tokens = gs2[1].split('$');
  if (tokens.length > GS2_MAX_TOKENS) return null;
  const seen = new Map<string, string>();
  for (const token of tokens) {
    const match = GS2_TOKEN_RE.exec(token);
    if (!match) return null;
    const [, key, tokenValue] = match;
    if (key !== 's' && key !== 'o') continue;
    if (seen.has(key)) return null;
    seen.set(key, tokenValue);
  }
  const sessionId = sanitizeGaSessionId(seen.get('s'));
  const sessionNumber = sanitizeGaSessionNumber(seen.get('o'));
  return sessionId && sessionNumber ? { sessionId, sessionNumber } : null;
}

export function readGaCookieIdentity(
  cookieHeader: unknown,
  measurementId: string = HSB_GA4_MEASUREMENT_ID,
): GaCookieIdentity {
  if (typeof cookieHeader !== 'string') return NO_IDENTITY;
  const sessionCookie = gaSessionCookieName(measurementId);
  const values = cookieValues(cookieHeader, sessionCookie ? ['_ga', sessionCookie] : ['_ga']);
  if (!values) return NO_IDENTITY;
  const session = sessionCookie ? sessionFrom(onlyValue(values.get(sessionCookie))) : null;
  return {
    clientId: clientIdFrom(onlyValue(values.get('_ga'))),
    sessionId: session?.sessionId ?? null,
    sessionNumber: session?.sessionNumber ?? null,
  };
}
