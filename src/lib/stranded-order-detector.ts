/**
 * Stranded paid-order DETECTOR — alert-only, read-only.
 *
 * Purpose: surface orders whose payment is authoritatively `paid` but whose
 * fulfillment never left `not_started` past a configurable age, so an operator
 * can investigate. This module ONLY detects and emits a redacted internal
 * alert. It has, by construction, no runtime path to fulfillment, artifact
 * generation, order/proof/payment/fulfillment state changes, Stripe, Blob
 * order records, customer email, or a print provider:
 *
 *   - Every side-effecting capability is an INJECTED dependency
 *     (`listOrders`, `readAlertState`, `writeAlertState`, `alert`, `log`,
 *     `now`). The module imports nothing runtime — only `import type`, which
 *     is erased at compile time. There is no import of `./fulfillment`,
 *     `./order-email`, `stripe`, `@vercel/blob`, or any order-write helper.
 *   - The injected `writeAlertState` targets the detector's OWN cooldown
 *     record (a separate ops namespace), never an order record.
 *
 * DISCRIMINATOR (fail-closed):
 * A stranded order is distinguished from an intentionally-held/manual order by
 * the explicit `fulfillmentMode` intent set by the creating workflow: ONLY
 * `fulfillmentMode === 'auto'` orders (with a valid authoritative `paidAt`) are
 * candidates. `manual_hold`, legacy/undefined mode, missing/invalid/future
 * `paidAt`, internal disposition, and an operator allowlist all fail closed.
 * No mode is inferred from product type, payment, or PII. NOTE: no order-
 * creation workflow currently sets `fulfillmentMode='auto'` (pending product/
 * policy decision), so today every order fails closed and the detector alerts
 * on nothing — activation stays blocked until an 'auto' workflow is designated.
 */

import type { OrderRecord } from './orders.ts';

// ── Public shapes ─────────────────────────────────────────────────────────────

/** Persisted, redacted per-order alert bookkeeping. Keyed by orderId. Value is
 *  the ISO timestamp we last alerted, used purely for cooldown/dedup. This is
 *  the detector's OWN record — it is not, and must not become, an order record. */
export type AlertState = Record<string, { lastAlertedAt: string }>;

/** The minimum, redacted payload emitted to the internal alert channel. No
 *  email, name, address, Stripe id, or artifact URL — only what an operator
 *  needs to open the order in admin and investigate. */
export interface StrandedAlert {
  kind: 'stranded_paid_order';
  orderId: string;
  bookFormat: string; // 'digital' | 'classic' | 'premium' — not PII
  paymentStatus: 'paid';
  fulfillmentStatus: 'not_started' | 'unset';
  ageHours: number;
  thresholdHours: number;
}

export interface EligibilityConfig {
  /** Minimum age (ms) since the paid/last write before an order is eligible. */
  thresholdMs: number;
  /** Order ids the operator has explicitly marked as held/internal and does
   *  NOT want alerted (e.g. the July 13 founder test until it is dispositioned). */
  excludeOrderIds: ReadonlySet<string>;
  /** Wall clock (ms epoch) for this scan. */
  nowMs: number;
}

export type IneligibleReason =
  | 'not_paid'
  | 'refunded'
  | 'fulfillment_started_or_terminal'
  | 'internal_disposition'
  | 'excluded_by_allowlist'
  | 'manual_hold'
  | 'legacy_mode_unset'
  | 'missing_paidat'
  | 'invalid_paidat'
  | 'future_paidat'
  | 'below_threshold';

/** Reasons that indicate a data-quality problem on an otherwise-eligible order
 *  (paid + auto + not_started) — surfaced as a `skipped` count + telemetry line
 *  so an operator can investigate, rather than silently dropped. */
const DATA_QUALITY_REASONS: ReadonlySet<IneligibleReason> = new Set(['invalid_paidat', 'future_paidat']);

/** Flat (non-discriminated) shape on purpose: the project's tsconfig does not
 *  reliably narrow discriminated unions, so callers read the optional fields
 *  directly. When `eligible` is true, `ageMs` is set; otherwise `reason` is. */
export interface Eligibility {
  eligible: boolean;
  ageMs?: number;
  reason?: IneligibleReason;
}

