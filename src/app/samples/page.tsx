import { EditorialSamplesPage } from '@/components/editorial-site';
import type { Metadata } from 'next';
import { getSiteOrigin } from '@/lib/site-url';

const siteOrigin = getSiteOrigin();

export const metadata: Metadata = {
  title: 'See a Real Sample Book | HeroStoryBooks',
  description:
    'See a real printed HeroStoryBooks copy, photographed, plus clean sample art from real titles. Proof-first: you approve every page before we print.',
  openGraph: {
    title: 'A real printed sample book, photographed',
    description:
      'Photos of an actual printed personalized children’s book, plus clean sample art from real titles. You approve before we print.',
    url: `${siteOrigin}/samples`,
    images: [
      {
        url: '/assets/hsb-lukas-dino-photo-cover.jpg',
        width: 960,
        height: 880,
        alt: 'Photograph of a printed HeroStoryBooks personalized book on a desk',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'A real printed sample book, photographed',
    description:
      'Photos of an actual printed personalized children’s book, plus clean sample art from real titles. You approve before we print.',
    images: ['/assets/hsb-lukas-dino-photo-cover.jpg'],
  },
};

export default function SamplesPage() {
  return <EditorialSamplesPage />;
}
