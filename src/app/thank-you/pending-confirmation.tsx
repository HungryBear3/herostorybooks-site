'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  CONFIRMATION_POLL_INTERVAL_MS,
  getConfirmationPollDecision,
} from '@/lib/confirmation-poll';

export function PendingConfirmation({
  orderId,
  childName,
  sessionId,
}: {
  orderId: string | undefined;
  childName: string;
  sessionId: string | undefined;
}) {
  const router = useRouter();
  const startedAt = useRef(Date.now());
  const [showSupportState, setShowSupportState] = useState(!orderId);
  const [stripeConfirmed, setStripeConfirmed] = useState(false);

  useEffect(() => {
    if (!orderId) return;
    let stopped = false;
    let requestInFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      const decision = getConfirmationPollDecision(Date.now() - startedAt.current);
      if (!decision.shouldPoll) {
        setShowSupportState(decision.showSupportState);
        if (timer) clearInterval(timer);
        return;
      }

      if (requestInFlight) return;
      requestInFlight = true;

      const query = new URLSearchParams();
      if (decision.includeStripeSession && sessionId) query.set('sessionId', sessionId);
      const suffix = query.size ? `?${query.toString()}` : '';

      try {
        const response = await fetch(
          `/api/order/${encodeURIComponent(orderId)}/confirmation${suffix}`,
          { cache: 'no-store' },
        );
        if (!response.ok && response.status !== 503 && response.status !== 404) return;
        const body = await response.json() as {
          status?: string;
          verifiedViaStripe?: boolean;
        };
        if (!stopped && body.status === 'paid') {
          stopped = true;
          if (timer) clearInterval(timer);
          if (body.verifiedViaStripe) {
            setStripeConfirmed(true);
          } else {
            router.refresh();
          }
        } else if (!stopped && body.status === 'failed') {
          stopped = true;
          if (timer) clearInterval(timer);
          router.refresh();
        }
      } catch {
        // A transient network failure leaves the truthful pending state visible.
      } finally {
        requestInFlight = false;
      }
    };

    void poll();
    timer = setInterval(() => { void poll(); }, CONFIRMATION_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [orderId, router, sessionId]);

  if (stripeConfirmed) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[var(--cream)] px-4 py-10 sm:py-16 space-y-6 sm:space-y-8">
        <div className="text-center" role="status" aria-live="polite">
          <span className="text-6xl sm:text-7xl" aria-hidden>✅</span>
          <h1 className="text-3xl sm:text-4xl font-bold text-[var(--forest)] mt-4 mb-2">
            Payment confirmed
          </h1>
          <p className="text-base sm:text-lg text-gray-600 max-w-md mx-auto">
            Stripe confirmed the payment for {childName}&apos;s order.
          </p>
        </div>
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 sm:p-6 w-full max-w-md space-y-3 text-sm text-gray-700">
          <p className="font-semibold text-[var(--forest)]">Do not submit another payment.</p>
          <p>
            Order ID: <span className="font-mono break-all text-[var(--forest)]">{orderId}</span>
          </p>
          <p className="text-gray-500">
            We are finalizing your saved order status now. Your confirmation email and proof-first delivery steps follow from the secure payment update.
          </p>
          <p className="text-xs text-center text-gray-400 pt-2 border-t border-gray-100">
            Questions? <a className="underline" href={`mailto:support@herostorybooks.com?subject=Order ${encodeURIComponent(orderId ?? '')}`}>support@herostorybooks.com</a>
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 w-full max-w-md sm:justify-center">
          <a
            href={`/status/${orderId}`}
            className="px-6 py-3 rounded-xl font-semibold text-sm text-center"
            style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
          >
            View Order Status
          </a>
          <a
            href="/"
            className="px-6 py-3 rounded-xl border-2 border-gray-200 font-semibold text-sm text-center text-[var(--forest)] hover:bg-gray-50 transition"
          >
            Back to Home
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[var(--cream)] px-4 py-10 sm:py-16 space-y-6 sm:space-y-8">
      <div className="text-center" role="status" aria-live="polite">
        <span className="text-6xl sm:text-7xl" aria-hidden>⏳</span>
        <h1 className="text-3xl sm:text-4xl font-bold text-[var(--forest)] mt-4 mb-2">
          {showSupportState ? 'Your order is saved — we are checking it' : 'Confirming your payment…'}
        </h1>
        <p className="text-base sm:text-lg text-gray-600 max-w-md mx-auto">
          {showSupportState
            ? `We could not display the final confirmation yet for ${childName}'s order.`
            : `Stripe returned you to us. We are checking ${childName}'s order now.`}
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 sm:p-6 w-full max-w-md space-y-3 text-sm text-gray-700">
        <p className="font-semibold text-[var(--forest)]">
          Do not submit another payment while we verify this one.
        </p>
        {orderId ? (
          <p>
            Order ID: <span className="font-mono break-all text-[var(--forest)]">{orderId}</span>
          </p>
        ) : null}
        <p className="text-gray-500">
          {showSupportState
            ? 'Keep this page or your order ID and contact us. We will verify the Stripe payment before asking you to do anything else.'
            : 'This usually resolves within a few seconds. The page updates automatically.'}
        </p>
        <p className="text-xs text-center text-gray-400 pt-2 border-t border-gray-100">
          Questions? <a className="underline" href={`mailto:support@herostorybooks.com${orderId ? `?subject=Order ${encodeURIComponent(orderId)}` : ''}`}>support@herostorybooks.com</a>
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 w-full max-w-md sm:justify-center">
        {orderId ? (
          <a
            href={`/status/${orderId}`}
            className="px-6 py-3 rounded-xl font-semibold text-sm text-center"
            style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
          >
            View Order Status
          </a>
        ) : null}
        <a
          href="/"
          className="px-6 py-3 rounded-xl border-2 border-gray-200 font-semibold text-sm text-center text-[var(--forest)] hover:bg-gray-50 transition"
        >
          Back to Home
        </a>
      </div>
    </div>
  );
}
