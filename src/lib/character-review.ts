import { requireAdoptionFence } from './paid-order-outbox.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import type { ManualAdoptionDeps } from './manual-media-proof-adoption.ts';
export interface CharacterReview {
  version: string; imageHash: string; description: string; tokenHash: string; expiresAt: string;
  status: 'awaiting_customer' | 'changes_requested' | 'approved';
  history: Array<{ version: string; status: string; at: string; comment?: string; imageHash?: string; description?: string }>;
  workQueue: Array<{ id: string; version: string; kind: 'revise_character' | 'character_approved'; status: 'pending' | 'superseded'; at: string; comment?: string }>;
}
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
export const characterImagePath = (id: string, digest: string) => `orders/${id}/character-sheets/${digest}.png`;
const headers = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' };
const response = (status: number, body: unknown) => Response.json(body, { status, headers });
function authorized(review: CharacterReview | undefined, token: string, now: Date) {
  if (!review || !/^[a-f0-9]{64}$/.test(review.tokenHash) || !Number.isFinite(Date.parse(review.expiresAt)) || Date.parse(review.expiresAt) <= now.getTime()) return false;
  return timingSafeEqual(Buffer.from(review.tokenHash), Buffer.from(hash(token)));
}
async function body(request: Request) {
  const reader = request.body?.getReader(); if (!reader) throw Error('invalid_body');
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const v = await reader.read(); if (v.done) break; size += v.value.length; if (size > 16384) throw Error('body_too_large'); chunks.push(v.value); } }
  finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
