'use client';

import { useMemo, useState } from 'react';

import type { OrderRecord } from '@/lib/orders';
import { deriveOrderStage, deriveOrderAttention } from '@/lib/order-stage';

/** Client-side mirror of preprintRefundRefusalReason (kept inline to
 *  avoid pulling Stripe into the client bundle through admin-actions).
 *  Server is the source of truth — UI just hides the button when the
 *  state already disqualifies the order. */
function uiCanRefund(order: OrderRecord): boolean {
  if (order.paymentStatus !== 'paid') return false;
  if (order.refundedAt) return false;
  if (order.status === 'shipped' || order.status === 'print_in_production') return false;
  const fs = order.fulfillmentStatus ?? 'not_started';
  if (fs === 'submitting_to_print' || fs === 'complete') return false;
  return true;
}

type Filter = 'all' | 'paid_attention' | 'paid' | 'in_progress' | 'proof_ready' | 'failed' | 'shipped';

const STUCK_AFTER_MS = 15 * 60 * 1000;
const IN_PROGRESS_FULFILLMENT_STATUSES = new Set([
  'generating_story',
  'generating_images',
  'building_pdf',
  'submitting_to_print',
]);

function isInternalArchived(order: OrderRecord): boolean {
  return Boolean(order.internalDisposition);
}

function paidArtifactNeedsAttention(order: OrderRecord, now = Date.now()): boolean {
  if (order.paymentStatus !== 'paid' || order.storyArtifactUrl) return false;
  const f = order.fulfillmentStatus ?? 'not_started';
  if (f === 'not_started' || f === 'failed_manual_review') return true;
  if (IN_PROGRESS_FULFILLMENT_STATUSES.has(f)) {
    const updatedAt = Date.parse(order.updatedAt ?? order.createdAt ?? '');
    return !Number.isFinite(updatedAt) || now - updatedAt >= STUCK_AFTER_MS;
  }
  return true;
}

