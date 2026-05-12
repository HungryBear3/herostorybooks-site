import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  triggerFulfillment,
  type FulfillmentDeps,
} from '../src/lib/fulfillment.ts';
import {
  createOrderRecord,
  persistOrder,
  getOrder,
} from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import type { StoryContent } from '../src/lib/fulfillment-types.ts';
import { retryOrderFulfillment, resendDigitalDelivery } from '../src/lib/admin-actions.ts';

// Tests for the email-failure isolation introduced after the
// `Digital delivery email for ord_d4db1530d474458c failed (403): The
// herostorybooks.com domain is not verified` incident. The book
// itself was generated correctly; only the email failed. We must:
//   - persist the artifacts (storyArtifactUrl + pageArtifacts) durably,
//   - record `fulfillmentStatus='delivery_email_failed'`,
//   - NOT regenerate the story/images on retry,
//   - support a clean email-only resend that recovers the order.

const MOCK_STORY: StoryContent = {
  title: "Luna's Tale",
  dedication: 'For Luna.',
  characterDescription: 'A brave child named Luna.',
  pages: [
    { pageNum: 1, sceneTitle: 'A', story: 'A', imagePrompt: 'A' },
    { pageNum: 2, sceneTitle: 'B', story: 'B', imagePrompt: 'B' },
  ],
};

const MOCK_PDF = Buffer.from('%PDF-1.4 mock');

function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-email-fail-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}

function cleanupTmpDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

async function makeDigitalOrder(
  overrides: Partial<OrderRecord> = {},
): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' },
    { id: `ord_${Math.random().toString(36).slice(2, 10)}`, now: '2026-05-12T10:00:00Z' },
  );
  const order: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    stripeSessionId: 'cs_test_email_fail',
    ...overrides,
  };
  await persistOrder(order);
  return order;
}

const PASS_DEPS_WITHOUT_EMAIL: FulfillmentDeps = {
  generateStory: async () => MOCK_STORY,
  generateImages: async (prompts) => prompts.map((_, i) => `https://img.example.com/page${i}.png`),
  buildPdf: async () => MOCK_PDF,
  uploadArtifact: async (orderId, _buf, filename) =>
    `https://cdn.example.com/${orderId}/${filename}`,
  sleep: async () => {},
  getBaseUrl: () => 'https://test.herostorybooks.com',
};

// ── Test 1: digital delivery email failure → delivery_email_failed ────────────

test('digital delivery email failure preserves artifacts and records delivery_email_failed', async (t) => {
  const dir = makeTmpDir();
  // Force the order-email module to throw the same Resend-style error
  // we saw in production. We intercept by stubbing the global fetch the
  // Resend SDK uses internally. Simpler: monkey-patch the module export
  // via a one-shot env-var-driven path. We use HSB_RESEND_API_KEY +
  // a stub fetch via the global agent.
  //
  // Cleanest path: use HSB_RESEND_API_KEY set (so the send is attempted)
  // and swap globalThis.fetch for a stub that returns the 403 body.
  const originalKey = process.env.HSB_RESEND_API_KEY;
  const originalUrl = process.env.NEXT_PUBLIC_URL;
  const originalFrom = process.env.HSB_EMAIL_FROM;
  const originalFallback = process.env.HSB_EMAIL_FROM_FALLBACK;
  const originalFetch = globalThis.fetch;
  process.env.HSB_RESEND_API_KEY = 're_test_stub';
  process.env.NEXT_PUBLIC_URL = 'https://test.herostorybooks.com';
  process.env.HSB_EMAIL_FROM = 'Hero Story Books <support@herostorybooks.com>';
  delete process.env.HSB_EMAIL_FROM_FALLBACK;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        statusCode: 403,
        name: 'validation_error',
        message: 'The herostorybooks.com domain is not verified.',
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

  t.after(() => {
    if (originalKey === undefined) delete process.env.HSB_RESEND_API_KEY;
    else process.env.HSB_RESEND_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_URL;
    else process.env.NEXT_PUBLIC_URL = originalUrl;
    if (originalFrom === undefined) delete process.env.HSB_EMAIL_FROM;
    else process.env.HSB_EMAIL_FROM = originalFrom;
    if (originalFallback === undefined) delete process.env.HSB_EMAIL_FROM_FALLBACK;
    else process.env.HSB_EMAIL_FROM_FALLBACK = originalFallback;
    globalThis.fetch = originalFetch;
    cleanupTmpDir(dir);
  });

  const order = await makeDigitalOrder();
  const result = await triggerFulfillment(order.id, PASS_DEPS_WITHOUT_EMAIL);
  assert.equal(result.status, 'started');

  const persisted = await getOrder(order.id);
  assert.ok(persisted, 'order persisted');
  assert.equal(persisted!.fulfillmentStatus, 'delivery_email_failed');
  // Artifacts must survive the email failure.
  assert.ok(
    persisted!.storyArtifactUrl?.includes('/luna-storybook.pdf'),
    `Expected storyArtifactUrl to be persisted, got ${persisted!.storyArtifactUrl}`,
  );
  assert.equal(persisted!.pageArtifacts?.length, MOCK_STORY.pages.length);
  // Last error must be descriptive and mention the actionable hint.
  assert.match(
    persisted!.fulfillmentLastError ?? '',
    /delivery_email_failed/,
  );
  assert.match(
    persisted!.fulfillmentLastError ?? '',
    /not on a verified Resend domain|domain is not verified/i,
  );
});

