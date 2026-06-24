/**
 * @jest-environment node
 *
 * Privacy guards for the family-review beta. These complement the
 * existing tests/family-review-no-filename-capture.test.ts (which still
 * runs) by locking in the harden-before-resend changes:
 *
 *   - No stale "stays on device" / "never upload" copy in any parent-
 *     facing surface.
 *   - No sensitive submission fields persisted to localStorage. The
 *     portal no longer reads or writes a draft; only legacy keys are
 *     purged on mount.
 *   - The parent-page redactor strips raw blobUrl from server props
 *     and the parent GET API redacts it too.
 *   - The middleware sets noindex + restrictive CSP for /family-review.
 *   - The deletion-request route exists and writes the timestamp.
 *
 * These tests are static-source assertions because the live network
 * paths (Blob, Stripe, Vercel headers) are not exercisable here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const SOURCES = {
  portalFlow: 'src/app/family-review/portal-flow.tsx',
  reviewPage: 'src/app/family-review/review/[reviewToken]/page.tsx',
  reviewPortal:
    'src/app/family-review/review/[reviewToken]/review-portal.tsx',
  reviewImagePage:
    'src/app/family-review/review/[reviewToken]/image/[assetId]/page.tsx',
  uploadApi: 'src/app/api/family-review/upload/route.ts',
  reviewApi: 'src/app/api/family-review/review/[reviewToken]/route.ts',
  feedbackApi:
    'src/app/api/family-review/review/[reviewToken]/feedback/route.ts',
  sampleProxy:
    'src/app/api/family-review/review/[reviewToken]/sample/[assetId]/route.ts',
  deletionApi:
    'src/app/api/family-review/review/[reviewToken]/deletion-request/route.ts',
  adminPage: 'src/app/family-review/admin/page.tsx',
  adminLogin: 'src/app/family-review/admin/admin-login.tsx',
  adminBoard: 'src/app/family-review/admin/admin-board.tsx',
  adminProxy:
    'src/app/api/family-review/admin/submissions/[submissionId]/asset/[assetId]/route.ts',
  adminSampleApi:
    'src/app/api/family-review/admin/submissions/[submissionId]/sample/route.ts',
  adminStatusApi:
    'src/app/api/family-review/admin/submissions/[submissionId]/status/route.ts',
  adminDeleteApi:
    'src/app/api/family-review/admin/submissions/[submissionId]/route.ts',
  adminListApi: 'src/app/api/family-review/submissions/route.ts',
  adminLoginApi: 'src/app/api/family-review/admin/login/route.ts',
  adminLogoutApi: 'src/app/api/family-review/admin/logout/route.ts',
  adminAuth: 'src/lib/family-review/admin-auth.ts',
  middleware: 'middleware.ts',
} as const;

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8');
}

/* ── 1. No stale "stays on device" / "never upload" copy ───────────── */

const STALE_COPY = [
  /stay on (your )?device/i,
  /never upload/i,
  /don'?t upload them/i,
  /never leave/i,
  /kept on this device/i,
  /still on your device/i,
  /never left/i,
];

test('parent-facing copy has no "stays on device" / "never upload" leftovers', () => {
  const surfaces = [
    SOURCES.portalFlow,
    SOURCES.reviewPortal,
    SOURCES.reviewPage,
  ];
  for (const rel of surfaces) {
    const src = read(rel);
    for (const pat of STALE_COPY) {
      assert.doesNotMatch(
        src,
        pat,
        `${rel} must not say "${pat.source}" — photos are uploaded privately now`,
      );
    }
  }
});

/* ── 2. No sensitive fields in localStorage ─────────────────────────── */

test('portal-flow does not save sensitive form state to localStorage', () => {
  const src = read(SOURCES.portalFlow);
  // saveDraft, loadDraft, clearDraft were removed. STORAGE_KEY constants
  // were replaced with LEGACY_DRAFT_KEYS (used only to purge, never to
  // write).
  assert.doesNotMatch(
    src,
    /function\s+saveDraft\b/,
    'saveDraft helper must be deleted',
  );
  assert.doesNotMatch(
    src,
    /function\s+loadDraft\b/,
    'loadDraft helper must be deleted',
  );
  // No localStorage.setItem anywhere — only removeItem (in purge).
  assert.doesNotMatch(
    src,
    /localStorage\.setItem/,
    'portal-flow must not write to localStorage',
  );
  // The legacy keys we DO clean up must be referenced in a removeItem
  // call so we know they're being purged on mount.
  assert.match(
    src,
    /localStorage\.removeItem/,
    'portal-flow must purge legacy localStorage keys on mount',
  );
});

