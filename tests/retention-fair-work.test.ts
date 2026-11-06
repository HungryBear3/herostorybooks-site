import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import * as blob from './helpers/group-book-blob-faults.mjs';
// Lazy synthetic transport metadata: no 50k-object materialization on disk or
// in the fake object map. Every product decision still executes actual source.
let history: {size:number;key:string;reads:number} | null=null;
const historyPrefix='group-book/ops/retention-service/';
mock.module('@vercel/blob',{namedExports:{...blob,
 async get(path:string,options:unknown) {
  const n=path.startsWith(historyPrefix)?Number(path.slice(historyPrefix.length,-5)):0;
  if(history && n>=1 && n<=history.size) {history.reads++;return {statusCode:200,stream:Response.json({schemaVersion:1,turn:n,familyStorageKey:history.key,reservation:`synthetic-${n}`}).body};}
  return blob.get(path,options);
 },
 async list(options:{prefix:string;cursor?:string;limit?:number}) {
  if(history && options.prefix===historyPrefix) {
   const start=Number(options.cursor||0),end=Math.min(start+(options.limit||1000),history.size);
   return {blobs:Array.from({length:end-start},(_,i)=>({pathname:`${historyPrefix}${String(start+i+1).padStart(16,'0')}.json`})),hasMore:end<history.size,cursor:String(end)};
  }
  return blob.list(options);
 }
}});
const store=await import('../src/lib/group-book/store.ts');
const retention=await import('../src/lib/group-book/retention.ts');
import { groupBookPolicyState } from '../src/lib/group-book/release.ts';
const {POST:intake}=await import('../src/app/group-book/intake/route.ts');
const {POST:close}=await import('../src/app/api/admin/group-book/pilot-close/route.ts');
const {GET:cron}=await import('../src/app/api/cron/group-book-retention-sweep/route.ts');
import { familyStorageKey } from '../src/lib/group-book/config.ts';

const DAY = 86400000;
test('B2: foreign prefix bytes cannot consume daily owned-work budget and starve B or due fullbook', async () => {
 const realNow = Date.now;
 let clock = Date.parse('2026-07-01T05:40:00.000Z');
 const a = {token:'SyntheticFairPilotASelector00000001', cohortId:'fair_pilot_a', familySlotId:'family_a', cohortLabel:'Synthetic A', expiresAt:'2099-01-01T00:00:00.000Z', purpose:'pilot_test_only'};
 const b = {...a, token:'SyntheticFairPilotBSelector00000001', cohortId:'fair_pilot_b', familySlotId:'family_b'};
 const full = {...a, token:'SyntheticFairFullbookSelector000001', cohortId:'fair_fullbook', familySlotId:'family_full', purpose:'fullbook'};
 const admin = (cohortId:string) => new Request('https://synthetic.invalid/api/admin/group-book/pilot-close', {method:'POST', headers:{'content-type':'application/json','x-hsb-order-admin-key':'synthetic-admin'}, body:JSON.stringify({cohortId, mode:'test_only', recordedBy:'Synthetic', evidence:'Synthetic actual close'})});
 try {
  await blob.reset();
  process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN='vercel_blob_rw_groupbookfixture_synthetic';
  process.env.GROUP_BOOK_INVITES_JSON=JSON.stringify([a,b,full]);
  process.env.HSB_CLASSROOM_CODES_JSON='[]';
  process.env.GROUP_BOOK_INTAKE_ENABLED='true';
  process.env.HSB_ORDER_ADMIN_KEY='synthetic-admin';
  process.env.CRON_SECRET='synthetic-cron';
  // This is the actual mounted caller's configuration, not a helper override.
  process.env.GROUP_BOOK_SWEEP_FAMILY_BUDGET='1';
  Date.now=()=>clock;
  const policy=groupBookPolicyState(); assert.equal(policy.state,'adopted');
  const bytes=await sharp({create:{width:4,height:4,channels:3,background:'#abcdef'}}).jpeg().toBuffer();
  const submit=async (invite:typeof a) => {
   const form=new FormData();
   for(const [key,value] of Object.entries({invite:invite.token,parentName:'Synthetic',parentEmail:'p@example.invalid',childFirstName:'Synthetic',ageRange:'5-6',guardianAuthority:'true',sharedWithParticipatingFamilies:'true',sourcePhotosRemainPrivate:'true',schoolApprovalNotRepresentedOrImplied:'true',policyVersion:policy.current.record.version,policyDigest:policy.current.digest})) form.set(key,value);
   form.append('photos',new File([bytes],'fixture.jpg',{type:'image/jpeg'}));
   assert.equal((await intake(new Request('https://synthetic.invalid/group-book/intake',{method:'POST',body:form}))).status,200);
   const record=await store.findGroupBookSubmission(invite); assert.ok(record); return record;
  };
  const ordinary=await submit(full);
  assert.equal((await retention.recordGroupBookFinalRelease({cohortId:full.cohortId,channel:'printing',attribution:'Synthetic',evidence:'Synthetic release',now:clock})).outcome,'recorded');
  assert.equal((await retention.recordGroupBookFinalDelivery({cohortId:full.cohortId,recordedBy:'Synthetic',evidence:'Synthetic delivery',now:clock})).outcome,'recorded');
  clock=Date.parse('2026-11-01T05:40:49.000Z');
  const ownedA=await submit(a), ownedB=await submit(b);
  assert.ok(ownedA.pilot); assert.ok(ownedB.pilot);
  assert.equal((await close(admin(a.cohortId))).status,200);
  clock+=1000;
  const closedB=clock;
  assert.equal((await close(admin(b.cohortId))).status,200);
  const stranger=`group-book/photos/${familyStorageKey(a)}/undeclared-stranger.jpg`;
  await blob.seed(stranger,Buffer.from('synthetic stranger: no ownership declaration'));
  const daily=[];
  for(let day=0;day<=6;day++) {
   clock=Date.parse('2026-11-01T05:41:00.000Z')+day*DAY;
   const response=await cron(new Request('https://synthetic.invalid/api/cron/group-book-retention-sweep',{headers:{authorization:'Bearer synthetic-cron'}}));
   const result=await response.json();
   assert.ok(result.counts.families<=1,'actual runGroupBookRetentionSweep action budget is one');
   assert.ok(blob.paths().includes(stranger),'undeclared bytes must be preserved');
   if(day>0) assert.ok(result.attention.length>0,'eligible held/deferred work must remain visible');
   daily.push({day,status:response.status,...result.counts,attention:result.attention});
  }
  assert.ok(clock<closedB+7*DAY,'last scheduled opportunity before actual-close+7');
  console.log('B2_FAIR_WORK',JSON.stringify({daily,aOwnedRemaining:blob.paths().includes(ownedA.photos[0].pathname),bOwnedRemaining:blob.paths().includes(ownedB.photos[0].pathname),fullbookRemaining:blob.paths().includes(ordinary.photos[0].pathname),strangerPreserved:blob.paths().includes(stranger),deadline:new Date(closedB+7*DAY).toISOString()}));
  assert.equal(blob.paths().includes(ownedB.photos[0].pathname),false,'B2: valid B owned bytes must be gone by the last daily sweep before close+7 despite A stranger');
  assert.equal(blob.paths().includes(ordinary.photos[0].pathname),false,'ordinary due fullbook must make fair progress');
 } finally {Date.now=realNow; delete process.env.GROUP_BOOK_SWEEP_FAMILY_BUDGET;}
});

