import type { OrderRecord } from './orders.ts';

/**
 * Read-only "email ledger" for an order: what customer-facing emails are known
 * to have been sent / failed / are still pending, derived purely from durable
 * signals already on the order record (timestamps + review audit events).
 *
 * This is a TRUTH layer, not a sender. It performs no email send, no provider
 * call, and no mutation. It exists so ops surfaces can show a consistent
 * "who has the customer actually heard from?" view without re-deriving the
 * logic per screen. It intentionally reports `pending` (rather than guessing
 * `sent`) when an email is expected but there is no durable evidence for it.
 */

export type CustomerEmailKind = 'order_confirmation' | 'proof_ready' | 'digital_delivery' | 'shipped';

export type CustomerEmailState = 'sent' | 'failed' | 'pending' | 'not_applicable';

export interface OrderEmailLedgerEntry {
  kind: CustomerEmailKind;
  state: CustomerEmailState;
  /** ISO timestamp of the durable evidence, when available. */
  at: string | null;
  /** Short stable code describing the evidence used. */
  evidence: string;
}

export interface OrderEmailLedger {
  orderId: string;
  entries: OrderEmailLedgerEntry[];
  /** True when any customer email is known to have FAILED (recovery signal). */
  hasFailure: boolean;
  sentCount: number;
}

function isPrintFormat(bookFormat: string): boolean {
  return bookFormat === 'classic' || bookFormat === 'premium';
}

/** Durable evidence that the proof/preview email actually went to the customer. */
function proofEmailEvidence(order: OrderRecord): { at: string | null; code: string } | null {
  if (order.customerProofReleasedAt) {
    return { at: order.customerProofReleasedAt, code: 'customer_proof_released_at' };
  }
  for (const event of order.auditEvents ?? []) {
    if (event.type === 'proof_release_override_recorded') {
      return { at: event.at, code: 'audit:proof_release_override_recorded' };
    }
    if (event.type === 'proof_review_acknowledged' && event.reason === 'customer_email_sent') {
      return { at: event.at, code: 'audit:proof_review_acknowledged' };
    }
  }
  return null;
}

function entry(kind: CustomerEmailKind, state: CustomerEmailState, at: string | null, evidence: string): OrderEmailLedgerEntry {
  return { kind, state, at, evidence };
}

export function deriveOrderEmailLedger(order: OrderRecord): OrderEmailLedger {
  const paid = order.paymentStatus === 'paid';
  const hasArtifact = Boolean(order.storyArtifactUrl);
  const fulfillment = order.fulfillmentStatus ?? 'not_started';
  const entries: OrderEmailLedgerEntry[] = [];

  // 1. Order confirmation — inferred from a captured payment (sent at checkout success).
  entries.push(
    paid
      ? entry('order_confirmation', 'sent', order.createdAt ?? null, 'inferred:payment_captured')
      : entry('order_confirmation', 'not_applicable', null, 'payment_not_captured'),
  );

  // 2. Proof / preview-ready email.
  const proof = proofEmailEvidence(order);
  if (proof) {
    entries.push(entry('proof_ready', 'sent', proof.at, proof.code));
  } else if (paid && hasArtifact && fulfillment === 'proof_ready') {
    entries.push(entry('proof_ready', 'pending', null, 'proof_artifact_ready_no_release_evidence'));
  } else {
    entries.push(entry('proof_ready', 'not_applicable', null, 'no_proof_stage'));
  }

  // 3. Digital delivery email (final PDF; applies to every paid order).
  if (fulfillment === 'delivery_email_failed') {
    entries.push(entry('digital_delivery', 'failed', null, 'fulfillment:delivery_email_failed'));
  } else if (fulfillment === 'complete') {
    entries.push(entry('digital_delivery', 'sent', order.updatedAt ?? null, 'fulfillment:complete'));
  } else if (paid && hasArtifact) {
    entries.push(entry('digital_delivery', 'pending', null, 'paid_with_artifact_not_delivered'));
  } else {
    entries.push(entry('digital_delivery', 'not_applicable', null, 'not_yet_deliverable'));
  }

  // 4. Shipped notification (print formats only).
  if (isPrintFormat(order.bookFormat)) {
    if (order.shippedAt || order.printJobStatus === 'shipped' || order.printJobStatus === 'delivered') {
      entries.push(entry('shipped', 'sent', order.shippedAt ?? null, 'shipped_marker'));
    } else if (paid && (order.printJobId || order.printSubmittedAt || order.proofApprovedAt)) {
      entries.push(entry('shipped', 'pending', null, 'print_in_flight_not_shipped'));
    } else {
      entries.push(entry('shipped', 'not_applicable', null, 'not_yet_in_print'));
    }
  } else {
    entries.push(entry('shipped', 'not_applicable', null, 'digital_order'));
  }

  return {
    orderId: order.id,
    entries,
    hasFailure: entries.some((e) => e.state === 'failed'),
    sentCount: entries.filter((e) => e.state === 'sent').length,
  };
}
