// Order watchdog — read-only classifier that flags PAID orders stuck on their
// way to customer delivery/fulfillment, before they turn into refunds or
// support tickets.
//
// Pure over OrderRecord, like order-diagnostics. It reuses
// `classifyPaidOrderOpsIssue` for the pre-artifact stage (paid but no
// story/proof artifact) and extends coverage to the post-artifact stages the
// ops issue classifier deliberately ignores:
//   - delivery_email_failed  (artifacts exist, only the email failed)
//   - print proof sitting un-approved for too long (refund risk)
//   - approved print order whose submitToPrint never produced a print job
//   - submitToPrint started but stalled with no print job id
//   - print job submitted but never shipped after a long window
//
// Healthy terminal states (delivered digital, shipped print) and orders that
// are still inside their normal generation/production window return null.

import type { OrderRecord } from './orders.ts';
import { isPrintFormat } from './orders.ts';
import {
  classifyPaidOrderOpsIssue,
  PAID_ARTIFACT_STALE_AFTER_MS,
} from './order-diagnostics.ts';

export type StuckSeverity = 'warn' | 'fail';

export type StuckOrderReason =
  // Pre-artifact stage — delegated to classifyPaidOrderOpsIssue.
  | 'paid_no_artifact_not_started'
  | 'paid_no_artifact_failed'
  | 'paid_no_artifact_stale_in_progress'
  | 'paid_no_artifact_terminal'
  // Post-artifact / delivery stage.
  | 'delivery_email_failed'
  | 'print_proof_awaiting_customer_stale'
  | 'print_approved_not_submitted'
  | 'print_submit_stalled'
  | 'print_submitted_no_shipment_stale';

export interface StuckOrderFinding {
  orderId: string;
  reason: StuckOrderReason;
  severity: StuckSeverity;
  label: string;
  /** Why this order is flagged. */
  detail: string;
  /** Read-only-safe next step for an operator (mirrors the support runbook). */
  suggestedAction: string;
  /** Minutes since the order last changed (updatedAt, falling back to createdAt). */
  minutesSinceUpdate: number | null;
  bookFormat: string;
  isPrint: boolean;
  paymentStatus: string;
  fulfillmentStatus: string;
  orderStatus: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Thresholds, all overridable per-call. Defaults are tuned for the live HSB
 * flow: generation is fast (minutes), customer proof approval is human-paced
 * (days), and Lulu print production legitimately takes a couple of weeks.
 */
export interface WatchdogThresholds {
  /** Paid + in-progress with no artifact yet (delegated default = 15 min). */
  paidArtifactStaleMs: number;
  /** Paid print proof delivered but not approved — refund-risk window. */
  proofAwaitingStaleMs: number;
  /** Approved/submitting print order with no print job id yet. */
  printSubmitStaleMs: number;
  /** Print job submitted but no shipment recorded. */
  printShipStaleMs: number;
}

export const WATCHDOG_DEFAULT_THRESHOLDS: WatchdogThresholds = {
  paidArtifactStaleMs: PAID_ARTIFACT_STALE_AFTER_MS, // 15 minutes
  proofAwaitingStaleMs: 72 * 60 * 60 * 1000, // 3 days
  printSubmitStaleMs: 30 * 60 * 1000, // 30 minutes
  printShipStaleMs: 14 * 24 * 60 * 60 * 1000, // 14 days
};

export interface WatchdogOptions extends Partial<WatchdogThresholds> {
  now?: Date;
}

const SUGGESTED_ACTION: Record<StuckOrderReason, string> = {
  paid_no_artifact_not_started:
    'Inspect Stripe webhook / fulfillment kickoff logs. If the order is truly paid and has produced no artifacts, use admin Retry fulfillment.',
  paid_no_artifact_failed:
    'Read fulfillmentLastError. Retry fulfillment from admin (only valid on failed_manual_review) once the cause is understood.',
  paid_no_artifact_stale_in_progress:
    'Generation appears hung. Check fulfillment logs; if no artifacts were produced, admin Retry can re-kick the pipeline.',
  paid_no_artifact_terminal:
    'Terminal fulfillment status with no artifact URL — needs manual review before any retry or customer follow-up.',
  delivery_email_failed:
    'Artifacts already exist; only the delivery/proof email failed. Resend the email from admin (Resend proof / delivery). Do NOT re-run the whole pipeline.',
  print_proof_awaiting_customer_stale:
    'Paid print proof has sat un-approved. Send a reminder / follow up with the customer. Do not auto-approve without explicit customer consent.',
  print_approved_not_submitted:
    'Whole book is approved but no print job id exists — submitToPrint likely failed. Verify the shipping address, inspect submit logs, and retry the print submission when safe.',
  print_submit_stalled:
    'submitToPrint started but never produced a print job id. Check Lulu submission logs before retrying.',
  print_submitted_no_shipment_stale:
    'Print job was submitted but no shipment is recorded. Check the Lulu job status / tracking and follow up; mark shipped only after the print partner confirms.',
};

function minutesSinceUpdate(order: OrderRecord, now: Date): number | null {
  const ts = Date.parse(order.updatedAt ?? order.createdAt ?? '');
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((now.getTime() - ts) / 60_000));
}

