/**
 * Default runtime wiring for the stranded-order detector.
 *
 * This is the ONLY place the detector touches durable storage, and it touches
 * exactly one thing: the detector's own cooldown record at
 * `withBlobNamespace('ops/stranded-alert-state.json')`. It NEVER reads or writes
 * an order record here (order reads go through the read-only `listOrders`), and
 * it imports nothing from fulfillment, order-email, Stripe, or any order-write
 * helper. The default alert sink is the structured logging path; wiring an
 * external channel (email/Discord/etc.) is a separate, approval-gated change.
 */

import { list, put } from '@vercel/blob';

import { listOrders, withBlobNamespace } from './orders.ts';
import type { AlertState, ScanDeps, StrandedAlert } from './stranded-order-detector.ts';

const ALERT_STATE_KEY = 'ops/stranded-alert-state.json';

// Conservative defaults. Intentionally long so a normally-progressing order or a
// transient serverless kickoff-retry window has elapsed before we alert. All are
// env-overridable; none are activated by this change.
const DEFAULT_THRESHOLD_HOURS = 12;
const DEFAULT_COOLDOWN_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

export interface DetectorConfig {
  thresholdMs: number;
  cooldownMs: number;
  excludeOrderIds: ReadonlySet<string>;
}

function parsePositiveHours(raw: string | undefined, fallbackHours: number): number {
  if (!raw) return fallbackHours * HOUR_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallbackHours * HOUR_MS;
  return n * HOUR_MS;
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
    thresholdMs: parsePositiveHours(env.HSB_STRANDED_THRESHOLD_HOURS, DEFAULT_THRESHOLD_HOURS),
    cooldownMs: parsePositiveHours(env.HSB_STRANDED_ALERT_COOLDOWN_HOURS, DEFAULT_COOLDOWN_HOURS),
    excludeOrderIds,
  };
}

function getBlobToken(): string | undefined {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

/**
 * Read the detector's own cooldown record. Fails CLOSED: with no blob token in a
 * production-like env we throw so `runStrandedScan` aborts before alerting
 * against an unknown cooldown state. A genuinely-absent record (cold start) is
 * NOT a failure — it returns empty state.
 */
async function readAlertState(): Promise<AlertState> {
  const token = getBlobToken();
  if (!token) {
    throw new Error('BLOB_READ_WRITE_TOKEN missing — refusing to scan without cooldown storage');
  }
  const key = withBlobNamespace(ALERT_STATE_KEY);
  // Mirror the codebase read pattern (orders.ts): list to locate the blob,
  // then fetch its url. A genuinely-absent record (cold start) → empty state.
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
 * Default internal alert sink: the structured LOGGING path. Emits a single
 * redacted, greppable line an ops log drain can pick up. No external send.
 */
function defaultAlertSink(payload: StrandedAlert): Promise<void> {
  // eslint-disable-next-line no-console
  console.error(`[stranded-scan][ALERT] ${JSON.stringify(payload)}`);
  return Promise.resolve();
}

export function buildDefaultDeps(config: DetectorConfig = loadConfigFromEnv()): ScanDeps {
  return {
    listOrders,
    readAlertState,
    writeAlertState,
    alert: defaultAlertSink,
    log: (line: string) => console.log(line),
    now: () => Date.now(),
    thresholdMs: config.thresholdMs,
    cooldownMs: config.cooldownMs,
    excludeOrderIds: config.excludeOrderIds,
  };
}
