/**
 * Framework-free handlers for the tokenized customer layout-editor routes.
 *
 * All route behavior lives here (token auth, body parsing, the fixed non-PII
 * `appliedBy`, forwarding ONLY layout/binding fields, and status mapping) so it
 * is unit-testable without pulling `next/server`. The route.ts files are thin
 * NextResponse wrappers around these.
 */
import { setProofLayoutOverride, requestLayoutHelp, customerReviewActor } from './page-review.ts';
import { authorizeCustomerReviewWrite } from './review-route-auth.ts';
import type { ProofTextColor } from './fulfillment-types.ts';

export interface RouteReply {
  status: number;
  body: Record<string, unknown>;
}

export async function handleProofLayoutOverrideRequest(request: Request, orderId: string): Promise<RouteReply> {
  const auth = await authorizeCustomerReviewWrite(request, orderId);
  if (!auth.ok) return { status: auth.status ?? 403, body: { ok: false, error: auth.error } };

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown> | null;
  const pageIndex = Number(body?.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    return { status: 400, body: { ok: false, error: 'invalid_page_index' } };
  }

  const rawGeometry = body?.geometry;
  const hasGeometry = rawGeometry != null && typeof rawGeometry === 'object';
  const g = rawGeometry as Record<string, unknown> | undefined;
  const geometry = hasGeometry
    ? {
        x: Number(g?.x), y: Number(g?.y), width: Number(g?.width),
        height: Number(g?.height), opacity: Number(g?.opacity), fontScale: Number(g?.fontScale),
      }
    : null; // null = reset

  const result = await setProofLayoutOverride({
    orderId,
    pageIndex,
    geometry,
    // Untrusted: forwarded as-is and validated (enum + contrast) in the service.
    textColor: (body?.textColor ?? null) as ProofTextColor | null,
    authoredAgainstProofVersion: typeof body?.authoredAgainstProofVersion === 'string' ? body.authoredAgainstProofVersion : null,
    authoredAgainstFingerprint: typeof body?.authoredAgainstFingerprint === 'string' ? body.authoredAgainstFingerprint : null,
    appliedBy: 'customer',
    actor: customerReviewActor(auth.reviewToken),
  });

  if (!result.ok) {
    return { status: result.status, body: { ok: false, error: result.error, ...(result.detail ? { detail: result.detail } : {}) } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      pageIndex: result.pageIndex,
      proofCardOverride: result.proofCardOverride ?? null,
      ...(result.noop ? { noop: true } : {}),
      snapshot: result.snapshot,
    },
  };
}

export async function handleRequestLayoutHelpRequest(request: Request, orderId: string): Promise<RouteReply> {
  const auth = await authorizeCustomerReviewWrite(request, orderId);
  if (!auth.ok) return { status: auth.status ?? 403, body: { ok: false, error: auth.error } };

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown> | null;
  const raw = Number(body?.pageIndex);
  const pageIndex = Number.isInteger(raw) && raw >= 0 ? raw : null;

  const result = await requestLayoutHelp({ orderId, pageIndex, actor: customerReviewActor(auth.reviewToken) });
  if (!result.ok) return { status: result.status, body: { ok: false, error: result.error } };
  return { status: 200, body: { ok: true, ...(result.noop ? { noop: true } : {}), snapshot: result.snapshot } };
}
