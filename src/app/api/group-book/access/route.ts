import { NextResponse } from 'next/server';

import { extractGroupBookToken, resolveGroupBookInvite } from '@/lib/group-book/config';
import { GROUP_BOOK_PRIVATE_HEADERS, setGroupBookAccessCookie } from '@/lib/group-book/session';
import { findGroupBookSubmission, groupBookStorageReady } from '@/lib/group-book/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!groupBookStorageReady()) {
    return NextResponse.json(
      { ok: false, error: 'storage_disabled' },
      { status: 503, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_json' },
      { status: 400, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }
  const token = extractGroupBookToken(
    typeof (raw as { invite?: unknown })?.invite === 'string'
      ? (raw as { invite: string }).invite
      : '',
  );
  const invite = token ? resolveGroupBookInvite(token) : null;
  if (!invite) {
    return NextResponse.json(
      { ok: false, error: 'invalid_invite' },
      { status: 403, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }
  const record = await findGroupBookSubmission(invite);
  if (!record) {
    return NextResponse.json(
      { ok: false, error: 'not_submitted' },
      { status: 404, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }
  const response = NextResponse.json(
    { ok: true, accessUrl: '/group-book/family' },
    { status: 200, headers: GROUP_BOOK_PRIVATE_HEADERS },
  );
  setGroupBookAccessCookie(response, token!);
  return response;
}
