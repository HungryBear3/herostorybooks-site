import { getConfiguredAdminKey } from '@/lib/admin-auth';
import { isAdminAuthedFromCookie } from '@/lib/admin-auth-server';
import {
  listResendEvents,
  summarizeResendBounces,
  RESEND_EVENT_TYPES,
  ResendEventPersistenceError,
  type ResendEventType,
} from '@/lib/resend-events';

/**
 * If the last event we ingested is older than this, render a stale
 * warning. Operators need to know that "0 bounces in the last 24h"
 * does not mean delivery is healthy when no events of ANY type have
 * arrived in days. Override with EMAIL_HEALTH_STALE_HOURS if a
 * different SLA is wanted.
 */
const DEFAULT_STALE_HOURS = 24;
function getStaleHours(): number {
  const raw = process.env.EMAIL_HEALTH_STALE_HOURS;
  if (!raw) return DEFAULT_STALE_HOURS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_HOURS;
}

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
  // R3 surface: if the durable event log can't be read, render a
  // specific persistence-failure warning instead of letting the
  // exception propagate to a generic Next.js error page. An empty
  // page would also be misleading — the operator MUST see this.
  let summary: Awaited<ReturnType<typeof summarizeResendBounces>> | null = null;
  let recent: Awaited<ReturnType<typeof listResendEvents>> = [];
  let persistenceError: string | null = null;
  try {
    summary = await summarizeResendBounces({ windowHours });
    recent = await listResendEvents({ limit: 50 });
  } catch (err) {
    if (err instanceof ResendEventPersistenceError) {
      persistenceError = err.message;
    } else {
      throw err;
    }
  }
  const webhookSecretConfigured = Boolean(process.env.RESEND_WEBHOOK_SECRET);

  if (persistenceError || !summary) {
    const msg = persistenceError ?? 'Resend event log unavailable';
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4 py-12">
        <div
          data-testid="email-health-persistence-failed"
          className="max-w-2xl rounded-2xl border-2 border-coral/40 bg-coral/10 p-8 text-coral-dark space-y-3"
        >
          <h1 className="font-serif text-2xl font-bold">
            Email-health monitor is UNAVAILABLE
          </h1>
          <p className="text-sm font-semibold">
            PERSISTENCE_FAILED — the Resend event log could not be read durably.
          </p>
          <p className="text-sm leading-6">
            The webhook ingestion route is configured to fail-closed (503) on
            persistence errors so Svix retries; but this admin page also
            cannot render any meaningful state until durable storage is
            restored. An empty list here is NOT a health signal.
          </p>
          <p className="text-xs font-mono break-words opacity-80">{msg}</p>
          <p className="text-sm leading-6">
            <strong>Action:</strong> verify <code className="bg-coral/20 px-1 rounded">BLOB_READ_WRITE_TOKEN</code>{' '}
            and Vercel Blob availability. Fall back to the Resend dashboard for
            bounce/complaint inspection until resolved.
          </p>
        </div>
      </div>
    );
  }

  // R5 freshness derivation. lastEventAt covers the full retention
  // scan (14d) regardless of the current window filter, so the
  // operator sees the most recent event ever ingested even when the
  // trailing window is empty.
  const staleHours = getStaleHours();
  const lastEventAt = summary.lastEventAt;
  const lastEventAgeMs = lastEventAt ? Date.now() - new Date(lastEventAt).getTime() : null;
  const lastEventAgeHours = lastEventAgeMs !== null ? Math.round(lastEventAgeMs / 36e5) : null;
  const noEventsEver = lastEventAt === null;
  const stale =
    !noEventsEver && lastEventAgeHours !== null && lastEventAgeHours > staleHours;

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
            <p
              data-testid="email-health-last-event-at"
              className="mt-1 text-xs text-gray-500"
            >
              {lastEventAt ? (
                <>
                  Last event received:{' '}
                  <time dateTime={lastEventAt}>{lastEventAt.slice(0, 19).replace('T', ' ')}Z</time>{' '}
                  ({lastEventAgeHours}h ago)
                </>
              ) : (
                <>Last event received: never (no events in the {14}d retention window).</>
              )}
            </p>
          </div>
        </header>

        {/* R5 — "configured but never verified" warning. Distinct
            from the "secret unset" banner below: secret IS set but
            no events have ever arrived. Most likely: webhook URL
            isn't registered in the Resend dashboard, or the dashboard
            secret doesn't match RESEND_WEBHOOK_SECRET. An empty list
            in this case is NOT a health signal. */}
        {webhookSecretConfigured && noEventsEver && (
          <section
            data-testid="email-health-configured-not-verified"
            className="rounded-2xl border-2 border-amber-400 bg-amber-50 px-5 py-4 text-sm text-amber-900 space-y-2"
          >
            <p className="font-semibold">
              Webhook secret is configured but NO events have ever been ingested.
            </p>
            <p className="leading-6">
              Configured ≠ verified. Until the first event arrives, this monitor
              cannot tell whether delivery is healthy or whether the webhook is
              simply not wired (URL not registered in Resend, or signature
              mismatch). Send a test event from the Resend dashboard; the
              expected response is HTTP 200 with{' '}
              <code className="font-mono">received: true</code>.
            </p>
          </section>
        )}

        {/* R5 — stale-monitor warning. Events flowed at some point but
            the newest one is older than EMAIL_HEALTH_STALE_HOURS
            (default 24h). Possible causes: webhook delivery broken,
            Svix outage, our endpoint returning 5xx, no real traffic. */}
        {webhookSecretConfigured && stale && (
          <section
            data-testid="email-health-stale-warning"
            className="rounded-2xl border-2 border-amber-400 bg-amber-50 px-5 py-4 text-sm text-amber-900 space-y-2"
          >
            <p className="font-semibold">
              Stale webhook stream: no event in the last {staleHours}h
              (most recent was {lastEventAgeHours}h ago).
            </p>
            <p className="leading-6">
              An empty trailing window is NOT a health signal. Either real
              traffic has stopped (verify in Resend dashboard) or webhook
              delivery is broken (check Resend dashboard's webhook log for
              failed deliveries to our endpoint).
            </p>
          </section>
        )}

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
