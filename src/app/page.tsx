import { EditorialHomePage } from '@/components/editorial-site';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Personalized Story Books for Children | HeroStoryBooks',
  description: 'Create a personalized keepsake storybook where your child becomes the hero.',
  alternates: { canonical: '/' },
};

export default function HomePage() {
  return <EditorialHomePage />;
}
