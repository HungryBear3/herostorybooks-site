// Synthetic-only readiness scenario for the private group-book portal. Runs the
// real intake/access/withdrawal/admin-export handlers and store against the
// in-memory Blob fake (group-book-blob-faults.mjs). The real Blob SDK is never
// loaded and no network is used. This is NOT provider qualification.
// Prints one RESULT line; exits non-zero when any step fails.
import assert from 'node:assert/strict';
import sharp from 'sharp';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const A = {
  token: 'SyntheticFamilyAlphaToken000000001',
  cohortId: 'synthetic_cohort',
  familySlotId: 'synthetic_family_a',
  cohortLabel: 'Synthetic classroom',
  expiresAt: iso(NOW + 10 * DAY),
};
const B = { ...A, token: 'SyntheticFamilyBravoToken000000002', familySlotId: 'synthetic_family_b' };
const C = { ...A, token: 'SyntheticFamilyCharlieToken0000003', familySlotId: 'synthetic_family_c', expiresAt: iso(NOW - DAY) };
const D = { ...A, token: 'SyntheticFamilyDeltaToken000000004', familySlotId: 'synthetic_family_d', revokedAt: iso(NOW - DAY) };
const ADMIN_KEY = 'synthetic-admin-key-not-a-secret';

// Placeholder owner-entry fixture. Every value is visibly synthetic; it is not
// an adopted or proposed policy and must never be copied into configuration.
// Filled after imports: the code-pinned owner-adopted record.
let POLICY_V1: Record<string, unknown> = {};

process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_groupbookfixture_synthetic';
process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([A, B, C, D]);
process.env.HSB_ORDER_ADMIN_KEY = ADMIN_KEY;
delete process.env.GROUP_BOOK_INTAKE_ENABLED;
delete process.env.GROUP_BOOK_POLICY_ADOPTIONS_JSON;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.FAMILY_REVIEW_DEST_BLOB_TOKEN;

const blob = await import('./group-book-blob-faults.mjs');
const headers = await import('./group-book-next-headers.mjs');
const config = await import('../../src/lib/group-book/config.ts');
const release = await import('../../src/lib/group-book/release.ts');
const limits = await import('../../src/lib/group-book/limits.ts');
const session = await import('../../src/lib/group-book/session.ts');
const store = await import('../../src/lib/group-book/store.ts');
const exporter = await import('../../src/lib/group-book/export.ts');
{
  const adopted = release.groupBookPolicyState();
  assert.equal(adopted.state, 'adopted');
  POLICY_V1 = adopted.current.record as unknown as Record<string, unknown>;
}
const { POST: intake } = await import('../../src/app/api/group-book/intake/route.ts');
const { POST: access } = await import('../../src/app/api/group-book/access/route.ts');
const { POST: familyWithdraw } = await import('../../src/app/group-book/family/withdraw/route.ts');
const { POST: adminExport } = await import('../../src/app/api/admin/group-book/export/route.ts');

type Invite = typeof A;
type Upload = { bytes: Buffer; mime: string };

const jpeg = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#557799' } }).jpeg().toBuffer();

function openIntake() {
  process.env.GROUP_BOOK_INTAKE_ENABLED = 'true';
  process.env.GROUP_BOOK_POLICY_ADOPTIONS_JSON = JSON.stringify([POLICY_V1]);
}
// Closing the release switch leaves the adopted policy in place.
function closeIntake() {
  delete process.env.GROUP_BOOK_INTAKE_ENABLED;
}
function currentDigest(): string {
  const state = release.groupBookPolicyState();
  assert.equal(state.state, 'adopted');
  return state.current.digest;
}

