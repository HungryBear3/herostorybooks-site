import type { Metadata } from 'next';
import '../../styles/family-review.css';

export const metadata: Metadata = {
  title: 'Private group-book intake · HeroStoryBooks',
  description: 'Private per-family intake for an invitation-only group book.',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default function GroupBookLayout({ children }: { children: React.ReactNode }) {
  return <div className="hsb-portal">{children}</div>;
}
