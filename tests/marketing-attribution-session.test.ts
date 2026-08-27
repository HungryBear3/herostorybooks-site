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
  governedCampaignFromSearch,
  ungovernedCampaignKey,
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

test('only the four governed keys are read, and companions reject the tuple', () => {
  // Non-campaign app params and platform click ids are irrelevant: only the
  // governed four are read.
  const clean = attributionFromSearch(`${VALID_QS}&gclid=abc&childName=PrivateName`);
  assert.deepEqual(Object.keys(clean).sort(), [
    'utm_campaign',
    'utm_medium',
    'utm_source',
  ]);
  // But an ungoverned campaign key is NOT stripped-and-ignored: it disqualifies
  // the whole tuple, so nothing at all comes back.
  assert.deepEqual(attributionFromSearch(`${VALID_QS}&utm_term=ignored`), {});
  assert.deepEqual(attributionFromSearch(`${VALID_QS}&ref=ignored`), {});
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

test('duplicate query keys reject the tuple rather than silently picking one', () => {
  const storage = fakeStorage();
  const decision = captureAttribution({
    search:
      '?utm_source=brightwood_pta&utm_source=evil&utm_medium=partner&utm_campaign=autumn_pilot',
    storage,
    now: 1_000,
  });
  // Taking the first value and discarding the second would attribute the visit
  // to whichever the author did not mean. Ambiguity is a rejection.
  assert.equal(decision.outcome, 'no_valid_tuple');
  assert.equal(storage.map.size, 0);
});

/* ── 2. No raw URL, referrer, or arbitrary query data is persisted ──────── */

test('the persisted record contains only governed fields and a timestamp', () => {
  const storage = fakeStorage();
  // utm_term / ref would now reject the tuple outright (covered below), so this
  // exercises the storage shape with the companions that are legitimately
  // ignored rather than rejected.
  captureAttribution({
    search: `${VALID_QS}&fbclid=z&childName=PrivateName#fragment`,
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
  for (const leak of ['fbclid', 'PrivateName', 'childName', 'fragment', 'http', '/', '?']) {
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

/* == 6. Strict whole-tuple rejection at the query boundary =============== */

test('an otherwise-valid tuple carrying utm_term is rejected ENTIRELY', () => {
  const storage = fakeStorage();
  const decision = captureAttribution({
    search: `${VALID_QS}&utm_term=keyword`,
    storage,
    now: 1_000,
  });
  assert.equal(decision.outcome, 'no_valid_tuple', 'the remainder was accepted after stripping');
  assert.equal(storage.map.size, 0);
  assert.equal(governedCampaignFromSearch(`${VALID_QS}&utm_term=x`).rejected, 'ungoverned_utm_key');
});

test('an otherwise-valid tuple carrying ref is rejected ENTIRELY', () => {
  const storage = fakeStorage();
  const decision = captureAttribution({ search: `${VALID_QS}&ref=friend`, storage, now: 1_000 });
  assert.equal(decision.outcome, 'no_valid_tuple');
  assert.equal(storage.map.size, 0);
  assert.equal(governedCampaignFromSearch(`${VALID_QS}&ref=x`).rejected, 'legacy_companion_key');
});

test('any arbitrary utm_* key rejects the whole tuple', () => {
  for (const key of ['utm_id', 'utm_name', 'utm_creative', 'utm_anything', 'UTM_TERM']) {
    const result = governedCampaignFromSearch(`${VALID_QS}&${key}=x`);
    assert.equal(result.rejected, 'ungoverned_utm_key', `${key} was tolerated`);
    assert.equal(result.utms, undefined);
  }
});

test('a duplicated governed key is ambiguous and rejects the whole tuple', () => {
  const result = governedCampaignFromSearch(
    '?utm_source=a_partner&utm_source=b_partner&utm_medium=partner&utm_campaign=c',
  );
  assert.equal(result.rejected, 'duplicate_key');
});

test('malformed percent-encoding rejects the whole tuple', () => {
  for (const bad of ['?utm_source=%zz&utm_medium=partner&utm_campaign=c', '?%E0%A4%A']) {
    const result = governedCampaignFromSearch(bad);
    assert.equal(result.rejected, 'malformed_encoding', `${bad} was tolerated`);
  }
});

test('smuggled PII in a governed value still fails, as before', () => {
  assert.equal(
    captureAttribution({
      search: '?utm_source=jane-at-gmail-com&utm_medium=partner&utm_campaign=c',
      storage: fakeStorage(),
      now: 1,
    }).outcome,
    'no_valid_tuple',
  );
});

test('a rejected query never displaces a live OR an expired first touch', () => {
  const storage = fakeStorage();
  captureAttribution({ search: VALID_QS, storage, now: 1_000 });
  const before = storage.map.get(ATTRIBUTION_STORAGE_KEY);

  captureAttribution({ search: `${VALID_QS}&utm_term=x`, storage, now: 2_000 });
  assert.equal(storage.map.get(ATTRIBUTION_STORAGE_KEY), before);

  const expired = captureAttribution({
    search: `${VALID_QS}&ref=x`,
    storage,
    now: 1_000 + ATTRIBUTION_TTL_MS + 1,
  });
  assert.equal(expired.outcome, 'no_valid_tuple');
  assert.equal(storage.map.get(ATTRIBUTION_STORAGE_KEY), before);
});

test('platform click ids are NOT treated as campaign companions', () => {
  // Documented decision: fbclid/gclid are appended automatically by the
  // platform, not typed by the link author. Rejecting them would mean a
  // governed partner link attributes from email but not from a Facebook share.
  for (const key of ['fbclid', 'gclid', 'msclkid', 'ttclid', 'twclid']) {
    const result = governedCampaignFromSearch(`${VALID_QS}&${key}=abc123`);
    assert.equal(result.rejected, undefined, `${key} rejected a governed link`);
    assert.equal(result.utms?.utm_source, 'brightwood_pta');
  }
  // And they are never stored.
  const storage = fakeStorage();
  captureAttribution({ search: `${VALID_QS}&fbclid=abc123`, storage, now: 1 });
  assert.equal((storage.map.get(ATTRIBUTION_STORAGE_KEY) ?? '').includes('fbclid'), false);
});

test('non-campaign query parameters are irrelevant and do not reject', () => {
  // /checkout?childName=... and /review?token=... are legitimate app params.
  const result = governedCampaignFromSearch(`${VALID_QS}&childName=PrivateName&token=abc`);
  assert.equal(result.rejected, undefined);
  assert.equal(result.utms?.utm_campaign, 'autumn_pilot');
});

test('the shared key check is what both boundaries use', () => {
  assert.equal(ungovernedCampaignKey(['utm_source', 'utm_medium', 'utm_campaign']), null);
  assert.equal(ungovernedCampaignKey(['utm_source', 'utm_term']), 'utm_term');
  assert.equal(ungovernedCampaignKey(['ref']), 'ref');
  assert.equal(ungovernedCampaignKey(['fbclid']), null);
  assert.equal(ungovernedCampaignKey(['childName', 'email']), null);
});
