import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import * as blob from './helpers/group-book-blob-faults.mjs';
import * as identity from '../src/lib/group-book/identity-access.ts';
import * as store from '../src/lib/group-book/store.ts';
import * as retention from '../src/lib/group-book/retention.ts';
import * as handlers from '../src/lib/group-book/admin-handlers.ts';
import { groupBookPolicyState } from '../src/lib/group-book/release.ts';
import { POST as intake } from '../src/app/group-book/intake/route.ts';
import { loadClassroomRoster } from '../src/lib/group-book/roster.ts';
import * as pilot from '../src/lib/group-book/pilot-retention.ts';
import * as monitor from '../src/lib/group-book/retention-monitor.ts';
import { GET as cron } from '../src/app/api/cron/group-book-retention-sweep/route.ts';
import * as pilotRoute from '../src/app/api/admin/group-book/pilot-close/route.ts';
import { familyStorageKey } from '../src/lib/group-book/config.ts';

const DAY=86400000;
const selector={token:'SyntheticManagedPilotSelector00000001',cohortId:'fresh_managed_pilot',cohortLabel:'Synthetic',expiresAt:'2099-01-01T00:00:00.000Z',purpose:'pilot_test_only' as const};
const cookie='hsb_classroom_auth=synthetic-session';
const subject='11111111-2222-4333-8444-555555555555';
let clock=Date.parse('2026-11-01T12:00:00.000Z');
const realNow=Date.now;
const realFetch=globalThis.fetch;
const admin=(body:object,key=true)=>new Request('https://synthetic.invalid/api/admin/group-book/pilot-close',{method:'POST',headers:{'content-type':'application/json',...(key?{'x-hsb-order-admin-key':'synthetic-admin'}:{})},body:JSON.stringify(body)});
async function request(token=selector.token,managed=true) {
 const policy=groupBookPolicyState(); assert.equal(policy.state,'adopted');
 const f=new FormData();
 for(const [k,v] of Object.entries({invite:token,parentName:'Synthetic',parentEmail:'p@example.invalid',childFirstName:'Synthetic',ageRange:'5-6',guardianAuthority:'true',sharedWithParticipatingFamilies:'true',sourcePhotosRemainPrivate:'true',schoolApprovalNotRepresentedOrImplied:'true',policyVersion:policy.current.record.version,policyDigest:policy.current.digest})) f.set(k,v);
 const bytes=await sharp({create:{width:4,height:4,channels:3,background:'#abcdef'}}).jpeg().toBuffer();
 f.append('photos',new File([bytes],'fixture.jpg',{type:'image/jpeg'}));
 return new Request('https://synthetic.invalid/group-book/intake',{method:'POST',headers:managed?{cookie,origin:'https://synthetic.invalid'}:{},body:f});
}
function setup(purpose='pilot_test_only') {
 process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN='vercel_blob_rw_groupbookfixture_synthetic';
 process.env.GROUP_BOOK_INVITES_JSON='[]';
 process.env.HSB_CLASSROOM_CODES_JSON=JSON.stringify([{...selector,purpose}]);
 process.env.HSB_CLASSROOM_AUTH_ENABLED='true';
 process.env.HSB_CLASSROOM_SUPABASE_PUBLISHABLE_KEY='sb_publishable_synthetic';
 process.env.GROUP_BOOK_INTAKE_ENABLED='true';
 process.env.HSB_ORDER_ADMIN_KEY='synthetic-admin';
 Date.now=()=>clock;
 globalThis.fetch=async(url)=>{
  assert.equal(String(url),'https://uedeigimwdabjlereedy.supabase.co/auth/v1/user');
  return Response.json({id:subject,is_anonymous:false,email_confirmed_at:'2026-01-01T00:00:00Z'});
 };
}

