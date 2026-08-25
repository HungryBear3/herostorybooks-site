/**
 * @jest-environment node
 *
 * Lane B family-review token privacy.
 *
 * These tests lock in the hardening applied to NEW family-review
 * submissions. They are deliberately pure-in-process: every helper
 * exercised here is a path/serialisation helper, so the suite asserts
 * (and enforces, via a throwing fetch stub) that nothing here touches
 * the network, Vercel Blob, or any production object.
 *
 * What is being locked in:
 *
 *   1. NEW submission ids carry >= 128 bits of crypto randomness and no
 *      timestamp / order / count signal.
 *   2. NEW token-index pathnames are keyed by sha256(reviewToken) — the
 *      raw token never appears in any pathname.
 *   3. NEW persisted submission bytes never contain the raw token.
 *   4. Legacy plaintext-token records stay READABLE (bounded compat) but
 *      the shared read normaliser strips the plaintext before any
 *      generic application record is returned.
 *   5. The single persistence serialiser strips plaintext defensively,
 *      so generic read-modify-write updates cannot resurrect it.
 *   6. Parent-facing capability misses are indistinguishable (404).
 *   7. No original-filename capture regression.
 *
 * This lane does NOT flip Blob access mode and does NOT migrate any
 * existing object. Pre-existing public objects remain exactly as they
 * are; see CC-FINAL-HANDOFF.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  hashReviewToken,
  isWellFormedReviewToken,
  isWellFormedReviewTokenHash,
  isWellFormedSubmissionId,
  newAssetId,
  newReviewToken,
  newSubmissionId,
} from '../src/lib/family-review/tokens.ts';
import {
  buildPersistPlan,
  legacyRawReviewTokenPath,
  normalizeSubmissionRecord,
  reviewTokenIndexPath,
  reviewTokenLookupPaths,
  sanitizeSubmissionForPersistence,
  submissionPath,
  type FamilyReviewSubmission,
} from '../src/lib/family-review/store.ts';

/* ── shared fixtures ───────────────────────────────────────────────── */

const LEGACY_SUBMISSION_ID = 'fr-m0kq3z9x-1a2b3c4d';
const LEGACY_RAW_TOKEN = 'LegacyRawToken0123456789abcdefg';

function baseRecordFields() {
  return {
    receivedAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    parent: { name: 'Test Parent', email: 'parent@example.test' },
    child: {
      firstName: 'Robin',
      ageRange: '5-6' as const,
      pronoun: null,
    },
    consent: { agreedAt: '2026-08-01T10:00:00.000Z', version: 'v1' as const },
    photos: {
      count: 1,
      uploadedToServer: true,
      assets: [
        {
          assetId: newAssetId(),
          blobPathname: 'family-review/photos/x/y.jpg',
          blobUrl: 'https://example.invalid/y.jpg',
          mime: 'image/jpeg',
          size: 1234,
          uploadedAt: '2026-08-01T10:00:00.000Z',
        },
      ],
    },
    samples: [],
    direction: 'dinosaur' as const,
    inviteCodeAccepted: true as const,
    status: 'submitted' as const,
  };
}

/** A record shaped exactly like the pre-hardening persisted JSON. */
function legacyShapedRecord(): FamilyReviewSubmission {
  return {
    id: LEGACY_SUBMISSION_ID,
    reviewToken: LEGACY_RAW_TOKEN,
    ...baseRecordFields(),
  } as FamilyReviewSubmission;
}

/** A record shaped the way NEW submissions are built. */
function newShapedRecord(token: string): FamilyReviewSubmission {
  return {
    id: newSubmissionId(),
    reviewTokenHash: hashReviewToken(token),
    ...baseRecordFields(),
  } as FamilyReviewSubmission;
}

function b64urlByteLength(value: string): number {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').length;
}

/* ── 0. No network / no production dependency ──────────────────────── */

