import type { Metadata } from 'next';

import { EditorialAboutPage } from '@/components/editorial-site';

export const metadata: Metadata = {
  title: 'About HeroStoryBooks | Personalized Books Made With Care',
  description:
    'Meet the small team behind HeroStoryBooks and learn how each personalized story is drafted, illustrated, reviewed, and approved.',
  alternates: { canonical: '/about' },
};

export default function AboutPage() {
  return <EditorialAboutPage />;
}
