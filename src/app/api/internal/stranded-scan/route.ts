/**
 * Authenticated, read-only operator incident scan endpoint.
 *
 * Alert-only: it invokes the scan, which emits redacted internal alerts
 * (default: local logging path) and updates only its own cooldown record. It
 * never advances fulfillment, mutates orders/Stripe, or emails customers.
 *
 * NOT SCHEDULED. No cron entry points at this route; activating a schedule is a
 * separate, explicitly approved change that comes after a deterministic
 * zero-send run.
 *
 * Security:
 *   - Requires `Authorization: Bearer <CRON_SECRET>`. Fails CLOSED: 503 if
 *     CRON_SECRET is unset, 401 on mismatch. Constant-time compare.
 *   - The HTTP response contains ONLY aggregate counts — never order ids,
 *     incident classes, emails, or any order data. Per-order identifiers go to
 *     the internal alert/log path, not to any HTTP caller.
 *   - A run whose enumeration, alert sink, or cooldown persistence failed
 *     returns 500. A clean 200 means the scan really was clean; `degraded`
 *     flags a run that completed over untrustworthy evidence.
 */

import { NextResponse } from 'next/server';

import { evaluateCronAuth } from '@/lib/cron-auth';
import { runIncidentScan } from '@/lib/stranded-order-detector';
import { buildDefaultDeps } from '@/lib/stranded-order-detector-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<NextResponse> {
  const denied = evaluateCronAuth(request.headers.get('authorization'), process.env.CRON_SECRET);
  if (denied !== null) {
    // Generic body — no data, no hint about which check failed beyond status.
    return NextResponse.json({ ok: false }, { status: denied });
  }

  const result = await runIncidentScan(buildDefaultDeps());

  // Aggregate counts ONLY — never order identifiers, incident classes, or PII.
  const body = {
    ok: result.ok,
    degraded: result.degraded,
    scanned: result.scanned,
    incidents: result.incidents,
    alertsSent: result.alertsSent,
    alertsSuppressed: result.alertsSuppressed,
    alertFailures: result.alertFailures,
    dataQuality: result.dataQuality,
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
