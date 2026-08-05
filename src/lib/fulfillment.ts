import crypto from 'node:crypto';
import { put } from '@vercel/blob';

import { getOrder, getOrderPhotoUrl, isPrintFormat, orderRequiresReferenceImage, updateFulfillmentState, withBlobNamespace } from './orders.ts';
import { buildPagePrompt } from './image-prompt-builder.ts';
import type { OrderRecord, PageArtifact } from './orders.ts';
import type { StoryContent } from './fulfillment-types.ts';
import { NEW_PROOF_LAYOUT_VERSION } from './fulfillment-types.ts';
import { assertStoryPageSet } from './story-page-contract.ts';
import { generateStory, generateStoryWithMeta } from './story-generator.ts';
import type { StoryWithMeta } from './story-generator.ts';
import { generateStoryImageResults, requireCompleteImageResults } from './image-generator.ts';
import type { GeneratedImageResult } from './image-generator.ts';
import { buildPdf, buildPrintCoverPdf, buildPrintInteriorPdf, getPrintInteriorPageCount } from './pdf-builder.ts';
import { calculateCoverDimensions, submitPrintJob } from './lulu.ts';
import { sendDigitalDeliveryEmail, sendProofReadyEmail, sendLifecycleEmail, sendOperatorFailureAlert } from './order-email.ts';
import { proofRenderSourceFingerprint, proofStoryFromPageArtifacts } from './review-source-identity.ts';

// ── Per-page artifact selection (proof rebuild) ───────────────────────────────

/**
 * Returns the URL the proof PDF should use for a given page:
 * acceptedImageUrl when accepted, otherwise currentImageUrl. Falls back to
 * null when the page has no rendered image at all.
 */
export function imageUrlForPage(artifact: import('./orders.ts').PageArtifact): string | null {
  if (artifact.accepted && artifact.acceptedImageUrl) return artifact.acceptedImageUrl;
  return artifact.currentImageUrl ?? null;
}

/** Build the URL list a proof builder should consume, in page order. */
export function pageImageUrlsFromArtifacts(
  artifacts: import('./orders.ts').PageArtifact[],
): (string | null)[] {
  return [...artifacts]
    .sort((a, b) => a.pageIndex - b.pageIndex)
    .map(imageUrlForPage);
}

// ── Config ────────────────────────────────────────────────────────────────────

export const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 5_000;

export function backoffMs(attempt: number): number {
  return BASE_BACKOFF_MS * Math.pow(5, attempt - 1);
  // attempt 1: 5s, 2: 25s, 3: 125s
}

// ── Injectable deps (for testing) ─────────────────────────────────────────────

export interface FulfillmentDeps {
  generateStory?: (order: OrderRecord) => Promise<StoryContent>;
  /**
   * Structured story-with-meta dep. When set, takes precedence over
   * generateStory. Lets fulfillment persist the StoryMeta record (source/
   * model/generatedAt/fallbackError) onto the order for diagnostics.
   */
  generateStoryWithMeta?: (order: OrderRecord) => Promise<StoryWithMeta>;
  /**
   * Legacy URL-only image gen, kept for tests that don't care about
   * conditioning metadata. Prefer generateImageResults when you want
   * provider/model/conditioning on the persisted PageArtifact.
   */
  generateImages?: (prompts: string[], order: OrderRecord) => Promise<(string | null)[]>;
  /**
   * Structured image gen — returns conditioning metadata per page so
   * fulfillment can persist honest provider/model/conditioning on each
   * PageArtifact. When this is set it takes precedence over generateImages.
   */
  generateImageResults?: (prompts: string[], order: OrderRecord) => Promise<GeneratedImageResult[]>;
  buildPdf?: (story: StoryContent, order: OrderRecord, urls: (string | null)[]) => Promise<Buffer>;
  buildPrintInteriorPdf?: (story: StoryContent, order: OrderRecord, urls: (string | null)[]) => Promise<Buffer>;
  buildPrintCoverPdf?: (widthPoints: number, heightPoints: number, title: string, order: OrderRecord) => Buffer;
  calculateCoverDimensions?: (order: OrderRecord, interiorPageCount: number) => Promise<{ widthPt: number; heightPt: number }>;
  uploadArtifact?: (orderId: string, buffer: Buffer, filename: string) => Promise<string>;
  submitPrint?: (order: OrderRecord) => Promise<{ jobId: string }>;
  sleep?: (ms: number) => Promise<void>;
  getBaseUrl?: () => string;
}

function paidFulfillmentPatch(order: OrderRecord, patch: Partial<OrderRecord>): Partial<OrderRecord> {
  return {
    ...patch,
    paymentStatus: 'paid',
    ...(order.stripeSessionId ? { stripeSessionId: order.stripeSessionId } : {}),
    ...(order.shippingAddress ? { shippingAddress: order.shippingAddress } : {}),
  };
}

function proofReleasePatch(order: OrderRecord): Partial<OrderRecord> {
  return paidFulfillmentPatch(order, {
    customerProofReleasedAt: new Date().toISOString(),
    fulfillmentLastError: null,
  });
}

// ── Default implementations ───────────────────────────────────────────────────

export async function defaultUploadArtifact(orderId: string, buffer: Buffer, filename: string): Promise<string> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    const blob = await put(withBlobNamespace(`orders/${orderId}/${filename}`), buffer, {
      access: 'public',
      contentType: 'application/pdf',
      addRandomSuffix: false,
      allowOverwrite: false,
      token,
    });
    return blob.url;
  }
  // Local fallback: write to .data/artifacts/ and return a path-based URL
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const dir = path.join(process.cwd(), '.data', 'artifacts', orderId);
  const filePath = path.join(dir, filename);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer, { flag: 'wx' });
  const base = process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:3000';
  return `${base}/api/order/${orderId}/artifact/${filename}`;
}

