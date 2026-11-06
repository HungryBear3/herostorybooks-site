import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as orders from '../src/lib/orders.ts';
import type { OrderRecord, OrderStoreAdapter } from '../src/lib/orders.ts';

const ID = 'ord_cache_custody_synthetic';
const record = (childName = 'BASE') => orders.createOrderRecord({ childName, bookFormat: 'digital', email: 'synthetic@example.invalid' }, { id: ID, now: '2026-08-05T00:00:00.000Z' });
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
function store() {
  const rows = new Map<string, { body: string; version: string }>();
  let seq = 0, reads = 0, writes = 0;
  let readHook: (() => Promise<void>) | undefined;
  let ack: (() => Promise<void>) | undefined;
  const key = () => orders.withBlobNamespace(`orders/${ID}.json`);
  const seed = (value: unknown = record()) => rows.set(key(), { body: JSON.stringify(value), version: `v${++seq}` });
  const factory = (): OrderStoreAdapter => ({
    kind: 'synthetic-custody',
    async readVersioned(p) { reads++; await readHook?.(); return rows.get(p) ? { ...rows.get(p)! } : null; },
    async createIfAbsent(p, body) { writes++; if (rows.has(p)) return { ok: false, reason: 'exists' }; rows.set(p, {body, version:`v${++seq}`}); return {ok:true,version:rows.get(p)!.version}; },
    async replaceIfVersion(p,body,version) { writes++; if(rows.get(p)?.version!==version) return {ok:false,reason:'version_conflict'}; rows.set(p,{body,version:`v${++seq}`}); const result={ok:true as const,version:rows.get(p)!.version}; await ack?.(); return result; },
  });
  orders.__setOrderStoreAdapterFactoryForTests(factory);
  seed();
  return { rows, key, seed, factory, raw:()=>rows.get(key())!, reads:()=>reads, writes:()=>writes, reset:()=>{reads=0;writes=0;}, readHook:(f?:()=>Promise<void>)=>{readHook=f;}, ack:(f?:()=>Promise<void>)=>{ack=f;} };
}
const observed = () => orders.withOrderTransaction(ID,o=>({abort:o.childName}));
const commit = (childName: string) => orders.withOrderTransaction(ID,o=>({commit:{...o,childName},result:null}));
const saved = { ...process.env };
test.afterEach(() => { orders.__resetOrderStoreAdapterFactoryForTests(); for(const k of ['BLOB_READ_WRITE_TOKEN','HSB_BLOB_ACCESS_MODE','HSB_ORDER_STORE_DIR','HSB_BLOB_NAMESPACE']) { if(saved[k]===undefined) delete process.env[k]; else process.env[k]=saved[k]; } });

test('exact committed body/version survives fresh adapters, caller mutation and fresh consumer parses', async()=>{
  const s=store(); let returned!: OrderRecord;
  await orders.withOrderTransaction(ID,o=>{ returned={...o,childName:'COMMITTED'}; return {commit:returned,result:null}; });
  const raw={...s.raw()}; returned.childName='CALLER_POISON'; s.reset();
  const a=await orders.readOrderVersioned(ID,{preferRecentCommit:true});
  assert.equal(a?.version,raw.version); assert.deepEqual(a?.order,JSON.parse(raw.body));
  a!.order.childName='CONSUMER_POISON';
  await orders.withOrderTransaction(ID,o=>{o.childName='ABORT_POISON'; return {abort:null};});
  assert.equal(await observed(),'COMMITTED'); assert.equal(s.reads(),0);
});

