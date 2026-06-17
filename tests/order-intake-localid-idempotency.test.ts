/**
 * Reload/resume-safe asset dedupe via stable client localId.
 *
 * Before this: addIntakeAsset minted a new assetId per call and relied on the
 * client's in-memory File cache — so a lost-response retry or a post-reload
 * resubmit could append a duplicate (multi categories) or 4xx on a cap
 * (singleton categories). With a localId, the server returns the EXISTING asset
 * for the same (draftId, category, localId), making re-sends idempotent.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  addIntakeAsset,
  createIntakeDraft,
  getIntakeDraft,
} from '../src/lib/order-intake.ts';

async function withDraftStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hsb-localid-'));
  process.env.HSB_ORDER_DRAFT_STORE_DIR = path.join(dir, 'drafts');
  process.env.HSB_ORDER_STORE_DIR = path.join(dir, 'orders');
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}

function baseDraftInput() {
  return {
    childName: 'Lukas',
    childAge: '6',
    theme: 'custom-voice-story',
    lesson: 'courage',
    occasion: 'fathers-day',
    giftMessage: '',
    characterNotes: '',
    familyCharacters: [
      { role: 'dad', name: 'Dad', relationshipLabel: 'Dad', pronouns: 'he/him', notes: '', appearsInStory: true },
    ],
    appearanceOptions: JSON.stringify({ skinTone: 'light', hairStyle: 'brown short hair', eyewear: '' }),
    bookFormat: 'digital',
    email: 'alexyopenclaw+localid-test@gmail.com',
  };
}

const photo = (name = 'child.jpg') => new File(['fake-image-bytes'], name, { type: 'image/jpeg' });

// ── singleton category: re-send with same localId is idempotent (no cap 4xx) ──

test('primary_photo: same localId twice returns the SAME asset and does not duplicate', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  const lid = 'child.jpg|16|1700000000000';

  const first = await addIntakeAsset({ draftId: draft.id, category: 'primary_photo', file: photo(), localId: lid });
  const second = await addIntakeAsset({ draftId: draft.id, category: 'primary_photo', file: photo(), localId: lid });

  assert.equal(second.asset.assetId, first.asset.assetId, 're-send returns the same assetId');
  assert.equal(second.asset.localId, lid);
  const reloaded = await getIntakeDraft(draft.id);
  assert.equal(reloaded?.assets.filter((a) => a.category === 'primary_photo').length, 1, 'no duplicate appended');
});

// ── reload/resume: the in-memory File is a NEW object, but localId still dedupes ──

test('primary_photo: a fresh File object with the same localId still dedupes (reload/resume)', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  const lid = 'child.jpg|16|1700000000000';
  const first = await addIntakeAsset({ draftId: draft.id, category: 'primary_photo', file: photo(), localId: lid });
  // Simulate a post-reload resubmit: brand-new File instance, same logical file.
  const resumed = await addIntakeAsset({ draftId: draft.id, category: 'primary_photo', file: photo(), localId: lid });
  assert.equal(resumed.asset.assetId, first.asset.assetId);
});

// ── multi category: dedupe by localId, no duplicate, caps not consumed twice ──

test('guided_child_reference: same localId is idempotent; different localId adds a distinct asset', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  const a1 = await addIntakeAsset({ draftId: draft.id, category: 'guided_child_reference', file: photo('front.jpg'), guidedPhotoConsent: true, localId: 'front.jpg|16|1' });
  const a1Again = await addIntakeAsset({ draftId: draft.id, category: 'guided_child_reference', file: photo('front.jpg'), guidedPhotoConsent: true, localId: 'front.jpg|16|1' });
  const a2 = await addIntakeAsset({ draftId: draft.id, category: 'guided_child_reference', file: photo('left.jpg'), guidedPhotoConsent: true, localId: 'left.jpg|16|2' });

  assert.equal(a1Again.asset.assetId, a1.asset.assetId, 'same localId → same asset');
  assert.notEqual(a2.asset.assetId, a1.asset.assetId, 'different localId → distinct asset');
  const reloaded = await getIntakeDraft(draft.id);
  assert.equal(reloaded?.assets.filter((a) => a.category === 'guided_child_reference').length, 2, 'exactly two guided assets');
});

// ── backward compatibility: no localId preserves the existing cap behavior ──

test('no localId preserves legacy behavior: a second primary_photo still hits the cap', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  await addIntakeAsset({ draftId: draft.id, category: 'primary_photo', file: photo() });
  await assert.rejects(
    () => addIntakeAsset({ draftId: draft.id, category: 'primary_photo', file: photo() }),
    /Only one primary child photo/,
    'without localId the singleton cap still applies (unchanged legacy path)',
  );
});

test('localId is persisted on the asset ref', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  const { asset } = await addIntakeAsset({ draftId: draft.id, category: 'primary_photo', file: photo(), localId: 'x|1|2' });
  assert.equal(asset.localId, 'x|1|2');
  const reloaded = await getIntakeDraft(draft.id);
  assert.equal(reloaded?.assets[0].localId, 'x|1|2');
});

// ── body-bloat avoidance: the assets route + client send refs, never bytes to finalize ──

test('the assets route forwards localId and finalize stays refs-only (no file bytes)', () => {
  const assetsRoute = readFileSync('src/app/api/order/draft/[draftOrderId]/assets/route.ts', 'utf8');
  assert.match(assetsRoute, /localId/, 'assets route forwards localId to addIntakeAsset');

  const checkout = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  // Each file goes to the per-asset draft route; finalize carries only assetIds.
  assert.match(checkout, /\/api\/order\/draft\/\$\{draftOrderId\}\/assets/);
  assert.match(checkout, /assetPayload\.set\("localId"/);
  // Finalize body references assetIds, not raw File objects.
  assert.match(checkout, /\/api\/order\/finalize/);
  assert.match(checkout, /primaryPhotoAssetId|guidedChildReferenceAssetIds/);
});
