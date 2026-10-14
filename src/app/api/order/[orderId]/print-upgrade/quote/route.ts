import { NextResponse } from 'next/server';

import { handlePrintUpgradeQuotePost } from '@/lib/print-upgrade-route-handler';
import { printUpgradeRouteDeps } from '@/lib/print-upgrade-route-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Live provider-cost quote for both formats at the customer's address. The
 * provider is `createLuluPrintCostQuoteProvider` (cost calculation only — it
 * never creates a print job); see print-upgrade-route-deps.ts.
 */
export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params;
  return handlePrintUpgradeQuotePost<NextResponse>(request, orderId, printUpgradeRouteDeps());
}