// All helpers stay in this sole allowed regression file; transport is the
// existing Blob fixture, and selection/deletion always run actual source.
async function fairFixture() {
 await blob.reset();
 let clock=Date.parse('2026-07-01T05:40:00.000Z');
 const saved=Date.now;Date.now=()=>clock;
 const a={token:'SyntheticQueuePilotASelector00000001',cohortId:'aaa_queue_pilot',familySlotId:'family_a',cohortLabel:'Synthetic',expiresAt:'2099-01-01T00:00:00.000Z',purpose:'pilot_test_only'};
 const b={...a,token:'SyntheticQueuePilotBSelector00000001',cohortId:'bbb_queue_pilot',familySlotId:'family_b'};
 const full={...a,token:'SyntheticQueueFullbookSelector000001',cohortId:'zzz_queue_fullbook',familySlotId:'family_full',purpose:'fullbook'};
 process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN='vercel_blob_rw_groupbookfixture_synthetic';
 process.env.GROUP_BOOK_INVITES_JSON=JSON.stringify([a,b,full]);process.env.HSB_CLASSROOM_CODES_JSON='[]';
 process.env.GROUP_BOOK_INTAKE_ENABLED='true';process.env.HSB_ORDER_ADMIN_KEY='synthetic-admin';process.env.CRON_SECRET='synthetic-cron';process.env.GROUP_BOOK_SWEEP_FAMILY_BUDGET='1';
 const policy=groupBookPolicyState() as Extract<ReturnType<typeof groupBookPolicyState>,{state:'adopted'}>;assert.equal(policy.state,'adopted');
 const image=await sharp({create:{width:4,height:4,channels:3,background:'#123456'}}).jpeg().toBuffer();
 async function submit(invite:typeof a,count=1) {
  const form=new FormData();
  for(const [k,v] of Object.entries({invite:invite.token,parentName:'Synthetic',parentEmail:'p@example.invalid',childFirstName:'Synthetic',ageRange:'5-6',guardianAuthority:'true',sharedWithParticipatingFamilies:'true',sourcePhotosRemainPrivate:'true',schoolApprovalNotRepresentedOrImplied:'true',policyVersion:policy.current.record.version,policyDigest:policy.current.digest})) form.set(k,v);
  for(let n=0;n<count;n++) form.append('photos',new File([image],'fixture.jpg',{type:'image/jpeg'}));
  assert.equal((await intake(new Request('https://synthetic.invalid/group-book/intake',{method:'POST',body:form}))).status,200);
  const record=await store.findGroupBookSubmission(invite);assert.ok(record);return record;
 }
 const ordinary=await submit(full);
 assert.equal((await retention.recordGroupBookFinalRelease({cohortId:full.cohortId,channel:'printing',attribution:'Synthetic',evidence:'Synthetic',now:clock})).outcome,'recorded');
 assert.equal((await retention.recordGroupBookFinalDelivery({cohortId:full.cohortId,recordedBy:'Synthetic',evidence:'Synthetic',now:clock})).outcome,'recorded');
 clock=Date.parse('2026-11-01T05:40:00.000Z');
 const ownedA=await submit(a,2),ownedB=await submit(b);
 for(const invite of [a,b]) assert.equal((await close(new Request('https://synthetic.invalid/api/admin/group-book/pilot-close',{method:'POST',headers:{'content-type':'application/json','x-hsb-order-admin-key':'synthetic-admin'},body:JSON.stringify({cohortId:invite.cohortId,mode:'test_only',recordedBy:'Synthetic',evidence:'Synthetic'})}))).status,200);
 clock+=60000;
 const request=()=>new Request('https://synthetic.invalid/api/cron/group-book-retention-sweep',{headers:{authorization:'Bearer synthetic-cron'}});
 return {a,b,full,ownedA,ownedB,ordinary,request,submit,tick:()=>{clock+=60000;},next:()=>{clock+=DAY;},now:()=>clock,restore:()=>{Date.now=saved;delete process.env.GROUP_BOOK_SWEEP_FAMILY_BUDGET;}};
}

