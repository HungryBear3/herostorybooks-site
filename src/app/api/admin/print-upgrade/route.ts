import { NextResponse } from 'next/server';
import Stripe from 'stripe';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { getOrder, persistOrder } from '@/lib/orders';
import {
  buildPrintUpgradeDraftEmail,
  buildPrintUpgradeOffer,
  PRINT_UPGRADE_TARGETS,
  type PrintUpgradeTargetFormat,
} from '@/lib/print-upgrade';
import { getRequiredStripeSecretKey } from '@/lib/stripe-env';

function getBaseUrl(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_URL;
  if (configured) {
    return configured.startsWith('http') ? configured : `https://${configured}`;
  }
  return new URL(request.url).origin;
}

function isPrintUpgradeTargetFormat(value: unknown): value is PrintUpgradeTargetFormat {
  return typeof value === 'string' && PRINT_UPGRADE_TARGETS.includes(value as PrintUpgradeTargetFormat);
}

export async function POST(request: Request) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const orderId = typeof body.orderId === 'string' ? body.orderId : '';
  const targetFormat = body.targetFormat;
  const createCheckout = body.createCheckout === true && body.confirmCreateCheckout === true;

  if (!orderId || !isPrintUpgradeTargetFormat(targetFormat)) {
    return NextResponse.json({ error: 'orderId and targetFormat=classic|premium are required' }, { status: 400 });
  }

  const order = await getOrder(orderId);
  if (!order) {
    return NextResponse.json({ error: `Order ${orderId} not found` }, { status: 404 });
  }

  let offer;
  try {
    offer = buildPrintUpgradeOffer(order, targetFormat);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'order is not eligible for print upgrade' },
      { status: 409 },
    );
  }

  const draftEmail = buildPrintUpgradeDraftEmail(offer);

  if (!createCheckout) {
    await persistOrder({
      ...order,
      printUpgradeStatus: order.printUpgradeStatus ?? 'offered',
      printUpgradeTargetFormat: targetFormat,
      updatedAt: new Date().toISOString(),
    });
    return NextResponse.json({
      ok: true,
      dryRun: true,
      offer,
      draftEmail,
      safety: 'No Stripe Checkout Session created. No email sent. No print/provider action triggered.',
    });
  }

  const stripe = new Stripe(getRequiredStripeSecretKey());
  const baseUrl = getBaseUrl(request);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: offer.email,
    client_reference_id: offer.orderId,
    metadata: offer.metadata,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: offer.deltaCents,
          product_data: {
            name: `${targetFormat === 'classic' ? 'Softcover' : 'Hardcover'} print upgrade — ${offer.childName}`,
            description: 'Hero Story Books digital-to-print upgrade. Proof/QA/owner print-go gates still apply.',
          },
        },
        quantity: 1,
      },
    ],
    shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB', 'AU', 'NZ'] },
    success_url: `${baseUrl}/thank-you?orderId=${encodeURIComponent(offer.orderId)}&upgrade=print`,
    cancel_url: `${baseUrl}/checkout?orderId=${encodeURIComponent(offer.orderId)}&upgrade=cancelled`,
  });

  await persistOrder({
    ...order,
    printUpgradeStatus: 'checkout_open',
    printUpgradeStripeSessionId: session.id,
    printUpgradeTargetFormat: targetFormat,
    updatedAt: new Date().toISOString(),
  });

  return NextResponse.json({
    ok: true,
    dryRun: false,
    offer,
    draftEmail,
    checkoutSessionId: session.id,
    checkoutUrl: session.url,
    safety: 'Checkout created only after admin confirmation. No email sent. No print/provider action triggered.',
  });
}
