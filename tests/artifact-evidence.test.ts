/**
 * Artifact evidence gate (Slice 4) — unit + diagnostics-visibility tests.
 *
 * Read-only validator: no order mutation, no provider calls, no release.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrderRecord, type OrderRecord, type PageArtifact } from '../src/lib/orders.ts';
import type { StorySource } from '../src/lib/fulfillment-types.ts';
import { evaluateArtifactEvidence } from '../src/lib/artifact-evidence.ts';
import { buildOrderDiagnostics, formatDiagnosticsSummary } from '../src/lib/order-diagnostics.ts';

function page(i: number, overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `On page ${i + 1}, Luna steps over a cool wet stone and the river answers back number ${i + 1}.`,
    basePrompt: `anchor :: page-${i + 1} scene with distinct framing ${i + 1}`,
    currentImageUrl: `https://example.com/p${i}.png`,
    acceptedImageUrl: null,
    generationProvider: 'fal',
    generationModel: 'fal-x',
    regenerateCount: 0,
    accepted: true,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

function goodPages(n: number): PageArtifact[] {
  return Array.from({ length: n }, (_, i) => page(i));
}

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'a@b.com' },
    { id: 'ord_ev_1', now: '2026-06-04T10:00:00Z' },
  );
  return {
    ...base,
    storyArtifactUrl: 'https://example.com/proof.pdf',
    storyMeta: { source: 'ollama_page_prose' as StorySource, model: 'llama', generatedAt: '2026-06-04T10:00:00Z', fallbackError: null },
    pageArtifacts: goodPages(24),
    ...overrides,
  };
}

// ── 1. complete artifact set passes ──────────────────────────────────────────

test('complete 24-page classic artifact set with trusted source passes', () => {
  const r = evaluateArtifactEvidence(makeOrder());
  assert.equal(r.ok, true);
  assert.equal(r.severity, 'pass');
  assert.equal(r.source, 'ollama_page_prose');
  assert.equal(r.sourceTrusted, true);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.counts.expectedPages, 24);
  assert.equal(r.counts.usableImages, 24);
  assert.equal(r.counts.missingImages, 0);
});

test('premium expects 32 pages', () => {
  const ok = evaluateArtifactEvidence(makeOrder({ bookFormat: 'premium', pageArtifacts: goodPages(32) }));
  assert.equal(ok.counts.expectedPages, 32);
  assert.equal(ok.ok, true);
  const short = evaluateArtifactEvidence(makeOrder({ bookFormat: 'premium', pageArtifacts: goodPages(24) }));
  assert.equal(short.ok, false);
  assert.ok(short.reasons.some((x) => x.code === 'PAGE_COUNT_SHORT'));
});

// ── 2. missing page artifact fails ───────────────────────────────────────────

test('short page count fails closed', () => {
  const r = evaluateArtifactEvidence(makeOrder({ pageArtifacts: goodPages(23) }));
  assert.equal(r.ok, false);
  assert.equal(r.severity, 'fail');
  assert.ok(r.reasons.some((x) => x.code === 'PAGE_COUNT_SHORT'));
});

test('zero artifacts fails', () => {
  const r = evaluateArtifactEvidence(makeOrder({ pageArtifacts: [] }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.code === 'NO_PAGE_ARTIFACTS'));
});

test('missing story artifact URL fails closed', () => {
  const r = evaluateArtifactEvidence(makeOrder({ storyArtifactUrl: null }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.code === 'NO_STORY_ARTIFACT' && x.severity === 'fail'));
});

test('full artifact count still fails when exact page index set is incomplete', () => {
  const pages = goodPages(24);
  pages[23] = page(24);
  const r = evaluateArtifactEvidence(makeOrder({ pageArtifacts: pages }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.code === 'MISSING_PAGE_INDEX' && /out-of-range/.test(x.message)));
  assert.ok(r.reasons.some((x) => x.code === 'MISSING_PAGE_INDEX' && /23/.test(x.message)));
});

test('duplicate page index fails closed', () => {
  const pages = goodPages(24);
  pages[23] = page(22, { storyText: 'Distinct duplicate-index page prose to avoid repeated-text side effects.' });
  const r = evaluateArtifactEvidence(makeOrder({ pageArtifacts: pages }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.code === 'DUPLICATE_PAGE_INDEX'));
  assert.ok(r.reasons.some((x) => x.code === 'MISSING_PAGE_INDEX' && /23/.test(x.message)));
});

// ── 3. missing image fails (and acceptedImageUrl counts as usable) ───────────

test('a page with no usable image fails', () => {
  const pages = goodPages(24);
  pages[5] = page(5, { currentImageUrl: null, acceptedImageUrl: null });
  const r = evaluateArtifactEvidence(makeOrder({ pageArtifacts: pages }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.code === 'MISSING_IMAGE'));
  assert.equal(r.counts.missingImages, 1);
  assert.equal(r.counts.usableImages, 23);
});

test('acceptedImageUrl alone counts as a usable image', () => {
  const pages = goodPages(24);
  pages[5] = page(5, { currentImageUrl: null, acceptedImageUrl: 'https://example.com/accepted5.png' });
  const r = evaluateArtifactEvidence(makeOrder({ pageArtifacts: pages }));
  assert.equal(r.counts.missingImages, 0);
  assert.ok(!r.reasons.some((x) => x.code === 'MISSING_IMAGE'));
});

test('empty story text fails', () => {
  const pages = goodPages(24);
  pages[3] = page(3, { storyText: '   ' });
  const r = evaluateArtifactEvidence(makeOrder({ pageArtifacts: pages }));
  assert.ok(r.reasons.some((x) => x.code === 'MISSING_STORY_TEXT'));
});

// ── 4. repeated prompt/text fails or warns ───────────────────────────────────

test('story text repeated on 3+ pages fails', () => {
  const pages = goodPages(24);
  for (const i of [10, 11, 12]) pages[i] = page(i, { storyText: 'The same flat line over and over.' });
  const r = evaluateArtifactEvidence(makeOrder({ pageArtifacts: pages }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.code === 'REPEATED_STORY_TEXT' && x.severity === 'fail'));
  assert.equal(r.counts.repeatedStoryTextPages, 3);
});

test('story text repeated on exactly 2 pages warns (does not fail)', () => {
  const pages = goodPages(24);
  for (const i of [10, 11]) pages[i] = page(i, { storyText: 'Twin line repeated once.' });
  const r = evaluateArtifactEvidence(makeOrder({ pageArtifacts: pages }));
  assert.equal(r.ok, true);
  assert.equal(r.severity, 'warn');
  assert.ok(r.reasons.some((x) => x.code === 'REPEATED_STORY_TEXT' && x.severity === 'warn'));
});

test('identical basePrompt across many pages fails', () => {
  const pages = goodPages(24).map((p, i) => page(i, { basePrompt: 'identical prompt for every page' }));
  const r = evaluateArtifactEvidence(makeOrder({ pageArtifacts: pages }));
  assert.ok(r.reasons.some((x) => x.code === 'REPEATED_BASE_PROMPT' && x.severity === 'fail'));
});

// ── 5. admin/template copy leak fails ────────────────────────────────────────

test('admin/template copy leak fails', () => {
  for (const leak of ['Adventure Notes', 'Theme: brave-explorer', 'Format: classic', 'A personalized story created for Luna']) {
    const pages = goodPages(24);
    pages[7] = page(7, { storyText: `Some prose. ${leak}. More prose.` });
    const r = evaluateArtifactEvidence(makeOrder({ pageArtifacts: pages }));
    assert.equal(r.ok, false, `leak "${leak}" should fail`);
    assert.ok(r.reasons.some((x) => x.code === 'ADMIN_COPY_LEAK'), `leak "${leak}"`);
  }
});

// ── 6. unknown / template / degraded source ──────────────────────────────────

test('unknown source (no storyMeta) fails closed', () => {
  const r = evaluateArtifactEvidence(makeOrder({ storyMeta: null }));
  assert.equal(r.ok, false);
  assert.equal(r.source, 'unknown');
  assert.equal(r.sourceTrusted, false);
  assert.ok(r.reasons.some((x) => x.code === 'SOURCE_UNKNOWN' && x.severity === 'fail'));
});

test('template-only source does not pass as gift-quality/custom', () => {
  const r = evaluateArtifactEvidence(makeOrder({ storyMeta: { source: 'template', model: 'template:Adventure', generatedAt: 't', fallbackError: null } }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.code === 'SOURCE_TEMPLATE_ONLY'));
});

test('silently-degraded source (template_after_openai_failure) fails', () => {
  const r = evaluateArtifactEvidence(makeOrder({ storyMeta: { source: 'template_after_openai_failure', model: 'template:Adventure', generatedAt: 't', fallbackError: 'boom' } }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.code === 'SOURCE_DEGRADED'));
});

// ── provenance + weak prose are advisory (warn, not fail) ─────────────────────

test('missing prompt/provider provenance warns but does not fail', () => {
  const pages = goodPages(24).map((p, i) => page(i, { generationProvider: null, basePrompt: '' }));
  const r = evaluateArtifactEvidence(makeOrder({ pageArtifacts: pages }));
  // basePrompt empty across all pages → REPEATED_BASE_PROMPT would not trigger
  // (empty strings are ignored by dup stats), so only provenance warns here.
  assert.ok(r.reasons.some((x) => x.code === 'PROVENANCE_INCOMPLETE' && x.severity === 'warn'));
  assert.equal(r.counts.provenanceIncompletePages, 24);
});

test('weak prose warns but does not fail on its own', () => {
  const pages = goodPages(24);
  pages[2] = page(2, { storyText: 'Luna walks on. Everything feels magical and bright today.' });
  const r = evaluateArtifactEvidence(makeOrder({ pageArtifacts: pages }));
  assert.ok(r.reasons.some((x) => x.code === 'WEAK_PROSE' && x.severity === 'warn'));
  assert.equal(r.ok, true);
});

// ── diagnostics visibility ───────────────────────────────────────────────────

test('order diagnostics surfaces the evidence result (visible to Rex)', () => {
  const d = buildOrderDiagnostics(makeOrder({ pageArtifacts: goodPages(23) }));
  assert.ok(d.evidence, 'diagnostics carries evidence');
  assert.equal(d.evidence.ok, false);
  assert.equal(d.evidence.severity, 'fail');
  assert.ok(d.evidence.reasons.some((r) => r.code === 'PAGE_COUNT_SHORT'));
  const summary = formatDiagnosticsSummary(d);
  assert.match(summary, /Artifact evidence: FAIL/);
  assert.match(summary, /evidence fail PAGE_COUNT_SHORT/);
});

test('diagnostics evidence passes for a complete trusted order', () => {
  const d = buildOrderDiagnostics(makeOrder());
  assert.equal(d.evidence.ok, true);
  assert.equal(d.evidence.severity, 'pass');
});
