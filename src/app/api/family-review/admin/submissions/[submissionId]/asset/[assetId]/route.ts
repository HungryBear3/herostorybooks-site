/**
 * GET /api/family-review/admin/submissions/[submissionId]/asset/[assetId]
 *
 * Cookie-gated admin proxy for ANY asset on a submission (reference
 * photo or generated sample). Replaces raw Vercel Blob URLs in the
 * admin board so:
 *
 *   - No vercel-storage.com URL appears in admin HTML or browser
 *     network logs.
 *   - The reviewer key never travels in the URL. Auth is the
 *     fr_admin_session HttpOnly cookie set by POST
 *     /api/family-review/admin/login.
 *   - The asset id must belong to THIS submission, so an admin can't
 *     accidentally cross-reference assets across families by tampering
 *     with the URL path segments.
 *
 * The route serves both photos and samples by scanning the submission's
 * photo asset list first, then the samples list. Returns 404 if the
 * id matches neither.
 */

import { NextResponse } from 'next/server';

import { isAdminRequestAuthed } from '@/lib/family-review/admin-auth';
import { findById } from '@/lib/family-review/store';
import {
  isWellFormedAssetId,
  isWellFormedSubmissionId,
} from '@/lib/family-review/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  {
    params,
  }: { params: Promise<{ submissionId: string; assetId: string }> },
) {
  const { submissionId, assetId } = await params;
  if (
    !isWellFormedSubmissionId(submissionId) ||
    !isWellFormedAssetId(assetId)
  ) {
    return new NextResponse('Not found', { status: 404 });
  }
  if (!isAdminRequestAuthed(req)) {
    return new NextResponse('Forbidden', { status: 403 });
  }
  const submission = await findById(submissionId);
  if (!submission) {
    return new NextResponse('Not found', { status: 404 });
  }
  const photo = submission.photos.assets.find((p) => p.assetId === assetId);
  const sample = submission.samples.find((s) => s.assetId === assetId);
  const asset = photo ?? sample;
  if (!asset) {
    return new NextResponse('Not found', { status: 404 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(asset.blobUrl, { cache: 'no-store' });
  } catch {
    return new NextResponse('Upstream fetch failed', { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new NextResponse('Upstream fetch failed', {
      status: upstream.status || 502,
    });
  }
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': asset.mime || 'application/octet-stream',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Disposition': 'inline',
    },
  });
}
