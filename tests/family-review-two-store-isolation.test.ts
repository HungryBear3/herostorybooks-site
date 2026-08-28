/**
 * Two-store isolation: the Family Review private lane and the order lane
 * must never touch each other's store.
 *
 * This is the regression guard for the defect that blocked the cutover.
 * `BLOB_READ_WRITE_TOKEN` is the whole application's credential — the
 * order records, customer photos, voice notes, and the payment-recovery
 * and recovery objects all live in the store it names. Pointing it at
 * the migrated private store to move Family Review would have taken
 * every one of those with it, into a store the migration never
 * populates.
 *
 * How this proves it
 * ------------------
 * Each scenario runs in a CHILD process with `@vercel/blob` resolved to
 * tests/helpers/blob-store-fake.mjs, a two-store fake that models the
 * SDK's real store resolution: an explicit `token:` wins, otherwise the
 * ambient variable. The REAL src/ modules run unmodified — no injected
 * client, no seam added to production code for a test's benefit. The
 * fake journals which store every call landed on, and the child prints
 * that journal for the assertions here.
 *
 * A child process because the resolve hook must be installed before
 * anything imports `@vercel/blob`, and because it guarantees one
 * scenario's environment cannot leak into the next.
 *
 * Everything is synthetic: fake parseable-but-obviously-not-real
 * credentials, a fake submission, a fake order. No live store, no
 * customer record, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const AMBIENT_STORE = 'pubAMBIENT0000';
const DEST_STORE = 'privDEST0000';

/** Credential values the scenario runner uses. Never real. */
const FAKE_TOKENS = [
  'vercel_blob_rw_pubAMBIENT0000_ambientsecret',
  'vercel_blob_rw_privDEST0000_destsecret',
];

interface JournalEntry {
  op: 'put' | 'get' | 'head' | 'del' | 'list';
  pathname: string | null;
  storeId: string;
  hasExplicitToken: boolean;
  access: string | null;
}

interface ScenarioResult {
  scenario: string;
  steps: Record<string, { ok: boolean; value?: unknown; error?: { name: string; code: string | null; message: string } }>;
  journal: JournalEntry[];
  stores: Record<string, string[]>;
  raw: string;
}

function runScenario(name: string): ScenarioResult {
  const raw = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--import',
      resolve(process.cwd(), 'tests/helpers/blob-fake-register.mjs'),
      resolve(process.cwd(), 'tests/helpers/two-store-scenario.mjs'),
      name,
    ],
    { encoding: 'utf8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const match = raw.match(/__SCENARIO_JSON__([\s\S]*?)__END__/);
  assert.ok(match, `scenario ${name} produced no result payload`);
  return { ...JSON.parse(match[1]), raw };
}

const familyReviewOps = (r: ScenarioResult) =>
  r.journal.filter((e) => (e.pathname ?? '').startsWith('family-review/'));
const otherLaneOps = (r: ScenarioResult) =>
  r.journal.filter((e) => !(e.pathname ?? '').startsWith('family-review/'));

/* ── 1. Private mode with a valid dedicated credential ──────────────── */

test('private mode sends every Family Review write to the destination store', () => {
  const r = runScenario('private-ok');
  const writes = familyReviewOps(r).filter((e) => e.op === 'put');
  assert.ok(writes.length >= 4, 'expected record, token index, photo, and sample writes');
  for (const w of writes) {
    assert.equal(w.storeId, DEST_STORE, `${w.pathname} must be written to the private store`);
    assert.equal(w.hasExplicitToken, true, `${w.pathname} must carry an explicit token`);
    assert.equal(w.access, 'private');
  }
  // Requirement 6: records, token indexes, parent photos, and admin
  // samples are ONE boundary, not four.
  const written = writes.map((w) => w.pathname ?? '');
  assert.ok(written.some((p) => p.startsWith('family-review/submissions/')), 'submission record');
  assert.ok(written.some((p) => p.startsWith('family-review/review-tokens/')), 'review-token index');
  assert.ok(written.some((p) => p.startsWith('family-review/photos/')), 'parent photo');
  assert.ok(written.some((p) => p.startsWith('family-review/samples/')), 'admin sample');
});

