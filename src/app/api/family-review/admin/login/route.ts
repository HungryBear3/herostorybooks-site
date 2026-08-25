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

function isBody(value: unknown): value is Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clearAdminSession(response: NextResponse): NextResponse {
  response.cookies.set({
    name: ADMIN_COOKIE_NAME,
    value: '',
    ...adminCookieOptions(),
    maxAge: 0,
  });
  return response;
}

export async function POST(req: Request) {
  const expected = expectedAdminKey();

  if (!expected) {
    return clearAdminSession(
      NextResponse.json(
        { ok: false, error: 'admin_unavailable' },
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        },
      ),
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return clearAdminSession(
      NextResponse.json(
        { ok: false, error: 'invalid_json' },
        {
          status: 400,
          headers: { 'Cache-Control': 'no-store' },
        },
      ),
    );
  }

  if (!isBody(body)) {
    return clearAdminSession(
      NextResponse.json(
        { ok: false, error: 'invalid_body' },
        {
          status: 400,
          headers: { 'Cache-Control': 'no-store' },
        },
      ),
    );
  }

  const provided = typeof body.key === 'string' ? body.key.trim() : '';

  if (
    !provided ||
    provided.length !== expected.length ||
    provided !== expected
  ) {
    // Clear any stale cookie even on a failed attempt so we never
    // leave the browser holding an invalid session.
    return clearAdminSession(
      NextResponse.json(
        { ok: false, error: 'forbidden' },
        {
          status: 401,
          headers: { 'Cache-Control': 'no-store' },
        },
      ),
    );
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
