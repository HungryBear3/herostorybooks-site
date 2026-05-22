/**
 * Focused tests for the regen-brief exporter helpers in
 * scripts/build-regen-brief.ts. The CLI itself (argv parsing, file
 * write, /tmp output) is exercised manually by running the script.
 * Here we pin the pure transforms so the brief stays a stable
 * contract.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRegenBriefJson,
  isPageFlagged,
  renderRegenBriefMarkdown,
} from '../scripts/build-regen-brief.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';

const NOW = '2026-05-22T12:00:00.000Z';

function page(overrides: Partial<PageArtifact> & { pageIndex: number }): PageArtifact {
  return {
    storyText: `Page ${overrides.pageIndex + 1} body.`,
    basePrompt: 'p',
    currentImageUrl: `https://cdn.test/page-${overrides.pageIndex + 1}.png`,
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

function order(pages: PageArtifact[]): Pick<
  OrderRecord,
  'id' | 'childName' | 'bookFormat' | 'formatLabel' | 'printTitle' | 'pageArtifacts'
> & { id: string } {
  return {
    id: 'ord_brief_test',
    childName: 'Luna',
    bookFormat: 'classic',
    formatLabel: 'Classic softcover',
    printTitle: null,
    pageArtifacts: pages,
  };
}

test('isPageFlagged: targetedRegenNeeded=true is flagged', () => {
  assert.equal(isPageFlagged(page({ pageIndex: 0, targetedRegenNeeded: true })), true);
});

test('isPageFlagged: non-empty reviewerNotes is flagged', () => {
  assert.equal(isPageFlagged(page({ pageIndex: 0, reviewerNotes: 'Lukas looks older here' })), true);
});

test('isPageFlagged: whitespace-only reviewerNotes is NOT flagged', () => {
  assert.equal(isPageFlagged(page({ pageIndex: 0, reviewerNotes: '   ' })), false);
});

test('isPageFlagged: legacy page missing the new fields is NOT flagged', () => {
  // Simulate a pre-Commit-3 page with no review fields at all.
  const legacy = page({ pageIndex: 0 });
  delete (legacy as { targetedRegenNeeded?: unknown }).targetedRegenNeeded;
  delete (legacy as { reviewerNotes?: unknown }).reviewerNotes;
  assert.equal(isPageFlagged(legacy), false);
});

test('buildRegenBriefJson: default filter includes flagged + notes-only pages, excludes the rest', () => {
  const flagged = page({ pageIndex: 0, targetedRegenNeeded: true });
  const notesOnly = page({ pageIndex: 1, reviewerNotes: 'T-rex too small in this frame' });
  const unflagged = page({ pageIndex: 2 });
  const brief = buildRegenBriefJson(order([flagged, notesOnly, unflagged]), { now: NOW });

  assert.equal(brief.filter, 'flagged_only');
  assert.equal(brief.totalPages, 3);
  assert.equal(brief.pagesIncluded, 2);
  assert.deepEqual(
    brief.pages.map((p) => p.pageNumber),
    [1, 2],
  );
  // Order header fields surface from the order record.
  assert.equal(brief.orderId, 'ord_brief_test');
  assert.equal(brief.childName, 'Luna');
  assert.equal(brief.formatLabel, 'Classic softcover');
  assert.equal(brief.generatedAt, NOW);
});

test('buildRegenBriefJson: includeUnflagged dumps every page in pageIndex order', () => {
  const pages = [
    page({ pageIndex: 2 }),
    page({ pageIndex: 0, targetedRegenNeeded: true }),
    page({ pageIndex: 1 }),
  ];
  const brief = buildRegenBriefJson(order(pages), { includeUnflagged: true, now: NOW });
  assert.equal(brief.filter, 'all_pages');
  assert.equal(brief.pagesIncluded, 3);
  assert.deepEqual(
    brief.pages.map((p) => p.pageNumber),
    [1, 2, 3],
  );
});

test('buildRegenBriefJson: empty brief when nothing is flagged', () => {
  const brief = buildRegenBriefJson(order([page({ pageIndex: 0 }), page({ pageIndex: 1 })]), { now: NOW });
  assert.equal(brief.pagesIncluded, 0);
  assert.deepEqual(brief.pages, []);
});

test('buildRegenBriefJson: legacy PageArtifact without review fields is excluded by default and included with --include-unflagged', () => {
  const legacy = page({ pageIndex: 0 });
  delete (legacy as { targetedRegenNeeded?: unknown }).targetedRegenNeeded;
  delete (legacy as { reviewerNotes?: unknown }).reviewerNotes;
  delete (legacy as { reviewedAt?: unknown }).reviewedAt;

  const flaggedOnly = buildRegenBriefJson(order([legacy]), { now: NOW });
  assert.equal(flaggedOnly.pagesIncluded, 0);

  const all = buildRegenBriefJson(order([legacy]), { includeUnflagged: true, now: NOW });
  assert.equal(all.pagesIncluded, 1);
  assert.equal(all.pages[0].targetedRegenNeeded, false);
  assert.equal(all.pages[0].reviewerNotes, null);
  assert.equal(all.pages[0].reviewedAt, null);
});

test('buildRegenBriefJson: feedback summary keeps the most recent N=3 entries', () => {
  const withFeedback = page({
    pageIndex: 0,
    targetedRegenNeeded: true,
    feedbackHistory: [
      { createdAt: '2026-05-01T00:00:00Z', rawText: 'first', tags: [], providerTried: 'openai', success: true },
      { createdAt: '2026-05-02T00:00:00Z', rawText: 'second', tags: ['hair'], providerTried: 'fal', success: false },
      { createdAt: '2026-05-03T00:00:00Z', rawText: 'third', tags: [], providerTried: 'gemini', success: true },
      { createdAt: '2026-05-04T00:00:00Z', rawText: 'fourth', tags: ['pose'], providerTried: 'fal_edit', success: true },
    ],
  });
  const brief = buildRegenBriefJson(order([withFeedback]), { now: NOW });
  assert.equal(brief.pages[0].feedbackSummary.length, 3);
  // Most recent three in original order — first dropped.
  assert.match(brief.pages[0].feedbackSummary[0], /second/);
  assert.match(brief.pages[0].feedbackSummary[2], /fourth/);
});

test('renderRegenBriefMarkdown: empty brief surfaces the "no pages flagged" explanation', () => {
  const brief = buildRegenBriefJson(order([page({ pageIndex: 0 })]), { now: NOW });
  const md = renderRegenBriefMarkdown(brief);
  assert.match(md, /# Targeted regeneration brief — Luna's book/);
  assert.match(md, /No pages flagged for regeneration/);
  assert.match(md, /--include-unflagged/);
});

test('renderRegenBriefMarkdown: flagged page section quotes the story text and includes the regen-instructions placeholder', () => {
  const brief = buildRegenBriefJson(
    order([
      page({
        pageIndex: 4,
        targetedRegenNeeded: true,
        reviewerNotes: 'Lukas looks older — soften jaw',
        storyText: 'Luna touched the lantern.',
      }),
    ]),
    { now: NOW },
  );
  const md = renderRegenBriefMarkdown(brief);
  assert.match(md, /### Page 5/);
  assert.match(md, /\*\*YES — targeted regen needed\*\*/);
  assert.match(md, /"Lukas looks older — soften jaw"/);
  assert.match(md, /> Luna touched the lantern\./);
  assert.match(md, /Regeneration instructions \(fill in before handoff\)/);
  assert.match(md, /- Preserve:/);
  assert.match(md, /- Change:/);
});
