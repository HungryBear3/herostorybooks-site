import { evaluateCronAuth } from '../../../../lib/cron-auth.ts';
import {
  buildDefaultFulfillmentSweepDeps,
  runFulfillmentSweep,
  type FulfillmentSweepResult,
} from '../../../../lib/fulfillment-sweep.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type RouteDeps = {
  runSweep: () => Promise<FulfillmentSweepResult>;
};

let routeDepsOverride: RouteDeps | null = null;

export function __setFulfillmentSweepRouteDepsForTests(deps: Partial<RouteDeps>): void {
  routeDepsOverride = {
    runSweep: deps.runSweep ?? (() => runFulfillmentSweep(buildDefaultFulfillmentSweepDeps())),
  };
}

export function __resetFulfillmentSweepRouteDepsForTests(): void {
  routeDepsOverride = null;
}

function getRouteDeps(): RouteDeps {
  if (routeDepsOverride) return routeDepsOverride;
  return {
    runSweep: () => runFulfillmentSweep(buildDefaultFulfillmentSweepDeps()),
  };
}

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
