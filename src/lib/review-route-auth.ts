import { getOrder } from './orders.ts';
import { hasReviewWriteAccess } from './page-review.ts';
import { getReviewTokenFromRequest } from './review-capability.ts';

export interface ReviewWriteAuth {
  ok: boolean;
  /** Present when ok === false. */
  status?: 403 | 404;
  error?: string;
  /**
   * The capability token this request presented, when it validated. Routes pass
   * it into the service so the SERVICE can revalidate it against the order as
   * read inside its guarded transaction. This route check is an early-refusal
   * optimization, not the authoritative gate: a token can be rotated between
   * this check and the commit.
   */
  reviewToken?: string | null;
}

/**
 * Single server-side authorizer for EVERY customer write on the tokenized
 * review surface (accept page, regenerate page, acknowledge proof, request
 * wording change, approve whole book).
 *
 * Reads the token from the request URL (`?token=`), never logs it, and requires
 * a prepared `proofApprovalToken` that matches via the constant-time
 * `hasReviewWriteAccess`. A bare order id, a missing token, or an invalid token
 * is rejected (403) before any mutation runs. A missing order is 404.
 *
 * Internal/operator callers invoke the page-review service functions directly
 * with an explicit internal actor and are intentionally not subject to this
 * customer-surface gate.
 */
export async function authorizeCustomerReviewWrite(
  request: Request,
  orderId: string,
): Promise<ReviewWriteAuth> {
  const token = getReviewTokenFromRequest(request, orderId);
  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'order_not_found' };
  if (!hasReviewWriteAccess(order, { reviewToken: token })) {
    return { ok: false, status: 403, error: 'invalid_or_missing_token' };
  }
  return { ok: true, reviewToken: token };
}
