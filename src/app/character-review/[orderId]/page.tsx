import CharacterReviewClient from './review-client';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Review your character | Hero Story Books', robots: { index: false, follow: false }, referrer: 'no-referrer' as const };
export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  return <CharacterReviewClient orderId={(await params).orderId} />;
}