function intakeRequest(invite: Invite, uploads: Upload[] = [{ bytes: jpeg, mime: 'image/jpeg' }], extra: Record<string, string> = {}): Request {
  const form = new FormData();
  const fields: Record<string, string> = {
    invite: invite.token,
    parentName: 'Synthetic Parent',
    parentEmail: 'synthetic@example.invalid',
    childFirstName: 'Synthetic Child',
    ageRange: '5-6',
    guardianAuthority: 'true',
    sharedWithParticipatingFamilies: 'true',
    sourcePhotosRemainPrivate: 'true',
    schoolApprovalNotRepresentedOrImplied: 'true',
    policyVersion: String(POLICY_V1.version),
    policyDigest: release.groupBookPolicyState().state === 'adopted' ? currentDigest() : '',
    ...extra,
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  for (const upload of uploads) form.append('photos', new File([upload.bytes], 'synthetic-upload', { type: upload.mime }));
  return new Request('https://synthetic.invalid/api/group-book/intake', { method: 'POST', body: form });
}
const accessRequest = (token: string) => new Request('https://synthetic.invalid/api/group-book/access', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: token }),
});
const exportRequest = (key: string | null, cohortId = A.cohortId) => new Request('https://synthetic.invalid/api/admin/group-book/export', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(key ? { 'x-hsb-order-admin-key': key } : {}) },
  body: JSON.stringify({ cohortId }),
});

async function reset() {
  await blob.reset();
  headers.setCookieHeader('');
  closeIntake();
  delete process.env.GROUP_BOOK_POLICY_ADOPTIONS_JSON;
}

const cookieFor = (invite: Invite) => `${session.GROUP_BOOK_ACCESS_COOKIE}=${invite.token}`;
const puts = (part: string) => blob.journal.filter((e: { op: string; pathname: string }) => e.op === 'put' && e.pathname.includes(part));
const putOrder = () => blob.journal.filter((e: { op: string }) => e.op === 'put').map((e: { pathname: string }) => e.pathname.split('/')[1]);
const deletes = () => blob.journal.filter((e: { op: string }) => e.op === 'del');

async function submitA() {
  openIntake();
  const response = await intake(intakeRequest(A));
  assert.equal(response.status, 200, 'synthetic positive control must save');
  closeIntake();
}

const results: { name: string; ok: boolean; error?: string }[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// 1. Release switch and policy adoption ---------------------------------------
await step('switch is default OFF: new intake refused before any persistence', async () => {
  await reset();
  assert.equal(release.groupBookIntakeEnabled(), false);
  process.env.GROUP_BOOK_POLICY_ADOPTIONS_JSON = JSON.stringify([POLICY_V1]);
  const response = await intake(intakeRequest(A));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'intake_closed');
  assert.equal(puts('/').length, 0);
  for (const value of ['1', 'TRUE', 'yes', ' true', '']) {
    assert.equal(release.groupBookIntakeEnabled(value), false, `"${value}" must not enable`);
  }
});

await step('policy is code-pinned: env cannot replace it; malformed adoption records are refused', async () => {
  await reset();
  process.env.GROUP_BOOK_POLICY_ADOPTIONS_JSON = JSON.stringify([{ ...POLICY_V1, finishedBookRecipients: 'ENV OVERRIDE' }]);
  const state = release.groupBookPolicyState();
  assert.equal(state.state, 'adopted');
  assert.equal(state.current.record.finishedBookRecipients, POLICY_V1.finishedBookRecipients);
  assert.equal(release.parseGroupBookPolicies([]).state, 'missing');
  for (const bad of [
    [{ ...POLICY_V1, finishedBookRecipients: '' }],
    [{ ...POLICY_V1, adoptedBy: undefined }],
    [POLICY_V1, POLICY_V1],
    [{ ...POLICY_V1, unexpected: 'x' }],
    [{ ...POLICY_V1, sourceSha256: 'nothex' }],
  ]) {
    assert.equal(release.parseGroupBookPolicies(bad).state, 'malformed');
  }
  assert.equal(puts('/').length, 0);
});

