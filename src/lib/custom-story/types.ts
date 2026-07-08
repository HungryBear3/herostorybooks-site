/**
 * Lane-agnostic types for HeroStoryBooks' fully-custom, shape-gated,
 * concierge-first story model.
 *
 * These objects are deliberately identical whether an operator fills them in
 * (concierge lane) or a model does (self-serve lane) — see
 * `docs`/`hsb-fully-custom-rollout-model-2026-07-08.md` §4: the brief schema,
 * anchor validation, and rubric records must be lane-agnostic from day one so a
 * shape can write its own regression suite from real concierge orders.
 *
 * Nothing in this module (or its siblings) touches checkout, Stripe, orders,
 * email, print, or any image/prose provider. It is pure data + validation.
 *
 * Sanitization boundary (gatekeeper review P1): the raw voice transcript must
 * NEVER be represented on the downstream brief. A `customStoryBrief` carries a
 * `sanitizedSourceSummary` only. `rawTranscript` is intentionally NOT a field —
 * and the validators fail closed if one is smuggled onto the object.
 */

/** Hero structure of a story shape — who the book is fundamentally about. */
export type HeroStructure =
  | 'child'
  | 'parent'
  | 'dual-parent'
  | 'grandparent'
  | 'sibling'
  | 'whole-family'
  | 'pet'
  | 'custom-cast';

/** Where the story comes from. */
export type StorySource = 'guided' | 'memory' | 'custom-plot';

/** The child's role in the story. */
export type ChildRole =
  | 'hero'
  | 'side-character'
  | 'recipient'
  | 'listener'
  | 'audience';

/**
 * A story shape = hero structure × story source × child role. Shapes — not hero
 * types — are the unit of gating (rollout model §2): Taco Gate proved the risk
 * lives in the combination.
 */
export interface StoryShape {
  heroStructure: HeroStructure;
  storySource: StorySource;
  childRole: ChildRole;
}

/** Role a cast member plays. Only `primary_hero` drives beats. */
export type CustomCastRole =
  | 'primary_hero'
  | 'co_protagonist'
  | 'recipient'
  | 'side_character'
  | 'listener'
  | 'audience';

export interface CustomStoryHero {
  name: string;
  role: CustomCastRole;
  /** e.g. "adult parent", "child", "grandparent". Free text, life-stage aware. */
  ageStage?: string;
  traits?: string[];
}

/**
 * The child recipient/audience. May react, listen, laugh, appear in framing —
 * must never become the plot-driver or rescuer (gatekeeper review, recipient
 * protection).
 */
export interface RecipientAudience {
  name: string;
  role: CustomCastRole;
  ageStage?: string;
  rules?: string[];
}

/**
 * A required story beat, matched against plan + prose by anchor OR any alias
 * (P3: exact-string matching alone fails good stories and passes bad ones).
 */
export interface StoryAnchor {
  anchor: string;
  aliases: string[];
}

/**
 * Provenance flags. Drives the sanitization + deletion-cascade rules (P7) and
 * the verbatim-quote check (P9). NOTE: there is deliberately no place here for a
 * raw transcript.
 */
export interface CustomStoryProvenance {
  /** How the source material reached us. */
  source: 'voice-memo' | 'written-note' | 'guided-theme' | 'operator-authored';
  /** True when derived from a buyer voice memo (retention/deletion cascade). */
  voiceMemoDerived: boolean;
  /** True once the raw transcript has been sanitized into the summary/brief. */
  transcriptSanitized: boolean;
  /** True once an operator has approved this brief for generation (P2). */
  briefApprovedByOperator: boolean;
  /**
   * True when the raw source transcript is still available to the extraction /
   * proof lane. When true, the verbatim-quote check (P9) is enforced against it.
   */
  sourceTranscriptAvailableToProofLane: boolean;
}

/**
 * The single downstream input for a custom story. After operator approval this
 * is the SOLE thing the planner/prose/image lanes ever see.
 */
export interface CustomStoryBrief {
  workingTitle: string;
  storyShape: StoryShape;
  /** Capped at 2 co-protagonists for this first slice (P5). */
  primaryHeroes: CustomStoryHero[];
  recipientAudience?: RecipientAudience | null;
  setting: string;
  coreMemory: string;
  mustInclude: StoryAnchor[];
  mustAvoid: string[];
  tone: string[];
  lesson: string;
  /** Sanitized paraphrase of the source — never the raw transcript (P1). */
  sanitizedSourceSummary: string;
  /** A kid-safe boundary line the story can lean on, when supplied. */
  kidSafeBoundaryLine?: string;
  /** Only these names may appear in the brief or the book (P10). */
  castLock: string[];
  provenance: CustomStoryProvenance;
}

/** Ensemble cap for this first slice (P5): Mom + Dad. Three-plus is Phase C. */
export const MAX_PRIMARY_HEROES = 2;

/** Each co-protagonist must drive at least this share of beats (P5 / rubric). */
export const MIN_COPROTAGONIST_BEAT_SHARE = 1 / 3;

/**
 * A single planned or final beat/page, normalized for validation. `driver` is
 * optional; when omitted the validators infer actors from the text.
 */
export interface CustomStoryBeat {
  /** 0-based order. */
  index: number;
  /** The beat's prose or plan text. */
  text: string;
  /** Optional explicit driver name(s) for this beat. */
  drivers?: string[];
}
