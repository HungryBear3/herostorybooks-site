import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import type { ProofTextColor } from '@/lib/fulfillment-types';
import { INTERNAL_REVIEW_ACTOR, setProofLayoutOverride } from '@/lib/page-review';
import { isCompleteProofCardGeometry, isProofTextColor } from '@/lib/proof-layout-override';

export const dynamic = 'force-dynamic';

/** Bounded, non-PII operator label for the audit trail. */
function opsActor(request: Request): string {
  const raw = request.headers.get('x-hsb-ops-actor') ?? '';
  const bounded = raw.trim().replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64);
  return bounded || 'internal_ops';
}

/**
 * Admin-only adapter over the current CAS-safe proof-layout service. This route
 * authenticates and validates transport shape; the service remains authoritative
 * for payment/refund, lifecycle, revision/fingerprint, overflow, contrast, proof
 * invalidation and audit gates. It triggers no build, email, provider, print or
 * fulfillment work.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const values = body as Record<string, unknown>;
  if (!Number.isInteger(values.pageIndex) || (values.pageIndex as number) < 0) {
    return NextResponse.json({ error: 'pageIndex (non-negative integer) is required' }, { status: 400 });
  }
  if (
    typeof values.authoredAgainstProofVersion !== 'string'
    || typeof values.authoredAgainstFingerprint !== 'string'
  ) {
    return NextResponse.json(
      { error: 'authoredAgainstProofVersion and authoredAgainstFingerprint are required' },
      { status: 400 },
    );
  }

  const isReset = values.geometry === null;
  if (!isReset && !isCompleteProofCardGeometry(values.geometry)) {
    return NextResponse.json({ error: 'invalid_geometry' }, { status: 422 });
  }
  const textColor = values.textColor;
  if (textColor != null && !isProofTextColor(textColor)) {
    return NextResponse.json({ error: 'invalid_text_color' }, { status: 422 });
  }

  const { orderId } = await context.params;
  const result = await setProofLayoutOverride({
    orderId,
    pageIndex: values.pageIndex as number,
    geometry: isReset ? null : values.geometry,
    textColor: textColor as ProofTextColor | null | undefined,
    authoredAgainstProofVersion: values.authoredAgainstProofVersion,
    authoredAgainstFingerprint: values.authoredAgainstFingerprint,
    appliedBy: opsActor(request),
    actor: INTERNAL_REVIEW_ACTOR,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.detail ? { detail: result.detail } : {}) },
      { status: result.status },
    );
  }

  return NextResponse.json({
    ok: true,
    pageIndex: result.pageIndex,
    proofCardOverride: result.proofCardOverride,
    noop: result.noop ?? false,
    snapshot: result.snapshot,
  });
}