test('token + path helpers make no network call at all', () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  // Deliberate throwing stub: any network attempt fails the suite loudly.
  globalThis.fetch = ((...args: unknown[]) => {
    calls.push(String(args[0]));
    throw new Error('network access is forbidden in this suite');
  }) as unknown as typeof globalThis.fetch;
  try {
    const token = newReviewToken();
    const record = newShapedRecord(token);
    const plan = buildPersistPlan(record);
    normalizeSubmissionRecord(legacyShapedRecord());
    sanitizeSubmissionForPersistence(legacyShapedRecord());
    reviewTokenLookupPaths(token);
    assert.ok(plan.submissionPathname.length > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, [], 'no fetch may be issued by these helpers');
});

test('BLOB_READ_WRITE_TOKEN is not required by this suite', () => {
  assert.equal(
    process.env.BLOB_READ_WRITE_TOKEN ?? '',
    process.env.BLOB_READ_WRITE_TOKEN ?? '',
    'suite must be agnostic to blob credentials',
  );
});

/* ── 1. Submission ids: >=128 bits, opaque, no time/order signal ───── */

test('newSubmissionId carries at least 128 bits of randomness', () => {
  for (let i = 0; i < 50; i += 1) {
    const id = newSubmissionId();
    const random = id.replace(/^fr-/, '');
    assert.match(id, /^fr-/, 'ids keep the fr- discriminator');
    assert.ok(
      b64urlByteLength(random) >= 16,
      `submission id must encode >= 16 random bytes, got ${b64urlByteLength(
        random,
      )} in ${id}`,
    );
  }
});

test('newSubmissionId carries no timestamp / order / count signal', () => {
  const nowB36 = Date.now().toString(36).slice(0, 6);
  const ids: string[] = [];
  for (let i = 0; i < 200; i += 1) ids.push(newSubmissionId());

  for (const id of ids) {
    assert.doesNotMatch(
      id,
      new RegExp(`^fr-${nowB36}`),
      `submission id ${id} still leaks a base36 millisecond prefix`,
    );
  }

  // Ids minted back-to-back must not share a leading prefix (a timestamp
  // prefix would make the first several characters identical).
  const prefixes = new Set(ids.map((id) => id.slice(3, 9)));
  assert.ok(
    prefixes.size > ids.length * 0.9,
    `submission ids share leading prefixes (${prefixes.size} distinct of ${ids.length}) — that is an order/time signal`,
  );

  // Generation order must not survive as lexicographic order.
  const sorted = [...ids].sort();
  assert.notDeepEqual(
    sorted,
    ids,
    'submission ids sort into generation order — that leaks submission order',
  );
});

test('newSubmissionId does not collide across a large corpus', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i += 1) seen.add(newSubmissionId());
  assert.equal(seen.size, 5000, 'submission ids must be unique');
});

test('isWellFormedSubmissionId accepts new ids and legacy ids', () => {
  for (let i = 0; i < 200; i += 1) {
    const id = newSubmissionId();
    assert.ok(
      isWellFormedSubmissionId(id),
      `new submission id ${id} must validate`,
    );
  }
  assert.ok(
    isWellFormedSubmissionId(LEGACY_SUBMISSION_ID),
    'legacy submission ids must stay routable (bounded compat)',
  );
  assert.ok(!isWellFormedSubmissionId('fr-'), 'empty random part is invalid');
  assert.ok(!isWellFormedSubmissionId('../../etc/passwd'), 'traversal rejected');
  assert.ok(!isWellFormedSubmissionId('fr-abc/def'), 'slash rejected');
  assert.ok(!isWellFormedSubmissionId(''), 'empty rejected');
});

/* ── 2. Token hashing ──────────────────────────────────────────────── */

test('hashReviewToken is sha256 hex and matches an independent digest', () => {
  const token = newReviewToken();
  const expected = createHash('sha256').update(token, 'utf8').digest('hex');
  assert.equal(hashReviewToken(token), expected);
  assert.match(hashReviewToken(token), /^[0-9a-f]{64}$/);
  assert.ok(isWellFormedReviewTokenHash(hashReviewToken(token)));
  assert.ok(!isWellFormedReviewTokenHash(token), 'a raw token is not a hash');
});

