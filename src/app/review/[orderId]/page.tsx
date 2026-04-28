import { notFound } from 'next/navigation';

import { getReviewSnapshot } from '@/lib/page-review';
import ReviewClient from './review-client';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const snapshot = await getReviewSnapshot(orderId);
  if (!snapshot) notFound();
  return <ReviewClient initial={snapshot} />;
}
