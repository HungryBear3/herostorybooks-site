/**
 * The four confirmed recovery defects, driven through the REAL decision helpers.
 *
 * Every assertion here executes production code rather than reading the
 * component source. The banner is proved by rendering its complete line list;
 * the retained-marker decision is proved by driving real browser storage
 * doubles; the rotation decision is proved by replaying two Continue clicks.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  CHECKOUT_SUBMIT_UNCONFIRMED,
} from '../src/lib/checkout-handoff.ts';
import {
  CURRENT_ORDER_NOT_SENT_GUIDANCE,
  NOT_CHARGED,
  PREVIOUS_CHECKOUT_PAID_RECOVERY,
  PREVIOUS_CHECKOUT_PAID_RECOVERY_NO_ACTION,
  PREVIOUS_CHECKOUT_UNRESOLVED_WARNING,
  SUBMIT_BANNER_HEADING_FAILED,
  SUBMIT_BANNER_HEADING_PAID,
  SUBMIT_BANNER_HEADING_UNRESOLVED,
  checkoutSubmitBanner,
  describeCheckoutSubmitError,
} from '../src/lib/checkout-direct-intake-error-copy.ts';
import {
  CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY,
  CHECKOUT_ATTEMPT_ID_STORAGE_KEY,
  CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY,
  CHECKOUT_ATTEMPT_SENT_STORAGE_KEY,
  type CheckoutSubmitAttemptRisk,
  checkoutAttemptWasSent,
  checkoutAttemptStorageUnavailable,
  checkoutSubmitAttemptRisk,
  checkoutSubmitBannerAttemptRisk,
  clearCheckoutAttemptStorage,
  readCheckoutAttemptStorageSnapshot,
  recordCheckoutAttemptReserved,
  recordCheckoutAttemptSent,
} from '../src/lib/checkout-saved-draft.ts';
import {
  type CheckoutAttemptRestartDecision,
  checkoutAttemptRotationAuthorized,
  decideCheckoutAttemptContinue,
  resolveCheckoutAttemptSubmitLease,
  resolveServerCheckoutAttemptLease,
  resolveStoredCheckoutAttemptForNewPurchase,
} from '../src/lib/checkout-attempt-restart-client.ts';

const OLD_ATTEMPT = 'a'.repeat(32);
const NEW_ATTEMPT = 'b'.repeat(32);

const ALL_RISKS: CheckoutSubmitAttemptRisk[] = [
  'none',
  'previous_attempt_resolved',
  'previous_attempt_unresolved',
  'previous_attempt_paid',
  'current_order_request_sent',
];

/** A sessionStorage double whose contents the test controls. */
function browserStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };
}

/** Storage that accepts the cleanup tombstone but refuses every removal. */
function cleanupFailingStorage(attemptId: string) {
  const storage = browserStorage({
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY]: attemptId,
    [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY]: attemptId,
    [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY]: attemptId,
  });
  return { ...storage, removeItem() { /* the browser silently ignores removal */ } };
}

// ── 1. The rendered banner may never volunteer a no-charge claim ─────────────

test('no banner branch except a provably unsent click can render the no-charge sentence', () => {
  for (const attemptRisk of ALL_RISKS) {
    for (const recordedVoiceHint of [false, true]) {
      const banner = checkoutSubmitBanner({
        message: `We couldn't finish saving your hero photo securely. ${NOT_CHARGED}`,
        attemptRisk,
        recordedVoiceHint,
      });
      const rendered = banner.lines.join(' ');
      if (attemptRisk === 'none') {
        assert.equal(banner.noChargeReassurance, true, attemptRisk);
        assert.ok(rendered.includes(NOT_CHARGED), attemptRisk);
        continue;
      }
      assert.equal(
        banner.noChargeReassurance,
        false,
        `${attemptRisk} must not authorize categorical no-charge copy`,
      );
      assert.doesNotMatch(
        rendered,
        /not been charged|no charge|nothing was charged/i,
        `${attemptRisk} rendered the banner with an unproven no-charge claim`,
      );
    }
  }
});