test('hashReviewToken is deterministic and never returns the raw token', () => {
  for (let i = 0; i < 200; i += 1) {
    const token = newReviewToken();
    const a = hashReviewToken(token);
    const b = hashReviewToken(token);
    assert.equal(a, b, 'digest must be deterministic');
    assert.notEqual(a, token, 'digest must not be the raw token');
    assert.ok(!a.includes(token), 'digest must not embed the raw token');
  }
});

test('two tokens never alias in a fixture corpus', () => {
  const tokens = new Set<string>();
  const hashes = new Set<string>();
  for (let i = 0; i < 5000; i += 1) {
    const token = newReviewToken();
    tokens.add(token);
    hashes.add(hashReviewToken(token));
  }
  assert.equal(tokens.size, 5000, 'tokens must be unique');
  assert.equal(hashes.size, 5000, 'token hashes must not alias');
});

/* ── 3. Raw tokens never appear in NEW pathnames ───────────────────── */

test('new token-index pathname is keyed by the digest, never the raw token', () => {
  const token = newReviewToken();
  const hash = hashReviewToken(token);
  const indexPath = reviewTokenIndexPath(hash);

  assert.ok(
    indexPath.includes(hash),
    'index pathname must be keyed by the digest',
  );
  assert.ok(
    !indexPath.includes(token),
    `index pathname must not contain the raw token (${indexPath})`,
  );
});

test('new submission pathname contains neither the raw token nor PII', () => {
  const token = newReviewToken();
  const record = newShapedRecord(token);
  const pathname = submissionPath(record.id);

  assert.ok(!pathname.includes(token), 'submission pathname leaks the token');
  assert.ok(
    !pathname.includes(record.parent.email),
    'submission pathname leaks the parent email',
  );
  assert.ok(
    !pathname.toLowerCase().includes(record.child.firstName.toLowerCase()),
    'submission pathname leaks the child first name',
  );
});

/* ── 4. Persist plan: bytes + pathnames are token-free ─────────────── */

test('buildPersistPlan writes the hash index and token-free bytes', () => {
  const token = newReviewToken();
  const record = newShapedRecord(token);
  const plan = buildPersistPlan(record);

  assert.equal(plan.submissionPathname, submissionPath(record.id));
  assert.equal(
    plan.indexPathname,
    reviewTokenIndexPath(hashReviewToken(token)),
    'index must be written at the digest path',
  );
  assert.deepEqual(
    JSON.parse(plan.indexBody as string),
    { submissionId: record.id },
    'hash index must resolve to the correct submission',
  );
  assert.ok(
    !plan.submissionBody.includes(token),
    'serialized submission bytes must not contain the raw token',
  );
  assert.ok(
    !plan.indexPathname!.includes(token),
    'index pathname must not contain the raw token',
  );
  assert.ok(
    !(plan.indexBody as string).includes(token),
    'index bytes must not contain the raw token',
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(
      JSON.parse(plan.submissionBody),
      'reviewToken',
    ),
    'persisted record must have no reviewToken key at all',
  );
});

test('hash index resolves the correct new submission among many', () => {
  const corpus = Array.from({ length: 50 }, () => {
    const token = newReviewToken();
    return { token, record: newShapedRecord(token) };
  });
  const byIndexPath = new Map<string, string>();
  for (const entry of corpus) {
    const plan = buildPersistPlan(entry.record);
    byIndexPath.set(plan.indexPathname!, plan.indexBody as string);
  }
  assert.equal(byIndexPath.size, corpus.length, 'index paths must not alias');
  for (const entry of corpus) {
    const lookup = reviewTokenLookupPaths(entry.token)[0];
    const body = byIndexPath.get(lookup);
    assert.ok(body, `lookup path for a known token must resolve (${lookup})`);
    assert.equal(
      JSON.parse(body!).submissionId,
      entry.record.id,
      'the digest index must resolve to that token’s own submission',
    );
  }
});

/* ── 5. Legacy compatibility + legacy scrub ────────────────────────── */

