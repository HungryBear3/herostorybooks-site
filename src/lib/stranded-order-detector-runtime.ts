/**
 * Default runtime wiring for the operator incident scan.
 *
 * This is the ONLY place the scan touches durable storage, and it touches
 * exactly two things: the fail-closed authoritative order enumeration (read
 * only) and the scan's own bounded cooldown record in the separate private
 * Blob store at `withBlobNamespace('ops/stranded-alert-state.json')`. It never writes an
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

import { BlobNotFoundError, get, put } from '@vercel/blob';

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

function getPrivateBlobToken(): string {
  const privateToken = process.env.HSB_PRIVATE_READ_WRITE_TOKEN?.trim();
  const publicToken = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!privateToken) {
    throw new Error('HSB_PRIVATE_READ_WRITE_TOKEN missing — refusing to use public cooldown storage');
  }
  if (publicToken && privateToken === publicToken) {
    throw new Error('HSB_PRIVATE_READ_WRITE_TOKEN must differ from BLOB_READ_WRITE_TOKEN');
  }
  return privateToken;
}

/**
 * Read the scan's own cooldown record. Fails CLOSED: with no private Blob token in a
 * production-like env we throw so `runIncidentScan` aborts before alerting
 * against an unknown cooldown state. A genuinely-absent record (cold start) is
 * NOT a failure — it returns empty state.
 */
async function readAlertState(): Promise<AlertState> {
  const token = getPrivateBlobToken();
  const key = withBlobNamespace(ALERT_STATE_KEY);
  try {
    const result = await get(key, { access: 'private', token, useCache: false });
    if (!result?.stream) return {};
    return parseAlertState(JSON.parse(await new Response(result.stream).text()) as unknown);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (error instanceof BlobNotFoundError || status === 404) return {};
    throw error;
  }
}

async function writeAlertState(state: AlertState): Promise<void> {
  const token = getPrivateBlobToken();
  await put(withBlobNamespace(ALERT_STATE_KEY), JSON.stringify(state), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    token,
  });
}

export function parseAlertState(v: unknown): AlertState {
  if (!isAlertState(v)) throw new Error('alert-state invalid');
  return v;
}

function isAlertState(v: unknown): v is AlertState {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
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
