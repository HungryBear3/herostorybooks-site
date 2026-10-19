import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '../admin-auth.ts';
import {
  hasCallerLifecycleTime,
  recordGroupBookFinalDelivery,
  recordGroupBookFinalRelease,
  runGroupBookRetentionCleanup,
} from './retention.ts';
import { GROUP_BOOK_PRIVATE_HEADERS } from './session.ts';
import { groupBookStorageReady } from './store.ts';

// Shared bodies of the operator delivery and retention-cleanup routes. The
// routes pass the SERVER clock; a request carrying any lifecycle time is
// refused (422 caller_time_rejected), so no request field can move a time.

const COHORT_RE = /^[A-Za-z0-9_-]{3,64}$/;
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: GROUP_BOOK_PRIVATE_HEADERS });

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function deliveryResponse(req: Request, now: number) {
  if (!isAdminAuthedFromRequest(req)) return json({ error: 'Unauthorized' }, 401);
  if (!groupBookStorageReady()) return json({ ok: false, error: 'storage_disabled' }, 503);
  const input = await body(req);
  if (hasCallerLifecycleTime(input)) return json({ ok: false, error: 'caller_time_rejected' }, 422);
  const result = await recordGroupBookFinalDelivery({
    cohortId: input.cohortId,
    recordedBy: input.recordedBy,
    evidence: input.evidence,
    now,
  });
  if (result.outcome === 'invalid') return json({ ok: false, error: result.error }, 422);
  if (result.outcome === 'unconfirmed') return json({ ok: false, outcome: 'unconfirmed' }, 503);
  if (result.outcome === 'release_not_recorded') return json({ ok: false, outcome: 'final_release_not_recorded' }, 409);
  const delivery = { cohortId: result.record.cohortId, deliveredAt: result.record.deliveredAt, recordedAt: result.record.recordedAt, dueAt: result.record.dueAt };
  if (result.outcome === 'conflict') return json({ ok: false, outcome: 'conflict', delivery }, 409);
  return json({ ok: true, outcome: result.outcome, delivery }, 200);
}

export async function retentionCleanupResponse(req: Request, now: number) {
  if (!isAdminAuthedFromRequest(req)) return json({ error: 'Unauthorized' }, 401);
  if (!groupBookStorageReady()) return json({ ok: false, error: 'storage_disabled' }, 503);
  const { cohortId } = await body(req);
  if (typeof cohortId !== 'string' || !COHORT_RE.test(cohortId)) return json({ ok: false, error: 'invalid_cohort' }, 400);
  const result = await runGroupBookRetentionCleanup({ cohortId, now });
  const status = result.outcome === 'complete' ? 200
    : result.outcome === 'partial' || result.outcome === 'delivery_unknown' || result.outcome === 'scope_unknown' ? 503
      : 409;
  return json({ ok: result.outcome === 'complete', ...result }, status);
}

/**
 * First final release (printing OR distribution). The actor is bound
 * server-side to the shared admin session; the entered name is unverified
 * attribution. Records an out-of-band fact only: nothing is printed,
 * distributed or published here, and no upstream atomic release exists.
 */
export async function finalReleaseResponse(req: Request, now: number) {
  if (!isAdminAuthedFromRequest(req)) return json({ error: 'Unauthorized' }, 401);
  if (!groupBookStorageReady()) return json({ ok: false, error: 'storage_disabled' }, 503);
  const input = await body(req);
  if (hasCallerLifecycleTime(input)) return json({ ok: false, error: 'caller_time_rejected' }, 422);
  const result = await recordGroupBookFinalRelease({
    cohortId: input.cohortId,
    channel: input.channel,
    attribution: input.attribution,
    evidence: input.evidence,
    now,
  });
  if (result.outcome === 'invalid') return json({ ok: false, error: result.error }, 422);
  if (result.outcome === 'unconfirmed') return json({ ok: false, outcome: 'unconfirmed' }, 503);
  const release = {
    cohortId: result.record.cohortId,
    channel: result.record.channel,
    releasedAt: result.record.releasedAt,
    recordedAt: result.record.recordedAt,
    recordedVia: result.record.recordedVia,
    attributionUnverified: result.record.attributionUnverified,
  };
  if (result.outcome === 'conflict') return json({ ok: false, outcome: 'conflict', release }, 409);
  return json({ ok: true, outcome: result.outcome, release }, 200);
}
