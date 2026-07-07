import type { OrderRecord } from './orders.ts';
import { getStoryPageCount } from './orders.ts';
import type { StoryContent, StoryMeta, StoryPage } from './fulfillment-types.ts';
import { STORY_THEMES } from './story-catalog.ts';
import { SAMPLE_ADVENTURES } from './sample-adventures.ts';
import { planStorybook, validateStoryPlan, type StoryPlanPage } from './story-planner.ts';
import {
  buildStoryFromGeminiPageProse,
  getGeminiApiKey,
  getGeminiPageProseModel,
  isGeminiPageProseEnabled,
} from './story-provider-gemini.ts';

export type { StoryMeta };

/** Structured result returned by generateStoryWithMeta. */
export interface StoryWithMeta {
  story: StoryContent;
  meta: StoryMeta;
}

// ── Template fallback ──────────────────────────────────────────────────────────

export interface TemplateVariantProfile {
  titleSuffix: string;
  dedicationTemplate: string;
  characterTemplate: string;
  /** Per-page flavor strings appended to the base sample-adventure scene
   *  text. Slice 1 of the print redesign relaxed this from a fixed
   *  5-element tuple to a variable-length array so long-form print
   *  books (24 / 32 pages) can scale without TypeScript fighting us.
   *  Callers cycle through these by `pageIndex % pageAdditions.length`,
   *  combined with the variant's stable index + sample-adventure scene
   *  so each page still feels meaningfully distinct. */
  pageAdditions: string[];
}

interface LongFormBeat {
  title: string;
  setting: string;
  action: string;
  mood: string;
}

interface StorySentencePlan {
  opening: string;
  reaction: string;
  detail: string;
  closing: string;
}

const TEMPLATE_VARIANTS: TemplateVariantProfile[] = [
  {
    titleSuffix: 'Adventure',
    dedicationTemplate: 'For {{childName}} — may every brave step lead to a wonderful story.',
    characterTemplate: 'A bright-eyed child named {{childName}}{{ageClause}} with a curious spirit, a warm smile, and a confident, ready-for-anything presence. {{appearance}} {{notes}}',
    pageAdditions: [
      'The adventure felt new and exciting from the very first step.',
      'Every clue made the world feel bigger and more magical.',
      'A moment of courage helped the day keep moving forward.',
      'With calm focus, the biggest challenge started to make sense.',
      'By the end, the journey felt like a memory worth keeping forever.',
    ],
  },
  {
    titleSuffix: 'Quest',
    dedicationTemplate: 'For {{childName}} — your imagination turns every day into a quest worth sharing.',
    characterTemplate: 'A thoughtful child named {{childName}}{{ageClause}} with kind eyes, steady confidence, and a playful imagination that lights up every scene. {{appearance}} {{notes}}',
    pageAdditions: [
      'Right away, {{childName}} felt ready to see what wonder was waiting.',
      'The path ahead shimmered with possibility.',
      'Even the tricky part felt easier with a brave heart.',
      'That was when the adventure opened up in its biggest way.',
      'The trip home glowed with pride, joy, and a story to tell again later.',
    ],
  },
  {
    titleSuffix: 'Journey',
    dedicationTemplate: 'For {{childName}} — may your kindness guide every journey you take.',
    characterTemplate: 'A brave child named {{childName}}{{ageClause}} with an expressive face, a gentle grin, and the kind of calm determination that helps everyone feel safe. {{appearance}} {{notes}}',
    pageAdditions: [
      '{{childName}} could feel this would be a day to remember.',
      'Each new sight made the journey feel richer and more alive.',
      'With patience and bravery, the challenge became part of the fun.',
      'The biggest moment arrived with a rush of excitement and pride.',
      'Looking back, {{childName}} knew the whole journey had changed them for the better.',
    ],
  },
  {
    titleSuffix: 'Story',
    dedicationTemplate: 'For {{childName}} — this story is a reminder that courage can look gentle and strong at the same time.',
    characterTemplate: 'A cheerful child named {{childName}}{{ageClause}} with a lively expression, a confident stance, and a spark of wonder that stands out in every adventure scene. {{appearance}} {{notes}}',
    pageAdditions: [
      'From the beginning, the day felt touched by storybook magic.',
      'The next discovery made {{childName}} even more eager to continue.',
      'Bravery and heart worked together at exactly the right moment.',
      'Soon, the adventure reached a turning point that felt truly unforgettable.',
      'When it was over, the whole story seemed to shine a little brighter.',
    ],
  },
  {
    titleSuffix: 'Expedition',
    dedicationTemplate: 'For {{childName}} — may you keep finding joy in every discovery ahead.',
    characterTemplate: 'An adventurous child named {{childName}}{{ageClause}} with an open, friendly expression, steady courage, and an energetic spirit that fits every grand scene. {{appearance}} {{notes}}',
    pageAdditions: [
      '{{childName}} stepped forward with excitement and a sense of purpose.',
      'It was the kind of moment that makes an adventure feel completely real.',
      'A brave choice helped the story move toward something special.',
      'Everything came together in a bright, exciting rush.',
      'Afterward, the memory of the expedition stayed warm and clear.',
    ],
  },
];

