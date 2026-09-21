import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _resetConfirmationEmailInFlightForTest,
  scheduleOrderConfirmationEmail,
} from '../src/lib/order-confirmation-kickoff.ts';
import {
  createOrderRecord,
  getOrderAuthoritative,
  persistOrder,
  type OrderRecord,
} from '../src/lib/orders.ts';

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

/** The deferred confirmation path claims, sends and records against the durable
 *  order record, so these tests run on a real (temporary) order store rather
 *  than a record that only exists in memory. */
function localStore<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-confirmation-kickoff-'));
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

/** The schedulers are fire-and-forget, so tests wait on observable state
 *  instead of guessing how many ticks the durable path needs. */
async function settle(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function seedPaidOrder(id: string, overrides: Partial<OrderRecord> = {}): Promise<OrderRecord> {
  const order = {
    ...createOrderRecord(
      { childName: 'Luna', bookFormat: 'digital', email: 'buyer@example.com' },
      { id, now: '2026-07-31T12:00:00.000Z' },
    ),
    paymentStatus: 'paid' as const,
    paidAt: '2026-07-31T12:05:00.000Z',
    stripeSessionId: `cs_test_${id}`,
    ...overrides,
  } as OrderRecord;
  await persistOrder(order);
  return order;
}

test('the scheduled path records a durable confirmation receipt and releases its claim', async () => {
  await localStore(async () => {
    _resetConfirmationEmailInFlightForTest();
    const queue: Array<() => void> = [];
    const order = await seedPaidOrder('ord_kickoff_receipt');

    scheduleOrderConfirmationEmail(order, {
      send: async () => ({ skipped: false as const, id: 'email_durable' }),
      setImmediateImpl: (cb) => { queue.push(cb); return null; },
      afterImpl: null,
      log: () => {},
      errorLog: () => {},
    });
    queue.shift()!();

    await settle(
      async () => Boolean((await getOrderAuthoritative(order.id))?.confirmationEmailSentAt),
      'the durable confirmation receipt',
    );
    const stored = await getOrderAuthoritative(order.id);
    assert.equal(stored?.emailResendClaimId ?? null, null);
    assert.equal(stored?.emailResendClaimKind ?? null, null);
  });
});

test('joined deferred email failure is contained and a later delivery can retry', async () => {
  await localStore(async () => {
    _resetConfirmationEmailInFlightForTest();
    const immediate: Array<() => void> = [];
    const after: Array<() => void | Promise<void>> = [];
    const errors: string[] = [];
    let rejectSend!: (error: Error) => void;
    let sends = 0;
    const order = await seedPaidOrder('ord_kickoff_failure');

    scheduleOrderConfirmationEmail(order, {
      send: async () => {
        sends += 1;
        return await new Promise<never>((_resolve, reject) => { rejectSend = reject; });
      },
      setImmediateImpl: (cb) => { immediate.push(cb); return null; },
      afterImpl: (cb) => { after.push(cb); },
      log: () => {},
      errorLog: (line) => { errors.push(line); },
    });

    immediate.shift()!();
    await settle(() => sends === 1, 'the first send attempt');
    const joined = Promise.resolve(after.shift()!());
    rejectSend(new Error('transient resend failure'));

    await assert.doesNotReject(joined);
    assert.equal(sends, 1);
    assert.ok(errors.some((line) => line.includes(`failed for ${order.id}`)));
    // A transient provider failure must not strand the order behind its claim.
    const stranded = await getOrderAuthoritative(order.id);
    assert.equal(stranded?.emailResendClaimId ?? null, null);
    assert.equal(stranded?.confirmationEmailSentAt ?? null, null);

    const retry: Array<() => void> = [];
    scheduleOrderConfirmationEmail(order, {
      send: async () => { sends += 1; return { skipped: false as const, id: 'email_1' }; },
      setImmediateImpl: (cb) => { retry.push(cb); return null; },
      afterImpl: null,
      log: () => {},
      errorLog: () => {},
    });
    retry.shift()!();
    await settle(
      async () => Boolean((await getOrderAuthoritative(order.id))?.confirmationEmailSentAt),
      'the retried confirmation receipt',
    );
    assert.equal(sends, 2);
  });
});

test('duplicate schedulers join one successful send in-process', async () => {
  await localStore(async () => {
    _resetConfirmationEmailInFlightForTest();
    const queue: Array<() => void> = [];
    let sends = 0;
    let resolveSend!: () => void;
    const send = async () => {
      sends += 1;
      await new Promise<void>((resolve) => { resolveSend = resolve; });
      return { skipped: false as const, id: 'email_1' };
    };
    const order = await seedPaidOrder('ord_kickoff_duplicate');

    for (let i = 0; i < 2; i += 1) {
      scheduleOrderConfirmationEmail(order, {
        send,
        setImmediateImpl: (cb) => { queue.push(cb); return null; },
        afterImpl: null,
        log: () => {},
        errorLog: () => {},
      });
    }

    queue.shift()!();
    queue.shift()!();
    await settle(() => sends === 1, 'the single in-process send');
    resolveSend();
    await settle(
      async () => Boolean((await getOrderAuthoritative(order.id))?.confirmationEmailSentAt),
      'the confirmation receipt',
    );
    assert.equal(sends, 1);
  });
});

test('a skipped email send clears dedupe so a later webhook replay can recover', async () => {
  await localStore(async () => {
    _resetConfirmationEmailInFlightForTest();
    const first: Array<() => void> = [];
    const retry: Array<() => void> = [];
    let sends = 0;
    const order = await seedPaidOrder('ord_kickoff_skipped');

    scheduleOrderConfirmationEmail(order, {
      send: async () => {
        sends += 1;
        return { skipped: true as const, reason: 'missing_resend_api_key' };
      },
      setImmediateImpl: (cb) => { first.push(cb); return null; },
      afterImpl: null,
      log: () => {},
      errorLog: () => {},
    });
    first.shift()!();
    await settle(() => sends === 1, 'the skipped send');
    await settle(
      async () => ((await getOrderAuthoritative(order.id))?.emailResendClaimId ?? null) === null,
      'the released claim',
    );
    assert.equal((await getOrderAuthoritative(order.id))?.confirmationEmailSentAt ?? null, null);

    scheduleOrderConfirmationEmail(order, {
      send: async () => {
        sends += 1;
        return { skipped: false as const, id: 'email_recovered' };
      },
      setImmediateImpl: (cb) => { retry.push(cb); return null; },
      afterImpl: null,
      log: () => {},
      errorLog: () => {},
    });
    retry.shift()!();
    await settle(
      async () => Boolean((await getOrderAuthoritative(order.id))?.confirmationEmailSentAt),
      'the recovered confirmation receipt',
    );
    assert.equal(sends, 2);
  });
});

test('authoritative refunded state blocks a stale deferred confirmation email', async () => {
  await localStore(async () => {
    _resetConfirmationEmailInFlightForTest();
    const queue: Array<() => void> = [];
    const errors: string[] = [];
    let sends = 0;
    const stale = await seedPaidOrder('ord_kickoff_refunded', {
      paymentStatus: 'refunded',
      refundedAt: '2026-08-12T20:00:00.000Z',
    });

    scheduleOrderConfirmationEmail(stale, {
      getOrder: async () => ({ ...stale, paymentStatus: 'refunded', refundedAt: '2026-08-12T20:00:00.000Z' }),
      send: async () => { sends += 1; return { skipped: false as const, id: 'must-not-send' }; },
      setImmediateImpl: (cb) => { queue.push(cb); return null; },
      afterImpl: null,
      log: () => {},
      errorLog: (line) => { errors.push(line); },
    });
    queue.shift()!();

    await settle(() => errors.some((line) => line.includes(`failed for ${stale.id}`)), 'the blocked attempt');
    assert.equal(sends, 0);
    const stored = await getOrderAuthoritative(stale.id);
    assert.equal(stored?.confirmationEmailSentAt ?? null, null);
    assert.equal(stored?.emailResendClaimId ?? null, null);
  });
});

test('the webhook kickoff and the recovery sweep share one durable claim implementation', () => {
  // Two independent claim implementations would be two ways to accept the same
  // email. The durable behaviour itself is covered by
  // tests/confirmation-email-recovery.test.ts; this pins the single seam.
  const source = readFileSync(new URL('../src/lib/order-confirmation-kickoff.ts', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/confirmation-email-delivery\.ts'/);
  assert.match(source, /deliverOrderConfirmationEmail\(/);
  assert.doesNotMatch(source, /withOrderTransaction/, 'the kickoff must not hand-roll a second claim');
});
