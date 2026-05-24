import { EditorialSamplesPage } from '@/components/editorial-site';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sample Personalized Proof Book | HeroStoryBooks',
  description:
    'Peek inside a personalized HeroStoryBooks proof book with real watercolor sample pages, proof-first review, and digital or printed keepsake options.',
  openGraph: {
    title: 'A peek inside a personalized proof book',
    description:
      'See sample story pages from a proof-first personalized children’s book before starting your own.',
    url: 'https://herostorybooks.com/samples',
    images: [
      {
        url: '/assets/hsb-lukas-print-story-21.jpg',
        width: 1254,
        height: 1254,
        alt: 'Sample HeroStoryBooks personalized proof page',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'A peek inside a personalized proof book',
    description:
      'See sample story pages from a proof-first personalized children’s book before starting your own.',
    images: ['/assets/hsb-lukas-print-story-21.jpg'],
  },
};

export default function SamplesPage() {
  return <EditorialSamplesPage />;
}
