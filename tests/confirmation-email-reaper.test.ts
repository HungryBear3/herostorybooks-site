/*
 * L-4 A3-6 — the dispatch-lease reaper (plan §3, addendum R-2/R-3).
 *
 * A record that recorded dispatch intent and whose lease has elapsed becomes a
 * `deadline_exceeded` hold (T9) in one guarded compare-and-swap. The reaper is a
 * separate enumeration pass: it never consults the sweep's eligibility filter,
 * never reaches a provider or the envelope store, never releases the claim and
 * never hands a record back to the send path.
 *
 * Seams, all synthetic:
 *   - `casOrderIo`  the raw NBT pair over an in-memory, versioned map; a hook
 *                   may land a competing write between a read and its commit;
 *   - `storeSpy`    put/get/del that count and throw;
 *   - `fetch`       counts and throws (the transport spy: any provider call
 *                   from this process goes through it).
 * No network, no Resend key, no real store, no order action.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONFIRMATION_EMAIL_REAPER_MAX_PER_RUN,
  CONFIRMATION_EMAIL_REAPER_SKEW_MS,
  decideConfirmationEmailReap,
  runConfirmationEmailReaper,
  type ConfirmationEmailReaperDeps,
} from '../src/lib/confirmation-email-reconciliation.ts';
import {
  evaluateConfirmationEmailSweepEligibility,
  runConfirmationEmailSweep,
  type ConfirmationEmailSweepDeps,
} from '../src/lib/confirmation-email-sweep.ts';
import { CONFIRMATION_EMAIL_CLAIM_STALE_MS, evaluateConfirmationEmailClaimability } from '../src/lib/confirmation-email-delivery.ts';
import { CONFIRMATION_DISPATCH_DEADLINE_MS } from '../src/lib/confirmation-email-dispatch.ts';
import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepo = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ── File-start backstops ───────────────────────────────────────────────────

assert.equal(process.env.HSB_RESEND_API_KEY || undefined, undefined, 'no usable Resend key may be present');
assert.equal(process.env.RESEND_API_KEY || undefined, undefined, 'no usable Resend key may be present');
assert.equal(process.env.HSB_CONFIRMATION_ENVELOPE_WRITER, undefined, 'no ambient writer flag');

let FETCH_CALLS = 0;
const ORIGINAL_FETCH = globalThis.fetch;
globalThis.fetch = (async () => {
  FETCH_CALLS += 1;
  throw new Error('fetch is forbidden in the reaper suite');
}) as typeof fetch;

// ── Fixtures ────────────────────────────────────────────────────────────────

const idOf = (suffix: string) => ['ord', `${'0'.repeat(16 - suffix.length)}${suffix}`].join('_');

const INTENT_AT = '2026-10-15T13:00:00.000Z';
const INTENT_MS = Date.parse(INTENT_AT);
const DEADLINE_MS = INTENT_MS + CONFIRMATION_DISPATCH_DEADLINE_MS;
const DEADLINE_AT = new Date(DEADLINE_MS).toISOString();
const ATTEMPT_ID = 'attempt-a36-1';
const CLAIM_ID = 'claim-a36-1';
const EPOCH = '2026-09-22T00:00:00.000Z';
const TOKEN = 'vercel_blob_rw_SYNTHETICenvStore01_SYNTHETICsecret000001';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Flat namespace, no Vercel, no ambient flag: the writer gate agrees. */
const isolated = <T>(fn: () => Promise<T> | T) => withEnv({
  HSB_BLOB_NAMESPACE: undefined, VERCEL: undefined, VERCEL_ENV: undefined,
  HSB_CONFIRMATION_ENVELOPE_WRITER: undefined, BLOB_READ_WRITE_TOKEN: undefined,
}, fn);

function writerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HSB_CONFIRMATION_ENVELOPE_WRITER: 'true',
    HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: EPOCH,
    HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN: TOKEN,
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

function refOf(id: string) {
  return {
    envelopeVersion: 1,
    orderId: id,
    templateVersion: 'confirmation-v1',
    createdAt: '2026-10-15T12:30:00.000Z',
    canonicalDigest: 'a'.repeat(64),
    canonicalBytes: 1024,
    accountLabel: 'hsb-test-account',
    storageKind: 'private_blob',
    objectPath: `confirmation-envelopes/${id}/v1.json`,
    purgedAt: null,
  };
}

function intentOrder(id: string, overrides: Record<string, unknown> = {}): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Luna', bookFormat: 'digital', email: 'buyer@example.invalid' },
      { id, now: '2026-10-15T11:00:00.000Z' },
    ),
    paymentStatus: 'paid' as const,
    paidAt: '2026-10-15T12:00:00.000Z',
    stripeSessionId: `cs_test_${id}`,
    updatedAt: INTENT_AT,
    confirmationEmailState: 'DISPATCH_INTENT_RECORDED',
    confirmationEmailHoldReason: null,
    confirmationEmailEnvelopeRef: refOf(id),
    confirmationEmailFrom: 'HSB <no-reply@example.invalid>',
    confirmationEmailIdempotencyKey: `order-confirmation/${id}`,
    confirmationEmailAttemptId: ATTEMPT_ID,
    confirmationEmailFirstDispatchIntentAt: INTENT_AT,
    confirmationEmailDispatchDeadlineAt: DEADLINE_AT,
    confirmationEmailAttempts: [],
    emailResendClaimId: CLAIM_ID,
    emailResendClaimKind: 'order_confirmation',
    emailResendClaimArtifact: `cs_test_${id}`,
    emailResendClaimAt: INTENT_AT,
    ...overrides,
  } as OrderRecord;
}