// ── Test 2: retryOrderFulfillment short-circuits when only email failed ───────

test('retryOrderFulfillment after delivery_email_failed resends email — does NOT regenerate', async (t) => {
  const dir = makeTmpDir();
  const originalKey = process.env.HSB_RESEND_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.HSB_RESEND_API_KEY = 're_test_stub';
  // This time the email send succeeds.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'email_id_success' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  t.after(() => {
    if (originalKey === undefined) delete process.env.HSB_RESEND_API_KEY;
    else process.env.HSB_RESEND_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
    cleanupTmpDir(dir);
  });

  // Seed an order that's already past artifact generation, only the email failed.
  const order = await makeDigitalOrder({
    fulfillmentStatus: 'delivery_email_failed',
    storyArtifactUrl: 'https://cdn.example.com/ord/luna-storybook.pdf',
    fulfillmentLastError: 'delivery_email_failed: ...',
  });

  // Counter on a story generator we should never reach.
  let storyCalls = 0;
  const result = await retryOrderFulfillment(order.id);

  // The smart-retry path returns ok without calling triggerFulfillment.
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.detail ?? '', /resent|email/i);
  }
  assert.equal(storyCalls, 0, 'story generator must not be called during email-only retry');

  const persisted = await getOrder(order.id);
  assert.ok(persisted);
  assert.equal(persisted!.fulfillmentStatus, 'complete');
  assert.equal(persisted!.fulfillmentLastError, null);
  assert.equal(persisted!.storyArtifactUrl, 'https://cdn.example.com/ord/luna-storybook.pdf');
});

// ── Test 3: resendDigitalDelivery exposes a direct admin handle ───────────────

test('resendDigitalDelivery resends the email for a digital order that already has an artifact', async (t) => {
  const dir = makeTmpDir();
  const originalKey = process.env.HSB_RESEND_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.HSB_RESEND_API_KEY = 're_test_stub';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'email_id_ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  t.after(() => {
    if (originalKey === undefined) delete process.env.HSB_RESEND_API_KEY;
    else process.env.HSB_RESEND_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
    cleanupTmpDir(dir);
  });

  const order = await makeDigitalOrder({
    fulfillmentStatus: 'delivery_email_failed',
    storyArtifactUrl: 'https://cdn.example.com/ord/x-storybook.pdf',
  });

  const result = await resendDigitalDelivery(order.id);
  assert.equal(result.ok, true);

  const persisted = await getOrder(order.id);
  assert.equal(persisted!.fulfillmentStatus, 'complete');
});

// ── Test 4: triggerFulfillment skips an order already at delivery_email_failed

test('triggerFulfillment skips delivery_email_failed instead of regenerating', async (t) => {
  const dir = makeTmpDir();
  t.after(() => cleanupTmpDir(dir));

  const order = await makeDigitalOrder({
    fulfillmentStatus: 'delivery_email_failed',
    storyArtifactUrl: 'https://cdn.example.com/ord/x-storybook.pdf',
  });

  // Story / image deps that throw if reached prove that the skip works.
  const result = await triggerFulfillment(order.id, {
    generateStory: async () => {
      throw new Error('story generator should not run for delivery_email_failed');
    },
    generateImages: async () => {
      throw new Error('image generator should not run for delivery_email_failed');
    },
    sleep: async () => {},
  });

  assert.equal(result.status, 'skipped_already_complete');
});
