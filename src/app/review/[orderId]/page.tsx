import { notFound } from 'next/navigation';

import { getReviewSnapshot } from '@/lib/page-review';
import ReviewClient from './review-client';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { orderId } = await params;
  const { token } = await searchParams;
  const snapshot = await getReviewSnapshot(orderId, { reviewToken: token ?? null });
  if (!snapshot) notFound();
  return <ReviewClient initial={snapshot} />;
}
