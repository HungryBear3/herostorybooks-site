/**
 * POST /api/family-review/review/[reviewToken]/feedback
 *
 * Parent feedback endpoint, gated by the parent-private reviewToken.
 * Idempotent on the server side: if feedback is already saved we
 * overwrite it with the new payload so the parent can revise.
 */

import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

import {
  findByReviewToken,
  persistSubmission,
  type ParentFeedback,
} from '@/lib/family-review/store';
import { isWellFormedReviewToken } from '@/lib/family-review/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RawBody {
  rating?: unknown;
  favoriteSampleAssetId?: unknown;
  looksLikeChild?: unknown;
  notes?: unknown;
}

function fallbackSampleRunId(
  samples: { assetId: string; uploadedAt: string }[],
): string | undefined {
  if (samples.length === 0) return undefined;
  const fingerprint = samples
    .map((sample) => `${sample.assetId}:${sample.uploadedAt}`)
    .sort()
    .join('|');
  return `run_${createHash('sha1').update(fingerprint).digest('hex').slice(0, 12)}`;
}

export async function POST(
  req: Request,
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

  let body: RawBody;
  try {
    body = (await req.json()) as RawBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_json' },
      { status: 400 },
    );
  }

  const ratingNum =
    typeof body.rating === 'number' ? body.rating : Number(body.rating);
  if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return NextResponse.json(
      { ok: false, error: 'invalid_rating' },
      { status: 422 },
    );
  }
  const looksLikeChild =
    body.looksLikeChild === 'yes' ||
    body.looksLikeChild === 'somewhat' ||
    body.looksLikeChild === 'no'
      ? body.looksLikeChild
      : null;
  if (!looksLikeChild) {
    return NextResponse.json(
      { ok: false, error: 'invalid_likeness' },
      { status: 422 },
    );
  }

  const favoriteSampleAssetId =
    typeof body.favoriteSampleAssetId === 'string' &&
    submission.samples.some((s) => s.assetId === body.favoriteSampleAssetId)
      ? body.favoriteSampleAssetId
      : undefined;

  const notes =
    typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : '';

  const feedback: ParentFeedback = {
    rating: Math.round(ratingNum),
    looksLikeChild,
    notes,
    submittedAt: new Date().toISOString(),
    sampleRunId: submission.currentSampleRunId ?? fallbackSampleRunId(submission.samples),
    sampleAssetIds: submission.samples.map((s) => s.assetId),
    ...(favoriteSampleAssetId ? { favoriteSampleAssetId } : {}),
  };

  const next = {
    ...submission,
    feedback,
    feedbackHistory: [...(submission.feedbackHistory ?? []), feedback],
    status:
      submission.status === 'archived'
        ? submission.status
        : 'feedback_received' as const,
    updatedAt: new Date().toISOString(),
  };
  const result = await persistSubmission(next);
  if (!result.persisted) {
    return NextResponse.json(
      { ok: false, error: 'persist_failed', reason: result.reason },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, feedback }, { status: 200 });
}