// ── Seams ───────────────────────────────────────────────────────────────────

class OrderVersionConflictError extends Error {
  constructor() {
    super('synthetic version conflict');
    this.name = 'OrderVersionConflictError';
  }
}

type CommitHook = (orderId: string, attempt: number) => Promise<void> | void;

/**
 * The raw NBT pair over a versioned in-memory map. `transact` re-reads on a
 * version conflict, exactly as the real NBT does, and reports NBT-shaped
 * provenance from the paths it used.
 */
function casOrderIo(seed: OrderRecord[], hook?: CommitHook) {
  const cells = new Map<string, { body: string; v: number }>();
  for (const order of seed) cells.set(order.id, { body: JSON.stringify(order), v: 1 });
  const counts = { read: 0, transact: 0, commits: 0 };
  const recordPath = (orderId: string) => `orders/${orderId}.json`;
  const provenance = (orderId: string, outcome: string, reads: number, commits: number) => ({
    namespace: '',
    recordPath: recordPath(orderId),
    readPaths: Array.from({ length: reads }, () => recordPath(orderId)),
    commitPaths: Array.from({ length: commits }, () => recordPath(orderId)),
    attempts: reads,
    outcome,
  });
  const read = async (_binding: unknown, orderId: string) => {
    counts.read += 1;
    const cell = cells.get(orderId);
    return cell === undefined
      ? { found: null, provenance: provenance(orderId, 'not_found', 1, 0) }
      : { found: { order: JSON.parse(cell.body) as OrderRecord, version: `v${cell.v}` }, provenance: provenance(orderId, 'read', 1, 0) };
  };
  const transact = async (
    _binding: unknown,
    orderId: string,
    mutate: (order: OrderRecord) => unknown,
    opts: { notFound: () => unknown; beforeCommit?: () => boolean; maxAttempts?: number },
  ) => {
    counts.transact += 1;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const cell = cells.get(orderId);
      if (cell === undefined) return { status: 'not_found', result: opts.notFound(), provenance: provenance(orderId, 'not_found', attempt, 0) };
      const seen = cell.v;
      const outcome = await mutate(JSON.parse(cell.body) as OrderRecord) as { abort?: unknown; commit?: OrderRecord; result?: unknown };
      if ('abort' in outcome) return { status: 'aborted', result: outcome.abort, provenance: provenance(orderId, 'aborted', attempt, 0) };
      await hook?.(orderId, attempt);
      if (opts.beforeCommit && opts.beforeCommit() !== true) {
        return { status: 'commit_refused', provenance: provenance(orderId, 'commit_refused', attempt, 0) };
      }
      if (cells.get(orderId)!.v !== seen) continue;
      cells.set(orderId, { body: JSON.stringify(outcome.commit), v: seen + 1 });
      counts.commits += 1;
      return { status: 'committed', result: outcome.result, provenance: provenance(orderId, 'committed', attempt, 1) };
    }
    throw new OrderVersionConflictError();
  };
  return {
    io: { read, transact },
    counts,
    bodyOf: (orderId: string) => cells.get(orderId)?.body,
    recordOf: (orderId: string) => JSON.parse(cells.get(orderId)!.body) as OrderRecord,
    /** A competing writer: lands immediately and bumps the version. */
    poke: (orderId: string, change: (order: OrderRecord) => OrderRecord) => {
      const cell = cells.get(orderId)!;
      cells.set(orderId, { body: JSON.stringify(change(JSON.parse(cell.body) as OrderRecord)), v: cell.v + 1 });
    },
  };
}

function storeSpy() {
  let calls = 0;
  const touch = async (): Promise<never> => {
    calls += 1;
    throw new Error('the envelope store was touched');
  };
  return { io: { put: touch, get: touch, del: touch }, calls: () => calls };
}

function reaperDeps(
  io: ReturnType<typeof casOrderIo>,
  nowMs: number,
  extra: Partial<ConfirmationEmailReaperDeps> & { storeIo?: unknown; env?: NodeJS.ProcessEnv } = {},
) {
  const logs: string[] = [];
  const errors: string[] = [];
  const { storeIo, env, ...rest } = extra;
  const deps: ConfirmationEmailReaperDeps = {
    nowMs,
    log: (line) => { logs.push(line); },
    errorLog: (line) => { errors.push(line); },
    writer: {
      env: env ?? writerEnv(),
      orderIo: io.io as never,
      ...(storeIo ? { storeIo: storeIo as never } : {}),
    },
    ...rest,
  };
  return { deps, logs, errors };
}

