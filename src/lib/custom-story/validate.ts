/**
 * Fail-closed validators for the custom-story pipeline.
 *
 * Pipeline (gatekeeper review P1/P2): raw transcript → sanitized brief →
 * operator approval → sanitized brief is the SOLE downstream input. These
 * validators guard the three checkpoints:
 *
 *   1. validateCustomStoryBrief()        — before generation runs
 *   2. validateCustomStoryPlanAnchors()  — after the beat plan is produced
 *   3. validateFinalCustomStoryProse()   — after final page prose is produced
 *
 * Every failure routes to the manual queue (P6). There is NO template fallback:
 * a custom story that fails validation is handed to a human, never silently
 * replaced by a preset theme.
 *
 * Pure functions. No I/O, no providers, no order mutation.
 */

import {
  MAX_PRIMARY_HEROES,
  MIN_COPROTAGONIST_BEAT_SHARE,
  type CustomStoryBeat,
  type CustomStoryBrief,
  type StoryAnchor,
} from './types.ts';
import { PRESET_TEMPLATE_LEXICON, mergedAvoidTerms } from './ban-list.ts';

// ── Result model ──────────────────────────────────────────────────────────────

export interface ValidationFailure {
  /** Stable machine code, e.g. 'anchor_missing'. */
  code: string;
  /** Human-readable explanation for the manual queue. */
  message: string;
  /** Optional field/anchor/name the failure concerns. */
  subject?: string;
}

export interface ValidationResult {
  ok: boolean;
  /** Where this brief/plan/prose routes next. `manual_queue` on any failure. */
  route: 'proceed' | 'manual_queue';
  failures: ValidationFailure[];
}

function result(failures: ValidationFailure[]): ValidationResult {
  return {
    ok: failures.length === 0,
    route: failures.length === 0 ? 'proceed' : 'manual_queue',
    failures,
  };
}

// ── Forbidden keys (sanitization boundary, P1) ───────────────────────────────

/** Keys that must never appear on a downstream brief — the raw source material. */
const FORBIDDEN_DOWNSTREAM_KEYS = [
  'rawTranscript',
  'transcript',
  'rawAudioUrl',
  'voiceMemoUrl',
  'audioBlob',
] as const;

function forbiddenKeyFailures(obj: unknown): ValidationFailure[] {
  if (!obj || typeof obj !== 'object') return [];
  const failures: ValidationFailure[] = [];
  for (const key of FORBIDDEN_DOWNSTREAM_KEYS) {
    if (key in (obj as Record<string, unknown>)) {
      failures.push({
        code: 'raw_source_leak',
        message: `sanitization boundary violated: '${key}' must never reach a downstream custom-story brief`,
        subject: key,
      });
    }
  }
  return failures;
}

// ── Text helpers ─────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'to', 'in', 'on', 'at', 'for', 'with',
  'his', 'her', 'their', 'its', 'that', 'this', 'is', 'are', 'as', 'by',
]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean);
}

