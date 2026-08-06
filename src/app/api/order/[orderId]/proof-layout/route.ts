import { NextResponse } from 'next/server';

import { handleProofLayoutOverrideRequest } from '../../../../../lib/proof-layout-route-handler.ts';

export const dynamic = 'force-dynamic';

/**
 * Apply or reset a customer's bounded, proof-only positioned text-card override
 * for one page. Thin wrapper — all auth, validation, binding, CAS, lifecycle,
 * and status logic lives in the framework-free handler. Omitting `geometry`
 * (or null) is a reset; `appliedBy` is fixed server-side (never client/token).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  const { status, body } = await handleProofLayoutOverrideRequest(request, orderId);
  return NextResponse.json(body, { status });
}