const auditOf = (order: OrderRecord) => order.auditEvents ?? [];

// ── Elapsed / unexpired / boundary ─────────────────────────────────────────

test('RP-1: an expired lease becomes a deadline hold; claim, attempt id and deadline stay; nothing is sent', async () => {
  await isolated(async () => {
    for (const gate of ['disarmed', 'armed'] as const) {
      const id = idOf(gate === 'armed' ? 'a1' : 'a0');
      const io = casOrderIo([intentOrder(id)]);
      const store = storeSpy();
      const fetchBefore = FETCH_CALLS;
      const { deps, logs, errors } = reaperDeps(io, DEADLINE_MS + 1, gate === 'armed' ? { storeIo: store.io } : {});
      const result = await runConfirmationEmailReaper([intentOrder(id)], deps);
      assert.deepEqual(result, { candidates: 1, reaped: 1, moved: 0, deferred: 0, unbound: 0 }, gate);

      const after = io.recordOf(id);
      assert.equal(after.confirmationEmailState, 'RECONCILIATION_REQUIRED');
      assert.equal(after.confirmationEmailHoldReason, 'deadline_exceeded');
      assert.equal(after.emailResendClaimId, CLAIM_ID, 'T9 keeps the claim');
      assert.equal(after.emailResendClaimKind, 'order_confirmation');
      assert.equal(after.emailResendClaimAt, INTENT_AT);
      assert.equal(after.confirmationEmailAttemptId, ATTEMPT_ID);
      assert.equal(after.confirmationEmailDispatchDeadlineAt, DEADLINE_AT);
      assert.equal(after.confirmationEmailFirstDispatchIntentAt, INTENT_AT);
      assert.equal(after.confirmationEmailSentAt ?? null, null, 'no receipt');
      assert.equal(after.confirmationEmailProviderMessageId ?? null, null, 'no receipt');
      assert.deepEqual(after.confirmationEmailAttempts, [
        { attemptId: ATTEMPT_ID, claimId: CLAIM_ID, intentAt: INTENT_AT, outcome: 'ambiguous' },
      ]);
      assert.deepEqual(auditOf(after), [{
        at: new Date(DEADLINE_MS + 1).toISOString(),
        type: 'confirmation_held',
        reason: 'deadline_exceeded',
        meta: { basis: 'deadline', toState: 'RECONCILIATION_REQUIRED', attemptCount: 1 },
      }]);
      assert.equal(after.updatedAt, new Date(DEADLINE_MS + 1).toISOString());

      // Held, so every send path refuses it.
      assert.equal(
        evaluateConfirmationEmailClaimability(after, { nowMs: DEADLINE_MS + 1, claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS }) !== null,
        true,
      );
      assert.equal(FETCH_CALLS, fetchBefore, 'the transport spy is untouched');
      assert.equal(store.calls(), 0, 'the envelope store is untouched');
      assert.deepEqual(logs, [`[confirmation-email-reaper] reaped orderId=${id} basis=deadline`]);
      assert.deepEqual(errors, []);
    }
  });
});

test('RP-2: an unexpired lease is untouched — no transaction at all', async () => {
  await isolated(async () => {
    const id = idOf('a2');
    const io = casOrderIo([intentOrder(id)]);
    const before = io.bodyOf(id);
    const { deps, logs, errors } = reaperDeps(io, DEADLINE_MS - 1);
    const result = await runConfirmationEmailReaper([intentOrder(id)], deps);
    assert.deepEqual(result, { candidates: 0, reaped: 0, moved: 0, deferred: 0, unbound: 0 });
    assert.equal(io.bodyOf(id), before);
    assert.equal(io.counts.transact, 0);
    assert.deepEqual([logs, errors], [[], []]);
  });
});

test('RP-3: the equality boundary reaps (deadline <= now)', async () => {
  await isolated(async () => {
    const id = idOf('a3');
    const io = casOrderIo([intentOrder(id)]);
    const { deps } = reaperDeps(io, DEADLINE_MS);
    const result = await runConfirmationEmailReaper([intentOrder(id)], deps);
    assert.equal(result.reaped, 1);
    assert.equal(io.recordOf(id).confirmationEmailState, 'RECONCILIATION_REQUIRED');
    // And the pure decision agrees at the boundary and one millisecond before.
    const observed = { attemptId: ATTEMPT_ID, deadline: DEADLINE_AT };
    assert.ok('commit' in decideConfirmationEmailReap(intentOrder(id), observed, DEADLINE_MS));
    assert.deepEqual(decideConfirmationEmailReap(intentOrder(id), observed, DEADLINE_MS - 1), { abort: { status: 'not_due' } });
  });
});

// ── R1: a separate pass ────────────────────────────────────────────────────

