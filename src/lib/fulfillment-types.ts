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
  | 'template_after_openai_failure';

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
