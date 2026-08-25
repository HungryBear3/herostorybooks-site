/**
 * DELETE /api/family-review/admin/submissions/[submissionId]
 *
 * Cookie-gated admin cleanup for known test/smoke records. This is
 * intentionally narrow: it deletes the submission JSON, review-token
 * index, reference photo blobs, and generated sample blobs for one
 * explicit submission id. Missing records return 404.
 */

import { NextResponse } from 'next/server';

import { isAdminRequestAuthed } from '@/lib/family-review/admin-auth';
import {
  deleteBlob,
  deleteReviewTokenIndexes,
  findById,
  submissionPath,
} from '@/lib/family-review/store';
import { isWellFormedSubmissionId } from '@/lib/family-review/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ submissionId: string }> },
) {
  if (!isAdminRequestAuthed(req)) {
    return NextResponse.json(
      { ok: false, error: 'forbidden' },
      { status: 403 },
    );
  }

  const { submissionId } = await ctx.params;
  if (!isWellFormedSubmissionId(submissionId)) {
    return NextResponse.json(
      { ok: false, error: 'not_found' },
      { status: 404 },
    );
  }

  const submission = await findById(submissionId);
  if (!submission) {
    return NextResponse.json(
      { ok: false, error: 'not_found' },
      { status: 404 },
    );
  }

  // Token indexes first, and through the store helper: the record we
  // hold has been normalized, so it no longer carries a plaintext token
  // to build a legacy index path from. The helper recovers that address
  // from the stored bytes, which must still exist at this point.
  await deleteReviewTokenIndexes(submission);

  const paths = [
    ...submission.photos.assets.map((asset) => asset.blobPathname),
    ...submission.samples.map((asset) => asset.blobPathname),
    submissionPath(submission.id),
  ];

  await Promise.all(paths.map((pathname) => deleteBlob(pathname)));

  return NextResponse.json(
    { ok: true, deleted: true, submissionId: submission.id },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
