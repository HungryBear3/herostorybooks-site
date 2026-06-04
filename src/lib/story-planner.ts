import type { OrderRecord } from './orders.ts';
import type { PageTextLayout, TextZone } from './fulfillment-types.ts';

export type StoryArcPosition = 'opening' | 'entry' | 'rising' | 'middle' | 'climb' | 'resolution';
export type StoryShotType =
  | 'extreme_wide'
  | 'wide'
  | 'medium'
  | 'close_up'
  | 'extreme_close_up'
  | 'over_the_shoulder'
  | 'birds_eye'
  | 'worms_eye'
  | 'two_shot';

export interface StoryPlanPage {
  page: number;
  arc_position: StoryArcPosition;
  beat_summary: string;
  setting: string;
  emotional_tone: string;
  shot_type: StoryShotType;
  key_object_or_detail: string;
  who_else_in_frame: string;
  /** Reusable per-page typography hint. The pdf renderer reads this to
   *  decide where the caption sits on top of the full-page illustration,
   *  and the image-prompt-builder uses it to ask the generator to keep
   *  that zone visually quiet. Always populated by planStorybook so
   *  downstream pipelines can rely on it without fallbacks. */
  text_layout: PageTextLayout;
}

export interface StoryPlan {
  title: string;
  tagline: string;
  protagonist_outfit: string;
  setting_palette: string;
  pages: StoryPlanPage[];
}

interface ThemePlanTemplate {
  titleNoun: string;
  tagline: string;
  protagonist_outfit: string;
  setting_palette: string;
  settings: string[];
  objects: string[];
  presences: string[];
  actionPhrases: string[];
}

const SHOT_SEQUENCE: StoryShotType[] = [
  'extreme_wide', 'close_up', 'medium', 'over_the_shoulder',
  'wide', 'extreme_close_up', 'birds_eye', 'medium',
  'two_shot', 'worms_eye', 'close_up', 'wide',
  'over_the_shoulder', 'extreme_wide', 'close_up', 'medium',
  'birds_eye', 'wide', 'worms_eye', 'two_shot',
  'close_up', 'medium', 'extreme_wide', 'wide',
  'over_the_shoulder', 'extreme_close_up', 'over_the_shoulder', 'birds_eye',
  'birds_eye', 'two_shot', 'worms_eye', 'extreme_wide',
];

const EMOTIONAL_TONES = [
  'anticipation', 'curiosity', 'resolve', 'wonder',
  'playfulness', 'attention', 'surprise', 'focus', 'tenderness',
  'hesitation', 'frustration', 'stillness', 'discovery', 'trust', 'wonder',
  'doubt', 'discovery', 'trust', 'courage', 'hope', 'attention',
  'strain', 'awe', 'determination', 'triumph', 'relief',
  'joy', 'gratitude', 'peace', 'calm', 'wonder',
] as const;

