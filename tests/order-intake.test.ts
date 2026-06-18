import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  addIntakeAsset,
  buildOrderInputFromDraft,
  createIntakeDraft,
  finalizeIntakeDraft,
  getIntakeDraft,
  validateFinalizeAssets,
  validateIntakeAssetFile,
} from '../src/lib/order-intake.ts';

async function withDraftStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hsb-order-intake-'));
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
    characterNotes: 'Likes French fries.',
    familyCharacters: [
      { role: 'dad', name: 'Dad', relationshipLabel: 'Dad', pronouns: 'he/him', notes: 'Warm and funny', appearsInStory: true },
    ],
    appearanceOptions: JSON.stringify({ skinTone: 'light', hairStyle: 'brown short hair', eyewear: '' }),
    bookFormat: 'digital',
    email: 'alexyopenclaw+intake-test@gmail.com',
  };
}

test('split intake creates JSON draft without Stripe/session side effects', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  assert.match(draft.id, /^draft_/);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.assets.length, 0);
  assert.equal(draft.orderId, undefined);
  const reloaded = await getIntakeDraft(draft.id);
  assert.equal(reloaded?.fields.childName, 'Lukas');
});

test('split intake uploads one asset per call and persists refs before finalize', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  const file = new File(['fake-image'], 'child.jpg', { type: 'image/jpeg' });
  const { asset } = await addIntakeAsset({ draftId: draft.id, category: 'primary_photo', file, label: 'child front' });
  assert.match(asset.assetId, /^asset_/);
  assert.equal(asset.category, 'primary_photo');
  assert.equal(asset.fileName, 'child.jpg');
  const reloaded = await getIntakeDraft(draft.id);
  assert.equal(reloaded?.assets.length, 1);
  assert.equal(reloaded?.assets[0]?.assetId, asset.assetId);
});

test('split intake rejects video and oversize assets before payment', () => {
  const video = new File(['not-still'], 'clip.mp4', { type: 'video/mp4' });
  const rejected = validateIntakeAssetFile('primary_photo', video);
  assert.equal(rejected.ok, false);
  if (rejected.ok === false) assert.equal(rejected.code, 'asset_invalid_type');

  const huge = new File([new Uint8Array(16 * 1024 * 1024)], 'huge.jpg', { type: 'image/jpeg' });
  const tooLarge = validateIntakeAssetFile('guided_child_reference', huge);
  assert.equal(tooLarge.ok, false);
  if (tooLarge.ok === false) assert.equal(tooLarge.code, 'asset_too_large');
});

test('finalize rejects unknown asset refs before order persistence / Stripe', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  const result = validateFinalizeAssets(draft, { draftOrderId: draft.id, primaryPhotoAssetId: 'asset_missing' });
  assert.equal(result.ok, false);
  if (result.ok === false) assert.equal(result.code, 'asset_ref_unknown');
});

test('finalize maps persisted child, guided, family, and voice refs into final order', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  const primary = await addIntakeAsset({ draftId: draft.id, category: 'primary_photo', file: new File(['p'], 'primary.jpg', { type: 'image/jpeg' }), label: 'front' });
  const guided = await addIntakeAsset({ draftId: draft.id, category: 'guided_child_reference', file: new File(['g'], 'guided.jpg', { type: 'image/jpeg' }), guidedPhotoConsent: true, label: 'left', source: 'guided_capture' });
  const family = await addIntakeAsset({ draftId: draft.id, category: 'supporting_character_reference', file: new File(['d'], 'dad.jpg', { type: 'image/jpeg' }), label: 'dad', familyCharacterIndex: 0, familyCharacterId: 'family-0', supportingPhotoConsent: true });
  const voice = await addIntakeAsset({ draftId: draft.id, category: 'voice_inspiration', file: new File(['voice'], 'idea.webm', { type: 'audio/webm' }), label: 'story direction', source: 'recorded' });

  const reloaded = await getIntakeDraft(draft.id);
  assert.ok(reloaded);
  const orderInput = buildOrderInputFromDraft(reloaded!, {
    draftOrderId: draft.id,
    primaryPhotoAssetId: primary.asset.assetId,
    guidedChildReferenceAssetIds: [guided.asset.assetId],
    voiceAssetId: voice.asset.assetId,
  });
  assert.equal(orderInput.photoFileName, 'primary.jpg');
  assert.equal(orderInput.guidedReferencePhotos?.[0]?.assetId, guided.asset.assetId);
  assert.equal((orderInput.familyCharacters as any)[0].referencePhotos[0].assetId, family.asset.assetId);
  assert.equal(orderInput.voiceFileName, 'idea.webm');
  assert.equal(orderInput.voiceSource, 'recorded');

  const finalized = await finalizeIntakeDraft({
    draftOrderId: draft.id,
    primaryPhotoAssetId: primary.asset.assetId,
    guidedChildReferenceAssetIds: [guided.asset.assetId],
    voiceAssetId: voice.asset.assetId,
    finalConsent: { voice: true, photos: true, terms: true },
  });
  assert.equal(finalized.draft.status, 'finalized');
  assert.equal(finalized.order.paymentStatus, 'pending');
  assert.equal(finalized.order.stripeSessionId, null);
  assert.equal(finalized.order.guidedReferencePhotos?.length, 1);
});

