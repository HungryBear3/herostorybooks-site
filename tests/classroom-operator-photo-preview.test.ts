// SYNTHETIC: fake private bytes for one class, one foreign cohort and one pilot.
// Real routes, admission, roster, store and retention over the in-memory blob
// transport. Run with --experimental-test-module-mocks. No provider, no network.
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_KEY = 'synthetic-photo-preview-admin-key-0001';
const TOKEN = 'vercel_blob_rw_classroomphotosynthetic_localonly';
const DAY = 86400000;
const FUTURE = new Date(Date.now() + 30 * DAY).toISOString();
const PAST = new Date(Date.now() - DAY).toISOString();
const COHORT = 'photo_cohort';
const OTHER_COHORT = 'photo_other_cohort';
const PILOT_COHORT = 'photo_pilot_cohort';
const SUBJECT = 'synthetic-photo-subject';
const LEGACY_A = { token: 'SyntheticPhotoLegacyToken00000000001', cohortId: COHORT, familySlotId: 'family_alpha', cohortLabel: 'Synthetic class', expiresAt: FUTURE };
const OTHER_C = { token: 'SyntheticPhotoOtherToken000000000001', cohortId: OTHER_COHORT, familySlotId: 'family_charlie', cohortLabel: 'Synthetic other', expiresAt: FUTURE };
const PILOT_P = { token: 'SyntheticPhotoPilotToken000000000001', cohortId: PILOT_COHORT, familySlotId: 'family_pilot', cohortLabel: 'Synthetic pilot', expiresAt: FUTURE, purpose: 'pilot_test_only' };
const SELECTOR = { token: 'SyntheticPhotoSelectorToken000000001', cohortId: COHORT, cohortLabel: 'Synthetic class', expiresAt: FUTURE };

const INVITES = [LEGACY_A, OTHER_C, PILOT_P];
process.env.HSB_ORDER_ADMIN_KEY = ADMIN_KEY;
process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = TOKEN;
process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify(INVITES);
process.env.HSB_CLASSROOM_CODES_JSON = JSON.stringify([SELECTOR]);
process.env.HSB_ORDER_STORE_DIR = path.join(tmpdir(), 'hsb-classroom-photo-unused');
process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_classroom_photo_only';
for (const name of ['BLOB_READ_WRITE_TOKEN', 'FAMILY_REVIEW_DEST_BLOB_TOKEN', 'VERCEL', 'VERCEL_ENV', 'GROUP_BOOK_INTAKE_ENABLED', 'HSB_CLASSROOM_AUTH_ENABLED', 'HSB_CLASSROOM_ORDER_INPUT_JSON']) delete process.env[name];
let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls += 1; throw new TypeError('synthetic_network_denied'); }) as typeof fetch;

