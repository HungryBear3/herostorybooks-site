/**
 * Owner-test checkout gate — default-closed, BOTH-layer gate.
 *
 * Controlled owner-test posture: /api/order must refuse to create a Stripe
 * Checkout Session unless BOTH are true:
 *   1. HSB_OWNER_TEST_CHECKOUT_ENABLED === 'true'  (global explicit enable)
 *   2. the buyer email is on HSB_OWNER_TEST_EMAILS  (comma-separated,
 *      case-insensitive, trimmed)
 *
 * Default with NO env set MUST be closed. The customer-facing response must
 * not leak the allowlist contents (the gate reason is internal only).
 *
 * These tests pass env values explicitly so the suite never mutates
 * process.env and stays order-independent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  OWNER_TEST_GATE_CODE,
  OWNER_TEST_GATE_MESSAGE,
  evaluateOwnerTestGate,
  isOwnerTestCheckoutEnabled,
  isOwnerTestEmailAllowed,
  parseOwnerTestEmails,
} from '../src/lib/owner-test-gate.ts';

// ── isOwnerTestCheckoutEnabled ───────────────────────────────────────────────

test('isOwnerTestCheckoutEnabled: only "true" enables, tolerant of Vercel whitespace/case', () => {
  assert.equal(isOwnerTestCheckoutEnabled('true'), true);
  assert.equal(isOwnerTestCheckoutEnabled(' TRUE '), true);
  assert.equal(isOwnerTestCheckoutEnabled('false'), false);
  assert.equal(isOwnerTestCheckoutEnabled('1'), false);
  assert.equal(isOwnerTestCheckoutEnabled(''), false);
  assert.equal(isOwnerTestCheckoutEnabled(undefined), false);
});

// ── parseOwnerTestEmails / isOwnerTestEmailAllowed ───────────────────────────

test('parseOwnerTestEmails: splits, trims, lowercases, drops blanks', () => {
  assert.deepEqual(
    parseOwnerTestEmails(' Owner@HSB.com , second@hsb.com ,, '),
    ['owner@hsb.com', 'second@hsb.com'],
  );
  assert.deepEqual(parseOwnerTestEmails(''), []);
  assert.deepEqual(parseOwnerTestEmails(undefined), []);
});

test('isOwnerTestEmailAllowed: case-insensitive + trimmed match', () => {
  const list = 'owner@hsb.com, Second@HSB.com';
  assert.equal(isOwnerTestEmailAllowed('owner@hsb.com', list), true);
  assert.equal(isOwnerTestEmailAllowed('  OWNER@hsb.com ', list), true);
  assert.equal(isOwnerTestEmailAllowed('second@hsb.com', list), true);
  assert.equal(isOwnerTestEmailAllowed('stranger@example.com', list), false);
  assert.equal(isOwnerTestEmailAllowed('', list), false);
  assert.equal(isOwnerTestEmailAllowed('owner@hsb.com', ''), false);
  assert.equal(isOwnerTestEmailAllowed('owner@hsb.com', undefined), false);
});

// ── evaluateOwnerTestGate (combined decision) ────────────────────────────────

test('default-closed: no env at all → blocked with flag_disabled', () => {
  const r = evaluateOwnerTestGate('owner@hsb.com', { enabledFlag: undefined, allowEmails: undefined });
  assert.equal(r.allowed, false);
  assert.equal(r.allowed === false && r.reason, 'flag_disabled');
});

test('flag off but email allowlisted → blocked (flag takes first precedence)', () => {
  const r = evaluateOwnerTestGate('owner@hsb.com', { enabledFlag: 'false', allowEmails: 'owner@hsb.com' });
  assert.equal(r.allowed, false);
  assert.equal(r.allowed === false && r.reason, 'flag_disabled');
});

test('flag on but email NOT allowlisted → blocked with email_not_allowlisted', () => {
  const r = evaluateOwnerTestGate('stranger@example.com', { enabledFlag: 'true', allowEmails: 'owner@hsb.com' });
  assert.equal(r.allowed, false);
  assert.equal(r.allowed === false && r.reason, 'email_not_allowlisted');
});

test('flag on but allowlist empty/unset → blocked (default-closed even with flag on)', () => {
  const r = evaluateOwnerTestGate('owner@hsb.com', { enabledFlag: 'true', allowEmails: undefined });
  assert.equal(r.allowed, false);
  assert.equal(r.allowed === false && r.reason, 'email_not_allowlisted');
});

test('flag on AND email allowlisted (case-insensitive) → allowed', () => {
  const r = evaluateOwnerTestGate('  OWNER@HSB.com ', { enabledFlag: ' true ', allowEmails: 'owner@hsb.com, second@hsb.com' });
  assert.equal(r.allowed, true);
});

// ── No allowlist leakage in the customer-facing message ──────────────────────

test('public message + code do not leak the allowlist or flag (static support contact is fine)', () => {
  assert.equal(OWNER_TEST_GATE_CODE, 'owner_test_gate_closed');
  // Must not name the gate env vars or reveal whether the flag is on/off.
  assert.doesNotMatch(OWNER_TEST_GATE_MESSAGE, /HSB_OWNER_TEST_/, 'message must not name the gate env vars');
  assert.doesNotMatch(OWNER_TEST_GATE_MESSAGE, /allowlist/i, 'message must not reveal the allowlist mechanism');
  // The combined gate result reason is internal-only — it is never the
  // customer-facing string.
  const blocked = evaluateOwnerTestGate('stranger@example.com', { enabledFlag: 'true', allowEmails: 'owner@hsb.com' });
  assert.equal(blocked.allowed, false);
  assert.notEqual(OWNER_TEST_GATE_MESSAGE, blocked.allowed === false ? blocked.reason : '');
});

// ── Route wiring (source assertion, mirrors checkout-pause.test.ts) ───────────

test('order route wires the owner-test gate after pause/KS and before Stripe session', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');

  const pauseIdx = src.indexOf('if (isCheckoutPaused())');
  const ksIdx = src.indexOf("enforceKillSwitch('checkout_pause')");
  // Match the CALL site, not the import line (the bare symbol appears in the
  // import first and would sort before the pause check).
  const gateIdx = src.indexOf('evaluateOwnerTestGate(email)');
  const stripeIdx = src.indexOf('stripe.checkout.sessions.create');

  assert.ok(gateIdx > -1, 'route must call evaluateOwnerTestGate');
  assert.ok(pauseIdx > -1 && ksIdx > -1, 'route must still check pause + KS');
  assert.ok(stripeIdx > -1, 'route must create a Stripe session');

  // Precedence: pause + KS take priority over the owner-test gate.
  assert.ok(pauseIdx < gateIdx, 'checkout pause must take precedence over owner-test gate');
  assert.ok(ksIdx < gateIdx, 'checkout_pause kill switch must take precedence over owner-test gate');
  // Gate must refuse BEFORE any Stripe session is created.
  assert.ok(gateIdx < stripeIdx, 'owner-test gate must run before Stripe session creation');

  // Refusal must use the gate code + a 503, and must not log the allowlist.
  assert.match(src, /OWNER_TEST_GATE_CODE/);
  assert.match(src, /OWNER_TEST_GATE_MESSAGE/);
  assert.match(src, /status:\s*503/);
});