const THEME_TEMPLATES: Record<string, ThemePlanTemplate> = {
  'brave-explorer': {
    titleNoun: 'Listening Stones',
    tagline: 'A hidden path, a brave step, and a jungle that answers back.',
    protagonist_outfit: 'tan explorer shirt with rolled sleeves, khaki shorts, brown hiking boots, wide-brim explorer hat, and a small olive backpack',
    setting_palette: 'Warm jungle greens, damp stone grays, and golden shafts of light. The world should feel lush, humid, and full of quiet discoveries, with changing terrain that grows stranger and more ancient as the child moves deeper in.',
    settings: [
      'jungle trailhead at dawn',
      'fern-lined footpath under tall palms',
      'shallow creek with flat stepping stones',
      'spiral stone beside the muddy trail',
      'frog-hushed hollow beneath giant leaves',
      'vine-covered archway of old roots',
      'sun-dappled bend above a ravine',
      'echoing stone alcove near the cliff wall',
      'root stairway climbing the hillside',
      'mossy overlook above the canopy',
      'reflecting pool with carved edges',
      'narrow ledge beside a broken wall',
      'leaf-curtain passage behind hanging vines',
      'hidden notch in a mossy shrine',
      'jaguar gate set into the hill',
      'groaning rope bridge over dark water',
      'waterfall cave mouth',
      'humming chamber of five small stones',
      'trembling floor beneath the inner vault',
      'sun shaft stair inside the temple',
      'high temple terrace above the canopy',
      'jungle path at dusk',
      'home porch at twilight',
      'bedroom window under moonlight',
    ],
    objects: [
      'creased paper map',
      'parrot feather clue',
      'humming pebble',
      'first listening stone',
      'frog-print marker',
      'vine arch glyph',
      'bronze compass',
      'whispering stone',
      'root step carving',
      'matched trio of listening stones',
      'carved marker',
      'loose ledge stone',
      'leaf-wrapped clue',
      'hidden notch',
      'gate keystone',
      'bridge rope knot',
      'echo drop',
      'ring of small listening stones',
      'glowing listening stone',
      'spiral sun symbol',
      'chorus of listening stones',
      'wrapped smooth stone',
      'listening stone on the porch rail',
      'listening stone on the pillow',
    ],
    presences: ['none', 'a watching parrot', 'a tree frog', 'a monkey on a branch', 'a firefly swarm', 'an old stone jaguar carving'],
    actionPhrases: [
      'laces boots and studies a creased paper map',
      'parts dew-heavy ferns and finds a dropped parrot feather',
      'steps across flat stones and hears a faint hum in the water',
      'kneels beside a listening stone etched with spirals',
      'brushes mud from a second listening stone while a tree frog chirps',
      'follows the humming clue toward a vine-covered arch',
      'holds the bronze compass beside the stone and watches the needle twitch',
      'presses an ear to a warm rock and catches a whispered direction',
      'climbs the root steps as chattering echoes bounce from the ridge',
      'lines up three listening stones until their hum matches',
      'crouches beside the reflecting pool and spots the next carved marker',
      'tests a narrow ledge when the path suddenly breaks away',
      'slips behind a curtain of leaves and finds the safer ledge beyond',
      'lifts a listening stone from moss and finds a hidden notch beneath it',
      'sets the stone into place and opens a concealed gate',
      'crosses the groaning rope bridge while fireflies swirl ahead',
      'ducks through the waterfall cave and listens for the loudest echo',
      'touches five small listening stones in the right order to wake the chamber',
      'steadies the glowing stone as the floor begins to tremble',
      'raises the listening stone into a sun shaft and reveals the final stair',
      'reaches the temple terrace and finally understands what the listening stones have been saying',
      'heads home through the dusk with one smooth stone wrapped in cloth',
      'shows the listening stone on the porch rail while family leans close',
      'rests the listening stone by the window and watches moonlight touch it',
    ],
  },
  'space-voyager': {
    titleNoun: 'Quiet Constellation',
    tagline: 'A child crosses the stars and learns which lights to follow.',
    protagonist_outfit: 'soft navy flight suit with copper seams, moon-gray boots, slim utility belt, and clear-domed helmet carried under one arm or opened so the face stays visible',
    setting_palette: 'Velvet blues, violet nebula clouds, glowing instrument lights, and silver moon dust. The world should move from cozy launch spaces to vast silent views and strange luminous planets.',
    settings: [
      'launch platform under a pink dawn sky',
      'small cockpit lit by blinking panels',
      'ringed planet horizon above the ship',
      'crystal field on a moonlit plain',
      'floating tunnel of meteor ice',
      'alien greenhouse under glass',
      'magnetic bridge over a crater',
      'shadowed observatory dome',
      'quiet home porch under stars',
    ],
    objects: ['star chart', 'glowing control lever', 'moon crystal', 'comet dust trail', 'signal beacon', 'silver seed pod', 'planet ring shard', 'tiny robot lamp', 'constellation key'],
    presences: ['none', 'a drifting robot helper', 'a blinking moon moth', 'a distant alien child', 'a cloud of star fish'],
    actionPhrases: [
      'tightens a glove strap and studies a star chart', 'guides the ship between slow-turning rocks', 'plants boots in silver dust and looks out wide', 'crouches to inspect a glowing crystal seam', 'reaches toward a blinking beacon', 'leans over the bridge rail to judge the distance below', 'cups a floating seed pod before it drifts away', 'angles a lamp toward a dark observatory wall', 'holds a constellation key up to the sky',
    ],
  },
  'ocean-dreams': {
    titleNoun: 'Whispering Pearl',
    tagline: 'Beneath the water, one small clue leads to a shining secret.',
    protagonist_outfit: 'teal swim tunic, shell-fastened belt, coral pink fins, and a small glass bubble hood or ribbon that keeps the face fully visible',
    setting_palette: 'Turquoise water, filtered sunbeams, pearl whites, and coral oranges. The world should feel buoyant, layered, and full of drifting movement, with dark mysterious pockets balanced by bright reef color.',
    settings: ['sunlit tide pool', 'coral garden arch', 'kelp forest path', 'sand hollow near anemones', 'sunken stairway', 'whale-bone gate', 'deep blue trench rim', 'glittering shell cave', 'calm moonlit shoreline'],
    objects: ['striped shell', 'bubble trail', 'silver fish scale', 'pearl lantern', 'sea fan', 'old anchor ring', 'spiral conch', 'sea glass shard', 'rippled sand map'],
    presences: ['none', 'a curious turtle', 'a school of yellow fish', 'a shy seahorse', 'a sleeping octopus'],
    actionPhrases: ['dips a hand into the tide pool', 'threads carefully through coral branches', 'parts a curtain of kelp', 'scoops rippled sand aside with both hands', 'leans close to a pearl lantern', 'follows a bubble trail upward', 'hovers at the trench edge and peers down', 'touches the shell cave wall lightly', 'turns a sea glass shard toward the light'],
  },
  'dinosaur-discovery': {
    titleNoun: 'Footprints at First Light',
    tagline: 'Gigantic tracks, gentle giants, and one child willing to keep going.',
    protagonist_outfit: 'dusty field shirt, knee-length shorts, sturdy boots, canvas hat, and a satchel for notes and fossils',
    setting_palette: 'Golden grass, misty valleys, fern greens, ochre stone, and warm sunrise skies. The world should feel prehistoric but inviting, with giant scale contrasts between child and landscape.',
    settings: ['museum yard at sunrise', 'fern-choked valley path', 'muddy river bend', 'red rock overlook', 'nesting ground near warm stones', 'foggy meadow of giant footprints', 'cliffside fossil shelf', 'echoing canyon pass', 'quiet hill at dusk'],
    objects: ['three-toed footprint', 'fossil tooth', 'feathered fern', 'cracked egg shell', 'amber pebble', 'bone flute reed', 'mud sketchbook', 'tail-swish in tall grass', 'sun-warmed stone'],
    presences: ['none', 'a tiny feathered dinosaur', 'a tall long-neck silhouette', 'two hatchlings', 'a watchful triceratops'],
    actionPhrases: ['brushes dirt from a fossil tooth', 'follows fresh tracks through wet mud', 'plants both hands on a warm stone to climb', 'stops as tall grass begins to sway', 'kneels beside a cracked shell', 'holds a sketchbook against the wind', 'looks up at a giant shadow crossing the ridge', 'offers a fern frond with an open hand', 'stands very still while hatchlings peek close'],
  },
  'dragon-quest': {
    titleNoun: 'Lantern Under the Mountain',
    tagline: 'A dragon’s clue glows brightest when the child dares to follow it.',
    protagonist_outfit: 'forest-green travel coat, leather belt pouch, lace-up boots, wool scarf, and a small lantern clipped at the hip',
    setting_palette: 'Twilight blues, ember golds, mossy stone, and red-orange dragon light. The world should feel old, enchanted, and echoing, with firelight guiding the eye through shadow.',
    settings: [
      'castle courtyard at dusk',
      'pine path beyond the outer wall',
      'stone bridge over a gorge',
      'mossy stair under leaning towers',
      'dragon-carved gate',
      'ember cave tunnel',
      'underground lake shore',
      'crystal-lit cavern bend',
      'warm ledge above a sleeping dragon tail',
      'narrow ridge inside the mountain',
      'rune chamber beneath hanging roots',
      'black stone door with a silver keyhole',
      'ruby-lit hollow near the old nest',
      'windy shelf above the clouds',
      'moonlit chamber of carved dragon faces',
      'last tunnel before the mountain heart',
      'round chamber around a quiet ruby ember',
      'hidden stair rising through smoke',
      'mountain peak under stars',
      'lantern-lit path down the slope',
      'castle courtyard under returning moonlight',
      'home road at dawn',
      'warm hearth at home',
      'bedroom window in soft morning light',
    ],
    objects: [
      'iron lantern',
      'dragon scale',
      'ash feather',
      'rope coil',
      'rune tile',
      'glowing mushroom',
      'silver key',
      'charred footprint',
      'warm dragon scale',
      'lantern shadow',
      'etched stone ring',
      'silver key',
      'ruby ember',
      'scarf knot',
      'carved dragon face',
      'lantern spark',
      'ruby ember',
      'smoke-warmed stair',
      'starlit mountain token',
      'wrapped ruby ember',
      'answering lantern glow',
      'wrapped ruby ember',
      'ruby ember on the hearth',
      'lantern by the window',
    ],
    presences: ['none', 'a fox with bright eyes', 'a sleeping dragon tail', 'an owl overhead', 'a small dragon hatchling'],
    actionPhrases: [
      'lifts a lantern and scans the dark path',
      'turns a dragon scale until it catches blue moonlight',
      'steps across the bridge while wind pulls the scarf',
      'loops a rope around the safest stone post',
      'pushes open a rune-marked gate',
      'waits while a low rumble rolls through the cave',
      'kneels beside a charred footprint at the water edge',
      'holds still as glowing mushrooms brighten the cavern wall',
      'notices the sleeping dragon tail and lowers the lantern',
      'follows a lantern shadow along the narrow ridge',
      'sets the etched stone ring into the floor mark',
      'turns the silver key without making a sound',
      'sets the lantern down beside the ruby ember',
      'ties the scarf tighter before crossing the windy shelf',
      'touches the carved dragon face and listens for the echo',
      'protects the lantern spark from a sudden breath of smoke',
      'holds the ruby ember up and sees the hidden answer inside',
      'climbs the smoke-warmed stair as the mountain settles',
      'chooses one starlit mountain token from the ledge',
      'wraps the ember safely and starts down the slope',
      'returns to the courtyard with the lantern glowing steady',
      'walks home with the ruby ember wrapped in both hands',
      'shows the ruby ember on the hearth while family leans close',
      'sets the lantern by the bedroom window before sleep',
    ],
  },
  'royal-adventure': {
    titleNoun: 'The Secret Balcony',
    tagline: 'Hidden stairways and a brave heart lead to a quiet royal surprise.',
    protagonist_outfit: 'cream tunic with gold trim, soft blue sash, polished boots, and a light crown or jeweled hair ribbon that keeps the face unobstructed',
    setting_palette: 'Ivory stone, velvet blues, rose gardens, candle gold, and moonlit silver. The world should feel elegant yet child-scaled, with secret passages and warm ceremonial spaces.',
    settings: ['palace bedroom at morning light', 'long gallery of portraits', 'echoing marble stair', 'rose garden maze', 'fountain courtyard', 'hidden servants corridor', 'library balcony', 'tower observatory', 'palace terrace at night'],
    objects: ['tiny brass key', 'silk ribbon', 'portrait frame crack', 'rose petal trail', 'silver goblet', 'star chart', 'music box', 'moonlit fountain spray', 'velvet curtain cord'],
    presences: ['none', 'a palace cat', 'a gardener', 'a younger sibling', 'a white dove'],
    actionPhrases: ['ties the sash and checks a tiny brass key', 'pauses in front of a crooked portrait frame', 'slides a hand along the marble banister', 'parts the hedge wall and slips inside', 'balances on the fountain edge to look closer', 'pulls a curtain cord and reveals a narrow door', 'opens a music box and listens hard', 'climbs the tower steps with one hand on the wall', 'leans on the terrace rail beneath the stars'],
  },
};

