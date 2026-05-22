/**
 * Family & Friends test-portal submission store.
 *
 * Now backed by REAL photo upload + per-submission review tokens. The
 * persistence model:
 *
 *   record JSON  →  {namespace}/family-review/submissions/{submissionId}.json
 *   photo bytes  →  {namespace}/family-review/photos/{submissionId}/{assetId}.{ext}
 *   sample bytes →  {namespace}/family-review/samples/{submissionId}/{assetId}.{ext}
 *
 * Paths intentionally use random submissionId + random assetId — original
 * filenames never leave the parent's device. Blob URLs are unguessable by
 * design (random store id + random submission/asset id) but treated as
 * capabilities and only ever surfaced to:
 *
 *   - the parent, via their crypto-random reviewToken page
 *   - admin reviewers, via the admin-key-gated dashboard
 *
 * When BLOB_READ_WRITE_TOKEN is missing this module returns
 * { enabled: false } and the calling routes return 503 so the parent
 * sees an explicit "private upload is not enabled yet" message instead
 * of a fake success. There is no localStorage fallback for real photo
 * data — only the multi-step form scratch state.
 *
 * NOTE: this module never reads or stores File.name. Original filenames
 * are stripped at the upload boundary in route.ts; see also
 * tests/family-review-no-filename-capture.test.ts.
 */

import { del, get, list, put } from '@vercel/blob';

import { withBlobNamespace } from '../orders';

export type AgeRange = '2-3' | '3-4' | '5-6' | '7-8' | '9-10';
export type Pronoun = 'she/her' | 'he/him' | 'they/them' | 'skip';
export type Direction = 'dinosaur' | 'bedtime' | 'space';
export type BriefId = 'cover-hero' | 'dinosaur-adventure' | 'bedtime-keepsake';

export type SubmissionStatus =
  | 'submitted'
  | 'samples_in_progress'
  | 'samples_ready'
  | 'feedback_received'
  | 'invited_to_order'
  | 'archived';

export interface PhotoAsset {
  assetId: string;
  blobPathname: string;
  blobUrl: string;
  mime: string;
  size: number;
  uploadedAt: string;
}

export interface SampleAsset {
  assetId: string;
  briefId: BriefId;
  blobPathname: string;
  blobUrl: string;
  mime: string;
  size: number;
  uploadedAt: string;
  /** Optional reviewer note that accompanies the sample. */
  note?: string;
}

export interface ParentFeedback {
  /** 1 = far off, 5 = unmistakably them. */
  rating: number;
  favoriteSampleAssetId?: string;
  looksLikeChild: 'yes' | 'somewhat' | 'no';
  notes: string;
  submittedAt: string;
  /** Stable id for the sample pass this feedback describes. */
  sampleRunId?: string;
  /** Sample asset ids visible to the parent when this feedback was saved. */
  sampleAssetIds?: string[];
}

export interface FamilyReviewSubmission {
  /** Random admin-facing id used in the persisted Blob filename. */
  id: string;
  /**
   * Crypto-random URL token used in /family-review/review/{token}. This
   * is the parent's only credential — never expose it to anyone but
   * that parent and admin reviewers.
   */
  reviewToken: string;
  receivedAt: string;
  updatedAt: string;
  parent: {
    name: string;
    email: string;
  };
  child: {
    firstName: string;
    ageRange: AgeRange;
    pronoun: Pronoun | null;
  };
  consent: {
    agreedAt: string;
    version: 'v1';
  };
  photos: {
    /** Number of photos the parent picked client-side. */
    count: number;
    /** True only when bytes were actually stored to Blob. */
    uploadedToServer: boolean;
    /**
     * Photo asset refs. Filenames are intentionally NOT captured — see
     * the guard test for the regression check. Only mime/size/assetId
     * and the random blob path live here.
     */
    assets: PhotoAsset[];
  };
  samples: SampleAsset[];
  /** Stable id for the currently-visible sample pass. */
  currentSampleRunId?: string;
  feedback?: ParentFeedback;
  /** Append-only feedback history, preserving notes from prior sample passes. */
  feedbackHistory?: ParentFeedback[];
  direction: Direction;
  /**
   * We never persist the literal invite code — see the
   * inviteCodeAccepted comment in route.ts.
   */
  inviteCodeAccepted: true;
  status: SubmissionStatus;
  /** Set when admin marks invited_to_order. */
  betaDiscountCode?: string;
  /**
   * ISO timestamp set when the parent clicks "Request deletion" on the
   * private review page. The submission is NOT auto-deleted — admin
   * reviewers see a prominent banner and process deletions manually
   * within 48h per the consent screen.
   */
  deletionRequestedAt?: string;
}