test('managed selector-only pilot binds purpose before photos, closes and sweeps through real lifecycle',async()=>{
 try {
  await blob.reset(); setup();
  const resolved=await identity.resolveGroupBookSessionInvite(selector.token,cookie,true);
  assert.equal(resolved.state,'active');
  const roster=await loadClassroomRoster(selector.cohortId); assert.equal(roster.state,'complete'); assert.equal(roster.invites.length,1);
  assert.equal((await intake(await request())).status,200);
  const record=await store.findGroupBookSubmission(resolved.invite); assert.ok(record);
  assert.equal(record.pilot?.purpose,'pilot_test_only','OLD BEHAVIOR: managed pilot photos were persisted without immutable pilot purpose');
  const firstPhoto=blob.journal.findIndex(e=>e.op==='put'&&e.pathname.includes('/photos/'));
  assert.ok(blob.journal.slice(0,firstPhoto).some(e=>e.op==='put'&&e.pathname===`group-book/purposes/${selector.cohortId}.json`));
  const closeBody={cohortId:selector.cohortId,mode:'test_only',recordedBy:'Synthetic',evidence:'Synthetic actual close'};
  assert.equal(pilotRoute.runtime,'nodejs'); assert.equal(pilotRoute.dynamic,'force-dynamic');
  const close=pilotRoute.POST;
  const operations=blob.journal.length;
  assert.equal((await close(admin(closeBody,false))).status,401);
  assert.equal(blob.journal.length,operations,'actual HTTP export authenticates before storage');
  assert.equal((await close(admin({...closeBody,pilotClosedAt:'2020-01-01'}))).status,422);
  assert.equal((await close(admin({...closeBody,now:'2020-01-01'}))).status,422);
  const first=await close(admin(closeBody)); assert.equal(first.status,200); const closed=await first.json();
  assert.equal(closed.pilot.pilotClosedAt,new Date(clock).toISOString(),'actual route supplies server clock');
  assert.equal(first.headers.get('cache-control'),'no-store, private');
  assert.equal(Date.parse(closed.pilot.deadlineAt),clock+7*DAY);
  clock+=DAY;
  assert.equal((await close(admin({...closeBody,retentionDays:8}))).status,422);
  assert.equal((await (await close(admin(closeBody))).json()).pilot.deadlineAt,closed.pilot.deadlineAt);
  clock+=45001;
  const swept=await retention.runGroupBookRetentionSweep(clock); assert.equal(swept.counts.deleted,1);
  assert.equal(blob.paths().includes(record.photos[0].pathname),false);
  assert.ok(await store.findGroupBookSubmission(resolved.invite),'consent summary survives');
  assert.equal((await retention.openGroupBookSourcePhoto(resolved.invite,record.photos[0].assetId,clock)).state,'expired');
  assert.equal(await store.createGroupBookAttempt(resolved.invite,'gbs_late',store.planGroupBookPhotos(resolved.invite,[{bytes:Buffer.from('synthetic'),mime:'image/jpeg',ext:'jpg'}]),{admittedAt:clock,writeDeadline:clock+45000}),null);
 } finally {Date.now=realNow;globalThis.fetch=realFetch;}
});

const closeBody=()=>({cohortId:selector.cohortId,mode:'test_only',recordedBy:'Synthetic',evidence:'Synthetic actual close'});
async function enroll() {
 const r=await identity.resolveGroupBookSessionInvite(selector.token,cookie,true); assert.equal(r.state,'active'); return r.invite;
}
async function fresh(purpose='pilot_test_only') {await blob.reset();clock=Date.parse('2026-11-01T12:00:00.000Z');setup(purpose);}
function restore() {Date.now=realNow;globalThis.fetch=realFetch;}
const photos=()=>blob.paths().filter(p=>p.startsWith('group-book/photos/'));

function principalNumber(n:number) {
 globalThis.fetch=async(url)=>{
  assert.equal(String(url),'https://uedeigimwdabjlereedy.supabase.co/auth/v1/user');
  return Response.json({id:`11111111-2222-4333-8444-${String(n).padStart(12,'0')}`,is_anonymous:false,email_confirmed_at:'2026-01-01T00:00:00Z'});
 };
}