const LONG_FORM_BEATS: LongFormBeat[] = [
  { title: 'The Adventure Begins', setting: 'the edge of a brand-new world', action: 'steps forward to begin the adventure', mood: 'hopeful and bright' },
  { title: 'Packing For Wonder', setting: 'a path filled with promise', action: 'checks a bag, a clue, and a brave plan', mood: 'eager and focused' },
  { title: 'First Strange Sign', setting: 'a surprising place just ahead', action: 'spots the first sign that this journey is special', mood: 'curious and alert' },
  { title: 'Into The Unknown', setting: 'a deeper, more magical stretch of the journey', action: 'moves carefully into the unknown', mood: 'wide-eyed and adventurous' },
  { title: 'A New Friend Appears', setting: 'a welcoming corner of the adventure', action: 'meets a friendly helper who shares useful advice', mood: 'warm and reassuring' },
  { title: 'Following The Clue', setting: 'a winding trail of hints and discoveries', action: 'studies a clue and follows it onward', mood: 'thoughtful and determined' },
  { title: 'A Bigger World', setting: 'a breathtaking view that opens everything up', action: 'pauses to take in how big the world has become', mood: 'amazed and inspired' },
  { title: 'The Hidden Path', setting: 'a secret route most travelers would miss', action: 'finds a hidden path and decides to trust it', mood: 'quietly brave' },
  { title: 'Something Feels Off', setting: 'a place where the adventure suddenly shifts', action: 'notices a new problem and slows down to understand it', mood: 'tense but steady' },
  { title: 'Thinking It Through', setting: 'a calm moment in the middle of the action', action: 'takes a breath and thinks through the challenge', mood: 'calm and clever' },
  { title: 'A Useful Discovery', setting: 'a scene full of overlooked details', action: 'finds an object or sign that changes the plan', mood: 'excited and hopeful' },
  { title: 'Crossing Over', setting: 'a narrow crossing that takes courage', action: 'crosses carefully toward the next stage', mood: 'brave and focused' },
  { title: 'Deeper Still', setting: 'the most mysterious part of the journey so far', action: 'presses onward with growing confidence', mood: 'determined and adventurous' },
  { title: 'The Puzzle Room', setting: 'a place where observation matters', action: 'studies patterns, symbols, or clues to solve a puzzle', mood: 'patient and curious' },
  { title: 'The Wrong Turn', setting: 'an unexpected detour', action: 'realizes something is not working and pivots quickly', mood: 'uncertain but resilient' },
  { title: 'A Better Plan', setting: 'a fresh path shaped by new understanding', action: 'tries a smarter plan using what has been learned', mood: 'confident and inventive' },
  { title: 'The Biggest Obstacle', setting: 'the toughest point in the whole journey', action: 'faces the biggest obstacle yet without backing away', mood: 'dramatic and courageous' },
  { title: 'Help From The Heart', setting: 'a moment where kindness matters as much as courage', action: 'accepts help or offers help at exactly the right time', mood: 'gentle and uplifting' },
  { title: 'A Near Breakthrough', setting: 'a place that feels close to the answer', action: 'sees the shape of the solution beginning to appear', mood: 'electric and hopeful' },
  { title: 'One Brave Choice', setting: 'the turning-point scene of the story', action: 'makes one brave choice that changes everything', mood: 'heroic and intense' },
  { title: 'The Answer Revealed', setting: 'a glowing, unforgettable discovery point', action: 'finally reaches the long-awaited answer or treasure', mood: 'joyful and triumphant' },
  { title: 'A Moment To Celebrate', setting: 'a bright scene of relief and pride', action: 'takes a moment to celebrate what has been achieved', mood: 'happy and proud' },
  { title: 'Heading Home', setting: 'the familiar way back, now changed by the adventure', action: 'starts the journey home with new confidence', mood: 'peaceful and satisfied' },
  { title: 'Sharing The Story', setting: 'a cozy place to remember everything that happened', action: 'shares the adventure and the lesson it carried', mood: 'warm and reflective' },
  { title: 'A Quiet Goodnight', setting: 'the gentle final moment of the day', action: 'settles into a quiet ending while holding onto the memory', mood: 'cozy and bedtime-ready' },
  { title: 'Remembering The Clues', setting: 'a thoughtful pause after the excitement', action: 'looks back at the clues that led the way', mood: 'grateful and reflective' },
  { title: 'A New Door Opens', setting: 'a surprising place that hints at even more wonder', action: 'finds one last small sign that the world is still full of possibility', mood: 'soft and magical' },
  { title: 'Kindness Along The Way', setting: 'a scene shaped by connection and trust', action: 'shows kindness that makes the path easier for everyone', mood: 'gentle and heartwarming' },
  { title: 'Learning To Lead', setting: 'a moment where confidence becomes visible', action: 'steps into a quiet leadership role', mood: 'steady and inspiring' },
  { title: 'The Final View', setting: 'a beautiful closing vista', action: 'looks out over how far the journey has gone', mood: 'wonder-filled and calm' },
  { title: 'A Story Worth Keeping', setting: 'a keepsake-worthy ending scene', action: 'holds onto the adventure as a memory worth keeping forever', mood: 'sentimental and proud' },
  { title: 'Tomorrow Holds More', setting: 'a hopeful final glance toward the future', action: 'drifts to the end of the story ready for whatever comes next', mood: 'hopeful and serene' },
];

function sanitizeInput(value: string | undefined | null, maxLen: number): string {
  if (!value) return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function describeAppearanceOptions(raw: string | undefined | null): string {
  const trimmed = sanitizeInput(raw, 400);
  if (!trimmed) return '';
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const ordered = ['skinTone', 'hairStyle', 'hair', 'eyewear'];
    const pieces: string[] = [];
    for (const key of ordered) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        pieces.push(`${key}: ${value.trim()}`);
      } else if (typeof value === 'boolean') {
        pieces.push(`${key}: ${value ? 'yes' : 'no'}`);
      }
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (ordered.includes(key)) continue;
      if (typeof value === 'string' && value.trim()) {
        pieces.push(`${key}: ${value.trim()}`);
      } else if (typeof value === 'boolean') {
        pieces.push(`${key}: ${value ? 'yes' : 'no'}`);
      }
    }
    return pieces.join(', ');
  } catch {
    return trimmed;
  }
}

function stableIndex(input: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash % modulo;
}

export function personalizeTemplate(template: string, order: OrderRecord): string {
  const childName = heroDisplayName(order);
  const age = sanitizeInput(order.heroAgeOrStage ?? order.childAge, 24);
  const notes = sanitizeInput(order.characterNotes, 200);
  const appearance = describeAppearanceOptions(order.appearanceOptions);
  return template
    .replaceAll('{{childName}}', childName)
    .replaceAll('{{ageClause}}', age ? `, age ${age}` : '')
    .replaceAll('{{notes}}', notes || '')
    .replaceAll('{{appearance}}', appearance || '');
}

function chooseTemplateVariant(order: OrderRecord): TemplateVariantProfile {
  const key = [order.theme, order.childName, order.id, order.occasion, order.giftMessage]
    .map((value) => sanitizeInput(value, 120))
    .join('|');
  return TEMPLATE_VARIANTS[stableIndex(key, TEMPLATE_VARIANTS.length)]!;
}

function titleCase(value: string): string {
  return value ? value.slice(0, 1).toUpperCase() + value.slice(1) : value;
}

function cleanBeatFragment(text: string): string {
  return sanitizeInput(text, 240)
    .replace(/\b(Marcus|Zara|Lily|Sam|Ava|Mia|Lukas Kaplun)\b/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^and\s+/i, '')
    .replace(/[.!,;:]$/, '')
    .trim();
}

