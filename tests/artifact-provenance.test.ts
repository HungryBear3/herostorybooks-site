import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertArtifactCanUseFilename,
  buildArtifactProvenanceManifest,
  guidedReferenceArtifactIdsForOrder,
  isCustomerLookingArtifactFilename,
} from '../src/lib/artifact-provenance.ts';
import { createOrderRecord } from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import type { StoryContent, StoryMeta } from '../src/lib/fulfillment-types.ts';
import type { GuidedReferencePhotoRecord } from '../src/lib/guided-photo-capture.ts';
import { lukasDinoArtDirectionFixture } from './fixtures/art-direction/lukas-dino-valid.ts';

const STORY: StoryContent = {
  title: 'A Real Story',
  characterDescription: 'A child in a warm picture-book style.',
  pages: [
    { pageNum: 1, sceneTitle: 'One', story: 'A real submitted idea begins.', imagePrompt: 'A real submitted scene.' },
  ],
};

const MODEL_META: StoryMeta = {
  source: 'openai_page_prose',
  model: 'gpt-4o-mini',
  generatedAt: '2026-05-29T15:00:00.000Z',
  fallbackError: null,
};

function guidedRef(label: string, n: number): GuidedReferencePhotoRecord {
  return {
    label,
    fileName: `${label}.jpg`,
    photoBlobPath: `orders/ord_provenance_test/guided-${n}-photo-${label}.jpg`,
    photoBlobUrl: `https://blob.example/guided-${n}-${label}.jpg`,
    source: 'guided_capture',
    consentAt: '2026-05-29T15:00:00.000Z',
  };
}

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Luna', bookFormat: 'classic', email: 'luna@example.com' },
      { id: 'ord_provenance_test', now: '2026-05-29T15:00:00.000Z' },
    ),
    paymentStatus: 'paid',
    ...overrides,
  };
}

test('customer proof manifest without transcript/planner/storyboard/prose lineage is rejected', () => {
  const manifest = buildArtifactProvenanceManifest({
    order: makeOrder({
      theme: 'custom-voice-story',
      voiceBlobPath: 'orders/ord_provenance_test/voice.m4a',
      artDirectionPacket: null,
      storyMeta: null,
    }),
    artifactPurpose: 'customer_proof',
    story: null,
    storyMeta: null,
    pageArtifacts: [],
    layoutArtifactId: null,
    generatorName: 'test',
  });

  assert.equal(manifest.lineageComplete, false);
  assert.deepEqual(
    manifest.missingLineage,
    [
      'transcriptArtifactId',
      'plannerArtifactId',
      'storyboardArtifactId',
      'proseArtifactId',
      'artPromptArtifactId',
      'layoutArtifactId',
    ],
  );
  assert.throws(() => assertArtifactCanUseFilename(manifest, 'luna-proof.pdf'), /lineage incomplete/);
});

test('synthetic internal order cannot produce a customer-looking proof manifest', () => {
  const manifest = buildArtifactProvenanceManifest({
    order: makeOrder({
      id: 'ord_internal_fixture_local',
      storyMeta: MODEL_META,
      artDirectionPacket: lukasDinoArtDirectionFixture,
    }),
    artifactPurpose: 'customer_proof',
    story: STORY,
    storyMeta: MODEL_META,
    pageArtifacts: null,
    layoutArtifactId: 'tmp/ord_internal_fixture_local/proof.pdf',
    generatorName: 'test',
  });

  assert.equal(manifest.isSynthetic, true);
  assert.throws(() => assertArtifactCanUseFilename(manifest, 'child-proof.pdf'), /synthetic artifacts cannot be customer_proof/);
});

test('diagnostic fixture filenames must be visibly non-customer', () => {
  const manifest = buildArtifactProvenanceManifest({
    order: makeOrder({ id: 'ord_internal_fixture_local' }),
    artifactPurpose: 'diagnostic_fixture',
    story: STORY,
    storyMeta: null,
    pageArtifacts: null,
    layoutArtifactId: 'tmp/fixture.html',
    generatorName: 'test',
  });

  assert.equal(isCustomerLookingArtifactFilename('sample-contact-sheet.html'), false);
  assert.equal(isCustomerLookingArtifactFilename('submitted-proof.pdf'), true);
  assert.throws(() => assertArtifactCanUseFilename(manifest, 'submitted-proof.pdf'), /requires artifactPurpose=customer_proof/);
  assert.doesNotThrow(() => assertArtifactCanUseFilename(manifest, 'diagnostic-fixture-contact-sheet.html'));
});

// ── guided reference photos in provenance ─────────────────────────────────────

test('guided reference photos appear in manifest.guidedReferenceArtifactIds + sourceAssets', () => {
  const order = makeOrder({
    storyMeta: MODEL_META,
    artDirectionPacket: lukasDinoArtDirectionFixture,
    guidedReferencePhotos: [guidedRef('front', 1), guidedRef('left', 2)],
  });
  const manifest = buildArtifactProvenanceManifest({
    order,
    artifactPurpose: 'diagnostic_fixture',
    story: STORY,
    storyMeta: MODEL_META,
    layoutArtifactId: 'tmp/fixture.html',
    generatorName: 'test',
  });
  assert.deepEqual(manifest.guidedReferenceArtifactIds, [
    'guided:front:orders/ord_provenance_test/guided-1-photo-front.jpg',
    'guided:left:orders/ord_provenance_test/guided-2-photo-left.jpg',
  ]);
  // Guided still blob paths are also surfaced as source assets.
  assert.ok(manifest.sourceAssets.includes('orders/ord_provenance_test/guided-1-photo-front.jpg'));
  assert.ok(manifest.sourceAssets.includes('orders/ord_provenance_test/guided-2-photo-left.jpg'));
});

test('guided reference photos are optional and never gate customer_proof lineage', () => {
  // Full lineage + guided refs → still complete (guided does not appear in missingLineage).
  const withGuided = buildArtifactProvenanceManifest({
    order: makeOrder({
      storyMeta: MODEL_META,
      artDirectionPacket: lukasDinoArtDirectionFixture,
      guidedReferencePhotos: [guidedRef('front', 1)],
    }),
    artifactPurpose: 'customer_proof',
    story: STORY,
    storyMeta: MODEL_META,
    layoutArtifactId: 'orders/ord_provenance_test/proof.pdf',
    generatorName: 'test',
  });
  assert.equal(withGuided.lineageComplete, true);
  assert.ok(!withGuided.missingLineage.includes('guidedReferenceArtifactIds'));

  // No guided refs → empty array, not a missing-lineage entry.
  const noGuided = makeOrder();
  assert.deepEqual(guidedReferenceArtifactIdsForOrder(noGuided), []);
});

// ── existing voice/custom-story lineage preserved ─────────────────────────────

test('voice source still requires a transcript artifact for customer_proof lineage', () => {
  const manifest = buildArtifactProvenanceManifest({
    order: makeOrder({ voiceBlobPath: 'orders/ord_provenance_test/voice.m4a', voiceSource: 'recorded' }),
    artifactPurpose: 'customer_proof',
    story: STORY,
    storyMeta: MODEL_META,
    layoutArtifactId: 'orders/ord_provenance_test/proof.pdf',
    generatorName: 'test',
  });
  assert.ok(manifest.missingLineage.includes('transcriptArtifactId'));
  assert.ok(manifest.sourceAssets.includes('orders/ord_provenance_test/voice.m4a'));
});
