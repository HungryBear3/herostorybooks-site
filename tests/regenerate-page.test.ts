import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, persistOrder, getOrder } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import {
  applyAcceptPage,
  applyRegeneratePage,
  regeneratePage,
  acceptPage,
} from '../src/lib/page-review.ts';
import {
  buildRegeneratePrompt,
  deriveFeedbackTags,
} from '../src/lib/image-prompt-builder.ts';
import { pageImageUrlsFromArtifacts, imageUrlForPage } from '../src/lib/fulfillment.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';
import { isValidPageTextLayout } from '../src/lib/fulfillment-types.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-pagereview-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  process.env.HSB_ENABLE_OPENAI_IMAGE = 'true';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
  delete process.env.HSB_ENABLE_OPENAI_IMAGE;
}

function pageFixture(i: number, overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `Page ${i + 1} story`,
    basePrompt: `prompt for page ${i + 1}`,
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

async function seedOrder(overrides: Partial<OrderRecord> = {}, id = 'ord_review_test'): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' },
    { id, now: '2026-04-26T10:00:00Z' },
  );
  const order: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    pageArtifacts: [pageFixture(0), pageFixture(1), pageFixture(2)],
    reviewStatus: 'in_review',
    ...overrides,
  };
  await persistOrder(order);
  return order;
}

const successProvider: ImageProvider = {
  name: 'openai',
  async generate({ prompt }) {
    return {
      imageUrl: 'https://example.com/regenerated.png',
      provider: 'openai',
      model: 'gpt-image-1',
      promptUsed: prompt,
      latencyMs: 1,
      error: null,
    };
  },
};

const failingOpenAI: ImageProvider = {
  name: 'openai',
  async generate({ prompt }) {
    return {
      imageUrl: null,
      provider: 'openai',
      model: 'gpt-image-1',
      promptUsed: prompt,
      latencyMs: 1,
      error: 'OpenAI 500',
    };
  },
};

const successFAL: ImageProvider = {
  name: 'fal',
  async generate({ prompt }) {
    return {
      imageUrl: 'https://example.com/fal.png',
      provider: 'fal',
      model: 'fal-flux',
      promptUsed: prompt,
      latencyMs: 1,
      error: null,
    };
  },
};

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('deriveFeedbackTags picks up keywords for hands and face_similarity', () => {
  const tags = deriveFeedbackTags('Please fix the hands and make the face look more like the photo');
  assert.ok(tags.includes('hands'));
  assert.ok(tags.includes('face_similarity'));
});

test('buildRegeneratePrompt sanitizes and includes constraints', () => {
  const result = buildRegeneratePrompt({
    basePrompt: 'A child explores a forest',
    feedback: 'fix the hands\u0000',
    order: {
      childName: 'Luna',
      childAge: '6',
      characterNotes: 'curly red hair',
      appearanceOptions: 'fair skin',
      photoBlobPath: 'orders/x/photo.jpg',
      theme: 'brave-explorer',
    },
  });
  assert.ok(result.tags.includes('hands'));
  assert.match(result.prompt, /Luna/);
  assert.match(result.prompt, /Reference photo/);
  assert.match(result.prompt, /exactly two hands/);
  assert.equal(result.sanitizedFeedback.includes('\u0000'), false);
});

test('applyAcceptPage: marks targeted page accepted and copies currentImageUrl', () => {
  const artifacts = [pageFixture(0), pageFixture(1), pageFixture(2)];
  const { artifacts: next, page } = applyAcceptPage(artifacts, 1);
  assert.ok(page);
  assert.equal(next[1].accepted, true);
  assert.equal(next[1].acceptedImageUrl, 'https://example.com/p1.png');
  // Other pages unchanged
  assert.equal(next[0].accepted, false);
  assert.equal(next[2].accepted, false);
});

test('applyAcceptPage: rejects page with no image', () => {
  const artifacts = [pageFixture(0, { currentImageUrl: null })];
  const result = applyAcceptPage(artifacts, 0);
  assert.equal(result.error, 'page_has_no_image_to_accept');
});

test('applyRegeneratePage: only mutates target page; others byref', () => {
  const artifacts = [
    pageFixture(0, { accepted: true, acceptedImageUrl: 'https://example.com/p0.png' }),
    pageFixture(1),
    pageFixture(2, { accepted: true, acceptedImageUrl: 'https://example.com/p2.png' }),
  ];
  const { artifacts: next } = applyRegeneratePage(
    artifacts,
    1,
    'https://new.png',
    'openai',
    'gpt-image-1',
    'prompt',
    {
      createdAt: '2026-04-26T10:00:00Z',
      rawText: 'fix it',
      tags: [],
      providerTried: 'openai',
      resultImageUrl: 'https://new.png',
      success: true,
    },
  );
  // Page 0 + 2 still accepted with original URLs
  assert.equal(next[0].accepted, true);
  assert.equal(next[0].acceptedImageUrl, 'https://example.com/p0.png');
  assert.equal(next[2].accepted, true);
  assert.equal(next[2].acceptedImageUrl, 'https://example.com/p2.png');
  // Page 1 has new image, not accepted, regenerateCount bumped, history appended
  assert.equal(next[1].currentImageUrl, 'https://new.png');
  assert.equal(next[1].accepted, false);
  assert.equal(next[1].regenerateCount, 1);
  assert.equal(next[1].feedbackHistory.length, 1);
  assert.equal(next[1].versionHistory.length, 1);
});