test('RP-4 (R1): a dispatch-intent record is invisible to the sweep filter and visible to the reaper', async () => {
  await isolated(async () => {
    const id = idOf('a4');
    const order = intentOrder(id);
    for (const admit of [undefined, true]) {
      const verdict = evaluateConfirmationEmailSweepEligibility(order, {
        nowMs: DEADLINE_MS + 60 * 60_000,
        graceMs: 0,
        claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
        activationPaidAtMs: 0,
        admitAwaitingFrozenDispatch: admit,
      });
      assert.equal(verdict.eligible, false, `admit=${String(admit)}`);
    }

    const io = casOrderIo([order]);
    const delivered: string[] = [];
    const { deps } = reaperDeps(io, DEADLINE_MS + 1);
    const result = await runConfirmationEmailSweep({
      listOrders: async () => [order],
      deliver: async (orderId) => { delivered.push(orderId); return { status: 'sent' }; },
      now: () => DEADLINE_MS + 1,
      graceMs: 0,
      claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
      activationPaidAtMs: 0,
      log: () => {},
      errorLog: () => {},
      reap: (orders, nowMs) => runConfirmationEmailReaper(orders, { ...deps, nowMs }),
    });
    assert.deepEqual(delivered, [], 'the delivery loop never sees it');
    assert.equal(result.reaped, 1, 'the reaper pass does');
    assert.equal(io.recordOf(id).confirmationEmailState, 'RECONCILIATION_REQUIRED');
  });
});

// ── Fallbacks (R-2: every hold is deadline_exceeded, basis in the audit) ───

function basisOf(order: OrderRecord): unknown {
  const events = auditOf(order);
  return events[events.length - 1]?.meta?.basis;
}

test('RP-5: no usable deadline falls back to the claim instant, then the first intent, then holds as unusable', async () => {
  await isolated(async () => {
    const OLD = '2026-10-15T12:00:00.000Z';
    const cases: Array<{ label: string; overrides: Record<string, unknown>; nowMs: number; basis: string | null }> = [
      { label: 'claim_at due', overrides: { confirmationEmailDispatchDeadlineAt: null }, nowMs: INTENT_MS + CONFIRMATION_DISPATCH_DEADLINE_MS, basis: 'claim_at' },
      { label: 'claim_at not yet due', overrides: { confirmationEmailDispatchDeadlineAt: null }, nowMs: INTENT_MS + CONFIRMATION_DISPATCH_DEADLINE_MS - 1, basis: null },
      { label: 'claim of another kind is not a lease', overrides: { confirmationEmailDispatchDeadlineAt: null, emailResendClaimKind: 'shipped', confirmationEmailFirstDispatchIntentAt: OLD }, nowMs: INTENT_MS, basis: 'first_intent' },
      { label: 'first_intent due', overrides: { confirmationEmailDispatchDeadlineAt: 'garbage', emailResendClaimAt: null, confirmationEmailFirstDispatchIntentAt: OLD }, nowMs: INTENT_MS, basis: 'first_intent' },
      { label: 'first_intent not yet due', overrides: { confirmationEmailDispatchDeadlineAt: undefined, emailResendClaimAt: 'garbage' }, nowMs: INTENT_MS + 1, basis: null },
      { label: 'nothing usable', overrides: { confirmationEmailDispatchDeadlineAt: null, emailResendClaimAt: null, confirmationEmailFirstDispatchIntentAt: '' }, nowMs: INTENT_MS, basis: 'unusable' },
      { label: 'nothing present at all', overrides: { confirmationEmailDispatchDeadlineAt: undefined, emailResendClaimAt: undefined, emailResendClaimId: undefined, emailResendClaimKind: undefined, confirmationEmailFirstDispatchIntentAt: undefined }, nowMs: INTENT_MS, basis: 'unusable' },
    ];
    for (const [index, c] of cases.entries()) {
      const id = idOf(`b${index}`);
      const order = intentOrder(id, c.overrides);
      const io = casOrderIo([order]);
      const before = io.bodyOf(id);
      const { deps } = reaperDeps(io, c.nowMs);
      const result = await runConfirmationEmailReaper([order], deps);
      if (c.basis === null) {
        assert.equal(result.reaped, 0, c.label);
        assert.equal(io.bodyOf(id), before, c.label);
        continue;
      }
      assert.equal(result.reaped, 1, c.label);
      const after = io.recordOf(id);
      assert.equal(after.confirmationEmailState, 'RECONCILIATION_REQUIRED', c.label);
      assert.equal(after.confirmationEmailHoldReason, 'deadline_exceeded', `${c.label}: R-2, never ambiguous_dispatch`);
      assert.equal(basisOf(after), c.basis, c.label);
    }
  });
});

