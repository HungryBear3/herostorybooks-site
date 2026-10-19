import { finalReleaseResponse } from '@/lib/group-book/admin-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Operator-recorded FIRST final release (printing or distribution) of a
 * cohort's book: the adopted withdrawal cutoff. Existing admin auth; actor
 * bound to the shared admin session; create-only, first wins; server clock.
 * Records an out-of-band fact; no print, distribution or export happens here.
 */
export async function POST(req: Request) {
  return finalReleaseResponse(req, Date.now());
}
