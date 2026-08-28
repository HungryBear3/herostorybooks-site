/**
 * Family & Friends test-portal submission store.
 *
 * Now backed by REAL photo upload + per-submission review tokens. The
 * persistence model:
 *
 *   record JSON  →  {namespace}/family-review/submissions/{submissionId}.json
 *   photo bytes  →  {namespace}/family-review/photos/{submissionId}/{assetId}.{ext}
 *   sample bytes →  {namespace}/family-review/samples/{submissionId}/{assetId}.{ext}
 *   token index  →  {namespace}/family-review/review-tokens/{sha256(token)}.json
 *
 * STORAGE ACCESS. Asset bytes and the record JSON are written with the
 * mode chosen by FAMILY_REVIEW_BLOB_ACCESS (see ./private-assets.ts).
 * The default is still 'public' — the production store is provisioned
 * as a public store and rejects private writes — so the pathname-as-
 * capability reasoning below remains in force until an operator
 * provisions a private store and flips the flag.
 *
 * TOKEN PRIVACY (Lane B). While objects are public the pathname IS the
 * capability. Two rules follow and are enforced by
 * tests/family-review-token-privacy.test.ts:
 *
 *   1. The parent's raw reviewToken is NEVER persisted and NEVER appears
 *      in a pathname. Storage addresses it only through
 *      hashReviewToken(). The raw token is handed to the parent exactly
 *      once, in the creation response from /api/family-review/upload.
 *   2. Every read goes through normalizeSubmissionRecord() and every
 *      write goes through sanitizeSubmissionForPersistence(), so a
 *      legacy record that still carries plaintext is scrubbed on the way
 *      in and cannot be resurrected by a generic read-modify-write.
 *
 * Records written before this hardening still carry a plaintext
 * reviewToken and are indexed under the raw token. They remain READABLE
 * for bounded compatibility (see reviewTokenLookupPaths) — nothing here
 * migrates, rewrites, or re-permissions an existing object.
 *
 * Paths intentionally use random submissionId + random assetId — original
 * filenames never leave the parent's device. Blob URLs are unguessable by
 * design (random store id + 128-bit submission id + random asset id) but
 * treated as capabilities and only ever surfaced to:
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

import { get, list, put } from '@vercel/blob';

import { withBlobNamespace } from '../orders.ts';
import {
  familyReviewPrivateToken,
  familyReviewPrivateTokenProblem,
} from './blob-credentials.ts';
import {
  deleteAsset,
  familyReviewAssetStorageMode,
  legacyPublicAssetReadsAllowed,
  putAsset,
  type AssetStorage,
} from './private-assets.ts';
import { hashReviewToken, isWellFormedReviewTokenHash } from './tokens.ts';

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
  /**
   * LEGACY ONLY. Present on assets written while the lane stored bytes
   * publicly. A private asset has NO url — blobPathname is the whole
   * reference, and it is useless without the store token.
   */
  blobUrl?: string;
  /** How the bytes are addressed. Absent on pre-migration records = public. */
  storage?: AssetStorage;
  mime: string;
  size: number;
  uploadedAt: string;
}

export interface SampleAsset {
  assetId: string;
  briefId: BriefId;
  blobPathname: string;
  /** LEGACY ONLY — see PhotoAsset.blobUrl. */
  blobUrl?: string;
  /** How the bytes are addressed. Absent on pre-migration records = public. */
  storage?: AssetStorage;
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
  /** Opaque 128-bit id used in the persisted Blob pathname. */
  id: string;
  /**
   * LEGACY / ECHO ONLY — never persisted.
   *
   * Records written before the Lane B hardening carry the parent's raw
   * capability token here; normalizeSubmissionRecord() strips it on read
   * and sanitizeSubmissionForPersistence() strips it on write.
   *
   * findByReviewToken() re-attaches the CALLER-SUPPLIED token to the
   * in-memory result so the parent's own page can keep building its own
   * links. That echo is the caller's own credential, never a stored one,
   * and it is stripped again before anything is written.
   */
  reviewToken?: string;
  /**
   * sha256 of the parent's review token. This is how the token index is
   * addressed, and it is the only token-derived value ever persisted.
   * Optional only because legacy records predate it — it is derived from
   * the legacy plaintext on read.
   */
  reviewTokenHash?: string;
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
  /** Digest the token index was written under; never the raw token. */
  reviewTokenHash?: string;
  reason?: 'no_token' | 'put_failed' | 'no_token_hash' | 'no_private_token';
}

