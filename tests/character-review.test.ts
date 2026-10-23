import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { characterReviewRequest, characterImagePath } from '../src/lib/character-review.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import type { ManualAdoptionDeps } from '../src/lib/manual-media-proof-adoption.ts';
async function fixture() {
 const image = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#ffcc33' } }).png().toBuffer();
 const digest = createHash('sha256').update(image).digest('hex');
 let order = { id: 'ord_synthetic', paymentStatus: 'paid', status: 'order_received', fulfillmentMode: 'manual_hold' } as OrderRecord; let rev = 1;
 const deps: ManualAdoptionDeps = { authenticate: () => true, now: () => new Date('2026-10-20T00:00:00Z'), readOrder: async () => ({ order: structuredClone(order), version: String(rev) }),
 readArtifact: async pathname => ({ pathname, body: image, contentType: 'image/png' }), commit: async (next, expected) => { if (expected !== String(rev)) return { ok: false }; order = next; rev++; return { ok: true }; } };
 const request = (data?: unknown, token = '', query = '') => new Request(`https://example.test/api${query}`, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, ...(data ? { body: JSON.stringify(data) } : {}) });
 async function publish(expectedVersion: string | null = null) { const res = await characterReviewRequest(request({ expectedVersion, imageHash: digest, description: 'A smiling adventurer', attestation: 'reviewed_exact_character_sheet' }), order.id, deps, true); return { res, data: await res.json() }; }
 return { deps, request, publish, get order() { return order; }, set order(o: OrderRecord) { order = o; }, digest };
}
const tokenOf = (data: { reviewPath: string }) => data.reviewPath.split('#token=')[1];
test('publication stores only hash, private image identity, expiring capability, no-send', async () => {
 const f = await fixture(); const { res, data } = await f.publish(); assert.equal(res.status, 200); assert.equal(data.sent, false);
 assert.equal(JSON.stringify(f.order).includes(tokenOf(data)), false); assert.ok(f.order.characterReview?.tokenHash); assert.equal(f.order.characterReview?.status, 'awaiting_customer');
 assert.equal(characterImagePath(f.order.id, f.digest), `orders/ord_synthetic/character-sheets/${f.digest}.png`);
});
for (const action of ['approve', 'request_changes']) test(`${action} creates atomic exactly-once durable event, repeat is idempotent`, async () => {
 const f = await fixture(); const { data } = await f.publish(); const payload = { action, version: data.version, comment: action === 'approve' ? '' : 'Please change hair' };
 for (let i = 0; i < 2; i++) assert.equal((await characterReviewRequest(f.request(payload, tokenOf(data)), f.order.id, f.deps)).status, 200);
 assert.equal(f.order.characterReview?.workQueue.length, 1); assert.equal(f.order.characterReview?.workQueue[0].status, 'pending');
 assert.equal(f.order.proofApprovedAt, undefined); assert.equal(f.order.printApprovedAt, undefined);
});
test('revision rotates token, rejects stale version and old image fetch, supersedes old queue', async () => {
 const f = await fixture(); const first = (await f.publish()).data;
 await characterReviewRequest(f.request({ action: 'request_changes', version: first.version, comment: 'hair' }, tokenOf(first)), f.order.id, f.deps);
 const second = (await f.publish(first.version)).data;
 assert.equal((await characterReviewRequest(f.request(undefined, tokenOf(first)), f.order.id, f.deps)).status, 403);
 assert.equal((await characterReviewRequest(f.request({ action: 'approve', version: first.version }, tokenOf(second)), f.order.id, f.deps)).status, 409);
 assert.equal((await characterReviewRequest(f.request(undefined, tokenOf(second), `?asset=image&version=${first.version}`), f.order.id, f.deps)).status, 409);
 assert.equal(f.order.characterReview?.workQueue[0].status, 'superseded');
});
test('expired, absent and plaintext legacy capabilities fail closed', async () => {
 const f = await fixture(); const { data } = await f.publish();
 for (const token of ['', 'wrong']) assert.equal((await characterReviewRequest(f.request(undefined, token), f.order.id, f.deps)).status, 403);
 f.deps.now = () => new Date('2026-10-28'); assert.equal((await characterReviewRequest(f.request(undefined, tokenOf(data)), f.order.id, f.deps)).status, 403);
});
test('CAS conflict does not claim publication or customer receipt', async () => {
 const f = await fixture(); const { data } = await f.publish(); f.deps.commit = async () => ({ ok: false });
 assert.equal((await f.publish(data.version)).res.status, 409);
 assert.equal((await characterReviewRequest(f.request({ version: data.version, action: 'approve' }, tokenOf(data)), f.order.id, f.deps)).status, 409);
 assert.equal(f.order.characterReview?.workQueue.length, 0);
});
test('unpaid, auth and cross-origin publication rejected', async () => {
 const f = await fixture(); f.deps.authenticate = () => false; assert.equal((await f.publish()).res.status, 401);
 f.deps.authenticate = () => true; f.order = { ...f.order, paymentStatus: 'pending' }; assert.equal((await f.publish()).res.status, 409);
 const req = new Request('https://example.test/api', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' });
 assert.equal((await characterReviewRequest(req, f.order.id, f.deps, true)).status, 403);
});
test('conflicting decisions and altered retries cannot create extra work', async () => {
 const f = await fixture(); const { data } = await f.publish(); const tok = tokenOf(data);
 await characterReviewRequest(f.request({ version: data.version, action: 'request_changes', comment: 'hair' }, tok), f.order.id, f.deps);
 for (const payload of [{ action: 'approve' }, { action: 'request_changes', comment: 'eyes' }]) assert.equal((await characterReviewRequest(f.request({ version: data.version, ...payload }, tok), f.order.id, f.deps)).status, 409);
 assert.equal(f.order.characterReview?.workQueue.length, 1);
});
test('private sheet bytes are hash-bound and version-bound', async () => {
 const f = await fixture(); const { data } = await f.publish(); const tok = tokenOf(data);
 const r = await characterReviewRequest(f.request(undefined, tok, `?asset=image&version=${data.version}`), f.order.id, f.deps);
 assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png'); assert.equal(r.headers.get('cache-control'), 'private, no-store');
 f.deps.readArtifact = async pathname => ({ pathname, body: Buffer.from('corrupt'), contentType: 'image/png' });
 assert.equal((await characterReviewRequest(f.request(undefined, tok, `?asset=image&version=${data.version}`), f.order.id, f.deps)).status, 409);
});
test('admin read exposes queue but not secret hash and image publication decodes PNG', async () => {
 const f = await fixture(); const { data } = await f.publish(); const r = await characterReviewRequest(f.request(), f.order.id, f.deps, true);
 const view = await r.json(); assert.equal(view.review.tokenHash, undefined); assert.equal(view.review.version, data.version);
 f.deps.readArtifact = async pathname => ({ pathname, body: Buffer.from('bad'), contentType: 'image/png' });
 assert.equal((await f.publish(data.version)).res.status, 400);
});
test('character route never exposes concrete identifiers or capability to analytics', async () => {
 const { sanitizeAnalyticsPath, sanitizeAnalyticsUrl } = await import('../src/lib/analytics-path.ts');
 assert.equal(sanitizeAnalyticsPath('/character-review/ord_secret#token=secret'), '/character-review/[orderId]');
 assert.equal(sanitizeAnalyticsUrl('https://example.test/character-review/ord_secret#token=secret'), 'https://example.test/character-review/[orderId]');
});
test('manual proof preflight rejects enrolled but unapproved character', async () => {
 const { assertPreparationOrder } = await import('../src/lib/manual-media-proof-contract.ts');
 const f = await fixture(); await f.publish();
 assert.throws(() => assertPreparationOrder({ ...f.order, voiceBlobPath: 'synthetic/voice', bookFormat: 'digital' }), /character_approval_required/);
});
test('unauthorized customer cannot distinguish payment or missing order', async () => {
 const f = await fixture(); f.order = { ...f.order, paymentStatus: 'pending' };
 assert.equal((await characterReviewRequest(f.request(), f.order.id, f.deps)).status, 403);
 f.deps.readOrder = async () => null;
 assert.equal((await characterReviewRequest(f.request(), f.order.id, f.deps)).status, 403);
});
test('staging dry-run validates exact local PNG without network or order writes', async () => {
 const { inspectCharacterSheet } = await import('../scripts/stage-character-sheet.ts');
 const { mkdtemp, writeFile } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
 const dir = await mkdtemp(join(tmpdir(), 'character-stage-')); const name = join(dir, 'sheet.png');
 const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#aabbcc' } }).png().toBuffer();
 await writeFile(name, image); const result = await inspectCharacterSheet('ord_synthetic', name);
 assert.equal(result.imageHash, createHash('sha256').update(image).digest('hex'));
 await assert.rejects(inspectCharacterSheet('../bad', name), /invalid_order_id/);
 await writeFile(name, 'not png'); await assert.rejects(inspectCharacterSheet('ord_synthetic', name), /invalid_png/);
});

test('same-origin browser authority works despite Next loopback URL normalization', async () => {
 const f = await fixture(); const { data } = await f.publish();
 const request = new Request('http://localhost:3194/api', { method: 'POST', headers: { Host: '127.0.0.1:3194', Origin: 'http://127.0.0.1:3194', Authorization: `Bearer ${tokenOf(data)}` }, body: JSON.stringify({ version: data.version, action: 'approve' }) });
 assert.equal((await characterReviewRequest(request, f.order.id, f.deps)).status, 200);
});
test('enrolled paid task must present current unexpired fence; renewed worker can publish',async()=>{
 const {paidEvent,mutateOutbox}=await import('../src/lib/paid-order-outbox.ts');
 const f=await fixture();let now=Date.parse('2026-10-20T00:00:00Z');f.deps.now=()=>new Date(now);
 f.order.settledAmountCents=3900;f.order.workOutbox=[paidEvent(f.order,'now')];const id=f.order.workOutbox[0].id;const claim=mutateOutbox(f.order,{action:'claim',eventId:id,lane:'agent',worker:'test'},now);f.order=claim.order;
 const payload={expectedVersion:null,imageHash:f.digest,description:'A smiling adventurer',attestation:'reviewed_exact_character_sheet',workFence:{eventId:id,token:claim.delivery.workToken}};
 assert.equal((await f.publish()).res.status,400);
 now+=100000;f.order=mutateOutbox(f.order,{action:'renew',eventId:id,lane:'agent',token:claim.delivery.workToken!},now).order;
 now+=100000;assert.equal((await characterReviewRequest(f.request(payload),f.order.id,f.deps,true)).status,200);
});
test('character image read cannot allow lease expiry or concurrent refund to adopt',async()=>{
 const {paidEvent,mutateOutbox}=await import('../src/lib/paid-order-outbox.ts');
 for(const mode of ['expire','refund']){
 const f=await fixture();let now=Date.parse('2026-10-20T00:00:00Z');f.deps.now=()=>new Date(now);f.order.settledAmountCents=3900;f.order.workOutbox=[paidEvent(f.order,'now')];const id=f.order.workOutbox[0].id;const claim=mutateOutbox(f.order,{action:'claim',eventId:id,lane:'agent',worker:'test'},now);f.order=claim.order;
 const read=f.deps.readArtifact;f.deps.readArtifact=async(...args)=>{if(mode==='expire')now+=600001;else {f.order={...f.order,refundedAt:'now'};f.deps.commit=async()=>({ok:false});}return read(...args);};
 const res=await characterReviewRequest(f.request({expectedVersion:null,imageHash:f.digest,description:'Safe',attestation:'reviewed_exact_character_sheet',workFence:{eventId:id,token:claim.delivery.workToken}}),f.order.id,f.deps,true);
 assert.notEqual(res.status,200);assert.equal(f.order.characterReview,undefined);
 }
});
test('operator can reissue expired enrolled invitation without altering character or queuing work',async()=>{
 const f=await fixture();const first=(await f.publish()).data;f.order.settledAmountCents=3900;
 const {paidEvent}=await import('../src/lib/paid-order-outbox.ts');f.order.workOutbox=[paidEvent(f.order,'now')];
 f.deps.now=()=>new Date('2026-11-20T00:00:00Z');
 const before=structuredClone(f.order.characterReview!);
 const response=await characterReviewRequest(f.request({action:'reissue_invitation',expectedVersion:before.version}),f.order.id,f.deps,true);
 assert.equal(response.status,200);const next=await response.json();assert.equal(next.sent,false);
 assert.equal(next.version,before.version);assert.equal(f.order.characterReview!.imageHash,before.imageHash);
 assert.deepEqual(f.order.characterReview!.workQueue,before.workQueue);
 assert.equal((await characterReviewRequest(f.request(undefined,tokenOf(first)),f.order.id,f.deps)).status,403);
 assert.equal((await characterReviewRequest(f.request(undefined,tokenOf(next)),f.order.id,f.deps)).status,200);
 f.order.characterReview!.status='approved';
 assert.equal((await characterReviewRequest(f.request({action:'reissue_invitation',expectedVersion:before.version}),f.order.id,f.deps,true)).status,409);
});
