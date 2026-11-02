import test from 'node:test';
import assert from 'node:assert/strict';
import {handleClassroomAuth} from '../src/lib/group-book/auth-handler.ts';
import {recordGroupBookFinalDelivery} from '../src/lib/group-book/retention.ts';

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
