/**
 * Resend webhook event ingestion + read API.
 *
 * Pure module: persists events Resend pushes to /api/webhooks/resend
 * and provides read helpers for the admin /admin/email-health monitor.
 * No outbound network. No live Resend API calls. The webhook route is
 * the only writer; the admin page is the only reader.
 *
 * Persistence shape: append-only JSON log files, one per UTC day, under
 *   <store>/resend-events/YYYY-MM-DD.jsonl
 * Same storage discipline as orders (FS in dev/test, blob in prod when
 * BLOB_READ_WRITE_TOKEN is set). Day-partitioned so retention can be
 * managed without a full re-read.
 *
 * Events older than RETENTION_DAYS are not deleted by this module; ops
 * can prune via a separate scheduled job. Read helpers cap their scan.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { put as blobPut, list as blobList } from '@vercel/blob';

import { requiresDurablePersistence } from './orders.ts';

/**
 * Thrown when a Resend webhook event cannot be persisted to durable
 * storage in a production-like environment. The webhook route MUST
 * surface this as HTTP 503 so Svix retries — silently 200-acking
 * while the event was written to ephemeral /tmp would tell Resend the
 * monitor is healthy when it actually loses events.
 */
export class ResendEventPersistenceError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ResendEventPersistenceError';
    this.cause = cause;
  }
}

/**
 * Allowlisted Resend event types. Anything outside this set is logged
 * and ignored at the webhook seam — we do not want a future Resend
 * event-type addition to silently grow our persisted schema.
 * Reference: https://resend.com/docs/dashboard/webhooks/event-types
 */
export const RESEND_EVENT_TYPES = [
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.bounced',
  'email.complained',
  'email.opened',
  'email.clicked',
] as const;
export type ResendEventType = (typeof RESEND_EVENT_TYPES)[number];