function sanitizeInput(value: string | undefined | null, maxLen: number): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, maxLen);
}

const SETTING_FLAVORS = [
  'under a pale wash of light',
  'with a small clue waiting just out of sight',
  'where the path bends toward something new',
  'under a quiet sky full of color',
  'beside a shape that looks almost familiar',
  'where the air feels still enough to listen',
  'with soft shadows stretching ahead',
  'where light catches on the smallest details',
  'beside a marker that seems to matter',
  'where the world feels larger than before',
  'with a distant glow pulling the eye forward',
  'beside a textured wall warm with reflected light',
  'under an arch of sheltering shapes',
  'where a faint sound suggests the next direction',
  'with a narrow way opening ahead',
  'beside a basin of reflected light',
  'where the air smells fresh and unfamiliar',
  'under a shaft of pale gold light',
  'with old marks hidden in the scene',
  'where the path opens just long enough to breathe',
  'beside a dark, mirror-like surface',
  'where evening settles gently overhead',
  'with the way home finally visible',
  'under a sky turning soft and silver',
  'beside a doorway warmed by lantern light',
  'where the last bright pieces of the day remain',
  'with distant voices on the breeze',
  'under a calm sweep of stars',
  'beside a familiar step worn smooth',
  'where warm light reaches the threshold',
  'with the adventure quiet at last',
  'under the hush of bedtime',
] as const;