test('RP-5b: non-scalar lease identity survives the JSON-backed CAS and is durably held as unusable', async () => {
  await isolated(async () => {
    const cases: Array<{ label: string; overrides: Record<string, unknown> }> = [
      {
        label: 'object deadline',
        overrides: {
          confirmationEmailDispatchDeadlineAt: { malformed: true },
          emailResendClaimAt: null,
          confirmationEmailFirstDispatchIntentAt: null,
        },
      },
      {
        label: 'array attempt id',
        overrides: {
          confirmationEmailAttemptId: ['malformed'],
          confirmationEmailDispatchDeadlineAt: null,
          emailResendClaimAt: null,
          confirmationEmailFirstDispatchIntentAt: null,
        },
      },
    ];
    for (const [index, c] of cases.entries()) {
      const id = idOf(`ba${index}`);
      const listed = intentOrder(id, c.overrides);
      const io = casOrderIo([listed]);
      const { deps } = reaperDeps(io, INTENT_MS);
      const result = await runConfirmationEmailReaper([listed], deps);
      assert.deepEqual(
        result,
        { candidates: 1, reaped: 1, moved: 0, deferred: 0, unbound: 0 },
        c.label,
      );
      const after = io.recordOf(id);
      assert.equal(after.confirmationEmailState, 'RECONCILIATION_REQUIRED', c.label);
      assert.equal(after.confirmationEmailHoldReason, 'deadline_exceeded', c.label);
      assert.equal(basisOf(after), 'unusable', c.label);
      assert.equal(after.emailResendClaimId, CLAIM_ID, `${c.label}: T9 keeps the claim`);
    }
  });
});

test('RP-6: a zone-less, impossible or far-future deadline is not canonical and falls back (TZ-independent)', async () => {
  await isolated(async () => {
    // Each of these parses under a lenient `Date.parse`; none round-trips.
    const bad = [
      '2026-10-15T13:01:30',          // zone-less: host-zone dependent
      '2026-10-15T13:01:30.000',      // zone-less, with millis
      '2026-09-31T13:01:30.000Z',     // impossible calendar date
      '2026-10-15T13:01:30Z',         // not the toISOString form
      '2099-01-01T00:00:00.000Z',     // canonical but implausibly far in the future
    ];
    for (const [index, deadline] of bad.entries()) {
      const id = idOf(`c${index}`);
      // The claim instant is old enough to be due; a lenient reading of the
      // deadline would instead decide on `deadline` (or wait until 2099).
      const order = intentOrder(id, { confirmationEmailDispatchDeadlineAt: deadline });
      const io = casOrderIo([order]);
      const { deps } = reaperDeps(io, INTENT_MS + CONFIRMATION_DISPATCH_DEADLINE_MS);
      const result = await runConfirmationEmailReaper([order], deps);
      assert.equal(result.reaped, 1, deadline);
      assert.equal(basisOf(io.recordOf(id)), 'claim_at', deadline);
    }
    // With no fallback at all, the far-future deadline is held as unusable,
    // never left unreachable until 2099.
    const id = idOf('c9');
    const order = intentOrder(id, {
      confirmationEmailDispatchDeadlineAt: '2099-01-01T00:00:00.000Z', emailResendClaimAt: null, confirmationEmailFirstDispatchIntentAt: null,
    });
    const io = casOrderIo([order]);
    const { deps } = reaperDeps(io, INTENT_MS);
    assert.equal((await runConfirmationEmailReaper([order], deps)).reaped, 1);
    assert.equal(basisOf(io.recordOf(id)), 'unusable');
  });
});

test('RP-6b: a deadline within the plausibility window is honoured; the skew constant is the documented minute', () => {
  assert.equal(CONFIRMATION_EMAIL_REAPER_SKEW_MS, 60_000);
  assert.equal(CONFIRMATION_EMAIL_REAPER_MAX_PER_RUN, 10);
  const nowMs = INTENT_MS;
  const limit = new Date(nowMs + CONFIRMATION_DISPATCH_DEADLINE_MS + CONFIRMATION_EMAIL_REAPER_SKEW_MS).toISOString();
  const beyond = new Date(nowMs + CONFIRMATION_DISPATCH_DEADLINE_MS + CONFIRMATION_EMAIL_REAPER_SKEW_MS + 1).toISOString();
  const noFallback = { emailResendClaimAt: null, confirmationEmailFirstDispatchIntentAt: null };
  // At the limit: a usable, not-yet-due deadline.
  const atLimit = intentOrder(idOf('c7'), { ...noFallback, confirmationEmailDispatchDeadlineAt: limit });
  assert.deepEqual(decideConfirmationEmailReap(atLimit, { attemptId: ATTEMPT_ID, deadline: limit }, nowMs), { abort: { status: 'not_due' } });
  // One millisecond further: implausible, so unusable, so held now.
  const past = intentOrder(idOf('c8'), { ...noFallback, confirmationEmailDispatchDeadlineAt: beyond });
  assert.ok('commit' in decideConfirmationEmailReap(past, { attemptId: ATTEMPT_ID, deadline: beyond }, nowMs));
});

// ── Stale owner and CAS loss ───────────────────────────────────────────────

