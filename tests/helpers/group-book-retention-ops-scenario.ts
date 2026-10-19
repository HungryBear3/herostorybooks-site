// Synthetic-only retention operations scenario (ops successor DESIGN O1-O6):
// per-key failure isolation, bounded budget, durable single-flight dispatch,
// sanitized heartbeat and deterministic monitor. Real routes/store/retention
// against the in-memory Blob fake. No network. Prints one RESULT line.
import assert from 'node:assert/strict';
import sharp from 'sharp';

const DAY = 24 * 60 * 60 * 1000;
const fixture = await import('./group-book-policy-fixture.mjs');
const A = { token: 'SyntheticOpsAlphaToken000000000001', cohortId: 'synthetic_cohort', familySlotId: 'synthetic_family_a', cohortLabel: 'Synthetic', expiresAt: fixture.SYNTHETIC_EXPIRES_AT };
const B = { ...A, token: 'SyntheticOpsBravoToken000000000002', familySlotId: 'synthetic_family_b' };
const OTHER = { ...A, token: 'SyntheticOpsOtherToken000000000003', cohortId: 'other_cohort', familySlotId: 'synthetic_family_o' };
const C = { ...A, token: 'SyntheticOpsCharlieToken0000000004', familySlotId: 'synthetic_family_c' };
const ADMIN_KEY = 'synthetic-admin-key-not-a-secret';
const CRON = 'synthetic-cron-secret-not-a-secret';
process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_groupbookfixture_synthetic';
process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([A, B, C, OTHER]);
process.env.HSB_ORDER_ADMIN_KEY = ADMIN_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.FAMILY_REVIEW_DEST_BLOB_TOKEN;
delete process.env.CRON_SECRET;

const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
const setClock = (ms: number) => { offset = ms - realNow(); };

const blob = await import('./group-book-blob-faults.mjs');
const headers = await import('./group-book-next-headers.mjs');
const config = await import('../../src/lib/group-book/config.ts');
const retention = await import('../../src/lib/group-book/retention.ts');
const monitor = await import('../../src/lib/group-book/retention-monitor.ts');
const handlers = await import('../../src/lib/group-book/admin-handlers.ts');
const { POST: intake } = await import('../../src/app/api/group-book/intake/route.ts');
const { GET: cron } = await import('../../src/app/api/cron/group-book-retention-sweep/route.ts');

type Invite = typeof A;
const jpeg = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#557799' } }).jpeg().toBuffer();
const logs: string[] = [];
console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

