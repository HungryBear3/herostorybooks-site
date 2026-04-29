import crypto from 'node:crypto';
import { put } from '@vercel/blob';

import { appendAuditEvent, getOrder, getOrderPhotoUrl, isPrintFormat, updateFulfillmentState, withBlobNamespace } from './orders.ts';
import { buildPagePrompt } from './image-prompt-builder.ts';
import type { OrderRecord } from './orders.ts';
import type { StoryContent } from './fulfillment-types.ts';
import { generateStory, generateStoryWithMeta } from './story-generator.ts';
import type { StoryWithMeta } from './story-generator.ts';
import { generateStoryImageResults } from './image-generator.ts';
import type { GeneratedImageResult } from './image-generator.ts';
import { buildPdf, buildPrintCoverPdf, buildPrintInteriorPdf, getPrintInteriorPageCount } from './pdf-builder.ts';
import { calculateCoverDimensions, submitPrintJob } from './lulu.ts';
import { sendDigitalDeliveryEmail, sendProofReadyEmail, sendLifecycleEmail, sendOperatorFailureAlert } from './order-email.ts';

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

// ── Default implementations ───────────────────────────────────────────────────

async function defaultUploadArtifact(orderId: string, buffer: Buffer, filename: string): Promise<string> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    const blob = await put(withBlobNamespace(`orders/${orderId}/${filename}`), buffer, {
      access: 'public',
      contentType: 'application/pdf',
      addRandomSuffix: false,
      token,
    });
    return blob.url;
  }
  // Local fallback: write to .data/artifacts/ and return a path-based URL
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const dir = path.join(process.cwd(), '.data', 'artifacts', orderId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await writeFile(filePath, buffer);
  const base = process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:3000';
  return `${base}/api/order/${orderId}/artifact/${filename}`;
}

function defaultGetBaseUrl(): string {
  return process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:3000';
}

function md5Hex(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
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
  // Real default path: try photo-conditioned FAL when we have a photo URL,
  // else text-only. Fallback chain inside generatePageImage handles the rest.
  const referenceImageUrl = getOrderPhotoUrl(order);
  return generateStoryImageResults(imagePrompts, { referenceImageUrl });
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

  await updateFulfillmentState(order.id, { fulfillmentStatus: 'generating_story' });
  const { story, meta: storyMeta } = await runStoryGeneration(order, deps);
  // Persist storyMeta as soon as it's known so diagnostics can answer
  // "which story path ran?" even before image gen completes.
  await updateFulfillmentState(order.id, { storyMeta });

  await updateFulfillmentState(order.id, { fulfillmentStatus: 'generating_images' });
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
    }),
  );
  const imageResults = await runImageGeneration(imagePrompts, order, deps);
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
  // below re-writes the same array (idempotent) plus the proof URL.
  await updateFulfillmentState(order.id, { pageArtifacts: seededPageArtifacts });

  await updateFulfillmentState(order.id, { fulfillmentStatus: 'building_pdf' });
  // Include cover image (first imageUrl) + per-page images
  const allUrls: (string | null)[] = [imageUrls[0] ?? null, ...imageUrls];
  const pdfBuffer = await _buildPdf(story, order, allUrls);

  const safeSlug = order.childName.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
  const filename = `${safeSlug}-storybook.pdf`;
  const pdfUrl = await _upload(order.id, pdfBuffer, filename);

  await updateFulfillmentState(order.id, {
    fulfillmentStatus: 'complete',
    status: 'preview_ready',
    storyArtifactUrl: pdfUrl,
    pageArtifacts: seededPageArtifacts,
    reviewStatus: 'in_review',
    fulfillmentAttempts: 0,
    fulfillmentLastError: null,
  });
  await appendAuditEvent(order.id, {
    type: 'proof_generated',
    meta: { bookFormat: order.bookFormat, pageCount: seededPageArtifacts.length },
  });

  await sendDigitalDeliveryEmail(order, { pdfUrl });
}

// ── Print fulfillment ─────────────────────────────────────────────────────────

