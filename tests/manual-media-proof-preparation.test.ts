import { manualProofSourceHash } from '../src/lib/manual-media-proof-contract.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { assertPreparationOrder, assertSnapshotCurrent, prepareManualMediaProof, sha256 } from '../scripts/prepare-manual-media-proof.ts';
import { canonicalSourceHash } from '../src/lib/review-source-identity.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
const order = { id: 'ord_synthetic', childName: 'Synthetic', bookFormat: 'digital', status: 'order_received', paymentStatus: 'paid', fulfillmentMode: 'manual_hold', voiceBlobPath: 'synthetic/no-retrieval', pageArtifacts: [] } as unknown as OrderRecord;
for (const patch of [
  { fulfillmentStatus: 'building_pdf' }, { printInteriorArtifactUrl: 'existing' }, { paymentStatus: 'pending' }, { paymentStatus: 'refunded' }, { fulfillmentMode: 'auto' },
  { voiceBlobPath: null }, { status: 'shipped' }, { storyArtifactUrl: 'existing' }, { proofVersion: 'existing' },
  { proofApprovalToken: 'existing' }, { customerProofReleasedAt: 'existing' }, { printJobId: 'existing' },
  { printSubmissionAttemptedAt: 'existing' }, { fulfillmentKickoffId: 'existing' }, { bookFormat: 'unknown' },
]) test(`reject ${JSON.stringify(patch)}`, () => assert.throws(() => assertPreparationOrder({ ...order, ...patch } as OrderRecord)));
test('conservative full snapshot rejects stale payment and unrelated order changes', () => {
  assertSnapshotCurrent(order, manualProofSourceHash(order));
  assert.throws(() => assertSnapshotCurrent({ ...order, childName: 'Changed' }, manualProofSourceHash(order)), /order_snapshot_changed/);
});
test('offline synthetic operator rehearsal and adversarial source validation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hsb-manual-proof-'));
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } }).png().toBuffer();
  await writeFile(path.join(root, 'art.png'), bytes);
  const source = { orderId: order.id, expectedOrderHash: manualProofSourceHash(order), story: { title: 'Synthetic rehearsal', characterDescription: 'Synthetic', pages: Array.from({ length: 24 }, (_, i) => ({ pageNum: i + 1, sceneTitle: `Scene ${i + 1}`, story: `Synthetic page ${i + 1}.`, imagePrompt: 'operator-authored', textLayout: { zone: 'bottom_band' as const, colorMode: 'dark' as const, panelStyle: 'translucent_cream' as const } })) }, images: Array(24).fill('art.png') };
  const network = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network_forbidden'); };
  try {
    const output = path.join(root, 'candidate');
    const result = await prepareManualMediaProof(order, source, root, output);
    assert.equal(result.status, 'local_candidate_not_adopted');
    assert.equal(result.customerReleaseAuthorized, false);
    assert.equal(result.proof.sha256, sha256(await readFile(path.join(output, 'candidate.pdf'))));
    assert.match((await readFile(path.join(output, 'candidate.pdf'))).subarray(0, 5).toString(), /%PDF-/);
    assert.deepEqual(order.pageArtifacts, []);
    await assert.rejects(prepareManualMediaProof(order, source, root, output), /EEXIST/);
    await assert.rejects(prepareManualMediaProof(order, { ...source, orderId: 'ord_other' }, root, path.join(root, 'bad')), /binding/);
    await assert.rejects(prepareManualMediaProof(order, { ...source, images: Array(24).fill('https://invalid/art.png') }, root, path.join(root, 'bad')), /local_relative/);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'hsb-outside-'));
    await writeFile(path.join(outside, 'art.png'), bytes);
    await symlink(outside, path.join(root, 'escape'));
    await assert.rejects(prepareManualMediaProof(order, { ...source, images: Array(24).fill('escape/art.png') }, root, path.join(root, 'bad')), /outside_input_root/);
    await writeFile(path.join(root, 'corrupt.png'), Buffer.from('not an image'));
    await assert.rejects(prepareManualMediaProof(order, { ...source, images: Array(24).fill('corrupt.png') }, root, path.join(root, 'corrupt')));
    const partial = { ...source, story: { ...source.story, pages: source.story.pages.slice(1) }, images: source.images.slice(1) };
    await assert.rejects(prepareManualMediaProof(order, partial, root, path.join(root, 'partial')), /page_identity|page_contract/);
    const duplicate = { ...source, story: { ...source.story, pages: source.story.pages.map(p => ({ ...p, pageNum: 1 })) } };
    await assert.rejects(prepareManualMediaProof(order, duplicate, root, path.join(root, 'duplicate')), /page_identity/);
  } finally { globalThis.fetch = network; }
});
test('stable proof source tolerates only explicit operational fields, not semantic changes',()=>{
 const o=structuredClone(order);
 const hash=manualProofSourceHash(o);
 for(const delta of [{updatedAt:'later'},{workOutbox:[]},{stripePaymentIntentId:'pi_backfill'}])assert.equal(manualProofSourceHash({...o,...delta}),hash);
 for(const delta of [{childName:'changed'},{bookFormat:'premium'},{paymentStatus:'refunded'},{settledAmountCents:0},{characterReview:{version:'v2',imageHash:'changed'}},{printUpgradeTargetFormat:'premium'},{shippingAddress:{city:'changed'}}])assert.notEqual(manualProofSourceHash({...o,...delta} as any),hash);
});
