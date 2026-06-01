/**
 * QA Production Room data layer — pure helpers that turn OrderRecord(s)
 * into a JSON-serializable analysis the operator dashboard can render.
 *
 * Hard rules:
 * - No mutation. No network. No order writes.
 * - All "live" customer-impacting actions are gated by the existing
 *   `/api/admin/orders/[orderId]/qa-pass` route + `releaseOrderAfterQa`
 *   server checks. This module only summarises state; it cannot release.
 * - Customer-visible preview text is derived ONLY from
 *   `buildOrderStatusView` so it cannot leak internal provider/QA
 *   details.
 */
import { isPrintFormat, type OrderRecord } from './orders.ts';
import {
  evaluateProofSubmissionGate,
  hasUsableShippingAddress,
  type ProofSubmissionGateReason,
} from './proof-submission-gate.ts';
import { buildOrderStatusView } from './order-status-view.ts';
import {
  buildManifest,
  evaluateReleaseGuardStructural,
  type OrderManifest,
  type ReleaseFailureCode,
} from './generation-manifest.ts';

export type PostureLevel = 'GREEN' | 'YELLOW' | 'RED';
export type GateState = 'live' | 'unknown' | 'down';

export interface StoryOrigin {
  source: string | null;
  model: string | null;
  fallbackError: string | null;
  isFallback: boolean;
  isTemplate: boolean;
}

export interface ImageLane {
  provider: string | null;
  model: string | null;
  conditioning: string | null;
  /** "fal_edit/<model>/<conditioning>" condensed for ops display. Never
   *  surfaced to customers. */
  representativeRoute: string | null;
  /** How many pages share that route. */
  pagesSharingRoute: number;
  /** Pages whose generationProvider differed (audit smell). */
  divergentPageCount: number;
}

export interface QaBlocker {
  code: string;
  severity: 'block' | 'warn';
  message: string;
}

export interface QaRiskFlag {
  code: string;
  label: string;
  severity: 'high' | 'med' | 'low';
}

export interface QaOrderAnalysis {
  orderId: string;
  childName: string;
  formatLabel: string;
  bookFormat: OrderRecord['bookFormat'];
  isPrint: boolean;
  paymentStatus: OrderRecord['paymentStatus'];
  fulfillmentStatus: string;
  awaitingQa: boolean;
  qaPassed: boolean;
  qaPassAt: string | null;
  qaPassBy: string | null;
  hasArtifact: boolean;
  proofUrl: string | null;
  storyOrigin: StoryOrigin;
  imageLane: ImageLane;
  /** Hard blockers that MUST clear before customer release. */
  blockers: QaBlocker[];
  /** Soft signals worth operator review. Never block release on their own. */
  riskFlags: QaRiskFlag[];
  slaAgeMinutes: number | null;
  requiredAction: string;
  /** Customer-safe summary line (no internal provider/QA details). */
  customerVisibleStatus: string;
  /** From order-status-view; safe to render in the customer preview card. */
  customerVisibleHeadline: string;
  /** Shipping address present + complete (only meaningful for print orders). */
  shippingPresentIfRequired: boolean;
  /** True if the order would pass the existing `releaseOrderAfterQa`
   *  server-side gate (apart from the checklist + paid + artifact checks
   *  which the UI already enforces). */
  canQaPass: boolean;
  /** Print release is downstream of customer approval, not of QA pass. */
  printReady: boolean;
  printGoNoGoState: 'not_yet' | 'awaiting_print_go' | 'submitted' | 'shipped';
  auditEventsCount: number;
  /** ISO timestamp the order entered awaiting_qa, falling back to updatedAt
   *  / createdAt when no transition event was recorded. Used by sla age. */
  awaitingSince: string | null;
  // ── Generation Operating Policy projection (additive) ────────────────────
  /** Manifest summary the QA Room renders in the detail panel. Computed
   *  from existing OrderRecord fields; never mutates the order. */
  policyManifest: OrderManifest;
  /** Result of the release-guard run against the manifest. UI flips
   *  release controls / risk tags based on this. */
  policyReleaseGuard: {
    ok: boolean;
    failureCode?: ReleaseFailureCode;
    message?: string;
  };
}

