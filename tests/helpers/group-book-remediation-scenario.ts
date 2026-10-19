// Synthetic-only regression scenario for the group-book remediation. Runs the
// real intake/withdrawal handlers and store against the in-memory Blob fake
// (through group-book-blob-faults.mjs). The real Blob SDK is never loaded.
// Prints one RESULT line; exits non-zero when any step fails.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';

const fixture = await import('./group-book-policy-fixture.mjs');
fixture.openSyntheticAdmission();
const A = {
  token: 'SyntheticFamilyAlphaToken000000001',
  cohortId: 'synthetic_cohort',
  familySlotId: 'synthetic_family_a',
  cohortLabel: 'Synthetic classroom',
  expiresAt: fixture.SYNTHETIC_EXPIRES_AT,
};
const B = {
  token: 'SyntheticFamilyBravoToken000000002',
  cohortId: 'synthetic_cohort',
  familySlotId: 'synthetic_family_b',
  cohortLabel: 'Synthetic classroom',
  expiresAt: fixture.SYNTHETIC_EXPIRES_AT,
};
process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_groupbookfixture_synthetic';
process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([A, B]);
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.FAMILY_REVIEW_DEST_BLOB_TOKEN;

const blob = await import('./group-book-blob-faults.mjs');
const headers = await import('./group-book-next-headers.mjs');
const config = await import('../../src/lib/group-book/config.ts');
const session = await import('../../src/lib/group-book/session.ts');
const store = await import('../../src/lib/group-book/store.ts');
const { POST: intake } = await import('../../src/app/api/group-book/intake/route.ts');
const { POST: apiWithdrawal } = await import('../../src/app/api/group-book/withdrawal/route.ts');
const { POST: familyWithdraw } = await import('../../src/app/group-book/family/withdraw/route.ts');

type Invite = typeof A;
type Upload = { bytes: Buffer; mime: string };

const jpeg = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#557799' } }).jpeg().toBuffer();
const png = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#335577' } }).png().toBuffer();

function intakeRequest(invite: Invite, uploads: Upload[] = [{ bytes: jpeg, mime: 'image/jpeg' }]): Request {
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
    policyVersion: String(fixture.SYNTHETIC_POLICY_STAMP.version),
    policyDigest: fixture.SYNTHETIC_POLICY_STAMP.digest,
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  for (const upload of uploads) form.append('photos', new File([upload.bytes], 'synthetic-upload', { type: upload.mime }));
  return new Request('https://synthetic.invalid/api/group-book/intake', { method: 'POST', body: form });
}

async function reset() {
  await blob.reset();
  headers.setCookieHeader('');
}

const cookieFor = (invite: Invite) => `${session.GROUP_BOOK_ACCESS_COOKIE}=${invite.token}`;
const photoPaths = () => blob.paths().filter((path: string) => path.includes('/photos/'));
const photoPuts = () => blob.journal.filter((e: { op: string; pathname: string }) => e.op === 'put' && e.pathname.includes('/photos/')).length;
const deletes = () => blob.journal.filter((e: { op: string }) => e.op === 'del').map((e: { pathname: string }) => e.pathname);

async function storedPhoto(invite: Invite): Promise<Buffer> {
  const record = await store.findGroupBookSubmission(invite);
  assert.ok(record, 'record must exist');
  const bytes = await blob.bytes(record.photos[0].pathname);
  assert.ok(bytes, 'stored photo must exist');
  return bytes;
}

async function expectRejected(uploads: Upload[], status: number | null, label: string) {
  await reset();
  const response = await intake(intakeRequest(A, uploads));
  if (status === null) assert.ok(response.status >= 400, `${label}: expected refusal, got ${response.status}`);
  else assert.equal(response.status, status, label);
  assert.equal(photoPuts(), 0, `${label}: nothing may reach private storage`);
  assert.equal(photoPaths().length, 0);
}

