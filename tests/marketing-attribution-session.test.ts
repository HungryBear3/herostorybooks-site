/**
 * Governed attribution: capture, precedence, expiry, and the boundary out.
 *
 * The governed contract in utm-contract.ts is the only authority on what a
 * tuple may contain. These tests prove the session layer never widens it, never
 * persists arbitrary query data, and never lets an invalid tuple displace a
 * valid one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ATTRIBUTION_MAX_SERIALIZED_BYTES,
  ATTRIBUTION_STORAGE_KEY,
  ATTRIBUTION_TTL_MS,
  attributionFromSearch,
  attributionMetadata,
  captureAttribution,
  decideAttribution,
  parseStoredAttribution,
  serializeAttribution,
  type StoredAttribution,
} from '../src/lib/marketing/attribution-session.ts';

const VALID = {
  utm_source: 'brightwood_pta',
  utm_medium: 'partner',
  utm_campaign: 'autumn_pilot',
};
const VALID_QS =
  '?utm_source=brightwood_pta&utm_medium=partner&utm_campaign=autumn_pilot';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

function stored(at: number, tuple = VALID): StoredAttribution {
  return { v: 1, t: tuple as never, at };
}

/* ── 1. Only governed keys and values are ever accepted ─────────────────── */

test('only the four governed keys are read out of a query string', () => {
  const out = attributionFromSearch(
    `${VALID_QS}&utm_term=ignored&ref=ignored&gclid=ignored&childName=PrivateName`,
  );
  assert.deepEqual(Object.keys(out).sort(), [
    'utm_campaign',
    'utm_medium',
    'utm_source',
  ]);
});

test('an unapproved medium is rejected rather than stored', () => {
  const storage = fakeStorage();
  // 'social' is not in the closed vocabulary; 'organic_social' is.
  const decision = captureAttribution({
    search: '?utm_source=telegram&utm_medium=social&utm_campaign=launch',
    storage,
    now: 1_000,
  });
  assert.equal(decision.outcome, 'no_valid_tuple');
  assert.equal(storage.map.size, 0, 'nothing may be persisted for a rejected tuple');
});

test('a PII-shaped value is rejected even though it is token-shaped', () => {
  const storage = fakeStorage();
  const decision = captureAttribution({
    search: '?utm_source=jane-at-gmail-com&utm_medium=partner&utm_campaign=launch',
    storage,
    now: 1_000,
  });
  assert.equal(decision.outcome, 'no_valid_tuple');
  assert.equal(storage.map.size, 0);
});

test('an oversized value is rejected, and is bounded before validation', () => {
  const storage = fakeStorage();
  const huge = 'a'.repeat(5_000);
  const decision = captureAttribution({
    search: `?utm_source=${huge}&utm_medium=partner&utm_campaign=launch`,
    storage,
    now: 1_000,
  });
  assert.equal(decision.outcome, 'no_valid_tuple');
  assert.equal(storage.map.size, 0);
});

test('a partial tuple is rejected whole, never stored in pieces', () => {
  const storage = fakeStorage();
  // Source and medium present, campaign missing.
  const decision = captureAttribution({
    search: '?utm_source=brightwood_pta&utm_medium=partner',
    storage,
    now: 1_000,
  });
  assert.equal(decision.outcome, 'no_valid_tuple');
  assert.equal(storage.map.size, 0, 'a half tuple must never be persisted');
});

test('duplicate query keys cannot smuggle a second value past validation', () => {
  const storage = fakeStorage();
  const decision = captureAttribution({
    search:
      '?utm_source=brightwood_pta&utm_source=evil&utm_medium=partner&utm_campaign=autumn_pilot',
    storage,
    now: 1_000,
  });
  // URLSearchParams.get returns the FIRST value; whichever it is, it must be
  // one governed value and never a joined pair.
  assert.equal(decision.outcome, 'stored_first_touch');
  assert.equal(decision.attribution?.t.utm_source, 'brightwood_pta');
});

/* ── 2. No raw URL, referrer, or arbitrary query data is persisted ──────── */

test('the persisted record contains only governed fields and a timestamp', () => {
  const storage = fakeStorage();
  captureAttribution({
    search: `${VALID_QS}&utm_term=x&ref=y&fbclid=z#fragment`,
    storage,
    now: 1_000,
  });
  const raw = storage.map.get(ATTRIBUTION_STORAGE_KEY) ?? '';
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), ['at', 't', 'v']);
  assert.deepEqual(Object.keys(parsed.t).sort(), [
    'utm_campaign',
    'utm_medium',
    'utm_source',
  ]);
  for (const leak of ['utm_term', 'ref', 'fbclid', 'fragment', 'http', '/', '?']) {
    assert.equal(raw.includes(leak), false, `${leak} leaked into storage`);
  }
});

test('the session module never reads a referrer, href, or pathname', () => {
  const src = readFileSync(
    new URL('../src/lib/marketing/attribution-session.ts', import.meta.url),
    'utf8',
  );
  for (const forbidden of ['document.referrer', 'location.href', 'location.pathname', 'location.hash']) {
    assert.equal(src.includes(forbidden), false, `attribution reads ${forbidden}`);
  }
});

/* ── 3. First-touch precedence and expiry ───────────────────────────────── */

test('the first valid tuple is stored as first touch', () => {
  const storage = fakeStorage();
  const decision = captureAttribution({ search: VALID_QS, storage, now: 1_000 });
  assert.equal(decision.outcome, 'stored_first_touch');
  assert.equal(decision.attribution?.at, 1_000);
});

