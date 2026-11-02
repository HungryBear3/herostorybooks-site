import { NextResponse } from 'next/server';

import { extractGroupBookToken, inviteRefusal } from '@/lib/group-book/config';
import { resolveGroupBookSessionInvite, classroomOriginAllowed } from '@/lib/group-book/identity-access';
import { groupBookAdmission, publicPolicyView } from '@/lib/group-book/release';
import { GROUP_BOOK_PRIVATE_HEADERS, setGroupBookAccessCookie } from '@/lib/group-book/session';
import { findGroupBookSubmission, groupBookStorageReady } from '@/lib/group-book/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function refuse(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status, headers: GROUP_BOOK_PRIVATE_HEADERS });
}

export async function POST(req: Request) {
  if (!classroomOriginAllowed(req)) return refuse('invalid_origin', 403);
  if (!groupBookStorageReady()) return refuse('storage_disabled', 503);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return refuse('invalid_json', 400);
  }
  const token = extractGroupBookToken(
    typeof (raw as { invite?: unknown })?.invite === 'string'
      ? (raw as { invite: string }).invite
      : '',
  );
  const resolved = token ? await resolveGroupBookSessionInvite(token, req.headers.get('cookie') ?? '', true) : { state: 'unknown' as const };
  if (!token || resolved.state !== 'active') return refuse(inviteRefusal(resolved.state), 403);
  let record: Awaited<ReturnType<typeof findGroupBookSubmission>>;
  try {
    record = await findGroupBookSubmission(resolved.invite);
  } catch {
    return refuse('storage_unavailable', 503);
  }
  if (!record) {
    // New intake is offered only when admission is open, with the exact
    // owner-adopted policy text the parent will consent to.
    const admission = groupBookAdmission();
    if (admission.open === false) return refuse(admission.refusal, 403);
    return refuse('not_submitted', 404, { policy: publicPolicyView(admission.policy) });
  }
  const response = NextResponse.json(
    { ok: true, accessUrl: '/group-book/family' },
    { status: 200, headers: GROUP_BOOK_PRIVATE_HEADERS },
  );
  setGroupBookAccessCookie(response, token, resolved.invite.expiresAt);
  return response;
}
