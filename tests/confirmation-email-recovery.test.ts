/*
 * Confirmation-email reliability.
 *
 * Incident: a real order was durably marked paid, the webhook returned 200, and
 * neither deferred scheduler (`setImmediate` / `after()`) ever entered the send
 * path. No Resend message existed and `confirmationEmailSentAt` plus every
 * resend-claim field was null. Nothing in the repo would ever have retried it.
 *
 * These tests pin the durable recovery path: authoritative enumeration, exact
 * eligibility, a crash-safe claim with a bounded reclaim window, and a
 * deterministic provider identity so every retry converges on one confirmation.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createOrderRecord,
  getOrderAuthoritative,
  persistOrder,
  withOrderTransaction,
  type OrderRecord,
} from '../src/lib/orders.ts';
import {
  CONFIRMATION_EMAIL_CLAIM_STALE_MS,
  claimConfirmationEmail,
  deliverOrderConfirmationEmail,
  evaluateConfirmationEmailClaimability,
  recordConfirmationEmailReceipt,
  releaseConfirmationEmailClaim,
  type OrderTransactImpl,
} from '../src/lib/confirmation-email-delivery.ts';
import {
  CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT,
  CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT_MS,
  buildDefaultConfirmationEmailSweepDeps,
  evaluateConfirmationEmailSweepEligibility,
  runConfirmationEmailSweep,
  type ConfirmationEmailSweepDeps,
} from '../src/lib/confirmation-email-sweep.ts';
import {
  GET as getConfirmationEmailSweepRoute,
  __resetConfirmationEmailSweepRouteDepsForTests,
  __setConfirmationEmailSweepRouteDepsForTests,
} from '../src/app/api/cron/confirmation-email-sweep/route.ts';
import {
  buildOrderConfirmationIdempotencyKey,
  sendOrderConfirmationEmail,
} from '../src/lib/order-email.ts';

const NOW_MS = Date.parse('2026-09-21T18:00:00.000Z');
const ACTIVATION_MS = CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT_MS;
const BUYER_EMAIL = 'buyer@example.com';
const CHILD_NAME = 'Luna';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function localStore<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-confirmation-email-'));
  return withEnv(
    {
      HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
      BLOB_READ_WRITE_TOKEN: undefined,
      HSB_ORDER_STORE_DIR: dir,
      VERCEL: undefined,
      NODE_ENV: 'development',
    },
    fn,
  ).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function makePaidOrder(
  id: string,
  overrides: Partial<OrderRecord> = {},
  nowMs = NOW_MS,
): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: CHILD_NAME, bookFormat: 'digital', email: BUYER_EMAIL },
      { id, now: new Date(nowMs - 60 * 60 * 1000).toISOString() },
    ),
    paymentStatus: 'paid' as const,
    paidAt: new Date(nowMs - 30 * 60 * 1000).toISOString(),
    stripeSessionId: `cs_test_${id}`,
    ...overrides,
  } as OrderRecord;
}

function acceptedSend(id = 'msg_accepted') {
  return async () => ({ skipped: false as const, id });
}

/** Renders whatever a log sink was handed, including the parts of an Error that
 *  `JSON.stringify` would silently drop. */
function renderLogArg(value: unknown): string {
  if (value instanceof Error) return `${value.name}|${value.message}|${value.stack ?? ''}`;
  if (typeof value === 'object' && value !== null) {
    return `${JSON.stringify(value)}|${Object.values(value).map(String).join('|')}`;
  }
  return String(value);
}

test.afterEach(() => {
  __resetConfirmationEmailSweepRouteDepsForTests();
});

// ── The incident ────────────────────────────────────────────────────────────

test('the sweep delivers and records a paid order whose confirmation email was never scheduled', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_incident'));
    const sent: string[] = [];

    const result = await runConfirmationEmailSweep({
      listOrders: async () => {
        const order = await getOrderAuthoritative('ord_incident');
        return order ? [order] : [];
      },
      deliver: (orderId) => deliverOrderConfirmationEmail(orderId, {
        send: async (order) => { sent.push(order.id); return { skipped: false as const, id: 'msg_incident' }; },
        now: () => NOW_MS,
      }),
      now: () => NOW_MS,
      graceMs: 15 * 60 * 1000,
      claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
      activationPaidAtMs: ACTIVATION_MS,
      log: () => {},
      errorLog: () => {},
    });

    assert.deepEqual(sent, ['ord_incident']);
    assert.equal(result.ok, true);
    assert.equal(result.eligible, 1);
    assert.equal(result.sent, 1);

    const stored = await getOrderAuthoritative('ord_incident');
    assert.ok(stored?.confirmationEmailSentAt, 'the durable receipt must be recorded');
    assert.equal(stored?.emailResendClaimId ?? null, null, 'the claim must be released');
    assert.equal(stored?.emailResendClaimKind ?? null, null);
    assert.equal(stored?.emailResendClaimAt ?? null, null);
  });
});

test('a second sweep pass over an already-confirmed order sends nothing', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_already', {
      confirmationEmailSentAt: '2026-09-21T17:00:00.000Z',
    }));
    let sends = 0;

    const outcome = await deliverOrderConfirmationEmail('ord_already', {
      send: async () => { sends += 1; return { skipped: false as const, id: 'must-not-send' }; },
      now: () => NOW_MS,
    });

    assert.equal(sends, 0);
    assert.deepEqual(outcome, { status: 'blocked', reason: 'already_sent' });
  });
});

// ── Exact, fail-closed eligibility ──────────────────────────────────────────

