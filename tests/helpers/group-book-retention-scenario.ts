// Synthetic-only retention/delivery scenario. Real admin routes, store and
// retention module against the in-memory Blob fake; no network, no provider.
// Prints one RESULT line; exits non-zero when any step fails.
import assert from 'node:assert/strict';
import sharp from 'sharp';

const DAY = 24 * 60 * 60 * 1000;
const fixture = await import('./group-book-policy-fixture.mjs');
const A = { token: 'SyntheticRetentionAlphaToken000001', cohortId: 'synthetic_cohort', familySlotId: 'synthetic_family_a', cohortLabel: 'Synthetic', expiresAt: fixture.SYNTHETIC_EXPIRES_AT };
const B = { ...A, token: 'SyntheticRetentionBravoToken000002', familySlotId: 'synthetic_family_b' };
const OTHER = { ...A, token: 'SyntheticRetentionOtherToken000003', cohortId: 'other_cohort', familySlotId: 'synthetic_family_o' };
const ADMIN_KEY = 'synthetic-admin-key-not-a-secret';
process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_groupbookfixture_synthetic';
process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([A, B, OTHER]);
process.env.HSB_ORDER_ADMIN_KEY = ADMIN_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.FAMILY_REVIEW_DEST_BLOB_TOKEN;

const blob = await import('./group-book-blob-faults.mjs');
const headers = await import('./group-book-next-headers.mjs');
const config = await import('../../src/lib/group-book/config.ts');
const release = await import('../../src/lib/group-book/release.ts');
const session = await import('../../src/lib/group-book/session.ts');
const store = await import('../../src/lib/group-book/store.ts');
const retention = await import('../../src/lib/group-book/retention.ts');
const exporter = await import('../../src/lib/group-book/export.ts');
const { POST: intake } = await import('../../src/app/api/group-book/intake/route.ts');
const { POST: familyWithdraw } = await import('../../src/app/group-book/family/withdraw/route.ts');
const { POST: deliveryRoute } = await import('../../src/app/api/admin/group-book/delivery/route.ts');
const handlers = await import('../../src/lib/group-book/admin-handlers.ts');
const { POST: cleanupRoute } = await import('../../src/app/api/admin/group-book/retention-cleanup/route.ts');

type Invite = typeof A;
const jpeg = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#557799' } }).jpeg().toBuffer();
const DELIVERED = '2026-06-01T12:00:00.000Z';
const DUE = Date.parse(DELIVERED) + 90 * DAY;

const logs: string[] = [];
const origError = console.error;
console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

