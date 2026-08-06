/**
 * Framework-free handlers for the tokenized customer layout-editor routes.
 *
 * All route behavior lives here (token auth, body parsing, the fixed non-PII
 * `appliedBy`, forwarding ONLY layout/binding fields, and status mapping) so it
 * is unit-testable without pulling `next/server`. The route.ts files are thin
 * NextResponse wrappers around these.
 */
import { setProofLayoutOverride, requestLayoutHelp, evaluateProofFit, customerReviewActor } from './page-review.ts';
import { authorizeCustomerReviewWrite } from './review-route-auth.ts';
import type { ProofTextColor } from './fulfillment-types.ts';
import { isCompleteProofCardGeometry } from './proof-layout-override.ts';

export interface RouteReply {
  status: number;
  body: Record<string, unknown>;
}

export async function handleProofLayoutOverrideRequest(request: Request, orderId: string): Promise<RouteReply> {
  const auth = await authorizeCustomerReviewWrite(request, orderId);
  if (!auth.ok) return { status: auth.status ?? 403, body: { ok: false, error: auth.error } };

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_body');
    body = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid_json_body' } };
  }
  const pageIndex = body.pageIndex;
  if (typeof pageIndex !== 'number' || !Number.isInteger(pageIndex) || pageIndex < 0) {
    return { status: 400, body: { ok: false, error: 'invalid_page_index' } };
  }

  const rawGeometry = body.geometry;
  if (rawGeometry != null && !isCompleteProofCardGeometry(rawGeometry)) {
    return { status: 422, body: { ok: false, error: 'invalid_geometry' } };
  }
  const geometry = rawGeometry == null ? null : rawGeometry;

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
      // Always an explicit boolean so the client can require it (no default).
      noop: result.noop === true,
      snapshot: result.snapshot,
    },
  };
}

export async function handleRequestLayoutHelpRequest(request: Request, orderId: string): Promise<RouteReply> {
  const auth = await authorizeCustomerReviewWrite(request, orderId);
  if (!auth.ok) return { status: auth.status ?? 403, body: { ok: false, error: auth.error } };

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_body');
    body = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid_json_body' } };
  }
  const raw = body.pageIndex;
  if (raw != null && (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0)) {
    return { status: 422, body: { ok: false, error: 'invalid_page_index' } };
  }
  const pageIndex = raw == null ? null : raw as number;

  const result = await requestLayoutHelp({ orderId, pageIndex, actor: customerReviewActor(auth.reviewToken) });
  if (!result.ok) return { status: result.status, body: { ok: false, error: result.error } };
  // Always an explicit boolean noop so the client's strict envelope accepts it.
  return { status: 200, body: { ok: true, noop: result.noop === true, snapshot: result.snapshot } };
}

/**
 * Read-only AUTHORITATIVE fit for a proposed card geometry, measured by the real
 * embedded-font renderer. Token-authorized, order/page/binding scoped, and
 * gated exactly like the mutation path but with NO commit. Never echoes story
 * text or the token; returns only the bounded numeric fit decision.
 */
export async function handleProofFitRequest(request: Request, orderId: string): Promise<RouteReply> {
  const auth = await authorizeCustomerReviewWrite(request, orderId);
  if (!auth.ok) return { status: auth.status ?? 403, body: { ok: false, error: auth.error } };

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_body');
    body = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid_json_body' } };
  }
  const pageIndex = body.pageIndex;
  if (typeof pageIndex !== 'number' || !Number.isInteger(pageIndex) || pageIndex < 0) {
    return { status: 400, body: { ok: false, error: 'invalid_page_index' } };
  }
  const rawGeometry = body.geometry;
  if (!isCompleteProofCardGeometry(rawGeometry)) {
    return { status: 422, body: { ok: false, error: 'invalid_geometry' } };
  }

  const result = await evaluateProofFit({
    orderId,
    pageIndex,
    geometry: rawGeometry,
    authoredAgainstProofVersion: typeof body?.authoredAgainstProofVersion === 'string' ? body.authoredAgainstProofVersion : null,
    authoredAgainstFingerprint: typeof body?.authoredAgainstFingerprint === 'string' ? body.authoredAgainstFingerprint : null,
    actor: customerReviewActor(auth.reviewToken),
  });
  if (!result.ok) return { status: result.status, body: { ok: false, error: result.error } };
  return { status: 200, body: { ok: true, fit: result.fit } };
}
