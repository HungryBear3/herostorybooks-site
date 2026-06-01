export interface StoryTheme {
  id: string;
  name: string;
  description: string;
  emoji: string;
  href: string;
  coverImage?: string;
  sampleImage?: string;
  accent: string;
  featuredLabel?: string;
}

export interface StoryOccasion {
  id: string;
  label: string;
}

export const STORY_OCCASIONS: StoryOccasion[] = [
  { id: 'birthday', label: '🎂 Birthday' },
  { id: 'holiday', label: '🎁 Holiday Gift' },
  { id: 'just-because', label: '❤️ Just Because' },
  { id: 'welcome-baby', label: '🍼 Welcome Baby' },
];

export const STORY_THEMES: StoryTheme[] = [
  {
    id: 'custom-voice-story',
    name: 'Custom Story',
    description: 'Built from your voice note, family details, and story ideas',
    emoji: '🎙️',
    href: '/checkout',
    coverImage: '/assets/lukas-watercolor-adventure-page.jpg',
    accent: 'from-amber-900 via-rose-700 to-yellow-500',
  },
  {
    id: 'brave-explorer',
    name: 'Brave Explorer',
    description: 'Jungle adventure & discovery',
    emoji: '🗺️',
    href: '/samples',
    coverImage: '/assets/brave-explorer.png',
    sampleImage: '/assets/explorer-sample.png',
    accent: 'from-emerald-900 via-green-700 to-lime-500',
  },
  {
    id: 'space-voyager',
    name: 'Space Voyager',
    description: 'Astronauts, starlight, and alien planets',
    emoji: '🚀',
    href: '/samples',
    coverImage: '/assets/space-voyager.png',
    sampleImage: '/assets/space-sample.png',
    accent: 'from-indigo-950 via-violet-700 to-sky-500',
  },
  {
    id: 'ocean-dreams',
    name: 'Ocean Dreams',
    description: 'Underwater kingdoms & treasure',
    emoji: '🐠',
    href: '/samples',
    coverImage: '/assets/ocean-dreams.png',
    sampleImage: '/assets/ocean-sample.png',
    accent: 'from-cyan-900 via-sky-700 to-teal-500',
  },
  {
    id: 'dinosaur-discovery',
    name: 'Dinosaur Discovery',
    description: 'Prehistoric wonder and giant new friends',
    emoji: '🦕',
    href: '/samples',
    coverImage: '/assets/dinosaur-discovery.png',
    sampleImage: '/assets/dino-sample.png',
    accent: 'from-lime-900 via-green-700 to-amber-500',
  },
  {
    id: 'dragon-quest',
    name: 'Dragon Quest',
    description: 'A magical dragon adventure full of courage, glowing skies, and castle-side wonder.',
    emoji: '🐉',
    href: '/samples',
    coverImage: '/assets/dragon-quest-gpt.png',
    accent: 'from-red-900 via-orange-700 to-amber-500',
  },
  {
    id: 'royal-adventure',
    name: 'Royal Adventure',
    description: 'A royal fairytale filled with sparkling halls, brave choices, and storybook celebration.',
    emoji: '👑',
    href: '/samples',
    coverImage: '/assets/royal-regen-candidates-v7/cover-v7.png',
    accent: 'from-purple-900 via-indigo-700 to-amber-500',
  },
  {
    id: 'fathers-day-adventure-book',
    name: 'Father’s Day Adventure Book',
    description: 'A fun story starring your child, inspired by the adventures and memories they share with Dad.',
    emoji: '🛠️',
    href: '/checkout',
    coverImage: '/assets/fathers-day-adventure-book.png',
    accent: 'from-slate-900 via-blue-800 to-amber-500',
    featuredLabel: 'Father’s Day',
  },
];

const FEATURED_THEME_ORDER = [
  'brave-explorer',
  'space-voyager',
  'ocean-dreams',
  'dinosaur-discovery',
  'dragon-quest',
  'royal-adventure',
] as const;

export const FEATURED_STORY_THEMES: StoryTheme[] = FEATURED_THEME_ORDER
  .map((id) => STORY_THEMES.find((theme) => theme.id === id))
  .filter((theme): theme is StoryTheme => Boolean(theme));

export const CHECKOUT_SAMPLE_IMAGES = [
  '/assets/lukas-sample-forest-portrait.jpg',
  '/assets/lukas-sample-dino-walk.jpg',
  '/assets/lukas-sample-space-portrait.jpg',
];
