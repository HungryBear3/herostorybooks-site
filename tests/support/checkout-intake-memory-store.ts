/*
 * In-memory `IntakeStore` used by the checkout upload state-machine tests.
 *
 * It models the two properties of the real private-Blob store the state
 * machine depends on and nothing else:
 *
 *   1. `read` returns `null` for an absent record and THROWS when the store is
 *      unavailable. The state machine must never conflate the two.
 *   2. `compareAndSwap` succeeds only against the exact current version, so a
 *      test can interleave two writers and reproduce a real lost update.
 *
 * `failNextCas` lets a test force a specific CAS attempt to lose the race
 * without needing real concurrency, which keeps the race regressions
 * deterministic.
 *
 * `armStaleReads` models the OTHER half of a real Blob store's failure modes:
 * a cross-request `read` that lags briefly behind a write a different request
 * already committed. It is driven by a SIMULATED clock (`advanceSimulatedClock`)
 * rather than real time, so a test can reproduce a lagging-read regression
 * without ever actually waiting.
 */
import { IntakeError } from '../../src/lib/checkout-intake.ts';
import type { IntakeRecord, IntakeStore, IntakeStoreSnapshot } from '../../src/lib/checkout-intake.ts';

export interface MemoryAssetBlob {
  pathname: string;
  mimeType: string;
  size: number;
  etag: string;
}

export interface MemoryIntakeStore extends IntakeStore {
  /** Raw stored records, keyed by intakeId. Tests read this to assert state. */
  records: Map<string, { record: IntakeRecord; etag: string }>;
  /** Blob objects that "exist" in storage, keyed by pathname. */
  assets: Map<string, MemoryAssetBlob>;
  /** Put an object into storage as if a client upload had landed. */
  putAsset(blob: MemoryAssetBlob): void;
  /** Make the next `read` throw, simulating an unavailable store. */
  failNextRead(error?: Error): void;
  /** Make the next `headAsset` throw, simulating an unreadable object. */
  failNextHead(error?: Error): void;
  /** Make the next N `compareAndSwap` calls report a lost race. */
  failNextCas(count?: number): void;
  /** Run `mutate` between the next read and its CAS, forcing a real conflict. */
  interleaveBeforeNextCas(mutate: () => void | Promise<void>): void;
  casAttempts: number;
  /**
   * Pins `read(intakeId)` to `snapshot` — instead of the live record — until
   * the store's simulated clock reaches `untilMs`. Models a storage replica
   * that has not yet observed a write another request already committed.
   * `compareAndSwap` is untouched: it always judges the live record, exactly
   * like a real CAS precondition would.
   */
  armStaleReads(intakeId: string, snapshot: IntakeStoreSnapshot, untilMs: number): void;
  /**
   * Advances the store's simulated clock. Meant to be called from a test's
   * fake `wait`, so a retry loop's backoff can be proven to matter without
   * any real time passing.
   */
  advanceSimulatedClock(ms: number): void;
}

let etagCounter = 0;

function nextEtag(): string {
  etagCounter += 1;
  return `etag-${etagCounter}`;
}

export function createMemoryIntakeStore(): MemoryIntakeStore {
  const records = new Map<string, { record: IntakeRecord; etag: string }>();
  const assets = new Map<string, MemoryAssetBlob>();
  let pendingReadError: Error | null = null;
  let pendingHeadError: Error | null = null;
  let pendingCasFailures = 0;
  let interleave: (() => void | Promise<void>) | null = null;
  let simulatedNowMs = 0;
  const staleReads = new Map<string, { snapshot: IntakeStoreSnapshot; untilMs: number }>();

  const store: MemoryIntakeStore = {
    records,
    assets,
    casAttempts: 0,

    armStaleReads(intakeId, snapshot, untilMs) {
      staleReads.set(intakeId, {
        snapshot: { record: structuredClone(snapshot.record), etag: snapshot.etag },
        untilMs,
      });
    },

    advanceSimulatedClock(ms) {
      simulatedNowMs += ms;
    },

    putAsset(blob) {
      assets.set(blob.pathname, { ...blob });
    },

    failNextRead(error = new Error('intake store unavailable')) {
      pendingReadError = error;
    },

    failNextHead(error = new IntakeError('intake_store_unavailable', 503)) {
      pendingHeadError = error;
    },

    failNextCas(count = 1) {
      pendingCasFailures = count;
    },

    interleaveBeforeNextCas(mutate) {
      interleave = mutate;
    },

    async create(record) {
      if (records.has(record.intakeId)) throw new Error('intake already exists');
      records.set(record.intakeId, { record: structuredClone(record), etag: nextEtag() });
    },

    async read(intakeId): Promise<IntakeStoreSnapshot | null> {
      if (pendingReadError) {
        const error = pendingReadError;
        pendingReadError = null;
        throw error;
      }
      const stale = staleReads.get(intakeId);
      if (stale && simulatedNowMs < stale.untilMs) {
        return { record: structuredClone(stale.snapshot.record), etag: stale.snapshot.etag };
      }
      const entry = records.get(intakeId);
      if (!entry) return null;
      return { record: structuredClone(entry.record), etag: entry.etag };
    },

    async compareAndSwap(intakeId, etag, record) {
      if (interleave) {
        const run = interleave;
        interleave = null;
        await run();
      }
      store.casAttempts += 1;
      if (pendingCasFailures > 0) {
        pendingCasFailures -= 1;
        return false;
      }
      const entry = records.get(intakeId);
      if (!entry || entry.etag !== etag) return false;
      records.set(intakeId, { record: structuredClone(record), etag: nextEtag() });
      return true;
    },

    async headAsset(pathname) {
      if (pendingHeadError) {
        const error = pendingHeadError;
        pendingHeadError = null;
        throw error;
      }
      const blob = assets.get(pathname);
      return blob ? { ...blob } : null;
    },
  };

  return store;
}

/** Overwrite a stored record without going through CAS (test-only surgery). */
export function forceRecord(store: MemoryIntakeStore, record: IntakeRecord): void {
  store.records.set(record.intakeId, { record: structuredClone(record), etag: nextEtag() });
}
