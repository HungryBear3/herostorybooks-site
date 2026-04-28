'use client';

import { useMemo, useState } from 'react';

import type { OrderRecord } from '@/lib/orders';

type Filter = 'all' | 'paid' | 'in_progress' | 'proof_ready' | 'failed' | 'shipped';

export default function AdminOrdersClient({ orders }: { orders: OrderRecord[] }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [retrying, setRetrying] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter(o => {
      if (q && !(
        o.id.toLowerCase().includes(q) ||
        o.childName.toLowerCase().includes(q) ||
        o.email.toLowerCase().includes(q)
      )) return false;

      switch (filter) {
        case 'paid': return o.paymentStatus === 'paid';
        case 'in_progress':
          return ['generating_story', 'generating_images', 'building_pdf', 'submitting_to_print'].includes(o.fulfillmentStatus ?? '');
        case 'proof_ready': return o.fulfillmentStatus === 'proof_ready';
        case 'failed': return o.fulfillmentStatus === 'failed_manual_review';
        case 'shipped': return o.status === 'shipped';
        default: return true;
      }
    });
  }, [orders, query, filter]);

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
          <option value="paid">Paid</option>
          <option value="in_progress">In progress</option>
          <option value="proof_ready">Proof ready</option>
          <option value="failed">Failed</option>
          <option value="shipped">Shipped</option>
        </select>
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
                <Row key={o.id} order={o} onRetry={retry} retrying={retrying === o.id} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Row({ order, onRetry, retrying }: { order: OrderRecord; onRetry: (id: string) => void; retrying: boolean }) {
  const paidTone = order.paymentStatus === 'paid' ? 'bg-forest/10 text-forest' : order.paymentStatus === 'failed' ? 'bg-coral/20 text-coral-dark' : 'bg-gray-100 text-gray-600';
  const f = order.fulfillmentStatus ?? 'not_started';
  const fulfillTone =
    f === 'complete' ? 'bg-forest/10 text-forest' :
    f === 'failed_manual_review' ? 'bg-coral/20 text-coral-dark' :
    f === 'proof_ready' ? 'bg-[#FFF8E6] text-[#8a6d1a]' :
    f === 'not_started' ? 'bg-gray-100 text-gray-500' :
    'bg-lavender text-purple';

  const created = order.createdAt ? new Date(order.createdAt) : null;
  const createdShort = created ? `${created.toISOString().slice(0, 10)} ${created.toISOString().slice(11, 16)}Z` : '—';

  return (
    <tr className="border-t border-gray-100 align-top">
      <td className="px-3 py-3 text-xs text-gray-500 whitespace-nowrap">{createdShort}</td>
      <td className="px-3 py-3">
        <a className="text-xs font-mono text-forest underline block" href={`/admin/orders/${order.id}`}>
          {order.id}
        </a>
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
        {order.fulfillmentLastError && (
          <p className="text-[10px] text-coral-dark mt-1 max-w-[220px] truncate" title={order.fulfillmentLastError}>
            {order.fulfillmentLastError}
          </p>
        )}
      </td>
      <td className="px-3 py-3 text-xs">{order.status}</td>
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
          <a href={`mailto:${order.email}?subject=Your%20Hero%20Story%20Books%20order%20${order.id}`} className="text-xs underline text-gray-500">
            Email customer
          </a>
        </div>
      </td>
    </tr>
  );
}
