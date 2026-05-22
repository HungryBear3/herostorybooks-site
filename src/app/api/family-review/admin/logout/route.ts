/**
 * POST /api/family-review/admin/logout
 *
 * Always 200. Clears the fr_admin_session cookie (Max-Age=0) using the
 * same options as login so the browser actually purges it. No auth
 * required to call — logging out without auth is a no-op that returns
 * the same shape.
 */

import { NextResponse } from 'next/server';

import {
  ADMIN_COOKIE_NAME,
  adminCookieOptions,
} from '@/lib/family-review/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const res = NextResponse.json({ ok: true }, { status: 200 });
  res.cookies.set({
    name: ADMIN_COOKIE_NAME,
    value: '',
    ...adminCookieOptions(),
    maxAge: 0,
  });
  return res;
}
