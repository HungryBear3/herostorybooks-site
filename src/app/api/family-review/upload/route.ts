/**
 * POST /api/family-review/upload  (multipart/form-data)
 *
 * Single atomic submission endpoint: accepts the parent's form fields
 * AND their 1–5 reference photo files in one request, uploads photo
 * bytes to Vercel Blob under a random submissionId + random assetId,
 * persists the submission record, and returns the private review
 * token URL the parent should be redirected to.
 *
 * Hard guards:
 *   - Server-side invite-code gate (defense in depth)
 *   - 503 if BLOB_READ_WRITE_TOKEN is not set — do NOT pretend upload
 *     worked. The portal surfaces this as "private upload is not
 *     enabled yet".
 *   - Per-file size limit (10 MB) and mime allowlist
 *   - Max 5 photos
 *   - File.name from the multipart frame is intentionally discarded;
 *     only mime + bytes + size are kept, with paths derived from
 *     random asset ids.
 *
 * This route never calls Stripe, Lulu, OpenAI/Gemini/fal, fulfillment,
 * webhooks, or the public order pipeline.
 */

import { NextResponse } from 'next/server';

import {
  hasBlobToken,
  persistSubmission,
  uploadPhotoBytes,
  type FamilyReviewSubmission,
  type AgeRange,
  type Direction,
  type Pronoun,
} from '@/lib/family-review/store';
import { resolveUploadImageType } from '@/lib/family-review/image-type';
import {
  hashReviewToken,
  newAssetId,
  newReviewToken,
  newSubmissionId,
} from '@/lib/family-review/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_INVITE_CODES = ['hazel-meadow', 'family-test'];

const MAX_BYTES_PER_FILE = 10 * 1024 * 1024;
const MAX_FILES = 5;