export interface PersistResult {
  persisted: boolean;
  id: string;
  reviewToken: string;
  reason?: 'no_token' | 'put_failed';
}

export function hasBlobToken(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export function submissionPath(id: string): string {
  return withBlobNamespace(`family-review/submissions/${id}.json`);
}

export function reviewTokenPath(token: string): string {
  return withBlobNamespace(`family-review/review-tokens/${token}.json`);
}

export function photoPath(submissionId: string, assetId: string, ext: string): string {
  return withBlobNamespace(
    `family-review/photos/${submissionId}/${assetId}.${ext}`,
  );
}

export function samplePath(submissionId: string, assetId: string, ext: string): string {
  return withBlobNamespace(
    `family-review/samples/${submissionId}/${assetId}.${ext}`,
  );
}

function submissionListPrefix(): string {
  return withBlobNamespace('family-review/submissions/');
}

export async function persistSubmission(
  record: FamilyReviewSubmission,
): Promise<PersistResult> {
  if (!hasBlobToken()) {
    return {
      persisted: false,
      id: record.id,
      reviewToken: record.reviewToken,
      reason: 'no_token',
    };
  }
  try {
    const pathname = submissionPath(record.id);
    await put(pathname, JSON.stringify(record, null, 2), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      cacheControlMaxAge: 0,
      allowOverwrite: true,
    });
    const indexPath = reviewTokenPath(record.reviewToken);
    await put(indexPath, JSON.stringify({ submissionId: record.id }, null, 2), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      cacheControlMaxAge: 0,
      allowOverwrite: true,
    });
    return { persisted: true, id: record.id, reviewToken: record.reviewToken };
  } catch (err) {
    console.error(`[family-review/store] persist failed for ${record.id}:`, err);
    return {
      persisted: false,
      id: record.id,
      reviewToken: record.reviewToken,
      reason: 'put_failed',
    };
  }
}

async function fetchSubmissionAt(url: string): Promise<FamilyReviewSubmission | null> {
  try {
    // Public Blob URLs can be edge-cached even after an overwrite. Admin
    // workflows read-modify-write the same JSON record several times in a
    // row, so cache-bust the read URL or rapid sample uploads can merge
    // against a stale copy and drop previously uploaded samples.
    const freshUrl = new URL(url);
    freshUrl.searchParams.set('__fr_read', `${Date.now()}-${Math.random()}`);
    const res = await fetch(freshUrl.toString(), { cache: 'no-store' });
    if (!res.ok) return null;
    const json = (await res.json()) as FamilyReviewSubmission;
    if (json && typeof json === 'object' && typeof json.id === 'string') {
      return json;
    }
    return null;
  } catch (err) {
    console.warn('[family-review/store] failed to read submission blob:', err);
    return null;
  }
}

async function getJsonAtPath<T>(pathname: string): Promise<T | null> {
  try {
    const result = await get(pathname, { access: 'public' });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text) as T;
  } catch (err) {
    console.warn(`[family-review/store] failed to read blob path ${pathname}:`, err);
    return null;
  }
}

async function fetchSubmissionByPath(
  pathname: string,
): Promise<FamilyReviewSubmission | null> {
  const json = await getJsonAtPath<FamilyReviewSubmission>(pathname);
  if (json && typeof json === 'object' && typeof json.id === 'string') {
    return json;
  }
  return null;
}

