// Deterministic, local pre-purchase "story confidence" preview.
//
// Builds a non-final story-direction card from checkout inputs the customer has
// ALREADY entered — no provider/API call, no persistence. Renders nothing until
// the required fields (child name + theme) are present, and never leaks internal
// labels (theme/SKU ids, voiceSource, artifact ids). The full book is written
// and illustrated only after checkout; the customer reviews a proof first.

import { STORY_THEMES } from './story-catalog.ts';

const STANDARD_LESSONS: Record<string, string> = {
  courage: 'being brave',
  kindness: 'kindness',
  friendship: 'true friendship',
  creativity: 'using imagination',
  perseverance: 'never giving up',
};

const CUSTOM_THEME_IDS = new Set(['custom-voice-story']);

export interface StoryPreviewInput {
  childName?: string | null;
  theme?: string | null;
  lesson?: string | null;
  giftMessage?: string | null;
  /** Typed customization / character notes. */
  characterNotes?: string | null;
  voiceAttached?: boolean;
  voiceTranscribed?: boolean;
  guidedPhotoCount?: number;
  bookFormat?: string | null;
}

export interface StoryPreview {
  title: string;
  hero: string;
  themeName: string;
  beats: string[];
  stylePromise: string[];
  /** Present when voice/audio is attached but not yet transcribed. */
  voiceNote: string | null;
  /** Count-only summary of guided reference photos. */
  guidedNote: string | null;
  /** Echo of the customer's own note/message (their words), bounded. */
  customDetailHint: string | null;
  disclaimer: string;
  isPrint: boolean;
}

function clean(value: unknown, max = 4000): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isPrintFormat(bookFormat: string): boolean {
  return bookFormat === 'classic' || bookFormat === 'premium';
}

/**
 * Returns a preview, or null when required fields (child name + theme) are not
 * yet present — so the card does not render too early and is never blank once
 * they are.
 */
export function buildStoryPreview(input: StoryPreviewInput): StoryPreview | null {
  const hero = clean(input.childName, 60);
  const themeId = clean(input.theme, 60);
  if (!hero || !themeId) return null;

  const theme = STORY_THEMES.find((t) => t.id === themeId);
  const isCustom = CUSTOM_THEME_IDS.has(themeId) || !theme;
  const themeName = theme ? theme.name : 'a one-of-a-kind';

  const lessonRaw = clean(input.lesson, 120);
  const lessonPhrase = lessonRaw
    ? (STANDARD_LESSONS[lessonRaw.toLowerCase()] ?? lessonRaw.toLowerCase())
    : '';

  const note = clean(input.characterNotes, 200) || clean(input.giftMessage, 200);
  const customDetailHint = note ? (note.length > 90 ? `${note.slice(0, 87)}…` : note) : null;
  const hasCustomDetail = Boolean(note) || Boolean(input.voiceAttached);

  const opening = isCustom
    ? `${hero}'s very own adventure begins on an ordinary day.`
    : `${hero}'s ${themeName} adventure begins on an ordinary day.`;

  const beats = [
    opening,
    `A surprise pulls ${hero} into something bigger than expected.`,
    `${hero} meets a challenge that takes a little bravery.`,
    lessonPhrase
      ? `Along the way, ${hero} discovers ${lessonPhrase}.`
      : `Along the way, ${hero} discovers what really matters.`,
    `${hero} heads home changed, with a story to keep forever.`,
  ];

  const isPrint = isPrintFormat(clean(input.bookFormat, 20));

  const stylePromise = [
    'A warm picture-book adventure',
    hasCustomDetail ? 'Personalized with the details you shared' : 'Personalized to your child',
    isPrint ? 'A proof to review before anything prints' : 'A proof to review before we finalize',
  ];

  const voiceNote =
    input.voiceAttached && !input.voiceTranscribed
      ? "We'll use your recording as story direction and inspiration after checkout."
      : null;

  const count = Math.max(0, Math.trunc(input.guidedPhotoCount ?? 0));
  const guidedNote =
    count > 0
      ? `Using ${count} approved reference photo${count === 1 ? '' : 's'} for a consistent look.`
      : null;

  const disclaimer = isPrint
    ? 'This is a preview of the story direction. We write and illustrate the full book after checkout, then you review the proof before anything prints.'
    : 'This is a preview of the story direction. We write and illustrate the full book after checkout, then you review the proof before we finalize.';

  return {
    title: 'Your story will be about…',
    hero,
    themeName,
    beats,
    stylePromise,
    voiceNote,
    guidedNote,
    customDetailHint,
    disclaimer,
    isPrint,
  };
}
