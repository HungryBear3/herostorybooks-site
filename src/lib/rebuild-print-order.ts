/**
 * Rebuild a single existing print order through the corrected
 * (slice-1 + slice-2) pipeline.
 *
 * Why this exists:
 *   The 2 production print orders that landed before slice 1 contain
 *   legacy 6-page artifacts. Slice 1 made story generation format-aware
 *   (classic 24 / premium 32 real story pages) and slice 2 added
 *   intentional matter pages to the print interior. Those orders need
 *   to be reissued from the corrected pipeline so they don't print as
 *   filler-padded short books.
 *
 * What this slice does NOT do:
 *   - touch checkout / Stripe / webhook
 *   - alter accepted-image preservation logic (a clean rebuild is the
 *     correct answer when the page count and arc both change)
 *   - submit to Lulu
 *
 * Safety contract: rebuild is allowed ONLY when the order is print
 * format, paid, and not yet submitted to Lulu / in production /
 * shipped. Anything else is refused with a structured reason.
 */

import crypto from 'node:crypto';

import {
  buildPdf as defaultBuildPdf,
  buildPrintInteriorPdf as defaultBuildPrintInteriorPdf,
  getPrintInteriorPageCount,
} from './pdf-builder.ts';
import type { GeneratedImageResult } from './image-generator.ts';
import {
  generateStoryImageResults as defaultGenerateImageResults,
  requireCompleteImageResults,
} from './image-generator.ts';
import { buildPagePrompt } from './image-prompt-builder.ts';
import {
  commitOrderConditional,
  getOrderPhotoUrl,
  getStoryPageCount,
  isPrintFormat,
  orderRequiresReferenceImage,
  readOrderVersioned,
  withBlobNamespace,
  type OrderRecord,
  type PageArtifact,
} from './orders.ts';
import {
  generateStoryWithMeta as defaultGenerateStoryWithMeta,
  type StoryWithMeta,
} from './story-generator.ts';
import type { StoryContent } from './fulfillment-types.ts';
import { NEW_PROOF_LAYOUT_VERSION } from './fulfillment-types.ts';
import { assertStoryPageSet } from './story-page-contract.ts';
import { newProofVersion, proofArtifactPath } from './fulfillment.ts';
import { proofRenderSourceFingerprint } from './review-source-identity.ts';

export type RebuildRefusalReason =
  | 'order_not_found'
  | 'not_print_format'
  | 'not_paid'
  | 'already_submitted_to_lulu'
  | 'already_in_production'
  | 'already_shipped'
  | 'order_refunded'
  | 'order_changed_during_rebuild';

export interface RebuildPlan {
  orderId: string;
  childName: string;
  bookFormat: 'classic' | 'premium' | 'digital';
  currentPageArtifactCount: number;
  currentPrintInteriorPageCount: number | null;
  targetStoryPageCount: number;
  targetInteriorPageCount: number;
  willClearPrintCover: boolean;
  willClearPrintJobId: boolean;
  willGenerateNewProofApprovalToken: boolean;
  willResetReviewState: boolean;
}

export interface RebuildSuccess {
  ok: true;
  dryRun: boolean;
  plan: RebuildPlan;
  /** Populated only when dryRun=false. */
  result?: {
    proofUrl: string;
    interiorUrl: string;
    interiorMd5: string;
    interiorPageCount: number;
    pageCount: number;
    proofApprovalToken: string;
  };
}

export interface RebuildRefusal {
  ok: false;
  reason: RebuildRefusalReason;
  detail?: string;
}

export type RebuildOutcome = RebuildSuccess | RebuildRefusal;

export interface RebuildDeps {
  generateStoryWithMeta?: (order: OrderRecord) => Promise<StoryWithMeta>;
  generateImageResults?: (
    prompts: string[],
    deps?: {
      referenceImageUrl?: string | null;
      referenceImageRequired?: boolean;
    },
  ) => Promise<GeneratedImageResult[]>;
  buildPdf?: typeof defaultBuildPdf;
  buildPrintInteriorPdf?: typeof defaultBuildPrintInteriorPdf;
  uploadArtifact?: (orderId: string, buffer: Buffer, filename: string) => Promise<string>;
  now?: () => Date;
}

// ── Pure helpers (testable without storage) ─────────────────────────────────

/**
 * Returns null when the order is safe to rebuild, or a structured
 * refusal reason otherwise. Pure — no I/O.
 */
