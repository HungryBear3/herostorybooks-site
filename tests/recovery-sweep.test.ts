import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNewRecoveryLead, isAbandonedCandidate, type RecoveryLead } from '../src/lib/recovery.ts';
import { buildAbandonedCheckoutEmail } from '../src/lib/recovery-email.ts';
import { runRecoverySweep } from '../src/lib/recovery-sweep.ts';

const THRESHOLD_MS = 2 * 60 * 60 * 1000;

function makeActive(overrides: Partial<RecoveryLead> = {}): RecoveryLead {
  return buildNewRecoveryLead(
    { email: 'test@example.com', childName: 'Ava', bookFormat: 'classic', theme: 'space' },
    { id: 'rec_t', now: '2026-04-20T08:00:00.000Z' },
    // @ts-expect-error -- overrides applied below
    ...[]
  ) as RecoveryLead;
}

function makeLeadAt(updatedAt: string, status: RecoveryLead['status'] = 'active'): RecoveryLead {
  return {
    ...buildNewRecoveryLead({ email: 'x@y.com' }, { id: 'rec_sweep', now: updatedAt }),
    status,
    updatedAt,
  };
}

const NOW = '2026-04-20T12:00:00.000Z'; // reference "now"
const OLD = '2026-04-20T08:00:00.000Z'; // 4h before NOW → eligible
const RECENT = '2026-04-20T11:30:00.000Z'; // 30min before NOW → too recent

// ── isAbandonedCandidate ──────────────────────────────────────────────────────

test('isAbandonedCandidate: active lead older than threshold is eligible', () => {
  const lead = makeLeadAt(OLD);
  assert.equal(isAbandonedCandidate(lead, NOW, THRESHOLD_MS), true);
});

test('isAbandonedCandidate: active lead too recent is not eligible', () => {
  const lead = makeLeadAt(RECENT);
  assert.equal(isAbandonedCandidate(lead, NOW, THRESHOLD_MS), false);
});

test('isAbandonedCandidate: converted lead is never eligible', () => {
  const lead = makeLeadAt(OLD, 'converted');
  assert.equal(isAbandonedCandidate(lead, NOW, THRESHOLD_MS), false);
});

test('isAbandonedCandidate: already-abandoned lead is not eligible', () => {
  const lead = makeLeadAt(OLD, 'abandoned');
  assert.equal(isAbandonedCandidate(lead, NOW, THRESHOLD_MS), false);
});

test('isAbandonedCandidate: unsubscribed lead is not eligible', () => {
  const lead = makeLeadAt(OLD, 'unsubscribed');
  assert.equal(isAbandonedCandidate(lead, NOW, THRESHOLD_MS), false);
});

test('isAbandonedCandidate: exactly at threshold boundary is eligible', () => {
  const exactBoundary = new Date(new Date(NOW).getTime() - THRESHOLD_MS).toISOString();
  const lead = makeLeadAt(exactBoundary);
  assert.equal(isAbandonedCandidate(lead, NOW, THRESHOLD_MS), true);
});

test('isAbandonedCandidate: custom threshold honored', () => {
  const lead = makeLeadAt(RECENT); // 30min old
  // eligible with a 15min threshold (lead is 30min old)
  assert.equal(isAbandonedCandidate(lead, NOW, 15 * 60 * 1000), true);
  // not eligible with a 1hr threshold (lead is only 30min old)
  assert.equal(isAbandonedCandidate(lead, NOW, 60 * 60 * 1000), false);
  // not eligible with a 2hr threshold
  assert.equal(isAbandonedCandidate(lead, NOW, THRESHOLD_MS), false);
});

// ── buildAbandonedCheckoutEmail ───────────────────────────────────────────────

test('buildAbandonedCheckoutEmail: subject includes child name when present', () => {
  const lead: RecoveryLead = {
    ...makeLeadAt(OLD),
    email: 'p@example.com',
    childName: 'Leo',
    theme: 'dragon-quest',
    bookFormat: 'classic',
  };
  const { subject } = buildAbandonedCheckoutEmail(lead);
  assert.match(subject, /Leo/);
});

test('buildAbandonedCheckoutEmail: subject fallback when no child name', () => {
  const lead: RecoveryLead = { ...makeLeadAt(OLD), email: 'p@example.com', childName: '' };
  const { subject } = buildAbandonedCheckoutEmail(lead);
  assert.match(subject, /storybook/i);
});

test('buildAbandonedCheckoutEmail: html contains checkout URL', () => {
  const lead: RecoveryLead = { ...makeLeadAt(OLD), email: 'p@example.com', childName: 'Mia' };
  const { html } = buildAbandonedCheckoutEmail(lead);
  assert.match(html, /herostorybooks\.com\/checkout/);
});

