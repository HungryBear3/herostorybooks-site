/**
 * `POST /api/checkout/diagnostics` — sanitized checkout-failure events.
 *
 * A shell. All behaviour — the same-origin guard, the body cap, the closed
 * schema, the budget, and the single fixed-label log record — lives in
 * `checkout-diagnostics-route.ts` so the production request path can be
 * exercised in tests without a network.
 *
 * Relative `.ts` imports, not the `@/…` alias: the alias is unresolvable under
 * the node test runner, which is what left the other route shells unproven.
 */
import {
  handleCheckoutDiagnosticsRequest,
} from '../../../../lib/checkout-diagnostics-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleCheckoutDiagnosticsRequest(request, { env: process.env });
}
