import {
  ArtDirectionStoryBeatSchema,
  StoryboardSchema,
  type ArtDirectionPacket,
  type ArtDirectionStoryBeat,
  type CharacterSheet,
  type Storyboard,
} from './art-direction-schemas.ts';

export type StoryboardValidationSeverity = 'error' | 'warning';

export interface StoryboardValidationIssue {
  severity: StoryboardValidationSeverity;
  code: string;
  message: string;
  path: string;
  pageNumber?: number;
}

export interface StoryboardValidationSummary {
  expectedEntries: number;
  actualEntries: number;
  missingPages: number[];
  duplicatePages: number[];
  coveredStoryBeats: ArtDirectionStoryBeat[];
  missingStoryBeats: ArtDirectionStoryBeat[];
  coveredArcSections: StoryArcSection[];
  missingArcSections: StoryArcSection[];
}

export interface StoryboardValidation {
  status: 'complete' | 'incomplete';
  bookId: string | null;
  issues: StoryboardValidationIssue[];
  errors: StoryboardValidationIssue[];
  warnings: StoryboardValidationIssue[];
  summary: StoryboardValidationSummary;
}

export interface StoryboardValidationOptions {
  /**
   * T1-T3 schemas currently define the active digital/classic storybook
   * storyboard as exactly 24 pages. Keep this injectable so the service can be
   * wired to a future product-format model without changing the result shape.
   */
  expectedEntries?: number;
  characterSheets?: CharacterSheet[];
  requireApprovals?: boolean;
}

export interface ArtDirectionStoryboardRecord {
  bookId: string;
  storyboard: Storyboard;
  validation: StoryboardValidation;
  validationStatus: StoryboardValidation['status'];
  validatedAt: string;
  schemaVersion: 1;
}

type StoryArcSection = 'beginning' | 'middle' | 'end';

const DEFAULT_STORYBOARD_PAGE_COUNT = 24;
const REQUIRED_STORY_BEATS = ArtDirectionStoryBeatSchema.options;

const STORY_ARC_BY_BEAT: Record<ArtDirectionStoryBeat, StoryArcSection> = {
  setup: 'beginning',
  inciting: 'beginning',
  rising: 'middle',
  midpoint: 'middle',
  climax: 'middle',
  resolution: 'end',
  tag: 'end',
};

const ROLE_MINIMUM_COVERAGE: Partial<Record<CharacterSheet['role'], number>> = {
  hero: 24,
  companion: Math.ceil(DEFAULT_STORYBOARD_PAGE_COUNT * 0.7),
};