test('applyRegeneratePage: regenerating an accepted page un-accepts it but preserves siblings', () => {
  const artifacts = [
    pageFixture(0),
    pageFixture(1, { accepted: true, acceptedImageUrl: 'https://example.com/p1.png' }),
  ];
  const { artifacts: next } = applyRegeneratePage(
    artifacts,
    1,
    'https://new.png',
    'openai',
    'm',
    'p',
    {
      createdAt: 't',
      rawText: '',
      tags: [],
      providerTried: 'openai',
      resultImageUrl: 'https://new.png',
      success: true,
    },
  );
  assert.equal(next[1].accepted, false);
  assert.equal(next[1].acceptedImageUrl, null);
  // Page 0 untouched
  assert.deepEqual(next[0], artifacts[0]);
});

// ── pageImageUrlsFromArtifacts (proof rebuild input) ─────────────────────────

test('pageImageUrlsFromArtifacts: returns acceptedImageUrl when accepted, current otherwise', () => {
  const artifacts = [
    pageFixture(0, { accepted: true, acceptedImageUrl: 'https://accepted/p0.png', currentImageUrl: 'https://current/p0.png' }),
    pageFixture(1, { currentImageUrl: 'https://current/p1.png' }),
    pageFixture(2, { accepted: false, currentImageUrl: 'https://current/p2.png' }),
  ];
  const urls = pageImageUrlsFromArtifacts(artifacts);
  assert.deepEqual(urls, [
    'https://accepted/p0.png',
    'https://current/p1.png',
    'https://current/p2.png',
  ]);
});

test('imageUrlForPage falls back to currentImageUrl when accepted is true but acceptedImageUrl missing', () => {
  const p = pageFixture(0, { accepted: true, acceptedImageUrl: null, currentImageUrl: 'https://x.png' });
  assert.equal(imageUrlForPage(p), 'https://x.png');
});

// ── Service-level: regeneratePage + acceptPage with a real persisted order ───

test('regeneratePage: persists new image, tags, and feedback history; siblings untouched', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({
      pageArtifacts: [
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://example.com/p0.png' }),
        pageFixture(1),
        pageFixture(2),
      ],
    });
    const result = await regeneratePage(
      { orderId: 'ord_review_test', pageIndex: 1, feedback: 'fix the hands and brighten the background' },
      { providers: [successProvider], skipProofRebuild: true },
    );
    assert.equal(result.ok, true);
    const order = await getOrder('ord_review_test');
    const page1 = order!.pageArtifacts!.find((p) => p.pageIndex === 1)!;
    assert.equal(page1.currentImageUrl, 'https://example.com/regenerated.png');
    assert.equal(page1.regenerateCount, 1);
    assert.ok(page1.feedbackHistory[0].tags.includes('hands'));
    assert.ok(page1.feedbackHistory[0].tags.includes('background'));
    // Sibling page 0 still accepted, image untouched
    const page0 = order!.pageArtifacts!.find((p) => p.pageIndex === 0)!;
    assert.equal(page0.accepted, true);
    assert.equal(page0.acceptedImageUrl, 'https://example.com/p0.png');
    // reviewStatus moved to changes_requested
    assert.equal(order!.reviewStatus, 'customer_changes_requested');
  } finally {
    cleanup(dir);
  }
});

test('regeneratePage: media-backed Custom Stories never call an image provider or mutate review state', async () => {
  const dir = makeTmp();
  let providerCalls = 0;
  const provider: ImageProvider = {
    name: 'openai',
    async generate({ prompt }) {
      providerCalls += 1;
      return {
        imageUrl: 'https://example.com/must-not-persist.png',
        provider: 'openai',
        model: 'gpt-image-1',
        promptUsed: prompt,
        latencyMs: 1,
        error: null,
      };
    },
  };
  try {
    const before = await seedOrder({
      theme: 'custom-voice-story',
      fulfillmentMode: 'manual_hold',
      documentBlobPath: 'orders/ord_review_test/story.pdf',
    });
    const result = await regeneratePage(
      { orderId: 'ord_review_test', pageIndex: 0, feedback: 'change the background' },
      { providers: [provider], skipProofRebuild: true },
    );
    assert.deepEqual(result, {
      ok: false,
      status: 409,
      error: 'media_story_manual_review_required',
    });
    assert.equal(providerCalls, 0);
    const after = await getOrder('ord_review_test');
    assert.deepEqual(after?.pageArtifacts, before.pageArtifacts);
    assert.equal(after?.reviewStatus, before.reviewStatus);
  } finally {
    cleanup(dir);
  }
});