test('a paid prior attempt is classified as previous_attempt_paid, not merely resolved', () => {
  // `previousAttemptResolved` is true for BOTH terminal restart reasons.
  // Collapsing the paid case into "resolved" would route it through the
  // generic resolved-banner path (heading "We couldn't start your order.",
  // no explicit new-purchase action) instead of the paid-recovery path.
  assert.equal(
    checkoutSubmitAttemptRisk({
      requestSent: false,
      previouslySent: true,
      previousAttemptResolved: true,
      previousAttemptPaid: true,
    }),
    'previous_attempt_paid',
    'a resolved-and-paid attempt must classify as paid, not the generic resolved risk',
  );
  assert.equal(
    checkoutSubmitAttemptRisk({
      requestSent: false,
      previouslySent: true,
      previousAttemptResolved: true,
      previousAttemptPaid: false,
    }),
    'previous_attempt_resolved',
    'an expired-unpaid resolution must keep the generic resolved risk',
  );

  const banner = checkoutSubmitBanner({
    message: PREVIOUS_CHECKOUT_PAID_RECOVERY,
    attemptRisk: checkoutSubmitAttemptRisk({
      requestSent: false,
      previouslySent: true,
      previousAttemptResolved: true,
      previousAttemptPaid: true,
    }),
    paidAttemptId: OLD_ATTEMPT,
  });
  assert.equal(banner.heading, SUBMIT_BANNER_HEADING_PAID);
  assert.equal(banner.newPurchaseActionRequired, true);
  assert.equal(banner.noChargeReassurance, false);
});

test('a completed-paid restart followed by a failed browser cleanup renders no no-charge claim', () => {
  // Restart approval covers completed_paid. The old code marked that state
  // `previous_attempt_resolved`, which cleared chargeUnconfirmed, and the banner
  // then appended "You have not been charged." to an ALREADY PAID purchase.
  const described = describeCheckoutSubmitError({
    code: 'order_request_failed',
    attemptRisk: 'previous_attempt_resolved',
    serverMessage:
      'This browser could not safely close your previous checkout attempt. '
      + 'No new order request was sent. Please reload this page and try again.',
  });
  const banner = checkoutSubmitBanner({
    message: described.message,
    attemptRisk: 'previous_attempt_resolved',
    recordedVoiceHint: described.showRecordedVoiceHint,
  });

  assert.equal(banner.visible, true);
  assert.equal(banner.heading, SUBMIT_BANNER_HEADING_FAILED);
  assert.equal(banner.noChargeReassurance, false);
  assert.ok(banner.message.endsWith(CURRENT_ORDER_NOT_SENT_GUIDANCE));
  assert.doesNotMatch(banner.lines.join(' '), /not been charged|no charge/i);
});

test('the checkout page cannot append the no-charge sentence outside the banner helper', () => {
  const form = fs.readFileSync(
    path.join(process.cwd(), 'src/app/checkout/checkout-form.tsx'),
    'utf8',
  );
  assert.equal(
    form.split('You have not been charged.').length - 1,
    0,
    'the page must own no literal no-charge copy; only the audited helper may emit it',
  );
});

// ── 2. Resolution evidence must outlive the submit that proved it ────────────

test('an approved restart whose browser cleanup failed stays resolved for later picker errors', () => {
  const storage = cleanupFailingStorage(OLD_ATTEMPT);

  // The submit proved the old attempt terminal, then failed to clear it.
  assert.equal(
    clearCheckoutAttemptStorage(storage, OLD_ATTEMPT),
    false,
    'this scenario requires the cleanup to fail',
  );
  assert.equal(storage.getItem(CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY), OLD_ATTEMPT);

  // A later non-submit error (photo picker) carries no explicit risk.
  const withoutEvidence = checkoutSubmitBannerAttemptRisk({
    storage,
    inMemoryAttemptId: null,
    inMemorySentAttemptId: null,
    resolvedAttemptId: null,
  });
  assert.equal(
    withoutEvidence,
    'previous_attempt_unresolved',
    'without retained evidence the stale marker resurrects ambiguity',
  );

  const withEvidence = checkoutSubmitBannerAttemptRisk({
    storage,
    inMemoryAttemptId: null,
    inMemorySentAttemptId: null,
    resolvedAttemptId: OLD_ATTEMPT,
  });
  assert.equal(
    withEvidence,
    'previous_attempt_resolved',
    'retained evidence keyed to the exact prior attempt must survive the failed cleanup',
  );

  const banner = checkoutSubmitBanner({
    message: "We couldn't accept that photo: please choose a JPG, PNG, or WebP photo.",
    attemptRisk: withEvidence,
    recordedVoiceHint: false,
  });
  assert.ok(banner.message.endsWith(CURRENT_ORDER_NOT_SENT_GUIDANCE));
  assert.doesNotMatch(banner.lines.join(' '), /not been charged|do not pay again/i);
});