export function checkRebuildSafety(order: OrderRecord): RebuildRefusal | null {
  if (!isPrintFormat(order.bookFormat)) {
    return { ok: false, reason: 'not_print_format', detail: `bookFormat=${order.bookFormat}` };
  }
  if (order.paymentStatus === 'refunded' || order.refundedAt || order.stripeRefundId) {
    return { ok: false, reason: 'order_refunded', detail: `paymentStatus=${order.paymentStatus}` };
  }
  if (order.paymentStatus !== 'paid') {
    return { ok: false, reason: 'not_paid', detail: `paymentStatus=${order.paymentStatus}` };
  }
  if (order.status === 'shipped') {
    return { ok: false, reason: 'already_shipped' };
  }
  if (order.status === 'print_in_production') {
    return { ok: false, reason: 'already_in_production' };
  }
  if (
    (order.printJobId && order.printJobId.length > 0)
    || order.fulfillmentStatus === 'submitting_to_print'
    || order.fulfillmentStatus === 'complete'
  ) {
    return {
      ok: false,
      reason: 'already_submitted_to_lulu',
      detail: `printJobId=${order.printJobId ?? 'null'} fulfillmentStatus=${order.fulfillmentStatus ?? 'null'}`,
    };
  }
  return null;
}

/** Build the dry-run summary describing what a rebuild WOULD do. Pure. */
export function planRebuildPrintOrder(order: OrderRecord): RebuildPlan {
  const targetStoryPageCount = getStoryPageCount(order.bookFormat);
  // Synthesize a minimal StoryContent for the page-count helper. We
  // don't need the real generated story here — getPrintInteriorPageCount
  // only reads pages.length and bookFormat.
  const syntheticStory: StoryContent = {
    title: '',
    characterDescription: '',
    pages: Array.from({ length: targetStoryPageCount }, (_, i) => ({
      pageNum: i + 1,
      sceneTitle: '',
      story: '',
      imagePrompt: '',
    })),
  };
  const targetInteriorPageCount = getPrintInteriorPageCount(syntheticStory, order);
  return {
    orderId: order.id,
    childName: order.childName,
    bookFormat: order.bookFormat,
    currentPageArtifactCount: order.pageArtifacts?.length ?? 0,
    currentPrintInteriorPageCount: order.printInteriorPageCount ?? null,
    targetStoryPageCount,
    targetInteriorPageCount,
    willClearPrintCover: Boolean(order.printCoverArtifactUrl),
    willClearPrintJobId: Boolean(order.printJobId),
    willGenerateNewProofApprovalToken: true,
    willResetReviewState: true,
  };
}

// ── Persistence (slim local helper to avoid widening FulfillmentPatch) ──────

