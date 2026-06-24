import { NextResponse } from 'next/server';

import { referralCookieHeaderValue, sanitizeReferralCode } from '@/lib/referrals';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code: rawCode } = await params;
  const code = sanitizeReferralCode(rawCode);
  const target = new URL('/', request.url);
  if (!code) return NextResponse.redirect(target);

  target.searchParams.set('ref', code);
  const response = NextResponse.redirect(target);
  response.headers.append('Set-Cookie', referralCookieHeaderValue(code));
  return response;
}
