// Synthetic-only lifecycle fence scenario (successor DESIGN I1-I6): server-
// authoritative release/delivery times, bounded intake writer, recurring
// cleanup of exact owned keys. Real routes/store/retention against the
// in-memory Blob fake. No network. Prints one RESULT line.
import assert from 'node:assert/strict';
import sharp from 'sharp';

const DAY = 24 * 60 * 60 * 1000;
const fixture = await import('./group-book-policy-fixture.mjs');
const A = { token: 'SyntheticLifeAlphaToken00000000001', cohortId: 'synthetic_cohort', familySlotId: 'synthetic_family_a', cohortLabel: 'Synthetic', expiresAt: fixture.SYNTHETIC_EXPIRES_AT };
const B = { ...A, token: 'SyntheticLifeBravoToken00000000002', familySlotId: 'synthetic_family_b' };
const OTHER = { ...A, token: 'SyntheticLifeOtherToken00000000003', cohortId: 'other_cohort', familySlotId: 'synthetic_family_o' };
const ADMIN_KEY = 'synthetic-admin-key-not-a-secret';
const CRON = 'synthetic-cron-secret-not-a-secret';
process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_groupbookfixture_synthetic';
process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([A, B, OTHER]);
process.env.HSB_ORDER_ADMIN_KEY = ADMIN_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.FAMILY_REVIEW_DEST_BLOB_TOKEN;
delete process.env.CRON_SECRET;

// Controllable server clock: every Date.now() in the handlers reads this.
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

const blob = await import('./group-book-blob-faults.mjs');
const headers = await import('./group-book-next-headers.mjs');
const config = await import('../../src/lib/group-book/config.ts');
const store = await import('../../src/lib/group-book/store.ts');
const retention = await import('../../src/lib/group-book/retention.ts');
const limits = await import('../../src/lib/group-book/limits.ts');
const handlers = await import('../../src/lib/group-book/admin-handlers.ts');
const intakeModule = await import('../../src/app/api/group-book/intake/route.ts');
const intake = intakeModule.POST;
const { POST: cleanupRoute } = await import('../../src/app/api/admin/group-book/retention-cleanup/route.ts');

type Invite = typeof A;
const jpeg = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#557799' } }).jpeg().toBuffer();

const logs: string[] = [];
console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