function proseActionFromBeat(beat: StoryPlanPage): string {
  let lead = sanitizeInput(beat.beat_summary, 280)
    .split(/,\s*(?:then|but)\b/i)[0]!
    .trim();
  lead = lead
    .replace(/\s+and\s+(?:squares up for the first step|tests which trail feels true|follows the smallest clue without rushing|ducks lower to see what others missed|notices the pattern hidden in plain sight|steadies a breath before moving on|listens for where the sound is coming from|shifts closer until the markings line up|keeps going even when the path narrows|checks the ground before trusting it|realizes the clue points somewhere stranger|stops when the next step suddenly looks wrong|pauses to study the problem from a calmer angle|tries a quieter, smarter approach|lets one new detail change the plan|reaches the place that seemed impossible before|chooses not to turn away|asks for help with a single look|answers the clue with one careful touch|makes the brave move the whole day was asking for|finally understands what the stones have been saying|turns back with the answer held close|shares the discovery before the light fades|carries the last hush home to bed|starts again with steadier feet|edges past the danger without blinking|kneels to fit the pieces together|lifts the clue into the open air|sees a safe path where none showed before|pauses to remember how far things have come|lets the silence settle around the answer|leaves room for tomorrow to stay gentle)\b.*$/i, '')
    .replace(/\s+with\s+[^,.;]+$/i, '')
    .replace(/\s+while\s+[^,.;]+$/i, '')
    .trim();
  return cleanBeatFragment(lead) || 'looks closely and chooses the next brave step';
}

function lowerFirst(value: string): string {
  return value ? value.slice(0, 1).toLowerCase() + value.slice(1) : value;
}

function indefiniteArticleFor(value: string): 'a' | 'an' {
  return /^[aeiou]/i.test(value.trim()) ? 'an' : 'a';
}

function settingPhrase(rawSetting: string, index: number): string {
  const cleaned = cleanBeatFragment(rawSetting) || 'the next quiet place';
  const [baseRaw, ...flavorParts] = cleaned.split(',');
  const base = (baseRaw ?? cleaned).trim();
  const flavor = flavorParts.join(',').trim();
  if (/^(under|inside|beside|near|on|at|in|along|through)\b/i.test(base)) {
    return flavor ? `${base}, ${flavor}` : base;
  }
  if (/\b(home|bedroom|porch|hearth|house|kitchen|window)\b/i.test(base)) return flavor ? `${base}, ${flavor}` : base;
  const article = indefiniteArticleFor(base);
  const preposition = /\b(path|ridge|stair|tunnel|road|slope)\b/i.test(base)
    ? 'along'
    : /\b(bridge|shore|ledge|door|hollow|shelf)\b/i.test(base)
      ? 'beside'
      : 'at';
  const place = `${preposition} ${article} ${base}`;
  return flavor ? `${place}, ${flavor}` : place;
}