export function isResendEventType(value: unknown): value is ResendEventType {
  return typeof value === 'string' && (RESEND_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Normalized event record we persist. Only fields useful for the
 * operator monitor are captured; we do NOT persist customer email
 * bodies, message HTML, or click URLs.
 */
export interface ResendEvent {
  /** Resend's event id (idempotency key from `svix-id` header). */
  id: string;
  type: ResendEventType;
  /** ISO timestamp from Resend's `created_at`. */
  createdAt: string;
  /** Resend's email_id (one per send). */
  emailId: string | null;
  /** Recipient address. Stored verbatim — these are operator-visible. */
  to: string | null;
  subject: string | null;
  /** For bounces: 'hard' / 'soft' / etc. Optional; depends on type. */
  bounceType: string | null;
  bounceReason: string | null;
}

const RETENTION_DAYS_FOR_READ = 14;
const READ_HARD_CAP = 1000;

function getBlobToken(): string | undefined {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

function getStoreDir(): string {
  // Tests use HSB_ORDER_STORE_DIR for the same blob namespace; reuse
  // so tmpdir-per-test fixtures work without a second env var.
  return process.env.HSB_ORDER_STORE_DIR ?? path.join(process.cwd(), '.data');
}

function dayKey(iso: string): string {
  // Trim to YYYY-MM-DD without timezone math; events from Resend always
  // carry an ISO timestamp so a string slice is sufficient.
  return iso.slice(0, 10);
}

function fsPathForDay(day: string): string {
  return path.join(getStoreDir(), 'resend-events', `${day}.jsonl`);
}

function blobPathForDay(day: string): string {
  // No withBlobNamespace dependency here — keep this module
  // self-contained so it can be lifted later. The orders namespace
  // helper is not exposed publicly anyway.
  return `resend-events/${day}.jsonl`;
}

function ymdRange(now: Date, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Append one normalized event to the day's log. Idempotent on `id`:
 * if the event id already exists in the day's log, the write is a
 * no-op so Svix retries don't double-count bounces.
 */
export async function appendResendEvent(event: ResendEvent): Promise<{ persisted: boolean }> {
  const day = dayKey(event.createdAt);
  const existing = await readDay(day);
  if (existing.some((e) => e.id === event.id)) {
    return { persisted: false };
  }
  const next = [...existing, event];
  await writeDay(day, next);
  return { persisted: true };
}

async function readDay(day: string): Promise<ResendEvent[]> {
  const token = getBlobToken();
  if (token) {
    try {
      const listing = await blobList({ prefix: blobPathForDay(day), token });
      const match = listing.blobs.find((b) => b.pathname === blobPathForDay(day));
      if (!match) return [];
      const res = await fetch(match.url);
      if (!res.ok) return [];
      const raw = await res.text();
      return parseJsonl(raw);
    } catch (err) {
      // In production-like environments, a blob read error is a real
      // signal — don't silently fall through to ephemeral FS. The
      // admin monitor will surface the read failure as missing
      // events; the webhook write path enforces durability separately.
      if (requiresDurablePersistence()) {
        throw new ResendEventPersistenceError(
          `Blob read failed for ${blobPathForDay(day)}: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
      // Dev/test only: fall through to FS so local development works
      // without a blob token.
    }
  } else if (requiresDurablePersistence()) {
    throw new ResendEventPersistenceError(
      'BLOB_READ_WRITE_TOKEN missing in production — cannot read Resend event log durably. Refusing to silently read from ephemeral FS.',
    );
  }
  try {
    const raw = await readFile(fsPathForDay(day), 'utf8');
    return parseJsonl(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function parseJsonl(raw: string): ResendEvent[] {
  if (!raw) return [];
  const lines = raw.split('\n').filter(Boolean);
  const out: ResendEvent[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as ResendEvent;
      if (isResendEventType(obj.type) && typeof obj.id === 'string' && typeof obj.createdAt === 'string') {
        out.push(obj);
      }
    } catch {
      // Skip malformed lines silently — the writer is the only path
      // and it always produces well-formed JSON; a parse failure here
      // means filesystem corruption we cannot recover from per line.
    }
  }
  return out;
}

async function writeDay(day: string, events: ResendEvent[]): Promise<void> {
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const token = getBlobToken();
  if (token) {
    try {
      await blobPut(blobPathForDay(day), body, {
        access: 'public',
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/jsonl',
        token,
      });
      return;
    } catch (err) {
      throw new ResendEventPersistenceError(
        `Blob write failed for ${blobPathForDay(day)}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
  if (requiresDurablePersistence()) {
    throw new ResendEventPersistenceError(
      'BLOB_READ_WRITE_TOKEN missing in production — cannot write Resend event log durably. Refusing to silently fall back to ephemeral FS (would 200-ack events to Resend that we can never read back).',
    );
  }
  const file = fsPathForDay(day);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, 'utf8');
}

export interface ListResendEventsInput {
  /** Restrict to a specific event type. Defaults to all. */
  type?: ResendEventType;
  /** Hard cap; default 200, max READ_HARD_CAP. */
  limit?: number;
  /** Days back to scan (newest first). Default 7. */
  days?: number;
  /** Inject `now` for deterministic tests. */
  now?: Date;
}

/**
 * Read recent events, newest first. Bounded by `limit` (default 200)
 * and `days` (default 7). Tests can inject `now` for determinism.
 */
export async function listResendEvents(input: ListResendEventsInput = {}): Promise<ResendEvent[]> {
  const limit = Math.min(input.limit ?? 200, READ_HARD_CAP);
  const days = Math.min(input.days ?? 7, RETENTION_DAYS_FOR_READ);
  const now = input.now ?? new Date();
  const out: ResendEvent[] = [];
  for (const day of ymdRange(now, days)) {
    const dayEvents = await readDay(day);
    for (const ev of dayEvents) {
      if (input.type && ev.type !== input.type) continue;
      out.push(ev);
    }
    if (out.length >= limit) break;
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out.slice(0, limit);
}

export interface ResendBucketSummary {
  windowHours: number;
  generatedAt: string;
  totals: Record<ResendEventType, number>;
  /** Subset of bounces flagged for operator attention. */
  recentBounces: ResendEvent[];
  /** Subset of complaints (spam) for operator attention. */
  recentComplaints: ResendEvent[];
  /**
   * ISO timestamp of the newest event in the trailing retention scan,
   * regardless of type or the window filter. Null when the log is
   * empty. The admin monitor uses this to detect "secret configured
   * but webhook never delivered" (always-null) and "events flowed at
   * some point but stopped recently" (lastEventAt older than a
   * stale-warning threshold). An empty log must NEVER be silently
   * read as healthy.
   */
  lastEventAt: string | null;
}

/**
 * Roll up event counts in the trailing window for the admin dashboard.
 * Pulls up to `days` of partitioned logs, filters to events within
 * `windowHours` of `now`, and buckets by type.
 */
export async function summarizeResendBounces(
  input: { now?: Date; windowHours?: number; daysToScan?: number } = {},
): Promise<ResendBucketSummary> {
  const windowHours = Math.max(1, Math.min(input.windowHours ?? 24, 24 * RETENTION_DAYS_FOR_READ));
  const now = input.now ?? new Date();
  const daysToScan = Math.min(input.daysToScan ?? Math.ceil(windowHours / 24) + 1, RETENTION_DAYS_FOR_READ);
  const cutoff = new Date(now.getTime() - windowHours * 60 * 60 * 1000).toISOString();

  const totals = Object.fromEntries(RESEND_EVENT_TYPES.map((t) => [t, 0])) as Record<ResendEventType, number>;
  const recentBounces: ResendEvent[] = [];
  const recentComplaints: ResendEvent[] = [];
  let lastEventAt: string | null = null;

  for (const day of ymdRange(now, daysToScan)) {
    for (const ev of await readDay(day)) {
      // lastEventAt scans the FULL retention range, not the window
      // filter — operators need to know "we received SOMETHING N
      // hours ago" even when the trailing-24h totals are all zero.
      if (lastEventAt === null || ev.createdAt > lastEventAt) {
        lastEventAt = ev.createdAt;
      }
      if (ev.createdAt < cutoff) continue;
      totals[ev.type] = (totals[ev.type] ?? 0) + 1;
      if (ev.type === 'email.bounced') recentBounces.push(ev);
      if (ev.type === 'email.complained') recentComplaints.push(ev);
    }
  }

  recentBounces.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  recentComplaints.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return {
    windowHours,
    generatedAt: now.toISOString(),
    totals,
    recentBounces: recentBounces.slice(0, 25),
    recentComplaints: recentComplaints.slice(0, 25),
    lastEventAt,
  };
}

/**
 * Normalize a Resend webhook body into our `ResendEvent` shape.
 * Returns null when the payload is not an allowlisted event type or is
 * missing the minimum fields. Pure — no side effects.
 *
 * The webhook route calls this BEFORE appending so unknown event types
 * never reach the persistence layer.
 */
export function normalizeResendWebhook(raw: unknown, svixId: string): ResendEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (!isResendEventType(type)) return null;
  const createdAt = typeof obj.created_at === 'string' ? obj.created_at : new Date().toISOString();
  const data = (obj.data && typeof obj.data === 'object') ? (obj.data as Record<string, unknown>) : {};
  const emailId = typeof data.email_id === 'string' ? data.email_id : null;
  const to = Array.isArray(data.to) && typeof data.to[0] === 'string'
    ? (data.to[0] as string)
    : typeof data.to === 'string' ? data.to : null;
  const subject = typeof data.subject === 'string' ? data.subject : null;
  const bounceRaw = (data.bounce && typeof data.bounce === 'object') ? (data.bounce as Record<string, unknown>) : null;
  const bounceType = bounceRaw && typeof bounceRaw.type === 'string' ? bounceRaw.type : null;
  const bounceReason = bounceRaw && typeof bounceRaw.message === 'string' ? bounceRaw.message : null;
  return {
    id: svixId,
    type,
    createdAt,
    emailId,
    to,
    subject,
    bounceType,
    bounceReason,
  };
}