await step('access for an unsubmitted family returns the exact owner-entered policy, or a closed refusal', async () => {
  await reset();
  const closed = await access(accessRequest(A.token));
  assert.equal(closed.status, 403);
  assert.equal((await closed.json()).error, 'intake_closed');
  openIntake();
  const open = await access(accessRequest(A.token));
  assert.equal(open.status, 404);
  const body = await open.json();
  assert.equal(body.error, 'not_submitted');
  assert.equal(body.policy.digest, currentDigest());
  for (const key of ['finishedBookRecipients', 'withdrawalCutoff', 'sourcePhotoRetention', 'depictedAdultPermission', 'guardianReviewScope', 'wholeBookApproval']) {
    assert.equal(body.policy[key], (POLICY_V1 as Record<string, unknown>)[key], `${key} verbatim`);
  }
  assert.equal(open.headers.get('set-cookie'), null);
});

await step('consent to a stale or absent policy digest is refused before persistence', async () => {
  await reset();
  openIntake();
  for (const digest of ['', 'f'.repeat(64)]) {
    const response = await intake(intakeRequest(A, undefined, { policyDigest: digest }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'policy_consent_stale');
  }
  assert.equal(puts('/').length, 0);
});

await step('saved submission stamps server consent time, policy version and digest; owner written before photos', async () => {
  await reset();
  openIntake();
  const response = await intake(intakeRequest(A));
  assert.equal(response.status, 200);
  assert.deepEqual(putOrder(), ['attempts', 'photos', 'families']);
  const record = await store.findGroupBookSubmission(A);
  assert.ok(record);
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.consent.version, 'group-book-v2');
  const consent = record.consent as import('../../src/lib/group-book/store.ts').GroupBookPolicyConsent;
  assert.equal(consent.policy.version, POLICY_V1.version);
  assert.equal(consent.policy.digest, currentDigest());
  assert.equal(consent.actor, 'invite_capability_holder_self_attested');
  assert.ok(Math.abs(Date.parse(record.consent.agreedAt) - Date.now()) < 60_000);
  const attempt = puts('/attempts/')[0].pathname;
  assert.ok(attempt.startsWith(`group-book/attempts/${config.familyStorageKey(A)}/`));
  const owner = JSON.parse((await blob.bytes(attempt)).toString('utf8'));
  assert.deepEqual(owner.photoPaths, record.photos.map((p: { pathname: string }) => p.pathname));
});

await step('cookie lifetime is capped by server invite expiry (45 days is not expiry)', async () => {
  await reset();
  openIntake();
  const response = await intake(intakeRequest(A));
  const maxAge = Number((response.headers.get('set-cookie') ?? '').match(/Max-Age=(\d+)/i)?.[1]);
  assert.ok(maxAge > 0 && maxAge <= 10 * 24 * 60 * 60, `Max-Age ${maxAge} must not outlive the invite`);
});

await step('switch OFF preserves valid-capability recovery, read and withdraw of existing work', async () => {
  await reset();
  await submitA();
  const recovered = await access(accessRequest(A.token));
  assert.equal(recovered.status, 200);
  const again = await intake(intakeRequest(A));
  assert.equal(again.status, 200);
  assert.equal((await again.json()).alreadySubmitted, true);
  const before = blob.journal.length;
  headers.setCookieHeader(cookieFor(A));
  const resolved = await store.loadOwnFamilySubmission(A.token);
  assert.equal(resolved.state, 'found');
  assert.equal((await familyWithdraw()).status, 200);
  assert.equal(puts('/families/').length, 1, 'no new family record while closed');
  assert.ok(blob.journal.slice(before).every((e: { op: string; pathname: string }) => e.op !== 'put' || e.pathname.includes('/withdrawals/')));
});