function pngHeaderOnly(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length, 0);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0, 0);
    return Buffer.concat([head, typed, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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

// 1. Cookie path / withdrawal target -------------------------------------
await step('cookie stays scoped to /group-book and the UI withdrawal target is inside it', async () => {
  await reset();
  const response = await intake(intakeRequest(A));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie') ?? '', /Path=\/group-book(;|$)/i);
  const button = readFileSync(new URL('../../src/app/group-book/family/withdraw-button.tsx', import.meta.url), 'utf8');
  const target = button.match(/fetch\('([^']+)'/)?.[1] ?? '';
  assert.equal(target, '/group-book/family/withdraw');
  assert.equal(familyWithdraw, apiWithdrawal, 'family route must reuse the same withdrawal handler');
});

await step('issued cookie withdraws through the family route; missing or unknown cookie is refused', async () => {
  await reset();
  assert.equal((await intake(intakeRequest(A))).status, 200);
  const markerA = store.groupBookWithdrawalPath(A);
  headers.setCookieHeader('');
  assert.equal((await familyWithdraw()).status, 404);
  headers.setCookieHeader(`${session.GROUP_BOOK_ACCESS_COOKIE}=${'X'.repeat(40)}`);
  assert.equal((await familyWithdraw()).status, 404);
  headers.setCookieHeader(cookieFor(B));
  assert.equal((await familyWithdraw()).status, 404, 'family B has no submission');
  assert.equal(blob.paths().some((path: string) => path.includes('/withdrawals/')), false);
  headers.setCookieHeader(cookieFor(A));
  const first = await familyWithdraw();
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.omitFromProofAndPrint, true);
  const second = await (await familyWithdraw()).json();
  assert.equal(second.requestedAt, firstBody.requestedAt, 'repeat withdrawal is idempotent');
  assert.ok(blob.paths().includes(markerA));
  assert.ok(!blob.paths().includes(store.groupBookWithdrawalPath(B)));
  const effective = await store.loadEffectiveGroupBookSubmission(A);
  assert.equal(effective?.effectiveStatus, 'withdrawal_requested');
  assert.equal(effective?.effectiveOmitFromProofAndPrint, true);
});

await step('family B withdrawal never changes family A', async () => {
  await reset();
  assert.equal((await intake(intakeRequest(A))).status, 200);
  assert.equal((await intake(intakeRequest(B))).status, 200);
  headers.setCookieHeader(cookieFor(B));
  assert.equal((await familyWithdraw()).status, 200);
  assert.equal((await store.loadEffectiveGroupBookSubmission(A))?.effectiveOmitFromProofAndPrint, false);
  assert.equal((await store.loadEffectiveGroupBookSubmission(B))?.effectiveOmitFromProofAndPrint, true);
});

// 2. Server-side image decode/normalize ----------------------------------
await step('truncated JPEG is refused before storage', async () => {
  await expectRejected([{ bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]), mime: 'image/jpeg' }], 422, 'truncated');
});

await step('animated WEBP is refused before storage', async () => {
  const animated = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } })
    .webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2, 'fixture must have two frames');
  await expectRejected([{ bytes: animated, mime: 'image/webp' }], 422, 'animated webp');
});

await step('oversized dimension is refused before storage', async () => {
  const wide = await sharp({ create: { width: 12_001, height: 1, channels: 3, background: '#000000' } }).png().toBuffer();
  await expectRejected([{ bytes: wide, mime: 'image/png' }], 422, 'dimension');
});

await step('header claiming too many pixels is refused before storage', async () => {
  await expectRejected([{ bytes: pngHeaderOnly(7_000, 7_000), mime: 'image/png' }], null, 'pixels');
});

await step('HEIC is refused on the server (codec not qualified)', async () => {
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'ascii'), Buffer.alloc(16)]);
  await expectRejected([{ bytes: heic, mime: 'image/heic' }], 415, 'heic');
});

await step('byte limit and declared MIME mismatch still refuse before storage', async () => {
  const big = Buffer.alloc(10 * 1024 * 1024 + 1);
  jpeg.copy(big);
  await expectRejected([{ bytes: big, mime: 'image/jpeg' }], 413, 'bytes');
  await expectRejected([{ bytes: jpeg, mime: 'image/png' }], 415, 'mime mismatch');
});

await step('one invalid photo among several stores nothing', async () => {
  await expectRejected([
    { bytes: jpeg, mime: 'image/jpeg' },
    { bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]), mime: 'image/jpeg' },
  ], 422, 'mixed');
});

await step('EXIF metadata does not survive persistence', async () => {
  await reset();
  const withExif = await sharp(jpeg).withExif({ IFD0: { ImageDescription: 'SYNTHETIC-PRIVATE-METADATA' } }).jpeg().toBuffer();
  assert.ok((await sharp(withExif).metadata()).exif, 'fixture must carry EXIF');
  assert.equal((await intake(intakeRequest(A, [{ bytes: withExif, mime: 'image/jpeg' }]))).status, 200);
  const stored = await storedPhoto(A);
  const metadata = await sharp(stored).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.exif, undefined);
  assert.equal(stored.includes(Buffer.from('SYNTHETIC-PRIVATE-METADATA')), false);
});

