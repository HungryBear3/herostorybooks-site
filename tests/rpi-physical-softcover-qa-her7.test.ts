/**
 * HER-7 RPI physical softcover QA tracker — doc guardrail tests.
 *
 * This is a docs-only tracking artifact (no app/runtime code), so we lock its
 * contract the same way the repo locks other source/doc invariants: read the
 * file and assert it (a) keeps the tracked evidence, (b) keeps every required
 * QA gate, (c) keeps explicit HOLD / "not print approval" language, and
 * (d) never contains affirmative clearance language that would imply the gate
 * approves print or clears launch/G5/public traffic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DOC = 'docs/runbooks/rpi-physical-softcover-qa-HER-7.md';
const ORDER_ID = 'ce868c70-61dc-4e36-ad0e-33174930c702';

function read(): string {
  return readFileSync(DOC, 'utf8');
}

test('tracker exists and pins the approved RPI production test order as evidence', () => {
  const src = read();
  assert.match(src, new RegExp(ORDER_ID), 'must track the specific RPI order id');
  assert.match(src, /VALID_HOLDING_BIN/, 'must record the post-payment status');
  assert.match(src, /\$23\.23/, 'must record the charged amount');
  assert.match(src, /2026-06-09/, 'must record the estimated ship date');
  assert.match(src, /2026-06-14/, 'must record the estimated delivery date');
});

test('tracker keeps explicit HOLD / tracking-only language', () => {
  const src = read();
  assert.match(src, /HOLD/, 'must carry a HOLD banner');
  assert.match(src, /tracking only/i, 'must state it is tracking only');
  assert.match(src, /not (a )?print approval/i, 'must state it is not a print approval');
});

test('tracker keeps the no-action / no-Pay-All constraints', () => {
  const src = read();
  assert.match(src, /Pay All/, 'must reference RPI bundled Pay All to forbid it');
  assert.match(src, /do not[^.]*pay all/i, 'must explicitly forbid bundled Pay All');
  assert.match(src, /do not[^.]*(submit|create)[^.]*order/i, 'must forbid submitting/creating an order');
  assert.match(src, /without explicit\s+approval/i, 'must require explicit approval for any new action');
});

test('tracker enumerates every required QA gate', () => {
  const src = read();
  for (const gate of [
    /shipped/i,
    /tracking/i,
    /deliver/i, // delivery / delivered
    /physical inspection/i,
    /print quality/i,
    /color/i,
    /binding/i,
    /page order/i,
    /evidence packet/i,
    /human verdict/i,
  ]) {
    assert.match(src, gate, `missing required QA gate: ${gate}`);
  }
});

test('tracker spells out what remains before HER-7 can be marked done', () => {
  const src = read();
  assert.match(src, /What remains before HER-7 can be marked done/i);
  assert.match(src, /human verdict/i);
  assert.match(src, /PASS \/ CONDITIONAL \/ FAIL|PASS\b/i);
});

test('tracker never claims print approval or launch/G5/public-traffic clearance', () => {
  const src = read();
  // Affirmative clearance phrasings that must never appear in a tracking-only doc.
  assert.doesNotMatch(src, /cleared for (public|launch|g5)/i);
  assert.doesNotMatch(src, /(launch|g5) is clear/i);
  assert.doesNotMatch(src, /print (is |has been )?approved/i);
  assert.doesNotMatch(src, /approved for (print|launch|public)/i);
});
