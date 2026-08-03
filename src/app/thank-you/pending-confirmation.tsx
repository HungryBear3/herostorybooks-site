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
        <span className="text-6xl sm:text-7xl" aria-hidden>✅</span>
        <div className="text-center" role="status" aria-live="polite">
          <h1 className="text-3xl sm:text-4xl font-bold text-[var(--forest)] mb-2">
            Payment confirmed
          </h1>
          <p className="text-base sm:text-lg text-gray-700 max-w-md mx-auto text-pretty">
            Stripe confirmed the payment for {childName}&apos;s order.
          </p>
        </div>
        <div className="bg-white rounded-2xl border border-gray-300 shadow-md p-5 sm:p-6 w-full max-w-md space-y-3 text-sm text-gray-700">
          <p className="border-l-4 border-amber-600 bg-amber-50 px-4 py-3 text-base font-bold text-gray-900 text-pretty">
            Don&apos;t pay again — you&apos;d be charged a second time.
          </p>
          <p>
            Order ID: <span className="font-mono break-all text-[var(--forest)]">{orderId}</span>
          </p>
          <p className="text-gray-700">
            Your payment went through. We&apos;re finishing the order record now. Your confirmation email and digital proof follow from there; nothing else is needed from you.
          </p>
          <p className="text-sm text-center text-gray-700 pt-3 border-t border-gray-200">
            Questions? <a className="font-semibold underline underline-offset-2" href={`mailto:support@herostorybooks.com?subject=Order ${encodeURIComponent(orderId ?? '')}`}>support@herostorybooks.com</a>
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 w-full max-w-md sm:justify-center">
          <a
            href={`/status/${orderId}`}
            className="min-h-12 inline-flex items-center justify-center px-6 py-3 rounded-xl border border-[#8A6F12] font-semibold text-sm text-center"
            style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
          >
            View Order Status
          </a>
          <a
            href="/"
            className="min-h-12 inline-flex items-center justify-center px-6 py-3 rounded-xl border-2 border-gray-300 font-semibold text-sm text-center text-[var(--forest)] hover:bg-gray-50 transition"
          >
            Back to Home
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[var(--cream)] px-4 py-10 sm:py-16 space-y-6 sm:space-y-8">
      <div
        className="h-14 w-14 rounded-full border-4 border-amber-200 border-t-amber-600 animate-spin"
        aria-hidden="true"
      />
      <div className="text-center" role="status" aria-live="polite">
        <h1 className="text-3xl sm:text-4xl font-bold text-[var(--forest)] mb-2 text-balance">
          {showSupportState ? 'Your order is saved — we are checking it' : 'Checking your payment…'}
        </h1>
        <p className="text-base sm:text-lg text-gray-700 max-w-md mx-auto text-pretty">
          {showSupportState
            ? `We could not display the final confirmation yet for ${childName}'s order.`
            : `Stripe returned you to us. We are checking ${childName}'s order now.`}
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-300 shadow-md p-5 sm:p-6 w-full max-w-md space-y-3 text-sm text-gray-700">
        <p className="border-l-4 border-amber-600 bg-amber-50 px-4 py-3 text-base font-bold text-gray-900 text-pretty">
          Don&apos;t pay again — it could create a duplicate charge.
        </p>
        {orderId ? (
          <p>
            Order ID: <span className="font-mono break-all text-[var(--forest)]">{orderId}</span>
          </p>
        ) : null}
        <p className="text-gray-700 text-pretty">
          {showSupportState
            ? 'Save your order ID and email us. We will check the payment with Stripe first, and we will not ask you to pay again.'
            : 'This usually resolves within a few seconds. The page updates automatically.'}
        </p>
        <p className="text-sm text-center text-gray-700 pt-3 border-t border-gray-200">
          Questions? <a className="font-semibold underline underline-offset-2" href={`mailto:support@herostorybooks.com${orderId ? `?subject=Order ${encodeURIComponent(orderId)}` : ''}`}>support@herostorybooks.com</a>
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 w-full max-w-md sm:justify-center">
        {showSupportState ? (
          <>
            <a
              href={`mailto:support@herostorybooks.com?subject=${encodeURIComponent(orderId ? `Payment check — Order ${orderId}` : 'Payment check')}`}
              className="min-h-12 inline-flex items-center justify-center px-6 py-3 rounded-xl border border-[#8A6F12] font-semibold text-sm text-center"
              style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
            >
              Email Us About This Order
            </a>
            {orderId ? (
              <a
                href={`/status/${orderId}`}
                className="min-h-12 inline-flex items-center justify-center px-6 py-3 rounded-xl border-2 border-gray-300 font-semibold text-sm text-center text-[var(--forest)] hover:bg-gray-50 transition"
              >
                View Order Status
              </a>
            ) : (
              <a
                href="/"
                className="min-h-12 inline-flex items-center justify-center px-6 py-3 rounded-xl border-2 border-gray-300 font-semibold text-sm text-center text-[var(--forest)] hover:bg-gray-50 transition"
              >
                Back to Home
              </a>
            )}
          </>
        ) : (
          <>
            {orderId ? (
              <a
                href={`/status/${orderId}`}
                className="min-h-12 inline-flex items-center justify-center px-6 py-3 rounded-xl border-2 border-gray-300 font-semibold text-sm text-center text-[var(--forest)] hover:bg-gray-50 transition"
              >
                View Order Status
              </a>
            ) : null}
            <a
              href="/"
              className="min-h-12 inline-flex items-center justify-center px-6 py-3 rounded-xl border-2 border-gray-300 font-semibold text-sm text-center text-[var(--forest)] hover:bg-gray-50 transition"
            >
              Back to Home
            </a>
          </>
        )}
      </div>
    </div>
  );
}
