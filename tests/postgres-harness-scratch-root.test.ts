import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as harness from './support/postgres-harness.ts';

// Filesystem only: never call startDisposableCluster or any PostgreSQL binary.
// Local runs bind the existing Mac scratch; a GitHub-hosted runner binds the
// fixed owned child of RUNNER_TEMP that the workflow creates with mode 0700.
const hostedRun = process.env.GITHUB_ACTIONS === 'true';
const scratch = hostedRun
  ? path.join(process.env.RUNNER_TEMP ?? '', 'hsb-scratch')
  : '/Users/abigailclaw/.hermes/cache/scratch';
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
  const padding = targetLength - Buffer.byteLength(fixture) - 1;
  assert.ok(padding >= 1, `fixture ${fixture} is too long to exercise the 103-byte bound`);
  const base = path.join(fixture, 'x'.repeat(padding));
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

// ── Hosted-runner admission seam ────────────────────────────────────────────
// Pure filesystem cases with a synthetic runner identity. They run on any host,
// but a passing positive case here does NOT demonstrate admission on Linux: on
// the Mac these fixtures also sit under the local scratch root. The no-fallback
// and wrong-identity refusals are what discriminate locally; admission of a
// RUNNER_TEMP outside the home directory is only exercised on the hosted runner.

type RunnerIdentity = { GITHUB_ACTIONS?: string; RUNNER_ENVIRONMENT?: string; RUNNER_TEMP?: string };
const create = harness.createPostgresTempRoot as (base?: string, identity?: RunnerIdentity) => string;
const HOSTED = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' } as const;
// Short names keep every positive fixture inside the 103-byte socket bound.
const hostedRoot = mkdtempSync(path.join(scratch, 'h-'));
test.after(() => rmSync(hostedRoot, { recursive: true, force: true }));

function runnerTemp(name: string, parentMode = 0o755, ownedMode = 0o700) {
  const parent = path.join(hostedRoot, name);
  const owned = path.join(parent, 'hsb-scratch');
  mkdirSync(parent);
  mkdirSync(owned);
  chmodSync(owned, ownedMode);
  chmodSync(parent, parentMode);
  return { parent, owned, identity: { ...HOSTED, RUNNER_TEMP: parent } as RunnerIdentity };
}

function privateDir(name: string): string {
  const directory = path.join(hostedRoot, name);
  mkdirSync(directory);
  chmodSync(directory, 0o700);
  return directory;
}

/** Refused, nothing allocated, nothing created. `pattern: null` admits an fs error. */
function refused(base: string, identity: RunnerIdentity, pattern: RegExp | null = /PostgreSQL temp root/): void {
  const snapshot = (): string | null => {
    let info;
    try { info = lstatSync(base); } catch { return null; }
    if (info.isSymbolicLink()) return `link:${readlinkSync(base)}`;
    if (info.isDirectory()) return `dir:${JSON.stringify(readdirSync(base))}`;
    return `file:${readFileSync(base).toString('base64')}`;
  };
  const before = snapshot();
  let allocated: string | undefined;
  try {
    allocated = create(base, identity);
  } catch (error) {
    if (pattern) assert.match((error as Error).message, pattern, `${base} ${JSON.stringify(identity)}`);
  }
  if (allocated !== undefined) {
    rmSync(allocated, { recursive: true, force: true });
    assert.fail(`allocated ${allocated} for base ${base} with identity ${JSON.stringify(identity)}`);
  }
  if (before !== null) assert.equal(snapshot(), before, `${base} was modified`);
  else assert.equal(existsSync(base), false, `${base} was created`);
}

