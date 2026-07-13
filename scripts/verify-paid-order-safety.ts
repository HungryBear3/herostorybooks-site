// Read-only safety verifier for HeroStoryBooks friends/family PAID beta orders.
//
// One command after a paid checkout answers: did payment work, does an app
// order exist, what state is it in, and did any UNSAFE proof/print/customer/
// provider side effect happen?
//
// Usage:
//   node --experimental-strip-types scripts/verify-paid-order-safety.ts --order-id ord_...
//   node --experimental-strip-types scripts/verify-paid-order-safety.ts --email someone@example.com
//   node --experimental-strip-types scripts/verify-paid-order-safety.ts --stripe-session cs_live_...
//   ... add --json for machine-readable output, --help for usage.
//
// Reads from the same store the live app uses (Vercel Blob when
// BLOB_READ_WRITE_TOKEN is set; HSB_ORDER_STORE_DIR / tmp fallback otherwise).
// When STRIPE_SECRET_KEY is present it makes READ-ONLY Stripe calls
// (checkout.sessions.retrieve, paymentIntents.retrieve, events.list) to
// cross-check the actual paid amount, discount, and webhook delivery.
//
// HARD RULES (enforced by construction — this file contains no writes):
//   * Read-only. No Stripe writes. No DB/blob/order writes. No proof/story/page
//     generation. No emails. No print/provider calls. No deploy/commit/push.
//   * Never prints secrets, session URLs, tokens, env values, raw private
//     memory/story text, raw uploaded media URLs, or full order JSON. IDs are
//     redacted to prefix…suffix; emails are shown (local internal output).
//
// The CLI entry is guarded so importing this module for tests runs no I/O.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Stripe from 'stripe';

import { getOrder, listOrders } from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import { sanitizeCheckoutTrackingValue, type CheckoutTracking } from '../src/lib/checkout-tracking.ts';
import { buildOrderDiagnostics } from '../src/lib/order-diagnostics.ts';
import type { OrderDiagnostics } from '../src/lib/order-diagnostics.ts';

// ── Verdict vocabulary ─────────────────────────────────────────────────────

export const VERDICT = {
  GREEN: 'GREEN',
  YELLOW: 'YELLOW',
  RED: 'RED',
} as const;

export type Verdict = (typeof VERDICT)[keyof typeof VERDICT];

const VERDICT_RANK: Record<Verdict, number> = {
  [VERDICT.GREEN]: 0,
  [VERDICT.YELLOW]: 1,
  [VERDICT.RED]: 2,
};

/** Roll a set of verdicts up to the most severe. Empty -> GREEN. */
export function rollupVerdict(verdicts: Verdict[]): Verdict {
  return verdicts.reduce<Verdict>(
    (worst, v) => (VERDICT_RANK[v] > VERDICT_RANK[worst] ? v : worst),
    VERDICT.GREEN,
  );
}

// ── Redaction ──────────────────────────────────────────────────────────────

/**
 * Redact an identifier to `prefix…suffix` so ops can still eyeball-match it
 * without the full token/session id landing in logs. Keeps the human-readable
 * type prefix (cs_live_, pi_, ord_, re_) intact.
 */
export function redactId(id: string | null | undefined, suffix = 6): string {
  if (!id) return '(none)';
  const s = String(id);
  // Keep a leading type marker like "cs_live_", "pi_", "ord_", "re_", "evt_".
  const m = s.match(/^([a-z]+_(?:live_|test_)?)/i);
  const head = m ? m[1] : s.slice(0, 4);
  const tailStart = Math.max(head.length, s.length - suffix);
  if (tailStart >= s.length) return `${head}…`;
  return `${head}…${s.slice(tailStart)}`;
}

// ── Stale / risky customer copy detection ──────────────────────────────────

export interface StaleCopyPattern {
  id: string;
  re: RegExp;
  note: string;
}

/**
 * Patterns that promise instant / minutes-scale digital delivery. The current
 * fulfillment model is operator-reviewed ("proof within ~2 business days"), so
 * any of these in an order's customer-facing copy or on the Stripe line item
 * is stale drift that must be caught before it reaches a real buyer.
 */