const ACTION_VARIATIONS = [
  'and squares up for the first step',
  'and tests which trail feels true',
  'and follows the smallest clue without rushing',
  'and ducks lower to see what others missed',
  'and notices the pattern hidden in plain sight',
  'and steadies a breath before moving on',
  'and listens for where the sound is coming from',
  'and shifts closer until the markings line up',
  'and keeps going even when the path narrows',
  'and checks the ground before trusting it',
  'and realizes the clue points somewhere stranger',
  'and stops when the next step suddenly looks wrong',
  'and pauses to study the problem from a calmer angle',
  'and tries a quieter, smarter approach',
  'and lets one new detail change the plan',
  'and reaches the place that seemed impossible before',
  'and chooses not to turn away',
  'and asks for help with a single look',
  'and answers the clue with one careful touch',
  'and makes the brave move the whole day was asking for',
  'and finally understands what the stones have been saying',
  'and turns back with the answer held close',
  'and shares the discovery before the light fades',
  'and carries the last hush home to bed',
  'and starts again with steadier feet',
  'and edges past the danger without blinking',
  'and kneels to fit the pieces together',
  'and lifts the clue into the open air',
  'and sees a safe path where none showed before',
  'and pauses to remember how far things have come',
  'and lets the silence settle around the answer',
  'and leaves room for tomorrow to stay gentle',
] as const;