test('RP-7: a different attempt id or deadline in the latest record aborts with no write', async () => {
  await isolated(async () => {
    const observed = { attemptId: ATTEMPT_ID, deadline: DEADLINE_AT };
    const nowMs = DEADLINE_MS + 1;
    const id = idOf('d1');
    for (const latest of [
      intentOrder(id, { confirmationEmailAttemptId: 'attempt-a36-2' }),
      intentOrder(id, { confirmationEmailAttemptId: null }),
      intentOrder(id, { confirmationEmailDispatchDeadlineAt: new Date(DEADLINE_MS - 1).toISOString() }),
      intentOrder(id, { confirmationEmailState: 'ACCEPTED' }),
      intentOrder(id, { confirmationEmailState: 'RECONCILIATION_REQUIRED', confirmationEmailHoldReason: 'deadline_exceeded' }),
    ]) {
      assert.deepEqual(decideConfirmationEmailReap(latest, observed, nowMs), { abort: { status: 'moved' } });
    }

    // Through the runner: a new attempt lands between the listing and the CAS.
    const listed = intentOrder(id);
    const io = casOrderIo([listed]);
    io.poke(id, (order) => ({ ...order, confirmationEmailAttemptId: 'attempt-a36-2' }));
    const before = io.bodyOf(id);
    const { deps } = reaperDeps(io, nowMs);
    const result = await runConfirmationEmailReaper([listed], deps);
    assert.deepEqual(result, { candidates: 1, reaped: 0, moved: 1, deferred: 0, unbound: 0 });
    assert.equal(io.bodyOf(id), before);
  });
});

test('RP-8: a worker receipt that lands first makes the reaper abort (CAS loss)', async () => {
  await isolated(async () => {
    const id = idOf('d2');
    const listed = intentOrder(id);
    let landed = false;
    const io = casOrderIo([listed], (orderId, attempt) => {
      if (attempt !== 1 || landed) return;
      landed = true;
      io.poke(orderId, (order) => ({
        ...order,
        confirmationEmailState: 'ACCEPTED',
        confirmationEmailSentAt: new Date(DEADLINE_MS).toISOString(),
        confirmationEmailAcceptedAt: new Date(DEADLINE_MS).toISOString(),
        confirmationEmailProviderMessageId: 'msg-worker-1',
        emailResendClaimId: null,
        emailResendClaimKind: null,
        emailResendClaimArtifact: null,
        emailResendClaimAt: null,
      }));
    });
    const { deps } = reaperDeps(io, DEADLINE_MS + 1);
    const result = await runConfirmationEmailReaper([listed], deps);
    assert.ok(landed);
    assert.deepEqual(result, { candidates: 1, reaped: 0, moved: 1, deferred: 0, unbound: 0 });
    const after = io.recordOf(id);
    assert.equal(after.confirmationEmailState, 'ACCEPTED', 'the receipt wins');
    assert.equal(after.confirmationEmailHoldReason ?? null, null);
    assert.deepEqual(auditOf(after), []);
  });
});

// ── Gate and budget ────────────────────────────────────────────────────────

test('RP-9: a writer gate that is off or refused writes nothing and reads nothing', async () => {
  await isolated(async () => {
    const id = idOf('e1');
    const order = intentOrder(id);
    for (const [label, env, ambient] of [
      ['off (flag unset)', { HSB_CONFIRMATION_ENVELOPE_WRITER: undefined } as unknown as NodeJS.ProcessEnv, undefined],
      ['off (flag not exactly true)', writerEnv({ HSB_CONFIRMATION_ENVELOPE_WRITER: 'TRUE' }), undefined],
      ['refused (namespace disagreement)', writerEnv({ HSB_BLOB_NAMESPACE: 'ns-a' }), 'ns-z'],
    ] as const) {
      await withEnv({ HSB_BLOB_NAMESPACE: ambient }, async () => {
        const io = casOrderIo([order]);
        const before = io.bodyOf(id);
        const { deps, errors } = reaperDeps(io, DEADLINE_MS + 1, { env });
        const result = await runConfirmationEmailReaper([order], deps);
        assert.deepEqual(result, { candidates: 1, reaped: 0, moved: 0, deferred: 0, unbound: 1 }, label);
        assert.equal(io.bodyOf(id), before, label);
        assert.deepEqual(io.counts, { read: 0, transact: 0, commits: 0 }, label);
        assert.equal(errors.length, 1, label);
        assert.match(errors[0], /^\[confirmation-email-reaper\] unbound gate=(off|refused) candidates=1$/, label);
      });
    }
  });
});

test('RP-9b: with no candidate the reaper resolves no gate and logs nothing', async () => {
  await isolated(async () => {
    const io = casOrderIo([]);
    const { deps, logs, errors } = reaperDeps(io, DEADLINE_MS + 1, { env: { HSB_CONFIRMATION_ENVELOPE_WRITER: 'nope' } as never });
    const unrelated = intentOrder(idOf('e2'), { confirmationEmailState: 'SNAPSHOTTED' });
    assert.deepEqual(await runConfirmationEmailReaper([unrelated], deps), { candidates: 0, reaped: 0, moved: 0, deferred: 0, unbound: 0 });
    assert.deepEqual([logs, errors], [[], []]);
  });
});

