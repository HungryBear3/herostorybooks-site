/**
 * The classroom local proof as a fresh process, under the runtime configurations
 * it must accept and the ones it must refuse. The real suite, real PDFKit and the
 * real pdftotext run; each case owns its own temporary directories.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = 'tests/classroom-local-proof.test.ts';
const ARTIFACT_DIR = 'synthetic-classroom-local-proof-artifact';
const ARTIFACT_LINE = 'SUBCASE J01 artifact path=';

function runProof(overrides: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A child test runner must not inherit this runner's own worker context.
  for (const name of ['HSB_OWNED_TEST_RUNTIME', 'NODE_TEST_CONTEXT']) delete env[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const run = spawnSync(process.execPath, [
    '--experimental-strip-types', '--experimental-test-module-mocks', '--no-warnings',
    '--test', '--test-reporter=spec', '--test-name-pattern=^J01_', SUITE,
  ], { cwd: ROOT, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

function artifactPath(output: string): string {
  const line = output.split('\n').find((candidate) => candidate.includes(ARTIFACT_LINE));
  assert.ok(line, output);
  return line.slice(line.indexOf(ARTIFACT_LINE) + ARTIFACT_LINE.length).split(' ')[0];
}

function inWorkspace(run: (dir: string) => void): void {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hsb-proof-runtime-')));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeDirs(...dirs: string[]): void {
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
}

test('without an explicit runtime the proof owns an isolated home and tmp beneath TMPDIR', () => {
  inWorkspace((dir) => {
    const tmp = path.join(dir, 'tmp');
    const home = path.join(dir, 'home');
    makeDirs(tmp, home);
    const run = runProof({ TMPDIR: tmp, HOME: home });
    assert.equal(run.status, 0, run.output);
    assert.ok(artifactPath(run.output).startsWith(`${tmp}${path.sep}`), run.output);
    assert.deepEqual(readdirSync(home), [], 'the inherited home is never written');
    assert.deepEqual(readdirSync(tmp), [], 'the owned runtime is removed at exit');
  });
});

test('an explicit confined runtime is honoured and a fresh proof never overwrites an earlier one', () => {
  inWorkspace((dir) => {
    const root = path.join(dir, 'owned');
    const home = path.join(root, 'home');
    const tmp = path.join(root, 'tmp');
    const artifacts = path.join(root, ARTIFACT_DIR);
    makeDirs(home, tmp, artifacts);
    const original = path.join(artifacts, 'synthetic-classroom-local-proof.pdf');
    writeFileSync(original, 'ORIGINAL-SUCCESSFUL-PDF');
    const env = { HSB_OWNED_TEST_RUNTIME: root, HOME: home, TMPDIR: tmp };

    const first = runProof(env);
    assert.equal(first.status, 0, first.output);
    const firstPath = artifactPath(first.output);
    assert.ok(firstPath.startsWith(`${artifacts}${path.sep}`), first.output);
    assert.notEqual(firstPath, original);
    assert.equal(readFileSync(original, 'utf8'), 'ORIGINAL-SUCCESSFUL-PDF');
    const firstBytes = readFileSync(firstPath);
    assert.equal(firstBytes.subarray(0, 5).toString('latin1'), '%PDF-');

    const second = runProof(env);
    assert.equal(second.status, 0, second.output);
    assert.notEqual(artifactPath(second.output), firstPath);
    assert.deepEqual(readFileSync(firstPath), firstBytes);
    assert.equal(readFileSync(original, 'utf8'), 'ORIGINAL-SUCCESSFUL-PDF');
  });
});

test('invalid runtime or tool configuration fails clearly before any proof runs', () => {
  inWorkspace((dir) => {
    const root = path.join(dir, 'owned');
    const home = path.join(root, 'home');
    const tmp = path.join(root, 'tmp');
    const outside = path.join(dir, 'outside');
    const noTools = path.join(dir, 'no-tools');
    const notExecutable = path.join(dir, 'not-executable');
    makeDirs(home, tmp, outside, noTools);
    writeFileSync(notExecutable, 'plain text', { mode: 0o600 });
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ HSB_OWNED_TEST_RUNTIME: 'relative/runtime' }, 'HSB_OWNED_TEST_RUNTIME must be absolute'],
      [{ HSB_OWNED_TEST_RUNTIME: '' }, 'HSB_OWNED_TEST_RUNTIME must be absolute'],
      [{ HSB_OWNED_TEST_RUNTIME: path.join(dir, 'missing') }, 'HSB_OWNED_TEST_RUNTIME must be an existing directory'],
      [{ HSB_OWNED_TEST_RUNTIME: root, HOME: outside, TMPDIR: tmp }, 'HOME must be confined to the owned runtime'],
      [{ HSB_OWNED_TEST_RUNTIME: root, HOME: home, TMPDIR: outside }, 'TMPDIR must be confined to the owned runtime'],
      [{ TMPDIR: path.join(dir, 'missing') }, 'TMPDIR must be an existing directory'],
      [{ TMPDIR: 'relative/tmp' }, 'TMPDIR must be absolute'],
      [{ TMPDIR: tmp, HOME: home, HSB_PDFTOTEXT: 'pdftotext' }, 'HSB_PDFTOTEXT must be absolute'],
      [{ TMPDIR: tmp, HOME: home, HSB_PDFTOTEXT: notExecutable }, 'HSB_PDFTOTEXT must be an executable file'],
      [{ TMPDIR: tmp, HOME: home, HSB_PDFTOTEXT: undefined, PATH: noTools }, 'pdftotext must be on PATH'],
    ];
    for (const [env, message] of cases) {
      const run = runProof(env);
      assert.notEqual(run.status, 0, message);
      assert.ok(run.output.includes(message), `${message}\n${run.output}`);
      assert.equal(run.output.includes(ARTIFACT_LINE), false, message);
    }
  });
});
