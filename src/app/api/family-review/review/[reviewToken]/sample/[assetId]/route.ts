/**
 * GET /api/family-review/review/[reviewToken]/sample/[assetId]
 *
 * Parent-private proxy for sample-illustration bytes. The parent's
 * private review page now references samples via THIS app-origin URL
 * instead of the raw Vercel Blob URL — so:
 *
 *   - No raw vercel-storage.com URL leaks into parent-facing HTML.
 *   - The parent's browser sends no referrer to vercel-storage.com.
 *   - The bytes are gated by the reviewToken match: any other token
 *     returns 404, never 403, so the endpoint can't be used to
 *     enumerate samples or tokens.
 *
 * Vercel Blob v2 only supports `access: 'public'` (private mode is
 * not GA at the time of this commit), so the underlying object is
 * still URL-addressable if a reviewer leaks the raw URL. The proxy
 * is a defense-in-depth layer, not a replacement for keeping the
 * raw URL secret.
 */

import { NextResponse } from 'next/server';

import { findByReviewToken } from '@/lib/family-review/store';
import {
  isWellFormedAssetId,
  isWellFormedReviewToken,
} from '@/lib/family-review/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  {
    params,
  }: { params: Promise<{ reviewToken: string; assetId: string }> },
) {
  const { reviewToken, assetId } = await params;
  if (!isWellFormedReviewToken(reviewToken) || !isWellFormedAssetId(assetId)) {
    return new NextResponse('Not found', { status: 404 });
  }
  const submission = await findByReviewToken(reviewToken);
  if (!submission) {
    return new NextResponse('Not found', { status: 404 });
  }
  const sample = submission.samples.find((s) => s.assetId === assetId);
  if (!sample) {
    return new NextResponse('Not found', { status: 404 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(sample.blobUrl, { cache: 'no-store' });
  } catch {
    return new NextResponse('Upstream fetch failed', { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new NextResponse('Upstream fetch failed', {
      status: upstream.status || 502,
    });
  }
  const suggestedName = `herostorybooks-${sample.briefId}.png`;
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': sample.mime || 'application/octet-stream',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Disposition': `inline; filename="${suggestedName}"`,
    },
  });
}
