import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import * as blob from './group-book-blob-faults.mjs';
import * as store from '../../src/lib/group-book/store.ts';
import { familyStorageKey } from '../../src/lib/group-book/config.ts';
import { POST as intake } from '../../src/app/api/group-book/intake/route.ts';

const A = {token:'SyntheticFamilyAlphaToken000000001',cohortId:'synthetic_cohort',familySlotId:'synthetic_family_a',cohortLabel:'Synthetic classroom'};
process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_groupbookfixture_synthetic';
process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([A]);
const jpeg = await sharp({create:{width:8,height:8,channels:3,background:'#456789'}}).jpeg().toBuffer();
const key = familyStorageKey(A);
async function fixture() {
  await blob.reset();
  const photo = {assetId:'gbp_winner',pathname:`group-book/photos/${key}/gbp_winner.jpg`,mime:'image/jpeg',size:jpeg.length,uploadedAt:new Date().toISOString(),storage:'private'};
  await blob.seed(photo.pathname,jpeg);
  const record = store.buildGroupBookSubmission({invite:A,parentName:'Synthetic',parentEmail:'synthetic@example.invalid',childFirstName:'Synthetic',ageRange:'5-6',characterNotes:'',photos:[photo]});
  return record;
}
function contradict(record, kind) {
  if (kind !== 'slot-only') record.cohort.id = 'foreign_cohort';
  if (kind !== 'cohort-only') record.cohort.familySlotId = 'foreign_family';
  assert.equal(record.familyStorageKey, key, 'adversarial record retains matching key');
  return record;
}
async function post() {
  const form = new FormData();
  for (const [k,v] of Object.entries({invite:A.token,parentName:'Synthetic',parentEmail:'synthetic@example.invalid',childFirstName:'Synthetic',ageRange:'5-6',guardianAuthority:'true',sharedWithParticipatingFamilies:'true',sourcePhotosRemainPrivate:'true',schoolApprovalNotRepresentedOrImplied:'true'})) form.set(k,v);
  form.set('photos',new File([jpeg],'synthetic.jpg',{type:'image/jpeg'}));
  const response = await intake(new Request('https://synthetic.invalid/api/group-book/intake',{method:'POST',body:form}));
  return {status:response.status,body:await response.json()};
}
for (const kind of ['cohort-only','slot-only','both']) {
  test(`${kind}: direct read refuses matching-key contradictory identity`, async () => {
    const winner = contradict(await fixture(), kind);
    await blob.seed(store.groupBookRecordPath(A),JSON.stringify(winner));
    await assert.rejects(store.findGroupBookSubmission(A),store.GroupBookStoreReadError);
  });
  for (const sameId of [false,true]) {
    test(`${kind}: reconciliation refuses ${sameId ? 'same-id' : 'competing'} inconsistent winner`, async () => {
      const record = await fixture();
      const winner = contradict(structuredClone(record),kind);
      if (!sameId) winner.id = 'gbs_competitor';
      blob.faults.preemptFamily = JSON.stringify(winner);
      assert.deepEqual(await store.createOrReconcileGroupBookSubmission(A,record),{outcome:'unconfirmed'});
      assert.equal(blob.journal.filter(e=>e.op==='del').length,0);
      assert.deepEqual(await blob.bytes(record.photos[0].pathname),jpeg);
    });
  }
  test(`${kind}: real intake refuses and preserves every uploaded asset`, async () => {
    const winner = contradict(await fixture(),kind);
    blob.faults.preemptFamily = JSON.stringify(winner);
    const result = await post();
    const photoPaths = blob.paths().filter(p=>p.includes('/photos/'));
    const deletes = blob.journal.filter(e=>e.op==='del').length;
    console.log('IDENTITY_ROUTE',JSON.stringify({kind,...result,deletes,photoCount:photoPaths.length}));
    assert.equal(result.status,503,'contradictory winner must not report success');
    assert.notEqual(result.body.alreadySubmitted,true);
    assert.equal(deletes,0,'unconfirmed durability never permits cleanup');
    assert.equal(photoPaths.length,2,'winner and request asset both retained');
    for (const pathname of photoPaths) assert.ok((await blob.bytes(pathname))?.length);
    await assert.rejects(store.findGroupBookSubmission(A),store.GroupBookStoreReadError);
  });
}
test('consistent same-key stored identity is readable',async()=>{
  const record=await fixture();
  await blob.seed(store.groupBookRecordPath(A),JSON.stringify(record));
  assert.deepEqual(await store.findGroupBookSubmission(A),record);
});
test('consistent competing winner still succeeds and cleans only losing asset',async()=>{
  const winner=await fixture();
  blob.faults.preemptFamily=JSON.stringify(winner);
  const result=await post();
  assert.equal(result.status,200);
  assert.equal(result.body.alreadySubmitted,true);
  assert.equal(blob.journal.filter(e=>e.op==='del').length,1);
  assert.deepEqual(blob.paths().filter(p=>p.includes('/photos/')),[winner.photos[0].pathname]);
  assert.deepEqual(await blob.bytes(winner.photos[0].pathname),jpeg);
});
test('same-key own commit with lost response succeeds without asset deletion',async()=>{
  await blob.reset();
  blob.faults.commitThenThrow=true;
  const result=await post();
  assert.equal(result.status,200);
  assert.notEqual(result.body.alreadySubmitted,true);
  assert.equal(blob.journal.filter(e=>e.op==='del').length,0);
  const record=await store.findGroupBookSubmission(A);
  assert.equal(record.cohort.id,A.cohortId);
  assert.equal(record.cohort.familySlotId,A.familySlotId);
  assert.ok((await blob.bytes(record.photos[0].pathname))?.length);
});