test('B1 actual close-before-put race covers a newly acknowledged managed family outside its snapshot',async()=>{
 try {
  await fresh();principalNumber(1);const a=await enroll();assert.equal((await intake(await request())).status,200);
  let reached!:()=>void;let resume!:()=>void;
  const entered=new Promise<void>(r=>{reached=r;});const paused=new Promise<void>(r=>{resume=r;});
  blob.faults.beforePilotClosePut=async()=>{reached();await paused;};
  const closing=pilotRoute.POST(admin(closeBody()));await entered;
  principalNumber(2);const b=await enroll();assert.equal((await intake(await request())).status,200);
  assert.notEqual(a.familySlotId,b.familySlotId);assert.equal(photos().length,2);
  resume();assert.equal((await closing).status,200);
  const closed=await pilot.loadGroupBookPilotCloseState(selector.cohortId);assert.equal(closed.state,'closed');
  assert.deepEqual(closed.record.familySlotIds,[a.familySlotId],'fixture pauses after actual roster snapshot');
  clock+=DAY;
  const swept=await retention.runGroupBookRetentionSweep(clock);
  assert.deepEqual(photos(),[],'B1: both valid matching-registration owned families must be reaped');
  assert.equal(swept.counts.deleted,2);
  const mismatched=structuredClone((await store.findGroupBookSubmission(a))!);
  mismatched.cohort.familySlotId='synthetic_mismatch';
  mismatched.familyStorageKey=familyStorageKey({cohortId:selector.cohortId,familySlotId:'synthetic_mismatch'});
  mismatched.pilot!.registrationId='gbreg_FOREIGNREGISTRATION';
  mismatched.photos[0].pathname=`group-book/photos/${mismatched.familyStorageKey}/${mismatched.photos[0].assetId}.jpg`;
  await blob.seed(`group-book/families/${mismatched.familyStorageKey}.json`,JSON.stringify(mismatched));
  await blob.seed(mismatched.photos[0].pathname,Buffer.from('synthetic foreign stamp'));
  const held=await retention.runGroupBookRetentionSweep(clock+DAY);
  assert.ok(held.counts.held>=1);assert.ok(held.attention.includes('held_unknown_scope'));
  assert.deepEqual(photos(),[mismatched.photos[0].pathname],'mismatched registration is never deletion authority');
 } finally {restore();}
});

test('REPLACEMENT frozen capacity contract: eight admitted families expose minimum-budget backlog honestly',async()=>{
 try {
  await fresh();process.env.GROUP_BOOK_SWEEP_FAMILY_BUDGET='1';
  // Close ten seconds before cron: the writer grace skips that first run,
  // leaving only SIX daily opportunities strictly within the seven days.
  clock=Date.parse('2026-11-01T05:40:50.000Z');
  let accepted=0;
  for(let n=1;n<=8;n++) {
   principalNumber(n);const response=await intake(await request());
   if(response.status===200) accepted++; else assert.ok(response.status>=400);
  }
  assert.ok(accepted>0);const closedAt=clock;
  assert.equal((await pilotRoute.POST(admin(closeBody()))).status,200);
  process.env.CRON_SECRET='synthetic-cron';
  const deletedPerDay:number[]=[];
  for(let day=0;day<=6;day++) {
   clock=Date.parse(`2026-11-${String(1+day).padStart(2,'0')}T05:41:00.000Z`);
   const response=await cron(new Request('https://synthetic.invalid/api/cron/group-book-retention-sweep',{headers:{authorization:'Bearer synthetic-cron'}}));
   const body=await response.json();assert.ok(body.counts.families<=1,'existing global family action budget preserved');
   deletedPerDay.push(body.counts.deleted);
  }
  assert.ok(clock<closedAt+7*DAY);
  // Explicit replacement of superseded six-lifetime-slot capacity assertions.
  assert.equal(accepted,8,'configured pilot admission is not a permanent global cap');
  assert.equal(photos().length,2,'six eligible actions cannot erase eight families; backlog is truthful');
  clock=closedAt+7*DAY;
  const overdue=await retention.runGroupBookRetentionSweep(clock);
  assert.ok(overdue.attention.includes('overdue_owned_work'));
  assert.ok(overdue.attention.includes('incomplete_budget'));
  clock+=DAY;await retention.runGroupBookRetentionSweep(clock);
  assert.deepEqual(photos(),[],'continued bounded service drains the remaining owned backlog');
  console.log('B2_WORKLOAD',JSON.stringify({accepted,rejected:8-accepted,deletedPerDay,remaining:photos().length,deadline:new Date(closedAt+7*DAY).toISOString(),lastRun:new Date(clock).toISOString()}));
 } finally {delete process.env.GROUP_BOOK_SWEEP_FAMILY_BUDGET;restore();}
});

