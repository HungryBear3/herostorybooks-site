export type FulfillmentStatus =
  | 'not_started'
  | 'generating_story'
  | 'generating_images'
  | 'building_pdf'
  | 'proof_ready'
  | 'proof_approved'
  | 'submitting_to_print'
  | 'complete'
  /**
   * Artifacts (story + images + PDF) generated and persisted successfully,
   * but the customer delivery email failed. The order has a valid
   * `storyArtifactUrl` (digital) or `proofApprovalToken` (print) — only
   * the notification is missing. Admin should NOT retry the whole
   * pipeline; the recovery path is "resend the email" (often after
   * verifying the Resend sender domain). Treated as recoverable rather
   * than `failed_manual_review` so the book itself is not regenerated.
   */
  | 'delivery_email_failed'
  | 'failed_manual_review';

/**
 * Picture-book typography control. Lets each page steer how its text is
 * placed and rendered ON TOP of the full-page illustration. This is the
 * future-proof surface for legibility tuning without flipping back to the
 * old "tiny art block + paragraph below" layout.
 *
 * - zone        : where the caption sits inside the illustration frame.
 *                 'natural' lets the renderer pick a safe default for the
 *                 page index/shot type.
 * - colorMode   : how the text colors itself relative to the panel/scrim.
 *                 Release 1 story pages resolve to dark text on cream.
 * - panelStyle  : the visual treatment behind the text. Legacy dark/scrim
 *                 values may exist in old metadata, but the PDF renderer
 *                 coerces story pages to the approved cream paper band.
 */
export type TextZone =
  | 'top_left'
  | 'top_right'
  | 'bottom_left'
  | 'bottom_right'
  | 'bottom_band'
  | 'top_band'
  | 'natural';

export type TextColorMode = 'light' | 'dark' | 'auto';

export type TextPanelStyle =
  | 'none'
  | 'translucent_cream'
  | 'translucent_dark'
  | 'soft_scrim';

export interface PageTextLayout {
  zone: TextZone;
  colorMode: TextColorMode;
  panelStyle: TextPanelStyle;
}

/**
 * Durable discriminator for how a book's story pages are laid out and
 * rendered. This is an explicit, per-order marker — never inferred at render
 * time — so the renderer can fail closed for modern books with missing
 * metadata instead of silently coercing to the legacy bottom band.
 *
 * - 'legacy_bottom_band' : the current Release-1 bottom paper band over art.
 *                          Missing/legacy per-page metadata is tolerated and
 *                          normalized (existing behavior).
 * - 'modern_full_bleed'  : the full-bleed overlay system with explicit,
 *                          validated per-page text placement. Missing or
 *                          invalid page metadata MUST fail closed.
 *
 * Absent (undefined/null) on a record = unmarked historical order → treated as
 * legacy at read time WITHOUT rewriting the record (migration boundary).
 */
export type LayoutVersion = 'legacy_bottom_band' | 'modern_full_bleed';

const TEXT_ZONES: readonly TextZone[] = [
  'top_left', 'top_right', 'bottom_left', 'bottom_right', 'bottom_band', 'top_band', 'natural',
];
const TEXT_COLOR_MODES: readonly TextColorMode[] = ['light', 'dark', 'auto'];
const TEXT_PANEL_STYLES: readonly TextPanelStyle[] = [
  'none', 'translucent_cream', 'translucent_dark', 'soft_scrim',
];

/**
 * True iff `layout` is present and every field is a known enum member. Shared
 * by the story-page contract validator and the PDF renderer's fail-closed
 * gate so both agree on what "valid modern layout metadata" means.
 */
export function isValidPageTextLayout(layout: PageTextLayout | null | undefined): layout is PageTextLayout {
  if (!layout || typeof layout !== 'object') return false;
  return (
    TEXT_ZONES.includes(layout.zone) &&
    TEXT_COLOR_MODES.includes(layout.colorMode) &&
    TEXT_PANEL_STYLES.includes(layout.panelStyle)
  );
}

/** Runtime guard for persisted data. TypeScript's union cannot protect JSON
 * records, so every non-null value must be recognized explicitly. */
export function isKnownLayoutVersion(layoutVersion: unknown): layoutVersion is LayoutVersion | null | undefined {
  return layoutVersion == null || layoutVersion === 'legacy_bottom_band' || layoutVersion === 'modern_full_bleed';
}

/** A book is rendered/validated under the modern contract ONLY when explicitly
 * marked modern. Callers must reject unknown non-null values before using this
 * predicate; only absent/null and explicit legacy are legacy-compatible. */
export function isModernLayout(layoutVersion: LayoutVersion | null | undefined): boolean {
  return layoutVersion === 'modern_full_bleed';
}

/**
 * The layout version assigned to newly generated / regenerated proofs.
 *
 * Phase 1 keeps this the legacy bottom band — the exact output of the current
 * renderer — because per-page layout metadata is not yet guaranteed by story
 * generation and the modern positioned renderer does not exist yet. Marking
 * new proofs modern now would intermittently fail-close live generation.
 * Phase 2 flips this single constant to `'modern_full_bleed'` once per-page
 * metadata production and the positioned renderer land.
 */
