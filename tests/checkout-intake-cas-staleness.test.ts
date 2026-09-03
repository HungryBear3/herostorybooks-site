/*
 * Regression for the PR #165 Preview intake incident:
 * a synthetic Digital checkout uploaded its hero photo successfully — the
 * private object landed — but the Vercel completion callback and the
 * browser's resolve/final-intake reconciliation both came back
 * `intake_write_conflict` (409) within the same short window, and the
 * durable slot was left at generation=1, pending=true, active=false: NEITHER
 * writer ever recorded the completed upload.
 *
 * ROOT CAUSE
 * ----------
 * `mutateIntake`'s bounded CAS retry loop re-reads the record on every
 * attempt but never waited between attempts — all five fired back to back,
 * within microseconds of each other. Vercel Blob's cross-request `read` can
 * lag briefly behind a write another request already committed (`useCache:
 * false` only disables OUR application cache, not the storage backend's own
 * propagation window). When a retrying writer's reads all land inside that
 * lagging window, the loop exhausts and reports a permanent conflict for what
 * is really a transient visibility gap that would have resolved a few tens of
 * milliseconds later.
 *
 * This is reproduced here with a store whose `read()` is pinned to a snapshot
 * captured before a concurrent write, until a SIMULATED clock — advanced only
 * by the retry loop's own backoff, never by real time — passes a threshold.
 * It proves the exhaustion happens with zero backoff, and that a bounded,
 * deterministic backoff between attempts is enough to let the read converge
 * on the completion the other request already landed, resolving to the same
 * idempotent outcome instead of a false conflict — or, worse, a blind
 * overwrite.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIntake,
  refreshIntakeConsent,
  type IntakeStoreSnapshot,
} from '../src/lib/checkout-intake.ts';
import { completeSlotUpload, reserveSlotUpload, resolveSlotUpload } from '../src/lib/checkout-intake-upload.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const CONSENT = { mediaAuthorizedAt: '2026-09-02T12:00:00.000Z' };
const HERO = { category: 'primary_hero_photo' } as const;

async function newIntake(store: MemoryIntakeStore) {
  return createIntake(store, CONSENT);
}

/** A `wait` that advances the store's simulated clock instead of really sleeping. */
function fastForwardWait(store: MemoryIntakeStore) {
  return async (delayMs: number): Promise<void> => {
    store.advanceSimulatedClock(delayMs);
  };
}

test('production completion waits, rereads a newer pending record, and reapplies activation', async () => {
  const store = createMemoryIntakeStore();
  const session = await newIntake(store);

  const reservation = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/jpeg',
    size: 1024,
  });
  const etag = `etag-${reservation.assetId}`;
  store.putAsset({ pathname: reservation.pathname, mimeType: 'image/jpeg', size: 1024, etag });

  // This is the pending snapshot the completion request initially sees.
  const stalePending: IntakeStoreSnapshot = (await store.read(session.intakeId))!;

  // A different request wins an unrelated intake mutation. The hero slot is
  // still pending, but its prior ETag can no longer win CAS.
  await refreshIntakeConsent(
    store,
    {
      intakeId: session.intakeId,
      capability: session.capability,
      consent: { documentAuthorizedAt: '2026-09-02T12:00:01.000Z' },
    },
    new Date('2026-09-02T12:00:01.000Z'),
  );
  const unrelatedWinner = store.records.get(session.intakeId)!.record;
  assert.ok(unrelatedWinner.consent.documentAuthorizedAt);
  assert.equal(unrelatedWinner.slots[HERO.category]!.pending?.assetId, reservation.assetId);
  assert.equal(unrelatedWinner.slots[HERO.category]!.active, null);

  // The completion request sees the old pending ETag until 60 ms of the real
  // production retry schedule has elapsed. Patch only the platform timer so
  // the test remains deterministic; do NOT inject MutateIntakeIo here. This
  // exercises completeSlotUpload's production/default composition.
  store.armStaleReads(session.intakeId, stalePending, 60);
  store.casAttempts = 0;
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const normalizedDelay = Number(delay ?? 0);
    delays.push(normalizedDelay);
    store.advanceSimulatedClock(normalizedDelay);
    callback(...args);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    const callback = await completeSlotUpload(store, {
      tokenPayload: reservation.tokenPayload,
      blob: { pathname: reservation.pathname, contentType: 'image/jpeg', size: 1024, etag },
    });
    assert.equal(callback.status, 'activated');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.deepEqual(delays, [20, 40]);
  assert.equal(store.casAttempts, 3);

  const record = store.records.get(session.intakeId)!.record;
  assert.ok(record.consent.documentAuthorizedAt, 'the unrelated winning mutation is preserved');
  assert.equal(record.slots[HERO.category]!.active?.assetId, reservation.assetId);
  assert.equal(record.slots[HERO.category]!.pending, null);
  assert.equal(record.superseded.length, 0);
});