test('purged legacy keys cover known previous versions (v1 + v2)', () => {
  const src = read(SOURCES.portalFlow);
  assert.match(src, /hsb_family_review_v1/, 'must purge v1 legacy key');
  assert.match(src, /hsb_family_review_v2/, 'must purge v2 legacy key');
});

/* ── 3. Raw Blob URLs are stripped before the parent sees them ─────── */

test('parent review server page redacts blobUrl from samples + photos', () => {
  const src = read(SOURCES.reviewPage);
  // The redactor block must omit blobUrl + blobPathname from sample
  // refs and must replace photos.assets with an empty array.
  assert.match(
    src,
    /blobUrl:\s*['"]['"]/,
    'sample blobUrl must be blanked before client render',
  );
  assert.match(
    src,
    /assets:\s*\[\s*\]/,
    'photos.assets must be replaced with [] before client render',
  );
});

test('parent GET API does not return raw blobUrl in samples response', () => {
  const src = read(SOURCES.reviewApi);
  // The `safe` projection must enumerate sample fields explicitly and
  // must not include blobUrl.
  const sampleMap = src.match(/samples:\s*submission\.samples\.map\([\s\S]*?\}\)\)/);
  assert.ok(sampleMap, 'parent API must explicitly project sample fields');
  assert.doesNotMatch(
    sampleMap![0],
    /blobUrl/,
    'parent API must not echo sample blobUrl',
  );
});

test('parent review portal references samples via the proxy URL helper', () => {
  const src = read(SOURCES.reviewPortal);
  assert.match(
    src,
    /sampleProxyUrl\(reviewToken,\s*\w+\.assetId\)/,
    'samples must be loaded through /api/family-review/review/{token}/sample/{assetId}',
  );
  // No direct `src={...blobUrl}` left.
  assert.doesNotMatch(
    src,
    /src=\{[^}]*\.blobUrl\}/,
    'parent portal must not <img src> a raw blobUrl',
  );
  assert.doesNotMatch(
    src,
    /href=\{[^}]*\.blobUrl\}/,
    'parent portal must not <a href> a raw blobUrl',
  );
});

