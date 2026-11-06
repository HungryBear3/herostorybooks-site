// SYNTHETIC: one class, two families (legacy + managed) plus one foreign cohort.
// Real route, admission, roster and store over the in-memory blob transport.
// Run with --experimental-test-module-mocks. No provider, no network.
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVIEW_ROUTE = new URL('../src/app/api/admin/group-book/review/route.ts', import.meta.url);
const ADMIN_KEY = 'synthetic-classroom-review-admin-key-0001';
const TOKEN = 'vercel_blob_rw_classroomreviewsynthetic_localonly';
const FUTURE = new Date(Date.now() + 30 * 86400000).toISOString();
const COHORT = 'review_cohort';
const OTHER_COHORT = 'other_cohort';
const SUBJECT = 'synthetic-review-subject';
const LEGACY_A = { token: 'SyntheticReviewLegacyToken0000000001', cohortId: COHORT, familySlotId: 'family_alpha', cohortLabel: 'Synthetic class', expiresAt: FUTURE };
const OTHER_C = { token: 'SyntheticReviewOtherToken00000000001', cohortId: OTHER_COHORT, familySlotId: 'family_charlie', cohortLabel: 'Synthetic other', expiresAt: FUTURE };
const SELECTOR = { token: 'SyntheticReviewSelectorToken000000001', cohortId: COHORT, cohortLabel: 'Synthetic class', expiresAt: FUTURE };