test('sweep eligibility admits only paid, unrefunded, unconfirmed, unclaimed orders past the grace window', () => {
  const cfg = {
    nowMs: NOW_MS,
    graceMs: 15 * 60 * 1000,
    claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
    activationPaidAtMs: ACTIVATION_MS,
  };

  assert.equal(
    evaluateConfirmationEmailSweepEligibility(makePaidOrder('eligible'), cfg).eligible,
    true,
  );

  const ineligible: Array<[string, OrderRecord]> = [
    ['pending', makePaidOrder('pending', { paymentStatus: 'pending' })],
    ['failed', makePaidOrder('failed', { paymentStatus: 'failed' })],
    ['refunded-status', makePaidOrder('refunded_status', { paymentStatus: 'refunded' })],
    ['refunded-at', makePaidOrder('refunded_at', { refundedAt: '2026-09-21T17:50:00.000Z' })],
    ['stripe-refund', makePaidOrder('stripe_refund', { stripeRefundId: 're_123' })],
    ['refund-claim', makePaidOrder('refund_claim', { refundClaimId: 'rc_123' })],
    ['already-sent', makePaidOrder('already_sent', { confirmationEmailSentAt: '2026-09-21T17:00:00.000Z' })],
    ['missing-paidat', makePaidOrder('missing_paidat', { paidAt: null })],
    ['invalid-paidat', makePaidOrder('invalid_paidat', { paidAt: 'not-a-date' })],
    ['future-paidat', makePaidOrder('future_paidat', { paidAt: new Date(NOW_MS + 60_000).toISOString() })],
    ['below-grace', makePaidOrder('below_grace', { paidAt: new Date(NOW_MS - 60_000).toISOString() })],
    ['fresh-claim', makePaidOrder('fresh_claim', {
      emailResendClaimId: 'claim-live',
      emailResendClaimKind: 'order_confirmation',
      emailResendClaimAt: new Date(NOW_MS - 60_000).toISOString(),
    })],
    ['other-kind-claim', makePaidOrder('other_kind', {
      emailResendClaimId: 'claim-proof',
      emailResendClaimKind: 'proof_ready',
      emailResendClaimAt: new Date(NOW_MS - 10 * 60 * 60 * 1000).toISOString(),
    })],
    ['unbounded-claim', makePaidOrder('unbounded_claim', {
      emailResendClaimId: 'claim-no-timestamp',
      emailResendClaimKind: 'order_confirmation',
      emailResendClaimAt: null,
    })],
    ['unparsable-claim-at', makePaidOrder('unparsable_claim', {
      emailResendClaimId: 'claim-bad-timestamp',
      emailResendClaimKind: 'order_confirmation',
      emailResendClaimAt: 'not-a-date',
    })],
  ];

  for (const [label, order] of ineligible) {
    assert.equal(
      evaluateConfirmationEmailSweepEligibility(order, cfg).eligible,
      false,
      `expected ${label} to be ineligible`,
    );
  }

  assert.equal(
    evaluateConfirmationEmailSweepEligibility(makePaidOrder('stale_claim', {
      emailResendClaimId: 'claim-stale',
      emailResendClaimKind: 'order_confirmation',
      emailResendClaimAt: new Date(NOW_MS - CONFIRMATION_EMAIL_CLAIM_STALE_MS - 1_000).toISOString(),
    }), cfg).eligible,
    true,
    'an own-kind claim past the bounded window is reclaimable',
  );
});

// ── The fixed activation floor ──────────────────────────────────────────────

test('the activation floor is a fixed instant, not a moving max-age', () => {
  // A moving window would abandon a future incident once it aged out. This is
  // the instant the recovery path went in; everything paid before it is the
  // operator's business, not this sweep's.
  assert.equal(CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT, '2026-09-21T12:48:51.665Z');
  assert.equal(ACTIVATION_MS, Date.parse('2026-09-21T12:48:51.665Z'));
  assert.equal(buildDefaultConfirmationEmailSweepDeps().activationPaidAtMs, ACTIVATION_MS);
});

test('the activation floor admits the boundary instant and refuses everything before it', () => {
  const graceMs = 15 * 60 * 1000;
  const verdictFor = (paidAtMs: number, nowMs: number) => evaluateConfirmationEmailSweepEligibility(
    makePaidOrder('ord_boundary', { paidAt: new Date(paidAtMs).toISOString() }),
    { nowMs, graceMs, claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS, activationPaidAtMs: ACTIVATION_MS },
  );
  const wellAfter = ACTIVATION_MS + 24 * 60 * 60 * 1000;

  const justBefore = verdictFor(ACTIVATION_MS - 1, wellAfter);
  assert.equal(justBefore.eligible, false);
  assert.equal(justBefore.eligible === false && justBefore.reason, 'before_activation');
  assert.equal(verdictFor(ACTIVATION_MS, wellAfter).eligible, true, 'the boundary instant itself is in scope');
  assert.equal(verdictFor(ACTIVATION_MS + 1, wellAfter).eligible, true);

  // Grace still applies at and after the floor.
  assert.equal(verdictFor(ACTIVATION_MS, ACTIVATION_MS + graceMs - 1).eligible, false);
  assert.equal(verdictFor(ACTIVATION_MS, ACTIVATION_MS + graceMs).eligible, true);

  // No amount of elapsed time ever brings a historical order into scope.
  const historical = Date.parse('2026-05-01T00:00:00.000Z');
  assert.equal(verdictFor(historical, wellAfter).eligible, false);
  assert.equal(verdictFor(historical, wellAfter + 365 * 24 * 60 * 60 * 1000).eligible, false);
});

test('a sweep run never delivers to an order paid before the activation floor', async () => {
  let delivered = 0;
  const result = await runConfirmationEmailSweep({
    listOrders: async () => [
      makePaidOrder('ord_historical', { paidAt: new Date(ACTIVATION_MS - 1).toISOString() }),
    ],
    deliver: async () => { delivered += 1; return { status: 'sent' }; },
    now: () => NOW_MS,
    graceMs: 15 * 60 * 1000,
    claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
    activationPaidAtMs: ACTIVATION_MS,
    log: () => {},
    errorLog: () => {},
  });

  assert.equal(delivered, 0);
  assert.equal(result.eligible, 0);
  assert.equal(result.sent, 0);
  assert.equal(result.scanned, 1);
});

test('the delivery claim re-checks eligibility against the authoritative record, not the enumerated snapshot', async () => {
  await localStore(async () => {
    // The sweep saw an eligible order; by the time delivery runs it is refunded.
    await persistOrder(makePaidOrder('ord_raced_refund', {
      refundedAt: '2026-09-21T17:59:00.000Z',
    }));
    let sends = 0;

    const outcome = await deliverOrderConfirmationEmail('ord_raced_refund', {
      send: async () => { sends += 1; return { skipped: false as const, id: 'must-not-send' }; },
      now: () => NOW_MS,
    });

    assert.equal(sends, 0);
    assert.deepEqual(outcome, { status: 'blocked', reason: 'refunded' });
  });
});

test('delivery for an order that is not in the durable store fails closed', async () => {
  await localStore(async () => {
    let sends = 0;
    const outcome = await deliverOrderConfirmationEmail('ord_missing', {
      send: async () => { sends += 1; return { skipped: false as const, id: 'must-not-send' }; },
      now: () => NOW_MS,
    });
    assert.equal(sends, 0);
    assert.deepEqual(outcome, { status: 'blocked', reason: 'order_not_found' });
  });
});

