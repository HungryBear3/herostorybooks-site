import { evaluateCronAuth } from '../../../../lib/cron-auth.ts';
import { getRouteDeps } from '../../../../lib/fulfillment-sweep-route-deps.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function handle(request: Request): Promise<Response> {
  const denied = evaluateCronAuth(request.headers.get('authorization'), process.env.CRON_SECRET);
  if (denied !== null) {
    return Response.json({ ok: false }, { status: denied });
  }

  const result = await getRouteDeps().runSweep();
  return Response.json(
    {
      ok: result.ok,
      scanned: result.scanned,
      eligible: result.eligible,
      started: result.started,
      skipped: result.skipped,
      failed: result.failed,
    },
    { status: result.ok ? 200 : 500 },
  );
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
