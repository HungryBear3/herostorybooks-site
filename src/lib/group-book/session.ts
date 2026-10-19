import type { NextResponse } from 'next/server';

export const GROUP_BOOK_ACCESS_COOKIE = 'hsb_group_book_family_access';

const MAX_COOKIE_SECONDS = 60 * 60 * 24 * 45;

/**
 * The cookie only carries the capability; it is not its expiry. Lifetime is
 * capped at the invite's server-side expiry, and every request re-resolves the
 * invite, so an expired or revoked capability grants nothing even if a
 * browser still holds the cookie.
 */
export function setGroupBookAccessCookie(response: NextResponse, token: string, expiresAt: string, now = Date.now()): void {
  const untilExpiry = Math.floor((Date.parse(expiresAt) - now) / 1000);
  const maxAge = Math.min(MAX_COOKIE_SECONDS, untilExpiry);
  if (!(maxAge > 0)) return;
  response.cookies.set(GROUP_BOOK_ACCESS_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/group-book',
    maxAge,
  });
}

export const GROUP_BOOK_PRIVATE_HEADERS = {
  'Cache-Control': 'no-store, private',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
} as const;
