/**
 * Local-only harness for the child-voice story regeneration slice.
 *
 * This deliberately uses a temp filesystem order store and synthetic order id.
 * It does not call Stripe, Lulu, image/PDF providers, admin production routes,
 * or real fulfillment providers. The story and art-direction providers are
 * local test stubs, proving the regenerated voice story is the input used to
 * build and persist the art-direction/storyboard packet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildArtDirectionPacketFromStory } from '../src/lib/art-direction-packet-builder.ts';
import { triggerFulfillment, type FulfillmentDeps } from '../src/lib/fulfillment.ts';
import { buildOrderDiagnostics, formatDiagnosticsSummary } from '../src/lib/order-diagnostics.ts';
import { getReviewSnapshot } from '../src/lib/page-review.ts';
import { evaluateProofSubmissionGate } from '../src/lib/proof-submission-gate.ts';
import { validateStoryboardCompleteness } from '../src/lib/storyboard-validator.ts';
import {
  createOrderRecord,
  getOrder,
  getStoryPageCount,
  persistOrder,
  type OrderRecord,
  type PageArtifact,
} from '../src/lib/orders.ts';
import type { StoryContent, StoryMeta } from '../src/lib/fulfillment-types.ts';
import { lukasDinoArtDirectionFixture } from './fixtures/art-direction/lukas-dino-valid.ts';

const OWNER_PAID_ORDER_ID = 'ord_d8ba45c3169b456f';
const SYNTHETIC_ORDER_ID = 'ord_internal_voice_regen_local_20260528';
const NOW = '2026-05-28T21:47:00.000Z';

const VOICE_STORY_META: StoryMeta = {
  source: 'openai_page_prose',
  model: 'local-harness:gpt-4o-mini-stub',
  generatedAt: '2026-05-28T21:49:00.000Z',
  fallbackError: null,
};

const MOCK_PDF = Buffer.from('%PDF-1.4 local voice regen harness');

const TEMPLATE_FALLBACK_STORY_META: StoryMeta = {
  source: 'template_after_openai_failure',
  model: 'template:Quest',
  generatedAt: '2026-05-28T18:31:00.000Z',
  fallbackError: 'fetch failed',
};

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-voice-regen-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.LULU_CLIENT_KEY;
  delete process.env.LULU_CLIENT_SECRET;
  delete process.env.FAL_KEY;
  delete process.env.OPENAI_API_KEY;
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

function syntheticVoiceOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const voiceTranscript = {
    transcript:
      'Lukas whispered that he wanted a tiny dinosaur friend named Sprout, a backyard map, and a brave bedtime adventure with Dad waiting at the porch light.',
    inspiration:
      'Regenerate the story around Lukas and Sprout following a backyard dinosaur map, with courage, gentle humor, and a warm return home to Dad.',
    model: 'local-harness-transcribe',
    transcribedAt: '2026-05-28T21:48:00.000Z',
    error: null,
  };

  const base = createOrderRecord(
    {
      childName: 'Lukas',
      childAge: '5',
      childPronouns: 'he/him',
      theme: 'custom-voice-story',
      lesson: 'voice-regenerated local dinosaur courage story',
      occasion: 'local harness proof',
      characterNotes: 'Lukas loves dinosaur maps and gentle bedtime jokes.',
      bookFormat: 'classic',
      email: 'local-voice-harness@example.invalid',
      voiceFileName: 'lukas-dino-voice-note.webm',
      voiceBlobPath: `orders/${SYNTHETIC_ORDER_ID}/voice-lukas-dino-voice-note.webm`,
      voiceConsentAt: '2026-05-28T21:47:30.000Z',
      voiceSource: 'recorded',
      voiceTranscript,
    },
    { id: SYNTHETIC_ORDER_ID, now: NOW },
  );

  return {
    ...base,
    paymentStatus: 'paid',
    stripeSessionId: 'cs_test_local_voice_regen_only',
    fulfillmentStatus: 'not_started',
    status: 'order_received',
    storyMeta: VOICE_STORY_META,
    artDirectionPacket: null,
    artDirectionValidation: null,
    artDirectionGeneratedAt: null,
    artDirectionHumanReviewStatus: null,
    artDirectionHumanReviewNotes: null,
    pageArtifacts: [],
    auditEvents: [
      {
        at: '2026-05-28T21:51:00.000Z',
        type: 'proof_generated',
        meta: { harness: true, source: 'local_temp_store' },
      },
    ],
    updatedAt: '2026-05-28T21:51:00.000Z',
    ...overrides,
  };
}

function regeneratedVoiceStory(inspiration: string | null): StoryContent {
  assert.ok(inspiration, 'synthetic voice inspiration must exist');
  const pageCount = getStoryPageCount('classic');
  return {
    title: 'Lukas and Sprout Follow the Backyard Map',
    dedication: 'For Lukas, whose brave bedtime ideas started the adventure.',
    characterDescription:
      'Lukas is a warm brown-eyed five-year-old child with a gentle dinosaur companion named Sprout.',
    pages: Array.from({ length: pageCount }, (_, index) => {
      const pageNumber = index + 1;
      const storyText =
      pageNumber === 1
        ? `${inspiration} Lukas opened the backyard map and listened for Sprout's friendly stomp.`
        : `Voice-regenerated page ${pageNumber}: Lukas and Sprout followed the map with courage and a bedtime-bright heart.`;
      return {
        pageNum: pageNumber,
        sceneTitle: `Voice Map Page ${pageNumber}`,
        story: storyText,
        imagePrompt:
          `Watercolor picture-book page ${pageNumber}. Lukas and Sprout follow the voice-inspired backyard dinosaur map. ` +
          `Use the persisted local transcript inspiration, no provider call.`,
      };
    }),
  };
}

function regeneratedVoicePageArtifacts(inspiration: string | null): PageArtifact[] {
  const story = regeneratedVoiceStory(inspiration);
  return story.pages.map((page, index) => ({
    pageIndex: index,
    storyText: page.story,
    basePrompt: page.imagePrompt,
    characterAnchor: story.characterDescription,
    currentImageUrl: `https://local.invalid/${SYNTHETIC_ORDER_ID}/pages/${index + 1}.png`,
    acceptedImageUrl: `https://local.invalid/${SYNTHETIC_ORDER_ID}/pages/${index + 1}.png`,
    generationProvider: 'openai',
    generationModel: 'local-harness-image-stub',
    generationConditioning: 'text_only',
    regenerateCount: 0,
    accepted: true,
    feedbackHistory: [],
    versionHistory: [
      {
        createdAt: '2026-05-28T21:50:30.000Z',
        imageUrl: `https://local.invalid/${SYNTHETIC_ORDER_ID}/pages/${index + 1}.png`,
        provider: 'openai',
        model: 'local-harness-image-stub',
        promptUsed: page.imagePrompt,
        conditioning: 'text_only',
        referencePhotoUrl: null,
      },
    ],
  }));
}

function pageArtifactsFromStory(story: StoryContent, orderId: string): PageArtifact[] {
  return story.pages.map((page, index) => ({
    pageIndex: index,
    storyText: page.story,
    basePrompt: page.imagePrompt,
    characterAnchor: story.characterDescription ?? null,
    currentImageUrl: `https://local.invalid/${orderId}/pages/${index + 1}.png`,
    acceptedImageUrl: `https://local.invalid/${orderId}/pages/${index + 1}.png`,
    generationProvider: 'openai',
    generationModel: 'local-harness-image-stub',
    generationConditioning: 'text_only',
    regenerateCount: 0,
    accepted: true,
    feedbackHistory: [],
    versionHistory: [
      {
        createdAt: '2026-05-28T21:50:30.000Z',
        imageUrl: `https://local.invalid/${orderId}/pages/${index + 1}.png`,
        provider: 'openai',
        model: 'local-harness-image-stub',
        promptUsed: 'local fixture image url; no image generation provider called',
        conditioning: 'text_only',
        referencePhotoUrl: null,
      },
    ],
  }));
}

test('voice story regen local harness: stubbed story builds and persists generated art-direction packet', async () => {
  const dir = makeTmp();
  try {
    assert.notEqual(SYNTHETIC_ORDER_ID, OWNER_PAID_ORDER_ID);
    assert.equal(existsSync(path.join(dir, `${OWNER_PAID_ORDER_ID}.json`)), false);

    const order = syntheticVoiceOrder();
    await persistOrder(order);
    const voiceStory = regeneratedVoiceStory(order.voiceTranscript?.inspiration ?? null);
    let storyCalls = 0;
    let imageCalls = 0;
    let artDirectionCalls = 0;
    let pdfCalls = 0;
    let printCalls = 0;

    const deps: FulfillmentDeps = {
      generateStoryWithMeta: async (storyOrder) => {
        storyCalls += 1;
        assert.equal(storyOrder.id, SYNTHETIC_ORDER_ID);
        assert.match(storyOrder.voiceTranscript?.inspiration ?? '', /backyard dinosaur map/);
        return { story: voiceStory, meta: VOICE_STORY_META };
      },
      buildArtDirectionPacket: async (input) => {
        artDirectionCalls += 1;
        assert.equal(input.order.id, SYNTHETIC_ORDER_ID);
        assert.equal(input.storyMeta.source, 'openai_page_prose');
        assert.equal(input.story.pages.length, 24);
        assert.match(input.story.pages[0]?.story ?? '', /backyard dinosaur map/);
        assert.match(input.story.pages[0]?.story ?? '', /Sprout/);
        return buildArtDirectionPacketFromStory(input, {
          provider: async (providerInput) => {
            assert.match(providerInput.story.pages[0]?.story ?? '', /backyard dinosaur map/);
            return lukasDinoArtDirectionFixture;
          },
          now: () => new Date('2026-05-28T21:50:00.000Z'),
        });
      },
      generateImageResults: async (prompts) => {
        imageCalls += 1;
        assert.equal(prompts.length, 24);
        assert.match(prompts[0] ?? '', /backyard dinosaur map/);
        return prompts.map((prompt, index) => ({
          imageUrl: `https://local.invalid/${SYNTHETIC_ORDER_ID}/pages/${index + 1}.png`,
          provider: 'openai',
          model: 'local-harness-image-stub',
          promptUsed: prompt,
          conditioning: 'text_only',
          referencePhotoUrl: null,
          latencyMs: 0,
          error: null,
        }));
      },
      buildPdf: async () => {
        pdfCalls += 1;
        return MOCK_PDF;
      },
      buildPrintInteriorPdf: async () => MOCK_PDF,
      uploadArtifact: async (_orderId, _buffer, filename) => `https://local.invalid/${SYNTHETIC_ORDER_ID}/${filename}`,
      submitPrint: async () => {
        printCalls += 1;
        throw new Error('submitPrint must not be called by local voice regen harness');
      },
      sleep: async () => {},
      getBaseUrl: () => 'https://local.invalid',
    };

    const result = await triggerFulfillment(SYNTHETIC_ORDER_ID, deps, {
      readbackMaxAttempts: 1,
      readbackInitialDelayMs: 0,
    });
    assert.equal(result.status, 'started');

    assert.equal(existsSync(path.join(dir, `${SYNTHETIC_ORDER_ID}.json`)), true);
    const persisted = await getOrder(SYNTHETIC_ORDER_ID);
    assert.ok(persisted);
    assert.equal(existsSync(path.join(dir, `${OWNER_PAID_ORDER_ID}.json`)), false);
    assert.equal(storyCalls, 1);
    assert.equal(artDirectionCalls, 1);
    assert.equal(imageCalls, 1);
    assert.equal(pdfCalls, 1);
    assert.equal(printCalls, 0);
    assert.equal(persisted.paymentStatus, 'paid');
    assert.equal(persisted.id, SYNTHETIC_ORDER_ID);
    assert.equal(persisted.voiceFileName, 'lukas-dino-voice-note.webm');
    assert.equal(persisted.voiceBlobPath, `orders/${SYNTHETIC_ORDER_ID}/voice-lukas-dino-voice-note.webm`);
    assert.equal(persisted.voiceSource, 'recorded');
    assert.equal(persisted.voiceConsentAt, '2026-05-28T21:47:30.000Z');
    assert.match(persisted.voiceTranscript?.transcript ?? '', /tiny dinosaur friend named Sprout/);
    assert.match(persisted.voiceTranscript?.inspiration ?? '', /backyard dinosaur map/);

    assert.equal(persisted.storyMeta?.source, 'openai_page_prose');
    assert.notEqual(persisted.storyMeta?.source, 'template');
    assert.equal(persisted.pageArtifacts?.length, 24);
    assert.ok(persisted.pageArtifacts?.[0]?.storyText.includes(persisted.voiceTranscript!.inspiration!));
    assert.equal(persisted.pageArtifacts?.[0]?.generationModel, 'local-harness-image-stub');

    const storyboard = validateStoryboardCompleteness(persisted.artDirectionPacket);
    assert.equal(storyboard.status, 'complete');
    assert.equal(storyboard.summary.actualEntries, 24);
    assert.equal(persisted.artDirectionGeneratedAt, '2026-05-28T21:50:00.000Z');
    assert.equal(persisted.artDirectionHumanReviewStatus, 'needs_review');

    const gate = evaluateProofSubmissionGate(persisted);
    assert.equal(gate.gated, true);
    assert.equal(gate.allowed, true);
    assert.deepEqual(gate.reasons, []);

    const diagnostics = buildOrderDiagnostics(persisted);
    assert.equal(diagnostics.payment.status, 'paid');
    assert.equal(diagnostics.story.source, 'openai_page_prose');
    assert.equal(diagnostics.storyInput.hasVoiceOrUpload, true);
    assert.equal(diagnostics.storyInput.transcriptStatus, 'stored');
    assert.equal(diagnostics.storyInput.voiceFileName, 'lukas-dino-voice-note.webm');
    assert.equal(diagnostics.artDirection.status, 'present');
    assert.equal(diagnostics.artDirection.storyboard.validationStatus, 'complete');
    assert.equal(diagnostics.artDirection.generatedAt, '2026-05-28T21:50:00.000Z');
    assert.equal(diagnostics.proofGate.gated, true);
    assert.equal(diagnostics.proofGate.allowed, true);
    assert.deepEqual(diagnostics.proofGate.reasons, []);
    assert.equal(diagnostics.artifacts.pageArtifactCount, 24);

    const summary = formatDiagnosticsSummary(diagnostics);
    assert.match(summary, /Story: source=openai_page_prose/);
    assert.match(summary, /Story input: .*upload=yes/);
    assert.match(summary, /file=lukas-dino-voice-note\.webm/);
    assert.match(summary, /Art direction: status=present schema=valid storyboard=complete/);
    assert.match(summary, /Proof gate: gated=yes allowed=yes/);

    const review = await getReviewSnapshot(SYNTHETIC_ORDER_ID, {
      reviewToken: persisted.proofApprovalToken!,
    });
    assert.ok(review);
    assert.equal(review!.storyArtifactUrl, `https://local.invalid/${SYNTHETIC_ORDER_ID}/lukas-proof.pdf`);
    assert.equal(review!.pageArtifacts.length, 24);
  } finally {
    cleanup(dir);
  }
});

test('voice story regen local harness: submitted-order-shaped fallback remains blocked without production mutation', async () => {
  const dir = makeTmp();
  try {
    const blockedOrder = syntheticVoiceOrder({
      id: 'ord_internal_submitted_shape_blocked_20260528',
      voiceBlobPath: 'orders/ord_internal_submitted_shape_blocked_20260528/voice-lukas-dino-voice-note.webm',
      paymentStatus: 'paid',
      fulfillmentStatus: 'proof_ready',
      status: 'preview_ready',
      storyMeta: TEMPLATE_FALLBACK_STORY_META,
      artDirectionPacket: null,
      artDirectionValidation: null,
      artDirectionGeneratedAt: null,
      artDirectionHumanReviewStatus: 'pending',
      artDirectionHumanReviewNotes: null,
      shippingAddress: null,
      storyArtifactUrl: 'https://local.invalid/ord_internal_submitted_shape_blocked_20260528/proof.pdf',
      proofApprovalToken: 'tok_local_blocked_submitted_shape',
      pageArtifacts: pageArtifactsFromStory(
        regeneratedVoiceStory('Submitted-shape fixture: proof artifacts exist but custom story generation fell back.'),
        'ord_internal_submitted_shape_blocked_20260528',
      ),
    });
    await persistOrder(blockedOrder);

    const persisted = await getOrder(blockedOrder.id);
    assert.ok(persisted);
    assert.equal(persisted.paymentStatus, 'paid');
    assert.equal(persisted.fulfillmentStatus, 'proof_ready');
    assert.equal(persisted.pageArtifacts?.length, 24);
    assert.equal(persisted.storyMeta?.source, 'template_after_openai_failure');
    assert.equal(persisted.artDirectionPacket, null);
    assert.equal(persisted.shippingAddress, null);

    const gate = evaluateProofSubmissionGate(persisted);
    assert.equal(gate.gated, true);
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.some((reason) => reason.code === 'custom_story_template_fallback'));
    assert.ok(gate.reasons.some((reason) => reason.code === 'art_direction_packet_missing'));

    const diagnostics = buildOrderDiagnostics(persisted);
    assert.equal(diagnostics.story.source, 'template_after_openai_failure');
    assert.equal(diagnostics.artDirection.status, 'absent');
    assert.equal(diagnostics.proofGate.allowed, false);
    assert.deepEqual(diagnostics.proofGate.reasons, [
      'custom_story_template_fallback',
      'art_direction_packet_missing',
    ]);
    assert.equal(diagnostics.print.hasShippingAddress, false);

    const summary = formatDiagnosticsSummary(diagnostics);
    assert.match(summary, /Story: source=template_after_openai_failure/);
    assert.match(summary, /Proof gate: gated=yes allowed=no/);
    assert.match(summary, /custom_story_template_fallback/);
    assert.match(summary, /art_direction_packet_missing/);

    const review = await getReviewSnapshot(blockedOrder.id, {
      reviewToken: 'tok_local_blocked_submitted_shape',
    });
    assert.equal(review, null);
  } finally {
    cleanup(dir);
  }
});

test('voice story regen local harness: missing packet and template provenance stay blocked', async () => {
  const templateOrder = syntheticVoiceOrder({
    storyMeta: {
      source: 'template',
      model: 'template:custom-voice-story',
      generatedAt: '2026-05-28T21:49:00.000Z',
      fallbackError: null,
    },
  });
  const templateGate = evaluateProofSubmissionGate(templateOrder);
  assert.equal(templateGate.allowed, false);
  assert.ok(templateGate.reasons.some((reason) => reason.code === 'custom_story_template_source'));

  const missingPacketOrder = syntheticVoiceOrder({
    artDirectionPacket: null,
    artDirectionValidation: null,
    artDirectionHumanReviewStatus: 'needs_review',
  });
  const missingPacketGate = evaluateProofSubmissionGate(missingPacketOrder);
  assert.equal(missingPacketGate.allowed, false);
  assert.ok(missingPacketGate.reasons.some((reason) => reason.code === 'art_direction_packet_missing'));

  const incompletePacket = structuredClone(lukasDinoArtDirectionFixture) as typeof lukasDinoArtDirectionFixture;
  incompletePacket.storyboard.entries = incompletePacket.storyboard.entries.slice(0, 23);
  const incompleteGate = evaluateProofSubmissionGate(syntheticVoiceOrder({
    artDirectionPacket: incompletePacket,
    artDirectionValidation: validateStoryboardCompleteness(incompletePacket),
  }));
  assert.equal(incompleteGate.allowed, false);
  assert.ok(incompleteGate.reasons.some((reason) =>
    reason.code === 'art_direction_packet_invalid' || reason.code === 'storyboard_incomplete',
  ));
});
