import { getConfiguredAdminKey } from '@/lib/admin-auth';
import { isAdminAuthedFromCookie } from '@/lib/admin-auth-server';
import { isCheckoutPaused } from '@/lib/checkout-pause';
import { KillSwitchDurabilityError, getKillSwitchSnapshot } from '@/lib/ops-kill-switches';

import KillSwitchesClient from './kill-switches-client';

export const dynamic = 'force-dynamic';

type PageProps = {
  searchParams?: Promise<{ err?: string }>;
};

export default async function AdminKillSwitchesPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};

  if (!getConfiguredAdminKey()) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="bg-white border border-gray-200 rounded-2xl p-8 max-w-md text-center">
          <h1 className="font-serif text-2xl font-bold text-forest mb-2">Kill switches disabled</h1>
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

  // KS durability surface: if the durable store can't be reached, the
  // entire console is unsafe to use. Render a hard warning instead of
  // the toggle UI so the operator does not flip a switch that won't
  // propagate. The /api/admin/kill-switches route enforces the same
  // posture (HTTP 503 + code DURABILITY_FAILED) for direct callers.
  type Snapshot = Awaited<ReturnType<typeof getKillSwitchSnapshot>>;
  let snapshot: Snapshot | null = null;
  let durabilityErrorMessage: string | null = null;
  try {
    snapshot = await getKillSwitchSnapshot();
  } catch (err) {
    if (err instanceof KillSwitchDurabilityError) {
      durabilityErrorMessage = err.message;
    } else {
      throw err;
    }
  }

  if (durabilityErrorMessage || !snapshot) {
    const message = durabilityErrorMessage ?? 'Kill-switch snapshot unavailable';
    void message;
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4 py-12">
        <div
          data-testid="kill-switches-durability-failed"
          className="max-w-2xl rounded-2xl border-2 border-coral/40 bg-coral/10 p-8 text-coral-dark space-y-3"
        >
          <h1 className="font-serif text-2xl font-bold">
            Kill-switch console is UNSAFE TO USE
          </h1>
          <p className="text-sm font-semibold">
            DURABILITY_FAILED — durable kill-switch state could not be read.
          </p>
          <p className="text-sm leading-6">
            Toggling a switch from this page may not propagate to other Vercel
            function instances, and every enforcement seam (KS-2 / KS-3 / KS-6)
            will fail-closed (refuse the underlying action) on every request
            until the durable store is restored.
          </p>
          <p className="text-xs font-mono break-words opacity-80">{durabilityErrorMessage ?? 'unknown durability error'}</p>
          <p className="text-sm leading-6">
            <strong>Action:</strong> verify <code className="bg-coral/20 px-1 rounded">BLOB_READ_WRITE_TOKEN</code> is set
            and Vercel Blob is reachable from this deploy. Until then, use the
            env-var fallback <code className="bg-coral/20 px-1 rounded">HSB_CHECKOUT_PAUSED=true</code> for any KS-1 pause
            (the env-var path is consulted before the file/blob check).
          </p>
        </div>
      </div>
    );
  }

  return (
    <KillSwitchesClient
      initialSnapshot={snapshot}
      envCheckoutPaused={isCheckoutPaused()}
    />
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
