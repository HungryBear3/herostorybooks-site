import Link from 'next/link';

import { getConfiguredAdminKey } from '@/lib/admin-auth';
import { isAdminAuthedFromCookie } from '@/lib/admin-auth-server';
import { listReferralStats } from '@/lib/referrals';

export const dynamic = 'force-dynamic';

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default async function AdminReferralsPage() {
  if (!getConfiguredAdminKey()) {
    return (
      <main className="min-h-screen bg-cream px-4 py-10">
        <div className="mx-auto max-w-xl rounded-lg border border-gray-200 bg-white p-6">
          <h1 className="font-serif text-2xl font-bold text-forest">Referral dashboard disabled</h1>
          <p className="mt-2 text-sm text-gray-600">Set HSB_ORDER_ADMIN_KEY to enable admin referral reporting.</p>
        </div>
      </main>
    );
  }

  const authed = await isAdminAuthedFromCookie();
  if (!authed) {
    return (
      <main className="min-h-screen bg-cream px-4 py-10">
        <div className="mx-auto max-w-xl rounded-lg border border-gray-200 bg-white p-6">
          <h1 className="font-serif text-2xl font-bold text-forest">Ops sign-in needed</h1>
          <p className="mt-2 text-sm text-gray-600">
            Sign in through <Link href="/admin/orders" className="underline">Orders · Ops</Link>, then come back here.
          </p>
        </div>
      </main>
    );
  }

  const referrals = await listReferralStats();
  const totals = referrals.reduce(
    (acc, r) => ({
      visits: acc.visits + r.visits,
      conversions: acc.conversions + r.conversions,
      revenueCents: acc.revenueCents + r.revenueCents,
      estimatedEarningsCents: acc.estimatedEarningsCents + r.estimatedEarningsCents,
    }),
    { visits: 0, conversions: 0, revenueCents: 0, estimatedEarningsCents: 0 },
  );

  return (
    <main className="min-h-screen bg-cream px-4 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-serif text-3xl font-bold text-forest">Influencer Referrals</h1>
            <p className="text-sm text-gray-500">Internal profit-share report · manual payouts</p>
          </div>
          <a
            href="/api/admin/referrals?format=csv"
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-forest shadow-sm"
          >
            Export CSV
          </a>
        </header>

        <section className="grid gap-3 md:grid-cols-4">
          <Stat label="Visits" value={totals.visits.toString()} />
          <Stat label="Paid orders" value={totals.conversions.toString()} />
          <Stat label="Revenue" value={dollars(totals.revenueCents)} />
          <Stat label="Est. payouts" value={dollars(totals.estimatedEarningsCents)} />
        </section>

        <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Link</th>
                <th className="px-4 py-3 text-right">Visits</th>
                <th className="px-4 py-3 text-right">Paid</th>
                <th className="px-4 py-3 text-right">Revenue</th>
                <th className="px-4 py-3 text-right">Rate</th>
                <th className="px-4 py-3 text-right">Est. payout</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {referrals.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-gray-500" colSpan={7}>
                    No referral activity yet. Share links like https://herostorybooks.com/r/creator-code.
                  </td>
                </tr>
              ) : (
                referrals.map((r) => (
                  <tr key={r.code}>
                    <td className="px-4 py-3 font-semibold text-forest">{r.code}</td>
                    <td className="px-4 py-3">
                      <Link className="text-forest underline" href={`/partner/${r.code}`}>
                        /r/{r.code}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right">{r.visits}</td>
                    <td className="px-4 py-3 text-right">{r.conversions}</td>
                    <td className="px-4 py-3 text-right">{dollars(r.revenueCents)}</td>
                    <td className="px-4 py-3 text-right">{(r.profitShareRate * 100).toFixed(0)}%</td>
                    <td className="px-4 py-3 text-right font-semibold">{dollars(r.estimatedEarningsCents)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
      <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-forest">{value}</p>
    </div>
  );
}
