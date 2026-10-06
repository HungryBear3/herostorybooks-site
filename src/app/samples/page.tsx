import { EditorialSamplesPage } from '@/components/editorial-site';
import type { Metadata } from 'next';
import { getSiteOrigin } from '@/lib/site-url';

const siteOrigin = getSiteOrigin();

export const metadata: Metadata = {
  title: 'Sample Personalized Story Books | HeroStoryBooks',
  description:
    'Explore personalized story pages and photos of real printed softcover and hardcover books, with proof-first review before delivery or print.',
  alternates: { canonical: '/samples' },
  openGraph: {
    title: 'HeroStoryBooks story and printed-book samples',
    description:
      'See illustrated story pages and real softcover and hardcover book photos before starting your own.',
    url: `${siteOrigin}/samples`,
    images: [
      {
        url: '/assets/showcase/dog-city/page-17.jpg',
        width: 1536,
        height: 1536,
        alt: 'Watercolor sample from Lukas Was a Dog in Dog City',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'HeroStoryBooks story and printed-book samples',
    description:
      'See illustrated story pages and real softcover and hardcover book photos before starting your own.',
    images: ['/assets/showcase/dog-city/page-17.jpg'],
  },
};

export default function SamplesPage() {
  return <EditorialSamplesPage />;
}
