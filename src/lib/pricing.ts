export interface PublicPricingPlan {
  id: 'digital' | 'classic' | 'premium';
  name: string;
  price: string;
  anchorPrice?: string;
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
    price: '$14.99',
    anchorPrice: '$19.99',
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
    price: '$39.99',
    description: 'Softcover keepsake with digital preview',
    promise: 'Free shipping included. Ships in 5–7 business days. A digital preview arrives first so you can approve before it prints.',
    features: [
      'Premium softcover printed book',
      'Free shipping included',
      'Digital preview approval before print',
      'Digital PDF included',
    ],
    cta: 'Choose Classic',
    featured: true,
  },
  {
    id: 'premium',
    name: 'Premium',
    price: '$59.99',
    description: 'Hardcover keepsake edition',
    promise: 'Free shipping included. Ships in 5–7 business days. A digital preview arrives first so you can approve before it prints.',
    features: [
      'Beautiful hardcover printed book',
      'Free shipping included',
      'Digital preview approval before print',
      'Digital PDF included',
      'Best for special gifts and keepsakes',
    ],
    cta: 'Choose Premium',
  },
];
