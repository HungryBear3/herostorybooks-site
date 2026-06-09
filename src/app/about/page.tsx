import { EditorialAboutPage } from '@/components/editorial-site';

export const metadata = {
  title: 'About HeroStoryBooks',
  description:
    'HeroStoryBooks is a small Chicago team making proof-first personalized storybooks for family gifts.',
  openGraph: {
    title: 'About HeroStoryBooks',
    description:
      'A small team making proof-first personalized storybooks for family gifts.',
    url: '/about',
  },
};

export default function AboutPage() {
  return <EditorialAboutPage />;
}
