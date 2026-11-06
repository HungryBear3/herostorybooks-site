import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as orders from '../src/lib/orders.ts';
import type { OrderRecord, OrderStoreAdapter } from '../src/lib/orders.ts';

const ID = 'ord_00000000000000d4';
const record = (childName: string): OrderRecord => orders.createOrderRecord({ childName, bookFormat: 'digital', email: 'synthetic@example.invalid' }, { id: ID, now: '2026-08-05T00:00:00.000Z' });
const observe = () => orders.withOrderTransaction(ID, o => ({ abort: o.childName }));
const commit = (childName: string) => orders.withOrderTransaction(ID, o => ({ commit: { ...o, childName }, result: null }));
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
const saved = { ...process.env };
test.afterEach(() => {
  orders.__resetOrderStoreAdapterFactoryForTests();
  for (const key of ['HSB_ORDER_STORE_DIR','HSB_BLOB_NAMESPACE','BLOB_READ_WRITE_TOKEN','HSB_REQUIRE_DURABLE_PERSISTENCE','NODE_ENV','VERCEL']) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

test('real LocalAdapter: successful newline-bearing already-current B retracts stale cached A', async () => {
  orders.__resetOrderStoreAdapterFactoryForTests();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'repair-local-noop-'));
  process.env.HSB_ORDER_STORE_DIR = dir; process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false'; delete process.env.BLOB_READ_WRITE_TOKEN; delete process.env.HSB_BLOB_NAMESPACE;
  const file = path.join(dir, `${ID}.json`);
  try {
    await orders.persistOrder(record('A'));
    await commit('CACHED_A');
    assert.equal(await observe(), 'CACHED_A');
    const b = { ...JSON.parse(readFileSync(file, 'utf8')), childName: 'EXTERNAL_B' };
    const bytes = `${JSON.stringify(b, null, 2)}\n`;
    writeFileSync(file, bytes); // A different process's exact serialized landing.
    const claims = readdirSync(path.join(dir, '.cas')).sort();
    const noOps = orders.readLocalCasDiagnostics().unconditional_already_current;
    const returned = await orders.persistOrder(b);
    assert.equal(returned.childName, 'EXTERNAL_B');
    assert.equal(readFileSync(file, 'utf8'), bytes);
    assert.deepEqual(readdirSync(path.join(dir, '.cas')).sort(), claims, 'already-current success must consume no CAS claim');
    assert.equal(orders.readLocalCasDiagnostics().unconditional_already_current, noOps + 1, 'the real adapter must take the already-current branch');
    const authoritative = await orders.readOrderVersioned(ID);
    assert.equal(authoritative?.order.childName, 'EXTERNAL_B');
    assert.equal(await observe(), 'EXTERNAL_B', 'a successful central writer observed B, so it cannot retain cached A');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function synthetic() {
  let body = JSON.stringify(record('BASE')), version = 'v1', seq = 1, reads = 0, writes = 0;
  const factory = (): OrderStoreAdapter => ({ kind: 'repair-synthetic',
    async readVersioned() { reads++; return { body, version }; },
    async createIfAbsent() { writes++; return { ok: false, reason: 'exists' }; },
    async replaceIfVersion(_p, next, expected) { writes++; if (expected !== version) return {ok:false,reason:'version_conflict'}; body=next;version=`v${++seq}`;return {ok:true,version}; },
  });
  orders.__setOrderStoreAdapterFactoryForTests(factory);
  return { reset(){reads=0;writes=0;}, reads:()=>reads,writes:()=>writes,raw:()=>({body,version}) };
}

test('true pre-write serialization refusal preserves an existing valid cache without an adapter read', async () => {
  const s=synthetic(); await commit('WINNER'); s.reset();
  const proposal={...record('REFUSED'),toJSON(){throw new Error('synthetic serialization refusal');}};
  await assert.rejects(orders.persistOrder(proposal), /not_serializable/);
  assert.equal(await observe(),'WINNER'); assert.equal(s.reads(),0); assert.equal(s.writes(),0);
});

test('a delayed true pre-write refusal preserves a newer winner cache', async () => {
  const s=synthetic(); const entered=gate(),release=gate();
  const version=s.raw().version;
  // The independent baseline is the only pending work; the proposal is never serialized.
  let first=true;
  let raw={body:JSON.stringify(record('BASE')),version};let reads=0;
  first=true;
  orders.__setOrderStoreAdapterFactoryForTests(()=>({kind:'repair-newer-winner',
    async readVersioned(){reads++;if(first){first=false;entered.release();await release.promise;throw new Error('synthetic prewrite read refusal');}return {...raw};},
    async createIfAbsent(){return {ok:false,reason:'exists'};},
    async replaceIfVersion(_p,body,expected){if(expected!==raw.version)return {ok:false,reason:'version_conflict'};raw={body,version:'winner-version'};return {ok:true,version:raw.version};},
  }));
  const refused=orders.commitOrderConditional(record('REFUSED'),version);
  const rejection=assert.rejects(refused,/synthetic prewrite read refusal/);
  try {await entered.promise;await commit('NEWER_WINNER');release.release();await rejection;reads=0;assert.equal(await observe(),'NEWER_WINNER');assert.equal(reads,0);} finally {release.release();await Promise.allSettled([refused,rejection]);}
});

test('successful already-current observation preserves a newer winner publication',async()=>{
  const entered=gate(),release=gate();let reads=0,hold=false;
  let raw={body:JSON.stringify(record('BASE')),version:'v1'};let seq=1;
  orders.__setOrderStoreAdapterFactoryForTests(()=>({kind:'repair-noop-newer',
    async readVersioned(){reads++;const captured={...raw};if(hold){hold=false;entered.release();await release.promise;}return captured;},
    async createIfAbsent(){return {ok:false,reason:'exists'};},
    async replaceIfVersion(_p,body,expected){if(raw.version!==expected)return {ok:false,reason:'version_conflict'};raw={body,version:`v${++seq}`};return {ok:true,version:raw.version};},
  }));
  await commit('CACHED_A');const b={...JSON.parse(raw.body),childName:'B'};raw={body:`${JSON.stringify(b,null,2)}\n`,version:'external-b'};hold=true;
  const direct=orders.persistOrder(b);
  try {await entered.promise;await orders.withOrderTransaction(ID,o=>({commit:{...o,childName:'NEWER'},result:null}),{fresh:true});release.release();await direct;reads=0;assert.equal(await observe(),'NEWER');assert.equal(reads,0,'the newer winner entry must survive the older no-op completion');}
  finally {release.release();await Promise.allSettled([direct]);}
});

const validRef = () => ({ envelopeVersion:1 as const,orderId:ID,templateVersion:'synthetic-v1',createdAt:'2026-08-05T00:00:00.000Z',canonicalDigest:'a'.repeat(64),canonicalBytes:42,accountLabel:'synthetic',storageKind:'private_blob' as const,objectPath:`confirmation-envelopes/${ID}/v1.json`,purgedAt:null });

test('accepted ordinary proposal getter executes only after matching baseline',async()=>{
  const s=synthetic();let getters=0;const p={...record('GETTER'),confirmationEmailEnvelopeRef:validRef(),get childAge(){getters++;assert.equal(s.reads(),1);return 6;}} as unknown as OrderRecord;
  assert.equal((await orders.commitOrderConditional(p,'v1')).ok,true);assert.equal(getters,1);assert.equal(s.writes(),1);assert.equal(JSON.parse(s.raw().body).childAge,6);
});

for (const match of [true,false]) test(`descriptor privacy preflight: ${match?'matching':'mismatched'} baseline precedes ordinary proposal getters and hooks`, async () => {
  const s=synthetic(); const events:string[]=[];
  const proposal={...record('NEXT'),confirmationEmailEnvelopeRef:validRef(),get childAge(){events.push('getter');assert.ok(s.reads()>0);return 6;},toJSON(){events.push('toJSON');assert.ok(s.reads()>0);return {...record('NEXT'),confirmationEmailEnvelopeRef:validRef()};}} as unknown as OrderRecord;
  const result=await orders.commitOrderConditional(proposal,match?'v1':'stale');
  assert.equal(result.ok,match);assert.deepEqual(events,match?['toJSON']:[]);assert.equal(s.reads(),1);assert.equal(s.writes(),match?1:0);
});

for (const shape of ['ref-accessor','ref-field-accessor','inline','invalid-ref','boxed-label'] as const) test(`descriptor privacy refusal ${shape} invokes no caller getter/hook and no store`, async()=>{
  const s=synthetic(); let invoked=0; const p={...record('REFUSED'),toJSON(){invoked++;throw Error('must not run');}} as OrderRecord;
  if(shape==='ref-accessor')Object.defineProperty(p,'confirmationEmailEnvelopeRef',{enumerable:true,get(){invoked++;return validRef();}});
  else if(shape==='inline')Object.defineProperty(p,'confirmationEmailEnvelope',{enumerable:true,get(){invoked++;return {};}});
  else {const ref=validRef() as unknown as Record<string,unknown>;
    if(shape==='ref-field-accessor')Object.defineProperty(ref,'templateVersion',{enumerable:true,get(){invoked++;return 'x';}});
    if(shape==='invalid-ref')ref.html='synthetic-forbidden';
    if(shape==='boxed-label')ref.templateVersion={toString(){invoked++;return 'x';},toJSON(){invoked++;return 'x';}};
    Object.defineProperty(p,'confirmationEmailEnvelopeRef',{enumerable:true,value:ref});
  }
  await assert.rejects(orders.commitOrderConditional(p,'v1'),/confirmation_envelope_boundary:/);
  assert.equal(invoked,0);assert.equal(s.reads(),0);assert.equal(s.writes(),0);
});

test('descriptor preflight ignores a proxy ordinary-Get trap on raw id/ref until after baseline',async()=>{
  const s=synthetic();const target={...record('NEXT'),confirmationEmailEnvelopeRef:validRef()};let gets=0;
  const p=new Proxy(target,{get(t,k,r){if(k==='id'||k==='confirmationEmailEnvelopeRef'){gets++;assert.ok(s.reads()>0,'ordinary raw properties must not be read before baseline');}return Reflect.get(t,k,r);}});
  assert.equal((await orders.commitOrderConditional(p,'stale')).ok,false);assert.equal(gets,0);assert.equal(s.reads(),1);assert.equal(s.writes(),0);
});