/**
 * Exactly what persistSubmission is about to write. Split out so the
 * privacy guarantees (no raw token in any pathname, no raw token in any
 * serialized byte) are assertable in-process with zero network access.
 */
export interface PersistPlan {
  submissionPathname: string;
  submissionBody: string;
  /** Digest the index is addressed by; null for an unaddressable record. */
  reviewTokenHash: string | null;
  /** null only when a record carries neither a digest nor a legacy token. */
  indexPathname: string | null;
  indexBody: string | null;
}

/**
 * Whether this lane has a usable store credential for its CONFIGURED
 * mode. The routes' 503 `storage_disabled` gate.
 *
 * Public mode: the ambient app-wide token, exactly as before.
 *
 * Private mode: the lane's OWN token (see ./blob-credentials.ts). The
 * ambient one is not consulted and is not a fallback — it names the
 * order lane's store, and serving Family Review out of it while the
 * configuration says 'private' is the failure this gate exists to
 * prevent. A private deployment with no usable dedicated credential
 * therefore refuses at the door, before any SDK or network call, with
 * the same honest `storage_disabled` response an unconfigured
 * deployment already returns.
 */
export function hasBlobToken(): boolean {
  if (familyReviewAssetStorageMode() === 'private') {
    const problem = familyReviewPrivateTokenProblem();
    if (problem) {
      // Names the variable and the fault. Never the value.
      console.error(`[family-review/store] private mode is not usable: ${problem}`);
      return false;
    }
    return true;
  }
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/**
 * SDK options for a store operation in the CONFIGURED mode: `{}` in
 * public mode, `{ token }` in private mode.
 *
 * `null` means private mode with no usable credential; the caller must
 * refuse rather than issue the call, because an empty option object
 * would address the ambient (order-lane) store.
 */
function storeTokenOptionsOrNull(): { token?: string } | null {
  if (familyReviewAssetStorageMode() !== 'private') return {};
  const token = familyReviewPrivateToken();
  return token ? { token } : null;
}

export function submissionPath(id: string): string {
  return withBlobNamespace(`family-review/submissions/${id}.json`);
}

/**
 * Token index address for NEW records: keyed by sha256(reviewToken), so
 * the raw token never appears in a pathname.
 */
export function reviewTokenIndexPath(tokenHash: string): string {
  return withBlobNamespace(`family-review/review-tokens/${tokenHash}.json`);
}

/**
 * BOUNDED COMPATIBILITY ONLY — the pre-hardening index address, keyed by
 * the raw token. Never written to any more; read (and deleted) so parents
 * holding a link issued before the hardening are not locked out.
 *
 * Lane C removes this together with the objects it addresses.
 */
export function legacyRawReviewTokenPath(token: string): string {
  return withBlobNamespace(`family-review/review-tokens/${token}.json`);
}

/**
 * Index addresses to try for a presented token, digest first. A legacy
 * record resolves through the second entry until it is next written, at
 * which point it also gains a digest index.
 */
export function reviewTokenLookupPaths(token: string): string[] {
  return [
    reviewTokenIndexPath(hashReviewToken(token)),
    legacyRawReviewTokenPath(token),
  ];
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

/** Bounds on the admin "recent submissions" scan. */
const LIST_PAGE_SIZE = 250;
const MAX_LIST_PAGES = 4;

/**
 * Plaintext-token property names that must never survive into a
 * persisted object, whatever shape the caller handed us.
 */
const PLAINTEXT_TOKEN_KEYS = [
  'reviewToken',
  'rawReviewToken',
  'review_token',
] as const;

/** The digest for a record, derived from legacy plaintext if needed. */
function tokenHashFor(record: {
  reviewTokenHash?: unknown;
  reviewToken?: unknown;
}): string | null {
  if (
    typeof record.reviewTokenHash === 'string' &&
    isWellFormedReviewTokenHash(record.reviewTokenHash)
  ) {
    return record.reviewTokenHash;
  }
  if (typeof record.reviewToken === 'string' && record.reviewToken) {
    return hashReviewToken(record.reviewToken);
  }
  return null;
}

/**
 * THE single persistence serializer input filter.
 *
 * Strips every plaintext token field — defensively, even when handed a
 * raw legacy-shaped object read straight out of Blob — and pins the
 * digest so the record stays index-addressable. Every write path goes
 * through this, which is what stops a generic read-modify-write (status,
 * sample, feedback, deletion-request) from resurrecting plaintext.
 */
export function sanitizeSubmissionForPersistence(
  record: FamilyReviewSubmission,
): FamilyReviewSubmission {
  const clone: Record<string, unknown> = { ...(record as object) };
  const hash = tokenHashFor(record);
  for (const key of PLAINTEXT_TOKEN_KEYS) delete clone[key];
  if (hash) clone.reviewTokenHash = hash;
  else delete clone.reviewTokenHash;
  return clone as unknown as FamilyReviewSubmission;
}

/**
 * THE single shared read normalizer.
 *
 * Applied to every record read out of Blob before it becomes a generic
 * application record. Legacy plaintext is converted to its digest and
 * then dropped, so no caller — admin list, admin detail, route handler,
 * server component — ever sees a stored raw token.
 */
export function normalizeSubmissionRecord(
  raw: unknown,
): FamilyReviewSubmission | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<FamilyReviewSubmission>;
  if (typeof candidate.id !== 'string' || !candidate.id) return null;
  return sanitizeSubmissionForPersistence(candidate as FamilyReviewSubmission);
}

/**
 * Everything persistSubmission is about to write, with no side effects.
 */
export function buildPersistPlan(record: FamilyReviewSubmission): PersistPlan {
  const safe = sanitizeSubmissionForPersistence(record);
  const hash = safe.reviewTokenHash ?? null;
  return {
    submissionPathname: submissionPath(safe.id),
    submissionBody: JSON.stringify(safe, null, 2),
    reviewTokenHash: hash,
    indexPathname: hash ? reviewTokenIndexPath(hash) : null,
    indexBody: hash
      ? JSON.stringify({ submissionId: safe.id }, null, 2)
      : null,
  };
}

export async function persistSubmission(
  record: FamilyReviewSubmission,
): Promise<PersistResult> {
  const plan = buildPersistPlan(record);
  if (!hasBlobToken()) {
    return {
      persisted: false,
      id: record.id,
      ...(plan.reviewTokenHash
        ? { reviewTokenHash: plan.reviewTokenHash }
        : {}),
      reason: 'no_token',
    };
  }
  if (!plan.indexPathname || !plan.indexBody) {
    // No digest and no legacy plaintext to derive one from: the record
    // would be written but unreachable by its own capability link. Fail
    // loudly rather than persist an orphan.
    console.error(
      `[family-review/store] refusing to persist ${record.id} — no review token digest`,
    );
    return { persisted: false, id: record.id, reason: 'no_token_hash' };
  }
  // The submission record carries the parent's email, the child's first
  // name, and free-text feedback — the highest-PII object in the lane.
  // It is written with the SAME access mode as the asset bytes, so a
  // private lane leaves no world-readable copy of it.
  const access = familyReviewAssetStorageMode();
  // The record and its token index go to the SAME store as the asset
  // bytes. In private mode that is the lane's own store, addressed by
  // its own token; a missing credential refuses here rather than
  // writing the highest-PII object in the lane into the order store.
  const tokenOptions = storeTokenOptionsOrNull();
  if (tokenOptions === null) {
    return { persisted: false, id: record.id, reason: 'no_private_token' };
  }
  try {
    await put(plan.submissionPathname, plan.submissionBody, {
      access,
      ...tokenOptions,
      addRandomSuffix: false,
      contentType: 'application/json',
      cacheControlMaxAge: 0,
      allowOverwrite: true,
    });
    await put(plan.indexPathname, plan.indexBody, {
      access,
      ...tokenOptions,
      addRandomSuffix: false,
      contentType: 'application/json',
      cacheControlMaxAge: 0,
      allowOverwrite: true,
    });
    return {
      persisted: true,
      id: record.id,
      ...(plan.reviewTokenHash
        ? { reviewTokenHash: plan.reviewTokenHash }
        : {}),
    };
  } catch (err) {
    console.error(`[family-review/store] persist failed for ${record.id}:`, err);
    return { persisted: false, id: record.id, reason: 'put_failed' };
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
    return normalizeSubmissionRecord(await res.json());
  } catch (err) {
    console.warn('[family-review/store] failed to read submission blob:', err);
    return null;
  }
}

/**
 * Read one JSON object, honoring the configured access mode.
 *
 * A private-mode deployment still has to read records written before the
 * migration, so a private miss falls back ONCE to a public read — the
 * same bounded-compatibility shape the legacy token index uses, and
 * gated by the same switch. This applies only to the record JSON. Asset
 * BYTES never fall back (see private-assets.openAsset).
 */
async function getJsonAtPath<T>(pathname: string): Promise<T | null> {
  const mode = familyReviewAssetStorageMode();
  // No usable dedicated credential in private mode is a STOP, not a
  // reason to try the public attempt: a private lane must never quietly
  // satisfy a read out of the ambient public store. Returning here also
  // means no SDK call is made at all.
  const privateToken = mode === 'private' ? familyReviewPrivateToken() : null;
  if (mode === 'private' && !privateToken) return null;
  const attempts: ('private' | 'public')[] =
    mode === 'private'
      ? legacyPublicAssetReadsAllowed()
        ? ['private', 'public']
        : ['private']
      : ['public'];
  for (const access of attempts) {
    try {
      // useCache is only meaningful for a PRIVATE read (it bypasses the
      // CDN); on a PUBLIC read Vercel Blob rejects it with HTTP 400 --
      // observed in the Preview soak, 2026-08-26. Passing it on the
      // public attempt was a regression introduced earlier in this
      // branch; the baseline never sent it.
      //
      // The token rides ONLY on the private attempt. The bounded public
      // attempt below is the pre-migration legacy-record path (§9 of the
      // rollout doc); it reads the ambient public store and must never
      // carry the private lane's credential.
      const result = await get(pathname, {
        access,
        ...(access === 'private' ? { useCache: false } : {}),
        ...(access === 'private' ? { token: privateToken as string } : {}),
      });
      if (!result || result.statusCode !== 200 || !result.stream) continue;
      const text = await new Response(result.stream).text();
      return JSON.parse(text) as T;
    } catch (err) {
      console.warn('[family-review/store] blob JSON read failed:', err);
    }
  }
  return null;
}

async function fetchSubmissionByPath(
  pathname: string,
): Promise<FamilyReviewSubmission | null> {
  return normalizeSubmissionRecord(await getJsonAtPath<unknown>(pathname));
}

export async function listRecentSubmissions(
  limit = 10,
): Promise<FamilyReviewSubmission[]> {
  if (!hasBlobToken()) return [];
  try {
    // Submission ids are opaque and unordered by design, so pathname
    // order carries no recency signal any more. Page the prefix and rank
    // by the Blob object's own uploadedAt instead. Bounded so a large
    // namespace can never turn an admin page load into an unbounded scan.
    const prefix = submissionListPrefix();
    // Enumeration follows the configured mode's store too. Without this
    // a private deployment would list the ambient store and then read
    // by pathname from the private one — reporting the wrong namespace
    // as empty, or worse, as full.
    const tokenOptions = storeTokenOptionsOrNull();
    if (tokenOptions === null) return [];
    const collected: { url: string; pathname: string; uploadedAt: Date }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const res = await list({ prefix, limit: LIST_PAGE_SIZE, cursor, ...tokenOptions });
      for (const blob of res.blobs) {
        collected.push({
          url: blob.url,
          pathname: blob.pathname,
          uploadedAt: blob.uploadedAt,
        });
      }
      if (!res.hasMore || !res.cursor) break;
      cursor = res.cursor;
    }
    const sorted = collected.sort(
      (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime(),
    );
    const top = sorted.slice(0, limit);
    // In private mode the listed url is not readable without the token,
    // so read by pathname. Public mode keeps the existing cache-busted
    // URL read: admin does repeated read-modify-write on these records
    // and the CDN can otherwise serve a stale copy.
    const privateMode = familyReviewAssetStorageMode() === 'private';
    const parsed: FamilyReviewSubmission[] = [];
    for (const blob of top) {
      const sub = privateMode
        ? await fetchSubmissionByPath(blob.pathname)
        : await fetchSubmissionAt(blob.url);
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
    for (const indexPath of reviewTokenLookupPaths(token)) {
      const index = await getJsonAtPath<{ submissionId?: string }>(indexPath);
      if (!index?.submissionId) continue;
      const submission = await findById(index.submissionId);
      if (!submission) continue;
      // Echo back the CALLER'S OWN token. The parent already holds it —
      // it is the URL they arrived on — and their page needs it to build
      // its own feedback / deletion / sample-proxy links. Nothing stored
      // is being revealed: the record itself carries only the digest, and
      // sanitizeSubmissionForPersistence strips this echo again before
      // any write.
      return { ...submission, reviewToken: token };
    }
  } catch (err) {
    console.error('[family-review/store] findByReviewToken failed:', err);
  }
  return null;
}

/**
 * Strip storage URLs from a record before it leaves the server.
 *
 * The admin board renders every asset through the cookie-gated proxy,
 * so the client has no use for a raw storage URL — but the admin list
 * and sample-upload responses used to ship one anyway. For a legacy
 * public asset that URL is a permanent, unauthenticated bearer link to
 * a child's photo, landing in browser history, devtools, extensions and
 * screen shares. Nothing outside this module needs it.
 *
 * blobPathname is retained: it is useless without the store token.
 */
export function redactAssetUrls(
  submission: FamilyReviewSubmission,
): FamilyReviewSubmission {
  const stripUrl = <T extends { blobUrl?: string }>(asset: T): T => {
    const { blobUrl: _blobUrl, ...rest } = asset;
    return rest as T;
  };
  return {
    ...submission,
    photos: {
      ...submission.photos,
      assets: submission.photos.assets.map(stripUrl),
    },
    samples: submission.samples.map(stripUrl),
  };
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
  const stored = await putAsset({
    pathname,
    bytes: args.bytes,
    mime: args.mime,
  });
  return {
    assetId: args.assetId,
    blobPathname: stored.blobPathname,
    // Only a legacy public write yields a url; a private write has none.
    ...(stored.blobUrl ? { blobUrl: stored.blobUrl } : {}),
    storage: stored.storage,
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
  const stored = await putAsset({
    pathname,
    bytes: args.bytes,
    mime: args.mime,
  });
  return {
    assetId: args.assetId,
    briefId: args.briefId,
    blobPathname: stored.blobPathname,
    ...(stored.blobUrl ? { blobUrl: stored.blobUrl } : {}),
    storage: stored.storage,
    mime: args.mime,
    size: args.bytes.byteLength,
    uploadedAt: new Date().toISOString(),
    ...(args.note ? { note: args.note } : {}),
  };
}

/**
 * Delete the token index/indexes for a submission.
 *
 * Callers hold a normalized record, which by construction has no
 * plaintext token — so the legacy raw-token index address is recovered
 * here, from the stored bytes, and never leaves this module.
 *
 * Must run BEFORE the submission JSON itself is deleted.
 */
export async function deleteReviewTokenIndexes(
  submission: Pick<FamilyReviewSubmission, 'id' | 'reviewTokenHash'>,
): Promise<void> {
  if (!hasBlobToken()) return;
  if (submission.reviewTokenHash) {
    await deleteBlob(reviewTokenIndexPath(submission.reviewTokenHash));
  }
  const stored = await getJsonAtPath<{ reviewToken?: unknown }>(
    submissionPath(submission.id),
  );
  if (typeof stored?.reviewToken === 'string' && stored.reviewToken) {
    await deleteBlob(legacyRawReviewTokenPath(stored.reviewToken));
  }
}

/**
 * Delete one stored object, REPORTING the outcome.
 *
 * This used to swallow every error and return void, so an admin delete
 * could report success while the bytes survived. Callers that care
 * (admin DELETE) now surface a partial failure instead.
 */
export async function deleteBlob(
  pathname: string,
): Promise<{ deleted: boolean; reason?: string }> {
  if (!hasBlobToken()) return { deleted: false, reason: 'no_token' };
  const result = await deleteAsset(pathname);
  if (!result.deleted) {
    console.warn('[family-review/store] blob delete failed:', result.reason);
  }
  return result;
}
