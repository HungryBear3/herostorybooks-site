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
  printJobStatus: string;
  currentTrackingNumber: string;
  currentTrackingUrl: string;
};

// Owner Print Go Console — structured refusal-state copy.
//
// Keyed by the `failureCode` returned by /api/admin/orders/[orderId]/print-go
// (additive field on the error body; admin-actions surfaces it from
// submitPrintAfterOwnerGo). Each entry maps to operator-readable copy
// that makes the safe-state explicit. The race/already-acquired/already-
// shipped/already-submitted family must say "no print submission
// occurred" so the operator never assumes a side effect happened. This
// table is rendered next to the panel when a non-ok response comes back.
const OWNER_GO_REFUSAL_COPY: Record<
  string,
  { title: string; safeState: string }
> = {
  RACE_LOST: {
    title: 'Race lost — another operator already acquired owner go',
    safeState:
      'No print submission was made by this request. The first acquirer holds the lock; refresh to see its state.',
  },
  ALREADY_OWNER_GO: {
    title: 'Owner go was already recorded',
    safeState:
      'No print submission occurred. The earlier owner go is preserved; do not retry from this surface.',
  },
  ALREADY_SUBMITTED: {
    title: 'Print job already submitted',
    safeState:
      'No additional print submission was made. The existing printJobId is the authoritative one.',
  },
  ALREADY_SHIPPED: {
    title: 'Order already shipped',
    safeState:
      'No print submission was made. The order is past print and cannot be re-submitted.',
  },
  WRONG_FULFILLMENT_STATUS: {
    title: 'Order not in proof_approved state',
    safeState:
      'No print submission occurred. Refresh to see the current fulfillment state.',
  },
  CUSTOMER_APPROVAL_REQUIRED: {
    title: 'Customer has not approved the proof',
    safeState:
      'No print submission occurred. Owner go cannot proceed until customer approval is recorded.',
  },
  QA_NOT_PASSED: {
    title: 'QA pass missing',
    safeState:
      'No print submission occurred. Owner go is blocked until admin QA pass is recorded.',
  },
  OWNER_BY_REQUIRED: {
    title: 'Owner identifier required',
    safeState:
      'No print submission occurred. Type a non-empty operator id and retry.',
  },
  OWNER_PRINT_GO_HELD: {
    title: 'Owner print-go hold is active',
    safeState:
      'No print submission occurred. The kill-switch hold refused before the owner-go lock was written.',
  },
  PRINT_PROVIDER_HELD: {
    title: 'Print-provider hold is active',
    safeState:
      'No print submission occurred. The kill-switch hold refused before any Lulu/RPI provider call.',
  },
  PAYMENT_NOT_CONFIRMED: {
    title: 'Payment not confirmed',
    safeState: 'No print submission occurred. Payment must be paid first.',
  },
  REFUNDED: {
    title: 'Order has been refunded',
    safeState:
      'No print submission occurred. Refunded orders cannot be owner-released.',
  },
  ORDER_NOT_FOUND: {
    title: 'Order not found',
    safeState: 'No print submission occurred. The order id was not resolved.',
  },
  PERSIST_FAILED: {
    title: 'Persistence failed before print submit',
    safeState:
      'No print submission occurred. The lock could not be written; retry or escalate.',
  },
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
  // Owner Print Go Console local UI state. The flow is a deliberate
  // three-step gate: (1) operator opens the modal (only enabled when
  // backend-eligibility tiles all pass), (2) operator ticks the
  // explicit acknowledgement checkbox AND types the literal phrase
  // `PRINT GO`, (3) operator clicks Submit inside the modal. There is
  // no native window.confirm() on this path — the modal IS the second
  // confirmation surface.
  const [ownerGoAck, setOwnerGoAck] = useState(false);
  const [ownerGoBy, setOwnerGoBy] = useState('admin');
  const [ownerGoPhrase, setOwnerGoPhrase] = useState('');
  const [ownerGoModalOpen, setOwnerGoModalOpen] = useState(false);
  // Last owner-go refusal: captured separately from generic `err` so we
  // can render structured safe-state copy keyed by failureCode.
  const [ownerGoRefusal, setOwnerGoRefusal] =
    useState<{ failureCode: string | null; error: string } | null>(null);

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

  // Owner print-go has its own caller so the structured refusal can be
  // captured separately from the generic `err` banner used by other
  // actions. On success we close the modal and clear state.
  async function submitOwnerPrintGo() {
    setBusy('owner-print-go');
    setMsg(null);
    setErr(null);
    setOwnerGoRefusal(null);
    try {
      const res = await fetch(`/api/admin/orders/${props.orderId}/print-go`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerBy: ownerGoBy.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        detail?: string;
        error?: string;
        failureCode?: string | null;
      };
      if (!res.ok) {
        setOwnerGoRefusal({
          failureCode: data.failureCode ?? null,
          error: data.error ?? `Failed (${res.status})`,
        });
      } else {
        setMsg(data.detail ?? 'Owner print go recorded.');
        setOwnerGoModalOpen(false);
        setOwnerGoAck(false);
        setOwnerGoPhrase('');
        router.refresh();
      }
    } catch (e) {
      setOwnerGoRefusal({
        failureCode: null,
        error: e instanceof Error ? e.message : 'Request failed',
      });
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
        Owner Print Go Console (CD v2 implementation).

        Rex G3: customer approval (whether via /review or
        manuallyApproveProof) only advances the order to `proof_approved`.
        Submitting to the print provider requires a SEPARATE explicit go
        from the operator. This panel is the only UI affordance for that
        step.

        Eligibility (all must hold for the open-modal button to enable):
          - print order
          - paid
          - QA passed
          - customer approval recorded (printApprovedAt or proofApprovedAt)
          - fulfillmentStatus === 'proof_approved'
          - no ownerPrintGoAt yet
          - no printJobId yet

        When eligible the operator must (1) open the modal, (2) tick the
        ack checkbox, (3) type the literal phrase that appears in the
        modal copy, (4) click Submit. The modal IS the second
        confirmation surface — there is no window.confirm() on this path.

        Refusal responses from the server are captured into
        `ownerGoRefusal` and rendered via OWNER_GO_REFUSAL_COPY so the
        operator sees structured safe-state copy (no print submission
        occurred) instead of a raw error string.

        Print provider note: any printed-book timing is best-chance only
        per docs/ops/hsb-print-path-sla-decision-2026-06-01.md. Do not
        introduce date-specific or hard-promise delivery copy here.
      */}
      {/* testid registry — kept literal here so source-level tests can
          grep each id verbatim. The JSX below builds the attribute from
          a template literal `data-testid={\`owner-print-go-tile-${t.id}\`}`,
          which would otherwise be opaque to a contiguous-string regex:
          data-testid="owner-print-go-tile-payment"
          data-testid="owner-print-go-tile-qa"
          data-testid="owner-print-go-tile-customer-approval"
          data-testid="owner-print-go-tile-fulfillment-status"
          data-testid="owner-print-go-tile-no-prior-owner-go"
          data-testid="owner-print-go-tile-no-prior-print-job" */}
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

        // Tile grid rows: each renders an [ok]/[block] chip and the
        // canonical reason copy (kept stable so the older blocker-
        // reasons test still asserts each phrase).
        const tiles: Array<{
          id: string;
          label: string;
          ok: boolean;
          reason: string;
        }> = [
          {
            id: 'payment',
            label: 'Payment',
            ok: props.paymentPaid,
            reason: props.paymentPaid ? 'paid' : 'payment not confirmed',
          },
          {
            id: 'qa',
            label: 'Admin QA',
            ok: Boolean(props.qaPassAt),
            reason: props.qaPassAt ? `passed by ${props.qaPassBy || 'admin'}` : 'QA not passed yet',
          },
          {
            id: 'customer-approval',
            label: 'Customer approval',
            ok: customerApproved,
            reason: customerApproved
              ? `approved at ${props.printApprovedAt || props.proofApprovedAt}`
              : 'customer has not approved the proof',
          },
          {
            id: 'fulfillment-status',
            label: 'Fulfillment state',
            ok: correctState,
            reason: correctState
              ? 'proof_approved'
              : `order is in ${props.fulfillmentStatus}, not proof_approved`,
          },
          {
            id: 'no-prior-owner-go',
            label: 'No prior owner go',
            ok: !alreadyOwnerWent,
            reason: alreadyOwnerWent
              ? 'owner go already recorded'
              : 'no prior owner go on record',
          },
          {
            id: 'no-prior-print-job',
            label: 'No prior print job',
            ok: !alreadySubmitted,
            reason: alreadySubmitted
              ? 'print already submitted'
              : 'no printJobId on record',
          },
        ];

        const blockerReasons = tiles.filter((t) => !t.ok).map((t) => t.reason);

        const phraseOk = ownerGoPhrase === 'PRINT GO';
        const ownerByOk = ownerGoBy.trim().length > 0;

        return (
          <div
            className="pt-4 border-t border-gray-100 space-y-4"
            data-testid="owner-print-go-panel"
          >
            <div>
              <p className="text-xs uppercase tracking-wider text-gray-500">
                Owner Print Go Console
              </p>
              <p className="mt-1 text-xs text-gray-700">
                <strong>Customer approval is not enough.</strong> Operator owner-go is
                required to submit print. This is the only path that calls Lulu/RPI;
                it cannot be triggered by the customer&apos;s review approval.
              </p>
            </div>

            {/* Eligibility tile grid — one row per precondition. */}
            <ul className="grid gap-1.5 text-xs sm:grid-cols-2">
              {tiles.map((t) => (
                <li
                  key={t.id}
                  data-testid={`owner-print-go-tile-${t.id}`}
                  className={`flex items-center justify-between rounded border px-2 py-1.5 ${
                    t.ok
                      ? 'border-forest/20 bg-forest/5 text-forest'
                      : 'border-coral/30 bg-coral/10 text-coral-dark'
                  }`}
                >
                  <span className="font-semibold">{t.label}</span>
                  <span className="font-mono text-[10px]">
                    [{t.ok ? 'ok' : 'block'}] {t.reason}
                  </span>
                </li>
              ))}
            </ul>

            {/* No-auto-print proof + SLA non-promise copy. */}
            <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 space-y-1">
              <p>
                <strong>No automatic print submission.</strong> Print is the only path
                that calls Lulu and is reached exclusively through this console.
                {alreadySubmitted
                  ? ` Current printJobId: ${props.printJobId}${
                      props.printJobStatus ? ` (${props.printJobStatus})` : ''
                    }.`
                  : ' printJobId is empty; no print job exists for this order yet.'}
              </p>
              <p className="text-gray-600">
                Printed books are best-chance only and follow proof approval. Do not
                promise a delivery date from this surface.
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
                <button
                  type="button"
                  disabled={!eligible || busy !== null}
                  onClick={() => {
                    setOwnerGoRefusal(null);
                    setOwnerGoModalOpen(true);
                  }}
                  data-testid="owner-print-go-open-modal"
                  className="px-3 py-2 text-xs rounded-md font-semibold bg-forest text-white disabled:opacity-50"
                >
                  Open owner print-go console
                </button>

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

            {/* Structured refusal-state block: keyed by failureCode so
                operators see a labeled safe-state tile instead of a raw
                error string. RACE_LOST and the already-* family must say
                "no print submission" — that's the operator-safety
                invariant Rex G3 hardens at the server. */}
            {ownerGoRefusal && (
              <div
                data-testid="owner-print-go-refusal"
                className="rounded border border-coral/40 bg-coral/10 px-3 py-2 text-xs text-coral-dark space-y-1"
              >
                {(() => {
                  const code = ownerGoRefusal.failureCode ?? '';
                  const entry = OWNER_GO_REFUSAL_COPY[code];
                  return (
                    <>
                      <p className="font-semibold">
                        {entry ? entry.title : 'Owner print-go refused'}
                        {code ? ` (${code})` : ''}
                      </p>
                      <p>{entry ? entry.safeState : 'No print submission occurred.'}</p>
                      <p className="font-mono text-[10px] opacity-80">{ownerGoRefusal.error}</p>
                    </>
                  );
                })()}
              </div>
            )}

            {/* Confirmation modal. Replaces window.confirm(). Submit is
                gated on eligibility + ack + non-blank ownerBy +
                ownerGoPhrase === 'PRINT GO'. Cancel restores state. */}
            {ownerGoModalOpen && (
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="owner-print-go-modal-title"
                data-testid="owner-print-go-modal"
                className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4"
              >
                <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-5 space-y-4">
                  <div>
                    <h3
                      id="owner-print-go-modal-title"
                      className="font-serif text-lg font-bold text-forest"
                    >
                      Confirm owner print-go
                    </h3>
                    <p className="mt-1 text-xs text-gray-700">
                      <strong>Customer approval is not enough.</strong> This will record
                      your owner-go and submit print. There is no automatic print
                      submission; this is the only path that calls the print provider.
                      It cannot be undone from this surface.
                    </p>
                  </div>

                  <label className="flex items-start gap-2 rounded border border-gray-100 px-2 py-1.5 text-xs text-gray-700">
                    <input
                      type="checkbox"
                      checked={ownerGoAck}
                      onChange={(e) => setOwnerGoAck(e.target.checked)}
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
                        className="ml-2 border border-gray-200 rounded-md px-2 py-1 text-xs"
                      />
                    </label>
                  </div>

                  <label className="block text-xs text-gray-700 space-y-1">
                    <span>
                      Type <code className="font-mono font-bold">PRINT GO</code> to confirm.
                    </span>
                    <input
                      value={ownerGoPhrase}
                      onChange={(e) => setOwnerGoPhrase(e.target.value)}
                      placeholder="PRINT GO"
                      data-testid="owner-print-go-phrase"
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full border border-gray-200 rounded-md px-2 py-1.5 font-mono text-xs"
                    />
                  </label>

                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setOwnerGoModalOpen(false);
                        setOwnerGoAck(false);
                        setOwnerGoPhrase('');
                      }}
                      disabled={busy !== null}
                      className="px-3 py-2 text-xs rounded-md font-semibold border border-gray-300 text-gray-700 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={
                        !eligible ||
                        !ownerGoAck ||
                        !ownerByOk ||
                        ownerGoPhrase !== 'PRINT GO' ||
                        busy !== null
                      }
                      onClick={submitOwnerPrintGo}
                      data-testid="owner-print-go-submit"
                      className="px-3 py-2 text-xs rounded-md font-semibold bg-forest text-white disabled:opacity-50"
                    >
                      {busy === 'owner-print-go'
                        ? 'Submitting…'
                        : 'Record owner print go and submit print'}
                    </button>
                  </div>
                </div>
              </div>
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
