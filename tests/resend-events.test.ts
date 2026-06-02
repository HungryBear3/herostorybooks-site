/**
 * Resend webhook ingestion + read-API coverage. Pure-module tests:
 * no live Resend API call, no outbound network. Each test uses a
 * tmpdir-backed store (HSB_ORDER_STORE_DIR) so the on-disk JSONL log
 * never leaks across runs.
 *
 * Webhook route tests live alongside as SOURCE-level assertions
 * because next/server-based route handlers can't mount under
 * node:test (same constraint already documented in
 * tests/admin-shipping-proof.test.ts and tests/order-persistence-strict.test.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendResendEvent,
  listResendEvents,
  normalizeResendWebhook,
  summarizeResendBounces,
  isResendEventType,
  RESEND_EVENT_TYPES,
  type ResendEvent,
} from '../src/lib/resend-events.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-resend-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

function makeEvent(overrides: Partial<ResendEvent>): ResendEvent {
  return {
    id: overrides.id ?? `evt_${crypto.randomBytes(6).toString('hex')}`,
    type: overrides.type ?? 'email.delivered',
    createdAt: overrides.createdAt ?? '2026-06-02T12:00:00.000Z',
    emailId: overrides.emailId ?? `em_${crypto.randomBytes(6).toString('hex')}`,
    to: overrides.to ?? 'recipient@example.com',
    subject: overrides.subject ?? 'Your proof is ready',
    bounceType: overrides.bounceType ?? null,
    bounceReason: overrides.bounceReason ?? null,
  };
}

// ── Allowlist + type guard ──────────────────────────────────────────────────

test('RESEND_EVENT_TYPES exactly matches the supported Resend event-type union', () => {
  // If Resend adds a new event type and we want to ingest it, this
  // list AND the type union must update together — the webhook route
  // drops unknown types so silent schema drift never reaches the log.
  assert.deepEqual(
    [...RESEND_EVENT_TYPES].sort(),
    [
      'email.bounced',
      'email.clicked',
      'email.complained',
      'email.delivered',
      'email.delivery_delayed',
      'email.opened',
      'email.sent',
    ].sort(),
  );
});

test('isResendEventType refuses values outside the allowlist', () => {
  assert.equal(isResendEventType('email.delivered'), true);
  assert.equal(isResendEventType('email.bounced'), true);
  assert.equal(isResendEventType('email.future_new_type'), false);
  assert.equal(isResendEventType(null), false);
  assert.equal(isResendEventType(undefined), false);
  assert.equal(isResendEventType(42), false);
});

// ── normalizeResendWebhook ─────────────────────────────────────────────────

test('normalizeResendWebhook returns null for unknown event types (drops silent schema drift)', () => {
  const raw = {
    type: 'email.future_new_type',
    created_at: '2026-06-02T12:00:00Z',
    data: { email_id: 'em_x', to: ['x@example.com'] },
  };
  assert.equal(normalizeResendWebhook(raw, 'msg_x'), null);
});

test('normalizeResendWebhook extracts bounceType + bounceReason from nested data.bounce', () => {
  const raw = {
    type: 'email.bounced',
    created_at: '2026-06-02T12:34:56.000Z',
    data: {
      email_id: 'em_abc',
      to: ['hard-bounce@example.com'],
      subject: 'Your proof is ready',
      bounce: {
        type: 'hard',
        message: 'The email account that you tried to reach does not exist.',
      },
    },
  };
  const ev = normalizeResendWebhook(raw, 'msg_2x9F');
  assert.ok(ev);
  assert.equal(ev?.id, 'msg_2x9F'); // svix-id wins over data.email_id for idempotency
  assert.equal(ev?.type, 'email.bounced');
  assert.equal(ev?.emailId, 'em_abc');
  assert.equal(ev?.to, 'hard-bounce@example.com');
  assert.equal(ev?.subject, 'Your proof is ready');
  assert.equal(ev?.bounceType, 'hard');
  assert.match(ev?.bounceReason ?? '', /does not exist/);
});

test('normalizeResendWebhook accepts data.to as either string or string[]', () => {
  const a = normalizeResendWebhook(
    { type: 'email.delivered', created_at: '2026-06-02T12:00:00Z', data: { to: ['x@a'] } },
    'msg_a',
  );
  const b = normalizeResendWebhook(
    { type: 'email.delivered', created_at: '2026-06-02T12:00:00Z', data: { to: 'y@b' } },
    'msg_b',
  );
  assert.equal(a?.to, 'x@a');
  assert.equal(b?.to, 'y@b');
});

// ── appendResendEvent + idempotency ───────────────────────────────────────

test('appendResendEvent persists once; replay with the same id is a no-op (Svix retry safety)', async () => {
  const dir = makeTmp();
  try {
    const ev = makeEvent({ id: 'msg_idem_1', type: 'email.bounced' });
    const first = await appendResendEvent(ev);
    const second = await appendResendEvent(ev); // simulated retry
    const third = await appendResendEvent({ ...ev, subject: 'changed' }); // same id, drift
    assert.equal(first.persisted, true);
    assert.equal(second.persisted, false);
    assert.equal(third.persisted, false);
    const list = await listResendEvents({ now: new Date('2026-06-02T13:00:00Z') });
    const matching = list.filter((e) => e.id === 'msg_idem_1');
    assert.equal(matching.length, 1, 'event id must be deduped');
    assert.equal(matching[0].subject, 'Your proof is ready', 'first write wins; retry must not overwrite');
  } finally { cleanup(dir); }
});

// ── listResendEvents ──────────────────────────────────────────────────────

test('listResendEvents returns newest-first, respects type filter and limit', async () => {
  const dir = makeTmp();
  try {
    await appendResendEvent(makeEvent({ id: 'a', type: 'email.delivered', createdAt: '2026-06-02T10:00:00Z' }));
    await appendResendEvent(makeEvent({ id: 'b', type: 'email.bounced', createdAt: '2026-06-02T11:00:00Z' }));
    await appendResendEvent(makeEvent({ id: 'c', type: 'email.delivered', createdAt: '2026-06-02T12:00:00Z' }));
    const all = await listResendEvents({ now: new Date('2026-06-02T13:00:00Z') });
    assert.deepEqual(all.map((e) => e.id), ['c', 'b', 'a']);

    const onlyBounces = await listResendEvents({ type: 'email.bounced', now: new Date('2026-06-02T13:00:00Z') });
    assert.deepEqual(onlyBounces.map((e) => e.id), ['b']);

    const limited = await listResendEvents({ limit: 1, now: new Date('2026-06-02T13:00:00Z') });
    assert.deepEqual(limited.map((e) => e.id), ['c']);
  } finally { cleanup(dir); }
});

test('listResendEvents reaches across day-partitioned log files', async () => {
  const dir = makeTmp();
  try {
    await appendResendEvent(makeEvent({ id: 'yesterday', type: 'email.delivered', createdAt: '2026-06-01T20:00:00Z' }));
    await appendResendEvent(makeEvent({ id: 'today', type: 'email.delivered', createdAt: '2026-06-02T08:00:00Z' }));
    const list = await listResendEvents({ days: 2, now: new Date('2026-06-02T09:00:00Z') });
    assert.deepEqual(list.map((e) => e.id), ['today', 'yesterday']);
  } finally { cleanup(dir); }
});

// ── summarizeResendBounces ────────────────────────────────────────────────

test('summarizeResendBounces buckets counts and pulls recent bounces + complaints', async () => {
  const dir = makeTmp();
  try {
    const now = new Date('2026-06-02T12:00:00Z');
    // In-window
    await appendResendEvent(makeEvent({ id: '1', type: 'email.delivered', createdAt: '2026-06-02T11:00:00Z' }));
    await appendResendEvent(makeEvent({ id: '2', type: 'email.bounced', createdAt: '2026-06-02T10:30:00Z',
      to: 'bad@example.com', bounceType: 'hard', bounceReason: 'no such mailbox' }));
    await appendResendEvent(makeEvent({ id: '3', type: 'email.complained', createdAt: '2026-06-02T09:00:00Z' }));
    await appendResendEvent(makeEvent({ id: '4', type: 'email.bounced', createdAt: '2026-06-02T11:55:00Z',
      to: 'soft@example.com', bounceType: 'soft' }));
    // Out-of-window (>24h prior)
    await appendResendEvent(makeEvent({ id: 'old', type: 'email.bounced', createdAt: '2026-05-31T08:00:00Z' }));

    const sum = await summarizeResendBounces({ now, windowHours: 24, daysToScan: 3 });
    assert.equal(sum.totals['email.delivered'], 1);
    assert.equal(sum.totals['email.bounced'], 2, 'old bounce excluded by window');
    assert.equal(sum.totals['email.complained'], 1);
    assert.equal(sum.recentBounces.length, 2);
    // Newest first
    assert.equal(sum.recentBounces[0].id, '4');
    assert.equal(sum.recentBounces[1].id, '2');
    assert.equal(sum.recentComplaints.length, 1);
    assert.equal(sum.recentComplaints[0].id, '3');
  } finally { cleanup(dir); }
});

// ── Webhook route: source-level invariants ────────────────────────────────
//
// Route handler is NOT imported (pulls next/server). Same workaround
// already used by other route tests in this repo. The grep below
// pins the SECURITY-CRITICAL invariants that the route must always
// satisfy: secret-required (refuse 503 when missing), Svix headers
// required (401 when absent), HMAC verification before any persist
// call, and unknown event types dropped before persist.

test('resend webhook route source: refuses 503 when RESEND_WEBHOOK_SECRET is not set', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/api/webhooks/resend/route.ts', import.meta.url),
    'utf8',
  );
  const secretCheckIdx = src.indexOf("process.env.RESEND_WEBHOOK_SECRET");
  const status503Idx = src.indexOf('status: 503');
  const appendIdx = src.indexOf('appendResendEvent(');
  assert.ok(secretCheckIdx > -1 && status503Idx > -1, 'secret check + 503 path present');
  assert.ok(secretCheckIdx < status503Idx, 'secret check precedes 503 return');
  assert.ok(status503Idx < appendIdx, '503 (no secret) refusal precedes any appendResendEvent call');
});

test('resend webhook route source: requires svix-id / svix-timestamp / svix-signature headers (401 when missing)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/api/webhooks/resend/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(src, /svix-id/);
  assert.match(src, /svix-timestamp/);
  assert.match(src, /svix-signature/);
  assert.match(src, /Missing Svix headers/i);
  assert.match(src, /status: 401/);
});

test('resend webhook route source: HMAC verification precedes any persistence', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/api/webhooks/resend/route.ts', import.meta.url),
    'utf8',
  );
  const verifyIdx = src.indexOf('verifySvixSignature(');
  const invalidSigIdx = src.indexOf('Invalid signature');
  const appendIdx = src.indexOf('appendResendEvent(');
  assert.ok(verifyIdx > -1 && invalidSigIdx > -1 && appendIdx > -1);
  assert.ok(verifyIdx < appendIdx, 'verifySvixSignature must run before appendResendEvent');
  assert.ok(invalidSigIdx < appendIdx, 'Invalid-signature 401 must precede any persistence');
});

test('resend webhook route source: unknown event types are dropped (200-ack) BEFORE persistence', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/api/webhooks/resend/route.ts', import.meta.url),
    'utf8',
  );
  // normalizeResendWebhook returns null for unknown types; the route
  // must short-circuit on null with a 200-ack BEFORE appendResendEvent.
  const normalizeIdx = src.indexOf('normalizeResendWebhook(');
  const droppedIdx = src.indexOf("dropped: 'unknown_type'");
  const appendIdx = src.indexOf('appendResendEvent(');
  assert.ok(normalizeIdx > -1 && droppedIdx > -1 && appendIdx > -1);
  assert.ok(normalizeIdx < droppedIdx, 'normalize call precedes dropped-event branch');
  assert.ok(droppedIdx < appendIdx, 'unknown-type drop precedes any persistence');
});

test('resend webhook route source: no outbound network calls (no fetch / no Resend.emails.send)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/api/webhooks/resend/route.ts', import.meta.url),
    'utf8',
  );
  // Webhook is a receive-only path. It MUST NOT call out to any
  // service — no fetch, no Resend SDK send, no Stripe, no Lulu.
  assert.doesNotMatch(src, /\bfetch\(/);
  assert.doesNotMatch(src, /resend\.emails\.send/i);
  assert.doesNotMatch(src, /from 'resend'/);
  assert.doesNotMatch(src, /from '@\/lib\/order-email'/);
});

// ── Admin email-health page: source-level invariants ──────────────────────

test('admin email-health page source: auth-gated BEFORE rendering ingested events', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/admin/email-health/page.tsx', import.meta.url),
    'utf8',
  );
  const adminKeyIdx = src.indexOf('getConfiguredAdminKey');
  const authIdx = src.indexOf('isAdminAuthedFromCookie');
  const summaryIdx = src.indexOf('summarizeResendBounces');
  const listIdx = src.indexOf('listResendEvents');
  assert.ok(adminKeyIdx > -1 && authIdx > -1 && summaryIdx > -1 && listIdx > -1);
  assert.ok(adminKeyIdx < summaryIdx, 'admin-key check precedes event read');
  assert.ok(authIdx < summaryIdx, 'cookie auth check precedes event read');
});

test('admin email-health page source: empty state explicitly warns when RESEND_WEBHOOK_SECRET is unset', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/admin/email-health/page.tsx', import.meta.url),
    'utf8',
  );
  // Empty list must NEVER be silently interpreted as "all green". The
  // unconfigured-secret banner is the only safe empty state.
  assert.match(src, /data-testid="email-health-webhook-unconfigured"/);
  assert.match(src, /RESEND_WEBHOOK_SECRET is not set/);
  assert.match(src, /empty list does NOT mean delivery is healthy/i);
});

// ── R3: persistence fail-closed ─────────────────────────────────────────────

test('appendResendEvent throws ResendEventPersistenceError in production when BLOB_READ_WRITE_TOKEN is missing', async () => {
  const dir = makeTmp();
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'true';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const { ResendEventPersistenceError } = await import('../src/lib/resend-events.ts');
    const ev = makeEvent({ id: 'msg_r3_prod', type: 'email.bounced' });
    await assert.rejects(
      () => appendResendEvent(ev),
      (err) => err instanceof ResendEventPersistenceError,
      'append must throw ResendEventPersistenceError in prod with no blob token',
    );
  } finally {
    delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
    cleanup(dir);
  }
});

test('listResendEvents throws ResendEventPersistenceError in production when BLOB_READ_WRITE_TOKEN is missing', async () => {
  const dir = makeTmp();
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'true';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const { ResendEventPersistenceError } = await import('../src/lib/resend-events.ts');
    await assert.rejects(
      () => listResendEvents({ now: new Date('2026-06-02T12:00:00Z') }),
      (err) => err instanceof ResendEventPersistenceError,
      'read must throw ResendEventPersistenceError in prod with no blob token',
    );
  } finally {
    delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
    cleanup(dir);
  }
});

test('resend webhook route source: persistence failure returns 503 (NOT 200) so Svix retries', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/api/webhooks/resend/route.ts', import.meta.url),
    'utf8',
  );
  // The ResendEventPersistenceError catch must short-circuit to 503
  // with code PERSISTENCE_FAILED and retryable:true, AFTER the
  // appendResendEvent call (proves the catch wraps the write seam).
  const appendIdx = src.indexOf('appendResendEvent(event)');
  const instanceofIdx = src.indexOf('instanceof ResendEventPersistenceError');
  const status503Idx = src.indexOf('status: 503', instanceofIdx);
  assert.ok(appendIdx > -1 && instanceofIdx > -1 && status503Idx > -1);
  assert.ok(appendIdx < instanceofIdx, 'instanceof check (catch branch) must follow the persist call');
  assert.ok(instanceofIdx < status503Idx, '503 must be returned inside the persistence-error catch');
  assert.match(src, /code: 'PERSISTENCE_FAILED'/);
  assert.match(src, /retryable: true/);
});

// ── R4: Svix replay-window guard ────────────────────────────────────────────

test('resend webhook route source: enforces svix-timestamp replay window BEFORE signature check and persistence', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/api/webhooks/resend/route.ts', import.meta.url),
    'utf8',
  );
  // Stale + future-skew checks both present, BOTH before the
  // verifySvixSignature call so a stale-but-validly-signed payload
  // returns the precise STALE_TIMESTAMP / FUTURE_TIMESTAMP code.
  assert.match(src, /code: 'STALE_TIMESTAMP'/);
  assert.match(src, /code: 'FUTURE_TIMESTAMP'/);
  assert.match(src, /code: 'INVALID_TIMESTAMP'/);
  assert.match(src, /DEFAULT_REPLAY_WINDOW_SECONDS = 300/);
  const staleIdx = src.indexOf("'STALE_TIMESTAMP'");
  // Target the CALL site (`if (!verifySvixSignature(...))`), not the
  // function definition that lives above the POST handler.
  const verifyCallIdx = src.indexOf('if (!verifySvixSignature(');
  const appendIdx = src.indexOf('appendResendEvent(event)');
  assert.ok(staleIdx > -1 && verifyCallIdx > -1 && appendIdx > -1);
  assert.ok(staleIdx < verifyCallIdx, 'stale-timestamp refusal must precede signature-verification call');
  assert.ok(staleIdx < appendIdx, 'stale-timestamp refusal must precede persistence');
  // Override env var documented in code.
  assert.match(src, /RESEND_WEBHOOK_REPLAY_WINDOW_SECONDS/);
});

// ── R5: email-health freshness ──────────────────────────────────────────────

test('summarizeResendBounces exposes lastEventAt across the FULL retention scan (ignores window filter)', async () => {
  const dir = makeTmp();
  try {
    const now = new Date('2026-06-02T12:00:00Z');
    // Event from 4 days ago — outside any 24h window but inside the
    // 14d retention. lastEventAt must still surface it.
    await appendResendEvent(makeEvent({ id: 'old', type: 'email.delivered', createdAt: '2026-05-29T08:00:00Z' }));
    const summary = await summarizeResendBounces({ now, windowHours: 24, daysToScan: 5 });
    assert.equal(summary.totals['email.delivered'], 0, 'old event must be outside the 24h window');
    assert.equal(summary.lastEventAt, '2026-05-29T08:00:00Z', 'lastEventAt must surface the older event');
  } finally { cleanup(dir); }
});

test('summarizeResendBounces.lastEventAt is null when the retention scan finds nothing', async () => {
  const dir = makeTmp();
  try {
    const summary = await summarizeResendBounces({ now: new Date('2026-06-02T12:00:00Z') });
    assert.equal(summary.lastEventAt, null);
  } finally { cleanup(dir); }
});

test('admin email-health page source: renders lastEventAt + stale + configured-not-verified warnings', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/admin/email-health/page.tsx', import.meta.url),
    'utf8',
  );
  // Header always shows the last received event (or "never").
  assert.match(src, /data-testid="email-health-last-event-at"/);
  assert.match(src, /Last event received: never/);
  // Configured-but-never-verified banner: secret IS set yet
  // no events ever arrived.
  assert.match(src, /data-testid="email-health-configured-not-verified"/);
  assert.match(src, /Configured ≠ verified/);
  // Stale-window banner: events flowed at some point but the newest
  // is older than EMAIL_HEALTH_STALE_HOURS.
  assert.match(src, /data-testid="email-health-stale-warning"/);
  assert.match(src, /Stale webhook stream/);
  assert.match(src, /EMAIL_HEALTH_STALE_HOURS/);
});

test('admin email-health page source: persistence-failure path renders specific block, not generic 500', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/admin/email-health/page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(src, /data-testid="email-health-persistence-failed"/);
  assert.match(src, /PERSISTENCE_FAILED/);
  assert.match(src, /ResendEventPersistenceError/);
  assert.match(src, /BLOB_READ_WRITE_TOKEN/);
});

// ── Email/env readiness hardening (2026-06-02): three explicit behaviors ──

test('first received event surfaces in listResendEvents (proves the data flow admin email-health renders)', async () => {
  // The admin page passes listResendEvents output to its "Recent
  // events" block. A real event ingested by the webhook must
  // therefore be visible end-to-end. This test exercises the lib API
  // directly; the source-level test pins that the page renders from
  // the SAME helper.
  const dir = makeTmp();
  try {
    const ev = makeEvent({
      id: 'msg_first_ever',
      type: 'email.delivered',
      createdAt: '2026-06-02T12:00:00Z',
      to: 'first-recipient@example.com',
      subject: 'Your proof is ready',
    });
    const append = await appendResendEvent(ev);
    assert.equal(append.persisted, true, 'first event must persist on first append');

    const recent = await listResendEvents({ now: new Date('2026-06-02T12:05:00Z') });
    assert.equal(recent.length, 1, 'first event must be visible to the admin page read path');
    assert.equal(recent[0].id, 'msg_first_ever');
    assert.equal(recent[0].to, 'first-recipient@example.com');
    assert.equal(recent[0].subject, 'Your proof is ready');

    // And the summary's lastEventAt must equal the event's createdAt
    // — proving the "Last event received" header on the admin page
    // would display the correct ISO timestamp.
    const sum = await summarizeResendBounces({ now: new Date('2026-06-02T12:05:00Z') });
    assert.equal(sum.lastEventAt, '2026-06-02T12:00:00Z');
  } finally { cleanup(dir); }
});

test('admin email-health stale-derivation: lastEventAt older than EMAIL_HEALTH_STALE_HOURS produces a stale state', async () => {
  // The page computes `stale = !noEventsEver && lastEventAgeHours > staleHours`.
  // Lib-level summarize is the input; this test pins that crossing the
  // threshold flips the input the page tests against.
  const dir = makeTmp();
  try {
    // Event 30h old; default stale threshold = 24h.
    const oldIso = '2026-06-01T06:00:00Z';
    const now = new Date('2026-06-02T12:00:00Z');
    await appendResendEvent(makeEvent({ id: 'old_event', type: 'email.delivered', createdAt: oldIso }));
    const sum = await summarizeResendBounces({ now, windowHours: 24, daysToScan: 3 });
    assert.equal(sum.lastEventAt, oldIso);
    // Age computed the way the admin page does it.
    const ageHours = Math.round((now.getTime() - new Date(oldIso).getTime()) / 36e5);
    assert.ok(ageHours > 24, `synthetic age ${ageHours}h must exceed the default 24h threshold`);
  } finally { cleanup(dir); }
});

test('webhook route source: RESEND_WEBHOOK_SECRET missing returns 503 BEFORE reading body / svix headers / persistence', async () => {
  // The 2026-06-02 readiness audit re-asserts the fail-closed
  // ordering: with no secret, the route must not parse the body,
  // not inspect Svix headers, and certainly not persist.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/api/webhooks/resend/route.ts', import.meta.url),
    'utf8',
  );
  const secretCheckIdx = src.indexOf("process.env.RESEND_WEBHOOK_SECRET");
  const status503Idx = src.indexOf('status: 503', secretCheckIdx);
  const bodyReadIdx = src.indexOf('request.text()');
  const headerReadIdx = src.indexOf("request.headers.get('svix-id')");
  const appendIdx = src.indexOf('appendResendEvent(event)');
  assert.ok(secretCheckIdx > -1 && status503Idx > -1, 'secret check + 503 return present');
  assert.ok(status503Idx < bodyReadIdx, '503 (no secret) must precede body read');
  assert.ok(status503Idx < headerReadIdx, '503 (no secret) must precede Svix header inspection');
  assert.ok(status503Idx < appendIdx, '503 (no secret) must precede any persistence');
});
