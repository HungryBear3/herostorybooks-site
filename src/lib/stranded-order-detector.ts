/**
 * Operator incident SCAN — alert-only, read-only.
 *
 * WHAT CHANGED AND WHY. The previous detector could only ever nominate an order
 * whose `fulfillmentMode` was explicitly `'auto'` and whose fulfillment was
 * still `not_started`. No production order-creation path sets that mode, so the
 * scan reported `scanned: N, candidates: 0` — a clean green light over a
 * completely uncovered surface. It also defaulted to the permissive
 * `listOrders`, whose storage fallback can turn an outage into `scanned: 0,
 * HTTP 200`, and it swallowed alert-sink exceptions while still returning
 * success.
 *
 * This module now:
 *   - enumerates ONLY through the fail-closed `listOrdersAuthoritative`;
 *   - delegates every verdict to the shared pure classifier in
 *     `./order-incident.ts`, which the admin attention queue and paid-order
 *     diagnostics also consume, so the three surfaces cannot drift apart;
 *   - keys cooldown on incident identity (`orderId + incidentClass +
 *     state-entry/attempt fingerprint`), never on order id alone;
 *   - FAILS the scan on alert-sink or cooldown-persistence failure, and marks
 *     it DEGRADED on data-quality uncertainty, so the HTTP layer can never
 *     report a clean 200 over an unreliable run.
 *
 * It has, by construction, no runtime path to fulfillment, artifact generation,
 * order/proof/payment state changes, Stripe, Blob order records, customer
 * email, or a print provider. Every side-effecting capability is an INJECTED
 * dependency; the module imports nothing runtime — only `import type`, which is
 * erased at compile time.
 *
 * ACTIVATION IS STILL GATED. The default sink is local structured logging. No
 * external channel and no cron schedule are wired by this module or its runtime.
 */

import type { OrderRecord } from './orders.ts';
import type {
  IncidentClass,
  IncidentSeverity,
  IncidentThresholds,
  OrderIncident,
} from './order-incident.ts';
import { classifyOrderIncident } from './order-incident.ts';

// ── Public shapes ─────────────────────────────────────────────────────────────

/**
 * Persisted, redacted cooldown bookkeeping. Keyed by INCIDENT dedup key
 * (`orderId::incidentClass::fingerprint`), not by order id: a new attempt or a
 * re-entered state is a new incident and must not be suppressed by the previous
 * one's cooldown. This is the scan's OWN record — it is not, and must not
 * become, an order record.
 *
 * The shape is unchanged from the previous order-id-keyed record, so an
 * existing state file loads without migration; stale order-id keys simply never
 * match a dedup key again and go inert.
 */
export type AlertState = Record<string, { lastAlertedAt: string }>;

/**
 * The minimum, redacted payload emitted to the internal alert channel.
 *
 * PII CONTRACT: no email, child name, address, capability token, Stripe or
 * provider identifier, artifact URL, story text, or customer feedback. The only
 * identifying value is the opaque order id and the admin path built from it —
 * exactly what an operator needs to open the order and investigate.
 */
export interface OperatorIncidentAlert {
  kind: 'operator_incident';
  orderId: string;
  incidentClass: IncidentClass;
  severity: IncidentSeverity;
  fulfillmentStatus: string;
  paymentStatus: string;
  bookFormat: string; // 'digital' | 'classic' | 'premium' — not PII
  ageHours: number | null;
  thresholdHours: number;
  retryable: boolean;
  detailCode: string;
  fingerprint: string;
  /** Stable idempotency key for delivery. */
  dedupKey: string;
  adminPath: string;
}

