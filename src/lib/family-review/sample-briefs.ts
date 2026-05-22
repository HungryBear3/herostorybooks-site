/**
 * Manual sample briefs for the first 3 real /family-review submissions.
 *
 * These are PROMPTS / NOTES for a human operator who will hand-prepare the
 * three sample illustrations for each tester. Nothing in this module calls an
 * image-generation API. Nothing here is wired to fulfillment, Stripe, or Lulu.
 *
 * The intent is to keep the manual prep step legible and consistent so that
 * every tester gets the same three "directions" regardless of which reviewer
 * runs the prep that day.
 */

import type { AgeRange, Direction, Pronoun } from './store';

export interface SampleBrief {
  id: 'cover-hero' | 'dinosaur-adventure' | 'bedtime-keepsake';
  label: string;
  intent: string;
  /** Prompt template — `{child}` / `{age}` / `{pronouns}` are placeholders. */
  promptTemplate: string;
  /** Hard constraints that must hold for every render of this brief. */
  constraints: string[];
  /** Human reviewer checklist before a sample is sent to a parent. */
  reviewChecklist: string[];
}

export const SAMPLE_BRIEFS: readonly SampleBrief[] = [
  {
    id: 'cover-hero',
    label: 'Cover hero portrait',
    intent:
      'Establish the child as the hero of a warm, gentle storybook adventure. Reads as a book cover, not an interior page.',
    promptTemplate:
      'Watercolor storybook cover illustration of {child}, age {age}, as the hero of a warm gentle adventure. Soft cream paper background, hand-painted watercolor edges, warm afternoon light. Centered composition. No text in image, no logos, no captions, no signage of any kind.',
    constraints: [
      'No text anywhere in the image.',
      'First name only — never include surname, school, or family details.',
      'Warm, non-scary mood appropriate for a 2–10 year-old reader.',
      'No realistic photographic likeness — watercolor stylization only.',
    ],
    reviewChecklist: [
      'Recognizable from references: face shape, hair, eyes, and expression family match.',
      'Clearly reads as the selected story direction, not a generic portrait.',
      'Looks gift-worthy as a first impression cover sample.',
      'No text, logos, school markings, or accidental identifying details.',
    ],
  },
  {
    id: 'dinosaur-adventure',
    label: 'Dinosaur adventure page',
    intent:
      'Joyful prehistoric scene. The friendly young T-rex is a companion, never a threat.',
    promptTemplate:
      'Watercolor storybook page of {child}, age {age}, walking through a lush prehistoric valley alongside a friendly young T-rex. Soft ferns, dappled afternoon light, gentle sense of wonder. Watercolor texture and visible paper grain. No text in image, no logos, no signage.',
    constraints: [
      'No text anywhere in the image.',
      'Dinosaur reads as friendly and small-scale — no teeth-bared, no chase.',
      'No realistic gore or peril. Calm, safe pacing.',
      'First name only in the prompt.',
    ],
    reviewChecklist: [
      'Theme is unambiguous and does not drift into another adventure category.',
      'Child likeness remains consistent with the cover sample.',
      'Scene feels safe, joyful, and parent-appropriate.',
      'No text, signage, threat, gore, or scary facial expression.',
    ],
  },
  {
    id: 'bedtime-keepsake',
    label: 'Bedtime keepsake page',
    intent:
      'Quiet pre-sleep moment with a parent or family adult. Reads as a tender keepsake page.',
    promptTemplate:
      'Watercolor storybook page of {child}, age {age}, reading a small book on a bed with a warm parent figure beside them, under the soft glow of a bedside lamp. Quilted blanket, paper grain, gentle storybook lighting. Tender, calm pre-sleep mood. No text in image, no logos, no signage.',
    constraints: [
      'No text anywhere in the image.',
      'Warm and intimate — never melancholic, never lonely.',
      'Parent figure shown from a neutral angle; no identifying real-face likeness.',
      'First name only in the prompt.',
    ],
    reviewChecklist: [
      'Child likeness remains consistent with the other samples.',
      'Mood is warm and keepsake-quality, not sad or lonely.',
      'Adult presence is generic and non-identifying.',
      'No text, logos, or readable book/page content.',
    ],
  },
] as const;

const DIRECTION_MOOD: Record<Direction, string> = {
  dinosaur:
    'a friendly prehistoric dinosaur adventure with soft ferns and safe wonder',
  bedtime:
    'a cozy bedtime wonder story with warm lamplight, stars, and a calm sleepy mood',
  space:
    'a gentle space explorer story with stars, a moonlit sky, and soft cosmic colors',
};

const PRIMARY_DIRECTION_BRIEF: Record<
  Direction,
  Pick<SampleBrief, 'label' | 'intent' | 'promptTemplate' | 'constraints' | 'reviewChecklist'>