// ── Claim semantics: crash-safe, bounded, never steals a live claim ──────────

test('a transient send failure releases the claim so the next sweep pass can retry', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_transient'));

    const failed = await deliverOrderConfirmationEmail('ord_transient', {
      send: async () => { throw new Error('resend 503'); },
      now: () => NOW_MS,
    });
    assert.equal(failed.status, 'failed');

    const stranded = await getOrderAuthoritative('ord_transient');
    assert.equal(stranded?.emailResendClaimId ?? null, null, 'a failed send must not strand the claim');
    assert.equal(stranded?.confirmationEmailSentAt ?? null, null);

    const retried = await deliverOrderConfirmationEmail('ord_transient', {
      send: acceptedSend('msg_retry'),
      now: () => NOW_MS,
    });
    assert.deepEqual(retried, { status: 'sent' });
    const recovered = await getOrderAuthoritative('ord_transient');
    assert.ok(recovered?.confirmationEmailSentAt);
  });
});

test('a skipped send releases the claim and does not record a receipt', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_skipped'));

    const outcome = await deliverOrderConfirmationEmail('ord_skipped', {
      send: async () => ({ skipped: true as const, reason: 'missing_resend_api_key' }),
      now: () => NOW_MS,
    });

    assert.deepEqual(outcome, { status: 'skipped', reason: 'missing_resend_api_key' });
    const stored = await getOrderAuthoritative('ord_skipped');
    assert.equal(stored?.emailResendClaimId ?? null, null);
    assert.equal(stored?.confirmationEmailSentAt ?? null, null);
  });
});

test('a claim abandoned by a crashed worker is reclaimed only after the bounded window', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_crashed'));

    // Worker A claims, then the process dies before sending.
    const claimed = await claimConfirmationEmail('ord_crashed', 'claim-a', { now: () => NOW_MS });
    assert.equal(claimed.ok, true);

    let sends = 0;
    const tooEarly = await deliverOrderConfirmationEmail('ord_crashed', {
      send: async () => { sends += 1; return { skipped: false as const, id: 'must-not-send' }; },
      now: () => NOW_MS + CONFIRMATION_EMAIL_CLAIM_STALE_MS - 1_000,
    });
    assert.deepEqual(tooEarly, { status: 'blocked', reason: 'claim_active' });
    assert.equal(sends, 0);
    assert.equal((await getOrderAuthoritative('ord_crashed'))?.emailResendClaimId, 'claim-a');

    const afterWindow = await deliverOrderConfirmationEmail('ord_crashed', {
      send: acceptedSend('msg_reclaimed'),
      now: () => NOW_MS + CONFIRMATION_EMAIL_CLAIM_STALE_MS + 1_000,
    });
    assert.deepEqual(afterWindow, { status: 'sent' });
    const stored = await getOrderAuthoritative('ord_crashed');
    assert.ok(stored?.confirmationEmailSentAt);
    assert.equal(stored?.emailResendClaimId ?? null, null);
  });
});

test('a claim held by another email flow is never reclaimed by the confirmation sweep', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_other_kind', {
      emailResendClaimId: 'claim-proof-ready',
      emailResendClaimKind: 'proof_ready',
      emailResendClaimAt: new Date(NOW_MS - 10 * 60 * 60 * 1000).toISOString(),
    }));
    let sends = 0;

    const outcome = await deliverOrderConfirmationEmail('ord_other_kind', {
      send: async () => { sends += 1; return { skipped: false as const, id: 'must-not-send' }; },
      now: () => NOW_MS,
    });

    assert.equal(sends, 0);
    assert.deepEqual(outcome, { status: 'blocked', reason: 'claim_other_kind' });
    assert.equal((await getOrderAuthoritative('ord_other_kind'))?.emailResendClaimId, 'claim-proof-ready');
  });
});

test('release and receipt never touch a claim owned by a different worker', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_foreign_claim'));
    const claimed = await claimConfirmationEmail('ord_foreign_claim', 'claim-live', { now: () => NOW_MS });
    assert.equal(claimed.ok, true);

    assert.equal(await releaseConfirmationEmailClaim('ord_foreign_claim', 'claim-other'), false);
    assert.equal(await recordConfirmationEmailReceipt('ord_foreign_claim', 'claim-other'), false);

    const stored = await getOrderAuthoritative('ord_foreign_claim');
    assert.equal(stored?.emailResendClaimId, 'claim-live');
    assert.equal(stored?.confirmationEmailSentAt ?? null, null);

    assert.equal(await releaseConfirmationEmailClaim('ord_foreign_claim', 'claim-live'), true);
    assert.equal((await getOrderAuthoritative('ord_foreign_claim'))?.emailResendClaimId ?? null, null);
  });
});

test('claimability is a pure, fail-closed predicate over the authoritative record', () => {
  const cfg = { nowMs: NOW_MS, claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS };
  assert.equal(evaluateConfirmationEmailClaimability(makePaidOrder('ok'), cfg), null);
  assert.equal(
    evaluateConfirmationEmailClaimability(makePaidOrder('p', { paymentStatus: 'pending' }), cfg),
    'not_paid',
  );
  assert.equal(
    evaluateConfirmationEmailClaimability(makePaidOrder('r', { stripeRefundId: 're_1' }), cfg),
    'refunded',
  );
  assert.equal(
    evaluateConfirmationEmailClaimability(
      makePaidOrder('s', { confirmationEmailSentAt: '2026-09-21T10:00:00.000Z' }),
      cfg,
    ),
    'already_sent',
  );
});

// ── Convergence: one provider identity, one receipt ──────────────────────────

test('concurrent deliveries for one order converge to a single send and a single receipt', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_concurrent'));
    let sends = 0;
    let releaseSend!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSend = resolve; });

    const send = async () => {
      sends += 1;
      await gate;
      return { skipped: false as const, id: 'msg_concurrent' };
    };

    const first = deliverOrderConfirmationEmail('ord_concurrent', { send, now: () => NOW_MS });
    const second = deliverOrderConfirmationEmail('ord_concurrent', { send, now: () => NOW_MS });
    await new Promise((resolve) => setImmediate(resolve));
    releaseSend();

    const outcomes = await Promise.all([first, second]);
    const statuses = outcomes.map((outcome) => outcome.status).sort();

    assert.equal(sends, 1, 'exactly one provider acceptance');
    assert.deepEqual(statuses, ['blocked', 'sent']);
    const stored = await getOrderAuthoritative('ord_concurrent');
    assert.ok(stored?.confirmationEmailSentAt);
    assert.equal(stored?.emailResendClaimId ?? null, null);
  });
});

