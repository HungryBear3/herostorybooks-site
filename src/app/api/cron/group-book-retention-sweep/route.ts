/**
 * Scheduled group-book source-photo retention dispatch (vercel.json, exactly
 * one schedule: `41 5 * * *`, 05:41 UTC daily).
 *
 * Authenticated before any storage access. A create-only per-UTC-day slot is
 * reserved BEFORE provider cleanup, so overlapping/duplicate invocations do no
 * cleanup. Every cohort at/past its server-recorded due time gets every
 * eligible family rechecked each day (late commits removed by the next day);
 * unknown/malformed keys are held with attention, never deleted by guess. The
 * response and heartbeat carry sanitized codes/counts/timestamps only.
 */
import { evaluateCronAuth } from '../../../../lib/cron-auth.ts';
import { runGroupBookRetentionDispatch } from '../../../../lib/group-book/retention.ts';
import { groupBookStorageReady } from '../../../../lib/group-book/store.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const denied = evaluateCronAuth(request.headers.get('authorization'), process.env.CRON_SECRET);
  if (denied !== null) return Response.json({ ok: false }, { status: denied });
  if (!groupBookStorageReady()) {
    // No group-book store configured: nothing can be stored or swept here.
    return Response.json({ ok: true, skipped: 'storage_disabled' }, { status: 200 });
  }
  const summary = await runGroupBookRetentionDispatch(Date.now());
  if (!summary.ok) console.error('[cron/group-book-retention-sweep] attention:', summary.status, summary.attention.join(','));
  return Response.json(summary, { status: summary.ok ? 200 : 503 });
}
