import { deliveryResponse } from '@/lib/group-book/admin-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Operator-recorded FINAL DELIVERY of a cohort's book: the only retention
 * anchor. Existing admin auth; create-only and immutable; server clock.
 * Records an out-of-band fact; it does not print, distribute or release.
 */
export async function POST(req: Request) {
  return deliveryResponse(req, Date.now());
}
