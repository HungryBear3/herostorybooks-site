/**
 * Email-event ingestion + persistence for Resend bounce/deliverability health.
 *
 * Stores ONLY non-sensitive monitoring fields (event type, timestamp, opaque
 * message id, recipient *domain* — never the full address, never any secret).
 * Persistence is a small JSON store with an env-overridable path so tests use
 * fixtures and never touch real data. Read/write failures are reported
 * distinctly (ok:false + error) so the monitor can show a persistence fault as
 * its own state rather than masquerading as "no events".
 *
 * No real Resend calls and no email sends happen here.
 */
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { EmailEventCounts } from './email-health.ts';

export type ResendEventType =
  | 'email.delivered'
  | 'email.bounced'
  | 'email.complained'
  | 'email.sent'
  | 'email.delivery_delayed';

export const MONITORED_EVENT_TYPES: ResendEventType[] = [
  'email.delivered',
  'email.bounced',
  'email.complained',
];

export interface EmailEventRecord {
  /** Opaque event id (Resend/Svix id) — not a secret. */
  id: string;
  type: string;
  /** ms epoch when the event occurred/was received. */
  at: number;
  /** Recipient DOMAIN only (e.g. "gmail.com"); never the full address. */
  recipientDomain?: string | null;
  messageId?: string | null;
}

export interface EmailEventsRead {
  ok: boolean;
  events: EmailEventRecord[];
  /** Non-null only when ok === false (distinct persistence-fault signal). */
  error: string | null;
}

function storePath(): string {
  return process.env.HSB_EMAIL_EVENTS_PATH || path.join(process.cwd(), '.data', 'email-events.json');
}

/** Extract the domain from an address without retaining the local part (PII). */
export function recipientDomain(to: unknown): string | null {
  if (typeof to !== 'string') return null;
  const at = to.lastIndexOf('@');
  if (at < 0) return null;
  const domain = to.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

/**
 * Normalize a raw Resend webhook payload into a monitoring record. Keeps no
 * secret/PII beyond the recipient domain.
 */
export function toEmailEventRecord(payload: unknown, receivedAt: number): EmailEventRecord | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const type = typeof p.type === 'string' ? p.type : null;
  if (!type) return null;
  const data = (p.data ?? {}) as Record<string, unknown>;
  const createdAt = typeof p.created_at === 'string' ? Date.parse(p.created_at) : NaN;
  const to = Array.isArray(data.to) ? data.to[0] : data.to;
  return {
    id: typeof p.id === 'string' && p.id ? p.id : crypto.randomUUID(),
    type,
    at: Number.isFinite(createdAt) ? createdAt : receivedAt,
    recipientDomain: recipientDomain(to),
    messageId: typeof data.email_id === 'string' ? data.email_id : null,
  };
}

/**
 * Summarize events into in-window counts + the most-recent event time.
 * Counts only the monitored types within [now - windowMs, now].
 */
export function summarizeEvents(
  events: EmailEventRecord[],
  now: number,
  windowMs: number,
): { counts: EmailEventCounts; lastEventAt: number | null } {
  const counts: EmailEventCounts = { delivered: 0, bounced: 0, complained: 0 };
  let lastEventAt: number | null = null;
  const cutoff = now - windowMs;
  for (const e of events) {
    if (lastEventAt === null || e.at > lastEventAt) lastEventAt = e.at;
    if (e.at < cutoff || e.at > now) continue;
    if (e.type === 'email.delivered') counts.delivered += 1;
    else if (e.type === 'email.bounced') counts.bounced += 1;
    else if (e.type === 'email.complained') counts.complained += 1;
  }
  return { counts, lastEventAt };
}

/** Read persisted events. Missing store = ok with empty list. Any other I/O or
 * parse error = ok:false so the caller can render a distinct persistence fault. */
export async function readEmailEvents(): Promise<EmailEventsRead> {
  try {
    const raw = await readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as { events?: EmailEventRecord[] };
    return { ok: true, events: Array.isArray(parsed.events) ? parsed.events : [], error: null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, events: [], error: null };
    return { ok: false, events: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Append an event. Returns ok:false on persistence failure (never throws). */
export async function recordEmailEvent(record: EmailEventRecord): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const existing = await readEmailEvents();
    const next = [...existing.events, record].slice(-1000);
    const file = storePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ events: next }, null, 2)}\n`, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Verify a Resend webhook signature.
 *
 * NOTE: production Resend uses Svix-style signing (svix-id/svix-timestamp/
 * svix-signature, base64 HMAC). This implementation uses a straightforward
 * HMAC-SHA256 over the raw body keyed by RESEND_WEBHOOK_SECRET (header
 * `resend-signature`), matching the repo's existing Lulu pattern, so the
 * ingestion path is testable with fixtures. Reconciling with Svix's exact
 * scheme is a documented pre-live gate (see the runbook); until then the
 * monitor stays out of GREEN because no verified event stream exists.
 */
export function verifyResendSignature(rawBody: string, headerSig: string | null, secret: string): boolean {
  if (!headerSig || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(headerSig));
  } catch {
    return false;
  }
}

/** Test/helper: compute the signature a valid caller would send. */
export function signResendBody(rawBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}
