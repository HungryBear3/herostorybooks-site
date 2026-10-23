import { manualProofSourceHash } from '../src/lib/manual-media-proof-contract.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { prepareManualMediaProof } from '../scripts/prepare-manual-media-proof.ts';
import { adoptManualMediaProof, manualArtifactPath, type ManualAdoptionDeps, type ManualManifest } from '../src/lib/manual-media-proof-adoption.ts';
import { canonicalSourceHash } from '../src/lib/review-source-identity.ts';
import { proofSourceFingerprint } from '../src/lib/fulfillment.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
const original = { id: 'ord_synthetic_adopt', childName: 'Synthetic', bookFormat: 'digital', status: 'order_received', paymentStatus: 'paid', fulfillmentMode: 'manual_hold', voiceBlobPath: 'synthetic/no-retrieval', pageArtifacts: [] } as unknown as OrderRecord;
let manifest: ManualManifest;
let objects: Map<string, { pathname: string; contentType: string; body: Buffer }>;
async function setup() {
  if (manifest) return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'hsb-adoption-'));
  await writeFile(path.join(root, 'art.png'), await sharp({ create: { width: 48, height: 48, channels: 3, background: '#446688' } }).png().toBuffer());
  const source = { orderId: original.id, expectedOrderHash: manualProofSourceHash(original), story: { title: 'Synthetic', characterDescription: 'Synthetic', pages: Array.from({ length: 24 }, (_, i) => ({ pageNum: i + 1, sceneTitle: `Scene ${i + 1}`, story: `Page ${i + 1}`, imagePrompt: 'operator-authored', textLayout: { zone: 'bottom_band' as const, colorMode: 'dark' as const, panelStyle: 'translucent_cream' as const } })) }, images: Array(24).fill('art.png') };
  const output = path.join(root, 'package');
  manifest = await prepareManualMediaProof(original, source, root, output) as ManualManifest;
  objects = new Map();
  for (const a of [manifest.proof, ...manifest.images]) objects.set(manualArtifactPath(manifest, a), { pathname: manualArtifactPath(manifest, a), contentType: a === manifest.proof ? 'application/pdf' : 'image/png', body: await readFile(path.join(output, a.filename)) });
}
function request(m = manifest, mode = 'adopt', hash = canonicalSourceHash(m)) {
  return new Request('https://local.invalid', { method: 'POST', body: JSON.stringify({ mode, manifest: m, expectedManifestHash: hash, attestation: 'reviewed_exact_candidate' }) });
}
function fixture() {
  let current = structuredClone(original); let version = 'v1'; let reads = 0; let commits = 0; let blobReads = 0;
  const deps: ManualAdoptionDeps = {
    authenticate: () => true,
    readOrder: async () => { reads++; return { order: structuredClone(current), version }; },
    readArtifact: async pathname => { blobReads++; return objects.get(pathname)!; },
    commit: async (next, expected) => { commits++; if (expected !== version) return { ok: false }; current = next; version = 'v2'; return { ok: true }; },
  };
  return { deps, get current() { return current; }, set current(o) { current = o; }, get counts() { return { reads, commits, blobReads }; } };
}
test('successful synthetic adoption is CAS-bound, zero-acceptance, unreleased and review-fingerprint compatible', async () => {
  await setup(); const f = fixture();
  const result = await adoptManualMediaProof(request(), original.id, f.deps);
  assert.equal(result.status, 200); assert.equal(result.body.status, 'adopted_unreleased');
  assert.equal(f.counts.commits, 1); assert.equal(f.current.pageArtifacts?.length, 24);
  assert.equal(f.current.pageArtifacts?.filter(p => p.accepted).length, 0);
  assert.equal(f.current.proofSourceFingerprint, proofSourceFingerprint(f.current));
  assert.equal(f.current.fulfillmentMode, 'manual_hold'); assert.equal(f.current.status, 'order_received');
  for (const key of ['proofApprovalToken', 'proofApprovalTokenHash', 'customerProofReleasedAt', 'proofApprovedAt', 'printJobId'] as const) assert.equal(f.current[key], undefined);
  assert.equal(f.current.privateStoryArtifact?.sha256, manifest.proof.sha256);
  const replay = await adoptManualMediaProof(request(), original.id, f.deps);
  assert.notEqual(replay.status, 200); assert.equal(f.counts.commits, 1);
});
test('preflight reads only order and cannot stage or adopt', async () => {
  await setup(); const f = fixture(); assert.equal((await adoptManualMediaProof(request(manifest, 'preflight'), original.id, f.deps)).status, 200);
  assert.deepEqual(f.counts, { reads: 1, commits: 0, blobReads: 0 });
});
test('unauthenticated request rejected before body or storage reads', async () => {
  await setup(); const f = fixture(); f.deps.authenticate = () => false;
  assert.equal((await adoptManualMediaProof(request(), original.id, f.deps)).status, 401);
  assert.deepEqual(f.counts, { reads: 0, commits: 0, blobReads: 0 });
});
for (const [label, change] of [
  ['wrong hash', (m: ManualManifest) => request(m, 'adopt', '0'.repeat(64))],
  ['cross-order', (m: ManualManifest) => request({ ...m, orderId: 'ord_other' })],
  ['tampered prose', (m: ManualManifest) => request({ ...m, story: { ...m.story, title: 'Different' } })],
  ['oversized descriptor', (m: ManualManifest) => request({ ...m, proof: { ...m.proof, bytes: 1e12 } })],
  ['unknown mode', (m: ManualManifest) => request(m, 'release')],
] as const) test(`refuse ${label}`, async () => { await setup(); const f = fixture(); assert.notEqual((await adoptManualMediaProof(change(manifest), original.id, f.deps)).status, 200); assert.equal(f.counts.commits, 0); });
for (const patch of [{ paymentStatus: 'refunded' }, { refundClaimId: 'claim' }, { fulfillmentMode: 'auto' }, { childName: 'Concurrent edit' }, { privateStoryArtifact: {} }]) test(`stale/unsafe state ${JSON.stringify(patch)}`, async () => {
  await setup(); const f = fixture(); f.current = { ...f.current, ...patch } as OrderRecord;
  assert.notEqual((await adoptManualMediaProof(request(), original.id, f.deps)).status, 200); assert.equal(f.counts.commits, 0);
});
test('refund during artifact verification refuses without commit', async () => {
  await setup(); const f = fixture(); const originalRead = f.deps.readArtifact;
  f.deps.readArtifact = async (...args) => { f.current = { ...f.current, paymentStatus: 'refunded' }; return originalRead(...args); };
  assert.notEqual((await adoptManualMediaProof(request(), original.id, f.deps)).status, 200); assert.equal(f.counts.commits, 0);
});
test('last-moment CAS conflict returns conflict and never rebases', async () => {
  await setup(); const f = fixture(); let attempts = 0;
  f.deps.commit = async () => { attempts++; return { ok: false }; };
  assert.equal((await adoptManualMediaProof(request(), original.id, f.deps)).status, 409); assert.equal(attempts, 1);
});
for (const kind of ['bytes', 'path', 'mime']) test(`private object ${kind} mismatch refuses`, async () => {
  await setup(); const f = fixture(); f.deps.readArtifact = async pathname => ({ ...objects.get(pathname)!, ...(kind === 'bytes' ? { body: Buffer.from('bad') } : kind === 'path' ? { pathname: 'orders/ord_other/proof' } : { contentType: 'text/html' }) });
  assert.notEqual((await adoptManualMediaProof(request(), original.id, f.deps)).status, 200); assert.equal(f.counts.commits, 0);
});
test('oversized unauthenticated-length body bounded', async () => { await setup(); const f = fixture(); const req = new Request('https://local.invalid', { method: 'POST', body: 'x'.repeat(513 * 1024) }); assert.notEqual((await adoptManualMediaProof(req, original.id, f.deps)).status, 200); assert.equal(f.counts.reads, 0); });
test('proof adoption rejects expired enrolled worker before artifact reads',async()=>{
 await setup();const {paidEvent,mutateOutbox}=await import('../src/lib/paid-order-outbox.ts');const f=fixture();const now=Date.now();f.current.settledAmountCents=3900;f.current.workOutbox=[paidEvent(f.current,'now')];f.current.characterReview={version:'approved-v1',status:'approved',imageHash:'a'.repeat(64),description:manifest.story.characterDescription,workQueue:[{id:'approved-event',kind:'character_approved',version:'approved-v1',status:'pending',at:'now'}]} as any;
 const claim=mutateOutbox(f.current,{action:'claim',eventId:'approved-event',lane:'agent',worker:'test'},now);f.current=claim.order;f.deps.now=()=>new Date(now+600001);
 const m=structuredClone(manifest);m.expectedOrderHash=manualProofSourceHash(f.current);m.candidateVersion=canonicalSourceHash({orderId:original.id,expectedOrderHash:m.expectedOrderHash,story:m.story,pages:m.story.pages.map((p,i)=>({pageIndex:i,storyText:p.story,textLayout:p.textLayout,currentImageUrl:`sha256:${m.images[i].sha256}`,acceptedImageUrl:null,accepted:false}))});
 const req=new Request('https://local.invalid',{method:'POST',body:JSON.stringify({mode:'adopt',manifest:m,expectedManifestHash:canonicalSourceHash(m),attestation:'reviewed_exact_candidate',workFence:{eventId:'approved-event',token:claim.delivery.workToken}})});
 const result=await adoptManualMediaProof(req,original.id,f.deps);assert.notEqual(result.status,200);assert.equal(f.counts.commits,0);assert.equal(f.counts.blobReads,0);
});
