import { getConfiguredAdminKey } from '@/lib/admin-auth';
import { isAdminAuthedFromCookie } from '@/lib/admin-auth-server';
import {
  computeVerdict,
  DEMO_STATE,
  VERDICT_RULE,
  type ControlRoomState,
  type EnvVarState,
  type Verdict,
  type VerdictReason,
} from '@/lib/g5-control-room';

export const dynamic = 'force-dynamic';

type PageProps = { searchParams?: Promise<{ err?: string }> };

// Single source of truth for the demo. Static/demo data only — no env reads,
// no provider calls, no writes.
const STATE: ControlRoomState = DEMO_STATE;

const VERDICT_TONE: Record<Verdict, { bg: string; fg: string; label: string }> = {
  RED: { bg: '#7f1d1d', fg: '#fee2e2', label: 'RED · DO NOT PROCEED' },
  YELLOW: { bg: '#854d0e', fg: '#fef9c3', label: 'YELLOW · OWNER-TEST ONLY' },
  GREEN: { bg: '#14532d', fg: '#dcfce7', label: 'GREEN · CLEARED' },
};

export default async function G5ControlRoomPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};

  if (!getConfiguredAdminKey()) {
    return (
      <main className="min-h-screen bg-cream px-4 py-10">
        <div className="mx-auto max-w-xl rounded-lg border border-gray-200 bg-white p-6">
          <h1 className="font-serif text-2xl font-bold text-forest">G5 Control Room disabled</h1>
          <p className="mt-2 text-sm text-gray-600">Set HSB_ORDER_ADMIN_KEY to enable this ops view.</p>
        </div>
      </main>
    );
  }

  const authed = await isAdminAuthedFromCookie();
  if (!authed) return <LoginCard error={params.err === '1'} />;

  // ── Compute the verdict ONCE; banner + hero both render from this. ──────────
  const verdict = computeVerdict(STATE);
  const tone = VERDICT_TONE[verdict.verdict];

  return (
    <div className="min-h-screen bg-cream text-gray-900">
      {/* Sticky banner — renders verdict.verdict */}
      <div
        className="sticky top-0 z-40 border-b-2 px-5 py-3 backdrop-blur"
        style={{ backgroundColor: tone.bg, color: tone.fg, borderColor: 'rgba(0,0,0,0.3)' }}
        data-testid="sticky-banner"
        data-verdict={verdict.verdict}
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
          <span className="font-mono text-xs uppercase tracking-wider opacity-80">G5 Operator Control Room</span>
          <span className="font-mono text-sm font-bold">{tone.label}</span>
          <span className="ml-auto font-mono text-xs opacity-80">
            static demo · {verdict.blockers.length} blocker{verdict.blockers.length === 1 ? '' : 's'} ·{' '}
            {verdict.warnings.length} warning{verdict.warnings.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <main className="mx-auto max-w-6xl space-y-6 px-5 py-8">
        {/* Hero / Launch verdict — also renders verdict.verdict */}
        <section
          className="rounded-xl border-2 p-6"
          style={{ borderColor: tone.bg }}
          data-testid="hero-verdict"
          data-verdict={verdict.verdict}
        >
          <p className="font-mono text-[11px] uppercase tracking-wider text-gray-500">Launch verdict</p>
          <h1 className="mt-1 font-serif text-3xl font-bold" style={{ color: tone.bg }}>
            {verdict.verdict}
          </h1>
          <p className="mt-2 text-sm text-gray-600">{VERDICT_RULE[verdict.verdict]}</p>
          <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Static demo data only. This view performs no env reads, no provider calls, and no writes. Buttons in
            the reference design are not wired to real controls.
          </p>
        </section>

        {/* Why — blocking & warning conditions */}
        <section className="rounded-xl border border-gray-200 bg-white p-5" data-testid="why-list">
          <h2 className="font-serif text-lg font-bold text-forest">Why — blocking &amp; warning conditions</h2>
          {verdict.blockers.length === 0 && verdict.warnings.length === 0 ? (
            <p className="mt-2 text-sm text-gray-600">No blockers or warnings — all required checks pass.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {verdict.blockers.map((r, i) => (
                <ReasonRow key={`b-${i}`} reason={r} />
              ))}
              {verdict.warnings.map((r, i) => (
                <ReasonRow key={`w-${i}`} reason={r} />
              ))}
            </ul>
          )}
        </section>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Env readiness panel */}
          <section className="rounded-xl border border-gray-200 bg-white p-5" data-testid="env-panel">
            <h2 className="font-serif text-lg font-bold text-forest">01 · Environment Readiness</h2>
            <p className="mt-1 text-xs text-gray-500">Presence / shape only — secret values are never read or shown.</p>
            <ul className="mt-3 space-y-1.5">
              {STATE.env.map((v) => (
                <EnvRow key={v.name} v={v} />
              ))}
            </ul>
          </section>

          {/* Email health panel */}
          <section className="rounded-xl border border-gray-200 bg-white p-5" data-testid="email-panel">
            <h2 className="font-serif text-lg font-bold text-forest">02 · Email Health (Resend)</h2>
            <ul className="mt-3 space-y-1.5 text-sm">
              <BoolRow label="RESEND_WEBHOOK_SECRET present" ok={STATE.email.webhookSecretPresent} />
              <BoolRow label="RESEND_API_KEY present" ok={STATE.email.apiKeyPresent} />
              <li className="flex items-center justify-between">
                <span className="text-gray-700">Last verified event</span>
                <span className="font-mono text-xs uppercase">{STATE.email.health}</span>
              </li>
            </ul>
          </section>
        </div>
      </main>
    </div>
  );
}

function ReasonRow({ reason }: { reason: VerdictReason }) {
  const isBlocker = reason.kind === 'blocker';
  return (
    <li className="flex items-start gap-2 text-sm">
      <span
        className="mt-0.5 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase"
        style={{
          backgroundColor: isBlocker ? '#fee2e2' : '#fef9c3',
          color: isBlocker ? '#991b1b' : '#854d0e',
        }}
      >
        {isBlocker ? 'blocker' : 'warning'}
      </span>
      <span className="text-gray-700">
        <span className="font-mono text-[11px] text-gray-400">[{reason.category}]</span> {reason.message}
      </span>
    </li>
  );
}

function EnvRow({ v }: { v: EnvVarState }) {
  const map = {
    present_prod: { label: 'present (prod)', color: '#14532d' },
    present_nonprod: { label: 'non-prod', color: '#854d0e' },
    missing: { label: 'missing', color: '#991b1b' },
  } as const;
  const s = map[v.status];
  return (
    <li className="flex items-center justify-between text-sm">
      <span className="font-mono text-xs text-gray-700">{v.name}</span>
      <span className="font-mono text-[11px] uppercase" style={{ color: s.color }}>
        {s.label}
      </span>
    </li>
  );
}

function BoolRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <li className="flex items-center justify-between">
      <span className="text-gray-700">{label}</span>
      <span className="font-mono text-[11px] uppercase" style={{ color: ok ? '#14532d' : '#991b1b' }}>
        {ok ? 'present' : 'missing'}
      </span>
    </li>
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
