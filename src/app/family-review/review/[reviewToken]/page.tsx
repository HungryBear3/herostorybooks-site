import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { findByReviewToken } from '@/lib/family-review/store';
import { isWellFormedReviewToken } from '@/lib/family-review/tokens';

import ReviewPortal from './review-portal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Your private review · HeroStoryBooks',
  description: 'Your private family/friends review page.',
  robots: { index: false, follow: false },
};

/**
 * /family-review/review/[reviewToken]
 *
 * Parent-private capability URL. The reviewToken is the only credential —
 * anyone with the link sees this submission. We:
 *
 *   1. Shape-check the token before touching Blob.
 *   2. Look up via findByReviewToken (which constant-time-ish scans the
 *      family-review/submissions/ prefix). If not found, 404 — never
 *      leak the existence of the store or the size of the namespace.
 *   3. Pass the full record to the client component for rendering.
 *
 * The route is intentionally NOT linked from any public nav.
 */
export default async function ReviewPage({
  params,
}: {
  params: Promise<{ reviewToken: string }>;
}) {
  const { reviewToken } = await params;

  if (!isWellFormedReviewToken(reviewToken)) {
    notFound();
  }

  const submission = await findByReviewToken(reviewToken);
  if (!submission) {
    notFound();
  }

  // Strip raw Blob URLs before handing to the client component. The
  // parent's HTML must not contain vercel-storage.com URLs; samples
  // are fetched through the token-gated proxy
  // /api/family-review/review/{token}/sample/{assetId}. Reference
  // photo URLs were never echoed to the parent anyway.
  const safe = {
    ...submission,
    samples: submission.samples.map((s) => ({
      assetId: s.assetId,
      briefId: s.briefId,
      mime: s.mime,
      size: s.size,
      uploadedAt: s.uploadedAt,
      note: s.note,
      // blobUrl + blobPathname omitted intentionally
      blobUrl: '',
      blobPathname: '',
    })),
    photos: {
      count: submission.photos.count,
      uploadedToServer: submission.photos.uploadedToServer,
      assets: [],
    },
  };

  return <ReviewPortal submission={safe} />;
}
