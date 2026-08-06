import { NextResponse } from 'next/server';

import { handleRequestLayoutHelpRequest } from '../../../../../lib/proof-layout-route-handler.ts';

export const dynamic = 'force-dynamic';

/**
 * Durable "request help with my layout" review request. Thin wrapper — records a
 * privacy-safe audit event only; no email/provider/print/order-advancement.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  const { status, body } = await handleRequestLayoutHelpRequest(request, orderId);
  return NextResponse.json(body, { status });
}
