import { getConfiguredAdminKey } from '@/lib/admin-auth';
import { isAdminAuthedFromCookie } from '@/lib/admin-auth-server';
import {
  getLaunchHoldSnapshot,
  type LaunchBlocker,
  type LaunchHoldStatus,
} from '@/lib/launch-hold';

export const dynamic = 'force-dynamic';

type PageProps = {
  searchParams?: Promise<{ err?: string }>;
};

export default async function AdminLaunchHoldPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};

  if (!getConfiguredAdminKey()) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="bg-white border border-gray-200 rounded-2xl p-8 max-w-md text-center">
          <h1 className="font-serif text-2xl font-bold text-forest mb-2">Launch HOLD board disabled</h1>
          <p className="text-sm text-gray-600">
            Set <code className="bg-gray-100 px-1 rounded">HSB_ORDER_ADMIN_KEY</code> in the environment
            to enable this page.
          </p>
        </div>
      </div>
    );
  }

  const authed = await isAdminAuthedFromCookie();
  if (!authed) return <LoginCard error={params.err === '1'} />;

  const snapshot = getLaunchHoldSnapshot();

  return (
    <div className="min-h-screen bg-cream px-4 py-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-serif text-3xl font-bold text-forest">Public Launch · HOLD</h1>
            <p className="text-sm text-gray-500">
              Internal only · {snapshot.openCount} open blocker{snapshot.openCount === 1 ? '' : 's'} · Generated{' '}
              <time dateTime={snapshot.generatedAt}>
                {snapshot.generatedAt.slice(0, 19).replace('T', ' ')}Z
              </time>
            </p>
          </div>
          <nav className="flex flex-wrap gap-2 text-xs">
            <a className="rounded-md border border-gray-200 bg-white px-3 py-1.5 font-semibold text-forest" href="/admin/orders">
              Orders
            </a>
          </nav>
        </header>

        <section className="rounded-lg border-2 border-coral/50 bg-coral/10 px-4 py-4">
          <p className="font-mono text-xs uppercase tracking-wider text-coral-dark">Posture</p>
          <p className="mt-1 font-serif text-2xl font-bold text-coral-dark">{snapshot.posture}</p>
          <p className="mt-2 text-sm text-gray-700">
            Public / creator / gifting traffic is <strong>NOT cleared</strong>. {snapshot.note}
          </p>
          <p className="mt-2 text-xs text-gray-500">
            This board is read-only: it has no controls and triggers no order, payment, print, email, or
            provider action. Clearing a blocker is a human decision recorded in its Linear issue.
          </p>
        </section>

        <section className="space-y-3">
          {snapshot.blockers.map((blocker) => (
            <BlockerCard key={blocker.id} blocker={blocker} />
          ))}
        </section>

        <p className="text-center text-[11px] text-gray-400">
          Status values are not derived from environment variables or secret names. A present secret or
          merged doc never marks a gate green here.
        </p>
      </div>
    </div>
  );
}

function BlockerCard({ blocker }: { blocker: LaunchBlocker }) {
  return (
    <article className="rounded-lg border border-gray-200 bg-white px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-serif text-lg font-bold text-forest">
            {blocker.id} · {blocker.title}
          </h2>
          <p className="mt-1 text-sm text-gray-600">{blocker.why}</p>
        </div>
        <StatusChip status={blocker.status} />
      </div>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[120px_1fr]">
        <dt className="text-[11px] uppercase tracking-wider text-gray-500">Owner</dt>
        <dd className="text-gray-700">{blocker.owner}</dd>
        <dt className="text-[11px] uppercase tracking-wider text-gray-500">Evidence to clear</dt>
        <dd className="text-gray-700">{blocker.evidenceRequired}</dd>
        <dt className="text-[11px] uppercase tracking-wider text-gray-500">Linear</dt>
        <dd>
          <a className="font-mono text-forest underline" href={blocker.linearUrl} target="_blank" rel="noreferrer">
            {blocker.id}
          </a>
        </dd>
      </dl>
    </article>
  );
}

function StatusChip({ status }: { status: LaunchHoldStatus }) {
  const label =
    status === 'blocked' ? 'BLOCKED' : status === 'in_progress' ? 'IN PROGRESS' : 'HOLD';
  return (
    <span className="shrink-0 rounded-full bg-coral/15 px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-coral-dark">
      {label}
    </span>
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
