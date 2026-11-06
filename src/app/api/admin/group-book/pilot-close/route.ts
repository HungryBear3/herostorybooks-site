import { pilotCloseResponse } from '@/lib/group-book/admin-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Authenticated, create-only pilot close; the handler receives only server time. */
export async function POST(req: Request) {
  return pilotCloseResponse(req, Date.now());
}