/** Significant tokens: length ≥ 3 and not a stopword. */
function significantTokens(text: string): string[] {
  return tokens(text).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function includesPhrase(haystackNormalized: string, phrase: string): boolean {
  const p = normalize(phrase);
  if (!p) return false;
  return ` ${haystackNormalized} `.includes(` ${p} `) || haystackNormalized.includes(p);
}

/**
 * An anchor is satisfied when its anchor phrase OR any alias appears in a beat,
 * OR when at least `min(2, significantTokenCount)` of the anchor's significant
 * tokens co-occur in a single beat. Fuzzy-by-design (P3): exact-string matching
 * alone fails good stories and passes bad ones.
 */
function anchorSatisfied(anchor: StoryAnchor, beatTexts: string[]): boolean {
  const phrases = [anchor.anchor, ...(anchor.aliases ?? [])];
  const anchorTokens = significantTokens(anchor.anchor);
  const needed = Math.min(2, anchorTokens.length) || 1;

  for (const raw of beatTexts) {
    const norm = normalize(raw);
    if (phrases.some((p) => includesPhrase(norm, p))) return true;
    const present = anchorTokens.filter((t) => norm.split(' ').includes(t)).length;
    if (present >= needed) return true;
  }
  return false;
}

// ── Beat attribution (ensemble integrity, P5 / rubric) ───────────────────────

/** Verbs that mark a cast member as *driving* a beat (protagonist behavior). */
const DRIVER_VERBS = [
  'saves', 'save', 'saved', 'rescues', 'rescue', 'rescued', 'solves', 'solve',
  'solved', 'decides', 'decide', 'decided', 'leads', 'lead', 'led', 'defeats',
  'defeat', 'defeated', 'fixes', 'fix', 'fixed', 'protects', 'protect',
  'protected', 'chooses', 'choose', 'chose', 'stands up', 'keeps', 'helps',
];

function firstName(name: string): string {
  return normalize(name).split(' ')[0] ?? '';
}

/** Beats a cast name appears in (drives or is named as an actor). */
function beatsMentioning(name: string, beats: CustomStoryBeat[]): number[] {
  const fn = firstName(name);
  if (!fn) return [];
  const hits: number[] = [];
  beats.forEach((beat) => {
    const explicit = (beat.drivers ?? []).some((d) => firstName(d) === fn);
    const inText = normalize(beat.text).split(' ').includes(fn);
    if (explicit || inText) hits.push(beat.index);
  });
  return hits;
}

/** Beats where `name` is the subject of a driver verb (protagonist behavior). */
function beatsDriving(name: string, beats: CustomStoryBeat[]): number[] {
  const fn = firstName(name);
  if (!fn) return [];
  const hits: number[] = [];
  beats.forEach((beat) => {
    if ((beat.drivers ?? []).some((d) => firstName(d) === fn)) {
      hits.push(beat.index);
      return;
    }
    const norm = normalize(beat.text);
    // `<name> ... <driver verb>` within a short window.
    const idx = norm.split(' ').indexOf(fn);
    if (idx === -1) return;
    const window = norm.split(' ').slice(idx, idx + 4).join(' ');
    if (DRIVER_VERBS.some((v) => window.includes(v))) hits.push(beat.index);
  });
  return hits;
}

// ── 1. Brief validation ──────────────────────────────────────────────────────

/**
 * Validate a sanitized brief before generation. Enforces the ensemble cap, cast
 * lock membership, anchor structure, provenance/sanitization invariants, and the
 * no-raw-source boundary. Fails closed to the manual queue.
 */
export function validateCustomStoryBrief(brief: CustomStoryBrief): ValidationResult {
  const failures: ValidationFailure[] = [];

  failures.push(...forbiddenKeyFailures(brief));

  if (!brief.workingTitle?.trim()) {
    failures.push({ code: 'missing_field', message: 'workingTitle is required', subject: 'workingTitle' });
  }
  if (!brief.setting?.trim()) {
    failures.push({ code: 'missing_field', message: 'setting is required', subject: 'setting' });
  }
  if (!brief.coreMemory?.trim()) {
    failures.push({ code: 'missing_field', message: 'coreMemory is required', subject: 'coreMemory' });
  }
  if (!brief.lesson?.trim()) {
    failures.push({ code: 'missing_field', message: 'lesson is required', subject: 'lesson' });
  }
  if (!Array.isArray(brief.tone) || brief.tone.length === 0) {
    failures.push({ code: 'missing_field', message: 'tone must have at least one entry', subject: 'tone' });
  }

  const shape = brief.storyShape;
  if (!shape?.heroStructure || !shape?.storySource || !shape?.childRole) {
    failures.push({ code: 'invalid_shape', message: 'storyShape requires heroStructure, storySource, and childRole', subject: 'storyShape' });
  }

  // Ensemble cap (P5).
  const heroes = brief.primaryHeroes ?? [];
  if (heroes.length === 0) {
    failures.push({ code: 'no_primary_hero', message: 'at least one primary hero is required', subject: 'primaryHeroes' });
  }
  if (heroes.length > MAX_PRIMARY_HEROES) {
    failures.push({
      code: 'ensemble_cap_exceeded',
      message: `primaryHeroes capped at ${MAX_PRIMARY_HEROES} for this slice; got ${heroes.length}`,
      subject: 'primaryHeroes',
    });
  }
  heroes.forEach((h, i) => {
    if (!h.name?.trim()) {
      failures.push({ code: 'missing_field', message: `primaryHeroes[${i}].name is required`, subject: 'primaryHeroes' });
    }
    if (h.role !== 'primary_hero' && h.role !== 'co_protagonist') {
      failures.push({
        code: 'invalid_hero_role',
        message: `primaryHeroes[${i}] must be primary_hero/co_protagonist, got '${h.role}'`,
        subject: h.name,
      });
    }
  });

  // Recipient must never be cast as a driver role (recipient protection).
  const recipient = brief.recipientAudience;
  if (recipient) {
    if (recipient.role === 'primary_hero' || recipient.role === 'co_protagonist') {
      failures.push({
        code: 'recipient_is_protagonist',
        message: `recipientAudience '${recipient.name}' must not hold a protagonist role`,
        subject: recipient.name,
      });
    }
  }

  // Cast lock (P10): every named hero/recipient must be in castLock.
  const castLock = (brief.castLock ?? []).map(firstName);
  if (castLock.length === 0) {
    failures.push({ code: 'missing_cast_lock', message: 'castLock must be non-empty', subject: 'castLock' });
  }
  const namedCast = [
    ...heroes.map((h) => h.name),
    ...(recipient ? [recipient.name] : []),
  ].filter(Boolean);
  for (const name of namedCast) {
    if (!castLock.includes(firstName(name))) {
      failures.push({
        code: 'cast_not_locked',
        message: `'${name}' appears in the brief but is not in castLock`,
        subject: name,
      });
    }
  }

  // Anchors well-formed (P3).
  const anchors = brief.mustInclude ?? [];
  if (anchors.length === 0) {
    failures.push({ code: 'no_anchors', message: 'mustInclude must have at least one anchor', subject: 'mustInclude' });
  }
  anchors.forEach((a, i) => {
    if (!a.anchor?.trim()) {
      failures.push({ code: 'invalid_anchor', message: `mustInclude[${i}].anchor is empty`, subject: 'mustInclude' });
    }
    if (!Array.isArray(a.aliases)) {
      failures.push({ code: 'invalid_anchor', message: `mustInclude[${i}].aliases must be an array`, subject: a.anchor });
    }
  });

  // Provenance / sanitization invariants (P1/P2/P7).
  const prov = brief.provenance;
  if (!prov) {
    failures.push({ code: 'missing_provenance', message: 'provenance is required', subject: 'provenance' });
  } else {
    if (prov.voiceMemoDerived && !prov.transcriptSanitized) {
      failures.push({
        code: 'unsanitized_source',
        message: 'voice-memo-derived brief must be sanitized before generation',
        subject: 'provenance.transcriptSanitized',
      });
    }
    if (prov.voiceMemoDerived && !brief.sanitizedSourceSummary?.trim()) {
      failures.push({
        code: 'missing_sanitized_summary',
        message: 'voice-memo-derived brief requires a sanitizedSourceSummary',
        subject: 'sanitizedSourceSummary',
      });
    }
  }

  return result(failures);
}

/**
 * Standalone cast-lock enforcement (P10): given a set of names detected in
 * generated content, every one must be in the brief's castLock. Real names of
 * anyone outside the cast are a failure.
 */
export function enforceCastLock(
  brief: CustomStoryBrief,
  detectedNames: readonly string[],
): ValidationResult {
  const lock = new Set((brief.castLock ?? []).map(firstName));
  const failures: ValidationFailure[] = [];
  for (const name of detectedNames) {
    if (!lock.has(firstName(name))) {
      failures.push({
        code: 'cast_not_locked',
        message: `'${name}' is not in castLock and must not appear in the story`,
        subject: name,
      });
    }
  }
  return result(failures);
}

// ── Shared content checks (plan + prose) ─────────────────────────────────────

interface ContentChecks {
  beats: CustomStoryBeat[];
  brief: CustomStoryBrief;
}

function anchorFailures({ beats, brief }: ContentChecks): ValidationFailure[] {
  const texts = beats.map((b) => b.text);
  const failures: ValidationFailure[] = [];
  for (const anchor of brief.mustInclude ?? []) {
    if (!anchorSatisfied(anchor, texts)) {
      failures.push({
        code: 'anchor_missing',
        message: `required anchor '${anchor.anchor}' (or an alias) does not appear`,
        subject: anchor.anchor,
      });
    }
  }
  return failures;
}

function bannedTermFailures({ beats, brief }: ContentChecks): ValidationFailure[] {
  const joined = normalize(beats.map((b) => b.text).join(' \n '));
  const failures: ValidationFailure[] = [];
  for (const term of mergedAvoidTerms(brief.mustAvoid ?? [])) {
    if (includesPhrase(joined, term)) {
      failures.push({
        code: 'banned_term',
        message: `banned/avoided term '${term}' appears in the content`,
        subject: term,
      });
    }
  }
  for (const term of PRESET_TEMPLATE_LEXICON) {
    if (includesPhrase(joined, term)) {
      failures.push({
        code: 'template_contamination',
        message: `preset-template lexicon '${term}' appears — custom story is contaminated`,
        subject: term,
      });
    }
  }
  return failures;
}

function ensembleFailures({ beats, brief }: ContentChecks): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  const total = beats.length;
  if (total === 0) return failures;

  const heroes = brief.primaryHeroes ?? [];
  // Only enforce beat-share when there is a genuine ensemble (co-protagonists).
  if (heroes.length >= 2) {
    for (const hero of heroes) {
      const share = beatsMentioning(hero.name, beats).length / total;
      if (share < MIN_COPROTAGONIST_BEAT_SHARE - 1e-9) {
        failures.push({
          code: 'ensemble_collapse',
          message: `co-protagonist '${hero.name}' drives ${(share * 100).toFixed(0)}% of beats (<${Math.round(MIN_COPROTAGONIST_BEAT_SHARE * 100)}% required)`,
          subject: hero.name,
        });
      }
    }
  }

  // Recipient protection: the child recipient may appear but must never drive.
  const recipient = brief.recipientAudience;
  if (recipient) {
    const driving = beatsDriving(recipient.name, beats);
    if (driving.length > 0) {
      failures.push({
        code: 'recipient_drives_plot',
        message: `recipient '${recipient.name}' drives beats ${driving.join(', ')} — must remain audience/listener`,
        subject: recipient.name,
      });
    }
  }

  return failures;
}