function assertAllocatedUnder(owned: string, root: string): void {
  try {
    assert.equal(path.dirname(root), owned);
    assert.equal(realpathSync(root), root);
    assert.match(path.basename(root), /^hsb-cp-[A-Za-z0-9]{6}$/);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(root).uid, process.getuid!());
    assert.ok(Buffer.byteLength(path.join(root, 's', '.s.PGSQL.65535')) <= 103);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('runner identity is read from exactly the three hosted-runner names', () => {
  const read = (harness as Record<string, unknown>).currentRunnerIdentity;
  assert.equal(typeof read, 'function', 'currentRunnerIdentity is not exported by the harness');
  assert.deepEqual((read as () => unknown)(), {
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    RUNNER_ENVIRONMENT: process.env.RUNNER_ENVIRONMENT,
    RUNNER_TEMP: process.env.RUNNER_TEMP,
  });
});

test('a GitHub-hosted identity admits its fixed owned child of RUNNER_TEMP and descendants', () => {
  for (const [name, parentMode] of [['a', 0o755], ['b', 0o750], ['c', 0o700]] as const) {
    const rt = runnerTemp(name, parentMode);
    assert.ok(Buffer.byteLength(path.join(rt.owned, 'hsb-cp-XXXXXX', 's', '.s.PGSQL.65535')) <= 103);
    assertAllocatedUnder(rt.owned, create(rt.owned, rt.identity));
    const nested = path.join(rt.owned, 'n');
    mkdirSync(nested, { mode: 0o700 });
    chmodSync(nested, 0o700);
    assertAllocatedUnder(nested, create(nested, rt.identity));
  }
});

test('anything but an exact GitHub-hosted identity is refused for the owned child', () => {
  const rt = runnerTemp('d');
  for (const identity of [
    { ...rt.identity, RUNNER_ENVIRONMENT: 'self-hosted' },
    { ...rt.identity, RUNNER_ENVIRONMENT: 'Github-Hosted' },
    { ...rt.identity, RUNNER_ENVIRONMENT: '' },
    { GITHUB_ACTIONS: 'true', RUNNER_TEMP: rt.parent },
    { RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: rt.parent },
    { ...rt.identity, GITHUB_ACTIONS: 'false' },
    { ...rt.identity, GITHUB_ACTIONS: 'TRUE' },
    { ...rt.identity, GITHUB_ACTIONS: '' },
  ]) {
    refused(rt.owned, identity);
  }
});

test('partial or unknown runner markers never fall back to the local scratch root', () => {
  const rt = runnerTemp('e');
  const local = privateDir('l');
  for (const identity of [
    { RUNNER_TEMP: rt.parent },
    { GITHUB_ACTIONS: 'true' },
    { RUNNER_ENVIRONMENT: 'github-hosted' },
    { GITHUB_ACTIONS: '' },
    { GITHUB_ACTIONS: 'true', RUNNER_TEMP: rt.parent },
    { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_TEMP: rt.parent },
    // A complete hosted identity admits only its own child, never an unrelated private root.
    rt.identity,
  ] as RunnerIdentity[]) {
    refused(local, identity);
  }
  // Control: with no runner markers at all, the existing local binding still applies.
  if (hostedRun) {
    assert.throws(() => create(local, {}));
  } else {
    const root = create(local, {});
    assertAllocatedUnder(local, root);
  }
});

test('RUNNER_TEMP must be present, absolute, normalized and plain', () => {
  const rt = runnerTemp('f');
  for (const runnerTempValue of [
    '', 'relative', 'f', `${rt.parent}/`, `${rt.parent}/.`, path.join(hostedRoot, 'x') + '/../f',
    `${rt.parent} q`, `${rt.parent}'`, `${rt.parent}$x`,
  ]) {
    refused(rt.owned, { ...HOSTED, RUNNER_TEMP: runnerTempValue });
  }
  const missing = path.join(hostedRoot, 'missing');
  refused(rt.owned, { ...HOSTED, RUNNER_TEMP: missing }, null);
  assert.equal(existsSync(missing), false);
  const file = path.join(hostedRoot, 'file');
  writeFileSync(file, 'sentinel');
  refused(rt.owned, { ...HOSTED, RUNNER_TEMP: file }, null);
});

test('a symlinked RUNNER_TEMP or symlinked ancestor is refused', () => {
  const rt = runnerTemp('r');
  const link = path.join(hostedRoot, 's');
  symlinkSync(rt.parent, link);
  refused(path.join(link, 'hsb-scratch'), { ...HOSTED, RUNNER_TEMP: link });
  refused(rt.owned, { ...HOSTED, RUNNER_TEMP: link });

  const ancestor = path.join(hostedRoot, 'g');
  mkdirSync(ancestor, { mode: 0o755 });
  const inner = path.join(ancestor, 'r2');
  mkdirSync(inner);
  chmodSync(inner, 0o755);
  const innerOwned = path.join(inner, 'hsb-scratch');
  mkdirSync(innerOwned);
  chmodSync(innerOwned, 0o700);
  const ancestorLink = path.join(hostedRoot, 'al');
  symlinkSync(ancestor, ancestorLink);
  const viaLink = path.join(ancestorLink, 'r2');
  refused(path.join(viaLink, 'hsb-scratch'), { ...HOSTED, RUNNER_TEMP: viaLink });
  refused(innerOwned, { ...HOSTED, RUNNER_TEMP: viaLink });
});

test('a group- or world-writable RUNNER_TEMP is refused and never repaired', () => {
  for (const [name, mode] of [['w1', 0o775], ['w2', 0o757], ['w3', 0o777], ['w4', 0o1777]] as const) {
    const rt = runnerTemp(name, mode);
    refused(rt.owned, rt.identity);
    assert.equal(statSync(rt.parent).mode & 0o7777, mode, `${name} permissions were changed`);
  }
});

test('the owned child must be a private real directory named hsb-scratch', () => {
  const loose = runnerTemp('o1', 0o755, 0o750);
  refused(loose.owned, loose.identity);
  assert.equal(statSync(loose.owned).mode & 0o777, 0o750, 'owned child permissions were changed');

  const bare = path.join(hostedRoot, 'o2');
  mkdirSync(bare);
  chmodSync(bare, 0o755);
  const absent = path.join(bare, 'hsb-scratch');
  refused(absent, { ...HOSTED, RUNNER_TEMP: bare }, null);
  assert.equal(existsSync(absent), false);

  const linked = path.join(hostedRoot, 'o3');
  mkdirSync(linked);
  chmodSync(linked, 0o755);
  const target = privateDir('o3t');
  symlinkSync(target, path.join(linked, 'hsb-scratch'));
  refused(path.join(linked, 'hsb-scratch'), { ...HOSTED, RUNNER_TEMP: linked });
  refused(target, { ...HOSTED, RUNNER_TEMP: linked });

  const filed = path.join(hostedRoot, 'o4');
  mkdirSync(filed);
  chmodSync(filed, 0o755);
  writeFileSync(path.join(filed, 'hsb-scratch'), 'sentinel');
  refused(path.join(filed, 'hsb-scratch'), { ...HOSTED, RUNNER_TEMP: filed });
});

test('neither RUNNER_TEMP itself nor a sibling or unrelated root is admitted', () => {
  const rt = runnerTemp('u', 0o700);
  refused(rt.parent, rt.identity);
  for (const sibling of ['hsb-scratch-other', 'other']) {
    const directory = path.join(rt.parent, sibling);
    mkdirSync(directory);
    chmodSync(directory, 0o700);
    refused(directory, rt.identity);
  }
  const unrelated = runnerTemp('v');
  refused(unrelated.owned, rt.identity);
});