> = {
  dinosaur: {
    label: 'Dinosaur adventure page',
    intent:
      'Joyful prehistoric scene. The friendly young T-rex is a companion, never a threat.',
    promptTemplate:
      'Watercolor storybook page of {child}, age {age}, walking through a lush prehistoric valley alongside a friendly young T-rex. Soft ferns, dappled afternoon light, gentle sense of wonder. Watercolor texture and visible paper grain. No text in image, no logos, no signage.',
    constraints: [
      'No text anywhere in the image.',
      'Dinosaur reads as friendly and small-scale — no teeth-bared, no chase.',
      'No realistic gore or peril. Calm, safe pacing.',
      'First name only in the prompt.',
    ],
    reviewChecklist: [
      'Theme is unmistakably dinosaur/prehistory, with friendly child-safe cues.',
      'No space, bedtime, or unrelated adventure elements are sneaking in.',
      'Child likeness matches references and stays consistent with cover sample.',
      'Would feel safe and delightful to a parent reviewing a gift preview.',
    ],
  },
  bedtime: {
    label: 'Bedtime wonder page',
    intent:
      'Cozy bedtime scene with stars, lamplight, and calm wonder. No dinosaurs or space gear.',
    promptTemplate:
      'Watercolor storybook page of {child}, age {age}, in a cozy bedroom at night, discovering a gentle trail of glowing stars and fireflies near the window. Warm bedside lamp, quilted blanket, sleepy wonder, visible paper grain. No dinosaurs, no rockets, no astronaut suit. No text in image, no logos, no signage.',
    constraints: [
      'No text anywhere in the image.',
      'Bedtime mood only — cozy, sleepy, safe, and gentle.',
      'No dinosaurs, prehistoric scenery, rockets, planets, or astronaut gear.',
      'First name only in the prompt.',
    ],
    reviewChecklist: [
      'Theme is unmistakably bedtime/cozy wonder.',
      'No dinosaur, jungle, rocket, or astronaut visual drift.',
      'Child likeness matches references and stays consistent with cover sample.',
      'Scene feels calm, warm, and keepsake-quality.',
    ],
  },
  space: {
    label: 'Space explorer page',
    intent:
      'Gentle child-safe space explorer scene. Reads clearly as space, never as dinosaur/prehistory.',
    promptTemplate:
      'Watercolor storybook page of {child}, age {age}, as a gentle space explorer standing on a soft moonlit hill under a starry sky, with a small friendly robot companion and distant planets. Dreamy cosmic blues, silver stars, visible paper grain, child-safe wonder. No dinosaurs, no prehistoric valley, no jungle ferns. No text in image, no logos, no signage.',
    constraints: [
      'No text anywhere in the image.',
      'Must clearly read as space explorer: stars, planets, moonlight, or gentle astronaut cues.',
      'No dinosaurs, prehistoric scenery, jungle ferns, volcanoes, or T-rex companion.',
      'First name only in the prompt.',
    ],
    reviewChecklist: [
      'Theme is unmistakably space explorer: stars, planets, moon, robot, or soft astronaut cues.',
      'No dinosaur/prehistory drift: no T-rex, jungle ferns, volcanoes, or prehistoric valley.',
      'Child likeness matches references and stays consistent with cover sample.',
      'Scene is gentle and gift-worthy, not sci-fi scary or overly dark.',
    ],
  },
};

export function sampleBriefLabelForDirection(
  briefId: SampleBrief['id'],
  direction: Direction,
): string {
  if (briefId === 'dinosaur-adventure') {
    return PRIMARY_DIRECTION_BRIEF[direction].label;
  }
  return SAMPLE_BRIEFS.find((brief) => brief.id === briefId)?.label ?? briefId;
}

export interface RenderedBrief {
  briefId: SampleBrief['id'];
  label: string;
  intent: string;
  prompt: string;
  constraints: string[];
  reviewChecklist: string[];
}

/**
 * Substitute the parent-supplied fields into each brief template.
 * Does NOT make any network calls.
 */
export function renderBriefsForSubmission(input: {
  childFirstName: string;
  ageRange: AgeRange;
  pronoun: Pronoun | null;
  direction: Direction;
}): RenderedBrief[] {
  const child = input.childFirstName.trim();
  const age = input.ageRange;
  const pronouns =
    input.pronoun && input.pronoun !== 'skip' ? input.pronoun : 'they/them';

  return SAMPLE_BRIEFS.map((brief) => {
    const directionBrief =
      brief.id === 'dinosaur-adventure'
        ? PRIMARY_DIRECTION_BRIEF[input.direction]
        : brief;
    const promptTemplate =
      brief.id === 'cover-hero'
        ? `${brief.promptTemplate} Overall story mood: ${DIRECTION_MOOD[input.direction]}.`
        : directionBrief.promptTemplate;

    return {
      briefId: brief.id,
      label: directionBrief.label,
      intent: directionBrief.intent,
      prompt: promptTemplate
      .replaceAll('{child}', child)
      .replaceAll('{age}', age)
      .replaceAll('{pronouns}', pronouns),
      constraints: [...directionBrief.constraints],
      reviewChecklist: [...directionBrief.reviewChecklist],
    };
  });
}
