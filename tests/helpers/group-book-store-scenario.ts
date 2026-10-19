import assert from 'node:assert/strict';

process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_groupbook_secret123';
process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_orders_secret456';
process.env.FAMILY_REVIEW_DEST_BLOB_TOKEN = 'vercel_blob_rw_family_secret789';

const blob = await import('./group-book-blob-fake.mjs');
const store = await import('../../src/lib/group-book/store.ts');

const invite = {
  token: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  cohortId: 'cohort_alpha',
  familySlotId: 'family_one',
  cohortLabel: 'Private classroom keepsake',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

const photo = await store.uploadGroupBookPhoto({
  invite,
  bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
  mime: 'image/jpeg',
  ext: 'jpg',
});
const record = store.buildGroupBookSubmission({
  invite,
  parentName: 'Test Parent',
  parentEmail: 'PARENT@EXAMPLE.COM',
  childFirstName: 'Test Child',
  ageRange: '5-6',
  characterNotes: 'Synthetic-only fixture.',
  photos: [photo],
  policy: { version: 'synthetic-v1', digest: 'a'.repeat(64) },
  now: new Date('2026-10-07T20:00:00.000Z'),
});
assert.equal(await store.createGroupBookSubmission(record), true);
assert.equal(await store.createGroupBookSubmission(record), false, 'family record is create-only');

const loaded = await store.loadEffectiveGroupBookSubmission(invite);
assert.equal(loaded?.parent.email, 'parent@example.com');
assert.equal(loaded?.effectiveOmitFromProofAndPrint, false);
const first = await store.requestGroupBookWithdrawal(invite, new Date('2026-10-07T21:00:00.000Z'));
const second = await store.requestGroupBookWithdrawal(invite, new Date('2026-10-07T22:00:00.000Z'));
assert.equal(first.created, true);
assert.equal(second.created, false);
assert.equal(second.requestedAt, first.requestedAt, 'repeat withdrawal is idempotent');
const withdrawn = await store.loadEffectiveGroupBookSubmission(invite);
assert.equal(withdrawn?.effectiveStatus, 'withdrawal_requested');
assert.equal(withdrawn?.effectiveOmitFromProofAndPrint, true);

assert.ok(blob.paths().every((path) => path.startsWith('group-book/')));
assert.ok(blob.paths().every((path) => !path.includes(invite.token)));
assert.ok(blob.journal.every((entry) => entry.explicitToken === true));
assert.ok(blob.journal.filter((entry) => entry.op === 'put').every((entry) => entry.access === 'private'));
assert.ok(blob.journal.filter((entry) => entry.op === 'put').every((entry) => entry.allowOverwrite === false));

console.log(JSON.stringify({
  paths: blob.paths(),
  operations: blob.journal.length,
  effectiveStatus: withdrawn?.effectiveStatus,
}));