async function runPrintFulfillment(order: OrderRecord, deps: FulfillmentDeps): Promise<void> {
  const _buildPdf = deps.buildPdf ?? buildPdf;
  const _buildPrintInteriorPdf = deps.buildPrintInteriorPdf ?? buildPrintInteriorPdf;
  const _upload = deps.uploadArtifact ?? defaultUploadArtifact;
  const _getBaseUrl = deps.getBaseUrl ?? defaultGetBaseUrl;

  await updateFulfillmentState(order.id, { fulfillmentStatus: 'generating_story' });
  const { story, meta: storyMeta } = await runStoryGeneration(order, deps);
  await updateFulfillmentState(order.id, { storyMeta });

  await updateFulfillmentState(order.id, { fulfillmentStatus: 'generating_images' });
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
    }),
  );
  const imageResults = await runImageGeneration(imagePrompts, order, deps);
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
  await updateFulfillmentState(order.id, { pageArtifacts: seededPageArtifacts });

  await updateFulfillmentState(order.id, { fulfillmentStatus: 'building_pdf' });
  const allUrls: (string | null)[] = [imageUrls[0] ?? null, ...imageUrls];
  const previewBuffer = await _buildPdf(story, order, allUrls);
  const interiorBuffer = await _buildPrintInteriorPdf(story, order, allUrls);

  const safeSlug = order.childName.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
  const proofUrl = await _upload(order.id, previewBuffer, `${safeSlug}-proof.pdf`);
  const interiorUrl = await _upload(order.id, interiorBuffer, `${safeSlug}-interior.pdf`);

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

  await updateFulfillmentState(order.id, {
    fulfillmentStatus: 'proof_ready',
    status: 'preview_ready',
    storyArtifactUrl: proofUrl,
    printInteriorArtifactUrl: interiorUrl,
    printInteriorMd5: md5Hex(interiorBuffer),
    printInteriorPageCount: interiorPageCount,
    printTitle: story.title,
    printCoverArtifactUrl: null,
    printCoverMd5: null,
    pageArtifacts: seededPageArtifacts,
    reviewStatus: 'in_review',
    proofApprovalToken,
    fulfillmentAttempts: 0,
    fulfillmentLastError: null,
  });
  await appendAuditEvent(order.id, {
    type: 'proof_generated',
    meta: { bookFormat: order.bookFormat, pageCount: seededPageArtifacts.length },
  });

  await sendProofReadyEmail(order, { reviewUrl, proofUrl });
}

// ── Print production (post-approval) ──────────────────────────────────────────

