/**
 * Scheduled purge of frozen confirmation envelopes (L-4 Slice A3-7) — INERT.
 *
 * Retention is unconfigured by construction, so every authorised call reports
 * `{ ok: true, skipped: 'retention_unconfigured' }`, with or without
 * `?dryRun=true`, and enumerates, reads and writes nothing.
 *
 * Auth runs first and fails closed through the shared cron helper: no secret
 * => 503, wrong secret => 401, each with an empty body.
 *
 * There is deliberately no `vercel.json` schedule for this path. Scheduling it
 * is part of activation, which needs A3-6, OD-2, OD-3, the store amendments and
 * a separate owner approval (see the retention module).
 */
import { evaluateCronAuth } from '../../../../lib/cron-auth.ts';
import { runConfirmationEnvelopePurge } from '../../../../lib/confirmation-envelope-retention.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  const denied = evaluateCronAuth(request.headers.get('authorization'), process.env.CRON_SECRET);
  if (denied !== null) return new Response(null, { status: denied });
  const dryRun = new URL(request.url).searchParams.get('dryRun') === 'true';
  return Response.json(runConfirmationEnvelopePurge({ dryRun }), { status: 200 });
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
