/**
 * Provenance manifest + release/print guards for the Generation Operating
 * Policy. Pure module — no broker, network, secret, or order-store
 * dependencies. Consumed by `releaseOrderAfterQa` and `runPrintProduction`.
 *
 * Design:
 *
 *  - `buildManifest(order)` produces a JSON-serializable manifest that
 *    combines existing OrderRecord/PageArtifact/StoryMeta fields with the
 *    additive Generation Operating Policy fields, derived where possible
 *    (e.g. `qaStatus` defaults to 'passed' when `qaPassAt` is set).
 *
 *  - `validateManifest(manifest)` returns a `ManifestValidation` with the
 *    full list of issues. Empty issues + `complete=true` is the only
 *    state that can pass a customer release.
 *
 *  - `evaluateReleaseGuard(order, opts)` builds the manifest, applies the
 *    full release policy (template story, fixture asset, missing lineage,
 *    QA-not-passed, emergency-approval-missing) and returns a single
 *    named-error result.
 *
 *  - `evaluatePrintGuard(order, opts)` re-checks customer approval plus
 *    every release-time condition independently of the release path. This
 *    is the policy-mandated "print submission must independently re-check"
 *    requirement (§6).
 *
 * Hash integrity TODO: `manifestHash` is computed deterministically from
 * the canonical-keyed manifest payload using SHA-256 when feasible. If
 * the runtime lacks `crypto.createHash`, the field is omitted and the
 * validator still passes on completeness.
 */
import { createHash } from 'node:crypto';

import type { OrderRecord, PageArtifact, ReviewAuditEvent } from './orders.ts';
import type { StoryMeta } from './fulfillment-types.ts';
import {
  type GenerationPolicyConfig,
  type GenerationRoute,
  loadGenerationPolicyConfig,
  pageProviderToRoute,
  storySourceToRoute,
} from './generation-policy.ts';

export type ReleaseFailureCode =
  | 'MISSING_LINEAGE'
  | 'TEMPLATE_STORY_BLOCKED'
  | 'FIXTURE_ASSET_BLOCKED'
  | 'QA_NOT_PASSED'
  | 'EMERGENCY_APPROVAL_MISSING'
  | 'MANIFEST_INCOMPLETE'
  | 'PROVIDER_ROUTE_BLOCKED'
  | 'PAYMENT_NOT_CONFIRMED'
  | 'ORDER_NOT_FOUND'
  | 'NO_ARTIFACT';

export type PrintFailureCode =
  | 'CUSTOMER_APPROVAL_REQUIRED'
  | 'PRINT_QA_GUARD_FAILED'
  | 'PRINT_MANIFEST_INVALID'
  | 'PRINT_LINEAGE_INVALID'
  | 'PRINT_STATE_INVALID'
  | 'PRINT_PAYMENT_INVALID';

export interface ManifestPage {
  pageId: string;
  pageIndex: number;
  imageProvider: string | null;
  imageModel: string | null;
  imageFallbackUsed: boolean;
  imageFallbackReason: string | null;
  assetSource: string;
  /** True when the page provider matches an allowed route under the policy
   *  (OPENAI_MANUAL/OPENAI_API/FAL+approval/SEEDREAM+approval). */
  routeAllowed: boolean;
  /** When routeAllowed is false, the failure code explains why. */
  routeFailureCode?: ReleaseFailureCode;
  likenessScoreOrFlag: string | number | boolean | null;
  hasImage: boolean;
}

export interface ManifestStory {
  storyProvider: string | null;
  storyModel: string | null;
  storyFallbackUsed: boolean;
  storyFallbackReason: string | null;
  generatedBy: string | null;
  promptRevisionId: string | null;
  attemptResult: string | null;
  /** True when the story source is in the allow-list for paid release. */
  routeAllowed: boolean;
  routeFailureCode?: ReleaseFailureCode;
}