process.env.HSB_ORDER_ADMIN_KEY = ADMIN_KEY;
process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = TOKEN;
process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([LEGACY_A, OTHER_C]);
process.env.HSB_CLASSROOM_CODES_JSON = JSON.stringify([SELECTOR]);
process.env.HSB_ORDER_STORE_DIR = path.join(tmpdir(), 'hsb-classroom-review-unused');
process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_classroom_review_only';
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
mock.module('@vercel/blob', { namedExports: {
  ...blob,
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
const retention: any = await import('../src/lib/group-book/pilot-retention.ts');
const { familyStorageKey } = await import('../src/lib/group-book/config.ts');
const { CLASSROOM_AUTH_COOKIE, CLASSROOM_AUTH_URL } = await import('../src/lib/group-book/managed-auth.ts');
const { POST: adminExport } = await import('../src/app/api/admin/group-book/export/route.ts');
const { POST: intake } = await import('../src/app/api/group-book/intake/route.ts');
const { CLASSROOM_HTML } = await import('../src/app/classroom/classroom-html.ts');

const SLOT_B = identity.classroomEnrollmentIdentity(COHORT, CLASSROOM_AUTH_URL, SUBJECT);
const MANAGED_B = { ...SELECTOR, familySlotId: SLOT_B, owner: { issuer: CLASSROOM_AUTH_URL, subject: SUBJECT } };
const policy = release.groupBookPolicyState();
assert.equal(policy.state, 'adopted');
const OPERATOR = { 'x-hsb-order-admin-key': ADMIN_KEY };
const REVIEW_URL = 'https://synthetic.invalid/api/admin/group-book/review';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function route(): Promise<any> {
  assert.ok(existsSync(REVIEW_ROUTE), 'operator review route must exist');
  return import(REVIEW_ROUTE.href);
}
const review = async (query: string, headers: Record<string, string> = OPERATOR): Promise<Response> =>
  (await route()).GET(new Request(`${REVIEW_URL}${query}`, { headers }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function submit(invite: any, name: string) {
  const photo = { assetId: 'gbp_synthetic1', pathname: store.groupBookPhotoPath(invite, 'gbp_synthetic1', 'jpg'), mime: 'image/jpeg', size: 4, uploadedAt: new Date().toISOString(), storage: 'private' as const };
  await blob.put(photo.pathname, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { access: 'private', token: TOKEN, allowOverwrite: false });
  const record = store.buildGroupBookSubmission({
    invite, parentName: `SyntheticParent${name}`, parentEmail: `synthetic-${name}@example.invalid`, childFirstName: `SyntheticChild${name}`,
    ageRange: '5-6', characterNotes: `SyntheticNotes${name}`, photos: [photo], policy: { version: policy.current.record.version, digest: policy.current.digest },
  });
  assert.equal(await store.createGroupBookSubmission(record), true);
  return { record, photoPath: photo.pathname as string };
}

async function seedClass() {
  await blob.reset();
  await blob.put(identity.classroomEnrollmentPath(SLOT_B), JSON.stringify({ schemaVersion: 1, cohortId: COHORT, familySlotId: SLOT_B, owner: MANAGED_B.owner }), { access: 'private', token: TOKEN, allowOverwrite: false });
  const seeded = { a: await submit(LEGACY_A, 'Alpha'), b: await submit(MANAGED_B, 'Bravo'), c: await submit(OTHER_C, 'Charlie') };
  blob.journal.length = 0;
  return seeded;
}

async function replaceObject(pathname: string, body: string) {
  await blob.del(pathname, { token: 'synthetic' });
  await blob.seed(pathname, body);
  blob.journal.length = 0;
}

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

const mutations = () => blob.journal.filter((entry: { op: string }) => entry.op === 'put' || entry.op === 'del').length;
const photoReads = () => blob.journal.filter((entry: { op: string; pathname: string }) => entry.op === 'get' && entry.pathname.startsWith('group-book/photos/')).length;
const rowOf = (body: string, slot: string) => body.split('<tr>').find((row) => row.includes(slot)) ?? '';

// The only asset identifier a page may carry is an operator preview link.
const PREVIEW_LINK = /<a href="\/api\/admin\/group-book\/photo\?cohortId=[A-Za-z0-9_-]+&amp;submissionId=gbs_[A-Za-z0-9_-]+&amp;assetId=gbp_[A-Za-z0-9_-]+" target="_blank" rel="noopener noreferrer">Preview \d+<\/a>/g;

function assertNoPrivateFields(rendered: string) {
  const body = rendered.replace(PREVIEW_LINK, '');
  const forbidden = [
    ...['Alpha', 'Bravo', 'Charlie'].flatMap((name) => [`SyntheticParent${name}`, `SyntheticChild${name}`, `SyntheticNotes${name}`]),
    '@example.invalid', LEGACY_A.token, OTHER_C.token, SELECTOR.token, ADMIN_KEY, TOKEN, SUBJECT, CLASSROOM_AUTH_URL,
    familyStorageKey(LEGACY_A), familyStorageKey(MANAGED_B), policy.current.digest, 'gbp_', 'vercel_blob', 'https://',
    'group-book/photos', 'group-book/families', 'group-book/enrollments', 'group-book/withdrawals', 'group-book/purposes',
  ];
  for (const value of forbidden) assert.ok(!body.includes(value), `leaked ${value.slice(0, 18)}`);
}

async function assertHeld(response: Response, status = 503): Promise<string> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store, private');
  const body = await response.text();
  assert.match(body, /REVIEW HELD/);
  assert.doesNotMatch(body, /synthetic read transport outage|GroupBookStoreReadError|bad-json/);
  assertNoPrivateFields(body);
  assert.equal(mutations(), 0, 'no mutation');
  assert.equal(photoReads(), 0, 'no photo read');
  return body;
}

test('operator sees metadata and eligibility with photosHeld, private headers and no side effects', async () => {
  const seeded = await seedClass();
  const before = blob.paths();
  for (const headers of [OPERATOR, { cookie: `hsb-ops-key=${ADMIN_KEY}` }]) {
    const response = await review(`?cohortId=${COHORT}`, headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store, private');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'.*frame-ancestors 'none'/);
    assert.equal(response.headers.get('set-cookie'), null);
    const body = await response.text();
    assert.match(body, /data-photos-held="true">photosHeld: true/);
    for (const [slot, submission] of [[LEGACY_A.familySlotId, seeded.a.record.id], [SLOT_B, seeded.b.record.id]]) {
      const row = rowOf(body, slot);
      assert.match(row, /ELIGIBLE/);
      assert.ok(row.includes(submission), 'submission id shown');
      assert.match(row, /photosHeld: 1/);
    }
    assertNoPrivateFields(body);
  }
  assert.equal(mutations(), 0);
  assert.equal(photoReads(), 0);
  assert.deepEqual(blob.paths(), before);
  const module = await route();
  assert.equal(module.dynamic, 'force-dynamic');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(module[method], undefined, `${method} not exported`);
});

test('unauthenticated, guardian and wrong credentials get 401 before any store access', async () => {
  await seedClass();
  const denied: Record<string, string>[] = [
    {},
    { cookie: `hsb_group_book_family_access=${LEGACY_A.token}; ${CLASSROOM_AUTH_COOKIE}=synthetic-guardian-session` },
    { 'x-hsb-order-admin-key': 'synthetic-wrong-key' },
    { cookie: 'hsb-ops-key=synthetic-wrong-key' },
    { cookie: `hsb-ops-key=${ADMIN_KEY}; hsb-ops-key=synthetic-wrong-key` },
  ];
  for (const headers of denied) {
    const response = await review(`?cohortId=${COHORT}`, headers);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store, private');
    assert.deepEqual(await response.json(), { error: 'Unauthorized' });
  }
  const unconfigured = await withEnv('HSB_ORDER_ADMIN_KEY', undefined, () => review(`?cohortId=${COHORT}`));
  assert.equal(unconfigured.status, 401);
  assert.equal(blob.journal.length, 0, 'no store call');
});

test('cohort form is served to an operator without store reads or tokens', async () => {
  await seedClass();
  const response = await review('');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /<form method="get" action="\/api\/admin\/group-book\/review">/);
  assert.ok(body.includes(`<option value="${COHORT}"></option>`));
  assert.ok(body.includes(`<option value="${OTHER_COHORT}"></option>`));
  assert.ok(body.includes('href="/group-book/sign-in"'));
  assertNoPrivateFields(body);
  assert.equal(blob.journal.length, 0);
});

test('malformed cohort is refused without echo; unknown cohort is 404 without reads', async () => {
  await seedClass();
  for (const query of ['?cohortId=', '?cohortId=ab', `?cohortId=${encodeURIComponent('<script>alert(1)</script>')}`, `?cohortId=${encodeURIComponent('../secrets')}`, `?cohortId=${COHORT}&cohortId=${OTHER_COHORT}`]) {
    const body = await assertHeld(await review(query), 400);
    assert.doesNotMatch(body, /<script|alert\(1\)|\.\.\/secrets/);
  }
  const unknown = await assertHeld(await review('?cohortId=unconfigured_cohort'), 404);
  assert.ok(!unknown.includes('unconfigured_cohort'), 'unknown cohort is not echoed');
  assert.equal(blob.journal.length, 0);
});

test('a cohort only ever shows its own families', async () => {
  const seeded = await seedClass();
  const own = await (await review(`?cohortId=${COHORT}`)).text();
  assert.ok(!own.includes(OTHER_C.familySlotId) && !own.includes(seeded.c.record.id));
  const other = await review(`?cohortId=${OTHER_COHORT}`);
  assert.equal(other.status, 200);
  const body = await other.text();
  assert.ok(rowOf(body, OTHER_C.familySlotId).includes(seeded.c.record.id));
  for (const value of [LEGACY_A.familySlotId, SLOT_B, seeded.a.record.id, seeded.b.record.id]) assert.ok(!body.includes(value));
});

test('withdrawing B shows OMIT, leaves A unchanged, and neither reads nor deletes B photos', async () => {
  const seeded = await seedClass();
  const before = await (await review(`?cohortId=${COHORT}`)).text();
  await store.requestGroupBookWithdrawal(MANAGED_B);
  blob.journal.length = 0;
  const stored = blob.paths();
  const response = await review(`?cohortId=${COHORT}`);
  assert.equal(response.status, 200, 'withdrawal is a settled exclusion');
  const body = await response.text();
  assert.equal(rowOf(body, LEGACY_A.familySlotId), rowOf(before, LEGACY_A.familySlotId), 'A unchanged');
  const omitted = rowOf(body, SLOT_B);
  assert.match(omitted, /OMIT/);
  assert.match(omitted, /Not a deletion record/);
  assert.doesNotMatch(omitted, /ELIGIBLE|photosHeld/);
  assert.ok(!body.includes(seeded.b.record.id), 'withdrawn submission id hidden');
  assertNoPrivateFields(body);
  assert.equal(photoReads(), 0);
  assert.equal(mutations(), 0);
  assert.deepEqual(blob.paths(), stored, 'nothing deleted');
  assert.ok(stored.includes(seeded.b.photoPath), 'OMIT is not deletion');
});

test('unreadable records fail closed with no exception text or eligible family', async () => {
  const seeded = await seedClass();
  const cases: [string, string, RegExp][] = [
    [store.groupBookWithdrawalPath(LEGACY_A), 'throw', /HELD: record unreadable/],
    [store.groupBookWithdrawalPath(LEGACY_A), 'parse', /HELD: withdrawal unverified/],
    [store.groupBookRecordPath(LEGACY_A), 'throw', /uncertain or empty/],
    [store.groupBookRecordPath(LEGACY_A), '503', /uncertain or empty/],
    [identity.classroomEnrollmentPath(SLOT_B), 'throw', /uncertain or empty/],
  ];
  for (const [readPath, readKind, expected] of cases) {
    Object.assign(blob.faults, { readPath, readKind });
    const body = await assertHeld(await review(`?cohortId=${COHORT}`));
    assert.match(body, expected);
    assert.ok(!body.includes(seeded.a.record.id) && !body.includes(seeded.b.record.id), 'no submission admitted');
    assert.doesNotMatch(body, /ELIGIBLE/);
    Object.assign(blob.faults, { readPath: null, readKind: null });
    blob.journal.length = 0;
  }
  blob.faults.listLoop = true;
  await assertHeld(await review(`?cohortId=${COHORT}`));
});

test('malformed, unreadable or conflicting durable purpose and close state fail closed', async () => {
  const purposePath = retention.groupBookCohortPurposePath(COHORT);
  await seedClass();
  for (const readKind of ['parse', 'throw', '503']) {
    Object.assign(blob.faults, { readPath: purposePath, readKind });
    await assertHeld(await review(`?cohortId=${COHORT}`));
  }
  Object.assign(blob.faults, { readPath: null, readKind: null });
  blob.journal.length = 0;
  await replaceObject(purposePath, JSON.stringify({ schemaVersion: 1, kind: 'cohort_purpose', cohortId: COHORT, purpose: 'unexpected' }));
  await assertHeld(await review(`?cohortId=${COHORT}`));
  await replaceObject(purposePath, JSON.stringify({
    schemaVersion: 1, kind: 'cohort_purpose', cohortId: COHORT, purpose: 'pilot_test_only', registrationId: 'gbreg_syntheticreview1', familySlotIds: [],
    registeredAt: new Date().toISOString(), recordedVia: 'intake_first_writer', recordedBy: 'synthetic', evidence: 'synthetic',
  }));
  await assertHeld(await review(`?cohortId=${COHORT}`));

  await seedClass();
  await blob.seed(retention.groupBookPilotClosePath(COHORT), '{bad-json');
  blob.journal.length = 0;
  await assertHeld(await review(`?cohortId=${COHORT}`));
});

test('malformed configuration and unavailable storage fail closed without reads', async () => {
  await seedClass();
  const malformed = await withEnv('GROUP_BOOK_INVITES_JSON', '{bad-json', () => review(`?cohortId=${COHORT}`));
  await assertHeld(malformed);
  const selector = await withEnv('HSB_CLASSROOM_CODES_JSON', '{bad-json', () => review(`?cohortId=${COHORT}`));
  await assertHeld(selector);
  const storage = await withEnv('GROUP_BOOK_BLOB_READ_WRITE_TOKEN', undefined, () => review(`?cohortId=${COHORT}`));
  await assertHeld(storage);
  assert.equal(blob.journal.length, 0);
});

test('export and classroom order stay on their existing 503 holds', async () => {
  await seedClass();
  const exported = await adminExport(new Request('https://synthetic.invalid/api/admin/group-book/export', {
    method: 'POST', headers: { ...OPERATOR, 'content-type': 'application/json' }, body: JSON.stringify({ cohortId: COHORT }),
  }));
  const body = await exported.json();
  assert.equal(exported.status, 503);
  assert.equal(body.hold, 'GROUP_BOOK_EXPORT_HOLD');
  assert.equal(body.reason, 'no_group_book_artifact_producer');
  assert.equal(body.admission.state, 'ready');

  const { POST: adminOrder } = await import('../src/app/api/admin/group-book/order/route.ts');
  const ordered = await adminOrder(new Request('https://synthetic.invalid/api/admin/group-book/order', { method: 'POST', headers: OPERATOR }));
  assert.equal(ordered.status, 503);
  assert.deepEqual(await ordered.json(), { error: 'classroom_trusted_input_unavailable' });
  assert.equal(mutations(), 0);
  assert.equal(photoReads(), 0);
});

test('intake guards hold: admin credential is no invitation, closed release and foreign origin refuse', async () => {
  await blob.reset();
  const post = (form: FormData, headers: Record<string, string>) => intake(new Request('https://synthetic.invalid/api/group-book/intake', { method: 'POST', headers, body: form }));

  const noInvite = await post(new FormData(), OPERATOR);
  assert.equal(noInvite.status, 403);
  assert.deepEqual(await noInvite.json(), { ok: false, error: 'invalid_invite' });

  const form = new FormData();
  form.set('invite', LEGACY_A.token);
  const closed = await post(form, {});
  const refusal = await closed.json();
  assert.equal(closed.status, 403);
  assert.equal(refusal.ok, false);
  assert.notEqual(refusal.error, 'invalid_invite', 'valid invitation stopped by the closed release switch');

  const foreign = await post(form, { cookie: `${CLASSROOM_AUTH_COOKIE}=synthetic-session`, origin: 'https://foreign.invalid' });
  assert.equal(foreign.status, 403);
  assert.deepEqual(await foreign.json(), { ok: false, error: 'invalid_origin' });
  assert.equal(mutations(), 0);
  assert.equal(process.env.GROUP_BOOK_INTAKE_ENABLED, undefined);
});

test('classroom landing points invited families at sign-in and stays closed', () => {
  assert.equal(CLASSROOM_HTML.split('href="/group-book/sign-in"').length - 1, 1, 'one sign-in link');
  assert.match(CLASSROOM_HTML, /Room parents only pass along the private invitation/);
  assert.match(CLASSROOM_HTML, /nothing can be submitted until a project opens/);
  assert.ok(CLASSROOM_HTML.includes('<button type="button" disabled>Family submissions not open yet</button>'));
  assert.doesNotMatch(CLASSROOM_HTML, /<form\b|<input\b|Synthetic/);
});

test('no network was attempted', () => {
  assert.equal(networkCalls, 0);
});
