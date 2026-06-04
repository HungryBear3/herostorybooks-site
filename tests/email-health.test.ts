/**
 * Email-health (Resend) readiness tests.
 *
 * Covers the launch-relevant states: missing/blank webhook secret, persistence
 * failure (distinct), stale events, unverified-but-configured, and GREEN.
 * Plus: Resend readiness never depends on LULU, secrets are never returned,
 * event summarization boundaries, and the webhook verify/ingest core.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeEmailHealth,
  readResendWebhookSecretStatus,
  readResendApiKeyConfigured,
  readLuluWebhookSecretStatus,
  DEFAULT_STALE_AFTER_MS,
  type EmailHealthInput,
} from '../src/lib/email-health.ts';
import {
  summarizeEvents,
  toEmailEventRecord,
  recordEmailEvent,
  readEmailEvents,
  verifyResendSignature,
  signResendBody,
  recipientDomain,
  type EmailEventRecord,
} from '../src/lib/email-events.ts';

const NOW = 1_750_000_000_000;

function base(over: Partial<EmailHealthInput> = {}): EmailHealthInput {
  return {
    webhookSecret: 'configured',
    apiKeyConfigured: true,
    persistence: { ok: true },
    lastEventAt: NOW - 60_000, // 1m ago → fresh
    counts: { delivered: 5, bounced: 0, complained: 0 },
    now: NOW,
    staleAfterMs: DEFAULT_STALE_AFTER_MS,
    ...over,
  };
}

// ── env presence: status only, never the value ───────────────────────────────

test('readResendWebhookSecretStatus reports configured/missing/blank and never the value', () => {
  assert.equal(readResendWebhookSecretStatus({ RESEND_WEBHOOK_SECRET: 'whsec_abc' }), 'configured');
  assert.equal(readResendWebhookSecretStatus({ RESEND_WEBHOOK_SECRET: '' }), 'blank');
  assert.equal(readResendWebhookSecretStatus({ RESEND_WEBHOOK_SECRET: '   ' }), 'blank');
  assert.equal(readResendWebhookSecretStatus({}), 'missing');
  // Returned value is only a status string — not the secret.
  assert.equal(typeof readResendWebhookSecretStatus({ RESEND_WEBHOOK_SECRET: 'whsec_abc' }), 'string');
  assert.equal(readResendApiKeyConfigured({ HSB_RESEND_API_KEY: 're_x' }), true);
  assert.equal(readResendApiKeyConfigured({ RESEND_API_KEY: 're_y' }), true);
  assert.equal(readResendApiKeyConfigured({}), false);
});

// ── RED cases ────────────────────────────────────────────────────────────────

test('RED when RESEND_WEBHOOK_SECRET is missing', () => {
  const r = computeEmailHealth(base({ webhookSecret: 'missing' }));
  assert.equal(r.status, 'RED');
  assert.equal(r.launchReady, false);
  assert.ok(r.blockers.some((b) => /RESEND_WEBHOOK_SECRET is missing/.test(b)));
});

test('RED when RESEND_WEBHOOK_SECRET is blank', () => {
  const r = computeEmailHealth(base({ webhookSecret: 'blank' }));
  assert.equal(r.status, 'RED');
  assert.ok(r.blockers.some((b) => /blank/.test(b)));
});

test('RED with a DISTINCT persistence blocker when persistence is failing', () => {
  const r = computeEmailHealth(base({ persistence: { ok: false, error: 'EIO write fail' } }));
  assert.equal(r.status, 'RED');
  assert.equal(r.persistenceOk, false);
  assert.ok(r.blockers.some((b) => /persistence is failing: EIO write fail/.test(b)));
  // Persistence is its own blocker, not folded into "no events".
  assert.ok(!r.blockers.some((b) => /events observed/.test(b)));
});

// ── YELLOW cases ─────────────────────────────────────────────────────────────

test('YELLOW when configured + persistence ok but no events yet (unverified)', () => {
  const r = computeEmailHealth(base({ lastEventAt: null, counts: { delivered: 0, bounced: 0, complained: 0 } }));
  assert.equal(r.status, 'YELLOW');
  assert.equal(r.launchReady, false);
  assert.equal(r.verified, false);
  assert.ok(r.warnings.some((w) => /configured but unverified/.test(w)));
});

test('YELLOW when the last event is stale (older than the window)', () => {
  const r = computeEmailHealth(base({ lastEventAt: NOW - (DEFAULT_STALE_AFTER_MS + 60_000) }));
  assert.equal(r.status, 'YELLOW');
  assert.equal(r.stale, true);
  assert.ok(r.warnings.some((w) => /stale/.test(w)));
});

// ── GREEN ────────────────────────────────────────────────────────────────────

test('GREEN only when configured + persistence ok + a recent verified event', () => {
  const r = computeEmailHealth(base());
  assert.equal(r.status, 'GREEN');
  assert.equal(r.launchReady, true);
  assert.equal(r.stale, false);
  assert.equal(r.verified, true);
  assert.equal(r.blockers.length, 0);
});

// ── Lulu must never affect Resend readiness ──────────────────────────────────

test('Resend readiness ignores LULU_WEBHOOK_SECRET entirely', () => {
  // A blank Lulu secret has no bearing on a healthy Resend config.
  const r = computeEmailHealth(base());
  assert.equal(r.status, 'GREEN');
  // computeEmailHealth has no Lulu input; the Lulu reader is independent.
  assert.equal(readLuluWebhookSecretStatus({ LULU_WEBHOOK_SECRET: '' }), 'blank');
  assert.equal(readResendWebhookSecretStatus({ LULU_WEBHOOK_SECRET: '', RESEND_WEBHOOK_SECRET: 'whsec_x' }), 'configured');
});

// ── no secret-like values surface ────────────────────────────────────────────

test('no secret-like values appear in a computed result', () => {
  const r = computeEmailHealth(base({ webhookSecret: 'configured' }));
  const serialized = JSON.stringify(r);
  assert.doesNotMatch(serialized, /whsec_|re_[A-Za-z0-9]{6,}|[A-Za-z0-9_-]{32,}/);
});

// ── event summarization ──────────────────────────────────────────────────────

test('summarizeEvents counts monitored types in-window and tracks last event', () => {
  const events: EmailEventRecord[] = [
    { id: '1', type: 'email.delivered', at: NOW - 1000 },
    { id: '2', type: 'email.bounced', at: NOW - 2000 },
    { id: '3', type: 'email.complained', at: NOW - 3000 },
    { id: '4', type: 'email.delivered', at: NOW - (DEFAULT_STALE_AFTER_MS + 10_000) }, // out of window
    { id: '5', type: 'email.sent', at: NOW - 500 }, // unmonitored type
  ];
  const { counts, lastEventAt } = summarizeEvents(events, NOW, DEFAULT_STALE_AFTER_MS);
  assert.deepEqual(counts, { delivered: 1, bounced: 1, complained: 1 });
  assert.equal(lastEventAt, NOW - 500); // most recent regardless of monitored-ness
});

test('toEmailEventRecord keeps only domain (no full address) and no secrets', () => {
  const rec = toEmailEventRecord(
    { id: 'evt_1', type: 'email.bounced', created_at: '2026-06-03T00:00:00.000Z', data: { to: ['parent@gmail.com'], email_id: 'm_1' } },
    NOW,
  );
  assert.ok(rec);
  assert.equal(rec!.recipientDomain, 'gmail.com');
  assert.doesNotMatch(JSON.stringify(rec), /parent@gmail\.com/);
  assert.equal(recipientDomain('a@b.co'), 'b.co');
  assert.equal(recipientDomain('garbage'), null);
});

// ── persistence round-trip + failure path ────────────────────────────────────

test('recordEmailEvent + readEmailEvents round-trip; bad path surfaces ok:false', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-eh-'));
  try {
    process.env.HSB_EMAIL_EVENTS_PATH = path.join(dir, 'events.json');
    const saved = await recordEmailEvent({ id: 'e1', type: 'email.delivered', at: NOW });
    assert.equal(saved.ok, true);
    const read = await readEmailEvents();
    assert.equal(read.ok, true);
    assert.equal(read.ok && read.events.length, 1);
    assert.ok(readFileSync(process.env.HSB_EMAIL_EVENTS_PATH, 'utf8').includes('email.delivered'));

    // Point the store at a path whose parent is a file → read fails distinctly.
    process.env.HSB_EMAIL_EVENTS_PATH = path.join(process.env.HSB_EMAIL_EVENTS_PATH, 'nope.json');
    const bad = await readEmailEvents();
    assert.equal(bad.ok, false);
  } finally {
    delete process.env.HSB_EMAIL_EVENTS_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── webhook signature verify (fixtures only, no real Resend) ──────────────────

test('verifyResendSignature accepts a matching HMAC and rejects tampering', () => {
  const secret = 'whsec_test_only_not_real';
  const body = JSON.stringify({ type: 'email.bounced', data: { to: 'x@y.com' } });
  const sig = signResendBody(body, secret);
  assert.equal(verifyResendSignature(body, sig, secret), true);
  assert.equal(verifyResendSignature(body, sig, 'wrong-secret'), false);
  assert.equal(verifyResendSignature(`${body} `, sig, secret), false);
  assert.equal(verifyResendSignature(body, null, secret), false);
});

// ── route wiring (source assertions; no next/server import in tests) ──────────

test('resend webhook route is gated, verifies, and never sends email', () => {
  const src = readFileSync(new URL('../src/app/api/webhooks/resend/route.ts', import.meta.url), 'utf8');
  assert.match(src, /readResendWebhookSecretStatus\(\)/);
  assert.match(src, /status !== 'configured'[\s\S]*?503/);
  assert.match(src, /verifyResendSignature\(/);
  assert.match(src, /recordEmailEvent\(/);
  assert.doesNotMatch(src, /resend\.emails\.send|sendEmail|\.send\(/);
});
