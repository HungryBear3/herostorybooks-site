import { classroomOrderResponse } from '../../../../../lib/group-book/order-handler.ts';
import { classroomTrustedInputFromEnv } from '../../../../../lib/group-book/trusted-input.ts';

/**
 * Thin wrapper: existing admin auth, then the server runtime trusted-input
 * supplier (read only after auth). Unset, disabled or invalid configuration
 * answers 503; the request body, query and headers never supply order input.
 */
export async function POST(request: Request): Promise<Response> {
  return classroomOrderResponse(request, { trustedInput: classroomTrustedInputFromEnv });
}
