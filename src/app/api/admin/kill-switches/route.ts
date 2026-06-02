import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import {
  getKillSwitchSnapshot,
  isKillSwitchId,
  updateKillSwitch,
} from '@/lib/ops-kill-switches';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(await getKillSwitchSnapshot());
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
    const message = error instanceof Error ? error.message : String(error);
    const status = /REQUIRED|UNKNOWN/.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
