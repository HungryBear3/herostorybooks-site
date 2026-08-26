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
 * Bytes are opened through the Family Review storage abstraction, so
 * a sample stored privately is read with the store token and has no
 * URL at all. Legacy samples written while the lane stored bytes
 * publicly still read through their recorded URL — see
 * private-assets.openAsset.
 */

import { NextResponse } from 'next/server';

import {
  AssetStorageError,
  openAsset,
  safeDownloadFilename,
  serveableContentType,
} from '@/lib/family-review/private-assets';
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
  // Storage is opened only after the token resolved to a submission AND
  // the asset was found among THAT submission's samples.
  let opened;
  try {
    opened = await openAsset(sample);
  } catch (err) {
    if (err instanceof AssetStorageError && err.code === 'not_found') {
      return new NextResponse('Not found', { status: 404 });
    }
    console.error(
      `[family-review/sample] read failed (asset=${assetId}):`,
      err instanceof AssetStorageError ? err.code : 'unknown',
    );
    return new NextResponse('Upstream fetch failed', { status: 502 });
  }

  // Extension follows the STORED mime rather than a hardcoded .png, and
  // Content-Type is allowlisted rather than echoed from upstream.
  const suggestedName = safeDownloadFilename(
    `herostorybooks-${sample.briefId}`,
    sample.mime,
  );
  return new NextResponse(opened.stream, {
    status: 200,
    headers: {
      'Content-Type': serveableContentType(sample.mime),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store, max-age=0',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Disposition': `inline; filename="${suggestedName}"`,
    },
  });
}