const NEXT_HEADERS = new URL('./helpers/group-book-next-headers.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier === 'next/headers') return { url: NEXT_HEADERS, shortCircuit: true };
    if (specifier.startsWith('@/')) {
      const base = path.resolve(ROOT, 'src', specifier.slice(2));
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const blob = await import(new URL('./helpers/group-book-blob-faults.mjs', import.meta.url).href);
const storeFake = await import(new URL('./helpers/blob-store-fake.mjs', import.meta.url).href);
// Runs once, immediately after a photo object read: a mid-request state change.
let afterPhotoRead: (() => Promise<void>) | null = null;
mock.module('@vercel/blob', { namedExports: {
  ...blob,
  get: async (pathname: string, options: unknown) => {
    const result = await blob.get(pathname, options);
    if (afterPhotoRead && pathname.startsWith('group-book/photos/')) {
      const hook = afterPhotoRead;
      afterPhotoRead = null;
      await hook();
    }
    return result;
  },
  head: storeFake.head,
  BlobError: storeFake.BlobError,
  BlobNotFoundError: storeFake.BlobNotFoundError,
  BlobPreconditionFailedError: storeFake.BlobPreconditionFailedError,
  BlobStoreNotFoundError: class BlobStoreNotFoundError extends Error {},
} });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store: any = await import('../src/lib/group-book/store.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const release: any = await import('../src/lib/group-book/release.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const identity: any = await import('../src/lib/group-book/identity-access.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pilotRetention: any = await import('../src/lib/group-book/pilot-retention.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const retention: any = await import('../src/lib/group-book/retention.ts');
const { CLASSROOM_AUTH_COOKIE, CLASSROOM_AUTH_URL } = await import('../src/lib/group-book/managed-auth.ts');
const { GET: reviewGet } = await import('../src/app/api/admin/group-book/review/route.ts');
const photoRoute = await import('../src/app/api/admin/group-book/photo/route.ts');
const { middleware } = await import('../middleware.ts');

const SLOT_B = identity.classroomEnrollmentIdentity(COHORT, CLASSROOM_AUTH_URL, SUBJECT);
const MANAGED_B = { ...SELECTOR, familySlotId: SLOT_B, owner: { issuer: CLASSROOM_AUTH_URL, subject: SUBJECT } };
const policy = release.groupBookPolicyState();
assert.equal(policy.state, 'adopted');
const OPERATOR = { 'x-hsb-order-admin-key': ADMIN_KEY };
const BASE = 'https://synthetic.invalid';
const PHOTO_URL = `${BASE}/api/admin/group-book/photo`;

const fakeJpeg = (name: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`SYNTHETIC-PRIVATE-BYTES-${name}`), Buffer.from([0xff, 0xd9])]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function submit(invite: any, name: string, overrides: Record<string, unknown> = {}, pilot: unknown = null) {
  const bytes = fakeJpeg(name);
  const assetId = `gbp_synthetic${name}`;
  const photo = { assetId, pathname: store.groupBookPhotoPath(invite, assetId, 'jpg'), mime: 'image/jpeg', size: bytes.length, uploadedAt: new Date().toISOString(), storage: 'private' as const, ...overrides };
  await blob.put(photo.pathname, bytes, { access: 'private', token: TOKEN, allowOverwrite: false });
  const record = store.buildGroupBookSubmission({
    invite, parentName: `SyntheticParent${name}`, parentEmail: `synthetic-${name}@example.invalid`, childFirstName: `SyntheticChild${name}`,
    ageRange: '5-6', characterNotes: `SyntheticNotes${name}`, photos: [photo], policy: { version: policy.current.record.version, digest: policy.current.digest }, pilot,
  });
  assert.equal(await store.createGroupBookSubmission(record), true);
  return { record, assetId, bytes, photoPath: photo.pathname as string };
}

async function seedClass() {
  await blob.reset();
  afterPhotoRead = null;
  await blob.put(identity.classroomEnrollmentPath(SLOT_B), JSON.stringify({ schemaVersion: 1, cohortId: COHORT, familySlotId: SLOT_B, owner: MANAGED_B.owner }), { access: 'private', token: TOKEN, allowOverwrite: false });
  const seeded = { a: await submit(LEGACY_A, 'Alpha'), b: await submit(MANAGED_B, 'Bravo'), c: await submit(OTHER_C, 'Charlie') };
  blob.journal.length = 0;
  return seeded;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queryOf = (target: any, cohortId = COHORT) => `?cohortId=${cohortId}&submissionId=${target.record.id}&assetId=${target.assetId}`;
const preview = (query: string, headers: Record<string, string> = OPERATOR): Promise<Response> => photoRoute.GET(new Request(`${PHOTO_URL}${query}`, { headers }));
const review = (cohortId: string): Promise<Response> => reviewGet(new Request(`${BASE}/api/admin/group-book/review?cohortId=${cohortId}`, { headers: OPERATOR }));
const photoReads = () => blob.journal.filter((entry: { op: string; pathname: string }) => entry.op === 'get' && entry.pathname.startsWith('group-book/photos/')).length;
const mutations = () => blob.journal.filter((entry: { op: string }) => entry.op === 'put' || entry.op === 'del').length;

async function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const prior = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await run();
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}

async function replaceObject(pathname: string, body: string) {
  await blob.del(pathname, { token: 'synthetic' });
  await blob.seed(pathname, body);
  blob.journal.length = 0;
}

function assertPrivateHeaders(response: Response) {
  assert.equal(response.headers.get('cache-control'), 'no-store, private');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(response.headers.get('set-cookie'), null);
}

/** Refusal: fixed body, private headers, and nothing internal in body or headers. */
async function assertRefused(response: Response, status: number, error: string, reads = 0) {
  assert.equal(response.status, status);
  assertPrivateHeaders(response);
  assert.equal(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const raw = await response.text();
  assert.deepEqual(JSON.parse(raw), { error });
  const exposed = raw + JSON.stringify([...response.headers]);
  for (const value of ['group-book/photos', 'vercel_blob', 'SYNTHETIC-PRIVATE', 'synthetic read transport', ADMIN_KEY, TOKEN]) assert.ok(!exposed.includes(value), `leaked ${value.slice(0, 18)}`);
  assert.equal(photoReads(), reads, 'photo object reads');
  assert.equal(mutations(), 0, 'no mutation');
}

const assertHeld = (response: Response, reads = 0) => assertRefused(response, 503, 'photo_held', reads);
const assertUnavailable = (response: Response, reads = 0) => assertRefused(response, 404, 'photo_unavailable', reads);

test('admin reads one eligible asset: exact private bytes, safe type and private headers, no side effects', async () => {
  const seeded = await seedClass();
  const before = blob.paths();
  const forbiddenLogs: unknown[] = [];
  const logged = mock.method(console, 'error', (...args: unknown[]) => { forbiddenLogs.push(...args); });
  try {
    for (const [target, headers] of [[seeded.a, OPERATOR], [seeded.b, { cookie: `hsb-ops-key=${ADMIN_KEY}` }]] as const) {
      const response = await preview(queryOf(target), headers);
      assert.equal(response.status, 200);
      assertPrivateHeaders(response);
      assert.equal(response.headers.get('content-type'), 'image/jpeg');
      assert.equal(response.headers.get('content-length'), String(target.bytes.length));
      assert.equal(response.headers.get('content-disposition'), 'inline; filename="classroom-photo.jpg"');
      assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'.*sandbox/);
      assert.ok(!JSON.stringify([...response.headers]).includes('group-book/photos'), 'no storage path in headers');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), target.bytes);
    }
  } finally {
    logged.mock.restore();
  }
  assert.deepEqual(forbiddenLogs, []);
  assert.equal(mutations(), 0);
  assert.deepEqual(blob.paths(), before);
  assert.equal(photoReads(), 2, 'exactly the one requested asset per request');
  assert.equal(photoRoute.dynamic, 'force-dynamic');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((photoRoute as Record<string, unknown>)[method], undefined, `${method} not exported`);
});

test('unauthenticated, guardian and wrong credentials get 401 before any store access', async () => {
  const seeded = await seedClass();
  const denied: Record<string, string>[] = [
    {},
    { cookie: `hsb_group_book_family_access=${LEGACY_A.token}; ${CLASSROOM_AUTH_COOKIE}=synthetic-guardian-session` },
    { 'x-hsb-order-admin-key': 'synthetic-wrong-key' },
    { cookie: 'hsb-ops-key=synthetic-wrong-key' },
    { cookie: `hsb-ops-key=${ADMIN_KEY}; hsb-ops-key=synthetic-wrong-key` },
  ];
  for (const headers of denied) {
    const response = await preview(queryOf(seeded.a), headers);
    assert.equal(response.status, 401);
    assertPrivateHeaders(response);
    assert.deepEqual(await response.json(), { error: 'Unauthorized' });
  }
  const unconfigured = await withEnv('HSB_ORDER_ADMIN_KEY', undefined, () => preview(queryOf(seeded.a)));
  assert.equal(unconfigured.status, 401);
  assert.equal(blob.journal.length, 0, 'no store call');
});

test('identifiers only: caller paths, URLs, extras and duplicates are refused before storage', async () => {
  const seeded = await seedClass();
  const good = { cohortId: COHORT, submissionId: seeded.a.record.id, assetId: seeded.a.assetId };
  const queries = [
    '',
    `?cohortId=${COHORT}&submissionId=${good.submissionId}`,
    `?${new URLSearchParams({ ...good, assetId: seeded.a.photoPath })}`,
    `?${new URLSearchParams({ ...good, assetId: '../../secrets' })}`,
    `?${new URLSearchParams({ ...good, submissionId: 'https://blob.invalid/x' })}`,
    `?${new URLSearchParams({ ...good, cohortId: '../photo_cohort' })}`,
    `?${new URLSearchParams({ ...good, pathname: seeded.a.photoPath })}`,
    `?${new URLSearchParams({ ...good, url: 'https://blob.invalid/x' })}`,
    `${queryOf(seeded.a)}&assetId=${seeded.a.assetId}`,
  ];
  for (const query of queries) await assertRefused(await preview(query), 400, 'invalid_request');
  assert.equal(blob.journal.length, 0, 'no store call');
  await assertUnavailable(await preview(queryOf(seeded.a, 'unconfigured_cohort')));
  assert.equal(blob.journal.length, 0, 'unknown cohort reads nothing');
});

test('wrong cohort, foreign submission, foreign asset and unknown asset never reach a photo object', async () => {
  const seeded = await seedClass();
  await assertUnavailable(await preview(queryOf(seeded.a, OTHER_COHORT)));
  await assertUnavailable(await preview(queryOf(seeded.c, COHORT)));
  await assertUnavailable(await preview(`?cohortId=${COHORT}&submissionId=${seeded.a.record.id}&assetId=${seeded.b.assetId}`));
  await assertUnavailable(await preview(`?cohortId=${COHORT}&submissionId=${seeded.a.record.id}&assetId=gbp_unknownasset`));
  await assertUnavailable(await preview(`?cohortId=${COHORT}&submissionId=gbs_unknownsubmission&assetId=${seeded.a.assetId}`));
});

test('withdrawal is refused on the next request for that family only, and is not a deletion', async () => {
  const seeded = await seedClass();
  await store.requestGroupBookWithdrawal(MANAGED_B);
  blob.journal.length = 0;
  await assertUnavailable(await preview(queryOf(seeded.b)));
  assert.equal((await preview(queryOf(seeded.a))).status, 200, 'other family unchanged');
  assert.ok(blob.paths().includes(seeded.b.photoPath), 'OMIT is not deletion');
});

test('withdrawal or release landing during the photo read returns no bytes', async () => {
  const seeded = await seedClass();
  afterPhotoRead = async () => { await store.requestGroupBookWithdrawal(LEGACY_A); blob.journal.length = 0; };
  await assertUnavailable(await preview(queryOf(seeded.a)));

  await seedClass();
  const reseeded = await store.findGroupBookSubmission(LEGACY_A);
  afterPhotoRead = async () => {
    await retention.recordGroupBookFinalRelease({ cohortId: COHORT, channel: 'printing', attribution: 'Synthetic', evidence: 'Synthetic', now: Date.now() });
    blob.journal.length = 0;
  };
  await assertUnavailable(await preview(`?cohortId=${COHORT}&submissionId=${reseeded.id}&assetId=${reseeded.photos[0].assetId}`));

  await seedClass();
  const unreadable = await store.findGroupBookSubmission(LEGACY_A);
  afterPhotoRead = async () => { Object.assign(blob.faults, { readPath: store.groupBookWithdrawalPath(LEGACY_A), readKind: 'throw' }); };
  await assertHeld(await preview(`?cohortId=${COHORT}&submissionId=${unreadable.id}&assetId=${unreadable.photos[0].assetId}`), 1);
  Object.assign(blob.faults, { readPath: null, readKind: null });
});

test('revoked legacy and selector access hold the cohort; expired access ends that family', async () => {
  const seeded = await seedClass();
  const revokedLegacy = JSON.stringify(INVITES.map((row) => (row === LEGACY_A ? { ...row, revokedAt: PAST } : row)));
  await withEnv('GROUP_BOOK_INVITES_JSON', revokedLegacy, async () => {
    await assertHeld(await preview(queryOf(seeded.a)));
    await assertHeld(await preview(queryOf(seeded.b)), 0);
  });
  blob.journal.length = 0;
  await withEnv('HSB_CLASSROOM_CODES_JSON', JSON.stringify([{ ...SELECTOR, revokedAt: PAST }]), async () => {
    await assertHeld(await preview(queryOf(seeded.b)));
  });
  blob.journal.length = 0;
  const expiredLegacy = JSON.stringify(INVITES.map((row) => (row === LEGACY_A ? { ...row, expiresAt: PAST } : row)));
  await withEnv('GROUP_BOOK_INVITES_JSON', expiredLegacy, async () => {
    await assertUnavailable(await preview(queryOf(seeded.a)));
    assert.equal((await preview(queryOf(seeded.b))).status, 200, 'unexpired family unchanged');
    const page = await (await review(COHORT)).text();
    assert.ok(!page.includes(seeded.a.assetId), 'no preview link for expired access');
    assert.ok(page.includes(seeded.b.assetId));
  });
  blob.journal.length = 0;
  await withEnv('HSB_CLASSROOM_CODES_JSON', JSON.stringify([{ ...SELECTOR, expiresAt: PAST }]), async () => {
    await assertUnavailable(await preview(queryOf(seeded.b)));
  });
});

test('durable purpose must be registered and agree with configuration and the record stamp', async () => {
  const seeded = await seedClass();
  const purposePath = pilotRetention.groupBookCohortPurposePath(COHORT);
  const durable = await blob.bytes(purposePath);

  const pilotConfig = JSON.stringify(INVITES.map((row) => (row === LEGACY_A ? { ...row, purpose: 'pilot_test_only' } : row)));
  await withEnv('GROUP_BOOK_INVITES_JSON', pilotConfig, () => withEnv('HSB_CLASSROOM_CODES_JSON', JSON.stringify([{ ...SELECTOR, purpose: 'pilot_test_only' }]), async () => {
    await assertHeld(await preview(queryOf(seeded.a)));
  }));

  blob.journal.length = 0;
  await blob.del(purposePath, { token: 'synthetic' });
  blob.journal.length = 0;
  await assertHeld(await preview(queryOf(seeded.a)));
  assert.ok(!(await (await review(COHORT)).text()).includes(seeded.a.assetId), 'no link without a durable purpose');
  blob.journal.length = 0;

  await blob.seed(purposePath, '{bad-json');
  blob.journal.length = 0;
  await assertHeld(await preview(queryOf(seeded.a)));
  await replaceObject(purposePath, durable.toString('utf8'));

  // A test-only stamp on a real finished-book record is never reinterpreted.
  const stamped = await store.findGroupBookSubmission(LEGACY_A);
  await replaceObject(store.groupBookRecordPath(LEGACY_A), JSON.stringify({ ...stamped, pilot: { purpose: 'pilot_test_only', registrationId: 'gbreg_syntheticforeign1' } }));
  await assertUnavailable(await preview(queryOf(seeded.a)));
});

test('consent outside the adopted policy, or a corrupt record, holds the cohort', async () => {
  const seeded = await seedClass();
  const recordPath = store.groupBookRecordPath(LEGACY_A);
  const stored = await store.findGroupBookSubmission(LEGACY_A);
  await replaceObject(recordPath, JSON.stringify({ ...stored, consent: { ...stored.consent, policy: { version: stored.consent.policy.version, digest: 'a'.repeat(64) } } }));
  await assertHeld(await preview(queryOf(seeded.a)));
  await assertHeld(await preview(queryOf(seeded.b)));
  const { policy: _policy, actor: _actor, ...legacyConsent } = stored.consent;
  await replaceObject(recordPath, JSON.stringify({ ...stored, schemaVersion: 1, consent: { ...legacyConsent, version: 'group-book-v1' } }));
  await assertHeld(await preview(queryOf(seeded.a)));
  await replaceObject(recordPath, '{bad-json');
  await assertHeld(await preview(queryOf(seeded.a)));
});

test('fullbook retention: released holds, past 90 days after delivery is refused, unreadable anchor holds', async () => {
  const seeded = await seedClass();
  const releasedAt = new Date(Date.now() - 100 * DAY).toISOString();
  await blob.seed(retention.groupBookReleasePath(COHORT), JSON.stringify({
    schemaVersion: 1, cohortId: COHORT, channel: 'printing', releasedAt, recordedAt: releasedAt, recordedVia: 'shared_admin_session', attributionUnverified: 'Synthetic', evidence: 'Synthetic',
  }));
  blob.journal.length = 0;
  await assertHeld(await preview(queryOf(seeded.a)));
  assert.ok(!(await (await review(COHORT)).text()).includes(seeded.a.assetId), 'no link after release');
  blob.journal.length = 0;

  const deliveredAt = new Date(Date.now() - 91 * DAY).toISOString();
  const delivery = { schemaVersion: 1, cohortId: COHORT, recordedVia: 'shared_admin_session', recordedBy: 'Synthetic', evidence: 'Synthetic', retentionDays: 90 };
  await blob.seed(retention.groupBookDeliveryPath(COHORT), JSON.stringify({ ...delivery, deliveredAt, recordedAt: deliveredAt, dueAt: new Date(Date.parse(deliveredAt) + 90 * DAY).toISOString() }));
  blob.journal.length = 0;
  await assertUnavailable(await preview(queryOf(seeded.a)));
  assert.ok(blob.paths().includes(seeded.a.photoPath), 'refusal is not deletion');

  // Inside the 90 days the object is retained, but released editions stay held.
  const recent = new Date(Date.now() - DAY).toISOString();
  await replaceObject(retention.groupBookDeliveryPath(COHORT), JSON.stringify({ ...delivery, deliveredAt: recent, recordedAt: recent, dueAt: new Date(Date.parse(recent) + 90 * DAY).toISOString() }));
  await assertHeld(await preview(queryOf(seeded.a)));

  await replaceObject(retention.groupBookDeliveryPath(COHORT), '{bad-json');
  await assertHeld(await preview(queryOf(seeded.a)));
});

test('pilot_test_only previews only its stamped photos, and closing refuses them', async () => {
  await seedClass();
  const binding = await pilotRetention.bindGroupBookCohortPurpose(PILOT_P, Date.now());
  assert.equal(binding.record.purpose, 'pilot_test_only');
  const pilot = await submit(PILOT_P, 'Pilot', {}, { purpose: 'pilot_test_only', registrationId: binding.record.registrationId });
  blob.journal.length = 0;
  assert.equal((await preview(queryOf(pilot, PILOT_COHORT))).status, 200);

  blob.journal.length = 0;
  const closed = await pilotRetention.recordGroupBookPilotClose({ cohortId: PILOT_COHORT, mode: 'test_only', recordedBy: 'Synthetic', evidence: 'Synthetic close', now: Date.now() });
  assert.equal(closed.outcome, 'recorded');
  blob.journal.length = 0;
  await assertUnavailable(await preview(queryOf(pilot, PILOT_COHORT)));
});

test('uncertain store reads hold without exception text, before or at the photo object', async () => {
  const seeded = await seedClass();
  const metadata = [store.groupBookWithdrawalPath(LEGACY_A), store.groupBookRecordPath(LEGACY_A), identity.classroomEnrollmentPath(SLOT_B), pilotRetention.groupBookPilotClosePath(COHORT), retention.groupBookDeliveryPath(COHORT), pilotRetention.groupBookCohortPurposePath(COHORT)];
  const logged = mock.method(console, 'error', () => {});
  try {
    for (const readPath of metadata) {
      for (const readKind of ['throw', '503']) {
        Object.assign(blob.faults, { readPath, readKind });
        blob.journal.length = 0;
        await assertHeld(await preview(queryOf(seeded.a)));
      }
    }
    Object.assign(blob.faults, { readPath: null, readKind: null });
    blob.faults.listLoop = true;
    blob.journal.length = 0;
    await assertHeld(await preview(queryOf(seeded.a)));
    blob.faults.listLoop = false;

    for (const readKind of ['throw', '503', 'no-stream']) {
      Object.assign(blob.faults, { readPath: seeded.a.photoPath, readKind });
      blob.journal.length = 0;
      await assertHeld(await preview(queryOf(seeded.a)), 1);
    }
    Object.assign(blob.faults, { readPath: null, readKind: null });
    for (const args of logged.mock.calls.flatMap((call) => call.arguments)) {
      assert.ok(!String(args).includes('group-book/') && !String(args).includes('synthetic read transport'), 'logs carry no path or exception text');
    }
  } finally {
    logged.mock.restore();
  }
});

test('malformed configuration and unavailable storage hold without reads', async () => {
  const seeded = await seedClass();
  await assertHeld(await withEnv('GROUP_BOOK_INVITES_JSON', '{bad-json', () => preview(queryOf(seeded.a))));
  await assertHeld(await withEnv('HSB_CLASSROOM_CODES_JSON', '{bad-json', () => preview(queryOf(seeded.a))));
  await assertHeld(await withEnv('GROUP_BOOK_BLOB_READ_WRITE_TOKEN', undefined, () => preview(queryOf(seeded.a))));
  assert.equal(blob.journal.length, 0);
});

test('stored object or metadata that is not a safe, exact JPEG is refused', async () => {
  const seeded = await seedClass();
  // Object replaced behind the record: type sniff and exact size both fail.
  await replaceObject(seeded.a.photoPath, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  await assertHeld(await preview(queryOf(seeded.a)), 1);
  // Exact recorded size, wrong type: only the byte sniff can refuse this one.
  await replaceObject(seeded.a.photoPath, 'x'.repeat(seeded.a.bytes.length));
  await assertHeld(await preview(queryOf(seeded.a)), 1);
  await blob.del(seeded.a.photoPath, { token: 'synthetic' });
  await blob.put(seeded.a.photoPath, Buffer.concat([seeded.a.bytes, Buffer.from('trailing')]), { access: 'private', token: TOKEN, allowOverwrite: false });
  blob.journal.length = 0;
  await assertHeld(await preview(queryOf(seeded.a)), 1);
  await blob.del(seeded.a.photoPath, { token: 'synthetic' });
  blob.journal.length = 0;
  await assertUnavailable(await preview(queryOf(seeded.a)), 1);

  const fresh = await seedClass();
  const stored = await store.findGroupBookSubmission(LEGACY_A);
  const [photo] = stored.photos;
  const twin = { ...photo, pathname: `group-book/photos/${stored.familyStorageKey}/nested/${photo.assetId}.jpg` };
  const records: unknown[] = [
    { ...stored, photos: [{ ...photo, mime: 'image/svg+xml' }] },
    { ...stored, photos: [{ ...photo, size: 4_000_001 }] },
    { ...stored, photos: [{ ...photo, pathname: `group-book/photos/${stored.familyStorageKey}/${photo.assetId}.png` }] },
    { ...stored, photos: [twin, photo] },
  ];
  for (const record of records) {
    await replaceObject(store.groupBookRecordPath(LEGACY_A), JSON.stringify(record));
    await assertUnavailable(await preview(queryOf(fresh.a)));
    assert.ok(!(await (await review(COHORT)).text()).includes(photo.assetId), 'no link for an unsafe asset');
    blob.journal.length = 0;
  }
});

test('review page links only proven eligible assets and reads no photo object', async () => {
  const seeded = await seedClass();
  await store.requestGroupBookWithdrawal(MANAGED_B);
  blob.journal.length = 0;
  const body = await (await review(COHORT)).text();
  assert.equal(photoReads(), 0);
  const href = `/api/admin/group-book/photo?cohortId=${COHORT}&amp;submissionId=${seeded.a.record.id}&amp;assetId=${seeded.a.assetId}`;
  assert.ok(body.includes(`<a href="${href}" target="_blank" rel="noopener noreferrer">Preview 1</a>`));
  assert.ok(!body.includes(seeded.b.assetId), 'withdrawn family has no link');
  assert.ok(!body.includes(seeded.c.assetId), 'foreign family has no link');
  assert.ok(!body.includes('group-book/photos'), 'no storage path');
  assert.equal(body.split('group-book/photo?').length - 1, 1, 'one link per eligible asset');

  // The link the page rendered is the link the route serves.
  const response = await preview(href.slice(href.indexOf('?')).replaceAll('&amp;', '&'));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), seeded.a.bytes);
});

test('uncertain roster shows no preview link; export and order stay on hold', async () => {
  const seeded = await seedClass();
  Object.assign(blob.faults, { readPath: store.groupBookRecordPath(LEGACY_A), readKind: 'throw' });
  const held = await (await review(COHORT)).text();
  Object.assign(blob.faults, { readPath: null, readKind: null });
  assert.doesNotMatch(held, /group-book\/photo\?/);
  assert.ok(!held.includes(seeded.b.assetId));

  const { POST: adminExport } = await import('../src/app/api/admin/group-book/export/route.ts');
  const exported = await adminExport(new Request(`${BASE}/api/admin/group-book/export`, {
    method: 'POST', headers: { ...OPERATOR, 'content-type': 'application/json' }, body: JSON.stringify({ cohortId: COHORT }),
  }));
  const body = await exported.json();
  assert.equal(exported.status, 503);
  assert.equal(body.hold, 'GROUP_BOOK_EXPORT_HOLD');
  assert.ok(!JSON.stringify(body).includes('gbp_'), 'export projection gains no asset identifier');
  const { POST: adminOrder } = await import('../src/app/api/admin/group-book/order/route.ts');
  const ordered = await adminOrder(new Request(`${BASE}/api/admin/group-book/order`, { method: 'POST', headers: OPERATOR }));
  assert.equal(ordered.status, 503);
});

test('Preview classroom-QA containment refuses the route before it dispatches', async () => {
  const seeded = await seedClass();
  const { NextRequest } = await import('next/server');
  const response = await withEnv('HSB_CLASSROOM_QA_ONLY', 'true', () => withEnv('VERCEL_ENV', 'preview', async () =>
    middleware(new NextRequest(`${PHOTO_URL}${queryOf(seeded.a)}`, { headers: OPERATOR }))));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'preview_classroom_qa_only' });
  assert.equal(blob.journal.length, 0);
});

test('no network was attempted', () => {
  assert.equal(networkCalls, 0);
});
