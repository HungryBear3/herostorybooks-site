import { existsSync } from 'node:fs';
import path from 'node:path';

import { getConfiguredAdminKey } from '@/lib/admin-auth';
import { isAdminAuthedFromCookie } from '@/lib/admin-auth-server';
import { listOrders } from '@/lib/orders';
import {
  analyzeOrderQa,
  dailyCommandBoard,
  defaultMarketingGuardrail,
  evaluatePosture,
  type QaOrderAnalysis,
} from '@/lib/qa-room';

import QaRoomClient from './qa-room-client';

export const dynamic = 'force-dynamic';

type PageProps = { searchParams?: Promise<{ err?: string }> };

export default async function QaRoomPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};

  if (!getConfiguredAdminKey()) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="bg-white border border-border rounded-2xl p-8 max-w-md text-center">
          <h1 className="font-serif text-2xl font-bold text-forest mb-2">QA Production Room disabled</h1>
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
  orders.sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''));

  // The QA gate backend is "installed" when the qa-pass route file exists
  // alongside this server component — we never probe the live route.
  const qaPassRoutePath = path.join(
    process.cwd(),
    'src',
    'app',
    'api',
    'admin',
    'orders',
    '[orderId]',
    'qa-pass',
    'route.ts',
  );
  const gateBackendInstalled = existsSync(qaPassRoutePath);

  const now = new Date();
  const analyses: QaOrderAnalysis[] = orders.map((o) => analyzeOrderQa(o, { now }));
  const posture = evaluatePosture(orders, { gateBackendInstalled, now });
  const marketing = defaultMarketingGuardrail();
  const board = dailyCommandBoard();

  return (
    <QaRoomClient
      analyses={analyses}
      posture={posture}
      marketing={marketing}
      board={board}
      generatedAtIso={now.toISOString()}
    />
  );
}

function LoginCard({ error }: { error: boolean }) {
  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <form
        action="/api/admin/login"
        method="post"
        className="bg-white border border-border rounded-2xl p-8 w-full max-w-sm space-y-4 shadow-sm"
      >
        <h1 className="font-serif text-2xl font-bold text-forest">QA Room sign-in</h1>
        <p className="text-xs text-gray-500">Enter the operator key. Session lasts 12 hours.</p>
        {error && <p className="text-xs text-coral-dark">Incorrect key.</p>}
        <input
          name="key"
          type="password"
          autoFocus
          required
          className="w-full border border-border rounded-lg px-3 py-2 text-sm"
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
