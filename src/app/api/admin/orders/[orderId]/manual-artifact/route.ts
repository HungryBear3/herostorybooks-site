import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import {
  registerManualArtifact,
  type RegisterArtifactInput,
} from '@/lib/manual-artifact-factory';

export const dynamic = 'force-dynamic';

// Register an uploaded artifact into the manual factory manifest by BLOB REF.
// This route registers references only — it is NOT a large-binary transport
// path. The file must already be in Vercel Blob; the body carries its URL.
export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orderId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Partial<RegisterArtifactInput>;

  if (!body.slot || !body.url || !body.source || !body.producedBy) {
    return NextResponse.json(
      { error: 'slot, url, source, and producedBy are required', code: 'missing_fields' },
      { status: 400 },
    );
  }

  const result = await registerManualArtifact(orderId, {
    slot: body.slot,
    pageNumber: body.pageNumber,
    url: body.url,
    source: body.source,
    producedBy: body.producedBy,
    checksum: body.checksum,
  });

  if (result.ok === true) {
    return NextResponse.json({ ok: true, fulfillmentStatus: result.fulfillmentStatus });
  }
  return NextResponse.json(
    { error: result.error, code: result.code, ...(result.reasons ? { reasons: result.reasons } : {}) },
    { status: result.status },
  );
}