test('a receipt write lost after provider acceptance retries under the same idempotency identity', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_ambiguous'));
    const keys: string[] = [];

    // Worker A: Resend accepted the message, then the process died before the
    // receipt write. The claim is left behind with nothing to show for it.
    const claimed = await claimConfirmationEmail('ord_ambiguous', 'claim-lost', { now: () => NOW_MS });
    assert.equal(claimed.ok, true);
    if (claimed.ok) keys.push(buildOrderConfirmationIdempotencyKey(claimed.order));

    const recovered = await deliverOrderConfirmationEmail('ord_ambiguous', {
      send: async (order) => {
        keys.push(buildOrderConfirmationIdempotencyKey(order));
        return { skipped: false as const, id: 'msg_ambiguous' };
      },
      now: () => NOW_MS + CONFIRMATION_EMAIL_CLAIM_STALE_MS + 1_000,
    });

    assert.deepEqual(recovered, { status: 'sent' });
    assert.deepEqual(keys[0], keys[1], 'the retry must reuse the first attempt\'s provider identity');
    const stored = await getOrderAuthoritative('ord_ambiguous');
    assert.ok(stored?.confirmationEmailSentAt);
    assert.equal(stored?.emailResendClaimId ?? null, null);
  });
});

test('a receipt write that lost its claim to another worker is not reported as sent', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_claim_stolen'));

    const outcome = await deliverOrderConfirmationEmail('ord_claim_stolen', {
      send: async () => {
        // A replacement claim lands while this send is in flight.
        await withOrderTransaction('ord_claim_stolen', (latest) => {
          const replacement: OrderRecord = {
            ...latest,
            emailResendClaimId: 'claim-replacement',
            emailResendClaimKind: 'order_confirmation',
            emailResendClaimAt: new Date(NOW_MS).toISOString(),
          };
          return { commit: replacement, result: replacement };
        });
        return { skipped: false as const, id: 'msg_fenced' };
      },
      now: () => NOW_MS,
    });

    assert.deepEqual(outcome, { status: 'receipt_unrecorded', reason: 'claim_lost' });
    const stored = await getOrderAuthoritative('ord_claim_stolen');
    assert.equal(stored?.emailResendClaimId, 'claim-replacement', 'the live claim is untouched');
    assert.equal(stored?.confirmationEmailSentAt ?? null, null);
  });
});

test('the sweep counts an unrecorded receipt as a visible failure, never as sent', async () => {
  const lines: string[] = [];
  const result = await runConfirmationEmailSweep({
    listOrders: async () => [makePaidOrder('ord_unrecorded')],
    deliver: async () => ({ status: 'receipt_unrecorded', reason: 'write_failed' }),
    now: () => NOW_MS,
    graceMs: 15 * 60 * 1000,
    claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
    activationPaidAtMs: ACTIVATION_MS,
    log: (line) => lines.push(line),
    errorLog: (line) => lines.push(line),
    maxDeliveries: 5,
  });

  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.ok, false, 'an unrecorded receipt must make the sweep fail visibly');
  assert.ok(lines.some((line) => line.includes('ord_unrecorded')));
});

test('a provider failure carrying customer PII never reaches either log sink argument', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_pii_error'));
    const sink: unknown[] = [];

    const outcome = await deliverOrderConfirmationEmail('ord_pii_error', {
      send: async () => {
        throw new Error(`Resend rejected ${BUYER_EMAIL} for child ${CHILD_NAME}`);
      },
      now: () => NOW_MS,
      log: (...args: unknown[]) => { sink.push(...args); },
      errorLog: (...args: unknown[]) => { sink.push(...args); },
    });

    assert.equal(outcome.status, 'failed');
    assert.ok(
      sink.every((arg) => typeof arg === 'string'),
      'the confirmation log boundary must hand its sinks strings only — never a raw error object',
    );
    const haystack = `${sink.map(renderLogArg).join('\n')}\n${JSON.stringify(outcome)}`;
    assert.doesNotMatch(haystack, /buyer@example\.com/);
    assert.doesNotMatch(haystack, new RegExp(CHILD_NAME));
    assert.doesNotMatch(haystack, /@/);
    assert.match(haystack, /ord_pii_error/, 'the opaque order handle is still logged');
  });
});

test('a sweep delivery that throws with PII in its message is logged by classification only', async () => {
  const sink: unknown[] = [];
  const result = await runConfirmationEmailSweep({
    listOrders: async () => [makePaidOrder('ord_pii_throw')],
    deliver: async () => { throw new Error(`upstream said ${BUYER_EMAIL} / ${CHILD_NAME}`); },
    now: () => NOW_MS,
    graceMs: 15 * 60 * 1000,
    claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
    activationPaidAtMs: ACTIVATION_MS,
    log: (...args: unknown[]) => { sink.push(...args); },
    errorLog: (...args: unknown[]) => { sink.push(...args); },
    maxDeliveries: 5,
  });

  assert.equal(result.failed, 1);
  assert.ok(sink.every((arg) => typeof arg === 'string'), 'the sweep must not hand a raw error to its sink');
  const haystack = `${sink.map(renderLogArg).join('\n')}\n${JSON.stringify(result)}`;
  assert.doesNotMatch(haystack, /buyer@example\.com/);
  assert.doesNotMatch(haystack, new RegExp(CHILD_NAME));
  assert.doesNotMatch(haystack, /@/);
});