test('paid evidence survives failed cleanup and a later non-submit error for the same attempt', () => {
  const storage = cleanupFailingStorage(OLD_ATTEMPT);
  assert.equal(clearCheckoutAttemptStorage(storage, OLD_ATTEMPT), false);

  const risk = checkoutSubmitBannerAttemptRisk({
    storage,
    inMemoryAttemptId: OLD_ATTEMPT,
    inMemorySentAttemptId: OLD_ATTEMPT,
    resolvedAttemptId: OLD_ATTEMPT,
    paidAttemptId: OLD_ATTEMPT,
  });
  assert.equal(risk, 'previous_attempt_paid');

  const banner = checkoutSubmitBanner({
    message: "We couldn't accept that photo.",
    attemptRisk: risk,
    paidAttemptId: OLD_ATTEMPT,
  });
  assert.equal(banner.heading, SUBMIT_BANNER_HEADING_PAID);
  assert.equal(banner.newPurchaseActionRequired, true);
  assert.equal(banner.noChargeReassurance, false);
});

test('retained resolution evidence is keyed: it never launders a different or unreadable identity', () => {
  const otherAttempt = browserStorage({
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY]: NEW_ATTEMPT,
    [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY]: NEW_ATTEMPT,
  });
  assert.equal(
    checkoutSubmitBannerAttemptRisk({
      storage: otherAttempt,
      inMemoryAttemptId: null,
      inMemorySentAttemptId: null,
      resolvedAttemptId: OLD_ATTEMPT,
    }),
    'previous_attempt_unresolved',
    'evidence for one attempt must not resolve a different attempt',
  );

  const unreadable = {
    getItem() { throw new DOMException('denied', 'SecurityError'); },
    setItem() { throw new DOMException('denied', 'SecurityError'); },
    removeItem() { throw new DOMException('denied', 'SecurityError'); },
  };
  assert.equal(
    checkoutSubmitBannerAttemptRisk({
      storage: unreadable,
      inMemoryAttemptId: OLD_ATTEMPT,
      inMemorySentAttemptId: null,
      resolvedAttemptId: OLD_ATTEMPT,
    }),
    'previous_attempt_unresolved',
    'an unreliable snapshot can never be resolved by an in-memory claim',
  );
});