export const STALE_COPY_PATTERNS: StaleCopyPattern[] = [
  { id: 'instant', re: /\binstant(ly|-download)?\b/i, note: 'implies immediate/automatic delivery' },
  { id: '15-minutes', re: /~?\s*15\s*min(?:ute)?s?\b/i, note: 'promises ~15-minute delivery' },
  { id: 'minutes-delivery', re: /in\s*~?\s*\d+\s*min(?:ute)?s?\b/i, note: 'promises delivery in minutes' },
  { id: 'by-email-minutes', re: /by\s+email\s+in\b/i, note: 'promises timed email delivery' },
];

export interface StaleCopyHit {
  field: string;
  patternId: string;
  note: string;
  /** The offending value, whitespace-collapsed and length-bounded. Never raw. */
  excerpt: string;
}

function boundedExcerpt(value: string, max = 120): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

/** Scan labelled customer-copy fields for stale instant/minutes promises. */
export function scanStaleCopy(fields: Array<{ field: string; value: string | null | undefined }>): StaleCopyHit[] {
  const hits: StaleCopyHit[] = [];
  for (const { field, value } of fields) {
    if (!value) continue;
    for (const p of STALE_COPY_PATTERNS) {
      if (p.re.test(value)) {
        hits.push({ field, patternId: p.id, note: p.note, excerpt: boundedExcerpt(value) });
      }
    }
  }
  return hits;
}

// ── Custom-story-brief (memory-lane intake) detection ──────────────────────

export interface CustomStoryBriefInfo {
  present: boolean;
  /** High-level top-level keys only — never the raw private brief text. */
  keys: string[];
  /** Which order field the brief was found on, if any. */
  source: string | null;
}

/**
 * The friends/family "memory lane" intake persists a structured custom-story
 * brief. Field naming has drifted across builds, so probe the known/candidate
 * locations defensively. Returns presence + top-level key names ONLY (bounded),
 * never the private story content.
 */
export function detectCustomStoryBrief(order: OrderRecord): CustomStoryBriefInfo {
  const candidates = ['customStoryBrief', 'storyBrief', 'memoryBrief', 'customMemoryBrief'];
  const bag = order as unknown as Record<string, unknown>;
  for (const field of candidates) {
    const raw = bag[field];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return { present: true, keys: Object.keys(raw as Record<string, unknown>).slice(0, 24), source: field };
    }
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return { present: true, keys: [], source: field };
    }
  }
  return { present: false, keys: [], source: null };
}

// ── Core safety classifier (pure) ──────────────────────────────────────────

export interface SafetyInputs {
  orderFound: boolean;
  bookFormat: string | null;
  /** App order paymentStatus (e.g. "paid" | "pending" | "failed"). */
  appPaymentStatus: string | null;
  /** Stripe session payment_status === 'paid'. null when unknown (no key/session). */
  stripePaid: boolean | null;
  hasStoryArtifact: boolean;
  pageArtifactCount: number;
  proofReady: boolean;
  printJobId: string | null;
  printInteriorArtifactUrl: string | null;
  printCoverArtifactUrl: string | null;
  fulfillmentStatus: string;
  customStoryBriefPresent: boolean;
  staleCopyHits: StaleCopyHit[];
  /** Operator escape hatches — default false. Only true when an explicit go exists. */
  printGo: boolean;
  artifactsIntended: boolean;
}

export interface SafetyEvaluation {
  verdict: Verdict;
  /** Short verdict qualifiers, e.g. "controlled-payment-ok / fulfillment-held". */
  labels: string[];
  /** RED-level problems that must be resolved. */
  blockers: string[];
  /** YELLOW-level drift / things to confirm. */
  followUps: string[];
  /** Unsafe side effects detected (subset that drives RED). */
  unsafeSideEffects: string[];
}

/**
 * Single source of truth for the GREEN/YELLOW/RED call. Pure over SafetyInputs
 * so the CLI, tests, and any future dashboard classify identically.
 */
