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

export interface StoryPage {
  pageNum: number;
  sceneTitle: string;
  story: string;
  imagePrompt: string;
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
 * - 'template'        : deterministic template fallback (no API call)
 * - 'template_after_openai_failure' : OpenAI was attempted, threw, and the
 *                                     template fallback ran instead
 */
export type StorySource =
  | 'openai_chat'
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
