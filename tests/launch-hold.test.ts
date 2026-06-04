/**
 * HER-11 public-launch HOLD dashboard — guardrail tests.
 *
 * Covers the three things the constraints care about:
 *  (1) auth — the API and page are admin-gated;
 *  (2) read-only / no-action — no mutating handlers, no action controls;
 *  (3) no auto-green — nothing is marked cleared from env/secret/doc presence,
 *      and `clearedForPublicTraffic` is structurally false.
 *
 * Route/page behavior is locked via source assertions (the repo's existing
 * convention — see kill-switch / inline-proof tests), and the data model +
 * auth primitive are exercised directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  getLaunchHoldSnapshot,
  LAUNCH_BLOCKERS,
  PUBLIC_LAUNCH_POSTURE,
  OWNER_TEST_GATE,
  PUBLIC_LAUNCH_GATES,
  DO_NOT_DO,
} from '../src/lib/launch-hold.ts';
import { isAdminAuthedFromRequest } from '../src/lib/admin-auth.ts';

const LIB = readFileSync(new URL('../src/lib/launch-hold.ts', import.meta.url), 'utf8');
const ROUTE = readFileSync(new URL('../src/app/api/admin/launch-hold/route.ts', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('../src/app/admin/launch-hold/page.tsx', import.meta.url), 'utf8');

const REQUIRED_IDS = ['HER-5', 'HER-6', 'HER-7', 'HER-9', 'HER-10', 'HER-11'];

// ── (3) no auto-green ─────────────────────────────────────────────────────────

test('snapshot is structurally NOT cleared for public traffic', () => {
  const snap = getLaunchHoldSnapshot(new Date('2026-06-02T00:00:00.000Z'));
  assert.equal(snap.clearedForPublicTraffic, false);
  assert.equal(snap.posture, PUBLIC_LAUNCH_POSTURE);
  assert.equal(snap.posture, 'PUBLIC_LAUNCH_HOLD');
  assert.equal(snap.generatedAt, '2026-06-02T00:00:00.000Z');
  assert.equal(snap.openCount, snap.blockers.length);
});

test('every required launch blocker is represented and in a not-cleared status', () => {
  const ids = LAUNCH_BLOCKERS.map((b) => b.id);
  for (const id of REQUIRED_IDS) {
    assert.ok(ids.includes(id), `missing required blocker ${id}`);
  }
  const allowed = new Set(['blocked', 'in_progress', 'hold']);
  for (const b of LAUNCH_BLOCKERS) {
    assert.ok(allowed.has(b.status), `${b.id} has non-hold status ${b.status}`);
    assert.ok(b.owner.length > 0, `${b.id} missing owner field`);
    assert.ok(b.evidenceRequired.length > 0, `${b.id} missing evidence-to-clear`);
  }
});

test('model never derives status from env vars or secret names', () => {
  // No env reads at all — status is editorial, not computed from config.
  assert.doesNotMatch(LIB, /process\.env/);
  assert.doesNotMatch(LIB, /RESEND|STRIPE|BLOB_READ_WRITE|_API_KEY|_SECRET/);
  // No "cleared/green/pass/go" appears as a status value the model can emit.
  assert.doesNotMatch(LIB, /status:\s*['"`](cleared|green|pass|go|ready)['"`]/i);
  // clearedForPublicTraffic is pinned false, never assigned true.
  assert.doesNotMatch(LIB, /clearedForPublicTraffic:\s*true/);
});

// ── owner-test vs public-launch separation (the core HER-11 goal) ────────────

test('snapshot exposes an owner-test gate that is explicitly NOT public launch', () => {
  const snap = getLaunchHoldSnapshot(new Date('2026-06-03T00:00:00.000Z'));
  assert.equal(snap.ownerTest.posture, 'OWNER_TEST_ONLY_BEHIND_GATE');
  assert.match(snap.ownerTest.notPublic, /NOT public traffic/i);
  assert.match(snap.ownerTest.notPublic, /NOT public-launch clearance/i);
  // The owner-test gate names the controlling flags but the model never reads them.
  assert.match(snap.ownerTest.control, /HSB_OWNER_TEST_CHECKOUT_ENABLED/);
  assert.match(snap.ownerTest.control, /HSB_OWNER_TEST_EMAILS/);
});

test('owner-test gate copy is rendered AND clearly separated from public posture on the page', () => {
  assert.match(PAGE, /Owner-test gate/);
  assert.match(PAGE, /ownerTest\.notPublic/);
  // Public posture is still the dominant verdict.
  assert.match(PAGE, /snapshot\.posture/);
});

// ── required public-launch gates (the task's blocker enumeration) ─────────────

test('all required public-launch gate categories are present', () => {
  const keys = PUBLIC_LAUNCH_GATES.map((g) => g.key);
  for (const k of [
    'owner-test-packet',
    'proof-hardcover',
    'print-sla',
    'email-health',
    'public-traffic-approval',
    'alias-cutover',
  ]) {
    assert.ok(keys.includes(k), `missing required gate ${k}`);
  }
  const allowed = new Set(['blocked', 'in_progress', 'hold']);
  for (const g of PUBLIC_LAUNCH_GATES) {
    assert.ok(allowed.has(g.status), `${g.key} has non-hold status ${g.status}`);
    assert.ok(g.requirement.length > 0 && g.references.length > 0, `${g.key} incomplete`);
  }
  // The gates render on the page.
  assert.match(PAGE, /Required public-launch gates/);
  assert.match(PAGE, /snapshot\.gates\.map/);
});

// ── do-not-do list ───────────────────────────────────────────────────────────

test('do-not-do list covers the required prohibitions and is rendered', () => {
  const joined = DO_NOT_DO.join(' \n ').toLowerCase();
  assert.match(joined, /public traffic/);
  assert.match(joined, /creator|gifting/);
  assert.match(joined, /posting|scheduling|boosting/);
  assert.match(joined, /print|provider|payment/);
  assert.match(joined, /alias|deploy|env/);
  assert.match(PAGE, /Do not do/i);
  assert.match(PAGE, /snapshot\.doNotDo\.map/);
});

test('evidence docs are exposed and rendered', () => {
  const snap = getLaunchHoldSnapshot(new Date('2026-06-03T00:00:00.000Z'));
  assert.ok(snap.evidence.length >= 1);
  assert.ok(snap.evidence.every((d) => d.path && d.label));
  assert.match(PAGE, /Evidence/);
  assert.match(PAGE, /snapshot\.evidence\.map/);
});

// ── (1) auth ──────────────────────────────────────────────────────────────────

test('admin auth primitive: no key configured → unauthorized', () => {
  delete process.env.HSB_ORDER_ADMIN_KEY;
  const req = new Request('https://x/api/admin/launch-hold');
  assert.equal(isAdminAuthedFromRequest(req), false);
});

test('admin auth primitive: wrong / missing header → unauthorized, correct → authorized', () => {
  process.env.HSB_ORDER_ADMIN_KEY = 'test-ops-key';
  try {
    assert.equal(
      isAdminAuthedFromRequest(new Request('https://x/api/admin/launch-hold')),
      false,
      'no header must be unauthorized',
    );
    assert.equal(
      isAdminAuthedFromRequest(
        new Request('https://x/api/admin/launch-hold', { headers: { 'x-hsb-order-admin-key': 'wrong' } }),
      ),
      false,
      'wrong header must be unauthorized',
    );
    assert.equal(
      isAdminAuthedFromRequest(
        new Request('https://x/api/admin/launch-hold', { headers: { 'x-hsb-order-admin-key': 'test-ops-key' } }),
      ),
      true,
      'correct header must be authorized',
    );
  } finally {
    delete process.env.HSB_ORDER_ADMIN_KEY;
  }
});

test('API route authorizes before returning the snapshot', () => {
  const authIdx = ROUTE.indexOf('isAdminAuthedFromRequest');
  const bodyIdx = ROUTE.indexOf('getLaunchHoldSnapshot');
  const unauthIdx = ROUTE.indexOf('401');
  assert.ok(authIdx > -1, 'route must check admin auth');
  assert.ok(unauthIdx > -1, 'route must 401 when unauthorized');
  assert.ok(authIdx < bodyIdx, 'auth check must precede snapshot return');
});

test('page is admin-gated and shows a login card when unauthed', () => {
  assert.match(PAGE, /getConfiguredAdminKey/);
  assert.match(PAGE, /isAdminAuthedFromCookie/);
  assert.match(PAGE, /return <LoginCard/);
});

// ── (2) read-only / no-action ─────────────────────────────────────────────────

test('API route exposes only a read-only GET (no mutating handlers)', () => {
  assert.match(ROUTE, /export async function GET\(/);
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.doesNotMatch(ROUTE, new RegExp(`export async function ${verb}\\(`), `route must not expose ${verb}`);
  }
});

test('launch-hold surfaces trigger no provider/order/payment/print/email action', () => {
  // The lib + route + page must not import or call any mutating/side-effecting path.
  for (const [name, src] of [['lib', LIB], ['route', ROUTE], ['page', PAGE]] as const) {
    assert.doesNotMatch(src, /persistOrder|updateFulfillment|submitPrint|sendProof|sendEmail|stripe|refund|recordOwnerPrintGo|releaseOrderAfterQa/i,
      `${name} must not reference any mutating action`);
  }
});

test('page has no action controls (no buttons/handlers beyond the read-only login form)', () => {
  // No client-side action wiring.
  assert.doesNotMatch(PAGE, /onClick|onSubmit|useState|fetch\(/);
  // The only form posts to the existing login endpoint — nothing else.
  const postTargets = [...PAGE.matchAll(/action="([^"]+)"/g)].map((m) => m[1]);
  for (const target of postTargets) {
    assert.equal(target, '/api/admin/login', `unexpected form action ${target}`);
  }
});
