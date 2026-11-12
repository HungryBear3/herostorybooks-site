/**
 * The ambiguous checkout-provisioning state has to be findable and recognisable
 * by an operator: enumerable on the authenticated order list, explained on the
 * order detail page, and never rendered with the marker's own secrets.
 *
 * This slice is read-only visibility. The modules that decide incidents, scan
 * for stranded orders, and schedule work stay byte-for-byte identical to the
 * base commit — pinned below. Checkout-session provisioning is intentionally
 * changed by the separately tested Safari Private payment-safety candidate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { HISTORICAL_ORDERS_BRIDGE_SPANS_V2, type HistoricalOrdersBridgeHunk } from './support/initial-shipping-historical-orders-bridge.ts';

import {
  CHECKOUT_RECONCILIATION_LABEL,
  CHECKOUT_RECONCILIATION_WARNING,
} from '../src/lib/checkout-provisioning-evidence.ts';

const BASE_SHA = '6aef22c36e9f9b897ce7d7fae51660af46e45c8a';

function src(path: string): string {
  return readFileSync(path, 'utf8');
}

const LIST_PAGE = 'src/app/admin/orders/page.tsx';
const DETAIL_PAGE = 'src/app/admin/orders/[orderId]/page.tsx';

/**
 * The sanctioned changes to `orders.ts` since the base commit.
 *
 * Three groups, in order:
 *
 *  1. The browser-side media size preflight moved the two story-attachment
 *     caps into the browser-safe `story-media-size.ts` so the checkout page
 *     refuses an oversize file using the exact number this server boundary
 *     enforces. That extraction touches `orders.ts` in three places.
 *
 *  2. The story-media private-store fix. Customer voice notes and story
 *     documents moved off the ambient order credential and the global
 *     `HSB_BLOB_ACCESS_MODE` onto a dedicated private store addressed by
 *     `HSB_PRIVATE_READ_WRITE_TOKEN`, and checkout-media rollback learned to
 *     delete each object through the credential for ITS store. That touches
 *     `orders.ts` in six places. See `src/lib/story-media-store.ts`.
 *
 *  3. The repeat-purchase recovery fix adds one atomic checkout-attempt
 *     retirement helper. The helper is separately exercised against the real
 *     CAS store; this normalizer declares that intentional write-surface change.
 *
 *  4. Safari Private mode adds one atomic semantic-intent claim primitive.
 *     Route-level concurrency tests prove the primitive converges different
 *     browser lease ids before provider creation.
 *
 * Each rule rewrites exactly one of those places back to its base form. A rule
 * that does not apply exactly once fails, and the whole-file equality check
 * that follows still has to hold — so any OTHER byte that moved, anywhere in
 * the file, is a failure. This narrows the freeze; it does not relax it.
 */
