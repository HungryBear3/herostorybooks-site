/**
 * Shared, pure incident classification for paid HeroStoryBooks orders.
 *
 * This module is the SINGLE source of truth for "is this order in trouble, and
 * which kind of trouble". It is consumed by three previously-divergent callers:
 *
 *   - `stranded-order-detector.ts` (the scheduled scan / alert path)
 *   - `order-stage.ts` -> `deriveOrderAttention` (the admin attention queue)
 *   - `order-diagnostics.ts` -> `classifyPaidOrderOpsIssue` (paid-order triage)
 *
 * Dependency direction is one-way (this module is imported BY its three
 * consumers and imports none of them), so sharing the taxonomy introduces no
 * cycle. The module is PURE: it imports only types, reads only the injected
 * clock, and performs no I/O. It must also stay safe in a React client bundle —
 * `order-stage.ts` is imported by the admin client component — so no `node:`
 * builtin may appear here.
 *
 * PII CONTRACT: nothing this module returns may contain an email address, child
 * name, postal address, capability token, Stripe/provider identifier, artifact
 * URL, story text, or customer feedback. The only identifying value emitted is
 * the opaque order id (and the admin path built from it). Free-text provider
 * errors are never echoed — only a validated short code is extracted, and the
 * raw text never reaches the fingerprint either.
 */

import type { OrderRecord } from './orders.ts';

// ── Taxonomy ─────────────────────────────────────────────────────────────────

export type IncidentClass =
  /** `submitting_to_print` past the durable pre-POST fence with no provider
   *  job. A physical book may already exist. Never retryable; an operator must
   *  reconcile against the provider. */
  | 'print_submission_ambiguous'
  /** Artifacts exist and are correct; only the customer notification failed. */
  | 'delivery_email_failed'
  /** A genuine fulfillment failure — explicitly NOT refund finalization. */
  | 'failed_manual_review'
  /** An in-progress generating/building state with no live kickoff lease. */
  | 'stale_in_progress_no_lease'
  /** Explicit `auto` routing intent that never left `not_started`. */
  | 'auto_not_started'
  /** Explicit `manual_hold` intent past its own operator SLA. A hold is not
   *  invisible forever, but detection never starts fulfillment. */
  | 'manual_hold_sla'
  /** An intentional customer wait (proof released, awaiting review) that has
   *  outlived its own, much longer, SLA. */
  | 'customer_review_wait_overdue'
  /** Clock, routing-intent or timestamp uncertainty. Degrades the scan rather
   *  than being silently dropped. */
  | 'data_quality_uncertain';

export type IncidentSeverity = 'critical' | 'high' | 'medium';

/** Relative urgency. Ambiguous print outranks everything by construction. */
export const INCIDENT_SEVERITY_RANK: Record<IncidentClass, number> = {
  print_submission_ambiguous: 100,
  failed_manual_review: 80,
  stale_in_progress_no_lease: 70,
  auto_not_started: 60,
  delivery_email_failed: 50,
  data_quality_uncertain: 40,
  manual_hold_sla: 30,
  customer_review_wait_overdue: 10,
};

const SEVERITY_BY_CLASS: Record<IncidentClass, IncidentSeverity> = {
  print_submission_ambiguous: 'critical',
  failed_manual_review: 'high',
  stale_in_progress_no_lease: 'high',
  auto_not_started: 'high',
  delivery_email_failed: 'high',
  data_quality_uncertain: 'medium',
  manual_hold_sla: 'medium',
  customer_review_wait_overdue: 'medium',
};

export interface OrderIncident {
  /** Opaque order id — the only identifying field, by design. */
  orderId: string;
  incidentClass: IncidentClass;
  severity: IncidentSeverity;
  /** Non-PII lifecycle facts an operator needs to triage. */
  fulfillmentStatus: string;
  paymentStatus: string;
  bookFormat: string;
  /** Age since the state entry that drives this incident. Null when unknowable. */
  ageMs: number | null;
  /** The threshold this incident crossed (0 for immediate classes). */
  thresholdMs: number;
  /** Whether an ordinary operator retry is safe. Always false for an ambiguous
   *  print submission: retrying can create a second physical job. */
  retryable: boolean;
  /** Validated short code. Never free-text provider output. */
  detailCode: string;
  /** Opaque hash of the state-entry/attempt identity. Changes when the order
   *  re-enters the state or makes a new attempt. */
  fingerprint: string;
  /** `orderId::incidentClass::fingerprint` — incident identity, not order id. */
  dedupKey: string;
  adminPath: string;
}

