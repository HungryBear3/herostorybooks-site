import { NextResponse } from 'next/server';

import { handlePrintUpgradeCheckoutPost } from '@/lib/print-upgrade-route-handler';
import { printUpgradeRouteDeps } from '@/lib/print-upgrade-route-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Opens the price-locked Stripe Checkout Session for one quote. The Stripe
 * call is `checkout.sessions.create(params, { idempotencyKey })` in
 * print-upgrade-route-deps.ts, with params built entirely by the lib.
 */
export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params;
  return handlePrintUpgradeCheckoutPost<NextResponse>(request, orderId, printUpgradeRouteDeps());
}
