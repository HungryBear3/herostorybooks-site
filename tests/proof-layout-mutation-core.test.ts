/**
 * Pure behavioral cores for B4 (honest no-op vs mutation), B5 (accessible
 * geometry announcement), B6 (single mutation coordinator + stale-response
 * rejection) and B7 (request-help contract). React-free, node-testable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  interpretLayoutMutationResponse,
  layoutMutationNotice,
  describeCardGeometry,
  createReviewMutationCoordinator,
} from '../src/lib/proof-layout-editor-core.ts';

// A FULLY-VALID render-critical ReviewSnapshot for order ord_x.
function fullSnap(patch: Record<string, unknown> = {}) {
  return {
    orderId: 'ord_x', childName: 'Kid', reviewStatus: 'in_review',
    pageArtifacts: [{ pageIndex: 0, storyText: 'A short page.' }],
    storyArtifactUrl: null, proofVersion: null, proofSourceFingerprint: null,
    proofReviewedVersion: null, proofReviewedAt: null,
    proofAvailable: false, proofFresh: false,
    proofLayoutEditing: { allowed: false, reason: 'proof_not_ready' },
    isPrint: false, bookFormat: 'digital',
    ...patch,
  };
}
const OID = 'ord_x';

// ── B4 / B7: response contract ───────────────────────────────────────────────

test('a real mutation (ok, noop:false, full snapshot, matching order) is applied', () => {
  const out = interpretLayoutMutationResponse(true, 200, { ok: true, noop: false, snapshot: fullSnap() }, OID);
  assert.equal(out.ok, true);
  assert.equal(out.noop, false);
  assert.equal(out.snapshot?.orderId, 'ord_x');
});

test('an equivalent no-op (ok, noop:true, full snapshot) is a success flagged noop', () => {
  const out = interpretLayoutMutationResponse(true, 200, { ok: true, noop: true, snapshot: fullSnap() }, OID);
  assert.equal(out.ok, true);
  assert.equal(out.noop, true);
});

test('missing noop is a failure — noop must be an exact boolean', () => {
  const out = interpretLayoutMutationResponse(true, 200, { ok: true, snapshot: fullSnap() }, OID);
  assert.equal(out.ok, false);
});

test('non-boolean noop is a failure', () => {
  const out = interpretLayoutMutationResponse(true, 200, { ok: true, noop: 'no', snapshot: fullSnap() }, OID);
  assert.equal(out.ok, false);
});

test('the two-field partial snapshot (the hostile probe) is REJECTED, never faked as success', () => {
  const out = interpretLayoutMutationResponse(true, 200, { ok: true, noop: false, snapshot: { orderId: 'ord_x', pageArtifacts: [] } }, OID);
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.reload, true);
  assert.match(!out.ok ? out.message : '', /didn.t return|reload|confirm/i);
});

test('missing snapshot is a failure', () => {
  const out = interpretLayoutMutationResponse(true, 200, { ok: true, noop: false }, OID);
  assert.equal(out.ok, false);
});

test('a cross-order / wrong-id snapshot is a failure (order binding enforced)', () => {
  const out = interpretLayoutMutationResponse(true, 200, { ok: true, noop: false, snapshot: fullSnap({ orderId: 'ord_OTHER' }) }, OID);
  assert.equal(out.ok, false);
});

test('a malformed capability inside the snapshot is a failure', () => {
  const out = interpretLayoutMutationResponse(true, 200, { ok: true, noop: false, snapshot: fullSnap({ proofLayoutEditing: { allowed: 'yes' } }) }, OID);
  assert.equal(out.ok, false);
});

test('a malformed page artifact is a failure', () => {
  const out = interpretLayoutMutationResponse(true, 200, { ok: true, noop: false, snapshot: fullSnap({ pageArtifacts: [{ pageIndex: 'zero' }] }) }, OID);
  assert.equal(out.ok, false);
});

test('malformed render-critical proof identity / freshness / booleans are failures', () => {
  const bad = [
    fullSnap({ proofVersion: 5 }),          // must be string|null
    fullSnap({ proofFresh: 'no' }),         // must be boolean
    fullSnap({ storyArtifactUrl: 12 }),     // must be string|null
    fullSnap({ reviewStatus: 7 }),          // must be string
    fullSnap({ bookFormat: null }),         // must be string
  ];
  for (const snapshot of bad) {
    const out = interpretLayoutMutationResponse(true, 200, { ok: true, noop: false, snapshot }, OID);
    assert.equal(out.ok, false, `snapshot ${JSON.stringify(Object.keys(snapshot))} should be rejected`);
  }
});

test('HTTP success with ok !== true is a failure', () => {
  const out = interpretLayoutMutationResponse(true, 200, { ok: false, noop: false, snapshot: fullSnap() }, OID);
  assert.equal(out.ok, false);
});

test('ok:true with a non-object snapshot is still a failure', () => {
  const out = interpretLayoutMutationResponse(true, 200, { ok: true, noop: false, snapshot: 'nope' }, OID);
  assert.equal(out.ok, false);
});

test('a stale-proof 409 fails with reload guidance, not endless retry', () => {
  for (const error of ['proof_stale', 'stale_revision', 'stale_fingerprint', 'no_live_proof']) {
    const out = interpretLayoutMutationResponse(false, 409, { ok: false, error }, OID);
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.reload, true, `${error} should instruct reload`);
    assert.match(!out.ok ? out.message : '', /reload/i);
  }
});

test('a non-2xx contentful error maps to specific copy without reload', () => {
  const out = interpretLayoutMutationResponse(false, 422, { ok: false, error: 'text_overflow' }, OID);
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.reload, false);
  assert.match(!out.ok ? out.message : '', /too large|font|card/i);
});

test('malformed JSON / null / unknown body fails closed', () => {
  assert.equal(interpretLayoutMutationResponse(true, 200, null, OID).ok, false);
  assert.equal(interpretLayoutMutationResponse(true, 200, 'garbage', OID).ok, false);
  assert.equal(interpretLayoutMutationResponse(true, 200, 42, OID).ok, false);
});

// ── B4 / B7: honest op-specific notices ──────────────────────────────────────

test('notices never claim a rebuild for a no-op, and do claim one for a real change', () => {
  assert.match(layoutMutationNotice('save', false), /updated proof|prepare/i);
  assert.doesNotMatch(layoutMutationNotice('save', true), /prepar|updated proof/i);
  assert.match(layoutMutationNotice('save', true), /no chang|already/i);

  assert.match(layoutMutationNotice('reset', false), /standard|updated proof/i);
  assert.doesNotMatch(layoutMutationNotice('reset', true), /updated proof/i);

  // Help is audit-only: it must never claim a proof rebuild, and must say no email.
  assert.doesNotMatch(layoutMutationNotice('help', false), /updated proof|prepar/i);
  assert.match(layoutMutationNotice('help', false), /no email/i);
  assert.match(layoutMutationNotice('help', true), /already/i);
  assert.match(layoutMutationNotice('help', true), /no email/i);
});

// ── B5: accessible geometry announcement ─────────────────────────────────────

test('describeCardGeometry announces position and size as readable percentages', () => {
  const s = describeCardGeometry({ x: 0.1, y: 0.65, width: 0.8, height: 0.2, opacity: 0.6, fontScale: 1 });
  assert.match(s, /10%/);
  assert.match(s, /65%/);
  assert.match(s, /80%/);
  assert.match(s, /20%/);
  // Human-readable, not a raw object dump.
  assert.doesNotMatch(s, /[{}]/);
});

// ── B6: single mutation coordinator + stale-response rejection ────────────────

test('coordinator allows at most one active mutation', () => {
  const c = createReviewMutationCoordinator();
  const t1 = c.begin('save');
  assert.equal(typeof t1, 'number');
  assert.equal(c.isBusy(), true);
  assert.equal(c.begin('regenerate'), null); // rejected while busy
  c.settle(t1!);
  assert.equal(c.isBusy(), false);
});

test('a deferred older response can never replace a newer authoritative snapshot', () => {
  const c = createReviewMutationCoordinator();
  const t1 = c.begin('regenerate')!;   // op1 starts, response will be delayed
  assert.equal(c.isCurrent(t1), true);
  c.settle(t1);                          // op1 network settles (lock released)
  const t2 = c.begin('save')!;          // op2 (layout save) starts and invalidates proof
  // op1's DELAYED response arrives now — it must be rejected as stale:
  assert.equal(c.isCurrent(t1), false);
  assert.equal(c.isCurrent(t2), true);
  c.settle(t2);
  // Once settled, nothing is current (no active owner to apply a snapshot).
  assert.equal(c.isCurrent(t2), false);
});

test('settle is owner-aware: a stale token cannot unlock a newer mutation', () => {
  const c = createReviewMutationCoordinator();
  const t1 = c.begin('save')!;
  c.settle(t1);
  const t2 = c.begin('accept')!;
  c.settle(t1); // stale settle must NOT release t2's lock
  assert.equal(c.isBusy(), true);
  assert.equal(c.isCurrent(t2), true);
});