test('a receipt write that throws releases our own claim so the retry is immediate', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_receipt_release'));
    const keys: string[] = [];
    let transactions = 0;

    // Claim commits; the receipt commit throws; the release that follows works.
    const transact: OrderTransactImpl = (orderId, mutate, opts) => {
      transactions += 1;
      if (transactions === 2) return Promise.reject(new Error('durable store unavailable'));
      return withOrderTransaction(orderId, mutate, opts);
    };

    const outcome = await deliverOrderConfirmationEmail('ord_receipt_release', {
      send: async (order) => {
        keys.push(buildOrderConfirmationIdempotencyKey(order));
        return { skipped: false as const, id: 'msg_release' };
      },
      transact,
      now: () => NOW_MS,
    });

    assert.deepEqual(outcome, { status: 'receipt_unrecorded', reason: 'write_failed' });
    const afterFailure = await getOrderAuthoritative('ord_receipt_release');
    assert.equal(afterFailure?.emailResendClaimId ?? null, null, 'our own claim must be released');
    assert.equal(afterFailure?.confirmationEmailSentAt ?? null, null, 'no receipt may be invented');

    // No stale window needed: the retry runs at the same instant and converges
    // on the identity the provider already accepted.
    const retried = await deliverOrderConfirmationEmail('ord_receipt_release', {
      send: async (order) => {
        keys.push(buildOrderConfirmationIdempotencyKey(order));
        return { skipped: false as const, id: 'msg_release' };
      },
      now: () => NOW_MS,
    });
    assert.deepEqual(retried, { status: 'sent' });
    assert.deepEqual(keys[0], keys[1]);
    assert.ok((await getOrderAuthoritative('ord_receipt_release'))?.confirmationEmailSentAt);
  });
});

test('a failed release after a failed receipt write retains the claim for the bounded window without leaking PII', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_release_fails'));
    const sink: unknown[] = [];
    let transactions = 0;

    // Receipt write AND the best-effort release both fail, quoting the buyer.
    const transact: OrderTransactImpl = (orderId, mutate, opts) => {
      transactions += 1;
      if (transactions === 2 || transactions === 3) {
        return Promise.reject(new Error(`store rejected ${BUYER_EMAIL} for ${CHILD_NAME}`));
      }
      return withOrderTransaction(orderId, mutate, opts);
    };

    const outcome = await deliverOrderConfirmationEmail('ord_release_fails', {
      send: acceptedSend('msg_retained'),
      transact,
      newClaimId: () => 'claim-retained',
      now: () => NOW_MS,
      log: (...args: unknown[]) => { sink.push(...args); },
      errorLog: (...args: unknown[]) => { sink.push(...args); },
    });

    assert.deepEqual(outcome, { status: 'receipt_unrecorded', reason: 'write_failed' });
    const retained = await getOrderAuthoritative('ord_release_fails');
    assert.equal(retained?.emailResendClaimId, 'claim-retained', 'the stale window is the fallback');
    assert.equal(retained?.confirmationEmailSentAt ?? null, null);

    assert.ok(sink.every((arg) => typeof arg === 'string'), 'no raw error may reach a log sink');
    const haystack = `${sink.map(renderLogArg).join('\n')}\n${JSON.stringify(outcome)}`;
    assert.doesNotMatch(haystack, /buyer@example\.com/);
    assert.doesNotMatch(haystack, new RegExp(CHILD_NAME));
    assert.doesNotMatch(haystack, /@/);

    // The bounded window is what recovers it.
    const early = await deliverOrderConfirmationEmail('ord_release_fails', {
      send: acceptedSend('must-not-send'),
      now: () => NOW_MS + CONFIRMATION_EMAIL_CLAIM_STALE_MS - 1_000,
    });
    assert.deepEqual(early, { status: 'blocked', reason: 'claim_active' });

    const reclaimed = await deliverOrderConfirmationEmail('ord_release_fails', {
      send: acceptedSend('msg_retained'),
      now: () => NOW_MS + CONFIRMATION_EMAIL_CLAIM_STALE_MS + 1_000,
    });
    assert.deepEqual(reclaimed, { status: 'sent' });
  });
});

test('an arbitrary provider skip reason is narrowed to a fixed literal at the log boundary', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_skip_reason'));
    const sink: unknown[] = [];

    const outcome = await deliverOrderConfirmationEmail('ord_skip_reason', {
      send: async () => ({ skipped: true as const, reason: `no route for ${BUYER_EMAIL} (${CHILD_NAME})` }),
      now: () => NOW_MS,
      log: (...args: unknown[]) => { sink.push(...args); },
      errorLog: (...args: unknown[]) => { sink.push(...args); },
    });

    assert.deepEqual(outcome, { status: 'skipped', reason: 'unknown_skip_reason' });
    const haystack = `${sink.map(renderLogArg).join('\n')}\n${JSON.stringify(outcome)}`;
    assert.doesNotMatch(haystack, /buyer@example\.com/);
    assert.doesNotMatch(haystack, new RegExp(CHILD_NAME));
    assert.doesNotMatch(haystack, /@/);
    assert.equal((await getOrderAuthoritative('ord_skip_reason'))?.emailResendClaimId ?? null, null);
  });
});

test('the confirmation idempotency key is deterministic per order and carries no customer identifiers', async () => {
  const order = makePaidOrder('ord_keys');
  const key = buildOrderConfirmationIdempotencyKey(order);
  assert.equal(key, 'order-confirmation-ord_keys-primary-v1');

  // Neither the customer nor the sender configuration may move the identity.
  assert.equal(
    buildOrderConfirmationIdempotencyKey({
      ...order,
      email: 'someone-else@example.com',
      childName: 'Different',
      updatedAt: '2027-01-01T00:00:00.000Z',
    }),
    key,
    'the identity is order-scoped, not attempt-scoped',
  );
  assert.equal(
    await withEnv(
      { HSB_EMAIL_FROM: SENDER_ROTATED, HSB_EMAIL_FROM_FALLBACK: SENDER_FALLBACK },
      () => buildOrderConfirmationIdempotencyKey(order),
    ),
    key,
  );
});

test('the confirmation path is off the shared sender fallback, and only the confirmation path', () => {
  const source = readFileSync(new URL('../src/lib/order-email.ts', import.meta.url), 'utf8');
  // Just this one function body — the declarations after it are the other
  // lifecycle senders, which deliberately still fall back.
  const start = source.indexOf('export async function sendOrderConfirmationEmail');
  assert.notEqual(start, -1, 'sendOrderConfirmationEmail must still exist');
  const end = source.indexOf('\nexport ', start + 1);
  assert.notEqual(end, -1, 'expected another export after the confirmation sender');
  const confirmation = source.slice(start, end);

  assert.doesNotMatch(
    confirmation,
    /sendWithFallback/,
    'a fallback changes `from`, and Resend refuses a changed body under an already-seen key',
  );
  assert.match(
    confirmation,
    /order\.confirmationEmailFrom/,
    'the send must read the frozen sender off the record',
  );
  assert.match(
    confirmation,
    /order\.confirmationEmailIdempotencyKey/,
    'and the frozen key off the record',
  );
  assert.doesNotMatch(
    confirmation,
    /getOrderSenderEmail\(\)|getFallbackSenderEmail\(\)/,
    'the confirmation send may never resolve a sender from the current environment',
  );

  // Scope containment: the other lifecycle senders keep their own two keys and
  // their existing verified-sender fallback.
  assert.match(source, /primaryIdempotencyKey: `\$\{options\.idempotencyKeyBase\}-primary`/);
  assert.match(source, /fallbackIdempotencyKey: `\$\{options\.idempotencyKeyBase\}-fallback`/);
  assert.ok(
    source.split('sendWithFallback(').length - 1 >= 4,
    'the other lifecycle emails must still route through sendWithFallback',
  );
});

