// LOCAL HTTP integration only: real handlers + managed provider adapter;
// provider /user transport and private Blob are synthetic. NOT live E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import sharp from 'sharp';
import * as blob from './group-book-blob-faults.mjs';
import {setCookieHeader} from './group-book-next-headers.mjs';
import {CLASSROOM_AUTH_URL} from '../../src/lib/group-book/managed-auth.ts';
import {handleClassroomAuth} from '../../src/lib/group-book/auth-handler.ts';
import {POST as access} from '../../src/app/api/group-book/access/route.ts';
import {POST as intake} from '../../src/app/api/group-book/intake/route.ts';
import {POST as withdraw} from '../../src/app/api/group-book/withdrawal/route.ts';
import {loadOwnFamilySubmission} from '../../src/lib/group-book/store.ts';
import {SYNTHETIC_POLICY_STAMP as policy} from './group-book-policy-fixture.mjs';
const subjectA='11111111-1111-4111-8111-111111111111';
const subjectB='22222222-2222-4222-8222-222222222222';
const legacy={token:'SyntheticLegacyFamilyToken00000001',cohortId:'room_legacy',familySlotId:'legacy_a',cohortLabel:'Legacy',expiresAt:'2099-01-01T00:00:00Z'};
const bound={...legacy,token:'SyntheticBoundFamilyToken000000001',familySlotId:'bound_a',owner:{issuer:CLASSROOM_AUTH_URL,subject:subjectA}};
const classroom={token:'SyntheticClassroomSelector00000001',cohortId:'room_one',cohortLabel:'Room One',expiresAt:legacy.expiresAt};
const room2={...classroom,token:'SyntheticClassroomSelector00000002',cohortId:'room_two'};
process.env.GROUP_BOOK_INVITES_JSON=JSON.stringify([legacy,bound]);
process.env.HSB_CLASSROOM_CODES_JSON=JSON.stringify([classroom,room2]);
process.env.HSB_CLASSROOM_AUTH_ENABLED='true';
process.env.HSB_CLASSROOM_SUPABASE_PUBLISHABLE_KEY='sb_publishable_local_fixture';
process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN='vercel_blob_rw_groupbookfixture_synthetic';
process.env.GROUP_BOOK_INTAKE_ENABLED='true';
delete process.env.BLOB_READ_WRITE_TOKEN;delete process.env.FAMILY_REVIEW_DEST_BLOB_TOKEN;
const nativeFetch=globalThis.fetch;
let validations=0;
globalThis.fetch=async (url,options) => {
 assert.equal(String(url),CLASSROOM_AUTH_URL+'/user','server egress only pinned mocked /user');
 validations++;
 const token=new Headers(options?.headers).get('authorization');
 if(token!=='Bearer parentA' && token!=='Bearer parentB') return Response.json({error:'expired'},{status:401});
 return Response.json({id:token==='Bearer parentA'?subjectA:subjectB,is_anonymous:false,email_confirmed_at:'2026-01-01T00:00:00Z'});
};
const server=createServer(async (incoming,out)=>{
 try {
  const chunks=[];for await(const chunk of incoming) chunks.push(chunk);
  const url=`http://${incoming.headers.host}${incoming.url}`;
  const req=new Request(url,{method:incoming.method,headers:incoming.headers as Record<string,string>,...(incoming.method==='POST'?{body:Buffer.concat(chunks)}:{})});
  setCookieHeader(req.headers.get('cookie')??'');
  let response:Response;
  if(incoming.url==='/group-book/access') response=await access(req);
  else if(incoming.url==='/group-book/intake') response=await intake(req);
  else if(incoming.url==='/group-book/family/withdraw') response=await withdraw(req);
  else if(incoming.url==='/group-book/auth') response=await handleClassroomAuth(req,{enabled:true,publishableKey:'sb_publishable_local_fixture',secure:false});
  else {const own=await loadOwnFamilySubmission(req.headers.get('x-selector')??'',req.headers.get('cookie')??'');response=Response.json(own);}
  out.writeHead(response.status,{...Object.fromEntries(response.headers),'set-cookie':response.headers.getSetCookie()});out.end(Buffer.from(await response.arrayBuffer()));
 }catch(e){out.writeHead(500);out.end(String(e));}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
const cookie=(who:string,selector=classroom.token)=>`hsb_classroom_auth=${who}; hsb_group_book_family_access=${selector}`;
const call=(path:string,who:string,body?:object,selector=classroom.token)=>nativeFetch(origin+path,{method:'POST',headers:{origin,'content-type':'application/json',cookie:cookie(who,selector),'x-selector':selector},body:JSON.stringify(body??{})});
async function submit(who:string,selector=classroom.token){
 const f=new FormData();for(const [k,v] of Object.entries({invite:selector,parentName:'Fixture',parentEmail:'untrusted@example.invalid',childFirstName:who||'Legacy child',ageRange:'5-6',guardianAuthority:'true',sharedWithParticipatingFamilies:'true',sourcePhotosRemainPrivate:'true',schoolApprovalNotRepresentedOrImplied:'true',policyVersion:policy.version,policyDigest:policy.digest,subject:subjectB,familySlotId:'attacker-chosen'})) f.set(k,v);
 f.set('photos',new Blob([new Uint8Array(await sharp({create:{width:4,height:4,channels:3,background:'#888888'}}).jpeg().toBuffer())],{type:'image/jpeg'}),'fixture.jpg');
 return nativeFetch(origin+'/group-book/intake',{method:'POST',headers:{origin,cookie:cookie(who,selector)},body:f});
}
try {
 await test('bound legacy invite consumes online-validated session; missing and other parent denied',async()=>{
  assert.equal((await call('/group-book/access','parentA',{invite:bound.token})).status,404);
  for(const who of ['','expired','parentB']) assert.equal((await call('/group-book/access',who,{invite:bound.token})).status,403);
 });
 await test('shared classroom selector enrolls and persists separate immutable issuer/subject owners',async()=>{
  assert.equal((await submit('parentA')).status,200);assert.equal((await submit('parentB')).status,200);
  const paths=blob.paths().filter((p:string)=>p.includes('/enrollments/'));assert.equal(paths.length,2);
  const rows=await Promise.all(paths.map(async(p:string)=>JSON.parse(String(await blob.bytes(p)))));
  assert.deepEqual(new Set(rows.map(r=>r.owner.subject)),new Set([subjectA,subjectB]));
  assert.ok(rows.every(r=>r.owner.issuer===CLASSROOM_AUTH_URL && r.familySlotId!=='attacker-chosen'));
 });
 await test('authenticated re-entry and withdrawal isolate both parents and cohorts',async()=>{
  const a=await (await call('/family','parentA')).json();const b=await (await call('/family','parentB')).json();
  assert.equal(a.submission.child.firstName,'parentA');assert.equal(b.submission.child.firstName,'parentB');
  assert.notEqual(a.invite.familySlotId,b.invite.familySlotId);
  assert.notEqual((await call('/group-book/access','parentA',{invite:room2.token})).status,200);
  assert.equal((await call('/group-book/family/withdraw','parentA',{},room2.token)).status,404);
  assert.equal((await call('/group-book/family/withdraw','parentA')).status,200);
  assert.equal((await (await call('/family','parentA')).json()).submission.effectiveStatus,'withdrawal_requested');
  assert.equal((await (await call('/family','parentB')).json()).submission.effectiveStatus,'submitted');
 });
 await test('expired session and forged identity cannot enroll/read/withdraw',async()=>{
  for(const who of ['expired','']) {
   assert.equal((await submit(who)).status,403);
   assert.equal((await call('/family',who)).status,200);
   assert.equal((await (await call('/family',who)).json()).state,'unauthorized');
   assert.equal((await call('/group-book/family/withdraw',who,{subject:subjectA})).status,404);
  }
 });
 await test('legacy private capability remains usable without managed auth',async()=>{
  assert.equal((await submit('',legacy.token)).status,200);
  assert.equal((await call('/group-book/access','',{invite:legacy.token},legacy.token)).status,200);
 });
 await test('cross-origin session mutation refused before storage',async()=>{
  const before=blob.journal.length;
  const response=await nativeFetch(origin+'/group-book/access',{method:'POST',headers:{origin:'https://attacker.invalid','content-type':'application/json',cookie:cookie('parentA')},body:JSON.stringify({invite:classroom.token})});
  assert.equal(response.status,403);assert.equal(blob.journal.length,before);
 });
 await test('signout clears managed and locator cookies without provider configuration',async()=>{
  const response=await call('/group-book/auth','parentA',{action:'signout'});
  assert.equal(response.status,200);assert.match(response.headers.get('set-cookie')??'',/hsb_classroom_auth=;.*Max-Age=0/);
  assert.match(response.headers.get('set-cookie')??'',/hsb_group_book_family_access=;/);
 });
 await test('durable enrollment rejects foreign owner and uncertain reads without overwrite',async()=>{
  const paths=blob.paths().filter((p:string)=>p.includes('/enrollments/'));
  const path=paths[0];const saved=await blob.bytes(path);const row=JSON.parse(String(saved));
  const who=row.owner.subject===subjectA?'parentA':'parentB';
  await blob.del(path,{token:'synthetic'});await blob.seed(path,JSON.stringify({...row,owner:{...row.owner,subject:'foreign'}}));
  const before=blob.journal.filter((x:{op:string})=>x.op==='put').length;
  assert.equal((await call('/group-book/access',who,{invite:classroom.token})).status,403);
  assert.equal(blob.journal.filter((x:{op:string})=>x.op==='put').length,before);
  await blob.del(path,{token:'synthetic'});await blob.seed(path,saved);
  blob.faults.readPath=path;blob.faults.readKind='503';
  assert.equal((await call('/group-book/access',who,{invite:classroom.token})).status,403);
  blob.faults.readPath=null;blob.faults.readKind=null;
  assert.equal((await call('/group-book/access',who,{invite:classroom.token})).status,200);
 });
 await test('closed admission preserves enrolled re-entry while refusing new enrollment',async()=>{
  process.env.GROUP_BOOK_INTAKE_ENABLED='false';
  assert.equal((await call('/group-book/access','parentA',{invite:classroom.token})).status,200);
  const before=blob.paths().filter((p:string)=>p.includes('/enrollments/')).length;
  assert.equal((await call('/group-book/access','parentB',{invite:room2.token})).status,403);
  assert.equal(blob.paths().filter((p:string)=>p.includes('/enrollments/')).length,before);
  process.env.GROUP_BOOK_INTAKE_ENABLED='true';
 });
 await test('disabled auth, expired and revoked classroom codes deny existing ownership',async()=>{
  process.env.HSB_CLASSROOM_AUTH_ENABLED='false';
  assert.equal((await call('/group-book/access','parentA',{invite:classroom.token})).status,403);
  process.env.HSB_CLASSROOM_AUTH_ENABLED='true';
  for(const extra of [{expiresAt:'2000-01-01T00:00:00Z'},{revokedAt:'2000-01-01T00:00:00Z'}]) {
   process.env.HSB_CLASSROOM_CODES_JSON=JSON.stringify([{...classroom,...extra}]);
   assert.equal((await call('/group-book/access','parentA',{invite:classroom.token})).status,403);
  }
  process.env.HSB_CLASSROOM_CODES_JSON=JSON.stringify([classroom,room2]);
  assert.ok(validations>0);
 });
}finally{globalThis.fetch=nativeFetch;await new Promise<void>(resolve=>server.close(()=>resolve()));}
