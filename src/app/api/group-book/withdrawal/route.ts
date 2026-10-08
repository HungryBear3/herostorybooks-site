import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import { resolveGroupBookInvite } from '@/lib/group-book/config';
import { GROUP_BOOK_ACCESS_COOKIE, GROUP_BOOK_PRIVATE_HEADERS } from '@/lib/group-book/session';
import {
  findGroupBookSubmission,
  groupBookStorageReady,
  requestGroupBookWithdrawal,
} from '@/lib/group-book/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  if (!groupBookStorageReady()) {
    return NextResponse.json(
      { ok: false, error: 'storage_disabled' },
      { status: 503, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }
  const token = (await cookies()).get(GROUP_BOOK_ACCESS_COOKIE)?.value ?? '';
  const invite = resolveGroupBookInvite(token);
  if (!invite || !(await findGroupBookSubmission(invite))) {
    return NextResponse.json(
      { ok: false, error: 'not_found' },
      { status: 404, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }
  try {
    const result = await requestGroupBookWithdrawal(invite);
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