export const NEW_PROOF_LAYOUT_VERSION: LayoutVersion = 'legacy_bottom_band';

/**
 * Closed set of the three EXPLICIT approved proof text-color choices. Semantic,
 * not free color input. Each maps to a FIXED (text, scrim-fill) pair in
 * proof-layout-override so the UI preview and PDF renderer use identical values.
 * Absence / no explicit choice is NOT in this enum — it resolves to the legacy
 * default (#1F3A5F, a deep blue), so blue is never labeled brown. Arbitrary
 * hex/RGB/CSS/gradients are never accepted.
 */
export type ProofTextColor = 'dark_brown' | 'cream' | 'charcoal';

/**
 * PROOF-ONLY per-page positioned text-card override for the customer-facing
 * modern layout editor (the sanctioned exception to "copy must never sit over
 * art"). When a page carries this override the customer-review PDF draws the
 * story text as a positioned translucent legibility card that MAY overlap the
 * illustration. A page with no override renders as it did before; the print
 * master (`buildPrintInteriorPdf`) never reads this field.
 *
 * All geometry is normalized and resolution-independent: origin is the page
 * top-left and every distance is a fraction of the page width/height in [0,1].
 * Byte-affecting values (geometry + resolved color) fold into the proof
 * fingerprint; operational metadata (appliedAt/appliedBy/authoredAgainst*) does
 * not, so it cannot spuriously invalidate a proof.
 */
export interface ProofCardOverride {
  /** Card top-left X, page-relative fraction [0,1]. */
  x: number;
  /** Card top-left Y, page-relative fraction [0,1]. */
  y: number;
  /** Card width, page-relative fraction [0,1]. */
  width: number;
  /** Card height, page-relative fraction [0,1]. */
  height: number;
  /** Card panel opacity, bounded so it is never unreadable nor a face-blocking
   *  opaque slab. */
  opacity: number;
  /** Multiplier applied to the fitted body font size, bounded conservatively. */
  fontScale: number;
  /** Approved semantic text color. Absent renders as the legacy default. */
  textColor?: ProofTextColor;
  /** Proof revision this override was authored against (revision binding). */
  authoredAgainstProofVersion: string;
  /** Source/artwork fingerprint this override was authored against. */
  authoredAgainstFingerprint: string;
  /** ISO timestamp the override was applied. Operational — NOT fingerprinted. */
  appliedAt: string;
  /** Bounded actor identifier for the audit trail. Operational — NOT fingerprinted. */
  appliedBy: string;
}

export interface StoryPage {
  pageNum: number;
  sceneTitle: string;
  story: string;
  imagePrompt: string;
  /** Optional per-page typography override. Legacy records may contain
   *  translucent_dark/soft_scrim, but Release 1 PDFs coerce story prose to
   *  dark text on an approved cream paper band. */
  textLayout?: PageTextLayout;
  /** Optional proof-only positioned text-card override. When present the proof
   *  renderer draws an over-art card instead of the bottom band; the print
   *  renderer ignores it. */
  proofCardOverride?: ProofCardOverride | null;
}

export interface StoryContent {
  title: string;
  dedication?: string;
  characterDescription: string;
  pages: StoryPage[];
}

/**
 * Where a story came from. Persisted on OrderRecord.storyMeta so admin
 * diagnostics can answer "did this order use template or model-generated
 * story?" without log spelunking.
 *
 * - 'openai_chat'     : OpenAI gpt-4o-mini chat-completions story path
 * - 'openai_page_prose': planner + per-page OpenAI prose generation path
 * - 'ollama_page_prose': planner + per-page Ollama prose generation path
 * - 'gemini_page_prose': planner + per-page Gemini prose generation path
 * - 'template'        : deterministic template fallback (no API call)
 * - 'template_after_openai_failure' : OpenAI/Ollama/Gemini was attempted, threw,
 *                                     and the template fallback ran instead.
 *                                     Name retained for legacy/diagnostic
 *                                     continuity — it now covers any LLM
 *                                     story-path failure, not OpenAI alone.
 */
export type StorySource =
  | 'openai_chat'
  | 'openai_page_prose'
  | 'ollama_page_prose'
  | 'gemini_page_prose'
  | 'template'
  | 'template_after_openai_failure';

export interface VoiceTranscriptMeta {
  status: 'not_enabled' | 'transcribed' | 'failed' | string;
  text?: string | null;
  inspiration?: string | null;
  model?: string | null;
  transcribedAt?: string | null;
  error?: string | null;
}

/** Persisted record of how the story for this order was produced. */
export interface StoryMeta {
  source: StorySource;
  /** Provider model identifier when applicable (e.g. 'gpt-4o-mini' or
   *  'template:Adventure'). */
  model: string;
  /** ISO timestamp the story was produced. */
  generatedAt: string;
  /** When source includes a fallback (e.g. template_after_openai_failure),
   *  the original error message that triggered the fallback. Truncated. */
  fallbackError?: string | null;
}