export function evaluatePaidOrderSafety(input: SafetyInputs): SafetyEvaluation {
  const blockers: string[] = [];
  const followUps: string[] = [];
  const unsafeSideEffects: string[] = [];
  const labels: string[] = [];
  const verdicts: Verdict[] = [];

  // 1. Order existence vs. Stripe payment.
  if (!input.orderFound) {
    if (input.stripePaid === true) {
      blockers.push('Stripe reports PAID but no app order was found — customer paid for an order the app cannot see.');
      labels.push('paid-no-app-order');
    } else {
      blockers.push('Order not found in the configured store — cannot verify safety.');
      labels.push('order-not-found');
    }
    return { verdict: VERDICT.RED, labels, blockers, followUps, unsafeSideEffects };
  }

  // 2. Payment consistency between app + Stripe.
  const appPaid = input.appPaymentStatus === 'paid';
  if (input.stripePaid === true && !appPaid) {
    blockers.push(`Stripe PAID but app paymentStatus=${input.appPaymentStatus ?? 'unknown'} — webhook may not have reconciled.`);
    verdicts.push(VERDICT.RED);
  } else if (input.stripePaid === false && appPaid) {
    blockers.push('App order is marked paid but Stripe session is NOT paid — state mismatch.');
    verdicts.push(VERDICT.RED);
  }

  // 3. Unsafe side effects for a concierge/manual beta order.
  if (!input.artifactsIntended) {
    if (input.hasStoryArtifact) unsafeSideEffects.push('storyArtifactUrl present (a customer-facing proof/PDF was generated).');
    if (input.proofReady) unsafeSideEffects.push('fulfillment reached proof_ready (proof released).');
    if (input.pageArtifactCount > 0) unsafeSideEffects.push(`${input.pageArtifactCount} page artifact(s) generated.`);
  }
  if (!input.printGo) {
    if (input.printJobId) unsafeSideEffects.push(`printJobId present (${redactId(input.printJobId)}) — a print/provider job exists.`);
    if (input.printInteriorArtifactUrl) unsafeSideEffects.push('printInteriorArtifactUrl present — print interior was built.');
    if (input.printCoverArtifactUrl) unsafeSideEffects.push('printCoverArtifactUrl present — print cover was built.');
  }
  if (unsafeSideEffects.length > 0) {
    for (const s of unsafeSideEffects) blockers.push(`Unexpected side effect: ${s}`);
    verdicts.push(VERDICT.RED);
    labels.push('unsafe-side-effects');
  }

  // 4. Baseline payment/fulfillment posture (only meaningful without RED above).
  if (appPaid) {
    // Paid + no artifacts/print is "controlled payment OK, fulfillment held".
    // Per beta policy this is NOT broad-launch green.
    if (unsafeSideEffects.length === 0) {
      labels.push('controlled-payment-ok / fulfillment-held');
      verdicts.push(VERDICT.YELLOW);
    }
  } else {
    followUps.push(`App order is not paid (paymentStatus=${input.appPaymentStatus ?? 'unknown'}); confirm this matches the Stripe session.`);
    labels.push('payment-not-confirmed');
    verdicts.push(VERDICT.YELLOW);
  }

  // 5. Copy drift.
  if (input.staleCopyHits.length > 0) {
    const fieldList = [...new Set(input.staleCopyHits.map((h) => h.field))].join(', ');
    followUps.push(`Stale/risky instant delivery copy detected on: ${fieldList}. Refresh before this reaches a real buyer.`);
    labels.push('copy drift');
    verdicts.push(VERDICT.YELLOW);
  }

  // 6. Intake drift — memory-lane friends/family orders should carry a brief.
  if (!input.customStoryBriefPresent) {
    followUps.push('No custom story brief present — order came through an older digital path, not the memory-lane intake.');
    labels.push('intake drift');
    verdicts.push(VERDICT.YELLOW);
  }

  const verdict = rollupVerdict(verdicts);
  return { verdict, labels, blockers, followUps, unsafeSideEffects };
}

// ── Stripe (read-only) ─────────────────────────────────────────────────────

export interface StripeFacts {
  available: boolean;
  reason: string | null;
  sessionId: string | null;
  sessionStatus: string | null;
  paymentStatus: string | null;
  amountTotal: number | null;
  amountSubtotal: number | null;
  amountDiscount: number | null;
  currency: string | null;
  promoEvidence: string[];
  paymentIntentId: string | null;
  paymentIntentStatus: string | null;
  chargePaid: boolean | null;
  amountCaptured: number | null;
  lineItemDescriptions: Array<{ name: string | null; description: string | null }>;
  metadataKeys: string[];
  metadataTracking: CheckoutTracking | null;
  webhook: {
    scanned: number;
    relatedEventTypes: string[];
    maxPendingWebhooks: number;
    note: string | null;
  } | null;
}

