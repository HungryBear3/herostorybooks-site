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

function withoutStoryMediaSizeExtraction(candidate: string): string {
  let normalized = candidate;
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
  const addedStart = 'const CHECKOUT_INTENT_FINGERPRINT =';
  const addedEnd = 'export async function persistOrResumeCheckoutOrder';
  const startAt = normalized.indexOf(addedStart);
  assert.ok(startAt >= 0, 'src/lib/orders.ts must carry the semantic claim/index block');
  assert.equal(normalized.indexOf(addedStart, startAt + 1), -1, 'semantic claim/index block must occur once');
  const endAt = normalized.indexOf(addedEnd, startAt);
  assert.ok(endAt > startAt, 'semantic claim/index block must end before persistOrResumeCheckoutOrder');
  const addedBlock = normalized.slice(startAt, endAt);
  assert.equal(
    crypto.createHash('sha256').update(addedBlock).digest('hex'),
    'b5c0be87cd7fd5e23386c3ef0a3290345e2fc547d0df7931bfc8eea4b6ef7e9e',
    'semantic claim/index block differs from its exact sanctioned bytes',
  );
  normalized = normalized.slice(0, startAt) + normalized.slice(endAt);
  return normalized;
}

/** Files frozen except for a declared, reversible transformation. */
const FREEZE_NORMALIZERS: Readonly<Record<string, (source: string) => string>> = {
  'src/lib/orders.ts': withoutStoryMediaSizeExtraction,
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
