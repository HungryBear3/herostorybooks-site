import { NextResponse } from 'next/server';


import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { getOrder } from '@/lib/orders';
import {
  calculatePrintUpgrade,
  parsePrintUpgradeTargetFormat,
  type PrintUpgradeProvider,
} from '@/lib/print-upgrades';


export const dynamic = 'force-dynamic';


export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orderId } = await context.params;

  let body: {
    targetFormat?: unknown;
    printProvider?: unknown;
    createCheckout?: unknown;
    confirmCreateCheckout?: unknown;
  } = {};
  try {
    body = await request.json();
  } catch {
    // Defaults below keep the internal smoke path fast.
  }

  const targetFormat = parsePrintUpgradeTargetFormat(body.targetFormat) ?? 'premium';
  const printProvider: PrintUpgradeProvider =
    typeof body.printProvider === 'string' && body.printProvider.trim().length > 0
      ? body.printProvider.trim()
      : 'rpi';
  const createCheckout = body.createCheckout === true && body.confirmCreateCheckout === true;

  const order = await getOrder(orderId);
  if (!order) {
    return NextResponse.json({ error: 'order_not_found' }, { status: 404 });
  }

  const upgrade = calculatePrintUpgrade(order, targetFormat);
  if (upgrade.ok === false) {
    return NextResponse.json({ error: upgrade.error }, { status: upgrade.status });
  }

  if (!createCheckout) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      orderId: order.id,
      targetFormat: upgrade.targetFormat,
      amountCents: upgrade.amountCents,
      printProvider,
      safety: 'Preview only. No Stripe Checkout Session, email, print job, or provider action was created.',
    });
  }
  return NextResponse.json({
    error: 'print_upgrade_checkout_retired',
    safety: 'Preview only. No Stripe Checkout Session or payable obligation was created.',
  }, { status: 410 });
}