function emptyStripeFacts(reason: string | null): StripeFacts {
  return {
    available: false,
    reason,
    sessionId: null,
    sessionStatus: null,
    paymentStatus: null,
    amountTotal: null,
    amountSubtotal: null,
    amountDiscount: null,
    currency: null,
    promoEvidence: [],
    paymentIntentId: null,
    paymentIntentStatus: null,
    chargePaid: null,
    amountCaptured: null,
    lineItemDescriptions: [],
    metadataKeys: [],
    metadataTracking: null,
    webhook: null,
  };
}

function sanitizeStripeKey(): string | null {
  const value = (process.env.STRIPE_SECRET_KEY ?? '').trim().replace(/\\n/g, '').replace(/[\r\n]/g, '').trim();
  return value || null;
}

/**
 * READ-ONLY Stripe cross-check. Only .retrieve/.list calls — no create/update.
 * Best-effort: any failure degrades to available:false with a reason, never
 * throws out of the verifier.
 */
async function loadStripeFacts(sessionId: string | null): Promise<StripeFacts> {
  const key = sanitizeStripeKey();
  if (!key) return emptyStripeFacts('STRIPE_SECRET_KEY not set — Stripe cross-check skipped.');
  if (!sessionId) return emptyStripeFacts('No Stripe session id available for cross-check.');

  const stripe = new Stripe(key);
  const facts = emptyStripeFacts(null);
  facts.sessionId = sessionId;

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items', 'total_details.breakdown', 'payment_intent'],
    });
    facts.available = true;
    facts.sessionStatus = session.status ?? null;
    facts.paymentStatus = session.payment_status ?? null;
    facts.amountTotal = session.amount_total ?? null;
    facts.amountSubtotal = session.amount_subtotal ?? null;
    facts.amountDiscount = session.total_details?.amount_discount ?? null;
    facts.currency = session.currency ?? null;
    facts.metadataKeys = Object.keys(session.metadata ?? {});
    const metadataCohort = sanitizeCheckoutTrackingValue(session.metadata?.cohort);
    const metadataInvite = sanitizeCheckoutTrackingValue(session.metadata?.invite);
    facts.metadataTracking = metadataCohort || metadataInvite
      ? {
          ...(metadataCohort ? { cohort: metadataCohort } : {}),
          ...(metadataInvite ? { invite: metadataInvite } : {}),
        }
      : null;

    // Promo evidence — presence only, redacted; never dump full discount objects.
    const breakdownDiscounts = session.total_details?.breakdown?.discounts ?? [];
    for (const d of breakdownDiscounts) {
      const disc = d.discount as { promotion_code?: unknown; coupon?: { id?: string; name?: string | null } } | undefined;
      const promo = typeof disc?.promotion_code === 'string' ? redactId(disc.promotion_code) : null;
      const coupon = disc?.coupon?.name ?? (disc?.coupon?.id ? redactId(disc.coupon.id) : null);
      facts.promoEvidence.push(`discount amount=${d.amount ?? '?'}${promo ? ` promo=${promo}` : ''}${coupon ? ` coupon=${coupon}` : ''}`);
    }

    const lineItems = (session as { line_items?: { data?: Array<{ description?: string | null; price?: { product?: unknown } | null }> } }).line_items;
    for (const li of lineItems?.data ?? []) {
      facts.lineItemDescriptions.push({ name: li.description ?? null, description: li.description ?? null });
    }

    const pi = session.payment_intent;
    if (pi && typeof pi === 'object') {
      facts.paymentIntentId = pi.id ?? null;
      facts.paymentIntentStatus = pi.status ?? null;
      facts.amountCaptured = typeof pi.amount_received === 'number' ? pi.amount_received : null;
      facts.chargePaid = pi.status === 'succeeded';
    } else if (typeof pi === 'string') {
      facts.paymentIntentId = pi;
    }
  } catch (err) {
    return emptyStripeFacts(`Stripe session retrieve failed: ${(err as Error).message}`);
  }

  // Webhook / event delivery summary — bounded, best-effort read.
  try {
    const events = await stripe.events.list({ limit: 100 });
    const related = events.data.filter((e) => {
      const obj = e.data?.object as { id?: string; payment_intent?: string } | undefined;
      return (
        obj?.id === facts.sessionId ||
        obj?.id === facts.paymentIntentId ||
        (facts.paymentIntentId != null && obj?.payment_intent === facts.paymentIntentId)
      );
    });
    facts.webhook = {
      scanned: events.data.length,
      relatedEventTypes: Array.from(new Set(related.map((e) => String(e.type)))),
      maxPendingWebhooks: related.reduce((m, e) => Math.max(m, e.pending_webhooks ?? 0), 0),
      note: related.length === 0 ? 'No related events in the most recent 100 — may be older than the scan window.' : null,
    };
  } catch (err) {
    facts.webhook = { scanned: 0, relatedEventTypes: [], maxPendingWebhooks: 0, note: `events.list failed: ${(err as Error).message}` };
  }

  return facts;
}

