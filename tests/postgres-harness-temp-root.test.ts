import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { selectPostgresTempBase, shortTempRoot, startDisposableCluster } from './support/postgres-harness.ts';

function withEnv(root: string | undefined, tmpdir: string | undefined, run: () => void): void {
  const saved = { root: process.env.HSB_CP_TEST_ROOT, tmpdir: process.env.TMPDIR };
  try {
    if (root === undefined) delete process.env.HSB_CP_TEST_ROOT;
    else process.env.HSB_CP_TEST_ROOT = root;
    if (tmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmpdir;
    run();
  } finally {
    if (saved.root === undefined) delete process.env.HSB_CP_TEST_ROOT;
    else process.env.HSB_CP_TEST_ROOT = saved.root;
    if (saved.tmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved.tmpdir;
  }
}

test('PostgreSQL temp roots: explicit opt-in and real filesystem validation (no PG)', async (t) => {
  // Never allocate fixtures in the legacy default: the runner supplies an owned parent.
  const parent = process.env.HSB_CP_TEST_ROOT ?? process.env.TMPDIR;
  assert.ok(parent, 'supply a short private fixture parent through HSB_CP_TEST_ROOT or TMPDIR');
  assert.equal(realpathSync(parent), parent);
  assert.equal(statSync(parent).uid, process.getuid!());
  assert.equal(statSync(parent).mode & 0o077, 0);
  const fixture = mkdtempSync(path.join(parent, 't-'));
  const makeDir = (name: string): string => {
    const dir = path.join(fixture, name);
    mkdirSync(dir, { mode: 0o700 });
    return dir;
  };
  const snapshot = (): string[] => readdirSync(fixture, { recursive: true }).map(String).sort();
  const alternate = makeDir('alt');
  try {
    await t.test('explicit private root wins over visible /tmp and alternate TMPDIR; children are fresh and private', () => {
      assert.ok(existsSync('/tmp') && statSync('/tmp').isDirectory(), 'this regression requires visible /tmp metadata');
      const before = snapshot();
      withEnv(fixture, alternate, () => {
        assert.equal(selectPostgresTempBase(), fixture);
        const children: string[] = [];
        try {
          children.push(shortTempRoot(), shortTempRoot());
          assert.notEqual(children[0], children[1]);
          for (const child of children) {
            assert.equal(path.dirname(child), fixture);
            assert.match(path.basename(child), /^hsb-cp-[A-Za-z0-9]{6}$/);
            assert.equal(lstatSync(child).isDirectory(), true);
            assert.equal(statSync(child).uid, process.getuid!());
            assert.equal(statSync(child).mode & 0o077, 0);
            assert.deepEqual(readdirSync(child), []);
          }
          assert.deepEqual(readdirSync(alternate), []);
        } finally {
          for (const child of children) rmSync(child, { recursive: true, force: true });
        }
      });
      assert.deepEqual(snapshot(), before);
      for (const tmpdir of [undefined, `${fixture}/missing`, 'invalid TMPDIR']) {
        withEnv(fixture, tmpdir, () => assert.equal(selectPostgresTempBase(), fixture));
      }
    });

    await t.test('invalid explicit roots fail closed with no new entries or fallback', () => {
      const target = makeDir('target');
      const alias = path.join(fixture, 'alias');
      symlinkSync(target, alias, 'dir');
      mkdirSync(path.join(target, 'child'), { mode: 0o700 });
      const file = path.join(fixture, 'file');
      writeFileSync(file, 'not a directory');
      const publicDir = makeDir('public');
      const unsafe = ['a b', "a'b", 'a"b', 'a;b', 'a$b', 'a`b', 'a\\b', 'a\nb', 'a\tb', 'a&b', 'a(b)', 'a=b', 'a:b', 'a😀b', 'a\n', 'a\r'];
      for (const name of unsafe) makeDir(name);
      const candidates = [
        '', '.', 'relative', `${fixture}/missing`, file, alias, `${alias}/child`,
        `${fixture}/`, `${fixture}/.`, `${fixture}//target`, `${fixture}/target/../target`,
        ...unsafe.map((name) => path.join(fixture, name)),
      ];
      // Cover every group/other permission bit, including execute-only exposure.
      for (const bit of [0o040, 0o020, 0o010, 0o004, 0o002, 0o001]) {
        chmodSync(publicDir, 0o700 | bit);
        const before = snapshot();
        withEnv(publicDir, alternate, () => {
          assert.throws(selectPostgresTempBase, /group or other/);
          assert.throws(shortTempRoot, /group or other/);
        });
        assert.equal(statSync(publicDir).mode & 0o777, 0o700 | bit);
        assert.deepEqual(snapshot(), before);
      }
      chmodSync(publicDir, 0o700);
      // Node truncates NUL on process.env assignment; pass it directly to the real selector.
      const beforeNul = snapshot();
      assert.throws(() => selectPostgresTempBase(`${fixture}\0bad`), /Invalid HSB_CP_TEST_ROOT/);
      assert.deepEqual(snapshot(), beforeNul);
      for (const candidate of candidates) {
        const before = snapshot();
        withEnv(candidate, alternate, () => {
          assert.throws(selectPostgresTempBase, undefined, JSON.stringify(candidate));
          assert.throws(shortTempRoot, undefined, JSON.stringify(candidate));
        });
        assert.deepEqual(snapshot(), before, JSON.stringify(candidate));
      }
      // Use real ownership metadata, without chown or a fake filesystem.
      assert.notEqual(statSync('/').uid, process.getuid!(), 'ownership case requires a non-root test process');
      withEnv('/', alternate, () => {
        assert.throws(selectPostgresTempBase, /process uid/);
        assert.throws(shortTempRoot, /process uid/);
      });
      assert.deepEqual(readdirSync(alternate), []);
    });

    await t.test('UTF-8 socket byte boundary accepts the limit and rejects one byte over', () => {
      const limit = process.platform === 'linux' ? 107 : 103;
      const suffix = '/hsb-cp-XXXXXX/s/.s.PGSQL.39999';
      const available = limit - Buffer.byteLength(`${fixture}/${suffix}`);
      assert.ok(available >= 4, 'fixture parent must be short enough for Unicode boundary cases');
      // A supplementary Unicode letter uses four UTF-8 bytes but two UTF-16 code units.
      const exact = makeDir('𐐀' + 'a'.repeat(available - 4));
      const over = makeDir('𐐀' + 'a'.repeat(available - 3));
      assert.equal(Buffer.byteLength(exact + suffix), limit);
      assert.equal(Buffer.byteLength(over + suffix), limit + 1);
      assert.ok((over + suffix).length < limit, 'code-unit counting would wrongly accept this root');
      const before = snapshot();
      withEnv(exact, alternate, () => {
        assert.equal(selectPostgresTempBase(), exact);
        const child = shortTempRoot();
        try {
          assert.equal(Buffer.byteLength(`${child}/s/.s.PGSQL.39999`), limit);
          assert.equal(path.dirname(child), exact);
        } finally {
          rmSync(child, { recursive: true, force: true });
        }
      });
      withEnv(over, alternate, () => {
        assert.throws(selectPostgresTempBase, /UTF-8 bytes/);
        assert.throws(shortTempRoot, /UTF-8 bytes/);
      });
      assert.deepEqual(snapshot(), before);
      const unicode = makeDir('é_é_漢-١');
      withEnv(unicode, alternate, () => assert.equal(selectPostgresTempBase(), unicode));
    });

    await t.test('unset uses the exact legacy base expression, without creating a default child', () => {
      const source = readFileSync(new URL('./support/postgres-harness.ts', import.meta.url), 'utf8');
      assert.ok(source.includes("const base = existsSync('/tmp') && statSync('/tmp').isDirectory() ? '/tmp' : (process.env.TMPDIR ?? '/tmp');"));
      for (const tmpdir of [undefined, '', alternate, `${fixture}/missing`]) {
        withEnv(undefined, tmpdir, () => {
          const expected = existsSync('/tmp') && statSync('/tmp').isDirectory() ? '/tmp' : (process.env.TMPDIR ?? '/tmp');
          assert.equal(selectPostgresTempBase(), expected);
        });
      }
    });

    await t.test('empty explicit configuration fails before cluster tool discovery', () => {
      const before = snapshot();
      withEnv('', alternate, () => assert.throws(startDisposableCluster, /Invalid HSB_CP_TEST_ROOT/));
      assert.deepEqual(snapshot(), before);
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
