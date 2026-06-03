#!/usr/bin/env node
/**
 * HSB pre-deploy live-feature guardrail (READ-ONLY).
 *
 * Prevents a deploy / apex-www alias move from silently reverting a known-good
 * live feature. The 2026-06-03 regression: a deploy candidate omitted an
 * analytics hotfix and, in doing so, also reverted a good voice-upload fix.
 * This check verifies that every feature listed in the release manifest is
 * still present (as a commit ancestor) on the branch about to be promoted.
 *
 * It checks:
 *   - HEAD is on / descended from the canonical deploy train (unless
 *     --allow-off-train), and
 *   - each required live feature's requiredCommit OR a listed superseding
 *     commit is an ancestor of HEAD.
 *
 * READ-ONLY: only `git rev-parse` and `git merge-base --is-ancestor`. No file
 * writes, no network, no env mutation, no provider calls. Prints only commit
 * SHAs + feature names — never secrets.
 *
 * Usage:
 *   node scripts/predeploy-live-feature-check.mjs
 *        [--manifest=PATH] [--repo=DIR] [--head=REF] [--allow-off-train] [--json]
 *
 * Exit codes:
 *   0  PASS — every required feature present (and on-train, or overridden)
 *   1  FAIL — a required feature is missing, or HEAD is off-train
 *   2  invocation error (bad flag, unreadable manifest, not a git repo)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

// ── CLI ──────────────────────────────────────────────────────────────────────
let manifestPath = 'config/hsb-release-manifest.json';
let repo = '.';
let head = 'HEAD';
let allowOffTrain = false;
let json = false;
for (const a of process.argv.slice(2)) {
  if (a === '--json') json = true;
  else if (a === '--allow-off-train') allowOffTrain = true;
  else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
  else if (a.startsWith('--manifest=')) manifestPath = a.slice('--manifest='.length);
  else if (a.startsWith('--repo=')) repo = a.slice('--repo='.length);
  else if (a.startsWith('--head=')) head = a.slice('--head='.length);
  else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(2); }
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/predeploy-live-feature-check.mjs [--manifest=PATH] [--repo=DIR] [--head=REF] [--allow-off-train] [--json]\n' +
    'Read-only: verifies required live-feature commits are ancestors of HEAD before an alias cutover. No writes, no network, no secrets.\n',
  );
}

// ── Git helpers (read-only) ──────────────────────────────────────────────────
function git(gitArgs) {
  return execFileSync('git', ['-C', repo, ...gitArgs], { encoding: 'utf8' }).trim();
}
function commitExists(ref) {
  if (!ref) return false;
  try { git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]); return true; }
  catch { return false; }
}
function isAncestor(anc, desc) {
  if (!commitExists(anc)) return false;
  try {
    execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', anc, desc], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}
function resolveTrain(train) {
  for (const ref of [train, `origin/${train}`]) if (commitExists(ref)) return ref;
  return null;
}

// ── Load manifest + repo sanity ──────────────────────────────────────────────
if (!existsSync(manifestPath)) { console.error(`Manifest not found: ${manifestPath}`); process.exit(2); }
let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
catch (e) { console.error(`Manifest parse error: ${e.message}`); process.exit(2); }
if (!commitExists(head)) {
  console.error(`Cannot resolve HEAD ref '${head}' in repo '${repo}' (not a git repo?)`);
  process.exit(2);
}
const headSha = git(['rev-parse', '--short', head]);

// ── Checks ───────────────────────────────────────────────────────────────────
const results = [];

if (manifest.deployTrain) {
  const trainRef = resolveTrain(manifest.deployTrain);
  if (!trainRef) {
    results.push({ id: 'deploy-train', status: 'WARN', detail: `deploy train '${manifest.deployTrain}' not resolvable in this clone — cannot verify ancestry` });
  } else if (isAncestor(trainRef, head)) {
    results.push({ id: 'deploy-train', status: 'PASS', detail: `HEAD is on / descended from ${manifest.deployTrain}` });
  } else if (allowOffTrain) {
    results.push({ id: 'deploy-train', status: 'WARN', detail: `HEAD is NOT descended from ${manifest.deployTrain} (allowed via --allow-off-train)` });
  } else {
    results.push({ id: 'deploy-train', status: 'FAIL', detail: `HEAD is NOT on / descended from the canonical deploy train '${manifest.deployTrain}'. Rebase onto the train, or pass --allow-off-train if this promotion is intentional.` });
  }
}

for (const f of manifest.requiredLiveFeatures ?? []) {
  let satisfiedBy = null;
  if (isAncestor(f.requiredCommit, head)) satisfiedBy = f.requiredCommit;
  if (!satisfiedBy) {
    for (const s of f.supersededBy ?? []) {
      if (isAncestor(s, head)) { satisfiedBy = `${s} (supersedes ${f.requiredCommit})`; break; }
    }
  }
  if (satisfiedBy) {
    results.push({ id: f.id, name: f.name, status: 'PASS', detail: `present via ${satisfiedBy}` });
  } else {
    const unresolved = commitExists(f.requiredCommit) ? '' : ' [marker not in this clone]';
    const sup = (f.supersededBy ?? []).join(', ') || 'none';
    results.push({
      id: f.id,
      name: f.name,
      status: 'FAIL',
      detail: `required live feature MISSING: "${f.name}" — neither ${f.requiredCommit}${unresolved} nor any superseding commit (${sup}) is an ancestor of HEAD. Back-merge/cherry-pick it into the deploy train before aliasing.`,
    });
  }
}

const queued = (manifest.queuedNotRequired ?? []).map((q) => ({
  id: q.id, name: q.name, commit: q.commit, note: q.note, present: isAncestor(q.commit, head),
}));

const failures = results.filter((r) => r.status === 'FAIL');
const verdict = failures.length === 0 ? 'PASS' : 'FAIL';

// ── Output ───────────────────────────────────────────────────────────────────
if (json) {
  process.stdout.write(JSON.stringify({ repo, head: headSha, deployTrain: manifest.deployTrain ?? null, results, queued, verdict }, null, 2) + '\n');
} else {
  const mark = (s) => (s === 'PASS' ? '✅ PASS ' : s === 'FAIL' ? '❌ FAIL ' : '⚠️  WARN');
  process.stdout.write(`HSB pre-deploy live-feature check — HEAD ${headSha} — manifest ${manifestPath}\n(read-only; no writes, no network, no secrets)\n\n`);
  for (const r of results) process.stdout.write(`${mark(r.status)} ${r.id}\n    ${r.detail}\n`);
  if (queued.length) {
    process.stdout.write(`\nqueued (informational, not required for this gate):\n`);
    for (const q of queued) process.stdout.write(`  ${q.present ? '•' : '◦'} ${q.id} — ${q.present ? 'present' : 'absent'} (${q.commit}) — ${q.note}\n`);
  }
  process.stdout.write(`\nVerdict: ${verdict}\n`);
  if (verdict === 'FAIL') {
    process.stdout.write('Do NOT cut over the apex / www alias until the missing required feature(s) are back-merged into the deploy train.\n');
  }
}
process.exit(verdict === 'PASS' ? 0 : 1);
