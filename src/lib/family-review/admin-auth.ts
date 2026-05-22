/**
 * Family-review admin session.
 *
 * Replaces the previous `?key=` query-string admin auth with an
 * HttpOnly cookie set by POST /api/family-review/admin/login. The
 * reviewer key is never carried in URLs, browser history, referer
 * headers, server access logs, or admin-board screenshots.
 *
 * Cookie:
 *   name      fr_admin_session
 *   value     the reviewer key string (compared against env at every
 *             check; nothing derived from it is sent back to the
 *             browser besides the cookie itself)
 *   HttpOnly  yes — JS can't read it
 *   Secure    yes in production / on Vercel; off only for local http://
 *   SameSite  Strict — never sent on cross-origin nav (no referer
 *             leakage either)
 *   Path      / — also needed for /api/family-review/admin/* asset GETs
 *             which sit outside /family-review
 *   Max-Age   8 hours — short enough that a forgotten browser window
 *             times out before the next workday
 *
 * The check helpers come in two flavors:
 *   - isAdminCookieValid() : for async server components / page.tsx
 *     (uses next/headers cookies() which is async in Next 15+).
 *   - isAdminRequestAuthed(req) : for route handlers where the cookie
 *     ships on the inbound Request.
 */

import { cookies } from 'next/headers';

export const ADMIN_COOKIE_NAME = 'fr_admin_session';
export const ADMIN_COOKIE_MAX_AGE = 8 * 60 * 60; // 8 hours

const DEFAULT_ADMIN_KEY = 'reviewer-preview';

export function expectedAdminKey(): string {
  return process.env.FAMILY_REVIEW_ADMIN_KEY || DEFAULT_ADMIN_KEY;
}

/** True iff the env-defined key matches what the cookie carries. */
function keysMatch(provided: string | undefined): boolean {
  if (!provided) return false;
  const expected = expectedAdminKey();
  // Constant-ish length compare; both sides are short server-only
  // strings so timing leakage isn't meaningful, but compare lengths
  // first so an early-exit on length mismatch is the only fast path.
  if (provided.length !== expected.length) return false;
  let acc = 0;
  for (let i = 0; i < provided.length; i += 1) {
    acc |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return acc === 0;
}

/** For server components / pages: returns true iff the cookie is set + valid. */
export async function isAdminCookieValid(): Promise<boolean> {
  const jar = await cookies();
  const raw = jar.get(ADMIN_COOKIE_NAME)?.value;
  return keysMatch(raw?.trim());
}

/** For API route handlers: parses the Cookie header off the inbound Request. */
export function isAdminRequestAuthed(req: Request): boolean {
  const header = req.headers.get('cookie') || '';
  // Tiny tolerant parser — finds `fr_admin_session=<value>` ignoring
  // surrounding spaces or other cookies. Cookie values follow
  // RFC 6265 quoted-string-or-token, but we URL-decoded what we
  // wrote so we URL-decode here too.
  const match = header.match(/(?:^|;\s*)fr_admin_session=([^;]*)/);
  if (!match) return false;
  let value: string;
  try {
    value = decodeURIComponent(match[1]);
  } catch {
    value = match[1];
  }
  return keysMatch(value.trim());
}

/** Common cookie-set options used by login. Exported so logout can mirror. */
export function adminCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict';
  path: '/';
} {
  const secure =
    process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
  };
}