test('resolved evidence never launders conflicting durable/current/sent identities', () => {
  const durableOld = browserStorage({
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY]: OLD_ATTEMPT,
    [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY]: OLD_ATTEMPT,
  });
  const matrix = [
    {
      label: 'reserved durable A vs in-memory sent B',
      storage: browserStorage({
        [CHECKOUT_ATTEMPT_ID_STORAGE_KEY]: OLD_ATTEMPT,
        [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY]: OLD_ATTEMPT,
      }),
      current: OLD_ATTEMPT,
      sent: NEW_ATTEMPT,
    },
    {
      label: 'durable A vs current B',
      storage: durableOld,
      current: NEW_ATTEMPT,
      sent: OLD_ATTEMPT,
    },
    {
      label: 'durable A vs sent B',
      storage: durableOld,
      current: OLD_ATTEMPT,
      sent: NEW_ATTEMPT,
    },
    {
      label: 'current A vs sent B with reliable empty storage',
      storage: browserStorage(),
      current: OLD_ATTEMPT,
      sent: NEW_ATTEMPT,
    },
  ];
  for (const row of matrix) {
    assert.equal(
      checkoutSubmitBannerAttemptRisk({
        storage: row.storage,
        inMemoryAttemptId: row.current,
        inMemorySentAttemptId: row.sent,
        resolvedAttemptId: OLD_ATTEMPT,
        paidAttemptId: OLD_ATTEMPT,
      }),
      'previous_attempt_unresolved',
      row.label,
    );
  }

  assert.equal(
    checkoutSubmitBannerAttemptRisk({
      storage: durableOld,
      inMemoryAttemptId: OLD_ATTEMPT,
      inMemorySentAttemptId: OLD_ATTEMPT,
      resolvedAttemptId: OLD_ATTEMPT,
      paidAttemptId: OLD_ATTEMPT,
    }),
    'previous_attempt_paid',
    'A/A/A paid evidence remains valid',
  );
  assert.equal(
    checkoutSubmitBannerAttemptRisk({
      storage: durableOld,
      inMemoryAttemptId: OLD_ATTEMPT,
      inMemorySentAttemptId: OLD_ATTEMPT,
      resolvedAttemptId: NEW_ATTEMPT,
      paidAttemptId: OLD_ATTEMPT,
    }),
    'previous_attempt_unresolved',
    'paid evidence without matching resolution evidence must fail closed',
  );
});

test('an unsent reserved attempt is still classified as no-risk', () => {
  const storage = browserStorage({
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY]: NEW_ATTEMPT,
    [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY]: NEW_ATTEMPT,
  });
  assert.equal(
    checkoutSubmitBannerAttemptRisk({
      storage,
      inMemoryAttemptId: NEW_ATTEMPT,
      inMemorySentAttemptId: null,
      resolvedAttemptId: null,
    }),
    'none',
  );
});

// ── 3. A reused cookie lease is not a fresh attempt ──────────────────────────

function leaseFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;
}

test('a reused cookie lease plus a local preparation failure makes no no-charge claim', async () => {
  const lease = await resolveServerCheckoutAttemptLease(
    leaseFetch({ status: 'ready', attemptId: OLD_ATTEMPT, provenance: 'reused' }),
    null,
  );
  assert.deepEqual(lease, { status: 'ready', attemptId: OLD_ATTEMPT, provenance: 'reused' });

  // The lease-backed submit then fails locally, before /api/order.
  const attemptRisk = checkoutSubmitAttemptRisk({
    requestSent: false,
    previouslySent: lease.status === 'ready' && lease.provenance !== 'fresh',
  });
  assert.equal(attemptRisk, 'previous_attempt_unresolved');

  const banner = checkoutSubmitBanner({
    message: `We couldn't finish saving your hero photo securely. ${NOT_CHARGED}`,
    attemptRisk,
    recordedVoiceHint: true,
  });
  assert.equal(banner.noChargeReassurance, false);
  assert.equal(banner.showRecordedVoiceHint, false);
  assert.doesNotMatch(banner.lines.join(' '), /not been charged|no charge/i);
  assert.ok(banner.message.endsWith(PREVIOUS_CHECKOUT_UNRESOLVED_WARNING));
});

test('a freshly minted lease is the only lease provenance that proves nothing was sent', async () => {
  const fresh = await resolveServerCheckoutAttemptLease(
    leaseFetch({ status: 'ready', attemptId: NEW_ATTEMPT, provenance: 'fresh' }),
    null,
  );
  assert.deepEqual(fresh, { status: 'ready', attemptId: NEW_ATTEMPT, provenance: 'fresh' });
  assert.equal(
    checkoutSubmitBanner({
      message: 'We could not read that photo.',
      attemptRisk: checkoutSubmitAttemptRisk({ requestSent: false, previouslySent: false }),
      recordedVoiceHint: false,
    }).noChargeReassurance,
    true,
  );
});

test('a lease response without closed provenance is unavailable', async () => {
  for (const body of [
    { status: 'ready', attemptId: OLD_ATTEMPT },
    { status: 'ready', attemptId: OLD_ATTEMPT, provenance: 'brand-new' },
    { status: 'ready', attemptId: OLD_ATTEMPT, provenance: null },
  ]) {
    const lease = await resolveServerCheckoutAttemptLease(leaseFetch(body), null);
    assert.deepEqual(lease, { status: 'unavailable' }, JSON.stringify(body));
  }
});

