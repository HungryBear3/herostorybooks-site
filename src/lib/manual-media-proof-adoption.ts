import { requireAdoptionFence } from './paid-order-outbox.ts';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { appendAuditEventTo } from './orders.ts';
import type { OrderRecord, PageArtifact, PrivateArtifactMetadata } from './orders.ts';
import type { StoryContent } from './fulfillment-types.ts';
import { NEW_PROOF_LAYOUT_VERSION } from './fulfillment-types.ts';
import { canonicalSourceHash, proofRenderSourceFingerprint, proofStoryFromPageArtifacts } from './review-source-identity.ts';
import { validateStoryPageSet } from './story-page-contract.ts';
import { assertSnapshotCurrent } from './manual-media-proof-contract.ts';

export interface ManualArtifact { filename: string; sha256: string; bytes: number }
export interface ManualManifest {
  schema: 'hsb-manual-media-proof-preparation-v1'; orderId: string; expectedOrderHash: string;
  candidateVersion: string; status: 'local_candidate_not_adopted'; customerReleaseAuthorized: false;
  proof: ManualArtifact; images: ManualArtifact[]; story: StoryContent; layoutVersion: 'modern_full_bleed';
}
export const manualArtifactPath = (m: ManualManifest, a: ManualArtifact) =>
  `orders/${m.orderId}/manual-proofs/${m.candidateVersion}/${a.sha256}${a.filename === 'candidate.pdf' ? '.pdf' : '.image'}`;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function validateManualManifest(m: ManualManifest, orderId: string, expectedManifestHash: string) {
  if (!m || canonicalSourceHash(m) !== expectedManifestHash || !/^[a-f0-9]{64}$/.test(expectedManifestHash)) throw new Error('manifest_hash_mismatch');
  if (!/^ord_[a-zA-Z0-9_-]+$/.test(orderId) || m.orderId !== orderId) throw new Error('order_binding_mismatch');
  if (m.schema !== 'hsb-manual-media-proof-preparation-v1' || m.status !== 'local_candidate_not_adopted'
      || m.customerReleaseAuthorized !== false || m.layoutVersion !== NEW_PROOF_LAYOUT_VERSION
      || !/^[a-f0-9]{64}$/.test(m.candidateVersion) || !/^[a-f0-9]{64}$/.test(m.expectedOrderHash)) throw new Error('invalid_manifest');
  if (!m.story || typeof m.story.title !== 'string' || !m.story.title.trim() || m.story.dedication || !Array.isArray(m.story.pages)
      || !Array.isArray(m.images) || m.images.length !== m.story.pages.length || m.images.length > 32) throw new Error('invalid_story');
  for (const [i, a] of [m.proof, ...m.images].entries()) {
    if (!a || a.filename !== (i === 0 ? 'candidate.pdf' : `page-${i}.image`) || !/^[a-f0-9]{64}$/.test(a.sha256)
        || !Number.isSafeInteger(a.bytes) || a.bytes < 1 || a.bytes > (i === 0 ? 64 : 20) * 1024 * 1024) throw new Error('invalid_artifact');
  }
  if ([m.proof, ...m.images].reduce((sum, a) => sum + a.bytes, 0) > 256 * 1024 * 1024) throw new Error('package_too_large');
  const sourcePages = m.story.pages.map((p, i) => {
    if (p.pageNum !== i + 1 || p.proofCardOverride || typeof p.imagePrompt !== 'string' || !p.imagePrompt.trim()) throw new Error('invalid_page_identity_or_prompt');
    return { pageIndex: i, storyText: p.story, textLayout: p.textLayout, currentImageUrl: `sha256:${m.images[i].sha256}`, acceptedImageUrl: null, accepted: false };
  });
  if (canonicalSourceHash({ orderId, expectedOrderHash: m.expectedOrderHash, story: m.story, pages: sourcePages }) !== m.candidateVersion) throw new Error('candidate_version_mismatch');
}
export interface ManualAdoptionDeps {
  authenticate: (request: Request) => boolean;
  readOrder: (id: string) => Promise<{ order: OrderRecord; version: string } | null>;
  readArtifact: (pathname: string, maxBytes: number) => Promise<{ pathname: string; contentType: string; body: Uint8Array }>;
  commit: (order: OrderRecord, expectedVersion: string) => Promise<{ ok: boolean }>;
  now?: () => Date;
}
/** Atomic initial adoption only. Staging uploads are never customer-authorized references.
 * No retries/rebase, capability minting, release, generation or external sends. */