function intakeRequest(invite: Invite): Request {
  const form = new FormData();
  const policy = release.groupBookPolicyState();
  assert.equal(policy.state, 'adopted');
  for (const [k, v] of Object.entries({
    invite: invite.token, parentName: 'SECRET-PARENT-NAME', parentEmail: 'secret-parent@example.invalid',
    childFirstName: 'SECRET-CHILD-NAME', ageRange: '5-6', guardianAuthority: 'true', sharedWithParticipatingFamilies: 'true',
    sourcePhotosRemainPrivate: 'true', schoolApprovalNotRepresentedOrImplied: 'true',
    policyVersion: policy.current.record.version, policyDigest: policy.current.digest,
  })) form.set(k, v);
  form.append('photos', new File([jpeg], 'x', { type: 'image/jpeg' }));
  form.append('photos', new File([jpeg], 'y', { type: 'image/jpeg' }));
  return new Request('https://synthetic.invalid/api/group-book/intake', { method: 'POST', body: form });
}
const admin = (path: string, body: unknown, key: string | null = ADMIN_KEY) => new Request(`https://synthetic.invalid${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(key ? { 'x-hsb-order-admin-key': key } : {}) },
  body: JSON.stringify(body),
});
// Time-controlled calls use the shared handler with an explicit SERVER clock;
// the routes themselves always pass Date.now(). Lifecycle times are the server
// recording time (successor I1): release at DELIVERED-1s, delivery AT DELIVERED.
// Delivery requires a recorded first final release (v3); record it first.
const recordDelivery = async (extra: Record<string, unknown> = {}, key: string | null = ADMIN_KEY) => {
  await handlers.finalReleaseResponse(admin('/api/admin/group-book/final-release', {
    cohortId: A.cohortId, channel: 'printing', attribution: 'Synthetic Operator', evidence: 'SYNTHETIC print ref',
  }), Date.parse(DELIVERED) - 1000);
  return recordDeliveryOnly(extra, key);
};
const recordDeliveryOnly = (extra: Record<string, unknown> = {}, key: string | null = ADMIN_KEY) => handlers.deliveryResponse(admin('/api/admin/group-book/delivery', {
  cohortId: A.cohortId, recordedBy: 'Synthetic Operator', evidence: 'SYNTHETIC carrier receipt ref', ...extra,
}, key), Date.parse(DELIVERED));
const cleanup = (now: number, key: string | null = ADMIN_KEY) => handlers.retentionCleanupResponse(admin('/api/admin/group-book/retention-cleanup', { cohortId: A.cohortId, now: '2099-01-01T00:00:00.000Z' }, key), now);
const dels = () => blob.journal.filter((e: { op: string }) => e.op === 'del').map((e: { pathname: string }) => e.pathname);
const photoPathsFor = (invite: Invite) => blob.paths().filter((p: string) => p.startsWith(`group-book/photos/${config.familyStorageKey(invite)}/`));

async function seedCohort() {
  await blob.reset();
  headers.setCookieHeader('');
  process.env.GROUP_BOOK_INTAKE_ENABLED = 'true';
  for (const invite of [A, B, OTHER]) assert.equal((await intake(intakeRequest(invite))).status, 200);
  delete process.env.GROUP_BOOK_INTAKE_ENABLED;
  // A stray attempt-owned photo for A (written, never referenced by the record).
  const key = config.familyStorageKey(A);
  await blob.seed(`group-book/photos/${key}/gbp_strayattempt01.jpg`, jpeg);
  await blob.seed(`group-book/attempts/${key}/gba_stray.json`, JSON.stringify({
    schemaVersion: 1, attemptId: 'gba_stray', familyStorageKey: key, submissionId: 'gbs_stray',
    photoPaths: [`group-book/photos/${key}/gbp_strayattempt01.jpg`, `group-book/photos/${config.familyStorageKey(OTHER)}/gbp_foreign.jpg`, 'orders/foreign.jpg'],
    createdAt: new Date().toISOString(),
  }));
  // Foreign objects that must never be deleted.
  await blob.seed('orders/foreign.jpg', jpeg);
  await blob.seed(`group-book/photos/${key}/nested/gbp_noncanonical.jpg`, jpeg);
  blob.journal.length = 0;
}
const FOREIGN = ['orders/foreign.jpg'];

const results: { name: string; ok: boolean; error?: string }[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) }); }
}

await step('adopted owner policy is the code-pinned record with exact owner answers', async () => {
  const policy = release.groupBookPolicyState();
  assert.equal(policy.state, 'adopted');
  const r = policy.current.record;
  assert.equal(r.version, 'hsb-classroom-submission-policy-2026-10-19-v1');
  assert.equal(r.adoptedBy, 'Alexy Kaplun');
  assert.equal(r.sourceSha256, '57cedae1e7db65cd796d5b992c93a3a911cdf15e22d6c08c91b9a354b4849a21');
  assert.match(r.finishedBookRecipients, /^Participating families and approved teachers only\./);
  assert.match(r.withdrawalCutoff, /^Until final release to printing or distribution, whichever comes first\./);
  assert.match(r.sourcePhotoRetention, /^90 days, then delete source photos\./);
  assert.match(r.sourcePhotoRetention, /final delivery/i);
  assert.match(r.sourcePhotoRetention, /not .*upload/i);
  assert.match(r.wholeBookApproval, /Alexy Kaplun/);
  assert.match(r.depictedAdultPermission, /consent/i);
  assert.match(r.guardianReviewScope, /own child/i);
  assert.doesNotMatch(JSON.stringify(r), /backups? (are|is) (erased|deleted)/i);
  assert.equal(retention.GROUP_BOOK_SOURCE_PHOTO_RETENTION_DAYS, 90);
});

await step('delivery and cleanup require existing admin auth (real routes, server clock)', async () => {
  await seedCohort();
  const unauth = (path: string) => admin(path, { cohortId: A.cohortId }, null);
  assert.equal((await deliveryRoute(unauth('/api/admin/group-book/delivery'))).status, 401);
  assert.equal((await cleanupRoute(unauth('/api/admin/group-book/retention-cleanup'))).status, 401);
  // A request-supplied clock cannot advance the due time: the real route uses
  // the server clock, and real "now" (before this run's due date + any skew) decides.
  const real = await cleanupRoute(admin('/api/admin/group-book/retention-cleanup', { cohortId: A.cohortId, now: '2099-01-01T00:00:00.000Z' }));
  assert.equal((await real.json()).outcome, 'no_delivery_recorded');
  assert.equal((await recordDelivery({}, null)).status, 401);
  assert.equal((await recordDelivery({}, 'wrong')).status, 401);
  assert.equal((await cleanup(DUE, null)).status, 401);
  assert.equal(dels().length, 0);
});

await step('unknown/absent delivery: no anchor, no deletion, photos stay accessible', async () => {
  await seedCohort();
  const response = await cleanup(Date.parse('2099-01-01T00:00:00.000Z'));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).outcome, 'no_delivery_recorded');
  assert.equal(dels().length, 0);
  const photo = (await store.findGroupBookSubmission(A))!.photos[0];
  assert.equal((await retention.openGroupBookSourcePhoto(A, photo.assetId, Date.parse('2099-01-01'))).state, 'ok');
});

await step('unreadable delivery record is unknown: refuses cleanup and fails closed on photo access', async () => {
  await seedCohort();
  await recordDelivery();
  blob.faults.readPath = retention.groupBookDeliveryPath(A.cohortId);
  blob.faults.readKind = '503';
  const response = await cleanup(DUE + DAY);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).outcome, 'delivery_unknown');
  const photo = (await store.findGroupBookSubmission(A))!.photos[0];
  assert.equal((await retention.openGroupBookSourcePhoto(A, photo.assetId, DUE - DAY)).state, 'unknown');
  assert.equal(dels().length, 0);
  blob.faults.readPath = null;
});

await step('delivery record validates, stamps server time, is immutable and idempotent', async () => {
  await seedCohort();
  for (const bad of [{ evidence: '' }, { recordedBy: '' }, { deliveredAt: 'soon' }, { deliveredAt: '2026-12-01T00:00:00.000Z' }]) {
    assert.equal((await recordDelivery(bad)).status, 422, JSON.stringify(bad));
  }
  const first = await recordDelivery();
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.outcome, 'recorded');
  assert.equal(body.delivery.dueAt, new Date(DUE).toISOString());
  assert.ok(body.delivery.recordedAt);
  const replay = await (await recordDelivery()).json();
  assert.equal(replay.outcome, 'replayed');
  // Contract change (successor I1): any caller time is refused, so a different
  // delivery is now expressed by different operator-entered evidence.
  assert.equal((await (await recordDelivery({ deliveredAt: '2026-05-30T12:00:00.000Z' })).json()).error, 'caller_time_rejected');
  const changed = await recordDelivery({ evidence: 'SYNTHETIC different carrier ref' });
  assert.equal(changed.status, 409);
  assert.equal(blob.journal.filter((e: { op: string; pathname: string }) => e.op === 'put' && e.pathname.includes('/deliveries/')).length, 1, 'exactly one create-only write');
});

await step('BEFORE due: not_due, zero deletes, retained photos accessible', async () => {
  await seedCohort();
  await recordDelivery();
  const response = await cleanup(DUE - 1);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).outcome, 'not_due');
  assert.equal(dels().length, 0);
  const photo = (await store.findGroupBookSubmission(A))!.photos[0];
  assert.equal((await retention.openGroupBookSourcePhoto(A, photo.assetId, DUE - 1)).state, 'ok');
});

await step('AT due: photo access fails closed even before deletion; cleanup deletes exactly family-owned canonical paths', async () => {
  await seedCohort();
  await recordDelivery();
  const photo = (await store.findGroupBookSubmission(A))!.photos[0];
  assert.equal((await retention.openGroupBookSourcePhoto(A, photo.assetId, DUE)).state, 'expired');
  const otherBefore = photoPathsFor(OTHER);
  const response = await cleanup(DUE);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcome, 'complete');
  assert.equal(photoPathsFor(A).filter((p: string) => !p.includes('/nested/')).length, 0);
  assert.equal(photoPathsFor(B).length, 0);
  assert.deepEqual(photoPathsFor(OTHER), otherBefore, 'other cohort untouched');
  for (const path of [...FOREIGN, `group-book/photos/${config.familyStorageKey(A)}/nested/gbp_noncanonical.jpg`]) {
    assert.ok(blob.paths().includes(path), `foreign path deleted: ${path}`);
  }
  for (const d of dels()) assert.match(d, /^group-book\/photos\/[0-9a-f]{64}\/gbp_[A-Za-z0-9_-]+\.jpg$/);
  // Preserved state: submission summary, consent, attempts, delivery.
  assert.ok(await store.findGroupBookSubmission(A));
  assert.ok(blob.paths().some((p: string) => p.startsWith(`group-book/attempts/${config.familyStorageKey(A)}/`)));
  assert.ok(blob.paths().includes(retention.groupBookDeliveryPath(A.cohortId)));
  assert.ok(blob.paths().some((p: string) => p.startsWith('group-book/retention/')), 'verified receipt written');
});

await step('look-alike photo prefix is unowned: cleanup fails closed with scope_unknown, nothing deleted', async () => {
  await seedCohort();
  await recordDelivery();
  const lookalike = `group-book/photos/${config.familyStorageKey(A)}-evil/gbp_lookalike.jpg`;
  await blob.seed(lookalike, jpeg);
  const response = await cleanup(DUE);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).outcome, 'scope_unknown');
  assert.equal(dels().length, 0);
  assert.ok(blob.paths().includes(lookalike));
});

await step('AFTER due replay is idempotent: already_complete, no foreign deletion', async () => {
  await seedCohort();
  await recordDelivery();
  assert.equal((await cleanup(DUE)).status, 200);
  const before = dels().length;
  const replay = await (await cleanup(DUE + 30 * DAY)).json();
  assert.equal(replay.outcome, 'complete');
  assert.ok(replay.families.every((f: { status: string }) => f.status === 'already_complete'));
  assert.equal(dels().length, before);
  assert.ok(blob.paths().includes('orders/foreign.jpg'));
});

await step('partial delete reports partial without receipt; replay reconciles to complete', async () => {
  await seedCohort();
  await recordDelivery();
  blob.faults.delMode = 'partial';
  const first = await cleanup(DUE);
  assert.equal(first.status, 503);
  assert.equal((await first.json()).outcome, 'partial');
  assert.ok(!blob.paths().some((p: string) => p.startsWith(`group-book/retention/${A.cohortId}/${config.familyStorageKey(A)}`)) ||
    photoPathsFor(A).filter((p: string) => !p.includes('/nested/')).length === 0);
  const second = await cleanup(DUE);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).outcome, 'complete');
  assert.equal(photoPathsFor(A).filter((p: string) => !p.includes('/nested/')).length, 0);
});

await step('ambiguous delete (committed then throw) is verified by reread, not assumed', async () => {
  await seedCohort();
  await recordDelivery();
  blob.faults.delMode = 'commit-then-throw';
  const response = await cleanup(DUE);
  const body = await response.json();
  assert.equal(body.outcome, 'complete');
  assert.equal(photoPathsFor(A).filter((p: string) => !p.includes('/nested/')).length, 0);
});

await step('unverifiable deletion (photo read 503) is never reported complete', async () => {
  await seedCohort();
  await recordDelivery();
  const target = (await store.findGroupBookSubmission(A))!.photos[0].pathname;
  blob.faults.readPath = target;
  blob.faults.readKind = '503';
  const response = await cleanup(DUE);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.outcome, 'partial');
  assert.equal(body.families.find((f: { familySlotId: string }) => f.familySlotId === A.familySlotId).status, 'unverified');
  blob.faults.readPath = null;
});

await step('retained state positive: withdrawn family keeps summary before and after cleanup; photos explained as deleted', async () => {
  await seedCohort();
  headers.setCookieHeader(`${session.GROUP_BOOK_ACCESS_COOKIE}=${A.token}`);
  assert.equal((await familyWithdraw()).status, 200);
  const photo = (await store.findGroupBookSubmission(A))!.photos[0];
  await recordDelivery();
  assert.equal((await retention.openGroupBookSourcePhoto(A, photo.assetId, DUE - DAY)).state, 'ok', 'withdrawn family photos retained before due');
  assert.equal((await cleanup(DUE)).status, 200);
  const own = await store.loadOwnFamilySubmission(A.token);
  assert.equal(own.state, 'found');
  assert.equal(own.submission.effectiveStatus, 'withdrawal_requested');
  const view = await retention.groupBookPhotoAvailability(A.cohortId, DUE + 1);
  assert.equal(view.state, 'expired');
  assert.equal((await retention.openGroupBookSourcePhoto(A, photo.assetId, DUE + 1)).state, 'expired');
});

await step('withdrawal after recorded final delivery is refused as already released (no recall promise)', async () => {
  await seedCohort();
  await recordDelivery();
  headers.setCookieHeader(`${session.GROUP_BOOK_ACCESS_COOKIE}=${B.token}`);
  const response = await familyWithdraw();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'edition_already_released');
});

await step('export admission blocks once retention has expired', async () => {
  await seedCohort();
  await recordDelivery();
  const admission = await exporter.loadGroupBookAdmission(A.cohortId);
  assert.equal(admission.state, 'uncertain');
  assert.ok(admission.families.some((f: { status: string }) => f.status === 'edition_already_released'));
});

await step('no raw child or parent details in any log line', async () => {
  for (const line of logs) assert.doesNotMatch(line, /SECRET-|secret-parent/);
});

console.error = origError;
console.log(`RESULT ${JSON.stringify({ results })}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