// ── The persisted provider identity ─────────────────────────────────────────
//
// Resend rejects reuse of an idempotency key whose request body has changed, so
// the sender and the key are one indivisible identity. Sharing a key across a
// sender fallback makes the fallback permanently unusable; splitting the key by
// sender makes a configuration change a second way to accept the same email.
// The only safe answer is to choose the identity once, persist it durably
// beside the claim, and never move it automatically.

const SENDER_PRIMARY = 'Hero Story Books <support@herostorybooks.com>';
const SENDER_ROTATED = 'Hero Story Books <hello@herostorybooks.com>';
const SENDER_FALLBACK = 'Hero Story Books <onboarding@resend.dev>';

interface StubbedResendCall {
  body: Record<string, unknown>;
  idempotencyKey: string | null;
}

/** Drives the real Resend client over a stubbed transport so the request the
 *  provider would actually receive — `from` and `Idempotency-Key` — is
 *  observable, and so a second attempt is countable. */
function stubResendTransport(responses: Array<{ status: number; body: unknown }>) {
  const calls: StubbedResendCall[] = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    let body: Record<string, unknown> = {};
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    calls.push({ body, idempotencyKey: headers.get('Idempotency-Key') });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Claim once under a known sender configuration, then hand back the durable
 *  record so a later attempt can be driven against a different configuration. */
async function claimUnderSender(orderId: string, sender: string, claimId = 'claim-initial') {
  await persistOrder(makePaidOrder(orderId));
  const claimed = await withEnv(
    { HSB_EMAIL_FROM: sender, HSB_EMAIL_FROM_FALLBACK: undefined, EMAIL_FROM: undefined },
    () => claimConfirmationEmail(orderId, claimId, { now: () => NOW_MS }),
  );
  assert.equal(claimed.ok, true, 'the fixture claim must succeed');
  const stored = await getOrderAuthoritative(orderId);
  assert.ok(stored);
  return stored;
}

test('the initial confirmation claim durably persists exactly one sender and one provider key', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_identity_init'));

    const claimed = await withEnv(
      {
        HSB_EMAIL_FROM: SENDER_PRIMARY,
        HSB_EMAIL_FROM_FALLBACK: SENDER_FALLBACK,
        EMAIL_FROM: undefined,
      },
      () => claimConfirmationEmail('ord_identity_init', 'claim-init', { now: () => NOW_MS }),
    );

    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    assert.equal(
      claimed.order.confirmationEmailFrom,
      SENDER_PRIMARY,
      'the claim must freeze the PRIMARY configured sender — never the fallback',
    );
    assert.equal(
      claimed.order.confirmationEmailIdempotencyKey,
      'order-confirmation-ord_identity_init-primary-v1',
      'the key must be deterministic per order',
    );

    const stored = await getOrderAuthoritative('ord_identity_init');
    assert.equal(stored?.confirmationEmailFrom, SENDER_PRIMARY, 'the choice must be durable, not in-memory');
    assert.equal(stored?.confirmationEmailIdempotencyKey, 'order-confirmation-ord_identity_init-primary-v1');
  });
});

test('a retry after the configured sender changes reuses the originally persisted identity', async () => {
  await localStore(async () => {
    const claimedRecord = await claimUnderSender('ord_identity_retry', SENDER_PRIMARY, 'claim-dead');
    const originalFrom = claimedRecord.confirmationEmailFrom;
    const originalKey = claimedRecord.confirmationEmailIdempotencyKey;

    // The first worker died holding the claim. Meanwhile an operator rotated
    // HSB_EMAIL_FROM and added a fallback.
    const seen: Array<{ from?: string | null; key?: string | null }> = [];
    const outcome = await withEnv(
      {
        HSB_EMAIL_FROM: SENDER_ROTATED,
        HSB_EMAIL_FROM_FALLBACK: SENDER_FALLBACK,
        EMAIL_FROM: undefined,
      },
      () => deliverOrderConfirmationEmail('ord_identity_retry', {
        send: async (order) => {
          seen.push({
            from: order.confirmationEmailFrom,
            key: order.confirmationEmailIdempotencyKey,
          });
          return { skipped: false as const, id: 'msg_identity_retry' };
        },
        newClaimId: () => 'claim-takeover',
        now: () => NOW_MS + CONFIRMATION_EMAIL_CLAIM_STALE_MS + 1_000,
      }),
    );

    assert.deepEqual(outcome, { status: 'sent' });
    assert.deepEqual(
      seen,
      [{ from: SENDER_PRIMARY, key: 'order-confirmation-ord_identity_retry-primary-v1' }],
      'the retry must present the identity the first attempt may already have used',
    );

    const stored = await getOrderAuthoritative('ord_identity_retry');
    assert.equal(stored?.confirmationEmailFrom, originalFrom, 'a stale-claim takeover must preserve the sender');
    assert.equal(stored?.confirmationEmailIdempotencyKey, originalKey, 'and the key');
  });
});

