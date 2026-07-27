import { EditorialSamplesPage } from '@/components/editorial-site';
import type { Metadata } from 'next';
import { getSiteOrigin } from '@/lib/site-url';

const siteOrigin = getSiteOrigin();

export const metadata: Metadata = {
  title: 'Sample Personalized Story Books | HeroStoryBooks',
  description:
    'Peek inside two digital sample story proofs with real watercolor pages, proof-first review, and digital or printed keepsake options.',
  alternates: { canonical: '/samples' },
  openGraph: {
    title: 'HeroStoryBooks digital sample story proofs',
    description:
      'See illustrated sample pages from proof-first personalized children’s books before starting your own.',
    url: `${siteOrigin}/samples`,
    images: [
      {
        url: '/assets/kind-dragon-v5/cover.jpg',
        width: 1536,
        height: 1536,
        alt: 'Lukas and the Kind Dragon digital sample cover',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'HeroStoryBooks digital sample story proofs',
    description:
      'See illustrated sample pages from proof-first personalized children’s books before starting your own.',
    images: ['/assets/kind-dragon-v5/cover.jpg'],
  },
};

export default function SamplesPage() {
  return <EditorialSamplesPage />;
}
