import { ArtDirectionPacketSchema } from './art-direction-schemas.ts';
import { isCustomProofGatedOrder } from './proof-submission-gate.ts';
import type { StoryContent, StoryMeta } from './fulfillment-types.ts';
import type { OrderRecord, PageArtifact } from './orders.ts';

export type ArtifactPurpose =
  | 'customer_proof'
  | 'diagnostic_fixture'
  | 'layout_test'
  | 'recovery_preview';

export interface ArtifactProvenanceManifest {
  orderId: string;
  isSynthetic: boolean;
  artifactPurpose: ArtifactPurpose;
  sourceAssets: string[];
  transcriptArtifactId: string | null;
  plannerArtifactId: string | null;
  storyboardArtifactId: string | null;
  proseArtifactId: string | null;
  artPromptArtifactId: string | null;
  /** Per-still identifiers for guided multi-angle reference photos (label +
   *  blob path/filename). Empty when the order has none. Optional input — these
   *  do NOT gate customer_proof lineage. */
  guidedReferenceArtifactIds: string[];
  layoutArtifactId: string | null;
  generatedAt: string;
  generatorName: string;
  command: string | null;
  lineageComplete: boolean;
  missingLineage: string[];
}

export interface BuildArtifactProvenanceInput {
  order: OrderRecord;
  artifactPurpose: ArtifactPurpose;
  story?: StoryContent | null;
  storyMeta?: StoryMeta | null;
  pageArtifacts?: PageArtifact[] | null;
  layoutArtifactId?: string | null;
  generatedAt?: string;
  generatorName: string;
  command?: string | null;
  isSynthetic?: boolean;
  requireLayout?: boolean;
}

const CUSTOMER_LOOKING_ARTIFACT_RE = /\b(proof|storybook|customer|submitted)\b/i;
const NON_CUSTOMER_MARKER_RE = /\b(diagnostic|fixture|synthetic|layout-test|layout_test|recovery-preview|recovery_preview)\b/i;

function storyHasProse(story: StoryContent | null | undefined): boolean {
  return Boolean(story?.pages?.length && story.pages.every((page) => page.story.trim()));
}

function storyHasArtPrompts(story: StoryContent | null | undefined): boolean {
  return Boolean(story?.pages?.length && story.pages.every((page) => page.imagePrompt.trim()));
}

function pagesHaveProse(pageArtifacts: PageArtifact[] | null | undefined): boolean {
  return Boolean(pageArtifacts?.length && pageArtifacts.every((page) => page.storyText.trim()));
}

function pagesHaveArtPrompts(pageArtifacts: PageArtifact[] | null | undefined): boolean {
  return Boolean(pageArtifacts?.length && pageArtifacts.every((page) => page.basePrompt.trim()));
}

/**
 * Per-still identifiers for guided reference photos: `guided:<label>:<path|name>`.
 * Used for ops provenance — prove which customer reference stills fed the book.
 */
export function guidedReferenceArtifactIdsForOrder(order: OrderRecord): string[] {
  const refs = order.guidedReferencePhotos;
  if (!Array.isArray(refs) || refs.length === 0) return [];
  return refs.map((ref, i) => {
    const id = ref.photoBlobPath || ref.photoBlobUrl || ref.fileName || `index-${i}`;
    return `guided:${ref.label || 'reference'}:${id}`;
  });
}

function sourceAssetsForOrder(order: OrderRecord): string[] {
  const guided = (order.guidedReferencePhotos ?? []).flatMap((ref) => [
    ref.photoBlobPath,
    ref.photoBlobUrl,
    ref.fileName,
  ]);
  return [
    order.voiceBlobPath,
    order.voiceBlobUrl,
    order.voiceFileName,
    order.photoBlobPath,
    order.photoBlobUrl,
    order.photoFileName,
    ...guided,
  ].filter((value): value is string => Boolean(value && value.trim()));
}

function hasVoiceSource(order: OrderRecord): boolean {
  return Boolean(
    order.voiceBlobPath ||
      order.voiceBlobUrl ||
      order.voiceFileName ||
      order.voiceConsentAt ||
      order.voiceSource,
  );
}

function isModelStorySource(storyMeta: StoryMeta | null | undefined): boolean {
  return Boolean(
    storyMeta?.source &&
      storyMeta.source !== 'template' &&
      storyMeta.source !== 'template_after_openai_failure',
  );
}

