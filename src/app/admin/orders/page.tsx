import { getConfiguredAdminKey } from '@/lib/admin-auth';
import { isAdminAuthedFromCookie } from '@/lib/admin-auth-server';
import { listOrders } from '@/lib/orders';
import type { OrderRecord } from '@/lib/orders';
import { deriveOrderAttention } from '@/lib/order-stage';

import AdminOrdersClient from './ops-client';

export const dynamic = 'force-dynamic';

type PageProps = {
  searchParams?: Promise<{ err?: string; q?: string }>;
};

export default async function AdminOrdersPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};

  if (!getConfiguredAdminKey()) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="bg-white border border-gray-200 rounded-2xl p-8 max-w-md text-center">
          <h1 className="font-serif text-2xl font-bold text-forest mb-2">Ops dashboard disabled</h1>
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

  const orders = await listOrders();
  orders.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  const stats = summarize(orders);

  return (
    <div className="min-h-screen bg-cream px-4 py-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="font-serif text-3xl font-bold text-forest">Orders · Ops</h1>
            <p className="text-sm text-gray-500">
              Internal only · {orders.length} orders loaded ·{' '}
              <a href="/admin/qa-room" className="text-forest underline hover:no-underline">
                QA Production Room ↗
              </a>
              {' · '}
              <a href="/admin/capacity" className="text-forest underline hover:no-underline">
                Capacity
              </a>
              {' · '}
              <a href="/admin/kill-switches" className="text-forest underline hover:no-underline">
                Kill Switches
              </a>
            </p>
          </div>
          <div className="flex gap-3 text-xs">
            <Stat label="Paid" value={stats.paid} />
            <Stat label="Paid attention" value={stats.paidAttention} tone="failure" />
            <Stat label="In progress" value={stats.inProgress} />
            <Stat label="Proof ready" value={stats.proofReady} />
            <Stat label="Failed" value={stats.failed} tone="failure" />
          </div>
        </header>

        <AdminOrdersClient orders={orders} />
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: 'neutral' | 'failure' }) {
  const color = tone === 'failure' && value > 0 ? 'text-coral-dark' : 'text-forest';
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-2 text-center">
      <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`font-bold text-lg ${color}`}>{value}</p>
    </div>
  );
}

function summarize(orders: OrderRecord[]) {
  let paid = 0, paidAttention = 0, inProgress = 0, proofReady = 0, failed = 0;
  for (const o of orders) {
    if (o.paymentStatus === 'paid') paid++;
    // Read-only truth layer: count paid orders whose derived attention is non-clear.
    const paidIssue = deriveOrderAttention(o);
    if (o.paymentStatus === 'paid' && paidIssue.severity !== 'none') paidAttention++;
    const f = o.fulfillmentStatus;
    if (f === 'generating_story' || f === 'generating_images' || f === 'building_pdf' || f === 'submitting_to_print') inProgress++;
    if (f === 'proof_ready') proofReady++;
    if (f === 'failed_manual_review') failed++;
  }
  return { paid, paidAttention, inProgress, proofReady, failed };
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
