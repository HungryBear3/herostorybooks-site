export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Printed copy · Hero Story Books',
  robots: { index: false, follow: false },
};

// Stripe's cancel target. The chooser token lives only in the email link's
// fragment, so this page cannot and does not re-open the chooser itself.
export default async function UpgradeCancelledPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return (
    <main className="min-h-screen bg-cream px-4 py-12 sm:py-16">
      <div className="max-w-xl mx-auto space-y-6 text-center">
        <p className="text-xs uppercase tracking-widest text-gray-500">Printed copy at our cost</p>
        <h1 className="font-serif text-3xl font-bold text-forest">No payment was made</h1>
        <p className="text-gray-700">You left the payment page, so nothing was charged. If you still want a printed copy, open the private link from our email again — the live price may have changed since.</p>
        <p className="text-xs text-gray-400 pt-2">Order ID · {orderId}</p>
      </div>
    </main>
  );
}