// ── 2. Plan validation ───────────────────────────────────────────────────────

/**
 * Validate the beat plan against the brief: anchors present, no preset-template
 * lexicon, no banned terms, ensemble beat-share, recipient never drives. Fails
 * closed to the manual queue.
 */
export function validateCustomStoryPlanAnchors(
  brief: CustomStoryBrief,
  planBeats: CustomStoryBeat[],
): ValidationResult {
  const checks: ContentChecks = { beats: planBeats, brief };
  const failures = [
    ...forbiddenKeyFailures(brief),
    ...anchorFailures(checks),
    ...bannedTermFailures(checks),
    ...ensembleFailures(checks),
  ];
  return result(failures);
}

// ── 3. Final prose validation ────────────────────────────────────────────────

export interface FinalProseOptions {
  /**
   * The raw source transcript, IF it is available to the extraction/proof lane.
   * When provided, the verbatim-quote check (P9) runs against it. This is the
   * ONLY place a transcript is permitted — it is never persisted on the brief.
   */
  sourceTranscript?: string | null;
  /**
   * Extra names (e.g. detected proper nouns) to run through the cast lock.
   */
  detectedNames?: readonly string[];
}

/** Longest run of consecutive shared words that counts as a verbatim quote. */
const VERBATIM_NGRAM = 8;