/**
 * Reusable typography rotation. The image generator and the pdf renderer
 * both read this so they stay in sync — wherever the caption is going to
 * land, the illustration is asked to leave a calm, low-detail area in
 * that zone. Rotation is deterministic (page index) so re-running the
 * planner produces the same layout, and prefers `bottom_band` for shot
 * types whose composition tends to push the subject into the upper
 * frame (extreme_wide, birds_eye), `top_band` for low-angle shots
 * (worms_eye, close_up where the subject sits low), and corner zones
 * for medium/two-shot/over-the-shoulder where one corner is usually
 * background sky/ground.
 */
export function defaultTextLayoutForPage(
  pageIndex: number,
  totalPages: number,
  shotType?: StoryShotType,
): PageTextLayout {
  // Final-page bedtime cadence: the last spread is always a quiet
  // bottom_band so the closing line never floats over a face or pillow.
  if (pageIndex === totalPages - 1) {
    return { zone: 'bottom_band', colorMode: 'auto', panelStyle: 'translucent_cream' };
  }

  const shotPreference: Partial<Record<StoryShotType, TextZone>> = {
    extreme_wide: 'bottom_band',
    wide: 'bottom_band',
    birds_eye: 'bottom_band',
    worms_eye: 'top_band',
    close_up: 'top_band',
    extreme_close_up: 'top_band',
    medium: 'bottom_left',
    over_the_shoulder: 'bottom_right',
    two_shot: 'bottom_band',
  };

  const rotation: TextZone[] = [
    'bottom_band', 'bottom_left', 'top_band', 'bottom_right',
    'bottom_band', 'top_left', 'bottom_band', 'bottom_left',
  ];

  const zone =
    (shotType ? shotPreference[shotType] : undefined)
    ?? rotation[pageIndex % rotation.length]!;

  // Product lock: story text must render as dark text on an opaque cream
  // paper band/margin. Never emit legacy translucent dark metadata.
  return { zone, colorMode: 'auto', panelStyle: 'translucent_cream' };
}

