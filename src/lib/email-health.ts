/**
 * Email-health (Resend bounce/deliverability) readiness model — pure.
 *
 * This module decides whether Resend email + bounce monitoring is launch-ready.
 * It is INERT: it reads env *presence* (never values), performs no I/O, makes
 * no Resend calls, and sends no email. Secret values are never accepted or
 * returned — only `configured | missing | blank` status strings.
 *
 * Verdict (from the Email Health Monitor design):
 *   GREEN  — secret configured · persistence healthy · a real, recent event
 *            observed in-window. "Configured ≠ verified": zero/stale events
 *            are never GREEN.
 *   YELLOW — configured + persistence healthy, but no recent verified event
 *            (none yet, or stale). Owner can proceed only with eyes open.
 *   RED    — hard config/pipeline fault: webhook secret missing/blank, Resend
 *            API key absent, or email-event persistence failing.
 *
 * Resend readiness NEVER depends on LULU_WEBHOOK_SECRET — that secret is for
 * the print provider and is deliberately not an input here.
 */

export type WebhookSecretStatus = 'configured' | 'missing' | 'blank';

/** 24h default window for "recent" verified events. */
export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function classifySecret(raw: string | undefined): WebhookSecretStatus {
  if (raw === undefined) return 'missing';
  if (raw.trim() === '') return 'blank';
  return 'configured';
}

/**
 * Resend webhook signing secret presence — value is NEVER returned, only its
 * status. Reads ONLY RESEND_WEBHOOK_SECRET.
 */
export function readResendWebhookSecretStatus(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): WebhookSecretStatus {
  return classifySecret(env.RESEND_WEBHOOK_SECRET);
}

/** Resend API key presence (HSB_RESEND_API_KEY or RESEND_API_KEY). Boolean only. */
export function readResendApiKeyConfigured(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): boolean {
  const raw = env.HSB_RESEND_API_KEY ?? env.RESEND_API_KEY;
  return typeof raw === 'string' && raw.trim() !== '';
}

/**
 * Lulu print-provider webhook secret status — exposed ONLY so the UI can show
 * it in a separate lane. It is intentionally NOT consumed by computeEmailHealth;
 * a blank LULU secret must never drag Resend readiness down (or up).
 */
export function readLuluWebhookSecretStatus(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): WebhookSecretStatus {
  return classifySecret(env.LULU_WEBHOOK_SECRET);
}

export type EmailHealthStatus = 'GREEN' | 'YELLOW' | 'RED';

export interface EmailEventCounts {
  delivered: number;
  bounced: number;
  complained: number;
}

export interface PersistenceState {
  ok: boolean;
  error?: string | null;
}

export interface EmailHealthInput {
  webhookSecret: WebhookSecretStatus;
  apiKeyConfigured: boolean;
  persistence: PersistenceState;
  /** ms epoch of the most recent observed event, or null if none. */
  lastEventAt: number | null;
  counts: EmailEventCounts;
  now: number;
  staleAfterMs: number;
}

export interface EmailHealthResult {
  status: EmailHealthStatus;
  /** Launch-ready ONLY when GREEN. */
  launchReady: boolean;
  webhookSecret: WebhookSecretStatus;
  verified: boolean;
  stale: boolean;
  lastEventAgeMs: number | null;
  persistenceOk: boolean;
  blockers: string[];
  warnings: string[];
  counts: EmailEventCounts;
}

/**
 * Compute email-health readiness. Pure over its input booleans/counts/timestamps.
 */
export function computeEmailHealth(input: EmailHealthInput): EmailHealthResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Hard config / pipeline faults → RED.
  if (input.webhookSecret === 'missing') {
    blockers.push('RESEND_WEBHOOK_SECRET is missing — Resend cannot post verified events');
  } else if (input.webhookSecret === 'blank') {
    blockers.push('RESEND_WEBHOOK_SECRET is blank — set a non-empty signing secret');
  }
  if (!input.apiKeyConfigured) {
    blockers.push('Resend API key is not configured (HSB_RESEND_API_KEY / RESEND_API_KEY)');
  }
  // Persistence failure is surfaced as its OWN distinct blocker.
  if (!input.persistence.ok) {
    const detail = input.persistence.error ? `: ${input.persistence.error}` : '';
    blockers.push(`email-event persistence is failing${detail}`);
  }

  const verified = input.lastEventAt !== null;
  const lastEventAgeMs = verified ? Math.max(0, input.now - (input.lastEventAt as number)) : null;
  const stale = verified && lastEventAgeMs !== null && lastEventAgeMs > input.staleAfterMs;

  // "Configured ≠ verified": no recent verified event keeps us out of GREEN.
  if (!verified) {
    warnings.push('no Resend events observed yet — configured but unverified');
  } else if (stale) {
    warnings.push('last Resend event is stale (older than the freshness window)');
  }

  const status: EmailHealthStatus =
    blockers.length > 0 ? 'RED' : !verified || stale ? 'YELLOW' : 'GREEN';

  return {
    status,
    launchReady: status === 'GREEN',
    webhookSecret: input.webhookSecret,
    verified,
    stale,
    lastEventAgeMs,
    persistenceOk: input.persistence.ok,
    blockers,
    warnings,
    counts: input.counts,
  };
}

export const EMAIL_HEALTH_RULE = {
  GREEN: 'secret configured · persistence healthy · a recent verified event in-window',
  YELLOW: 'configured + persistence healthy, but no recent verified event (none yet, or stale)',
  RED: 'webhook secret missing/blank, Resend API key absent, or event persistence failing',
} as const;
