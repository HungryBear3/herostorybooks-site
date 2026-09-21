/**
 * Scheduled recovery of paid-order confirmation emails.
 *
 * The confirmation send after checkout runs on `setImmediate`/`after()`, which
 * do not survive the serverless invocation. Without this schedule a paid order
 * whose deferred send never ran is never retried — which is exactly how a real
 * order ended up paid with no confirmation and no resend claim.
 *
 * Auth is the shared fail-closed cron helper: no secret => 503, wrong secret
 * => 401, and neither reads or mutates any order state.
 */
import { evaluateCronAuth } from '../../../../lib/cron-auth.ts';
import {
  buildDefaultConfirmationEmailSweepDeps,
  runConfirmationEmailSweep,
  type ConfirmationEmailSweepResult,
} from '../../../../lib/confirmation-email-sweep.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type RouteDeps = {
  runSweep: () => Promise<ConfirmationEmailSweepResult>;
};

let routeDepsOverride: RouteDeps | null = null;

export function __setConfirmationEmailSweepRouteDepsForTests(deps: Partial<RouteDeps>): void {
  routeDepsOverride = {
    runSweep: deps.runSweep ?? (() => runConfirmationEmailSweep(buildDefaultConfirmationEmailSweepDeps())),
  };
}

export function __resetConfirmationEmailSweepRouteDepsForTests(): void {
  routeDepsOverride = null;
}

function getRouteDeps(): RouteDeps {
  if (routeDepsOverride) return routeDepsOverride;
  return {
    runSweep: () => runConfirmationEmailSweep(buildDefaultConfirmationEmailSweepDeps()),
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
      sent: result.sent,
      skipped: result.skipped,
      blocked: result.blocked,
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
