import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { getLaunchHoldSnapshot } from '@/lib/launch-hold';

export const dynamic = 'force-dynamic';

/**
 * Read-only launch-HOLD snapshot for internal ops/scripts. Admin-auth gated.
 * There is intentionally no POST/PUT/DELETE handler: this surface reports HOLD
 * status and clears/triggers nothing.
 */
export async function GET(request: Request) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(getLaunchHoldSnapshot());
}
