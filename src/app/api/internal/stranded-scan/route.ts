/**
 * Scheduled, authenticated, read-only stranded-paid-order scan endpoint.
 *
 * Alert-only: it invokes the detector, which emits a redacted internal alert
 * (default: logging path) and updates only its own cooldown record. It never
 * advances fulfillment, mutates orders/Stripe, or emails customers.
 *
 * Security:
 *   - Requires `Authorization: Bearer <CRON_SECRET>` (the header Vercel Cron
 *     sends automatically when CRON_SECRET is set). Fails CLOSED: 503 if
 *     CRON_SECRET is unset, 401 on mismatch. Constant-time compare.
 *   - The HTTP response contains ONLY aggregate counts — never order ids,
 *     emails, or any order data. Per-order identifiers go to the internal
 *     alert/log path, not to any HTTP caller.
 */

import { NextResponse } from 'next/server';

import { evaluateCronAuth } from '@/lib/cron-auth';
import { runStrandedScan } from '@/lib/stranded-order-detector';
import { buildDefaultDeps } from '@/lib/stranded-order-detector-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<NextResponse> {
  const denied = evaluateCronAuth(request.headers.get('authorization'), process.env.CRON_SECRET);
  if (denied !== null) {
    // Generic body — no data, no hint about which check failed beyond status.
    return NextResponse.json({ ok: false }, { status: denied });
  }

  const result = await runStrandedScan(buildDefaultDeps());

  // Aggregate counts ONLY — never order identifiers or PII in the HTTP response.
  const body = {
    ok: result.ok,
    scanned: result.scanned,
    candidates: result.candidates,
    alertsSent: result.alertsSent,
    alertsSuppressed: result.alertsSuppressed,
    skipped: result.skipped,
  };
  return NextResponse.json(body, { status: result.failed ? 500 : 200 });
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request);
}

// POST accepted too (some schedulers POST); same auth + behavior.
export async function POST(request: Request): Promise<NextResponse> {
  return handle(request);
}