function ageMs(minutes: number | null): number {
  return minutes == null ? Number.POSITIVE_INFINITY : minutes * 60_000;
}

/**
 * Classify a single order. Returns null for orders that are healthy, still
 * inside their normal window, or not revenue-at-risk (unpaid, refunded, or
 * internal test/smoke dispositions).
 */
export function classifyStuckOrder(
  order: OrderRecord,
  options: WatchdogOptions = {},
): StuckOrderFinding | null {
  const now = options.now ?? new Date();
  const t: WatchdogThresholds = { ...WATCHDOG_DEFAULT_THRESHOLDS, ...options };

  // Only paid orders carry revenue at risk of becoming a refund.
  if (order.paymentStatus !== 'paid') return null;
  // Already resolved or never a real customer order.
  if (order.refundedAt) return null;
  if (order.internalDisposition) return null;

  const isPrint = isPrintFormat(order.bookFormat);
  const fulfillment = order.fulfillmentStatus ?? 'not_started';
  const mins = minutesSinceUpdate(order, now);
  const age = ageMs(mins);

  // Happy terminal states — delivered digital / shipped print.
  if (isPrint && order.status === 'shipped') return null;
  if (!isPrint && fulfillment === 'complete' && order.storyArtifactUrl) return null;

  const base = (
    reason: StuckOrderReason,
    severity: StuckSeverity,
    label: string,
    detail: string,
  ): StuckOrderFinding => ({
    orderId: order.id,
    reason,
    severity,
    label,
    detail,
    suggestedAction: SUGGESTED_ACTION[reason],
    minutesSinceUpdate: mins,
    bookFormat: order.bookFormat,
    isPrint,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: fulfillment,
    orderStatus: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  });

  // ── Pre-artifact stage: reuse the existing ops-issue classifier ──────────
  // It fires only when paid && !storyArtifactUrl. We treat its actionable
  // (non-info) results as stuck and let its 'info' waiting window pass as
  // healthy (still generating, inside the threshold).
  const opsIssue = classifyPaidOrderOpsIssue(order, now);
  if (opsIssue) {
    if (opsIssue.severity === 'info') return null; // still inside generation window
    // Reasons line up 1:1 with PaidOrderOpsIssueKind except the 'waiting' info kind.
    return base(
      opsIssue.kind as StuckOrderReason,
      opsIssue.severity === 'fail' ? 'fail' : 'warn',
      opsIssue.label,
      opsIssue.detail,
    );
  }

  // From here, the order is paid AND has a story/proof artifact.

  // delivery_email_failed applies to both digital and print: the book exists,
  // only the customer notification failed. This is "customer delivery missing".
  if (fulfillment === 'delivery_email_failed') {
    return base(
      'delivery_email_failed',
      'fail',
      'Artifacts ready but customer delivery email failed',
      `fulfillmentStatus=delivery_email_failed. ${order.fulfillmentLastError ?? 'No error message recorded.'}`,
    );
  }

  // Digital orders have no proof/print follow-up; the only healthy terminal is
  // complete+artifact (handled above) and the only failure is the email
  // (handled above). Anything else is not a stuck-before-delivery case.
  if (!isPrint) return null;

  // ── Print follow-up stages ───────────────────────────────────────────────
  const approved =
    order.reviewStatus === 'approved' ||
    fulfillment === 'proof_approved' ||
    fulfillment === 'submitting_to_print';

  // Proof delivered, customer hasn't approved — refund risk once it ages out.
  if (!approved && fulfillment === 'proof_ready') {
    if (age >= t.proofAwaitingStaleMs) {
      return base(
        'print_proof_awaiting_customer_stale',
        'warn',
        'Paid print proof awaiting customer approval (stale)',
        `Proof has been ready for ${mins ?? 'unknown'} minute(s) with reviewStatus=${order.reviewStatus ?? 'not_started'} and no approval.`,
      );
    }
    return null;
  }

  // Approved but no print job id → submitToPrint failed or never ran.
  if (approved && !order.printJobId) {
    if (age >= t.printSubmitStaleMs) {
      const stalled = fulfillment === 'submitting_to_print';
      return base(
        stalled ? 'print_submit_stalled' : 'print_approved_not_submitted',
        'fail',
        stalled
          ? 'Print submission stalled with no print job id'
          : 'Approved print order has no print job id',
        `fulfillmentStatus=${fulfillment}, reviewStatus=${order.reviewStatus ?? 'not_started'}, printJobId is empty after ${mins ?? 'unknown'} minute(s).`,
      );
    }
    return null;
  }

  // Print job submitted but no shipment recorded after a long window.
  if (order.printJobId && order.status !== 'shipped') {
    if (age >= t.printShipStaleMs) {
      return base(
        'print_submitted_no_shipment_stale',
        'warn',
        'Print job submitted but never shipped',
        `printJobId=${order.printJobId} (printJobStatus=${order.printJobStatus ?? 'unknown'}) with orderStatus=${order.status} and no shippedAt after ${mins ?? 'unknown'} minute(s).`,
      );
    }
    return null;
  }

  return null;
}

