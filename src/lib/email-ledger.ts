import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type EmailLedgerType = 'proof' | 'digital_delivery' | 'support' | 'nudge' | 'receipt';
export type EmailLedgerStatus = 'sent' | 'delivered' | 'bounced' | 'failed' | 'skipped';

export interface EmailLedgerInput {
  orderId: string;
  emailType: EmailLedgerType;
  recipient: string;
  resendMessageId?: string | null;
  status: EmailLedgerStatus;
  occurredAt?: string | null;
  providerPayload?: unknown;
  error?: string | null;
}

export interface EmailLedgerEvent {
  orderId: string;
  emailType: EmailLedgerType;
  recipient: string;
  resendMessageId: string | null;
  status: EmailLedgerStatus;
  occurredAt: string;
  providerPayloadHash: string | null;
  error: string | null;
}

export interface EmailLedgerSummary {
  orderId: string;
  lastProofStatus: EmailLedgerStatus | null;
  hasProofSent: boolean;
  hasDigitalDeliverySent: boolean;
  hasFailure: boolean;
  eventCount: number;
}

function ledgerRoot(): string {
  return process.env.HSB_EMAIL_LEDGER_DIR || path.join(process.cwd(), '.hsb-email-ledger');
}

function eventPath(orderId: string): string {
  const safe = orderId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(ledgerRoot(), `${safe}.jsonl`);
}

function bound(value: unknown, max = 240): string | null {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value);
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function payloadHash(payload: unknown): string | null {
  if (payload == null) return null;
  const serialized = JSON.stringify(stablePayload(payload));
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

function stablePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stablePayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stablePayload(child)]),
  );
}

export async function appendEmailLedgerEvent(input: EmailLedgerInput): Promise<EmailLedgerEvent> {
  const event: EmailLedgerEvent = {
    orderId: input.orderId,
    emailType: input.emailType,
    recipient: input.recipient,
    resendMessageId: input.resendMessageId ?? null,
    status: input.status,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    providerPayloadHash: payloadHash(input.providerPayload),
    error: bound(input.error),
  };
  await mkdir(ledgerRoot(), { recursive: true });
  await writeFile(eventPath(input.orderId), `${JSON.stringify(event)}\n`, { flag: 'a' });
  return event;
}

export async function listEmailLedgerEvents(orderId: string): Promise<EmailLedgerEvent[]> {
  try {
    const content = await readFile(eventPath(orderId), 'utf8');
    return content.split('\n').filter(Boolean).map((line) => JSON.parse(line) as EmailLedgerEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function summarizeEmailLedgerForOrder(orderId: string): Promise<EmailLedgerSummary> {
  const events = await listEmailLedgerEvents(orderId);
  const proof = events.filter((event) => event.emailType === 'proof');
  return {
    orderId,
    lastProofStatus: proof.at(-1)?.status ?? null,
    hasProofSent: proof.some((event) => event.status === 'sent' || event.status === 'delivered'),
    hasDigitalDeliverySent: events.some((event) => event.emailType === 'digital_delivery' && (event.status === 'sent' || event.status === 'delivered')),
    hasFailure: events.some((event) => event.status === 'failed' || event.status === 'bounced'),
    eventCount: events.length,
  };
}
