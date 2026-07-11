import type { Metadata } from 'next';
import Link from 'next/link';

import { CHECKOUT_PAUSED_MESSAGE, isCheckoutPaused } from '@/lib/checkout-pause';

import { PaidMemoryBetaForm } from './paid-memory-beta-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Private Custom Family Book Beta | Hero Story Books',
  description:
    'Private friends-and-family custom memory book beta with payment receipt, human review, proof approval, and no automatic print.',
  robots: {
    index: false,
    follow: false,
  },
};

function CheckoutPaused() {
  return (
    <main className="min-h-screen bg-cream px-6 py-16">
      <div className="mx-auto max-w-2xl rounded-3xl border border-amber-200 bg-white p-8 text-center shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-700">Temporarily paused</p>
        <h1 className="mt-3 font-serif text-3xl font-bold text-forest">Custom book beta is paused</h1>
        <p className="mt-4 text-sm text-gray-700">{CHECKOUT_PAUSED_MESSAGE}</p>
        <Link href="/" className="mt-6 inline-flex rounded-full bg-forest px-5 py-3 text-sm font-semibold text-white">
          Back to home
        </Link>
      </div>
    </main>
  );
}

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === 'true' || value === '"true"';
}

export default function CustomMemoryPaidBetaPage() {
  if (isCheckoutPaused()) return <CheckoutPaused />;

  const paidBetaEnabled =
    envFlag('HSB_CUSTOM_STORY_PAID_BETA') || envFlag('NEXT_PUBLIC_HSB_CUSTOM_STORY_PAID_BETA');

  return <PaidMemoryBetaForm paidBetaEnabled={paidBetaEnabled} />;
}