function intakeRequest(invite: Invite, photoCount = 1): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries({
    invite: invite.token, parentName: 'P', parentEmail: 'p@example.invalid', childFirstName: 'C', ageRange: '5-6',
    guardianAuthority: 'true', sharedWithParticipatingFamilies: 'true', sourcePhotosRemainPrivate: 'true',
    schoolApprovalNotRepresentedOrImplied: 'true', policyVersion: fixture.SYNTHETIC_POLICY_STAMP.version, policyDigest: fixture.SYNTHETIC_POLICY_STAMP.digest,
  })) form.set(k, v);
  for (let i = 0; i < photoCount; i += 1) form.append('photos', new File([jpeg], `x${i}`, { type: 'image/jpeg' }));
  return new Request('https://synthetic.invalid/api/group-book/intake', { method: 'POST', body: form });
}
const admin = (path: string, body: unknown, key: string | null = ADMIN_KEY) => new Request(`https://synthetic.invalid${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-hsb-order-admin-key': key } : {}) }, body: JSON.stringify(body),
});
const release = (extra: Record<string, unknown> = {}, now = Date.now()) => handlers.finalReleaseResponse(admin('/api/admin/group-book/final-release', {
  cohortId: A.cohortId, channel: 'printing', attribution: 'Synthetic Operator', evidence: 'SYNTHETIC print handoff ref', ...extra,
}), now);
const deliver = (extra: Record<string, unknown> = {}, now = Date.now()) => handlers.deliveryResponse(admin('/api/admin/group-book/delivery', {
  cohortId: A.cohortId, recordedBy: 'Synthetic Operator', evidence: 'SYNTHETIC carrier ref', ...extra,
}), now);
const cleanup = (now: number) => handlers.retentionCleanupResponse(admin('/api/admin/group-book/retention-cleanup', { cohortId: A.cohortId }), now);
const photosOf = (invite: Pick<Invite, 'cohortId' | 'familySlotId'>) => blob.paths().filter((p: string) => p.startsWith(`group-book/photos/${config.familyStorageKey(invite)}/`));
const attemptsOf = (invite: Invite) => blob.paths().filter((p: string) => p.startsWith(`group-book/attempts/${config.familyStorageKey(invite)}/`));
const cronRequest = (secret: string | null) => new Request('https://synthetic.invalid/api/cron/group-book-retention-sweep', {
  method: 'GET', headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

async function seed(invites: Invite[] = [A, OTHER]) {
  await blob.reset();
  offset = 0;
  headers.setCookieHeader('');
  process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([A, B, OTHER]);
  process.env.GROUP_BOOK_INTAKE_ENABLED = 'true';
  for (const invite of invites) assert.equal((await intake(intakeRequest(invite))).status, 200);
  blob.journal.length = 0;
}
/** Server-recorded release then delivery; returns the server dueAt. */
async function releaseThenDeliver(): Promise<number> {
  const r = await release();
  assert.equal(r.status, 200, `release ${r.status} ${JSON.stringify(await r.clone().json())}`);
  offset += 1000;
  const d = await deliver();
  assert.equal(d.status, 200, `delivery ${d.status}`);
  return Date.parse((await d.json()).delivery.dueAt);
}

const results: { name: string; ok: boolean; error?: string }[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) }); }
}

// I1 -----------------------------------------------------------------------------
await step('T1 operator backdate of release is rejected; server time is the release time', async () => {
  await seed([A]);
  const backdated = await release({ releasedAt: new Date(Date.now() - 200 * DAY).toISOString() });
  assert.equal(backdated.status, 422);
  assert.equal((await backdated.json()).error, 'caller_time_rejected');
  assert.equal((await retention.loadGroupBookReleaseState(A.cohortId)).state, 'none', 'nothing recorded');
  const now = Date.now();
  const ok = await release({}, now);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.release.releasedAt, new Date(now).toISOString());
  assert.equal(body.release.recordedAt, body.release.releasedAt);
  assert.equal((await (await release({}, now + 5000)).json()).outcome, 'replayed', 'identical replay later is still a replay');
});

await step('T1 operator backdate of delivery is rejected; dueAt = server delivery time + 90d', async () => {
  await seed([A]);
  assert.equal((await release()).status, 200);
  const backdated = await deliver({ deliveredAt: new Date(Date.now() - 100 * DAY).toISOString() });
  assert.equal(backdated.status, 422);
  assert.equal((await backdated.json()).error, 'caller_time_rejected');
  const now = Date.now() + 1000;
  const body = await (await deliver({}, now)).json();
  assert.equal(body.delivery.deliveredAt, new Date(now).toISOString());
  assert.equal(Date.parse(body.delivery.dueAt), now + 90 * DAY);
});

await step('T1 a stored record whose times are not server-recorded parses as unknown (fail closed)', async () => {
  await seed([A]);
  const recordedAt = new Date(Date.now()).toISOString();
  const deliveredAt = new Date(Date.now() - 100 * DAY).toISOString();
  await blob.seed(retention.groupBookReleasePath(A.cohortId), JSON.stringify({
    schemaVersion: 1, cohortId: A.cohortId, channel: 'printing', releasedAt: deliveredAt, recordedAt, recordedVia: 'shared_admin_session', attributionUnverified: 'x', evidence: 'x',
  }));
  await blob.seed(retention.groupBookDeliveryPath(A.cohortId), JSON.stringify({
    schemaVersion: 1, cohortId: A.cohortId, deliveredAt, recordedAt, recordedVia: 'shared_admin_session', recordedBy: 'x', evidence: 'x', retentionDays: 90,
    dueAt: new Date(Date.parse(deliveredAt) + 90 * DAY).toISOString(),
  }));
  assert.equal((await retention.loadGroupBookDeliveryState(A.cohortId)).state, 'unknown');
  const response = await cleanup(Date.now());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).outcome, 'delivery_unknown');
  assert.ok(photosOf(A).length > 0, 'nothing deleted');
});

// I6 / no early deletion -----------------------------------------------------------
await step('T2 no early deletion; read allowed before due, denied at due; summary+consent retained', async () => {
  await seed([A]);
  const due = await releaseThenDeliver();
  const before = await cleanup(due - 1);
  assert.equal(before.status, 409);
  assert.equal((await before.json()).outcome, 'not_due');
  assert.equal(photosOf(A).length, 1);
  const record = await store.findGroupBookSubmission(A);
  assert.ok(record);
  const invite = config.groupBookInvites().find((i: Invite) => i.familySlotId === A.familySlotId);
  assert.equal((await retention.openGroupBookSourcePhoto(invite, record.photos[0].assetId, due - 1)).state, 'ok');
  assert.equal((await retention.openGroupBookSourcePhoto(invite, record.photos[0].assetId, due)).state, 'expired');
  const done = await cleanup(due);
  assert.equal((await done.json()).outcome, 'complete');
  assert.equal(photosOf(A).length, 0);
  const summary = await store.findGroupBookSubmission(A);
  assert.ok(summary, 'summary retained');
  assert.equal(summary.consent.version, 'group-book-v2', 'consent retained');
  assert.equal(attemptsOf(A).length, 1, 'owner record never retired');
});

// I2 / I3 -------------------------------------------------------------------------
await step('T8 bounds are real: route maxDuration export, write window inside it, abort signal on photo puts', async () => {
  assert.equal(intakeModule.maxDuration, 60);
  assert.equal(limits.GROUP_BOOK_INTAKE_MAX_DURATION_S, 60);
  assert.ok(limits.GROUP_BOOK_INTAKE_WRITE_WINDOW_MS > 0 && limits.GROUP_BOOK_INTAKE_WRITE_WINDOW_MS <= 45_000);
  await seed([]);
  assert.equal((await intake(intakeRequest(A))).status, 200);
  const photoPuts = blob.journal.filter((e: { op: string; pathname: string }) => e.op === 'put' && e.pathname.includes('/photos/'));
  assert.ok(photoPuts.length > 0 && photoPuts.every((e: { abortSignal: boolean }) => e.abortSignal), 'every photo put carries an AbortSignal');
  const owner = JSON.parse((await blob.bytes(attemptsOf(A)[0])).toString('utf8'));
  assert.ok(Date.parse(owner.admittedAt) > 0);
  assert.equal(Date.parse(owner.writeDeadline) - Date.parse(owner.admittedAt), limits.GROUP_BOOK_INTAKE_WRITE_WINDOW_MS);
});

await step('T3 admitted-then-released race: writer aborted at its deadline, late remote commit swept at due', async () => {
  await seed([A]);
  blob.faults.beforeAttemptPut = async () => { offset += limits.GROUP_BOOK_INTAKE_WRITE_WINDOW_MS - 150; };
  blob.faults.hangPhotoPut = true;
  const response = await intake(intakeRequest(B));
  assert.equal(response.status, 503, `got ${response.status}`);
  assert.equal((await response.json()).error, 'write_window_elapsed');
  assert.equal(await store.findGroupBookSubmission(B), null, 'no family record committed');
  const due = await releaseThenDeliver();
  assert.equal(await blob.applyLateCommits(), 1);
  assert.equal(photosOf(B).length, 1, 'late remote commit landed after abort');
  const body = await (await cleanup(due)).json();
  assert.equal(body.outcome, 'complete', JSON.stringify(body));
  assert.equal(photosOf(B).length + photosOf(A).length, 0);
});

await step('T3b no write is started after the deadline; commit refused past it', async () => {
  await seed([A]);
  blob.faults.beforeAttemptPut = async () => { offset += limits.GROUP_BOOK_INTAKE_WRITE_WINDOW_MS + 1; };
  const response = await intake(intakeRequest(B));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'write_window_elapsed');
  assert.equal(blob.journal.filter((e: { op: string; pathname: string }) => e.op === 'put' && e.pathname.includes('/photos/')).length, 0);
  assert.equal(await store.findGroupBookSubmission(B), null);
});

await step('T4 late commit after a complete pass is deleted by the next pass; owner record survives', async () => {
  await seed([A]);
  blob.faults.beforeAttemptPut = async () => { offset += limits.GROUP_BOOK_INTAKE_WRITE_WINDOW_MS - 150; };
  blob.faults.hangPhotoPut = true;
  assert.equal((await intake(intakeRequest(B))).status, 503);
  const due = await releaseThenDeliver();
  const first = await (await cleanup(due)).json();
  assert.equal(first.outcome, 'complete');
  await blob.applyLateCommits();
  assert.equal(photosOf(B).length, 1);
  const second = await (await cleanup(due + DAY)).json();
  assert.equal(second.outcome, 'complete');
  assert.equal(second.families.find((f: { familySlotId: string }) => f.familySlotId === B.familySlotId).deleted, 1);
  assert.equal(photosOf(B).length, 0);
  assert.equal(attemptsOf(B).length, 1, 'declared ownership is never retired');
});

await step('T6 partial delete then replay completes', async () => {
  await seed([]);
  assert.equal((await intake(intakeRequest(A, 2))).status, 200);
  const due = await releaseThenDeliver();
  blob.faults.delMode = 'partial';
  const partial = await cleanup(due);
  assert.equal(partial.status, 503);
  assert.equal((await partial.json()).outcome, 'partial');
  assert.equal(photosOf(A).length, 1, 'one of two deleted before the fault');
  assert.equal((await (await cleanup(due)).json()).outcome, 'complete');
  assert.equal(photosOf(A).length, 0);
});

await step('T7 namespace: other cohort and look-alike keys untouched; admin auth required', async () => {
  await seed([A, OTHER]);
  const due = await releaseThenDeliver();
  const lookAlike = `group-book/photos-archive/${config.familyStorageKey(A)}/gbp_x.jpg`;
  await blob.seed(lookAlike, jpeg);
  assert.equal((await cleanupRoute(admin('/api/admin/group-book/retention-cleanup', { cohortId: A.cohortId }, null))).status, 401);
  assert.equal((await (await cleanup(due)).json()).outcome, 'complete');
  assert.equal(photosOf(A).length, 0);
  assert.equal(photosOf(OTHER).length, 1, 'other cohort retained');
  assert.ok(blob.paths().includes(lookAlike), 'look-alike prefix untouched');
  assert.ok(await store.findGroupBookSubmission(OTHER));
});

// I5 recurring cron ------------------------------------------------------------------
await step('T5 cron: fail-closed auth, durable cohort discovery, recurring re-verification', async () => {
  const { GET: cron, maxDuration } = await import('../../src/app/api/cron/group-book-retention-sweep/route.ts');
  assert.equal(maxDuration, 300);
  await seed([A, OTHER]);
  assert.equal((await cron(cronRequest(null))).status, 503, 'no CRON_SECRET configured');
  process.env.CRON_SECRET = CRON;
  assert.equal((await cron(cronRequest('wrong'))).status, 401);
  const notDue = await (await cron(cronRequest(CRON))).json();
  assert.equal(notDue.counts.cohortsDue + notDue.counts.cohortsNotDue, 0, 'no delivery recorded: nothing in scope');
  const due = await releaseThenDeliver();
  process.env.GROUP_BOOK_INVITES_JSON = '[]'; // discovery is durable, never invite config
  offset += DAY; // one effective dispatch per UTC day (ops O3)
  let body = await (await cron(cronRequest(CRON))).json();
  assert.equal(body.counts.cohortsNotDue, 1);
  assert.equal(photosOf(A).length, 1);
  offset = due - realNow();
  const run1 = await cron(cronRequest(CRON));
  body = await run1.json();
  assert.equal(run1.status, 200, JSON.stringify(body));
  assert.equal(body.status, 'ok');
  assert.equal(body.counts.cohortsDue, 1);
  assert.equal(body.counts.complete, 1);
  assert.equal(photosOf(A).length, 0);
  assert.equal(photosOf(OTHER).length, 1, 'undelivered cohort untouched');
  const key = config.familyStorageKey(A);
  const owner = JSON.parse((await blob.bytes(attemptsOf(A)[0])).toString('utf8'));
  await blob.seed(owner.photoPaths[0], jpeg); // a late commit at an owned declared key
  offset += DAY;
  body = await (await cron(cronRequest(CRON))).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.counts.complete, 1);
  assert.equal(photosOf(A).length, 0, 'recurring pass removes the late object');
  assert.ok(owner.photoPaths[0].includes(key));
  delete process.env.CRON_SECRET;
});

console.log(`RESULT ${JSON.stringify({ results })}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
