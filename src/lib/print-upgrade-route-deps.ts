/**
 * Production adapters for the print-upgrade route handlers: the Next response
 * constructor, the Lulu cost-calculation provider, the Stripe Session create
 * with the lib's idempotency key, and the site origin. Nothing here is reached
 * by node:test; the handlers are exercised through doubles instead.
 */
import { NextResponse } from 'next/server';
import Stripe from 'stripe';

import { createLuluPrintCostQuoteProvider } from './lulu.ts';
import type { PrintUpgradeRouteDeps } from './print-upgrade-route-handler.ts';
import { getSiteOrigin } from './site-url.ts';
import { getRequiredStripeSecretKey } from './stripe-env.ts';

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store, max-age=0' };

export function printUpgradeRouteDeps(): PrintUpgradeRouteDeps<NextResponse> {
  return {
    json: (body, status) => NextResponse.json(body, { status, headers: NO_STORE_HEADERS }),
    quoteProvider: () => createLuluPrintCostQuoteProvider(),
    createCheckoutSession: async (params, idempotencyKey) => {
      const stripe = new Stripe(getRequiredStripeSecretKey());
      const session = await stripe.checkout.sessions.create(params, { idempotencyKey });
      return { id: session.id, url: session.url };
    },
    baseUrl: () => getSiteOrigin(),
  };
}
