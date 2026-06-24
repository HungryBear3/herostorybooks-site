/**
 * G5 Operator Control Room — verdict + safety tests.
 *
 * Verdict behavior is exercised directly against the pure computeVerdict().
 * The single-source-of-truth (banner == hero) and no-secret-render guarantees
 * are locked via page-source assertions, matching the repo's convention for
 * server components with no DOM renderer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  computeVerdict,
  DEMO_STATE_GREEN,
  DEMO_STATE_YELLOW,
  type ControlRoomState,
} from '../src/lib/g5-control-room.ts';

const PAGE = readFileSync(new URL('../src/app/admin/g5-control-room/page.tsx', import.meta.url), 'utf8');
const LIB = readFileSync(new URL('../src/lib/g5-control-room.ts', import.meta.url), 'utf8');

/** A passing baseline we mutate per-case. */
function baseGreen(): ControlRoomState {
  return structuredClone(DEMO_STATE_GREEN);
}

// ── RED cases ────────────────────────────────────────────────────────────────

test('RED if RESEND_WEBHOOK_SECRET missing', () => {
  const s = baseGreen();
  s.email.webhookSecretPresent = false;
  const v = computeVerdict(s);
  assert.equal(v.verdict, 'RED');
  assert.ok(v.blockers.some((b) => /RESEND_WEBHOOK_SECRET missing/.test(b.message)));
});

test('RED if email health unverifiable', () => {
  const s = baseGreen();
  s.email.health = 'unverifiable';
  const v = computeVerdict(s);
  assert.equal(v.verdict, 'RED');
  assert.ok(v.blockers.some((b) => /email health unverifiable/.test(b.message)));
});

test('RED if G5 packet incomplete', () => {
  const s = baseGreen();
  s.packet = { complete: false, missingItems: ['proof QA sign-off'] };
  const v = computeVerdict(s);
  assert.equal(v.verdict, 'RED');
  assert.ok(v.blockers.some((b) => b.category === 'packet'));
});

// ── YELLOW ───────────────────────────────────────────────────────────────────

test('YELLOW only when blockers are clear and accepted warnings remain', () => {
  // The canonical YELLOW demo: no blockers, one accepted warning.
  const v = computeVerdict(DEMO_STATE_YELLOW);
  assert.equal(v.verdict, 'YELLOW');
  assert.equal(v.blockers.length, 0);
  assert.ok(v.warnings.length >= 1);

  // An UN-accepted warning is not YELLOW — it becomes a blocker → RED.
  const s = baseGreen();
  s.warnings = [{ code: 'x', message: 'unreviewed risk', accepted: false }];
  const vr = computeVerdict(s);
  assert.equal(vr.verdict, 'RED');

  // A blocker + an accepted warning is still RED, never YELLOW.
  const s2 = structuredClone(DEMO_STATE_YELLOW);
  s2.packet = { complete: false, missingItems: ['x'] };
  assert.equal(computeVerdict(s2).verdict, 'RED');
});

// ── GREEN ────────────────────────────────────────────────────────────────────

test('GREEN only when all required checks pass and packet complete', () => {
  const v = computeVerdict(DEMO_STATE_GREEN);
  assert.equal(v.verdict, 'GREEN');
  assert.equal(v.blockers.length, 0);
  assert.equal(v.warnings.length, 0);

  // Any single regression flips it off GREEN.
  for (const mutate of [
    (s: ControlRoomState) => (s.operator.named = false),
    (s: ControlRoomState) => (s.sideEffect.customerSideEffectRisk = true),
    (s: ControlRoomState) => (s.email.health = 'stale'),
    (s: ControlRoomState) => (s.env[0].status = 'missing'),
    (s: ControlRoomState) => (s.switches.push({ id: 'KS-3 owner print-go', status: 'uncertain', enforced: true })),
  ]) {
    const s = baseGreen();
    mutate(s);
    assert.notEqual(computeVerdict(s).verdict, 'GREEN');
  }

  // A non-prod (but present) env is a warning, not GREEN.
  const s = baseGreen();
  s.env[0].status = 'present_nonprod';
  assert.equal(computeVerdict(s).verdict, 'YELLOW');
});

test('computeVerdict is pure: same input → identical output, input unmutated', () => {
  const s = structuredClone(DEMO_STATE_YELLOW);
  const snapshot = JSON.stringify(s);
  const a = computeVerdict(s);
  const b = computeVerdict(s);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(s), snapshot, 'state must not be mutated');
});

// ── sticky banner verdict matches hero verdict ───────────────────────────────

test('sticky banner verdict matches hero verdict (single source of truth)', () => {
  // Verdict is computed exactly once in the page and reused.
  const calls = PAGE.match(/computeVerdict\(/g) ?? [];
  assert.equal(calls.length, 1, 'page must compute the verdict exactly once');

  // Both surfaces render from the same `verdict.verdict` value.
  assert.match(PAGE, /data-testid="sticky-banner"[\s\S]*?data-verdict=\{verdict\.verdict\}/);
  assert.match(PAGE, /data-testid="hero-verdict"[\s\S]*?data-verdict=\{verdict\.verdict\}/);
});

// ── no secret-like values render ─────────────────────────────────────────────

test('no secret-like values appear in the lib state or the page', () => {
  // Structural: serialized demo states + page source carry no key/token bodies.
  const serialized = JSON.stringify([DEMO_STATE_GREEN, DEMO_STATE_YELLOW]);
  const secretLike = /(sk_(live|test)_|whsec-REDACTED-|re_[A-Za-z0-9]{6,}|vercel-blob-rw-REDACTED-|[A-Za-z0-9_-]{32,})/;
  assert.doesNotMatch(serialized, secretLike, 'demo state must not contain secret-like values');
  assert.doesNotMatch(PAGE, secretLike, 'page must not embed secret-like values');

  // The state type only carries booleans/status/labels — there is no `value`
  // field that could hold a secret, and the email panel renders booleans only.
  assert.doesNotMatch(LIB, /value\s*:/, 'state shape must not carry raw values');
  assert.match(PAGE, /Presence \/ shape only — secret values are never read or shown/);
});
