/**
 * THE only shape an admin HTTP or RSC boundary may hand out (L-4 Slice A3-1).
 *
 * Before this module, three surfaces serialized whole `OrderRecord` values:
 * the admin list API, the admin detail API, and the admin list page's handoff
 * into a `'use client'` component. "Whole record" is not a redaction problem
 * that can be solved by deleting a field, because the record grows: every
 * optional field added to `OrderRecord` later would have crossed those three
 * boundaries automatically, on the day it was added, with nobody deciding that
 * it should.
 *
 * So the rule here is positive, not subtractive. Every key that leaves this
 * module is written out by name in a fresh object literal. There is no spread,
 * no `Omit`, no runtime `Pick`, no delete-the-bad-ones pass, and no
 * "return the original if something looks off" fallback. A `Pick<>` or an
 * `Omit<>` annotation would not help either: both are erased at run time and
 * constrain nothing about what `JSON.stringify` actually emits.
 *
 * Nested objects are rebuilt field by field for the same reason. Passing
 * `record.checkoutTracking` through by reference would re-open the hole one
 * level down.
 *
 * `stage` and `attention` are computed HERE, on the server, and only their
 * results cross. The client previously received whole records so that it could
 * call `deriveOrderAttention` itself — which meant `shippingAddress`,
 * `auditEvents`, `proofApprovalToken` and the print/QA internals were
 * serialized into the browser payload of a page that lists every order, purely
 * as inputs to a derivation. They are inputs on the server now, and they stop
 * here.
 *
 * This module performs no I/O: no storage read or write, no provider call, no
 * credential read, no environment read, no log sink. It projects, and nothing
 * else.
 */
import type { CheckoutTracking } from './checkout-tracking.ts';
import type { FulfillmentStatus } from './fulfillment-types.ts';
import type { CustomerQueueStatus } from './order-queue.ts';
import {
  deriveOrderAttention,
  deriveOrderStage,
  type DerivedOrderAttention,
  type DerivedOrderStage,
} from './order-stage.ts';
import type { InternalOrderDisposition, OrderRecord, OrderStatus, PaymentStatus } from './orders.ts';
import {
  projectConfirmationEmailEnvelopeRefIfValid,
  type ConfirmationEmailOperatorView,
} from './confirmation-envelope-ref.ts';

/**
 * Re-exported so the operator view's shape is reachable from the module that
 * decides whether it crosses. It is DEFINED next to the ref validator on
 * purpose: the view is only meaningful for a ref that has been positively
 * validated, and keeping the allowlist beside the validator means the two
 * cannot drift apart in separate files.
 */
export type { ConfirmationEmailOperatorView } from './confirmation-envelope-ref.ts';

/**
 * The F&F cohort/invite pair, rebuilt rather than forwarded.
 *
 * `CheckoutTracking` is a shared type that other code may extend; forwarding
 * the stored object would let a future member of it cross this boundary
 * without review.
 */
export interface AdminOrderCheckoutTracking {
  cohort: string | null;
  invite: string | null;
}

/**
 * The server-computed attention verdict, byte-for-byte the existing
 * `DerivedOrderAttention` contract. All four members are load-bearing: the
 * grid renders `severity` as a pill and `reason`, `queue` and `nextActionOwner`
 * as the line underneath it.
 */
export interface AdminOrderAttention {
  severity: DerivedOrderAttention['severity'];
  reason: DerivedOrderAttention['reason'];
  queue: DerivedOrderAttention['queue'];
  nextActionOwner: DerivedOrderAttention['nextActionOwner'];
}

/** One row of the admin orders list. Exactly these keys, always. */
export interface AdminOrderListItem {
  id: string;
  childName: string;
  email: string;
  createdAt: string;
  updatedAt: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus | null;
  fulfillmentLastError: string | null;
  storyArtifactUrl: string | null;
  refundedAt: string | null;
  formatLabel: string;
  internalDisposition: InternalOrderDisposition | null;
  internalDispositionNote: string | null;
  customerQueueStatus: CustomerQueueStatus | null;
  checkoutTracking: AdminOrderCheckoutTracking | null;
  stage: DerivedOrderStage;
  attention: AdminOrderAttention;
  /**
   * Non-PII confirmation-envelope metadata, present ONLY when the record
   * carries a fully valid, non-tombstoned `confirmationEmailEnvelopeRef`
   * (L-4 Slice A3-3).
   *
   * Optional rather than always-emitted, and deliberately NOT added to the key
   * constants below: those pin the keys every projection emits for every order,
   * which is what makes an exact-key assertion meaningful, and the accepted A3-1
   * fixtures — none of which carry a ref — must stay byte-for-byte compatible.
   * An absent, malformed, extra-keyed, foreign-order or tombstoned ref omits
   * this property entirely; it is never emitted as null, never partially built,
   * and never falls back to the stored object.
   */
  confirmation?: ConfirmationEmailOperatorView;
}