export async function listRecentSubmissions(
  limit = 10,
): Promise<FamilyReviewSubmission[]> {
  if (!hasBlobToken()) return [];
  try {
    const prefix = submissionListPrefix();
    const { blobs } = await list({ prefix, limit: Math.min(1000, limit * 4) });
    const sorted = [...blobs].sort((a, b) =>
      a.pathname < b.pathname ? 1 : a.pathname > b.pathname ? -1 : 0,
    );
    const top = sorted.slice(0, limit);
    const parsed: FamilyReviewSubmission[] = [];
    for (const blob of top) {
      const sub = await fetchSubmissionAt(blob.url);
      if (sub) parsed.push(sub);
    }
    return parsed;
  } catch (err) {
    console.error('[family-review/store] list failed:', err);
    return [];
  }
}

/**
 * Look up by id (admin-facing). Read the exact blob path through the
 * Blob API instead of list()+public URL fetch; list is eventually
 * consistent enough to miss a just-created submission during admin
 * sample upload.
 */
export async function findById(
  id: string,
): Promise<FamilyReviewSubmission | null> {
  if (!hasBlobToken()) return null;
  return await fetchSubmissionByPath(submissionPath(id));
}

/**
 * Look up by parent-private review token. The token is the parent's
 * capability — admin can also use it. The token index avoids both
 * full-store scans and eventual-consistency misses immediately after
 * submit.
 */
export async function findByReviewToken(
  token: string,
): Promise<FamilyReviewSubmission | null> {
  if (!hasBlobToken()) return null;
  try {
    const index = await getJsonAtPath<{ submissionId?: string }>(
      reviewTokenPath(token),
    );
    if (index?.submissionId) {
      return await findById(index.submissionId);
    }
  } catch (err) {
    console.error('[family-review/store] findByReviewToken failed:', err);
  }
  return null;
}

/** Cheap status flag used by routes + the admin UI. */
export function storeStatus(): { enabled: boolean; reason?: 'no_token' } {
  if (!hasBlobToken()) return { enabled: false, reason: 'no_token' };
  return { enabled: true };
}

/**
 * Upload a single photo's bytes to Blob and return its asset ref. The
 * caller passes the raw bytes and content-type from the multipart form
 * — File.name is intentionally never passed in.
 */
export async function uploadPhotoBytes(args: {
  submissionId: string;
  assetId: string;
  bytes: Buffer | Uint8Array;
  mime: string;
  ext: string;
}): Promise<PhotoAsset> {
  const pathname = photoPath(args.submissionId, args.assetId, args.ext);
  const result = await put(pathname, args.bytes as Buffer, {
    access: 'public',
    addRandomSuffix: false,
    contentType: args.mime,
    cacheControlMaxAge: 31536000,
  });
  return {
    assetId: args.assetId,
    blobPathname: pathname,
    blobUrl: result.url,
    mime: args.mime,
    size: args.bytes.byteLength,
    uploadedAt: new Date().toISOString(),
  };
}

export async function uploadSampleBytes(args: {
  submissionId: string;
  assetId: string;
  briefId: BriefId;
  bytes: Buffer | Uint8Array;
  mime: string;
  ext: string;
  note?: string;
}): Promise<SampleAsset> {
  const pathname = samplePath(args.submissionId, args.assetId, args.ext);
  const result = await put(pathname, args.bytes as Buffer, {
    access: 'public',
    addRandomSuffix: false,
    contentType: args.mime,
    cacheControlMaxAge: 31536000,
  });
  return {
    assetId: args.assetId,
    briefId: args.briefId,
    blobPathname: pathname,
    blobUrl: result.url,
    mime: args.mime,
    size: args.bytes.byteLength,
    uploadedAt: new Date().toISOString(),
    ...(args.note ? { note: args.note } : {}),
  };
}

/** Best-effort sample delete used when admin replaces a sample for a brief. */
export async function deleteBlob(pathname: string): Promise<void> {
  if (!hasBlobToken()) return;
  try {
    await del(pathname);
  } catch (err) {
    console.warn(`[family-review/store] delete ${pathname} failed:`, err);
  }
}
