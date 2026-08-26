/**
 * Migration utility guards: dry-run default, multi-part confirmation,
 * Production targeting, hard-disabled source deletion, idempotency and
 * resume semantics.
 *
 * These exercise the pure guards; nothing here touches a store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  applyAuthorizationProblems,
  destructiveFlag,
  parseArgs,
} from '../scripts/family-review-migrate-assets.ts';

function migrationSource(): string {
  return readFileSync(
    resolve(process.cwd(), 'scripts/family-review-migrate-assets.ts'),
    'utf8',
  );
}

/* ── 1. Dry run is the default ─────────────────────────────────────── */

test('no flags means dry run', () => {
  const args = parseArgs([]);
  assert.equal(args.apply, false);
  assert.equal(args.target, null);
});

test('a dry run needs no confirmation at all', () => {
  // The authorization gate is only consulted when --apply is present;
  // with no flags the parsed intent is already non-writing.
  assert.equal(parseArgs(['--limit=5', '--submission=fr-abc']).apply, false);
});

/* ── 2. Multi-part confirmation ────────────────────────────────────── */

test('--apply alone is refused', () => {
  const problems = applyAuthorizationProblems(
    'preview',
    parseArgs(['--apply']),
    undefined,
  );
  assert.ok(problems.length >= 2, 'both the target and the env confirmation are missing');
  assert.ok(problems.some((p) => p.includes('--target')));
  assert.ok(problems.some((p) => p.includes('FAMILY_REVIEW_MIGRATION_CONFIRM')));
});

test('--apply with the right target but no env confirmation is refused', () => {
  const problems = applyAuthorizationProblems(
    'preview',
    parseArgs(['--apply', '--target=preview']),
    undefined,
  );
  assert.deepEqual(problems.length, 1);
  assert.match(problems[0], /FAMILY_REVIEW_MIGRATION_CONFIRM/);
});

test('a confirmation naming a DIFFERENT store is refused', () => {
  const problems = applyAuthorizationProblems(
    'production',
    parseArgs(['--apply', '--target=production']),
    'i-am-migrating-preview',
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /must be exactly 'i-am-migrating-production'/);
});

test('a --target that disagrees with the resolved store is refused', () => {
  const problems = applyAuthorizationProblems(
    'production',
    parseArgs(['--apply', '--target=preview']),
    'i-am-migrating-production',
  );
  assert.ok(problems.some((p) => p.includes('does not match the resolved store')));
});

test('all three matching confirmations authorize the write', () => {
  assert.deepEqual(
    applyAuthorizationProblems(
      'preview',
      parseArgs(['--apply', '--target=preview']),
      'i-am-migrating-preview',
    ),
    [],
  );
});

test('Production cannot be reached without literally naming it twice', () => {
  // Every partial combination must still be refused.
  const partials: [string[], string | undefined][] = [
    [['--apply'], 'i-am-migrating-production'],
    [['--apply', '--target=production'], undefined],
    [['--apply', '--target=production'], 'i-am-migrating-preview'],
    [['--apply', '--target=preview'], 'i-am-migrating-production'],
    [[], 'i-am-migrating-production'],
  ];
  for (const [argv, confirm] of partials) {
    assert.ok(
      applyAuthorizationProblems('production', parseArgs(argv), confirm).length > 0,
      `argv=${JSON.stringify(argv)} confirm=${String(confirm)} must NOT authorize a production write`,
    );
  }
});

/* ── 3. Source deletion is hard-disabled ───────────────────────────── */

test('any deletion-shaped flag is detected for refusal', () => {
  for (const flag of [
    '--delete-source',
    '--delete',
    '--purge',
    '--purge-public',
    '--remove-source',
    '--drop-legacy',
    '--DELETE-SOURCE',
  ]) {
    assert.equal(destructiveFlag([flag]), flag, `${flag} must be refused`);
  }
  assert.equal(destructiveFlag(['--apply', '--limit=3']), null);
});

test('the migration source contains no delete/copy-destructive call', () => {
  const src = migrationSource();
  assert.doesNotMatch(
    src,
    /\bdel\s*\(/,
    'the migration must never call the Blob delete API',
  );
  assert.doesNotMatch(
    src,
    /from '@vercel\/blob'[\s\S]{0,120}\bdel\b/,
    'the migration must not even import the delete API',
  );
});

/* ── 4. Copy → verify → record ordering, and idempotency ───────────── */

test('metadata is flipped only AFTER verification passes', () => {
  const src = migrationSource();
  const verifyIdx = src.indexOf('const verified = await copyAndVerify');
  const flipIdx = src.indexOf("asset.storage = 'private'");
  assert.ok(verifyIdx > 0 && flipIdx > 0);
  assert.ok(
    verifyIdx < flipIdx,
    'the record must not be updated before the bytes are verified',
  );
  // And the failure branch must return before reaching the flip.
  const between = src.slice(verifyIdx, flipIdx);
  assert.match(
    between,
    /if \(verified\.ok === false\)[\s\S]*?return;/,
    'a failed verification must return without touching the record',
  );
});

test('verification compares size, content type, AND a content hash', () => {
  const src = migrationSource();
  assert.match(src, /size_mismatch/);
  assert.match(src, /content_type_mismatch/);
  assert.match(src, /hash_mismatch/);
  assert.match(src, /sha256\(roundTripped\) !== sourceHash/);
});

test('an already-private asset is skipped, making re-runs idempotent', () => {
  const src = migrationSource();
  assert.match(
    src,
    /if \(asset\.storage === 'private'\)[\s\S]{0,200}already_private/,
    'a migrated asset must be skipped on every later run',
  );
});

/* ── 5. Enumeration is scoped, never inferred ──────────────────────── */

test('enumeration is bounded and confined to the Family Review prefix', () => {
  const src = migrationSource();
  assert.match(
    src,
    /withBlobNamespace\('family-review\/submissions\/'\)/,
    'only the Family Review submissions prefix may be listed',
  );
  assert.match(src, /MAX_LIST_PAGES/, 'paging must be bounded');
  // Asset paths come from inside the record, never from a prefix scan.
  assert.doesNotMatch(
    src,
    /list\(\{\s*prefix:\s*withBlobNamespace\('family-review\/(photos|samples)/,
    'asset objects must never be discovered by globbing a prefix',
  );
});

/* ── 6. Redacted reporting ─────────────────────────────────────────── */

test('reporting carries opaque ids and counts only — never PII or URLs', () => {
  const src = migrationSource();
  const reportBlock = src.slice(src.indexOf('const tally = new Map'));
  for (const forbidden of ['parent', 'email', 'firstName', 'reviewToken', 'blobUrl', 'blobPathname']) {
    assert.ok(
      !reportBlock.includes(forbidden),
      `migration output must never include ${forbidden}`,
    );
  }
});
