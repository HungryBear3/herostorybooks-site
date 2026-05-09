import { NextResponse, type NextRequest } from 'next/server';

import {
  COVER_VARIANT_COOKIE,
  COVER_VARIANT_COOKIE_MAX_AGE,
  parseVariantCookie,
  pickVariant,
} from '@/lib/cover-variant';

// Set the cover-variant cookie server-side on first hit so server-rendered pages
// can read it without a client flash. 7-day persistence; sticky per visitor.
export function middleware(request: NextRequest) {
  const existing = parseVariantCookie(request.cookies.get(COVER_VARIANT_COOKIE)?.value);
  if (existing) return NextResponse.next();

  const assigned = pickVariant();
  const response = NextResponse.next();
  response.cookies.set({
    name: COVER_VARIANT_COOKIE,
    value: assigned,
    maxAge: COVER_VARIANT_COOKIE_MAX_AGE,
    path: '/',
    sameSite: 'lax',
  });
  // Surface the variant to server components via a request header copy too.
  response.headers.set('x-cover-variant', assigned);
  return response;
}

export const config = {
  // Skip API routes, _next assets, static files. We only need the cookie on
  // pages that render covers (home, /samples, /pricing, /checkout, etc.).
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|assets|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|txt|xml)).*)'],
};