// ── Order resolution ───────────────────────────────────────────────────────

export interface CliArgs {
  orderId: string | null;
  email: string | null;
  stripeSession: string | null;
  json: boolean;
  help: boolean;
  printGo: boolean;
  artifactsIntended: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    orderId: null,
    email: null,
    stripeSession: null,
    json: false,
    help: false,
    printGo: false,
    artifactsIntended: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    if (a === '--order-id' || a === '--order') args.orderId = next().trim() || null;
    else if (a === '--email') args.email = next().trim().toLowerCase() || null;
    else if (a === '--stripe-session' || a === '--session') args.stripeSession = next().trim() || null;
    else if (a === '--json') args.json = true;
    else if (a === '--print-go') args.printGo = true;
    else if (a === '--artifacts-intended') args.artifactsIntended = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--order-id=')) args.orderId = a.slice('--order-id='.length).trim() || null;
    else if (a.startsWith('--email=')) args.email = a.slice('--email='.length).trim().toLowerCase() || null;
    else if (a.startsWith('--stripe-session=')) args.stripeSession = a.slice('--stripe-session='.length).trim() || null;
  }
  return args;
}

const HELP = `Read-only HSB paid-order safety verifier.

Usage:
  verify-paid-order-safety --order-id ord_...
  verify-paid-order-safety --email someone@example.com
  verify-paid-order-safety --stripe-session cs_live_...

Options:
  --order-id <id>          Look up an order by id.
  --email <addr>           Look up the most recent order for an email.
  --stripe-session <id>    Look up an order by stored Stripe session id.
  --json                   Emit machine-readable JSON instead of text.
  --print-go               Treat existing print/provider job as intended (rare).
  --artifacts-intended     Treat existing proof/story/page artifacts as intended.
  -h, --help               Show this help.

Reads the same store the app uses (Vercel Blob when BLOB_READ_WRITE_TOKEN is
set, else local dir). If STRIPE_SECRET_KEY is set it performs READ-ONLY Stripe
cross-checks. This tool never writes anything and never prints secrets.`;

interface ResolvedOrder {
  order: OrderRecord | null;
  matchedBy: string | null;
  candidates: number;
}

async function resolveOrder(args: CliArgs): Promise<ResolvedOrder> {
  if (args.orderId) {
    const order = await getOrder(args.orderId);
    return { order, matchedBy: order ? 'order-id' : null, candidates: order ? 1 : 0 };
  }

  const all = await listOrders();
  const pick = (matches: OrderRecord[]): ResolvedOrder => {
    if (matches.length === 0) return { order: null, matchedBy: null, candidates: 0 };
    const sorted = [...matches].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return { order: sorted[0], matchedBy: null, candidates: matches.length };
  };

  if (args.stripeSession) {
    const r = pick(all.filter((o) => o.stripeSessionId === args.stripeSession));
    return { ...r, matchedBy: r.order ? 'stripe-session' : null };
  }
  if (args.email) {
    const r = pick(all.filter((o) => (o.email ?? '').toLowerCase() === args.email));
    return { ...r, matchedBy: r.order ? 'email' : null };
  }
  return { order: null, matchedBy: null, candidates: 0 };
}

// ── Report assembly ────────────────────────────────────────────────────────