/**
 * The admin detail API's shape.
 *
 * Declared independently of `AdminOrderListItem` rather than extending it, so
 * that each surface's emitted key set is pinned on its own and widening one
 * cannot silently widen the other. It is presently the same set; the detail
 * route's previous behaviour — return the entire record — is not a reason to
 * reproduce the entire record here.
 */
export interface AdminOrderDetail {
  id: string;
  childName: string;
  email: string;
  createdAt: string;
  updatedAt: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus | null;
  fulfillmentLastError: string | null;
  storyArtifactUrl: string | null;
  refundedAt: string | null;
  formatLabel: string;
  internalDisposition: InternalOrderDisposition | null;
  internalDispositionNote: string | null;
  customerQueueStatus: CustomerQueueStatus | null;
  checkoutTracking: AdminOrderCheckoutTracking | null;
  stage: DerivedOrderStage;
  attention: AdminOrderAttention;
  /**
   * Non-PII confirmation-envelope metadata, present ONLY when the record
   * carries a fully valid, non-tombstoned `confirmationEmailEnvelopeRef`
   * (L-4 Slice A3-3).
   *
   * Optional rather than always-emitted, and deliberately NOT added to the key
   * constants below: those pin the keys every projection emits for every order,
   * which is what makes an exact-key assertion meaningful, and the accepted A3-1
   * fixtures — none of which carry a ref — must stay byte-for-byte compatible.
   * An absent, malformed, extra-keyed, foreign-order or tombstoned ref omits
   * this property entirely; it is never emitted as null, never partially built,
   * and never falls back to the stored object.
   */
  confirmation?: ConfirmationEmailOperatorView;
}

/**
 * The exact key sets, exported so a guard can assert them without restating
 * them, and so a reviewer can read the whole allowlist in one place.
 *
 * A test additionally pins each of these constants against a hand-written
 * literal list: widening the DTO therefore takes two deliberate edits, not one.
 */
export const ADMIN_ORDER_CHECKOUT_TRACKING_KEYS = ['cohort', 'invite'] as const;

export const ADMIN_ORDER_ATTENTION_KEYS = [
  'severity',
  'reason',
  'queue',
  'nextActionOwner',
] as const;

export const ADMIN_ORDER_LIST_ITEM_KEYS = [
  'id',
  'childName',
  'email',
  'createdAt',
  'updatedAt',
  'status',
  'paymentStatus',
  'fulfillmentStatus',
  'fulfillmentLastError',
  'storyArtifactUrl',
  'refundedAt',
  'formatLabel',
  'internalDisposition',
  'internalDispositionNote',
  'customerQueueStatus',
  'checkoutTracking',
  'stage',
  'attention',
] as const;

export const ADMIN_ORDER_DETAIL_KEYS = [
  'id',
  'childName',
  'email',
  'createdAt',
  'updatedAt',
  'status',
  'paymentStatus',
  'fulfillmentStatus',
  'fulfillmentLastError',
  'storyArtifactUrl',
  'refundedAt',
  'formatLabel',
  'internalDisposition',
  'internalDispositionNote',
  'customerQueueStatus',
  'checkoutTracking',
  'stage',
  'attention',
] as const;

/**
 * Optional record fields arrive as `undefined`, `null`, or a value. They leave
 * as `null` or the value, so the emitted key set is the same for every order
 * and an exact-key assertion means something.
 */
function orNull<T>(value: T | null | undefined): T | null {
  return value === undefined || value === null ? null : value;
}

/**
 * Rebuild the cohort/invite pair, or report its absence.
 *
 * A stored object with neither member is reported as absent rather than as an
 * empty pair: the grid's "—" branch already treats both-missing that way, and
 * emitting `{ cohort: null, invite: null }` would change what the row renders.
 */