test('provider ambiguity plus a sender configuration change cannot open a second identity', async () => {
  await localStore(async () => {
    await persistOrder(makePaidOrder('ord_identity_ambiguous'));
    const presented: Array<string> = [];
    let transactions = 0;

    // Attempt 1 under the original sender: Resend accepts, the receipt write
    // fails, and the order is handed back with nothing durable to show for it.
    const transact: OrderTransactImpl = (orderId, mutate, opts) => {
      transactions += 1;
      if (transactions === 2) return Promise.reject(new Error('durable store unavailable'));
      return withOrderTransaction(orderId, mutate, opts);
    };

    const first = await withEnv(
      { HSB_EMAIL_FROM: SENDER_PRIMARY, HSB_EMAIL_FROM_FALLBACK: undefined, EMAIL_FROM: undefined },
      () => deliverOrderConfirmationEmail('ord_identity_ambiguous', {
        send: async (order) => {
          presented.push(`${order.confirmationEmailFrom}|${order.confirmationEmailIdempotencyKey}`);
          return { skipped: false as const, id: 'msg_ambiguous_identity' };
        },
        transact,
        now: () => NOW_MS,
      }),
    );
    assert.deepEqual(first, { status: 'receipt_unrecorded', reason: 'write_failed' });

    // Attempt 2 after the operator changed both env senders.
    const second = await withEnv(
      {
        HSB_EMAIL_FROM: SENDER_ROTATED,
        HSB_EMAIL_FROM_FALLBACK: SENDER_FALLBACK,
        EMAIL_FROM: undefined,
      },
      () => deliverOrderConfirmationEmail('ord_identity_ambiguous', {
        send: async (order) => {
          presented.push(`${order.confirmationEmailFrom}|${order.confirmationEmailIdempotencyKey}`);
          return { skipped: false as const, id: 'msg_ambiguous_identity' };
        },
        now: () => NOW_MS,
      }),
    );
    assert.deepEqual(second, { status: 'sent' });

    assert.equal(presented.length, 2, 'both attempts reached the provider');
    assert.equal(
      new Set(presented).size,
      1,
      'two identities across an ambiguous acceptance is a duplicate confirmation in the buyer inbox',
    );
    assert.equal(presented[0], `${SENDER_PRIMARY}|order-confirmation-ord_identity_ambiguous-primary-v1`);
  });
});

test('a rejected sender is never rewritten automatically — the identity survives the failure', async () => {
  await localStore(async () => {
    const claimedRecord = await claimUnderSender('ord_identity_rejected', SENDER_PRIMARY, 'claim-reject');
    assert.equal(claimedRecord.confirmationEmailFrom, SENDER_PRIMARY);
    await releaseConfirmationEmailClaim('ord_identity_rejected', 'claim-reject', { now: () => NOW_MS });

    const failed = await withEnv(
      {
        HSB_EMAIL_FROM: SENDER_ROTATED,
        HSB_EMAIL_FROM_FALLBACK: SENDER_FALLBACK,
        EMAIL_FROM: undefined,
      },
      () => deliverOrderConfirmationEmail('ord_identity_rejected', {
        send: async () => { throw new Error('sender not on a verified domain'); },
        now: () => NOW_MS,
        errorLog: () => {},
      }),
    );
    assert.equal(failed.status, 'failed');

    const stored = await getOrderAuthoritative('ord_identity_rejected');
    assert.equal(stored?.confirmationEmailFrom, claimedRecord.confirmationEmailFrom);
    assert.equal(stored?.confirmationEmailIdempotencyKey, claimedRecord.confirmationEmailIdempotencyKey);
    assert.equal(stored?.emailResendClaimId ?? null, null, 'the claim is still released for the next attempt');
    assert.equal(stored?.confirmationEmailSentAt ?? null, null);
  });
});

test('the confirmation send makes exactly one provider attempt and never falls back to another sender', async () => {
  await localStore(async () => {
    const order = await claimUnderSender('ord_identity_onecall', SENDER_PRIMARY, 'claim-onecall');

    const transport = stubResendTransport([{
      status: 403,
      body: {
        statusCode: 403,
        name: 'validation_error',
        message: 'The herostorybooks.com domain is not verified.',
      },
    }]);
    try {
      await withEnv(
        {
          HSB_RESEND_API_KEY: 're_test_stub',
          RESEND_API_KEY: undefined,
          // A fallback IS configured and the primary IS rejected as unverified:
          // the other lifecycle emails would retry under it. This one must not.
          HSB_EMAIL_FROM: SENDER_ROTATED,
          HSB_EMAIL_FROM_FALLBACK: SENDER_FALLBACK,
          EMAIL_FROM: undefined,
        },
        () => assert.rejects(() => sendOrderConfirmationEmail(order)),
      );
    } finally {
      transport.restore();
    }

    assert.equal(transport.calls.length, 1, 'a sender fallback under a reused key is a permanent provider rejection');
    assert.equal(transport.calls[0]?.body.from, SENDER_PRIMARY, 'the persisted sender, not the configured one');
    assert.equal(transport.calls[0]?.idempotencyKey, order.confirmationEmailIdempotencyKey);
  });
});

test('the confirmation send presents the persisted identity verbatim on the accepted path', async () => {
  await localStore(async () => {
    const order = await claimUnderSender('ord_identity_accepted', SENDER_PRIMARY, 'claim-accepted');

    const transport = stubResendTransport([{ status: 200, body: { id: 'msg_provider_accepted' } }]);
    let result: Awaited<ReturnType<typeof sendOrderConfirmationEmail>>;
    try {
      result = await withEnv(
        {
          HSB_RESEND_API_KEY: 're_test_stub',
          RESEND_API_KEY: undefined,
          HSB_EMAIL_FROM: SENDER_ROTATED,
          HSB_EMAIL_FROM_FALLBACK: SENDER_FALLBACK,
          EMAIL_FROM: undefined,
        },
        () => sendOrderConfirmationEmail(order),
      );
    } finally {
      transport.restore();
    }

    assert.deepEqual(result, { skipped: false, id: 'msg_provider_accepted' });
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0]?.body.from, SENDER_PRIMARY);
    assert.equal(
      transport.calls[0]?.idempotencyKey,
      'order-confirmation-ord_identity_accepted-primary-v1',
      'the key travels with the sender that was frozen alongside it',
    );
  });
});

test('the confirmation send refuses to invent an identity for an unclaimed record', async () => {
  await localStore(async () => {
    const unclaimed = makePaidOrder('ord_identity_missing');
    const transport = stubResendTransport([{ status: 200, body: { id: 'must-not-send' } }]);
    try {
      await withEnv(
        {
          HSB_RESEND_API_KEY: 're_test_stub',
          RESEND_API_KEY: undefined,
          HSB_EMAIL_FROM: SENDER_PRIMARY,
          EMAIL_FROM: undefined,
        },
        () => assert.rejects(
          () => sendOrderConfirmationEmail(unclaimed),
          (error: Error) => {
            assert.equal(error.name, 'ConfirmationEmailIdentityError');
            return true;
          },
        ),
      );
    } finally {
      transport.restore();
    }
    assert.equal(transport.calls.length, 0, 'no identity means no provider call');
  });
});