function defaultGetBaseUrl(): string {
  return process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:3000';
}

function md5Hex(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function buildProofGeneratedAuditEvent(order: OrderRecord, pageCount: number) {
  return {
    at: new Date().toISOString(),
    type: 'proof_generated' as const,
    meta: {
      bookFormat: order.bookFormat,
      pageCount,
    },
  };
}

/**
 * Run image generation through whichever dep the caller provided. Returns
 * structured per-page results so fulfillment can persist conditioning
 * metadata. When a test only supplied the legacy URL-only `generateImages`,
 * we synthesize a `text_only` GeneratedImageResult per page so downstream
 * code paths stay uniform.
 */
/**
 * Run story generation through whichever dep the caller provided. Returns
 * structured story+meta so fulfillment can persist the StoryMeta record.
 * Tests that only mocked the legacy `generateStory` get a synthetic
 * `template` meta — accurate for those tests since their mocks return a
 * canned StoryContent.
 */
async function runStoryGeneration(
  order: OrderRecord,
  deps: FulfillmentDeps,
): Promise<StoryWithMeta> {
  if (deps.generateStoryWithMeta) {
    return deps.generateStoryWithMeta(order);
  }
  if (deps.generateStory) {
    const story = await deps.generateStory(order);
    return {
      story,
      meta: {
        source: 'template',
        model: 'test_mock_legacy',
        generatedAt: new Date().toISOString(),
        fallbackError: null,
      },
    };
  }
  return generateStoryWithMeta(order);
}

async function runImageGeneration(
  imagePrompts: string[],
  order: OrderRecord,
  deps: FulfillmentDeps,
): Promise<GeneratedImageResult[]> {
  if (deps.generateImageResults) {
    return deps.generateImageResults(imagePrompts, order);
  }
  if (deps.generateImages) {
    const urls = await deps.generateImages(imagePrompts, order);
    return urls.map((url, i) => ({
      imageUrl: url ?? null,
      provider: 'fal' as const,
      model: 'fal-ai/flux/schnell',
      promptUsed: imagePrompts[i] ?? '',
      conditioning: 'text_only' as const,
      referencePhotoUrl: null,
      latencyMs: 0,
      error: url ? null : 'no image url returned',
    }));
  }
  // Real default path: explicit reference orders stay photo-conditioned and
  // fail closed if their durable URL is missing; explicit storybook orders
  // use the text-only lane.
  // TODO(voice-beta): when order.voiceBlobUrl is present and a server-flagged
  // transcription path is wired up (HSB_VOICE_TRANSCRIPTION_ENABLED), call the
  // transcription provider here, extract reviewed personalization signals, and feed
  // them into the story planner — NOT into voice cloning. Until then the audio
  // remains optional source material only.
  const referenceImageUrl = getOrderPhotoUrl(order);
  return generateStoryImageResults(imagePrompts, {
    referenceImageUrl,
    referenceImageRequired: orderRequiresReferenceImage(order),
  });
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────

async function runWithRetry(
  orderId: string,
  fn: (attempt: number) => Promise<void>,
  deps: Pick<FulfillmentDeps, 'sleep'>,
): Promise<void> {
  const _sleep = deps.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      await fn(attempt);
      return;
    } catch (err) {
      attempt++;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[fulfillment] orderId=${orderId} attempt=${attempt} error: ${errMsg}`);

      if (attempt >= MAX_RETRIES) {
        await updateFulfillmentState(orderId, {
          fulfillmentStatus: 'failed_manual_review',
          fulfillmentAttempts: attempt,
          fulfillmentLastError: errMsg,
        });
        console.error(`[fulfillment] orderId=${orderId} moved to failed_manual_review after ${attempt} attempts`);
        const failedOrder = await getOrder(orderId);
        if (failedOrder) {
          sendOperatorFailureAlert(failedOrder, errMsg).catch(e =>
            console.error(`[fulfillment] operator alert failed for ${orderId}:`, e),
          );
        }
        return;
      }

      await updateFulfillmentState(orderId, {
        fulfillmentAttempts: attempt,
        fulfillmentLastError: errMsg,
      });
      await _sleep(backoffMs(attempt));
    }
  }
}

// ── Digital fulfillment ───────────────────────────────────────────────────────

async function runDigitalFulfillment(order: OrderRecord, deps: FulfillmentDeps): Promise<void> {
  const _buildPdf = deps.buildPdf ?? buildPdf;
  const _upload = deps.uploadArtifact ?? defaultUploadArtifact;
  const _getBaseUrl = deps.getBaseUrl ?? defaultGetBaseUrl;

  await updateFulfillmentState(order.id, paidFulfillmentPatch(order, { fulfillmentStatus: 'generating_story' }));
  const { story, meta: storyMeta } = await runStoryGeneration(order, deps);
  // Persist storyMeta as soon as it's known so diagnostics can answer
  // "which story path ran?" even before image gen completes.
  await updateFulfillmentState(order.id, paidFulfillmentPatch(order, { storyMeta }));

  // Every subsequent updateFulfillmentState in this function is a
  // read-modify-write against blob. If the blob read returns a slightly
  // stale snapshot (taken before the storyMeta write fully landed), the
  // patch merge drops storyMeta — which is exactly what the 2026-05-15
  // Gemini preview proof test reproduced (final persisted storyMeta was
  // null even though it was written here). Carry storyMeta forward in
  // every later patch so the merge is deterministic regardless of
  // blob-read freshness. Defense-in-depth: also carry it through
  // delivery_email_failed so an email-side failure cannot drop it
  // either.
  await updateFulfillmentState(order.id, paidFulfillmentPatch(order, { fulfillmentStatus: 'generating_images', storyMeta }));
  // Build per-page prompts that LEAD with the frozen character anchor + identity
  // section + continuity rules + quality constraints. Initial generation now
  // goes through buildPagePrompt so it gets the same identity scaffolding the
  // regenerate path has always had.
  const characterAnchor = story.characterDescription ?? null;
  const imagePrompts = story.pages.map((p) =>
    buildPagePrompt({
      basePrompt: p.imagePrompt,
      storyText: p.story,
      order: {
        childName: order.childName,
        childAge: order.childAge,
        characterNotes: order.characterNotes,
        appearanceOptions: order.appearanceOptions,
        photoBlobPath: order.photoBlobPath ?? null,
        theme: order.theme,
      },
      characterAnchor,
      textLayout: p.textLayout,
    }),
  );
  const imageResults = requireCompleteImageResults(
    await runImageGeneration(imagePrompts, order, deps),
    story.pages.length,
    'digital_fulfillment',
  );
  const imageUrls = imageResults.map((r) => r.imageUrl);

  // Seed pageArtifacts so the customer review page can render even before the PDF builds.
  // Persist the LLM's per-page basePrompt AND the frozen character anchor so
  // regenerate can rebuild the same identity scaffolding deterministically.
  // Conditioning metadata (provider/model/conditioning/referencePhotoUrl) flows
  // through from the structured image result so diagnostics can show whether
  // each page was photo-conditioned or text-only.
  const seededPageArtifacts = story.pages.map((page, i): import('./orders.ts').PageArtifact => {
    const result = imageResults[i];
    return {
      pageIndex: i,
      storyText: page.story,
      basePrompt: page.imagePrompt,
      sceneTitle: page.sceneTitle,
      textLayout: page.textLayout ?? null,
      characterAnchor,
      currentImageUrl: result?.imageUrl ?? null,
      acceptedImageUrl: null,
      generationProvider: result?.provider ?? null,
      generationModel: result?.model ?? null,
      generationConditioning: result?.conditioning ?? null,
      regenerateCount: 0,
      accepted: false,
      feedbackHistory: [],
      versionHistory: result?.imageUrl
        ? [
            {
              createdAt: new Date().toISOString(),
              imageUrl: result.imageUrl,
              provider: result.provider,
              model: result.model,
              promptUsed: imagePrompts[i] ?? page.imagePrompt,
              conditioning: result.conditioning ?? null,
              referencePhotoUrl: result.referencePhotoUrl ?? null,
            },
          ]
        : [],
    };
  });

  // Persist pageArtifacts BEFORE the slow PDF build so a serverless timeout
  // during PDF generation doesn't lose the per-page generation evidence.
  // Diagnostics + admin can now inspect what generation produced even if the
  // function dies before the proof PDF is built. The final updateFulfillmentState
  // below re-writes the same array (idempotent) plus the proof URL. storyMeta
  // carried forward to survive stale blob-readback (see comment above).
  await updateFulfillmentState(order.id, paidFulfillmentPatch(order, { pageArtifacts: seededPageArtifacts, storyMeta }));

  await updateFulfillmentState(order.id, paidFulfillmentPatch(order, { fulfillmentStatus: 'building_pdf', storyMeta }));
  // Fail closed BEFORE building/publishing a proof: the story page set must
  // satisfy the book contract (exact count, unique/contiguous indices, story
  // text + illustration on every page). A partial/duplicated set never reaches
  // preview_ready. New proofs are the legacy bottom band (see NEW_PROOF_LAYOUT_VERSION).
  assertStoryPageSet(seededPageArtifacts, order.bookFormat, NEW_PROOF_LAYOUT_VERSION);
  // Include cover image (first imageUrl) + per-page images
  const allUrls: (string | null)[] = [imageUrls[0] ?? null, ...imageUrls];
  const pdfBuffer = await _buildPdf(story, { ...order, layoutVersion: NEW_PROOF_LAYOUT_VERSION }, allUrls);

  const proofVersion = newProofVersion();
  const pdfUrl = await _upload(order.id, pdfBuffer, proofArtifactPath(proofVersion));
  const sourceFingerprint = proofRenderSourceFingerprint({ story, order, imageUrls: allUrls });

  const proofApprovalToken = order.proofApprovalToken ?? crypto.randomBytes(24).toString('hex');
  const reviewUrl = `${_getBaseUrl()}/review/${order.id}?token=${proofApprovalToken}`;
  const proofGeneratedEvent = buildProofGeneratedAuditEvent(order, seededPageArtifacts.length);
  // CRITICAL: include storyMeta explicitly in the final 'complete' patch.
  // The 2026-05-15 Gemini preview proof test showed final persisted
  // storyMeta=null because (a) storyMeta was written in a separate prior
  // patch, and (b) a stale blob-read in this final write merged-in over
  // the storyMeta field. Explicit inclusion makes the merge deterministic.
  const finalDigitalPatch: Partial<OrderRecord> = {
    fulfillmentStatus: 'complete',
    status: 'preview_ready',
    layoutVersion: NEW_PROOF_LAYOUT_VERSION,
    storyArtifactUrl: pdfUrl,
    // Identity of the artifact just published. Without these the review
    // surface has a URL it cannot verify, and every proof gate fails closed.
    proofSourceFingerprint: sourceFingerprint,
    proofVersion,
    proofReviewedAt: null,
    proofReviewedVersion: null,
    proofApprovalToken,
    pageArtifacts: seededPageArtifacts,
    printTitle: story.title,
    storyMeta,
    reviewStatus: 'in_review',
    fulfillmentAttempts: 0,
    fulfillmentLastError: null,
    auditEvents: [...(order.auditEvents ?? []), proofGeneratedEvent],
  };
  await updateFulfillmentState(order.id, paidFulfillmentPatch(order, finalDigitalPatch));

  // Delivery email runs AFTER the artifacts are durably persisted at
  // fulfillmentStatus='complete'. If the email fails (e.g. Resend domain
  // not verified), we record `delivery_email_failed` and keep
  // `storyArtifactUrl` intact. We deliberately do NOT re-throw — that
  // would push the whole order to `failed_manual_review` via runWithRetry
  // and trigger a wasted regeneration of the story + images for an order
  // whose PDF is already correct. Admin's `retryOrderFulfillment` knows
  // how to recover by resending just the email.
  try {
    const emailResult = await sendDigitalDeliveryEmail(order, { pdfUrl, reviewUrl });
    if (!emailResult.skipped) {
      await updateFulfillmentState(order.id, proofReleasePatch(order));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[fulfillment] delivery email failed for ${order.id}: ${message}`);
    // Patch only email/fulfillment diagnostics onto the latest versioned record.
    // Never replay proof or page fields captured before the email call: customer
    // review may have committed concurrently while the network request was open.
    await updateFulfillmentState(order.id, paidFulfillmentPatch(order, {
      fulfillmentStatus: 'delivery_email_failed',
      fulfillmentLastError: `delivery_email_failed: ${message.slice(0, 500)}`,
    }));
  }
}