export interface ScanDeps {
  /**
   * READ-ONLY, COMPLETE, fail-closed order enumeration. Must be wired to
   * `listOrdersAuthoritative`: it paginates to exhaustion, re-reads every order
   * through the version-bound authoritative path, and throws rather than
   * returning a partial set. The permissive list helper is not acceptable here
   * because its storage fallback can silently degrade an outage into an empty,
   * apparently-clean scan.
   */
  listOrdersAuthoritative: () => Promise<OrderRecord[]>;
  /** Read the scan's own cooldown record. Throwing fails the scan closed (no
   *  alerts) — we never alert blind against an unknown cooldown state. */
  readAlertState: () => Promise<AlertState>;
  /** Persist the scan's own cooldown record (ops namespace, not orders). */
  writeAlertState: (state: AlertState) => Promise<void>;
  /** Emit ONE redacted internal alert. Default wiring is the logging path. */
  alert: (payload: OperatorIncidentAlert) => Promise<void>;
  /** Structured telemetry sink (defaults to console). */
  log: (line: string) => void;
  now: () => number;
  cooldownMs: number;
  thresholds: IncidentThresholds;
  /** Order ids the operator has explicitly marked as held/internal and does
   *  NOT want alerted (e.g. the July 13 founder test until it is dispositioned). */
  excludeOrderIds: ReadonlySet<string>;
}

export interface ScanResult {
  /** True only for a run that enumerated completely and delivered everything. */
  ok: boolean;
  /** Enumeration, alert-sink or cooldown-persistence failure. HTTP must not
   *  report a clean 200 when this is set. */
  failed: boolean;
  /** The run completed but its evidence is not fully trustworthy (clock,
   *  routing-intent or timestamp uncertainty on at least one order). */
  degraded: boolean;
  scanned: number;
  incidents: number;
  alertsSent: number;
  alertsSuppressed: number;
  /** Incidents whose alert emit threw. Their cooldown was NOT advanced. */
  alertFailures: number;
  /** Incidents classified as data-quality uncertainty. */
  dataQuality: number;
  reason?: string;
}

const HOUR_MS = 60 * 60 * 1000;

function toHours(ms: number | null): number | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return Math.floor((ms / HOUR_MS) * 10) / 10;
}

/** Project a classified incident onto the redacted wire payload. Nothing is
 *  copied from the order that the classifier did not already vet. */
function buildAlert(incident: OrderIncident): OperatorIncidentAlert {
  return {
    kind: 'operator_incident',
    orderId: incident.orderId,
    incidentClass: incident.incidentClass,
    severity: incident.severity,
    fulfillmentStatus: incident.fulfillmentStatus,
    paymentStatus: incident.paymentStatus,
    bookFormat: incident.bookFormat,
    ageHours: toHours(incident.ageMs),
    thresholdHours: toHours(incident.thresholdMs) ?? 0,
    retryable: incident.retryable,
    detailCode: incident.detailCode,
    fingerprint: incident.fingerprint,
    dedupKey: incident.dedupKey,
    adminPath: incident.adminPath,
  };
}

function isValidThresholds(t: IncidentThresholds | undefined): boolean {
  if (!t) return false;
  return [t.manualHoldMs, t.autoNotStartedMs, t.staleInProgressMs, t.leaseTtlMs, t.customerWaitMs]
    .every((v) => Number.isFinite(v) && v >= 0);
}

// ── Scan (alert-only) ──────────────────────────────────────────────────────────

/**
 * Run one incident scan. Read-only over orders; the only writes are (a) the
 * injected alert emit and (b) the scan's own cooldown record.
 *
 * Failure semantics, deliberately loud:
 *   - enumeration or cooldown READ failure aborts BEFORE any alert;
 *   - an alert emit failure leaves that incident's cooldown untouched (so the
 *     next scan retries it) and fails the whole run;
 *   - a cooldown WRITE failure fails the run, because the next scan would
 *     otherwise re-alert without knowing it;
 *   - data-quality uncertainty degrades the run without failing it.
 */
