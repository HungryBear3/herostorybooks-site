/**
 * Taco Gate regression fixture — the sanitized concierge sample brief.
 *
 * Source: `rex/ops/hsb-tacogate-concierge-sample-packet-20260708.md` §2 (the
 * SANITIZED brief) and §3 (the manual proof story-plan target). This fixture is
 * built from the SANITIZED brief, never the raw transcript — that is the point
 * of the sanitization boundary (gatekeeper review P1).
 *
 * Shape: dual-parent + memory + child-audience (the Taco Gate shape).
 *
 * This file lives under tests/fixtures/ and is imported by the *.test.ts specs;
 * the test runner glob (`tests/*.test.ts`) does not execute it directly.
 */

import type { CustomStoryBeat, CustomStoryBrief } from '../../src/lib/custom-story/types.ts';

export const TACO_GATE_BRIEF: CustomStoryBrief = {
  workingTitle: 'Taco Gate at the Floating Taco Bar',
  storyShape: {
    heroStructure: 'dual-parent',
    storySource: 'memory',
    childRole: 'audience',
  },
  primaryHeroes: [
    {
      name: 'Dad',
      role: 'primary_hero',
      ageStage: 'adult parent',
      traits: ['joyful', 'excited', 'birthday adventurer', 'loves the floating taco bar idea'],
    },
    {
      name: 'Mom',
      role: 'primary_hero',
      ageStage: 'adult parent',
      traits: ['loyal', 'funny', 'protective of family joy', 'steady when plans get chaotic'],
    },
  ],
  recipientAudience: {
    name: 'Lukas',
    role: 'audience',
    ageStage: 'child',
    rules: [
      'may react, listen, laugh, or appear in framing scenes',
      'must not become the plot-driver or rescuer',
    ],
  },
  setting:
    'A warm U.S. Virgin Islands family vacation with a charter boat ride to a floating taco bar in the ocean.',
  coreMemory:
    "Dad's birthday adventure to a floating taco bar. Travel logistics get messy, but Mom protects the birthday joy and the family chooses ocean, tacos, laughter, and togetherness.",
  mustInclude: [
    { anchor: 'floating taco bar', aliases: ['taco boat', 'tacos on the water', 'floating lunch spot', 'ocean taco stop'] },
    { anchor: 'charter boat ride', aliases: ['boat ride', 'ride from the harbor', 'crossing the blue water'] },
    { anchor: "Dad's birthday excitement", aliases: ["Dad's special day", 'birthday adventure', 'birthday tacos'] },
    { anchor: 'Mom protects the joy', aliases: ['Mom keeps the day bright', 'Mom helps everyone choose fun', 'Mom stands up for the birthday moment'] },
    { anchor: 'family chooses joy', aliases: ['laughing together', 'turning chaos into adventure', 'choosing the sunny part of the day'] },
  ],
  mustAvoid: [
    'divorce or separation',
    'illness or medical detail',
    'apology fight',
    'blame language',
    'adult relationship conflict',
    'real names outside the cast',
    'real business/brand names',
    'verbatim memo quotes',
    'embarrassing or mean framing',
    'alcohol/substances',
    'money/financial stress',
    'legal/custody matters',
    'body commentary',
    'child discipline',
  ],
  tone: ['warm', 'funny', 'ocean-bright', 'bedtime-safe', 'family keepsake'],
  lesson:
    'Special days can stay joyful even when plans get messy; family teamwork, humor, and kind boundaries protect the moments we care about.',
  kidSafeBoundaryLine:
    "If the tacos aren't your favorite, that's okay — we're still going to enjoy Dad's birthday.",
  sanitizedSourceSummary:
    "Dad's island birthday trip to a floating taco bar; travel got messy; Mom kept the day bright; the family chose tacos, ocean, and laughter together.",
  castLock: ['Dad', 'Mom', 'Lukas'],
  provenance: {
    source: 'voice-memo',
    voiceMemoDerived: true,
    transcriptSanitized: true,
    briefApprovedByOperator: true,
    sourceTranscriptAvailableToProofLane: true,
  },
};

/** The §3 manual proof story-plan target, normalized to CustomStoryBeat[]. */
export const TACO_GATE_PLAN_LINES: string[] = [
  'Lukas hears that Mom and Dad have a birthday story from a sunny island trip.',
  'Dad dreams of birthday tacos on the water.',
  'Mom packs sunshine, towels, and a plan to keep the day bright.',
  'The harbor morning gets busy and a little tangled.',
  'Mom and Dad breathe, smile, and choose adventure.',
  'The charter boat pulls away from the harbor.',
  'Blue water sparkles around the boat.',
  'Dad watches for the floating taco bar like a treasure island.',
  'Mom spots bright colors bobbing on the waves.',
  'The floating taco bar appears.',
  "Dad's birthday grin gets bigger.",
  'Tacos arrive across the water.',
  'A grumpy moment tries to drift into the day.',
  'Mom gently protects the birthday joy with the kid-safe boundary line.',
  'The grumpy cloud floats away.',
  'Mom and Dad choose laughter, ocean, and tacos.',
  'Lukas imagines the waves clapping for Dad birthday.',
  'The family makes the taco bar feel like a tiny island party.',
  'Dad says this was exactly the birthday adventure he hoped for.',
  'Mom says some days need someone brave enough to keep the joy.',
  'The boat carries everyone back under a golden sky.',
  'Lukas asks if birthdays can always have a little magic.',
  'Mom and Dad say the magic is remembering what matters.',
  'The family remembers Taco Gate as the day joy won on the water.',
];

export function tacoGatePlanBeats(): CustomStoryBeat[] {
  return TACO_GATE_PLAN_LINES.map((text, index) => ({ index, text }));
}