function serverInviteCodes(): string[] {
  const raw =
    process.env.FAMILY_REVIEW_CODES ??
    process.env.NEXT_PUBLIC_FAMILY_REVIEW_CODES ??
    '';
  if (!raw.trim()) return DEFAULT_INVITE_CODES;
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const AGE_RANGES = new Set<AgeRange>(['2-3', '3-4', '5-6', '7-8', '9-10']);
const PRONOUNS = new Set<Pronoun>(['she/her', 'he/him', 'they/them', 'skip']);
const DIRECTIONS = new Set<Direction>(['dinosaur', 'bedtime', 'space']);

function readString(v: FormDataEntryValue | null, max: number): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function extractInviteCodeFromText(value: string): string {
  const normalized = value.trim().toLowerCase();
  const embeddedCode = normalized.match(/\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/);
  if (embeddedCode) return embeddedCode[0];
  return normalized;
}

function emailLooksValid(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

export async function POST(req: Request) {
  // 0. Storage gate — if we have no Blob token there is no real
  // private capture surface; do NOT pretend upload worked.
  if (!hasBlobToken()) {
    return NextResponse.json(
      {
        ok: false,
        error: 'storage_disabled',
        message:
          "Private photo upload isn't enabled in this environment yet. Please reply to your invite email — your reviewer will collect the details and reference photos manually.",
      },
      { status: 503 },
    );
  }

  // 1. Parse multipart form
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_form' },
      { status: 400 },
    );
  }

  // 2. Invite-code gate
  const inviteRaw = readString(form.get('inviteCode'), 1200);
  const invite = inviteRaw ? extractInviteCodeFromText(inviteRaw) : null;
  if (!invite || !serverInviteCodes().includes(invite)) {
    return NextResponse.json(
      { ok: false, error: 'invalid_invite_code' },
      { status: 403 },
    );
  }

  // 3. Required text fields
  const parentName = readString(form.get('parentName'), 80);
  const parentEmailRaw = readString(form.get('parentEmail'), 200);
  const childFirstName = readString(form.get('childFirstName'), 40);
  const ageRangeRaw = readString(form.get('ageRange'), 10);
  const directionRaw = readString(form.get('direction'), 20);
  const consent = form.get('consent') === 'true';

  if (
    !parentName ||
    !parentEmailRaw ||
    !emailLooksValid(parentEmailRaw) ||
    !childFirstName ||
    !ageRangeRaw ||
    !AGE_RANGES.has(ageRangeRaw as AgeRange) ||
    !directionRaw ||
    !DIRECTIONS.has(directionRaw as Direction) ||
    !consent
  ) {
    return NextResponse.json(
      { ok: false, error: 'missing_or_invalid_fields' },
      { status: 422 },
    );
  }

  // 4. Optional pronouns
  const pronounRaw = readString(form.get('pronoun'), 20);
  const pronoun: Pronoun | null =
    pronounRaw && PRONOUNS.has(pronounRaw as Pronoun)
      ? (pronounRaw as Pronoun)
      : null;

  // 5. Photo files — File.name is NEVER read. We pull bytes/mime only.
  const fileEntries = form
    .getAll('photos')
    .filter((entry): entry is File => entry instanceof File);
  if (fileEntries.length === 0 || fileEntries.length > MAX_FILES) {
    return NextResponse.json(
      {
        ok: false,
        error: 'invalid_photo_count',
        message: `Send 1–${MAX_FILES} photos.`,
      },
      { status: 422 },
    );
  }

  const preparedPhotos: { file: File; mime: string; ext: string }[] = [];
  for (const file of fileEntries) {
    if (file.size > MAX_BYTES_PER_FILE) {
      return NextResponse.json(
        {
          ok: false,
          error: 'photo_too_large',
          message: `One of the photos is bigger than 10 MB.`,
        },
        { status: 413 },
      );
    }
    const resolved = await resolveUploadImageType(file);
    if (!resolved) {
      return NextResponse.json(
        {
          ok: false,
          error: 'unsupported_mime',
          message: `One of the photos is not a supported image type (jpg / png / webp / heic).`,
        },
        { status: 415 },
      );
    }
    preparedPhotos.push({ file, ...resolved });
  }

  // 6. Generate ids + upload bytes
  const submissionId = newSubmissionId();
  const reviewToken = newReviewToken();

  const photoAssets = [];
  for (const photo of preparedPhotos) {
    const assetId = newAssetId();
    const buf = Buffer.from(await photo.file.arrayBuffer());
    try {
      const asset = await uploadPhotoBytes({
        submissionId,
        assetId,
        bytes: buf,
        mime: photo.mime,
        ext: photo.ext,
      });
      photoAssets.push(asset);
    } catch (err) {
      console.error(
        `[family-review/upload] photo upload failed (submission=${submissionId}):`,
        err,
      );
      return NextResponse.json(
        {
          ok: false,
          error: 'photo_upload_failed',
          message:
            "One of the photos didn't upload. Please try again — nothing has been recorded for this submission yet.",
        },
        { status: 502 },
      );
    }
  }

  // 7. Persist record
  const now = new Date();
  // The raw reviewToken is NEVER persisted. Storage addresses the
  // parent's capability only through its sha256 digest; the raw value
  // leaves this process exactly once, in the success response below.
  const record: FamilyReviewSubmission = {
    id: submissionId,
    reviewTokenHash: hashReviewToken(reviewToken),
    receivedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    parent: { name: parentName, email: parentEmailRaw.toLowerCase() },
    child: {
      firstName: childFirstName,
      ageRange: ageRangeRaw as AgeRange,
      pronoun: pronoun && pronoun !== 'skip' ? pronoun : null,
    },
    consent: { agreedAt: now.toISOString(), version: 'v1' },
    photos: {
      count: photoAssets.length,
      uploadedToServer: true,
      assets: photoAssets,
    },
    samples: [],
    direction: directionRaw as Direction,
    inviteCodeAccepted: true,
    status: 'submitted',
  };

  const result = await persistSubmission(record);
  if (!result.persisted) {
    // Photos already uploaded but record didn't save — caller cannot
    // reach this submission. Best-effort: surface a clear error so we
    // can clean up manually. We deliberately do not silently mark it
    // device-only — the parent would have no way to follow up.
    console.error(
      `[family-review/upload] record persist failed (submission=${submissionId}, reason=${result.reason ?? 'unknown'}). Photo bytes are orphaned in Blob and need manual cleanup.`,
    );
    return NextResponse.json(
      {
        ok: false,
        error: 'record_persist_failed',
        message:
          "Your photos uploaded but we couldn't save the form details. Please reply to your invite email — your reviewer can finish the record manually.",
      },
      { status: 500 },
    );
  }

  // First and only issuance of the raw token. There is no later
  // server-side path that can reproduce this link — see
  // CC-FINAL-HANDOFF.md.
  return NextResponse.json(
    {
      ok: true,
      submissionId,
      reviewToken,
      reviewUrl: `/family-review/review/${reviewToken}`,
    },
    { status: 200 },
  );
}