test('durable queue serves fullbook after pilot grace and advances transient A failure across a fresh module instance',async()=>{
 const f=await fairFixture();
 try {
  blob.faults.delMode='partial';
  const first=await (await cron(f.request())).json();assert.equal(first.counts.families,1);assert.equal(first.counts.deleted,1);assert.ok(first.attention.includes('partial_or_unverified'));
  assert.ok(blob.paths().includes(f.ownedB.photos[0].pathname));assert.ok(blob.paths().includes(f.ordinary.photos[0].pathname),'fullbook actually competes after grace');
  f.next();
  const restarted=await import('../src/lib/group-book/retention.ts?fair-restart=1' as string);
  const second=await restarted.runGroupBookRetentionDispatch(f.now());
  assert.equal(second.counts.families,1);assert.equal(blob.paths().includes(f.ownedB.photos[0].pathname),false,'restart retains failed A service position');
  f.next();await cron(f.request());
  assert.equal(blob.paths().includes(f.ordinary.photos[0].pathname),false,'ordinary fullbook served while A still has owned bytes');
  assert.ok(f.ownedA.photos.some(p=>blob.paths().includes(p.pathname)));
  f.next();await cron(f.request());
  assert.ok(f.ownedA.photos.every(p=>!blob.paths().includes(p.pathname)));
 } finally {f.restore();}
});

test('stranger-only and completed families use zero deletion actions; concurrent cron dispatch stays single flight',async()=>{
 const f=await fairFixture();
 try {
  const stranger=`group-book/photos/${familyStorageKey(f.a)}/gbp_UNDECLARED.jpg`;
  const fullStranger=`group-book/photos/${familyStorageKey(f.full)}/gbp_UNDECLARED.jpg`;
  await blob.seed(stranger,Buffer.from('synthetic stranger'));await blob.seed(fullStranger,Buffer.from('synthetic fullbook stranger'));
  const responses=await Promise.all([cron(f.request()),cron(f.request())]);
  const bodies=await Promise.all(responses.map(r=>r.json()));
  assert.equal(bodies.filter(b=>b.status==='duplicate_suppressed').length,1);
  assert.equal(bodies.reduce((n,b)=>n+(b.status==='duplicate_suppressed'?0:b.counts.families),0),1);
  for(let day=0;day<2;day++) {f.next();const result=await (await cron(f.request())).json();assert.equal(result.counts.families,1);}
  assert.ok(!blob.paths().includes(f.ownedB.photos[0].pathname));assert.ok(!blob.paths().includes(f.ordinary.photos[0].pathname));
  f.next();const verified=await (await cron(f.request())).json();assert.equal(verified.counts.families,0,'no owned bytes means no deletion capacity consumed');
  assert.ok(verified.attention.includes('partial_or_unverified'));assert.ok(blob.paths().includes(stranger));assert.ok(blob.paths().includes(fullStranger),'canonical fullbook prefix alone is never authority');
 } finally {f.restore();}
});