function makeIssue(args: {
  severity?: StoryboardValidationSeverity;
  code: string;
  message: string;
  path: string;
  pageNumber?: number;
}): StoryboardValidationIssue {
  return {
    severity: args.severity ?? 'error',
    code: args.code,
    message: args.message,
    path: args.path,
    ...(args.pageNumber !== undefined ? { pageNumber: args.pageNumber } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getStoryboardInput(input: unknown): unknown {
  if (isRecord(input) && 'storyboard' in input) return input.storyboard;
  return input;
}

function getPacketInput(input: unknown): Partial<ArtDirectionPacket> | null {
  if (isRecord(input) && 'storyboard' in input) {
    return input as Partial<ArtDirectionPacket>;
  }
  return null;
}

function getRawEntries(storyboardInput: unknown): unknown[] {
  if (!isRecord(storyboardInput) || !Array.isArray(storyboardInput.entries)) return [];
  return storyboardInput.entries;
}

function entryPageNumber(entry: unknown): number | null {
  if (!isRecord(entry)) return null;
  const page = entry.page_number;
  return Number.isInteger(page) ? page as number : null;
}

function entryStoryBeat(entry: unknown): ArtDirectionStoryBeat | null {
  if (!isRecord(entry)) return null;
  const result = ArtDirectionStoryBeatSchema.safeParse(entry.story_beat);
  return result.success ? result.data : null;
}

function hasNonEmptyArrayField(entry: unknown, field: string): boolean {
  if (!isRecord(entry)) return false;
  const value = entry[field];
  return Array.isArray(value) && value.length > 0;
}

function hasContinuityCallback(entry: unknown, pageNumber: number | null): boolean {
  if (!isRecord(entry) || !isRecord(entry.continuity_callback)) return false;
  if (pageNumber === 1) return entry.continuity_callback.to_page === null;
  return Number.isInteger(entry.continuity_callback.to_page);
}

function hasTransitionIntoNext(entry: unknown, pageNumber: number | null, expectedEntries: number): boolean {
  if (!isRecord(entry)) return false;
  if (pageNumber === expectedEntries) return entry.transition_into_next === null;
  return typeof entry.transition_into_next === 'string' && entry.transition_into_next.trim().length > 0;
}

function addSchemaIssues(storyboardInput: unknown, issues: StoryboardValidationIssue[]) {
  const parsed = StoryboardSchema.safeParse(storyboardInput);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.') || 'storyboard';
    issues.push(makeIssue({
      code: 'schema_invalid',
      message: issue.message,
      path,
      pageNumber: typeof issue.path[1] === 'number'
        ? entryPageNumber(getRawEntries(storyboardInput)[issue.path[1]])
        : undefined,
    }));
  }
}

function addPageCoverageIssues(
  entries: unknown[],
  expectedEntries: number,
  issues: StoryboardValidationIssue[],
): { missingPages: number[]; duplicatePages: number[] } {
  const counts = new Map<number, number>();
  for (const entry of entries) {
    const pageNumber = entryPageNumber(entry);
    if (pageNumber === null) continue;
    counts.set(pageNumber, (counts.get(pageNumber) ?? 0) + 1);
  }

  const missingPages: number[] = [];
  for (let page = 1; page <= expectedEntries; page += 1) {
    if (!counts.has(page)) {
      missingPages.push(page);
      issues.push(makeIssue({
        code: 'missing_page',
        message: `Missing storyboard page ${page}.`,
        path: 'entries',
        pageNumber: page,
      }));
    }
  }

  const duplicatePages = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([page]) => page)
    .sort((a, b) => a - b);
  for (const page of duplicatePages) {
    issues.push(makeIssue({
      code: 'duplicate_page',
      message: `Storyboard page ${page} appears more than once.`,
      path: 'entries',
      pageNumber: page,
    }));
  }

  if (entries.length !== expectedEntries) {
    issues.push(makeIssue({
      code: 'entry_count_mismatch',
      message: `Storyboard must contain exactly ${expectedEntries} entries; found ${entries.length}.`,
      path: 'entries',
    }));
  }

  return { missingPages, duplicatePages };
}

function addContinuityIssues(
  entries: unknown[],
  expectedEntries: number,
  issues: StoryboardValidationIssue[],
) {
  entries.forEach((entry, index) => {
    const pageNumber = entryPageNumber(entry);
    const path = `entries.${index}`;

    if (!hasContinuityCallback(entry, pageNumber)) {
      issues.push(makeIssue({
        code: 'missing_continuity_callback',
        message: pageNumber === 1
          ? 'Page 1 continuity_callback.to_page must be null.'
          : 'Every page after page 1 must declare continuity_callback.to_page.',
        path: `${path}.continuity_callback`,
        pageNumber: pageNumber ?? undefined,
      }));
    }

    if (!hasTransitionIntoNext(entry, pageNumber, expectedEntries)) {
      issues.push(makeIssue({
        code: 'missing_transition_into_next',
        message: pageNumber === expectedEntries
          ? `Page ${expectedEntries} transition_into_next must be null.`
          : `Every page before page ${expectedEntries} must declare transition_into_next.`,
        path: `${path}.transition_into_next`,
        pageNumber: pageNumber ?? undefined,
      }));
    }

    if (!hasNonEmptyArrayField(entry, 'required_recurring_objects')) {
      issues.push(makeIssue({
        code: 'missing_required_recurring_objects',
        message: 'required_recurring_objects must be non-empty.',
        path: `${path}.required_recurring_objects`,
        pageNumber: pageNumber ?? undefined,
      }));
    }
  });
}

function addStoryBeatIssues(
  entries: unknown[],
  issues: StoryboardValidationIssue[],
): {
  coveredStoryBeats: ArtDirectionStoryBeat[];
  missingStoryBeats: ArtDirectionStoryBeat[];
  coveredArcSections: StoryArcSection[];
  missingArcSections: StoryArcSection[];
} {
  const beatSet = new Set<ArtDirectionStoryBeat>();
  const arcSet = new Set<StoryArcSection>();
  for (const entry of entries) {
    const beat = entryStoryBeat(entry);
    if (!beat) continue;
    beatSet.add(beat);
    arcSet.add(STORY_ARC_BY_BEAT[beat]);
  }

  const coveredStoryBeats = REQUIRED_STORY_BEATS.filter((beat) => beatSet.has(beat));
  const missingStoryBeats = REQUIRED_STORY_BEATS.filter((beat) => !beatSet.has(beat));
  for (const beat of missingStoryBeats) {
    issues.push(makeIssue({
      code: 'missing_story_beat',
      message: `Storyboard missing required story_beat ${beat}.`,
      path: 'entries.story_beat',
    }));
  }

  const requiredArcSections: StoryArcSection[] = ['beginning', 'middle', 'end'];
  const coveredArcSections = requiredArcSections.filter((section) => arcSet.has(section));
  const missingArcSections = requiredArcSections.filter((section) => !arcSet.has(section));
  for (const section of missingArcSections) {
    issues.push(makeIssue({
      code: 'missing_story_arc_section',
      message: `Storyboard missing ${section} story coverage.`,
      path: 'entries.story_beat',
    }));
  }

  return { coveredStoryBeats, missingStoryBeats, coveredArcSections, missingArcSections };
}

function addCharacterCoverageWarnings(
  entries: unknown[],
  characterSheets: CharacterSheet[],
  issues: StoryboardValidationIssue[],
) {
  const appearances = new Map<string, number>();
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.characters_present)) continue;
    const pageCharacters = new Set<string>();
    for (const character of entry.characters_present) {
      if (isRecord(character) && typeof character.character_id === 'string') {
        pageCharacters.add(character.character_id);
      }
    }
    for (const characterId of pageCharacters) {
      appearances.set(characterId, (appearances.get(characterId) ?? 0) + 1);
    }
  }

  for (const sheet of characterSheets) {
    const minimum = ROLE_MINIMUM_COVERAGE[sheet.role];
    if (!minimum) continue;
    const count = appearances.get(sheet.character_id) ?? 0;
    if (count < minimum) {
      issues.push(makeIssue({
        severity: 'warning',
        code: 'character_coverage_below_minimum',
        message: `${sheet.display_name} appears on ${count}/${minimum} required pages for role ${sheet.role}.`,
        path: 'entries.characters_present',
      }));
    }
  }
}

