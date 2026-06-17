import { getOrder } from '@/lib/orders';

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
    contributionToken?: string;
  }>;
};

export default async function ThankYouPage({ searchParams }: ThankYouPageProps) {
  const params = (await searchParams) || {};
  const orderIdParam = params.orderId?.trim();
  const childNameFallback = params.childName?.trim() || 'Your child';
  const formatFallback = params.format?.trim() || 'storybook';
  const emailFallback = params.email?.trim();

  // Server-side load the order. If orderId is missing or unknown, fall
  // through to the neutral processing state — never to the success state.
  const order = orderIdParam ? await getOrder(orderIdParam).catch(() => null) : null;

  // Prefer the persisted record over URL params when we have it.
  const childName = order?.childName?.trim() || childNameFallback;
  const format = order?.formatLabel?.trim() || formatFallback;
  const email = order?.email?.trim() || emailFallback;
  const orderId = order?.id ?? orderIdParam;
  const contributionToken =
    order?.familyContributionToken?.trim() || params.contributionToken?.trim() || null;

  // Branch on payment state, defaulting to the safer (neutral) view when
  // we can't confirm 'paid'.
  const paymentStatus = order?.paymentStatus;

  if (paymentStatus === 'paid') {
    return (
      <SuccessView
        childName={childName}
        format={format}
        email={email}
        orderId={orderId}
        contributionToken={contributionToken}
      />
    );
  }

  if (paymentStatus === 'failed') {
    return <FailedView orderId={orderId} />;
  }

  // pending OR order-not-found OR no orderId — show neutral processing state.
  return <PendingView orderId={orderId} childName={childName} />;
}

function SuccessView({
  childName,
  format,
  email,
  orderId,
  contributionToken,
}: {
  childName: string;
  format: string;
  email: string | undefined;
  orderId: string | undefined;
  contributionToken: string | null;
}) {
  const contributionUrl = contributionToken
    ? `/family-contribute/${encodeURIComponent(contributionToken)}`
    : null;
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[var(--cream)] px-4 py-16 space-y-8">
      <div className="text-center">
        <span className="text-7xl">✨</span>
        <h1 className="text-4xl font-bold text-[var(--forest)] mt-4 mb-2">
          {childName}&apos;s Storybook Is In Motion!
        </h1>
        <p className="text-lg text-gray-600 max-w-md mx-auto">
          We&apos;re preparing your custom {format} proof. You&apos;ll receive an email when
          it&apos;s ready for review — nothing prints until you approve.
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
              <p className="font-semibold text-[var(--forest)]">Confirmation + proof for review</p>
              <p className="text-gray-500">
                {email ? `A confirmation was sent to ${email}. ` : ''}
                We&apos;ll email you when your proof is ready for review. Nothing prints until you approve.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="text-xl flex-shrink-0">📦</span>
            <div>
              <p className="font-semibold text-[var(--forest)]">Print timeline</p>
              <p className="text-gray-500">If you chose a printed book, production and shipping follow after preview approval. Typical ship window is 5–7 business days.</p>
            </div>
          </div>
        </div>
        <p className="text-xs text-center text-gray-400 pt-2 border-t border-gray-100">
          Questions? support@herostorybooks.com · Print books move to production only after proof approval
        </p>
      </div>

      {contributionUrl ? (
        <div className="bg-[#FFF8E5] rounded-2xl border border-[#D4AF37]/40 shadow-sm p-6 w-full max-w-md space-y-3">
          <p className="font-semibold text-[var(--forest)] text-base">Invite family to add memories</p>
          <p className="text-sm text-gray-600">
            Share this private link so grandparents, siblings, or friends can add a dedication,
            memory, voice note, story idea, or supporting character photo for {childName}&apos;s book.
          </p>
          <a
            href={contributionUrl}
            className="inline-flex px-5 py-3 rounded-xl font-semibold text-sm text-center"
            style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
          >
            Open Family Invite Link
          </a>
          <p className="break-all rounded-xl bg-white/70 p-3 font-mono text-xs text-gray-500">
            {contributionUrl}
          </p>
        </div>
      ) : null}

      <div className="flex flex-col sm:flex-row gap-3">
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

function PendingView({
  orderId,
  childName,
}: {
  orderId: string | undefined;
  childName: string;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[var(--cream)] px-4 py-16 space-y-8">
      {/* Auto-refresh once after ~20s in case the webhook hasn't landed yet.
          Keeps the page honest without polling aggressively. */}
      <meta httpEquiv="refresh" content="20" />
      <div className="text-center">
        <span className="text-7xl">⏳</span>
        <h1 className="text-4xl font-bold text-[var(--forest)] mt-4 mb-2">
          Confirming your payment…
        </h1>
        <p className="text-lg text-gray-600 max-w-md mx-auto">
          We&apos;re waiting for Stripe to confirm {childName}&apos;s order. This usually takes
          under a minute. This page will refresh automatically.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 w-full max-w-md space-y-3 text-sm text-gray-700">
        <p className="text-gray-600">
          {orderId ? (
            <>
              Your order id is <span className="font-mono text-[var(--forest)]">{orderId}</span>.
              You&apos;ll see the full confirmation here once the payment lands.
            </>
          ) : (
            <>You&apos;ll see the full confirmation here once the payment lands.</>
          )}
        </p>
        <p className="text-gray-500">
          If this page is still confirming after a minute or two, your payment may not have completed.
          You can safely re-try checkout, or contact support and we&apos;ll sort it out.
        </p>
        <p className="text-xs text-center text-gray-400 pt-2 border-t border-gray-100">
          Questions? support@herostorybooks.com
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
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

function FailedView({ orderId }: { orderId: string | undefined }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[var(--cream)] px-4 py-16 space-y-8">
      <div className="text-center">
        <span className="text-7xl">⚠️</span>
        <h1 className="text-4xl font-bold text-[var(--forest)] mt-4 mb-2">
          We couldn&apos;t confirm your payment
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
        <p className="text-xs text-center text-gray-400 pt-2 border-t border-gray-100">
          Questions? support@herostorybooks.com
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <a
          href="/checkout"
          className="px-6 py-3 rounded-xl font-semibold text-sm text-center"
          style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
        >
          Try Checkout Again
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
