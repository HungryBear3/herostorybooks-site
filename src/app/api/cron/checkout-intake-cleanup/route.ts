/**
 * Scheduled reclamation of checkout intake storage.
 *
 * Buyer media staged before payment is deleted once its intake expires, and
 * bytes that belong to no slot are reclaimed sooner. Media bound to a
 * finalized (paid) order is never in scope — see `checkout-intake-cleanup.ts`
 * for the claim that makes that safe against a concurrent finalization.
 *
 * `?dryRun=true` reports the plan without deleting anything.
 */
import { evaluateCronAuth } from '../../../../lib/cron-auth.ts';
import { IntakeError } from '../../../../lib/checkout-intake.ts';
import {
  buildDefaultCheckoutIntakeCleanupDeps,
  runCheckoutIntakeCleanup,
} from '../../../../lib/checkout-intake-cleanup.ts';
import { isDirectUploadServerEnabled } from '../../../../lib/checkout-direct-flags.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function handle(request: Request): Promise<Response> {
  const denied = evaluateCronAuth(request.headers.get('authorization'), process.env.CRON_SECRET);
  if (denied !== null) return Response.json({ ok: false }, { status: denied });
  if (!isDirectUploadServerEnabled(process.env)) {
    // Nothing stages intake media while the feature is off, so there is
    // nothing to sweep. Reporting that plainly beats a 404 on a cron target.
    return Response.json({ ok: true, skipped: 'direct_upload_disabled' }, { status: 200 });
  }
  const dryRun = new URL(request.url).searchParams.get('dryRun') === 'true';
  try {
    const result = await runCheckoutIntakeCleanup(buildDefaultCheckoutIntakeCleanupDeps(), { dryRun });
    return Response.json(result, { status: 200 });
  } catch (error) {
    console.error('[cron/checkout-intake-cleanup] run failed:', error);
    // A fail-closed configuration error (no dedicated store, no namespace on
    // Preview) is reported as such rather than flattened into a 500.
    const status = error instanceof IntakeError ? error.status : 500;
    return Response.json({ ok: false }, { status });
  }
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
