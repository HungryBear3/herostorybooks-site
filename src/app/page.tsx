import { EditorialHomePage } from '@/components/editorial-site';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Personalized Story Books for Children | HeroStoryBooks',
  description: 'Create a personalized keepsake storybook where your child becomes the hero.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Hero Story Books',
    description: 'Create a personalized keepsake storybook where your child becomes the hero.',
    url: 'https://herostorybooks.com',
    siteName: 'HeroStoryBooks',
    images: [
      {
        url: '/assets/og-social-share.png',
        width: 1200,
        height: 630,
        alt: 'HeroStoryBooks social share image',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Hero Story Books',
    description: 'Personalized storybooks that turn your child into the hero of their own keepsake adventure.',
    images: ['/assets/og-social-share.png'],
  },
};

export default function HomePage() {
  return <EditorialHomePage />;
}
