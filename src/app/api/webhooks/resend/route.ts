import { NextResponse } from 'next/server';

import { readResendWebhookSecretStatus } from '@/lib/email-health';
import { recordEmailEvent, toEmailEventRecord, verifyResendSignature } from '@/lib/email-events';

export const dynamic = 'force-dynamic';

/**
 * Resend webhook ingestion for email-health monitoring.
 *
 * - If RESEND_WEBHOOK_SECRET is unset/blank → 503 (clearly not configured;
 *   the monitor stays out of GREEN rather than silently accepting unsigned
 *   events).
 * - Verifies the signature (see verifyResendSignature note re: Svix) before
 *   recording anything.
 * - Persists a non-sensitive monitoring record (type/time/domain/message id).
 *   A persistence failure returns 500 so Resend retries — and the monitor
 *   surfaces the fault distinctly.
 *
 * No email is sent and no Resend API call is made from this route.
 */
export async function POST(request: Request) {
  const status = readResendWebhookSecretStatus();
  if (status !== 'configured') {
    return NextResponse.json({ error: 'Resend webhook not configured' }, { status: 503 });
  }
  const secret = process.env.RESEND_WEBHOOK_SECRET as string;

  const body = await request.text();
  const sig = request.headers.get('resend-signature') ?? request.headers.get('svix-signature');
  if (!verifyResendSignature(body, sig, secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const record = toEmailEventRecord(payload, Date.now());
  if (!record) {
    return NextResponse.json({ error: 'Unrecognized event shape' }, { status: 400 });
  }

  const saved = await recordEmailEvent(record);
  if (!saved.ok) {
    console.error('[resend-webhook] persistence failure');
    return NextResponse.json({ error: 'Persistence failure' }, { status: 500 });
  }

  return NextResponse.json({ received: true, type: record.type });
}