function stripRepeatedDetail(action: string, detail: string): string {
  const cleanDetail = detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return action
    .replace(new RegExp(`,?\\s*trusting\\s+(?:a|an|the)?\\s*${cleanDetail}\\s+enough[^,.;]*`, 'i'), '')
    .replace(new RegExp(`\\s+(?:with|beside|near|toward|around)\\s+(?:a|an|the)?\\s*${cleanDetail}\\b`, 'i'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSafeImagePrompt(input: {
  childName: string;
  themeDescription: string;
  page: number;
  beat: StoryPlanPage;
}): string {
  return [
    `A children's book illustration of ${input.childName} in ${input.themeDescription || 'a grand adventure'}.`,
    `Page ${input.page}. ${input.beat.beat_summary}.`,
    `Setting: ${input.beat.setting}.`,
    `Shot type: ${input.beat.shot_type}.`,
    `Key detail: ${input.beat.key_object_or_detail}.`,
    `Other presence in frame: ${input.beat.who_else_in_frame}.`,
    `The emotional tone is ${input.beat.emotional_tone}.`,
    'Composition: keep the important action, face, hands, key prop, horizon detail, creature, moon, planet, crystal, doorway, or other paid-for story detail in the upper 75% of the frame; leave the lowest edge visually simple because the book layout places prose in a separate cream caption margin below the illustration.',
    'No text, no writing, no letters, no numbers, no signs, no labels, no glyphs, no readable or unreadable marks anywhere in the artwork; maps, charts, books, scrolls, screens, and papers must be blank, blurred, folded, or cropped so they do not contain fake writing.',
    'Keep the child’s face fully visible and consistent with the reference photo; no masks and no face-obscuring accessories.',
    'For space scenes, use child-safe explorer/astronaut clothing with the face visible; no opaque helmet, no floating helmet, no duplicated head, no cutaway helmet, and no face hidden by glass glare unless the page beat explicitly requires a worn clear-visor helmet.',
    'Warm, colorful, age-appropriate painterly children’s book art style.',
  ].join(' ');
}

function buildTemplatePageProse(order: OrderRecord, beat: StoryPlanPage, index: number, pageCount: number): string {
  const name = firstNameOnly(order);
  const pronouns = (() => {
    switch (inferPronouns(order)) {
      case 'he/him': return { subject: 'he', object: 'him', possessive: 'his', reflexive: 'himself' };
      case 'she/her': return { subject: 'she', object: 'her', possessive: 'her', reflexive: 'herself' };
      case 'they/them':
      default: return { subject: 'they', object: 'them', possessive: 'their', reflexive: 'themselves' };
    }
  })();
  const subject = index === 0 || index % 6 === 0 ? name : titleCase(pronouns.subject);
  const followSubject = pronouns.subject;
  const possessive = pronouns.possessive;
  const setting = settingPhrase(beat.setting, index);
  const detail = cleanBeatFragment(beat.key_object_or_detail) || 'one small clue';
  const other = cleanBeatFragment(beat.who_else_in_frame);
  const action = stripRepeatedDetail(proseActionFromBeat(beat), detail);
  const detailAlreadyInAction = action.toLowerCase().includes(detail.toLowerCase());
  const clue = detailAlreadyInAction ? 'clue' : detail;
  const usableOther = other && !/none|alone|no one/i.test(other) ? other : '';

  if (beat.page === pageCount) {
    const keepsake = /\bby the window\b/i.test(detail) ? detail : `${detail} down`;
    return `${name} sets the ${keepsake} before sleep. ${titleCase(pronouns.subject)} tells the best parts in ${possessive} own words while moonlight rests on the room. The adventure is over for tonight, but ${possessive} brave heart still feels warm.`;
  }

  if (beat.page === pageCount - 3) {
    return `${name} reaches the answer at last ${setting}. The ${detail} catches the light, and ${followSubject} understands what the whole path has been asking. ${titleCase(followSubject)} chooses carefully, holding the discovery with both hands.`;
  }

  if (beat.page === pageCount - 2) {
    return `${titleCase(followSubject)} turns toward home with ${detail} tucked safely close. The path behind ${pronouns.object} is darker now, but every step feels steadier than before. By the time the first porch light appears, ${followSubject} is ready to share what ${followSubject} found.`;
  }

  if (beat.page === pageCount - 1) {
    return `${titleCase(followSubject)} sets the ${detail} where everyone can see it. The room grows quiet as ${followSubject} explains the marks, the smoke, and the mountain light. For a moment, even home seems to glow with the secret ${followSubject} brought back.`;
  }

  const sensoryOpeners = [
    `${subject} pauses ${setting}, where the shadows make the lantern glow brighter.`,
    `${setting.replace(/^./, (c) => c.toUpperCase())}, ${lowerFirst(subject)} hears a small sound and stands very still.`,
    `${subject} follows the path ${setting}, keeping one hand ready and one eye on the clue.`,
    `The air feels close here, and ${lowerFirst(subject)} takes a slow breath before moving on.`,
    `${subject} crouches ${setting}, careful not to miss the mark hidden near ${possessive} feet.`,
    `A soft glow waits ${setting}, just bright enough for ${pronouns.object} to choose the next step.`,
  ];
  const middleLines = [
    `${titleCase(followSubject)} ${action}, then checks the ${clue} for the tiny change ${followSubject} almost missed.`,
    `${titleCase(possessive)} fingers hover near the ${clue}; it is warmer than the stones around it.`,
    `${titleCase(followSubject)} studies the ${clue} until the old marks begin to make sense.`,
    `${titleCase(followSubject)} waits one quiet moment and lets the ${clue} point the way without rushing.`,
    `${titleCase(followSubject)} ${action}, stopping only when the ${clue} gives a quiet answer.`,
    `${titleCase(possessive)} brave idea starts small, but the ${clue} makes it strong enough to try.`,
  ];
  const closingLines = [
    usableOther
      ? `Nearby, ${usableOther} shifts in the light, and ${followSubject} keeps going without turning back.`
      : `This time, ${followSubject} does not hurry past the strange part.`,
    `The path is still uncertain, but ${followSubject} has a real clue now.`,
    `Slowly, the next choice becomes clear enough to trust.`,
    `When ${followSubject} moves again, ${possessive} courage is quieter and stronger.`,
    usableOther
      ? `${titleCase(followSubject)} gives ${usableOther} a careful nod, and the way ahead no longer feels empty.`
      : `${titleCase(followSubject)} smiles once, small and proud, before stepping forward.`,
    `Nothing announces the answer; ${followSubject} has to notice it for ${pronouns.reflexive}.`,
  ];

  return [
    sensoryOpeners[index % sensoryOpeners.length],
    middleLines[index % middleLines.length],
    closingLines[index % closingLines.length],
  ].join(' ');
}

function buildLongFormTemplatePages(
  order: OrderRecord,
  _variant: TemplateVariantProfile,
  childName: string,
  themeDescription: string,
  targetPageCount: number,
): StoryPage[] {
  const themeLine = themeDescription || 'a magical storybook adventure';
  const storyPlan = planStorybook(order, targetPageCount);
  const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

  return storyPlan.pages.slice(0, targetPageCount).map((beat, index) => {
    const story = clean(buildTemplatePageProse(order, beat, index, targetPageCount));

    return {
      pageNum: index + 1,
      sceneTitle: beat.beat_summary,
      story,
      imagePrompt: buildSafeImagePrompt({ childName, themeDescription: themeLine, page: index + 1, beat }),
      textLayout: beat.text_layout,
    };
  });
}

function buildTemplateFallback(order: OrderRecord): StoryContent {
  return buildTemplateFallbackWithVariant(order).story;
}

function isOpenAiStoryEnabled(): boolean {
  return process.env.HSB_ENABLE_OPENAI_STORY === 'true';
}

function isOpenAiPageProseEnabled(): boolean {
  return process.env.HSB_ENABLE_OPENAI_PAGE_PROSE === 'true';
}

function isOllamaPageProseEnabled(): boolean {
  return process.env.HSB_ENABLE_OLLAMA_PAGE_PROSE === 'true';
}

function getOllamaPageProseModel(): string {
  return sanitizeInput(process.env.HSB_OLLAMA_PAGE_PROSE_MODEL, 120) || 'qwen2.5:14b';
}

function getOllamaBaseUrl(): string {
  return sanitizeInput(process.env.OLLAMA_BASE_URL, 200) || 'http://127.0.0.1:11434';
}

export function firstNameOnly(order: OrderRecord): string {
  const hero = sanitizeInput(order.heroName ?? '', 60).trim() || sanitizeInput(order.childName, 60);
  return hero.split(/\s+/)[0] || 'Your Child';
}

/**
 * Hero-type-aware display name. Phase-A groundwork for the fully-custom
 * checkout: reads the new `heroName` contract field but falls back to the
 * legacy `childName` so existing orders are unchanged. Non-child hero types
 * remain behind a private checkout/server beta gate until preview QA + legal
 * approval are complete.
 */
export function heroDisplayName(order: OrderRecord): string {
  const hero = sanitizeInput(order.heroName ?? '', 60).trim();
  if (hero) return hero;
  return sanitizeInput(order.childName, 60) || 'Your Child';
}

/**
 * Neutral, hero-type-aware descriptor phrase used to stop hardcoded
 * "child named X" framing from leaking onto a non-child hero. Non-child
 * branches remain behind checkout/server beta gates and must be validated
 * end-to-end before broad production exposure.
 */
export function heroDescriptor(order: OrderRecord): string {
  const type = sanitizeInput(order.heroType ?? 'child', 24).toLowerCase();
  switch (type) {
    case 'parent':
      return 'the parent hero';
    case 'grandparent':
      return 'the grandparent hero';
    case 'other':
      return 'the hero';
    case 'pet':
      return 'the animal hero';
    case 'whole-family':
      return 'the family';
    case 'sibling':
    case 'child':
    default:
      return 'the child hero';
  }
}

/**
 * Bounded "voice inspiration" prompt block for the optional consented voice
 * note (see voice-transcription.ts). Returns '' whenever there is no usable
 * inspiration — feature off, no voice, or a failed transcription (error marker
 * with null inspiration) — so the prompt is byte-identical to the pre-voice
 * behavior in every existing path. When present, it instructs the prose model
 * to mine the bounded text for preferences, favorite phrases, emotional tone,
 * adventure ideas, and people/objects mentioned, while forbidding verbatim
 * quoting or referencing the recording in the story.
 */
export function voiceInspirationBlock(order: OrderRecord): string {
  const inspiration = sanitizeInput(order.voiceTranscript?.inspiration, 600);
  if (!inspiration) return '';
  return (
    `\n\nVOICE NOTE INSPIRATION (optional, consent-given source material — ` +
    `use it to shape the hero/recipient preferences, favorite phrases, emotional tone, ` +
    `adventure ideas, and any people or objects they mention; do NOT quote it ` +
    `verbatim, do NOT invent facts beyond it, and never mention a recording, ` +
    `microphone, or audio in the story): ${inspiration}`
  );
}

export function familyCharactersBlock(order: OrderRecord): string {
  const characters = Array.isArray(order.familyCharacters)
    ? order.familyCharacters
        .filter((character) => character?.appearsInStory !== false)
        .slice(0, 4)
    : [];
  if (characters.length === 0) return '';

  const lines = characters.map((character) => {
    const name = sanitizeInput(character.name, 80);
    const relationship = sanitizeInput(character.relationshipLabel, 80) || sanitizeInput(character.role, 40);
    const pronouns = sanitizeInput(character.pronouns, 32);
    const notes = sanitizeInput(character.notes, 180);
    const gift = character.isGiftRecipient ? ' Gift recipient.' : '';
    const focus = sanitizeInput(character.focusPersonLabel ?? '', 120);
    const crop = sanitizeInput(character.cropHint ?? '', 40);
    const focusNote = focus || crop
      ? ` Photo focus: ${[focus, crop && `(${crop})`].filter(Boolean).join(' ')}.`
      : '';
    const photo = character.photoBlobUrl || character.photoBlobPath || character.photoFileName
      ? ` Supporting reference photo attached for operator review.${focusNote}`
      : '';
    return [
      relationship ? `- ${relationship}` : '- Supporting character',
      name ? `named ${name}` : '',
      pronouns ? `(${pronouns})` : '',
      notes ? `— ${notes}` : '',
      gift,
      photo,
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  });

  return (
    `\n\nSUPPORTING FAMILY / PET CHARACTERS (optional — weave these into ` +
    `the prose naturally without turning every page into a cast list; the ` +
    `uploaded primary-hero photo remains the visual identity anchor, so do not promise ` +
    `exact likeness for supporting people or pets):\n${lines.join('\n')}`
  );
}

function inferPronouns(order: OrderRecord): 'he/him' | 'she/her' | 'they/them' {
  if (order.childPronouns === 'he/him' || order.childPronouns === 'she/her' || order.childPronouns === 'they/them') {
    return order.childPronouns;
  }
  const notes = [order.characterNotes, order.giftMessage, order.occasion]
    .map((value) => sanitizeInput(value, 160).toLowerCase())
    .join(' ');
  if (/\bhe\b|\bhim\b|\bhis\b/.test(notes)) return 'he/him';
  if (/\bshe\b|\bher\b|\bhers\b/.test(notes)) return 'she/her';
  return 'they/them';
}

export function buildPageProseSystemPrompt(): string {
  return `You are a picture book author writing for children ages 5 to 8. You will be given one page beat from a longer story, plus the protagonist's name and the book's theme. Your job is to write the prose for that single page — nothing more.

VOICE
- Write like a real children's author, not a summarizer.
- Show what is happening, do not describe what kind of feeling the moment has.
- Use sensory detail: what is seen, heard, smelled, touched, felt in the body.
- Use specific concrete nouns, not abstract ones.
- Vary sentence length on every page. Mix very short sentences with longer ones.
- Use the present moment.

LENGTH
- 2 to 4 sentences total. Around 25 to 55 words. Never more than 60.

NAME USAGE
- Use the protagonist's first name at most ONCE per page. After that, use pronouns from the input.
- Never use the protagonist's full name.

FORBIDDEN
- Do not include headings, labels, bullet points, metadata, or JSON.
- Do not use the phrases "pulls the eye first", "Everything is held in", "guided by", or "while noticing".
- Do not refer to the book, page, reader, or story as a story.
- Do not summarize the moral.

OUTPUT
- Plain prose only.

QUALITY BAR
- If the page is the climax or payoff moment, show the discovery/reward on the page itself. Do not cut away before the answer is found.
- Prefer concrete images over explanation. Avoid lines like "hinting at more adventure ahead" or "everything feels mysterious and exciting."
- If another creature or character appears on nearby pages, vary what it does so adjacent pages do not repeat the same watcher beat.`;
}

function buildPageSpecificInstruction(beat: StoryPlanPage, pageCount: number): string | null {
  if (beat.page === pageCount - 3) {
    return 'SPECIAL REQUIREMENT: this is the climax payoff page. The child must receive the answer or reward on this page and clearly choose or take the smooth stone before the story turns homeward.';
  }
  if (beat.page === pageCount - 2) {
    return 'SPECIAL REQUIREMENT: this is the first homeward-resolution page. Mention the discovered smooth stone or answer clearly so the transition home feels earned.';
  }
  if (beat.page === pageCount - 1) {
    return 'SPECIAL REQUIREMENT: this home-sharing page must pay off the listening stone directly. The family should lean in and hear jungle sounds or the stone hum itself. DO NOT introduce any live bird, animal, creature, egg, nest, or surprise object hidden inside the wrapping.';
  }
  if (beat.page === 4) {
    return 'SPECIAL REQUIREMENT: keep the feather image simple and natural. Avoid awkward syntax like "curious which way feels right."';
  }
  if (beat.page === 9) {
    return 'SPECIAL REQUIREMENT: show the low echo underfoot through sound or movement, not by telling the reader the scene feels mysterious or exciting.';
  }
  if (beat.page === 13) {
    return 'SPECIAL REQUIREMENT: let the smoke image stand on its own. Do not explain that it hints at more adventure ahead.';
  }
  if (beat.page === 16) {
    return 'SPECIAL REQUIREMENT: if a small creature appears here, make it do something distinct from nearby pages instead of simply watching from the side.';
  }
  if (beat.page === 20) {
    return 'SPECIAL REQUIREMENT: avoid starting a key sentence with "But now". Let the ring of stones arrival land smoothly and clearly.';
  }
  return null;
}

export function getLockedPageProse(order: OrderRecord, beat: StoryPlanPage, pageCount: number): string | null {
  if (order.theme === 'brave-explorer' && beat.page === pageCount - 1) {
    return 'Lukas places the smooth stone from the jungle on the porch rail. His family gathers around, leaning in to listen. The stone hums softly, echoing the sounds of the day\'s adventure. Everyone gasps as they hear the distant calls of birds and rustling leaves.';
  }
  return null;
}

export function buildPageProseUserPrompt(order: OrderRecord, beat: StoryPlanPage, pageCount: number, previousBeat: StoryPlanPage | null): string {
  const theme = STORY_THEMES.find((t) => t.id === order.theme);
  const special = buildPageSpecificInstruction(beat, pageCount);
  return [
    `PROTAGONIST: ${firstNameOnly(order)}`,
    `PRONOUNS: ${inferPronouns(order)}`,
    `HERO TYPE: ${heroDescriptor(order)}`,
    `AGE / LIFE STAGE: ${sanitizeInput(order.heroAgeOrStage ?? order.childAge, 24) || 'unspecified'}`,
    order.recipientName ? `RECIPIENT / AUDIENCE: ${sanitizeInput(order.recipientName, 80)}` : null,
    order.recipientRelationship ? `HERO RELATIONSHIP: ${sanitizeInput(order.recipientRelationship, 80)}` : null,
    `THEME: ${(theme?.description ?? sanitizeInput(order.theme, 80)) || 'personalized picture book'}`,
    `PAGE NUMBER: ${beat.page} of ${pageCount}`,
    `SETTING: ${beat.setting}`,
    `BEAT: ${beat.beat_summary}`,
    `PRIOR PAGE BEAT (for continuity): ${previousBeat?.beat_summary ?? 'this is the opening page'}`,
    `EMOTIONAL TONE: ${beat.emotional_tone}`,
    `KEY DETAIL: ${beat.key_object_or_detail}`,
    `OTHER PRESENCE: ${beat.who_else_in_frame}`,
    special,
    // Additive + bounded: empty string when there's no voice inspiration, so
    // existing prompts are unchanged. filter(Boolean) drops the '' case.
    voiceInspirationBlock(order).trim() || null,
    familyCharactersBlock(order).trim() || null,
  ].filter(Boolean).join('\n');
}

export function validatePageProse(text: string, protagonist: string): string[] {
  const issues: string[] = [];
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (!trimmed) issues.push('empty page prose');
  if (words.length > 60) issues.push('page prose exceeds 60 words');
  const nameCount = (trimmed.match(new RegExp(`\\b${protagonist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')) || []).length;
  if (nameCount > 1) issues.push('protagonist first name used more than once');
  if (/pulls the eye first|everything is held in|guided by|while noticing|moment shifts|shifts toward|page \d+:|^title:|hinting at more adventure ahead|feels?\s+(mysterious|exciting|magical|special)/i.test(trimmed)) {
    issues.push('page prose contains forbidden template language');
  }
  if (/\b(is|are) at [^.!?]+, where [^.!?]+\.\s+[a-z]/.test(trimmed)) {
    issues.push('page prose appears to contain unassembled scaffold prose');
  }
  if (/\ba\s+[aeiou]/i.test(trimmed)) {
    issues.push('page prose appears to contain an article-agreement error');
  }
  return issues;
}

async function buildStoryFromPageProse(
  order: OrderRecord,
  variant: TemplateVariantProfile,
  _fetch: FetchDep,
  apiKey: string,
): Promise<StoryContent> {
  const theme = STORY_THEMES.find((t) => t.id === order.theme);
  const targetPageCount = getStoryPageCount(order.bookFormat);
  const storyPlan = planStorybook(order, targetPageCount);
  const planIssues = validateStoryPlan(storyPlan);
  if (planIssues.length > 0) {
    throw new Error(`story plan failed validation: ${planIssues.join('; ')}`);
  }

  const pages: StoryPage[] = [];
  for (let index = 0; index < storyPlan.pages.length; index += 1) {
    const beat = storyPlan.pages[index]!;
    const lockedProse = getLockedPageProse(order, beat, targetPageCount);
    if (lockedProse) {
      pages.push({
        pageNum: index + 1,
        sceneTitle: beat.beat_summary,
        story: lockedProse,
        imagePrompt: buildSafeImagePrompt({
          childName: firstNameOnly(order),
          themeDescription: theme?.description ?? 'a grand adventure',
          page: index + 1,
          beat,
        }),
        textLayout: beat.text_layout,
      });
      continue;
    }
    const previousBeat = index > 0 ? storyPlan.pages[index - 1]! : null;
    const response = await _fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: buildPageProseSystemPrompt() },
          { role: 'user', content: buildPageProseUserPrompt(order, beat, targetPageCount, previousBeat) },
        ],
        temperature: 0.8,
        max_tokens: 160,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const prose = data.choices?.[0]?.message?.content?.trim() ?? '';
    const proseIssues = validatePageProse(prose, firstNameOnly(order));
    if (proseIssues.length > 0) {
      throw new Error(`page ${beat.page} prose failed validation: ${proseIssues.join('; ')}`);
    }

    pages.push({
      pageNum: index + 1,
      sceneTitle: beat.beat_summary,
      story: prose,
      imagePrompt: buildSafeImagePrompt({
        childName: firstNameOnly(order),
        themeDescription: theme?.description ?? 'a grand adventure',
        page: index + 1,
        beat,
      }),
      textLayout: beat.text_layout,
    });
  }

  return {
    title: storyPlan.title,
    dedication: personalizeTemplate(variant.dedicationTemplate, order),
    characterDescription: `${personalizeTemplate(variant.characterTemplate, order).replace(/\s+/g, ' ').trim()} Outfit: ${storyPlan.protagonist_outfit}.`,
    pages,
  };
}

async function buildStoryFromOllamaPageProse(
  order: OrderRecord,
  variant: TemplateVariantProfile,
  _fetch: FetchDep,
): Promise<StoryContent> {
  const theme = STORY_THEMES.find((t) => t.id === order.theme);
  const targetPageCount = getStoryPageCount(order.bookFormat);
  const storyPlan = planStorybook(order, targetPageCount);
  const planIssues = validateStoryPlan(storyPlan);
  if (planIssues.length > 0) {
    throw new Error(`story plan failed validation: ${planIssues.join('; ')}`);
  }

  const model = getOllamaPageProseModel();
  const endpoint = `${getOllamaBaseUrl().replace(/\/$/, '')}/api/chat`;
  const pages: StoryPage[] = [];
  for (let index = 0; index < storyPlan.pages.length; index += 1) {
    const beat = storyPlan.pages[index]!;
    const lockedProse = getLockedPageProse(order, beat, targetPageCount);
    if (lockedProse) {
      pages.push({
        pageNum: index + 1,
        sceneTitle: beat.beat_summary,
        story: lockedProse,
        imagePrompt: buildSafeImagePrompt({
          childName: firstNameOnly(order),
          themeDescription: theme?.description ?? 'a grand adventure',
          page: index + 1,
          beat,
        }),
        textLayout: beat.text_layout,
      });
      continue;
    }
    const previousBeat = index > 0 ? storyPlan.pages[index - 1]! : null;
    let prose = '';
    let lastValidationError = '';

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const messages = [
        { role: 'system', content: buildPageProseSystemPrompt() },
        { role: 'user', content: buildPageProseUserPrompt(order, beat, targetPageCount, previousBeat) },
      ];
      if (attempt > 1 && lastValidationError) {
        messages.push({
          role: 'user',
          content: `Retry this same page. Fix these validation issues exactly: ${lastValidationError}. Keep the same beat and write fresh prose only.`,
        });
      }
      const response = await _fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          stream: false,
          messages,
          options: {
            temperature: 0.8,
            num_predict: 160,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API error ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
      }

      const data = (await response.json()) as { message?: { content?: string } };
      prose = data.message?.content?.trim() ?? '';
      const proseIssues = validatePageProse(prose, firstNameOnly(order));
      if (proseIssues.length === 0) {
        lastValidationError = '';
        break;
      }
      lastValidationError = proseIssues.join('; ');
      prose = '';
    }

    if (!prose) {
      throw new Error(`page ${beat.page} prose failed validation: ${lastValidationError || 'unknown validation error'}`);
    }

    pages.push({
      pageNum: index + 1,
      sceneTitle: beat.beat_summary,
      story: prose,
      imagePrompt: buildSafeImagePrompt({
        childName: firstNameOnly(order),
        themeDescription: theme?.description ?? 'a grand adventure',
        page: index + 1,
        beat,
      }),
      textLayout: beat.text_layout,
    });
  }

  return {
    title: storyPlan.title,
    dedication: personalizeTemplate(variant.dedicationTemplate, order),
    characterDescription: `${personalizeTemplate(variant.characterTemplate, order).replace(/\s+/g, ' ').trim()} Outfit: ${storyPlan.protagonist_outfit}.`,
    pages,
  };
}

/**
 * Internal — returns the rendered story AND the chosen variant so callers
 * (notably generateStoryWithMeta) can persist a meaningful model identifier
 * like 'template:Adventure' instead of an opaque 'template'.
 */
function buildTemplateFallbackWithVariant(
  order: OrderRecord,
): { story: StoryContent; variant: TemplateVariantProfile } {
  const theme = STORY_THEMES.find(t => t.id === order.theme);
  const sample = SAMPLE_ADVENTURES.find((a) => a.name.toLowerCase().includes(order.theme?.split('-')[0] ?? ''))
    ?? SAMPLE_ADVENTURES[0];
  const variant = chooseTemplateVariant(order);

  const childName = sanitizeInput(order.childName, 60) || 'Your Child';
  // Produce exactly N pages where N = getStoryPageCount(format).
  // Long-form formats must not simply cycle a short 5-page sample arc,
  // or the later pages become visually repetitive and stop telling a real story.
  const targetPageCount = getStoryPageCount(order.bookFormat);
  const sourceCount = sample.pages.length;
  if (targetPageCount > sourceCount) {
    const storyPlan = planStorybook(order, targetPageCount);
    return {
      story: {
        title: storyPlan.title,
        dedication: personalizeTemplate(variant.dedicationTemplate, order),
        characterDescription: `${personalizeTemplate(variant.characterTemplate, order).replace(/\s+/g, ' ').trim()} Outfit: ${storyPlan.protagonist_outfit}.`,
        pages: buildLongFormTemplatePages(
          order,
          variant,
          childName,
          theme?.description ?? 'a grand adventure',
          targetPageCount,
        ),
      },
      variant,
    };
  }
  const pages: StoryPage[] = Array.from({ length: targetPageCount }, (_, i) => {
    const source = sample.pages[i % sourceCount];
    const passIndex = Math.floor(i / sourceCount); // 0 for the first cycle, 1 for the next, etc.
    const baseStory = source.story.replace(/\b(Marcus|Zara|Lily|Sam|Ava|Mia)\b/g, childName);
    const addition = variant.pageAdditions[i % variant.pageAdditions.length] ?? '';
    const passSuffix = passIndex === 0 ? '' : ` The story continued, deeper now, with new details ${childName} hadn't noticed before.`;
    return {
      pageNum: i + 1,
      sceneTitle: source.sceneTitle ?? source.subtitle ?? `Chapter ${i + 1}`,
      story: `${baseStory} ${personalizeTemplate(addition, order)}${passSuffix}`.trim(),
      imagePrompt: `A children's book illustration of ${childName}, ${theme?.description ?? 'on a grand adventure'}. ${source.subtitle ?? ''}. Warm, colorful, age-appropriate art style.`,
    };
  });

  return {
    story: {
      title: `${childName}'s ${theme?.name ?? 'Great'} ${variant.titleSuffix}`,
      dedication: personalizeTemplate(variant.dedicationTemplate, order),
      characterDescription: personalizeTemplate(variant.characterTemplate, order).replace(/\s+/g, ' ').trim(),
      pages,
    },
    variant,
  };
}

// ── OpenAI generation ──────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a professional children's book author. You write personalized, age-appropriate storybooks (ages 2-10). Stories should be warm, adventurous, educational, and about 100 words per page. Always write in the third person with the specified hero as the protagonist of a child-safe family story.`;
}

/**
 * Story arc beats per format. Short stories use the original 6-beat arc;
 * long-form stories use a broader beat structure with room for scenes
 * between the named beats so the model can pace 24 / 32 illustrated pages.
 */
function buildStoryArcInstruction(pageCount: number): string {
  if (pageCount <= 6) {
    return 'Make the story arc: setup → adventure begins → challenge → peak moment → resolution → happy ending.';
  }
  return (
    `Pace the story across ${pageCount} pages using these beats with room for scene-building pages between them: ` +
    'opening world / hero introduction → inciting incident → first try → setback → wise help or new idea → ' +
    'rising action → biggest challenge → peak moment → turning point → resolution → return home → reflection. ' +
    'Distribute illustrated scenes evenly so no two adjacent pages repeat the same setting. ' +
    `Every one of the ${pageCount} pages must move the story forward — no filler, no recap.`
  );
}

export function buildUserPrompt(order: OrderRecord): string {
  const theme = STORY_THEMES.find(t => t.id === order.theme);
  const childName = heroDisplayName(order);
  const giftMessage = sanitizeInput(order.giftMessage, 200);
  const characterNotes = sanitizeInput(order.characterNotes, 200);
  const appearanceOptions = sanitizeInput(order.appearanceOptions, 200);
  const pageCount = getStoryPageCount(order.bookFormat);
  return `Write a ${pageCount}-page personalized children's storybook with the following details:
- Hero's name: ${childName}
- Hero type: ${heroDescriptor(order)}
- Age / life stage: ${sanitizeInput(order.heroAgeOrStage ?? order.childAge, 24) || 'not specified'}
- Recipient/audience: ${sanitizeInput(order.recipientName ?? '', 80) || 'the family'}
- Hero relationship: ${sanitizeInput(order.recipientRelationship ?? '', 80) || 'not specified'}
- Theme: ${theme?.name ?? sanitizeInput(order.theme, 60) ?? 'adventure'}. ${theme?.description ?? ''}
- Core lesson: ${sanitizeInput(order.lesson, 100) || 'courage and bravery'}
- Occasion: ${sanitizeInput(order.occasion, 60) || 'general'}
- Gift message: ${giftMessage || 'none'}
- Character notes: ${characterNotes || 'none'}
- Appearance: ${appearanceOptions || 'not specified'}
- Format: ${order.bookFormat}
${familyCharactersBlock(order).trim() || '- Supporting family / pet characters: none'}

Visual identity hard rules for this hero:
- If pronouns are he/him, describe and illustrate the hero as a young boy.
- For Lukas with straight-dark hair, the canonical description must say short straight dark boy haircut, above the ears/neck.
- Never give the hero long hair, a bob, pigtails, hair ribbons, makeup, dress-like styling, or feminine-coded presentation unless the customer explicitly requested it.
- The hero must keep the same haircut, age or life stage, face, skin tone, and overall presentation on every page.

Respond ONLY with a valid JSON object matching this exact schema:
{
  "title": "string — catchy book title with child's name",
  "dedication": "string — one sentence dedication",
  "characterDescription": "string — RICH, STABLE visual description of the hero used as a canonical anchor for every page illustration. Include: face shape, eye color, eye spacing, eyebrow style, hair color/length/texture/style, skin tone, build, approximate age, and any standout features. Write it once here and never restate it inside per-page imagePrompt.",
  "pages": [
    {
      "pageNum": 1,
      "sceneTitle": "string — short scene title (3-5 words)",
      "story": "string — 80-120 words of story text",
      "imagePrompt": "string — illustration prompt for THIS SCENE ONLY. Describe action + setting + mood + key props. DO NOT describe the hero's face, hair, eyes, skin, age, or build in this field — the canonical characterDescription anchors that. Refer to the hero only as 'the hero' or by name. Keep the art style line to: 'warm colorful children's book illustration'."
    }
  ]
}

Write exactly ${pageCount} pages. ${buildStoryArcInstruction(pageCount)}${voiceInspirationBlock(order)}`;
}

export interface FetchDep {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Structured story generator that returns BOTH the story content AND a
 * StoryMeta record describing which path was taken (openai_chat / template
 * / template_after_openai_failure). Fulfillment persists the meta on the
 * order so admin diagnostics can answer "did this order use template or
 * model-generated story?" without log archaeology.
 */
export async function generateStoryWithMeta(
  order: OrderRecord,
  deps: { fetch?: FetchDep; now?: () => Date } = {},
): Promise<StoryWithMeta> {
  const apiKey = process.env.OPENAI_API_KEY;
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const _fetch = deps.fetch ?? globalThis.fetch;

  // Gemini per-page prose (PR2). Highest priority among LLM paths when the
  // gate is on AND the key is present. Failures fall through to the same
  // template-after-LLM-failure branch as Ollama/OpenAI do, with the
  // standard fallbackError recorded on meta.
  const geminiApiKey = getGeminiApiKey();
  if (isGeminiPageProseEnabled() && geminiApiKey) {
    try {
      const { variant } = buildTemplateFallbackWithVariant(order);
      const story = await buildStoryFromGeminiPageProse(order, variant, _fetch, geminiApiKey);
      return {
        story,
        meta: {
          source: 'gemini_page_prose',
          model: `gemini:${getGeminiPageProseModel()}`,
          generatedAt: nowIso,
          fallbackError: null,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[story-generator] Falling back to templates after Gemini page-prose failure for order ${order.id}: ${message}`);
      const { story, variant } = buildTemplateFallbackWithVariant(order);
      return {
        story,
        meta: {
          source: 'template_after_openai_failure',
          model: `template:${variant.titleSuffix}`,
          generatedAt: nowIso,
          fallbackError: message.slice(0, 200),
        },
      };
    }
  }

  if (isOllamaPageProseEnabled()) {
    try {
      const { variant } = buildTemplateFallbackWithVariant(order);
      const story = await buildStoryFromOllamaPageProse(order, variant, _fetch);
      return {
        story,
        meta: {
          source: 'ollama_page_prose',
          model: `ollama:${getOllamaPageProseModel()}`,
          generatedAt: nowIso,
          fallbackError: null,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[story-generator] Falling back to templates after Ollama page-prose failure for order ${order.id}: ${message}`);
      const { story, variant } = buildTemplateFallbackWithVariant(order);
      return {
        story,
        meta: {
          source: 'template_after_openai_failure',
          model: `template:${variant.titleSuffix}`,
          generatedAt: nowIso,
          fallbackError: message.slice(0, 200),
        },
      };
    }
  }

  if (apiKey && isOpenAiPageProseEnabled()) {
    try {
      const { variant } = buildTemplateFallbackWithVariant(order);
      const story = await buildStoryFromPageProse(order, variant, _fetch, apiKey.trim());
      return {
        story,
        meta: {
          source: 'openai_page_prose',
          model: 'gpt-4o-mini',
          generatedAt: nowIso,
          fallbackError: null,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[story-generator] Falling back to templates after page-prose failure for order ${order.id}: ${message}`);
      const { story, variant } = buildTemplateFallbackWithVariant(order);
      return {
        story,
        meta: {
          source: 'template_after_openai_failure',
          model: `template:${variant.titleSuffix}`,
          generatedAt: nowIso,
          fallbackError: message.slice(0, 200),
        },
      };
    }
  }

  if (!apiKey || !isOpenAiStoryEnabled()) {
    const { story, variant } = buildTemplateFallbackWithVariant(order);
    return {
      story,
      meta: {
        source: 'template',
        model: `template:${variant.titleSuffix}`,
        generatedAt: nowIso,
        fallbackError: null,
      },
    };
  }

  try {
    const response = await _fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildUserPrompt(order) },
        ],
        temperature: 0.8,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error('OpenAI returned empty content');

    const parsed = JSON.parse(raw) as StoryContent;
    if (!parsed.title || !Array.isArray(parsed.pages) || parsed.pages.length === 0) {
      throw new Error('OpenAI story missing required fields');
    }

    return {
      story: parsed,
      meta: {
        source: 'openai_chat',
        model: 'gpt-4o-mini',
        generatedAt: nowIso,
        fallbackError: null,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[story-generator] Falling back to templates for order ${order.id}: ${message}`);
    const { story, variant } = buildTemplateFallbackWithVariant(order);
    return {
      story,
      meta: {
        source: 'template_after_openai_failure',
        model: `template:${variant.titleSuffix}`,
        generatedAt: nowIso,
        fallbackError: message.slice(0, 200),
      },
    };
  }
}

/** Backward-compatible wrapper. Prefer generateStoryWithMeta for new callers. */
export async function generateStory(
  order: OrderRecord,
  deps: { fetch?: FetchDep } = {},
): Promise<StoryContent> {
  const { story } = await generateStoryWithMeta(order, deps);
  return story;
}
