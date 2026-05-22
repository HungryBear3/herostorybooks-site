/**
 * GET /api/family-review/submissions?limit=N
 *
 * Admin-only read endpoint. Returns the most recent submissions with
 * full extended schema (photo asset refs, samples, feedback, status).
 *
 * Auth: fr_admin_session HttpOnly cookie set by POST
 * /api/family-review/admin/login. The admin key is NEVER read from the
 * URL — no query string carries it. Without a valid cookie this
 * endpoint must not leak the existence of the store, the namespace,
 * or any count.
 *
 * Soft-fails to an empty list when Blob isn't configured.
 */

import { NextResponse } from 'next/server';

import { isAdminRequestAuthed } from '@/lib/family-review/admin-auth';
import {
  listRecentSubmissions,
  storeStatus,
  type FamilyReviewSubmission,
} from '@/lib/family-review/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

export async function GET(req: Request) {
  if (!isAdminRequestAuthed(req)) {
    return NextResponse.json(
      { ok: false, error: 'forbidden' },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), MAX_LIMIT)
      : DEFAULT_LIMIT;

  const status = storeStatus();
  if (!status.enabled) {
    return NextResponse.json(
      {
        ok: true,
        storeEnabled: false,
        reason: status.reason,
        submissions: [] as FamilyReviewSubmission[],
      },
      { status: 200 },
    );
  }

  const submissions = await listRecentSubmissions(limit);

  return NextResponse.json(
    { ok: true, storeEnabled: true, submissions },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