function md5Hex(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

// ── Orchestration ───────────────────────────────────────────────────────────

export async function rebuildPrintOrder(
  orderId: string,
  opts: { dryRun?: boolean } = {},
  deps: RebuildDeps = {},
): Promise<RebuildOutcome> {
  const versioned = await readOrderVersioned(orderId);
  if (!versioned) {
    return { ok: false, reason: 'order_not_found', detail: orderId };
  }
  const { order, version: startingVersion } = versioned;

  const refusal = checkRebuildSafety(order);
  if (refusal) return refusal;

  const plan = planRebuildPrintOrder(order);
  if (opts.dryRun) {
    return { ok: true, dryRun: true, plan };
  }

  // ── Real rebuild ──
  const _generateStoryWithMeta = deps.generateStoryWithMeta ?? defaultGenerateStoryWithMeta;
  const _generateImageResults = deps.generateImageResults ?? defaultGenerateImageResults;
  const _buildPdf = deps.buildPdf ?? defaultBuildPdf;
  const _buildPrintInteriorPdf = deps.buildPrintInteriorPdf ?? defaultBuildPrintInteriorPdf;
  const _upload = deps.uploadArtifact ?? defaultUploadArtifact;
  const now = (deps.now ?? (() => new Date()))();

  const { story, meta: storyMeta } = await _generateStoryWithMeta(order);

  // Image generation — long-form story now means N images per print order.
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
  const referenceImageUrl = getOrderPhotoUrl(order);
  const imageResults = requireCompleteImageResults(
    await _generateImageResults(imagePrompts, {
      referenceImageUrl,
      referenceImageRequired: orderRequiresReferenceImage(order),
    }),
    story.pages.length,
    'print_rebuild',
  );

  // Clean rebuild: discard prior pageArtifacts. The legacy 6-page artifacts
  // do not map onto the new long-form arc (different scenes, different
  // page indices), and the slice 3 contract chooses correctness over
  // partial preservation. Customers re-approve the fresh proof.
  const newPageArtifacts: PageArtifact[] = story.pages.map((page, i): PageArtifact => {
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
              createdAt: now.toISOString(),
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

  const allUrls: (string | null)[] = [
    imageResults[0]?.imageUrl ?? null,
    ...imageResults.map((r) => r.imageUrl),
  ];

  // Build BOTH artifacts: the customer-facing proof (buildPdf) AND the
  // print interior that goes to Lulu (buildPrintInteriorPdf). The slice
  // 2 print interior renderer is what introduces the matter pages and
  // reduces filler — that's the fix we're delivering to these orders.
  // Fail closed: the rebuilt page set must satisfy the book contract before we
  // publish a proof/interior or move the order to preview_ready. This is the
  // exact defect that produced a 6-page/14-page partial — a short regenerated
  // set now aborts the rebuild instead of shipping.
  assertStoryPageSet(newPageArtifacts, order.bookFormat, NEW_PROOF_LAYOUT_VERSION);
  const orderForBuild = { ...order, layoutVersion: NEW_PROOF_LAYOUT_VERSION };
  const proofBuffer = await _buildPdf(story, orderForBuild, allUrls);
  const interiorBuffer = await _buildPrintInteriorPdf(story, orderForBuild, allUrls);

  const proofVersion = newProofVersion();
  const proofUrl = await _upload(order.id, proofBuffer, proofArtifactPath(proofVersion));
  const interiorUrl = await _upload(order.id, interiorBuffer, `interiors/${proofVersion}.pdf`);
  const proofSourceFingerprint = proofRenderSourceFingerprint({ story, order, imageUrls: allUrls });
  const interiorMd5 = md5Hex(interiorBuffer);
  const interiorPageCount = getPrintInteriorPageCount(story, order);

  const proofApprovalToken = crypto.randomBytes(24).toString('hex');

  // Persist the full rebuild as a single read-modify-write so partial
  // intermediate state doesn't leak. We deliberately go through
  // persistOrder rather than updateFulfillmentState so we can clear
  // multiple non-FulfillmentPatch fields (e.g., printCoverArtifactUrl)
  // and explicitly null the printJobId/Status fields in one write.
  const updated: OrderRecord = {
    ...order,
    storyArtifactUrl: proofUrl,
    proofSourceFingerprint,
    proofVersion,
    layoutVersion: NEW_PROOF_LAYOUT_VERSION,
    storyMeta,
    printInteriorArtifactUrl: interiorUrl,
    printInteriorMd5: interiorMd5,
    printInteriorPageCount: interiorPageCount,
    printTitle: story.title,
    // Force cover regeneration on next print submission — old cover
    // dimensions were calculated against the wrong interior page count.
    printCoverArtifactUrl: null,
    printCoverMd5: null,
    // Clear any existing print-job state. Safety check above already
    // refused if a real Lulu job was in flight, so these should be null
    // anyway — being explicit guards against future safety regressions.
    printJobId: null,
    printJobStatus: null,
    pageArtifacts: newPageArtifacts,
    reviewStatus: 'in_review',
    proofApprovalToken,
    proofApprovedAt: null,
    proofReviewedAt: null,
    proofReviewedVersion: null,
    fulfillmentStatus: 'proof_ready',
    fulfillmentAttempts: 0,
    fulfillmentLastError: null,
    status: 'preview_ready',
    auditEvents: [
      ...(order.auditEvents ?? []),
      {
        at: now.toISOString(),
        type: 'proof_rebuilt',
        reason: 'rebuild_print_order',
        meta: {
          bookFormat: order.bookFormat,
          previousPageCount: order.pageArtifacts?.length ?? 0,
          newPageCount: newPageArtifacts.length,
          newInteriorPageCount: interiorPageCount,
        },
      },
    ],
    updatedAt: now.toISOString(),
  };
  const committed = await commitOrderConditional(updated, startingVersion);
  if (!committed.ok) {
    return { ok: false, reason: 'order_changed_during_rebuild' };
  }

  return {
    ok: true,
    dryRun: false,
    plan,
    result: {
      proofUrl,
      interiorUrl,
      interiorMd5,
      interiorPageCount,
      pageCount: newPageArtifacts.length,
      proofApprovalToken,
    },
  };
}

// ── Default upload (mirrors fulfillment.ts) ─────────────────────────────────

export async function defaultUploadArtifact(
  orderId: string,
  buffer: Buffer,
  filename: string,
): Promise<string> {
  const { put } = await import('@vercel/blob');
  const { withBlobNamespace } = await import('./orders.ts');
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
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const dir = path.join(process.cwd(), '.data', 'artifacts', orderId);
  const filePath = path.join(dir, filename);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer, { flag: 'wx' });
  const base = process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:3000';
  return `${base}/api/order/${orderId}/artifact/${filename}`;
}