test('unknown owned probe and malformed independent family stay visible without starving B',async()=>{
 const f=await fairFixture();
 try {
  blob.faults.readPath=f.ownedA.photos[0].pathname;blob.faults.readKind='503';
  await blob.seed(`group-book/families/${'e'.repeat(64)}.json`,'{bad');
  await blob.seed(`group-book/photos/${'e'.repeat(64)}/gbp_HELD.jpg`,Buffer.from('synthetic held'));
  const first=await (await cron(f.request())).json();assert.ok(first.attention.includes('held_unknown_scope'));assert.ok(first.attention.includes('partial_or_unverified'));
  f.next();await cron(f.request());assert.ok(!blob.paths().includes(f.ownedB.photos[0].pathname));
  assert.ok(blob.paths().includes(`group-book/photos/${'e'.repeat(64)}/gbp_HELD.jpg`));
  blob.faults.readPath=null;
 } finally {f.restore();}
});

test('unconfirmed durable service reservation fails closed, then next daily dispatch resumes',async()=>{
 const f=await fairFixture();
 try {
  blob.faults.failPutPrefix='group-book/ops/retention-service/';
  const first=await (await cron(f.request())).json();
  assert.ok(first.attention.includes('dispatch_unconfirmed'));assert.equal(first.counts.families,0);
  assert.ok(f.ownedA.photos.every(p=>blob.paths().includes(p.pathname)));assert.ok(blob.paths().includes(f.ownedB.photos[0].pathname));
  f.next();const next=await (await cron(f.request())).json();assert.equal(next.counts.families,1);assert.equal(next.counts.deleted,2);
 } finally {f.restore();}
});

test('FAIR-B1: 50001 valid historical service records resume in bounded passes and serve tiny current work',async()=>{
 const f=await fairFixture();
 try {
  history={size:50001,key:'a'.repeat(64),reads:0};
  let served=false;
  for(let pass=0;pass<110;pass++) {
   const before=history.reads;
   const body=await (await cron(f.request())).json();
   assert.ok(history.reads-before<=514,'each mounted pass has bounded historical record reads');
   if(body.counts.families) {served=true;break;}
   assert.ok(body.attention.includes('service_history_continuation'),'bounded migration is explicitly incomplete');
   assert.ok(blob.paths().some(p=>p.startsWith('group-book/ops/retention-service-checkpoints/')),'each unfinished pass persists actual continuation');
   f.next();
  }
  assert.ok(served,'50001 valid historical records must not permanently halt current owned work');
 } finally {history=null;f.restore();}
});

test('continuing arrivals cannot reset B/fullbook progress while A has recurring actual owned deletion failures',async()=>{
 const f=await fairFixture();
 try {
  for(let pass=0;pass<6;pass++) {
   if(pass) {
    f.next();
    const arrival={...f.a,cohortId:`000_arrival_${pass}`,token:`SyntheticContinuingArrivalToken00000${pass}`};
    const configured=JSON.parse(process.env.GROUP_BOOK_INVITES_JSON!);configured.push(arrival);process.env.GROUP_BOOK_INVITES_JSON=JSON.stringify(configured);
    await f.submit(arrival);
    assert.equal((await close(new Request('https://synthetic.invalid/api/admin/group-book/pilot-close',{method:'POST',headers:{'content-type':'application/json','x-hsb-order-admin-key':'synthetic-admin'},body:JSON.stringify({cohortId:arrival.cohortId,mode:'test_only',recordedBy:'Synthetic',evidence:'Synthetic continuing arrival'})}))).status,200);
    f.tick();
   }
   // These exact keys already have durable actual-intake ownership declarations.
   for(const photo of f.ownedA.photos) if(!blob.paths().includes(photo.pathname)) await blob.seed(photo.pathname,Buffer.from('synthetic late owned commit'));
   blob.faults.delMode='partial';
   const result=await (await cron(f.request())).json();assert.equal(result.counts.families,1);
   assert.ok(f.ownedA.photos.some(p=>blob.paths().includes(p.pathname)),'A still has real owned bytes after recurring partial-delete faults');
   if(pass>=1) assert.ok(!blob.paths().includes(f.ownedB.photos[0].pathname),'new arrivals do not jump ahead of queued B');
   if(pass>=2) assert.ok(!blob.paths().includes(f.ordinary.photos[0].pathname),'fullbook progresses despite recurring owned A failure and arrivals');
  }
 } finally {f.restore();}
});
