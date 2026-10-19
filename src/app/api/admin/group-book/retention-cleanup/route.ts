import { retentionCleanupResponse } from '@/lib/group-book/admin-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Idempotent source-photo retention cleanup for one cohort, at or after the
 * durable due time (recorded final delivery + 90 days). Server clock only.
 */
export async function POST(req: Request) {
  return retentionCleanupResponse(req, Date.now());
}
