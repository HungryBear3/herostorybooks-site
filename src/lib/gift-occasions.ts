export type GiftOccasionId =
  | 'birthdays'
  | 'grandparents'
  | 'siblings'
  | 'pets'
  | 'holidays'
  | 'child-as-hero';

export interface GiftOccasion {
  id: GiftOccasionId;
  eyebrow: string;
  title: string;
  description: string;
  storyIdeas: readonly string[];
  checkoutOccasion: string;
}

export const APPROVED_SAMPLE = {
  src: '/assets/kind-dragon-v5/23-bravest-magic.jpg',
  alt: 'Digital sample illustration of a child, a dog, and friendly dragons at bedtime',
  framing: 'Digital sample — illustrative only',
} as const;

export const GIFT_OCCASIONS: readonly GiftOccasion[] = [
  {
    id: 'birthdays',
    eyebrow: 'A birthday story made around them',
    title: 'Make the birthday child the hero',
    description:
      'Turn their interests, favorite people, and one special birthday wish into a story they can review before it becomes a keepsake.',
    storyIdeas: ['A birthday quest', 'A surprise adventure', 'A brave new-year-of-you story'],
    checkoutOccasion: 'birthday',
  },
  {
    id: 'grandparents',
    eyebrow: 'A keepsake for Grandma or Grandpa',
    title: 'Give grandparents a story starring the child they love',
    description:
      'Build a child-led adventure around family memories, a meaningful dedication, and the details that make their bond feel personal.',
    storyIdeas: ['A favorite day together', 'A family tradition', 'A thank-you adventure'],
    checkoutOccasion: 'grandparent gift',
  },
  {
    id: 'siblings',
    eyebrow: 'A story for siblings',
    title: 'Put their teamwork at the center of the adventure',
    description:
      'Create a story led by your child, with a sibling included through the details and approved reference photos you choose to provide.',
    storyIdeas: ['A shared treasure hunt', 'A teamwork challenge', 'A new-sibling welcome'],
    checkoutOccasion: 'sibling gift',
  },
  {
    id: 'pets',
    eyebrow: 'For children and their favorite sidekick',
    title: 'Send your child and pet on an adventure together',
    description:
      'Share the pet’s look, personality, and favorite habits so the story can reflect the friendship your child already knows.',
    storyIdeas: ['A missing-toy mystery', 'A backyard expedition', 'A bedtime rescue'],
    checkoutOccasion: 'pet adventure',
  },
  {
    id: 'holidays',
    eyebrow: 'A family holiday keepsake',
    title: 'Wrap a familiar tradition inside a new adventure',
    description:
      'Use your family’s celebration, setting, and dedication to shape a proof-first gift without promising a specific carrier delivery date.',
    storyIdeas: ['A winter-light adventure', 'A family tradition', 'A just-for-us celebration'],
    checkoutOccasion: 'holiday',
  },
  {
    id: 'child-as-hero',
    eyebrow: 'Their ideas. Their adventure.',
    title: 'Make your child the hero of a story built for them',
    description:
      'Start with their photo, interests, family details, and optional voice note. We build the proof, and you review every page before approval.',
    storyIdeas: ['A courage story', 'A kindness quest', 'A completely custom idea'],
    checkoutOccasion: 'just-because',
  },
] as const;

export function getGiftOccasion(id: string): GiftOccasion | undefined {
  return GIFT_OCCASIONS.find((occasion) => occasion.id === id);
}

export function giftCheckoutHref(occasion: GiftOccasion): string {
  const query = new URLSearchParams({ occasion: occasion.checkoutOccasion });
  return `/checkout?${query.toString()}`;
}
