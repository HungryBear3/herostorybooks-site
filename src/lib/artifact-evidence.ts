/**
 * Artifact evidence gate (Slice 4).
 *
 * A pure, read-only validator that produces a structured pass/fail result
 * BEFORE any "gift-quality / custom proof" readiness claim. It never mutates an
 * order, never calls a provider, and never releases anything — it only inspects
 * already-persisted artifacts and reports evidence.
 *
 * The result is surfaced through order diagnostics so Rex can inspect it. It is
 * intentionally DIAGNOSTIC-ONLY at this layer: it does not flip
 * proof_release_hold or the manual-review gate. Enforcement wiring is a
 * separate, Rex-owned decision.
 *
 * Default posture is FAIL-CLOSED: missing/short/imageless artifacts, unknown
 * provenance, or template-only/degraded source do NOT pass as gift-quality.
 *
 * Provenance note: this is a minimal, self-contained evidence validator. It is
 * intentionally NOT coupled to the in-progress `src/lib/artifact-provenance.ts`
 * lineage manifest (different WIP). The two could later merge — the lineage
 * manifest would feed `reasons`/`counts` here — but this module stands alone.
 */
import { getStoryPageCount, type OrderRecord, type PageArtifact } from './orders.ts';
import type { StorySource } from './fulfillment-types.ts';

export type EvidenceSeverity = 'pass' | 'warn' | 'fail';

export type EvidenceReasonCode =
  | 'NO_PAGE_ARTIFACTS'
  | 'PAGE_COUNT_SHORT'
  | 'PAGE_COUNT_OVER'
  | 'MISSING_PAGE_INDEX'
  | 'DUPLICATE_PAGE_INDEX'
  | 'MISSING_STORY_TEXT'
  | 'MISSING_IMAGE'
  | 'PROVENANCE_INCOMPLETE'
  | 'NO_STORY_ARTIFACT'
  | 'SOURCE_UNKNOWN'
  | 'SOURCE_TEMPLATE_ONLY'
  | 'SOURCE_DEGRADED'
  | 'REPEATED_STORY_TEXT'
  | 'REPEATED_BASE_PROMPT'
  | 'ADMIN_COPY_LEAK'
  | 'WEAK_PROSE';

export interface EvidenceReason {
  code: EvidenceReasonCode;
  severity: 'warn' | 'fail';
  message: string;
}

export interface EvidenceCounts {
  expectedPages: number;
  actualArtifacts: number;
  usableImages: number;
  missingImages: number;
  repeatedStoryTextPages: number;
  repeatedBasePromptPages: number;
  adminCopyLeakPages: number;
  weakProsePages: number;
  provenanceIncompletePages: number;
}

export type KnownOrUnknownSource = StorySource | 'unknown';

export interface ArtifactEvidenceResult {
  /** True only when NO fail-severity reason fired — i.e. evidence supports a
   *  gift-quality/custom proof claim. Warnings do not block `ok`. */
  ok: boolean;
  severity: EvidenceSeverity;
  /** Persisted story source, or 'unknown' when storyMeta is absent/unrecognized. */
  source: KnownOrUnknownSource;
  /** A known, non-template, non-degraded generation source. */
  sourceTrusted: boolean;
  reasons: EvidenceReason[];
  summary: string;
  counts: EvidenceCounts;
}

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Admin/template copy that must never appear in customer-facing page prose. */
export const ADMIN_COPY_LEAK_PATTERNS: RegExp[] = [
  /adventure notes/i,
  /\btheme:/i,
  /\bformat:/i,
  /a personalized story created for/i,
];

/** Tell-not-show phrases (advisory). Kept small and aligned with the prose
 *  guardrails; these WARN, they do not fail the gate. */
export const WEAK_PROSE_PATTERNS: RegExp[] = [
  /pulls the eye first/i,
  /everything is held in/i,
  /hinting at more adventure ahead/i,
  /feels?\s+(mysterious|exciting|magical|special)/i,
  /filled with (wonder|magic)/i,
  /\bmagical place\b/i,
];

/** A normalized text/prompt repeated on this many pages or more is a hard
 *  template failure; exactly 2 occurrences is a warning. */
const REPEAT_FAIL_THRESHOLD = 3;

const KNOWN_SOURCES: ReadonlySet<string> = new Set<StorySource>([
  'openai_chat',
  'openai_page_prose',
  'ollama_page_prose',
  'gemini_page_prose',
  'template',
  'template_after_openai_failure',
]);

