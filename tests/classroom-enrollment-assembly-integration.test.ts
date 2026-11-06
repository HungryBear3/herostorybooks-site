// SYNTHETIC: verified managed enrollment -> effective withdrawal -> group-book assembly.
// Real roster/export/store modules over the existing in-memory blob fake. No provider, no network.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mock, test } from 'node:test';

const ROSTER = new URL('../src/lib/group-book/roster.ts', import.meta.url);
const TOKEN = 'vercel_blob_rw_enrollsynthetic_assemblyonly';
const FUTURE = new Date(Date.now() + 30 * 86400000).toISOString();
const COHORT = 'enroll_cohort';
const LEGACY = { token: 'SyntheticEnrollLegacyToken0000000001', cohortId: COHORT, familySlotId: 'legacy_slot', cohortLabel: 'Synthetic', expiresAt: FUTURE };
const SELECTOR = { token: 'SyntheticEnrollSelectorToken00000001', cohortId: COHORT, cohortLabel: 'Synthetic', expiresAt: FUTURE };
process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = TOKEN;
process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([LEGACY]);
process.env.HSB_CLASSROOM_CODES_JSON = JSON.stringify([SELECTOR]);
for (const name of ['BLOB_READ_WRITE_TOKEN', 'FAMILY_REVIEW_DEST_BLOB_TOKEN', 'VERCEL', 'VERCEL_ENV']) delete process.env[name];
globalThis.fetch = (async () => { throw new TypeError('synthetic_network_denied'); }) as typeof fetch;

const blobFake = await import(new URL('./helpers/blob-store-fake.mjs', import.meta.url).href);
mock.module('@vercel/blob', { namedExports: { ...blobFake, BlobStoreNotFoundError: class BlobStoreNotFoundError extends Error {} } });

test('managed enrollment joins assembly; effective withdrawal overrides base omit:false at recheck and selection', async () => {
  assert.ok(existsSync(ROSTER), 'verified-enrollment roster adapter must exist');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const roster: any = await import(ROSTER.href);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const identity: any = await import('../src/lib/group-book/identity-access.ts');
  const { CLASSROOM_AUTH_URL } = await import('../src/lib/group-book/managed-auth.ts');
  const store = await import('../src/lib/group-book/store.ts');
  const release = await import('../src/lib/group-book/release.ts');
  const exportMod = await import('../src/lib/group-book/export.ts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob: any = await import('@vercel/blob');

  const subject = 'synthetic-parent-subject';
  const slot = identity.classroomEnrollmentIdentity(COHORT, CLASSROOM_AUTH_URL, subject);
  const owner = { issuer: CLASSROOM_AUTH_URL, subject };
  await blob.put(identity.classroomEnrollmentPath(slot), JSON.stringify({ schemaVersion: 1, cohortId: COHORT, familySlotId: slot, owner }), { access: 'private', token: TOKEN, allowOverwrite: false });
  const managed = { ...SELECTOR, familySlotId: slot, owner };

  const state = release.groupBookPolicyState();
  assert.equal(state.state, 'adopted');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const current = (state as any).current;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function submit(invite: any) {
    const photo = { assetId: 'gbp_synthetic1', pathname: store.groupBookPhotoPath(invite, 'gbp_synthetic1', 'jpg'), mime: 'image/jpeg', size: 4, uploadedAt: new Date().toISOString(), storage: 'private' as const };
    await blob.put(photo.pathname, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { access: 'private', token: TOKEN, allowOverwrite: false });
    const record = store.buildGroupBookSubmission({ invite, parentName: 'SYNTHETIC', parentEmail: 'synthetic@example.invalid', childFirstName: 'SYNTH', ageRange: '5-6', characterNotes: 'SYNTHETIC', photos: [photo], policy: { version: current.record.version, digest: current.digest } });
    assert.equal(await store.createGroupBookSubmission(record), true);
  }
  await submit(LEGACY);
  await submit(managed);

  const listed = await roster.loadClassroomRoster(COHORT);
  assert.equal(listed.state, 'complete', JSON.stringify(listed));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.deepEqual(listed.invites.map((i: any) => i.familySlotId).sort(), [LEGACY.familySlotId, slot].sort());

  const admission = await exportMod.loadGroupBookAdmission(COHORT);
  assert.equal(admission.state, 'ready');
  assert.deepEqual(admission.eligible.map((p) => p.familySlotId).sort(), [LEGACY.familySlotId, slot].sort(), 'real managed family, not a fake invite');

  let published = 0;
  const changed = await exportMod.assembleGroupBookExport({
    cohortId: COHORT,
    publisher: async () => { published += 1; return { published: true as const }; },
    afterSnapshot: async () => { await store.requestGroupBookWithdrawal(managed); },
  });
  assert.equal(changed.state, 'refused');
  assert.equal((changed as { reason?: string }).reason, 'participation_changed', 'withdrawal between snapshot and publication refuses');
  assert.equal(published, 0, 'nothing published');

  const base = await store.findGroupBookSubmission(managed);
  assert.equal(base?.omitFromProofAndPrint, false, 'immutable base record unchanged');
  const effective = await store.loadEffectiveGroupBookSubmission(managed);
  assert.equal(effective?.effectiveOmitFromProofAndPrint, true, 'overlay authoritative');

  const after = await exportMod.loadGroupBookAdmission(COHORT);
  assert.equal(after.families.find((f) => f.familySlotId === slot)?.status, 'withdrawn');
  assert.deepEqual(after.eligible.map((p) => p.familySlotId), [LEGACY.familySlotId]);

  const final = await exportMod.assembleGroupBookExport({ cohortId: COHORT, publisher: async () => ({ published: true as const }) });
  assert.equal(final.state, 'published');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.deepEqual((final as any).snapshot.participants.map((p: any) => p.familySlotId), [LEGACY.familySlotId]);
});
