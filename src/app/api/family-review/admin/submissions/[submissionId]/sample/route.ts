/**
 * POST /api/family-review/admin/submissions/[submissionId]/sample
 *
 * Admin-only: upload one approved sample illustration for a brief
 * (cover-hero / dinosaur-adventure / bedtime-keepsake). The reviewer
 * prepares the image manually (ChatGPT image-creation, hand-painting,
 * whatever — outside this app) and then uploads the approved PNG/JPG.
 *
 * This route does NOT call any image-generation API. It is a pure
 * upload-and-record endpoint.
 */

import { NextResponse } from 'next/server';

import { isAdminRequestAuthed } from '@/lib/family-review/admin-auth';
import {
  deleteBlob,
  findById,
  hasBlobToken,
  persistSubmission,
  uploadSampleBytes,
  type BriefId,
} from '@/lib/family-review/store';
import {
  isWellFormedSubmissionId,
  newAssetId,
} from '@/lib/family-review/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED_BRIEFS = new Set<BriefId>([
  'cover-hero',
  'dinosaur-adventure',
  'bedtime-keepsake',
]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ submissionId: string }> },
) {
  const { submissionId } = await params;
  if (!isWellFormedSubmissionId(submissionId)) {
    return NextResponse.json(
      { ok: false, error: 'invalid_submission_id' },
      { status: 400 },
    );
  }

  // Auth: fr_admin_session HttpOnly cookie set by POST
  // /api/family-review/admin/login. The reviewer key is never read
  // from the URL.
  if (!isAdminRequestAuthed(req)) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  if (!hasBlobToken()) {
    return NextResponse.json(
      { ok: false, error: 'storage_disabled' },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_form' },
      { status: 400 },
    );
  }

  const briefRaw = form.get('briefId');
  const briefId =
    typeof briefRaw === 'string' && ALLOWED_BRIEFS.has(briefRaw as BriefId)
      ? (briefRaw as BriefId)
      : null;
  if (!briefId) {
    return NextResponse.json(
      { ok: false, error: 'invalid_brief' },
      { status: 422 },
    );
  }
  const noteRaw = form.get('note');
  const note = typeof noteRaw === 'string' ? noteRaw.trim().slice(0, 500) : '';

  const fileEntry = form.get('sample');
  if (!(fileEntry instanceof File)) {
    return NextResponse.json(
      { ok: false, error: 'missing_file' },
      { status: 422 },
    );
  }
  if (fileEntry.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: 'file_too_large' },
      { status: 413 },
    );
  }
  if (!ALLOWED_MIME[fileEntry.type]) {
    return NextResponse.json(
      { ok: false, error: 'unsupported_mime' },
      { status: 415 },
    );
  }

  const submission = await findById(submissionId);
  if (!submission) {
    return NextResponse.json(
      { ok: false, error: 'submission_not_found' },
      { status: 404 },
    );
  }

  const assetId = newAssetId();
  const ext = ALLOWED_MIME[fileEntry.type];
  const buf = Buffer.from(await fileEntry.arrayBuffer());

  let asset;
  try {
    asset = await uploadSampleBytes({
      submissionId,
      assetId,
      briefId,
      bytes: buf,
      mime: fileEntry.type,
      ext,
      ...(note ? { note } : {}),
    });
  } catch (err) {
    console.error(
      `[family-review/admin/sample] upload failed (submission=${submissionId}, brief=${briefId}):`,
      err,
    );
    return NextResponse.json(
      { ok: false, error: 'upload_failed' },
      { status: 502 },
    );
  }

  // Replace policy: if a sample for this brief already exists, delete
  // the old blob so we never accumulate stale samples for the same brief.
  const stale = submission.samples.filter((s) => s.briefId === briefId);
  const kept = submission.samples.filter((s) => s.briefId !== briefId);
  for (const old of stale) {
    await deleteBlob(old.blobPathname);
  }

  const nextSamples = [...kept, asset];
  const nextStatus =
    submission.status === 'submitted'
      ? ('samples_in_progress' as const)
      : nextSamples.length >= 3
      ? ('samples_ready' as const)
      : submission.status;
  const shouldClearFeedback =
    submission.status === 'feedback_received' ||
    (submission.status === 'samples_in_progress' && Boolean(submission.feedback));
  const feedbackAlreadyInHistory =
    Boolean(submission.feedback) &&
    (submission.feedbackHistory ?? []).some(
      (fb) => fb.submittedAt === submission.feedback?.submittedAt,
    );
  const currentSampleRunId = shouldClearFeedback
    ? `run_${newAssetId()}`
    : submission.currentSampleRunId ?? `run_${newAssetId()}`;
  const next = {
    ...submission,
    samples: nextSamples,
    status: nextStatus,
    currentSampleRunId,
    ...(shouldClearFeedback ? { feedback: undefined } : {}),
    ...(shouldClearFeedback && submission.feedback && !feedbackAlreadyInHistory
      ? {
          feedbackHistory: [
            ...(submission.feedbackHistory ?? []),
            submission.feedback,
          ],
        }
      : {}),
    updatedAt: new Date().toISOString(),
  };

  const result = await persistSubmission(next);
  if (!result.persisted) {
    return NextResponse.json(
      { ok: false, error: 'persist_failed', reason: result.reason },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { ok: true, asset, status: next.status, samples: nextSamples },
    { status: 200 },
  );
}