function hasStoryboardPacket(order: OrderRecord): boolean {
  const parsed = ArtDirectionPacketSchema.safeParse(order.artDirectionPacket);
  return parsed.success && parsed.data.storyboard.entries.length > 0;
}

export function isSyntheticOrderId(orderId: string): boolean {
  return /^ord_internal/i.test(orderId);
}

export function isCustomerLookingArtifactFilename(filename: string): boolean {
  return CUSTOMER_LOOKING_ARTIFACT_RE.test(filename) && !NON_CUSTOMER_MARKER_RE.test(filename);
}

export function buildArtifactProvenanceManifest(
  input: BuildArtifactProvenanceInput,
): ArtifactProvenanceManifest {
  const {
    order,
    artifactPurpose,
    story = null,
    storyMeta = order.storyMeta ?? null,
    pageArtifacts = order.pageArtifacts ?? null,
    layoutArtifactId = null,
    generatedAt = new Date().toISOString(),
    generatorName,
    command = null,
    requireLayout = true,
  } = input;
  const isSynthetic = input.isSynthetic ?? isSyntheticOrderId(order.id);
  const sourceAssets = sourceAssetsForOrder(order);
  const customGated = isCustomProofGatedOrder(order);
  const voiceSource = hasVoiceSource(order);

  const transcriptArtifactId = order.voiceTranscript?.transcript
    ? 'order.voiceTranscript.transcript'
    : null;
  const plannerArtifactId = isModelStorySource(storyMeta)
    ? `order.storyMeta:${storyMeta!.source}:${storyMeta!.model}`
    : null;
  const storyboardArtifactId = hasStoryboardPacket(order)
    ? 'order.artDirectionPacket.storyboard'
    : null;
  const proseArtifactId =
    storyHasProse(story) || pagesHaveProse(pageArtifacts)
      ? story?.title
        ? `story:${story.title}`
        : 'order.pageArtifacts.storyText'
      : null;
  const artPromptArtifactId =
    storyHasArtPrompts(story) || pagesHaveArtPrompts(pageArtifacts)
      ? 'story.pages.imagePrompt'
      : null;
  const guidedReferenceArtifactIds = guidedReferenceArtifactIdsForOrder(order);

  const missingLineage: string[] = [];
  if (isSynthetic && artifactPurpose === 'customer_proof') missingLineage.push('artifactPurpose');
  if (voiceSource && !transcriptArtifactId) missingLineage.push('transcriptArtifactId');
  if (customGated && !plannerArtifactId) missingLineage.push('plannerArtifactId');
  if (customGated && !storyboardArtifactId) missingLineage.push('storyboardArtifactId');
  if (!proseArtifactId) missingLineage.push('proseArtifactId');
  if (!artPromptArtifactId) missingLineage.push('artPromptArtifactId');
  if (requireLayout && !layoutArtifactId) missingLineage.push('layoutArtifactId');

  return {
    orderId: order.id,
    isSynthetic,
    artifactPurpose,
    sourceAssets,
    transcriptArtifactId,
    plannerArtifactId,
    storyboardArtifactId,
    proseArtifactId,
    artPromptArtifactId,
    guidedReferenceArtifactIds,
    layoutArtifactId,
    generatedAt,
    generatorName,
    command,
    lineageComplete: missingLineage.length === 0,
    missingLineage,
  };
}

export function validateArtifactProvenanceManifest(
  manifest: ArtifactProvenanceManifest,
): string[] {
  const issues: string[] = [];
  if (isSyntheticOrderId(manifest.orderId) && !manifest.isSynthetic) {
    issues.push('ord_internal artifacts must be marked synthetic');
  }
  if (manifest.isSynthetic && manifest.artifactPurpose === 'customer_proof') {
    issues.push('synthetic artifacts cannot be customer_proof');
  }
  if (manifest.artifactPurpose === 'customer_proof' && !manifest.lineageComplete) {
    issues.push(`customer_proof lineage incomplete: ${manifest.missingLineage.join(', ')}`);
  }
  return issues;
}

export function assertArtifactCanUseFilename(
  manifest: ArtifactProvenanceManifest,
  filename: string,
): void {
  const issues = validateArtifactProvenanceManifest(manifest);
  if (
    isCustomerLookingArtifactFilename(filename) &&
    manifest.artifactPurpose !== 'customer_proof'
  ) {
    issues.push(
      `customer-looking artifact filename "${filename}" requires artifactPurpose=customer_proof`,
    );
  }
  if (issues.length > 0) {
    throw new Error(`artifact provenance violation: ${issues.join('; ')}`);
  }
}
