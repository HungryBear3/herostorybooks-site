import { timingSafeEqualStr } from './cron-auth.ts';

export const ADMIN_COOKIE = 'hsb-ops-key';

export function getConfiguredAdminKey(): string | undefined {
  // Trim the classic dashboard paste artifact; a whitespace-only value still
  // fails closed. Mirrors family-review/admin-auth.ts:37.
  return process.env.HSB_ORDER_ADMIN_KEY?.trim() || undefined;
}

/**
 * The one admin session cookie carried by a raw `Cookie` header, or `null` when
 * there is no unambiguous one.
 *
 * Shared by both readers on purpose. `isAdminAuthedFromRequest` scans the header
 * itself while the ops pages go through `next/headers`, and those two disagreed
 * on a duplicate `hsb-ops-key`: Next's RequestCookies collapses same-name entries
 * keeping the LAST, a plain scan keeps the FIRST. So `a; real` authed the page
 * and denied the API, and `real; a` did the reverse — anyone able to write a
 * cookie on the apex (XSS, or a subdomain setting `Domain=.`) could lock
 * operators out of every mutation route while the dashboard still rendered.
 *
 * Duplicates are therefore rejected rather than resolved, in both readers and in
 * either order. Not "accept if any copy matches": a stale or injected duplicate
 * must not be made harmless just because a valid credential also appears.
 *
 * Anchors on a cookie-name boundary so a look-alike name can neither shadow the
 * real cookie nor stand in for it. Cf. family-review/admin-auth.ts:70.
 */
export function readAdminSessionCookie(cookieHeader: string | null | undefined): string | null {
  const pattern = new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([^;]*)`, 'g');
  let found: string | null = null;
  for (const match of (cookieHeader ?? '').matchAll(pattern)) {
    if (found !== null) return null;
    try {
      found = decodeURIComponent(match[1]);
    } catch {
      // A malformed escape can only match if the configured key *is* that
      // literal string, so falling back to the raw value grants nothing.
      found = match[1];
    }
  }
  return found;
}

export function isAdminAuthedFromRequest(request: Request): boolean {
  const configured = getConfiguredAdminKey();
  if (!configured) return false;
  const header = request.headers.get('x-hsb-order-admin-key');
  if (header && timingSafeEqualStr(header, configured)) return true;
  const cookie = readAdminSessionCookie(request.headers.get('cookie'));
  if (cookie === null) return false;
  return timingSafeEqualStr(cookie, configured);
}
