/**
 * order-diagnostics — pure summary over OrderRecord. Used by the support
 * inspection endpoint, the admin detail page, and the CLI status script.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrderRecord, type OrderRecord, type PageArtifact } from '../src/lib/orders.ts';
import {
  buildOrderDiagnostics,
  classifyPaidOrderOpsIssue,
  formatDiagnosticsSummary,
} from '../src/lib/order-diagnostics.ts';

function pageFixture(i: number, overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `Page ${i + 1}`,
    basePrompt: 'p',
    currentImageUrl: `https://example.com/p${i}.png`,
    acceptedImageUrl: null,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'a@b.com' },
    { id: 'ord_diag_1', now: '2026-04-27T10:00:00Z' },
  );
  return { ...base, ...overrides };
}

test('diagnostics: payment pending → warn', () => {
  const d = buildOrderDiagnostics(makeOrder({ paymentStatus: 'pending' }));
  const c = d.checks.find((c) => c.id === 'payment');
  assert.equal(c?.severity, 'warn');
  assert.equal(d.flags.isPaid, false);
});

test('diagnostics: paid + proof ready + ack missing → warn on proof-ack', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    proofReviewedAt: null,
    pageArtifacts: [pageFixture(0, { accepted: true }), pageFixture(1, { accepted: true })],
  }));
  assert.equal(d.flags.proofReady, true);
  assert.equal(d.flags.proofAcknowledged, false);
  assert.equal(d.flags.needsCustomerAction, true);
  const ack = d.checks.find((c) => c.id === 'proof-ack');
  assert.equal(ack?.severity, 'warn');
});

test('diagnostics: paid + proof ready + acknowledged → ok', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    proofReviewedAt: '2026-04-27T11:00:00Z',
    pageArtifacts: [pageFixture(0, { accepted: true }), pageFixture(1, { accepted: true })],
  }));
  const ack = d.checks.find((c) => c.id === 'proof-ack');
  assert.equal(ack?.severity, 'ok');
  assert.equal(d.flags.proofAcknowledged, true);
});

test('diagnostics: failed_manual_review surfaces fail check with last error', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'failed_manual_review',
    fulfillmentLastError: 'OpenAI rate limit',
  }));
  const fail = d.checks.find((c) => c.id === 'failure');
  assert.equal(fail?.severity, 'fail');
  assert.match(fail?.detail ?? '', /rate limit/i);
  assert.equal(d.flags.isFailed, true);
});

test('diagnostics: story source/input summarizes custom lesson and inspiration upload metadata', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    theme: 'custom-voice-story',
    lesson: 'Always tell the truth, even when it is hard.',
    occasion: 'Father\'s Day',
    giftMessage: 'For Dad, with love.',
    characterNotes: 'Luna loves dinosaurs and bedtime jokes.',
    storyMeta: {
      source: 'template_after_openai_failure',
      model: 'template:custom-voice-story',
      generatedAt: '2026-05-28T18:00:00Z',
      fallbackError: 'OpenAI story fetch failed',
    },
    voiceFileName: 'story-ideas.pdf',
    voiceBlobPath: 'orders/ord_diag_1/voice/story-ideas.pdf',
    voiceSource: 'uploaded',
    voiceConsentAt: '2026-05-28T17:55:00Z',
    voiceTranscript: {
      transcript: 'Luna wants a dinosaur adventure with her dad.',
      inspiration: 'Use a dinosaur adventure with Dad as the emotional center.',
      model: 'gpt-4o-mini-transcribe',
      transcribedAt: '2026-05-28T17:56:00Z',
      error: null,
    },
  }));

  assert.equal(d.story.source, 'template_after_openai_failure');
  assert.equal(d.story.fallbackError, 'OpenAI story fetch failed');
  assert.equal(d.storyInput.hasCustomText, true);
  assert.equal(d.storyInput.lesson, 'Always tell the truth, even when it is hard.');
  assert.equal(d.storyInput.hasVoiceOrUpload, true);
  assert.equal(d.storyInput.voiceFileName, 'story-ideas.pdf');
  assert.equal(d.storyInput.voiceBlobPath, 'orders/ord_diag_1/voice/story-ideas.pdf');
  assert.equal(d.storyInput.transcriptStatus, 'stored');
  assert.match(d.storyInput.inspirationPreview ?? '', /dinosaur adventure/);

  const text = formatDiagnosticsSummary(d);
  assert.match(text, /Story: source=template_after_openai_failure/);
  assert.match(text, /fallbackError="OpenAI story fetch failed"/);
  assert.match(text, /Story input: .*lesson=Always tell the truth/);
  assert.match(text, /upload=yes/);
  assert.match(text, /file=story-ideas\.pdf/);
  assert.match(text, /transcript=stored/);
});

test('diagnostics: paid + not_started + no artifact is an ops attention item', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'not_started',
    storyArtifactUrl: null,
  }));
  assert.equal(d.flags.paidWithoutArtifact, true);
  assert.equal(d.flags.paidArtifactNeedsAttention, true);
  assert.equal(d.paidOrderOpsIssue?.kind, 'paid_no_artifact_not_started');
  const c = d.checks.find((c) => c.id === 'paid-artifact');
  assert.equal(c?.severity, 'fail');
});

test('classifyPaidOrderOpsIssue: fresh in-progress paid order waits before alerting', () => {
  const order = makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'generating_images',
    storyArtifactUrl: null,
    updatedAt: '2026-04-27T10:10:00Z',
  });
  const issue = classifyPaidOrderOpsIssue(order, new Date('2026-04-27T10:20:00Z'));
  assert.equal(issue?.kind, 'paid_no_artifact_waiting');
  assert.equal(issue?.severity, 'info');
});

test('classifyPaidOrderOpsIssue: stale in-progress paid order alerts', () => {
  const order = makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'building_pdf',
    storyArtifactUrl: null,
    updatedAt: '2026-04-27T10:00:00Z',
  });
  const issue = classifyPaidOrderOpsIssue(order, new Date('2026-04-27T10:16:00Z'));
  assert.equal(issue?.kind, 'paid_no_artifact_stale_in_progress');
  assert.equal(issue?.severity, 'fail');
});

test('diagnostics: paid + missing photo blob path → warn when filename present', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    photoFileName: 'kid.jpg',
    photoBlobPath: null,
  }));
  const photo = d.checks.find((c) => c.id === 'photo');
  assert.equal(photo?.severity, 'warn');
});

test('diagnostics: paid + no stripeSessionId → warn (recovery candidate)', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    stripeSessionId: null,
  }));
  const c = d.checks.find((c) => c.id === 'stripe-session');
  assert.equal(c?.severity, 'warn');
});

test('diagnostics: print order approved with no print job id → warn', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    bookFormat: 'classic',
    fulfillmentStatus: 'proof_approved',
    reviewStatus: 'approved',
    proofReviewedAt: '2026-04-27T11:00:00Z',
    proofApprovedAt: '2026-04-27T12:00:00Z',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    printJobId: null,
  }));
  const c = d.checks.find((c) => c.id === 'print-job');
  assert.equal(c?.severity, 'warn');
  assert.equal(d.flags.approved, true);
});

test('diagnostics: shipped order is happy-path ok', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    bookFormat: 'classic',
    fulfillmentStatus: 'complete',
    reviewStatus: 'approved',
    status: 'shipped',
    proofReviewedAt: '2026-04-27T11:00:00Z',
    proofApprovedAt: '2026-04-27T12:00:00Z',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    printJobId: 'PJ123',
    printJobStatus: 'SHIPPED',
    trackingNumber: '1Z999',
    shippedAt: '2026-04-30T10:00:00Z',
    shippingAddress: { line1: '123 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
  }));
  assert.equal(d.flags.shipped, true);
  const failing = d.checks.filter((c) => c.severity === 'fail');
  assert.equal(failing.length, 0);
  const shipped = d.checks.find((c) => c.id === 'shipped');
  assert.equal(shipped?.severity, 'ok');
});

test('formatDiagnosticsSummary: produces multi-line escalation block including ids and statuses', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    pageArtifacts: [pageFixture(0, { accepted: true })],
  }));
  const text = formatDiagnosticsSummary(d);
  assert.match(text, /Order ord_diag_1/);
  assert.match(text, /Payment: paid/);
  assert.match(text, /Fulfillment: proof_ready/);
});
