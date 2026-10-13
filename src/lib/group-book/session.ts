import type { NextResponse } from 'next/server';

export const GROUP_BOOK_ACCESS_COOKIE = 'hsb_group_book_family_access';

export function setGroupBookAccessCookie(response: NextResponse, token: string): void {
  response.cookies.set(GROUP_BOOK_ACCESS_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/group-book',
    maxAge: 60 * 60 * 24 * 45,
  });
}

export const GROUP_BOOK_PRIVATE_HEADERS = {
  'Cache-Control': 'no-store, private',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
} as const;
