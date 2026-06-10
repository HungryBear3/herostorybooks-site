import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { setManualQaReport, type SetQaReportInput } from '@/lib/manual-artifact-factory';

export const dynamic = 'force-dynamic';

// Record the internal QA report for a manual-factory order's manifest.
export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orderId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Partial<SetQaReportInput>;

  if (typeof body.passed !== 'boolean' || !body.reviewedBy || !body.checks) {
    return NextResponse.json(
      { error: 'passed (boolean), reviewedBy, and checks are required', code: 'missing_fields' },
      { status: 400 },
    );
  }

  const result = await setManualQaReport(orderId, {
    passed: body.passed,
    reviewedBy: body.reviewedBy,
    notes: body.notes,
    checks: body.checks,
  });

  if (result.ok === true) {
    return NextResponse.json({ ok: true, fulfillmentStatus: result.fulfillmentStatus });
  }
  return NextResponse.json(
    { error: result.error, code: result.code, ...(result.reasons ? { reasons: result.reasons } : {}) },
    { status: result.status },
  );
}