// 2. Invite authority ----------------------------------------------------------
await step('missing, wrong, expired and revoked invites are refused everywhere; tokens are not URL-extracted', async () => {
  await reset();
  await submitA();
  assert.equal(config.extractGroupBookToken(`https://example.test/group-book/${A.token}`), null);
  assert.equal(config.extractGroupBookToken(`  ${A.token}\n`), A.token);
  const wrong = await access(accessRequest('X'.repeat(40)));
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error, 'invalid_invite');
  for (const [invite, error] of [[C, 'invite_expired'], [D, 'invite_revoked']] as const) {
    const response = await access(accessRequest(invite.token));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, error);
    assert.equal(response.headers.get('set-cookie'), null);
    openIntake();
    const intakeRes = await intake(intakeRequest(invite));
    assert.equal(intakeRes.status, 403);
    closeIntake();
    headers.setCookieHeader(cookieFor(invite));
    assert.equal((await familyWithdraw()).status, 404);
    assert.equal((await store.loadOwnFamilySubmission(invite.token)).state, 'unauthorized');
  }
  assert.equal(puts('/families/').length, 1);
  assert.equal((await store.loadOwnFamilySubmission('')).state, 'unauthorized');
  assert.equal(config.groupBookInvites(JSON.stringify([{ ...A, expiresAt: undefined }])).length, 0, 'expiry is required');
  assert.equal(config.groupBookInvites(JSON.stringify([{ ...A, expiresAt: 'soon' }])).length, 0);
});

await step('cross-family cookie never reads or withdraws another family', async () => {
  await reset();
  await submitA();
  headers.setCookieHeader(cookieFor(B));
  assert.equal((await familyWithdraw()).status, 404);
  const own = await store.loadOwnFamilySubmission(B.token);
  assert.equal(own.state, 'not_submitted');
  assert.equal((await store.loadEffectiveGroupBookSubmission(A))?.effectiveOmitFromProofAndPrint, false);
});

// 3. Canonical image handling / size truth --------------------------------------
await step('prepared size and request body caps fit under the Vercel 4.5 MB function body limit', async () => {
  assert.ok(limits.MAX_INTAKE_REQUEST_BYTES <= 4_500_000);
  assert.ok(limits.MAX_PREPARED_PHOTO_BYTES * limits.MAX_GROUP_BOOK_PHOTOS + 64 * 1024 <= limits.MAX_INTAKE_REQUEST_BYTES);
  assert.deepEqual([...limits.GROUP_BOOK_ACCEPTED_PHOTO_TYPES].sort(), ['image/jpeg', 'image/png', 'image/webp']);
});

await step('declared oversized body is refused before parsing or persistence', async () => {
  await reset();
  openIntake();
  const response = await intake(new Request('https://synthetic.invalid/api/group-book/intake', {
    method: 'POST',
    headers: { 'content-length': String(limits.MAX_INTAKE_REQUEST_BYTES + 1), 'content-type': 'multipart/form-data; boundary=x' },
    body: 'x',
  }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, 'request_too_large');
  assert.equal(puts('/').length, 0);
});

await step('prepared photo over cap, malformed, SVG, GIF and HEIC are refused before persistence', async () => {
  const big = Buffer.alloc(limits.MAX_PREPARED_PHOTO_BYTES + 1);
  jpeg.copy(big);
  const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary');
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'ascii'), Buffer.alloc(16)]);
  for (const [upload, status] of [
    [{ bytes: big, mime: 'image/jpeg' }, 413],
    [{ bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]), mime: 'image/jpeg' }, 422],
    [{ bytes: Buffer.from('<svg onload=alert(1)>'), mime: 'image/svg+xml' }, 415],
    [{ bytes: gif, mime: 'image/gif' }, 415],
    [{ bytes: heic, mime: 'image/heic' }, 415],
  ] as const) {
    await reset();
    openIntake();
    const response = await intake(intakeRequest(A, [upload]));
    assert.equal(response.status, status, `${upload.mime} ${upload.bytes.length}`);
    assert.equal(puts('/').length, 0, `${upload.mime}: nothing persisted`);
  }
});

