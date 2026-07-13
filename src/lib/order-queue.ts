import type { OrderRecord } from './orders.ts';

/**
 * Lightweight INTERNAL manual-queue + customer-status tracking for HSB
 * friends-&-family / concierge orders that come through normal /checkout.
 *
 * Design notes:
 *   - Paid F&F orders park at `paymentStatus=paid` + `status=order_received`
 *     for manual review/proof work. This module gives ops a clear view of that
 *     queue and a small, customer-facing status vocabulary.
 *   - Everything here is PURE + READ-ONLY. No persistence, no Stripe, no email,
 *     no automated fulfillment. The begin/set helpers only compute a patch
 *     object; callers (admin tooling, later) decide whether to persist it.
 *   - Queue POSITION is derived on the fly from `createdAt`, never stored, so
 *     parallel tester submissions never race on a persisted counter.
 */

/** Small, customer-friendly status vocabulary. Deliberately non-committal —
 *  no delivery promises, no automation implied. */
export type CustomerQueueStatus = 'queued' | 'in_review' | 'in_progress' | 'ready';

export const CUSTOMER_QUEUE_STATUSES: readonly CustomerQueueStatus[] = [
  'queued',
  'in_review',
  'in_progress',
  'ready',
] as const;

/** Human labels for internal display / future status copy. Vague on timing by design. */
export const CUSTOMER_QUEUE_STATUS_LABELS: Record<CustomerQueueStatus, string> = {
  queued: 'In the queue',
  in_review: 'Being reviewed',
  in_progress: 'Being made',
  ready: 'Ready for you',
};

export function normalizeCustomerQueueStatus(value: unknown): CustomerQueueStatus | null {
  return typeof value === 'string' && (CUSTOMER_QUEUE_STATUSES as readonly string[]).includes(value)
    ? (value as CustomerQueueStatus)
    : null;
}

/** Partial patch of the queue fields. Never persisted by this module. */
export interface QueueStatusPatch {
  manualQueueEnteredAt?: string | null;
  customerQueueStatus?: CustomerQueueStatus | null;
  lastQueueStatusUpdateAt?: string | null;
  queueStatusNote?: string | null;
}

/**
 * Compute the patch for an order ENTERING the manual review queue (e.g. once
 * paid). Pure + idempotent: keeps an existing `manualQueueEnteredAt` and an
 * existing `customerQueueStatus` rather than clobbering them.
 */
export function beginManualQueue(
  order: Pick<OrderRecord, 'manualQueueEnteredAt' | 'customerQueueStatus'>,
  now: string,
): QueueStatusPatch {
  return {
    manualQueueEnteredAt: order.manualQueueEnteredAt ?? now,
    customerQueueStatus: normalizeCustomerQueueStatus(order.customerQueueStatus) ?? 'queued',
    lastQueueStatusUpdateAt: now,
  };
}

/** Compute the patch for an operator-driven status change. Pure. */
export function setCustomerQueueStatus(
  status: CustomerQueueStatus,
  now: string,
  note?: string | null,
): QueueStatusPatch {
  return {
    customerQueueStatus: status,
    lastQueueStatusUpdateAt: now,
    ...(note !== undefined ? { queueStatusNote: note } : {}),
  };
}

export interface QueueView {
  /** True when the order is a paid order still parked for manual review. */
  inManualQueue: boolean;
  status: CustomerQueueStatus | null;
  statusLabel: string | null;
  enteredAt: string | null;
  lastUpdateAt: string | null;
  note: string | null;
}

/** Read-only view for admin surfaces. */
export function deriveQueueView(order: OrderRecord): QueueView {
  const status = normalizeCustomerQueueStatus(order.customerQueueStatus);
  return {
    inManualQueue:
      order.paymentStatus === 'paid' &&
      order.status === 'order_received' &&
      !order.internalDisposition &&
      !order.refundedAt,
    status,
    statusLabel: status ? CUSTOMER_QUEUE_STATUS_LABELS[status] : null,
    enteredAt: order.manualQueueEnteredAt ?? null,
    lastUpdateAt: order.lastQueueStatusUpdateAt ?? null,
    note: order.queueStatusNote ?? null,
  };
}

export interface PendingQueueRow {
  /** 1-based position by createdAt (oldest first). Derived, not stored. */
  position: number;
  orderId: string;
  createdAt: string;
  cohort: string | null;
  invite: string | null;
  customerQueueStatus: CustomerQueueStatus | null;
  manualQueueEnteredAt: string | null;
  /** Internal-only display context. */
  childName: string;
  email: string;
}

/**
 * Read-only: the pending manual-review queue — paid orders still at
 * `order_received`, oldest first, with F&F cohort/invite annotations. Excludes
 * refunded and internally-dispositioned orders. Does not mutate anything.
 */
export function pendingManualQueue(orders: OrderRecord[]): PendingQueueRow[] {
  return orders
    .filter(
      (o) =>
        o.paymentStatus === 'paid' &&
        o.status === 'order_received' &&
        !o.internalDisposition &&
        !o.refundedAt,
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((o, index) => ({
      position: index + 1,
      orderId: o.id,
      createdAt: o.createdAt,
      cohort: o.checkoutTracking?.cohort ?? null,
      invite: o.checkoutTracking?.invite ?? null,
      customerQueueStatus: normalizeCustomerQueueStatus(o.customerQueueStatus),
      manualQueueEnteredAt: o.manualQueueEnteredAt ?? null,
      childName: o.childName,
      email: o.email,
    }));
}
