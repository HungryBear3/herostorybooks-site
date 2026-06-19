/**
 * Tests for scripts/verify-hsb-cutover-readiness.mjs.
 *
 * The HTTP surface (page GETs + invalid webhook probes) is hard to exercise
 * hermetically, so we unit-test the pure classifiers and report logic that
 * decide PASS/WARN/FAIL. The script guards its CLI entry behind an
 * import.meta check, so importing it here runs no network calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VERDICT,
  CHECKOUT_MARKERS,
  classifyRoute,
  classifyAdminSurface,
  classifyWebhookProbe,
  scanMarkers,
  evaluatePredeployLineage,
  rollupVerdict,
  formatReport,
} from '../scripts/verify-hsb-cutover-readiness.mjs';

// ── classifyRoute ────────────────────────────────────────────────────────

test('classifyRoute: 2xx passes, 3xx warns, 404/5xx fail', () => {
  assert.equal(classifyRoute(200).verdict, VERDICT.PASS);
  assert.equal(classifyRoute(204).verdict, VERDICT.PASS);
  assert.equal(classifyRoute(301).verdict, VERDICT.WARN);
  assert.equal(classifyRoute(404).verdict, VERDICT.FAIL);
  assert.equal(classifyRoute(500).verdict, VERDICT.FAIL);
  assert.equal(classifyRoute(418).verdict, VERDICT.WARN);
});

// ── classifyAdminSurface ─────────────────────────────────────────────────

test('classifyAdminSurface: open 200 and missing 404 both FAIL; gated passes', () => {
  assert.equal(classifyAdminSurface(200).verdict, VERDICT.FAIL); // auth surface open
  assert.equal(classifyAdminSurface(404).verdict, VERDICT.FAIL); // missing
  assert.equal(classifyAdminSurface(401).verdict, VERDICT.PASS);
  assert.equal(classifyAdminSurface(403).verdict, VERDICT.PASS);
  assert.equal(classifyAdminSurface(302).verdict, VERDICT.PASS); // redirect to login
  assert.equal(classifyAdminSurface(500).verdict, VERDICT.FAIL);
});

// ── classifyWebhookProbe ─────────────────────────────────────────────────

test('classifyWebhookProbe: 400 is the canonical pass, 200 is a hard fail', () => {
  assert.equal(classifyWebhookProbe(400, { provider: 'stripe', pathProvided: true }).verdict, VERDICT.PASS);
  // accepting an invalid signature is the worst outcome
  assert.equal(classifyWebhookProbe(200, { provider: 'stripe', pathProvided: true }).verdict, VERDICT.FAIL);
  assert.equal(classifyWebhookProbe(401, { provider: 'stripe', pathProvided: true }).verdict, VERDICT.PASS);
});

test('classifyWebhookProbe: 404 depends on whether the path was supplied', () => {
  // explicit path that 404s is a real failure
  assert.equal(classifyWebhookProbe(404, { provider: 'resend', pathProvided: true }).verdict, VERDICT.FAIL);
  // default/unprovided path that 404s is a WARN, not a fabricated pass or fail
  assert.equal(classifyWebhookProbe(404, { provider: 'resend', pathProvided: false }).verdict, VERDICT.WARN);
  // stripe path is always supplied -> 404 must FAIL
  assert.equal(classifyWebhookProbe(404, { provider: 'stripe', pathProvided: true }).verdict, VERDICT.FAIL);
});

// ── scanMarkers ──────────────────────────────────────────────────────────

test('scanMarkers: present markers found and absent markers missing all PASS', () => {
  const html = `
    <main>Custom Story · Built from your voice note · Custom story lesson ·
    Custom occasion · 32-page high-res PDF delivered after approval</main>`;
  const results = scanMarkers(html);
  for (const r of results) assert.equal(r.verdict, VERDICT.PASS, `${r.label} should pass: ${r.detail}`);
});

test('scanMarkers: a missing present-marker FAILs', () => {
  const html = '<main>Custom story lesson · Custom occasion · 32-page high-res PDF</main>';
  const results = scanMarkers(html);
  const voice = results.find((r) => r.label === 'Built from your voice note');
  assert.equal(voice?.verdict, VERDICT.FAIL);
});

test('scanMarkers: a present absent-marker (old pronoun UI) FAILs', () => {
  const html = '<main>Custom Story Built from your voice note Custom story lesson Custom occasion 32-page high-res PDF Hero pronouns</main>';
  const results = scanMarkers(html);
  const hero = results.find((r) => r.label === 'Hero pronouns');
  assert.equal(hero?.verdict, VERDICT.FAIL);
});

test('scanMarkers covers exactly the documented 7 markers', () => {
  assert.equal(CHECKOUT_MARKERS.length, 7);
  assert.equal(CHECKOUT_MARKERS.filter((m) => m.kind === 'present').length, 5);
  assert.equal(CHECKOUT_MARKERS.filter((m) => m.kind === 'absent').length, 2);
});

// ── evaluatePredeployLineage ─────────────────────────────────────────────

test('evaluatePredeployLineage: script + anchor = PASS', () => {
  const r = evaluatePredeployLineage({ scriptNames: ['build', 'predeploy:live-features'], manifestFound: true, buildIdFound: false });
  assert.equal(r.verdict, VERDICT.PASS);
});

test('evaluatePredeployLineage: partial or none = WARN, never silent pass', () => {
  assert.equal(evaluatePredeployLineage({ scriptNames: ['predeploy:live-features'], manifestFound: false, buildIdFound: false }).verdict, VERDICT.WARN);
  assert.equal(evaluatePredeployLineage({ scriptNames: ['build', 'test'], manifestFound: false, buildIdFound: false }).verdict, VERDICT.WARN);
  // a generic predeploy* script still counts as a partial anchor
  assert.equal(evaluatePredeployLineage({ scriptNames: ['predeploy'], manifestFound: false }).verdict, VERDICT.WARN);
});

// ── rollupVerdict ────────────────────────────────────────────────────────

test('rollupVerdict: worst-of wins, SKIP is ignored', () => {
  assert.equal(rollupVerdict([{ verdict: VERDICT.PASS }, { verdict: VERDICT.SKIP }]), VERDICT.PASS);
  assert.equal(rollupVerdict([{ verdict: VERDICT.PASS }, { verdict: VERDICT.WARN }]), VERDICT.WARN);
  assert.equal(rollupVerdict([{ verdict: VERDICT.WARN }, { verdict: VERDICT.FAIL }]), VERDICT.FAIL);
  assert.equal(rollupVerdict([{ verdict: VERDICT.SKIP }]), VERDICT.PASS);
});

// ── formatReport ─────────────────────────────────────────────────────────

test('formatReport: includes overall verdict and read-only safety lines', () => {
  const out = formatReport(
    [{ title: 'Routes', checks: [{ name: '/', verdict: VERDICT.PASS, detail: 'home 200' }] }],
    VERDICT.PASS,
  );
  assert.match(out, /OVERALL: PASS/);
  assert.match(out, /Production deploy: NOT RUN/);
  assert.match(out, /Apex\/www alias: NOT TOUCHED/);
  assert.match(out, /mutations: NONE/);
});