const ORDERS_SANCTIONED_TRANSFORMS: ReadonlyArray<{
  description: string;
  candidate: string;
  base: string;
}> = [
  {
    description: 'import of the canonical story-media size policy',
    candidate: "import { STORY_MEDIA_MAX_BYTES } from './story-media-size.ts';\n",
    base: '',
  },
  {
    description: 'MAX_VOICE_BYTES reading the canonical audio cap',
    candidate: 'export const MAX_VOICE_BYTES = STORY_MEDIA_MAX_BYTES.audio;',
    base: 'export const MAX_VOICE_BYTES = 15 * 1024 * 1024;',
  },
  {
    description: 'MAX_DOCUMENT_BYTES reading the canonical document cap',
    candidate: 'export const MAX_DOCUMENT_BYTES = STORY_MEDIA_MAX_BYTES.document;',
    base: 'export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;',
  },
  {
    description: 'import of the private story-media store policy',
    candidate: `import {
  classifyOrderMediaLane,
  storyMediaPrivateToken,
  storyMediaPrivateTokenProblem,
  type OrderMediaLane,
} from './story-media-store.ts';
`,
    base: '',
  },
  {
    description: 'story-media credential resolver replacing the global access-mode assertion',
    candidate: `/**
 * Resolve the credential customer story media must be written with.
 *
 * Story media lives in its OWN private Blob store, addressed by an explicit
 * \`HSB_PRIVATE_READ_WRITE_TOKEN\`. It is NOT the ambient order/photo store and
 * NOT governed by \`HSB_BLOB_ACCESS_MODE\`: that global also governs order JSON
 * and hero photos, and the Production order store is public and rejects a
 * private write. See \`./story-media-store.ts\`.
 *
 * Throws before any SDK call when the private credential is missing or names
 * the same store as the public one — so a misconfiguration fails checkout
 * closed BEFORE Stripe rather than putting consented child audio in a public
 * store. The message never contains a token value.
 */
export function assertPrivateStorySourceStorage(
  orderId: string,
): { access: 'private'; token: string } {
  const token = storyMediaPrivateToken();
  if (!token) {
    throw new OrderPersistenceError(
      orderId,
      \`Private Blob storage is required for customer voice notes and story documents: \${storyMediaPrivateTokenProblem()}\`,
    );
  }
  return { access: 'private', token };
}`,
    base: `/**
 * Upload an attached child-voice audio file to durable blob storage. Mirrors
 * uploadOrderPhoto's fail-before-Stripe contract in production-like envs.
 */
export function assertPrivateStorySourceStorage(orderId: string): 'private' {
  const access = getBlobAccessMode();
  if (access !== 'private') {
    throw new OrderPersistenceError(
      orderId,
      'Private Blob storage is required for customer voice notes and story documents.',
    );
  }
  return access;
}`,
  },
  {
    description: 'uploadOrderVoice resolving the private credential',
    candidate: `  if (typeof file.arrayBuffer !== 'function') {
    return null;
  }

  // Local dev with no private story-media store: explicit, expected behavior.
  // Production-like envs fall through to the assertion below, which throws.
  if (!storyMediaPrivateToken() && !requiresDurablePersistence()) {
    return null;
  }

  const { access, token } = assertPrivateStorySourceStorage(orderId);`,
    base: `  const token = getBlobToken();

  if (typeof file.arrayBuffer !== 'function') {
    return null;
  }

  if (!token) {
    if (requiresDurablePersistence()) {
      console.error(
        \`[orders] uploadOrderVoice: BLOB_READ_WRITE_TOKEN is not set in a production-like environment (orderId=\${orderId}). Refusing to drop customer voice note silently.\`,
      );
      throw new OrderPersistenceError(
        orderId,
        'BLOB_READ_WRITE_TOKEN missing in production — cannot durably store customer voice note',
      );
    }
    return null;
  }

  const access = assertPrivateStorySourceStorage(orderId);`,
  },
  {
    description: 'uploadOrderDocument resolving the private credential',
    candidate: `  if (typeof file.arrayBuffer !== 'function') return null;

  // Same contract as uploadOrderVoice: dev without the private store is a
  // silent no-op, production-like is a hard stop before Stripe.
  if (!storyMediaPrivateToken() && !requiresDurablePersistence()) return null;

  const { access, token } = assertPrivateStorySourceStorage(orderId);`,
    base: `  const token = getBlobToken();

  if (typeof file.arrayBuffer !== 'function') return null;
  if (!token) {
    if (requiresDurablePersistence()) {
      console.error(
        \`[orders] uploadOrderDocument: BLOB_READ_WRITE_TOKEN is not set in a production-like environment (orderId=\${orderId}). Refusing to drop customer document silently.\`,
      );
      throw new OrderPersistenceError(
        orderId,
        'BLOB_READ_WRITE_TOKEN missing in production — cannot durably store customer document',
      );
    }
    return null;
  }

  const access = assertPrivateStorySourceStorage(orderId);`,
  },
  {
    description: 'lane-aware rollback dependency and its contract',
    candidate: `  deleteBlob?: (pathname: string, lane: OrderMediaLane) => Promise<void>;
}

/**
 * Delete media uploaded during a checkout that failed before its final order
 * record was persisted. Each object gets one retry before the failure is
 * surfaced.
 *
 * A single failed checkout can straddle BOTH stores — hero and supporting
 * photos in the public order store, voice and document in the private
 * story-media store — and a Blob token can only delete from the store it is
 * scoped to. So each path is classified into its lane and deleted with that
 * lane's credential.
 *
 * Classification is fail-closed and namespace-constrained: a path must sit
 * directly under this order's \`orders/<id>/[checkout-<lease>/]\` prefix AND
 * match one of the exact names the uploaders produce
 * (\`classifyOrderMediaLane\`). Anything else is refused before a single delete
 * — otherwise a caller could choose both the object AND the credential it is
 * deleted with, which is a strictly worse primitive than the arbitrary-path
 * deletion the prefix check already prevented.
 */`,
    base: `  deleteBlob?: (pathname: string) => Promise<void>;
}

/**
 * Delete media uploaded during a checkout that failed before its final order
 * record was persisted. Paths are constrained to the deterministic namespace
 * for this order so a caller can never turn cleanup into arbitrary Blob
 * deletion. Each object gets one retry before the failure is surfaced.
 */`,
  },
  {
    description: 'rollback routing each object to the credential for its own store',
    candidate: `  const laneByPath = new Map<string, OrderMediaLane>();
  for (const pathname of uniquePaths) {
    const lane = pathname.startsWith(expectedPrefix)
      ? classifyOrderMediaLane(pathname.slice(expectedPrefix.length))
      : null;
    if (!lane) {
      throw new OrderPersistenceError(
        orderId,
        \`Refusing checkout-media rollback outside the order namespace: \${pathname}\`,
      );
    }
    laneByPath.set(pathname, lane);
  }

  const tokenForLane: Record<OrderMediaLane, string | undefined> = {
    public: getBlobToken(),
    private: storyMediaPrivateToken() ?? undefined,
  };
  let deleteBlob = deps.deleteBlob;
  if (!deleteBlob) {
    const missing = [...new Set(laneByPath.values())].filter((lane) => !tokenForLane[lane]);
    if (missing.length > 0) {
      if (requiresDurablePersistence()) {
        throw new OrderPersistenceError(
          orderId,
          \`Blob credential missing in production — cannot roll back uploaded customer media (\${missing.sort().join(', ')} store)\`,
        );
      }
      return 0;
    }
    deleteBlob = async (pathname: string, lane: OrderMediaLane) => {
      await del(pathname, { token: tokenForLane[lane]! });
    };
  }

  const failures: Array<{ pathname: string; cause: unknown }> = [];
  for (const [pathname, lane] of laneByPath) {
    let deleted = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2 && !deleted; attempt += 1) {
      try {
        await deleteBlob(pathname, lane);`,
    base: `  for (const pathname of uniquePaths) {
    const relative = pathname.slice(expectedPrefix.length);
    if (!pathname.startsWith(expectedPrefix)
      || !relative
      || relative.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new OrderPersistenceError(
        orderId,
        \`Refusing checkout-media rollback outside the order namespace: \${pathname}\`,
      );
    }
  }

  const token = getBlobToken();
  const deleteBlob = deps.deleteBlob ?? (token
    ? async (pathname: string) => { await del(pathname, { token }); }
    : null);
  if (!deleteBlob) {
    if (requiresDurablePersistence()) {
      throw new OrderPersistenceError(
        orderId,
        'BLOB_READ_WRITE_TOKEN missing in production — cannot roll back uploaded customer media',
      );
    }
    return 0;
  }

  const failures: Array<{ pathname: string; cause: unknown }> = [];
  for (const pathname of uniquePaths) {
    let deleted = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2 && !deleted; attempt += 1) {
      try {
        await deleteBlob(pathname);`,
  },
  {
    description: 'atomic retirement of an exact expired unpaid checkout attempt',
    candidate: `/**
 * Atomically retire an exact expired+unpaid checkout attempt after Stripe has
 * already proven its bound Session terminal. The caller supplies the
 * authoritative snapshot used for that provider lookup; any concurrent lease,
 * generation, candidate, provisioning, Session, fingerprint, or payment change
 * aborts the retirement so a browser cannot rotate into a second payable path.
 */
export async function retireExpiredCheckoutAttempt(observed: OrderRecord): Promise<boolean> {
  if (!observed.checkoutAttemptId || !observed.stripeSessionId) return false;
  const retired = await withOrderTransaction<boolean>(observed.id, (current) => {
    if (current.paymentStatus !== 'pending'
      || current.checkoutAttemptId !== observed.checkoutAttemptId
      || current.checkoutFingerprint !== observed.checkoutFingerprint
      || current.stripeSessionId !== observed.stripeSessionId
      || current.checkoutSessionAttempt !== observed.checkoutSessionAttempt
      || current.checkoutLeaseId !== observed.checkoutLeaseId
      || current.checkoutLeaseExpiresAt !== observed.checkoutLeaseExpiresAt
      || current.checkoutSessionCandidate
      || current.checkoutSessionProvisioning) {
      return { abort: false };
    }
    const updated: OrderRecord = {
      ...current,
      paymentStatus: 'failed',
      fulfillmentLastError: 'stripe_session_expired_unpaid',
      checkoutLeaseId: null,
      checkoutLeaseExpiresAt: null,
      updatedAt: new Date().toISOString(),
    };
    return { commit: updated, result: true };
  });
  return retired;
}

`,
    base: '',
  },
  {
    description: 'semantic checkout-intent fingerprint field',
    candidate: `  /** PII-free SHA-256 key for the atomic semantic checkout-intent claim. */
  checkoutIntentFingerprint?: string | null;
`,
    base: '',
  },
];

// Initial-shipping provenance supplement (SCOPE_ADMIT): exactly one parseBlobToken
// import and one factory block right after resolveOrderStoreAdapter; the inverse
// must reconstruct the exact pre-addition orders.ts before the transforms below.
const IS_PROVENANCE_IMPORT_ANCHOR =
  "import { finalizationFingerprint, parseSelectionEntry, type FinalizedSelectionEntry } from './checkout-intake.ts';\n";
