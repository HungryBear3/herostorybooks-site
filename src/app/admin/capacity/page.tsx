import { getConfiguredAdminKey } from '@/lib/admin-auth';
import { isAdminAuthedFromCookie } from '@/lib/admin-auth-server';
import {
  buildCapacityDashboardSummary,
  type CapacityDashboardSummary,
  type CapacityRecommendationLevel,
} from '@/lib/capacity-dashboard';
import { listOrders } from '@/lib/orders';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

type PageProps = {
  searchParams?: Promise<{ err?: string }>;
};

export default async function AdminCapacityPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};

  if (!getConfiguredAdminKey()) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="bg-white border border-gray-200 rounded-2xl p-8 max-w-md text-center">
          <h1 className="font-serif text-2xl font-bold text-forest mb-2">Capacity dashboard disabled</h1>
          <p className="text-sm text-gray-600">
            Set <code className="bg-gray-100 px-1 rounded">HSB_ORDER_ADMIN_KEY</code> in the environment to
            enable this page.
          </p>
        </div>
      </div>
    );
  }

  const authed = await isAdminAuthedFromCookie();
  if (!authed) return <LoginCard error={params.err === '1'} />;

  const orders = await listOrders();
  const summary = buildCapacityDashboardSummary(orders);

  return (
    <div className="min-h-screen bg-cream px-4 py-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-serif text-3xl font-bold text-forest">Capacity</h1>
            <p className="text-sm text-gray-500">
              Internal read-only view - {summary.localDay} {summary.timezone} - Generated{' '}
              <time dateTime={summary.generatedAtIso}>{summary.generatedAtIso.slice(0, 19).replace('T', ' ')}Z</time>
            </p>
          </div>
          <nav className="flex flex-wrap gap-2 text-xs">
            <a className="rounded-md border border-gray-200 bg-white px-3 py-1.5 font-semibold text-forest" href="/admin/orders">
              Orders
            </a>
            <a className="rounded-md border border-gray-200 bg-white px-3 py-1.5 font-semibold text-forest" href="/admin/qa-room">
              QA Room
            </a>
            <a className="rounded-md border border-gray-200 bg-white px-3 py-1.5 font-semibold text-forest" href="/admin/kill-switches">
              Kill Switches
            </a>
          </nav>
        </header>

        <RecommendationPanel summary={summary} />

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Capacity metrics">
          <MetricCard
            label="Paid today"
            value={`${summary.paidOrdersToday}/${summary.dailyPaidCeiling}`}
            sub={`Target ${summary.dailyPaidTarget}; pause at ${summary.dailyPaidCeiling}`}
            tone={summary.paidOrdersToday >= summary.dailyPaidCeiling ? 'red' : summary.paidOrdersToday >= summary.dailyPaidTarget ? 'yellow' : 'neutral'}
          />
          <MetricCard
            label="QA in-flight"
            value={`${summary.qaInFlight}`}
            sub="Slowdown trigger above 6"
            tone={summary.qaInFlight > 6 ? 'yellow' : 'neutral'}
          />
          <MetricCard
            label="Oldest proof age"
            value={formatHours(summary.oldestProofAgeHours)}
            sub={summary.oldestProofOrderId ? summary.oldestProofOrderId : 'No awaiting QA proofs'}
            tone={summary.oldestProofAgeHours !== null && summary.oldestProofAgeHours > 36 ? 'yellow' : 'neutral'}
          />
          <MetricCard
            label="Median time-to-proof"
            value={formatHours(summary.medianProofTimeHours)}
            sub={`${summary.proofTimeSampleSize} completed proof sample${summary.proofTimeSampleSize === 1 ? '' : 's'}`}
            tone={summary.medianProofTimeHours !== null && summary.medianProofTimeHours > 36 ? 'yellow' : 'neutral'}
          />
        </section>

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ReadOnlyPanel title="Slowdown Triggers">
            <SignalRow
              label="QA queue above 6"
              value={`${summary.qaInFlight} in-flight`}
              active={summary.qaInFlight > 6}
            />
            <SignalRow
              label="Median time-to-proof above 36h"
              value={summary.medianProofTimeHours === null ? 'Not enough completed proofs' : formatHours(summary.medianProofTimeHours)}
              active={summary.medianProofTimeHours !== null && summary.medianProofTimeHours > 36}
            />
            <SignalRow
              label="Single revision above 2 round-trips"
              value={
                summary.maxRevisionOrderId
                  ? `${summary.maxRevisionRoundTrips} on ${summary.maxRevisionOrderId}`
                  : `${summary.maxRevisionRoundTrips}`
              }
              active={summary.maxRevisionRoundTrips > 2}
            />
          </ReadOnlyPanel>

          <ReadOnlyPanel title="Pause Triggers">
            <SignalRow
              label="10 paid orders today"
              value={`${summary.paidOrdersToday}/${summary.dailyPaidCeiling}`}
              active={summary.paidOrdersToday >= summary.dailyPaidCeiling}
            />
            <SignalRow
              label="QA defect rate above 20% over latest 5 paid"
              value={
                summary.rollingFiveQaDefectRatePercent === null
                  ? 'No paid sample'
                  : `${summary.rollingFiveQaDefectRatePercent}% (${summary.rollingFiveDefectOrderCount}/${summary.rollingFivePaidOrderCount})`
              }
              active={
                summary.rollingFivePaidOrderCount >= 5 &&
                summary.rollingFiveQaDefectRatePercent !== null &&
                summary.rollingFiveQaDefectRatePercent > 20
              }
            />
            <SignalRow
              label="Lulu/RPI acknowledgment delayed above 24h"
              value={
                summary.printAckDelayedCount > 0
                  ? `${summary.printAckDelayedCount} delayed`
                  : 'No delayed local print acknowledgments'
              }
              active={summary.printAckDelayedCount > 0}
            />
            <SignalRow
              label="Stripe dispute opened"
              value="Not available in current order records"
              active={false}
              statusLabel="Manual"
            />
          </ReadOnlyPanel>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white px-4 py-3">
          <h2 className="font-serif text-lg font-semibold text-forest">Operator Notes</h2>
          <ul className="mt-2 list-disc pl-5 text-sm leading-relaxed text-gray-600">
            <li>This page only reads order records through the existing admin order store.</li>
            <li>Checkout auto-pauses before Stripe when the daily paid ceiling is already hit.</li>
            <li>Manual emergency pause remains available: set <code className="rounded bg-gray-100 px-1">HSB_CHECKOUT_PAUSED=true</code>.</li>
            <li>Stripe disputes and external print-provider status should still be checked directly before opening traffic.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

function RecommendationPanel({ summary }: { summary: CapacityDashboardSummary }) {
  const tone = recommendationTone(summary.recommendation.level);
  const reasons = summary.recommendation.reasons.length > 0 ? summary.recommendation.reasons : ['No capacity trigger is currently active from available order data.'];
  return (
    <section className={`rounded-xl border px-4 py-4 ${tone.panel}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className={`text-[10px] uppercase tracking-wider ${tone.muted}`}>Pause recommendation</p>
          <h2 className={`font-serif text-2xl font-bold ${tone.text}`}>{summary.recommendation.label}</h2>
        </div>
        <span className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-mono uppercase tracking-wider ${tone.pill}`}>
          {summary.recommendation.level}
        </span>
      </div>
      <ul className="mt-3 list-disc pl-5 text-sm leading-relaxed">
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {summary.recommendation.unavailableSignals.length > 0 && (
        <div className="mt-3 border-t border-current/20 pt-3">
          <p className={`text-[10px] uppercase tracking-wider ${tone.muted}`}>Manual verification still required</p>
          <ul className="mt-1 list-disc pl-5 text-xs leading-relaxed">
            {summary.recommendation.unavailableSignals.map((signal) => (
              <li key={signal}>{signal}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function MetricCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: 'neutral' | 'yellow' | 'red';
}) {
  const valueClass = tone === 'red' ? 'text-coral-dark' : tone === 'yellow' ? 'text-[#8a6d1a]' : 'text-forest';
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
      <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-bold ${valueClass}`}>{value}</p>
      <p className="mt-1 text-xs text-gray-500">{sub}</p>
    </div>
  );
}

function ReadOnlyPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-serif text-lg font-semibold text-forest">{title}</h2>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-gray-500">
          Read-only
        </span>
      </div>
      <div className="mt-3 divide-y divide-gray-100">{children}</div>
    </section>
  );
}

function SignalRow({
  label,
  value,
  active,
  statusLabel,
}: {
  label: string;
  value: string;
  active: boolean;
  statusLabel?: string;
}) {
  const labelText = statusLabel ?? (active ? 'Active' : 'Clear');
  return (
    <div className="flex items-start justify-between gap-3 py-2 text-sm">
      <div>
        <p className="font-medium text-gray-800">{label}</p>
        <p className="text-xs text-gray-500">{value}</p>
      </div>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider ${
          active ? 'bg-coral/20 text-coral-dark' : 'bg-forest/10 text-forest'
        }`}
      >
        {labelText}
      </span>
    </div>
  );
}

function LoginCard({ error }: { error: boolean }) {
  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <form
        action="/api/admin/login"
        method="post"
        className="bg-white border border-gray-200 rounded-2xl p-8 w-full max-w-sm space-y-4 shadow-sm"
      >
        <h1 className="font-serif text-2xl font-bold text-forest">Capacity sign-in</h1>
        <p className="text-xs text-gray-500">Enter the operator key. Session lasts 12 hours.</p>
        {error && <p className="text-xs text-coral-dark">Incorrect key.</p>}
        <input
          name="key"
          type="password"
          autoFocus
          required
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          placeholder="Operator key"
        />
        <button
          type="submit"
          className="w-full px-4 py-2 rounded-lg font-semibold text-sm"
          style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
        >
          Sign in
        </button>
      </form>
    </div>
  );
}

function formatHours(value: number | null): string {
  return value === null ? 'N/A' : `${value}h`;
}

function recommendationTone(level: CapacityRecommendationLevel) {
  if (level === 'pause') {
    return {
      panel: 'border-coral/40 bg-coral/10 text-coral-dark',
      pill: 'bg-coral/20 text-coral-dark',
      text: 'text-coral-dark',
      muted: 'text-coral-dark/70',
    };
  }
  if (level === 'slowdown') {
    return {
      panel: 'border-[#E6CD7A] bg-[#FFF8E6] text-[#8a6d1a]',
      pill: 'bg-[#E6CD7A]/30 text-[#8a6d1a]',
      text: 'text-[#8a6d1a]',
      muted: 'text-[#8a6d1a]/70',
    };
  }
  return {
    panel: 'border-forest/30 bg-forest/5 text-forest',
    pill: 'bg-forest/10 text-forest',
    text: 'text-forest',
    muted: 'text-forest/70',
  };
}
