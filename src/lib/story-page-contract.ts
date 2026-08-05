import type { PageArtifact } from './orders.ts';
import { getStoryPageCount } from './orders.ts';
import { isModernLayout, isValidPageTextLayout, type LayoutVersion } from './fulfillment-types.ts';

/**
 * The digital/print product contract for a story-page set. A book must carry
 * EXACTLY `getStoryPageCount(bookFormat)` real story pages (24 digital/classic,
 * 32 premium) with unique, contiguous, in-range page indices, story text, and
 * an illustration binding on every page. Modern books additionally require
 * valid per-page layout metadata.
 *
 * Cover / dedication / copyright / back matter are NOT part of `pageArtifacts`
 * (the PDF builder adds them separately), so they can never satisfy the story
 * page count.
 *
 * Pure and side-effect free — it only inspects; it never pads, duplicates,
 * invents, or omits pages. Shared by every readiness/approval choke point so
 * a partial, duplicated, missing, or out-of-range set fails closed identically.
 */

export type StoryPageSetFailure =
  | { code: 'wrong_page_count'; expected: number; actual: number }
  | { code: 'out_of_range_page'; pageIndex: number; expected: number }
  | { code: 'duplicate_page'; pageIndex: number }
  | { code: 'missing_story_text'; pageIndex: number }
  | { code: 'missing_illustration'; pageIndex: number }
  | { code: 'missing_layout_metadata'; pageIndex: number };

/** The subset of a page artifact the contract inspects. */
export type StoryPageForContract = Pick<
  PageArtifact,
  'pageIndex' | 'storyText' | 'currentImageUrl' | 'acceptedImageUrl' | 'textLayout'
>;

/**
 * Validate a story-page set against the book contract. Returns `null` when the
 * set is valid, or the first `StoryPageSetFailure` otherwise. (A nullable
 * failure — rather than a discriminated result — keeps narrowing simple under
 * this repo's non-strict TS config.)
 */
export function validateStoryPageSet(
  pageArtifacts: readonly StoryPageForContract[] | null | undefined,
  bookFormat: string,
  layoutVersion: LayoutVersion | null | undefined,
): StoryPageSetFailure | null {
  const expected = getStoryPageCount(bookFormat);
  const pages = pageArtifacts ?? [];

  if (pages.length !== expected) {
    return { code: 'wrong_page_count', expected, actual: pages.length };
  }

  // Unique + in-range indices. With an exact count, these two together imply a
  // contiguous 0..expected-1 set (pigeonhole), so a missing/gap page surfaces
  // as an out-of-range or duplicate index.
  const seen = new Set<number>();
  for (const page of pages) {
    const idx = page.pageIndex;
    if (!Number.isInteger(idx) || idx < 0 || idx >= expected) {
      return { code: 'out_of_range_page', pageIndex: idx, expected };
    }
    if (seen.has(idx)) {
      return { code: 'duplicate_page', pageIndex: idx };
    }
    seen.add(idx);
  }

  const modern = isModernLayout(layoutVersion);
  for (const page of pages) {
    if (!page.storyText || !page.storyText.trim()) {
      return { code: 'missing_story_text', pageIndex: page.pageIndex };
    }
    const illustration = page.acceptedImageUrl ?? page.currentImageUrl;
    if (!illustration) {
      return { code: 'missing_illustration', pageIndex: page.pageIndex };
    }
    // Layout metadata is required ONLY for modern books; legacy/unmarked books
    // tolerate absent/legacy metadata (normalized by the renderer).
    if (modern && !isValidPageTextLayout(page.textLayout)) {
      return { code: 'missing_layout_metadata', pageIndex: page.pageIndex };
    }
  }

  return null;
}

/** True when a page set satisfies the contract. */
export function isValidStoryPageSet(
  pageArtifacts: readonly StoryPageForContract[] | null | undefined,
  bookFormat: string,
  layoutVersion: LayoutVersion | null | undefined,
): boolean {
  return validateStoryPageSet(pageArtifacts, bookFormat, layoutVersion) === null;
}

/** Thrown by `assertStoryPageSet` when a page set violates the book contract.
 *  Carries the typed failure so callers can branch or audit without parsing. */
export class StoryPageContractError extends Error {
  readonly failure: StoryPageSetFailure;
  constructor(failure: StoryPageSetFailure) {
    super(`Story page set failed the book contract: ${describeStoryPageSetFailure(failure)}`);
    this.name = 'StoryPageContractError';
    this.failure = failure;
  }
}

/** Enforce the contract at a readiness/approval choke point. Throws
 *  `StoryPageContractError` (fail closed) so the caller's transactional commit
 *  aborts and the order does not advance. */
export function assertStoryPageSet(
  pageArtifacts: readonly StoryPageForContract[] | null | undefined,
  bookFormat: string,
  layoutVersion: LayoutVersion | null | undefined,
): void {
  const failure = validateStoryPageSet(pageArtifacts, bookFormat, layoutVersion);
  if (failure) throw new StoryPageContractError(failure);
}

/** Human/audit-safe one-line summary of a failure (no PII, no story text). */
export function describeStoryPageSetFailure(failure: StoryPageSetFailure): string {
  switch (failure.code) {
    case 'wrong_page_count':
      return `expected ${failure.expected} story pages, got ${failure.actual}`;
    case 'out_of_range_page':
      return `page index ${failure.pageIndex} outside 0..${failure.expected - 1}`;
    case 'duplicate_page':
      return `duplicate page index ${failure.pageIndex}`;
    case 'missing_story_text':
      return `page index ${failure.pageIndex} has no story text`;
    case 'missing_illustration':
      return `page index ${failure.pageIndex} has no illustration`;
    case 'missing_layout_metadata':
      return `modern page index ${failure.pageIndex} has missing/invalid layout metadata`;
  }
}
