import { NextResponse } from 'next/server';

import { handleAdminPrintUpgradeOfferPost } from '@/lib/print-upgrade-route-handler';
import { printUpgradeRouteDeps } from '@/lib/print-upgrade-route-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Operator action: prepare the customer's one-time at-cost print-upgrade
 * offer and return the chooser URL + email draft. Sends nothing, creates no
 * Stripe Session, and contacts no print provider. The legacy
 * `print-upgrade` admin route (retail-delta preview) is untouched.
 */
export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params;
  return handleAdminPrintUpgradeOfferPost<NextResponse>(request, orderId, printUpgradeRouteDeps());
}