export interface VerifierReport {
  verdict: Verdict;
  labels: string[];
  lookup: { matchedBy: string | null; candidates: number; requested: Partial<CliArgs> };
  order: {
    found: boolean;
    orderId: string | null;
    email: string | null;
    childName: string | null;
    bookFormat: string | null;
    formatLabel: string | null;
    priceCents: number | null;
    paymentStatus: string | null;
    status: string | null;
    fulfillmentStatus: string | null;
    reviewStatus: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    stripeSessionId: string | null;
    internalDisposition: string | null;
    checkoutTracking: CheckoutTracking | null;
  };
  artifacts: {
    storyArtifactPresent: boolean;
    pageArtifactCount: number;
    proofReady: boolean;
    printJobId: string | null;
    printInteriorArtifactPresent: boolean;
    printCoverArtifactPresent: boolean;
    refunded: boolean;
  };
  customStoryBrief: CustomStoryBriefInfo;
  proofGate: {
    gated?: boolean;
    allowed?: boolean;
    overrideApplied?: boolean;
    reasons?: string[];
  } | null;
  stripe: StripeFacts;
  staleCopyHits: StaleCopyHit[];
  safety: SafetyEvaluation;
}

export function buildReport(
  args: CliArgs,
  resolved: ResolvedOrder,
  diag: OrderDiagnostics | null,
  stripe: StripeFacts,
): VerifierReport {
  const order = resolved.order;
  const brief = order ? detectCustomStoryBrief(order) : { present: false, keys: [], source: null };

  const staleFields: Array<{ field: string; value: string | null | undefined }> = order
    ? [
        { field: 'order.deliveryExpectation', value: order.deliveryExpectation },
        { field: 'order.formatLabel', value: order.formatLabel },
      ]
    : [];
  for (const li of stripe.lineItemDescriptions) {
    staleFields.push({ field: 'stripe.lineItem.name', value: li.name });
    staleFields.push({ field: 'stripe.lineItem.description', value: li.description });
  }
  const staleCopyHits = scanStaleCopy(staleFields);

  const safety = evaluatePaidOrderSafety({
    orderFound: Boolean(order),
    bookFormat: order?.bookFormat ?? null,
    appPaymentStatus: order?.paymentStatus ?? null,
    stripePaid: stripe.available ? stripe.paymentStatus === 'paid' : null,
    hasStoryArtifact: Boolean(order?.storyArtifactUrl),
    pageArtifactCount: diag?.artifacts.pageArtifactCount ?? 0,
    proofReady: Boolean(diag?.flags.proofReady),
    printJobId: order?.printJobId ?? null,
    printInteriorArtifactUrl: order?.printInteriorArtifactUrl ?? null,
    printCoverArtifactUrl: order?.printCoverArtifactUrl ?? null,
    fulfillmentStatus: diag?.fulfillment.fulfillmentStatus ?? 'not_started',
    customStoryBriefPresent: brief.present,
    staleCopyHits,
    printGo: args.printGo,
    artifactsIntended: args.artifactsIntended,
  });

  return {
    verdict: safety.verdict,
    labels: safety.labels,
    lookup: {
      matchedBy: resolved.matchedBy,
      candidates: resolved.candidates,
      requested: {
        orderId: args.orderId,
        email: args.email,
        stripeSession: args.stripeSession ? redactId(args.stripeSession) : null,
      },
    },
    order: {
      found: Boolean(order),
      orderId: order?.id ?? null,
      email: order?.email ?? null,
      childName: order?.childName ?? null,
      bookFormat: order?.bookFormat ?? null,
      formatLabel: order?.formatLabel ?? null,
      priceCents: order?.priceCents ?? null,
      paymentStatus: order?.paymentStatus ?? null,
      status: order?.status ?? null,
      fulfillmentStatus: diag?.fulfillment.fulfillmentStatus ?? null,
      reviewStatus: diag?.review.reviewStatus ?? null,
      createdAt: order?.createdAt ?? null,
      updatedAt: order?.updatedAt ?? null,
      stripeSessionId: order?.stripeSessionId ? redactId(order.stripeSessionId) : null,
      internalDisposition: order?.internalDisposition ?? null,
      checkoutTracking: order?.checkoutTracking ?? null,
    },
    artifacts: {
      storyArtifactPresent: Boolean(order?.storyArtifactUrl),
      pageArtifactCount: diag?.artifacts.pageArtifactCount ?? 0,
      proofReady: Boolean(diag?.flags.proofReady),
      printJobId: order?.printJobId ? redactId(order.printJobId) : null,
      printInteriorArtifactPresent: Boolean(order?.printInteriorArtifactUrl),
      printCoverArtifactPresent: Boolean(order?.printCoverArtifactUrl),
      refunded: Boolean(order?.refundedAt || order?.stripeRefundId),
    },
    customStoryBrief: brief,
    proofGate: ((diag as unknown as { proofGate?: VerifierReport['proofGate'] } | null)?.proofGate) ?? null,
    stripe,
    staleCopyHits,
    safety,
  };
}

