/**
 * Pre-QA proof artifact scanner.
 *
 * Hard rule (CD lifecycle): a story page with no usable illustration — or the
 * rendered placeholder string "Illustration preview unavailable" — is a
 * build/export FAILURE, not a previewable proof. This scanner detects those
 * conditions from the persisted order artifacts so QA pass / customer release
 * can be blocked BEFORE anyone reviews or emails.
 *
 * Pure: no I/O, no provider calls. Operates on the order's persisted artifacts.
 */
import type { OrderRecord } from './orders.ts';

/** The exact string the PDF renderer prints when a page image is missing. */
export const PROOF_PLACEHOLDER_TEXT = 'Illustration preview unavailable';

export const DEFAULT_STORY_PAGE_COUNT = 24;

export type QaFailReasonTag =
  | 'missing_illustrations'
  | 'grammar'
  | 'repetition'
  | 'layout'
  | 'wrong_personalization'
  | 'inaccurate_colophon';

export interface ProofArtifactScan {
  /** True only when every expected page has a usable image and no placeholder is present. */
  ok: boolean;
  expectedPages: number;
  pagesWithImage: number;
  /** 1-based page numbers that lack a usable illustration. */
  missingImagePages: number[];
  placeholderDetected: boolean;
  blocking: string[];
  blockingReasonTags: QaFailReasonTag[];
}

function usableImage(artifact: unknown): boolean {
  if (!artifact || typeof artifact !== 'object') return false;
  const a = artifact as Record<string, unknown>;
  const accepted = typeof a.acceptedImageUrl === 'string' ? a.acceptedImageUrl.trim() : '';
  const current = typeof a.currentImageUrl === 'string' ? a.currentImageUrl.trim() : '';
  const chosen = accepted || current;
  if (!chosen) return false;
  // A url that literally encodes the placeholder is also a failure.
  return !chosen.includes(PROOF_PLACEHOLDER_TEXT);
}

function artifactText(artifact: unknown): string {
  if (!artifact || typeof artifact !== 'object') return '';
  const a = artifact as Record<string, unknown>;
  return [a.storyText, a.imagePrompt, a.caption]
    .map((v) => (typeof v === 'string' ? v : ''))
    .join(' ');
}

/** True if any text contains the failure placeholder string. */
export function containsPlaceholder(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(PROOF_PLACEHOLDER_TEXT);
}

export function scanProofArtifacts(
  order: Pick<OrderRecord, 'pageArtifacts'>,
  { expectedPages = DEFAULT_STORY_PAGE_COUNT }: { expectedPages?: number } = {},
): ProofArtifactScan {
  const artifacts = Array.isArray(order.pageArtifacts) ? order.pageArtifacts : [];
  const missingImagePages: number[] = [];
  let pagesWithImage = 0;
  let placeholderDetected = false;

  // Index artifacts by their 1-based page number when present, else by order.
  const byPage = new Map<number, unknown>();
  artifacts.forEach((artifact, idx) => {
    const a = artifact as unknown as Record<string, unknown> | null;
    const pageNumber =
      a && Number.isInteger(a.pageNumber) ? (a.pageNumber as number)
      : a && Number.isInteger(a.pageIndex) ? (a.pageIndex as number) + 1
      : idx + 1;
    byPage.set(pageNumber, artifact);
    if (containsPlaceholder(artifactText(artifact))) placeholderDetected = true;
  });

  for (let page = 1; page <= expectedPages; page += 1) {
    const artifact = byPage.get(page);
    if (artifact !== undefined && usableImage(artifact)) pagesWithImage += 1;
    else missingImagePages.push(page);
  }

  const blocking: string[] = [];
  const blockingReasonTags: QaFailReasonTag[] = [];

  if (artifacts.length === 0) {
    blocking.push('no page artifacts were generated');
    blockingReasonTags.push('missing_illustrations');
  } else if (missingImagePages.length > 0) {
    blocking.push(
      `missing illustrations on ${missingImagePages.length}/${expectedPages} pages: ${missingImagePages.slice(0, 12).join(', ')}${missingImagePages.length > 12 ? '…' : ''}`,
    );
    blockingReasonTags.push('missing_illustrations');
  }
  if (placeholderDetected) {
    blocking.push(`placeholder "${PROOF_PLACEHOLDER_TEXT}" present in artifacts (build/export failure)`);
    if (!blockingReasonTags.includes('missing_illustrations')) blockingReasonTags.push('missing_illustrations');
  }

  return {
    ok: blocking.length === 0,
    expectedPages,
    pagesWithImage,
    missingImagePages,
    placeholderDetected,
    blocking,
    blockingReasonTags,
  };
}