// ── Print fulfillment ─────────────────────────────────────────────────────────

async function runPrintFulfillment(order: OrderRecord, deps: FulfillmentDeps): Promise<void> {
  const _buildPdf = deps.buildPdf ?? buildPdf;
  const _buildPrintInteriorPdf = deps.buildPrintInteriorPdf ?? buildPrintInteriorPdf;
  const _upload = deps.uploadArtifact ?? defaultUploadArtifact;
  const _getBaseUrl = deps.getBaseUrl ?? defaultGetBaseUrl;

  await updateFulfillmentState(order.id, paidFulfillmentPatch(order, { fulfillmentStatus: 'generating_story' }));
  const { story, meta: storyMeta } = await runStoryGeneration(order, deps);
  await updateFulfillmentState(order.id, paidFulfillmentPatch(order, { storyMeta }));

  // Mirror of the digital path: carry storyMeta forward in every later
  // patch so a stale blob-read cannot drop it during the proof_ready
  // write. The 2026-05-15 Gemini preview proof test reproduced the
  // dropped-storyMeta failure on the digital path; same risk applies
  // here.
  await updateFulfillmentState(order.id, paidFulfillmentPatch(order, { fulfillmentStatus: 'generating_images', storyMeta }));
  // Same identity-anchored prompt construction as the digital path — keeps the
  // same child consistent across all pages of the print book.
  const characterAnchor = story.characterDescription ?? null;
  const imagePrompts = story.pages.map((p) =>
    buildPagePrompt({
      basePrompt: p.imagePrompt,
      storyText: p.story,
      order: {
        childName: order.childName,
        childAge: order.childAge,
        characterNotes: order.characterNotes,
        appearanceOptions: order.appearanceOptions,
        photoBlobPath: order.photoBlobPath ?? null,
        theme: order.theme,
      },
      characterAnchor,
      textLayout: p.textLayout,
    }),
  );
  const imageResults = requireCompleteImageResults(
    await runImageGeneration(imagePrompts, order, deps),
    story.pages.length,
    'print_fulfillment',
  );
  const imageUrls = imageResults.map((r) => r.imageUrl);

  // Compute + PERSIST pageArtifacts BEFORE the slow PDF build steps so a
  // serverless timeout during PDF/upload doesn't lose the generation evidence.
  // Without this, classic/premium orders that timed out during _buildPdf
  // ended up permanently stuck at fulfillmentStatus='building_pdf' with
  // pageArtifacts=0 and the runner's catch-block never running.
  const seededPageArtifacts = story.pages.map((page, i): import('./orders.ts').PageArtifact => {
    const result = imageResults[i];
    return {
      pageIndex: i,
      storyText: page.story,
      basePrompt: page.imagePrompt,
      sceneTitle: page.sceneTitle,
      textLayout: page.textLayout ?? null,
      characterAnchor,
      currentImageUrl: result?.imageUrl ?? null,
      acceptedImageUrl: null,
      generationProvider: result?.provider ?? null,
      generationModel: result?.model ?? null,
      generationConditioning: result?.conditioning ?? null,
      regenerateCount: 0,
      accepted: false,
      feedbackHistory: [],
      versionHistory: result?.imageUrl
        ? [
            {
              createdAt: new Date().toISOString(),
              imageUrl: result.imageUrl,
              provider: result.provider,
              model: result.model,
              promptUsed: imagePrompts[i] ?? page.imagePrompt,
              conditioning: result.conditioning ?? null,
              referencePhotoUrl: result.referencePhotoUrl ?? null,
            },
          ]
        : [],
    };
  });
  await updateFulfillmentState(order.id, paidFulfillmentPatch(order, { pageArtifacts: seededPageArtifacts, storyMeta }));

  await updateFulfillmentState(order.id, paidFulfillmentPatch(order, { fulfillmentStatus: 'building_pdf', storyMeta }));
  // Fail closed on a partial/duplicated page set before building the print
  // proof + interior — no preview_ready with an undersized book.
  assertStoryPageSet(seededPageArtifacts, order.bookFormat, NEW_PROOF_LAYOUT_VERSION);
  const allUrls: (string | null)[] = [imageUrls[0] ?? null, ...imageUrls];
  const orderForBuild = { ...order, layoutVersion: NEW_PROOF_LAYOUT_VERSION };
  const previewBuffer = await _buildPdf(story, orderForBuild, allUrls);
  const interiorBuffer = await _buildPrintInteriorPdf(story, orderForBuild, allUrls);

  const proofVersion = newProofVersion();
  const proofUrl = await _upload(order.id, previewBuffer, proofArtifactPath(proofVersion));
  const interiorUrl = await _upload(order.id, interiorBuffer, `interiors/${proofVersion}.pdf`);
  const sourceFingerprint = proofRenderSourceFingerprint({ story, order, imageUrls: allUrls });

  const proofApprovalToken = crypto.randomBytes(24).toString('hex');
  const baseUrl = _getBaseUrl();
  // Primary CTA — the review surface drives per-page accept, proof ack, and the
  // server-gated whole-book approval. The legacy /api/order/<id>/approve-proof
  // endpoint still exists for backward compatibility but is no longer surfaced
  // to customers.
  const reviewUrl = `${baseUrl}/review/${order.id}?token=${proofApprovalToken}`;
  const interiorPageCount = getPrintInteriorPageCount(story, order);

  // seededPageArtifacts was already computed and persisted earlier (before
  // PDF build), so we just re-use it in the final state write below.

  const proofGeneratedEvent = buildProofGeneratedAuditEvent(order, seededPageArtifacts.length);
  // storyMeta included explicitly so the proof_ready merge is
  // deterministic regardless of blob-read freshness.
  const finalPrintProofPatch: Partial<OrderRecord> = {
    fulfillmentStatus: 'proof_ready',
    status: 'preview_ready',
    layoutVersion: NEW_PROOF_LAYOUT_VERSION,
    storyArtifactUrl: proofUrl,
    proofSourceFingerprint: sourceFingerprint,
    proofVersion,
    proofReviewedAt: null,
    proofReviewedVersion: null,
    printInteriorArtifactUrl: interiorUrl,
    printInteriorMd5: md5Hex(interiorBuffer),
    printInteriorPageCount: interiorPageCount,
    printTitle: story.title,
    printCoverArtifactUrl: null,
    printCoverMd5: null,
    pageArtifacts: seededPageArtifacts,
    storyMeta,
    reviewStatus: 'in_review',
    proofApprovalToken,
    fulfillmentAttempts: 0,
    fulfillmentLastError: null,
    auditEvents: [...(order.auditEvents ?? []), proofGeneratedEvent],
  };
  await updateFulfillmentState(order.id, paidFulfillmentPatch(order, finalPrintProofPatch));

  // Mirror of the digital path: proof artifacts are durably persisted at
  // fulfillmentStatus='proof_ready'. If the proof-ready email fails we
  // record `delivery_email_failed` (preserving the artifacts) instead of
  // bubbling up to runWithRetry, which would burn retry attempts on
  // already-correct PDFs and eventually move the order to
  // `failed_manual_review`. Admin can resend the proof email separately.
  try {
    const emailResult = await sendProofReadyEmail(order, { reviewUrl, proofUrl });
    if (!emailResult.skipped) {
      await updateFulfillmentState(order.id, proofReleasePatch(order));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[fulfillment] proof-ready email failed for ${order.id}: ${message}`);
    // Patch only email/fulfillment diagnostics onto the latest versioned record.
    // The proof/page tuple may have been invalidated by customer review while
    // the email request was in flight and must never be replayed here.
    await updateFulfillmentState(order.id, paidFulfillmentPatch(order, {
      fulfillmentStatus: 'delivery_email_failed',
      fulfillmentLastError: `delivery_email_failed: ${message.slice(0, 500)}`,
    }));
  }
}

// ── Print production (post-approval) ──────────────────────────────────────────

async function runPrintProduction(order: OrderRecord, deps: FulfillmentDeps): Promise<void> {
  const _submitPrint = deps.submitPrint ?? submitPrintJob;
  const _upload = deps.uploadArtifact ?? defaultUploadArtifact;
  const _calculateCoverDimensions = deps.calculateCoverDimensions ?? calculateCoverDimensions;
  const _buildPrintCoverPdf = deps.buildPrintCoverPdf ?? buildPrintCoverPdf;

  // Defensive print-gate (Plan §6, §9). Until this slice the gate was
  // implied by convention — only approvePrintProof / manuallyApproveProof
  // could reach this function. We now assert the preconditions in code so
  // a future caller cannot silently skip them.
  //   - paymentStatus must be 'paid' (not 'refunded' or anything else)
  //   - fulfillmentStatus must be 'proof_approved' or 'submitting_to_print'
  //     (the latter for retries that re-enter mid-flow)
  //   - the order must not be refunded
  //   - the order must not already be in print/shipped
  if (order.paymentStatus !== 'paid') {
    throw new Error(`Refusing print: paymentStatus=${order.paymentStatus}`);
  }
  if (order.refundedAt) {
    throw new Error('Refusing print: order has been refunded');
  }
  if (order.status === 'shipped' || order.status === 'print_in_production') {
    throw new Error(`Refusing print: order.status=${order.status}`);
  }
  const fs = order.fulfillmentStatus ?? 'not_started';
  if (fs !== 'proof_approved' && fs !== 'submitting_to_print') {
    throw new Error(`Refusing print: fulfillmentStatus=${fs} — proof not approved`);
  }

  if (!order.printInteriorArtifactUrl || !order.printInteriorMd5 || !order.printInteriorPageCount || !order.printTitle) {
    throw new Error('Missing print interior artifacts — cannot submit to print without interior PDF metadata');
  }

  await updateFulfillmentState(order.id, paidFulfillmentPatch(order, { fulfillmentStatus: 'submitting_to_print' }));

  let hydratedOrder = order;
  if (!order.printCoverArtifactUrl || !order.printCoverMd5) {
    const dims = await _calculateCoverDimensions(order, order.printInteriorPageCount);
    const coverBuffer = await _buildPrintCoverPdf(dims.widthPt, dims.heightPt, order.printTitle, order);
    const safeSlug = order.childName.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
    const coverUrl = await _upload(order.id, coverBuffer, `${safeSlug}-cover.pdf`);
    hydratedOrder = (await updateFulfillmentState(order.id, paidFulfillmentPatch(order, {
      printCoverArtifactUrl: coverUrl,
      printCoverMd5: md5Hex(coverBuffer),
    }))) ?? { ...order, printCoverArtifactUrl: coverUrl, printCoverMd5: md5Hex(coverBuffer) };
  }

  const result = await _submitPrint(hydratedOrder);

  const afterPrint = await updateFulfillmentState(order.id, paidFulfillmentPatch(order, {
    fulfillmentStatus: 'complete',
    status: 'print_in_production',
    printJobId: result.jobId,
    fulfillmentLastError: null,
  }));

  await sendLifecycleEmail(afterPrint ?? { ...hydratedOrder, status: 'print_in_production' });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Entry point called from Stripe webhook after payment confirmed.
 * Fire-and-forget: errors are captured on the order record.
 */
/**
 * Rebuild the proof PDF from the latest accepted/current per-page images.
 * Call this after the customer approves the whole book OR (optionally) after
 * any individual regenerate to keep the proof URL fresh.
 */
/**
 * Stable fingerprint of the page set a proof PDF was rendered from.
 *
 * Derived from `imageUrlForPage` — the SAME helper `pageImageUrlsFromArtifacts`
 * feeds the renderer — so the fingerprint and the rendered output cannot drift.
 * Covers everything the PDF actually renders: page order, story text, and the
 * effective image URL per page. Delimiters are escapes, never raw bytes, so the
 * source stays plain ASCII while the encoding remains injective.
 *
 * Rendering is slow and necessarily happens outside any transaction; this is
 * what binds a produced artifact to the exact state it came from, so a caller
 * can refuse to publish a proof whose source moved underneath it.
 */
export function proofSourceFingerprint(
  order: Pick<OrderRecord, 'id' | 'childName' | 'bookFormat' | 'printTitle' | 'pageArtifacts'>,
  pages: PageArtifact[] = order.pageArtifacts ?? [],
): string | null {
  const story = proofStoryFromPageArtifacts(order, pages);
  if (!story) return null;
  const pageUrls = pageImageUrlsFromArtifacts(pages);
  return proofRenderSourceFingerprint({
    story,
    order,
    imageUrls: [pageUrls[0] ?? null, ...pageUrls],
  });
}

/**
 * Fail-closed discriminated union. A successful build ALWAYS carries the URL,
 * the source fingerprint and the version; there is no shape in which a caller
 * receives `ok: true` with a missing field, and the producer validates this at
 * RUNTIME rather than trusting the type checker.
 */
export type ProofBuildResult =
  | { ok: true; proofUrl: string; sourceFingerprint: string; proofVersion: string }
  | { ok: false; error: string };

/** Runtime validation of a claimed-successful build. Never trust the type. */
export function isUsableProofBuild(
  result: ProofBuildResult | null | undefined,
): result is { ok: true; proofUrl: string; sourceFingerprint: string; proofVersion: string } {
  if (!result || result.ok !== true) return false;
  const r = result as { proofUrl?: unknown; sourceFingerprint?: unknown; proofVersion?: unknown };
  return (
    typeof r.proofUrl === 'string' && r.proofUrl.length > 0 &&
    typeof r.sourceFingerprint === 'string' && r.sourceFingerprint.length > 0 &&
    typeof r.proofVersion === 'string' && r.proofVersion.length > 0
  );
}

/** Opaque, collision-resistant revision id for one proof artifact. */
export function newProofVersion(): string {
  return `pv_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

/** Immutable customer-proof path bound one-to-one to a proof revision. */
export function proofArtifactPath(proofVersion: string): string {
  return `proofs/${proofVersion}.pdf`;
}

/**
 * Render + upload a proof PDF to an IMMUTABLE, version-keyed path and persist
 * NOTHING.
 *
 * Each build lands at `orders/{orderId}/proofs/{proofVersion}.pdf`, so the
 * persisted `storyArtifactUrl` identifies the exact artifact by itself: a
 * reload, a reopen or a shared link always resolves to the bytes that were
 * acknowledged. Nothing overwrites a previously published proof, so no cache
 * buster or session-local nonce is ever load-bearing.
 *
 * Persisting the URL is the caller's responsibility and must go through a
 * conditional commit that re-checks `sourceFingerprint` against current pages.
 */
export async function buildProofArtifactFromPageArtifacts(
  orderId: string,
  deps: FulfillmentDeps = {},
): Promise<ProofBuildResult> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, error: 'order_not_found' };
  if (!order.pageArtifacts || order.pageArtifacts.length === 0) {
    return { ok: false, error: 'no_page_artifacts' };
  }

  const _buildPdf = deps.buildPdf ?? buildPdf;
  const _upload = deps.uploadArtifact ?? defaultUploadArtifact;
  const pages = order.pageArtifacts;
  const proofVersion = newProofVersion();

  const story = proofStoryFromPageArtifacts(order, pages);
  if (!story) return { ok: false, error: 'page_artifacts_incomplete' };

  const pageUrls = pageImageUrlsFromArtifacts(pages);
  const allUrls: (string | null)[] = [pageUrls[0] ?? null, ...pageUrls];
  // Fingerprint the exact production-renderer inputs before the slow render.
  const sourceFingerprint = proofRenderSourceFingerprint({ story, order, imageUrls: allUrls });

  let proofUrl: string;
  try {
    const pdfBuffer = await _buildPdf(story, order, allUrls);
    // Immutable, version-keyed path. Never reuses a published proof path.
    proofUrl = await _upload(order.id, pdfBuffer, proofArtifactPath(proofVersion));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const candidate = { ok: true, proofUrl, sourceFingerprint, proofVersion } as ProofBuildResult;
  // Fail closed: an upload that produced no usable URL — or any other way of
  // ending up without all three identity fields — is NOT a successful build.
  if (!isUsableProofBuild(candidate)) {
    return { ok: false, error: 'proof_build_incomplete' };
  }
  return candidate;
}

/**
 * Rebuild the proof and persist it with a LAST-WRITE-WINS update.
 *
 * NOT safe for concurrent callers and NOT used by the customer editable-review
 * flows, which build via `buildProofArtifactFromPageArtifacts` and publish
 * through their own conditional, fingerprint-checked commit.
 *
 * Fully guarded regardless: it can never persist a URL without the matching
 * fingerprint and version, so it cannot produce a record that passes a proof
 * gate without an identifiable artifact.
 */
export async function rebuildProofFromPageArtifacts(
  orderId: string,
  deps: FulfillmentDeps = {},
): Promise<{ ok: boolean; proofUrl?: string; error?: string }> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found' };
  if (!order.pageArtifacts || order.pageArtifacts.length === 0) {
    return { ok: false, error: 'Order has no page artifacts to rebuild from' };
  }

  const built = await buildProofArtifactFromPageArtifacts(orderId, deps);
  if (built.ok !== true) return { ok: false, error: built.error };

  // Stale-ack invalidation: a new PDF has not been acknowledged. The identity
  // fields move with the URL, so no record can carry a proof without one.
  await updateFulfillmentState(order.id, {
    storyArtifactUrl: built.proofUrl,
    proofSourceFingerprint: built.sourceFingerprint,
    proofVersion: built.proofVersion,
    proofReviewedAt: null,
    proofReviewedVersion: null,
  });
  return { ok: true, proofUrl: built.proofUrl };
}

export interface TriggerFulfillmentOptions {
  /**
   * Confirm-paid readback policy. The kickoff polls `getOrder` until it
   * observes `paymentStatus === 'paid'`. If the persistence backend
   * never converges, returns `not_paid_yet` — caller decides whether
   * to retry. Default is tight (3 × 100ms doubling = ~700ms) so the
   * caller's bounded retry loop owns the total wait budget.
   */
  readbackMaxAttempts?: number;
  readbackInitialDelayMs?: number;
}

/**
 * Discriminated result from `triggerFulfillment`. Used by the kickoff
 * helper to decide whether to retry, dedupe, or stop. The previous
 * void/log-only contract caused the 2026-05-08 race: the closure-local
 * `ran=true` was set when the scheduler fired (regardless of whether
 * fulfillment actually started), so a refused-because-not-paid-yet
 * call permanently blocked the fallback scheduler.
 *
 * Helper dedupe rule:
 *   - `started` / `skipped_already_running` / `skipped_already_complete`:
 *     real outcome — DO NOT fall through to a fallback scheduler.
 *   - `not_paid_yet`: persistence hasn't converged — CALLER MAY RETRY
 *     either via the fallback scheduler or a bounded retry loop.
 *   - `not_found`: order does not exist; not retryable.
 *
 * `runWithRetry` catches its own errors internally (moves the order to
 * failed_manual_review and returns), so no 'error' status propagates
 * out of triggerFulfillment.
 */
export type TriggerResult =
  | { status: 'started' }
  | { status: 'skipped_already_running'; fulfillmentStatus: string }
  | { status: 'skipped_already_complete'; fulfillmentStatus: string }
  | { status: 'not_paid_yet'; attempts: number }
  | { status: 'not_found' };

const DEFAULT_READBACK_MAX_ATTEMPTS = 3;
const DEFAULT_READBACK_INITIAL_DELAY_MS = 100;

/**
 * Re-read the order from authoritative persistence and only return a
 * confirmed-paid record. Returns null if the readback never converges
 * to `paymentStatus === 'paid'`, which triggers a fail-closed skip in
 * the caller. This is the gate that prevents digital generation from
 * running against a still-pending payment record.
 *
 * The webhook-triggered case ALSO has a non-empty `stripeSessionId`
 * by the time it gets here (the webhook awaited the payment write
 * before scheduling fulfillment). Admin-triggered retries may have
 * paymentStatus='paid' without a Stripe session id, which is valid —
 * we don't gate on stripeSessionId here.
 */
interface ReadbackResult {
  order: OrderRecord | null;
  attempts: number;
  notFound: boolean;
}

async function readbackUntilPaid(
  orderId: string,
  opts: TriggerFulfillmentOptions = {},
  sleep: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms)),
): Promise<ReadbackResult> {
  const maxAttempts = opts.readbackMaxAttempts ?? DEFAULT_READBACK_MAX_ATTEMPTS;
  const initialDelay = opts.readbackInitialDelayMs ?? DEFAULT_READBACK_INITIAL_DELAY_MS;
  let attempts = 0;
  let lastSeen: OrderRecord | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts++;
    const order = await getOrder(orderId);
    lastSeen = order ?? lastSeen;
    if (order && order.paymentStatus === 'paid') {
      return { order, attempts, notFound: false };
    }
    if (attempt < maxAttempts - 1) {
      await sleep(initialDelay * (2 ** attempt));
    }
  }
  // Distinguish "order doesn't exist at all" from "order exists but
  // paymentStatus hasn't converged to paid". Caller's retry policy
  // depends on the difference.
  if (!lastSeen) return { order: null, attempts, notFound: true };
  return { order: null, attempts, notFound: false };
}

