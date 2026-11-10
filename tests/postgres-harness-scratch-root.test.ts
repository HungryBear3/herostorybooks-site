import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as harness from './support/postgres-harness.ts';

// Filesystem only: never call startDisposableCluster or any PostgreSQL binary.
const scratch = '/Users/abigailclaw/.hermes/cache/scratch';
assert.equal(process.env.TMPDIR, scratch);
assert.equal(realpathSync(scratch), scratch);
const fixture = mkdtempSync(path.join(scratch, 'p-'));
test.after(() => rmSync(fixture, { recursive: true, force: true }));

test('default TMPDIR allocation is canonical, random, private and inside owned scratch', () => {
  const roots: string[] = [];
  try {
    roots.push(harness.createPostgresTempRoot(), harness.createPostgresTempRoot());
    assert.notEqual(roots[0], roots[1]);
    for (const root of roots) {
      assert.equal(path.dirname(root), scratch);
      assert.equal(realpathSync(root), root);
      assert.match(path.basename(root), /^hsb-cp-[A-Za-z0-9]{6}$/);
      assert.equal(statSync(root).mode & 0o777, 0o700);
      assert.equal(statSync(root).uid, process.getuid!());
      assert.ok(Buffer.byteLength(path.join(root, 's', '.s.PGSQL.65535')) <= 103);
      assert.deepEqual(readdirSync(root), []);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('explicit owned base is respected instead of /tmp', () => {
  const root = harness.createPostgresTempRoot(fixture);
  try { assert.equal(path.dirname(root), fixture); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('relative, blank, TCP and outside roots are rejected without allocation', () => {
  for (const base of ['', '.', 'relative', 'localhost:5432', '/tmp', `${scratch}-outside`, `${scratch}/../outside`]) {
    assert.throws(() => harness.createPostgresTempRoot(base), /PostgreSQL temp root/);
  }
  assert.deepEqual(readdirSync(fixture), []);
});

test('missing and non-directory bases are rejected without creating them', () => {
  const missing = path.join(fixture, 'missing');
  assert.throws(() => harness.createPostgresTempRoot(missing));
  assert.equal(existsSync(missing), false);
  const file = path.join(fixture, 'file');
  writeFileSync(file, 'sentinel');
  assert.throws(() => harness.createPostgresTempRoot(file), /PostgreSQL temp root/);
});

test('symlink bases and symlink ancestors are refused', () => {
  const real = path.join(fixture, 'real');
  mkdirSync(real, { mode: 0o700 });
  mkdirSync(path.join(real, 'child'), { mode: 0o700 });
  const link = path.join(fixture, 'link');
  symlinkSync(real, link);
  assert.throws(() => harness.createPostgresTempRoot(link), /PostgreSQL temp root/);
  assert.throws(() => harness.createPostgresTempRoot(path.join(link, 'child')), /PostgreSQL temp root/);
  assert.deepEqual(readdirSync(real), ['child']);
});

test('non-private base permissions are refused', () => {
  const base = path.join(fixture, 'mode');
  mkdirSync(base, { mode: 0o700 });
  chmodSync(base, 0o755);
  assert.throws(() => harness.createPostgresTempRoot(base), /PostgreSQL temp root/);
  assert.deepEqual(readdirSync(base), []);
});

test('socket path bound is byte-exact at 103 and refuses 104 before allocation', () => {
  const suffix = '/hsb-cp-XXXXXX/s/.s.PGSQL.65535';
  const targetLength = 103 - Buffer.byteLength(suffix);
  const base = path.join(fixture, 'x'.repeat(targetLength - Buffer.byteLength(fixture) - 1));
  mkdirSync(base, { mode: 0o700 });
  const root = harness.createPostgresTempRoot(base);
  try { assert.equal(Buffer.byteLength(path.join(root, 's', '.s.PGSQL.65535')), 103); }
  finally { rmSync(root, { recursive: true, force: true }); }
  const long = `${base}x`;
  mkdirSync(long, { mode: 0o700 });
  assert.throws(() => harness.createPostgresTempRoot(long), /socket path/);
  assert.deepEqual(readdirSync(long), []);
});

test('shell-option metacharacters in base are refused without allocation', () => {
  for (const tail of ["quote'", 'quote"', 'back\\slash', 'space here', '$value', '`value`', 'line\nbreak']) {
    assert.throws(() => harness.createPostgresTempRoot(path.join(fixture, tail)), /PostgreSQL temp root/);
  }
});