export interface OrderManifest {
  orderId: string;
  paid: boolean;
  bookFormat: OrderRecord['bookFormat'];
  isPrint: boolean;
  qaStatus: 'pending' | 'passed' | 'blocked';
  qaReviewer: string | null;
  qaBlockedReason: string | null;
  qaPassAt: string | null;
  customerProofReleasedAt: string | null;
  printApprovedAt: string | null;
  printSubmittedAt: string | null;
  manualInterventionRequired: boolean;
  emergencyOverrideUsed: boolean;
  emergencyApprovedBy: string | null;
  emergencyApprovalRef: string | null;
  sourcePhotoPresent: boolean;
  personalizationInputsPresent: boolean;
  hasArtifact: boolean;
  story: ManifestStory;
  pages: ManifestPage[];
  /** True when all required fields are populated AND no per-page lineage
   *  is missing. Does NOT validate policy compliance — see
   *  `evaluateReleaseGuard` for that. */
  complete: boolean;
  /** SHA-256 over the canonical-keyed manifest payload, or null if not
   *  computed. */
  manifestHash: string | null;
}

export interface ManifestValidation {
  complete: boolean;
  issues: string[];
}

export interface ReleaseGuardResult {
  ok: boolean;
  /** Named failure code when ok=false. */
  failureCode?: ReleaseFailureCode;
  /** Operator-readable message. */
  message?: string;
  manifest: OrderManifest;
}

export interface PrintGuardResult {
  ok: boolean;
  failureCode?: PrintFailureCode;
  message?: string;
  manifest: OrderManifest;
  /** When the underlying release guard failed, the release failure code
   *  is bubbled up for transparency. */
  underlyingReleaseFailure?: ReleaseFailureCode;
}

const ALLOWED_NON_EMERGENCY_PROVIDERS: ReadonlySet<string> = new Set([
  'openai',
  'openai_manual',
  'manual',
  'abby',
]);
const FIXTURE_ASSET_SOURCES: ReadonlySet<string> = new Set([
  'fixture',
  'sample',
  'internal',
]);

function isPaidOrder(order: OrderRecord): boolean {
  return order.paymentStatus === 'paid' && !order.refundedAt;
}

function buildManifestPage(page: PageArtifact, paid: boolean): ManifestPage {
  const pageId = page.pageId ?? `page_${page.pageIndex}`;
  const provider = page.generationProvider ?? null;
  const model = page.generationModel ?? null;
  const assetSource = (page.assetSource ?? 'live').toString();
  const hasImage = Boolean(page.currentImageUrl);
  const fallbackUsed = page.imageFallbackUsed === true;
  const fallbackReason = page.imageFallbackReason ?? null;
  let routeAllowed = true;
  let routeFailureCode: ReleaseFailureCode | undefined;
  if (paid) {
    if (provider == null) {
      routeAllowed = false;
      routeFailureCode = 'MISSING_LINEAGE';
    } else if (FIXTURE_ASSET_SOURCES.has(assetSource)) {
      routeAllowed = false;
      routeFailureCode = 'FIXTURE_ASSET_BLOCKED';
    } else if (!ALLOWED_NON_EMERGENCY_PROVIDERS.has(provider.toLowerCase())) {
      // Any non-OpenAI provider requires emergency approval — order-level
      // check elsewhere. Mark route as conditional here.
      routeAllowed = false;
      routeFailureCode = 'EMERGENCY_APPROVAL_MISSING';
    }
  }
  return {
    pageId,
    pageIndex: page.pageIndex,
    imageProvider: provider,
    imageModel: model,
    imageFallbackUsed: fallbackUsed,
    imageFallbackReason: fallbackReason,
    assetSource,
    routeAllowed,
    routeFailureCode,
    likenessScoreOrFlag: page.likenessScoreOrFlag ?? null,
    hasImage,
  };
}

function buildManifestStory(storyMeta: StoryMeta | null | undefined, paid: boolean): ManifestStory {
  const source = storyMeta?.source ?? null;
  const provider = storyMeta?.storyProvider ?? storySourceFamily(source);
  const model = storyMeta?.storyModel ?? storyMeta?.model ?? null;
  const fallbackUsed = Boolean(
    storyMeta?.storyFallbackUsed ?? source === 'template_after_openai_failure',
  );
  const fallbackReason = storyMeta?.storyFallbackReason ?? storyMeta?.fallbackError ?? null;
  let routeAllowed = true;
  let routeFailureCode: ReleaseFailureCode | undefined;
  if (paid) {
    if (!source) {
      routeAllowed = false;
      routeFailureCode = 'MISSING_LINEAGE';
    } else if (source === 'template' || source === 'template_after_openai_failure') {
      routeAllowed = false;
      routeFailureCode = 'TEMPLATE_STORY_BLOCKED';
    }
  }
  return {
    storyProvider: provider,
    storyModel: model,
    storyFallbackUsed: fallbackUsed,
    storyFallbackReason: fallbackReason,
    generatedBy: storyMeta?.generatedBy ?? null,
    promptRevisionId: storyMeta?.promptRevisionId ?? null,
    attemptResult: storyMeta?.attemptResult ?? null,
    routeAllowed,
    routeFailureCode,
  };
}

