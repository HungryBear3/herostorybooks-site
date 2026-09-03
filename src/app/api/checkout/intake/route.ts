/**
 * `POST /api/checkout/intake` — the browser's entry point to the checkout
 * direct-upload state machine.
 *
 * A shell. All behaviour lives in `checkout-intake-route.ts` so the production
 * request path can be exercised in tests without a network or a Blob store.
 */
import {
  handleIntakeRequest,
  type IntakeRouteDeps,
} from '../../../../lib/checkout-intake-route.ts';
import { createVercelIntakeStore } from '../../../../lib/checkout-intake.ts';
import { isDirectUploadServerEnabled } from '../../../../lib/checkout-direct-flags.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (!isDirectUploadServerEnabled(process.env)) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  let deps: IntakeRouteDeps;
  try {
    // Resolving the store can fail closed (503) when the dedicated intake
    // credential is missing or shares a value with the order store.
    deps = { store: createVercelIntakeStore(), env: process.env };
  } catch {
    return Response.json({ error: 'intake_store_unavailable' }, { status: 503 });
  }
  return handleIntakeRequest(request, deps);
}
