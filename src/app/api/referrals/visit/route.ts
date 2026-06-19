import { NextResponse } from 'next/server';

import { recordReferralVisit, sanitizeReferralCode } from '@/lib/referrals';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { code?: unknown };
    const code = sanitizeReferralCode(body.code);
    if (!code) {
      return NextResponse.json({ ok: false, error: 'invalid_code' }, { status: 400 });
    }
    await recordReferralVisit(code);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: 'visit_failed' }, { status: 500 });
  }
}