test('legacy raw-token records stay resolvable through the compat path', () => {
  const paths = reviewTokenLookupPaths(LEGACY_RAW_TOKEN);
  assert.equal(
    paths[0],
    reviewTokenIndexPath(hashReviewToken(LEGACY_RAW_TOKEN)),
    'digest index must be tried first',
  );
  assert.ok(
    paths.includes(legacyRawReviewTokenPath(LEGACY_RAW_TOKEN)),
    'legacy raw-token index must remain readable for bounded compat',
  );
});

test('normalizeSubmissionRecord strips legacy plaintext but keeps the record', () => {
  const normalized = normalizeSubmissionRecord(legacyShapedRecord())!;

  assert.equal(
    normalized.reviewToken,
    undefined,
    'legacy raw token must be absent from the normalized in-memory result',
  );
  assert.ok(
    !JSON.stringify(normalized).includes(LEGACY_RAW_TOKEN),
    'no field of the normalized record may carry the legacy raw token',
  );
  assert.equal(
    normalized.reviewTokenHash,
    hashReviewToken(LEGACY_RAW_TOKEN),
    'the digest must be derived so the record stays index-addressable',
  );
  // Everything else must survive untouched.
  assert.equal(normalized.id, LEGACY_SUBMISSION_ID);
  assert.equal(normalized.parent.email, 'parent@example.test');
  assert.equal(normalized.child.firstName, 'Robin');
  assert.equal(normalized.status, 'submitted');
  assert.equal(normalized.photos.count, 1);
  assert.equal(normalized.photos.assets.length, 1);
});

test('normalizeSubmissionRecord rejects non-records', () => {
  assert.equal(normalizeSubmissionRecord(null), null);
  assert.equal(normalizeSubmissionRecord(undefined), null);
  assert.equal(normalizeSubmissionRecord({} as never), null);
  assert.equal(normalizeSubmissionRecord({ id: 7 } as never), null);
});

/* ── 6. The serializer strips plaintext defensively ────────────────── */

test('direct persistence of a raw legacy-shaped record strips plaintext', () => {
  const legacy = legacyShapedRecord();
  const sanitized = sanitizeSubmissionForPersistence(legacy);

  assert.ok(
    !Object.prototype.hasOwnProperty.call(sanitized, 'reviewToken'),
    'sanitized record must not carry a reviewToken key',
  );
  assert.ok(
    !JSON.stringify(sanitized).includes(LEGACY_RAW_TOKEN),
    'sanitized bytes must not contain the legacy raw token',
  );
  assert.equal(
    sanitized.reviewTokenHash,
    hashReviewToken(LEGACY_RAW_TOKEN),
    'the digest must be derived from the legacy token so the index survives',
  );

  const plan = buildPersistPlan(legacy);
  assert.ok(
    !plan.submissionBody.includes(LEGACY_RAW_TOKEN),
    'persist plan bytes must not contain the legacy raw token',
  );
  assert.ok(
    !plan.indexPathname!.includes(LEGACY_RAW_TOKEN),
    'persist plan must never write a raw-token index pathname',
  );
});

