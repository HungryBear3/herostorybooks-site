import { getConfiguredAdminKey } from '@/lib/admin-auth';
import { isAdminAuthedFromCookie } from '@/lib/admin-auth-server';
import { listOrders } from '@/lib/orders';
import type { OrderRecord } from '@/lib/orders';
import { deriveOrderAttention } from '@/lib/order-stage';
import {
  CHECKOUT_RECONCILIATION_LABEL,
  CHECKOUT_RECONCILIATION_WARNING,
  readCheckoutProvisioningEvidence,
} from '@/lib/checkout-provisioning-evidence';

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

  // Orders whose checkout entered a provider create that never resolved. These
  // are typically unpaid, so no paid-order taxonomy or attention filter lists
  // them — this panel is the only place they can be enumerated.
  const reconciliation = orders
    .map((o) => ({ id: o.id, evidence: readCheckoutProvisioningEvidence(o) }))
    .filter((row) => row.evidence.status === 'reconciliation_required');

  return (
    <div className="min-h-screen bg-cream px-4 py-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="font-serif text-3xl font-bold text-forest">Orders · Ops</h1>
            <p className="text-sm text-gray-500">Internal only · {orders.length} orders loaded</p>
          </div>
          <div className="flex gap-3 text-xs">
            <Stat label="Paid" value={stats.paid} />
            <Stat label="Paid attention" value={stats.paidAttention} tone="failure" />
            <Stat label="In progress" value={stats.inProgress} />
            <Stat label="Proof ready" value={stats.proofReady} />
            <Stat label="Failed" value={stats.failed} tone="failure" />
          </div>
        </header>

        {reconciliation.length > 0 && (
          <section className="bg-white border border-amber-300 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-amber-900">
              {CHECKOUT_RECONCILIATION_LABEL} · {reconciliation.length}
            </h2>
            <p className="text-xs text-amber-900 mt-1">
              A checkout provider call was started for these orders and its outcome was never
              recorded, so a payable Stripe Session may exist. <strong>{CHECKOUT_RECONCILIATION_WARNING}</strong>{' '}
              — verify each order in the Stripe Dashboard and escalate manually. See the support
              stuck-order runbook.
            </p>
            <ul className="mt-3 space-y-1 text-xs">
              {reconciliation.map((row) => (
                <li key={row.id} className="flex flex-wrap gap-2">
                  <a href={`/admin/orders/${row.id}`} className="font-mono underline text-forest">
                    {row.id}
                  </a>
                  <span className="text-gray-500">
                    started{' '}
                    {row.evidence.status === 'reconciliation_required' ? row.evidence.startedAt : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

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
    const paidIssue = deriveOrderAttention(o);
    if (paidIssue.severity !== 'none') paidAttention++;
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
