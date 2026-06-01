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
    promise: 'Digital proof usually ready within 2 business days; final high-res PDF delivered after approval. Best when timing is too tight for print.',
    features: [
      'Personalized digital storybook PDF',
      '24 illustrated story pages plus keepsake pages',
      'Read on any device',
      'Print at home anytime',
      'Safest late-window Father’s Day option',
    ],
    cta: 'Choose Digital',
  },
  {
    id: 'classic',
    name: 'Classic softcover',
    price: '$44.99',
    description: '32-page softcover keepsake with proof review',
    promise: 'Free shipping included for US orders. Ships in 5–7 business days after approval. You review the proof before it prints. If timing is tight, choose Digital PDF.',
    features: [
      'Premium softcover printed book',
      '24 illustrated story pages plus keepsake pages',
      'Free shipping included for US orders',
      'Digital preview approval before print',
      'Proof approval before print',
    ],
    cta: 'Choose Classic',
    featured: true,
  },
  {
    id: 'premium',
    name: 'Premium hardcover',
    price: '$64.99',
    description: '32-page hardcover keepsake edition',
    promise: 'Free shipping included for US orders. Ships in 5–7 business days after approval. You review the proof before it prints. If timing is tight, choose Digital PDF.',
    features: [
      'Beautiful hardcover printed book',
      '24 illustrated story pages plus keepsake pages',
      'Free shipping included for US orders',
      'Digital preview approval before print',
      'Proof approval before print',
      'Most gifted keepsake finish',
    ],
    cta: 'Choose Premium',
  },
];