function intakeRequest(invite: Invite): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries({
    invite: invite.token, parentName: 'SECRET-PARENT', parentEmail: 'p@example.invalid', childFirstName: 'SECRET-CHILD', ageRange: '5-6',
    guardianAuthority: 'true', sharedWithParticipatingFamilies: 'true', sourcePhotosRemainPrivate: 'true',
    schoolApprovalNotRepresentedOrImplied: 'true', policyVersion: fixture.SYNTHETIC_POLICY_STAMP.version, policyDigest: fixture.SYNTHETIC_POLICY_STAMP.digest,
  })) form.set(k, v);
  form.append('photos', new File([jpeg], 'x0', { type: 'image/jpeg' }));
  return new Request('https://synthetic.invalid/api/group-book/intake', { method: 'POST', body: form });
}
const admin = (path: string, body: unknown, key: string | null = ADMIN_KEY) => new Request(`https://synthetic.invalid${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-hsb-order-admin-key': key } : {}) }, body: JSON.stringify(body),
});
const photosOf = (invite: Pick<Invite, 'cohortId' | 'familySlotId'>) => blob.paths().filter((p: string) => p.startsWith(`group-book/photos/${config.familyStorageKey(invite)}/`));
const cronRequest = (secret: string | null) => new Request('https://synthetic.invalid/api/cron/group-book-retention-sweep', {
  method: 'GET', headers: secret ? { authorization: `Bearer ${secret}` } : {},
});
const writes = () => blob.journal.filter((e: { op: string }) => e.op === 'put' || e.op === 'del');
const dels = () => blob.journal.filter((e: { op: string }) => e.op === 'del').map((e: { pathname: string }) => e.pathname);
const BASE = Date.parse('2026-03-02T05:41:00.000Z');

/** Seeds intake for invites at BASE, records release+delivery for A's cohort; returns due ms. */
async function seedDue(invites: Invite[] = [A, B, OTHER]): Promise<number> {
  await blob.reset();
  setClock(BASE);
  headers.setCookieHeader('');
  process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([A, B, C, OTHER]);
  process.env.GROUP_BOOK_INTAKE_ENABLED = 'true';
  process.env.CRON_SECRET = CRON;
  for (const invite of invites) assert.equal((await intake(intakeRequest(invite))).status, 200);
  assert.equal((await handlers.finalReleaseResponse(admin('/api/admin/group-book/final-release', {
    cohortId: A.cohortId, channel: 'printing', attribution: 'Synthetic Operator', evidence: 'SYNTHETIC print ref',
  }), BASE)).status, 200);
  const d = await handlers.deliveryResponse(admin('/api/admin/group-book/delivery', {
    cohortId: A.cohortId, recordedBy: 'Synthetic Operator', evidence: 'SYNTHETIC carrier ref',
  }), BASE + 1000);
  assert.equal(d.status, 200);
  blob.journal.length = 0;
  // First scheduled dispatch after due: 05:41 UTC on the due day + 1.
  const due = Date.parse((await d.json()).delivery.dueAt);
  setClock(Date.parse(new Date(due + DAY).toISOString().slice(0, 10) + 'T05:41:00.000Z'));
  return due;
}
const nextDay = () => { offset += DAY; };

const results: { name: string; ok: boolean; error?: string }[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) }); }
}

await step('O5 unauthorized cron and admin cleanup cause zero provider writes', async () => {
  await seedDue();
  delete process.env.CRON_SECRET;
  assert.equal((await cron(cronRequest(CRON))).status, 503);
  process.env.CRON_SECRET = CRON;
  assert.equal((await cron(cronRequest(null))).status, 401);
  assert.equal((await cron(cronRequest('wrong'))).status, 401);
  assert.equal((await handlers.retentionCleanupResponse(admin('/api/admin/group-book/retention-cleanup', { cohortId: A.cohortId }, 'bad'), Date.now())).status, 401);
  assert.deepEqual(writes(), []);
  assert.equal(blob.journal.length, 0, 'no provider operation at all');
});

await step('O1 malformed/unknown family records cannot starve an expired family; unknown never deleted', async () => {
  await seedDue([A, B]);
  const keyB = config.familyStorageKey(B);
  blob.faults.readPath = `group-book/families/${keyB}.json`; // B's record now reads malformed: held
  blob.faults.readKind = 'parse';
  await blob.seed(`group-book/families/${'f'.repeat(64)}.json`, '{broken'); // unknown malformed record
  const orphan = `group-book/photos/${'e'.repeat(64)}/gbp_orphan.jpg`;
  await blob.seed(orphan, jpeg);
  const before = photosOf(B);
  const res = await cron(cronRequest(CRON));
  blob.faults.readPath = null;
  const body = await res.json();
  assert.equal(res.status, 503, JSON.stringify(body));
  assert.equal(body.status, 'attention');
  assert.ok(body.attention.includes('held_unknown_scope'));
  assert.equal(photosOf(A).length, 0, 'valid due family still cleaned');
  assert.deepEqual(photosOf(B), before, 'held family photos retained');
  assert.ok(blob.paths().includes(orphan), 'unowned photo never deleted');
  assert.ok(dels().every((p: string) => p.startsWith(`group-book/photos/${config.familyStorageKey(A)}/`)));
  assert.equal(body.counts.held, 3, 'B, malformed unknown record, orphan prefix');
  assert.ok(blob.paths().includes(`group-book/families/${'f'.repeat(64)}.json`));
});

await step('O1 global transport failure halts with attention, never complete, zero deletes', async () => {
  await seedDue();
  blob.faults.listLoop = true;
  const res = await cron(cronRequest(CRON));
  blob.faults.listLoop = false;
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.deepEqual(body.attention, ['discovery_unavailable']);
  assert.equal(dels().length, 0);
  assert.equal(body.counts.complete, 0);
  const hb = await monitor.loadRetentionMonitorInputs(Date.now());
  assert.equal(hb.heartbeats[0]?.status, 'attention', 'durable attention heartbeat written');
});

await step('O2 budget exhaustion is incomplete with attention; the next dispatch finishes', async () => {
  await seedDue([A, B]);
  process.env.GROUP_BOOK_SWEEP_FAMILY_BUDGET = '1';
  let body = await (await cron(cronRequest(CRON))).json();
  assert.ok(body.attention.includes('incomplete_budget'), JSON.stringify(body));
  assert.equal(body.counts.deferred, 1);
  assert.equal(photosOf(A).length + photosOf(B).length, 1);
  nextDay();
  process.env.GROUP_BOOK_SWEEP_FAMILY_BUDGET = '5';
  body = await (await cron(cronRequest(CRON))).json();
  assert.equal(body.status, 'ok', JSON.stringify(body));
  assert.equal(photosOf(A).length + photosOf(B).length, 0);
  delete process.env.GROUP_BOOK_SWEEP_FAMILY_BUDGET;
});

await step('O2 partial delete exposes attention and is retried by the next daily dispatch only', async () => {
  await seedDue([A]);
  const owned = `group-book/photos/${config.familyStorageKey(A)}/gbp_second.jpg`;
  await blob.seed(owned, jpeg);
  blob.faults.delMode = 'partial';
  let res = await cron(cronRequest(CRON));
  let body = await res.json();
  assert.equal(res.status, 503);
  assert.ok(body.attention.includes('partial_or_unverified'), JSON.stringify(body));
  assert.ok(photosOf(A).length > 0);
  res = await cron(cronRequest(CRON)); // same UTC day: suppressed, no retry storm
  body = await res.json();
  assert.equal(body.status, 'duplicate_suppressed');
  nextDay();
  body = await (await cron(cronRequest(CRON))).json();
  assert.equal(body.status, 'ok', JSON.stringify(body));
  assert.equal(photosOf(A).length, 0);
});

await step('O2 late arrival at an owned key is removed by the next dispatch (repeat)', async () => {
  await seedDue([A]);
  assert.equal((await (await cron(cronRequest(CRON))).json()).status, 'ok');
  const late = `group-book/photos/${config.familyStorageKey(A)}/gbp_late.jpg`;
  await blob.seed(late, jpeg);
  nextDay();
  const body = await (await cron(cronRequest(CRON))).json();
  assert.equal(body.status, 'ok');
  assert.ok(!blob.paths().includes(late));
});

await step('O3 concurrent overlapping dispatches: exactly one effective cleanup, slot retained', async () => {
  await seedDue([A]);
  const [r1, r2] = await Promise.all([cron(cronRequest(CRON)), cron(cronRequest(CRON))]);
  const bodies = [await r1.json(), await r2.json()];
  assert.equal(bodies.filter((b) => b.status === 'duplicate_suppressed').length, 1, JSON.stringify(bodies));
  assert.equal(bodies.filter((b) => b.status === 'ok').length, 1);
  assert.equal(dels().length, 1, 'one effective delete');
  const slots = blob.paths().filter((p: string) => p.startsWith('group-book/ops/retention-dispatch/'));
  assert.equal(slots.length, 1);
  assert.equal(blob.paths().filter((p: string) => p.startsWith('group-book/ops/retention-heartbeat/')).length, 1);
});

await step('O4 heartbeat and cron response are sanitized counts/status/timestamps only', async () => {
  await seedDue([A, B]);
  const res = await cron(cronRequest(CRON));
  const text = await res.text();
  const hbPath = blob.paths().find((p: string) => p.startsWith('group-book/ops/retention-heartbeat/'));
  assert.ok(hbPath);
  const hb = (await blob.bytes(hbPath)).toString('utf8');
  for (const s of [text, hb]) {
    for (const bad of ['SECRET', A.familySlotId, B.familySlotId, A.token, config.familyStorageKey(A), 'gbp_', 'cohortId', 'http']) {
      assert.ok(!s.includes(bad), `leaked ${bad}`);
    }
  }
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['attention', 'counts', 'ok', 'startedAt', 'status']);
});

await step('O6 monitor: missed dispatch (no slot) alerts; stale in-progress alerts', async () => {
  await blob.reset();
  setClock(Date.parse('2026-04-10T07:00:00.000Z'));
  let inputs = await monitor.loadRetentionMonitorInputs(Date.now());
  let out = monitor.evaluateRetentionMonitor({ ...inputs, now: Date.now(), httpStatus: null, priorFingerprints: [] });
  assert.deepEqual(out.alerts.map((a) => a.kind), ['missed_dispatch']);
  await blob.seed('group-book/ops/retention-dispatch/2026-04-10.json', JSON.stringify({ schemaVersion: 1, runId: 'r', startedAt: '2026-04-10T05:41:00.000Z' }));
  inputs = await monitor.loadRetentionMonitorInputs(Date.now());
  out = monitor.evaluateRetentionMonitor({ ...inputs, now: Date.now(), httpStatus: null, priorFingerprints: [] });
  assert.deepEqual(out.alerts.map((a) => a.kind), ['stale_in_progress']);
  // Before the grace window the previous day is expected instead.
  setClock(Date.parse('2026-04-10T05:50:00.000Z'));
  inputs = await monitor.loadRetentionMonitorInputs(Date.now());
  out = monitor.evaluateRetentionMonitor({ ...inputs, now: Date.now(), httpStatus: null, priorFingerprints: [] });
  assert.equal(out.expectedDay, '2026-04-09');
});

await step('O6 monitor: attention alerts once, unchanged fault deduped, 5xx alerts', async () => {
  const now = Date.parse('2026-04-10T07:00:00.000Z');
  const slot = { day: '2026-04-10', startedAt: '2026-04-10T05:41:01.000Z' };
  const hb = { day: '2026-04-10', status: 'attention' as const, attention: ['held_unknown_scope'], finishedAt: '2026-04-10T05:41:09.000Z' };
  const first = monitor.evaluateRetentionMonitor({ now, slots: [slot], heartbeats: [hb], httpStatus: null, priorFingerprints: [] });
  assert.deepEqual(first.alerts.map((a) => a.kind), ['attention']);
  const again = monitor.evaluateRetentionMonitor({ now: now + DAY, slots: [{ ...slot, day: '2026-04-11' }], heartbeats: [{ ...hb, day: '2026-04-11' }], httpStatus: null, priorFingerprints: first.fingerprints });
  assert.deepEqual(again.alerts, [], 'unchanged fault not re-alerted');
  assert.deepEqual(again.fingerprints, first.fingerprints, 'fingerprint persists while fault persists');
  const changed = monitor.evaluateRetentionMonitor({ now, slots: [slot], heartbeats: [{ ...hb, attention: ['incomplete_budget'] }], httpStatus: 503, priorFingerprints: first.fingerprints });
  assert.deepEqual(changed.alerts.map((a) => a.kind).sort(), ['attention', 'http_5xx']);
  for (const alert of [...first.alerts, ...changed.alerts]) assert.equal(alert.delivery, 'dry_run');
});

await step('O6 monitor: repeated healthy cycles produce zero alerts and clear fingerprints', async () => {
  const now = Date.parse('2026-04-10T07:00:00.000Z');
  let prior = ['attention:held_unknown_scope'];
  for (let i = 0; i < 3; i += 1) {
    const day = new Date(now + i * DAY).toISOString().slice(0, 10);
    const out = monitor.evaluateRetentionMonitor({
      now: now + i * DAY, slots: [{ day, startedAt: `${day}T05:41:01.000Z` }],
      heartbeats: [{ day, status: 'ok', attention: [], finishedAt: `${day}T05:41:09.000Z` }], httpStatus: 200, priorFingerprints: prior,
    });
    assert.deepEqual(out.alerts, []);
    assert.deepEqual(out.fingerprints, []);
    prior = out.fingerprints;
  }
});

await step('Existing admin per-cohort cleanup stays strictly fail-closed on unknown scope', async () => {
  await seedDue([A]);
  await blob.seed(`group-book/photos/${'e'.repeat(64)}/gbp_orphan.jpg`, jpeg);
  const res = await handlers.retentionCleanupResponse(admin('/api/admin/group-book/retention-cleanup', { cohortId: A.cohortId }), Date.now());
  assert.equal((await res.json()).outcome, 'scope_unknown');
  assert.equal(dels().length, 0);
});

await step('O2 fairness: same budget across days reaches every family without raising budget', async () => {
  await seedDue([A, B, C]);
  process.env.GROUP_BOOK_SWEEP_FAMILY_BUDGET = '1';
  // Make every family's cleanup permanently re-needed: re-seed a late object each day for A (first in order).
  const lateA = `group-book/photos/${config.familyStorageKey(A)}/gbp_late.jpg`;
  for (let day = 0; day < 3; day += 1) {
    if (!blob.paths().includes(lateA)) await blob.seed(lateA, jpeg);
    const body = await (await cron(cronRequest(CRON))).json();
    assert.equal(body.counts.families, 1);
    assert.equal(body.counts.deferred, 2);
    nextDay();
  }
  assert.equal(photosOf(B).length + photosOf(C).length, 0, 'deferred families reached within ceil(N/budget) days');
  delete process.env.GROUP_BOOK_SWEEP_FAMILY_BUDGET;
});

await step('O4 heartbeat write failure is typed attention heartbeat_unconfirmed with 503, never ok', async () => {
  await seedDue([A]);
  blob.faults.failPutPrefix = 'group-book/ops/retention-heartbeat/';
  const res = await cron(cronRequest(CRON));
  blob.faults.failPutPrefix = null;
  const body = await res.json();
  assert.equal(res.status, 503, JSON.stringify(body));
  assert.equal(body.ok, false);
  assert.ok(body.attention.includes('heartbeat_unconfirmed'));
});

await step('O3 duplicate never masks a prior attention or unconfirmed run as healthy', async () => {
  await seedDue([A]);
  await blob.seed(`group-book/photos/${'e'.repeat(64)}/gbp_orphan.jpg`, jpeg);
  assert.equal((await cron(cronRequest(CRON))).status, 503);
  let res = await cron(cronRequest(CRON));
  let body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.status, 'duplicate_suppressed');
  assert.equal(body.ok, false);
  assert.ok(body.attention.includes('held_unknown_scope'), 'stored sanitized result returned');
  nextDay();
  await blob.seed(`group-book/ops/retention-dispatch/${new Date(Date.now()).toISOString().slice(0, 10)}.json`, JSON.stringify({ schemaVersion: 1, runId: 'x', startedAt: new Date(Date.now()).toISOString() }));
  blob.journal.length = 0;
  res = await cron(cronRequest(CRON));
  body = await res.json();
  assert.equal(res.status, 503);
  assert.deepEqual(body.attention, ['dispatch_unconfirmed']);
  assert.equal(dels().length, 0);
});

await step('O6 monitor loader: malformed slot timestamp / heartbeat schema cannot suppress the alarm', async () => {
  await blob.reset();
  setClock(Date.parse('2026-04-10T07:00:00.000Z'));
  await blob.seed('group-book/ops/retention-dispatch/2026-04-10.json', JSON.stringify({ schemaVersion: 1, runId: 'r', startedAt: 'garbage' }));
  let inputs = await monitor.loadRetentionMonitorInputs(Date.now());
  let out = monitor.evaluateRetentionMonitor({ ...inputs, now: Date.now(), httpStatus: null, priorFingerprints: [] });
  assert.ok(out.alerts.length > 0, 'malformed slot must alert');
  assert.ok(out.alerts.some((a) => a.kind === 'monitor_read_unavailable'));
  await blob.reset();
  await blob.seed('group-book/ops/retention-heartbeat/2026-04-10.json', JSON.stringify({ status: 'ok', attention: [], finishedAt: 'not-a-time' }));
  inputs = await monitor.loadRetentionMonitorInputs(Date.now());
  out = monitor.evaluateRetentionMonitor({ ...inputs, now: Date.now(), httpStatus: null, priorFingerprints: [] });
  assert.ok(out.alerts.some((a) => a.kind === 'monitor_read_unavailable'), 'bad heartbeat timestamp alerts');
  // Pure evaluator also never treats a NaN slot time as fresh.
  out = monitor.evaluateRetentionMonitor({ now: Date.now(), slots: [{ day: '2026-04-10', startedAt: 'x' }], heartbeats: [], httpStatus: null, priorFingerprints: [] });
  assert.deepEqual(out.alerts.map((a) => a.kind), ['stale_in_progress']);
});

await step('O6 monitor CLI is quiet when healthy and prints only on new faults', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'gbmon-'));
  const day = '2026-04-10';
  fs.writeFileSync(pathMod.join(dir, 'in.json'), JSON.stringify({ now: Date.parse(`${day}T07:00:00.000Z`), slots: [{ day, startedAt: `${day}T05:41:01.000Z` }], heartbeats: [{ day, status: 'ok', attention: [], finishedAt: `${day}T05:41:09.000Z` }], readFailed: false }));
  const out = execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/group-book-retention-monitor.ts', '--state', pathMod.join(dir, 's.json'), '--input', pathMod.join(dir, 'in.json')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(out, '', 'healthy run prints nothing');
});

console.log(`RESULT ${JSON.stringify({ results })}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