function projectCheckoutTracking(
  tracking: CheckoutTracking | null | undefined,
): AdminOrderCheckoutTracking | null {
  if (!tracking || typeof tracking !== 'object') return null;
  const cohort = typeof tracking.cohort === 'string' ? tracking.cohort : null;
  const invite = typeof tracking.invite === 'string' ? tracking.invite : null;
  if (cohort === null && invite === null) return null;
  return { cohort, invite };
}

/**
 * Rebuild the attention verdict field by field.
 *
 * `deriveOrderAttention` returns exactly these four today. Naming them here
 * means a fifth member added to `DerivedOrderAttention` later reaches the
 * browser only when someone adds it here too.
 */
function projectAttention(order: OrderRecord): AdminOrderAttention {
  const derived = deriveOrderAttention(order);
  return {
    severity: derived.severity,
    reason: derived.reason,
    queue: derived.queue,
    nextActionOwner: derived.nextActionOwner,
  };
}

/**
 * Validate the stored ref, then project the operator view — or report absence.
 *
 * Read through an index rather than a declared property so a stored value of any
 * shape reaches the validator rather than being trusted because the type says
 * it is a ref. The record this runs on came out of the store: its declared type
 * is a claim about what a writer intended, not evidence about what is there.
 *
 * The heavy lifting is in `confirmation-envelope-ref.ts` — it is the same
 * validator the public-store write boundary runs, minus the namespace check this
 * module cannot make, because an accepted A3-1 guard holds this file to no
 * `process.env` read and no I/O of any kind.
 */
function projectConfirmation(order: OrderRecord): ConfirmationEmailOperatorView | null {
  const stored = (order as OrderRecord & Record<string, unknown>)['confirmationEmailEnvelopeRef'];
  return projectConfirmationEmailEnvelopeRefIfValid(stored, { orderId: order.id });
}

/**
 * Project one order for the admin list.
 *
 * Reads the record; never writes to it. The returned object shares no
 * reference with the input, so a caller cannot reach the record through it and
 * a projection cannot mutate the record it came from.
 */
export function toAdminOrderListItem(order: OrderRecord): AdminOrderListItem {
  const projected: AdminOrderListItem = {
    id: order.id,
    childName: order.childName,
    email: order.email,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: orNull(order.fulfillmentStatus),
    fulfillmentLastError: orNull(order.fulfillmentLastError),
    storyArtifactUrl: orNull(order.storyArtifactUrl),
    refundedAt: orNull(order.refundedAt),
    formatLabel: order.formatLabel,
    internalDisposition: orNull(order.internalDisposition),
    internalDispositionNote: orNull(order.internalDispositionNote),
    customerQueueStatus: orNull(order.customerQueueStatus),
    checkoutTracking: projectCheckoutTracking(order.checkoutTracking),
    stage: deriveOrderStage(order),
    attention: projectAttention(order),
  };
  // Assigned after construction, never spread in: the property is absent
  // unless a positively validated ref produced a complete view.
  const confirmation = projectConfirmation(order);
  if (confirmation) projected.confirmation = confirmation;
  return projected;
}

/**
 * Project one order for the admin detail API.
 *
 * Written out in full rather than delegating to the list projection, for the
 * same reason the interface is declared separately: the two surfaces are pinned
 * independently, and reading this function tells you exactly what the detail
 * endpoint emits without following a second function to find out.
 */
export function toAdminOrderDetail(order: OrderRecord): AdminOrderDetail {
  const projected: AdminOrderDetail = {
    id: order.id,
    childName: order.childName,
    email: order.email,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: orNull(order.fulfillmentStatus),
    fulfillmentLastError: orNull(order.fulfillmentLastError),
    storyArtifactUrl: orNull(order.storyArtifactUrl),
    refundedAt: orNull(order.refundedAt),
    formatLabel: order.formatLabel,
    internalDisposition: orNull(order.internalDisposition),
    internalDispositionNote: orNull(order.internalDispositionNote),
    customerQueueStatus: orNull(order.customerQueueStatus),
    checkoutTracking: projectCheckoutTracking(order.checkoutTracking),
    stage: deriveOrderStage(order),
    attention: projectAttention(order),
  };
  // Assigned after construction, never spread in: the property is absent
  // unless a positively validated ref produced a complete view.
  const confirmation = projectConfirmation(order);
  if (confirmation) projected.confirmation = confirmation;
  return projected;
}