test('a confirmation provider rejection never carries the recipient into its error', async () => {
  await localStore(async () => {
    const order = await claimUnderSender('ord_identity_pii', SENDER_PRIMARY, 'claim-pii');

    const transport = stubResendTransport([{
      status: 422,
      body: {
        statusCode: 422,
        name: 'validation_error',
        message: `Recipient ${BUYER_EMAIL} rejected while sending to ${CHILD_NAME}`,
      },
    }]);
    try {
      await withEnv(
        { HSB_RESEND_API_KEY: 're_test_stub', RESEND_API_KEY: undefined, EMAIL_FROM: undefined },
        () => assert.rejects(
          () => sendOrderConfirmationEmail(order),
          (error: Error) => {
            const haystack = renderLogArg(error);
            assert.doesNotMatch(haystack, /buyer@example\.com/);
            assert.doesNotMatch(haystack, new RegExp(CHILD_NAME));
            assert.doesNotMatch(haystack, /@/, 'no address of any kind may ride out on this path');
            assert.match(haystack, /422/, 'the bounded status code is still actionable');
            return true;
          },
        ),
      );
    } finally {
      transport.restore();
    }
  });
});

// ── Sweep behaviour ─────────────────────────────────────────────────────────

test('the sweep isolates per-order failures, bounds its work, and reports outcomes', async () => {
  const orders = [
    makePaidOrder('ord_a'),
    makePaidOrder('ord_b'),
    makePaidOrder('ord_c'),
    makePaidOrder('ord_confirmed', { confirmationEmailSentAt: '2026-09-21T10:00:00.000Z' }),
  ];
  const errors: string[] = [];
  const attempted: string[] = [];

  const deps: ConfirmationEmailSweepDeps = {
    listOrders: async () => orders,
    deliver: async (orderId) => {
      attempted.push(orderId);
      if (orderId === 'ord_b') throw new Error('boom');
      return { status: 'sent' };
    },
    now: () => NOW_MS,
    graceMs: 15 * 60 * 1000,
    claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
    activationPaidAtMs: ACTIVATION_MS,
    log: () => {},
    errorLog: (line) => errors.push(line),
    maxDeliveries: 2,
  };

  const result = await runConfirmationEmailSweep(deps);

  assert.equal(result.scanned, 4);
  assert.equal(result.eligible, 2, 'work is bounded per invocation');
  assert.deepEqual(attempted, ['ord_a', 'ord_b']);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.ok, false);
  assert.equal(errors.length, 1);
});

test('sweep logs and results carry opaque handles only — never customer PII', async () => {
  const lines: string[] = [];
  const result = await runConfirmationEmailSweep({
    listOrders: async () => [
      makePaidOrder('ord_pii'),
      makePaidOrder('ord_pii_fail'),
    ],
    deliver: async (orderId) => {
      if (orderId === 'ord_pii_fail') throw new Error(`send failed for ${BUYER_EMAIL}`);
      return { status: 'sent' };
    },
    now: () => NOW_MS,
    graceMs: 15 * 60 * 1000,
    claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
    activationPaidAtMs: ACTIVATION_MS,
    log: (line) => lines.push(line),
    errorLog: (line) => lines.push(line),
    maxDeliveries: 5,
  });

  const haystack = `${lines.join('\n')}\n${JSON.stringify(result)}`;
  assert.doesNotMatch(haystack, /buyer@example\.com/);
  assert.doesNotMatch(haystack, new RegExp(CHILD_NAME));
  assert.doesNotMatch(haystack, /@/, 'no email-shaped token may reach the log sink');
  assert.match(haystack, /ord_pii/);
});

// ── The scheduled entry point ───────────────────────────────────────────────

test('the sweep cron route fails closed when CRON_SECRET is unset', async () => {
  let calls = 0;
  __setConfirmationEmailSweepRouteDepsForTests({
    runSweep: async () => { calls += 1; throw new Error('must not run'); },
  });

  const response = await withEnv({ CRON_SECRET: undefined }, () => getConfirmationEmailSweepRoute(
    new Request('https://example.test/api/cron/confirmation-email-sweep'),
  ));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false });
  assert.equal(calls, 0);
});

test('the sweep cron route rejects a wrong bearer secret without running', async () => {
  let calls = 0;
  __setConfirmationEmailSweepRouteDepsForTests({
    runSweep: async () => { calls += 1; throw new Error('must not run'); },
  });

  const response = await withEnv({ CRON_SECRET: 'right-secret' }, () => getConfirmationEmailSweepRoute(
    new Request('https://example.test/api/cron/confirmation-email-sweep', {
      headers: { authorization: 'Bearer wrong-secret' },
    }),
  ));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false });
  assert.equal(calls, 0);
});

test('an authorized sweep invocation reports an opaque result', async () => {
  __setConfirmationEmailSweepRouteDepsForTests({
    runSweep: async () => ({
      ok: true, scanned: 3, eligible: 1, sent: 1, skipped: 0, blocked: 0, failed: 0,
    }),
  });

  const response = await withEnv({ CRON_SECRET: 'right-secret' }, () => getConfirmationEmailSweepRoute(
    new Request('https://example.test/api/cron/confirmation-email-sweep', {
      headers: { authorization: 'Bearer right-secret' },
    }),
  ));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, scanned: 3, eligible: 1, sent: 1, skipped: 0, blocked: 0, failed: 0,
  });
});

test('the confirmation sweep is actually scheduled and does not stack on the fulfillment tick', () => {
  const config = JSON.parse(
    readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
  ) as { crons?: Array<{ path?: string; schedule?: string }> };

  const entry = (config.crons ?? []).find(
    (cron) => cron.path === '/api/cron/confirmation-email-sweep',
  );
  assert.ok(entry, 'an unscheduled recovery sweep recovers nothing');

  const fields = (entry.schedule ?? '').trim().split(/\s+/);
  assert.equal(fields.length, 5, `expected a 5-field cron expression, got ${entry.schedule}`);
  for (const minute of (fields[0] ?? '').split(',')) {
    assert.match(minute, /^\d{1,2}$/, 'the minutes must be fixed values');
    assert.notEqual(Number(minute) % 10, 0, 'do not stack on a fulfillment-sweep tick');
  }
});
