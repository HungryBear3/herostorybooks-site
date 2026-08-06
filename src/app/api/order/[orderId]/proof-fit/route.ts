import { NextResponse } from 'next/server';

import { handleProofFitRequest } from '../../../../../lib/proof-layout-route-handler.ts';

export const dynamic = 'force-dynamic';

/**
 * READ-ONLY authoritative fit check for a proposed proof text-card geometry.
 * The real embedded-font renderer measures the order's authoritative story text
 * and reports whether it overflows, so the customer editor can surface true
 * overflow and disable Save for that exact geometry. Thin wrapper — all auth,
 * gating, and measurement live in the framework-free handler. No mutation.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  const { status, body } = await handleProofFitRequest(request, orderId);
  return NextResponse.json(body, { status });
}
