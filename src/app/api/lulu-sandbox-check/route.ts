import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';

/**
 * Retired: this endpoint previously changed process-global Lulu configuration
 * around an irreversible provider request. Sandbox jobs must be submitted from
 * an isolated, durable ops workflow—not from a shared web process.
 */
export async function POST(request: Request) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(
    {
      error: 'lulu_sandbox_submission_retired',
      safety: 'No provider request or print job was created.',
    },
    { status: 410 },
  );
}
