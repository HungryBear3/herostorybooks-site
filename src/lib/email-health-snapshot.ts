/**
 * Compose a live email-health snapshot from env presence + persisted events.
 * Server-only glue: env presence (never values) + the event store → the pure
 * computeEmailHealth verdict. No Resend calls, no email sends.
 */
import {
  computeEmailHealth,
  DEFAULT_STALE_AFTER_MS,
  readLuluWebhookSecretStatus,
  readResendApiKeyConfigured,
  readResendWebhookSecretStatus,
  type EmailHealthResult,
  type WebhookSecretStatus,
} from './email-health.ts';
import { readEmailEvents, summarizeEvents } from './email-events.ts';

export interface EmailHealthSnapshot extends EmailHealthResult {
  generatedAt: string;
  staleAfterMs: number;
  /** Shown in a SEPARATE lane — never folded into the Resend verdict. */
  luluWebhookSecret: WebhookSecretStatus;
}

export async function getEmailHealthSnapshot(now: number = Date.now()): Promise<EmailHealthSnapshot> {
  const webhookSecret = readResendWebhookSecretStatus();
  const apiKeyConfigured = readResendApiKeyConfigured();
  const staleAfterMs = DEFAULT_STALE_AFTER_MS;

  const read = await readEmailEvents();
  const { counts, lastEventAt } = summarizeEvents(read.events, now, staleAfterMs);

  const result = computeEmailHealth({
    webhookSecret,
    apiKeyConfigured,
    persistence: { ok: read.ok, error: read.error },
    lastEventAt,
    counts,
    now,
    staleAfterMs,
  });

  return {
    ...result,
    generatedAt: new Date(now).toISOString(),
    staleAfterMs,
    luluWebhookSecret: readLuluWebhookSecretStatus(),
  };
}
