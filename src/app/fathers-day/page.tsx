import type { Metadata } from 'next';
import { EditorialFathersDayPage } from '@/components/editorial-site';
import { getSiteOrigin } from '@/lib/site-url';

const siteOrigin = getSiteOrigin();

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Father’s Day Personalized Storybook | HeroStoryBooks',
  description:
    'Create a personalized Father’s Day storybook with an optional child voice note, proof-first review, and digital delivery after approval.',
  openGraph: {
    title: 'A Father’s Day storybook from them',
    description:
      'Start a personalized proof book for Dad. Review every page first, then approve digital or print when it feels right.',
    url: `${siteOrigin}/fathers-day`,
    images: [
      {
        url: '/assets/og-social-share.png',
        width: 1200,
        height: 630,
        alt: 'HeroStoryBooks Father’s Day personalized storybook',
      },
    ],
  },
};

export default function FathersDayPage() {
  return <EditorialFathersDayPage />;
}