export interface Posture {
  level: PostureLevel;
  gateState: GateState;
  gateDown: boolean;
  ordersAwaitingQa: number;
  ordersWithBlockers: number;
  ordersWithTemplateFallback: number;
  banner: string;
  rationale: string[];
}

export interface MarketingGuardrail {
  paidBudgetUsd: number;
  retargetingOnly: boolean;
  creatorsAcceptedCap: number;
  giftedProductionDailyCap: number;
  pauseConditions: string[];
  notes: string[];
}

export interface CommandBoard {
  morning: string[];
  midday: string[];
  afternoon: string[];
  endOfDay: string[];
}

const TEMPLATE_FALLBACK_SOURCE = 'template_after_openai_failure';
const TEMPLATE_SOURCE = 'template';

/**
 * Inspect a single order and produce the operator-facing analysis the
 * QA Production Room renders. All derived values must be either present
 * on the OrderRecord or trivially computable; we never invent state.
 */
export function analyzeOrderQa(
  order: OrderRecord,
  options: { now?: Date } = {},
): QaOrderAnalysis {
  const now = options.now ?? new Date();
  const fulfillmentStatus = order.fulfillmentStatus ?? 'not_started';
  const awaitingQa = fulfillmentStatus === 'awaiting_qa';
  const qaPassed = Boolean(order.qaPassAt);
  const isPrint = isPrintFormat(order.bookFormat);
  const hasArtifact = Boolean(order.storyArtifactUrl);
  const proofUrl = order.storyArtifactUrl ?? null;

  const storyOrigin: StoryOrigin = {
    source: order.storyMeta?.source ?? null,
    model: order.storyMeta?.model ?? null,
    fallbackError: order.storyMeta?.fallbackError ?? null,
    isFallback: order.storyMeta?.source === TEMPLATE_FALLBACK_SOURCE,
    isTemplate:
      order.storyMeta?.source === TEMPLATE_SOURCE ||
      order.storyMeta?.source === TEMPLATE_FALLBACK_SOURCE,
  };

  const imageLane = summarizeImageLane(order);

  const gateResult = evaluateProofSubmissionGate(order);
  const blockers = collectBlockers(order, fulfillmentStatus, gateResult.reasons, hasArtifact);
  const riskFlags = collectRiskFlags(order, storyOrigin, isPrint);
  const shippingPresentIfRequired = isPrint ? hasUsableShippingAddress(order) : true;
  const awaitingSince = awaitingQaTimestamp(order);
  const slaAgeMinutes =
    awaitingQa && awaitingSince
      ? Math.max(0, Math.round((now.getTime() - Date.parse(awaitingSince)) / 60000))
      : null;

  const view = buildOrderStatusView(order);
  const customerVisibleHeadline = view.headline;
  const customerVisibleStatus = view.subhead;

  // Generation Operating Policy projection — STRUCTURAL release guard
  // (everything except qaStatus=passed). The QA Room UI uses this to
  // tell the operator whether finishing the checklist will let them
  // release. The full release guard (which requires qaStatus=passed)
  // would always report QA_NOT_PASSED here and deadlock the UI; that
  // version runs server-side inside `releaseOrderAfterQa` against a
  // synthesized post-pass order.
  const policyManifest = buildManifest(order);
  const guardResult = evaluateReleaseGuardStructural(order);
  const policyReleaseGuard = {
    ok: guardResult.ok,
    failureCode: guardResult.failureCode,
    message: guardResult.message,
  };

  const canQaPass =
    awaitingQa &&
    order.paymentStatus === 'paid' &&
    hasArtifact &&
    blockers.filter((b) => b.severity === 'block').length === 0 &&
    shippingPresentIfRequired;

  const printGoNoGoState = derivePrintGoNoGoState(order, isPrint, fulfillmentStatus);

  return {
    orderId: order.id,
    childName: order.childName,
    formatLabel: order.formatLabel,
    bookFormat: order.bookFormat,
    isPrint,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus,
    awaitingQa,
    qaPassed,
    qaPassAt: order.qaPassAt ?? null,
    qaPassBy: order.qaPassBy ?? null,
    hasArtifact,
    proofUrl,
    storyOrigin,
    imageLane,
    blockers,
    riskFlags,
    slaAgeMinutes,
    requiredAction: deriveRequiredAction(
      awaitingQa,
      qaPassed,
      blockers,
      hasArtifact,
      isPrint,
      shippingPresentIfRequired,
      printGoNoGoState,
    ),
    customerVisibleStatus,
    customerVisibleHeadline,
    shippingPresentIfRequired,
    canQaPass,
    printReady: printGoNoGoState === 'awaiting_print_go',
    printGoNoGoState,
    auditEventsCount: order.auditEvents?.length ?? 0,
    awaitingSince,
    policyManifest,
    policyReleaseGuard,
  };
}