// 4. Durability / ambiguity ---------------------------------------------------------
await step('owner record write failure stops before any photo write', async () => {
  await reset();
  openIntake();
  blob.faults.failPutPrefix = 'group-book/attempts/';
  const response = await intake(intakeRequest(A));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'owner_record_unconfirmed');
  assert.equal(puts('/photos/').length, 0);
  assert.equal(puts('/families/').length, 0);
});

await step('photo write failure never writes the family record; owner record keeps attribution', async () => {
  await reset();
  openIntake();
  blob.faults.failPutPrefix = 'group-book/photos/';
  const response = await intake(intakeRequest(A));
  assert.equal(response.status, 502);
  assert.equal(puts('/families/').length, 0);
  assert.equal(puts('/attempts/').length, 1);
});

await step('committed-then-throw family write reconciles to success, photos retained, no second write', async () => {
  await reset();
  openIntake();
  blob.faults.commitThenThrow = true;
  const response = await intake(intakeRequest(A));
  assert.equal(response.status, 200);
  assert.equal(puts('/families/').length, 1);
  assert.equal(deletes().length, 0);
  const record = await store.findGroupBookSubmission(A);
  assert.ok(record && (await blob.bytes(record.photos[0].pathname)));
});

await step('outage ambiguity after commit: unconfirmed, nothing deleted, no automatic repeat write; later re-entry recovers', async () => {
  await reset();
  openIntake();
  blob.faults.commitThenThrow = true;
  blob.faults.afterCommitReadKind = 'throw';
  const response = await intake(intakeRequest(A));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'record_persist_unconfirmed');
  assert.equal(puts('/families/').length, 1, 'exactly one family write attempt');
  assert.equal(deletes().length, 0);
  blob.faults.readPath = null;
  closeIntake();
  const recovered = await access(accessRequest(A.token));
  assert.equal(recovered.status, 200, 'later re-entry finds the committed record');
});

// 5. OMIT retention -----------------------------------------------------------------
await step('withdrawn family retains photos and valid own-family read; no delete issued', async () => {
  await reset();
  await submitA();
  headers.setCookieHeader(cookieFor(A));
  assert.equal((await familyWithdraw()).status, 200);
  const own = await store.loadOwnFamilySubmission(A.token);
  assert.equal(own.state, 'found');
  assert.equal(own.submission.effectiveStatus, 'withdrawal_requested');
  assert.ok(await blob.bytes(own.submission.photos[0].pathname), 'photo retained under OMIT');
  assert.equal(deletes().length, 0);
  assert.equal((await access(accessRequest(A.token))).status, 200);
});

// 6. Operator export / assembly handoff ---------------------------------------------
await step('export requires existing admin auth', async () => {
  await reset();
  assert.equal((await adminExport(exportRequest(null))).status, 401);
  assert.equal((await adminExport(exportRequest('wrong-key'))).status, 401);
});

await step('authorized export loads current participants, omits withdrawn/missing, and stays HOLD (no producer)', async () => {
  await reset();
  await submitA();
  const response = await adminExport(exportRequest(ADMIN_KEY));
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.hold, 'GROUP_BOOK_EXPORT_HOLD');
  assert.equal(body.reason, 'no_group_book_artifact_producer');
  assert.equal(body.admission.state, 'ready');
  assert.deepEqual(body.admission.eligible.map((p: { familySlotId: string }) => p.familySlotId), [A.familySlotId]);
  const statuses = Object.fromEntries(body.admission.families.map((f: { familySlotId: string; status: string }) => [f.familySlotId, f.status]));
  assert.equal(statuses[B.familySlotId], 'not_submitted');
  assert.equal(statuses[D.familySlotId], 'invite_revoked');
  assert.doesNotMatch(JSON.stringify(body), /Synthetic Parent|synthetic@example|Synthetic Child|photos\//);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(A.token));
  headers.setCookieHeader(cookieFor(A));
  await familyWithdraw();
  const after = await (await adminExport(exportRequest(ADMIN_KEY))).json();
  assert.equal(after.admission.eligible.length, 0);
});

