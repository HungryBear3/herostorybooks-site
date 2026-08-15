/**
 * Synthetic-fixture seeder for the customer text-editor e2e suite.
 *
 * Runs OUT OF PROCESS from the Playwright runner (`node --experimental-strip-types`)
 * so it can import the real production order/fingerprint code with the repo's
 * native `.ts` import style. The Playwright fixtures shell out to this.
 *
 * SAFETY: writes ONLY to the local filesystem order store named by
 * HSB_ORDER_STORE_DIR, with every provider/blob credential stripped. It cannot
 * touch production orders, blobs, email, payment, print, or any external
 * service. All customer data is synthetic and uses .invalid hostnames.
 *
 * Usage:
 *   node --experimental-strip-types tests/e2e/seed-cli.ts seed '<json spec>'
 *   node --experimental-strip-types tests/e2e/seed-cli.ts read '<orderId>'
 */
import { createOrderRecord, persistOrder, getOrder } from '../../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../../src/lib/orders.ts';
import { proofSourceFingerprint } from '../../src/lib/fulfillment.ts';

// Never let a seeder reach a real provider, blob store, or mailbox.
for (const k of [
  'BLOB_READ_WRITE_TOKEN', 'HSB_REQUIRE_DURABLE_PERSISTENCE', 'RESEND_API_KEY',
  'OPENAI_API_KEY', 'FAL_KEY', 'GEMINI_API_KEY', 'LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET',
  'STRIPE_SECRET_KEY', 'HSB_STRIPE_SECRET_KEY',
]) delete process.env[k];

if (!process.env.HSB_ORDER_STORE_DIR) {
  throw new Error('HSB_ORDER_STORE_DIR must be set — refusing to seed without an explicit local store.');
}

const NOW = '2026-08-05T00:00:00.000Z';

/** Every lifecycle/eligibility state the suite needs, keyed to the REAL gates
 *  in evaluateProofLayoutEditCapability / evaluateProofLayoutMutationLifecycle. */
export type FixtureState =
  | 'editable'
  | 'approved'
  | 'finalized'
  | 'shipped'
  | 'in_production'
  | 'print_submitted'
  | 'refunded'
  | 'unpaid'
  | 'stale_proof';

const STATE_PATCH: Record<FixtureState, Partial<OrderRecord>> = {
  editable: {},
  approved: { reviewStatus: 'approved' },
  finalized: { fulfillmentStatus: 'complete' },
  shipped: { status: 'shipped', shippedAt: NOW },
  in_production: { status: 'print_in_production' },
  print_submitted: { printJobId: 'synthetic-print-job' },
  refunded: { refundedAt: NOW },
  unpaid: { paymentStatus: 'pending' },
  stale_proof: {},
};

export interface SeedSpec {
  id: string;
  state?: FixtureState;
  /** Token the review surface will accept. 48 chars, synthetic. */
  token?: string;
  /** Overrides page 0's story text (used for overflow fixtures). */
  storyText?: string;
  pageCount?: number;
  /** Raw OrderRecord overrides applied last. */
  overrides?: Partial<OrderRecord>;
  /**
   * Seed page 0 with an ALREADY-APPLIED override plus a live proof — the state
   * a customer is really in when they press "Reset to standard". (Applying an
   * override invalidates the live proof, so apply-then-reset in one breath is
   * not a sequence production ever serves; a rebuild happens in between.)
   */
  withOverride?: boolean;
}

function page(i: number, storyText?: string): PageArtifact {
  return {
    pageIndex: i,
    storyText: storyText ?? `Short page ${i + 1}.`,
    basePrompt: 'p',
    currentImageUrl: `https://example.invalid/p${i}.png`,
    acceptedImageUrl: `https://example.invalid/p${i}.png`,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: true,
    feedbackHistory: [],
    versionHistory: [],
  } as PageArtifact;
}

export function buildFixture(spec: SeedSpec): OrderRecord {
  const state = spec.state ?? 'editable';
  const token = spec.token ?? `tok${spec.id}`.padEnd(48, 'x').slice(0, 48);
  const pageCount = spec.pageCount ?? 2;

  const pages = Array.from({ length: pageCount }, (_, i) =>
    page(i, i === 0 ? spec.storyText : undefined));

  const order: OrderRecord = {
    ...createOrderRecord(
      { childName: 'Kid', bookFormat: 'digital', email: 'synthetic@example.invalid' },
      { id: spec.id, now: NOW },
    ),
    paymentStatus: 'paid',
    reviewStatus: 'in_review',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.invalid/proof.pdf',
    proofVersion: 'pv_1',
    proofReviewedAt: null,
    proofReviewedVersion: null,
    proofApprovalToken: token,
    pageArtifacts: pages,
    auditEvents: [],
    ...STATE_PATCH[state],
    ...(spec.overrides ?? {}),
  } as OrderRecord;

  if (spec.withOverride) {
    order.pageArtifacts = [
      {
        ...order.pageArtifacts![0],
        proofCardOverride: {
          x: 0.1, y: 0.12, width: 0.6, height: 0.3, opacity: 0.9, fontScale: 1,
          textColor: 'dark_brown',
          authoredAgainstProofVersion: 'pv_1',
          authoredAgainstFingerprint: 'pf_seed',
          appliedAt: NOW,
          appliedBy: 'customer',
        },
      },
      ...order.pageArtifacts!.slice(1),
    ];
  }

  // Fingerprint LAST so it matches the final page set — except for the
  // deliberately-stale fixture, which must NOT match its own pages.
  order.proofSourceFingerprint = state === 'stale_proof'
    ? 'pf_00000000000000000000000000000000'
    : proofSourceFingerprint(order);

  return order;
}

const [, , mode, payload] = process.argv;

// Only act as a CLI when invoked directly — importing buildFixture() from a
// test must never seed anything as a side effect.
const invokedDirectly = import.meta.filename === process.argv[1];

if (!invokedDirectly) {
  // imported as a library — nothing to do
} else if (mode === 'seed') {
  const spec = JSON.parse(payload ?? '{}') as SeedSpec;
  const order = buildFixture(spec);
  await persistOrder(order);
  process.stdout.write(JSON.stringify({
    orderId: order.id,
    token: order.proofApprovalToken,
    proofVersion: order.proofVersion,
    proofSourceFingerprint: order.proofSourceFingerprint,
  }));
} else if (mode === 'read') {
  const order = await getOrder(payload!);
  process.stdout.write(JSON.stringify(order ?? null));
} else {
  throw new Error(`unknown mode: ${mode}`);
}