const IS_PROVENANCE_IMPORT = "import { parseBlobToken } from './checkout-blob-identity.ts';\n";
const IS_PROVENANCE_PREFIX = '  return localOrderStoreAdapter();\n}\n\n';
const IS_PROVENANCE_START = '/** Narrow bound initial-shipping provenance marker access (H3).';
const IS_PROVENANCE_END = '/** A cached commit, tagged with the write generation that published it. */';
const IS_PROVENANCE_BLOCK_SHA256 = '054c27dbe42e2ebbd099bf2747f8f8e3b2328a5cb990b136d9d66c50be212ac3';
const IS_PROVENANCE_PRE_ADDITION_SHA256 = '3a718b98810ac86813b7c397da687c027aebbae7a21570af0e983cd916450c2d';
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const SHIPPING_TYPE_IMPORT = "import type { InitialShippingOrderMetadataV1, InitialShippingSettlementV1 } from './initial-shipping-contract.ts';\n";
const SHIPPING_TYPE_FIELDS = '  initialShipping?: InitialShippingOrderMetadataV1;\n  initialShippingSettlement?: InitialShippingSettlementV1;\n';
function withoutInitialShippingTypeAddition(source: string): string {
  const importAnchor = IS_PROVENANCE_IMPORT + SHIPPING_TYPE_IMPORT;
  const fieldAnchor = 'export interface OrderRecord extends OrderInput {\n' + SHIPPING_TYPE_FIELDS;
  assert.equal(source.split(SHIPPING_TYPE_IMPORT).length - 1, 1, 'exact type import once');
  assert.equal(source.split(importAnchor).length - 1, 1, 'exact type import location');
  assert.equal(source.split(SHIPPING_TYPE_FIELDS).length - 1, 1, 'exact optional type fields once');
  assert.equal(source.split(fieldAnchor).length - 1, 1, 'exact type field location');
  return source.replace(importAnchor, IS_PROVENANCE_IMPORT).replace(fieldAnchor, 'export interface OrderRecord extends OrderInput {\n');
}
// Required print delivery phone (SCOPE_ADMIT): exactly one declaration-only
// merge onto ShippingAddress, immediately before the additive-types end marker.
// Removed first so every accepted-HEAD/historical oracle below sees exact bytes.
const PHONE_TYPE_ANCHOR = "  printStatus: 'awaiting_files' | 'ready_for_print' | 'submitted' | 'shipped';\n}\n";
const PHONE_TYPE_END = '// PRINT_COMMERCE_ADDITIVE_END_TYPES\n';
const PHONE_TYPE_BLOCK = [
  '/**',
  ' * Delivery contact (2026-10-29). Declaration-merged onto `ShippingAddress`',
  ' * so the frozen base declaration above stays byte-identical. Both fields are',
  ' * collected by Stripe hosted Checkout for standard print formats and copied',
  ' * here by the signed webhook; `null` means never collected — nothing',
  ' * downstream invents them, and print release refuses until an operator',
  ' * records the contact.',
  ' */',
  'export interface ShippingAddress {',
  '  /** Recipient name as Stripe collected it with the address. */',
  '  name?: string | null;',
  '  /** Delivery phone (E.164 when Stripe supplied it). Required by the print provider. */',
  '  phone?: string | null;',
  '}',
  '',
].join('\n');
function withoutPrintDeliveryContactType(source: string): string {
  const placed = PHONE_TYPE_ANCHOR + PHONE_TYPE_BLOCK + PHONE_TYPE_END;
  assert.equal(source.split(PHONE_TYPE_BLOCK).length - 1, 1, 'delivery contact type block exactly once');
  assert.equal(source.split(placed).length - 1, 1, 'delivery contact type block in its exact place');
  return source.replace(placed, () => PHONE_TYPE_ANCHOR + PHONE_TYPE_END);
}
function withoutInitialShippingProvenanceAddition(source: string): string {
  source = withoutInitialShippingTypeAddition(withoutPrintDeliveryContactType(source));
  const count = (needle: string) => source.split(needle).length - 1;
  assert.equal(count(IS_PROVENANCE_IMPORT), 1, 'provenance import exactly once');
  assert.equal(count(IS_PROVENANCE_IMPORT_ANCHOR + IS_PROVENANCE_IMPORT), 1, 'provenance import in its exact place');
  assert.equal(count(IS_PROVENANCE_START), 1, 'provenance factory exactly once');
  const start = source.indexOf(IS_PROVENANCE_START);
  assert.equal(source.slice(start - IS_PROVENANCE_PREFIX.length, start), IS_PROVENANCE_PREFIX, 'factory right after the resolver');
  const end = source.indexOf(IS_PROVENANCE_END, start);
  assert.ok(end > start, 'factory ends before the cached-commit declaration');
  assert.equal(sha256(source.slice(start, end)), IS_PROVENANCE_BLOCK_SHA256, 'factory bytes are the frozen authored block');
  const withoutBlock = source.slice(0, start) + source.slice(end);
  return withoutBlock.replace(IS_PROVENANCE_IMPORT_ANCHOR + IS_PROVENANCE_IMPORT, () => IS_PROVENANCE_IMPORT_ANCHOR);
}

