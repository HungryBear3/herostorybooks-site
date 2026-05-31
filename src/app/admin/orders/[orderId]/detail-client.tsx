'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Props = {
  orderId: string;
  isPrint: boolean;
  fulfillmentStatus: string;
  alreadyShipped: boolean;
  hasProof: boolean;
  hasArtifact: boolean;
  isFailed: boolean;
  paymentPaid: boolean;
  qaPassAt: string;
  qaPassBy: string;
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
  const [qa, setQa] = useState({
    storyReviewed: false,
    imagesReviewed: false,
    proofArtifactReviewed: false,
    customerSafe: false,
    noPrintRelease: false,
  });

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

      {props.fulfillmentStatus === 'awaiting_qa' && props.paymentPaid && props.hasArtifact && (
        <div className="pt-4 border-t border-gray-100 space-y-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-gray-500">QA release</p>
            <p className="mt-1 text-xs text-gray-500">
              Records positive human QA, then sends the customer proof/digital email. Print release stays separate.
            </p>
          </div>
          <div className="grid gap-2 text-xs text-gray-700 sm:grid-cols-2">
            {[
              ['storyReviewed', 'Story reviewed'],
              ['imagesReviewed', 'Images reviewed'],
              ['proofArtifactReviewed', 'PDF/proof artifact reviewed'],
              ['customerSafe', 'Safe for customer release'],
              ['noPrintRelease', 'No print release side effect'],
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 rounded border border-gray-100 px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={qa[key as keyof typeof qa]}
                  onChange={(e) => setQa((prev) => ({ ...prev, [key]: e.target.checked }))}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <button disabled={busy !== null}
                  onClick={() => call('qa-pass', `/api/admin/orders/${props.orderId}/qa-pass`,
                    { qaPassBy: 'admin', checklist: qa },
                    `Approve ${props.orderId} for customer proof/digital release? This sends the customer email but does not release print.`)}
                  className="px-3 py-2 text-xs rounded-md font-semibold bg-forest text-white disabled:opacity-50">
            {busy === 'qa-pass' ? 'Releasing…' : 'Approve for customer proof release'}
          </button>
        </div>
      )}

      {props.qaPassAt && (
        <p className="text-xs text-forest bg-forest/10 rounded px-3 py-2">
          QA passed by {props.qaPassBy || 'admin'} at {props.qaPassAt}.
        </p>
      )}

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
