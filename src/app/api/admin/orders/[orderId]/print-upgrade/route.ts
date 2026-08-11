import { NextResponse } from 'next/server';
import Stripe from 'stripe';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { getOrder } from '@/lib/orders';
import {
  calculatePrintUpgrade,
  parsePrintUpgradeTargetFormat,
  type PrintUpgradeProvider,
} from '@/lib/print-upgrades';
import { getRequiredStripeSecretKey } from '@/lib/stripe-env';

export const dynamic = 'force-dynamic';

function getBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL || process.env.HSB_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  return new URL(request.url).origin;
}

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

  const stripe = new Stripe(getRequiredStripeSecretKey());
  const baseUrl = getBaseUrl(request);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    allow_promotion_codes: true,
    customer_email: order.email,
    client_reference_id: order.id,
    metadata: {
      kind: 'print_upgrade',
      orderId: order.id,
      sourceFormat: upgrade.sourceFormat,
      targetFormat: upgrade.targetFormat,
      printProvider,
    },
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: upgrade.amountCents,
          product_data: {
            name: `${order.childName} HeroStoryBook — ${upgrade.description}`,
            description: 'Internal print upgrade. Promo codes supported in Stripe checkout.',
          },
        },
        quantity: 1,
      },
    ],
    shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB', 'AU', 'NZ'] },
    success_url: `${baseUrl}/thank-you?orderId=${encodeURIComponent(order.id)}&printUpgrade=success`,
    cancel_url: `${baseUrl}/thank-you?orderId=${encodeURIComponent(order.id)}&printUpgrade=cancelled`,
  });

  return NextResponse.json({
    ok: true,
    dryRun: false,
    orderId: order.id,
    targetFormat: upgrade.targetFormat,
    amountCents: upgrade.amountCents,
    printProvider,
    redirectTo: session.url,
    sessionId: session.id,
    safety: 'Checkout created after double confirmation. No email, print job, or provider action was triggered.',
  });
}