test('RP-10: the reaper budget is enforced, separately from the delivery budget', async () => {
  await isolated(async () => {
    const orders = Array.from({ length: 12 }, (_, index) => intentOrder(idOf(`f${index.toString(16)}`)));
    const io = casOrderIo(orders);
    const { deps } = reaperDeps(io, DEADLINE_MS + 1);
    const result = await runConfirmationEmailReaper(orders, deps);
    assert.equal(result.reaped, CONFIRMATION_EMAIL_REAPER_MAX_PER_RUN);
    assert.equal(result.candidates, 12);
    const held = orders.filter((order) => io.recordOf(order.id).confirmationEmailState === 'RECONCILIATION_REQUIRED');
    assert.equal(held.length, 10);

    const io2 = casOrderIo(orders);
    const { deps: deps2 } = reaperDeps(io2, DEADLINE_MS + 1, { maxPerRun: 3 });
    assert.equal((await runConfirmationEmailReaper(orders, deps2)).reaped, 3);
  });
});

test('RP-11: a namespace fault or CAS exhaustion is a deferral, never a throw and never a write', async () => {
  await isolated(async () => {
    const id = idOf('e3');
    const order = intentOrder(id);
    // Exhaustion: every commit loses.
    const io = casOrderIo([order], (orderId) => { io.poke(orderId, (o) => ({ ...o, updatedAt: new Date().toISOString() })); });
    const { deps, errors } = reaperDeps(io, DEADLINE_MS + 1);
    const result = await runConfirmationEmailReaper([order], deps);
    assert.deepEqual(result, { candidates: 1, reaped: 0, moved: 0, deferred: 1, unbound: 0 });
    assert.equal(io.recordOf(id).confirmationEmailState, 'DISPATCH_INTENT_RECORDED');
    assert.deepEqual(errors, [`[confirmation-email-reaper] deferred orderId=${id} reason=cas_exhausted`]);

    // Drift: the ambient namespace moves before the commit.
    const io2 = casOrderIo([order], () => { process.env.HSB_BLOB_NAMESPACE = 'ns-drifted'; });
    const { deps: deps2, errors: errors2 } = reaperDeps(io2, DEADLINE_MS + 1);
    try {
      const drifted = await runConfirmationEmailReaper([order], deps2);
      assert.deepEqual(drifted, { candidates: 1, reaped: 0, moved: 0, deferred: 1, unbound: 0 });
    } finally {
      delete process.env.HSB_BLOB_NAMESPACE;
    }
    assert.equal(io2.recordOf(id).confirmationEmailState, 'DISPATCH_INTENT_RECORDED');
    assert.deepEqual(errors2, [`[confirmation-email-reaper] deferred orderId=${id} reason=namespace_drift`]);
  });
});

// ── The sweep result (R-3: optional counters) ──────────────────────────────

function sweepDeps(orders: OrderRecord[], extra: Partial<ConfirmationEmailSweepDeps> = {}): ConfirmationEmailSweepDeps {
  return {
    listOrders: async () => orders,
    deliver: async () => ({ status: 'sent' }),
    now: () => DEADLINE_MS + 1,
    graceMs: 0,
    claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
    activationPaidAtMs: 0,
    log: () => {},
    errorLog: () => {},
    ...extra,
  };
}

test('RP-12 (R-3): without a reaper the sweep result keeps its exact prior shape', async () => {
  const result = await runConfirmationEmailSweep(sweepDeps([]));
  assert.deepEqual(result, { ok: true, scanned: 0, eligible: 0, sent: 0, skipped: 0, blocked: 0, failed: 0, snapshotted: 0, held: 0, deferred: 0 });
});

test('RP-13 (R-3): with a reaper the counters appear, reapDeferred fails the run, and the reaper runs first', async () => {
  const order = intentOrder(idOf('g1'));
  const sequence: string[] = [];
  const ok = await runConfirmationEmailSweep(sweepDeps([order], {
    reap: async (orders, nowMs) => {
      sequence.push(`reap:${orders.length}:${nowMs}`);
      return { candidates: 1, reaped: 1, moved: 0, deferred: 0, unbound: 0 };
    },
    deliver: async (orderId) => { sequence.push(`deliver:${orderId}`); return { status: 'sent' }; },
  }));
  assert.deepEqual(ok, {
    ok: true, scanned: 1, eligible: 0, sent: 0, skipped: 0, blocked: 0, failed: 0, snapshotted: 0, held: 0, deferred: 0,
    reaped: 1, reapDeferred: 0,
  });
  assert.deepEqual(sequence, [`reap:1:${DEADLINE_MS + 1}`]);

  for (const reap of [
    async () => ({ candidates: 2, reaped: 0, moved: 0, deferred: 1, unbound: 0 }),
    async () => ({ candidates: 2, reaped: 0, moved: 0, deferred: 0, unbound: 2 }),
  ]) {
    const result = await runConfirmationEmailSweep(sweepDeps([order], { reap }));
    assert.equal(result.ok, false);
    assert.equal(result.reaped, 0);
    assert.ok((result.reapDeferred ?? 0) > 0);
  }

  // A reaper that throws is a deferral; the delivery loop still runs.
  const errors: string[] = [];
  const thrown = await runConfirmationEmailSweep(sweepDeps([order], {
    reap: async () => { throw new TypeError('boom with private text'); },
    errorLog: (line) => { errors.push(line); },
  }));
  assert.equal(thrown.ok, false);
  assert.equal(thrown.reapDeferred, 1);
  assert.deepEqual(errors, ['[confirmation-email-sweep] reaper threw errorClass=TypeError']);
});

