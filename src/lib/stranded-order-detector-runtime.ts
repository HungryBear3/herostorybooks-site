/**
 * Default runtime wiring for the operator incident scan.
 *
 * This is the ONLY place the scan touches durable storage, and it touches
 * exactly two things: the fail-closed authoritative order enumeration (read
 * only) and the scan's own cooldown record at
 * `withBlobNamespace('ops/stranded-alert-state.json')`. It never writes an
 * order record, and it imports nothing from fulfillment, order-email, Stripe,
 * or any order-write helper.
 *
 * ENUMERATION. Wired to `listOrdersAuthoritative`, never the permissive list
 * helper. The permissive helper falls back to ephemeral filesystem storage when
 * blob access fails, which turns a storage outage into `scanned: 0` and a clean
 * HTTP 200 — the exact false-green this lane exists to remove. The authoritative
 * helper paginates to exhaustion, re-reads each order through the version-bound
 * path, and throws on cursor ambiguity so the scan fails closed.
 *
 * ALERT SINK. Local structured logging ONLY. Wiring an external channel (email,
 * Discord, Slack, Telegram, webhook) and adding a cron schedule are separate,
 * explicitly approval-gated changes and are deliberately absent here.
 */

import { list, put } from '@vercel/blob';

import { listOrdersAuthoritative, withBlobNamespace } from './orders.ts';
import { DEFAULT_INCIDENT_THRESHOLDS, type IncidentThresholds } from './order-incident.ts';
import type { AlertState, OperatorIncidentAlert, ScanDeps } from './stranded-order-detector.ts';

const ALERT_STATE_KEY = 'ops/stranded-alert-state.json';

// Conservative defaults. Intentionally long so a normally-progressing order or a
// transient serverless kickoff-retry window has elapsed before we alert. All are
// env-overridable; none are activated by this change.
const DEFAULT_COOLDOWN_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export interface DetectorConfig {
  cooldownMs: number;
  thresholds: IncidentThresholds;
  excludeOrderIds: ReadonlySet<string>;
}

function parseDurationMs(raw: string | undefined, fallbackMs: number, unitMs: number): number {
  if (!raw) return fallbackMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallbackMs;
  return n * unitMs;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DetectorConfig {
  const excludeRaw = env.HSB_STRANDED_EXCLUDE_ORDER_IDS ?? '';
  const excludeOrderIds = new Set(
    excludeRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return {
    cooldownMs: parseDurationMs(env.HSB_STRANDED_ALERT_COOLDOWN_HOURS, DEFAULT_COOLDOWN_HOURS * HOUR_MS, HOUR_MS),
    thresholds: {
      // `HSB_STRANDED_THRESHOLD_HOURS` kept its original meaning: how long an
      // explicit `auto` order may sit unstarted.
      autoNotStartedMs: parseDurationMs(
        env.HSB_STRANDED_THRESHOLD_HOURS,
        DEFAULT_INCIDENT_THRESHOLDS.autoNotStartedMs,
        HOUR_MS,
      ),
      manualHoldMs: parseDurationMs(
        env.HSB_INCIDENT_MANUAL_HOLD_SLA_HOURS,
        DEFAULT_INCIDENT_THRESHOLDS.manualHoldMs,
        HOUR_MS,
      ),
      staleInProgressMs: parseDurationMs(
        env.HSB_INCIDENT_STALE_IN_PROGRESS_MINUTES,
        DEFAULT_INCIDENT_THRESHOLDS.staleInProgressMs,
        MINUTE_MS,
      ),
      leaseTtlMs: parseDurationMs(
        env.HSB_INCIDENT_LEASE_TTL_MINUTES,
        DEFAULT_INCIDENT_THRESHOLDS.leaseTtlMs,
        MINUTE_MS,
      ),
      customerWaitMs: parseDurationMs(
        env.HSB_INCIDENT_CUSTOMER_WAIT_HOURS,
        DEFAULT_INCIDENT_THRESHOLDS.customerWaitMs,
        HOUR_MS,
      ),
    },
    excludeOrderIds,
  };
}

function getBlobToken(): string | undefined {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

/**
 * Read the scan's own cooldown record. Fails CLOSED: with no blob token in a
 * production-like env we throw so `runIncidentScan` aborts before alerting
 * against an unknown cooldown state. A genuinely-absent record (cold start) is
 * NOT a failure — it returns empty state.
 */
async function readAlertState(): Promise<AlertState> {
  const token = getBlobToken();
  if (!token) {
    throw new Error('BLOB_READ_WRITE_TOKEN missing — refusing to scan without cooldown storage');
  }
  const key = withBlobNamespace(ALERT_STATE_KEY);
  // Mirror the codebase read pattern: list to locate the blob, then fetch its
  // url. A genuinely-absent record (cold start) → empty state.
  const { blobs } = await list({ prefix: key, token });
  const blob = blobs.find((b) => b.pathname === key);
  if (!blob?.url) return {};
  const res = await fetch(`${blob.url}?t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`alert-state read failed: ${res.status}`);
  const parsed = (await res.json()) as unknown;
  return isAlertState(parsed) ? parsed : {};
}

async function writeAlertState(state: AlertState): Promise<void> {
  const token = getBlobToken();
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN missing — cannot persist cooldown state');
  await put(withBlobNamespace(ALERT_STATE_KEY), JSON.stringify(state), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    token,
  });
}

function isAlertState(v: unknown): v is AlertState {
  if (typeof v !== 'object' || v === null) return false;
  return Object.values(v as Record<string, unknown>).every(
    (e) => typeof e === 'object' && e !== null && typeof (e as { lastAlertedAt?: unknown }).lastAlertedAt === 'string',
  );
}

/**
 * The redacted operator incident sink: local structured LOGGING only.
 *
 * Emits a single greppable line an ops log drain can pick up. There is no
 * external send here by design — the previous `sendOperatorFailureAlert` in the
 * fulfillment module embeds customer email and child name, asserts the wrong
 * state, and carries no incident idempotency key, so it is deliberately NOT
 * reused. Recipient and cadence remain activation-time operator configuration.
 *
 * The payload is already vetted by the shared classifier; this function adds
 * nothing to it.
 */
function defaultIncidentSink(payload: OperatorIncidentAlert): Promise<void> {
  // eslint-disable-next-line no-console
  console.error(`[incident-scan][ALERT] ${JSON.stringify(payload)}`);
  return Promise.resolve();
}

export function buildDefaultDeps(config: DetectorConfig = loadConfigFromEnv()): ScanDeps {
  return {
    listOrdersAuthoritative: () => listOrdersAuthoritative(),
    readAlertState,
    writeAlertState,
    alert: defaultIncidentSink,
    log: (line: string) => console.log(line),
    now: () => Date.now(),
    cooldownMs: config.cooldownMs,
    thresholds: config.thresholds,
    excludeOrderIds: config.excludeOrderIds,
  };
}