export interface ScanDeps {
  /** READ-ONLY order list. Injected so the core module never imports the
   *  orders module's write functions. */
  listOrders: () => Promise<OrderRecord[]>;
  /** Read the detector's own cooldown record. Throwing here fails the scan
   *  closed (no alerts) — we never alert blind. */
  readAlertState: () => Promise<AlertState>;
  /** Persist the detector's own cooldown record (ops namespace, not orders). */
  writeAlertState: (state: AlertState) => Promise<void>;
  /** Emit ONE redacted internal alert. Default wiring is the logging path. */
  alert: (payload: StrandedAlert) => Promise<void>;
  /** Structured telemetry sink (defaults to console). */
  log: (line: string) => void;
  now: () => number;
  thresholdMs: number;
  cooldownMs: number;
  excludeOrderIds: ReadonlySet<string>;
}

export interface ScanResult {
  ok: boolean;
  failed: boolean;
  scanned: number;
  candidates: number;
  alertsSent: number;
  alertsSuppressed: number;
  /** Orders skipped for a data-quality reason (e.g. unparseable timestamp). */
  skipped: number;
  reason?: string;
}

const HOUR_MS = 60 * 60 * 1000;

// ── Pure eligibility ───────────────────────────────────────────────────────────

/**
 * Pure, side-effect-free eligibility test. Ordered so each exclusion is
 * independently observable. A candidate MUST have explicit `fulfillmentMode ===
 * 'auto'` intent AND a valid authoritative `paidAt`; everything else (manual_hold,
 * legacy/undefined mode, missing/invalid/future paidAt, unpaid, refunded,
 * started/terminal, internal disposition, allowlisted, below-threshold) fails
 * closed with an explicit reason. Age is computed from `paidAt` ONLY — never
 * from `updatedAt` or a scan clock.
 */
export function evaluateEligibility(order: OrderRecord, cfg: EligibilityConfig): Eligibility {
  // 1. Authoritative paid evidence. `paymentStatus` is written only by the
  //    Stripe webhook; 'refunded' is terminal and excluded here + below.
  if (order.paymentStatus !== 'paid') return { eligible: false, reason: 'not_paid' };

  // 2. Refund is terminal for the payment lifecycle.
  if (order.refundedAt) return { eligible: false, reason: 'refunded' };

  // 3. Fulfillment must be genuinely unstarted. Any in-progress, complete,
  //    delivery_email_failed, proof_*, or failed_manual_review state is
  //    excluded — those are handled by other paths, not "silently stranded".
  const f = order.fulfillmentStatus ?? 'not_started';
  if (f !== 'not_started') return { eligible: false, reason: 'fulfillment_started_or_terminal' };

  // 4. Internal/test/smoke orders carry a schema disposition marker; exclude
  //    them. Also honor the operator-supplied id allowlist (no PII inference).
  if (order.internalDisposition != null) return { eligible: false, reason: 'internal_disposition' };
  if (cfg.excludeOrderIds.has(order.id)) return { eligible: false, reason: 'excluded_by_allowlist' };

  // 5. Fulfillment routing intent — FAIL CLOSED. Only an order the workflow
  //    explicitly marked 'auto' is a stranded-detection candidate. manual_hold
  //    and legacy/undefined mode are never alerted.
  if (order.fulfillmentMode === 'manual_hold') return { eligible: false, reason: 'manual_hold' };
  if (order.fulfillmentMode !== 'auto') return { eligible: false, reason: 'legacy_mode_unset' };

  // 6. Authoritative paidAt required; age is derived from it ONLY.
  if (order.paidAt == null || order.paidAt === '') return { eligible: false, reason: 'missing_paidat' };
  const paidMs = Date.parse(order.paidAt);
  if (!Number.isFinite(paidMs)) return { eligible: false, reason: 'invalid_paidat' };
  if (paidMs > cfg.nowMs) return { eligible: false, reason: 'future_paidat' };

  // 7. Age threshold (inclusive at exactly threshold).
  const ageMs = cfg.nowMs - paidMs;
  if (ageMs < cfg.thresholdMs) return { eligible: false, reason: 'below_threshold' };

  return { eligible: true, ageMs };
}

function buildAlert(order: OrderRecord, ageMs: number, thresholdMs: number): StrandedAlert {
  return {
    kind: 'stranded_paid_order',
    orderId: order.id,
    bookFormat: order.bookFormat,
    paymentStatus: 'paid',
    fulfillmentStatus: order.fulfillmentStatus == null ? 'unset' : 'not_started',
    ageHours: Math.floor((ageMs / HOUR_MS) * 10) / 10,
    thresholdHours: Math.floor((thresholdMs / HOUR_MS) * 10) / 10,
  };
}

// ── Scan (alert-only) ──────────────────────────────────────────────────────────