test('private mode reads, lists, and deletes from the destination store', () => {
  const r = runScenario('private-ok');
  for (const op of ['get', 'list', 'del'] as const) {
    const calls = familyReviewOps(r).filter((e) => e.op === op && e.access !== 'public');
    assert.ok(calls.length > 0, `expected at least one ${op}`);
    for (const c of calls) {
      assert.equal(c.storeId, DEST_STORE, `${op} ${c.pathname} must address the private store`);
      assert.equal(c.hasExplicitToken, true);
    }
  }
  assert.equal(r.steps.listRecentSubmissions.value?.[0], 'fr-synthetic-1');
  assert.equal(r.steps.findById.value, 'fr-synthetic-1');
  assert.deepEqual(r.steps.openPrivateAsset.value, { storage: 'private', size: 18 });
});

test('the order, payment-recovery, and recovery lanes stay on the ambient store', () => {
  const r = runScenario('private-ok');
  const others = otherLaneOps(r);
  assert.ok(others.length > 0, 'the order lane must actually have been exercised');
  for (const e of others) {
    assert.equal(
      e.storeId,
      AMBIENT_STORE,
      `${e.op} ${e.pathname} must stay on the ambient store while Family Review is private`,
    );
  }
  assert.equal(r.steps.persistOrder.ok, true, 'the order lane keeps working during a private Family Review cutover');
});

test('neither store ends up holding the other lane’s objects', () => {
  const r = runScenario('private-ok');
  for (const pathname of r.stores[DEST_STORE]) {
    assert.ok(
      pathname.startsWith('family-review/'),
      `the private store must hold only Family Review objects, found: ${pathname}`,
    );
  }
  for (const pathname of r.stores[AMBIENT_STORE]) {
    assert.ok(
      !pathname.startsWith('family-review/'),
      `a private cutover must leave no NEW Family Review object in the ambient store, found: ${pathname}`,
    );
  }
  assert.deepEqual(r.stores.unresolved, [], 'no call may run without a resolvable credential');
  assert.deepEqual(r.stores.unparseable, [], 'no call may run on an unparseable credential');
});

/* ── 2. Fail closed, before any SDK call ────────────────────────────── */

for (const scenario of ['private-missing-token', 'private-blank-token', 'private-malformed-token']) {
  test(`${scenario}: private mode makes NO Family Review store call at all`, () => {
    const r = runScenario(scenario);
    assert.deepEqual(
      familyReviewOps(r),
      [],
      'an unusable dedicated credential must stop before the SDK, not after it',
    );
  });

  test(`${scenario}: every Family Review operation refuses, and none falls back`, () => {
    const r = runScenario(scenario);
    assert.equal(r.steps.hasBlobToken.value, false, 'the 503 storage gate must close');
    assert.equal(r.steps.persistSubmission.value?.persisted, false);
    for (const step of ['putPhotoAsset', 'putSampleAsset', 'openPrivateAsset']) {
      assert.equal(r.steps[step].ok, false, `${step} must fail`);
      assert.equal(r.steps[step].error?.name, 'AssetStorageError');
      assert.equal(r.steps[step].error?.code, 'credential_unavailable');
    }
    assert.deepEqual(r.steps.listRecentSubmissions.value, []);
    assert.equal(r.steps.findById.value, null);
    assert.deepEqual(r.steps.deleteAsset.value, { deleted: false, reason: 'credential_unavailable' });
  });

  test(`${scenario}: the order lane is untouched by the Family Review failure`, () => {
    const r = runScenario(scenario);
    assert.equal(r.steps.persistOrder.ok, true);
    for (const e of otherLaneOps(r)) assert.equal(e.storeId, AMBIENT_STORE);
  });
}

/* ── 3. Public mode is unchanged ────────────────────────────────────── */