function summarizeImageLane(order: OrderRecord): ImageLane {
  const pages = order.pageArtifacts ?? [];
  if (pages.length === 0) {
    return {
      provider: null,
      model: null,
      conditioning: null,
      representativeRoute: null,
      pagesSharingRoute: 0,
      divergentPageCount: 0,
    };
  }
  // Use a null-byte separator because real model strings legitimately
  // contain slashes (e.g. `fal-ai/bytedance/seedream/v4/edit`); a slash
  // separator would over-split the model identifier and lose the conditioning.
  const SEP = '\x00';
  const routes = new Map<string, number>();
  for (const p of pages) {
    const key = `${p.generationProvider ?? '?'}${SEP}${p.generationModel ?? '?'}${SEP}${p.generationConditioning ?? '?'}`;
    routes.set(key, (routes.get(key) ?? 0) + 1);
  }
  let best: [string, number] | null = null;
  for (const entry of routes.entries()) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  let representative: { provider: string | null; model: string | null; conditioning: string | null } | null = null;
  let displayRoute: string | null = null;
  if (best) {
    const [provider, model, conditioning] = best[0].split(SEP);
    representative = {
      provider: provider === '?' ? null : provider,
      model: model === '?' ? null : model,
      conditioning: conditioning === '?' ? null : conditioning,
    };
    displayRoute = [provider, model, conditioning].join('/');
  }
  const pagesSharingRoute = best?.[1] ?? 0;
  const divergentPageCount = pages.length - pagesSharingRoute;
  return {
    provider: representative?.provider ?? null,
    model: representative?.model ?? null,
    conditioning: representative?.conditioning ?? null,
    representativeRoute: displayRoute,
    pagesSharingRoute,
    divergentPageCount,
  };
}

function collectBlockers(
  order: OrderRecord,
  fulfillmentStatus: string,
  gateReasons: ProofSubmissionGateReason[],
  hasArtifact: boolean,
): QaBlocker[] {
  const blockers: QaBlocker[] = [];

  if (order.paymentStatus !== 'paid') {
    blockers.push({
      code: 'payment_not_confirmed',
      severity: 'block',
      message: `paymentStatus=${order.paymentStatus} — release requires paid`,
    });
  }
  if (order.refundedAt) {
    blockers.push({
      code: 'refunded',
      severity: 'block',
      message: 'Order was refunded; release halted',
    });
  }
  if (fulfillmentStatus === 'awaiting_qa' && !hasArtifact) {
    blockers.push({
      code: 'missing_artifact',
      severity: 'block',
      message: 'Awaiting QA but no proof/digital artifact URL is persisted',
    });
  }
  if (order.storyMeta?.source === TEMPLATE_FALLBACK_SOURCE) {
    blockers.push({
      code: 'template_after_openai_failure',
      severity: 'block',
      message:
        'Story generation fell back to template after model failure — human prose verification or rewrite is required before customer release.',
    });
  }
  for (const reason of gateReasons) {
    blockers.push({
      code: `proof_gate:${reason.code}`,
      severity: 'block',
      message: reason.message,
    });
  }
  return blockers;
}

