export interface PublicPricingPlan {
  id: 'digital' | 'classic' | 'premium';
  name: string;
  price: string;
  description: string;
  promise: string;
  features: string[];
  cta: string;
  featured?: boolean;
}

export const PUBLIC_PRICING_PLANS: PublicPricingPlan[] = [
  {
    id: 'digital',
    name: 'Digital',
    price: '$29.99',
    description: 'Personalized PDF delivered fast',
    promise: 'Delivered by email in about 15 minutes.',
    features: [
      'Personalized digital storybook PDF',
      'Read on any device',
      'Print at home anytime',
      'Fastest delivery option',
    ],
    cta: 'Choose Digital',
  },
  {
    id: 'classic',
    name: 'Classic',
    price: '$49.99',
    description: 'Softcover keepsake with digital preview',
    promise: 'Ships in 5–7 business days. A digital preview arrives first so you can approve before it prints.',
    features: [
      'Premium softcover printed book',
      'Digital preview approval before print',
      'Digital PDF included',
      'Most popular gift format',
    ],
    cta: 'Choose Classic',
    featured: true,
  },
  {
    id: 'premium',
    name: 'Premium',
    price: '$79.99',
    description: 'Hardcover gift set with extra copies',
    promise: 'Ships in 5–7 business days. A digital preview arrives first so you can approve before it prints.',
    features: [
      'Premium hardcover printed book',
      'Digital preview approval before print',
      'Digital PDF included',
      'Includes 2 extra softcover copies',
    ],
    cta: 'Choose Premium',
  },
];