function addApprovalIssues(
  packet: Partial<ArtDirectionPacket> | null,
  characterSheets: CharacterSheet[],
  requireApprovals: boolean,
  issues: StoryboardValidationIssue[],
) {
  if (!requireApprovals) return;

  if (packet?.style_bible) {
    if (!packet.style_bible.versioning?.approved_by || !packet.style_bible.versioning?.approved_at) {
      issues.push(makeIssue({
        code: 'style_bible_approval_missing',
        message: 'Style bible approval fields are required before storyboard readiness.',
        path: 'style_bible.versioning',
      }));
    }
  }

  characterSheets.forEach((sheet, index) => {
    if (!sheet.versioning?.approved_by || !sheet.versioning?.approved_at) {
      issues.push(makeIssue({
        code: 'character_sheet_approval_missing',
        message: `${sheet.display_name} approval fields are required before storyboard readiness.`,
        path: `character_sheets.${index}.versioning`,
      }));
    }
  });
}

export function validateStoryboardCompleteness(
  input: unknown,
  options: StoryboardValidationOptions = {},
): StoryboardValidation {
  const expectedEntries = options.expectedEntries ?? DEFAULT_STORYBOARD_PAGE_COUNT;
  const packet = getPacketInput(input);
  const storyboardInput = getStoryboardInput(input);
  const entries = getRawEntries(storyboardInput);
  const characterSheets = options.characterSheets ?? packet?.character_sheets ?? [];
  const issues: StoryboardValidationIssue[] = [];

  if (expectedEntries !== DEFAULT_STORYBOARD_PAGE_COUNT) {
    issues.push(makeIssue({
      severity: 'warning',
      code: 'unsupported_storyboard_page_count',
      message: `Storyboard schemas currently target ${DEFAULT_STORYBOARD_PAGE_COUNT} pages; requested ${expectedEntries}.`,
      path: 'entries',
    }));
  }

  addSchemaIssues(storyboardInput, issues);
  const pageCoverage = addPageCoverageIssues(entries, expectedEntries, issues);
  addContinuityIssues(entries, expectedEntries, issues);
  const beatCoverage = addStoryBeatIssues(entries, issues);
  addCharacterCoverageWarnings(entries, characterSheets, issues);
  addApprovalIssues(packet, characterSheets, options.requireApprovals ?? true, issues);

  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const bookId = isRecord(storyboardInput) && typeof storyboardInput.book_id === 'string'
    ? storyboardInput.book_id
    : packet?.style_bible?.book_id ?? null;

  return {
    status: errors.length === 0 ? 'complete' : 'incomplete',
    bookId,
    issues,
    errors,
    warnings,
    summary: {
      expectedEntries,
      actualEntries: entries.length,
      missingPages: pageCoverage.missingPages,
      duplicatePages: pageCoverage.duplicatePages,
      ...beatCoverage,
    },
  };
}

export function buildArtDirectionStoryboardRecord(args: {
  packet: ArtDirectionPacket;
  validatedAt: string;
  validation?: StoryboardValidation;
}): ArtDirectionStoryboardRecord {
  const validation = args.validation ?? validateStoryboardCompleteness(args.packet);
  return {
    bookId: args.packet.storyboard.book_id,
    storyboard: args.packet.storyboard,
    validation,
    validationStatus: validation.status,
    validatedAt: args.validatedAt,
    schemaVersion: 1,
  };
}
