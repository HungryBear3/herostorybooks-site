import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import {
  KillSwitchDurabilityError,
  getKillSwitchSnapshot,
  isKillSwitchId,
  updateKillSwitch,
} from '@/lib/ops-kill-switches';

export const dynamic = 'force-dynamic';

// Structured failure code surfaced to the admin UI when the kill-switch
// durable store cannot be read or written. The UI uses this to render a
// specific "console non-functional / unsafe" warning instead of a
// generic transient 500. Operators need to know whether a failure is
// "retry later" or "your kill switches won't actually halt anything."
const DURABILITY_FAILED = 'DURABILITY_FAILED';

function durabilityFailedResponse(error: KillSwitchDurabilityError) {
  return NextResponse.json(
    {
      error: error.message,
      code: DURABILITY_FAILED,
      // Plain-English operator guidance. Kept here (not in the lib) so
      // the lib can stay a pure module without UI copy.
      operatorGuidance:
        'Kill-switch state could not be read or written to durable storage. The console is NOT safe to use until this is resolved: toggling a switch from this page may not propagate to other function instances, and enforcement seams will fail-closed (refuse the action) on every request. Verify BLOB_READ_WRITE_TOKEN and Vercel Blob availability before relying on any kill switch.',
    },
    { status: 503 },
  );
}

export async function GET(request: Request) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json(await getKillSwitchSnapshot());
  } catch (error) {
    if (error instanceof KillSwitchDurabilityError) {
      return durabilityFailedResponse(error);
    }
    throw error;
  }
}

export async function POST(request: Request) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as {
    id?: unknown;
    active?: unknown;
    reason?: unknown;
    updatedBy?: unknown;
  };
  if (!isKillSwitchId(body.id)) {
    return NextResponse.json({ error: 'Unknown kill switch id' }, { status: 400 });
  }
  if (typeof body.active !== 'boolean') {
    return NextResponse.json({ error: 'active must be boolean' }, { status: 400 });
  }
  if (typeof body.updatedBy !== 'string' || !body.updatedBy.trim()) {
    return NextResponse.json({ error: 'updatedBy required' }, { status: 400 });
  }
  if (body.active && (typeof body.reason !== 'string' || !body.reason.trim())) {
    return NextResponse.json({ error: 'reason required when activating a switch' }, { status: 400 });
  }

  try {
    const updated = await updateKillSwitch({
      id: body.id,
      active: body.active,
      reason: typeof body.reason === 'string' ? body.reason : null,
      updatedBy: body.updatedBy,
    });
    return NextResponse.json({ ok: true, switch: updated, snapshot: await getKillSwitchSnapshot() });
  } catch (error) {
    if (error instanceof KillSwitchDurabilityError) {
      return durabilityFailedResponse(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = /REQUIRED|UNKNOWN/.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
