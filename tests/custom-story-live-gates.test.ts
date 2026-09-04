import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createOrderRecord, type OrderInput, type OrderRecord } from '../src/lib/orders.ts';
import { generateStoryWithMeta } from '../src/lib/story-generator.ts';
import { TACO_GATE_BRIEF } from './fixtures/taco-gate-brief.ts';

test('order route validates sanitized customStoryBrief before Stripe and returns manual_queue failures', () => {
  const source = readFileSync('src/app/api/order/route.ts', 'utf8');
  const validateIdx = source.indexOf('validateCustomStoryBrief(customStoryBrief)');
  const stripeIdx = source.indexOf('const stripe = getStripe()');
  assert.ok(validateIdx > 0, 'customStoryBrief validation is present');
  assert.ok(stripeIdx > 0, 'stripe creation is present');
  assert.ok(validateIdx < stripeIdx, 'custom brief validation must happen before Stripe creation');
  assert.match(source, /custom_story_manual_review_required/);
  assert.match(source, /custom_story_paid_beta_required/);
  assert.match(source, /CUSTOM_STORY_PAID_BETA_ENABLED/);
  assert.match(source, /value === '\"true\"'/);
});

test('order route does not call statusForShape on malformed customStoryBrief', () => {
  const source = readFileSync('src/app/api/order/route.ts', 'utf8');
  const validationIdx = source.indexOf('customStoryValidation = validateCustomStoryBrief(customStoryBrief)');
  const gatedStatusIdx = source.indexOf('customStoryValidation.ok\n        ? statusForShape(customStoryBrief.storyShape)');
  assert.ok(validationIdx > 0, 'validation assignment is present');
  assert.ok(gatedStatusIdx > validationIdx, 'status lookup is gated on a passing validation result');
  assert.match(source, /shapeStatus\?\.lane \?\? 'not-accepted'/);
});

test('createOrderRecord preserves sanitized customStoryBrief and validation snapshot', () => {
  const order = createOrderRecord({
    childName: 'Lukas',
    childPronouns: 'he/him',
    bookFormat: 'classic',
    email: 'parent@example.com',
    theme: 'custom-voice-story',
    customStoryBrief: TACO_GATE_BRIEF,
    customStoryValidation: { ok: true, route: 'proceed', failures: [] },
  });
  assert.equal(order.customStoryBrief?.workingTitle, 'Taco Gate at the Floating Taco Bar');
  assert.equal(order.customStoryBrief?.provenance.transcriptSanitized, true);
  assert.equal((order.customStoryBrief as unknown as Record<string, unknown>).rawTranscript, undefined);
  assert.equal(order.customStoryValidation?.route, 'proceed');
});

test('custom story generation refuses template fallback when LLM path fails', async () => {
  const previous = process.env.HSB_ENABLE_OPENAI_STORY;
  process.env.HSB_ENABLE_OPENAI_STORY = 'true';
  try {
    const order = createOrderRecord({
      childName: 'Lukas',
      childPronouns: 'he/him',
      bookFormat: 'classic',
      email: 'parent@example.com',
      theme: 'custom-voice-story',
      customStoryBrief: TACO_GATE_BRIEF,
      customStoryValidation: { ok: true, route: 'proceed', failures: [] },
    });
    await assert.rejects(
      () => generateStoryWithMeta(order, {
        fetch: async () => { throw new Error('provider offline'); },
      }),
      /template fallback is disabled for custom-story briefs/,
    );
  } finally {
    if (previous === undefined) delete process.env.HSB_ENABLE_OPENAI_STORY;
    else process.env.HSB_ENABLE_OPENAI_STORY = previous;
  }
});

