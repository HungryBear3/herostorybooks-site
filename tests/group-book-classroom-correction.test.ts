import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
// The real private store is never reached: the existing in-memory fake stands
// in for @vercel/blob before retention (and its store) is imported.
const blobFake=await import(new URL('./helpers/group-book-blob-fake.mjs',import.meta.url).href);
mock.module('@vercel/blob',{namedExports:{...blobFake,BlobStoreNotFoundError:class BlobStoreNotFoundError extends Error {}}});
const {handleClassroomAuth}=await import('../src/lib/group-book/auth-handler.ts');
const {recordGroupBookFinalDelivery,recordGroupBookFinalRelease,groupBookPhotoAvailability}=await import('../src/lib/group-book/retention.ts');
const DAY=24*60*60*1000;

const selector={token:'SyntheticClassroomSelector00000001',cohortId:'room_one',cohortLabel:'Room One',expiresAt:'2099-01-01T00:00:00Z'};
const args={cohortId:selector.cohortId,recordedBy:'Synthetic operator',evidence:'Synthetic delivery',now:1792821500000};
process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN='vercel_blob_rw_groupbookfixture_synthetic';
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.FAMILY_REVIEW_DEST_BLOB_TOKEN;

test('validated classroom-only cohort reaches existing release prerequisite',async()=>{
 process.env.GROUP_BOOK_INVITES_JSON='[]';
 process.env.HSB_CLASSROOM_CODES_JSON=JSON.stringify([selector]);
 assert.deepEqual(await recordGroupBookFinalDelivery(args),{outcome:'release_not_recorded'});
});
test('legacy cohort retains existing release prerequisite',async()=>{
 process.env.HSB_CLASSROOM_CODES_JSON='[]';
 process.env.GROUP_BOOK_INVITES_JSON=JSON.stringify([{...selector,familySlotId:'legacy_a'}]);
 assert.deepEqual(await recordGroupBookFinalDelivery(args),{outcome:'release_not_recorded'});
});
test('malformed, ambiguous and owner-bearing selectors cannot authorize retention',async()=>{
 process.env.GROUP_BOOK_INVITES_JSON='[]';
 for(const rows of [[{...selector,token:'bad'}],[selector,selector],[{...selector,owner:{}}],[{...selector,familySlotId:'injected'}],[],[{...selector,cohortId:'../bad'}]]) {
  process.env.HSB_CLASSROOM_CODES_JSON=JSON.stringify(rows);
  assert.deepEqual(await recordGroupBookFinalDelivery(args),{outcome:'invalid',error:'unknown_cohort'});
 }
});
for(const enabled of [false,true]) test(`same-origin signout clears both cookies with missing key and enabled=${enabled}`,async()=>{
 let calls=0;
 const fetcher:typeof fetch=async()=>{calls++;throw Error('provider forbidden');};
 const req=new Request('https://hsb.example.test/group-book/auth',{method:'POST',headers:{origin:'https://hsb.example.test','content-type':'application/json'},body:JSON.stringify({action:'signout'})});
 const response=await handleClassroomAuth(req,{enabled,publishableKey:'',secure:true},fetcher);
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{ok:true});
 assert.deepEqual(response.headers.getSetCookie(),['hsb_classroom_auth','hsb_group_book_family_access'].map(name=>`${name}=; HttpOnly; SameSite=Strict; Path=/group-book; Max-Age=0; Secure`));
 assert.equal(calls,0);
});
test('disabled signout preserves origin and request validation with zero provider calls',async()=>{
 let calls=0;const fetcher:typeof fetch=async()=>{calls++;throw Error('provider forbidden');};
 for(const [origin,body,status] of [['https://evil.test','{"action":"signout"}',403],['https://hsb.example.test','{',400]] as const){
  const response=await handleClassroomAuth(new Request('https://hsb.example.test/group-book/auth',{method:'POST',headers:{origin,'content-type':'application/json'},body}),{enabled:false,publishableKey:'',secure:true},fetcher);
  assert.equal(response.status,status);assert.equal(response.headers.get('set-cookie'),null);
 }
 assert.equal(calls,0);
});
test('malformed, non-array, duplicate, owner-bearing or legacy-overlapping selectors fail closed even for a valid legacy cohort',async()=>{
 process.env.GROUP_BOOK_INVITES_JSON=JSON.stringify([{...selector,familySlotId:'legacy_a'}]);
 const other={...selector,token:'SyntheticClassroomSelector00000002',cohortId:'room_two'};
 for(const raw of ['{not json','{}','"x"',JSON.stringify([other,{...other,cohortId:'room_three'}]),JSON.stringify([{...other,owner:{issuer:'https://issuer.example.invalid',subject:'s'}}]),JSON.stringify([{...selector,cohortId:'room_two'}])]) {
  process.env.HSB_CLASSROOM_CODES_JSON=raw;
  assert.deepEqual(await recordGroupBookFinalDelivery(args),{outcome:'invalid',error:'unknown_cohort'},raw);
 }
});
test('malformed legacy configuration fails closed even for a valid classroom cohort',async()=>{
 process.env.GROUP_BOOK_INVITES_JSON='{bad';
 process.env.HSB_CLASSROOM_CODES_JSON=JSON.stringify([selector]);
 assert.deepEqual(await recordGroupBookFinalDelivery(args),{outcome:'invalid',error:'unknown_cohort'});
});
test('expired or revoked selector still anchors lifecycle at the existing release prerequisite',async()=>{
 process.env.GROUP_BOOK_INVITES_JSON='[]';
 process.env.HSB_CLASSROOM_CODES_JSON=JSON.stringify([{...selector,expiresAt:'2000-01-01T00:00:00Z',revokedAt:'2000-01-01T00:00:00Z'}]);
 assert.deepEqual(await recordGroupBookFinalDelivery(args),{outcome:'release_not_recorded'});
});
test('authoritative release then FINAL delivery: before-release refusal, replay, conflict and server-time 90-day boundary',async()=>{
 const life={...selector,token:'SyntheticClassroomSelector00000009',cohortId:'room_life'};
 process.env.GROUP_BOOK_INVITES_JSON='[]';
 process.env.HSB_CLASSROOM_CODES_JSON=JSON.stringify([life]);
 const base={cohortId:life.cohortId,recordedBy:'Synthetic operator',evidence:'Synthetic delivery'};
 const released=await recordGroupBookFinalRelease({cohortId:life.cohortId,channel:'printing',attribution:'Synthetic operator',evidence:'Synthetic print ref',now:args.now});
 assert.equal(released.outcome,'recorded');
 assert.deepEqual(await recordGroupBookFinalDelivery({...base,now:args.now-1}),{outcome:'invalid',error:'delivered_before_release'});
 const delivered=await recordGroupBookFinalDelivery({...base,now:args.now+1000});
 assert.equal(delivered.outcome,'recorded');
 const due=args.now+1000+90*DAY;
 assert.equal(Date.parse(delivered.record.dueAt),due);
 assert.equal((await recordGroupBookFinalDelivery({...base,now:args.now+5000})).outcome,'replayed');
 assert.equal((await recordGroupBookFinalDelivery({...base,evidence:'Different synthetic delivery',now:args.now+5000})).outcome,'conflict');
 assert.equal((await groupBookPhotoAvailability(life.cohortId,due-1)).state,'retained');
 assert.equal((await groupBookPhotoAvailability(life.cohortId,due)).state,'expired');
});