await step('EXIF orientation is applied, then dropped', async () => {
  await reset();
  const rotated = await sharp(jpeg).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  assert.equal((await sharp(rotated).metadata()).orientation, 6, 'fixture must carry orientation 6');
  assert.equal((await intake(intakeRequest(A, [{ bytes: rotated, mime: 'image/jpeg' }]))).status, 200);
  const metadata = await sharp(await storedPhoto(A)).metadata();
  assert.equal(metadata.width, 4);
  assert.equal(metadata.height, 8);
  assert.equal(metadata.orientation, undefined);
});

await step('appended non-image payload does not survive persistence', async () => {
  await reset();
  const tail = Buffer.from('<html>SYNTHETIC-NONIMAGE-TAIL</html>');
  assert.equal((await intake(intakeRequest(A, [{ bytes: Buffer.concat([jpeg, tail]), mime: 'image/jpeg' }]))).status, 200);
  assert.equal((await storedPhoto(A)).includes(tail), false);
});

await step('PNG with octet-stream declared type is stored as canonical JPEG', async () => {
  await reset();
  assert.equal((await intake(intakeRequest(A, [{ bytes: png, mime: 'application/octet-stream' }]))).status, 200);
  const record = await store.findGroupBookSubmission(A);
  assert.equal(record?.photos[0].mime, 'image/jpeg');
  assert.ok(record?.photos[0].pathname.endsWith('.jpg'));
  const stored = await storedPhoto(A);
  assert.equal(record?.photos[0].size, stored.byteLength);
  const metadata = await sharp(stored, { animated: true }).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.pages ?? 1, 1);
});

// 3. Withdrawal-marker read uncertainty ----------------------------------
for (const kind of ['503', 'parse', 'no-stream']) {
  await step(`withdrawal marker ${kind} read is omitted as unverified, never eligible`, async () => {
    await reset();
    assert.equal((await intake(intakeRequest(A))).status, 200);
    await store.requestGroupBookWithdrawal(A);
    blob.faults.readPath = store.groupBookWithdrawalPath(A);
    blob.faults.readKind = kind;
    const effective = await store.loadEffectiveGroupBookSubmission(A);
    assert.equal(effective?.effectiveStatus, 'withdrawal_unverified');
    assert.equal(effective?.effectiveOmitFromProofAndPrint, true);
  });
}

await step('uncertain read with no marker stored is still not eligible', async () => {
  await reset();
  assert.equal((await intake(intakeRequest(A))).status, 200);
  blob.faults.readPath = store.groupBookWithdrawalPath(A);
  blob.faults.readKind = '503';
  assert.equal((await store.loadEffectiveGroupBookSubmission(A))?.effectiveOmitFromProofAndPrint, true);
});

await step('foreign-identity or malformed marker is unverified, never eligible', async () => {
  for (const marker of [
    { schemaVersion: 1, familyStorageKey: config.familyStorageKey(B), requestedAt: new Date().toISOString(), omitFromProofAndPrint: true, reason: 'parent_requested' },
    { schemaVersion: 2 },
  ]) {
    await reset();
    assert.equal((await intake(intakeRequest(A))).status, 200);
    await blob.seed(store.groupBookWithdrawalPath(A), JSON.stringify(marker));
    const effective = await store.loadEffectiveGroupBookSubmission(A);
    assert.equal(effective?.effectiveStatus, 'withdrawal_unverified');
    assert.equal(effective?.effectiveOmitFromProofAndPrint, true);
  }
});

await step('thrown marker transport error still propagates', async () => {
  await reset();
  assert.equal((await intake(intakeRequest(A))).status, 200);
  await store.requestGroupBookWithdrawal(A);
  blob.faults.readPath = store.groupBookWithdrawalPath(A);
  blob.faults.readKind = 'throw';
  await assert.rejects(store.loadEffectiveGroupBookSubmission(A), /synthetic read transport outage/);
});

await step('proven-absent marker reads as submitted (control)', async () => {
  await reset();
  assert.equal((await intake(intakeRequest(A))).status, 200);
  const effective = await store.loadEffectiveGroupBookSubmission(A);
  assert.equal(effective?.effectiveStatus, 'submitted');
  assert.equal(effective?.effectiveOmitFromProofAndPrint, false);
});