/** No notification, capability email, generation, proof release or provider calls. */
export async function characterReviewRequest(request: Request, id: string, deps: ManualAdoptionDeps, admin = false) {
  if (!/^ord_[a-zA-Z0-9_-]+$/.test(id)) return response(admin ? 404 : 403, { error: 'not_found_or_unauthorized' });
  if (admin && !deps.authenticate(request)) return response(401, { error: 'unauthorized' });
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin');
    // Next's loopback server normalizes Request.url to localhost even when
    // the browser requested 127.0.0.1. Host is the actual requested authority;
    // browsers cannot forge it. Never trust x-forwarded-host here.
    const url = new URL(request.url);
    const authority = request.headers.get('host') ?? url.host;
    if (origin && origin !== `${url.protocol}//${authority}`) return response(403, { error: 'origin_rejected' });
  }
  try {
    const snap = await deps.readOrder(id); if (!snap || snap.order.id !== id) return response(admin ? 404 : 403, { error: 'not_found_or_unauthorized' });
    const order = snap.order; const now = deps.now?.() ?? new Date();
    if (!admin && !authorized(order.characterReview, request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '', now)) return response(403, { error: 'invalid_or_expired_capability' });
    if (order.paymentStatus !== 'paid' || order.refundedAt || order.stripeRefundId || order.refundClaimId) return response(409, { error: 'paid_order_required' });
    const current = order.characterReview;
    if (admin) {
      if (request.method === 'GET') return response(200, { review: current ? { version: current.version, description: current.description, imageHash: current.imageHash, expiresAt: current.expiresAt, status: current.status, history: current.history, workQueue: current.workQueue } : null });
      const input = await body(request);
      // Authenticated operator rotation is not a new production task and may recover
      // expired links without inventing a customer decision or bypassing review.
      if (input.action === 'reissue_invitation') {
        if (!current || current.status !== 'awaiting_customer' || input.expectedVersion !== current.version)
          return response(409, { error: 'stale_or_decided_version' });
        if (order.status !== 'order_received' || order.fulfillmentMode !== 'manual_hold' || order.customerProofReleasedAt || order.printJobId || order.pageArtifacts?.length || order.proofVersion)
          return response(409, { error: 'book_already_prepared' });
        if (current.history.length >= 100) return response(409, { error: 'review_history_limit' });
        const token = randomBytes(32).toString('hex');
        const next: CharacterReview = { ...current, tokenHash: hash(token), expiresAt: new Date(now.getTime() + 7 * 86400000).toISOString(),
          history: [...current.history, { version: current.version, status: 'invitation_reissued', at: now.toISOString() }] };
        if (!(await deps.commit({ ...order, characterReview: next }, snap.version)).ok) return response(409, { error: 'concurrent_change' });
        return response(200, { version: next.version, expiresAt: next.expiresAt, reviewPath: `/character-review/${id}#token=${token}`, sent: false });
      }
      requireAdoptionFence(order, input.workFence, 'character', now.getTime());
      if (input.expectedVersion !== (current?.version ?? null)) return response(409, { error: 'stale_version' });
      if (input.attestation !== 'reviewed_exact_character_sheet' || !/^[a-f0-9]{64}$/.test(input.imageHash)
          || typeof input.description !== 'string' || !input.description.trim() || input.description.length > 4000) return response(400, { error: 'invalid_candidate' });
      if (order.status !== 'order_received' || order.fulfillmentMode !== 'manual_hold' || order.customerProofReleasedAt || order.printJobId || order.pageArtifacts?.length || order.proofVersion) return response(409, { error: 'book_already_prepared' });
      const artifact = await deps.readArtifact(characterImagePath(id, input.imageHash), 10 * 1024 * 1024);
      if (artifact.pathname !== characterImagePath(id, input.imageHash) || artifact.contentType !== 'image/png' || hash(artifact.body) !== input.imageHash
          || Buffer.from(artifact.body.subarray(0,8)).toString('hex') !== '89504e470d0a1a0a') return response(400, { error: 'image_mismatch' });
      if ((current?.history.length ?? 0) >= 100) return response(409, { error: 'review_history_limit' });
      await sharp(Buffer.from(artifact.body), { limitInputPixels: 40000000 }).raw().toBuffer();
      const token = randomBytes(32).toString('hex'); const version = randomBytes(16).toString('hex');
      const next: CharacterReview = { version, imageHash: input.imageHash, description: input.description.trim(), tokenHash: hash(token),
        expiresAt: new Date(now.getTime() + 7 * 86400000).toISOString(), status: 'awaiting_customer',
        history: [...(current?.history ?? []), { version, status: 'internal_qa_complete', at: now.toISOString(), imageHash: input.imageHash, description: input.description.trim() }], workQueue: (current?.workQueue ?? []).map(e => ({ ...e, status: 'superseded' })) };
      requireAdoptionFence(order, input.workFence, 'character', (deps.now?.() ?? new Date()).getTime());
      if (!(await deps.commit({ ...order, characterReview: next }, snap.version)).ok) return response(409, { error: 'concurrent_change' });
      return response(200, { version, expiresAt: next.expiresAt, reviewPath: `/character-review/${id}#token=${token}`, sent: false });
    }
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!authorized(current, token, now)) return response(403, { error: 'invalid_or_expired_capability' });
    const review = current!;
    if (request.method === 'GET') {
      if (new URL(request.url).searchParams.get('asset') === 'image') {
        if (new URL(request.url).searchParams.get('version') !== review.version) return response(409, { error: 'stale_version' });
        const image = await deps.readArtifact(characterImagePath(id, review.imageHash), 10 * 1024 * 1024);
        if (image.pathname !== characterImagePath(id, review.imageHash) || hash(image.body) !== review.imageHash || image.contentType !== 'image/png') return response(409, { error: 'image_mismatch' });
        return new Response(Buffer.from(image.body), { headers: { ...headers, 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff' } });
      }
      return response(200, { version: review.version, description: review.description, status: review.status });
    }
    const input = await body(request);
    if (input.version !== review.version) return response(409, { error: 'stale_version' });
    if (!['approve', 'request_changes'].includes(input.action)) return response(400, { error: 'invalid_action' });
    const comment = typeof input.comment === 'string' ? input.comment.trim() : '';
    if (comment.length > 2000 || (input.action === 'request_changes' && !comment)) return response(400, { error: 'changes_required' });
    const status = input.action === 'approve' ? 'approved' : 'changes_requested';
    const eventId = hash(`${id}:${review.version}:${input.action}`);
    const previous = review.workQueue.find(e => e.id === eventId);
    if (previous) return previous.comment === comment ? response(200, { ok: true, status, duplicate: true }) : response(409, { error: 'decision_already_recorded' });
    if (review.status !== 'awaiting_customer') return response(409, { error: 'decision_already_recorded' });
    const at = now.toISOString();
    const next: CharacterReview = { ...review, status, history: [...review.history, { version: review.version, status, at, comment }],
      workQueue: [...review.workQueue, { id: eventId, version: review.version, kind: input.action === 'approve' ? 'character_approved' : 'revise_character', status: 'pending', at, comment }] };
    if (!(await deps.commit({ ...order, characterReview: next }, snap.version)).ok) return response(409, { error: 'concurrent_change' });
    return response(200, { ok: true, status, queued: true });
  } catch { return response(400, { error: 'character_review_unavailable' }); }
}