test('public mode behaves exactly as before: ambient store, no dedicated token', () => {
  const r = runScenario('public-mode');
  const ops = familyReviewOps(r);
  assert.ok(ops.length > 0);
  for (const e of ops) {
    assert.equal(e.storeId, AMBIENT_STORE, `${e.op} ${e.pathname} must stay on the ambient store`);
    assert.equal(e.hasExplicitToken, false, 'public mode must not start passing a token');
    assert.notEqual(e.access, 'private');
  }
  assert.equal(r.steps.hasBlobToken.value, true);
  assert.equal(r.steps.persistSubmission.value?.persisted, true);
  assert.equal(r.steps.putPhotoAsset.value?.storage, 'public');
  assert.ok(r.steps.putPhotoAsset.value?.blobUrl, 'a public asset still gets its URL');
  assert.equal(r.steps.findById.value, 'fr-synthetic-1');
  // listRecentSubmissions is not asserted here: in public mode it reads
  // the record over the object's public URL, and the fake's URLs are
  // deliberately unroutable. The store binding — the thing under test —
  // is asserted from the journal above.
});

test('an asset already marked private still refuses in public mode rather than reading it publicly', () => {
  // storage is a per-asset fact, not a global one. A record migrated to
  // storage:'private' has no blobUrl to fall back to, so a deployment
  // that flipped back to public mode must refuse it, not invent a
  // public read for it.
  const r = runScenario('public-mode');
  assert.equal(r.steps.openPrivateAsset.ok, false);
  assert.equal(r.steps.openPrivateAsset.error?.code, 'credential_unavailable');
});

/* ── 4. No public fallback after a private failure ──────────────────── */

test('a missing private asset throws and never retries against the public store', () => {
  const r = runScenario('private-ok');
  assert.equal(r.steps.openMissingPrivateAsset.ok, false);
  assert.equal(r.steps.openMissingPrivateAsset.error?.code, 'not_found');
  const assetReads = familyReviewOps(r).filter(
    (e) => e.op === 'get' && (e.pathname ?? '').startsWith('family-review/photos/'),
  );
  assert.ok(assetReads.length > 0);
  for (const e of assetReads) {
    assert.equal(e.storeId, DEST_STORE, 'asset BYTES must never be read from the ambient store');
    assert.equal(e.access, 'private');
  }
});

test('with legacy public reads off, private mode touches the ambient store zero times', () => {
  const r = runScenario('private-read-miss-legacy-off');
  for (const e of familyReviewOps(r)) {
    assert.equal(
      e.storeId,
      DEST_STORE,
      `FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS=0 must make the lane private-only, but ${e.op} ${e.pathname} hit ${e.storeId}`,
    );
  }
  assert.equal(r.steps.readMissingRecord.value, null, 'a missing record stays missing; it is not resolved publicly');
});

test('with legacy public reads on, the ONE remaining public touch is a record-JSON read that carries no token', () => {
  // This is the pre-migration compatibility path (rollout doc §9): a
  // private-mode deployment must still be able to read records written
  // before the migration. It applies to record JSON only — asset bytes
  // never fall back — it is gated by
  // FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS, and the operator
  // closes it by setting that flag off once migration reports zero
  // failures. It must never carry the private credential.
  const r = runScenario('private-ok');
  const publicTouches = familyReviewOps(r).filter((e) => e.storeId !== DEST_STORE);
  for (const e of publicTouches) {
    assert.equal(e.op, 'get', 'only a read may fall back');
    assert.equal(e.access, 'public');
    assert.equal(e.hasExplicitToken, false, 'the legacy public attempt must never carry the private token');
    assert.match(
      e.pathname ?? '',
      /^family-review\/(submissions|review-tokens)\/[^/]+\.json$/,
      'only record/index JSON may take the legacy path — never asset bytes',
    );
  }
});

/* ── 5. No credential value escapes ─────────────────────────────────── */

test('no token value appears in any journal entry, log line, error, or payload', () => {
  for (const scenario of [
    'private-ok',
    'private-missing-token',
    'private-malformed-token',
    'public-mode',
    'private-read-miss-legacy-off',
  ]) {
    const r = runScenario(scenario);
    for (const token of FAKE_TOKENS) {
      assert.ok(
        !r.raw.includes(token),
        `${scenario}: a credential value reached stdout/stderr — the whole child transcript is checked, so this covers logs, thrown messages, and the serialized journal`,
      );
    }
    assert.ok(
      !r.raw.includes('vercel_blob_rw_'),
      `${scenario}: nothing token-shaped may appear in operator-visible output`,
    );
  }
});