test('REPLACEMENT frozen capacity contract: uncapped cohorts and ordinary fullbook share bounded service',async()=>{
 try {
  await fresh();process.env.GROUP_BOOK_SWEEP_FAMILY_BUDGET='1';
  const second={...selector,token:'SyntheticSecondPilotSelector00000001',cohortId:'second_managed_pilot'};
  process.env.HSB_CLASSROOM_CODES_JSON=JSON.stringify([selector,second]);
  let accepted=0;
  for(let n=1;n<=8;n++) {
   principalNumber(n);const response=await intake(await request(n<=4?selector.token:second.token));
   if(response.status===200) accepted++;else assert.ok(response.status>=400);
  }
  assert.equal(accepted,8,'explicit replacement: no six-family lifetime bound across cohorts');
  const legacy={...selector,token:'SyntheticFullbookCompetition00000001',cohortId:'ordinary_fullbook',familySlotId:'legacy_family',purpose:undefined};
  process.env.GROUP_BOOK_INVITES_JSON=JSON.stringify([legacy]);
  const current=clock;clock-=90*DAY;
  assert.equal((await intake(await request(legacy.token,false))).status,200,'pilot cap does not restrict fullbook intake');
  assert.equal((await handlers.finalReleaseResponse(admin({cohortId:legacy.cohortId,channel:'printing',attribution:'Synthetic',evidence:'Synthetic'}),clock)).status,200);
  assert.equal((await handlers.deliveryResponse(admin({cohortId:legacy.cohortId,recordedBy:'Synthetic',evidence:'Synthetic'}),clock)).status,200);
  clock=current;
  for(const cohortId of [selector.cohortId,second.cohortId]) assert.equal((await pilotRoute.POST(admin({...closeBody(),cohortId}))).status,200);
  let fullbookServed=false;
  const fullbook=(await store.findGroupBookSubmission(legacy))!;
  for(let day=1;day<=9;day++) {
   clock=current+day*DAY;const swept=await retention.runGroupBookRetentionDispatch(clock);
   assert.equal(swept.counts.families,1);assert.equal(swept.counts.deleted,1);
   if(!photos().includes(fullbook.photos[0].pathname)) fullbookServed=true;
  }
  assert.ok(fullbookServed,'fullbook receives service while pilots are eligible');
  assert.deepEqual(photos(),[],'all nine independent families drain in nine bounded actions');
  clock=current+10*DAY;const final=await retention.runGroupBookRetentionDispatch(clock);
  assert.equal(final.counts.families,0,'already-clean families consume no deletion actions');
  assert.deepEqual(photos(),[]);
 } finally {delete process.env.GROUP_BOOK_SWEEP_FAMILY_BUDGET;restore();}
});

test('REPLACEMENT frozen capacity contract: eight concurrent actual intakes retain independent ownership without lifetime slots',async()=>{
 try {
  await fresh();
  globalThis.fetch=async(url,options)=>{
   assert.equal(String(url),'https://uedeigimwdabjlereedy.supabase.co/auth/v1/user');
   const n=Number(new Headers(options?.headers).get('authorization')?.match(/synthetic-session-(\d+)$/)?.[1]);
   assert.ok(n>=1&&n<=8);
   return Response.json({id:`11111111-2222-4333-8444-${String(n).padStart(12,'0')}`,is_anonymous:false,email_confirmed_at:'2026-01-01T00:00:00Z'});
  };
  const requests:Request[]=[];
  for(let n=1;n<=8;n++) {const req=await request();req.headers.set('cookie',`hsb_classroom_auth=synthetic-session-${n}`);requests.push(req);}
  const responses=await Promise.all(requests.map(req=>intake(req)));
  assert.equal(responses.filter(r=>r.status===200).length,8);
  assert.equal(photos().length,8);
  const claims=blob.paths().filter(p=>p.startsWith('group-book/purposes/pilot-capacity/'));
  assert.equal(claims.length,0,'no new permanent capacity reservations');
  const owners=blob.paths().filter(p=>p.startsWith('group-book/attempts/'));
  assert.equal(owners.length,8);
  const keys=await Promise.all(owners.map(async p=>JSON.parse((await blob.bytes(p))!.toString()).familyStorageKey));
  assert.equal(new Set(keys).size,8,'each concurrent attempt retains independent durable ownership');
 } finally {restore();}
});