for(const selector of ['BLOB_READ_WRITE_TOKEN','HSB_BLOB_ACCESS_MODE','HSB_ORDER_STORE_DIR','HSB_BLOB_NAMESPACE'] as const) {
  test(`cache identity isolates ${selector} and restores an equivalent context`,async()=>{
    process.env[selector]=selector==='HSB_BLOB_ACCESS_MODE'?'public':selector==='HSB_ORDER_STORE_DIR'?path.join(process.env.TMPDIR!,'root-a'):'context-a';
    const s=store(); await commit('A'); const first=process.env[selector];
    process.env[selector]=selector==='HSB_BLOB_ACCESS_MODE'?'private':selector==='HSB_ORDER_STORE_DIR'?path.join(process.env.TMPDIR!,'root-b'):'context-b';
    s.seed(record('B')); s.reset(); assert.equal(await observed(),'B'); assert.equal(s.reads(),1);
    process.env[selector]=first; s.reset(); assert.equal(await observed(),'A'); assert.equal(s.reads(),0);
  });
}

test('factory replacement isolates old entries and path isolation prevents cross-id cache reuse',async()=>{
  const a=store(); await commit('A'); const b=store(); b.seed(record('B')); b.reset(); assert.equal(await observed(),'B'); assert.equal(b.reads(),1);
  b.rows.set(orders.withBlobNamespace('orders/other.json'),{body:JSON.stringify({...record('OTHER'),id:'other'}),version:'other-version'});
  await commit('B-COMMIT'); b.reset(); assert.equal(await orders.withOrderTransaction('other',o=>({abort:o.childName})),'OTHER'); assert.equal(b.reads(),1);
  void a;
});

test('context is captured before option getters and retained across conflict retries',async()=>{
  process.env.HSB_BLOB_NAMESPACE='capture-a'; const s=store(); const p=s.key(); let attempts=0;
  await orders.withOrderTransaction(ID,o=>{ attempts++; if(attempts===1) s.rows.set(p,{body:JSON.stringify(record('RACER')),version:'racer'}); process.env.HSB_BLOB_NAMESPACE='capture-b'; return {commit:{...o,childName:'DONE'},result:null}; },{get maxAttempts(){process.env.HSB_BLOB_NAMESPACE='capture-c'; return 3;}});
  assert.equal(attempts,2); assert.equal(JSON.parse(s.rows.get(p)!.body).childName,'DONE'); assert.equal(s.rows.size,1);
});

test('fresh explicitly bypasses the process-local read-your-writes entry',async()=>{
  const s=store(); await commit('A'); s.seed(record('EXTERNAL')); s.reset();
  assert.equal(await observed(),'A'); assert.equal(s.reads(),0);
  assert.equal(await orders.withOrderTransaction(ID,o=>({abort:o.childName}),{fresh:true}),'EXTERNAL'); assert.equal(s.reads(),1);
});

for(const field of ['classroomAcceptedTerms','classroomAcceptedSession','classroomFinancialReceipt','classroomFinancialReconciliation','classroomProofAdoption']) {
  for(const value of [null,{malformed:true}]) test(`own ${field} ${JSON.stringify(value)} is never cached`,async()=>{
    const s=store(); s.seed({...record(),[field]:value}); await commit('HELD'); s.reset(); assert.equal(await observed(),'HELD'); assert.equal(s.reads(),1);
  });
}

for(const shape of ['stale','absent','read-failure','matching']) test(`independent ${shape} baseline precedes all proposal hooks`,async()=>{
  const s=store(); const version=s.raw().version; const events:string[]=[];
  s.readHook(async()=>{events.push('baseline'); if(shape==='read-failure') throw new Error('synthetic baseline failure');});
  const proposal={...record('NEXT'),toJSON(){events.push('proposal'); return record('NEXT');}};
  if(shape==='absent') s.rows.clear();
  const before=s.writes();
  if(shape==='read-failure') await assert.rejects(orders.commitOrderConditional(proposal,version),/synthetic baseline failure/);
  else {const result=await orders.commitOrderConditional(proposal,shape==='stale'?'stale':version); assert.equal(result.ok,shape==='matching');}
  assert.deepEqual(events,shape==='matching'?['baseline','proposal']:['baseline']); assert.equal(s.writes()-before,shape==='matching'?1:0);
});

