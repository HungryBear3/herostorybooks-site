import { getOrder } from '@/lib/orders';
import { PROOF_TURNAROUND_WINDOW } from '@/lib/proof-turnaround';
import { PendingConfirmation } from './pending-confirmation';

// This page MUST be honest about payment state. Do not show success copy
// based on URL params alone — Stripe redirects here on completion AND a
// customer can also land here via a stale link, browser-back, or before
// the webhook has stamped paymentStatus=paid. We server-fetch the order
// and branch by paymentStatus so the page never lies about payment.
export const dynamic = 'force-dynamic';

type ThankYouPageProps = {
  searchParams?: Promise<{
    orderId?: string;
    childName?: string;
    format?: string;
    email?: string;
    sessionId?: string;
  }>;
};

export default async function ThankYouPage({ searchParams }: ThankYouPageProps) {
  const params = (await searchParams) || {};
  const orderIdParam = params.orderId?.trim();
  const childNameFallback = params.childName?.trim() || 'Your child';
  const formatFallback = params.format?.trim() || 'storybook';
  const emailFallback = params.email?.trim();
  const sessionId = params.sessionId?.trim();

  // Server-side load the order. If orderId is missing or unknown, fall
  // through to the neutral processing state — never to the success state.
  const order = orderIdParam ? await getOrder(orderIdParam).catch(() => null) : null;

  // Prefer the persisted record over URL params when we have it.
  const childName = order?.childName?.trim() || childNameFallback;
  const format = order?.formatLabel?.trim() || formatFallback;
  const email = order?.email?.trim() || emailFallback;
  const orderId = order?.id ?? orderIdParam;

  // Branch on payment state, defaulting to the safer (neutral) view when
  // we can't confirm 'paid'.
  const paymentStatus = order?.paymentStatus;

  if (paymentStatus === 'paid') {
    return (
      <SuccessView childName={childName} format={format} email={email} orderId={orderId} />
    );
  }

  if (paymentStatus === 'failed') {
    return <FailedView orderId={orderId} />;
  }

  if (paymentStatus === 'refunded') {
    return <RefundedView orderId={orderId} />;
  }

  // pending OR order-not-found OR no orderId — show neutral processing state.
  return <PendingConfirmation orderId={orderId} childName={childName} sessionId={sessionId} />;
}

function SuccessView({
  childName,
  format,
  email,
  orderId,
}: {
  childName: string;
  format: string;
  email: string | undefined;
  orderId: string | undefined;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[var(--cream)] px-4 py-16 space-y-8">
      <div className="text-center">
        <span className="text-7xl">✨</span>
        <h1 className="text-4xl font-bold text-[var(--forest)] mt-4 mb-2">
          {childName}&apos;s Storybook Is In Motion!
        </h1>
        <p className="text-lg text-gray-600 max-w-md mx-auto">
          Your {format} order is saved. We&apos;ll prepare your proof next.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 w-full max-w-md space-y-4">
        <p className="font-semibold text-[var(--forest)] text-base">What happens next</p>
        <div className="space-y-3 text-sm text-gray-700">
          <div className="flex items-start gap-3">
            <span className="text-xl flex-shrink-0">✅</span>
            <div>
              <p className="font-semibold text-[var(--forest)]">Order received</p>
              <p className="text-gray-500">We saved your order details{orderId ? ` under ${orderId}` : ''} so the team can track it cleanly.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="text-xl flex-shrink-0">📱</span>
            <div>
              <p className="font-semibold text-[var(--forest)]">Confirmation + proof-first delivery</p>
              <p className="text-gray-500">
                {email ? `A confirmation was sent to ${email}. ` : ''}
                We email a digital proof first, usually in {PROOF_TURNAROUND_WINDOW}. Once you approve the proof, you receive the final high-resolution PDF for digital orders, or the printed book ships for softcover/hardcover orders.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="text-xl flex-shrink-0">📦</span>
            <div>
              <p className="font-semibold text-[var(--forest)]">Print timeline</p>
              <p className="text-gray-500">If you chose a printed book, production and shipping follow after preview approval. Tracking follows when the book ships.</p>
            </div>
          </div>
        </div>
        <p className="text-sm text-center text-gray-700 pt-3 border-t border-gray-200">
          Questions? support@herostorybooks.com · Print books move to production only after proof approval
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        {orderId ? (
          <a
            href={`/status/${orderId}`}
            className="min-h-12 inline-flex items-center justify-center px-6 py-3 rounded-xl border border-[#8A6F12] font-semibold text-sm text-center"
            style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
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
      </div>
    </div>
  );
}

function FailedView({ orderId }: { orderId: string | undefined }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[var(--cream)] px-4 py-16 space-y-8">
      <div className="text-center">
        <span className="text-7xl">⚠️</span>
        <h1 className="text-4xl font-bold text-[var(--forest)] mt-4 mb-2">
          Your payment didn&apos;t go through
        </h1>
        <p className="text-lg text-gray-600 max-w-md mx-auto">
          Stripe reported a failed payment for this order. No book has been started yet.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 w-full max-w-md space-y-3 text-sm text-gray-700">
        <p className="text-gray-600">
          Most of the time this means the card was declined or the checkout was cancelled.
          You can safely try checkout again — you have not been charged.
        </p>
        {orderId ? (
          <p className="text-gray-500">
            If you reach out to us, please include your order id:{' '}
            <span className="font-mono text-[var(--forest)]">{orderId}</span>.
          </p>
        ) : null}
        <p className="text-sm text-center text-gray-700 pt-3 border-t border-gray-200">
          Questions? support@herostorybooks.com
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <a
          href="/checkout"
          className="min-h-12 inline-flex items-center justify-center px-6 py-3 rounded-xl border border-[#8A6F12] font-semibold text-sm text-center"
          style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
        >
          Try Checkout Again
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

function RefundedView({ orderId }: { orderId: string | undefined }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[var(--cream)] px-4 py-16 space-y-8">
      <div className="text-center">
        <span className="text-7xl">↩️</span>
        <h1 className="text-4xl font-bold text-[var(--forest)] mt-4 mb-2">This order was refunded</h1>
        <p className="text-lg text-gray-600 max-w-md mx-auto">
          Contact us if you need help with the refund or want to place a separate new order.
        </p>
      </div>
      <div className="bg-white rounded-2xl border border-gray-300 shadow-md p-6 w-full max-w-md space-y-3 text-sm text-gray-700">
        <p className="border-l-4 border-amber-600 bg-amber-50 px-4 py-3 text-base font-bold text-gray-900">
          Don&apos;t pay again for this order.
        </p>
        {orderId ? <p>Order ID: <span className="font-mono break-all text-[var(--forest)]">{orderId}</span></p> : null}
        <p className="text-sm text-center text-gray-700 pt-3 border-t border-gray-200">
          Questions? <a className="font-semibold underline underline-offset-2" href="mailto:support@herostorybooks.com">support@herostorybooks.com</a>
        </p>
      </div>
      <div className="flex flex-col sm:flex-row gap-3">
        {orderId ? (
          <a href={`/status/${orderId}`} className="min-h-12 inline-flex items-center justify-center px-6 py-3 rounded-xl border border-[#8A6F12] font-semibold text-sm text-center" style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}>
            View Order Status
          </a>
        ) : null}
        <a href="/" className="min-h-12 inline-flex items-center justify-center px-6 py-3 rounded-xl border-2 border-gray-300 font-semibold text-sm text-center text-[var(--forest)] hover:bg-gray-50 transition">
          Back to Home
        </a>
      </div>
    </div>
  );
}
