// Synthetic-only REVIEW-1 remediation scenario: durable cleanup roster, no
// intake after release/delivery/unknown, distinct first final-release record.
// Real routes/store/retention against the in-memory Blob fake. No network.
import assert from 'node:assert/strict';
import sharp from 'sharp';

const DAY = 24 * 60 * 60 * 1000;
const fixture = await import('./group-book-policy-fixture.mjs');
const A = { token: 'SyntheticV3AlphaToken0000000000001', cohortId: 'synthetic_cohort', familySlotId: 'synthetic_family_a', cohortLabel: 'Synthetic', expiresAt: fixture.SYNTHETIC_EXPIRES_AT };
const B = { ...A, token: 'SyntheticV3BravoToken0000000000002', familySlotId: 'synthetic_family_b' };
const C = { ...A, token: 'SyntheticV3CharlieToken00000000003', familySlotId: 'synthetic_family_c' };
const OTHER = { ...A, token: 'SyntheticV3OtherToken0000000000004', cohortId: 'other_cohort', familySlotId: 'synthetic_family_o' };
const ADMIN_KEY = 'synthetic-admin-key-not-a-secret';
const ALL = [A, B, C, OTHER];
process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_groupbookfixture_synthetic';
process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify(ALL);
process.env.HSB_ORDER_ADMIN_KEY = ADMIN_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.FAMILY_REVIEW_DEST_BLOB_TOKEN;

const blob = await import('./group-book-blob-faults.mjs');
const headers = await import('./group-book-next-headers.mjs');
const config = await import('../../src/lib/group-book/config.ts');
const session = await import('../../src/lib/group-book/session.ts');
const store = await import('../../src/lib/group-book/store.ts');
const retention = await import('../../src/lib/group-book/retention.ts');
const exporter = await import('../../src/lib/group-book/export.ts');
const handlers = await import('../../src/lib/group-book/admin-handlers.ts');
const { POST: intake } = await import('../../src/app/api/group-book/intake/route.ts');
const { POST: access } = await import('../../src/app/api/group-book/access/route.ts');
const { POST: familyWithdraw } = await import('../../src/app/group-book/family/withdraw/route.ts');
const { POST: releaseRoute } = await import('../../src/app/api/admin/group-book/final-release/route.ts');

type Invite = typeof A;
const jpeg = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#557799' } }).jpeg().toBuffer();
const RELEASED = '2026-05-20T12:00:00.000Z';
const DELIVERED = '2026-06-01T12:00:00.000Z';
const DUE = Date.parse(DELIVERED) + 90 * DAY;
// Successor I1: lifecycle times are the server recording time, so the handler
// clock IS the release/delivery time; caller times are refused.
const CLOCK = Date.parse(DELIVERED) + 1000;

