import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { classroomOriginAllowed } from '@/lib/group-book/identity-access';

import { GROUP_BOOK_ACCESS_COOKIE, GROUP_BOOK_PRIVATE_HEADERS } from '@/lib/group-book/session';
import { loadGroupBookReleaseState } from '@/lib/group-book/retention';
import {
  groupBookStorageReady,
  loadOwnFamilySubmission,
  requestGroupBookWithdrawal,
} from '@/lib/group-book/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The browser posts to /group-book/family/withdraw, which re-exports this
// handler so the /group-book-scoped access cookie is actually sent. This API
// path stays for compatibility; a browser never sends the cookie here.
export async function POST(req?: Request) {
  if (req && !classroomOriginAllowed(req)) return NextResponse.json({ok:false,error:'invalid_origin'},{status:403,headers:GROUP_BOOK_PRIVATE_HEADERS});
  if (!groupBookStorageReady()) {
    return NextResponse.json(
      { ok: false, error: 'storage_disabled' },
      { status: 503, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }
  const token = (await cookies()).get(GROUP_BOOK_ACCESS_COOKIE)?.value ?? '';
  // Only an active (unexpired, unrevoked) capability may act, on its own family.
  let own: Awaited<ReturnType<typeof loadOwnFamilySubmission>>;
  try {
    own = await loadOwnFamilySubmission(token, (await cookies()).toString());
  } catch {
    return NextResponse.json(
      { ok: false, error: 'storage_unavailable' },
      { status: 503, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }
  if (own.state !== 'found') {
    return NextResponse.json(
      { ok: false, error: 'not_found' },
      { status: 404, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }
  // Adopted policy: withdrawal guarantees OMIT only until the FIRST final
  // release to printing or distribution (the recorded release, never the
  // later delivery). Released copies are not recalled. An existing withdrawal
  // stays recorded; an unknown release state refuses.
  if (own.submission.effectiveStatus !== 'withdrawal_requested') {
    const release = await loadGroupBookReleaseState(own.invite.cohortId);
    if (release.state !== 'none') {
      return NextResponse.json(
        { ok: false, error: release.state === 'recorded' ? 'edition_already_released' : 'storage_unavailable' },
        { status: release.state === 'recorded' ? 409 : 503, headers: GROUP_BOOK_PRIVATE_HEADERS },
      );
    }
  }
  try {
    const result = await requestGroupBookWithdrawal(own.invite);
    return NextResponse.json(
      { ok: true, omitFromProofAndPrint: true, requestedAt: result.requestedAt },
      { status: 200, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: 'withdrawal_failed' },
      { status: 500, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }
}
