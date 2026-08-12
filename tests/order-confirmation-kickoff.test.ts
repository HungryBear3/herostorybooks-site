import test from 'node:test';
import assert from 'node:assert/strict';

import {
  _resetConfirmationEmailInFlightForTest,
  scheduleOrderConfirmationEmail,
} from '../src/lib/order-confirmation-kickoff.ts';
import { createOrderRecord } from '../src/lib/orders.ts';

function makeOrder() {
  return {
    ...createOrderRecord(
      { childName: 'Luna', bookFormat: 'digital', email: 'buyer@example.com' },
      { id: 'ord_email_kickoff', now: '2026-07-31T12:00:00.000Z' },
    ),
    paymentStatus: 'paid' as const,
  };
}

test('joined deferred email failure is contained and a later delivery can retry', async () => {
  _resetConfirmationEmailInFlightForTest();
  const immediate: Array<() => void> = [];
  const after: Array<() => void | Promise<void>> = [];
  const errors: string[] = [];
  let rejectSend!: (error: Error) => void;
  let sends = 0;

  scheduleOrderConfirmationEmail(makeOrder(), {
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
  await new Promise((resolve) => setImmediate(resolve));
  const joined = Promise.resolve(after.shift()!());
  rejectSend(new Error('transient resend failure'));

  await assert.doesNotReject(joined);
  assert.equal(sends, 1);
  assert.ok(errors.some((line) => line.includes('failed for ord_email_kickoff')));

  const retry: Array<() => void> = [];
  scheduleOrderConfirmationEmail(makeOrder(), {
    send: async () => { sends += 1; return { skipped: false as const, id: 'email_1' }; },
    setImmediateImpl: (cb) => { retry.push(cb); return null; },
    afterImpl: null,
    log: () => {},
    errorLog: () => {},
  });
  retry.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 2);
});

test('duplicate schedulers join one successful send in-process', async () => {
  _resetConfirmationEmailInFlightForTest();
  const queue: Array<() => void> = [];
  let sends = 0;
  let resolveSend!: () => void;
  const send = async () => {
    sends += 1;
    await new Promise<void>((resolve) => { resolveSend = resolve; });
    return { skipped: false as const, id: 'email_1' };
  };

  for (let i = 0; i < 2; i += 1) {
    scheduleOrderConfirmationEmail(makeOrder(), {
      send,
      setImmediateImpl: (cb) => { queue.push(cb); return null; },
      afterImpl: null,
      log: () => {},
      errorLog: () => {},
    });
  }

  queue.shift()!();
  queue.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 1);
  resolveSend();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 1);
});

test('a skipped email send clears dedupe so a later webhook replay can recover', async () => {
  _resetConfirmationEmailInFlightForTest();
  const first: Array<() => void> = [];
  const retry: Array<() => void> = [];
  let sends = 0;

  scheduleOrderConfirmationEmail(makeOrder(), {
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
  await new Promise((resolve) => setImmediate(resolve));

  scheduleOrderConfirmationEmail(makeOrder(), {
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 2);
});

test('authoritative refunded state blocks a stale deferred confirmation email', async () => {
  _resetConfirmationEmailInFlightForTest();
  const queue: Array<() => void> = [];
  let sends = 0;
  const stale = makeOrder();
  scheduleOrderConfirmationEmail(stale, {
    getOrder: async () => ({ ...stale, paymentStatus: 'refunded', refundedAt: '2026-08-12T20:00:00.000Z' }),
    send: async () => { sends += 1; return { skipped: false as const, id: 'must-not-send' }; },
    setImmediateImpl: (cb) => { queue.push(cb); return null; },
    afterImpl: null,
    log: () => {},
    errorLog: () => {},
  });
  queue.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 0);
});
