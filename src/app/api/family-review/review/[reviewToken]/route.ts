/**
 * GET /api/family-review/review/[reviewToken]
 *
 * Parent-private read endpoint. The reviewToken is the only credential —
 * we shape-check it, look up the submission, and return its full record
 * minus a few admin-only fields. 404 (never 403) when the token doesn't
 * match, so the endpoint cannot be used to enumerate tokens.
 */

import { NextResponse } from 'next/server';

import { findByReviewToken } from '@/lib/family-review/store';
import { isWellFormedReviewToken } from '@/lib/family-review/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ reviewToken: string }> },
) {
  const { reviewToken } = await params;
  if (!isWellFormedReviewToken(reviewToken)) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  const submission = await findByReviewToken(reviewToken);
  if (!submission) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  // Strip admin-only / sensitive fields the parent shouldn't see.
  // Reference photo URLs are admin-only. Sample URLs are also redacted —
  // the parent fetches sample bytes through the token-gated proxy at
  // /api/family-review/review/{token}/sample/{assetId} so no raw
  // vercel-storage.com URL ever lands in parent-facing HTML or fetch
  // responses.
  const safe = {
    id: submission.id,
    reviewToken: submission.reviewToken,
    receivedAt: submission.receivedAt,
    updatedAt: submission.updatedAt,
    parent: { name: submission.parent.name, email: submission.parent.email },
    child: submission.child,
    consent: submission.consent,
    photos: {
      count: submission.photos.count,
      uploadedToServer: submission.photos.uploadedToServer,
    },
    samples: submission.samples.map((s) => ({
      assetId: s.assetId,
      briefId: s.briefId,
      mime: s.mime,
      size: s.size,
      uploadedAt: s.uploadedAt,
      note: s.note,
    })),
    currentSampleRunId: submission.currentSampleRunId,
    feedback: submission.feedback,
    feedbackHistory: submission.feedbackHistory ?? [],
    direction: submission.direction,
    status: submission.status,
    betaDiscountCode: submission.betaDiscountCode,
    deletionRequestedAt: submission.deletionRequestedAt,
  };
  return NextResponse.json(
    { ok: true, submission: safe },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
