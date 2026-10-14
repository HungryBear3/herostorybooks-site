import { getOrder } from '@/lib/orders';
import { printUpgradeCheckoutStatusView } from '@/lib/print-upgrade-checkout';

// Honest about payment state: the view is derived from the persisted record
// keyed by the Session id Stripe redirected with, never from the URL alone.
// It carries no name, email or address.
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Printed copy · Hero Story Books',
  robots: { index: false, follow: false },
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default async function UpgradeDonePage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams?: Promise<{ sessionId?: string }>;
}) {
  const { orderId } = await params;
  const sessionId = ((await searchParams) ?? {}).sessionId?.trim() || null;
  const validSession = sessionId && sessionId.startsWith('cs_') && sessionId.length <= 256 ? sessionId : null;
  const order = validSession && orderId.length <= 128 ? await getOrder(orderId).catch(() => null) : null;
  const view = order ? printUpgradeCheckoutStatusView(order, validSession) : { status: 'unknown' as const };
  const formatName = 'targetFormat' in view ? (view.targetFormat === 'premium' ? 'hardcover' : 'softcover') : null;

  return (
    <main className="min-h-screen bg-cream px-4 py-12 sm:py-16">
      <div className="max-w-xl mx-auto space-y-6 text-center">
        <p className="text-xs uppercase tracking-widest text-gray-500">Printed copy at our cost</p>
        {view.status === 'paid' && (
          <>
            <h1 className="font-serif text-3xl sm:text-4xl font-bold text-forest">Payment received — thank you</h1>
            <p className="text-gray-700">
              We received {dollars(view.amountTotalCents)} for your {formatName} copy. That is exactly our print provider&apos;s cost for print, shipping and handling, fulfillment and tax.
            </p>
            <p className="text-gray-700">
              Next, we prepare the print files for the {formatName} and check them by hand. Nothing is printed automatically: you will get an email with the final print proof to confirm, then another when it goes to print and when it ships.
            </p>
          </>
        )}
        {view.status === 'pending' && (
          <>
            <h1 className="font-serif text-3xl font-bold text-forest">Confirming your payment…</h1>
            <p className="text-gray-700">Stripe is still confirming this payment. Refresh this page in a moment. If you did not complete payment, nothing was charged.</p>
          </>
        )}
        {view.status === 'expired' && (
          <>
            <h1 className="font-serif text-3xl font-bold text-forest">That payment page expired</h1>
            <p className="text-gray-700">Nothing was charged. Open the link from our email again to get a fresh live price.</p>
          </>
        )}
        {view.status === 'unknown' && (
          <>
            <h1 className="font-serif text-3xl font-bold text-forest">We could not match this payment page</h1>
            <p className="text-gray-700">If you just paid, give it a minute and open the confirmation from Stripe again. Otherwise, use the private link from our email.</p>
          </>
        )}
        <p className="text-xs text-gray-400 pt-2">Order ID · {orderId}</p>
      </div>
    </main>
  );
}