test('controlled pending managed photo settles after close and sweep without resurrecting media',async()=>{
 try {
  await fresh();const invite=await enroll();
  let resume!:()=>void;let entered!:()=>void;
  const blocked=new Promise<void>(r=>{resume=r;});const started=new Promise<void>(r=>{entered=r;});
  blob.faults.beforePhotoPut=async()=>{entered();await blocked;};
  const writing=intake(await request());await started;
  assert.equal((await handlers.pilotCloseResponse(admin(closeBody()),clock)).status,200);
  clock+=45001;
  const during=await retention.runGroupBookRetentionSweep(clock);
  assert.ok(during.attention.includes('partial_or_unverified'),'pending provider write must remain attention');
  assert.equal(during.counts.complete,0);
  resume();assert.equal((await writing).status,503);
  assert.deepEqual(photos(),[],'post-put close reconciliation removes exact late bytes');
  assert.equal(await store.findGroupBookSubmission(invite),null);
  const after=await retention.runGroupBookRetentionSweep(clock);assert.equal(after.counts.complete,1);
  assert.equal(blob.paths().filter(p=>p.includes('/attempts/')).length,1);
 } finally {restore();}
});

test('malformed family is held while independent valid due pilot is cleaned by authenticated cron and monitor sees attention',async()=>{
 try {
  await fresh();const invite=await enroll();assert.equal((await intake(await request())).status,200);
  assert.equal((await handlers.pilotCloseResponse(admin(closeBody()),clock)).status,200);
  const foreign=`group-book/photos/${'e'.repeat(64)}/gbp_held.jpg`;
  await blob.seed(`group-book/families/${'e'.repeat(64)}.json`,'{malformed');await blob.seed(foreign,Buffer.from('synthetic'));
  clock+=DAY;process.env.CRON_SECRET='synthetic-cron';
  const req=()=>new Request('https://synthetic.invalid/api/cron/group-book-retention-sweep',{headers:{authorization:'Bearer synthetic-cron'}});
  const response=await cron(req());assert.equal(response.status,503);
  const body=await response.json();assert.ok(body.attention.includes('held_unknown_scope'));assert.equal(body.counts.deleted,1);
  assert.deepEqual(photos(),[foreign]);assert.ok(await store.findGroupBookSubmission(invite));
  const inputs=await monitor.loadRetentionMonitorInputs(clock);
  const alerts=monitor.evaluateRetentionMonitor({...inputs,now:clock,httpStatus:503,priorFingerprints:[]});
  assert.ok(alerts.alerts.some(a=>a.kind==='attention'));
  assert.equal((await cron(req())).status,503,'duplicate cannot hide attention');
 } finally {restore();}
});

test('unknown close read and unverifiable deletion fail closed; scheduled discovery failures stay visible',async()=>{
 try {
  await fresh();const invite=await enroll();assert.equal((await intake(await request())).status,200);
  const record=(await store.findGroupBookSubmission(invite))!;
  blob.faults.readPath=pilot.groupBookPilotClosePath(selector.cohortId);blob.faults.readKind='503';
  assert.equal((await retention.openGroupBookSourcePhoto(invite,record.photos[0].assetId,clock)).state,'unknown');
  assert.equal((await handlers.pilotCloseResponse(admin(closeBody()),clock)).status,503);
  assert.equal(await store.createGroupBookAttempt(invite,'gbs_no',[],{admittedAt:clock,writeDeadline:clock+45000}),null);
  blob.faults.readPath=null;assert.equal((await handlers.pilotCloseResponse(admin(closeBody()),clock)).status,200);
  clock+=45001;blob.faults.readPath=record.photos[0].pathname;blob.faults.readKind='503';
  const uncertain=await retention.runGroupBookRetentionSweep(clock);assert.equal(uncertain.counts.complete,0);assert.ok(uncertain.attention.includes('partial_or_unverified'));
  assert.ok(blob.paths().some(p=>p.includes('/attempts/')));
  blob.faults.readPath=null;blob.faults.listLoop=true;
  assert.deepEqual((await retention.runGroupBookRetentionSweep(clock)).attention,['discovery_unavailable']);
  blob.faults.listLoop=false;assert.equal((await retention.runGroupBookRetentionSweep(clock)).counts.complete,1);
 } finally {restore();}
});