test('generic status / sample / feedback updates cannot resurrect plaintext', () => {
  // Mirrors the read-modify-write shape used by the status, sample,
  // feedback and deletion-request routes.
  const stored = legacyShapedRecord();
  const readBack = normalizeSubmissionRecord(stored)!;

  const statusUpdate = {
    ...readBack,
    status: 'samples_ready' as const,
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
  const sampleUpdate = {
    ...statusUpdate,
    samples: [
      {
        assetId: newAssetId(),
        briefId: 'cover-hero' as const,
        blobPathname: 'family-review/samples/x/y.png',
        blobUrl: 'https://example.invalid/y.png',
        mime: 'image/png',
        size: 10,
        uploadedAt: '2026-08-24T00:00:00.000Z',
      },
    ],
  };
  const feedbackUpdate = {
    ...sampleUpdate,
    feedback: {
      rating: 5,
      looksLikeChild: 'yes' as const,
      notes: 'lovely',
      submittedAt: '2026-08-24T00:00:00.000Z',
    },
  };
  const deletionUpdate = {
    ...feedbackUpdate,
    deletionRequestedAt: '2026-08-24T00:00:00.000Z',
  };

  for (const next of [
    statusUpdate,
    sampleUpdate,
    feedbackUpdate,
    deletionUpdate,
  ]) {
    const plan = buildPersistPlan(next as FamilyReviewSubmission);
    assert.ok(
      !plan.submissionBody.includes(LEGACY_RAW_TOKEN),
      'a generic update must not resurrect the legacy plaintext token',
    );
    assert.equal(
      plan.indexPathname,
      reviewTokenIndexPath(hashReviewToken(LEGACY_RAW_TOKEN)),
      'a generic update must keep addressing the digest index',
    );
  }
});

test('a record carrying an echoed capability token still persists clean', () => {
  // findByReviewToken re-attaches the CALLER-SUPPLIED token so the parent
  // page keeps working. That echoed value must never reach storage.
  const token = newReviewToken();
  const record = { ...newShapedRecord(token), reviewToken: token };
  const plan = buildPersistPlan(record as FamilyReviewSubmission);
  assert.ok(
    !plan.submissionBody.includes(token),
    'an echoed capability token must be stripped before persistence',
  );
});

/* ── 7. Enumeration resistance on parent capability paths ──────────── */

function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8');
}

const PARENT_CAPABILITY_ROUTES = [
  'src/app/api/family-review/review/[reviewToken]/route.ts',
  'src/app/api/family-review/review/[reviewToken]/feedback/route.ts',
  'src/app/api/family-review/review/[reviewToken]/deletion-request/route.ts',
  'src/app/api/family-review/review/[reviewToken]/sample/[assetId]/route.ts',
];

test('malformed and unknown capability paths are indistinguishable', () => {
  for (const rel of PARENT_CAPABILITY_ROUTES) {
    const src = readSource(rel);
    // Shape check must happen before any store lookup. Compare CALL
    // sites (`name(`), not the import lines, which are ordered
    // alphabetically and say nothing about execution order.
    const shapeIdx = src.indexOf('isWellFormedReviewToken(');
    const lookupIdx = src.indexOf('findByReviewToken(');
    assert.ok(shapeIdx > -1, `${rel} must shape-check the token`);
    assert.ok(lookupIdx > -1, `${rel} must look the token up`);
    assert.ok(
      shapeIdx < lookupIdx,
      `${rel} must shape-check before touching the store`,
    );
    // Both the malformed branch and the miss branch must be 404 and must
    // not carry any distinguishing body.
    assert.doesNotMatch(
      src,
      /status:\s*40[13]\b/,
      `${rel} must not answer a bad capability with 401/403 — that discloses existence`,
    );
    assert.ok(
      !/error:\s*'(invalid_token|malformed|expired|unknown_token)'/.test(src),
      `${rel} must not use a distinguishing error code for a bad capability`,
    );
  }
});

test('review token shape check rejects malformed capability values', () => {
  assert.ok(!isWellFormedReviewToken(''));
  assert.ok(!isWellFormedReviewToken('short'));
  assert.ok(!isWellFormedReviewToken('../../etc/passwd'));
  assert.ok(!isWellFormedReviewToken('has spaces in it aaaaaaaaaaaa'));
  assert.ok(!isWellFormedReviewToken('a'.repeat(200)));
  assert.ok(isWellFormedReviewToken(newReviewToken()));
});

/* ── 8. Parent + admin workflows remain wired ──────────────────────── */

