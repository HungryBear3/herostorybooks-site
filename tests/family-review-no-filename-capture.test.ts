/**
 * @jest-environment node
 *
 * Static guard: nothing in the family-review namespace may capture, store,
 * or transmit photo filenames. Filenames frequently carry surnames, school
 * names, dates, and family-context strings that would violate the portal's
 * first-name-only privacy promise.
 *
 * If you are about to add a filename / clientFilenames / photoFilenames
 * field anywhere in src/app/family-review, src/app/api/family-review, or
 * src/lib/family-review — stop and read
 *   src/lib/family-review/store.ts (FamilyReviewSubmission docstring)
 * first. The persisted record intentionally captures `photos.count` only.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const FAMILY_REVIEW_SOURCES = [
  'src/lib/family-review/store.ts',
  'src/lib/family-review/sample-briefs.ts',
  'src/lib/family-review/tokens.ts',
  'src/app/api/family-review/upload/route.ts',
  'src/app/api/family-review/submissions/route.ts',
  'src/app/api/family-review/review/[reviewToken]/route.ts',
  'src/app/api/family-review/review/[reviewToken]/feedback/route.ts',
  'src/app/api/family-review/admin/submissions/[submissionId]/sample/route.ts',
  'src/app/api/family-review/admin/submissions/[submissionId]/status/route.ts',
  'src/app/family-review/portal-flow.tsx',
  'src/app/family-review/admin/admin-board.tsx',
  'src/app/family-review/review/[reviewToken]/page.tsx',
  'src/app/family-review/review/[reviewToken]/review-portal.tsx',
  'src/app/family-review/review/[reviewToken]/image/[assetId]/page.tsx',
];

// Patterns that would represent any kind of filename capture path.
// Word boundaries on `-` and `_` mean "filename" alone in prose doesn't
// match — only the camel-cased identifiers we never want to see used as
// code. The per-match heuristic below additionally tolerates the same
// identifier appearing inside a comment that explicitly forbids it.
const FORBIDDEN = [
  /\bclientFilenames\b/,
  /\bphotoFilenames\b/,
  /\bphotoFilename\b/,
  /\bfileNames\b/,
  /\bfileName\b/,
];

function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8');
}

test('family-review namespace has zero filename-capture identifiers', () => {
  const offenders: { file: string; pattern: RegExp; sample: string }[] = [];

  for (const rel of FAMILY_REVIEW_SOURCES) {
    const src = readSource(rel);
    for (const pat of FORBIDDEN) {
      // Allow the identifier ONLY inside a clearly-prose explanatory
      // comment that says it is intentionally not captured.
      const all = [...src.matchAll(new RegExp(pat.source, 'g'))];
      for (const m of all) {
        const idx = m.index ?? 0;
        const start = Math.max(0, idx - 80);
        const end = Math.min(src.length, idx + 80);
        const context = src.slice(start, end);
        const isProseExclusion =
          /NOT captured|never capture|do NOT|never read|forbidden/i.test(
            context,
          ) && /\*|\/\*|\/\/|comment/.test(src.slice(Math.max(0, idx - 200), idx));
        if (!isProseExclusion) {
          offenders.push({ file: rel, pattern: pat, sample: context });
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `family-review namespace must not contain filename-capture identifiers. Offenders: ${JSON.stringify(
      offenders,
      null,
      2,
    )}`,
  );
});

test('persisted submission schema declares only safe photo metadata fields', () => {
  const src = readSource('src/lib/family-review/store.ts');
  // Locate the photos: { ... } block on the FamilyReviewSubmission type
  // and verify it contains only count, uploadedToServer, and assets —
  // never a filename field. PhotoAsset's separate shape is checked below.
  const photoBlockMatch = src.match(/photos:\s*\{([\s\S]*?)\};\s*samples:/);
  assert.ok(photoBlockMatch, 'photos block must exist on FamilyReviewSubmission');
  const block = photoBlockMatch![1];
  const propLines = [...block.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\??:/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    propLines.sort(),
    ['assets', 'count', 'uploadedToServer'].sort(),
    `photos schema must be exactly { count, uploadedToServer, assets }. Got: ${propLines.join(', ')}`,
  );
});

test('PhotoAsset shape carries blob refs only — no filename, no original name', () => {
  const src = readSource('src/lib/family-review/store.ts');
  const m = src.match(/export interface PhotoAsset\s*\{([\s\S]*?)\}/);
  assert.ok(m, 'PhotoAsset interface must exist');
  const block = m![1];
  const propLines = [...block.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\??:/gm)].map(
    (x) => x[1],
  );
  assert.deepEqual(
    propLines.sort(),
    // blobUrl is now OPTIONAL and legacy-only: a privately stored asset
    // has no URL at all, only a pathname that is useless without the
    // store token. `storage` records which of the two an asset is.
    // Still an exact pin, and still the filename guard.
    ['assetId', 'blobPathname', 'blobUrl', 'storage', 'mime', 'size', 'uploadedAt'].sort(),
    `PhotoAsset schema regression. Got: ${propLines.join(', ')}`,
  );
});

test('upload route does NOT include any filename-shaped property in the persisted record', () => {
  const src = readSource('src/app/api/family-review/upload/route.ts');
  // Anything that looks like `clientFilenames: …` or `filenames: …`
  // in object-literal position is a regression. Strict regex matches
  // only property-key positions (preceded by `{` or `,` and followed
  // by `:`).
  const propKeyRegex = /[{,]\s*(clientFilenames|photoFilenames|filenames|fileNames)\s*:/g;
  const matches = [...src.matchAll(propKeyRegex)];
  assert.deepEqual(
    matches.map((m) => m[1]),
    [],
    'upload route must not assign any filename-shaped property',
  );
});

test('persisted record uses inviteCodeAccepted (boolean) — not literal invite code', () => {
  const route = readSource('src/app/api/family-review/upload/route.ts');
  // The record literal must use the boolean field and must NOT assign
  // the literal invite code under `inviteCodeUsed` or similar names.
  assert.match(route, /inviteCodeAccepted:\s*true/);
  assert.doesNotMatch(route, /[{,]\s*inviteCodeUsed\s*:/);
});

test('parent review portal route reads File.name from nowhere', () => {
  // file.name access in the parent-facing client component would mean
  // we're stashing the original filename somewhere — forbid it.
  for (const rel of [
    'src/app/family-review/review/[reviewToken]/review-portal.tsx',
    'src/app/family-review/review/[reviewToken]/page.tsx',
  ]) {
    const src = readSource(rel);
    assert.doesNotMatch(
      src,
      /\bfile\.name\b/i,
      `${rel} should not read File.name`,
    );
  }
});
