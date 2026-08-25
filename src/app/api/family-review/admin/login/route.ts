/**
 * POST /api/family-review/admin/login
 *
 * Body: { key: string }
 *
 * Validates the reviewer key against FAMILY_REVIEW_ADMIN_KEY and, on
 * match, sets the fr_admin_session cookie (HttpOnly, Secure-in-prod,
 * SameSite=Strict, Path=/, Max-Age=8h). On miss, returns a 401 with no
 * detail — the admin board's login UI surfaces a generic "not valid"
 * message.
 *
 * The cookie is the ONLY transport for admin auth from this point on.
 * The route also strips any pre-existing fr_admin_session that didn't
 * match, so a stale cookie can't linger after a key rotation.
 */

import { NextResponse } from 'next/server';

import {
  ADMIN_COOKIE_MAX_AGE,
  ADMIN_COOKIE_NAME,
  adminCookieOptions,
  expectedAdminKey,
} from '@/lib/family-review/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  key?: unknown;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_json' },
      { status: 400 },
    );
  }

  const provided = typeof body.key === 'string' ? body.key.trim() : '';
  const expected = expectedAdminKey();

  if (!expected) {
    const unavailable = NextResponse.json(
      { ok: false, error: 'admin_unavailable' },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
    unavailable.cookies.set({
      name: ADMIN_COOKIE_NAME,
      value: '',
      ...adminCookieOptions(),
      maxAge: 0,
    });
    return unavailable;
  }

  if (
    !provided ||
    provided.length !== expected.length ||
    provided !== expected
  ) {
    // Clear any stale cookie even on a failed attempt so we never
    // leave the browser holding an invalid session.
    const fail = NextResponse.json(
      { ok: false, error: 'forbidden' },
      { status: 401 },
    );
    fail.cookies.set({
      name: ADMIN_COOKIE_NAME,
      value: '',
      ...adminCookieOptions(),
      maxAge: 0,
    });
    return fail;
  }

  const res = NextResponse.json({ ok: true }, { status: 200 });
  res.cookies.set({
    name: ADMIN_COOKIE_NAME,
    value: provided,
    ...adminCookieOptions(),
    maxAge: ADMIN_COOKIE_MAX_AGE,
  });
  return res;
}