test('parent review download action opens a native image page for mobile saving', () => {
  const portal = read(SOURCES.reviewPortal);
  const page = read(SOURCES.reviewImagePage);

  assert.match(portal, /function sampleViewerUrl\(/);
  assert.match(portal, /openSaveFallback/);
  assert.match(portal, /Download/);
  assert.doesNotMatch(portal, /navigator\.share/);
  assert.doesNotMatch(portal, /navigator\.canShare/);
  assert.doesNotMatch(portal, /new File\(\[blob\]/);
  assert.doesNotMatch(portal, /\sdownload[=>\s]/);

  assert.match(page, /findByReviewToken/);
  assert.match(page, /isWellFormedReviewToken/);
  assert.match(page, /isWellFormedAssetId/);
  assert.match(page, /Save to Photos or Download image/);
  assert.match(page, /src=\{imageUrl\}/);
});

test('admin board references assets via the admin-key-gated proxy', () => {
  const src = read(SOURCES.adminBoard);
  assert.match(
    src,
    /function adminAssetUrl\(/,
    'admin board must define adminAssetUrl helper',
  );
  // No direct blobUrl in JSX src/href attributes.
  assert.doesNotMatch(
    src,
    /src=\{[^}]*\.blobUrl\}/,
    'admin board must not <img src> a raw blobUrl',
  );
  assert.doesNotMatch(
    src,
    /href=\{[^}]*\.blobUrl\}/,
    'admin board must not <a href> a raw blobUrl',
  );
});

/* ── 4. Middleware sets noindex + CSP for family-review surfaces ──── */

test('middleware applies noindex + CSP + referrer headers to family-review paths', () => {
  const src = read(SOURCES.middleware);
  assert.match(src, /FAMILY_REVIEW_PATH\s*=/, 'middleware must define the path regex');
  assert.match(src, /X-Robots-Tag/i);
  assert.match(src, /Referrer-Policy/i);
  assert.match(src, /Content-Security-Policy/i);
  assert.match(src, /frame-ancestors 'none'/);
  assert.match(src, /Permissions-Policy/i);
});

/* ── 5. Deletion request route exists + writes the timestamp ──────── */

test('deletion-request route shape-checks token, persists deletionRequestedAt', () => {
  const src = read(SOURCES.deletionApi);
  assert.match(src, /isWellFormedReviewToken/);
  assert.match(src, /findByReviewToken/);
  assert.match(src, /deletionRequestedAt/);
  assert.match(src, /persistSubmission/);
});

test('parent review portal renders a Request deletion action', () => {
  const src = read(SOURCES.reviewPortal);
  assert.match(src, /Request deletion/);
  assert.match(src, /deletion-request/);
});

test('admin board shows a prominent deletion-requested banner', () => {
  const src = read(SOURCES.adminBoard);
  assert.match(
    src,
    /Deletion requested by parent/,
    'admin board must show a Deletion requested banner',
  );
});

/* ── 6. Proxy routes shape-check ids + return 404 on miss ─────────── */

test('parent sample proxy 404s wrong token or wrong asset id', () => {
  const src = read(SOURCES.sampleProxy);
  assert.match(src, /isWellFormedReviewToken/);
  assert.match(src, /isWellFormedAssetId/);
  // 404 on any miss path
  assert.match(src, /status:\s*404/);
  // No raw href/src to vercel-storage in the proxy itself (it fetches
  // it server-side to relay).
  assert.match(src, /fetch\(sample\.blobUrl/);
});

test('admin asset proxy 403s without correct admin auth, 404s on miss', () => {
  const src = read(SOURCES.adminProxy);
  assert.match(src, /isWellFormedSubmissionId/);
  assert.match(src, /isWellFormedAssetId/);
  assert.match(src, /status:\s*403/);
  assert.match(src, /status:\s*404/);
  // Cookie-gated now — must call the helper (which reads the env key).
  assert.match(src, /isAdminRequestAuthed/);
});

/* ── 7. Invite-code placeholder is generic ────────────────────────── */

test('invite-code input no longer reveals the demo code as a placeholder', () => {
  const src = read(SOURCES.portalFlow);
  assert.doesNotMatch(
    src,
    /placeholder="hazel-meadow"/,
    'invite-code placeholder must not show the actual demo code',
  );
  assert.match(
    src,
    /placeholder="your-invite-code"/,
    'invite-code input must use a generic placeholder',
  );
});

test('invite-code field supports paste explicitly', () => {
  const src = read(SOURCES.portalFlow);
  assert.match(src, /onPaste=/, 'invite code input should handle paste events');
  assert.doesNotMatch(src, /navigator\.clipboard\.readText/, 'invite gate should rely on native phone paste, not a custom paste button');
  assert.doesNotMatch(src, /Paste code/, 'invite gate should not show a separate Paste code button');
  assert.match(src, /extractInviteCodeFromText/, 'invite gate should extract a code from full pasted invite text');
  assert.match(src, /\\b\[a-z0-9\]\+\(\?:-\[a-z0-9\]\+\)\{2,\}\\b/, 'invite extraction should detect code-shaped tokens inside copied messages');
  assert.match(src, /autoCapitalize="none"/, 'invite code input should not auto-capitalize codes');
  assert.match(src, /autoCorrect="off"/, 'invite code input should not auto-correct codes');
});

test('upload route extracts invite code from full copied invite text', () => {
  const uploadRoute = read(SOURCES.uploadApi);
  assert.match(uploadRoute, /extractInviteCodeFromText/, 'upload route should defensively extract embedded invite codes');
  assert.match(uploadRoute, /readString\(form\.get\('inviteCode'\),\s*1200\)/, 'upload route should accept full copied invite messages');
});

test('parent portal does not ship real invite codes in public JavaScript', () => {
  const src = read(SOURCES.portalFlow);
  assert.doesNotMatch(src, /NEXT_PUBLIC_FAMILY_REVIEW_CODES/);
  assert.doesNotMatch(src, /DEFAULT_INVITE_CODES/);
  assert.doesNotMatch(src, /hazel-meadow/);
  assert.doesNotMatch(src, /family-test/);
});

test('parent portal asks only for male/female, not pronoun options', () => {
  const src = read(SOURCES.portalFlow);
  assert.match(src, /Male or female/);
  assert.match(src, /Male/);
  assert.match(src, /Female/);
  assert.doesNotMatch(src, /Pronouns/i);
  assert.doesNotMatch(src, /they\/them|prefer not to say/i);
});

test('family-review photo picker supports drag/drop and mobile image mime variants', () => {
  const src = read(SOURCES.portalFlow);
  assert.match(src, /onDrop=/, 'photo picker should support drag/drop');
  assert.match(src, /dataTransfer\.files/, 'drop handler must pass dropped files to the picker');
  assert.match(src, /aria-label="Add reference photos"/, 'photo input should be directly tappable on mobile');
  assert.match(src, /position:\s*'absolute'/, 'photo input should overlay the upload card for iOS Safari');
  assert.doesNotMatch(src, /display:\s*['"]none['"]/, 'photo input must not be display:none on mobile');
  assert.match(src, /preparePhotoForUpload/, 'phone photos should be shrunk before upload');
  assert.match(src, /canvas\.toBlob/, 'client-side photo shrinking should use canvas output');
  assert.match(src, /photos selected/, 'photo picker should visibly confirm selected photos');
  assert.match(src, /URL\.createObjectURL/, 'photo picker should show local selected-photo previews');
  assert.match(src, /URL\.revokeObjectURL/, 'photo picker should clean up preview object URLs');
  assert.match(src, /alt=\{`Selected reference/, 'photo previews should render selected images with accessible alt text');
  assert.doesNotMatch(src, /fileInput\.current\.value\s*=\s*['"]['"]/, 'photo picker must not clear mobile file input immediately after selection');
  assert.match(src, /image\/jpg/, 'photo picker should accept nonstandard image/jpg MIME');
  assert.match(src, /\.heic/, 'photo picker should accept HEIC extension fallback');

  const uploadRoute = read(SOURCES.uploadApi);
  assert.match(uploadRoute, /resolveImageType/, 'upload route should resolve image type robustly');
  assert.match(uploadRoute, /image\/jpg/, 'upload route should accept nonstandard image/jpg MIME');
  assert.match(uploadRoute, /never read File\.name/i, 'upload route should sniff bytes without reading filenames');
});

/* ── 8. Admin auth: NO ?key= URL anywhere. Cookie-only transport. ─── */

test('admin board source contains zero ?key= URLs and zero adminKey identifiers', () => {
  const src = read(SOURCES.adminBoard);
  assert.doesNotMatch(
    src,
    /\?key=/,
    'admin board must not build any ?key= URLs (cookie auth only)',
  );
  // The board no longer reads the key from the URL or holds it in state.
  assert.doesNotMatch(
    src,
    /\badminKeyFromUrl\b/,
    'adminKeyFromUrl helper must be deleted',
  );
  assert.doesNotMatch(
    src,
    /\badminKey\b/,
    'admin board must not reference an adminKey identifier anywhere',
  );
});

test('admin page no longer reads searchParams for the reviewer key', () => {
  const src = read(SOURCES.adminPage);
  assert.doesNotMatch(
    src,
    /searchParams/,
    'admin page must not consult searchParams — cookie-only auth',
  );
  // Must check the cookie and render the login form when missing.
  assert.match(src, /isAdminCookieValid/);
  assert.match(src, /AdminLogin/);
});

test('admin login UI exists and POSTs to the cookie-setting endpoint', () => {
  const src = read(SOURCES.adminLogin);
  assert.match(
    src,
    /\/api\/family-review\/admin\/login/,
    'login UI must POST to the login route',
  );
  assert.match(
    src,
    /type="password"/,
    'reviewer key input must be type="password" (not in autocomplete history)',
  );
  // Must never CALL localStorage / sessionStorage from this component.
  // (The docstring may mention these names in prose explaining why we
  // don't use them — we only forbid the actual API calls.)
  assert.doesNotMatch(
    src,
    /localStorage\s*\.\s*(get|set|remove)Item/,
    'login UI must not call localStorage methods',
  );
  assert.doesNotMatch(
    src,
    /sessionStorage\s*\.\s*(get|set|remove)Item/,
    'login UI must not call sessionStorage methods',
  );
});

test('admin login API sets HttpOnly Secure-in-prod SameSite=Strict cookie on success', () => {
  const src = read(SOURCES.adminLoginApi);
  assert.match(src, /POST/);
  assert.match(src, /ADMIN_COOKIE_NAME/);
  // Cookie options helper supplies HttpOnly + SameSite=Strict.
  assert.match(src, /adminCookieOptions/);
  // On miss, must return 401 (or 403) — never silently grant.
  assert.match(src, /status:\s*401|status:\s*403/);
});

test('admin logout API clears the cookie with Max-Age 0', () => {
  const src = read(SOURCES.adminLogoutApi);
  assert.match(src, /maxAge:\s*0/);
  assert.match(src, /ADMIN_COOKIE_NAME/);
});

test('admin-auth helper enforces HttpOnly + SameSite=Strict in cookie options', () => {
  const src = read(SOURCES.adminAuth);
  assert.match(src, /httpOnly:\s*true/);
  assert.match(src, /sameSite:\s*'strict'/);
  // Path must be "/" so the cookie reaches /api/family-review/admin/*.
  assert.match(src, /path:\s*'\/'/);
  // Secure flag is true in production-like environments.
  assert.match(
    src,
    /secure:\s*\w+|process\.env\.NODE_ENV.*'production'/,
  );
});

test('admin API routes authenticate via cookie helper, not query string or header', () => {
  for (const rel of [
    SOURCES.adminProxy,
    SOURCES.adminSampleApi,
    SOURCES.adminStatusApi,
    SOURCES.adminDeleteApi,
    SOURCES.adminListApi,
  ]) {
    const src = read(rel);
    // Must call the shared cookie helper.
    assert.match(
      src,
      /isAdminRequestAuthed/,
      `${rel} must auth via isAdminRequestAuthed`,
    );
    // Must NOT read ?key= or x-admin-key anymore.
    assert.doesNotMatch(
      src,
      /searchParams\.get\(['"]key['"]\)/,
      `${rel} must not read ?key= from the URL`,
    );
    assert.doesNotMatch(
      src,
      /['"]x-admin-key['"]/,
      `${rel} must not accept x-admin-key header (cookie-only)`,
    );
  }
});

test('no TODO comment claims query-token admin auth is still in use', () => {
  for (const rel of [
    SOURCES.adminBoard,
    SOURCES.adminPage,
    SOURCES.adminProxy,
    SOURCES.adminSampleApi,
    SOURCES.adminStatusApi,
    SOURCES.adminDeleteApi,
    SOURCES.adminListApi,
  ]) {
    const src = read(rel);
    // The previous codebase had `TODO(auth): the admin key currently
    // travels in a \`?key=\` query string`. Forbid that exact wording
    // plus the broader "query token" hint.
    assert.doesNotMatch(
      src,
      /TODO\(auth\)[\s\S]{0,200}\?key=/,
      `${rel}: stale TODO mentioning ?key= must be removed`,
    );
  }
});

test('admin asset proxy URL builder takes no key argument', () => {
  const src = read(SOURCES.adminBoard);
  // adminAssetUrl signature must be (submissionId, assetId) — two args.
  const sig = src.match(/function adminAssetUrl\(([^)]*)\)/);
  assert.ok(sig, 'adminAssetUrl must exist');
  const params = sig![1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.equal(
    params.length,
    2,
    `adminAssetUrl must take exactly (submissionId, assetId), got: (${sig![1]})`,
  );
});

test('admin board fetches include credentials: same-origin so cookie ships', () => {
  const src = read(SOURCES.adminBoard);
  // Every fetch to /api/family-review/admin or /submissions must carry
  // credentials so the HttpOnly cookie is actually sent.
  const adminFetches = [...src.matchAll(
    /fetch\(\s*['"`][^'"`]*\/api\/family-review\/(?:admin|submissions)[^'"`]*['"`][\s\S]*?\)/g,
  )];
  assert.ok(adminFetches.length >= 3, 'expected ≥3 admin fetches in admin-board');
  for (const m of adminFetches) {
    assert.match(
      m[0],
      /credentials:\s*['"]same-origin['"]/,
      `admin fetch must set credentials: 'same-origin' so the auth cookie is sent. Offender: ${m[0].slice(0, 200)}`,
    );
  }
});

test('family-review sample email draft makes the parent review link explicit', () => {
  const src = read(SOURCES.adminBoard);
  assert.match(src, /export function buildParentSampleEmail/);
  assert.match(src, /Review link:/);
  assert.match(src, /copy and paste the full URL above into your browser/);
  assert.match(src, /sequential adventure story/);
});

test('admin login API + helper never reveal the reviewer key in any response', () => {
  // The login route returns { ok: true } only — no echo of the key.
  // The helper exports keysMatch via private fn, but doesn't return
  // the key from any public API. Spot-check the login route body.
  const login = read(SOURCES.adminLoginApi);
  // The string `provided` is the user-submitted key. Make sure it
  // isn't sent back in the response body.
  assert.doesNotMatch(
    login,
    /NextResponse\.json\(\s*\{\s*[^}]*key:\s*provided/,
    'login route must not echo the provided key in its response',
  );
});