function collectRiskFlags(
  order: OrderRecord,
  storyOrigin: StoryOrigin,
  isPrint: boolean,
): QaRiskFlag[] {
  const flags: QaRiskFlag[] = [];
  if (storyOrigin.isFallback) {
    flags.push({ code: 'story_provider_failed', label: 'Story provider failed', severity: 'high' });
    flags.push({ code: 'template_fallback', label: 'Template fallback in use', severity: 'high' });
  }
  if (storyOrigin.isTemplate && !storyOrigin.isFallback) {
    flags.push({ code: 'template_source', label: 'Deterministic template (no model)', severity: 'med' });
  }
  const family = Array.isArray(order.familyCharacters) ? order.familyCharacters : [];
  const familyMentioned = family.length > 0;
  const inspiration = order.voiceTranscript?.inspiration?.toLowerCase() ?? '';
  const mentionsDad = /\b(dad|daddy|father|papa)\b/.test(inspiration);
  const mentionsPet = /\b(dog|cat|puppy|kitten|pet|bird|hamster|rabbit)\b/.test(inspiration);
  if ((mentionsDad || mentionsPet) && !familyMentioned) {
    flags.push({
      code: 'missing_family_pet',
      label: 'Voice mentions dad/pet but no family characters captured',
      severity: 'high',
    });
  }
  const pages = order.pageArtifacts ?? [];
  const likenessConcernPages = pages.filter((p) => p.targetedRegenNeeded).length;
  if (likenessConcernPages > 0) {
    flags.push({
      code: 'likeness_concern',
      label: `Likeness concern on ${likenessConcernPages} page${likenessConcernPages === 1 ? '' : 's'}`,
      severity: 'med',
    });
  }
  const reviewerNoted = pages.some((p) => (p.reviewerNotes ?? '').trim().length > 0);
  if (reviewerNoted) {
    flags.push({ code: 'reviewer_notes_present', label: 'Reviewer notes present on pages', severity: 'low' });
  }
  const textSafe = order.artDirectionValidation;
  if (textSafe && textSafe.status !== 'complete') {
    flags.push({ code: 'text_safe_issue', label: 'Storyboard validation incomplete', severity: 'high' });
  }
  if (isPrint && !hasUsableShippingAddress(order)) {
    flags.push({ code: 'shipping_problem', label: 'Shipping address missing/incomplete', severity: 'high' });
  }
  if (order.referralCode) {
    flags.push({ code: 'creator_referral', label: 'Creator/referral order', severity: 'low' });
  }
  if (order.internalDisposition) {
    flags.push({ code: 'internal_disposition', label: `Internal: ${order.internalDisposition}`, severity: 'low' });
  }
  return flags;
}

function awaitingQaTimestamp(order: OrderRecord): string | null {
  const events = order.auditEvents ?? [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (!ev) continue;
    if (typeof ev.type === 'string' && ev.type.toLowerCase().includes('awaiting_qa')) {
      return ev.at ?? null;
    }
  }
  return order.updatedAt ?? order.createdAt ?? null;
}

function derivePrintGoNoGoState(
  order: OrderRecord,
  isPrint: boolean,
  fulfillmentStatus: string,
): QaOrderAnalysis['printGoNoGoState'] {
  if (!isPrint) return 'not_yet';
  if (order.status === 'shipped') return 'shipped';
  if (order.printJobId) return 'submitted';
  if (fulfillmentStatus === 'proof_approved' || fulfillmentStatus === 'submitting_to_print') {
    return 'awaiting_print_go';
  }
  return 'not_yet';
}

function deriveRequiredAction(
  awaitingQa: boolean,
  qaPassed: boolean,
  blockers: QaBlocker[],
  hasArtifact: boolean,
  isPrint: boolean,
  shippingPresent: boolean,
  printState: QaOrderAnalysis['printGoNoGoState'],
): string {
  if (printState === 'shipped') return 'Shipped — no action';
  if (printState === 'submitted') return 'Print submitted — awaiting Lulu webhook';
  if (printState === 'awaiting_print_go') return 'Owner: print go/no-go decision';
  if (!awaitingQa) {
    if (qaPassed) return 'Released — monitor downstream';
    return `No QA action — order is ${blockers.length > 0 ? 'blocked' : 'pre-QA'}`;
  }
  if (!hasArtifact) return 'Wait for artifact build to complete';
  const blocking = blockers.filter((b) => b.severity === 'block');
  if (blocking.length > 0) return `Resolve ${blocking.length} blocker${blocking.length === 1 ? '' : 's'} first`;
  if (isPrint && !shippingPresent) return 'Operator: capture shipping address before QA pass';
  return 'Run QA checklist; release proof/digital';
}

/**
 * Compute a conservative system posture from a fleet of orders.
 *
 * The QA gate backend's existence cannot be probed at runtime in this
 * module (we'd have to import the route handler); callers pass it in
 * via `deps.gateBackendInstalled`. The QA Room server component sets
 * this to `true` because the route file exists in this worktree.
 *
 * If posture is RED, the UI should refuse to render green chips on
 * passes that came from a stale source.
 */