test('immutable managed default purpose and historical unclassified enrollment cannot be relabeled pilot',async()=>{
 try {
  await fresh('fullbook');const invite=await enroll();assert.equal((await intake(await request())).status,200);
  setup();
  assert.equal((await pilot.admitGroupBookIntakePurpose({...invite,purpose:'pilot_test_only'},clock)).state,'refused');
  assert.equal((await handlers.pilotCloseResponse(admin(closeBody()),clock)).status,422);
  assert.equal(((await pilot.loadGroupBookCohortPurpose(selector.cohortId)) as Extract<pilot.GroupBookCohortPurposeState,{state:'registered'}>).record.purpose,'fullbook');
  assert.equal(photos().length,1);
  // Old managed enrollment: no marker exists, including no submitted family.
  await fresh();
  const id=identity.classroomEnrollmentIdentity(selector.cohortId,'https://uedeigimwdabjlereedy.supabase.co/auth/v1',subject);
  await blob.seed(identity.classroomEnrollmentPath(id),JSON.stringify({schemaVersion:1,cohortId:selector.cohortId,familySlotId:id,owner:{issuer:'https://uedeigimwdabjlereedy.supabase.co/auth/v1',subject}}));
  assert.equal((await intake(await request())).status,503);
  assert.deepEqual(photos(),[]);
  assert.equal((await pilot.loadGroupBookCohortPurpose(selector.cohortId)).state,'none');
 } finally {restore();}
});

test('legacy direct writer is owned and immutable; normal fullbook delivery still deletes at 90 days',async()=>{
 try {
  await fresh('fullbook');process.env.HSB_CLASSROOM_CODES_JSON='[]';
  const legacy={...selector,cohortId:'historical_synthetic_ab',familySlotId:'synthetic_family_a',purpose:undefined};
  process.env.GROUP_BOOK_INVITES_JSON=JSON.stringify([legacy]);
  const photo=await store.uploadGroupBookPhoto({invite:legacy,bytes:Buffer.from('synthetic'),mime:'image/jpeg',ext:'jpg'});
  assert.ok(blob.paths().some(p=>p.includes('/attempts/')),'direct writer has durable ownership');
  const policy=groupBookPolicyState();assert.equal(policy.state,'adopted');
  const record=store.buildGroupBookSubmission({invite:legacy,parentName:'Synthetic',parentEmail:'p@example.invalid',childFirstName:'Synthetic',ageRange:'5-6',characterNotes:'',photos:[photo],policy:{version:policy.current.record.version,digest:policy.current.digest}});
  assert.equal(await store.createGroupBookSubmission(record),true);
  const base={cohortId:legacy.cohortId,recordedBy:'Synthetic',evidence:'Synthetic'};
  assert.equal((await handlers.finalReleaseResponse(admin({...base,channel:'printing',attribution:'Synthetic'}),clock)).status,200);
  const delivery=await handlers.deliveryResponse(admin(base),clock);assert.equal(delivery.status,200);
  const due=Date.parse((await delivery.json()).delivery.dueAt);assert.equal(due,clock+90*DAY);
  assert.equal((await retention.runGroupBookRetentionCleanup({cohortId:legacy.cohortId,now:due-1})).outcome,'not_due');
  assert.equal((await retention.runGroupBookRetentionCleanup({cohortId:legacy.cohortId,now:due})).outcome,'complete');
  assert.deepEqual(photos(),[]);
  process.env.GROUP_BOOK_INVITES_JSON=JSON.stringify([{...legacy,purpose:'pilot_test_only'}]);
  await assert.rejects(store.uploadGroupBookPhoto({invite:{...legacy,purpose:'pilot_test_only'},bytes:Buffer.from('synthetic'),mime:'image/jpeg',ext:'jpg'}));
 } finally {restore();}
});

test('closed pilot never reopens on config change; replay after config removal is nonextendable',async()=>{
 try {
  await fresh();const invite=await enroll();assert.equal((await intake(await request())).status,200);
  const first=await handlers.pilotCloseResponse(admin(closeBody()),clock);assert.equal(first.status,200);const anchor=(await first.json()).pilot;
  process.env.HSB_CLASSROOM_CODES_JSON='[]';clock+=DAY;
  const replay=await handlers.pilotCloseResponse(admin(closeBody()),clock);assert.equal(replay.status,200);assert.deepEqual((await replay.json()).pilot,anchor);
  assert.equal((await handlers.pilotCloseResponse(admin({...closeBody(),evidence:'changed'}),clock)).status,409);
  setup('fullbook');
  assert.equal((await identity.resolveGroupBookSessionInvite(selector.token,'hsb_classroom_auth=synthetic-session',true)).state,'active','existing own-family read stays available');
  assert.equal(await store.createGroupBookAttempt({...invite,purpose:'fullbook'},'gbs_late',[],{admittedAt:clock,writeDeadline:clock+45000}),null);
  assert.equal((await handlers.finalReleaseResponse(admin({cohortId:selector.cohortId,channel:'printing',attribution:'Synthetic',evidence:'Synthetic'}),clock)).status,422);
 } finally {restore();}
});