// Historical assertion evidence, NOT a replacement expected value. The b5
// assertion failed on exact unchanged HEAD when explicitly invoked (the HEAD
// suite never called it). V2 supersedes that assertion rather than claiming it
// passes: whole accepted HEAD protection + finite residual inverse + original
// historical Git equality. Original assertion/native RED remain in the packet.
const ORIGINAL_SEMANTIC_BLOCK_PIN = 'b5c0be87cd7fd5e23386c3ef0a3290345e2fc547d0df7931bfc8eea4b6ef7e9e';
const ACCEPTED_ORDERS_HEAD = '46ca97bece38c92b6b8c7d39ecd607ebbe4b6e30';
const HISTORICAL_ORDERS_SHA256 = 'f7022ce0fee47746b75820d8166033768213cd77fc75303a131dec52bacdca8b';
const BRIDGE_V2_SHA256 = '482efbc3f82fdbd9b2fb380c85d1f70c46e9a603963528b5c7800a5561cd05c4';
const HISTORICAL_ORDERS_BRIDGE_V2: readonly HistoricalOrdersBridgeHunk[] = loadHistoricalOrdersBridgeV2();
function loadHistoricalOrdersBridgeV2(): readonly HistoricalOrdersBridgeHunk[] {
  assert.equal(sha256(JSON.stringify(HISTORICAL_ORDERS_BRIDGE_SPANS_V2)),
    '955bd80ef01c9a4c91f8de3d9f8fdaa95ff2f8d6bd23512604902eec9d2c9703', 'bridge v2 span identity');
  const readOrigin = (revision: string) => execFileSync('git', ['show', `${revision}:src/lib/orders.ts`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const accepted = readOrigin(ACCEPTED_ORDERS_HEAD);
  const historical = readOrigin(BASE_SHA);
  assert.equal(sha256(accepted), IS_PROVENANCE_PRE_ADDITION_SHA256, 'bridge v2 accepted Git origin');
  assert.equal(sha256(historical), HISTORICAL_ORDERS_SHA256, 'bridge v2 historical Git origin');
  const preimage = applyOriginalOrdersTransforms(accepted);
  return HISTORICAL_ORDERS_BRIDGE_SPANS_V2.map((span) => Object.freeze({
    id: span.id, offset: span.offset,
    candidate: preimage.slice(span.offset, span.offset + span.length),
    base: historical.slice(span.baseOffset, span.baseOffset + span.baseLength),
    sha256: span.sha256, baseSha256: span.baseSha256,
  }));
}

function assertBridgeV2Fixture(rules: readonly HistoricalOrdersBridgeHunk[]): void {
  assert.equal(sha256(JSON.stringify(rules)), BRIDGE_V2_SHA256, 'bridge v2 fixture identity');
}
function invertHistoricalHunk(source: string, rule: HistoricalOrdersBridgeHunk): string {
  assert.equal(sha256(rule.candidate), rule.sha256, `${rule.id}: candidate hash`);
  assert.equal(sha256(rule.base), rule.baseSha256, `${rule.id}: base hash`);
  assert.equal(source.split(rule.candidate).length - 1, 1, `${rule.id}: exact occurrence`);
  assert.equal(source.indexOf(rule.candidate), rule.offset, `${rule.id}: exact location`);
  return source.slice(0, rule.offset) + rule.base + source.slice(rule.offset + rule.candidate.length);
}
function invertHistoricalBridgeV2(source: string, rules = HISTORICAL_ORDERS_BRIDGE_V2): string {
  assertBridgeV2Fixture(rules);
  // Descending offsets keep each hunk's original location stable.
  for (const rule of rules) source = invertHistoricalHunk(source, rule);
  assert.equal(sha256(source), HISTORICAL_ORDERS_SHA256, 'bridge v2 whole historical output');
  return source;
}
function applyOriginalOrdersTransforms(normalized: string): string {
  for (const rule of ORDERS_SANCTIONED_TRANSFORMS) {
    const occurrences = normalized.split(rule.candidate).length - 1;
    assert.equal(
      occurrences,
      1,
      `src/lib/orders.ts must carry the ${rule.description} exactly once, found ${occurrences}`,
    );
    // A function replacer: no `$&`-style expansion out of the base text.
    normalized = normalized.replace(rule.candidate, () => rule.base);
  }
  return normalized;
}
function withoutStoryMediaSizeExtraction(candidate: string): string {
  const accepted = withoutInitialShippingProvenanceAddition(candidate);
  // Protect EVERY byte, including bodies the historical inverse maps away.
  assert.equal(sha256(accepted), IS_PROVENANCE_PRE_ADDITION_SHA256, 'accepted HEAD whole orders bytes');
  return invertHistoricalBridgeV2(applyOriginalOrdersTransforms(accepted));
}

/** Exact sanctioned schedule additions and branch-only Preview suppression.
 *  Every other byte, including all other Git configuration and schedules,
 *  stays frozen to the base commit after these reversible transformations. */
const VERCEL_SANCTIONED_TRANSFORMS: ReadonlyArray<{
  description: string;
  candidate: string;
  base: string;
}> = [
  {
    description: 'only the two approved literal release branches disable Preview deployment',
    candidate: `  "git": {
    "deploymentEnabled": {
      "rex/hsb-safeoff-20261019-jrm7sg1b": false,
      "rex/hsb-expedited-shipping-20261109": false
    }
  },
`,
    base: '',
  },
  {
    description: 'public FAQ route redirects to the rendered homepage FAQ anchor',
    candidate: `    },
    {
      "source": "/faq",
      "destination": "/#faq",
      "permanent": true
    },
    {
      "source": "/fleccas",
`,
    base: `    },
    {
      "source": "/fleccas",
`,
  },
  {
    description: 'approved Fleccas short-link redirect',
    candidate: `    },
    {
      "source": "/fleccas",
      "destination": "https://herostorybooks.com/?utm_source=fleccas&utm_medium=podcast&utm_campaign=october_2026",
      "permanent": false
    }
  ],
`,
    base: `    }
  ],
`,
  },
  {
    // Successor group-book lifecycle redesign: the scheduled source-photo
    // retention pass, appended after every existing schedule.
    description: 'group-book retention sweep schedule',
    candidate: `    },
    {
      "path": "/api/cron/group-book-retention-sweep",
      "schedule": "41 5 * * *"
    }
  ]
`,
    base: `    }
  ]
`,
  },
  {
    description: 'confirmation-email recovery sweep schedule',
    candidate: `    },
    {
      "path": "/api/cron/confirmation-email-sweep",
      "schedule": "7,22,37,52 * * * *"
    }
  ]
`,
    base: `    }
  ]
`,
  },
];

function withoutConfirmationEmailSweepSchedule(candidate: string): string {
  assert.deepEqual(JSON.parse(candidate).git, {
    deploymentEnabled: {
      'rex/hsb-safeoff-20261019-jrm7sg1b': false,
      'rex/hsb-expedited-shipping-20261109': false,
    },
  }, 'the exact suppression must be the top-level Git configuration');
  let normalized = candidate;
  for (const rule of VERCEL_SANCTIONED_TRANSFORMS) {
    const occurrences = normalized.split(rule.candidate).length - 1;
    assert.equal(
      occurrences,
      1,
      `vercel.json must carry the ${rule.description} exactly once, found ${occurrences}`,
    );
    // A function replacer: no `$&`-style expansion out of the base text.
    normalized = normalized.replace(rule.candidate, () => rule.base);
  }
  return normalized;
}

const SHIPPING_FULFILLMENT_INVERSE = [
  {
    "candidate": "import crypto from 'node:crypto';\nimport { preclaimShippingGate, prepareProductionDispatch, productionAuthorizationMatches, type ExpeditedDispatchAuthorization } from './initial-shipping-dispatch.ts';\nimport { readOrderInitialShipping } from './initial-shipping-contract.ts';\nimport { put } from '@vercel/blob';\n\nimport { applyFulfillmentPatchTo, getOrder, getOrderPhotoUrl, isPrintFormat, OrderVersionConflictError, orderRequiresReferenceImage, readOrderVersioned, updateFulfillmentState, withBlobNamespace, withOrderTransaction } from './orders.ts';\n",
    "base": "import crypto from 'node:crypto';\nimport { put } from '@vercel/blob';\n\nimport { applyFulfillmentPatchTo, getOrder, getOrderPhotoUrl, isPrintFormat, OrderVersionConflictError, orderRequiresReferenceImage, readOrderVersioned, updateFulfillmentState, withBlobNamespace, withOrderTransaction } from './orders.ts';\n",
    "sha256": "4d7891c66e33e09c15c62b5ebbd2f4eacdee9cf730d04a468c0fc08fe9e60ced"
  },
  {
    "candidate": "  buildPrintCoverPdf?: (widthPoints: number, heightPoints: number, title: string, order: OrderRecord) => Buffer;\n  calculateCoverDimensions?: (order: OrderRecord, interiorPageCount: number) => Promise<{ widthPt: number; heightPt: number }>;\n  uploadArtifact?: (orderId: string, buffer: Buffer, filename: string) => Promise<string>;\n  submitPrint?: (order: OrderRecord, options?: { authorization?: ExpeditedDispatchAuthorization }) => Promise<{ jobId: string }>;\n  sleep?: (ms: number) => Promise<void>;\n  getBaseUrl?: () => string;\n}\n",
    "base": "  buildPrintCoverPdf?: (widthPoints: number, heightPoints: number, title: string, order: OrderRecord) => Buffer;\n  calculateCoverDimensions?: (order: OrderRecord, interiorPageCount: number) => Promise<{ widthPt: number; heightPt: number }>;\n  uploadArtifact?: (orderId: string, buffer: Buffer, filename: string) => Promise<string>;\n  submitPrint?: (order: OrderRecord) => Promise<{ jobId: string }>;\n  sleep?: (ms: number) => Promise<void>;\n  getBaseUrl?: () => string;\n}\n",
    "sha256": "e8589b520792ee1b3c435228cd80c93e6a2fc6b7dfe295639d2a76f3b831ad95"
  },
  {
    "candidate": "  if (initialRefusal) throw new Error(`Refusing print: ${initialRefusal}`);\n\n  let hydratedOrder = order;\n  let generatedCover: Buffer | undefined;\n  if (!order.printCoverArtifactUrl || !order.printCoverMd5) {\n    const dims = await _calculateCoverDimensions(order, order.printInteriorPageCount);\n    const coverBuffer = await _buildPrintCoverPdf(dims.widthPt, dims.heightPt, order.printTitle, order);\n    generatedCover = coverBuffer;\n    const safeSlug = order.childName.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);\n    const coverUrl = await _upload(order.id, coverBuffer, `${safeSlug}-cover.pdf`);\n    hydratedOrder = (await updateFulfillmentState(order.id, paidFulfillmentPatch(order, {\n",
    "base": "  if (initialRefusal) throw new Error(`Refusing print: ${initialRefusal}`);\n\n  let hydratedOrder = order;\n  if (!order.printCoverArtifactUrl || !order.printCoverMd5) {\n    const dims = await _calculateCoverDimensions(order, order.printInteriorPageCount);\n    const coverBuffer = await _buildPrintCoverPdf(dims.widthPt, dims.heightPt, order.printTitle, order);\n    const safeSlug = order.childName.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);\n    const coverUrl = await _upload(order.id, coverBuffer, `${safeSlug}-cover.pdf`);\n    hydratedOrder = (await updateFulfillmentState(order.id, paidFulfillmentPatch(order, {\n",
    "sha256": "5b7d94754f43f5d0f48d36f9d93f2922d87d39e0034050830639673a904aa08d"
  },
  {
    "candidate": "    ? printReleaseRefusal(authoritative, ['submitting_to_print'])\n    : 'order_not_found';\n  if (boundaryRefusal) throw new Error(`Refusing print: ${boundaryRefusal}`);\n  if (preclaimShippingGate(order) !== 'standard' && (\n    authoritative!.proofVersion !== order.proofVersion || authoritative!.proofSourceFingerprint !== order.proofSourceFingerprint ||\n    authoritative!.printInteriorArtifactUrl !== order.printInteriorArtifactUrl || authoritative!.printInteriorMd5 !== order.printInteriorMd5 ||\n    (generatedCover && (authoritative!.printCoverArtifactUrl !== hydratedOrder.printCoverArtifactUrl || authoritative!.printCoverMd5 !== hydratedOrder.printCoverMd5))\n  )) throw new Error('shipping_hold:dispatch_artifact_drift');\n\n  // Persist the ambiguity fence BEFORE the irreversible POST. A crash or lost\n  // response after this write must require provider reconciliation, never an\n  // ordinary retry that could create a second physical print job.\n  const preflight = await prepareProductionDispatch(authoritative!, generatedCover);\n  if (preflight.kind === 'hold') throw new Error(`shipping_hold:${preflight.reason}`);\n  const authorization = preflight.kind === 'authorized' ? preflight.authorization : undefined;\n  const expectedProofVersion = authoritative!.proofVersion;\n  const submissionOrder = await withOrderTransaction<OrderRecord | null>(\n    order.id,\n",
    "base": "    ? printReleaseRefusal(authoritative, ['submitting_to_print'])\n    : 'order_not_found';\n  if (boundaryRefusal) throw new Error(`Refusing print: ${boundaryRefusal}`);\n\n  // Persist the ambiguity fence BEFORE the irreversible POST. A crash or lost\n  // response after this write must require provider reconciliation, never an\n  // ordinary retry that could create a second physical print job.\n  const expectedProofVersion = authoritative!.proofVersion;\n  const submissionOrder = await withOrderTransaction<OrderRecord | null>(\n    order.id,\n",
    "sha256": "29488f34093b149c45ad074e9e4294a6ffdcdc475397164547005d01cb7a8965"
  },
  {
    "candidate": "        refusal ||\n        current.proofVersion !== expectedProofVersion ||\n        current.printInteriorProofVersion !== expectedProofVersion ||\n        current.printSubmissionAttemptedAt ||\n        (authorization ? !productionAuthorizationMatches(authorization, current) : preclaimShippingGate(current) !== 'standard')\n      ) {\n        return { abort: null };\n      }\n",
    "base": "        refusal ||\n        current.proofVersion !== expectedProofVersion ||\n        current.printInteriorProofVersion !== expectedProofVersion ||\n        current.printSubmissionAttemptedAt\n      ) {\n        return { abort: null };\n      }\n",
    "sha256": "2a34aac39ae7f556936da3fa2faeb0aa04b2ef02e2881f8b88eb9bb418213146"
  },
  {
    "candidate": "  if (!submissionOrder) throw new Error('Refusing print: submission_attempt_fence_failed');\n  const expectedSubmissionAt = submissionOrder.printSubmissionAttemptedAt;\n\n  const result = await _submitPrint(submissionOrder, authorization ? { authorization } : undefined);\n\n  const afterPrint = await withOrderTransaction<OrderRecord | null>(\n    order.id,\n",
    "base": "  if (!submissionOrder) throw new Error('Refusing print: submission_attempt_fence_failed');\n  const expectedSubmissionAt = submissionOrder.printSubmissionAttemptedAt;\n\n  const result = await _submitPrint(submissionOrder);\n\n  const afterPrint = await withOrderTransaction<OrderRecord | null>(\n    order.id,\n",
    "sha256": "855beaf59d4100be41a655b63ca135019bfd5f58caf8fac6d1e910ec01640192"
  },
  {
    "candidate": "        const refusal = printReleaseRefusal(order, ['proof_ready']);\n        if (refusal) return { abort: { claimed: false, ok: false, error: refusal } };\n\n        if (preclaimShippingGate(order) === 'hold') {\n          const read = readOrderInitialShipping(order);\n          const reason = read.kind === 'malformed' ? 'metadata_malformed' : read.kind === 'present' ? read.settlement.reason ?? 'refund_or_terminal' : 'metadata_malformed';\n          const next: OrderRecord = { ...order, fulfillmentStatus: 'failed_manual_review',\n            fulfillmentLastError: `shipping_hold:${reason}`, updatedAt: new Date().toISOString() };\n          return { commit: next, result: { claimed: false, ok: false, error: 'shipping_hold' } };\n        }\n        const claimedOrder: OrderRecord = {\n          ...order,\n          fulfillmentStatus: 'submitting_to_print',\n",
    "base": "        const refusal = printReleaseRefusal(order, ['proof_ready']);\n        if (refusal) return { abort: { claimed: false, ok: false, error: refusal } };\n\n        const claimedOrder: OrderRecord = {\n          ...order,\n          fulfillmentStatus: 'submitting_to_print',\n",
    "sha256": "d3cbbcb15438b20969c2aa3cb530d2b010f62543374c48d97345f1ed0e9eb20a"
  },
  {
    "candidate": "    await runPrintProduction(claim.order, deps);\n    return { ok: true };\n  } catch (error) {\n    const expedited = readOrderInitialShipping(claim.order).kind !== 'absent';\n    const raw = error instanceof Error ? error.message : '';\n    // Never persist provider echoes/contact/transport exceptions on the public order.\n    const message = expedited\n      ? (/^shipping_hold:(dispatch_[a-z_]+|metadata_malformed|refund_or_terminal)$/.test(raw) ? raw : 'shipping_dispatch_requires_operator_review')\n      : error instanceof Error ? error.message : String(error);\n    const current = await getOrder(orderId, expedited ? { logFailures: false } : {});\n    const ambiguous = Boolean(current?.printSubmissionAttemptedAt);\n    await withOrderTransaction(\n      orderId,\n",
    "base": "    await runPrintProduction(claim.order, deps);\n    return { ok: true };\n  } catch (error) {\n    const message = error instanceof Error ? error.message : String(error);\n    const current = await getOrder(orderId);\n    const ambiguous = Boolean(current?.printSubmissionAttemptedAt);\n    await withOrderTransaction(\n      orderId,\n",
    "sha256": "7da9b95a07eee29469945d8676123bb6a36ca613ec57e98e62bc96e5c97ce279"
  }
];
// Required print delivery phone (SCOPE_ADMIT): one import and one standard-lane
// contact refusal at the end of printReleaseRefusal, each in its exact place.
const PHONE_FULFILLMENT_INVERSE = [
  {
    description: 'print delivery contact import',
    candidate: "import { calculateCoverDimensions, submitPrintJob } from './lulu.ts';\nimport { printDeliveryContactRefusal } from './print-delivery-contact.ts';\n",
    base: "import { calculateCoverDimensions, submitPrintJob } from './lulu.ts';\n",
  },
  {
    description: 'standard-lane delivery contact refusal in printReleaseRefusal',
    candidate: `    return 'print_interior_stale';
  }
  // Standard lane only: the provider needs a recipient name and delivery phone
  // from the order's address. Refuse here, before the cover-dimension call and
  // the print-job POST, rather than ship with a placeholder. The expedited lane
  // carries its contact in the private draft and is decided by its own gate.
  if (preclaimShippingGate(order) === 'standard') {
    const contactRefusal = printDeliveryContactRefusal(order.shippingAddress);
    if (contactRefusal) return contactRefusal;
  }
  return null;
}
`,
    base: `    return 'print_interior_stale';
  }
  return null;
}
`,
  },
];
function withoutPrintDeliveryContactGate(source: string): string {
  for (const rule of PHONE_FULFILLMENT_INVERSE) {
    assert.equal(source.split(rule.candidate).length - 1, 1, `src/lib/fulfillment.ts must carry the ${rule.description} exactly once`);
    source = source.replace(rule.candidate, () => rule.base);
  }
  return source;
}
function withoutInitialShippingFulfillment(source: string): string {
  source = withoutPrintDeliveryContactGate(source);
  for (const rule of SHIPPING_FULFILLMENT_INVERSE) {
    assert.equal(sha256(rule.candidate), rule.sha256);
    assert.equal(source.split(rule.candidate).length - 1, 1);
    source = source.replace(rule.candidate, () => rule.base);
  }
  assert.equal(sha256(source), "778b848403bcab3f342c8891c3ba4540dd2ab4fe5f9d154a250c520171d104dd");
  return source;
}

/** Files frozen except for a declared, reversible transformation. */
const FREEZE_NORMALIZERS: Readonly<Record<string, (source: string) => string>> = {
  'src/lib/orders.ts': withoutStoryMediaSizeExtraction,
  'vercel.json': withoutConfirmationEmailSweepSchedule,
  'src/lib/fulfillment.ts': withoutInitialShippingFulfillment,
};

test('the operator copy says what the state is and forbids automatic retry', () => {
  assert.equal(CHECKOUT_RECONCILIATION_LABEL, 'Checkout reconciliation required');
  assert.equal(CHECKOUT_RECONCILIATION_WARNING, 'Do not retry payment automatically');
});

test('the admin order list enumerates orders needing checkout reconciliation', () => {
  const page = src(LIST_PAGE);
  assert.match(page, /readCheckoutProvisioningEvidence/);
  assert.match(page, /CHECKOUT_RECONCILIATION_LABEL/);
  assert.match(page, /CHECKOUT_RECONCILIATION_WARNING/);
  // The panel must enumerate: one linked order id per affected order.
  assert.match(page, /\/admin\/orders\/\$\{row\.id\}/);
});

test('the admin order detail page shows the checkout reconciliation evidence', () => {
  const page = src(DETAIL_PAGE);
  assert.match(page, /readCheckoutProvisioningEvidence/);
  assert.match(page, /CHECKOUT_RECONCILIATION_LABEL/);
  assert.match(page, /CHECKOUT_RECONCILIATION_WARNING/);
  assert.match(page, /checkoutEvidence\.status === 'reconciliation_required'/);
});

test('neither admin surface renders the marker token, nonce, or provider identifiers', () => {
  for (const path of [LIST_PAGE, DETAIL_PAGE]) {
    const page = src(path);
    for (const field of [
      'idempotencyKey',
      'checkoutAttemptId',
      'checkoutFingerprint',
      'checkoutLeaseId',
      'checkoutSessionCandidate',
      'checkoutSessionProvisioning',
    ]) {
      assert.equal(page.includes(field), false, `${path} renders ${field}`);
    }
  }
});

test('the runbook documents read-only verification and forbids automatic retry', () => {
  const runbook = src('docs/runbooks/support-stuck-order-checklist.md');
  assert.match(runbook, /Checkout reconciliation required/);
  assert.match(runbook, /Do not retry payment automatically/);
  assert.match(runbook, /read-only/i);
});

test('freeze oracle rejects Git, schedule, incident, and stranded-scan deviations', () => {
  const vercel = src('vercel.json');
  const branch = 'rex/hsb-safeoff-20261019-jrm7sg1b';
  const shipping = 'rex/hsb-expedited-shipping-20261109';
  const gitBlock = VERCEL_SANCTIONED_TRANSFORMS[0].candidate;
  const cases: Array<[string, string, string]> = [
    ['shipping wrong prefix', 'vercel.json', vercel.replace(shipping, `other/${shipping}`)],
    ['shipping similar prefix', 'vercel.json', vercel.replace(shipping, `${shipping}-other`)],
    ['shipping substituted main', 'vercel.json', vercel.replace(shipping, 'main')],
    ['shipping enabled', 'vercel.json', vercel.replace(`"${shipping}": false`, `"${shipping}": true`)],
    ['shipping missing', 'vercel.json', vercel.replace(`,\n      "${shipping}": false`, '')],
    ['old missing', 'vercel.json', vercel.replace(`      "${branch}": false,\n`, '')],
    ['shipping extra rule', 'vercel.json', vercel.replace(`"${shipping}": false`, `"${shipping}": false, "other": false`)],
    ['shipping duplicate key', 'vercel.json', vercel.replace(`"${shipping}": false`, `"${shipping}": false, "${shipping}": false`)],
    ['nested git block', 'vercel.json', vercel.replace(gitBlock, '').replace('          "type": "host",', gitBlock + '          "type": "host",')],
    ['wrong branch', 'vercel.json', vercel.replace(branch, `${branch}-other`)],
    ['main disabled', 'vercel.json', vercel.replace(branch, 'main')],
    ['wildcard disabled', 'vercel.json', vercel.replace(branch, '*')],
    ['global deployment disabled', 'vercel.json', vercel.replace(gitBlock, '  "git": { "deploymentEnabled": false },\n')],
    ['git false', 'vercel.json', vercel.replace(gitBlock, '  "git": false,\n')],
    ['branch enabled', 'vercel.json', vercel.replace(`"${branch}": false`, `"${branch}": true`)],
    ['extra main rule', 'vercel.json', vercel.replace(`"${branch}": false`, `"${branch}": false, "main": false`)],
    ['extra git setting', 'vercel.json', vercel.replace('"deploymentEnabled": {', '"extra": false, "deploymentEnabled": {')],
    ['missing git rule', 'vercel.json', vercel.replace(gitBlock, '')],
    ['duplicate git block', 'vercel.json', vercel.replace(gitBlock, gitBlock + gitBlock)],
    ['Fleccas destination changed', 'vercel.json', vercel.replace('utm_source=fleccas', 'utm_source=other')],
    ['existing schedule changed', 'vercel.json', vercel.replace('*/10 * * * *', '*/11 * * * *')],
    ['confirmation schedule changed', 'vercel.json', vercel.replace('7,22,37,52 * * * *', '8,23,38,53 * * * *')],
    ['retention schedule changed', 'vercel.json', vercel.replace('41 5 * * *', '42 5 * * *')],
    ...[
      'src/lib/order-incident.ts',
      'src/lib/stranded-order-detector.ts',
      'src/lib/stranded-order-detector-runtime.ts',
    ].map((path): [string, string, string] => [path, path, src(path) + '\n// unauthorized change\n']),
  ];
  for (const [label, path, candidate] of cases) {
    const committed = execFileSync('git', ['show', `${BASE_SHA}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const normalize = FREEZE_NORMALIZERS[path] ?? ((source: string) => source);
    // Positive control uses the very same oracle, before each negative control.
    assert.equal(normalize(src(path)), committed, `${label}: conforming control`);
    assert.notEqual(candidate, src(path), `${label}: mutation must actually change bytes`);
    assert.throws(() => assert.equal(normalize(candidate), committed),
      { code: 'ERR_ASSERTION' }, `${label}: unauthorized change must be rejected`);
  }
});

test('initial shipping provenance addition has an exact inverse and rejects unauthorized mutations', () => {
  const current = src('src/lib/orders.ts');
  const oracle = (source: string) => {
    assert.equal(sha256(withoutInitialShippingProvenanceAddition(source)), IS_PROVENANCE_PRE_ADDITION_SHA256);
  };
  oracle(current);
  const start = current.indexOf(IS_PROVENANCE_START);
  const block = current.slice(start, current.indexOf(IS_PROVENANCE_END, start));
  const inBlock = (from: string, to: string) => {
    assert.ok(block.includes(from), `block mutation anchor missing: ${from}`);
    return current.replace(block, () => block.replace(from, () => to));
  };
  const outside = (from: string, to: string) => {
    assert.equal(current.split(from).length - 1, 1, `unique outside anchor: ${from}`);
    return current.replace(from, () => to);
  };
  const cases: Array<[string, string]> = [
    ['missing type import', current.replace(SHIPPING_TYPE_IMPORT, '')],
    ['duplicate type import', current.replace(SHIPPING_TYPE_IMPORT, SHIPPING_TYPE_IMPORT + SHIPPING_TYPE_IMPORT)],
    ['moved type import', current.replace(IS_PROVENANCE_IMPORT + SHIPPING_TYPE_IMPORT, SHIPPING_TYPE_IMPORT + IS_PROVENANCE_IMPORT)],
    ['mutated type import', current.replace(SHIPPING_TYPE_IMPORT, SHIPPING_TYPE_IMPORT.replace('import type', 'import'))],
    ['missing type fields', current.replace(SHIPPING_TYPE_FIELDS, '')],
    ['duplicate type fields', current.replace(SHIPPING_TYPE_FIELDS, SHIPPING_TYPE_FIELDS + SHIPPING_TYPE_FIELDS)],
    ['reordered type fields', current.replace(SHIPPING_TYPE_FIELDS, SHIPPING_TYPE_FIELDS.split('\n').filter(Boolean).reverse().join('\n') + '\n')],
    ['mutated type fields', current.replace(SHIPPING_TYPE_FIELDS, SHIPPING_TYPE_FIELDS.replace('initialShipping?', 'initialShipping'))],
    ['missing factory', current.replace(block, '')],
    ['duplicate factory', current.replace(block, () => block + block)],
    ['relocated factory', current.replace(block, '').replace('function blobOrderStoreAdapter(', () => block + 'function blobOrderStoreAdapter(')],
    ['missing import', current.replace(IS_PROVENANCE_IMPORT, '')],
    ['duplicate import', current.replace(IS_PROVENANCE_IMPORT, () => IS_PROVENANCE_IMPORT + IS_PROVENANCE_IMPORT)],
    ['reordered import', current.replace(IS_PROVENANCE_IMPORT_ANCHOR + IS_PROVENANCE_IMPORT, () => IS_PROVENANCE_IMPORT + IS_PROVENANCE_IMPORT_ANCHOR)],
    ['mutated path', inBlock('`order-provenance/initial-shipping/${orderId}.json`', '`orders/${orderId}.json`')],
    ['mutated body', inBlock('if (body !== expected) throw invalid();', 'if (!body) throw invalid();')],
    ['mutated namespace', inBlock("namespace || '.flat'", 'namespace')],
    ['mutated token', inBlock('const token = getBlobToken() || null;', 'const token = process.env.OTHER_TOKEN || null;')],
    ['mutated mode', inBlock("{ access: 'private', token, useCache: false }", "{ access: 'private', token, useCache: true }")],
    ['mutated durable', inBlock('durable || !!process.env.VERCEL', '!!process.env.VERCEL')],
    ['no-fallback predicate removed', inBlock('if (!captured.token && captured.productionLike) throw unavailable();', '')],
    ['weakened exact reread/drift', inBlock("if (!intact()) throw new Error('initial_shipping_provenance_context_drift');", '')],
    ['local basename mapping', inBlock('return `${markerRoot}/${orderId}.json`;', 'return `${localRoot}/${orderId}.json`;')],
    ['overwrite enabled', inBlock('allowOverwrite: false,', 'allowOverwrite: true,')],
    ['broadened absence catch', inBlock('if (error instanceof BlobNotFoundError) {', 'if (error) {')],
    ['leaked adapter/replace export', inBlock('    intact,\n      async read(orderId) {', '    intact,\n      replace: blobOrderStoreAdapter(token!).replaceIfVersion,\n      async read(orderId) {')],
    ['leaked adapter export outside', current + 'export const leakedAdapter = blobOrderStoreAdapter;\n'],
    ['resolver changed', outside('  if (token) return blobOrderStoreAdapter(token);\n', '  if (token) return localOrderStoreAdapter();\n')],
    ['blob adapter changed', outside("        if (error instanceof BlobNotFoundError || isBlobNotFoundError(message)) return null;", "        if (error) return null;")],
    ['local adapter changed', outside('        await link(tmp, file); // atomic exclusive create\n        return { ok: true', '        await rename(tmp, file);\n        return { ok: true')],
    ['cache changed', outside('const recentConditionalCommits = new Map<string, CachedCommit>();', 'const recentConditionalCommits = new Map<string, CachedCommit>(); ')],
    ['CAS body changed', outside('          ifMatch: expectedVersion,\n', '')],
  ];
  for (const [label, candidate] of cases) {
    assert.notEqual(candidate, current, `${label}: mutation must actually change bytes`);
    assert.throws(() => oracle(candidate), { code: 'ERR_ASSERTION' }, `${label}: unauthorized change must be rejected`);
  }
});

test('print delivery contact additions have exact inverses and reject unauthorized mutations', () => {
  const orders = src('src/lib/orders.ts');
  const fulfillment = src('src/lib/fulfillment.ts');
  const ordersOracle = (source: string) => {
    assert.equal(sha256(withoutInitialShippingProvenanceAddition(source)), IS_PROVENANCE_PRE_ADDITION_SHA256);
  };
  const fulfillmentOracle = (source: string) => { withoutInitialShippingFulfillment(source); };
  ordersOracle(orders);
  fulfillmentOracle(fulfillment);
  const [importRule, gateRule] = PHONE_FULFILLMENT_INVERSE;
  const cases: Array<[string, string, (source: string) => void]> = [
    ['orders block missing', orders.replace(PHONE_TYPE_BLOCK, ''), ordersOracle],
    ['orders block duplicated', orders.replace(PHONE_TYPE_BLOCK, () => PHONE_TYPE_BLOCK + PHONE_TYPE_BLOCK), ordersOracle],
    ['orders block relocated', orders.replace(PHONE_TYPE_BLOCK, '').replace('export type PrintUpgradeStatus =', () => PHONE_TYPE_BLOCK + 'export type PrintUpgradeStatus ='), ordersOracle],
    ['orders block widened', orders.replace('  phone?: string | null;\n}\n', '  phone?: string | null;\n  email?: string | null;\n}\n'), ordersOracle],
    ['fulfillment import missing', fulfillment.replace(importRule.candidate, importRule.base), fulfillmentOracle],
    ['fulfillment gate missing', fulfillment.replace(gateRule.candidate, gateRule.base), fulfillmentOracle],
    ['fulfillment gate unscoped', fulfillment.replace("  if (preclaimShippingGate(order) === 'standard') {\n    const contactRefusal", "  if (true) {\n    const contactRefusal"), fulfillmentOracle],
    ['fulfillment extra refusal elsewhere', fulfillment.replace("  if (!isPrintFormat(order.bookFormat)) return 'not_print_order';", () => "  if (!isPrintFormat(order.bookFormat)) return 'not_print_order';\n  if (printDeliveryContactRefusal(order.shippingAddress)) return 'shipping_contact_missing';"), fulfillmentOracle],
  ];
  for (const [label, candidate, oracle] of cases) {
    assert.notEqual(candidate, label.startsWith('orders') ? orders : fulfillment, `${label}: mutation must actually change bytes`);
    assert.throws(() => oracle(candidate), { code: 'ERR_ASSERTION' }, `${label}: unauthorized change must be rejected`);
  }
});

test('versioned historical orders bridge v2 preserves exact accepted HEAD and original whole-file baseline', () => {
  const historical = execFileSync('git', ['show', `${BASE_SHA}:src/lib/orders.ts`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const accepted = execFileSync('git', ['show', `${ACCEPTED_ORDERS_HEAD}:src/lib/orders.ts`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(withoutInitialShippingProvenanceAddition(src('src/lib/orders.ts')), accepted);
  assert.equal(withoutStoryMediaSizeExtraction(src('src/lib/orders.ts')), historical);
});

// These tests enter the exact hunk guard directly; a later whole-file hash is
// NOT allowed to masquerade as an occurrence/location/hash rejection.
for (const rule of HISTORICAL_ORDERS_BRIDGE_V2) {
  test(`historical bridge v2 ${rule.id}: exact inverse and targeted negative controls`, () => {
    const input = applyOriginalOrdersTransforms(withoutInitialShippingProvenanceAddition(src('src/lib/orders.ts')));
    assertBridgeV2Fixture(HISTORICAL_ORDERS_BRIDGE_V2);
    const expected = input.replace(rule.candidate, () => rule.base);
    assert.equal(invertHistoricalHunk(input, rule), expected, 'positive hunk inverse first');
    assert.notEqual(expected, input, 'inverse must actually transform bytes');
    const cases: Array<[string, string, string]> = [
      ['missing', input.replace(rule.candidate, ''), 'exact occurrence'],
      ['duplicate', input.replace(rule.candidate, () => rule.candidate + rule.candidate), 'exact occurrence'],
      ['mutated', input.replace(rule.candidate, () => '!' + rule.candidate.slice(1)), 'exact occurrence'],
      ['relocated', '!' + input, 'exact location'],
    ];
    for (const [label, mutant, guard] of cases) {
      assert.equal(invertHistoricalHunk(input, rule), expected, `${label}: positive control`);
      assert.notEqual(mutant, input, `${label}: mutation applied`);
      assert.throws(() => invertHistoricalHunk(mutant, rule),
        { code: 'ERR_ASSERTION', message: new RegExp(`${rule.id}: ${guard}`) }, `${label}: intended guard`);
    }
    for (const field of ['candidate', 'base'] as const) {
      const altered = { ...rule, [field]: rule[field] + '!' };
      assert.notEqual(altered[field], rule[field]);
      assert.throws(() => invertHistoricalHunk(input, altered),
        { code: 'ERR_ASSERTION', message: new RegExp(`${rule.id}: ${field} hash`) });
    }
    const moved = { ...rule, offset: rule.offset + 1 };
    assert.notEqual(moved.offset, rule.offset);
    assert.throws(() => invertHistoricalHunk(input, moved),
      { code: 'ERR_ASSERTION', message: new RegExp(`${rule.id}: exact location`) });
  });
}

test('historical bridge v2 rejects missing duplicate reordered and coordinated-rebound fixture hunks', () => {
  const input = applyOriginalOrdersTransforms(withoutInitialShippingProvenanceAddition(src('src/lib/orders.ts')));
  const historical = execFileSync('git', ['show', `${BASE_SHA}:src/lib/orders.ts`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(invertHistoricalBridgeV2(input), historical);
  for (const [index, rule] of HISTORICAL_ORDERS_BRIDGE_V2.entries()) {
    const changed = rule.candidate + '!';
    const rebound = { ...rule, candidate: changed, sha256: sha256(changed) };
    const alteredBase = rule.base + '!';
    const cases = [
      HISTORICAL_ORDERS_BRIDGE_V2.filter((_, i) => i !== index),
      [...HISTORICAL_ORDERS_BRIDGE_V2, rule],
      [...HISTORICAL_ORDERS_BRIDGE_V2].reverse(),
      HISTORICAL_ORDERS_BRIDGE_V2.map((r, i) => i === index ? rebound : r),
      HISTORICAL_ORDERS_BRIDGE_V2.map((r, i) => i === index ? { ...r, base: alteredBase, baseSha256: sha256(alteredBase) } : r),
    ];
    for (const rules of cases) {
      assertBridgeV2Fixture(HISTORICAL_ORDERS_BRIDGE_V2);
      assert.notEqual(JSON.stringify(rules), JSON.stringify(HISTORICAL_ORDERS_BRIDGE_V2));
      assert.throws(() => invertHistoricalBridgeV2(input, rules),
        { code: 'ERR_ASSERTION', message: /bridge v2 fixture identity/ });
    }
    const reboundInput = input.replace(rule.candidate, () => changed);
    assert.notEqual(reboundInput, input);
    // Even with candidate + candidate hash rebound together, fixed manifest wins.
    assert.throws(() => invertHistoricalBridgeV2(reboundInput,
      HISTORICAL_ORDERS_BRIDGE_V2.map((r, i) => i === index ? rebound : r)),
      { code: 'ERR_ASSERTION', message: /bridge v2 fixture identity/ });
  }
});

test('historical bridge v2 whole accepted-base guard rejects protected body mutations before normalization', () => {
  const current = src('src/lib/orders.ts');
  const historical = execFileSync('git', ['show', `${BASE_SHA}:src/lib/orders.ts`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const targets = [
    ['transaction', 'const outcome = await mutate(current.order);', 'const outcome = { abort: undefined };'],
    ['cache', 'const recentConditionalCommits = new Map<string, CachedCommit>();', 'const recentConditionalCommits = new Map<string, CachedCommit>(injectedCommits);'],
    ['namespace', 'return applyBlobNamespace(`orders/${orderId}.json`, binding.namespace);', 'return applyBlobNamespace(`orders/${orderId}.json`, "");'],
    ['parser', 'const order = scrubRetiredPrivateFields(JSON.parse(serialized) as OrderRecord);', 'const order = JSON.parse(serialized) as OrderRecord;'],
    ['claim generation', 'if (claim.retiredOrderIds.includes(proposedOrderId)) {', 'if (false) {'],
  ];
  for (const [label, target, replacement] of targets) {
    assert.equal(withoutStoryMediaSizeExtraction(current), historical, `${label}: positive first`);
    assert.equal(current.split(target).length - 1, 1, `${label}: unique mutation target`);
    const mutant = current.replace(target, () => replacement);
    assert.notEqual(mutant, current, `${label}: changed`);
    assert.throws(() => withoutStoryMediaSizeExtraction(mutant),
      { code: 'ERR_ASSERTION', message: /accepted HEAD whole orders bytes/ }, `${label}: exact guard reached`);
  }
});

test('shipping fulfillment exact inverse rejects missing duplicate mutated and unrelated edits', () => {
  const current = src('src/lib/fulfillment.ts');
  const historical = execFileSync('git', ['show', `${BASE_SHA}:src/lib/fulfillment.ts`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const oracle = (value: string) => assert.equal(withoutInitialShippingFulfillment(value), historical);
  oracle(current);
  for (const rule of SHIPPING_FULFILLMENT_INVERSE) {
    for (const replacement of ['', rule.candidate + rule.candidate, rule.candidate + '/* unauthorized */']) {
      oracle(current);
      assert.throws(() => oracle(current.replace(rule.candidate, () => replacement)), { code: 'ERR_ASSERTION' });
    }
  }
  assert.throws(() => oracle(current + '// unrelated edit\n'), { code: 'ERR_ASSERTION' });
});

test('incident classification, stranded-order scans, and schedules are unchanged from the base commit', () => {
  for (const path of [
    'src/lib/order-incident.ts',
    'src/lib/stranded-order-detector.ts',
    'src/lib/stranded-order-detector-runtime.ts',
    'vercel.json',
    'src/lib/fulfillment.ts',
    'src/lib/checkout-intake-order-binding.ts',
  ]) {
    const committed = execFileSync('git', ['show', `${BASE_SHA}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const normalize = FREEZE_NORMALIZERS[path] ?? ((source: string) => source);
    assert.equal(
      normalize(src(path)),
      committed,
      `${path} differs from ${BASE_SHA} beyond its declared transformations`,
    );
  }
});