export function evaluatePosture(
  orders: OrderRecord[],
  deps: { gateBackendInstalled?: boolean; now?: Date } = {},
): Posture {
  const gateInstalled = deps.gateBackendInstalled ?? false;
  const now = deps.now ?? new Date();

  let awaiting = 0;
  let blocked = 0;
  let templateFallback = 0;
  let stuckOver60min = 0;

  for (const o of orders) {
    if (o.fulfillmentStatus === 'awaiting_qa') {
      awaiting += 1;
      const ts = Date.parse(o.updatedAt ?? o.createdAt ?? '');
      if (Number.isFinite(ts) && now.getTime() - ts >= 60 * 60 * 1000) stuckOver60min += 1;
    }
    if (o.storyMeta?.source === TEMPLATE_FALLBACK_SOURCE) {
      templateFallback += 1;
      blocked += 1;
    }
  }

  const rationale: string[] = [];
  let level: PostureLevel = 'GREEN';
  let gateState: GateState = gateInstalled ? 'live' : 'unknown';
  let gateDown = false;

  if (!gateInstalled) {
    level = 'RED';
    gateDown = true;
    rationale.push('QA gate backend not detected — refusing to release until operator confirms gate is live.');
  } else {
    if (templateFallback > 0) {
      level = templateFallback >= 3 ? 'RED' : 'YELLOW';
      rationale.push(
        `${templateFallback} order${templateFallback === 1 ? '' : 's'} carrying template_after_openai_failure — release blocked until human rewrite.`,
      );
    }
    if (stuckOver60min > 0) {
      level = level === 'RED' ? 'RED' : 'YELLOW';
      rationale.push(
        `${stuckOver60min} order${stuckOver60min === 1 ? '' : 's'} stuck awaiting QA for over 60 minutes.`,
      );
    }
    if (level === 'GREEN' && awaiting === 0) {
      rationale.push('No orders awaiting QA right now.');
    }
  }

  const banner =
    level === 'RED'
      ? 'RED — gate down or releases halted. Resume only after the gate is restored and backlog cleared.'
      : level === 'YELLOW'
        ? 'YELLOW — proceed with care. Operator review required on flagged orders before release.'
        : 'GREEN — release clean proofs to customers; flag at-risk orders for owner review.';

  return {
    level,
    gateState,
    gateDown,
    ordersAwaitingQa: awaiting,
    ordersWithBlockers: blocked,
    ordersWithTemplateFallback: templateFallback,
    banner,
    rationale,
  };
}

/**
 * Static read-only marketing guardrail surfaced as operator context.
 * NOT wired to ads/spend/creator mutation. Edit this single source if
 * Alexy changes the daily caps.
 */
export function defaultMarketingGuardrail(): MarketingGuardrail {
  return {
    paidBudgetUsd: 200,
    retargetingOnly: true,
    creatorsAcceptedCap: 5,
    giftedProductionDailyCap: 2,
    pauseConditions: [
      'RED or gate-down pauses ads and creator codes',
      'Backlog > 2 orders awaiting QA pauses new traffic',
      'Refunds / complaints >= 5% pauses new traffic',
    ],
    notes: [
      'Paid budget: $200 retargeting only',
      'Creators accepted cap: 5',
      'Gifted production cap: 2 per day',
      'No new traffic until QA gate is live',
    ],
  };
}

export function dailyCommandBoard(): CommandBoard {
  return {
    morning: [
      'Check QA gate is live (admin/qa-room banner)',
      'Drain overnight awaiting_qa queue',
      'Confirm provider health (story + image lanes)',
      "Set today’s posture and daily cap",
    ],
    midday: [
      'Release clean proofs to customers',
      'Flag at-risk orders for owner review',
      'Triage incoming refunds / complaints',
      'Confirm no template-fallback orders shipped',
    ],
    afternoon: [
      'Re-check posture after creator/gifted batch',
      'Walk new orders without artifacts (paid_attention)',
      'Confirm shipping addresses on print orders before QA pass',
      'Pause creator codes if backlog > 2',
    ],
    endOfDay: [
      'Confirm no proofs released without QA pass',
      'Snapshot blocker counts for the morning review',
      'Flag follow-ups for owner sign-off',
      'Stop new traffic if posture closed RED',
    ],
  };
}