/**
 * Run one detection scan. Read-only over orders; the only writes are (a) the
 * injected alert emit and (b) the detector's own cooldown record. Fails closed:
 * any storage/config error aborts BEFORE any alert and returns a failure signal
 * with zero alerts and zero writes to order state.
 */
export async function runStrandedScan(deps: ScanDeps): Promise<ScanResult> {
  const nowMs = deps.now();
  const empty: ScanResult = {
    ok: false, failed: true, scanned: 0, candidates: 0,
    alertsSent: 0, alertsSuppressed: 0, skipped: 0,
  };

  if (!Number.isFinite(deps.thresholdMs) || deps.thresholdMs < 0 || !Number.isFinite(deps.cooldownMs) || deps.cooldownMs < 0) {
    deps.log('[stranded-scan] scan_failure reason=invalid_config');
    return { ...empty, reason: 'invalid_config' };
  }

  let orders: OrderRecord[];
  let state: AlertState;
  try {
    // Read order list AND cooldown state up front. If either fails we never
    // alert (fail closed) — we do not alert against an unknown cooldown state.
    orders = await deps.listOrders();
    state = await deps.readAlertState();
  } catch (err) {
    deps.log(`[stranded-scan] scan_failure reason=storage_unavailable message=${sanitize(err)}`);
    return { ...empty, reason: 'storage_unavailable' };
  }

  const cfg: EligibilityConfig = {
    thresholdMs: deps.thresholdMs,
    excludeOrderIds: deps.excludeOrderIds,
    nowMs,
  };

  let candidates = 0;
  let alertsSent = 0;
  let alertsSuppressed = 0;
  let skipped = 0;
  const nextState: AlertState = { ...state };
  let stateChanged = false;

  for (const order of orders) {
    const verdict = evaluateEligibility(order, cfg);
    // Positive-branch discrimination: the eligible member is handled in the
    // `if`; the `else` narrows to the ineligible member (portable across TS
    // versions, unlike negated inline narrowing).
    if (verdict.eligible) {
      candidates += 1;
      const payload = buildAlert(order, verdict.ageMs ?? 0, deps.thresholdMs);

      const prior = nextState[order.id];
      const priorMs = prior ? Date.parse(prior.lastAlertedAt) : NaN;
      const withinCooldown = Number.isFinite(priorMs) && nowMs - priorMs < deps.cooldownMs;
      if (withinCooldown) {
        alertsSuppressed += 1;
        const remaining = deps.cooldownMs - (nowMs - priorMs);
        deps.log(`[stranded-scan] alert_suppressed orderId=${order.id} cooldownRemainingMs=${Math.max(0, remaining)}`);
        continue;
      }

      try {
        await deps.alert(payload);
      } catch (err) {
        // A failed alert emit must not mutate cooldown state (so a retry can
        // re-attempt) and must not crash the scan.
        deps.log(`[stranded-scan] alert_error orderId=${order.id} message=${sanitize(err)}`);
        continue;
      }
      alertsSent += 1;
      nextState[order.id] = { lastAlertedAt: new Date(nowMs).toISOString() };
      stateChanged = true;
      deps.log(`[stranded-scan] alert_sent orderId=${order.id} ageHours=${payload.ageHours}`);
    } else if (verdict.reason != null && DATA_QUALITY_REASONS.has(verdict.reason)) {
      skipped += 1;
      deps.log(`[stranded-scan] data_quality skip orderId=${order.id} reason=${verdict.reason}`);
    }
  }

  if (stateChanged) {
    try {
      await deps.writeAlertState(nextState);
    } catch (err) {
      // Alerts already emitted; persistence of cooldown failed. Log it — next
      // scan may re-alert (bounded, non-mutating). Do not fail the whole scan.
      deps.log(`[stranded-scan] cooldown_persist_failed message=${sanitize(err)}`);
    }
  }

  deps.log(
    `[stranded-scan] scan_success scanned=${orders.length} candidates=${candidates} ` +
      `alertsSent=${alertsSent} alertsSuppressed=${alertsSuppressed} skipped=${skipped}`,
  );
  return {
    ok: true,
    failed: false,
    scanned: orders.length,
    candidates,
    alertsSent,
    alertsSuppressed,
    skipped,
  };
}

/** Redact/shorten an error for telemetry — never echo secrets or PII. */
function sanitize(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/(vercel_blob_rw|rw_)[A-Za-z0-9_-]{8,}/gi, '$1[redacted]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/g, '[redacted-email]')
    .slice(0, 200);
}