test('a LATER valid tuple does not displace a live first touch', () => {
  const storage = fakeStorage();
  captureAttribution({ search: VALID_QS, storage, now: 1_000 });
  const later = captureAttribution({
    search: '?utm_source=other_partner&utm_medium=flyer&utm_campaign=second',
    storage,
    now: 1_000 + ATTRIBUTION_TTL_MS - 1,
  });
  assert.equal(later.outcome, 'kept_existing_first_touch');
  assert.equal(later.attribution?.t.utm_source, 'brightwood_pta');
  assert.equal(later.attribution?.at, 1_000, 'the window must not be extended');
});

test('an expired first touch is replaced by the next valid tuple', () => {
  const storage = fakeStorage();
  captureAttribution({ search: VALID_QS, storage, now: 1_000 });
  const later = captureAttribution({
    search: '?utm_source=other_partner&utm_medium=flyer&utm_campaign=second',
    storage,
    now: 1_000 + ATTRIBUTION_TTL_MS,
  });
  assert.equal(later.outcome, 'replaced_expired');
  assert.equal(later.attribution?.t.utm_source, 'other_partner');
});

test('expiry is inclusive at exactly the TTL boundary', () => {
  const one = decideAttribution({
    stored: stored(0),
    incoming: { utm_source: 'x_partner', utm_medium: 'flyer', utm_campaign: 'c' },
    now: ATTRIBUTION_TTL_MS - 1,
  });
  assert.equal(one.outcome, 'kept_existing_first_touch');
  const two = decideAttribution({
    stored: stored(0),
    incoming: { utm_source: 'x_partner', utm_medium: 'flyer', utm_campaign: 'c' },
    now: ATTRIBUTION_TTL_MS,
  });
  assert.equal(two.outcome, 'replaced_expired');
});

test('an INVALID later tuple never overwrites a live or an expired first touch', () => {
  const storage = fakeStorage();
  captureAttribution({ search: VALID_QS, storage, now: 1_000 });
  const before = storage.map.get(ATTRIBUTION_STORAGE_KEY);

  // Live window, invalid challenger.
  captureAttribution({ search: '?utm_medium=not_allowed', storage, now: 2_000 });
  assert.equal(storage.map.get(ATTRIBUTION_STORAGE_KEY), before);

  // Expired window, invalid challenger: still not overwritten, still not cleared.
  const expired = captureAttribution({
    search: '?utm_source=x&utm_medium=bogus&utm_campaign=y',
    storage,
    now: 1_000 + ATTRIBUTION_TTL_MS + 1,
  });
  assert.equal(expired.outcome, 'no_valid_tuple');
  assert.equal(storage.map.get(ATTRIBUTION_STORAGE_KEY), before, 'storage was mutated');
});

test('an empty query never overwrites or clears', () => {
  const storage = fakeStorage();
  captureAttribution({ search: VALID_QS, storage, now: 1_000 });
  const before = storage.map.get(ATTRIBUTION_STORAGE_KEY);
  const decision = captureAttribution({ search: '', storage, now: 2_000 });
  assert.equal(decision.outcome, 'kept_existing_first_touch');
  assert.equal(storage.map.get(ATTRIBUTION_STORAGE_KEY), before);
});

/* ── 4. Stored records are re-validated, never trusted ──────────────────── */

test('a tampered stored record is discarded, not honoured', () => {
  for (const raw of [
    'not json',
    '{}',
    JSON.stringify({ v: 2, t: VALID, at: 1 }),
    JSON.stringify({ v: 1, t: VALID }),
    JSON.stringify({ v: 1, t: VALID, at: 0 }),
    JSON.stringify({ v: 1, t: VALID, at: -5 }),
    JSON.stringify({ v: 1, t: { utm_source: 'x' }, at: 1 }),
    // A medium that was never allowlisted, hand-written into storage.
    JSON.stringify({ v: 1, t: { ...VALID, utm_medium: 'social' }, at: 1 }),
    // PII smuggled past a stale contract.
    JSON.stringify({ v: 1, t: { ...VALID, utm_campaign: 'jane-at-gmail-com' }, at: 1 }),
  ]) {
    assert.equal(parseStoredAttribution(raw), null, `honoured: ${raw.slice(0, 60)}`);
  }
});

test('an oversized stored record is refused before it is parsed', () => {
  const huge = JSON.stringify({ v: 1, t: VALID, at: 1, pad: 'x'.repeat(ATTRIBUTION_MAX_SERIALIZED_BYTES) });
  assert.equal(parseStoredAttribution(huge), null);
});

test('a valid stored record round-trips exactly', () => {
  const record = stored(12_345);
  const parsed = parseStoredAttribution(serializeAttribution(record));
  assert.deepEqual(parsed, record);
});

/* ── 5. The boundary out to the server ──────────────────────────────────── */

test('attributionMetadata emits only governed keys, or nothing', () => {
  assert.deepEqual(attributionMetadata(null), {});
  const meta = attributionMetadata(VALID as never);
  assert.deepEqual(Object.keys(meta).sort(), [
    'utm_campaign',
    'utm_medium',
    'utm_source',
  ]);
  assert.equal(meta.utm_source, 'brightwood_pta');
});

test('storage being unavailable degrades instead of throwing', () => {
  const decision = captureAttribution({ search: VALID_QS, storage: null, now: 1 });
  assert.equal(decision.outcome, 'unavailable');
});

test('a storage that throws on read is treated as empty, not as a grant of anything', () => {
  const hostile = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => undefined,
  };
  const decision = captureAttribution({ search: VALID_QS, storage: hostile, now: 1_000 });
  assert.equal(decision.outcome, 'stored_first_touch');
});

test('a storage that throws on write does not break the page', () => {
  const hostile = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
  };
  const decision = captureAttribution({ search: VALID_QS, storage: hostile, now: 1_000 });
  assert.equal(decision.outcome, 'stored_first_touch');
  assert.equal(decision.attribution?.t.utm_source, 'brightwood_pta');
});
