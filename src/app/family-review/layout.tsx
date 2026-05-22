import type { Metadata } from 'next';
import '../../styles/family-review.css';

export const metadata: Metadata = {
  title: 'Family & Friends Test · HeroStoryBooks',
  description:
    'A small, invite-only round where families help us decide if our personalized samples are close enough to your child.',
  robots: { index: false, follow: false },
};

export default function FamilyReviewLayout({ children }: { children: React.ReactNode }) {
  return <div className="hsb-portal">{children}</div>;
}