export async function runIncidentScan(deps: ScanDeps): Promise<ScanResult> {
  const nowMs = deps.now();
  const empty: ScanResult = {
    ok: false, failed: true, degraded: false, scanned: 0, incidents: 0,
    alertsSent: 0, alertsSuppressed: 0, alertFailures: 0, dataQuality: 0,
  };

  if (!Number.isFinite(deps.cooldownMs) || deps.cooldownMs < 0 || !isValidThresholds(deps.thresholds)) {
    deps.log('[incident-scan] scan_failure reason=invalid_config');
    return { ...empty, reason: 'invalid_config' };
  }

  let orders: OrderRecord[];
  let state: AlertState;
  try {
    // Authoritative, complete enumeration AND cooldown state up front. If
    // either is uncertain we never alert (fail closed) — a partial order list
    // would silently under-report, and an unknown cooldown would over-report.
    orders = await deps.listOrdersAuthoritative();
    state = await deps.readAlertState();
  } catch (err) {
    deps.log(`[incident-scan] scan_failure reason=enumeration_unavailable message=${sanitize(err)}`);
    return { ...empty, reason: 'enumeration_unavailable' };
  }

  let incidents = 0;
  let alertsSent = 0;
  let alertsSuppressed = 0;
  let alertFailures = 0;
  let dataQuality = 0;
  const nextState: AlertState = { ...state };
  let stateChanged = false;

  for (const order of orders) {
    if (deps.excludeOrderIds.has(order.id)) {
      deps.log(`[incident-scan] excluded_by_allowlist orderId=${order.id}`);
      continue;
    }

    const incident = classifyOrderIncident(order, { nowMs, thresholds: deps.thresholds });
    if (incident === null) continue;

    incidents += 1;
    if (incident.incidentClass === 'data_quality_uncertain') dataQuality += 1;

    const prior = nextState[incident.dedupKey];
    const priorMs = prior ? Date.parse(prior.lastAlertedAt) : Number.NaN;
    const withinCooldown = Number.isFinite(priorMs) && nowMs - priorMs < deps.cooldownMs;
    if (withinCooldown) {
      alertsSuppressed += 1;
      const remaining = deps.cooldownMs - (nowMs - priorMs);
      deps.log(
        `[incident-scan] alert_suppressed orderId=${incident.orderId} class=${incident.incidentClass} ` +
          `cooldownRemainingMs=${Math.max(0, remaining)}`,
      );
      continue;
    }

    try {
      await deps.alert(buildAlert(incident));
    } catch (err) {
      // A failed emit must NOT advance cooldown (so the next scan re-attempts)
      // and must NOT let the run claim success.
      alertFailures += 1;
      deps.log(
        `[incident-scan] alert_error orderId=${incident.orderId} class=${incident.incidentClass} ` +
          `message=${sanitize(err)}`,
      );
      continue;
    }
    alertsSent += 1;
    nextState[incident.dedupKey] = { lastAlertedAt: new Date(nowMs).toISOString() };
    stateChanged = true;
    deps.log(
      `[incident-scan] alert_sent orderId=${incident.orderId} class=${incident.incidentClass} ` +
        `severity=${incident.severity} ageHours=${toHours(incident.ageMs)} retryable=${incident.retryable}`,
    );
  }

  const tally = { scanned: orders.length, incidents, alertsSent, alertsSuppressed, alertFailures, dataQuality };

  if (stateChanged) {
    try {
      await deps.writeAlertState(nextState);
    } catch (err) {
      // Alerts already emitted but the cooldown did not persist. The next scan
      // would re-alert without knowing it, so this run is a failure, not a
      // footnote.
      deps.log(`[incident-scan] scan_failure reason=cooldown_persist_failed message=${sanitize(err)}`);
      return { ...tally, ok: false, failed: true, degraded: dataQuality > 0, reason: 'cooldown_persist_failed' };
    }
  }

  if (alertFailures > 0) {
    deps.log(`[incident-scan] scan_failure reason=alert_sink_failed alertFailures=${alertFailures}`);
    return { ...tally, ok: false, failed: true, degraded: dataQuality > 0, reason: 'alert_sink_failed' };
  }

  const degraded = dataQuality > 0;
  deps.log(
    `[incident-scan] ${degraded ? 'scan_degraded' : 'scan_success'} scanned=${tally.scanned} ` +
      `incidents=${incidents} alertsSent=${alertsSent} alertsSuppressed=${alertsSuppressed} ` +
      `dataQuality=${dataQuality}`,
  );
  return {
    ...tally,
    ok: true,
    failed: false,
    degraded,
    ...(degraded ? { reason: 'data_quality_uncertain' } : {}),
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
