import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  extractGroupBookToken,
  familyStorageKey,
  groupBookBlobTokenProblem,
  groupBookInvites,
} from '../src/lib/group-book/config.ts';
import { sniffGroupBookImage } from '../src/lib/group-book/image-type.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

test('server-only invite config requires unique strong family capabilities', () => {
  const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const parsed = groupBookInvites(JSON.stringify([{
    token,
    cohortId: 'cohort_alpha',
    familySlotId: 'family_one',
    cohortLabel: 'Private classroom keepsake',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }]));
  assert.equal(parsed.length, 1);
  // Invites are bare tokens only; a URL-shaped paste is never mined for one.
  assert.equal(extractGroupBookToken(`Private link: https://example.test/group-book/${token}`), null);
  assert.equal(extractGroupBookToken(` ${token} `), token);
  assert.equal(groupBookInvites(JSON.stringify([{ ...parsed[0], expiresAt: undefined }])).length, 0);
  assert.equal(groupBookInvites(JSON.stringify([{ ...parsed[0] }, { ...parsed[0] }])).length, 0);
  assert.equal(groupBookInvites(JSON.stringify([{ ...parsed[0], token: 'weak-code' }])).length, 0);
  assert.match(familyStorageKey(parsed[0]), /^[0-9a-f]{64}$/);
  assert.ok(!familyStorageKey(parsed[0]).includes(parsed[0].familySlotId));
});

test('group-book storage credential must be dedicated and private-lane shaped', () => {
  const previousAmbient = process.env.BLOB_READ_WRITE_TOKEN;
  const previousFamily = process.env.FAMILY_REVIEW_DEST_BLOB_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_orders_secret123';
  process.env.FAMILY_REVIEW_DEST_BLOB_TOKEN = 'vercel_blob_rw_family_secret456';
  try {
    assert.equal(groupBookBlobTokenProblem('vercel_blob_rw_groupbook_secret789'), null);
    assert.match(groupBookBlobTokenProblem(undefined) ?? '', /not set/);
    assert.match(groupBookBlobTokenProblem('not-a-token') ?? '', /not a well-formed/);
    assert.match(groupBookBlobTokenProblem('vercel_blob_rw_orders_othersecret') ?? '', /different Blob store/);
    assert.match(groupBookBlobTokenProblem('vercel_blob_rw_family_othersecret') ?? '', /different Blob store/);
  } finally {
    if (previousAmbient === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousAmbient;
    if (previousFamily === undefined) delete process.env.FAMILY_REVIEW_DEST_BLOB_TOKEN;
    else process.env.FAMILY_REVIEW_DEST_BLOB_TOKEN = previousFamily;
  }
});

test('photo type is decided from bytes, never a filename', () => {
  assert.deepEqual(sniffGroupBookImage(Uint8Array.from([0xff, 0xd8, 0xff])), { mime: 'image/jpeg', ext: 'jpg' });
  assert.deepEqual(sniffGroupBookImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), { mime: 'image/png', ext: 'png' });
  assert.equal(sniffGroupBookImage(new TextEncoder().encode('<svg onload=alert(1)>')), null);
});

test('synthetic private-store flow is create-only and withdrawal is append-only/idempotent', () => {
  const stdout = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      './tests/helpers/group-book-blob-register.mjs',
      './tests/helpers/group-book-store-scenario.ts',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const result = JSON.parse(stdout.trim()) as { paths: string[]; effectiveStatus: string };
  assert.equal(result.effectiveStatus, 'withdrawal_requested');
  assert.equal(result.paths.filter((value) => value.includes('/families/')).length, 1);
  assert.equal(result.paths.filter((value) => value.includes('/withdrawals/')).length, 1);
});

test('portal copy and source enforce separate semantics and hard external-action boundaries', () => {
  const portal = readFileSync(path.join(ROOT, 'src/app/group-book/parent-intake.tsx'), 'utf8');
  const familyPage = readFileSync(path.join(ROOT, 'src/app/group-book/family/page.tsx'), 'utf8');
  const intake = readFileSync(path.join(ROOT, 'src/app/api/group-book/intake/route.ts'), 'utf8');
  const store = readFileSync(path.join(ROOT, 'src/lib/group-book/store.ts'), 'utf8');
  const middleware = readFileSync(path.join(ROOT, 'middleware.ts'), 'utf8');
  const all = [portal, familyPage, intake, store].join('\n');

  assert.match(portal, /submitting only my own child/i);
  assert.match(portal, /shared only with the recipients those terms name/i);
  assert.doesNotMatch(portal, /heic|heif/i, 'HEIC is not advertised');
  assert.match(portal, /does not represent or imply school, teacher, district, or administrator approval/i);
  assert.match(portal, /Room parents\s+cannot see submissions/i);
  assert.match(familyPage, /No room parent or participating family can open this submission/i);
  assert.doesNotMatch(all, /NEXT_PUBLIC_GROUP_BOOK/);
  assert.doesNotMatch(all, /localStorage|sessionStorage/);
  assert.doesNotMatch(all, /stripe|resend|lulu|openai|gemini|fal\.ai/i);
  assert.doesNotMatch(all, /FAMILY_REVIEW_CODES|FAMILY_REVIEW_DEST_BLOB_TOKEN/);
  assert.match(store, /access:\s*'private'/);
  assert.match(store, /allowOverwrite:\s*false/g);
  assert.doesNotMatch(store, /access:\s*'public'/);
  assert.match(middleware, /GROUP_BOOK_PATH/);
  assert.match(middleware, /isFamilyReview \|\| isGroupBook/);
});

test('there is no room-parent, cohort-list, payment, or public-gallery route in the new namespace', () => {
  const routeFiles = execFileSync('rg', ['--files', 'src/app/api/group-book', 'src/app/group-book'], { cwd: ROOT, encoding: 'utf8' });
  assert.doesNotMatch(routeFiles, /admin|room-parent|cohort-list|gallery|payment|checkout|email/i);
});