// 4. Family-record read uncertainty --------------------------------------
await step('uncertain family record read refuses instead of reading as absent', async () => {
  await reset();
  assert.equal((await intake(intakeRequest(A))).status, 200);
  const putsBefore = photoPuts();
  blob.faults.readPath = store.groupBookRecordPath(A);
  blob.faults.readKind = '503';
  await assert.rejects(store.findGroupBookSubmission(A), { name: 'GroupBookStoreReadError' });
  const again = await intake(intakeRequest(A));
  assert.equal(again.status, 503);
  assert.equal((await again.json()).error, 'storage_unavailable');
  assert.equal(photoPuts(), putsBefore);
  headers.setCookieHeader(cookieFor(A));
  assert.equal((await familyWithdraw()).status, 503);
  assert.equal(blob.paths().some((path: string) => path.includes('/withdrawals/')), false);
});

await step('corrupt family record refuses intake before any upload', async () => {
  await reset();
  await blob.seed(store.groupBookRecordPath(A), JSON.stringify({ schemaVersion: 1 }));
  await assert.rejects(store.findGroupBookSubmission(A), { name: 'GroupBookStoreReadError' });
  assert.equal((await intake(intakeRequest(A))).status, 503);
  assert.equal(photoPuts(), 0);
});

// 5. Ambiguous create reconciliation -------------------------------------
await step('committed create with lost response keeps every referenced photo and succeeds', async () => {
  await reset();
  blob.faults.commitThenThrow = true;
  const response = await intake(intakeRequest(A, [{ bytes: jpeg, mime: 'image/jpeg' }, { bytes: png, mime: 'image/png' }]));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).alreadySubmitted, false);
  const record = await store.findGroupBookSubmission(A);
  assert.equal(record?.photos.length, 2);
  for (const photo of record!.photos) assert.ok(blob.paths().includes(photo.pathname));
  assert.deepEqual(deletes(), []);
});

for (const kind of ['503', 'throw']) {
  await step(`committed create with ${kind} reread holds photos and does not claim success`, async () => {
    await reset();
    blob.faults.commitThenThrow = true;
    blob.faults.afterCommitReadKind = kind;
    const response = await intake(intakeRequest(A));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'record_persist_unconfirmed');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(deletes(), []);
    blob.faults.readPath = null;
    const record = await store.findGroupBookSubmission(A);
    for (const photo of record!.photos) assert.ok(blob.paths().includes(photo.pathname));
  });
}

await step('create failure with no record present holds photos (durability unknown)', async () => {
  await reset();
  blob.faults.failFamilyPutBeforeCommit = true;
  const response = await intake(intakeRequest(A));
  assert.equal(response.status, 503);
  assert.deepEqual(deletes(), []);
  assert.equal(photoPaths().length, 1);
});

await step('proven foreign winner: only the losing request photos are deleted', async () => {
  await reset();
  const key = config.familyStorageKey(A);
  const winnerPhoto = {
    assetId: 'gbp_syntheticwinner',
    pathname: `group-book/photos/${key}/gbp_syntheticwinner.jpg`,
    mime: 'image/jpeg',
    size: jpeg.byteLength,
    uploadedAt: new Date().toISOString(),
    storage: 'private' as const,
  };
  await blob.seed(winnerPhoto.pathname, jpeg);
  const winner = store.buildGroupBookSubmission({
    invite: A,
    parentName: 'Synthetic Winner',
    parentEmail: 'winner@example.invalid',
    childFirstName: 'Synthetic Child',
    ageRange: '5-6',
    characterNotes: '',
    photos: [winnerPhoto],
    policy: fixture.SYNTHETIC_POLICY_STAMP,
  });
  blob.faults.preemptFamily = JSON.stringify(winner);
  const response = await intake(intakeRequest(A));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).alreadySubmitted, true);
  assert.equal((await store.findGroupBookSubmission(A))?.id, winner.id);
  assert.deepEqual(photoPaths(), [winnerPhoto.pathname]);
  const removed = deletes();
  assert.equal(removed.length, 1);
  assert.ok(!removed.includes(winnerPhoto.pathname));
});

// 6. Token hygiene --------------------------------------------------------
await step('tokens never appear in storage paths or response bodies', async () => {
  await reset();
  const response = await intake(intakeRequest(A));
  const text = await response.text();
  headers.setCookieHeader(cookieFor(A));
  const withdrawText = await (await familyWithdraw()).text();
  for (const token of [A.token, B.token]) {
    assert.ok(!text.includes(token));
    assert.ok(!withdrawText.includes(token));
    assert.ok(blob.paths().every((path: string) => !path.includes(token)));
  }
});

console.log(`RESULT ${JSON.stringify({ results })}`);
if (results.some((result) => !result.ok)) process.exitCode = 1;