function storySourceFamily(source: string | null | undefined): string | null {
  if (!source) return null;
  if (source.startsWith('openai')) return 'openai';
  if (source.startsWith('gemini')) return 'gemini';
  if (source.startsWith('ollama')) return 'ollama';
  if (source === 'template' || source === 'template_after_openai_failure') return 'template';
  return source;
}

function inferPersonalizationInputs(order: OrderRecord): boolean {
  if (order.personalizationInputsPresent != null) {
    return order.personalizationInputsPresent === true;
  }
  if (!order.childName?.trim()) return false;
  return Boolean(
    (order.theme ?? '').trim() ||
      (order.lesson ?? '').trim() ||
      (order.occasion ?? '').trim() ||
      order.voiceTranscript?.transcript ||
      order.voiceTranscript?.inspiration,
  );
}

function inferSourcePhotoPresent(order: OrderRecord): boolean {
  if (order.sourcePhotoPresent != null) {
    return order.sourcePhotoPresent === true;
  }
  return Boolean(order.photoBlobUrl || order.photoBlobPath || order.photoFileName);
}

function computeManifestHash(payload: Record<string, unknown>): string | null {
  try {
    const canonical = JSON.stringify(sortKeys(payload));
    return createHash('sha256').update(canonical).digest('hex');
  } catch {
    return null;
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys(obj[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Build a JSON-serializable manifest from an order. Uses existing fields
 * + the additive Generation Operating Policy fields. Does not mutate.
 */
export function buildManifest(order: OrderRecord): OrderManifest {
  const paid = isPaidOrder(order);
  const isPrint = order.bookFormat === 'classic' || order.bookFormat === 'premium';
  const pages = (order.pageArtifacts ?? []).map((p) => buildManifestPage(p, paid));
  const story = buildManifestStory(order.storyMeta ?? null, paid);
  const personalizationInputsPresent = inferPersonalizationInputs(order);
  const sourcePhotoPresent = inferSourcePhotoPresent(order);
  const qaStatus: OrderManifest['qaStatus'] =
    order.qaStatus ?? (order.qaPassAt ? 'passed' : order.qaBlockedReason ? 'blocked' : 'pending');
  const qaReviewer = order.qaReviewer ?? order.qaPassBy ?? null;
  const printApprovedAt = order.printApprovedAt ?? order.proofApprovedAt ?? null;
  const printSubmittedAt = order.printSubmittedAt ?? (order.printJobId ? order.shippedAt ?? null : null);
  const customerProofReleasedAt = order.customerProofReleasedAt ?? null;
  const hasArtifact = Boolean(order.storyArtifactUrl);

  // Pre-hash payload — exclude derived fields that would create a hash
  // circular dependency on themselves.
  const hashPayload: Record<string, unknown> = {
    orderId: order.id,
    paid,
    bookFormat: order.bookFormat,
    qaStatus,
    qaReviewer,
    qaPassAt: order.qaPassAt ?? null,
    customerProofReleasedAt,
    printApprovedAt,
    printSubmittedAt,
    emergencyOverrideUsed: order.emergencyOverrideUsed === true,
    emergencyApprovedBy: order.emergencyApprovedBy ?? null,
    emergencyApprovalRef: order.emergencyApprovalRef ?? null,
    sourcePhotoPresent,
    personalizationInputsPresent,
    hasArtifact,
    story: {
      storyProvider: story.storyProvider,
      storyModel: story.storyModel,
      storyFallbackUsed: story.storyFallbackUsed,
    },
    pages: pages.map((p) => ({
      pageId: p.pageId,
      pageIndex: p.pageIndex,
      imageProvider: p.imageProvider,
      imageModel: p.imageModel,
      imageFallbackUsed: p.imageFallbackUsed,
      assetSource: p.assetSource,
    })),
  };

  const manifest: OrderManifest = {
    orderId: order.id,
    paid,
    bookFormat: order.bookFormat,
    isPrint,
    qaStatus,
    qaReviewer,
    qaBlockedReason: order.qaBlockedReason ?? null,
    qaPassAt: order.qaPassAt ?? null,
    customerProofReleasedAt,
    printApprovedAt,
    printSubmittedAt,
    manualInterventionRequired: order.manualInterventionRequired === true,
    emergencyOverrideUsed: order.emergencyOverrideUsed === true,
    emergencyApprovedBy: order.emergencyApprovedBy ?? null,
    emergencyApprovalRef: order.emergencyApprovalRef ?? null,
    sourcePhotoPresent,
    personalizationInputsPresent,
    hasArtifact,
    story,
    pages,
    complete: false, // overwritten below
    manifestHash: order.manifestHash ?? computeManifestHash(hashPayload),
  };

  const validation = validateManifest(manifest);
  manifest.complete = validation.complete;
  return manifest;
}

/**
 * Deterministic completeness validator — used by both release + print
 * guards. Does NOT enforce route allow-lists (those are checked in
 * `evaluateReleaseGuard`).
 */
export function validateManifest(manifest: OrderManifest): ManifestValidation {
  const issues: string[] = [];
  if (!manifest.hasArtifact) issues.push('storyArtifactUrl missing');
  if (manifest.pages.length === 0) issues.push('no page artifacts');
  for (const p of manifest.pages) {
    if (!p.hasImage) issues.push(`${p.pageId} missing currentImageUrl`);
    if (manifest.paid && p.imageProvider == null) issues.push(`${p.pageId} missing imageProvider`);
  }
  if (manifest.paid) {
    if (!manifest.sourcePhotoPresent) issues.push('paid order missing source photo');
    if (!manifest.personalizationInputsPresent) issues.push('paid order missing personalization inputs');
  }
  return { complete: issues.length === 0, issues };
}

/**
 * Evaluate the customer-release guard. Returns a single named failure code
 * or ok=true. Caller should append a `proof_release_failed` audit event on
 * failure (per policy §11).
 */
export function evaluateReleaseGuard(
  order: OrderRecord,
  opts: { config?: GenerationPolicyConfig } = {},
): ReleaseGuardResult {
  const manifest = buildManifest(order);
  const config = opts.config; // unused at present; reserved for future per-config tightening

  // Payment + artifact preconditions (also covered by releaseOrderAfterQa,
  // but checked here so the guard is reusable from any boundary).
  if (!manifest.paid) {
    return {
      ok: false,
      failureCode: 'PAYMENT_NOT_CONFIRMED',
      message: 'Cannot release: payment not confirmed or refunded',
      manifest,
    };
  }
  if (!manifest.hasArtifact) {
    return {
      ok: false,
      failureCode: 'NO_ARTIFACT',
      message: 'Cannot release: storyArtifactUrl missing',
      manifest,
    };
  }

  // Story-level: template fallback never ships to a paying customer.
  if (!manifest.story.routeAllowed) {
    return {
      ok: false,
      failureCode: manifest.story.routeFailureCode ?? 'TEMPLATE_STORY_BLOCKED',
      message: `Story route not allowed: ${manifest.story.storyProvider ?? 'unknown'} (storyFallbackUsed=${manifest.story.storyFallbackUsed})`,
      manifest,
    };
  }

  // Per-page lineage + asset source.
  for (const p of manifest.pages) {
    if (p.imageProvider == null) {
      return {
        ok: false,
        failureCode: 'MISSING_LINEAGE',
        message: `Page ${p.pageId} missing imageProvider`,
        manifest,
      };
    }
    if (FIXTURE_ASSET_SOURCES.has(p.assetSource)) {
      return {
        ok: false,
        failureCode: 'FIXTURE_ASSET_BLOCKED',
        message: `Page ${p.pageId} has assetSource=${p.assetSource} — fixture/sample/internal assets are blocked for paid orders`,
        manifest,
      };
    }
    if (!p.routeAllowed) {
      // Emergency provider on a page without order-level approval fields.
      if (
        p.routeFailureCode === 'EMERGENCY_APPROVAL_MISSING' &&
        manifest.emergencyOverrideUsed &&
        manifest.emergencyApprovedBy &&
        manifest.emergencyApprovalRef
      ) {
        // Order-level approval present — page provider permitted under
        // emergency route. Continue.
        continue;
      }
      return {
        ok: false,
        failureCode: p.routeFailureCode ?? 'PROVIDER_ROUTE_BLOCKED',
        message: `Page ${p.pageId} provider ${p.imageProvider} requires emergency approval (set emergencyApprovedBy + emergencyApprovalRef)`,
        manifest,
      };
    }
  }

  // QA gate.
  if (manifest.qaStatus !== 'passed') {
    return {
      ok: false,
      failureCode: 'QA_NOT_PASSED',
      message: `QA status is ${manifest.qaStatus} — qaPassAt required before release`,
      manifest,
    };
  }
  if (!manifest.qaReviewer || !manifest.qaReviewer.trim()) {
    return {
      ok: false,
      failureCode: 'QA_NOT_PASSED',
      message: 'QA passed but qaReviewer is missing',
      manifest,
    };
  }

  // Manifest completeness — final structural gate.
  if (!manifest.complete) {
    const validation = validateManifest(manifest);
    return {
      ok: false,
      failureCode: 'MANIFEST_INCOMPLETE',
      message: `Manifest incomplete: ${validation.issues.join('; ')}`,
      manifest,
    };
  }

  void config; // referenced for the future-tightening hook
  return { ok: true, manifest };
}

/**
 * Print-submission guard — independent from the release guard but
 * verifies that the release guard would still pass. Adds the customer-
 * approval timestamp check.
 */
export function evaluatePrintGuard(order: OrderRecord): PrintGuardResult {
  const manifest = buildManifest(order);

  if (order.paymentStatus !== 'paid' || order.refundedAt) {
    return {
      ok: false,
      failureCode: 'PRINT_PAYMENT_INVALID',
      message: 'Cannot submit print: payment not confirmed or refunded',
      manifest,
    };
  }
  // Customer approval is required — aliases proofApprovedAt.
  const approval = manifest.printApprovedAt;
  if (!approval) {
    return {
      ok: false,
      failureCode: 'CUSTOMER_APPROVAL_REQUIRED',
      message: 'Cannot submit print: customer approval timestamp missing (printApprovedAt/proofApprovedAt)',
      manifest,
    };
  }
  const fs = order.fulfillmentStatus ?? 'not_started';
  if (fs !== 'proof_approved' && fs !== 'submitting_to_print') {
    return {
      ok: false,
      failureCode: 'PRINT_STATE_INVALID',
      message: `Cannot submit print: fulfillmentStatus=${fs}`,
      manifest,
    };
  }

  // Independently re-run the release guard to catch artifact drift since
  // qa-pass time (e.g. a later page regenerate that introduced a fixture
  // asset).
  const release = evaluateReleaseGuard(order);
  if (!release.ok) {
    return {
      ok: false,
      failureCode:
        release.failureCode === 'MANIFEST_INCOMPLETE'
          ? 'PRINT_MANIFEST_INVALID'
          : release.failureCode === 'MISSING_LINEAGE' ||
              release.failureCode === 'PROVIDER_ROUTE_BLOCKED' ||
              release.failureCode === 'EMERGENCY_APPROVAL_MISSING'
            ? 'PRINT_LINEAGE_INVALID'
            : 'PRINT_QA_GUARD_FAILED',
      message: `Print guard failed: ${release.message ?? 'release guard re-check failed'}`,
      manifest,
      underlyingReleaseFailure: release.failureCode,
    };
  }
  return { ok: true, manifest };
}

/**
 * Convenience: derive a short audit-event payload describing a failure
 * for the proof_release_failed / print_submission_blocked audit events.
 */
export function describeFailureForAudit(
  result: ReleaseGuardResult | PrintGuardResult,
): Record<string, string | number | boolean | null> {
  return {
    failureCode: result.failureCode ?? 'NONE',
    message: (result.message ?? '').slice(0, 240),
    manifestComplete: result.manifest.complete,
    storyProvider: result.manifest.story.storyProvider,
    storyFallbackUsed: result.manifest.story.storyFallbackUsed,
    pageCount: result.manifest.pages.length,
    emergencyOverrideUsed: result.manifest.emergencyOverrideUsed,
    qaStatus: result.manifest.qaStatus,
  };
}

/**
 * Marker re-export so route-decision-recorded audit events can stay
 * type-safe at the call site.
 */
export type { GenerationRoute };
// Reference the import to satisfy `noUnusedLocals` while keeping the
// import available for downstream users that re-export.
const _kept = { pageProviderToRoute, loadGenerationPolicyConfig };
void _kept;