export async function triggerFulfillment(
  orderId: string,
  deps: FulfillmentDeps = {},
  opts: TriggerFulfillmentOptions = {},
): Promise<TriggerResult> {
  // Observable entry: this single line is the proof-of-life that
  // triggerFulfillment was actually called from a deferred kickoff.
  // If you ever see a paid order stuck at not_started with no
  // [fulfillment] entered line in the log, the kickoff scheduler
  // (see fulfillment-kickoff.ts) failed before getting here.
  console.log(`[fulfillment] entered for ${orderId}`);

  // Confirm authoritative paid state before doing ANY work. Read-after-
  // write inconsistency on the persistence backend cannot trick us into
  // running fulfillment on a non-paid order (the 2026-05-08 retest
  // reproduced exactly that — pages generated, paymentStatus stuck
  // pending). If we never see a confirmed-paid record, return
  // not_paid_yet so the caller can retry on a wider budget.
  const readback = await readbackUntilPaid(orderId, opts, deps.sleep);
  if (readback.notFound) {
    console.error(`[fulfillment] order ${orderId} not found in persistence — refusing`);
    return { status: 'not_found' };
  }
  if (!readback.order) {
    console.warn(
      `[fulfillment] order ${orderId} payment not confirmed after ${readback.attempts} readback attempt(s) (paymentStatus !== 'paid') — caller may retry`,
    );
    return { status: 'not_paid_yet', attempts: readback.attempts };
  }
  const order = readback.order;
  console.log(
    `[fulfillment] order ${orderId} confirmed paid after ${readback.attempts} readback attempt(s) (stripeSessionId=${order.stripeSessionId ? 'present' : 'absent'}, fulfillmentStatus=${order.fulfillmentStatus ?? 'unset'})`,
  );

  // fulfillmentStatus state machine:
  //   - undefined / 'not_started' / 'failed_manual_review' → eligible to (re)start
  //   - 'complete' → already-done (idempotent skip)
  //   - 'delivery_email_failed' → artifacts already exist; full pipeline
  //       re-run would burn money on a regenerated story. Treat as
  //       skipped_already_complete so callers (e.g. webhook re-deliveries)
  //       don't trigger a wasted regeneration. Admin's `retryOrderFulfillment`
  //       handles the email-only recovery path explicitly.
  //   - any in-progress state ('generating_story', 'generating_images',
  //     'building_pdf', 'proof_ready', 'proof_approved',
  //     'submitting_to_print', 'print_in_production') → in-progress skip
  const cur = order.fulfillmentStatus;
  if (cur === 'complete') {
    console.warn(`[fulfillment] order ${orderId} already has fulfillmentStatus=complete — skipping (idempotent)`);
    return { status: 'skipped_already_complete', fulfillmentStatus: cur };
  }
  if (cur === 'delivery_email_failed') {
    console.warn(`[fulfillment] order ${orderId} has fulfillmentStatus=delivery_email_failed — artifacts already exist, use admin resend rather than re-running fulfillment`);
    return { status: 'skipped_already_complete', fulfillmentStatus: cur };
  }
  if (cur && cur !== 'not_started' && cur !== 'failed_manual_review') {
    console.warn(`[fulfillment] order ${orderId} already has fulfillmentStatus=${cur} — skipping (in progress)`);
    return { status: 'skipped_already_running', fulfillmentStatus: cur };
  }

  const isDigital = !isPrintFormat(order.bookFormat);
  console.log(`[fulfillment] starting ${isDigital ? 'digital' : 'print'} run for ${orderId}`);
  const run = isDigital
    ? (_attempt: number) => runDigitalFulfillment(order, deps)
    : (_attempt: number) => runPrintFulfillment(order, deps);

  await runWithRetry(orderId, run, deps);
  console.log(`[fulfillment] runWithRetry returned for ${orderId}`);
  return { status: 'started' };
}