test('descriptor id refuses an accessor without invoking it or reading the store',async()=>{
  const s=store(); let invoked=0; const p=record(); Object.defineProperty(p,'id',{get(){invoked++; return ID;}});
  s.reset(); await assert.rejects(orders.commitOrderConditional(p,'v1'),/id_not_plain_data/); assert.equal(invoked,0); assert.equal(s.reads(),0); assert.equal(s.writes(),0);
});

test('serialization-time concurrent landing faces CAS at the original immutable version',async()=>{
  const s=store(); const version=s.raw().version;
  const p={...record(),toJSON(){s.rows.set(s.key(),{body:JSON.stringify(record('CONCURRENT')),version:'concurrent'}); return record('PROPOSAL');}};
  assert.equal((await orders.commitOrderConditional(p,version)).ok,false); assert.equal(JSON.parse(s.raw().body).childName,'CONCURRENT');
});

for(const read of [orders.readPublicOrderBlobVersioned,orders.readAuthoritativeOrderBlobVersioned]) test(`${read.name} bare version grants no custody removal authority`,async()=>{
  const s=store(); s.seed({...record(),classroomFinancialReceipt:{malformed:true}});
  const raw=await read(s.key(),'synthetic-token',{
    listImpl:async()=>({blobs:[{pathname:s.key(),url:'https://synthetic.invalid/order',etag:s.raw().version}]}),
    fetchImpl:async()=>new Response(s.raw().body,{headers:{etag:s.raw().version}}),sleepImpl:async()=>{},
  });
  assert.ok(raw); s.reset(); await assert.rejects(orders.commitOrderConditional(record('STRIPPED'),raw.version),/immutable classroom financial custody/); assert.equal(s.writes(),0);
});

test('manual-runtime function-value commit keeps the same mandatory baseline and stale-version refusal',async()=>{
  const {manualMediaProofRuntime}=await import('../src/lib/manual-media-proof-runtime.ts');
  const s=store(); const version=s.raw().version; await commit('WINNER'); let hooks=0;
  const p={...record(),toJSON(){hooks++;return record('STALE');}};
  assert.equal((await manualMediaProofRuntime.commit(p,version)).ok,false); assert.equal(hooks,0);
});

for(const reverse of [false,true]) test(`pre-write failures retract in ${reverse?'reverse':'forward'} completion order and preserve a pending winner`,async()=>{
  const s=store(); const installed=gate(), ack=gate(); s.ack(async()=>{installed.release(); await ack.promise;});
  const winner=commit('WINNER'); await installed.promise; const a=gate(),b=gate(); let n=0;
  s.readHook(async()=>{const g=n++===0?a:b; await g.promise; throw new Error('synthetic no-write');});
  const p=orders.commitOrderConditional(record('A'),'stale').catch(e=>e); const q=orders.commitOrderConditional(record('B'),'stale').catch(e=>e);
  try { if(reverse){b.release(); await q; a.release();await p;}else{a.release();await p;b.release();await q;} s.readHook(); ack.release(); await winner; s.reset(); assert.equal(await observed(),'WINNER');assert.equal(s.reads(),0); }
  finally {a.release();b.release();ack.release();await Promise.allSettled([winner,p,q]);}
});

test('real local adapter reconstruction reuses exact persisted version and fresh copies',async()=>{
  orders.__resetOrderStoreAdapterFactoryForTests(); delete process.env.BLOB_READ_WRITE_TOKEN;
  const dir=mkdtempSync(path.join(os.tmpdir(),'cache-local-regression-')); process.env.HSB_ORDER_STORE_DIR=dir;
  try {await orders.persistOrder(record()); const before=await orders.readOrderVersioned(ID); assert.ok(before); await commit('LOCAL');
    const body=readFileSync(path.join(dir,`${ID}.json`),'utf8'); const cached=await orders.readOrderVersioned(ID,{preferRecentCommit:true}); const fresh=await orders.readOrderVersioned(ID);
    assert.equal(cached?.version,fresh?.version); assert.deepEqual(cached?.order,JSON.parse(body)); cached!.order.childName='POISON'; assert.equal(await observed(),'LOCAL');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
