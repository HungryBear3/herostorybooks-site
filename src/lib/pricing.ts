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
    price: '$14.99',
    description: '32-page digital proof first, then high-resolution PDF',
    promise: 'Digital proof usually ready within 2 business days; final high-res PDF delivered after approval. No printing or shipping step.',
    features: [
      'Personalized digital storybook PDF',
      '24 illustrated story pages plus keepsake pages',
      'Read on any device',
      'Print at home anytime',
      'Fastest Father’s Day option',
    ],
    cta: 'Choose Digital',
    featured: true,
  },
  {
    id: 'classic',
    name: 'Classic softcover',
    price: '$44.99',
    description: '32-page softcover keepsake with digital preview',
    promise: 'Free shipping included for US orders. Ships in 5–7 business days. A digital preview arrives first so you can approve before it prints.',
    features: [
      'Premium softcover printed book',
      '24 illustrated story pages plus keepsake pages',
      'Free shipping included for US orders',
      'Digital preview approval before print',
      'Digital PDF included',
    ],
    cta: 'Choose Classic',
  },
  {
    id: 'premium',
    name: 'Premium hardcover',
    price: '$64.99',
    description: '32-page hardcover keepsake edition',
    promise: 'Free shipping included for US orders. Ships in 5–7 business days. A digital preview arrives first so you can approve before it prints.',
    features: [
      'Beautiful hardcover printed book',
      '24 illustrated story pages plus keepsake pages',
      'Free shipping included for US orders',
      'Digital preview approval before print',
      'Digital PDF included',
      'Best for special gifts and keepsakes',
    ],
    cta: 'Choose Premium',
  },
];