test('RP-14: the default sweep wires the reaper; the default reaper resolves the ambient (unset) gate', () => {
  const sweep = readRepo('src/lib/confirmation-email-sweep.ts');
  const defaults = sweep.slice(sweep.indexOf('export function buildDefaultConfirmationEmailSweepDeps'));
  const body = defaults.slice(0, defaults.indexOf('\n}\n'));
  assert.match(body, /reap: \(orders, nowMs\) => runConfirmationEmailReaper\(orders, \{/);
  assert.doesNotMatch(body, /writer\s*:/, 'the default reaper injects no writer deps');
  // The reaper pass precedes the delivery loop.
  const run = sweep.slice(sweep.indexOf('export async function runConfirmationEmailSweep'));
  assert.ok(run.indexOf('deps.reap') !== -1 && run.indexOf('deps.reap') < run.indexOf('for (const order of orders)'));
});

// ── Source guards ──────────────────────────────────────────────────────────

const RECONCILIATION = 'src/lib/confirmation-email-reconciliation.ts';

function importTable(source: string): Array<{ specifier: string; type: boolean; bindings: string[] }> {
  const table: Array<{ specifier: string; type: boolean; bindings: string[] }> = [];
  for (const match of source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+'([^']+)';/gm)) {
    table.push({
      specifier: match[3],
      type: Boolean(match[1]),
      bindings: match[2].split(',').map((binding) => binding.trim()).filter(Boolean).sort(),
    });
  }
  return table;
}

test('RP-15: the reconciliation module reaches no transport, sender, store or sweep filter', () => {
  const source = readRepo(RECONCILIATION);
  const allImports = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+'([^']+)'/gm)].map((match) => match[1]);
  assert.equal(/\bimport\s*\(/.test(source), false, 'no dynamic import');
  assert.equal(/\brequire\s*\(/.test(source), false, 'no require');
  for (const specifier of allImports) {
    assert.doesNotMatch(specifier, /order-email|resend|confirmation-envelope-store|confirmation-envelope-config|@vercel\/blob|confirmation-email-sweep|confirmation-email-envelope/, specifier);
  }
  const runtime = importTable(source).filter((entry) => !entry.type);
  assert.deepEqual(runtime, [
    { specifier: 'node:crypto', type: false, bindings: ['createHash'] },
    { specifier: './admin-auth.ts', type: false, bindings: ['isAdminAuthedFromRequest'] },
    { specifier: './confirmation-email-delivery.ts', type: false, bindings: ['CONFIRMATION_EMAIL_CLAIM_KIND', 'classifyConfirmationEmailError'] },
    { specifier: './confirmation-email-dispatch.ts', type: false, bindings: ['CONFIRMATION_DISPATCH_DEADLINE_MS'] },
    { specifier: './confirmation-email-state.ts', type: false, bindings: ['CONFIRMATION_EMAIL_STATES', 'appendConfirmationEmailAttempt', 'evaluateConfirmationEmailTransition'] },
    { specifier: './confirmation-envelope-producer.ts', type: false, bindings: ['resolveConfirmationEnvelopeWriter'] },
    { specifier: ['./confirmation-envelope', 'ref.ts'].join('-'), type: false, bindings: ['CONFIRMATION_ENVELOPE_REF_ORDER_ID_RE', 'projectConfirmationEmailEnvelopeRefIfValid'] },
  ]);
  for (const forbidden of [
    'dispatchFrozenConfirmation', 'resolveFrozenDispatcher', 'sendOrderConfirmationEmail', 'sendWithFallback',
    'writer.store', '.store.', 'createConfirmationEnvelopeStore', 'evaluateConfirmationEmailSweepEligibility',
    'snapshotConfirmationEnvelope', 'deliverOrderConfirmationEmail', 'postTransportTransact', 'snapshotTransact',
    'beforeTransport', 'confirmationEmailEnvelope:', '.confirmationEmailEnvelope;', 'process.env', 'fetch(',
  ]) {
    assert.equal(source.includes(forbidden), false, `the reconciliation module names ${forbidden}`);
  }
  // Every commit goes through the guarded bound transaction.
  assert.ok(source.includes('gate.orderIo.guardedTransact'));
  // The reaper names T9 and nothing else from the worker/operator vocabulary.
  const reaper = source.slice(source.indexOf('export function decideConfirmationEmailReap'), source.indexOf('export async function runConfirmationEmailReaper'));
  assert.match(reaper, /event: 'deadline_elapsed', actor: 'reaper'/);
  assert.doesNotMatch(reaper, /'claim_released'|'worker'|'operator'|emailResendClaimId: null/);
});

test('ISO: file end — no fetch, env restored', () => {
  assert.equal(FETCH_CALLS, 0, 'a reaper path reached fetch');
  assert.equal(process.env.HSB_BLOB_NAMESPACE, undefined);
  globalThis.fetch = ORIGINAL_FETCH;
});
