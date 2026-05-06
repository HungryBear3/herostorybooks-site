export type FulfillmentStatus =
  | 'not_started'
  | 'generating_story'
  | 'generating_images'
  | 'building_pdf'
  | 'proof_ready'
  | 'proof_approved'
  | 'submitting_to_print'
  | 'complete'
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
 *                 'auto' resolves to a sensible default for the panel style
 *                 (e.g. light text on a dark scrim, dark text on a cream).
 * - panelStyle  : the visual treatment behind the text. 'none' is naked
 *                 text directly on the illustration — only safe when the
 *                 image already has a quiet zone in that area.
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
  /** Optional per-page typography override. When omitted the renderer uses
   *  the legacy bottom_band + translucent_dark default that has been
   *  validated for legibility across every existing book. */
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
 * - 'template'        : deterministic template fallback (no API call)
 * - 'template_after_openai_failure' : OpenAI/Ollama was attempted, threw, and the
 *                                     template fallback ran instead
 */
export type StorySource =
  | 'openai_chat'
  | 'openai_page_prose'
  | 'ollama_page_prose'
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
