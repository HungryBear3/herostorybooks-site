import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { getReviewSnapshot } from '@/lib/page-review';
import { getPrivateReviewSessionCookieName } from '@/lib/review-capability';
import ReviewClient from './review-client';
import ReviewSessionBootstrap from './review-session-bootstrap';

export const dynamic = 'force-dynamic';
export const metadata = {
  robots: { index: false, follow: false },
};

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { orderId } = await params;
  const { token } = await searchParams;
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(getPrivateReviewSessionCookieName(orderId))?.value ?? null;
  const snapshot = await getReviewSnapshot(orderId, { reviewToken: token ?? sessionToken, now: new Date() });
  if (!snapshot && !token && !sessionToken) {
    return <ReviewSessionBootstrap orderId={orderId} />;
  }
  if (!snapshot) notFound();
  return <ReviewClient initial={snapshot} />;
}