test('a completion that already landed converges after a lagging cross-request read, instead of exhausting', async () => {
  const store = createMemoryIntakeStore();
  const session = await newIntake(store);

  const reservation = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/jpeg',
    size: 1024,
  });
  const etag = `etag-${reservation.assetId}`;
  store.putAsset({ pathname: reservation.pathname, mimeType: 'image/jpeg', size: 1024, etag });

  // The snapshot a lagging cross-request read keeps serving: captured BEFORE
  // the completion below is applied.
  const preCompletion: IntakeStoreSnapshot = (await store.read(session.intakeId))!;

  // The Vercel completion callback lands normally and wins outright — the
  // "upload completion callback" side of the incident.
  const callback = await completeSlotUpload(store, {
    tokenPayload: reservation.tokenPayload,
    blob: { pathname: reservation.pathname, contentType: 'image/jpeg', size: 1024, etag },
  });
  assert.equal(callback.status, 'activated');

  // Arm cross-request staleness for 300ms of SIMULATED time: any `read` sees
  // the pre-completion snapshot (pending, no active) until then.
  store.armStaleReads(session.intakeId, preCompletion, 300);

  // The browser's resolve/final-intake reconciliation races the callback and
  // hits the lagging read.
  const resolved = await resolveSlotUpload(
    store,
    { intakeId: session.intakeId, capability: session.capability, slot: HERO, generation: reservation.generation },
    undefined,
    { wait: fastForwardWait(store) },
  );

  // It must converge on the completion that already landed — never a thrown
  // conflict, and never a second/duplicate asset.
  assert.equal(resolved.status, 'idempotent');
  assert.equal(resolved.asset?.assetId, reservation.assetId);

  const record = store.records.get(session.intakeId)!.record;
  assert.equal(record.slots[HERO.category]!.active?.assetId, reservation.assetId);
  assert.equal(record.slots[HERO.category]!.pending, null);
  assert.equal(record.superseded.length, 0, 'no orphan was recorded for a completion that actually landed');
});

test('a lagging read that never converges is still a conflict, never a blind overwrite', async () => {
  const store = createMemoryIntakeStore();
  const session = await newIntake(store);

  const reservation = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/jpeg',
    size: 1024,
  });
  const etag = `etag-${reservation.assetId}`;
  store.putAsset({ pathname: reservation.pathname, mimeType: 'image/jpeg', size: 1024, etag });

  const preCompletion: IntakeStoreSnapshot = (await store.read(session.intakeId))!;

  const callback = await completeSlotUpload(store, {
    tokenPayload: reservation.tokenPayload,
    blob: { pathname: reservation.pathname, contentType: 'image/jpeg', size: 1024, etag },
  });
  assert.equal(callback.status, 'activated');

  // Staleness that outlasts the whole bounded retry budget: even with the
  // fix's backoff, cumulative simulated delay never reaches this. The retry
  // loop must still fail closed rather than retry forever or adopt the stale
  // view.
  store.armStaleReads(session.intakeId, preCompletion, Number.MAX_SAFE_INTEGER);

  await assert.rejects(
    resolveSlotUpload(
      store,
      { intakeId: session.intakeId, capability: session.capability, slot: HERO, generation: reservation.generation },
      undefined,
      { wait: fastForwardWait(store) },
    ),
    (error) => (error as { code?: string }).code === 'intake_write_conflict' && (error as { status?: number }).status === 409,
  );

  // The already-landed completion is untouched — the exhausted retry never
  // performed a write of its own.
  const record = store.records.get(session.intakeId)!.record;
  assert.equal(record.slots[HERO.category]!.active?.assetId, reservation.assetId);
  assert.equal(record.superseded.length, 0);
});