export interface StuckOrderReport {
  generatedAt: string;
  scanned: number;
  paidScanned: number;
  stuck: number;
  bySeverity: { fail: number; warn: number };
  findings: StuckOrderFinding[];
}

/**
 * Classify a batch of orders into a sorted report. Findings are ordered
 * fail-first, then oldest-first (largest minutesSinceUpdate), so the most
 * urgent revenue risk is at the top.
 */
export function buildStuckOrderReport(
  orders: OrderRecord[],
  options: WatchdogOptions = {},
): StuckOrderReport {
  const now = options.now ?? new Date();
  const findings: StuckOrderFinding[] = [];
  let paidScanned = 0;

  for (const order of orders) {
    if (order.paymentStatus === 'paid') paidScanned += 1;
    const finding = classifyStuckOrder(order, { ...options, now });
    if (finding) findings.push(finding);
  }

  findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'fail' ? -1 : 1;
    const am = a.minutesSinceUpdate ?? Number.POSITIVE_INFINITY;
    const bm = b.minutesSinceUpdate ?? Number.POSITIVE_INFINITY;
    return bm - am;
  });

  return {
    generatedAt: now.toISOString(),
    scanned: orders.length,
    paidScanned,
    stuck: findings.length,
    bySeverity: {
      fail: findings.filter((f) => f.severity === 'fail').length,
      warn: findings.filter((f) => f.severity === 'warn').length,
    },
    findings,
  };
}

function formatAge(mins: number | null): string {
  if (mins == null) return 'age unknown';
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / (60 * 24))}d`;
}

/** Human-readable, paste-friendly report for the CLI / escalation threads. */
export function formatStuckOrderReport(report: StuckOrderReport): string {
  const lines: string[] = [];
  lines.push(
    `HSB order watchdog — ${report.generatedAt}`,
  );
  lines.push(
    `Scanned ${report.scanned} order(s) (${report.paidScanned} paid). ` +
      `Stuck: ${report.stuck} (${report.bySeverity.fail} FAIL, ${report.bySeverity.warn} WARN).`,
  );

  if (report.findings.length === 0) {
    lines.push('');
    lines.push('No stuck paid orders detected.');
    return lines.join('\n');
  }

  lines.push('');
  for (const f of report.findings) {
    const tag = f.severity === 'fail' ? '[FAIL]' : '[WARN]';
    lines.push(
      `${tag} ${f.orderId} · ${f.bookFormat} · pay=${f.paymentStatus} · fulfillment=${f.fulfillmentStatus} · order=${f.orderStatus} · ${formatAge(f.minutesSinceUpdate)} since update`,
    );
    lines.push(`        reason: ${f.reason} — ${f.label}`);
    lines.push(`        detail: ${f.detail}`);
    lines.push(`        action: ${f.suggestedAction}`);
  }
  return lines.join('\n');
}