test('an unusable lease response is unavailable rather than a usable fresh identity', async () => {
  for (const [body, status] of [
    [{ status: 'ready', attemptId: 'nope' }, 200],
    [{ status: 'unknown' }, 200],
    [{ status: 'ready', attemptId: OLD_ATTEMPT }, 503],
  ] as const) {
    const lease = await resolveServerCheckoutAttemptLease(leaseFetch(body, status), null);
    assert.deepEqual(lease, { status: 'unavailable' }, JSON.stringify(body));
  }
});

test('unavailable lease explicitly aborts storage-denied submit orchestration', async () => {
  const deniedStorage = {
    getItem() { throw new DOMException('denied', 'SecurityError'); },
    setItem() { throw new DOMException('denied', 'SecurityError'); },
    removeItem() { throw new DOMException('denied', 'SecurityError'); },
  };
  const snapshot = readCheckoutAttemptStorageSnapshot(deniedStorage);
  assert.equal(checkoutAttemptStorageUnavailable(deniedStorage, snapshot), true);

  for (const body of [
    {},
    { status: 'ready', attemptId: 'malformed' },
    { status: 'unknown', reason: 'provider_ambiguous' },
  ]) {
    const transition = await resolveCheckoutAttemptSubmitLease({
      storage: deniedStorage,
      snapshot,
      fetchImpl: leaseFetch(body),
      lockManager: null,
    });
    assert.deepEqual(transition, { action: 'abort_unresolved' }, JSON.stringify(body));

    const banner = checkoutSubmitBanner({
      message: 'Checkout attempt recovery is unavailable.',
      attemptRisk: 'previous_attempt_unresolved',
    });
    assert.equal(banner.noChargeReassurance, false);
    assert.equal(banner.newPurchaseActionRequired, false);
  }
});

test('a paid cookie lease routes to confirmation instead of handing back a payable identity', async () => {
  const lease = await resolveServerCheckoutAttemptLease(
    leaseFetch({ status: 'paid_confirmation_required', attemptId: OLD_ATTEMPT }),
    null,
  );
  assert.deepEqual(lease, { status: 'paid_confirmation_required', attemptId: OLD_ATTEMPT });
});

test('paid-cookie recovery offers no ineffective new-purchase action without an exact attempt id', async () => {
  const unidentified = await resolveServerCheckoutAttemptLease(
    leaseFetch({ status: 'paid_confirmation_required' }),
    null,
  );
  assert.deepEqual(unidentified, { status: 'paid_confirmation_required', attemptId: null });

  const withoutIdentity = checkoutSubmitBanner({
    message: PREVIOUS_CHECKOUT_PAID_RECOVERY,
    attemptRisk: 'previous_attempt_paid',
    paidAttemptId: null,
  });
  assert.equal(withoutIdentity.heading, SUBMIT_BANNER_HEADING_PAID);
  assert.equal(withoutIdentity.newPurchaseActionRequired, false);
  assert.equal(withoutIdentity.message, PREVIOUS_CHECKOUT_PAID_RECOVERY_NO_ACTION);
  assert.doesNotMatch(withoutIdentity.lines.join(' '), /start a separate new order|choose .* below/i);

  const withIdentity = checkoutSubmitBanner({
    message: PREVIOUS_CHECKOUT_PAID_RECOVERY,
    attemptRisk: 'previous_attempt_paid',
    paidAttemptId: OLD_ATTEMPT,
  });
  assert.equal(withIdentity.newPurchaseActionRequired, true);
});

// ── 4. Continue is never consent to buy a second time ────────────────────────