test('unparsed media-backed Custom Stories fail before successful providers can ignore the source', async () => {
  const envKeys = ['OPENAI_API_KEY', 'HSB_ENABLE_OPENAI_STORY'] as const;
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.HSB_ENABLE_OPENAI_STORY = 'true';

  try {
    for (const fields of [
      { documentBlobPath: 'orders/test/story.pdf' },
      { voiceBlobPath: 'orders/test/voice.webm' },
    ]) {
      let providerCalls = 0;
      const order = createOrderRecord({
        childName: 'Lukas',
        childPronouns: 'he/him',
        bookFormat: 'classic',
        email: 'parent@example.com',
        theme: 'custom-voice-story',
        ...fields,
      });

      await assert.rejects(
        () => generateStoryWithMeta(order, {
          fetch: async () => {
            providerCalls += 1;
            return new Response(JSON.stringify({
              choices: [{ message: { content: JSON.stringify({
                title: 'Generic Adventure', dedication: 'For Lukas', characterDescription: 'A child',
                pages: [{ pageNum: 1, sceneTitle: 'Ignored source', story: 'Generic.', imagePrompt: 'Generic.' }],
              }) } }],
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          },
        }),
        /media-backed custom stories require operator-authored prose/,
      );
      assert.equal(providerCalls, 0);
    }
  } finally {
    for (const key of envKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('approved briefs do not opt media-backed Custom Stories into automated prose', async () => {
  const envKeys = ['OPENAI_API_KEY', 'HSB_ENABLE_OPENAI_STORY'] as const;
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.HSB_ENABLE_OPENAI_STORY = 'true';

  try {
    for (const fields of [
      { documentBlobPath: 'orders/test/story.pdf' },
      { voiceBlobPath: 'orders/test/voice.webm' },
    ]) {
      let providerCalls = 0;
      const order = createOrderRecord({
        childName: 'Lukas', childPronouns: 'he/him', bookFormat: 'classic',
        email: 'parent@example.com', theme: 'custom-voice-story',
        customStoryBrief: TACO_GATE_BRIEF,
        customStoryValidation: { ok: true, route: 'proceed', failures: [] },
        ...fields,
      });

      await assert.rejects(
        () => generateStoryWithMeta(order, {
          fetch: async () => {
            providerCalls += 1;
            throw new Error('provider must not be called');
          },
        }),
        /media-backed custom stories require operator-authored prose/,
      );
      assert.equal(providerCalls, 0);
    }
  } finally {
    for (const key of envKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('media-backed Custom Stories refuse generation before every template fallback path', async () => {
  const envKeys = [
    'OPENAI_API_KEY',
    'HSB_ENABLE_OPENAI_STORY',
    'HSB_ENABLE_OPENAI_PAGE_PROSE',
    'HSB_ENABLE_GEMINI_PAGE_PROSE',
    'HSB_ENABLE_OLLAMA_PAGE_PROSE',
    'GOOGLE_GEMINI_API_KEY',
  ] as const;
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];

  const mediaCases: Array<{
    label: string;
    fields: Partial<OrderInput>;
    recordFields?: Partial<OrderRecord>;
  }> = [
    { label: 'legacy voice', fields: { voiceBlobPath: 'orders/test/voice.webm' } },
    { label: 'legacy document', fields: { documentBlobPath: 'orders/test/story.pdf' } },
    { label: 'voice URL only', fields: { theme: 'space-voyager', voiceBlobUrl: 'https://private.invalid/voice' } },
    { label: 'document URL only', fields: { theme: 'space-voyager', documentBlobUrl: 'https://private.invalid/story' } },
    { label: 'voice transcript only', fields: { theme: 'space-voyager', voiceTranscript: { status: 'transcribed', text: 'private family memory' } } },
    { label: 'voice source only', fields: { theme: 'space-voyager', voiceSource: 'uploaded' } },
    { label: 'voice consent only', fields: { theme: 'space-voyager', voiceConsentAt: '2026-09-03T00:00:00.000Z' } },
    { label: 'document source only', fields: { theme: 'space-voyager', documentSource: 'uploaded' } },
    { label: 'document consent only', fields: { theme: 'space-voyager', documentConsentAt: '2026-09-03T00:00:00.000Z' } },
    { label: 'retired legacy filename marker only', fields: {}, recordFields: { legacyVoiceUploadPresent: true } },
    {
      label: 'private intake voice',
      fields: {},
      recordFields: {
        voiceIntakeMedia: {
          slotKey: 'voice', category: 'voice_inspiration', familyCharacterId: null,
          familyCharacterIndex: null, guidedStillIndex: null, assetId: 'asset_voice',
          pathname: 'checkout-intake/test/voice.webm', mimeType: 'audio/webm', size: 4,
          etag: 'etag-voice', generation: 1, consentAt: '2026-09-03T00:00:00.000Z',
          voiceSource: 'recorded',
        },
      },
    },
    {
      label: 'private intake document',
      fields: {},
      recordFields: {
        documentIntakeMedia: {
          slotKey: 'document', category: 'document_inspiration', familyCharacterId: null,
          familyCharacterIndex: null, guidedStillIndex: null, assetId: 'asset_document',
          pathname: 'checkout-intake/test/story.pdf', mimeType: 'application/pdf', size: 4,
          etag: 'etag-document', generation: 1, consentAt: '2026-09-03T00:00:00.000Z',
          voiceSource: null,
        },
      },
    },
  ];

  try {
    for (const { label, fields, recordFields } of mediaCases) {
      const order = {
        ...createOrderRecord({
        childName: 'Lukas',
        childPronouns: 'he/him',
        bookFormat: 'classic',
        email: 'parent@example.com',
        theme: 'space-voyager',
        ...fields,
        }),
        ...recordFields,
      };
      await assert.rejects(
        () => generateStoryWithMeta(order, {
          fetch: async () => { throw new Error('provider must remain unavailable'); },
        }),
        /media-backed custom stories require operator-authored prose/,
        label,
      );
    }
  } finally {
    for (const key of envKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('every enabled model path refuses unparsed media-backed Custom Stories before provider calls', async () => {
  const envKeys = [
    'OPENAI_API_KEY',
    'HSB_ENABLE_OPENAI_STORY',
    'HSB_ENABLE_OPENAI_PAGE_PROSE',
    'HSB_ENABLE_GEMINI_PAGE_PROSE',
    'HSB_ENABLE_OLLAMA_PAGE_PROSE',
    'GOOGLE_GEMINI_API_KEY',
  ] as const;
  const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const paths: Array<{ label: string; env: Partial<Record<(typeof envKeys)[number], string>> }> = [
    { label: 'OpenAI chat', env: { OPENAI_API_KEY: 'test-key', HSB_ENABLE_OPENAI_STORY: 'true' } },
    { label: 'OpenAI page prose', env: { OPENAI_API_KEY: 'test-key', HSB_ENABLE_OPENAI_PAGE_PROSE: 'true' } },
    { label: 'Ollama page prose', env: { HSB_ENABLE_OLLAMA_PAGE_PROSE: 'true' } },
    { label: 'Gemini page prose', env: { GOOGLE_GEMINI_API_KEY: 'test-key', HSB_ENABLE_GEMINI_PAGE_PROSE: 'true' } },
  ];

  try {
    for (const { label, env } of paths) {
      for (const key of envKeys) delete process.env[key];
      for (const [key, value] of Object.entries(env)) process.env[key] = value;
      const order = createOrderRecord({
        childName: 'Lukas', childPronouns: 'he/him', bookFormat: 'classic',
        email: 'parent@example.com', theme: 'custom-voice-story',
        documentBlobPath: 'orders/test/story.pdf',
      });
      await assert.rejects(
        () => generateStoryWithMeta(order, { fetch: async () => { throw new Error('provider offline'); } }),
        /media-backed custom stories require operator-authored prose/,
        label,
      );
    }
  } finally {
    for (const key of envKeys) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('custom story generation rejects unsanitized/non-approved briefs before provider calls', async () => {
  let called = false;
  const unsafe = {
    ...TACO_GATE_BRIEF,
    provenance: { ...TACO_GATE_BRIEF.provenance, transcriptSanitized: false, briefApprovedByOperator: false },
  };
  const order = createOrderRecord({
    childName: 'Lukas',
    childPronouns: 'he/him',
    bookFormat: 'classic',
    email: 'parent@example.com',
    theme: 'custom-voice-story',
    customStoryBrief: unsafe,
  });
  await assert.rejects(
    () => generateStoryWithMeta(order, {
      fetch: async () => {
        called = true;
        throw new Error('should not reach provider');
      },
    }),
    /custom story requires manual_queue/,
  );
  assert.equal(called, false);
});
