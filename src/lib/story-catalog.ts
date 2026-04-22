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
  { id: 'mothers-day', label: '💐 Mother\'s Day' },
  { id: 'fathers-day', label: '🛠️ Father\'s Day' },
  { id: 'just-because', label: '❤️ Just Because' },
  { id: 'welcome-baby', label: '🍼 Welcome Baby' },
];

export const STORY_THEMES: StoryTheme[] = [
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
    id: 'mothers-day-memory-book',
    name: 'Mother’s Day Memory Book',
    description: 'A child-and-mom keepsake story built for heartfelt gifting.',
    emoji: '💐',
    href: '/checkout',
    accent: 'from-rose-900 via-pink-700 to-amber-400',
    featuredLabel: 'Mother’s Day',
  },
  {
    id: 'fathers-day-adventure-book',
    name: 'Father’s Day Adventure Book',
    description: 'A kid-plus-dad adventure with room for shared milestones and inside jokes.',
    emoji: '🛠️',
    href: '/checkout',
    accent: 'from-slate-900 via-blue-800 to-amber-500',
    featuredLabel: 'Father’s Day',
  },
];

export const CHECKOUT_SAMPLE_IMAGES = STORY_THEMES
  .map((theme) => theme.sampleImage)
  .filter((image): image is string => Boolean(image))
  .slice(0, 3);