function buildArcPositions(pageCount: number): StoryArcPosition[] {
  if (pageCount === 24) {
    return [
      'opening', 'opening', 'opening',
      'entry', 'entry', 'entry', 'entry',
      'rising', 'rising', 'rising', 'rising', 'rising', 'rising',
      'middle', 'middle', 'middle', 'middle', 'middle',
      'climb', 'climb', 'climb',
      'resolution', 'resolution', 'resolution',
    ];
  }

  return [
    'opening', 'opening', 'opening', 'opening',
    'entry', 'entry', 'entry', 'entry', 'entry',
    'rising', 'rising', 'rising', 'rising', 'rising', 'rising',
    'middle', 'middle', 'middle', 'middle', 'middle', 'middle', 'middle',
    'climb', 'climb', 'climb', 'climb', 'climb',
    'resolution', 'resolution', 'resolution', 'resolution', 'resolution',
  ];
}

function firstName(order: OrderRecord): string {
  return sanitizeInput(order.childName, 80).split(/\s+/)[0] || 'Your Child';
}

function pickThemeTemplate(order: OrderRecord): ThemePlanTemplate {
  if (order.theme === 'mothers-day-memory-book') return THEME_TEMPLATES['royal-adventure'];
  if (order.theme === 'fathers-day-adventure-book') return THEME_TEMPLATES['brave-explorer'];
  return THEME_TEMPLATES[order.theme ?? ''] ?? THEME_TEMPLATES['brave-explorer'];
}

function titleFor(order: OrderRecord, template: ThemePlanTemplate): string {
  const name = firstName(order);
  const noun = /^(the|a|an)\b/i.test(template.titleNoun) ? template.titleNoun : `the ${template.titleNoun}`;
  return `${name} and ${noun}`;
}

function uniqueSetting(baseSetting: string, index: number): string {
  const flavor = SETTING_FLAVORS[index] ?? SETTING_FLAVORS[index % SETTING_FLAVORS.length]!;
  return `${baseSetting}, ${flavor}`;
}

function actionLeadFromBeat(beat: string): string {
  return beat.split(',')[0]!.trim().toLowerCase();
}

function buildBeatSummary(page: number, pageCount: number, action: string, keyObject: string, whoElse: string, arc: StoryArcPosition): string {
  const presenceTag = whoElse !== 'none' ? ` while ${whoElse} stays nearby` : '';
  const variation = ACTION_VARIATIONS[page - 1] ?? ACTION_VARIATIONS[(page - 1) % ACTION_VARIATIONS.length]!;
  const lastThreeStart = pageCount - 2;

  if (page === pageCount - 3) {
    return `${action}, then finally hears the answer waiting at the end of the climb and chooses ${keyObject} as the discovery to carry home${presenceTag}.`;
  }
  if (page === lastThreeStart) {
    return `${action}, then turns toward home with ${keyObject} wrapped safely in both hands${presenceTag}.`;
  }
  if (page === lastThreeStart + 1) {
    return `${action}, then shows what was found and lets everyone see why ${keyObject} mattered${presenceTag}.`;
  }
  if (page === pageCount) {
    return `${action}, then settles into a quiet goodnight while keeping ${keyObject} close${presenceTag}.`;
  }
  if (arc === 'middle') {
    return `${action}, but ${keyObject} makes the next choice harder than before${presenceTag}.`;
  }
  if (arc === 'climb') {
    return `${action}, trusting ${keyObject} enough to make the boldest move yet${presenceTag}.`;
  }

  return `${action} ${variation} with ${keyObject}${presenceTag}.`;
}

