/**
 * Generation observability surface in diagnostics.
 *
 * Asserts:
 *   - story source/model/generatedAt/fallbackError flow from OrderRecord.storyMeta
 *   - per-page conditioning is exposed in artifacts.perPageConditioning
 *   - story-source check has the right severity per source
 *   - text format includes Story + Conditioning lines
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOrderDiagnostics,
  formatDiagnosticsSummary,
} from '../src/lib/order-diagnostics.ts';
import {
  createOrderRecord,
  type OrderRecord,
  type PageArtifact,
} from '../src/lib/orders.ts';

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'a@b.com' },
    { id: 'ord_obs', now: '2026-04-29T10:00:00Z' },
  );
  return { ...base, ...overrides };
}

function pageFixture(i: number, overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `p${i}`,
    basePrompt: 'p',
    currentImageUrl: `https://x/${i}.png`,
    acceptedImageUrl: null,
    generationProvider: null,
    generationModel: null,
    generationConditioning: null,
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

// ── story.* surface ──

test('diagnostics: storyMeta absent → story fields null + legacy info check', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    pageArtifacts: [pageFixture(0)],
  }));
  assert.equal(d.story.source, null);
  assert.equal(d.story.model, null);
  const legacy = d.checks.find((c) => c.id === 'story-source');
  assert.equal(legacy?.severity, 'info');
  assert.match(legacy?.label ?? '', /unknown.*legacy/i);
});

test('diagnostics: storyMeta=openai_chat → ok check + model surfaced', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    storyMeta: {
      source: 'openai_chat',
      model: 'gpt-4o-mini',
      generatedAt: '2026-04-29T10:01:00Z',
      fallbackError: null,
    },
  }));
  assert.equal(d.story.source, 'openai_chat');
  assert.equal(d.story.model, 'gpt-4o-mini');
  const c = d.checks.find((c) => c.id === 'story-source');
  assert.equal(c?.severity, 'ok');
});

test('diagnostics: storyMeta=template → info check + template:<Variant> model', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    storyMeta: {
      source: 'template',
      model: 'template:Adventure',
      generatedAt: '2026-04-29T10:01:00Z',
      fallbackError: null,
    },
  }));
  const c = d.checks.find((c) => c.id === 'story-source');
  assert.equal(c?.severity, 'info');
  assert.match(c?.label ?? '', /template:Adventure/);
});

test('diagnostics: storyMeta=template_after_openai_failure → warn check + fallback error in detail', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    storyMeta: {
      source: 'template_after_openai_failure',
      model: 'template:Quest',
      generatedAt: '2026-04-29T10:01:00Z',
      fallbackError: 'OpenAI API error 503: rate limit',
    },
  }));
  const c = d.checks.find((c) => c.id === 'story-source');
  assert.equal(c?.severity, 'warn');
  assert.match(c?.detail ?? '', /rate limit/);
});

// ── per-page conditioning surface ──

test('diagnostics: artifacts.perPageConditioning lists every page in order with conditioning detail', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    pageArtifacts: [
      pageFixture(0, {
        generationProvider: 'fal_edit',
        generationModel: 'fal-ai/nano-banana-pro/edit',
        generationConditioning: 'photo_edit',
        versionHistory: [
          {
            createdAt: 't0',
            imageUrl: 'https://x/0.png',
            provider: 'fal_edit',
            model: 'fal-ai/nano-banana-pro/edit',
            promptUsed: 'p',
            conditioning: 'photo_edit',
            referencePhotoUrl: 'https://photos/luna.jpg',
          },
        ],
      }),
      pageFixture(1, {
        generationProvider: 'fal',
        generationModel: 'fal-ai/flux/schnell',
        generationConditioning: 'text_only',
        versionHistory: [
          {
            createdAt: 't1',
            imageUrl: 'https://x/1.png',
            provider: 'fal',
            model: 'fal-ai/flux/schnell',
            promptUsed: 'p',
            conditioning: 'text_only',
            referencePhotoUrl: null,
          },
        ],
      }),
      pageFixture(2, { regenerateCount: 2 }),
    ],
  }));
  assert.equal(d.artifacts.perPageConditioning.length, 3);
  const [p0, p1, p2] = d.artifacts.perPageConditioning;
  assert.equal(p0.conditioning, 'photo_edit');
  assert.equal(p0.provider, 'fal_edit');
  assert.equal(p0.hasReferencePhoto, true);
  assert.equal(p1.conditioning, 'text_only');
  assert.equal(p1.hasReferencePhoto, false);
  assert.equal(p2.conditioning, null);
  assert.equal(p2.regenerateCount, 2);
  assert.equal(d.artifacts.pagesPhotoConditioned, 1);
  assert.equal(d.artifacts.pagesTextOnly, 1);
  assert.equal(d.artifacts.pagesUnknownConditioning, 1);
});

// ── text format ──

test('diagnostics text: includes Story line + Conditioning line + per-page detail', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    storyMeta: {
      source: 'openai_chat',
      model: 'gpt-4o-mini',
      generatedAt: '2026-04-29T10:01:00Z',
      fallbackError: null,
    },
    pageArtifacts: [
      pageFixture(0, {
        generationProvider: 'fal_edit',
        generationModel: 'fal-ai/nano-banana-pro/edit',
        generationConditioning: 'photo_edit',
        versionHistory: [{
          createdAt: 't0', imageUrl: 'https://x/0.png',
          provider: 'fal_edit', model: 'fal-ai/nano-banana-pro/edit',
          promptUsed: 'p', conditioning: 'photo_edit', referencePhotoUrl: 'https://x/photo.jpg',
        }],
      }),
    ],
  }));
  const text = formatDiagnosticsSummary(d);
  assert.match(text, /Story: source=openai_chat model=gpt-4o-mini/);
  assert.match(text, /Conditioning: 1 photo-edit/);
  assert.match(text, /page 0: photo_edit · fal_edit\/fal-ai\/nano-banana-pro\/edit · refPhoto=yes/);
});
