/**
 * Route-level guards for Family Review asset access.
 *
 * Covers: unauthorized parent/admin access, invalid capability shapes,
 * cross-submission access, authorization ordering (nothing opens
 * storage before both checks pass), the privacy/security header set,
 * public-URL leakage, and preservation of the existing flows.
 *
 * Source-level assertions, matching the convention already used by
 * tests/family-review-privacy.test.ts — the route handlers pull in the
 * Next runtime and cannot be invoked in-process here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ADMIN_PROXY =
  'src/app/api/family-review/admin/submissions/[submissionId]/asset/[assetId]/route.ts';
const PARENT_PROXY =
  'src/app/api/family-review/review/[reviewToken]/sample/[assetId]/route.ts';
const ADMIN_LIST = 'src/app/api/family-review/submissions/route.ts';
const ADMIN_SAMPLE =
  'src/app/api/family-review/admin/submissions/[submissionId]/sample/route.ts';
const ADMIN_DELETE =
  'src/app/api/family-review/admin/submissions/[submissionId]/route.ts';

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8');
}

/* ── 1. Unauthorized access ────────────────────────────────────────── */

test('the admin asset proxy refuses an unauthenticated request', () => {
  const s = src(ADMIN_PROXY);
  assert.match(
    s,
    /if \(!isAdminRequestAuthed\(req\)\) \{\s*return new NextResponse\('Forbidden', \{ status: 403 \}\);/,
    'no admin cookie must mean 403',
  );
});

test('the parent proxy 404s an invalid token shape without any lookup', () => {
  const s = src(PARENT_PROXY);
  const shapeIdx = s.indexOf('isWellFormedReviewToken(reviewToken)');
  const lookupIdx = s.indexOf('findByReviewToken(reviewToken)');
  assert.ok(shapeIdx > 0 && lookupIdx > shapeIdx, 'shape check must precede lookup');
  assert.match(
    s,
    /!isWellFormedReviewToken\(reviewToken\) \|\| !isWellFormedAssetId\(assetId\)[\s\S]{0,120}status: 404/,
    'a malformed capability must 404',
  );
});

test('an unknown or expired parent capability yields 404, never 403', () => {
  const s = src(PARENT_PROXY);
  // 403 would confirm that a token exists; the endpoint must stay
  // non-enumerable. Check emitted statuses, not the prose that
  // documents the rule.
  assert.doesNotMatch(
    s,
    /status:\s*403/,
    'the parent proxy must never answer 403 — that would confirm a token exists',
  );
  assert.match(
    s,
    /const submission = await findByReviewToken\(reviewToken\);\s*if \(!submission\) \{\s*return new NextResponse\('Not found', \{ status: 404 \}\);/,
  );
});

test('the admin listing endpoint refuses an unauthenticated caller', () => {
  assert.match(
    src(ADMIN_LIST),
    /if \(!isAdminRequestAuthed\(req\)\)[\s\S]{0,160}status: 403/,
  );
});

/* ── 2. Cross-submission access ────────────────────────────────────── */

test('an admin cannot read an asset belonging to another submission', () => {
  const s = src(ADMIN_PROXY);
  // The asset is resolved from THIS submission's own lists only.
  assert.match(s, /submission\.photos\.assets\.find\(\(p\) => p\.assetId === assetId\)/);
  assert.match(s, /submission\.samples\.find\(\(s\) => s\.assetId === assetId\)/);
  assert.match(
    s,
    /const asset = photo \?\? sample;\s*if \(!asset\) \{\s*return new NextResponse\('Not found', \{ status: 404 \}\);/,
    'an asset id that is not on this submission must 404',
  );
});

test('a parent cannot read reference photos, only samples on their own record', () => {
  const s = src(PARENT_PROXY);
  assert.match(s, /submission\.samples\.find\(\(s\) => s\.assetId === assetId\)/);
  assert.ok(
    !s.includes('photos.assets'),
    'the parent proxy must never resolve an asset from the reference-photo list',
  );
});

/* ── 3. Authorization strictly precedes any storage read ───────────── */

test('neither proxy opens storage before authorization and ownership pass', () => {
  for (const [label, file, authNeedle] of [
    ['admin', ADMIN_PROXY, 'isAdminRequestAuthed(req)'],
    ['parent', PARENT_PROXY, 'findByReviewToken(reviewToken)'],
  ] as const) {
    const s = src(file);
    const authIdx = s.indexOf(authNeedle);
    const ownershipIdx = s.indexOf('.find((');
    const openIdx = s.indexOf('await openAsset(');
    assert.ok(authIdx > 0, `${label}: auth check present`);
    assert.ok(openIdx > 0, `${label}: storage open present`);
    assert.ok(authIdx < openIdx, `${label}: authorization must precede openAsset`);
    assert.ok(
      ownershipIdx > 0 && ownershipIdx < openIdx,
      `${label}: ownership resolution must precede openAsset`,
    );
  }
});

/* ── 4. Privacy / security headers ─────────────────────────────────── */

test('both byte proxies set the full privacy header set', () => {
  for (const file of [ADMIN_PROXY, PARENT_PROXY]) {
    const s = src(file);
    assert.match(s, /'X-Content-Type-Options': 'nosniff'/, `${file}: nosniff`);
    assert.match(
      s,
      /'Cache-Control': 'private, no-store, max-age=0'/,
      `${file}: no-store`,
    );
    assert.match(s, /'Referrer-Policy': 'no-referrer'/, `${file}: no-referrer`);
    assert.match(s, /'X-Robots-Tag': 'noindex, nofollow'/, `${file}: noindex`);
    assert.match(s, /Content-Disposition/, `${file}: disposition`);
  }
});

test('served Content-Type comes from the stored allowlisted mime, never upstream', () => {
  for (const file of [ADMIN_PROXY, PARENT_PROXY]) {
    const s = src(file);
    assert.match(
      s,
      /'Content-Type': serveableContentType\(/,
      `${file}: must funnel the type through the allowlist`,
    );
    assert.doesNotMatch(
      s,
      /upstream\.headers\.get\(['"]content-type/i,
      `${file}: must never echo the upstream content type`,
    );
  }
});

test('middleware sets nosniff on every family-review response', () => {
  const s = src('middleware.ts');
  assert.match(
    s,
    /function applyFamilyReviewPrivacyHeaders[\s\S]*?'X-Content-Type-Options', 'nosniff'/,
  );
});

/* ── 5. No public URL leakage ──────────────────────────────────────── */

test('no route hands a raw storage URL to a client', () => {
  // The admin listing and the sample-upload response both used to ship
  // photos[].blobUrl — permanent unauthenticated bearer links to a
  // child's photos — into the admin browser.
  assert.match(
    src(ADMIN_LIST),
    /listRecentSubmissions\(limit\)\)\.map\(redactAssetUrls\)/,
    'the admin listing must redact asset URLs',
  );
  assert.match(
    src(ADMIN_SAMPLE),
    /const safe = redactAssetUrls\(next\);/,
    'the sample upload response must redact asset URLs',
  );
  assert.doesNotMatch(
    src(ADMIN_SAMPLE),
    /\{ ok: true, asset, /,
    'the raw asset object must not be echoed',
  );
});

test('the proxies no longer fetch a raw blob URL directly', () => {
  for (const file of [ADMIN_PROXY, PARENT_PROXY]) {
    assert.doesNotMatch(
      src(file),
      /fetch\((?:asset|sample)\.blobUrl/,
      `${file}: byte reads must go through the storage abstraction`,
    );
  }
});

test('the admin board client component carries no blobUrl in its props', () => {
  assert.doesNotMatch(
    src('src/app/family-review/admin/admin-board.tsx'),
    /existing\?: \{[^}]*blobUrl/,
    'a raw storage URL must not reach the client bundle',
  );
});

/* ── 6. Deletion behavior ──────────────────────────────────────────── */

test('admin delete reports a partial failure instead of a blanket ok', () => {
  const s = src(ADMIN_DELETE);
  assert.match(s, /const failed = results\.filter\(\(r\) => !r\.deleted\)\.length;/);
  assert.match(s, /error: 'partial_delete'/);
  assert.doesNotMatch(
    s,
    /await Promise\.all\(paths\.map\(\(pathname\) => deleteBlob\(pathname\)\)\);\s*\n\s*return NextResponse\.json\(\s*\{ ok: true/,
    'delete must not report success without checking outcomes',
  );
});

test('delete failures are logged as counts, never as pathnames', () => {
  const s = src(ADMIN_DELETE);
  const logLine = s.slice(s.indexOf('[family-review/admin/delete]'));
  assert.ok(
    !logLine.includes('${pathname}'),
    'a pathname must never reach the logs',
  );
});

/* ── 7. Existing flows preserved ───────────────────────────────────── */

test('the parent and admin asset URLs are unchanged', () => {
  assert.match(
    src('src/app/family-review/review/[reviewToken]/review-portal.tsx'),
    /`\/api\/family-review\/review\/\$\{encodeURIComponent\(reviewToken\)\}\/sample\/\$\{encodeURIComponent\(assetId\)\}`/,
    'the parent sample proxy URL must not move',
  );
  assert.match(
    src('src/app/family-review/admin/admin-board.tsx'),
    /`\/api\/family-review\/admin\/submissions\/\$\{encodeURIComponent\(submissionId\)\}\/asset\/\$\{encodeURIComponent\(assetId\)\}`/,
    'the admin asset proxy URL must not move',
  );
});

test('the storage-disabled 503 contract is unchanged', () => {
  assert.match(
    src('src/app/api/family-review/upload/route.ts'),
    /if \(!hasBlobToken\(\)\)[\s\S]{0,400}status: 503/,
    'a missing blob token must still surface an explicit 503, never a fake success',
  );
});
