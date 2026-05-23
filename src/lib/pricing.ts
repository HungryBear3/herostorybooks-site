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
    name: 'Digital PDF',
    price: '$19',
    description: 'Digital proof first, then high-resolution PDF',
    promise: 'Digital proof usually ready within 2 business days; final high-res PDF delivered after approval. No printing or shipping step.',
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
    name: 'Classic softcover',
    price: '$39',
    description: 'Softcover keepsake with digital preview',
    promise: 'Free shipping included for US orders. Ships in 5–7 business days. A digital preview arrives first so you can approve before it prints.',
    features: [
      'Premium softcover printed book',
      'Free shipping included for US orders',
      'Digital preview approval before print',
      'Digital PDF included',
    ],
    cta: 'Choose Classic',
    featured: true,
  },
  {
    id: 'premium',
    name: 'Premium hardcover',
    price: '$64',
    description: 'Hardcover keepsake edition',
    promise: 'Free shipping included for US orders. Ships in 5–7 business days. A digital preview arrives first so you can approve before it prints.',
    features: [
      'Beautiful hardcover printed book',
      'Free shipping included for US orders',
      'Digital preview approval before print',
      'Digital PDF included',
      'Best for special gifts and keepsakes',
    ],
    cta: 'Choose Premium',
  },
];
