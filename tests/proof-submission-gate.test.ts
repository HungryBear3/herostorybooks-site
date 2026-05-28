import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOrderStatusView } from '../src/lib/order-status-view.ts';
import { createOrderRecord, persistOrder } from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import { getReviewSnapshot } from '../src/lib/page-review.ts';
import {
  evaluateProofSubmissionGate,
  isCustomProofGatedOrder,
} from '../src/lib/proof-submission-gate.ts';
import type { StoryMeta } from '../src/lib/fulfillment-types.ts';
import { lukasDinoArtDirectionFixture } from './fixtures/art-direction/lukas-dino-valid.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODEL_STORY_META: StoryMeta = {
  source: 'openai_page_prose',
  model: 'gpt-4o-mini',
  generatedAt: '2026-05-28T20:00:00.000Z',
  fallbackError: null,
};

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'luna@example.com' },
    { id: 'ord_gate_test', now: '2026-05-28T19:00:00.000Z' },
  );
  return {
    ...base,
    paymentStatus: 'paid',
    theme: 'custom-voice-story',
    storyMeta: MODEL_STORY_META,
    artDirectionPacket: lukasDinoArtDirectionFixture,
    ...overrides,
  };
}

function pageArtifacts() {
  return [
    {
      pageIndex: 0,
      storyText: 'Page 1',
      basePrompt: 'p',
      currentImageUrl: 'https://example.com/p0.png',
      acceptedImageUrl: null,
      generationProvider: null,
      generationModel: null,
      regenerateCount: 0,
      accepted: false,
      feedbackHistory: [],
      versionHistory: [],
    },
  ];
}

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-proof-gate-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

test('proof submission gate: valid custom story and art-direction packet pass', () => {
  const result = evaluateProofSubmissionGate(makeOrder());

  assert.equal(isCustomProofGatedOrder(makeOrder()), true);
  assert.equal(result.gated, true);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.reasons, []);
});

test('proof submission gate: missing custom story source blocks proof release', () => {
  const result = evaluateProofSubmissionGate(makeOrder({ storyMeta: null }));

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((reason) => reason.code === 'custom_story_source_missing'));
});

test('proof submission gate: template fallback source blocks proof release', () => {
  const result = evaluateProofSubmissionGate(makeOrder({
    storyMeta: {
      source: 'template_after_openai_failure',
      model: 'template:custom-voice-story',
      generatedAt: '2026-05-28T20:00:00.000Z',
      fallbackError: 'story provider failed',
    },
  }));

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((reason) => reason.code === 'custom_story_template_fallback'));
});

test('proof submission gate: missing or incomplete storyboard/art-direction blocks proof release', () => {
  const missing = evaluateProofSubmissionGate(makeOrder({ artDirectionPacket: null }));
  assert.equal(missing.allowed, false);
  assert.ok(missing.reasons.some((reason) => reason.code === 'art_direction_packet_missing'));

  const incompletePacket = structuredClone(lukasDinoArtDirectionFixture) as any;
  incompletePacket.storyboard.entries = incompletePacket.storyboard.entries.slice(0, 23);
  const incomplete = evaluateProofSubmissionGate(makeOrder({ artDirectionPacket: incompletePacket }));
  assert.equal(incomplete.allowed, false);
  assert.ok(incomplete.reasons.some((reason) =>
    reason.code === 'art_direction_packet_invalid' || reason.code === 'storyboard_incomplete',
  ));
});

test('proof submission gate: explicit bounded audited override can pass blocked checks', () => {
  const order = makeOrder({
    storyMeta: null,
    artDirectionPacket: null,
    proofReleaseOverride: {
      recordedAt: '2026-05-28T20:10:00.000Z',
      recordedBy: 'operator_abigail',
      reason: 'Manual launch spot-check verified custom story source and storyboard packet offline.',
      scope: 'full_proof_release',
    },
    auditEvents: [{
      at: '2026-05-28T20:10:00.000Z',
      type: 'proof_release_override_recorded',
      meta: { recordedBy: 'operator_abigail', scope: 'full_proof_release' },
    }],
  });

  const result = evaluateProofSubmissionGate(order, { now: new Date('2026-05-28T20:12:00.000Z') });
  assert.equal(result.allowed, true);
  assert.equal(result.overrideApplied, true);
  assert.ok(result.reasons.some((reason) => reason.code === 'custom_story_source_missing'));
});

test('proof submission gate: override without matching audit event does not pass', () => {
  const result = evaluateProofSubmissionGate(makeOrder({
    storyMeta: null,
    proofReleaseOverride: {
      recordedAt: '2026-05-28T20:10:00.000Z',
      recordedBy: 'operator_abigail',
      reason: 'Spot check.',
      scope: 'full_proof_release',
    },
    auditEvents: [],
  }), { now: new Date('2026-05-28T20:12:00.000Z') });

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((reason) => reason.code === 'human_override_invalid'));
});

test('customer status and review surfaces do not expose blocked proof_ready as ready', async () => {
  const dir = makeTmp();
  try {
    const order = makeOrder({
      fulfillmentStatus: 'proof_ready',
      status: 'preview_ready',
      storyArtifactUrl: 'https://example.com/proof.pdf',
      proofApprovalToken: 'tok_proof',
      storyMeta: null,
      artDirectionPacket: null,
      pageArtifacts: pageArtifacts(),
    });
    await persistOrder(order);

    const view = buildOrderStatusView(order);
    assert.equal(view.tone, 'neutral');
    assert.equal(view.needsAction, false);
    assert.equal(view.primaryAction, undefined);
    assert.doesNotMatch(view.headline, /ready for review/i);

    const snapshot = await getReviewSnapshot(order.id, { reviewToken: 'tok_proof' });
    assert.equal(snapshot, null);
  } finally {
    cleanup(dir);
  }
});