const TRUSTED_SOURCES: ReadonlySet<string> = new Set<StorySource>([
  'openai_chat',
  'openai_page_prose',
  'ollama_page_prose',
  'gemini_page_prose',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalize(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function usableImage(p: PageArtifact): boolean {
  const current = (p.currentImageUrl ?? '').trim();
  const accepted = (p.acceptedImageUrl ?? '').trim();
  return current.length > 0 || accepted.length > 0;
}

/** Count pages whose normalized value collides with another page's. Returns
 *  the number of pages in any duplicate group (size ≥ 2) and the largest group. */
function duplicateStats(values: string[]): { pagesInDuplicateGroups: number; maxGroup: number } {
  const groups = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    groups.set(v, (groups.get(v) ?? 0) + 1);
  }
  let pagesInDuplicateGroups = 0;
  let maxGroup = 0;
  for (const count of groups.values()) {
    if (count >= 2) pagesInDuplicateGroups += count;
    if (count > maxGroup) maxGroup = count;
  }
  return { pagesInDuplicateGroups, maxGroup };
}

// ── Validator ────────────────────────────────────────────────────────────────

export interface EvaluateEvidenceOptions {
  /** Override the expected page count (defaults to getStoryPageCount(format)). */
  expectedPages?: number;
}

export function evaluateArtifactEvidence(
  order: OrderRecord,
  options: EvaluateEvidenceOptions = {},
): ArtifactEvidenceResult {
  const reasons: EvidenceReason[] = [];
  const fail = (code: EvidenceReasonCode, message: string) =>
    reasons.push({ code, severity: 'fail', message });
  const warn = (code: EvidenceReasonCode, message: string) =>
    reasons.push({ code, severity: 'warn', message });

  const expectedPages = options.expectedPages ?? getStoryPageCount(order.bookFormat);
  const artifacts = order.pageArtifacts ?? [];
  const actualArtifacts = artifacts.length;

  // ── source / provenance ──
  const rawSource = order.storyMeta?.source;
  const source: KnownOrUnknownSource =
    rawSource && KNOWN_SOURCES.has(rawSource) ? rawSource : 'unknown';
  const sourceTrusted = TRUSTED_SOURCES.has(source);

  if (source === 'unknown') {
    // Fail closed: cannot claim custom/gift-quality without a known source.
    fail('SOURCE_UNKNOWN', 'story source is unknown/unrecognized — cannot evidence custom proof');
  } else if (source === 'template') {
    fail('SOURCE_TEMPLATE_ONLY', 'story source is template-only — not evidence of a custom/gift-quality story');
  } else if (source === 'template_after_openai_failure') {
    fail('SOURCE_DEGRADED', 'story silently degraded to template after generation failure');
  }

  if (!order.storyArtifactUrl) {
    fail('NO_STORY_ARTIFACT', 'no story/proof artifact URL persisted yet');
  }

  // ── page count ──
  if (actualArtifacts === 0) {
    fail('NO_PAGE_ARTIFACTS', 'no page artifacts present');
  } else if (actualArtifacts < expectedPages) {
    fail('PAGE_COUNT_SHORT', `only ${actualArtifacts}/${expectedPages} page artifacts present`);
  } else if (actualArtifacts > expectedPages) {
    warn('PAGE_COUNT_OVER', `${actualArtifacts} page artifacts exceeds expected ${expectedPages}`);
  }

  // ── per-page structure ──
  const seenIndexes = new Set<number>();
  let missingImages = 0;
  let provenanceIncompletePages = 0;
  let adminCopyLeakPages = 0;
  let weakProsePages = 0;
  let badIndex = false;
  let dupIndex = false;
  let missingText = false;
  const storyTexts: string[] = [];
  const basePrompts: string[] = [];

  for (const p of artifacts) {
    if (!Number.isInteger(p.pageIndex) || p.pageIndex < 0 || p.pageIndex >= expectedPages) badIndex = true;
    else if (seenIndexes.has(p.pageIndex)) dupIndex = true;
    else seenIndexes.add(p.pageIndex);

    if (normalize(p.storyText).length === 0) missingText = true;
    if (!usableImage(p)) missingImages += 1;

    // Provenance metadata when available: prompt + provider. Soft signal.
    const hasPrompt = (p.basePrompt ?? '').trim().length > 0;
    const hasProvider = Boolean(p.generationProvider);
    if (!hasPrompt || !hasProvider) provenanceIncompletePages += 1;

    const text = p.storyText ?? '';
    if (ADMIN_COPY_LEAK_PATTERNS.some((re) => re.test(text))) adminCopyLeakPages += 1;
    if (WEAK_PROSE_PATTERNS.some((re) => re.test(text))) weakProsePages += 1;

    storyTexts.push(normalize(p.storyText));
    basePrompts.push(normalize(p.basePrompt));
  }

  const missingExpectedIndexes = Array.from({ length: expectedPages }, (_, i) => i)
    .filter((i) => !seenIndexes.has(i));
  if (badIndex) fail('MISSING_PAGE_INDEX', 'one or more page artifacts have an invalid or out-of-range page index');
  if (missingExpectedIndexes.length > 0) {
    fail(
      'MISSING_PAGE_INDEX',
      `missing expected page index(es): ${missingExpectedIndexes.slice(0, 8).join(', ')}${missingExpectedIndexes.length > 8 ? ', …' : ''}`,
    );
  }
  if (dupIndex) fail('DUPLICATE_PAGE_INDEX', 'duplicate page indexes across artifacts');
  if (missingText) fail('MISSING_STORY_TEXT', 'one or more page artifacts have empty story text');
  if (missingImages > 0) {
    fail('MISSING_IMAGE', `${missingImages} page artifact(s) have no usable image reference`);
  }
  if (provenanceIncompletePages > 0) {
    warn('PROVENANCE_INCOMPLETE', `${provenanceIncompletePages} page(s) missing prompt/provider provenance`);
  }

  // ── repetition (template/prose failure) ──
  const textDup = duplicateStats(storyTexts);
  if (textDup.maxGroup >= REPEAT_FAIL_THRESHOLD) {
    fail('REPEATED_STORY_TEXT', `identical story text repeated on ${textDup.maxGroup} pages`);
  } else if (textDup.pagesInDuplicateGroups > 0) {
    warn('REPEATED_STORY_TEXT', `story text repeated across ${textDup.pagesInDuplicateGroups} pages`);
  }

  const promptDup = duplicateStats(basePrompts);
  if (promptDup.maxGroup >= REPEAT_FAIL_THRESHOLD) {
    fail('REPEATED_BASE_PROMPT', `identical basePrompt repeated on ${promptDup.maxGroup} pages`);
  } else if (promptDup.pagesInDuplicateGroups > 0) {
    warn('REPEATED_BASE_PROMPT', `basePrompt repeated across ${promptDup.pagesInDuplicateGroups} pages`);
  }

  // ── leaks / weak prose ──
  if (adminCopyLeakPages > 0) {
    fail('ADMIN_COPY_LEAK', `${adminCopyLeakPages} page(s) leak admin/template copy`);
  }
  if (weakProsePages > 0) {
    warn('WEAK_PROSE', `${weakProsePages} page(s) contain weak tell-not-show prose`);
  }

  // ── verdict ──
  const usableImages = actualArtifacts - missingImages;
  const hasFail = reasons.some((r) => r.severity === 'fail');
  const hasWarn = reasons.some((r) => r.severity === 'warn');
  const severity: EvidenceSeverity = hasFail ? 'fail' : hasWarn ? 'warn' : 'pass';
  const ok = !hasFail;

  const counts: EvidenceCounts = {
    expectedPages,
    actualArtifacts,
    usableImages,
    missingImages,
    repeatedStoryTextPages: textDup.pagesInDuplicateGroups,
    repeatedBasePromptPages: promptDup.pagesInDuplicateGroups,
    adminCopyLeakPages,
    weakProsePages,
    provenanceIncompletePages,
  };

  const summary = buildSummary(ok, severity, source, counts, reasons);

  return { ok, severity, source, sourceTrusted, reasons, summary, counts };
}

function buildSummary(
  ok: boolean,
  severity: EvidenceSeverity,
  source: KnownOrUnknownSource,
  counts: EvidenceCounts,
  reasons: EvidenceReason[],
): string {
  const head = ok
    ? 'PASS — artifacts support a custom/gift-quality proof claim'
    : `FAIL — not evidenced as gift-quality (${reasons.filter((r) => r.severity === 'fail').length} blocker(s))`;
  const warnNote = severity === 'warn' ? ' [warnings present]' : '';
  return (
    `${head}${warnNote}. source=${source}, ` +
    `images ${counts.usableImages}/${counts.expectedPages}, ` +
    `artifacts ${counts.actualArtifacts}/${counts.expectedPages}` +
    (counts.adminCopyLeakPages ? `, admin-copy-leak ${counts.adminCopyLeakPages}` : '') +
    (counts.repeatedStoryTextPages ? `, repeated-text ${counts.repeatedStoryTextPages}` : '') +
    '.'
  );
}
