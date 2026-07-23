export interface PrintReadinessEvidence {
  provider: 'lulu' | 'rpi';
  sku: string;
  templateFile: string;
  templateSha256: string;
  templateRetrievedAt: string;
  interiorTrim: string;
  pageCount: number;
  interiorFullBleed: boolean;
  coverUsesExactTemplateDimensions: boolean;
  coverImportantContentInsetInches: number;
  coverBackgroundReachesBleed: boolean;
  spineReviewed: boolean;
  orientationReviewed: boolean;
  bindingReviewed: boolean;
  deterministicPreflightPassed: boolean;
  proofCopyReceivedAndReviewed: boolean;
}

export interface PrintReadinessResult {
  ready: boolean;
  blockers: string[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const LULU_IMPORTANT_CONTENT_INSET_INCHES = 0.875;

export function evaluatePrintReadiness(evidence: PrintReadinessEvidence): PrintReadinessResult {
  const blockers: string[] = [];
  if (!evidence.sku.trim()) blockers.push('missing exact provider SKU');
  if (!evidence.templateFile.trim()) blockers.push('missing exact current provider template');
  if (!SHA256.test(evidence.templateSha256)) blockers.push('provider template SHA-256 is missing or invalid');
  if (!evidence.templateRetrievedAt.trim()) blockers.push('provider template retrieval date is missing');
  if (!evidence.interiorTrim.trim()) blockers.push('interior trim is missing');
  if (!Number.isInteger(evidence.pageCount) || evidence.pageCount <= 0) blockers.push('page count is invalid');
  if (!evidence.interiorFullBleed) blockers.push('interior pages are not verified full bleed');
  if (!evidence.coverUsesExactTemplateDimensions) blockers.push('cover does not use exact provider template dimensions');
  if (evidence.provider === 'lulu' && evidence.coverImportantContentInsetInches < LULU_IMPORTANT_CONTENT_INSET_INCHES) {
    blockers.push('important cover content is inside Lulu’s 0.875-inch edge safety inset');
  }
  if (!evidence.coverBackgroundReachesBleed) blockers.push('cover background does not reach the full bleed edge');
  if (!evidence.spineReviewed) blockers.push('spine is not reviewed');
  if (!evidence.orientationReviewed) blockers.push('imposed orientation is not reviewed');
  if (!evidence.bindingReviewed) blockers.push('binding is not reviewed');
  if (!evidence.deterministicPreflightPassed) blockers.push('deterministic print preflight did not pass');
  if (!evidence.proofCopyReceivedAndReviewed) blockers.push('physical proof copy has not been received and reviewed');
  return { ready: blockers.length === 0, blockers };
}