test('parent and admin routes still use the shared store contract', () => {
  const reviewApi = readSource(
    'src/app/api/family-review/review/[reviewToken]/route.ts',
  );
  assert.match(reviewApi, /findByReviewToken/);

  const feedbackApi = readSource(
    'src/app/api/family-review/review/[reviewToken]/feedback/route.ts',
  );
  assert.match(feedbackApi, /persistSubmission/);

  const deletionApi = readSource(
    'src/app/api/family-review/review/[reviewToken]/deletion-request/route.ts',
  );
  assert.match(deletionApi, /deletionRequestedAt/);

  const statusApi = readSource(
    'src/app/api/family-review/admin/submissions/[submissionId]/status/route.ts',
  );
  assert.match(statusApi, /persistSubmission/);

  const sampleApi = readSource(
    'src/app/api/family-review/admin/submissions/[submissionId]/sample/route.ts',
  );
  assert.match(sampleApi, /uploadSampleBytes/);
  assert.match(sampleApi, /persistSubmission/);

  const deleteApi = readSource(
    'src/app/api/family-review/admin/submissions/[submissionId]/route.ts',
  );
  assert.match(
    deleteApi,
    /deleteReviewTokenIndexes/,
    'admin delete must clean up token indexes through the store helper',
  );
  assert.doesNotMatch(
    deleteApi,
    /reviewTokenPath\(submission\.reviewToken\)/,
    'admin delete must not depend on a persisted plaintext token',
  );
});

test('upload route returns the raw token exactly once, at creation', () => {
  const src = readSource('src/app/api/family-review/upload/route.ts');

  // Isolate the literal that is actually handed to persistSubmission.
  const recordMatch = src.match(
    /const record: FamilyReviewSubmission = \{([\s\S]*?)\n  \};/,
  );
  assert.ok(recordMatch, 'the persisted record literal must exist');
  const recordLiteral = recordMatch![1];

  assert.match(
    recordLiteral,
    /reviewTokenHash:\s*hashReviewToken\(reviewToken\)/,
    'the persisted record must carry only the digest',
  );
  assert.doesNotMatch(
    recordLiteral,
    /^\s*reviewToken,\s*$/m,
    'the persisted record literal must not shorthand-carry the raw token',
  );
  assert.doesNotMatch(
    recordLiteral,
    /^\s*reviewToken:/m,
    'the persisted record literal must not carry a raw token property',
  );

  // ...while the one-time creation response still hands the parent the
  // link. This is the only place the raw token is ever emitted.
  assert.match(
    src,
    /reviewUrl:\s*`\/family-review\/review\/\$\{reviewToken\}`/,
    'the creation response must still hand the parent their link once',
  );
});

/* ── 9. No original-filename capture regression ────────────────────── */

test('sanitizer preserves the photo asset shape and captures no filename', () => {
  const legacy = legacyShapedRecord();
  const sanitized = sanitizeSubmissionForPersistence(legacy);
  const asset = sanitized.photos.assets[0];
  assert.deepEqual(
    Object.keys(asset).sort(),
    ['assetId', 'blobPathname', 'blobUrl', 'mime', 'size', 'uploadedAt'].sort(),
    'photo asset shape must be unchanged by the sanitizer',
  );
  assert.ok(
    !JSON.stringify(sanitized).toLowerCase().includes('filename'),
    'no filename-shaped field may be introduced',
  );
});

/* ── 10. Admin board never fabricates an unrecoverable parent URL ─────────── */

test('admin board hides link and email affordances when no raw token is recoverable', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'src/app/family-review/admin/admin-board.tsx'),
    'utf8',
  );

  assert.match(
    src,
    /const hasReviewToken =\s*typeof submission\.reviewToken === 'string'\s*&&\s*submission\.reviewToken\.length > 0/,
    'the board must distinguish one-time token echoes from generic tokenless admin records',
  );
  assert.match(
    src,
    /const reviewUrl = hasReviewToken[\s\S]*?: null;/,
    'a missing token must produce no URL rather than /undefined',
  );
  assert.match(
    src,
    /Review link was issued once at submission and is not recoverable from stored data\./,
    'the board must explain the intentional one-time issuance contract',
  );
  assert.match(
    src,
    /disabled=\{!readyToEmail \|\| !sampleEmail\}/,
    'the parent-email affordance must stay disabled without a recoverable link',
  );
  assert.doesNotMatch(
    src,
    /const reviewUrl =\s*typeof window/,
    'the board must never construct a review URL before proving a token exists',
  );
});
