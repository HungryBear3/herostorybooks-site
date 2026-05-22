/**
 * POST /api/family-review/review/[reviewToken]/deletion-request
 *
 * Parent-initiated deletion request, gated by the parent-private
 * reviewToken. Sets deletionRequestedAt on the submission — does NOT
 * auto-purge bytes. A reviewer sees the flag in the admin board and
 * processes the deletion manually within the 48h window promised on
 * the consent screen.
 *
 * Idempotent: a second click overwrites the timestamp with the latest
 * time so admins can see the most recent request. Returns 404 (never
 * 403) on token miss so the endpoint cannot be used to enumerate.
 */

import { NextResponse } from 'next/server';

import {
  findByReviewToken,
  persistSubmission,
} from '@/lib/family-review/store';
import { isWellFormedReviewToken } from '@/lib/family-review/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
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
  const now = new Date().toISOString();
  const next = {
    ...submission,
    deletionRequestedAt: now,
    updatedAt: now,
  };
  const result = await persistSubmission(next);
  if (!result.persisted) {
    return NextResponse.json(
      { ok: false, error: 'persist_failed', reason: result.reason },
      { status: 500 },
    );
  }
  return NextResponse.json(
    { ok: true, deletionRequestedAt: now },
    { status: 200 },
  );
}