test('buildAbandonedCheckoutEmail: mentions theme in html when present', () => {
  const lead: RecoveryLead = {
    ...makeLeadAt(OLD),
    email: 'p@example.com',
    childName: 'Zoe',
    theme: 'ocean-dreams',
  };
  const { html } = buildAbandonedCheckoutEmail(lead);
  assert.match(html, /ocean-dreams/);
});

test('buildAbandonedCheckoutEmail: text fallback contains checkout URL', () => {
  const lead: RecoveryLead = { ...makeLeadAt(OLD), email: 'p@example.com', childName: 'Ava' };
  const { text } = buildAbandonedCheckoutEmail(lead);
  assert.match(text, /herostorybooks\.com\/checkout/);
});

test('buildAbandonedCheckoutEmail: no fake discounts in html', () => {
  const lead: RecoveryLead = { ...makeLeadAt(OLD), email: 'p@example.com', childName: 'Sam' };
  const { html } = buildAbandonedCheckoutEmail(lead);
  assert.doesNotMatch(html, /\d+%\s*off/i);
  assert.doesNotMatch(html, /discount/i);
  assert.doesNotMatch(html, /coupon/i);
  assert.doesNotMatch(html, /promo/i);
});

test('buildAbandonedCheckoutEmail: explains proof-first approval before print', () => {
  const lead: RecoveryLead = { ...makeLeadAt(OLD), email: 'p@example.com', childName: 'Avery' };
  const { html, text } = buildAbandonedCheckoutEmail(lead);
  assert.match(html, /private digital proof first/i);
  assert.match(html, /nothing enters print until you approve/i);
  assert.match(text, /private digital proof first/i);
});

// ── runRecoverySweep ──────────────────────────────────────────────────────────

function makeLead(id: string, updatedAt: string, status: RecoveryLead['status'] = 'active'): RecoveryLead {
  return { ...makeLeadAt(updatedAt, status), id, email: `${id}@example.com` };
}

test('runRecoverySweep dry-run: eligible leads counted, nothing sent or marked', async () => {
  const leads = [
    makeLead('r1', OLD),   // eligible
    makeLead('r2', OLD),   // eligible
    makeLead('r3', RECENT), // too recent
  ];
  const sent: string[] = [];
  const marked: string[] = [];

  const result = await runRecoverySweep({
    dryRun: true,
    now: NOW,
    thresholdMs: THRESHOLD_MS,
    _leads: leads,
    _onSend: async (l) => { sent.push(l.id); return { id: 'msg_x' }; },
    _onMark: async (l) => { marked.push(l.id); },
  });

  assert.equal(result.eligible, 2);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.dryRun, true);
  assert.equal(sent.length, 0);
  assert.equal(marked.length, 0);
});

test('runRecoverySweep live: sends to eligible, marks abandoned, skips ineligible', async () => {
  const leads = [
    makeLead('r1', OLD),          // eligible
    makeLead('r2', OLD, 'converted'), // ineligible
    makeLead('r3', RECENT),       // too recent
  ];
  const sent: string[] = [];
  const marked: string[] = [];

  const result = await runRecoverySweep({
    dryRun: false,
    now: NOW,
    thresholdMs: THRESHOLD_MS,
    _leads: leads,
    _onSend: async (l) => { sent.push(l.id); return { id: 'msg_ok' }; },
    _onMark: async (l) => { marked.push(l.id); },
  });

  assert.equal(result.eligible, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(sent, ['r1']);
  assert.deepEqual(marked, ['r1']);
});

test('runRecoverySweep: failed sends counted, lead not marked abandoned', async () => {
  const leads = [makeLead('r1', OLD)];
  const marked: string[] = [];

  const result = await runRecoverySweep({
    dryRun: false,
    now: NOW,
    thresholdMs: THRESHOLD_MS,
    _leads: leads,
    _onSend: async () => { throw new Error('Resend 429'); },
    _onMark: async (l) => { marked.push(l.id); },
  });

  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(marked.length, 0); // not marked — should retry next sweep
});

test('runRecoverySweep: no eligible leads → all zeros', async () => {
  const leads = [
    makeLead('r1', RECENT),
    makeLead('r2', OLD, 'converted'),
  ];

  const result = await runRecoverySweep({
    dryRun: false,
    now: NOW,
    thresholdMs: THRESHOLD_MS,
    _leads: leads,
    _onSend: async () => { throw new Error('should not be called'); },
    _onMark: async () => { throw new Error('should not be called'); },
  });

  assert.equal(result.eligible, 0);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);
});

test('runRecoverySweep: empty corpus returns zeros', async () => {
  const result = await runRecoverySweep({
    dryRun: false,
    now: NOW,
    _leads: [],
    _onSend: async () => { throw new Error('should not be called'); },
    _onMark: async () => {},
  });

  assert.equal(result.eligible, 0);
  assert.equal(result.sent, 0);
});
