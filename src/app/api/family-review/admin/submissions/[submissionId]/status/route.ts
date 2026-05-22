/**
 * POST /api/family-review/admin/submissions/[submissionId]/status
 *
 * Admin-only: move a submission between workflow statuses and
 * (optionally) attach a beta discount code when marking
 * invited_to_order.
 */

import { NextResponse } from 'next/server';

import { isAdminRequestAuthed } from '@/lib/family-review/admin-auth';
import {
  findById,
  persistSubmission,
  type SubmissionStatus,
} from '@/lib/family-review/store';
import { isWellFormedSubmissionId, newAssetId } from '@/lib/family-review/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED: Set<SubmissionStatus> = new Set([
  'submitted',
  'samples_in_progress',
  'samples_ready',
  'feedback_received',
  'invited_to_order',
  'archived',
]);

interface Body {
  status?: unknown;
  betaDiscountCode?: unknown;
}

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
  // /api/family-review/admin/login.
  if (!isAdminRequestAuthed(req)) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_json' },
      { status: 400 },
    );
  }
  if (
    typeof body.status !== 'string' ||
    !ALLOWED.has(body.status as SubmissionStatus)
  ) {
    return NextResponse.json(
      { ok: false, error: 'invalid_status' },
      { status: 422 },
    );
  }
  const nextStatus = body.status as SubmissionStatus;

  const submission = await findById(submissionId);
  if (!submission) {
    return NextResponse.json(
      { ok: false, error: 'submission_not_found' },
      { status: 404 },
    );
  }

  // Beta code attaches only when transitioning into invited_to_order.
  const code =
    nextStatus === 'invited_to_order' &&
    typeof body.betaDiscountCode === 'string'
      ? body.betaDiscountCode.trim().slice(0, 40)
      : undefined;
  const shouldClearFeedback =
    nextStatus === 'submitted' ||
    nextStatus === 'samples_in_progress' ||
    nextStatus === 'samples_ready';
  const feedbackAlreadyInHistory =
    Boolean(submission.feedback) &&
    (submission.feedbackHistory ?? []).some(
      (fb) => fb.submittedAt === submission.feedback?.submittedAt,
    );

  const next = {
    ...submission,
    status: nextStatus,
    currentSampleRunId:
      shouldClearFeedback && nextStatus !== 'submitted'
        ? `run_${newAssetId()}`
        : submission.currentSampleRunId,
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
    ...(nextStatus === 'invited_to_order' && code
      ? { betaDiscountCode: code }
      : {}),
  };

  const result = await persistSubmission(next);
  if (!result.persisted) {
    return NextResponse.json(
      { ok: false, error: 'persist_failed' },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, submission: next }, { status: 200 });
}
