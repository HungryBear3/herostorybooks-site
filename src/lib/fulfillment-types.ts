export type FulfillmentStatus =
  | 'not_started'
  | 'generating_story'
  | 'generating_images'
  | 'building_pdf'
  /**
   * Customer-facing artifacts have been generated and persisted under a paid
   * order, but are held behind an internal positive-QA gate. The customer proof
   * or digital delivery email must not be sent from the automatic fulfillment
   * path while an order is in this state.
   */
  | 'awaiting_qa'
  /**
   * Generation Operating Policy gate caught a structural blocker that
   * prevents customer release (template story prose, fixture asset on a
   * paid order, missing provider lineage, missing emergency-approval
   * payload for a fal/Seedream paid route, etc.). Distinct from
   * `failed_manual_review` (which covers non-QA generation failures)
   * and from `awaiting_qa` (the normal positive-pass queue). Recovery
   * requires operator intervention: rework the offending artifact OR
   * record an explicit emergency-approval payload.
   */
  | 'qa_blocked'
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
  | 'failed_manual_review'
  /** Operator sent the proof back for regeneration after a QA fail (CD lifecycle). */
  | 'needs_rebuild';

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

export interface StoryPage {
  pageNum: number;
  sceneTitle: string;
  story: string;
  imagePrompt: string;
  /** Optional per-page typography override. Legacy records may contain
   *  translucent_dark/soft_scrim, but Release 1 PDFs coerce story prose to
   *  dark text on an approved cream paper band. */
  textLayout?: PageTextLayout;
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
  | 'template_after_openai_failure'
  /** Generation Operating Policy default: Abby / OpenAI manual subscription
   *  workflow. Operator-authored prose copied in. Distinct from
   *  `openai_chat` which records an automated chat-completions API call. */
  | 'manual';

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
  // ── Generation Operating Policy attempt-level provenance (additive) ────────
  /** Canonical provider name for the policy guard. Mirrors `source` family but
   *  in the policy vocabulary: 'openai_chat'/'openai_page_prose' → 'openai',
   *  'gemini_page_prose' → 'gemini', 'template*' → 'template'. Optional;
   *  derived at manifest build time when absent. */
  storyProvider?: 'openai' | 'gemini' | 'ollama' | 'template' | string | null;
  /** Mirrors `model` to satisfy policy schema; optional alias. */
  storyModel?: string | null;
  /** True iff source === 'template_after_openai_failure'. Cached for
   *  manifest-time checks that don't want to re-parse the source enum. */
  storyFallbackUsed?: boolean | null;
  /** Short, sanitized reason for fallback (e.g. 'fetch failed'). Optional;
   *  may alias `fallbackError`. */
  storyFallbackReason?: string | null;
  /** Operator/system that generated the story attempt: e.g. 'fulfillment',
   *  'manual:abby', 'rex:emergency'. Optional. */
  generatedBy?: string | null;
  /** Identifier for the prompt revision used to generate the story (e.g. a
   *  git SHA or a tracked template version). Optional. */
  promptRevisionId?: string | null;
  /** Outcome of the attempt. 'success' for normal flow; 'fallback' when a
   *  template was substituted; 'rejected' when policy refused the artifact;
   *  'needs_review' when the operator must inspect. Optional. */
  attemptResult?: 'success' | 'fallback' | 'rejected' | 'needs_review' | string | null;
}

/**
 * Persisted result of transcribing an optional, consented child-voice note
 * (the NEXT_PUBLIC_HSB_VOICE_BETA feature). Written once during checkout when
 * HSB_VOICE_TRANSCRIPTION_ENABLED is on; never overwritten.
 *
 * IMPORTANT: the audio is used ONLY for text transcription + story inspiration.
 * It is never used for voice cloning, generated speech, imitation, or published
 * audio. `transcript` is a safely truncated copy of the raw transcript;
 * `inspiration` is a short, bounded summary that is safe to feed into story
 * generation. On failure, `transcript`/`inspiration` are null and `error`
 * carries a truncated diagnostic — transcription failure must never block
 * order creation or payment.
 */
export interface VoiceTranscriptMeta {
  /** Safely truncated raw transcript, or null if transcription failed. */
  transcript: string | null;
  /** Short bounded "voice inspiration" summary fed into story generation,
   *  or null if transcription failed / produced nothing usable. */
  inspiration: string | null;
  /** Transcription model used (e.g. 'gpt-4o-mini-transcribe'). */
  model: string | null;
  /** ISO timestamp the transcription was attempted. */
  transcribedAt: string;
  /** Truncated failure diagnostic when transcription failed; null on success. */
  error: string | null;
}
