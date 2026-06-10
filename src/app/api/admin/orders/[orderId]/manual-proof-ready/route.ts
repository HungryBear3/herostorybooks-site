import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { markManualProofReady } from '@/lib/manual-artifact-factory';

export const dynamic = 'force-dynamic';

// Advance a manual-factory order to proof_ready_for_customer ONLY if the
// manifest gate (isManifestProofReady) passes. Returns 422 with specific
// failure reasons otherwise. No customer email / proof token / release here.
export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orderId } = await context.params;
  const result = await markManualProofReady(orderId);

  if (result.ok === true) {
    return NextResponse.json({ ok: true, fulfillmentStatus: result.fulfillmentStatus });
  }
  return NextResponse.json(
    { error: result.error, code: result.code, ...(result.reasons ? { reasons: result.reasons } : {}) },
    { status: result.status },
  );
}