test('finalize requires consent for voice or document inspiration refs', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  const voice = await addIntakeAsset({ draftId: draft.id, category: 'voice_inspiration', file: new File(['voice'], 'idea.webm', { type: 'audio/webm' }) });
  const reloaded = await getIntakeDraft(draft.id);
  assert.ok(reloaded);
  const rejected = validateFinalizeAssets(reloaded!, { draftOrderId: draft.id, voiceAssetId: voice.asset.assetId });
  assert.equal(rejected.ok, false);
  if (rejected.ok === false) assert.equal(rejected.code, 'voice_consent_required');
});

test('document inspiration refs map into final order inspiration attachment fields', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  const document = await addIntakeAsset({ draftId: draft.id, category: 'document_inspiration', file: new File(['Once upon a time'], 'story.txt', { type: 'text/plain' }) });
  const reloaded = await getIntakeDraft(draft.id);
  assert.ok(reloaded);
  const orderInput = buildOrderInputFromDraft(reloaded!, {
    draftOrderId: draft.id,
    documentAssetIds: [document.asset.assetId],
    finalConsent: { voice: true, photos: true, terms: true },
  });
  assert.equal(orderInput.voiceFileName, 'story.txt');
  assert.equal(orderInput.voiceSource, 'uploaded');
  const finalized = await finalizeIntakeDraft({
    draftOrderId: draft.id,
    documentAssetIds: [document.asset.assetId],
    finalConsent: { voice: true, photos: true, terms: true },
  });
  assert.equal(finalized.order.voiceFileName, 'story.txt');
});

test('draft ids reject traversal-shaped values before filesystem lookup', async () => {
  await withDraftStore();
  await assert.rejects(() => getIntakeDraft('../draft_escape'), /Invalid draft order id/);
});

test('guided references require explicit photo consent at server boundary', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  await assert.rejects(
    () => addIntakeAsset({ draftId: draft.id, category: 'guided_child_reference', file: new File(['g'], 'guided.jpg', { type: 'image/jpeg' }) }),
    /photo consent is required/,
  );
});

test('supporting family reference split uploads require explicit photo consent at server boundary', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  await assert.rejects(
    () => addIntakeAsset({
      draftId: draft.id,
      category: 'supporting_character_reference',
      file: new File(['d'], 'dad.jpg', { type: 'image/jpeg' }),
      familyCharacterIndex: 0,
      familyCharacterId: 'family-0',
    }),
    /permission to share each family or pet reference photo/,
  );

  const accepted = await addIntakeAsset({
    draftId: draft.id,
    category: 'supporting_character_reference',
    file: new File(['d'], 'dad.jpg', { type: 'image/jpeg' }),
    familyCharacterIndex: 0,
    familyCharacterId: 'family-0',
    supportingPhotoConsent: true,
    now: '2026-06-17T16:00:00.000Z',
  });
  assert.equal(accepted.asset.consentAt, '2026-06-17T16:00:00.000Z');
  const reloaded = await getIntakeDraft(draft.id);
  assert.equal(reloaded?.consent.supportingPhotoConsentAt, '2026-06-17T16:00:00.000Z');
});

test('server-side asset caps reject duplicate primary, family, and story inspiration uploads', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  await addIntakeAsset({ draftId: draft.id, category: 'primary_photo', file: new File(['p'], 'primary.jpg', { type: 'image/jpeg' }) });
  await assert.rejects(
    () => addIntakeAsset({ draftId: draft.id, category: 'primary_photo', file: new File(['p2'], 'primary2.jpg', { type: 'image/jpeg' }) }),
    /Only one primary child photo/,
  );
  await addIntakeAsset({ draftId: draft.id, category: 'supporting_character_reference', file: new File(['d'], 'dad.jpg', { type: 'image/jpeg' }), familyCharacterIndex: 0, supportingPhotoConsent: true });
  await assert.rejects(
    () => addIntakeAsset({ draftId: draft.id, category: 'supporting_character_reference', file: new File(['d2'], 'dad2.jpg', { type: 'image/jpeg' }), familyCharacterIndex: 0, supportingPhotoConsent: true }),
    /Only one supporting family reference/,
  );
  await addIntakeAsset({ draftId: draft.id, category: 'voice_inspiration', file: new File(['voice'], 'idea.webm', { type: 'audio/webm' }) });
  await assert.rejects(
    () => addIntakeAsset({ draftId: draft.id, category: 'voice_inspiration', file: new File(['voice2'], 'idea2.webm', { type: 'audio/webm' }) }),
    /Only one story inspiration file/,
  );
});

test('finalize validates and applies selected supporting family asset ids', async () => {
  await withDraftStore();
  const draft = await createIntakeDraft(baseDraftInput());
  const family = await addIntakeAsset({ draftId: draft.id, category: 'supporting_character_reference', file: new File(['d'], 'dad.jpg', { type: 'image/jpeg' }), label: 'dad', familyCharacterIndex: 0, familyCharacterId: 'family-0', supportingPhotoConsent: true });
  const reloaded = await getIntakeDraft(draft.id);
  assert.ok(reloaded);
  const missing = validateFinalizeAssets(reloaded!, { draftOrderId: draft.id, familyCharacterReferenceAssetIds: { 'family-0': 'asset_missing' } });
  assert.equal(missing.ok, false);
  if (missing.ok === false) assert.equal(missing.code, 'asset_ref_unknown');
  const orderInput = buildOrderInputFromDraft(reloaded!, {
    draftOrderId: draft.id,
    familyCharacterReferenceAssetIds: { 'family-0': family.asset.assetId },
  });
  assert.equal((orderInput.familyCharacters as any)[0].referencePhotos[0].assetId, family.asset.assetId);
});
