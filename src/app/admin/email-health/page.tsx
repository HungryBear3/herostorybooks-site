import { getConfiguredAdminKey } from '@/lib/admin-auth';
import { isAdminAuthedFromCookie } from '@/lib/admin-auth-server';
import {
  listResendEvents,
  summarizeResendBounces,
  RESEND_EVENT_TYPES,
  type ResendEventType,
} from '@/lib/resend-events';

export const dynamic = 'force-dynamic';

type PageProps = { searchParams?: Promise<{ err?: string; window?: string }> };

/**
 * Admin-only read-only Resend bounce/complaint monitor.
 *
 * Surfaces the ingested webhook event log so ops can spot bounce or
 * complaint trends without opening the Resend dashboard. This page
 * does NOT make any outbound network call — it reads only the local
 * event log written by /api/webhooks/resend.
 *
 * Empty-state copy explicitly tells ops if the webhook hasn't been
 * configured / hasn't received any events yet, so an empty list is
 * never silently mistaken for "all green".
 */
export default async function AdminEmailHealthPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};

  if (!getConfiguredAdminKey()) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="bg-white border border-gray-200 rounded-2xl p-8 max-w-md text-center">
          <h1 className="font-serif text-2xl font-bold text-forest mb-2">Email health disabled</h1>
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

  // Default 24h window; allow ?window=72 for a longer view. Capped in
  // summarizeResendBounces so a runaway query can't scan beyond the
  // module's retention limit.
  const windowHours = (() => {
    const n = Number.parseInt(params.window ?? '24', 10);
    if (!Number.isFinite(n) || n <= 0) return 24;
    return Math.min(n, 24 * 14);
  })();
  const summary = await summarizeResendBounces({ windowHours });
  const recent = await listResendEvents({ limit: 50 });
  const webhookSecretConfigured = Boolean(process.env.RESEND_WEBHOOK_SECRET);

  return (
    <div className="min-h-screen bg-cream px-4 py-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-serif text-3xl font-bold text-forest">Email health</h1>
            <p className="text-sm text-gray-500">
              Read-only Resend webhook monitor — trailing {summary.windowHours}h —{' '}
              <time dateTime={summary.generatedAt}>{summary.generatedAt.slice(0, 19).replace('T', ' ')}Z</time>
            </p>
          </div>
        </header>

        {!webhookSecretConfigured && (
          <section
            data-testid="email-health-webhook-unconfigured"
            className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900"
          >
            <p className="font-semibold">RESEND_WEBHOOK_SECRET is not set in this environment.</p>
            <p className="mt-1 leading-6">
              The webhook ingestion route at <code className="font-mono">/api/webhooks/resend</code> will refuse
              all inbound events with 503 until the secret is configured in Vercel AND the Resend dashboard
              webhook is pointed at <code className="font-mono">https://&lt;deploy&gt;/api/webhooks/resend</code>.
              Until then, this page can only render historical events ingested under a prior configuration —
              an empty list does NOT mean delivery is healthy. See{' '}
              <code className="font-mono">docs/ops/hsb-resend-bounce-monitoring-2026-06-02.md</code> for setup.
            </p>
          </section>
        )}

        <section
          data-testid="email-health-summary"
          className="grid gap-3 sm:grid-cols-4"
        >
          {RESEND_EVENT_TYPES.map((type) => (
            <SummaryCard key={type} type={type} value={summary.totals[type]} />
          ))}
        </section>

        <section className="bg-white border border-gray-200 rounded-2xl p-5">
          <h2 className="text-xs uppercase tracking-wider text-gray-500 mb-3">
            Recent bounces (last {summary.windowHours}h, top 25)
          </h2>
          {summary.recentBounces.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="email-health-bounces-empty">
              No bounces captured in the trailing window.
            </p>
          ) : (
            <ul className="space-y-2 text-xs">
              {summary.recentBounces.map((ev) => (
                <li
                  key={ev.id}
                  data-testid="email-health-bounce-row"
                  className="rounded border border-coral/30 bg-coral/10 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-coral-dark">
                      {ev.createdAt.slice(0, 19).replace('T', ' ')}Z
                    </span>
                    {ev.bounceType && (
                      <span className="rounded-full bg-coral/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-coral-dark">
                        {ev.bounceType}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-coral-dark">
                    <span className="font-semibold">{ev.to ?? '(unknown recipient)'}</span>
                    {ev.subject && <span className="text-coral-dark/80"> — {ev.subject}</span>}
                  </div>
                  {ev.bounceReason && (
                    <p className="mt-1 text-coral-dark/90">{ev.bounceReason}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-white border border-gray-200 rounded-2xl p-5">
          <h2 className="text-xs uppercase tracking-wider text-gray-500 mb-3">
            Recent complaints (last {summary.windowHours}h, top 25)
          </h2>
          {summary.recentComplaints.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="email-health-complaints-empty">
              No complaints captured in the trailing window.
            </p>
          ) : (
            <ul className="space-y-2 text-xs">
              {summary.recentComplaints.map((ev) => (
                <li
                  key={ev.id}
                  data-testid="email-health-complaint-row"
                  className="rounded border border-amber-300 bg-amber-50 px-3 py-2"
                >
                  <span className="font-mono text-[11px] text-amber-900">
                    {ev.createdAt.slice(0, 19).replace('T', ' ')}Z
                  </span>
                  <div className="mt-1 text-amber-900">
                    <span className="font-semibold">{ev.to ?? '(unknown recipient)'}</span>
                    {ev.subject && <span className="text-amber-900/80"> — {ev.subject}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-white border border-gray-200 rounded-2xl p-5">
          <h2 className="text-xs uppercase tracking-wider text-gray-500 mb-3">
            Recent events (top 50, all types)
          </h2>
          {recent.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="email-health-recent-empty">
              No events ingested yet.
            </p>
          ) : (
            <ol className="space-y-1 text-xs">
              {recent.map((ev) => (
                <li key={ev.id} className="font-mono text-[11px] text-gray-700">
                  <span className="text-gray-400">{ev.createdAt.slice(0, 19).replace('T', ' ')}Z</span>
                  {' · '}
                  <span className="font-semibold text-gray-800">{ev.type}</span>
                  {ev.to && <span className="text-gray-500"> · to {ev.to}</span>}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

function SummaryCard({ type, value }: { type: ResendEventType; value: number }) {
  const tone =
    type === 'email.bounced'
      ? 'border-coral/30 bg-coral/5 text-coral-dark'
      : type === 'email.complained'
        ? 'border-amber-300 bg-amber-50 text-amber-900'
        : type === 'email.delivered' || type === 'email.opened' || type === 'email.clicked'
          ? 'border-forest/30 bg-forest/5 text-forest'
          : 'border-gray-200 bg-white text-gray-700';
  return (
    <div className={`rounded-xl border px-4 py-3 ${tone}`}>
      <div className="text-[10px] uppercase tracking-wider opacity-70">{type}</div>
      <div className="mt-1 font-serif text-2xl">{value}</div>
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
        <h1 className="font-serif text-2xl font-bold text-forest">Email health sign-in</h1>
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
