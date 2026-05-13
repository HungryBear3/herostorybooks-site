import Link from 'next/link';

import { CHECKOUT_PAUSED_MESSAGE, isCheckoutPaused } from '@/lib/checkout-pause';
import { CheckoutForm } from './checkout-form';

export const dynamic = 'force-dynamic';

function CheckoutPaused() {
  return (
    <main className="min-h-screen bg-cream px-4 py-10">
      <div className="container mx-auto max-w-2xl">
        <div className="mb-8 flex items-center justify-between">
          <Link href="/" className="text-sm text-gray-500 transition hover:text-forest">
            ← Back
          </Link>
          <span className="font-serif text-lg font-bold text-forest">HeroStoryBooks ✨</span>
          <div className="w-12" />
        </div>

        <section className="rounded-3xl border-2 border-deep-gold/25 bg-white p-8 text-center shadow-lg md:p-12">
          <div className="mb-4 text-6xl">🛠️</div>
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.22em] text-deep-gold">
            Checkout paused
          </p>
          <h1 className="mb-4 font-serif text-4xl text-forest md:text-5xl">
            We&apos;re tuning the story magic
          </h1>
          <p className="mx-auto mb-6 max-w-xl text-lg leading-8 text-gray-700">
            {CHECKOUT_PAUSED_MESSAGE}
          </p>
          <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            No orders or payments can be started while checkout is paused. If you already placed an order, we&apos;re still taking care of it.
          </div>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link
              href="/samples"
              className="rounded-xl border-2 border-deep-gold px-5 py-3 font-bold text-forest transition hover:bg-deep-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-deep-gold"
            >
              View sample stories
            </Link>
            <a
              href="mailto:support@herostorybooks.com"
              className="rounded-xl bg-deep-gold px-5 py-3 font-bold text-white shadow-md transition hover:bg-deep-gold/90"
            >
              Contact support
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}

export default function CheckoutPage() {
  if (isCheckoutPaused()) {
    return <CheckoutPaused />;
  }

  return <CheckoutForm />;
}
