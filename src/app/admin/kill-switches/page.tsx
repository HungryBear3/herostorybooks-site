import { getConfiguredAdminKey } from '@/lib/admin-auth';
import { isAdminAuthedFromCookie } from '@/lib/admin-auth-server';
import { isCheckoutPaused } from '@/lib/checkout-pause';
import { getKillSwitchSnapshot } from '@/lib/ops-kill-switches';

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

  return (
    <KillSwitchesClient
      initialSnapshot={await getKillSwitchSnapshot()}
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