async function restartFetchOf(body: unknown, status = 200) {
  return resolveStoredCheckoutAttemptForNewPurchase(
    OLD_ATTEMPT,
    (async () => new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch,
  );
}

test('the restart reason survives the client boundary and only expired-unpaid authorizes rotation', async () => {
  assert.deepEqual(
    await restartFetchOf({ status: 'restart_allowed', reason: 'expired_unpaid' }),
    { status: 'restart_allowed', reason: 'expired_unpaid' },
  );
  assert.deepEqual(
    await restartFetchOf({ status: 'restart_allowed', reason: 'completed_paid' }),
    { status: 'restart_allowed', reason: 'completed_paid' },
  );
  assert.equal(
    checkoutAttemptRotationAuthorized({ status: 'restart_allowed', reason: 'expired_unpaid' }),
    true,
  );
  assert.equal(
    checkoutAttemptRotationAuthorized({ status: 'restart_allowed', reason: 'completed_paid' }),
    false,
    'a paid attempt must never rotate without an explicit new-purchase action',
  );
});

test('a restart_allowed without a recognized reason degrades to unknown', async () => {
  for (const body of [
    { status: 'restart_allowed' },
    { status: 'restart_allowed', reason: 'because' },
    { status: 'restart_allowed', reason: 'session_open' },
  ]) {
    const decision = await restartFetchOf(body);
    assert.equal(decision.status, 'unknown', JSON.stringify(body));
    assert.equal(checkoutAttemptRotationAuthorized(decision), false);
  }
});

test('restart client enforces the complete closed status/reason contract', async () => {
  const accepted: Array<[unknown, CheckoutAttemptRestartDecision]> = [
    [{ status: 'restart_allowed', reason: 'expired_unpaid' }, { status: 'restart_allowed', reason: 'expired_unpaid' }],
    [{ status: 'restart_allowed', reason: 'completed_paid' }, { status: 'restart_allowed', reason: 'completed_paid' }],
    [{ status: 'resume_required', reason: 'session_open' }, { status: 'resume_required', reason: 'session_open' }],
    [{ status: 'unknown', reason: 'invalid_attempt' }, { status: 'unknown', reason: 'invalid_attempt' }],
    [{ status: 'unknown', reason: 'identity_mismatch' }, { status: 'unknown', reason: 'identity_mismatch' }],
    [{ status: 'unknown', reason: 'provider_ambiguous' }, { status: 'unknown', reason: 'provider_ambiguous' }],
    [{ status: 'unknown', reason: 'provider_unavailable' }, { status: 'unknown', reason: 'provider_unavailable' }],
  ];
  for (const [body, expected] of accepted) {
    assert.deepEqual(await restartFetchOf(body), expected, JSON.stringify(body));
  }

  for (const body of [
    { status: 'resume_required', reason: 'completed_paid' },
    { status: 'resume_required', reason: 'provider_unavailable' },
    { status: 'unknown', reason: 'session_open' },
    { status: 'unknown', reason: 'expired_unpaid' },
    { status: 'blocked', reason: 'provider_unavailable' },
    { status: 'restart_allowed', reason: 'provider_unavailable' },
  ]) {
    const decision = await restartFetchOf(body);
    assert.deepEqual(decision, { status: 'unknown', reason: 'provider_ambiguous' }, JSON.stringify(body));
    assert.equal(checkoutAttemptRotationAuthorized(decision), false);
  }
});

test('an unresolved attempt that becomes completed_paid between Continue clicks routes to recovery', () => {
  // Click 1: the attempt is still open, so the identity is reused as-is.
  const firstClick = decideCheckoutAttemptContinue({
    attemptId: OLD_ATTEMPT,
    decision: { status: 'resume_required', reason: 'session_open' },
    newPurchaseConsentAttemptId: null,
  });
  assert.deepEqual(firstClick, { action: 'reuse_attempt' });

  // Between the clicks the buyer paid. Click 2 must NOT rotate into a second
  // payable checkout just because Continue was pressed again.
  const secondClick = decideCheckoutAttemptContinue({
    attemptId: OLD_ATTEMPT,
    decision: { status: 'restart_allowed', reason: 'completed_paid' },
    newPurchaseConsentAttemptId: null,
  });
  assert.deepEqual(secondClick, { action: 'paid_confirmation_required' });

  const banner = checkoutSubmitBanner({
    message: PREVIOUS_CHECKOUT_PAID_RECOVERY,
    attemptRisk: 'previous_attempt_paid',
    recordedVoiceHint: true,
    paidAttemptId: OLD_ATTEMPT,
  });
  assert.equal(banner.heading, SUBMIT_BANNER_HEADING_PAID);
  assert.equal(banner.message, PREVIOUS_CHECKOUT_PAID_RECOVERY);
  assert.equal(banner.noChargeReassurance, false);
  assert.equal(banner.showRecordedVoiceHint, false);
  assert.equal(banner.newPurchaseActionRequired, true);
  assert.doesNotMatch(banner.lines.join(' '), /not been charged|no charge/i);
  assert.doesNotMatch(
    banner.lines.join(' '),
    /press Continue again/i,
    'the paid banner must never promise that Continue reuses the attempt',
  );
});

test('repeated Continue clicks on a paid attempt never authorize rotation', () => {
  const paid: CheckoutAttemptRestartDecision = { status: 'restart_allowed', reason: 'completed_paid' };
  for (let click = 0; click < 5; click += 1) {
    assert.deepEqual(
      decideCheckoutAttemptContinue({
        attemptId: OLD_ATTEMPT,
        decision: paid,
        newPurchaseConsentAttemptId: null,
      }),
      { action: 'paid_confirmation_required' },
      `click ${click}`,
    );
  }
});

test('only an explicit new-purchase action for that exact attempt unlocks a second checkout', () => {
  const paid: CheckoutAttemptRestartDecision = { status: 'restart_allowed', reason: 'completed_paid' };
  assert.deepEqual(
    decideCheckoutAttemptContinue({
      attemptId: OLD_ATTEMPT,
      decision: paid,
      newPurchaseConsentAttemptId: NEW_ATTEMPT,
    }),
    { action: 'paid_confirmation_required' },
    'consent recorded for another attempt must not unlock this one',
  );
  assert.deepEqual(
    decideCheckoutAttemptContinue({
      attemptId: OLD_ATTEMPT,
      decision: paid,
      newPurchaseConsentAttemptId: OLD_ATTEMPT,
    }),
    { action: 'rotate_attempt', reason: 'completed_paid' },
  );
});

test('the unresolved warning no longer promises that Continue reuses the same attempt', () => {
  assert.doesNotMatch(
    PREVIOUS_CHECKOUT_UNRESOLVED_WARNING,
    /reuse the same checkout attempt/i,
    'that promise is false once an unresolved attempt turns out to be paid',
  );
  assert.match(PREVIOUS_CHECKOUT_UNRESOLVED_WARNING, /do not pay again/i);
  assert.match(PREVIOUS_CHECKOUT_UNRESOLVED_WARNING, /press Continue again/i);
  assert.match(PREVIOUS_CHECKOUT_UNRESOLVED_WARNING, /second payment/i);
});

// ── 5. Expired-unpaid still rotates, exactly once ───────────────────────────

test('an expired unpaid attempt rotates exactly once across repeated Continue clicks', () => {
  const storage = browserStorage({
    [CHECKOUT_ATTEMPT_ID_STORAGE_KEY]: OLD_ATTEMPT,
    [CHECKOUT_ATTEMPT_SENT_STORAGE_KEY]: OLD_ATTEMPT,
    [CHECKOUT_ATTEMPT_RESERVED_STORAGE_KEY]: OLD_ATTEMPT,
  });
  let preflights = 0;
  let rotations = 0;
  let currentAttempt = OLD_ATTEMPT;

  const pressContinue = () => {
    const previouslySent = checkoutAttemptWasSent(storage, currentAttempt, null);
    if (!previouslySent) return;
    preflights += 1;
    const decision = decideCheckoutAttemptContinue({
      attemptId: currentAttempt,
      decision: { status: 'restart_allowed', reason: 'expired_unpaid' },
      newPurchaseConsentAttemptId: null,
    });
    if (decision.action !== 'rotate_attempt') return;
    assert.equal(clearCheckoutAttemptStorage(storage, currentAttempt), true);
    currentAttempt = NEW_ATTEMPT;
    storage.setItem(CHECKOUT_ATTEMPT_ID_STORAGE_KEY, currentAttempt);
    assert.equal(recordCheckoutAttemptReserved(storage, currentAttempt), true);
    rotations += 1;
  };

  pressContinue();
  pressContinue();
  pressContinue();

  assert.equal(rotations, 1, 'the expired attempt must rotate exactly once');
  assert.equal(preflights, 1, 'a freshly reserved attempt must not re-run the preflight');
  assert.equal(currentAttempt, NEW_ATTEMPT);
  assert.equal(storage.getItem(CHECKOUT_ATTEMPT_SENT_STORAGE_KEY), null);
  assert.equal(storage.getItem(CHECKOUT_ATTEMPT_CLEANUP_STORAGE_KEY), null);

  // Once the new attempt actually dispatches, risk returns without rotating.
  assert.equal(recordCheckoutAttemptSent(storage, currentAttempt), true);
  assert.equal(checkoutAttemptWasSent(storage, currentAttempt, null), true);
});

// ── 6. Every other provider/record state stays fail-closed ──────────────────

test('open, missing, unknown, unavailable and paid-inconsistent decisions never rotate', async () => {
  const failClosed: CheckoutAttemptRestartDecision[] = [
    { status: 'resume_required', reason: 'session_open' },
    { status: 'unknown', reason: 'provider_ambiguous' },
    { status: 'unknown', reason: 'provider_unavailable' },
    { status: 'unknown', reason: 'identity_mismatch' },
    { status: 'unknown', reason: 'invalid_attempt' },
  ];
  for (const decision of failClosed) {
    assert.equal(checkoutAttemptRotationAuthorized(decision), false, decision.reason);
    assert.deepEqual(
      decideCheckoutAttemptContinue({
        attemptId: OLD_ATTEMPT,
        decision,
        newPurchaseConsentAttemptId: OLD_ATTEMPT,
      }),
      { action: 'reuse_attempt' },
      `${decision.reason} must reuse the identity even with new-purchase consent on file`,
    );
  }

  // Transport-level failures are unknown, never approval.
  const thrown = await resolveStoredCheckoutAttemptForNewPurchase(
    OLD_ATTEMPT,
    (async () => { throw new TypeError('offline'); }) as typeof fetch,
  );
  assert.deepEqual(thrown, { status: 'unknown', reason: 'provider_unavailable' });

  const refused = await restartFetchOf({ status: 'unknown' }, 503);
  assert.equal(refused.status, 'unknown');
  assert.equal(checkoutAttemptRotationAuthorized(refused), false);

  const nonJson = await resolveStoredCheckoutAttemptForNewPurchase(
    OLD_ATTEMPT,
    (async () => new Response('<html>', { status: 200 })) as typeof fetch,
  );
  assert.equal(nonJson.status, 'unknown');
});

// ── 7. A dispatched /api/order stays fully conservative ─────────────────────

test('a current /api/order dispatch keeps the fully conservative banner', () => {
  const described = describeCheckoutSubmitError({
    code: 'asset_mime_invalid',
    label: 'hero photo',
    voiceSource: 'recorded',
    attemptRisk: 'current_order_request_sent',
  });
  const banner = checkoutSubmitBanner({
    message: described.message,
    attemptRisk: 'current_order_request_sent',
    recordedVoiceHint: described.showRecordedVoiceHint,
  });

  assert.equal(banner.heading, SUBMIT_BANNER_HEADING_UNRESOLVED);
  assert.equal(banner.message, CHECKOUT_SUBMIT_UNCONFIRMED);
  assert.equal(banner.noChargeReassurance, false);
  assert.equal(banner.showRecordedVoiceHint, false);
  assert.equal(banner.newPurchaseActionRequired, false);
  assert.match(banner.lines.join(' '), /do not pay again/i);
  assert.doesNotMatch(banner.lines.join(' '), /not been charged|no charge|try again|retry|reload/i);
});

test('a dismissed banner renders nothing at all', () => {
  for (const message of [null, undefined, '']) {
    const banner = checkoutSubmitBanner({
      message,
      attemptRisk: 'current_order_request_sent',
      recordedVoiceHint: true,
    });
    assert.equal(banner.visible, false);
    assert.deepEqual(banner.lines, []);
    assert.equal(banner.noChargeReassurance, false);
    assert.equal(banner.showRecordedVoiceHint, false);
  }
});
