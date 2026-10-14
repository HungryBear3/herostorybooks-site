import { NextResponse } from 'next/server';

import { handlePrintUpgradeOfferPost } from '@/lib/print-upgrade-route-handler';
import { printUpgradeRouteDeps } from '@/lib/print-upgrade-route-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Customer chooser bootstrap: token in the JSON body, uniform 404 on any denial. */
export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params;
  return handlePrintUpgradeOfferPost<NextResponse>(request, orderId, printUpgradeRouteDeps());
}
