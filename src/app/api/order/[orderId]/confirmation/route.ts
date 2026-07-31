import { NextResponse } from 'next/server';
import Stripe from 'stripe';

import {
  confirmCheckoutPayment,
  type CheckoutSessionForConfirmation,
} from '@/lib/checkout-session-confirmation';
import { getOrder } from '@/lib/orders';
import { getRequiredStripeSecretKey } from '@/lib/stripe-env';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

export async function GET(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  const sessionId = new URL(request.url).searchParams.get('sessionId')?.trim() || null;

  if (!orderId || orderId.length > 128 || (sessionId && (!sessionId.startsWith('cs_') || sessionId.length > 256))) {
    return NextResponse.json({ status: 'not_found' }, { status: 404, headers: NO_STORE_HEADERS });
  }

  try {
    const stripe = sessionId ? new Stripe(getRequiredStripeSecretKey()) : null;
    const result = await confirmCheckoutPayment(
      { orderId, stripeSessionId: sessionId },
      {
        getOrder,
        retrieveSession: async (id) => (
          await stripe!.checkout.sessions.retrieve(id)
        ) as CheckoutSessionForConfirmation,
      },
    );

    const statusCode = result.status === 'not_found' ? 404 : 200;
    return NextResponse.json(
      {
        status: result.status,
        orderId,
        verifiedViaStripe: result.verifiedViaStripe,
      },
      { status: statusCode, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error(`[confirmation] check failed for ${orderId}`, error);
    return NextResponse.json(
      { status: 'pending', orderId, verifiedViaStripe: false },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
