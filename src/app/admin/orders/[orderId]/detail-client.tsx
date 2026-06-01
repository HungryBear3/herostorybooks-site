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
  // Customer-approval timestamp (set by approvePrintProof). Customer
  // approval is necessary but NOT sufficient — see ownerPrintGoAt.
  proofApprovedAt: string;
  printApprovedAt: string;
  // Operator/owner explicit print go-ahead. Required by evaluatePrintGuard
  // before runPrintProduction is invoked.
  ownerPrintGoAt: string;
  ownerPrintGoBy: string;
  // Set after Lulu/RPI submission succeeded.
  printJobId: string;
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
  // Owner print go local UI state. The checkbox is a deliberate
  // two-step guard in addition to the confirm() dialog: operator must
  // tick the explicit acknowledgement that customer approval alone is
  // not enough before the submit button enables.
  const [ownerGoAck, setOwnerGoAck] = useState(false);
  const [ownerGoBy, setOwnerGoBy] = useState('admin');

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

      {/*
        Owner / operator print go.

        Rex G3: customer approval (whether via /review or
        manuallyApproveProof) only advances the order to `proof_approved`.
        Submitting to Lulu/RPI requires a SEPARATE explicit go from the
        operator. This panel is the only UI affordance for that step.

        Eligibility (all must hold for the submit control to enable):
          - print order
          - paid
          - QA passed
          - customer approval recorded (printApprovedAt or proofApprovedAt)
          - fulfillmentStatus === 'proof_approved'
          - no ownerPrintGoAt yet
          - no printJobId yet

        When eligible: operator must tick the acknowledgement checkbox,
        then click submit, then confirm in a dialog (three discrete
        deliberate acts before any Lulu/RPI call is made).
      */}
      {props.isPrint && (() => {
        const customerApproved = Boolean(props.printApprovedAt || props.proofApprovedAt);
        const alreadyOwnerWent = Boolean(props.ownerPrintGoAt);
        const alreadySubmitted = Boolean(props.printJobId);
        const correctState = props.fulfillmentStatus === 'proof_approved';
        const eligible =
          props.paymentPaid &&
          Boolean(props.qaPassAt) &&
          customerApproved &&
          correctState &&
          !alreadyOwnerWent &&
          !alreadySubmitted;

        const blockerReasons: string[] = [];
        if (!props.paymentPaid) blockerReasons.push('payment not confirmed');
        if (!props.qaPassAt) blockerReasons.push('QA not passed yet');
        if (!customerApproved) blockerReasons.push('customer has not approved the proof');
        if (!correctState) blockerReasons.push(`order is in ${props.fulfillmentStatus}, not proof_approved`);
        if (alreadyOwnerWent) blockerReasons.push('owner go already recorded');
        if (alreadySubmitted) blockerReasons.push('print already submitted');

        return (
          <div
            className="pt-4 border-t border-gray-100 space-y-3"
            data-testid="owner-print-go-panel"
          >
            <div>
              <p className="text-xs uppercase tracking-wider text-gray-500">
                Owner print go / submit print
              </p>
              <p className="mt-1 text-xs text-gray-700">
                <strong>Customer approval is not enough.</strong> Operator owner-go is
                required to submit print. This is the only path that calls Lulu/RPI;
                it cannot be triggered by the customer&apos;s /review approval.
              </p>
            </div>

            {alreadyOwnerWent && (
              <p className="text-xs text-forest bg-forest/10 rounded px-3 py-2">
                Owner go recorded by {props.ownerPrintGoBy || 'admin'} at {props.ownerPrintGoAt}
                {alreadySubmitted ? ` · printJobId=${props.printJobId}` : ''}.
              </p>
            )}

            {!alreadyOwnerWent && !alreadySubmitted && (
              <>
                <label className="flex items-start gap-2 rounded border border-gray-100 px-2 py-1.5 text-xs text-gray-700">
                  <input
                    type="checkbox"
                    checked={ownerGoAck}
                    onChange={(e) => setOwnerGoAck(e.target.checked)}
                    disabled={!eligible}
                    data-testid="owner-print-go-ack"
                  />
                  <span>
                    I confirm the customer has approved this proof and I, as operator,
                    am giving explicit owner go to submit print. I understand this is a
                    separate decision from customer approval.
                  </span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs text-gray-500">
                    Owner identifier
                    <input
                      value={ownerGoBy}
                      onChange={(e) => setOwnerGoBy(e.target.value)}
                      maxLength={120}
                      disabled={!eligible}
                      className="ml-2 border border-gray-200 rounded-md px-2 py-1 text-xs"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!eligible || !ownerGoAck || !ownerGoBy.trim() || busy !== null}
                    onClick={() => call(
                      'owner-print-go',
                      `/api/admin/orders/${props.orderId}/print-go`,
                      { ownerBy: ownerGoBy.trim() || 'admin' },
                      `Confirm: record owner print go for ${props.orderId} and submit to print? This calls Lulu/RPI and cannot be undone.`,
                    )}
                    className="px-3 py-2 text-xs rounded-md font-semibold bg-forest text-white disabled:opacity-50"
                    data-testid="owner-print-go-submit"
                  >
                    {busy === 'owner-print-go' ? 'Submitting…' : 'Record owner print go and submit print'}
                  </button>
                </div>

                {!eligible && (
                  <p
                    className="text-xs text-gray-500"
                    data-testid="owner-print-go-blocked-reasons"
                  >
                    Disabled — {blockerReasons.join('; ')}.
                  </p>
                )}
              </>
            )}
          </div>
        );
      })()}

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