/**
 * Called when customer clicks the approval link in their proof email.
 */
export async function approvePrintProof(
  orderId: string,
  token: string,
  deps: FulfillmentDeps = {},
): Promise<{ ok: boolean; error?: string }> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found' };
  if (!order.proofApprovalToken) return { ok: false, error: 'No proof pending approval' };
  const storedToken = order.proofApprovalToken ?? '';
  const tokensMatch =
    storedToken.length === token.length &&
    crypto.timingSafeEqual(Buffer.from(storedToken), Buffer.from(token));
  if (!tokensMatch) return { ok: false, error: 'Invalid approval token' };
  if (order.fulfillmentStatus === 'proof_approved' || order.fulfillmentStatus === 'submitting_to_print' || order.fulfillmentStatus === 'complete') {
    return { ok: true };
  }
  if (order.fulfillmentStatus !== 'proof_ready') {
    return { ok: false, error: `Proof is in state ${order.fulfillmentStatus} — cannot approve` };
  }

  // Use the authoritative in-memory record returned by updateFulfillmentState
  // rather than doing a second getOrder reload. The two-step variant could
  // produce a stale snapshot (read-after-write inconsistency on the blob
  // backend) where runPrintProduction's gate observed fulfillmentStatus=
  // 'proof_ready' and refused — which then burned all retry attempts and
  // pushed the order to failed_manual_review even though approval had
  // already persisted. updateFulfillmentState returns the post-write state
  // it just persisted; using it directly closes that race.
  const updatedOrder = await updateFulfillmentState(orderId, {
    fulfillmentStatus: 'proof_approved',
    proofApprovedAt: new Date().toISOString(),
  });
  if (!updatedOrder) return { ok: false, error: 'Failed to update order state' };

  await runWithRetry(
    orderId,
    () => runPrintProduction(updatedOrder, deps),
    deps,
  );

  return { ok: true };
}