async function runPrintProduction(order: OrderRecord, deps: FulfillmentDeps): Promise<void> {
  const _submitPrint = deps.submitPrint ?? submitPrintJob;
  const _upload = deps.uploadArtifact ?? defaultUploadArtifact;
  const _calculateCoverDimensions = deps.calculateCoverDimensions ?? calculateCoverDimensions;
  const _buildPrintCoverPdf = deps.buildPrintCoverPdf ?? buildPrintCoverPdf;

  if (!order.printInteriorArtifactUrl || !order.printInteriorMd5 || !order.printInteriorPageCount || !order.printTitle) {
    throw new Error('Missing print interior artifacts — cannot submit to print without interior PDF metadata');
  }

  await updateFulfillmentState(order.id, { fulfillmentStatus: 'submitting_to_print' });

  let hydratedOrder = order;
  if (!order.printCoverArtifactUrl || !order.printCoverMd5) {
    const dims = await _calculateCoverDimensions(order, order.printInteriorPageCount);
    const coverBuffer = _buildPrintCoverPdf(dims.widthPt, dims.heightPt, order.printTitle, order);
    const safeSlug = order.childName.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
    const coverUrl = await _upload(order.id, coverBuffer, `${safeSlug}-cover.pdf`);
    hydratedOrder = (await updateFulfillmentState(order.id, {
      printCoverArtifactUrl: coverUrl,
      printCoverMd5: md5Hex(coverBuffer),
    })) ?? { ...order, printCoverArtifactUrl: coverUrl, printCoverMd5: md5Hex(coverBuffer) };
  }

  const result = await _submitPrint(hydratedOrder);

  const afterPrint = await updateFulfillmentState(order.id, {
    fulfillmentStatus: 'complete',
    status: 'print_in_production',
    printJobId: result.jobId,
    fulfillmentLastError: null,
  });

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
export async function rebuildProofFromPageArtifacts(
  orderId: string,
  deps: FulfillmentDeps = {},
): Promise<{ ok: boolean; proofUrl?: string; error?: string }> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, error: 'Order not found' };
  if (!order.pageArtifacts || order.pageArtifacts.length === 0) {
    return { ok: false, error: 'Order has no page artifacts to rebuild from' };
  }

  const _generateStory = deps.generateStory ?? generateStory;
  const _buildPdf = deps.buildPdf ?? buildPdf;
  const _upload = deps.uploadArtifact ?? defaultUploadArtifact;

  // We need a StoryContent shape for the PDF builder. Reconstruct it from artifacts.
  const story: StoryContent = await (async () => {
    // Prefer a fresh story regeneration ONLY if we don't have stored text — otherwise
    // reuse what's persisted to keep deterministic output.
    const haveAllText = order.pageArtifacts!.every((p) => p.storyText && p.basePrompt);
    if (haveAllText) {
      return {
        title: order.printTitle ?? `${order.childName}'s Hero Story Book`,
        characterDescription: '',
        pages: order.pageArtifacts!.map((p) => ({
          pageNum: p.pageIndex + 1,
          sceneTitle: '',
          story: p.storyText,
          imagePrompt: p.basePrompt,
        })),
      };
    }
    return _generateStory(order);
  })();

  const pageUrls = pageImageUrlsFromArtifacts(order.pageArtifacts);
  const allUrls: (string | null)[] = [pageUrls[0] ?? null, ...pageUrls];

  const pdfBuffer = await _buildPdf(story, order, allUrls);
  const safeSlug = order.childName.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
  const proofUrl = await _upload(order.id, pdfBuffer, `${safeSlug}-proof.pdf`);

  // Stale-ack invalidation: every successful rebuild produces a NEW PDF the
  // customer has not yet acknowledged. Clearing proofReviewedAt forces the
  // approve-whole-book gate to require a fresh ack against the new proof.
  // approveWholeBook reads proofReviewedAt BEFORE calling this rebuild, so
  // its in-progress happy path is unaffected — the clear only impacts
  // subsequent approval attempts.
  await updateFulfillmentState(order.id, {
    storyArtifactUrl: proofUrl,
    proofReviewedAt: null,
  });
  return { ok: true, proofUrl };
}

export async function triggerFulfillment(
  orderId: string,
  deps: FulfillmentDeps = {},
): Promise<void> {
  const order = await getOrder(orderId);
  if (!order) {
    console.error(`[fulfillment] order ${orderId} not found`);
    return;
  }

  if (order.paymentStatus !== 'paid') {
    console.error(`[fulfillment] order ${orderId} not paid — skipping fulfillment`);
    return;
  }

  if (
    order.fulfillmentStatus &&
    order.fulfillmentStatus !== 'not_started' &&
    order.fulfillmentStatus !== 'failed_manual_review'
  ) {
    console.warn(`[fulfillment] order ${orderId} already has fulfillmentStatus=${order.fulfillmentStatus} — skipping`);
    return;
  }

  const isDigital = !isPrintFormat(order.bookFormat);
  const run = isDigital
    ? (attempt: number) => runDigitalFulfillment(order, deps)
    : (attempt: number) => runPrintFulfillment(order, deps);

  await runWithRetry(orderId, run, deps);
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

  await updateFulfillmentState(orderId, {
    fulfillmentStatus: 'proof_approved',
    proofApprovedAt: new Date().toISOString(),
  });

  const updatedOrder = await getOrder(orderId);
  if (!updatedOrder) return { ok: false, error: 'Failed to reload order' };

  await runWithRetry(
    orderId,
    () => runPrintProduction(updatedOrder, deps),
    deps,
  );

  return { ok: true };
}