test('legacy pilot intake and direct upload honor close; historical unstamped A/B cannot be registered later',async()=>{
 try {
  await fresh();process.env.HSB_CLASSROOM_CODES_JSON='[]';
  const legacy={...selector,cohortId:'legacy_test_pilot',familySlotId:'synthetic_family_a'};
  const other={...legacy,token:'SyntheticLegacyPilotSecond000000001',familySlotId:'synthetic_family_b'};
  process.env.GROUP_BOOK_INVITES_JSON=JSON.stringify([legacy,other]);
  assert.equal((await intake(await request(legacy.token,false))).status,200);
  const saved=(await store.findGroupBookSubmission(legacy))!;assert.equal(saved.pilot?.purpose,'pilot_test_only');
  assert.equal((await handlers.pilotCloseResponse(admin({...closeBody(),cohortId:legacy.cohortId}),clock)).status,200);
  const count=photos().length;
  assert.equal((await intake(await request(other.token,false))).status,409);
  await assert.rejects(store.uploadGroupBookPhoto({invite:other,bytes:Buffer.from('synthetic'),mime:'image/jpeg',ext:'jpg'}));
  assert.equal(photos().length,count);
  clock+=45001;assert.equal((await retention.runGroupBookRetentionSweep(clock)).counts.deleted,1);
  // Historical record has no purpose marker, no pilot stamp, and old bytes.
  await blob.reset();const historical={...saved};delete historical.pilot;
  await blob.seed(store.groupBookRecordPath(legacy),JSON.stringify(historical));
  await blob.seed(historical.photos[0].pathname,Buffer.from('synthetic historical'));
  const before=await blob.bytes(historical.photos[0].pathname);
  assert.equal((await handlers.pilotCloseResponse(admin({action:'register',cohortId:legacy.cohortId,purpose:'pilot_test_only',recordedBy:'Synthetic',evidence:'late relabel'}),clock)).status,503);
  assert.equal((await pilot.loadGroupBookCohortPurpose(legacy.cohortId)).state,'none');
  assert.deepEqual(await blob.bytes(historical.photos[0].pathname),before);
  assert.equal((await retention.runGroupBookRetentionSweep(clock)).counts.deleted,0);
 } finally {restore();}
});

test('aborted transport with possible remote commit stays durably unverified across repeated exact-key reaping',async()=>{
 try {
  await fresh();const invite=await enroll();
  blob.faults.beforeAttemptPut=async()=>{clock+=44980;};blob.faults.hangPhotoPut=true;
  assert.ok((await intake(await request())).status>=400);
  assert.equal(blob.lateCommits.length,1);
  assert.equal((await handlers.pilotCloseResponse(admin(closeBody()),clock)).status,200);
  clock+=45001;
  let swept=await retention.runGroupBookRetentionSweep(clock);assert.equal(swept.counts.complete,0);assert.ok(swept.attention.includes('partial_or_unverified'));
  assert.equal(await blob.applyLateCommits(),1);
  assert.equal(photos().length,1,'unknown remote commit is still attributed by the attempt');
  const attempt=JSON.parse((await blob.bytes(blob.paths().find(p=>p.includes('/attempts/'))!))!.toString());
  const assetId=attempt.photoPaths[0].split('/').pop().slice(0,-4);
  assert.equal((await retention.openGroupBookSourcePhoto(invite,assetId,clock)).state,'expired');
  clock+=DAY;swept=await retention.runGroupBookRetentionSweep(clock);
  assert.equal(swept.counts.deleted,1);assert.deepEqual(photos(),[]);
  assert.equal(swept.counts.complete,0,'a lost remote result is never converted into proof of settlement');
  assert.ok(swept.attention.includes('partial_or_unverified'));
  assert.ok(blob.paths().some(p=>p.includes('/attempts/')));
 } finally {restore();}
});

