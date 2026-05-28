import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getReferralStats, sanitizeReferralCode } from '@/lib/referrals';

interface Props {
  params: Promise<{ code: string }>;
}

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'Partner Dashboard | HeroStoryBooks',
    robots: { index: false, follow: false },
  };
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default async function PartnerPage({ params }: Props) {
  const { code: rawCode } = await params;
  const code = sanitizeReferralCode(rawCode);
  if (!code) notFound();

  const stats = await getReferralStats(code);
  if (!stats) notFound();

  const link = `https://herostorybooks.com/?ref=${encodeURIComponent(code)}`;
  const conversionRate =
    stats.visits > 0 ? ((stats.conversions / stats.visits) * 100).toFixed(1) : '0.0';

  return (
    <main className="min-h-screen bg-[#f4ecd9] px-4 py-12 text-[#241914]">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <Link href="/" className="text-sm text-[#695f54] hover:text-[#241914]">
            HeroStoryBooks
          </Link>
          <span className="rounded-full border border-[#d8c6a2] px-3 py-1 text-xs uppercase tracking-[0.18em] text-[#695f54]">
            Partner
          </span>
        </div>

        <section className="rounded-lg border border-[#d8c6a2] bg-[#fff8ec] p-6 shadow-sm md:p-8">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-[#6f7f4f]">
            Influencer profit share
          </p>
          <h1 className="mb-3 font-serif text-4xl leading-tight md:text-5xl">
            Partner: {stats.code}
          </h1>
          <p className="mb-5 text-sm leading-6 text-[#695f54]">
            Share this link with your audience. Paid orders attributed to this
            code count toward manual profit-share payouts.
          </p>
          <code className="block rounded-md border border-dashed border-[#b8a27b] bg-white px-4 py-3 text-sm text-[#1d4f43]">
            {link}
          </code>
        </section>

        <section className="mt-5 grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-[#d8c6a2] bg-[#fff8ec] p-5">
            <div className="text-3xl font-semibold">{stats.visits}</div>
            <div className="mt-1 text-sm text-[#695f54]">Link visits</div>
          </div>
          <div className="rounded-lg border border-[#d8c6a2] bg-[#fff8ec] p-5">
            <div className="text-3xl font-semibold">{stats.conversions}</div>
            <div className="mt-1 text-sm text-[#695f54]">Paid orders</div>
          </div>
          <div className="rounded-lg border border-[#c3d0aa] bg-[#f3f7e9] p-5">
            <div className="text-3xl font-semibold text-[#3d5240]">
              {dollars(stats.estimatedEarningsCents)}
            </div>
            <div className="mt-1 text-sm text-[#52644f]">Estimated earnings</div>
          </div>
        </section>

        <section className="mt-5 rounded-lg border border-[#d8c6a2] bg-[#fff8ec] p-6">
          <h2 className="mb-4 font-serif text-2xl">Revenue Summary</h2>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-[#695f54]">Total attributed revenue</span>
              <span className="font-medium">{dollars(stats.revenueCents)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-[#695f54]">Profit share rate</span>
              <span className="font-medium">
                {(stats.profitShareRate * 100).toFixed(0)}%
              </span>
            </div>
            <div className="flex justify-between gap-4 border-t border-[#eadfca] pt-3">
              <span className="font-medium">Estimated payout</span>
              <span className="font-semibold text-[#3d5240]">
                {dollars(stats.estimatedEarningsCents)}
              </span>
            </div>
          </div>
          <p className="mt-4 text-xs leading-5 text-[#695f54]">
            Payouts are estimated and handled manually. Stats update as visits
            and paid Stripe checkouts are recorded.
          </p>
        </section>

        <section className="mt-5 rounded-lg border border-[#d8c6a2] bg-[#fff8ec] p-6">
          <h2 className="mb-2 font-serif text-2xl">Conversion Rate</h2>
          <div className="text-3xl font-semibold">{conversionRate}%</div>
          <p className="mt-2 text-sm text-[#695f54]">
            Best posts show the actual child-safe watercolor samples and make
            the offer concrete: personalized book, proof first, Father&apos;s
            Day gift window.
          </p>
        </section>
      </div>
    </main>
  );
}
