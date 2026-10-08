import { NextResponse } from 'next/server';

import { extractGroupBookToken, resolveGroupBookInvite } from '@/lib/group-book/config';
import { resolveGroupBookImage } from '@/lib/group-book/image-type';
import { GROUP_BOOK_PRIVATE_HEADERS, setGroupBookAccessCookie } from '@/lib/group-book/session';
import {
  buildGroupBookSubmission,
  createGroupBookSubmission,
  deleteGroupBookPhotos,
  findGroupBookSubmission,
  groupBookStorageReady,
  uploadGroupBookPhoto,
  type GroupBookAgeRange,
  type GroupBookPhotoAsset,
} from '@/lib/group-book/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const AGE_RANGES = new Set<GroupBookAgeRange>(['2-3', '3-4', '5-6', '7-8', '9-10', '10+']);

function text(form: FormData, name: string, max: number): string | null {
  const value = form.get(name);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function emailLooksValid(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function success(token: string, alreadySubmitted: boolean) {
  const response = NextResponse.json(
    { ok: true, alreadySubmitted, accessUrl: '/group-book/family' },
    { status: 200, headers: GROUP_BOOK_PRIVATE_HEADERS },
  );
  setGroupBookAccessCookie(response, token);
  return response;
}

export async function POST(req: Request) {
  if (!groupBookStorageReady()) {
    return NextResponse.json(
      { ok: false, error: 'storage_disabled' },
      { status: 503, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_form' },
      { status: 400, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }

  const token = extractGroupBookToken(text(form, 'invite', 2000) ?? '');
  const invite = token ? resolveGroupBookInvite(token) : null;
  if (!token || !invite) {
    return NextResponse.json(
      { ok: false, error: 'invalid_invite' },
      { status: 403, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }
  if (await findGroupBookSubmission(invite)) return success(token, true);

  const parentName = text(form, 'parentName', 80);
  const parentEmail = text(form, 'parentEmail', 200);
  const childFirstName = text(form, 'childFirstName', 40);
  const ageRange = text(form, 'ageRange', 12) as GroupBookAgeRange | null;
  const characterNotes = text(form, 'characterNotes', 600) ?? '';
  const consentComplete =
    form.get('guardianAuthority') === 'true' &&
    form.get('sharedWithParticipatingFamilies') === 'true' &&
    form.get('sourcePhotosRemainPrivate') === 'true' &&
    form.get('schoolApprovalNotRepresentedOrImplied') === 'true';
  if (
    !parentName || !parentEmail || !emailLooksValid(parentEmail) ||
    !childFirstName || !ageRange || !AGE_RANGES.has(ageRange) || !consentComplete
  ) {
    return NextResponse.json(
      { ok: false, error: 'missing_or_invalid_fields' },
      { status: 422, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }

  const files = form.getAll('photos').filter((value): value is File => value instanceof File);
  if (files.length < 1 || files.length > MAX_FILES) {
    return NextResponse.json(
      { ok: false, error: 'invalid_photo_count' },
      { status: 422, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }

  const prepared: { bytes: Buffer; mime: string; ext: string }[] = [];
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { ok: false, error: 'photo_too_large' },
        { status: 413, headers: GROUP_BOOK_PRIVATE_HEADERS },
      );
    }
    const type = await resolveGroupBookImage(file);
    if (!type) {
      return NextResponse.json(
        { ok: false, error: 'unsupported_image' },
        { status: 415, headers: GROUP_BOOK_PRIVATE_HEADERS },
      );
    }
    prepared.push({ bytes: Buffer.from(await file.arrayBuffer()), ...type });
  }

  const uploaded: GroupBookPhotoAsset[] = [];
  try {
    for (const photo of prepared) {
      uploaded.push(await uploadGroupBookPhoto({ invite, ...photo }));
    }
  } catch (err) {
    await deleteGroupBookPhotos(uploaded);
    console.error('[group-book/intake] private upload failed:', err instanceof Error ? err.name : 'unknown');
    return NextResponse.json(
      { ok: false, error: 'private_upload_failed' },
      { status: 502, headers: GROUP_BOOK_PRIVATE_HEADERS },
    );
  }

  const record = buildGroupBookSubmission({
    invite,
    parentName,
    parentEmail,
    childFirstName,
    ageRange,
    characterNotes,
    photos: uploaded,
  });
  if (await createGroupBookSubmission(record)) return success(token, false);

  // A concurrent request may have won the create-only family record. Never
  // overwrite it; clean up only this request's random-path assets.
  await deleteGroupBookPhotos(uploaded);
  if (await findGroupBookSubmission(invite)) return success(token, true);
  return NextResponse.json(
    { ok: false, error: 'record_persist_failed' },
    { status: 502, headers: GROUP_BOOK_PRIVATE_HEADERS },
  );
}
