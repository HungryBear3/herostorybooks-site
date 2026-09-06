import { NextResponse } from 'next/server';
import Stripe from 'stripe';

import {
  isPrintFormat,
  rollbackOrderMediaUploads,
  uploadOrderPhoto,
  uploadOrderDocument,
  uploadOrderSupportingPhoto,
  uploadOrderVoice,
} from '@/lib/orders';
import { markRecoveryLeadConverted } from '@/lib/recovery';
import { getRequiredStripeSecretKey } from '@/lib/stripe-env';
import { type DirectCheckoutSessionRequest } from '@/lib/checkout-direct-order';
import { createVercelIntakeStore } from '@/lib/checkout-intake';
import { handleCheckoutOrderPost } from '@/lib/checkout-order-route-handler';

function getStripe() {
  return new Stripe(getRequiredStripeSecretKey());
}

/**
 * The whole handler is `handleCheckoutOrderPost`, in lib, because this file
 * cannot be imported under `node:test` (next/server + Stripe) and an
 * un-executable handler cannot be shown to REACH anything. A mutation that made
 * the legacy resume/recovery call unreachable once survived every test in the
 * suite. Everything below is adapters: the response constructor, the provider,
 * the Blob-backed media writes, the intake store, and the recovery-lead write.
 */
export async function POST(request: Request) {
  return handleCheckoutOrderPost<NextResponse>(request, {
    json: (body, httpStatus) => NextResponse.json(body, { status: httpStatus }),
    createCheckoutSession: createDirectCheckoutSession,
    retrieveCheckoutSession: retrieveDirectCheckoutSession,
    createIntakeStore: () => createVercelIntakeStore(),
    uploadOrderPhoto: (orderId, file, leaseId) => uploadOrderPhoto(orderId, file, leaseId),
    uploadOrderSupportingPhoto: (orderId, index, file, leaseId) =>
      uploadOrderSupportingPhoto(orderId, index, file, leaseId),
    uploadOrderVoice: (orderId, file, leaseId) => uploadOrderVoice(orderId, file, leaseId),
    uploadOrderDocument: (orderId, file, leaseId) => uploadOrderDocument(orderId, file, leaseId),
    rollbackOrderMediaUploads: (orderId, pathnames, leaseId) =>
      rollbackOrderMediaUploads(orderId, pathnames, leaseId),
    markRecoveryLeadConverted: (email, orderId) => markRecoveryLeadConverted(email, orderId),
    logError: (message, detail) => console.error(message, detail ?? ''),
  });
}

async function retrieveDirectCheckoutSession(sessionId: string) {
  return getStripe().checkout.sessions.retrieve(sessionId);
}

async function createDirectCheckoutSession(request: DirectCheckoutSessionRequest) {
  const { order, stripeProductId, baseUrl, gaClientId, idempotencyKey } = request;
  // The success URL lands in browser history, referrer headers, and anything
  // that records page location. It carries opaque reconciliation ids only —
  // the thank-you page reads the name, format, and email off the order record.
  const successParams = new URLSearchParams({ orderId: order.id });
  return getStripe().checkout.sessions.create({
    mode: 'payment',
    allow_promotion_codes: true,
    customer_email: order.email,
    client_reference_id: order.id,
    metadata: {
      orderId: order.id,
      ...(gaClientId ? { gaClientId } : {}),
      ...(order.checkoutTracking?.cohort ? { cohort: order.checkoutTracking.cohort } : {}),
      ...(order.checkoutTracking?.invite ? { invite: order.checkoutTracking.invite } : {}),
    },
    payment_intent_data: { metadata: { orderId: order.id } },
    line_items: [{
      price_data: {
        currency: 'usd',
        unit_amount: order.priceCents,
        product: stripeProductId,
      },
      quantity: 1,
    }],
    ...(isPrintFormat(order.bookFormat)
      ? { shipping_address_collection: { allowed_countries: ['US'] as const } }
      : {}),
    success_url: `${baseUrl}/thank-you?${successParams.toString()}&sessionId={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/checkout`,
  }, { idempotencyKey });
}