function verbatimFailures(
  proseBeats: CustomStoryBeat[],
  transcript: string,
): ValidationFailure[] {
  const proseTokens = tokens(proseBeats.map((b) => b.text).join(' '));
  const proseNorm = ` ${proseTokens.join(' ')} `;
  const transTokens = tokens(transcript);
  const failures: ValidationFailure[] = [];

  for (let i = 0; i + VERBATIM_NGRAM <= transTokens.length; i++) {
    const gram = transTokens.slice(i, i + VERBATIM_NGRAM).join(' ');
    if (proseNorm.includes(` ${gram} `)) {
      failures.push({
        code: 'verbatim_quote',
        message: `final prose reproduces a verbatim run from the transcript: "${gram}…"`,
        subject: gram,
      });
      break; // one hit is enough to route to manual queue
    }
  }
  return failures;
}

/**
 * Validate final page prose. Runs every plan check plus verbatim-quote detection
 * (when the transcript is available to this lane) and cast-lock enforcement over
 * any detected names. Fails closed to the manual queue.
 */
export function validateFinalCustomStoryProse(
  brief: CustomStoryBrief,
  proseBeats: CustomStoryBeat[],
  options: FinalProseOptions = {},
): ValidationResult {
  const checks: ContentChecks = { beats: proseBeats, brief };
  const failures = [
    ...forbiddenKeyFailures(brief),
    ...anchorFailures(checks),
    ...bannedTermFailures(checks),
    ...ensembleFailures(checks),
  ];

  if (options.detectedNames && options.detectedNames.length > 0) {
    failures.push(...enforceCastLock(brief, options.detectedNames).failures);
  }

  const transcript = options.sourceTranscript;
  if (brief.provenance?.sourceTranscriptAvailableToProofLane && transcript) {
    failures.push(...verbatimFailures(proseBeats, transcript));
  }

  return result(failures);
}
