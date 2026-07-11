import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createOrderRecord } from '../src/lib/orders.ts';
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