export async function adoptManualMediaProof(request: Request, orderId: string, deps: ManualAdoptionDeps) {
  const headers = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' };
  const reply = (status: number, body: Record<string, unknown>) => ({ status, body, headers });
  if (!deps.authenticate(request)) return reply(401, { error: 'Unauthorized' });
  const origin = request.headers.get('origin');
  const requestUrl = new URL(request.url);
  if (origin && origin !== `${requestUrl.protocol}//${request.headers.get('host') ?? requestUrl.host}`) return reply(403, { error: 'origin_rejected' });
  try {
    // Bounded read even when content-length is absent or dishonest.
    const reader = request.body?.getReader();
    if (!reader) throw new Error('invalid_body');
    const chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength;
      if (length > 512 * 1024) throw new Error('manifest_too_large'); chunks.push(value); }
    } finally { await reader.cancel(); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (input.attestation !== 'reviewed_exact_candidate' || !['preflight', 'adopt'].includes(input.mode)) throw new Error('review_attestation_required');
    const m: ManualManifest = input.manifest;
    validateManualManifest(m, orderId, input.expectedManifestHash);
    const snapshot = await deps.readOrder(orderId);
    if (!snapshot) return reply(404, { error: 'order_not_found' });
    if (snapshot.order.id !== orderId) throw new Error('order_binding_mismatch');
    assertSnapshotCurrent(snapshot.order, m.expectedOrderHash);
    requireAdoptionFence(snapshot.order, input.workFence, 'proof', (deps.now?.() ?? new Date()).getTime());
    const createdAt = (deps.now?.() ?? new Date()).toISOString();
    const retentionUntil = new Date(Date.parse(createdAt) + 30 * 86400000).toISOString();
    const metas: PrivateArtifactMetadata[] = [];
    for (const a of [m.proof, ...m.images]) {
      const pathname = manualArtifactPath(m, a);
      const expectedType = a === m.proof ? 'application/pdf' : null;
      if (input.mode === 'preflight') { metas.push({ pathname, sha256: a.sha256, bytes: a.bytes, contentType: expectedType ?? 'image/png', createdAt, retentionUntil }); continue; }
      const result = await deps.readArtifact(pathname, a.bytes);
      if (result.pathname !== pathname || result.body.byteLength !== a.bytes || sha(result.body) !== a.sha256) throw new Error('private_artifact_mismatch');
      if (expectedType ? result.contentType !== expectedType : !['image/png', 'image/jpeg'].includes(result.contentType)) throw new Error('artifact_type_mismatch');
      if (expectedType && Buffer.from(result.body.subarray(0, 5)).toString() !== '%PDF-') throw new Error('invalid_pdf');
      if (!expectedType) { const decoded = sharp(Buffer.from(result.body), { limitInputPixels: 40000000 });
        const metadata = await decoded.metadata();
        if (result.contentType !== (metadata.format === 'png' ? 'image/png' : metadata.format === 'jpeg' ? 'image/jpeg' : 'invalid')) throw new Error('artifact_type_mismatch');
        await decoded.raw().toBuffer(); }
      metas.push({ pathname, sha256: a.sha256, bytes: a.bytes, contentType: result.contentType, createdAt, retentionUntil });
    }
    const pages: PageArtifact[] = m.story.pages.map((p, i) => ({ pageIndex: i, storyText: p.story, sceneTitle: p.sceneTitle,
      basePrompt: p.imagePrompt, characterAnchor: m.story.characterDescription, textLayout: p.textLayout,
      currentImageUrl: `/api/order/${orderId}/review-asset/page-${String(i + 1).padStart(2, '0')}`,
      accepted: false, acceptedImageUrl: null, regenerateCount: 0, feedbackHistory: [], versionHistory: [], privateReviewAsset: metas[i + 1] }));
    const pageFailure = validateStoryPageSet(pages, snapshot.order.bookFormat, NEW_PROOF_LAYOUT_VERSION);
    if (pageFailure) throw new Error(`page_contract:${pageFailure.code}`);
    if (input.mode === 'preflight') return reply(200, { ok: true, status: 'preflight_only_no_artifacts_read_or_order_changed' });
    const next: OrderRecord = { ...snapshot.order, pageArtifacts: pages, printTitle: m.story.title,
      layoutVersion: NEW_PROOF_LAYOUT_VERSION, privateStoryArtifact: metas[0],
      storyArtifactUrl: `/api/order/${orderId}/review-asset/proof-pdf`,
      proofVersion: `manual_${m.candidateVersion}`, proofReviewedAt: null, proofReviewedVersion: null,
      reviewStatus: 'in_review', updatedAt: createdAt };
    const story = proofStoryFromPageArtifacts(next, pages);
    if (!story) throw new Error('invalid_proof_source');
    next.proofSourceFingerprint = proofRenderSourceFingerprint({ story, order: next, imageUrls: [pages[0].currentImageUrl!, ...pages.map(p => p.currentImageUrl!)] });
    // Fresh read protects against payment/refund edits during blob verification; CAS also fences later edits.
    const latest = await deps.readOrder(orderId);
    if (!latest || latest.version !== snapshot.version) return reply(409, { error: 'order_changed' });
    assertSnapshotCurrent(latest.order, m.expectedOrderHash);
    const audited = appendAuditEventTo(next, { type: 'proof_generated', reason: 'manual_media_proof_adopted_without_capability_or_release', meta: { manifestHash: input.expectedManifestHash, proofVersion: next.proofVersion!, acceptedPages: 0 } }, createdAt);
    requireAdoptionFence(latest.order, input.workFence, 'proof', (deps.now?.() ?? new Date()).getTime());
    const committed = await deps.commit(audited, snapshot.version);
    if (!committed.ok) return reply(409, { error: 'order_changed' });
    return reply(200, { ok: true, status: 'adopted_unreleased', proofVersion: next.proofVersion, acceptedPages: 0,
      reviewCapabilityCreated: false, customerReleaseAuthorized: false });
  } catch (error) {
    const known = error instanceof Error ? error.message : '';
    const safe = /^(manifest_|order_|invalid_|paid_|media_|initial_|active_|review_|candidate_|page_contract:|private_artifact_|artifact_|package_)/.test(known);
    return reply(400, { error: safe ? known : 'adoption_failed' });
  }
}