test('regeneratePage: emits warning at >=3 regenerations and manual_review at >=5', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({
      pageArtifacts: [pageFixture(0, { regenerateCount: 2 })],
    });
    const r1 = await regeneratePage(
      { orderId: 'ord_review_test', pageIndex: 0, feedback: 'change pose' },
      { providers: [successProvider], skipProofRebuild: true },
    );
    assert.equal(r1.warning, 'regen_threshold_warning');

    await regeneratePage({ orderId: 'ord_review_test', pageIndex: 0, feedback: 'a' }, { providers: [successProvider] });
    const r3 = await regeneratePage(
      { orderId: 'ord_review_test', pageIndex: 0, feedback: 'b' },
      { providers: [successProvider], skipProofRebuild: true },
    );
    assert.equal(r3.warning, 'regen_manual_review_threshold');
  } finally {
    cleanup(dir);
  }
});

test('regeneratePage: falls back to FAL when OpenAI fails', async () => {
  const dir = makeTmp();
  try {
    await seedOrder();
    const result = await regeneratePage(
      { orderId: 'ord_review_test', pageIndex: 0, feedback: 'change' },
      { providers: [failingOpenAI, successFAL], skipProofRebuild: true },
    );
    assert.equal(result.ok, true);
    assert.equal(result.page?.generationProvider, 'fal');
    assert.equal(result.page?.currentImageUrl, 'https://example.com/fal.png');
  } finally {
    cleanup(dir);
  }
});

test('regeneratePage: rejects unknown order with 404', async () => {
  const dir = makeTmp();
  try {
    const r = await regeneratePage(
      { orderId: 'ord_ghost', pageIndex: 0, feedback: '' },
      { providers: [successProvider], skipProofRebuild: true },
    );
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  } finally {
    cleanup(dir);
  }
});

test('regeneratePage: rejects invalid page index with 400', async () => {
  const dir = makeTmp();
  try {
    await seedOrder();
    const r = await regeneratePage(
      { orderId: 'ord_review_test', pageIndex: 99, feedback: '' },
      { providers: [successProvider], skipProofRebuild: true },
    );
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  } finally {
    cleanup(dir);
  }
});

test('acceptPage: marks single page; does NOT flip reviewStatus to approved on all-accepted', async () => {
  // Regression: previously acceptPage flipped reviewStatus='approved' once every
  // page was accepted, which short-circuited the proof-ack/approveWholeBook gate.
  // Now 'approved' is reserved for approveWholeBook only.
  const dir = makeTmp();
  try {
    await seedOrder({
      reviewStatus: 'in_review',
      pageArtifacts: [
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://example.com/p0.png' }),
        pageFixture(1, { accepted: true, acceptedImageUrl: 'https://example.com/p1.png' }),
        pageFixture(2),
      ],
    });
    const r = await acceptPage({ orderId: 'ord_review_test', pageIndex: 2 });
    assert.equal(r.ok, true);
    const order = await getOrder('ord_review_test');
    assert.notEqual(order!.reviewStatus, 'approved');
    assert.ok(order!.pageArtifacts!.every((p) => p.accepted));
  } finally {
    cleanup(dir);
  }
});

test('acceptPage: accepting one page does NOT overwrite any other page\u2019s state', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({
      pageArtifacts: [
        pageFixture(0, { regenerateCount: 4, currentImageUrl: 'https://example.com/p0-v5.png' }),
        pageFixture(1, { accepted: true, acceptedImageUrl: 'https://example.com/p1-accepted.png' }),
        pageFixture(2),
      ],
    });
    await acceptPage({ orderId: 'ord_review_test', pageIndex: 2 });
    const order = await getOrder('ord_review_test');
    const p0 = order!.pageArtifacts!.find((p) => p.pageIndex === 0)!;
    const p1 = order!.pageArtifacts!.find((p) => p.pageIndex === 1)!;
    assert.equal(p0.regenerateCount, 4);
    assert.equal(p1.accepted, true);
    assert.equal(p1.acceptedImageUrl, 'https://example.com/p1-accepted.png');
  } finally {
    cleanup(dir);
  }
});

test('applyRegeneratePage repairs missing or invalid text layout on the regenerated page', () => {
  const feedback = {
    createdAt: 't', rawText: '', tags: [], providerTried: 'openai' as const,
    resultImageUrl: 'https://new.png', success: true,
  };
  for (const textLayout of [undefined, { zone: 'bogus' } as never]) {
    const { page } = applyRegeneratePage(
      [pageFixture(0, { textLayout })], 0, 'https://new.png', 'openai', 'm', 'p', feedback,
    );
    assert.ok(isValidPageTextLayout(page?.textLayout), 'regenerated page must carry valid metadata');
  }
});