export function planStorybook(order: OrderRecord, pageCount = 24): StoryPlan {
  const template = pickThemeTemplate(order);
  const featuredPresencePages = new Set([5, 6, 9, 14, 16, 18, 21, 26, 29]);
  const arcPositions = buildArcPositions(pageCount);

  const pages: StoryPlanPage[] = Array.from({ length: pageCount }, (_, index) => {
    const page = index + 1;
    const baseSetting = template.settings[index % template.settings.length]!;
    const setting = uniqueSetting(baseSetting, index);
    const keyObject = template.objects[index % template.objects.length]!;
    const whoElse = featuredPresencePages.has(page)
      ? template.presences[(index + 1) % template.presences.length] ?? 'none'
      : 'none';
    const action = template.actionPhrases[index % template.actionPhrases.length]!;
    const arc = arcPositions[index]!;
    const shotType = SHOT_SEQUENCE[index]!;
    return {
      page,
      arc_position: arc,
      beat_summary: buildBeatSummary(page, pageCount, action, keyObject, whoElse, arc),
      setting,
      emotional_tone: EMOTIONAL_TONES[index]!,
      shot_type: shotType,
      key_object_or_detail: keyObject,
      who_else_in_frame: whoElse,
      text_layout: defaultTextLayoutForPage(index, pageCount, shotType),
    };
  });

  return {
    title: titleFor(order, template),
    tagline: template.tagline,
    protagonist_outfit: template.protagonist_outfit,
    setting_palette: template.setting_palette,
    pages,
  };
}

export function validateStoryPlan(plan: StoryPlan): string[] {
  const issues: string[] = [];
  if (![24, 32].includes(plan.pages.length)) issues.push('plan must contain exactly 24 or 32 pages');

  const settings = new Set(plan.pages.map((p) => p.setting));
  const beats = new Set(plan.pages.map((p) => p.beat_summary));
  const actionLeads = new Set(plan.pages.map((p) => actionLeadFromBeat(p.beat_summary)));
  const tones = new Set(plan.pages.map((p) => p.emotional_tone));
  const shotCounts = new Map<string, number>();

  for (const page of plan.pages) {
    shotCounts.set(page.shot_type, (shotCounts.get(page.shot_type) ?? 0) + 1);
    const lowered = page.beat_summary.toLowerCase();
    if (lowered.includes('while noticing ') || lowered.includes('the child at ')) {
      issues.push(`page ${page.page} beat_summary leaks template wiring`);
    }
    if (lowered.includes('continues the adventure') || lowered.includes('moves through') || lowered.includes('magical place')) {
      issues.push(`page ${page.page} beat_summary is generic`);
    }
  }

  if (settings.size !== plan.pages.length) issues.push('every setting must be unique');
  if (beats.size !== plan.pages.length) issues.push('every beat_summary must be unique');
  if (plan.pages.length === 24 && actionLeads.size < 8) issues.push('24-page plan needs at least 8 distinct action leads');
  if (tones.size < 4) issues.push('plan must use at least 4 unique emotional tones');
  if (!plan.pages.some((p) => ['middle', 'climb'].includes(p.arc_position) && ['doubt', 'frustration', 'hesitation', 'strain'].includes(p.emotional_tone))) {
    issues.push('plan needs a setback/doubt beat in middle or climb');
  }
  if ([...shotCounts.values()].some((count) => count > 4)) {
    issues.push('no shot_type may appear more than 4 times');
  }
  if (plan.pages.filter((p) => p.who_else_in_frame !== 'none').length < 3) {
    issues.push('plan needs at least 3 pages with another presence in frame');
  }
  const resolutionTail = plan.pages.length === 24 ? plan.pages.slice(-3) : plan.pages.slice(-5);
  if (!resolutionTail.every((p) => p.arc_position === 'resolution')) {
    issues.push(plan.pages.length === 24 ? 'final three pages must all be resolution beats' : 'final five pages must all be resolution beats');
  }

  return issues;
}
