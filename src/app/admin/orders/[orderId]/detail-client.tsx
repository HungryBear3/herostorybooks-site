'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Props = {
  orderId: string;
  isPrint: boolean;
  fulfillmentStatus: string;
  alreadyShipped: boolean;
  hasProof: boolean;
  isFailed: boolean;
  paymentPaid: boolean;
  currentTrackingNumber: string;
  currentTrackingUrl: string;
};

export default function OrderDetailActions(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tn, setTn] = useState(props.currentTrackingNumber);
  const [tu, setTu] = useState(props.currentTrackingUrl);

  async function call(action: string, path: string, body?: unknown, confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(action); setMsg(null); setErr(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error ?? `Failed (${res.status})`);
      } else {
        setMsg(data.detail ?? 'Done');
        router.refresh();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
      <h2 className="text-xs uppercase tracking-wider text-gray-500">Actions</h2>

      {msg && <p className="text-xs text-forest bg-forest/10 rounded px-3 py-2">{msg}</p>}
      {err && <p className="text-xs text-coral-dark bg-coral/10 rounded px-3 py-2">{err}</p>}

      <div className="flex flex-wrap gap-2">
        {props.isFailed && props.paymentPaid && (
          <button disabled={busy !== null}
                  onClick={() => call('retry', `/api/admin/orders/${props.orderId}/retry`, undefined,
                    'Retry fulfillment?')}
                  className="px-3 py-2 text-xs rounded-md font-semibold disabled:opacity-50"
                  style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}>
            {busy === 'retry' ? 'Queuing…' : 'Retry fulfillment'}
          </button>
        )}

        {props.hasProof && props.fulfillmentStatus === 'proof_ready' && (
          <>
            <button disabled={busy !== null}
                    onClick={() => call('resend', `/api/admin/orders/${props.orderId}/resend-proof`)}
                    className="px-3 py-2 text-xs rounded-md font-semibold bg-lavender text-purple disabled:opacity-50">
              {busy === 'resend' ? 'Sending…' : 'Resend proof email'}
            </button>
            <button disabled={busy !== null}
                    onClick={() => call('approve', `/api/admin/orders/${props.orderId}/manual-approve`, undefined,
                      'Manually approve the proof and send to print?')}
                    className="px-3 py-2 text-xs rounded-md font-semibold bg-forest text-white disabled:opacity-50">
              {busy === 'approve' ? 'Approving…' : 'Manually approve proof'}
            </button>
          </>
        )}
      </div>

      {props.isPrint && !props.alreadyShipped && (
        <div className="pt-4 border-t border-gray-100 space-y-3">
          <p className="text-xs uppercase tracking-wider text-gray-500">Mark shipped</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input value={tn} onChange={e => setTn(e.target.value)}
                   placeholder="Tracking number"
                   className="border border-gray-200 rounded-md px-2 py-1.5 text-sm" />
            <input value={tu} onChange={e => setTu(e.target.value)}
                   placeholder="Tracking URL (optional)"
                   className="border border-gray-200 rounded-md px-2 py-1.5 text-sm" />
          </div>
          <button disabled={busy !== null}
                  onClick={() => call('ship', `/api/admin/orders/${props.orderId}/ship`,
                    { trackingNumber: tn.trim() || undefined, trackingUrl: tu.trim() || undefined },
                    `Mark ${props.orderId} as shipped? This sends the shipped email.`)}
                  className="px-3 py-2 text-xs rounded-md font-semibold disabled:opacity-50"
                  style={{ backgroundColor: '#D4AF37', color: '#1F3A5F' }}>
            {busy === 'ship' ? 'Marking…' : 'Mark shipped & email customer'}
          </button>
        </div>
      )}

      {props.alreadyShipped && (
        <p className="text-xs text-gray-500 pt-4 border-t border-gray-100">Order already marked shipped.</p>
      )}
    </section>
  );
}
