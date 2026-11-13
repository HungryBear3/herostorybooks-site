// Synthetic-only regression for the intake writer deadline (DESIGN I2/I3).
// The route aborts every photo put with a REAL AbortSignal.timeout armed for
// the remaining write window. That timer runs on the monotonic event-loop
// clock, while the route's window check reads the wall clock (Date.now), so
// the owned deadline signal can fire while the wall clock still reads before
// writeDeadline. An abort by the route's own deadline signal is deadline
// expiry (503 write_window_elapsed) whatever the wall clock says; a transport
// failure while the owned signal has not fired stays 502 private_upload_failed.
//
// The parent (node:test) spawns this same file with SCENARIO_FLAG set; the
// child installs the existing resolution hook, controls only the wall clock,
// and drives the unchanged real route, store and retention against the
// in-memory Blob fake. The timeout itself is never replaced: AbortSignal.timeout
// is observed (real signal returned) so its firing can be asserted. No network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCENARIO_FLAG = 'GROUP_BOOK_DEADLINE_REGRESSION_SCENARIO';

const CASES = [
  'D1 owned deadline signal fires while wall clock is BEFORE writeDeadline: 503 write_window_elapsed; late commit owned and swept by recurring pass',
  'D2 owned deadline signal fires with wall clock exactly AT writeDeadline: 503 write_window_elapsed; late commit owned and swept',
  'D3 owned deadline signal fires with wall clock AFTER writeDeadline: 503 write_window_elapsed; late commit owned and swept',
  'D4 generic transport failure before the deadline (owned signal not fired, same wall clock as D1): 502 private_upload_failed',
  'D5 foreign BlobRequestAbortedError-named failure before the deadline (owned signal not fired): 502 private_upload_failed',
] as const;

