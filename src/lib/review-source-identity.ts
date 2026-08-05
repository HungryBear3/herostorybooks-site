import crypto from 'node:crypto';

import type { OrderRecord, PageArtifact } from './orders.ts';
import type { StoryContent } from './fulfillment-types.ts';
import { proofCardGeometryForFingerprint, proofTextColorForFingerprint } from './proof-layout-override.ts';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

/** Stable SHA-256 for persisted/render-source identity values. */
export function canonicalSourceHash(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

/**
 * Identity of every persisted/derived input consumed by regeneratePage before
 * its slow provider call. A result may be committed only while this identity is
 * unchanged. Sibling pages and unrelated operational fields are intentionally
 * excluded so CAS retries can merge independent work.
 */
export function pageGenerationSourceFingerprint(input: {
  order: OrderRecord;
  page: PageArtifact;
  referenceImageUrl: string | null;
  referenceImageRequired: boolean;
}): string {
  const { order, page, referenceImageUrl, referenceImageRequired } = input;
  return canonicalSourceHash({
    page,
    promptOrder: {
      childName: order.childName,
      childAge: order.childAge,
      characterNotes: order.characterNotes,
      appearanceOptions: order.appearanceOptions,
      photoBlobPath: order.photoBlobPath ?? null,
      theme: order.theme,
    },
    referenceImageUrl,
    referenceImageRequired,
  });
}

/**
 * Identity of the exact values consumed by the production proof renderer.
 * Keep this projection explicit: operational fields such as audit timestamps
 * must not invalidate a proof, while every byte-affecting value must.
 */
export function proofRenderSourceFingerprint(input: {
  story: StoryContent;
  order: Pick<OrderRecord, 'id' | 'childName' | 'bookFormat' | 'layoutVersion'>;
  imageUrls: (string | null)[];
}): string {
  const { story, order, imageUrls } = input;
  const renderedStory = {
    title: story.title,
    pages: story.pages.map((page) => ({
      pageNum: page.pageNum,
      sceneTitle: page.sceneTitle,
      story: page.story,
      textLayout: page.textLayout ?? null,
      // Only byte-affecting values move the fingerprint: canonical card geometry
      // plus the RESOLVED text/scrim RGB. Operational metadata
      // (appliedAt/appliedBy/authoredAgainst*) is excluded so it cannot
      // spuriously invalidate a proof.
      proofCardOverride: page.proofCardOverride
        ? {
            ...proofCardGeometryForFingerprint(page.proofCardOverride),
            color: proofTextColorForFingerprint(page.proofCardOverride.textColor),
          }
        : null,
    })),
  };
  const digest = canonicalSourceHash({
    story: renderedStory,
    order: {
      id: order.id,
      childName: order.childName,
      bookFormat: order.bookFormat,
      layoutVersion: order.layoutVersion ?? 'legacy_bottom_band',
    },
    imageUrls,
  });
  return `pf_${digest.slice(0, 32)}`;
}

/** Reconstruct the production proof-render inputs from persisted page state. */
export function proofStoryFromPageArtifacts(
  order: Pick<OrderRecord, 'childName' | 'printTitle'>,
  pages: PageArtifact[],
): StoryContent | null {
  if (pages.length === 0 || pages.some((page) => !page.storyText || !page.basePrompt)) return null;
  const sorted = [...pages].sort((left, right) => left.pageIndex - right.pageIndex);
  return {
    title: order.printTitle ?? `${order.childName}'s Hero Story Book`,
    characterDescription: sorted[0]?.characterAnchor ?? '',
    pages: sorted.map((page) => ({
      pageNum: page.pageIndex + 1,
      sceneTitle: page.sceneTitle ?? '',
      story: page.storyText,
      imagePrompt: page.basePrompt,
      ...(page.textLayout ? { textLayout: page.textLayout } : {}),
      // Carry the proof-only positioned card override through to the render +
      // fingerprint inputs, so a customer layout edit both renders and moves the
      // proof identity.
      ...(page.proofCardOverride ? { proofCardOverride: page.proofCardOverride } : {}),
    })),
  };
}