export interface IncidentThresholds {
  /** Operator SLA for a paid `manual_hold` order. */
  manualHoldMs: number;
  /** How long an explicit `auto` order may sit at `not_started`. */
  autoNotStartedMs: number;
  /** How long an in-progress state may sit with no live lease. */
  staleInProgressMs: number;
  /** Kickoff-lease TTL. Mirrors FULFILLMENT_KICKOFF_TTL_MS in fulfillment.ts. */
  leaseTtlMs: number;
  /** How long a released proof may wait on the customer before it is surfaced. */
  customerWaitMs: number;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Conservative design/testing defaults. These are NOT an activation decision:
 * recipient and cadence remain activation-time operator configuration, and this
 * lane wires no external channel and no cron.
 */
export const DEFAULT_INCIDENT_THRESHOLDS: IncidentThresholds = {
  manualHoldMs: 24 * HOUR_MS,
  autoNotStartedMs: 12 * HOUR_MS,
  staleInProgressMs: 60 * MINUTE_MS,
  leaseTtlMs: 6 * MINUTE_MS,
  customerWaitMs: 14 * DAY_MS,
};

export interface ClassifyContext {
  nowMs: number;
  thresholds?: Partial<IncidentThresholds>;
}

/**
 * In-progress fulfillment states. `submitting_to_print` is included because an
 * order parked there with no provider job is exactly the false-green case this
 * lane exists to remove — but it is never marked retryable.
 */
const IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set([
  'generating_story',
  'generating_images',
  'building_pdf',
  'submitting_to_print',
]);

/** States where the ball is legitimately in the customer's court. */
const CUSTOMER_WAIT_STATUSES: ReadonlySet<string> = new Set(['proof_ready', 'proof_approved']);

const PRINT_AMBIGUOUS_ERROR_PREFIX = 'print_submission_ambiguous';

// ── Shared predicates ────────────────────────────────────────────────────────

/**
 * A print submission is AMBIGUOUS when the irreversible provider call was
 * attempted (or explicitly reported ambiguous) and no provider job identity
 * came back. `fulfillment.ts` deliberately parks these at `submitting_to_print`
 * rather than failing them, because a retry could create a second physical job.
 *
 * Deliberately independent of `storyArtifactUrl`: the artifact existing is what
 * previously hid this case from paid-order diagnostics entirely.
 */
export function isPrintSubmissionAmbiguous(order: OrderRecord): boolean {
  if ((order.fulfillmentStatus ?? 'not_started') !== 'submitting_to_print') return false;
  // A known provider job means the submission is reconciled, not ambiguous.
  if (order.printJobId) return false;
  if (order.printJobStatus) return false;
  if ((order.fulfillmentLastError ?? '').startsWith(PRINT_AMBIGUOUS_ERROR_PREFIX)) return true;
  // The durable pre-POST fence was crossed and no job was recorded: the first
  // provider response may simply have been lost.
  return Boolean(order.printSubmissionAttemptedAt);
}

/**
 * True only while a kickoff claim is genuinely live. Fails closed on a missing,
 * unparseable or future claim timestamp so a bad clock can never manufacture an
 * "it is still running" excuse for a stalled order.
 */
export function hasActiveFulfillmentLease(order: OrderRecord, nowMs: number, leaseTtlMs: number): boolean {
  if (!order.fulfillmentKickoffId) return false;
  const claimedMs = Date.parse(order.fulfillmentKickoffAt ?? '');
  if (!Number.isFinite(claimedMs)) return false;
  if (claimedMs > nowMs) return false;
  return nowMs - claimedMs < leaseTtlMs;
}

/**
 * Terminal states that must never produce a stranded/manual-review incident.
 * Refund finalization writes `fulfillmentStatus='failed_manual_review'` on
 * purpose, so every refund signal is checked here — a refunded order would
 * otherwise alert forever.
 *
 * Ambiguous print is deliberately classified BEFORE this gate: refunding a
 * customer does not un-submit a physical book.
 */
function isTerminalOrExcluded(order: OrderRecord): boolean {
  if (order.internalDisposition != null) return true;
  if (order.refundedAt) return true;
  if (order.paymentStatus === 'refunded' || order.paymentStatus === 'partially_refunded') return true;
  if (order.stripeRefundId) return true;
  if (order.refundClaimId) return true;
  if (order.shippedAt || order.status === 'shipped') return true;
  const printJobStatus = (order.printJobStatus ?? '').toLowerCase();
  if (printJobStatus === 'shipped' || printJobStatus === 'delivered') return true;
  if ((order.fulfillmentStatus ?? 'not_started') === 'complete') return true;
  return false;
}

// ── Redaction helpers ────────────────────────────────────────────────────────

/**
 * Extract a validated short code from a provider error. Anything that is not a
 * bare token fails closed to `unclassified`, so free-text messages — which
 * routinely embed Stripe ids and email addresses — can never leak.
 */
export function safeErrorCode(raw: string | null | undefined): string {
  if (!raw) return 'none';
  const head = raw.split(':', 1)[0].trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(head) ? head : 'unclassified';
}

/**
 * Two independently-seeded FNV-1a 32-bit passes, concatenated to 16 hex chars.
 * Deterministic and dependency-free: Node's crypto builtin is unavailable here
 * because this module is reachable from the admin client bundle.
 */
function opaqueHash(input: string): string {
  const pass = (offsetBasis: number): string => {
    let h = offsetBasis >>> 0;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (input.charCodeAt(i) >>> 8) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return pass(0x811c9dc5) + pass(0x7fffffff);
}

/**
 * State-entry / attempt identity. Composed ONLY of non-PII lifecycle values,
 * and hashed so that even opaque internal claim ids are not emitted verbatim.
 * The raw provider error is never an input — only its validated short code.
 */
function buildFingerprint(
  order: OrderRecord,
  incidentClass: IncidentClass,
  stateEntryAt: string | null,
): string {
  return opaqueHash([
    incidentClass,
    order.fulfillmentStatus ?? 'not_started',
    order.paymentStatus,
    String(order.fulfillmentAttempts ?? 0),
    stateEntryAt ?? '',
    order.fulfillmentKickoffId ?? '',
    order.printSubmissionAttemptedAt ?? '',
    order.printSubmissionProofVersion ?? '',
    order.proofVersion ?? '',
    safeErrorCode(order.fulfillmentLastError),
  ].join(' '));
}

function buildIncident(args: {
  order: OrderRecord;
  incidentClass: IncidentClass;
  ageMs: number | null;
  thresholdMs: number;
  retryable: boolean;
  detailCode: string;
  stateEntryAt: string | null;
}): OrderIncident {
  const { order, incidentClass, stateEntryAt } = args;
  const fingerprint = buildFingerprint(order, incidentClass, stateEntryAt);
  return {
    orderId: order.id,
    incidentClass,
    severity: SEVERITY_BY_CLASS[incidentClass],
    fulfillmentStatus: order.fulfillmentStatus ?? 'not_started',
    paymentStatus: order.paymentStatus,
    bookFormat: order.bookFormat,
    ageMs: args.ageMs,
    thresholdMs: args.thresholdMs,
    // Ambiguous print is never retryable regardless of what a caller asks for.
    retryable: incidentClass === 'print_submission_ambiguous' ? false : args.retryable,
    detailCode: args.detailCode,
    fingerprint,
    dedupKey: `${order.id}::${incidentClass}::${fingerprint}`,
    adminPath: `/admin/orders/${order.id}`,
  };
}

/** Read a timestamp field, distinguishing absent / unparseable / future. */
type TimestampVerdict =
  | { kind: 'ok'; ms: number; iso: string }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'future'; iso: string };

function readTimestamp(raw: string | null | undefined, nowMs: number): TimestampVerdict {
  if (raw == null || raw === '') return { kind: 'missing' };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { kind: 'invalid' };
  if (ms > nowMs) return { kind: 'future', iso: raw };
  return { kind: 'ok', ms, iso: raw };
}

function dataQuality(order: OrderRecord, detailCode: string, stateEntryAt: string | null): OrderIncident {
  return buildIncident({
    order,
    incidentClass: 'data_quality_uncertain',
    ageMs: null,
    thresholdMs: 0,
    retryable: false,
    detailCode,
    stateEntryAt,
  });
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * Classify one order into at most one incident. Returns `null` for a healthy,
 * intentionally-waiting, or terminal order.
 *
 * Evaluation order is significant and each step is independently observable:
 *   1. ambiguous print (outranks even refund/disposition — a physical book may
 *      already exist and the provider must still be reconciled);
 *   2. terminal/refund/internal exclusions;
 *   3. unpaid orders (not this taxonomy's concern);
 *   4. delivery-email failure;
 *   5. genuine manual-review failure;
 *   6. stale in-progress with no live lease;
 *   7. intentional customer wait past its own SLA;
 *   8. `not_started` routed by explicit fulfillment mode, with timestamp and
 *      routing-intent uncertainty surfaced as data quality rather than dropped.
 */
export function classifyOrderIncident(order: OrderRecord, ctx: ClassifyContext): OrderIncident | null {
  const nowMs = ctx.nowMs;
  const t: IncidentThresholds = { ...DEFAULT_INCIDENT_THRESHOLDS, ...(ctx.thresholds ?? {}) };

  // 1. Highest severity, checked first and exempt from the terminal filter.
  if (isPrintSubmissionAmbiguous(order)) {
    const attempted = readTimestamp(order.printSubmissionAttemptedAt, nowMs);
    const entryIso = attempted.kind === 'ok' ? attempted.iso : (order.updatedAt ?? null);
    const entryMs = attempted.kind === 'ok' ? attempted.ms : Date.parse(order.updatedAt ?? '');
    const errorCode = safeErrorCode(order.fulfillmentLastError);
    return buildIncident({
      order,
      incidentClass: 'print_submission_ambiguous',
      ageMs: Number.isFinite(entryMs) ? Math.max(0, nowMs - entryMs) : null,
      thresholdMs: 0,
      retryable: false,
      detailCode: errorCode === 'none' ? 'pre_post_fence_unreconciled' : errorCode,
      stateEntryAt: entryIso,
    });
  }

  // 2. Terminal / refunded / internal orders never produce an incident.
  if (isTerminalOrExcluded(order)) return null;

  // 3. Only paid orders are in scope for this taxonomy.
  if (order.paymentStatus !== 'paid') return null;

  const fulfillment = order.fulfillmentStatus ?? 'not_started';

  // 4. Artifacts are fine; only the notification failed.
  if (fulfillment === 'delivery_email_failed') {
    const entry = readTimestamp(order.updatedAt, nowMs);
    return buildIncident({
      order,
      incidentClass: 'delivery_email_failed',
      ageMs: entry.kind === 'ok' ? nowMs - entry.ms : null,
      thresholdMs: 0,
      retryable: true,
      detailCode: 'customer_delivery_email_failed',
      stateEntryAt: order.updatedAt ?? null,
    });
  }

  // 5. A real failure. Refund finalization was already excluded at step 2.
  if (fulfillment === 'failed_manual_review') {
    const entry = readTimestamp(order.updatedAt, nowMs);
    return buildIncident({
      order,
      incidentClass: 'failed_manual_review',
      ageMs: entry.kind === 'ok' ? nowMs - entry.ms : null,
      thresholdMs: 0,
      retryable: true,
      detailCode: safeErrorCode(order.fulfillmentLastError),
      stateEntryAt: order.updatedAt ?? null,
    });
  }

  // 6. In-progress states: an incident ONLY when no lease is live.
  if (IN_PROGRESS_STATUSES.has(fulfillment)) {
    if (hasActiveFulfillmentLease(order, nowMs, t.leaseTtlMs)) return null;

    const hasKickoffStamp = order.fulfillmentKickoffAt != null && order.fulfillmentKickoffAt !== '';
    const entry = hasKickoffStamp
      ? readTimestamp(order.fulfillmentKickoffAt, nowMs)
      : readTimestamp(order.updatedAt, nowMs);
    if (entry.kind === 'invalid') return dataQuality(order, 'state_entry_invalid', null);
    if (entry.kind === 'missing') return dataQuality(order, 'state_entry_missing', null);
    if (entry.kind === 'future') return dataQuality(order, 'state_entry_future', entry.iso);

    const ageMs = nowMs - entry.ms;
    if (ageMs < t.staleInProgressMs) return null;
    return buildIncident({
      order,
      incidentClass: 'stale_in_progress_no_lease',
      ageMs,
      thresholdMs: t.staleInProgressMs,
      // Never offer a retry affordance for an in-flight print submission.
      retryable: fulfillment !== 'submitting_to_print',
      detailCode: order.fulfillmentKickoffId ? 'lease_expired' : 'no_lease_recorded',
      stateEntryAt: entry.iso,
    });
  }

  // 7. Intentional customer wait — silent until its own, much longer, SLA.
  if (CUSTOMER_WAIT_STATUSES.has(fulfillment)) {
    const entry = readTimestamp(order.customerProofReleasedAt ?? order.updatedAt, nowMs);
    if (entry.kind === 'invalid') return dataQuality(order, 'state_entry_invalid', null);
    if (entry.kind === 'missing') return dataQuality(order, 'state_entry_missing', null);
    if (entry.kind === 'future') return dataQuality(order, 'state_entry_future', entry.iso);

    const ageMs = nowMs - entry.ms;
    if (ageMs < t.customerWaitMs) return null;
    return buildIncident({
      order,
      incidentClass: 'customer_review_wait_overdue',
      ageMs,
      thresholdMs: t.customerWaitMs,
      retryable: true,
      detailCode: 'customer_review_wait_overdue',
      stateEntryAt: entry.iso,
    });
  }

  // 8. `not_started` (and any unrecognised state) routed by explicit intent.
  //    Authoritative `paidAt` only — never `updatedAt` or a scan clock.
  const paid = readTimestamp(order.paidAt, nowMs);
  if (paid.kind === 'missing') return dataQuality(order, 'paidat_missing', null);
  if (paid.kind === 'invalid') return dataQuality(order, 'paidat_invalid', null);
  if (paid.kind === 'future') return dataQuality(order, 'paidat_future', paid.iso);

  const ageMs = nowMs - paid.ms;

  if (order.fulfillmentMode === 'auto') {
    if (ageMs < t.autoNotStartedMs) return null;
    return buildIncident({
      order,
      incidentClass: 'auto_not_started',
      ageMs,
      thresholdMs: t.autoNotStartedMs,
      retryable: true,
      detailCode: 'auto_never_started',
      stateEntryAt: paid.iso,
    });
  }

  if (order.fulfillmentMode === 'manual_hold') {
    if (ageMs < t.manualHoldMs) return null;
    return buildIncident({
      order,
      incidentClass: 'manual_hold_sla',
      ageMs,
      thresholdMs: t.manualHoldMs,
      // Detection never starts fulfillment: releasing a hold is an operator act.
      retryable: false,
      detailCode: 'operator_hold_past_sla',
      stateEntryAt: paid.iso,
    });
  }

  // Legacy/undefined routing intent. We genuinely do not know whether this
  // order was meant to auto-run or wait for an operator, so say so rather than
  // failing closed into silence.
  if (ageMs < t.manualHoldMs) return null;
  return buildIncident({
    order,
    incidentClass: 'data_quality_uncertain',
    ageMs,
    thresholdMs: t.manualHoldMs,
    retryable: false,
    detailCode: 'fulfillment_mode_unset',
    stateEntryAt: paid.iso,
  });
}
