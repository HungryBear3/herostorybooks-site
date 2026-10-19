import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { adminAdmissionView, assembleGroupBookExport } from '@/lib/group-book/export';
import { GROUP_BOOK_PRIVATE_HEADERS } from '@/lib/group-book/session';
import { groupBookStorageReady } from '@/lib/group-book/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COHORT_RE = /^[A-Za-z0-9_-]{3,64}$/;

/**
 * Operator export/assembly handoff. Uses the existing admin credential, loads
 * the cohort's current effective participants, and then stops at an explicit
 * HOLD: there is no group-book artifact producer, and the private store cannot
 * publish atomically against a concurrent withdrawal. No book, page, image,
 * proof or print work happens here.
 */
export async function POST(req: Request) {
  if (!isAdminAuthedFromRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: GROUP_BOOK_PRIVATE_HEADERS });
  }
  if (!groupBookStorageReady()) {
    return NextResponse.json({ ok: false, error: 'storage_disabled' }, { status: 503, headers: GROUP_BOOK_PRIVATE_HEADERS });
  }
  let cohortId: unknown;
  try {
    cohortId = ((await req.json()) as { cohortId?: unknown })?.cohortId;
  } catch {
    cohortId = undefined;
  }
  if (typeof cohortId !== 'string' || !COHORT_RE.test(cohortId)) {
    return NextResponse.json({ ok: false, error: 'invalid_cohort' }, { status: 400, headers: GROUP_BOOK_PRIVATE_HEADERS });
  }
  const outcome = await assembleGroupBookExport({ cohortId, publisher: null });
  if (outcome.state === 'published') {
    // Unreachable with publisher: null; refuse rather than claim publication.
    return NextResponse.json({ ok: false, error: 'unexpected_publication' }, { status: 500, headers: GROUP_BOOK_PRIVATE_HEADERS });
  }
  return NextResponse.json(
    {
      ok: false,
      hold: 'GROUP_BOOK_EXPORT_HOLD',
      reason: outcome.state === 'hold' ? outcome.reason : 'no_group_book_artifact_producer',
      admissionRefusal: outcome.state === 'refused' ? outcome.reason : null,
      admission: adminAdmissionView(outcome.admission),
    },
    { status: 503, headers: GROUP_BOOK_PRIVATE_HEADERS },
  );
}