test('REPLACEMENT historical capacity: nine completed, abandoned and noncollecting managed families never bar future pilots',async()=>{
 try {
  await fresh();
  const attempts:string[]=[];
  for(let n=1;n<=9;n++) {
   principalNumber(n);const invite=await enroll();
   if(n<=3) assert.equal((await intake(await request())).status,200);
   else if(n<=6) {
    const planned=store.planGroupBookPhotos(invite,[{bytes:Buffer.from('synthetic abandoned'),mime:'image/jpeg',ext:'jpg'}]);
    const owner=await store.createGroupBookAttempt(invite,store.newGroupBookSubmissionId(),planned,{admittedAt:clock,writeDeadline:clock+45000});
    assert.ok(owner);attempts.push(store.groupBookAttemptPath(invite,owner.attemptId));
   }
   // n=7..9 enroll only: noncollecting durable families.
  }
  assert.equal((await pilotRoute.POST(admin(closeBody()))).status,200);
  clock+=DAY;await retention.runGroupBookRetentionSweep(clock);
  assert.deepEqual(photos(),[],'completed owned media is gone');
  for(const path of attempts) assert.ok(blob.paths().includes(path),'uncertain abandoned ownership is never recycled');
  // Historical lifetime reservations are not deleted or reused as ownership.
  for(let slot=0;slot<6;slot++) await blob.seed(`group-book/purposes/pilot-capacity/${slot}.json`,JSON.stringify({schemaVersion:1,familyStorageKey:String(slot).repeat(64),cohortId:selector.cohortId,registrationId:'gbreg_SYNTHETICHISTORY'}));
  const later={...selector,token:'SyntheticLaterPilotSelector000000001',cohortId:'later_managed_pilot'};
  process.env.HSB_CLASSROOM_CODES_JSON=JSON.stringify([selector,later]);
  principalNumber(10);
  assert.equal((await intake(await request(later.token))).status,200,'historical completed/abandoned/noncollecting families cannot permanently bar a new configured pilot');
  assert.equal(blob.paths().filter(p=>p.startsWith('group-book/purposes/pilot-capacity/')).length,6,'historical reservations preserved, no new reservations');
  for(const path of attempts) assert.ok(blob.paths().includes(path));
 } finally {restore();}
});

test('original managed session scenario assertions with in-memory Request/Response transport and no socket',async()=>{
 // Execute the unchanged original ten cases. The audited scenario captures
 // nativeFetch before installing its synthetic /user adapter. Supply that
 // captured transport entirely in memory; node:http never opens a socket.
 await blob.reset();
 const savedFetch=globalThis.fetch;
 let dispatch: (incoming: unknown, outgoing: unknown)=>Promise<void>;
 const origin='http://127.0.0.1:31337';
 const httpMock=mock.module('node:http',{namedExports:{
  createServer(listener: typeof dispatch) {
   dispatch=listener;
   return {
    listen(port:number,host:string,ready:()=>void) {assert.equal(port,0);assert.equal(host,'127.0.0.1');ready();},
    address() {return {port:31337};},
    close(done:()=>void) {done();},
   };
  },
 }});
 globalThis.fetch=async(input,init)=>{
  const req=new Request(input,init);
  assert.equal(new URL(req.url).origin,origin,'all captured transport stays in memory');
  const bytes=Buffer.from(await req.arrayBuffer());
  return new Promise<Response>((resolve,reject)=>{
   let status=200;const headers=new Headers();
   const incoming={
    method:req.method,url:new URL(req.url).pathname,
    headers:{...Object.fromEntries(req.headers),host:'127.0.0.1:31337'},
    async *[Symbol.asyncIterator]() {yield bytes;},
   };
   const outgoing={
    writeHead(code:number,fields:Record<string,string|string[]>) {
     status=code;
     for(const [name,value] of Object.entries(fields)) {
      headers.delete(name);
      for(const item of Array.isArray(value)?value:[value]) headers.append(name,item);
     }
    },
    end(body:BodyInit) {resolve(new Response(body,{status,headers}));},
   };
   dispatch(incoming,outgoing).catch(reject);
  });
 };
 try {await import('./helpers/group-book-session-http-scenario.ts');}
 finally {globalThis.fetch=savedFetch;httpMock.restore();}
});
