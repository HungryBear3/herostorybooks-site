import type { OrderRecord } from './orders.ts';

export interface CheckoutSessionForConfirmation {
  id: string;
  mode?: string | null;
  payment_status?: string | null;
  amount_subtotal?: number | null;
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
}

export type CheckoutConfirmationStatus = 'paid' | 'pending' | 'failed' | 'not_found';

export interface CheckoutConfirmationResult {
  status: CheckoutConfirmationStatus;
  order: OrderRecord | null;
  verifiedViaStripe: boolean;
  reason?: string;
}

export interface CheckoutConfirmationDeps {
  getOrder: (orderId: string) => Promise<OrderRecord | null>;
  retrieveSession: (sessionId: string) => Promise<CheckoutSessionForConfirmation>;
}

export function isExactSettledCheckoutSession(
  session: CheckoutSessionForConfirmation,
  order: OrderRecord,
  requestedSessionId: string,
  expectedSubtotalCents: number = order.priceCents,
): boolean {
  return (
    session.id === requestedSessionId
    && session.mode === 'payment'
    && (
      session.payment_status === 'paid'
      || (session.payment_status === 'no_payment_required' && session.amount_total === 0)
    )
    && session.client_reference_id === order.id
    && session.metadata?.orderId === order.id
    && session.amount_subtotal === expectedSubtotalCents
    && typeof session.amount_total === 'number'
    && session.amount_total >= 0
    && session.amount_total <= session.amount_subtotal
    && session.currency?.toLowerCase() === 'usd'
  );
}

/**
 * Confirms what the customer may safely see after Stripe redirects.
 *
 * This fallback is deliberately read-only. The signed Stripe webhook remains
 * the sole writer of payment state and sole trigger for email/fulfillment.
 * Keeping those side effects single-sourced avoids refund resurrection and
 * cross-instance duplicate fulfillment when webhook and thank-you overlap.
 */
export async function confirmCheckoutPayment(
  input: { orderId: string; stripeSessionId?: string | null },
  deps: CheckoutConfirmationDeps,
): Promise<CheckoutConfirmationResult> {
  const order = await deps.getOrder(input.orderId);
  if (!order) {
    return { status: 'not_found', order: null, verifiedViaStripe: false };
  }

  if (order.paymentStatus === 'paid') {
    return { status: 'paid', order, verifiedViaStripe: false };
  }

  if (
    order.paymentStatus === 'failed'
    || order.paymentStatus === 'partially_refunded'
    || order.paymentStatus === 'refunded'
  ) {
    return { status: 'failed', order, verifiedViaStripe: false };
  }

  const sessionId = input.stripeSessionId?.trim();
  if (!sessionId) {
    return { status: 'pending', order, verifiedViaStripe: false };
  }

  if (order.stripeSessionId && order.stripeSessionId !== sessionId) {
    return {
      status: 'pending',
      order,
      verifiedViaStripe: false,
      reason: 'session_mismatch',
    };
  }

  const session = await deps.retrieveSession(sessionId);
  if (!isExactSettledCheckoutSession(session, order, sessionId)) {
    return {
      status: 'pending',
      order,
      verifiedViaStripe: false,
      reason: 'stripe_not_verified',
    };
  }

  return {
    status: 'paid',
    order,
    verifiedViaStripe: true,
  };
}
