import { createShippingRouteHandler } from '../../../../lib/initial-shipping-checkout.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handle = createShippingRouteHandler();
export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