export default function AdminOrdersClient({ orders }: { orders: OrderRecord[] }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [showInternalArchived, setShowInternalArchived] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    return orders.filter(o => {
      if (!showInternalArchived && isInternalArchived(o)) return false;

      if (q && !(
        o.id.toLowerCase().includes(q) ||
        o.childName.toLowerCase().includes(q) ||
        o.email.toLowerCase().includes(q)
      )) return false;

      switch (filter) {
        case 'paid_attention': return paidArtifactNeedsAttention(o, now);
        case 'paid': return o.paymentStatus === 'paid';
        case 'in_progress':
          return ['generating_story', 'generating_images', 'building_pdf', 'submitting_to_print'].includes(o.fulfillmentStatus ?? '');
        case 'proof_ready': return o.fulfillmentStatus === 'proof_ready';
        case 'failed': return o.fulfillmentStatus === 'failed_manual_review';
        case 'shipped': return o.status === 'shipped';
        default: return true;
      }
    });
  }, [orders, query, filter, showInternalArchived]);

  const internalArchivedCount = useMemo(
    () => orders.filter(isInternalArchived).length,
    [orders],
  );
  const paidAttentionCount = useMemo(
    () => orders.filter((o) => (!showInternalArchived && isInternalArchived(o)) ? false : paidArtifactNeedsAttention(o)).length,
    [orders, showInternalArchived],
  );

  async function retry(orderId: string) {
    if (!confirm(`Retry fulfillment for ${orderId}?`)) return;
    setRetrying(orderId);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/retry`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Retry failed' }));
        alert(`Retry failed: ${data.error ?? res.status}`);
      } else {
        alert('Retry queued. Refresh in a minute to see progress.');
      }
    } finally {
      setRetrying(null);
    }
  }

  async function refund(orderId: string) {
    const reason = prompt(
      `Refund ${orderId}? This calls Stripe and CANNOT be undone.\n\nReason (recorded in audit log):`,
      'customer_request',
    );
    if (reason === null) return; // cancelled
    setRefunding(orderId);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Refund failed: ${data.error ?? res.status}`);
      } else {
        alert(`Refund issued. ${data.detail ?? ''}\nReload to see updated state.`);
      }
    } finally {
      setRefunding(null);
    }
  }

  return (
    <>
      <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-wrap gap-3 items-center">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search order ID, child name, email"
          className="flex-1 min-w-[240px] border border-gray-200 rounded-lg px-3 py-2 text-sm"
        />
        <select
          value={filter}
          onChange={e => setFilter(e.target.value as Filter)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
        >
          <option value="all">All</option>
          <option value="paid_attention">Paid attention ({paidAttentionCount})</option>
          <option value="paid">Paid</option>
          <option value="in_progress">In progress</option>
          <option value="proof_ready">Proof ready</option>
          <option value="failed">Failed</option>
          <option value="shipped">Shipped</option>
        </select>
        <label className="inline-flex items-center gap-2 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={showInternalArchived}
            onChange={e => setShowInternalArchived(e.target.checked)}
          />
          Show internal/test archived ({internalArchivedCount})
        </label>
        <span className="text-xs text-gray-500">{filtered.length} shown</span>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-2">Created</th>
                <th className="text-left px-3 py-2">Order</th>
                <th className="text-left px-3 py-2">Child / Email</th>
                <th className="text-left px-3 py-2">Format</th>
                <th className="text-left px-3 py-2">Payment</th>
                <th className="text-left px-3 py-2">Fulfillment</th>
                <th className="text-left px-3 py-2">Order status</th>
                <th className="text-left px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="text-center py-8 text-gray-400">No orders match.</td></tr>
              )}
              {filtered.map(o => (
                <Row
                  key={o.id}
                  order={o}
                  onRetry={retry}
                  retrying={retrying === o.id}
                  onRefund={refund}
                  refunding={refunding === o.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Row({
  order,
  onRetry,
  retrying,
  onRefund,
  refunding,
}: {
  order: OrderRecord;
  onRetry: (id: string) => void;
  retrying: boolean;
  onRefund: (id: string) => void;
  refunding: boolean;
}) {
  const paidTone =
    order.paymentStatus === 'paid' ? 'bg-forest/10 text-forest' :
    order.paymentStatus === 'failed' ? 'bg-coral/20 text-coral-dark' :
    order.paymentStatus === 'refunded' ? 'bg-purple/20 text-purple' :
    'bg-gray-100 text-gray-600';
  const f = order.fulfillmentStatus ?? 'not_started';
  const fulfillTone =
    f === 'complete' ? 'bg-forest/10 text-forest' :
    f === 'failed_manual_review' ? 'bg-coral/20 text-coral-dark' :
    f === 'proof_ready' ? 'bg-[#FFF8E6] text-[#8a6d1a]' :
    f === 'not_started' ? 'bg-gray-100 text-gray-500' :
    'bg-lavender text-purple';

  const created = order.createdAt ? new Date(order.createdAt) : null;
  const createdShort = created ? `${created.toISOString().slice(0, 10)} ${created.toISOString().slice(11, 16)}Z` : '—';
  const needsPaidArtifactAttention = paidArtifactNeedsAttention(order);
  // Read-only truth layer: derived stage + attention are display-only signals;
  // no action is taken here.
  const stage = deriveOrderStage(order);
  const attention = deriveOrderAttention(order);

  return (
    <tr className="border-t border-gray-100 align-top">
      <td className="px-3 py-3 text-xs text-gray-500 whitespace-nowrap">{createdShort}</td>
      <td className="px-3 py-3">
        <a className="text-xs font-mono text-forest underline block" href={`/admin/orders/${order.id}`}>
          {order.id}
        </a>
        {order.internalDisposition && (
          <span className="mt-1 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500" title={order.internalDispositionNote ?? undefined}>
            {order.internalDisposition}
          </span>
        )}
        <a className="text-[10px] text-gray-400 underline" href={`/status/${order.id}`} target="_blank" rel="noopener">
          customer view ↗
        </a>
      </td>
      <td className="px-3 py-3">
        <p className="font-semibold text-forest text-sm">{order.childName}</p>
        <p className="text-xs text-gray-500">{order.email}</p>
      </td>
      <td className="px-3 py-3 text-xs">{order.formatLabel}</td>
      <td className="px-3 py-3"><span className={`inline-block px-2 py-0.5 rounded-full text-xs ${paidTone}`}>{order.paymentStatus}</span></td>
      <td className="px-3 py-3">
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs ${fulfillTone}`}>{f}</span>
        {needsPaidArtifactAttention && (
          <p className="text-[10px] text-coral-dark mt-1 max-w-[220px]">
            Paid but no proof/digital artifact — check diagnostics/retry.
          </p>
        )}
        {order.fulfillmentLastError && (
          <p className="text-[10px] text-coral-dark mt-1 max-w-[220px] truncate" title={order.fulfillmentLastError}>
            {order.fulfillmentLastError}
          </p>
        )}
      </td>
      <td className="px-3 py-3 text-xs">
        {order.status}
        <div className="mt-1 text-[10px] text-gray-400">Derived stage: {stage}</div>
        {attention.severity !== 'none' && (
          <div className="mt-0.5 text-[10px] text-coral-dark max-w-[220px]">
            {attention.severity}: {attention.reason} · queue: {attention.queue} · owner: {attention.nextActionOwner}
          </div>
        )}
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-col gap-1">
          {order.storyArtifactUrl && (
            <a href={order.storyArtifactUrl} target="_blank" rel="noopener" className="text-xs underline text-forest">
              {f === 'proof_ready' ? 'View proof' : 'Artifact'}
            </a>
          )}
          <a href={`/status/${order.id}`} target="_blank" rel="noopener" className="text-xs underline text-gray-500">
            Customer view
          </a>
          {f === 'failed_manual_review' && order.paymentStatus === 'paid' && (
            <button
              type="button"
              onClick={() => onRetry(order.id)}
              disabled={retrying}
              className="text-xs px-2 py-1 rounded-md font-semibold disabled:opacity-50"
              style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}
            >
              {retrying ? 'Queuing…' : 'Retry'}
            </button>
          )}
          {uiCanRefund(order) && (
            <button
              type="button"
              onClick={() => onRefund(order.id)}
              disabled={refunding}
              className="text-xs px-2 py-1 rounded-md font-semibold border border-coral/40 text-coral-dark hover:bg-coral/5 disabled:opacity-50"
              data-testid={`refund-${order.id}`}
            >
              {refunding ? 'Refunding…' : 'Refund'}
            </button>
          )}
          {order.refundedAt && (
            <span className="text-[10px] text-gray-400" data-testid={`refunded-${order.id}`}>
              Refunded {new Date(order.refundedAt).toISOString().slice(0, 10)}
            </span>
          )}
          <a href={`mailto:${order.email}?subject=Your%20Hero%20Story%20Books%20order%20${order.id}`} className="text-xs underline text-gray-500">
            Email customer
          </a>
        </div>
      </td>
    </tr>
  );
}