function intakeRequest(invite: Invite): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries({
    invite: invite.token, parentName: 'P', parentEmail: 'p@example.invalid', childFirstName: 'C', ageRange: '5-6',
    guardianAuthority: 'true', sharedWithParticipatingFamilies: 'true', sourcePhotosRemainPrivate: 'true',
    schoolApprovalNotRepresentedOrImplied: 'true', policyVersion: fixture.SYNTHETIC_POLICY_STAMP.version, policyDigest: fixture.SYNTHETIC_POLICY_STAMP.digest,
  })) form.set(k, v);
  form.append('photos', new File([jpeg], 'x', { type: 'image/jpeg' }));
  return new Request('https://synthetic.invalid/api/group-book/intake', { method: 'POST', body: form });
}
const admin = (path: string, body: unknown, key: string | null = ADMIN_KEY) => new Request(`https://synthetic.invalid${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-hsb-order-admin-key': key } : {}) }, body: JSON.stringify(body),
});
const recordRelease = (extra: Record<string, unknown> = {}, now = Date.parse(RELEASED)) => handlers.finalReleaseResponse(admin('/api/admin/group-book/final-release', {
  cohortId: A.cohortId, channel: 'printing', attribution: 'Synthetic Operator', evidence: 'SYNTHETIC print handoff ref', ...extra,
}), now);
const recordDelivery = (extra: Record<string, unknown> = {}, now = Date.parse(DELIVERED)) => handlers.deliveryResponse(admin('/api/admin/group-book/delivery', {
  cohortId: A.cohortId, recordedBy: 'Synthetic Operator', evidence: 'SYNTHETIC carrier ref', ...extra,
}), now);
const cleanup = (now: number) => handlers.retentionCleanupResponse(admin('/api/admin/group-book/retention-cleanup', { cohortId: A.cohortId }), now);
const photosOf = (invite: Pick<Invite, 'cohortId' | 'familySlotId'>) => blob.paths().filter((p: string) => p.startsWith(`group-book/photos/${config.familyStorageKey(invite)}/`));
const puts = (part: string) => blob.journal.filter((e: { op: string; pathname: string }) => e.op === 'put' && e.pathname.includes(part)).length;

async function seed(invites: Invite[] = [A, B, OTHER]) {
  await blob.reset();
  headers.setCookieHeader('');
  process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify(ALL);
  process.env.GROUP_BOOK_INTAKE_ENABLED = 'true';
  for (const invite of invites) assert.equal((await intake(intakeRequest(invite))).status, 200);
  blob.journal.length = 0;
}
async function releaseAndDeliver() {
  assert.equal((await recordRelease()).status, 200);
  assert.equal((await recordDelivery()).status, 200);
}

const results: { name: string; ok: boolean; error?: string }[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) }); }
}

// 1. Durable cleanup roster -----------------------------------------------------
await step('cleanup purges a family whose invite slot was removed from config', async () => {
  await seed();
  await releaseAndDeliver();
  process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([B, OTHER]);
  const response = await cleanup(DUE);
  const body = await response.json();
  assert.equal(body.outcome, 'complete', JSON.stringify(body));
  assert.equal(photosOf(A).length, 0, 'removed slot photos verified absent');
  assert.equal(photosOf(B).length, 0);
  assert.ok(photosOf(OTHER).length > 0, 'other cohort untouched');
  assert.ok(body.families.some((f: { familySlotId: string }) => f.familySlotId === A.familySlotId));
});

await step('malformed invite config cannot produce an empty complete; durable roster still purges', async () => {
  await seed();
  await releaseAndDeliver();
  process.env.GROUP_BOOK_INVITES_JSON = '{not json';
  const body = await (await cleanup(DUE)).json();
  assert.equal(body.outcome, 'complete');
  assert.equal(body.families.length, 2);
  assert.equal(photosOf(A).length + photosOf(B).length, 0);
});

await step('expired and revoked slots are still purged (capability state is irrelevant to retention)', async () => {
  await seed();
  await releaseAndDeliver();
  process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([{ ...A, expiresAt: '2000-01-01T00:00:00.000Z' }, { ...B, revokedAt: '2000-01-01T00:00:00.000Z' }, OTHER]);
  assert.equal((await (await cleanup(DUE)).json()).outcome, 'complete');
  assert.equal(photosOf(A).length + photosOf(B).length, 0);
});

await step('unowned photo object makes scope unknown: no complete, no deletion', async () => {
  await seed();
  await releaseAndDeliver();
  await blob.seed(`group-book/photos/${'e'.repeat(64)}/gbp_orphan.jpg`, jpeg);
  const response = await cleanup(DUE);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).outcome, 'scope_unknown');
  assert.ok(photosOf(A).length > 0, 'nothing deleted on unknown scope');
});

await step('malformed attempt record makes scope unknown', async () => {
  await seed();
  await releaseAndDeliver();
  await blob.seed(`group-book/attempts/${config.familyStorageKey(A)}/gba_bad.json`, '{broken');
  const response = await cleanup(DUE);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).outcome, 'scope_unknown');
  assert.ok(photosOf(A).length > 0);
});

await step('unreadable family record makes scope unknown', async () => {
  await seed();
  await releaseAndDeliver();
  blob.faults.readPath = store.groupBookRecordPath(A);
  blob.faults.readKind = '503';
  const response = await cleanup(DUE);
  assert.equal((await response.json()).outcome, 'scope_unknown');
  blob.faults.readPath = null;
});

await step('unbounded listing hits the page bound and fails closed', async () => {
  await seed();
  await releaseAndDeliver();
  blob.faults.listLoop = true;
  const response = await cleanup(DUE);
  blob.faults.listLoop = false;
  assert.equal(response.status, 503);
  assert.equal((await response.json()).outcome, 'scope_unknown');
  assert.ok(photosOf(A).length > 0);
});

await step('attempt records carry exact durable cohort/family identity', async () => {
  await seed([A]);
  const attempt = blob.paths().find((p: string) => p.startsWith(`group-book/attempts/${config.familyStorageKey(A)}/`));
  const owner = JSON.parse((await blob.bytes(attempt)).toString('utf8'));
  assert.equal(owner.cohortId, A.cohortId);
  assert.equal(owner.familySlotId, A.familySlotId);
});

// 2. No new intake after release/delivery/unknown ---------------------------------
await step('new intake refused after first final release; existing recovery still allowed', async () => {
  await seed([A]);
  assert.equal((await recordRelease()).status, 200);
  blob.journal.length = 0;
  const refused = await intake(intakeRequest(B));
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, 'edition_already_released');
  assert.equal(puts('/'), 0);
  assert.equal((await intake(intakeRequest(A))).status, 200, 'existing family recovery');
  assert.equal((await access({ json: async () => ({ invite: A.token }) } as unknown as Request)).status, 200);
});

await step('new intake refused when release state is unknown', async () => {
  await seed([A]);
  blob.faults.readPath = retention.groupBookReleasePath(A.cohortId);
  blob.faults.readKind = '503';
  const response = await intake(intakeRequest(B));
  blob.faults.readPath = null;
  assert.equal(response.status, 503);
  assert.equal(puts('/'), 0);
});

await step('in-flight intake racing release: final commit refused, photos stay owned, later sweep purges them', async () => {
  await seed([A]);
  blob.faults.beforePhotoPut = async () => {
    assert.equal((await recordRelease()).status, 200);
    assert.equal((await recordDelivery()).status, 200);
  };
  const response = await intake(intakeRequest(B));
  assert.equal(response.status, 409);
  assert.equal(await store.findGroupBookSubmission(B), null, 'no family record committed after release');
  assert.ok(photosOf(B).length > 0, 'the in-flight photo landed');
  const body = await (await cleanup(DUE)).json();
  assert.equal(body.outcome, 'complete');
  assert.equal(photosOf(B).length, 0, 'owner record made the orphan discoverable');
});

// 3. Distinct first final-release record ---------------------------------------------
await step('final release requires admin auth and binds the actor to the shared admin session', async () => {
  await seed([A]);
  assert.equal((await releaseRoute(admin('/api/admin/group-book/final-release', { cohortId: A.cohortId }, null))).status, 401);
  const first = await recordRelease();
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.outcome, 'recorded');
  assert.equal(body.release.recordedVia, 'shared_admin_session');
  assert.equal(body.release.attributionUnverified, 'Synthetic Operator');
  assert.equal(body.release.channel, 'printing');
});

await step('first release wins: identical replay is replayed, any other (distribution) is conflict; validation', async () => {
  await seed([A]);
  for (const bad of [{ channel: 'email' }, { releasedAt: '2027-01-01T00:00:00.000Z' }, { attribution: '' }, { evidence: '' }]) {
    assert.equal((await recordRelease(bad)).status, 422, JSON.stringify(bad));
  }
  assert.equal((await (await recordRelease()).json()).outcome, 'recorded');
  assert.equal((await (await recordRelease()).json()).outcome, 'replayed');
  assert.equal((await recordRelease({ channel: 'distribution' }, Date.parse(RELEASED) + 5 * DAY)).status, 409);
});

await step('delivery requires a recorded first release and cannot precede it', async () => {
  await seed([A]);
  assert.equal((await recordDelivery()).status, 409);
  assert.equal((await recordRelease()).status, 200);
  assert.equal((await recordDelivery({ deliveredAt: '2026-05-01T00:00:00.000Z' })).status, 422, 'caller time refused');
  assert.equal((await recordDelivery({}, Date.parse(RELEASED) - 1)).status, 422, 'server clock before release');
  assert.equal((await recordDelivery()).status, 200);
});

await step('release-to-delivery gap: withdrawal refuses the OMIT promise and export admission blocks', async () => {
  await seed([A, B]);
  assert.equal((await recordRelease()).status, 200);
  headers.setCookieHeader(`${session.GROUP_BOOK_ACCESS_COOKIE}=${B.token}`);
  const response = await familyWithdraw();
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, 'edition_already_released');
  assert.notEqual(body.omitFromProofAndPrint, true);
  assert.equal((await retention.loadGroupBookDeliveryState(A.cohortId)).state, 'none', 'no delivery yet');
  const admission = await exporter.loadGroupBookAdmission(A.cohortId);
  assert.equal(admission.state, 'uncertain');
  const submitted = admission.families.filter((f: { status: string }) => f.status !== 'not_submitted');
  assert.equal(submitted.length, 2);
  assert.ok(submitted.every((f: { status: string }) => f.status === 'edition_already_released'));
});

await step('unknown release state: withdrawal fails closed (503)', async () => {
  await seed([A]);
  blob.faults.readPath = retention.groupBookReleasePath(A.cohortId);
  blob.faults.readKind = '503';
  headers.setCookieHeader(`${session.GROUP_BOOK_ACCESS_COOKIE}=${A.token}`);
  const response = await familyWithdraw();
  blob.faults.readPath = null;
  assert.equal(response.status, 503);
});

console.log(`RESULT ${JSON.stringify({ results })}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