await step('unreadable withdrawal or record makes the whole admission uncertain', async () => {
  for (const target of ['withdrawals', 'families']) {
    await reset();
    await submitA();
    blob.faults.readPath = target === 'withdrawals' ? store.groupBookWithdrawalPath(A) : store.groupBookRecordPath(A);
    blob.faults.readKind = '503';
    const admission = await exporter.loadGroupBookAdmission(A.cohortId);
    assert.equal(admission.state, 'uncertain', target);
    assert.equal(admission.eligible.length, 0);
    blob.faults.readKind = 'throw';
    assert.equal((await exporter.loadGroupBookAdmission(A.cohortId)).state, 'uncertain');
  }
});

await step('legacy unstamped (v1) record stays readable to its family but blocks admission', async () => {
  await reset();
  const legacy = { ...store.buildGroupBookSubmission({
    invite: A, parentName: 'P', parentEmail: 'p@example.invalid', childFirstName: 'C', ageRange: '5-6', characterNotes: '',
    photos: [{ assetId: 'gbp_legacy', pathname: `group-book/photos/${config.familyStorageKey(A)}/gbp_legacy.jpg`, mime: 'image/jpeg', size: 4, uploadedAt: iso(NOW), storage: 'private' }],
    policy: { version: 'legacy', digest: 'a'.repeat(64) },
  }) } as Record<string, unknown>;
  legacy.schemaVersion = 1;
  legacy.consent = { version: 'group-book-v1', agreedAt: iso(NOW), guardianAuthority: true, sharedWithParticipatingFamilies: true, sourcePhotosRemainPrivate: true, schoolApprovalNotRepresentedOrImplied: true };
  await blob.seed(store.groupBookRecordPath(A), JSON.stringify(legacy));
  assert.equal((await store.loadOwnFamilySubmission(A.token)).state, 'found');
  process.env.GROUP_BOOK_POLICY_ADOPTIONS_JSON = JSON.stringify([POLICY_V1]);
  const admission = await exporter.loadGroupBookAdmission(A.cohortId);
  assert.equal(admission.state, 'uncertain');
  assert.equal(admission.families.find((f: { familySlotId: string }) => f.familySlotId === A.familySlotId)?.status, 'policy_unstamped');
});

await step('stale snapshot: withdrawal between snapshot and publication is refused at recheck; publisher not called', async () => {
  await reset();
  await submitA();
  process.env.GROUP_BOOK_POLICY_ADOPTIONS_JSON = JSON.stringify([POLICY_V1]);
  let published = 0;
  const outcome = await exporter.assembleGroupBookExport({
    cohortId: A.cohortId,
    afterSnapshot: async () => {
      headers.setCookieHeader(cookieFor(A));
      assert.equal((await familyWithdraw()).status, 200);
    },
    publisher: async () => { published += 1; return { published: true }; },
  });
  assert.equal(outcome.state, 'refused');
  assert.equal(outcome.reason, 'participation_changed');
  assert.equal(published, 0);
});

await step('assembly positive control with synthetic publisher passes exact snapshot; null publisher is HOLD', async () => {
  await reset();
  await submitA();
  process.env.GROUP_BOOK_POLICY_ADOPTIONS_JSON = JSON.stringify([POLICY_V1]);
  let seen: unknown = null;
  const ok = await exporter.assembleGroupBookExport({
    cohortId: A.cohortId,
    publisher: async (snapshot: unknown) => { seen = snapshot; return { published: true }; },
  });
  assert.equal(ok.state, 'published');
  assert.equal((seen as { participants: unknown[] }).participants.length, 1);
  const hold = await exporter.assembleGroupBookExport({ cohortId: A.cohortId, publisher: null });
  assert.equal(hold.state, 'hold');
  assert.equal(hold.reason, 'no_group_book_artifact_producer');
});

console.log(`RESULT ${JSON.stringify({ results })}`);
process.exit(results.every((result) => result.ok) ? 0 : 1);
