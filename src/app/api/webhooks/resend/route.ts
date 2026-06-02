import crypto from 'node:crypto';
import { NextResponse } from 'next/server';

import { appendResendEvent, normalizeResendWebhook } from '@/lib/resend-events';

export const dynamic = 'force-dynamic';

/**
 * Resend webhook ingestion.
 *
 * Resend delivers events via Svix; signature is in the `svix-signature`
 * header in the format `v1,<base64-hmac-sha256>`. Body to sign is
 * `<svix-id>.<svix-timestamp>.<raw-body>`. See
 * https://docs.svix.com/receiving/verifying-payloads/how-manual.
 *
 * Security posture:
 *   - If `RESEND_WEBHOOK_SECRET` is NOT set, the route returns 503
 *     (configuration-required). We do not accept unsigned events.
 *   - If the signature does not verify, 401.
 *   - Unknown event types are logged + 200-ack (so Svix does not retry
 *     forever); they are NOT persisted.
 *
 * Side effects: writes one append-only line to the day-partitioned
 * Resend event log. Does NOT call any outbound service. Does NOT touch
 * orders, Stripe, Lulu, RPI, customer email transport, or print
 * provider — this route only RECEIVES.
 */

function decodeBase64Secret(secret: string): Buffer {
  // Svix secrets are prefixed `whsec_`. Strip and base64-decode; if the
  // prefix is absent treat the input as already-raw-base64 (allows
  // tests to inject a plain secret).
  const trimmed = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  try {
    return Buffer.from(trimmed, 'base64');
  } catch {
    return Buffer.from('');
  }
}

function verifySvixSignature(
  svixId: string,
  svixTimestamp: string,
  body: string,
  signatureHeader: string,
  secret: string,
): boolean {
  const key = decodeBase64Secret(secret);
  if (key.length === 0) return false;
  const signedPayload = `${svixId}.${svixTimestamp}.${body}`;
  const expected = crypto.createHmac('sha256', key).update(signedPayload).digest('base64');
  // The header may carry multiple space-delimited `v1,<sig>` pairs
  // (current + rotation). Accept if any one matches.
  const candidates = signatureHeader
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1,'))
    .map((s) => s.slice('v1,'.length));
  for (const candidate of candidates) {
    try {
      const a = Buffer.from(candidate);
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[resend-webhook] RESEND_WEBHOOK_SECRET not set; refusing inbound webhook');
    return NextResponse.json(
      { error: 'Resend webhook secret not configured' },
      { status: 503 },
    );
  }

  const body = await request.text();
  const svixId = request.headers.get('svix-id') ?? '';
  const svixTimestamp = request.headers.get('svix-timestamp') ?? '';
  const svixSignature = request.headers.get('svix-signature') ?? '';
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: 'Missing Svix headers' }, { status: 401 });
  }
  if (!verifySvixSignature(svixId, svixTimestamp, body, svixSignature, secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const event = normalizeResendWebhook(parsed, svixId);
  if (!event) {
    // Unknown event type or malformed shape. Ack to stop Svix retries
    // but log so ops can spot a Resend schema change.
    console.warn('[resend-webhook] dropping unknown/malformed event', {
      svixId,
      rawType: (parsed as { type?: unknown })?.type ?? null,
    });
    return NextResponse.json({ received: true, persisted: false, dropped: 'unknown_type' });
  }

  const result = await appendResendEvent(event);
  return NextResponse.json({ received: true, persisted: result.persisted });
}
