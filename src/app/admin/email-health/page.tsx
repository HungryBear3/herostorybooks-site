import { getConfiguredAdminKey } from '@/lib/admin-auth';
import { isAdminAuthedFromCookie } from '@/lib/admin-auth-server';
import { EMAIL_HEALTH_RULE, type EmailHealthStatus, type WebhookSecretStatus } from '@/lib/email-health';
import { getEmailHealthSnapshot, type EmailHealthSnapshot } from '@/lib/email-health-snapshot';

export const dynamic = 'force-dynamic';

type PageProps = { searchParams?: Promise<{ err?: string }> };

const TONE: Record<EmailHealthStatus, { bg: string; label: string }> = {
  RED: { bg: '#991b1b', label: 'RED · NOT launch-ready' },
  YELLOW: { bg: '#854d0e', label: 'YELLOW · configured, not verified' },
  GREEN: { bg: '#14532d', label: 'GREEN · launch-ready' },
};

function fmtAge(ms: number | null): string {
  if (ms === null) return 'no events yet';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

function SecretChip({ status }: { status: WebhookSecretStatus }) {
  const map = {
    configured: { label: 'configured', color: '#14532d' },
    missing: { label: 'missing', color: '#991b1b' },
    blank: { label: 'blank', color: '#991b1b' },
  } as const;
  const s = map[status];
  return (
    <span className="font-mono text-[11px] uppercase" style={{ color: s.color }}>
      {s.label}
    </span>
  );
}

export default async function EmailHealthPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};

  if (!getConfiguredAdminKey()) {
    return (
      <main className="min-h-screen bg-cream px-4 py-10">
        <div className="mx-auto max-w-xl rounded-lg border border-gray-200 bg-white p-6">
          <h1 className="font-serif text-2xl font-bold text-forest">Email Health disabled</h1>
          <p className="mt-2 text-sm text-gray-600">Set HSB_ORDER_ADMIN_KEY to enable this ops view.</p>
        </div>
      </main>
    );
  }
  if (!(await isAdminAuthedFromCookie())) return <LoginCard error={params.err === '1'} />;

  const snap: EmailHealthSnapshot = await getEmailHealthSnapshot();
  const tone = TONE[snap.status];

  return (
    <div className="min-h-screen bg-cream text-gray-900">
      <div
        className="sticky top-0 z-40 border-b-2 px-5 py-3"
        style={{ backgroundColor: tone.bg, color: '#fff' }}
        data-testid="email-health-banner"
        data-status={snap.status}
      >
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
          <span className="font-mono text-xs uppercase tracking-wider opacity-80">Email Health (Resend)</span>
          <span className="font-mono text-sm font-bold">{tone.label}</span>
          <span className="ml-auto font-mono text-xs opacity-80">
            launch-ready: {snap.launchReady ? 'YES' : 'NO'}
          </span>
        </div>
      </div>

      <main className="mx-auto max-w-5xl space-y-6 px-5 py-8">
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="font-serif text-lg font-bold text-forest">What GREEN requires</h2>
          <p className="mt-1 text-sm text-gray-600">{EMAIL_HEALTH_RULE.GREEN}</p>
          <p className="mt-1 text-xs text-gray-500">
            Configured ≠ verified — a registered webhook only reaches YELLOW. A recent, real event stream is
            required for GREEN. Zero or stale events are never GREEN.
          </p>
        </section>

        {(snap.blockers.length > 0 || snap.warnings.length > 0) && (
          <section className="rounded-xl border border-gray-200 bg-white p-5" data-testid="why-list">
            <h2 className="font-serif text-lg font-bold text-forest">Why — blockers &amp; warnings</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {snap.blockers.map((b, i) => (
                <li key={`b${i}`} className="flex gap-2">
                  <span className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-red-800">blocker</span>
                  <span className="text-gray-700">{b}</span>
                </li>
              ))}
              {snap.warnings.map((w, i) => (
                <li key={`w${i}`} className="flex gap-2">
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-amber-800">warning</span>
                  <span className="text-gray-700">{w}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          <section className="rounded-xl border border-gray-200 bg-white p-5" data-testid="webhook-panel">
            <h2 className="font-serif text-lg font-bold text-forest">Webhook configuration</h2>
            <ul className="mt-3 space-y-1.5 text-sm">
              <li className="flex items-center justify-between">
                <span className="text-gray-700">Endpoint</span>
                <span className="font-mono text-xs">POST /api/webhooks/resend</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-gray-700">RESEND_WEBHOOK_SECRET</span>
                <SecretChip status={snap.webhookSecret} />
              </li>
              <li className="flex items-center justify-between">
                <span className="text-gray-700">Required events</span>
                <span className="font-mono text-[11px]">delivered · bounced · complained</span>
              </li>
            </ul>
            <p className="mt-3 rounded bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
              Print provider is separate: <span className="font-mono">LULU_WEBHOOK_SECRET</span>{' '}
              <SecretChip status={snap.luluWebhookSecret} /> — not part of Resend readiness.
            </p>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5" data-testid="severity-panel">
            <h2 className="font-serif text-lg font-bold text-forest">Event severity (last 24h)</h2>
            <ul className="mt-3 space-y-1.5 text-sm">
              <li className="flex items-center justify-between">
                <span className="text-gray-700">Last event</span>
                <span className="font-mono text-xs" data-testid="last-event">
                  {fmtAge(snap.lastEventAgeMs)}
                  {snap.stale ? ' · STALE' : ''}
                </span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-gray-700">Delivered</span>
                <span className="font-mono text-xs">{snap.counts.delivered}</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-gray-700">Bounced</span>
                <span className="font-mono text-xs">{snap.counts.bounced}</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-gray-700">Complained</span>
                <span className="font-mono text-xs">{snap.counts.complained}</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-gray-700">Persistence</span>
                <span
                  className="font-mono text-[11px] uppercase"
                  data-testid="persistence-state"
                  style={{ color: snap.persistenceOk ? '#14532d' : '#991b1b' }}
                >
                  {snap.persistenceOk ? 'healthy' : 'FAILING'}
                </span>
              </li>
            </ul>
          </section>
        </div>

        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="font-serif text-lg font-bold text-forest">Manual fallback checklist</h2>
          <p className="mt-1 text-xs text-gray-500">
            Required while not GREEN. Manual checks do NOT turn this monitor GREEN — they record a human
            spot-check, they do not verify the automated event pipeline.
          </p>
          <ul className="mt-3 space-y-1.5 text-sm text-gray-700">
            <li>☐ Sent a test order email and confirmed delivery in the Resend dashboard.</li>
            <li>☐ Confirmed the webhook endpoint is registered with delivered/bounced/complained.</li>
            <li>☐ Checked the bounce/complaint rate is within tolerance.</li>
          </ul>
        </section>

        <p className="text-center text-[11px] text-gray-400">
          Generated {snap.generatedAt.slice(0, 19).replace('T', ' ')}Z · presence/status only — no secret values
          are read or shown.
        </p>
      </main>
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
        <h1 className="font-serif text-2xl font-bold text-forest">Ops sign-in</h1>
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
        <button type="submit" className="w-full px-4 py-2 rounded-lg font-semibold text-sm" style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}>
          Sign in
        </button>
      </form>
    </div>
  );
}
