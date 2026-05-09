import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { resendProofEmail } from '@/lib/admin-actions';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { orderId } = await context.params;
  const baseUrl = process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || new URL(request.url).origin;
  const result = await resendProofEmail(orderId, baseUrl);
  if (result.ok === true) return NextResponse.json({ ok: true });
  return NextResponse.json({ error: result.error }, { status: result.status });
}
