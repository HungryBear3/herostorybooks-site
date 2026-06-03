/**
 * Tests for scripts/predeploy-live-feature-check.mjs.
 *
 * Builds a throwaway git repo with synthetic commits and synthetic manifests,
 * then spawns the real script against it. Never touches the real repo history
 * or the committed manifest. Read-only behavior is exercised end-to-end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = fileURLToPath(new URL('../scripts/predeploy-live-feature-check.mjs', import.meta.url));

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'predeploy-check-'));
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  const commit = (msg: string, body: string) => {
    writeFileSync(path.join(dir, 'f.txt'), body);
    g('add', '-A');
    g('commit', '-q', '-m', msg);
    return g('rev-parse', 'HEAD');
  };
  const A = commit('A', 'a');
  const B = commit('B', 'b');
  const MAIN = g('rev-parse', '--abbrev-ref', 'HEAD'); // default branch (main/master)
  g('branch', 'deploytrain'); // train points at B
  const C = commit('C', 'c'); // HEAD (MAIN) descends from train(B)
  // Side commit D, branched from A — NOT in MAIN/train history.
  g('checkout', '-q', '-b', 'side', A);
  const D = commit('D', 'd');
  g('checkout', '-q', MAIN);
  return { dir, g, A, B, C, D, MAIN };
}

function writeManifest(dir: string, name: string, manifest: unknown): string {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify(manifest, null, 2));
  return p;
}

function run(repo: string, manifestPath: string, extra: string[] = []) {
  const r = spawnSync('node', [SCRIPT, `--repo=${repo}`, `--manifest=${manifestPath}`, ...extra], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('PASS when the required commit is an ancestor of HEAD and HEAD is on the deploy train', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  const m = writeManifest(repo.dir, 'ok.json', {
    deployTrain: 'deploytrain',
    requiredLiveFeatures: [{ id: 'feat-b', name: 'Feature B', requiredCommit: repo.B, supersededBy: [] }],
    queuedNotRequired: [],
  });
  const r = run(repo.dir, m);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Verdict: PASS/);
  assert.match(r.stdout, /✅ PASS\s+feat-b/);
  assert.match(r.stdout, /✅ PASS\s+deploy-train/);
});

test('FAIL with a clear message when the voice marker is missing (no superseding commit)', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  const m = writeManifest(repo.dir, 'missing-voice.json', {
    deployTrain: 'deploytrain',
    requiredLiveFeatures: [{ id: 'voice-upload', name: 'voice upload section', requiredCommit: repo.D, supersededBy: [] }],
    queuedNotRequired: [],
  });
  const r = run(repo.dir, m);
  assert.equal(r.status, 1, 'missing required feature must fail');
  assert.match(r.stdout, /Verdict: FAIL/);
  assert.match(r.stdout, /❌ FAIL\s+voice-upload/);
  assert.match(r.stdout, /required live feature MISSING: "voice upload section"/);
  // Clear pre-alias message.
  assert.match(r.stdout, /Do NOT cut over the apex \/ www alias/);
});

test('supports superseding commit markers (requiredCommit absent-from-history but a superseder is present)', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  const m = writeManifest(repo.dir, 'superseded.json', {
    deployTrain: 'deploytrain',
    // requiredCommit D is NOT an ancestor of HEAD, but B (a superseder) IS.
    requiredLiveFeatures: [{ id: 'voice-upload', name: 'voice upload section', requiredCommit: repo.D, supersededBy: [repo.B] }],
    queuedNotRequired: [],
  });
  const r = run(repo.dir, m);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Verdict: PASS/);
  assert.match(r.stdout, new RegExp(`present via ${repo.B.slice(0, 10)}`));
  assert.match(r.stdout, /supersedes/);
});

test('FAIL when HEAD is off the deploy train; --allow-off-train downgrades to WARN', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  const m = writeManifest(repo.dir, 'offtrain.json', {
    deployTrain: 'deploytrain',
    // Required commit A is an ancestor of BOTH the train and the off-train HEAD,
    // so this test isolates the deploy-train check (the feature is satisfied
    // either way; only on-train-ness flips between FAIL and WARN).
    requiredLiveFeatures: [{ id: 'feat-a', name: 'Feature A', requiredCommit: repo.A, supersededBy: [] }],
    queuedNotRequired: [],
  });
  // HEAD = side commit D, which is not descended from deploytrain(B).
  const offTrain = run(repo.dir, m, [`--head=${repo.D}`]);
  assert.equal(offTrain.status, 1, 'off-train HEAD must fail before alias cutover');
  assert.match(offTrain.stdout, /❌ FAIL\s+deploy-train/);
  assert.match(offTrain.stdout, /NOT on \/ descended from the canonical deploy train/);

  // With the explicit override, the off-train check is a WARN, not a FAIL.
  const overridden = run(repo.dir, m, [`--head=${repo.D}`, '--allow-off-train']);
  assert.equal(overridden.status, 0, overridden.stdout + overridden.stderr);
  assert.match(overridden.stdout, /⚠️\s*WARN\s+deploy-train/);
  assert.match(overridden.stdout, /Verdict: PASS/);
});

test('JSON output is valid and reflects the verdict', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  const m = writeManifest(repo.dir, 'json.json', {
    deployTrain: 'deploytrain',
    requiredLiveFeatures: [{ id: 'voice-upload', name: 'voice', requiredCommit: repo.D, supersededBy: [] }],
    queuedNotRequired: [{ id: 'queued-x', name: 'Queued X', commit: repo.D, note: 'not required' }],
  });
  const r = run(repo.dir, m, ['--json']);
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.verdict, 'FAIL');
  const voice = parsed.results.find((x: { id: string }) => x.id === 'voice-upload');
  assert.equal(voice.status, 'FAIL');
  // queued item present=false (absent) and never affects the verdict.
  assert.equal(parsed.queued[0].present, false);
});