async function runScenario() {
  const sharp = (await import('sharp')).default;
  const DAY = 24 * 60 * 60 * 1000;
  const fixture = await import('./helpers/group-book-policy-fixture.mjs');
  const A = { token: 'SyntheticDeadAlphaToken00000000001', cohortId: 'synthetic_cohort', familySlotId: 'synthetic_family_a', cohortLabel: 'Synthetic', expiresAt: fixture.SYNTHETIC_EXPIRES_AT };
  const B = { ...A, token: 'SyntheticDeadBravoToken00000000002', familySlotId: 'synthetic_family_b' };
  const ADMIN_KEY = 'synthetic-admin-key-not-a-secret';
  process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_groupbookfixture_synthetic';
  process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([A, B]);
  process.env.HSB_ORDER_ADMIN_KEY = ADMIN_KEY;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.FAMILY_REVIEW_DEST_BLOB_TOKEN;
  delete process.env.CRON_SECRET;

  // Controlled WALL clock only: every Date.now() in the handlers reads `wall`.
  // Real timers (AbortSignal.timeout, the fake's safety timer) are untouched.
  const realNow = Date.now.bind(Date);
  let wall = realNow();
  Date.now = () => wall;

  // Observe, never replace: the route receives the real timeout signal. A
  // listener registered at creation runs before the fake's abort listener, so
  // a case can place the wall clock at the instant the real timer fires.
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeouts: { ms: number; signal: AbortSignal; wallAtAbort: number | null }[] = [];
  let atOwnedAbort: (() => void) | null = null;
  AbortSignal.timeout = (ms: number): AbortSignal => {
    const signal = realTimeout(ms);
    const entry = { ms, signal, wallAtAbort: null as number | null };
    timeouts.push(entry);
    signal.addEventListener('abort', () => {
      atOwnedAbort?.();
      entry.wallAtAbort = wall;
    }, { once: true });
    return signal;
  };

  const blob = await import('./helpers/group-book-blob-faults.mjs');
  const headers = await import('./helpers/group-book-next-headers.mjs');
  const config = await import('../src/lib/group-book/config.ts');
  const store = await import('../src/lib/group-book/store.ts');
  const limits = await import('../src/lib/group-book/limits.ts');
  const handlers = await import('../src/lib/group-book/admin-handlers.ts');
  const { POST: intake } = await import('../src/app/api/group-book/intake/route.ts');
  const W: number = limits.GROUP_BOOK_INTAKE_WRITE_WINDOW_MS;

  type Invite = typeof A;
  const jpeg = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#557799' } }).jpeg().toBuffer();
  const logs: string[] = [];
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

  function intakeRequest(invite: Invite): Request {
    const form = new FormData();
    for (const [k, v] of Object.entries({
      invite: invite.token, parentName: 'P', parentEmail: 'p@example.invalid', childFirstName: 'C', ageRange: '5-6',
      guardianAuthority: 'true', sharedWithParticipatingFamilies: 'true', sourcePhotosRemainPrivate: 'true',
      schoolApprovalNotRepresentedOrImplied: 'true', policyVersion: fixture.SYNTHETIC_POLICY_STAMP.version, policyDigest: fixture.SYNTHETIC_POLICY_STAMP.digest,
    })) form.set(k, v);
    form.append('photos', new File([jpeg], 'x0', { type: 'image/jpeg' }));
    return new Request('https://synthetic.invalid/api/group-book/intake', { method: 'POST', body: form });
  }
  const admin = (p: string, body: unknown) => new Request(`https://synthetic.invalid${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hsb-order-admin-key': ADMIN_KEY }, body: JSON.stringify(body),
  });
  const cleanup = (now: number) => handlers.retentionCleanupResponse(admin('/api/admin/group-book/retention-cleanup', { cohortId: A.cohortId }), now);
  const photosOf = (invite: Invite) => blob.paths().filter((p: string) => p.startsWith(`group-book/photos/${config.familyStorageKey(invite)}/`));
  const attemptsOf = (invite: Invite) => blob.paths().filter((p: string) => p.startsWith(`group-book/attempts/${config.familyStorageKey(invite)}/`));
  const photoPuts = () => blob.journal.filter((e: { op: string; pathname: string }) => e.op === 'put' && e.pathname.includes('/photos/'));

  async function seed() {
    await blob.reset();
    wall = realNow();
    atOwnedAbort = null;
    headers.setCookieHeader('');
    process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([A, B]);
    process.env.GROUP_BOOK_INTAKE_ENABLED = 'true';
    assert.equal((await intake(intakeRequest(A))).status, 200);
    blob.journal.length = 0;
    timeouts.length = 0;
    logs.length = 0;
  }
  async function releaseThenDeliver(): Promise<number> {
    const r = await handlers.finalReleaseResponse(admin('/api/admin/group-book/final-release', {
      cohortId: A.cohortId, channel: 'printing', attribution: 'Synthetic Operator', evidence: 'SYNTHETIC print handoff ref',
    }), wall);
    assert.equal(r.status, 200, `release ${r.status}`);
    wall += 1000;
    const d = await handlers.deliveryResponse(admin('/api/admin/group-book/delivery', {
      cohortId: A.cohortId, recordedBy: 'Synthetic Operator', evidence: 'SYNTHETIC carrier ref',
    }), wall);
    assert.equal(d.status, 200, `delivery ${d.status}`);
    return Date.parse((await d.json()).delivery.dueAt);
  }
  /** The single owner record B's attempt wrote before any photo put. */
  async function ownerOf(admittedAt: number) {
    assert.equal(attemptsOf(B).length, 1, 'exactly one owner record for the attempt');
    const owner = JSON.parse((await blob.bytes(attemptsOf(B)[0])).toString('utf8'));
    assert.equal(owner.admittedAt, new Date(admittedAt).toISOString(), 'admittedAt is the wall clock at request entry');
    assert.equal(owner.writeDeadline, new Date(admittedAt + W).toISOString());
    assert.equal(owner.photoPaths.length, 1);
    return owner as { photoPaths: string[] };
  }

  const results: { name: string; ok: boolean; error?: string }[] = [];
  async function step(name: string, fn: () => Promise<void>) {
    try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) }); }
  }

  /**
   * Admission at wall T0; the existing beforeAttemptPut hook moves the wall
   * clock to writeDeadline - 150 and then holds it, so the route arms a real
   * 150 ms timeout. The stalled photo put ends only via that real signal.
   * `wallAtFire` is where the wall clock stands when the real timer fires.
   */
  async function ownedDeadlineAbort(wallAtFire: 'before' | 'at' | 'after') {
    await seed();
    const admittedAt = wall;
    const deadline = admittedAt + W;
    blob.faults.beforeAttemptPut = async () => { wall = deadline - 150; };
    blob.faults.hangPhotoPut = true;
    atOwnedAbort = wallAtFire === 'before' ? null : () => { wall = wallAtFire === 'at' ? deadline : deadline + 1; };
    const response = await intake(intakeRequest(B));
    atOwnedAbort = null;
    const body = await response.json();

    // The real deadline signal was armed for the remaining window and fired.
    assert.equal(timeouts.length, 1, 'one real AbortSignal.timeout for the one started photo put');
    assert.equal(timeouts[0].ms, 150);
    assert.equal(timeouts[0].signal.aborted, true, 'owned deadline signal fired');
    const reason = timeouts[0].signal.reason as { name?: string } | undefined;
    assert.equal(reason?.name, 'TimeoutError', 'aborted by the real timeout, not a manual abort');
    assert.equal(timeouts[0].wallAtAbort, wallAtFire === 'before' ? deadline - 150 : wallAtFire === 'at' ? deadline : deadline + 1);
    assert.equal(photoPuts().length, 1);
    assert.ok(photoPuts().every((e: { abortSignal: boolean }) => e.abortSignal), 'photo put carried the signal');

    // No family record; the owned path is declared before the write.
    assert.equal(await store.findGroupBookSubmission(B), null, 'no family record committed');
    const owner = await ownerOf(admittedAt);
    assert.equal(photosOf(B).length, 0, 'nothing stored before the late commit');

    // Late remote commit after a complete pass lands on the exact owned key and
    // is removed by the next pass; ownership is never retired.
    const due = await releaseThenDeliver();
    const first = await (await cleanup(due)).json();
    assert.equal(first.outcome, 'complete', JSON.stringify(first));
    assert.equal(await blob.applyLateCommits(), 1);
    assert.deepEqual(photosOf(B), owner.photoPaths, 'late commit is at the owned declared key');
    const second = await (await cleanup(due + DAY)).json();
    assert.equal(second.outcome, 'complete', JSON.stringify(second));
    assert.equal(second.families.find((f: { familySlotId: string }) => f.familySlotId === B.familySlotId).deleted, 1);
    assert.equal(photosOf(B).length + photosOf(A).length, 0);
    assert.equal(attemptsOf(B).length, 1, 'declared ownership is never retired');

    // Classification last, so the safety assertions above are proven either way.
    assert.deepEqual(
      { status: response.status, error: body.error },
      { status: 503, error: 'write_window_elapsed' },
      `owned deadline abort (wall ${wallAtFire} deadline) misclassified; logs: ${JSON.stringify(logs)}`,
    );
  }

  /**
   * Same wall clock as D1 (writeDeadline - 150, real 150 ms timeout armed), but
   * the transport fails on its own before the owned signal fires. The failure
   * path is microtask-only, so the response precedes the timer deterministically.
   */
  async function predeadlineFailure(fail: () => void) {
    await seed();
    const admittedAt = wall;
    const deadline = admittedAt + W;
    blob.faults.beforeAttemptPut = async () => { wall = deadline - 150; };
    fail();
    const response = await intake(intakeRequest(B));
    const body = await response.json();
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].ms, 150);
    assert.equal(timeouts[0].signal.aborted, false, 'owned deadline signal had not fired');
    assert.ok(wall < deadline);
    assert.equal(await store.findGroupBookSubmission(B), null, 'no family record committed');
    await ownerOf(admittedAt);
    assert.equal(photosOf(B).length, 0);
    assert.deepEqual(
      { status: response.status, error: body.error },
      { status: 502, error: 'private_upload_failed' },
      `pre-deadline transport failure misclassified; logs: ${JSON.stringify(logs)}`,
    );
  }

  await step(CASES[0], () => ownedDeadlineAbort('before'));
  await step(CASES[1], () => ownedDeadlineAbort('at'));
  await step(CASES[2], () => ownedDeadlineAbort('after'));
  await step(CASES[3], () => predeadlineFailure(() => { blob.faults.failPutPrefix = 'group-book/photos/'; }));
  await step(CASES[4], () => predeadlineFailure(() => {
    blob.faults.beforePhotoPut = async () => {
      const err = new Error('synthetic foreign abort');
      err.name = 'BlobRequestAbortedError';
      throw err;
    };
  }));

  console.log(`RESULT ${JSON.stringify({ results })}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

function runChild(): { results: { name: string; ok: boolean; error?: string }[] | null; stderr: string; status: number } {
  const env = { ...process.env, [SCENARIO_FLAG]: '1' };
  delete env.NODE_TEST_CONTEXT;
  let stdout = '';
  let stderr = '';
  let status = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--import', './tests/helpers/group-book-route-register.mjs', './tests/group-book-deadline-regression.test.ts'],
      { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; status?: number };
    stdout = failed.stdout ?? '';
    stderr = failed.stderr ?? '';
    status = failed.status ?? 1;
  }
  const line = stdout.split('\n').reverse().find((row) => row.startsWith('RESULT '));
  return { results: line ? JSON.parse(line.slice('RESULT '.length)).results : null, stderr, status };
}

if (process.env[SCENARIO_FLAG] === '1') {
  await runScenario();
} else {
  const { default: test } = await import('node:test');
  let child: ReturnType<typeof runChild> | null = null;
  const run = () => (child ??= runChild());

  for (const name of CASES) {
    test(`group-book intake deadline: ${name}`, () => {
      const { results, stderr, status } = run();
      assert.ok(results, `scenario printed no RESULT line (exit ${status})\n${stderr.slice(-2000)}`);
      const row = results.find((r) => r.name === name);
      assert.ok(row, 'case did not report');
      assert.equal(row.ok, true, row.error);
    });
  }

  test('group-book intake deadline: every case reports and exit status matches', () => {
    const { results, stderr, status } = run();
    assert.ok(results, `scenario printed no RESULT line (exit ${status})\n${stderr.slice(-2000)}`);
    assert.deepEqual(results.map((r) => r.name), [...CASES]);
    assert.equal(status, results.every((r) => r.ok) ? 0 : 1);
  });
}
