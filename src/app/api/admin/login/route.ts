import { NextResponse } from 'next/server';

import { ADMIN_COOKIE, getConfiguredAdminKey } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const configured = getConfiguredAdminKey();
  if (!configured) {
    return NextResponse.json({ error: 'Admin key not configured on server' }, { status: 503 });
  }

  const form = await request.formData();
  const key = String(form.get('key') ?? '');
  if (key !== configured) {
    const url = new URL('/admin/orders?err=1', request.url);
    return NextResponse.redirect(url, { status: 303 });
  }

  const url = new URL('/admin/orders', request.url);
  const res = NextResponse.redirect(url, { status: 303 });
  res.cookies.set(ADMIN_COOKIE, configured, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  return res;
}
