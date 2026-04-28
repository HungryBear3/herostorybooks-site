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