function money(cents: number | null, currency: string | null): string {
  if (cents == null) return 'n/a';
  return `${(cents / 100).toFixed(2)} ${(currency ?? 'usd').toUpperCase()} (${cents}¢)`;
}

export function formatReport(r: VerifierReport): string {
  const L: string[] = [];
  const verdictLine = `VERDICT: ${r.verdict}${r.labels.length ? ` — ${r.labels.join(' · ')}` : ''}`;
  L.push('═'.repeat(Math.max(24, verdictLine.length)));
  L.push(verdictLine);
  L.push('═'.repeat(Math.max(24, verdictLine.length)));
  L.push('');

  L.push('Lookup:');
  L.push(`  matched by      : ${r.lookup.matchedBy ?? '(no match)'}${r.lookup.candidates > 1 ? ` (${r.lookup.candidates} candidates, newest shown)` : ''}`);
  L.push('');

  if (!r.order.found) {
    L.push('Order: NOT FOUND in the configured store.');
    if (r.stripe.available) {
      L.push(`  Stripe session status=${r.stripe.sessionStatus ?? '?'} payment=${r.stripe.paymentStatus ?? '?'} total=${money(r.stripe.amountTotal, r.stripe.currency)}`);
    }
  } else {
    L.push('Order:');
    L.push(`  order id        : ${r.order.orderId}`);
    L.push(`  email           : ${r.order.email ?? 'n/a'}`);
    L.push(`  child           : ${r.order.childName ?? 'n/a'}`);
    L.push(`  book format     : ${r.order.bookFormat ?? 'n/a'} (${r.order.formatLabel ?? 'n/a'})`);
    L.push(`  list priceCents : ${money(r.order.priceCents, 'usd')}`);
    L.push(`  paymentStatus   : ${r.order.paymentStatus ?? 'n/a'}`);
    L.push(`  status          : ${r.order.status ?? 'n/a'}`);
    L.push(`  fulfillment     : ${r.order.fulfillmentStatus ?? 'n/a'}`);
    L.push(`  reviewStatus    : ${r.order.reviewStatus ?? 'n/a'}`);
    L.push(`  stripe session  : ${r.order.stripeSessionId ?? '(none stored)'}`);
    if (r.order.checkoutTracking?.cohort || r.order.checkoutTracking?.invite) {
      L.push(`  checkout track  : cohort=${r.order.checkoutTracking.cohort ?? 'n/a'} invite=${r.order.checkoutTracking.invite ?? 'n/a'}`);
    }
    L.push(`  created/updated : ${r.order.createdAt ?? '?'} / ${r.order.updatedAt ?? '?'}`);
    if (r.order.internalDisposition) L.push(`  internalDisp    : ${r.order.internalDisposition}`);
  }
  L.push('');

  L.push('Stripe cross-check:');
  if (!r.stripe.available) {
    L.push(`  (unavailable) ${r.stripe.reason ?? ''}`);
  } else {
    L.push(`  session status  : ${r.stripe.sessionStatus ?? '?'}`);
    L.push(`  payment status  : ${r.stripe.paymentStatus ?? '?'}`);
    L.push(`  amount total    : ${money(r.stripe.amountTotal, r.stripe.currency)}`);
    L.push(`  amount subtotal : ${money(r.stripe.amountSubtotal, r.stripe.currency)}`);
    L.push(`  amount discount : ${money(r.stripe.amountDiscount, r.stripe.currency)}`);
    if (r.stripe.promoEvidence.length) L.push(`  promo evidence  : ${r.stripe.promoEvidence.join(' | ')}`);
    L.push(`  paymentIntent   : ${redactId(r.stripe.paymentIntentId)} status=${r.stripe.paymentIntentStatus ?? '?'} captured=${money(r.stripe.amountCaptured, r.stripe.currency)}`);
    if (r.stripe.metadataKeys.length) L.push(`  metadata keys   : ${r.stripe.metadataKeys.join(', ')}`);
    if (r.stripe.metadataTracking?.cohort || r.stripe.metadataTracking?.invite) {
      L.push(`  metadata track  : cohort=${r.stripe.metadataTracking.cohort ?? 'n/a'} invite=${r.stripe.metadataTracking.invite ?? 'n/a'}`);
    }
    if (r.stripe.webhook) {
      L.push(`  webhook events  : scanned ${r.stripe.webhook.scanned}, related types [${r.stripe.webhook.relatedEventTypes.join(', ') || 'none'}], maxPending=${r.stripe.webhook.maxPendingWebhooks}${r.stripe.webhook.note ? ` — ${r.stripe.webhook.note}` : ''}`);
    }
  }
  L.push('');

  L.push('Fulfillment side effects (should be empty for a held concierge beta order):');
  L.push(`  story artifact  : ${r.artifacts.storyArtifactPresent ? 'PRESENT ⚠' : 'none'}`);
  L.push(`  proof ready     : ${r.artifacts.proofReady ? 'YES ⚠' : 'no'}`);
  L.push(`  page artifacts  : ${r.artifacts.pageArtifactCount}${r.artifacts.pageArtifactCount > 0 ? ' ⚠' : ''}`);
  L.push(`  print job       : ${r.artifacts.printJobId ?? 'none'}${r.artifacts.printJobId ? ' ⚠' : ''}`);
  L.push(`  print interior  : ${r.artifacts.printInteriorArtifactPresent ? 'PRESENT ⚠' : 'none'}`);
  L.push(`  print cover     : ${r.artifacts.printCoverArtifactPresent ? 'PRESENT ⚠' : 'none'}`);
  L.push(`  refunded        : ${r.artifacts.refunded ? 'YES' : 'no'}`);
  if (r.proofGate) {
    const reasons = r.proofGate.reasons ?? [];
    L.push(`  proof gate      : gated=${r.proofGate.gated ?? 'unknown'} allowed=${r.proofGate.allowed ?? 'unknown'} override=${r.proofGate.overrideApplied ?? 'unknown'}${reasons.length ? ` reasons=${reasons.join(',')}` : ''}`);
  }
  L.push('');

  L.push('Intake:');
  L.push(`  customStoryBrief: ${r.customStoryBrief.present ? `present (source=${r.customStoryBrief.source}${r.customStoryBrief.keys.length ? `, keys: ${r.customStoryBrief.keys.join(', ')}` : ''})` : 'ABSENT'}`);
  L.push('');

  if (r.staleCopyHits.length) {
    L.push('Stale/risky customer copy:');
    for (const h of r.staleCopyHits) {
      L.push(`  [${h.patternId}] ${h.field} — ${h.note}: "${h.excerpt}"`);
    }
    L.push('');
  }

  L.push('Blockers / follow-ups:');
  if (r.safety.blockers.length === 0 && r.safety.followUps.length === 0) {
    L.push('  (none)');
  } else {
    for (const b of r.safety.blockers) L.push(`  [RED]    ${b}`);
    for (const f of r.safety.followUps) L.push(`  [YELLOW] ${f}`);
  }

  return L.join('\n');
}

// ── CLI entry ──────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.orderId && !args.email && !args.stripeSession)) {
    console.log(HELP);
    process.exit(args.help ? 0 : 2);
  }

  const resolved = await resolveOrder(args);
  const diag = resolved.order ? buildOrderDiagnostics(resolved.order) : null;

  // Prefer the stored session id (it's the one the app actually used); fall
  // back to a session id passed on the CLI.
  const sessionForStripe = resolved.order?.stripeSessionId ?? args.stripeSession ?? null;
  const stripe = await loadStripeFacts(sessionForStripe);

  const report = buildReport(args, resolved, diag, stripe);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  // Exit code mirrors the verdict so callers can gate on it:
  //   GREEN=0, YELLOW=10, RED=20.
  process.exit(report.verdict === VERDICT.RED ? 20 : report.verdict === VERDICT.YELLOW ? 10 : 0);
}

const __isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (__isCli) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
