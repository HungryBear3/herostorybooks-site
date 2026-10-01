/*
 * L-4 A3-6 — operator reconciliation: the route, the three doors, the
 * projection and the page (plan §4–§5, addendum AM-1 / OD-1).
 *
 * Every door is authenticated before any body read, order read or CAS; carries
 * an exact origin, a closed input, a stale-record token and per-door evidence;
 * commits one guarded CAS that releases only the confirmation claim and appends
 * one accepted audit event. Door 3 is an out-of-band attestation and sends
 * nothing. No door reaches a provider or the envelope store.
 *
 * Seams, all synthetic: the raw NBT pair over a versioned in-memory map, a
 * throwing envelope-store spy, a throwing `fetch` spy, and a `Request` whose
 * body readers count. The page (.tsx) cannot be rendered under node:test, so
 * it is covered by the projection tests and a source guard (plan §5).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONFIRMATION_EMAIL_OPERATOR_PROJECTION_KEYS,
  computeConfirmationEmailReconciliationToken,
  describeConfirmationEmailOperatorResult,
  handleConfirmationEmailOperatorRequest,
  projectConfirmationEmailForOperator,
  runConfirmationEmailReaper,
  type ConfirmationEmailOperatorDeps,
} from '../src/lib/confirmation-email-reconciliation.ts';
import { POST } from '../src/app/api/admin/orders/[orderId]/confirmation-email/route.ts';
import { CONFIRMATION_DISPATCH_DEADLINE_MS } from '../src/lib/confirmation-email-dispatch.ts';
import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepo = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

assert.equal(process.env.HSB_RESEND_API_KEY || undefined, undefined, 'no usable Resend key may be present');
assert.equal(process.env.RESEND_API_KEY || undefined, undefined, 'no usable Resend key may be present');
assert.equal(process.env.HSB_CONFIRMATION_ENVELOPE_WRITER, undefined, 'no ambient writer flag');

let FETCH_CALLS = 0;
const ORIGINAL_FETCH = globalThis.fetch;
globalThis.fetch = (async () => {
  FETCH_CALLS += 1;
  throw new Error('fetch is forbidden in the operator suite');
}) as typeof fetch;

// ── Fixtures ────────────────────────────────────────────────────────────────

const idOf = (suffix: string) => ['ord', `${'0'.repeat(16 - suffix.length)}${suffix}`].join('_');
const ADMIN_KEY = 'a36-synthetic-admin-key';
const ORIGIN = 'https://ops.example.invalid';
const INTENT_AT = '2026-10-15T13:00:00.000Z';
const INTENT_MS = Date.parse(INTENT_AT);
const DEADLINE_AT = new Date(INTENT_MS + CONFIRMATION_DISPATCH_DEADLINE_MS).toISOString();
const NOW_MS = INTENT_MS + 10 * 60_000;
const NOW_ISO = new Date(NOW_MS).toISOString();
const EPOCH = '2026-09-22T00:00:00.000Z';
const BLOB_TOKEN = 'vercel_blob_rw_SYNTHETICenvStore01_SYNTHETICsecret000001';
const MESSAGE_ID = 'a36f0000-0000-4000-8000-000000000001';

const CANARY = {
  email: 'CANARY-EMAIL-7c1d@example.invalid',
  key: 'CANARY-IDEMKEY-90ab',
  requestFrom: 'CANARY-REQFROM-3e55',
  requestTo: 'CANARY-REQTO-a4c2@example.invalid',
  requestSubject: 'CANARY-SUBJECT-0f19',
  child: 'CANARY-CHILD-b733',
  claim: 'CANARY-CLAIM-61d0',
  attempt: 'CANARY-ATTEMPT-28fe',
  objectPath: 'CANARY-OBJPATH',
};
/** Distinct from the request's sender: the frozen sender identity may show. */
const RECORD_FROM = 'RECORDFROM-OK-5b2e <no-reply@example.invalid>';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const isolated = <T>(fn: () => Promise<T> | T) => withEnv({
  HSB_BLOB_NAMESPACE: undefined, VERCEL: undefined, VERCEL_ENV: undefined,
  HSB_CONFIRMATION_ENVELOPE_WRITER: undefined, BLOB_READ_WRITE_TOKEN: undefined,
  HSB_ORDER_ADMIN_KEY: ADMIN_KEY,
}, fn);

function writerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HSB_CONFIRMATION_ENVELOPE_WRITER: 'true',
    HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: EPOCH,
    HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN: BLOB_TOKEN,
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

function refOf(id: string, purgedAt: string | null = null) {
  return {
    envelopeVersion: 1,
    orderId: id,
    templateVersion: 'confirmation-v1',
    createdAt: '2026-10-15T12:30:00.000Z',
    canonicalDigest: 'b'.repeat(64),
    canonicalBytes: 2048,
    accountLabel: 'hsb-test-account',
    storageKind: 'private_blob',
    objectPath: `confirmation-envelopes/${id}/v1.json`,
    purgedAt,
  };
}

/** A record held by the reaper: claim kept, attempt recorded. */
function heldOrder(id: string, overrides: Record<string, unknown> = {}): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: CANARY.child, bookFormat: 'digital', email: CANARY.email },
      { id, now: '2026-10-15T11:00:00.000Z' },
    ),
    paymentStatus: 'paid' as const,
    paidAt: '2026-10-15T12:00:00.000Z',
    stripeSessionId: `cs_test_${id}`,
    updatedAt: DEADLINE_AT,
    confirmationEmailState: 'RECONCILIATION_REQUIRED',
    confirmationEmailHoldReason: 'deadline_exceeded',
    confirmationEmailEnvelopeRef: refOf(id),
    // The retired inline envelope, as a hand-edited legacy record might carry it.
    confirmationEmailEnvelope: {
      request: { from: CANARY.requestFrom, to: [CANARY.requestTo], subject: CANARY.requestSubject, html: '<p>x</p>', text: 'x' },
      idempotencyKey: CANARY.key,
    },
    confirmationEmailFrom: RECORD_FROM,
    confirmationEmailIdempotencyKey: CANARY.key,
    confirmationEmailAttemptId: CANARY.attempt,
    confirmationEmailFirstDispatchIntentAt: INTENT_AT,
    confirmationEmailDispatchDeadlineAt: DEADLINE_AT,
    confirmationEmailAttempts: [
      { attemptId: CANARY.attempt, claimId: CANARY.claim, intentAt: INTENT_AT, outcome: 'ambiguous' },
    ],
    emailResendClaimId: CANARY.claim,
    emailResendClaimKind: 'order_confirmation',
    emailResendClaimArtifact: `cs_test_${id}`,
    emailResendClaimAt: INTENT_AT,
    ...overrides,
  } as unknown as OrderRecord;
}

// ── Seams ───────────────────────────────────────────────────────────────────

class OrderVersionConflictError extends Error {
  constructor() {
    super('synthetic version conflict');
    this.name = 'OrderVersionConflictError';
  }
}

type CommitHook = (orderId: string, attempt: number) => Promise<void> | void;

function casOrderIo(seed: OrderRecord[], hook?: CommitHook) {
  const cells = new Map<string, { body: string; v: number }>();
  for (const order of seed) cells.set(order.id, { body: JSON.stringify(order), v: 1 });
  const counts = { read: 0, transact: 0, commits: 0 };
  const recordPath = (orderId: string) => `orders/${orderId}.json`;
  const provenance = (orderId: string, outcome: string, reads: number, commits: number) => ({
    namespace: '',
    recordPath: recordPath(orderId),
    readPaths: Array.from({ length: reads }, () => recordPath(orderId)),
    commitPaths: Array.from({ length: commits }, () => recordPath(orderId)),
    attempts: reads,
    outcome,
  });
  const read = async (_binding: unknown, orderId: string) => {
    counts.read += 1;
    const cell = cells.get(orderId);
    return cell === undefined
      ? { found: null, provenance: provenance(orderId, 'not_found', 1, 0) }
      : { found: { order: JSON.parse(cell.body) as OrderRecord, version: `v${cell.v}` }, provenance: provenance(orderId, 'read', 1, 0) };
  };
  const transact = async (
    _binding: unknown,
    orderId: string,
    mutate: (order: OrderRecord) => unknown,
    opts: { notFound: () => unknown; beforeCommit?: () => boolean },
  ) => {
    counts.transact += 1;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const cell = cells.get(orderId);
      if (cell === undefined) return { status: 'not_found', result: opts.notFound(), provenance: provenance(orderId, 'not_found', attempt, 0) };
      const seen = cell.v;
      const outcome = await mutate(JSON.parse(cell.body) as OrderRecord) as { abort?: unknown; commit?: OrderRecord; result?: unknown };
      if ('abort' in outcome) return { status: 'aborted', result: outcome.abort, provenance: provenance(orderId, 'aborted', attempt, 0) };
      await hook?.(orderId, attempt);
      if (opts.beforeCommit && opts.beforeCommit() !== true) {
        return { status: 'commit_refused', provenance: provenance(orderId, 'commit_refused', attempt, 0) };
      }
      if (cells.get(orderId)!.v !== seen) continue;
      cells.set(orderId, { body: JSON.stringify(outcome.commit), v: seen + 1 });
      counts.commits += 1;
      return { status: 'committed', result: outcome.result, provenance: provenance(orderId, 'committed', attempt, 1) };
    }
    throw new OrderVersionConflictError();
  };
  return {
    io: { read, transact },
    counts,
    bodyOf: (orderId: string) => cells.get(orderId)?.body,
    recordOf: (orderId: string) => JSON.parse(cells.get(orderId)!.body) as OrderRecord,
    poke: (orderId: string, change: (order: OrderRecord) => OrderRecord) => {
      const cell = cells.get(orderId)!;
      cells.set(orderId, { body: JSON.stringify(change(JSON.parse(cell.body) as OrderRecord)), v: cell.v + 1 });
    },
  };
}

function storeSpy() {
  let calls = 0;
  const touch = async (): Promise<never> => {
    calls += 1;
    throw new Error('the envelope store was touched');
  };
  return { io: { put: touch, get: touch, del: touch }, calls: () => calls };
}

function operatorDeps(io: ReturnType<typeof casOrderIo>, extra: { storeIo?: unknown; env?: NodeJS.ProcessEnv; nowMs?: number } = {}) {
  const errors: string[] = [];
  const deps: ConfirmationEmailOperatorDeps = {
    now: () => extra.nowMs ?? NOW_MS,
    errorLog: (line) => { errors.push(line); },
    writer: {
      env: extra.env ?? writerEnv(),
      orderIo: io.io as never,
      ...(extra.storeIo ? { storeIo: extra.storeIo as never } : {}),
    },
  };
  return { deps, errors };
}

interface RequestOptions {
  authed?: boolean;
  origin?: string | null;
  form?: boolean;
  url?: string;
}

/** A request whose body readers count, so "no body read" is observable. */
function opRequest(orderId: string, body: Record<string, string>, opts: RequestOptions = {}) {
  const headers = new Headers();
  if (opts.authed !== false) headers.set('x-hsb-order-admin-key', ADMIN_KEY);
  if (opts.origin !== null) headers.set('origin', opts.origin ?? ORIGIN);
  const text = opts.form ? new URLSearchParams(body).toString() : JSON.stringify(body);
  headers.set('content-type', opts.form ? 'application/x-www-form-urlencoded' : 'application/json');
  const reads = { count: 0 };
  const count = <T>(value: T) => { reads.count += 1; return value; };
  const request = {
    url: opts.url ?? `${ORIGIN}/api/admin/orders/${orderId}/confirmation-email`,
    method: 'POST',
    headers,
    text: async () => count(text),
    json: async () => count(JSON.parse(text)),
    formData: async () => count(new URLSearchParams(text)),
    arrayBuffer: async () => count(new TextEncoder().encode(text).buffer),
    get body() { reads.count += 1; return null; },
  } as unknown as Request;
  return { request, reads };
}

async function call(
  io: ReturnType<typeof casOrderIo>,
  orderId: string,
  body: Record<string, string>,
  opts: RequestOptions & { deps?: ConfirmationEmailOperatorDeps } = {},
) {
  const { deps } = opts.deps ? { deps: opts.deps } : operatorDeps(io);
  const { request, reads } = opRequest(orderId, body, opts);
  const response = await handleConfirmationEmailOperatorRequest(request, Promise.resolve({ orderId }), deps);
  const text = await response.text();
  return { response, status: response.status, text, json: text ? JSON.parse(text) : null, reads };
}

const tokenOf = (order: OrderRecord) => computeConfirmationEmailReconciliationToken(order);

const DOORS = {
  bind: (order: OrderRecord, id = MESSAGE_ID) => ({ action: 'bind_acceptance', expectedToken: tokenOf(order), providerMessageId: id }),
  prove: (order: OrderRecord) => ({ action: 'prove_non_acceptance', expectedToken: tokenOf(order), attestation: 'provider_shows_no_acceptance' }),
  resend: (order: OrderRecord) => ({ action: 'resend_attestation', expectedToken: tokenOf(order), attestation: 'sent_out_of_band' }),
};

function assertNoCanary(label: string, ...surfaces: string[]) {
  for (const surface of surfaces) {
    for (const [name, marker] of Object.entries(CANARY)) {
      assert.equal(surface.includes(marker), false, `${label}: canary ${name} leaked`);
    }
  }
}

// ── Auth, origin, order id (before any read) ───────────────────────────────

test('OP-1: unauthenticated → 401 with no body read, no order read and no transaction', async () => {
  await isolated(async () => {
    const id = idOf('a1');
    const order = heldOrder(id);
    const io = casOrderIo([order]);
    for (const [label, opts] of [
      ['no key', { authed: false }],
      ['no key, bad origin, bad id', { authed: false, origin: 'https://evil.example.invalid' }],
    ] as const) {
      const r = await call(io, label.includes('bad id') ? 'not-an-id' : id, DOORS.resend(order), opts);
      assert.equal(r.status, 401, label);
      assert.deepEqual(r.json, { ok: false, error: 'unauthorized' }, label);
      assert.equal(r.reads.count, 0, `${label}: the body was read`);
    }
    // Unconfigured key fails closed too.
    await withEnv({ HSB_ORDER_ADMIN_KEY: undefined }, async () => {
      const r = await call(io, id, DOORS.resend(order));
      assert.equal(r.status, 401);
      assert.equal(r.reads.count, 0);
    });
    assert.deepEqual(io.counts, { read: 0, transact: 0, commits: 0 });
  });
});

test('OP-2: a cross-origin request → 403; a bad order id → 404; neither reads anything', async () => {
  await isolated(async () => {
    const id = idOf('a2');
    const order = heldOrder(id);
    const io = casOrderIo([order]);
    for (const origin of ['https://evil.example.invalid', 'null', `${ORIGIN}:8443`, 'http://ops.example.invalid']) {
      const r = await call(io, id, DOORS.resend(order), { origin });
      assert.equal(r.status, 403, origin);
      assert.deepEqual(r.json, { ok: false, error: 'origin_mismatch' });
      assert.equal(r.reads.count, 0);
    }
    for (const bad of ['ord_123', ['ORD', '0000000000000a02'].join('_'), `${id}/../x`, '', 'ord_000000000000000g']) {
      const r = await call(io, bad, DOORS.resend(order));
      assert.equal(r.status, 404, bad);
      assert.deepEqual(r.json, { ok: false, error: 'not_found' });
      assert.equal(r.reads.count, 0);
    }
    assert.deepEqual(io.counts, { read: 0, transact: 0, commits: 0 });
    // An absent Origin header is allowed (non-browser callers).
    const ok = await call(io, id, DOORS.resend(order), { origin: null });
    assert.equal(ok.status, 200);
  });
});

test('OP-3: the route file authenticates through the handler and reads nothing when unauthenticated', async () => {
  await isolated(async () => {
    const id = idOf('a3');
    const { request, reads } = opRequest(id, { action: 'resend_attestation' }, { authed: false });
    const response = await POST(request, { params: Promise.resolve({ orderId: id }) });
    assert.equal(response.status, 401);
    assert.equal(reads.count, 0);
    // Authenticated, the default (unset) writer gate refuses with no write.
    const authed = opRequest(id, { action: 'resend_attestation', expectedToken: 'f'.repeat(64), attestation: 'sent_out_of_band' });
    const refused = await POST(authed.request, { params: Promise.resolve({ orderId: id }) });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { ok: false, error: 'reconciliation_unavailable' });
  });
});

test('OP-4: the route source is a thin, auth-first shell over the reconciliation handler', () => {
  const source = readRepo('src/app/api/admin/orders/[orderId]/confirmation-email/route.ts');
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['../../../../../../lib/confirmation-email-reconciliation.ts']);
  assert.match(source, /export async function POST\(/);
  assert.doesNotMatch(source, /export async function (GET|PUT|PATCH|DELETE)\(/);
  assert.doesNotMatch(source, /confirmationEmail[A-Z]|emailResendClaim|getOrder|withOrderTransaction|process\.env/);
});

// ── Input ──────────────────────────────────────────────────────────────────

test('OP-5: the body is closed — unknown keys, bad types, bad tokens, bad actions and oversize bodies are 400 with no write', async () => {
  await isolated(async () => {
    const id = idOf('a5');
    const order = heldOrder(id);
    const io = casOrderIo([order]);
    const base = DOORS.resend(order);
    const cases: Array<[string, Record<string, string>]> = [
      ['unknown action', { ...base, action: 'send_now' }],
      ['prototype action', { ...base, action: '__proto__' }],
      ['missing token', { action: base.action, attestation: base.attestation }],
      ['short token', { ...base, expectedToken: 'abc' }],
      ['uppercase token', { ...base, expectedToken: base.expectedToken.toUpperCase() }],
      ['extra key', { ...base, note: 'free text' }],
      ['email key', { ...base, email: CANARY.email }],
      ['wrong attestation', { ...base, attestation: 'provider_shows_no_acceptance' }],
      ['message id on door 3', { ...base, providerMessageId: MESSAGE_ID }],
      ['oversize', { ...base, attestation: 'x'.repeat(10_000) }],
    ];
    for (const [label, body] of cases) {
      const r = await call(io, id, body);
      assert.equal(r.status, 400, label);
      assert.deepEqual(r.json, { ok: false, error: 'bad_input' }, label);
    }
    // Non-string values and non-object JSON.
    for (const raw of ['[]', '"x"', 'null', '{"action":1}', '{bad json']) {
      const { request } = opRequest(id, {});
      (request as unknown as { text: () => Promise<string> }).text = async () => raw;
      const response = await handleConfirmationEmailOperatorRequest(request, Promise.resolve({ orderId: id }), operatorDeps(io).deps);
      assert.equal(response.status, 400, raw);
    }
    assert.deepEqual(io.counts, { read: 0, transact: 0, commits: 0 });
  });
});

test('OP-6: door 1 evidence — missing or malformed id is 400; an id conflicting with recorded acceptance is 409', async () => {
  await isolated(async () => {
    const id = idOf('a6');
    const order = heldOrder(id);
    const io = casOrderIo([order]);
    for (const bad of ['', 'has space', 'semi;colon', 'x'.repeat(129), 'ünicode', 'a/b']) {
      const r = await call(io, id, DOORS.bind(order, bad));
      assert.equal(r.status, 400, bad);
    }
    const missing = { action: 'bind_acceptance', expectedToken: tokenOf(order) };
    assert.equal((await call(io, id, missing)).status, 400);
    assert.equal(io.counts.transact, 0);

    // A history that recorded acceptance under a different id.
    const accepted = heldOrder(idOf('a7'), {
      confirmationEmailHoldReason: 'receipt_write_failed',
      confirmationEmailAttempts: [
        { attemptId: CANARY.attempt, claimId: CANARY.claim, intentAt: INTENT_AT, outcome: 'accepted', providerMessageId: 'msg-recorded-1' },
      ],
    });
    const io2 = casOrderIo([accepted]);
    const before = io2.bodyOf(accepted.id);
    const conflict = await call(io2, accepted.id, DOORS.bind(accepted, 'msg-other-2'));
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.json, { ok: false, error: 'evidence_conflict' });
    assert.equal(io2.bodyOf(accepted.id), before);
    const matching = await call(io2, accepted.id, DOORS.bind(accepted, 'msg-recorded-1'));
    assert.equal(matching.status, 200);
    assert.equal(io2.recordOf(accepted.id).confirmationEmailState, 'RECONCILED_ACCEPTED');
  });
});

// ── The doors ──────────────────────────────────────────────────────────────

const META_KEYS = ['attemptCount', 'door', 'evidenceKind', 'fromHoldReason', 'toState'];

test('OP-7: each door commits its modelled target, releases the confirmation claim and appends one audit event', async () => {
  await isolated(async () => {
    const cases = [
      { door: 'bind', body: DOORS.bind, to: 'RECONCILED_ACCEPTED', result: 'reconciled_accepted', type: 'confirmation_reconciled', evidence: 'provider_message_id' },
      { door: 'prove', body: DOORS.prove, to: 'SNAPSHOTTED', result: 'returned_to_snapshot', type: 'confirmation_reconciled', evidence: 'provider_shows_no_acceptance' },
      { door: 'resend', body: DOORS.resend, to: 'OWNER_AUTHORIZED_RESEND_SENT', result: 'resend_attested', type: 'confirmation_owner_resend', evidence: 'sent_out_of_band' },
    ] as const;
    for (const [index, c] of cases.entries()) {
      for (const gate of ['disarmed', 'armed'] as const) {
        const id = idOf(`b${index}${gate === 'armed' ? 1 : 0}`);
        const order = heldOrder(id);
        const io = casOrderIo([order]);
        const store = storeSpy();
        const { deps, errors } = operatorDeps(io, gate === 'armed' ? { storeIo: store.io } : {});
        const fetchBefore = FETCH_CALLS;
        const r = await call(io, id, c.body(order), { deps });
        const label = `${c.door}/${gate}`;
        assert.equal(r.status, 200, label);
        assert.deepEqual(r.json, { ok: true, result: c.result }, label);

        const after = io.recordOf(id);
        assert.equal(after.confirmationEmailState, c.to, label);
        assert.equal(after.confirmationEmailHoldReason, null, label);
        // AM-1: the confirmation claim is released, all four fields.
        assert.equal(after.emailResendClaimId, null, label);
        assert.equal(after.emailResendClaimKind, null, label);
        assert.equal(after.emailResendClaimArtifact, null, label);
        assert.equal(after.emailResendClaimAt, null, label);
        // No receipt fields are written by any door.
        assert.equal(after.confirmationEmailSentAt ?? null, null, label);
        assert.equal(after.confirmationEmailAcceptedAt ?? null, null, label);
        assert.equal(after.confirmationEmailProviderMessageId ?? null, null, label);
        // Evidence that survives: first intent, attempt id, deadline, history.
        assert.equal(after.confirmationEmailFirstDispatchIntentAt, INTENT_AT, label);
        assert.equal(after.confirmationEmailAttemptId, CANARY.attempt, label);
        assert.equal(after.confirmationEmailDispatchDeadlineAt, DEADLINE_AT, label);
        assert.deepEqual(after.confirmationEmailAttempts, order.confirmationEmailAttempts, label);
        assert.equal(after.updatedAt, NOW_ISO, label);

        const events = after.auditEvents ?? [];
        assert.equal(events.length, 1, label);
        const [event] = events;
        assert.equal(event.type, c.type, label);
        assert.equal(event.at, NOW_ISO, label);
        const expectedKeys = c.door === 'bind' ? [...META_KEYS, 'providerMessageId'].sort() : META_KEYS;
        assert.deepEqual(Object.keys(event.meta ?? {}).sort(), expectedKeys, `${label}: meta allowlist`);
        assert.deepEqual(event.meta, {
          door: c.body(order).action,
          fromHoldReason: 'deadline_exceeded',
          toState: c.to,
          attemptCount: 1,
          evidenceKind: c.evidence,
          ...(c.door === 'bind' ? { providerMessageId: MESSAGE_ID } : {}),
        }, label);
        assert.deepEqual(Object.keys(event).sort(), ['at', 'meta', 'type'], `${label}: no reason, no free text`);

        // Every other field is untouched.
        const strip = (record: OrderRecord) => {
          const copy: Record<string, unknown> = { ...record };
          for (const key of ['confirmationEmailState', 'confirmationEmailHoldReason', 'emailResendClaimId', 'emailResendClaimKind',
            'emailResendClaimArtifact', 'emailResendClaimAt', 'auditEvents', 'updatedAt']) delete copy[key];
          return copy;
        };
        assert.deepEqual(strip(after), strip(JSON.parse(JSON.stringify(order))), `${label}: only the door fields moved`);

        assert.equal(FETCH_CALLS, fetchBefore, `${label}: the transport spy is untouched`);
        assert.equal(store.calls(), 0, `${label}: the envelope store is untouched`);
        assert.deepEqual(errors, [], label);
        assertNoCanary(label, r.text, JSON.stringify(events));
      }
    }
  });
});

test('OP-8: every door is refused from every non-held state, with no write', async () => {
  await isolated(async () => {
    const states = [null, 'SNAPSHOTTED', 'DISPATCH_INTENT_RECORDED', 'ACCEPTED', 'PROVABLY_PRE_DISPATCH_FAILED', 'RECONCILED_ACCEPTED', 'OWNER_AUTHORIZED_RESEND_SENT', 'BOGUS'];
    for (const [index, state] of states.entries()) {
      const id = idOf(`c${index}`);
      const order = heldOrder(id, { confirmationEmailState: state, confirmationEmailHoldReason: null });
      const io = casOrderIo([order]);
      const before = io.bodyOf(id);
      for (const door of Object.values(DOORS)) {
        const r = await call(io, id, door(order));
        assert.equal(r.status, 409, `${String(state)} ${door(order).action}`);
        assert.deepEqual(r.json, { ok: false, error: 'not_held' });
      }
      assert.equal(io.bodyOf(id), before);
      assert.equal(io.counts.commits, 0);
    }
    // An unknown order: 404, no write.
    const io = casOrderIo([]);
    const missing = await call(io, idOf('cf'), DOORS.resend(heldOrder(idOf('cf'))));
    assert.equal(missing.status, 404);
  });
});

test('OP-9: door 2 is refused after any recorded acceptance, on a receipt hold, and without a usable ref', async () => {
  await isolated(async () => {
    const accepted = { attemptId: 'x', claimId: 'y', intentAt: INTENT_AT, outcome: 'accepted', providerMessageId: 'msg-1' };
    const idOnly = { attemptId: 'x', claimId: 'y', intentAt: INTENT_AT, outcome: 'ambiguous', providerMessageId: 'msg-2' };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['receipt_write_failed', { confirmationEmailHoldReason: 'receipt_write_failed' }],
      ['claim_lost_after_acceptance', { confirmationEmailHoldReason: 'claim_lost_after_acceptance' }],
      ['accepted attempt', { confirmationEmailAttempts: [accepted] }],
      ['message id on an attempt', { confirmationEmailAttempts: [idOnly] }],
      ['message id on the record', { confirmationEmailProviderMessageId: 'msg-3' }],
      ['acceptance instant on the record', { confirmationEmailAcceptedAt: INTENT_AT }],
      ['receipt on the record', { confirmationEmailSentAt: INTENT_AT }],
      ['unreadable history', { confirmationEmailAttempts: 'not-an-array' }],
      ['no ref', { confirmationEmailEnvelopeRef: null }],
      ['tombstoned ref', { confirmationEmailEnvelopeRef: 'tombstone' }],
      ['foreign ref', { confirmationEmailEnvelopeRef: 'foreign' }],
    ];
    for (const [index, [label, overrides]] of cases.entries()) {
      const id = idOf(`d${index.toString(16)}`);
      const resolved = { ...overrides };
      if (resolved.confirmationEmailEnvelopeRef === 'tombstone') resolved.confirmationEmailEnvelopeRef = refOf(id, INTENT_AT);
      if (resolved.confirmationEmailEnvelopeRef === 'foreign') resolved.confirmationEmailEnvelopeRef = refOf(idOf('ffff'));
      const order = heldOrder(id, resolved);
      const io = casOrderIo([order]);
      const before = io.bodyOf(id);
      const r = await call(io, id, DOORS.prove(order));
      assert.equal(r.status, 409, label);
      assert.deepEqual(r.json, { ok: false, error: 'door_not_permitted' }, label);
      assert.equal(io.bodyOf(id), before, label);
      assert.equal(projectConfirmationEmailForOperator(order).availableDoors.includes('prove_non_acceptance'), false, label);
    }
  });
});

test('OP-10: a stale token aborts with 409 and no write; an unrelated updatedAt change does not', async () => {
  await isolated(async () => {
    const id = idOf('e1');
    const order = heldOrder(id);
    const staleBody = DOORS.resend(order);
    for (const [label, change] of [
      ['attempt id', (o: OrderRecord) => ({ ...o, confirmationEmailAttemptId: 'attempt-other' })],
      ['hold reason', (o: OrderRecord) => ({ ...o, confirmationEmailHoldReason: 'ambiguous_dispatch' })],
      ['attempt appended', (o: OrderRecord) => ({ ...o, confirmationEmailAttempts: [...(o.confirmationEmailAttempts ?? []), { attemptId: 'z', claimId: 'z', intentAt: INTENT_AT, outcome: 'ambiguous' }] })],
      ['claim id', (o: OrderRecord) => ({ ...o, emailResendClaimId: 'claim-other' })],
      ['deadline', (o: OrderRecord) => ({ ...o, confirmationEmailDispatchDeadlineAt: INTENT_AT })],
    ] as const) {
      const io = casOrderIo([order]);
      io.poke(id, change as (o: OrderRecord) => OrderRecord);
      const before = io.bodyOf(id);
      const r = await call(io, id, staleBody);
      assert.equal(r.status, 409, label);
      assert.deepEqual(r.json, { ok: false, error: 'stale_record' }, label);
      assert.equal(io.bodyOf(id), before, label);
    }
    const io = casOrderIo([order]);
    io.poke(id, (o) => ({ ...o, updatedAt: '2026-10-15T13:05:00.000Z', fulfillmentAttempts: 3 }));
    const r = await call(io, id, staleBody);
    assert.equal(r.status, 200, 'updatedAt is outside the token');
  });
});

test('OP-11: concurrent operator + operator → exactly one transition', async () => {
  await isolated(async () => {
    const id = idOf('e2');
    const order = heldOrder(id);
    let gate!: () => void;
    const both = new Promise<void>((resolve) => { gate = resolve; });
    let arrived = 0;
    const io = casOrderIo([order], async (_orderId, attempt) => {
      if (attempt !== 1) return;
      arrived += 1;
      if (arrived === 2) gate();
      await both;
    });
    const [a, b] = await Promise.all([
      call(io, id, DOORS.bind(order)),
      call(io, id, DOORS.resend(order)),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const loser = a.status === 409 ? a : b;
    assert.ok(['stale_record', 'not_held'].includes(loser.json.error), loser.text);
    assert.equal(io.counts.commits, 1);
    assert.equal(io.recordOf(id).auditEvents?.length, 1);
  });
});

test('OP-12: concurrent operator + reaper → exactly one transition', async () => {
  await isolated(async () => {
    const id = idOf('e3');
    // The operator loaded the page while the record still held intent.
    const intent = heldOrder(id, {
      confirmationEmailState: 'DISPATCH_INTENT_RECORDED', confirmationEmailHoldReason: null, confirmationEmailAttempts: [],
    });
    const io = casOrderIo([intent]);
    const staleBody = DOORS.resend(intent);
    const reaperErrors: string[] = [];
    const [reaped, operator] = await Promise.all([
      runConfirmationEmailReaper([intent], {
        nowMs: NOW_MS, log: () => {}, errorLog: (line) => { reaperErrors.push(line); },
        writer: { env: writerEnv(), orderIo: io.io as never },
      }),
      call(io, id, staleBody),
    ]);
    assert.equal(reaped.reaped, 1);
    assert.equal(operator.status, 409);
    assert.ok(['stale_record', 'not_held'].includes(operator.json.error));
    assert.equal(io.counts.commits, 1);
    const after = io.recordOf(id);
    assert.equal(after.confirmationEmailState, 'RECONCILIATION_REQUIRED');
    assert.equal(after.emailResendClaimId, CANARY.claim, 'the reaper kept the claim');

    // With the fresh token the operator then resolves it, once.
    const fresh = await call(io, id, DOORS.resend(after));
    assert.equal(fresh.status, 200);
    assert.equal(io.counts.commits, 2);
  });
});

test('OP-13 (AM-1): a foreign claim kind aborts fail-closed; a resolved order is no longer claim-blocked', async () => {
  await isolated(async () => {
    const id = idOf('e4');
    const foreign = heldOrder(id, { emailResendClaimKind: 'shipped' });
    const io = casOrderIo([foreign]);
    const before = io.bodyOf(id);
    for (const door of Object.values(DOORS)) {
      const r = await call(io, id, door(foreign));
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { ok: false, error: 'claim_other_kind' });
    }
    assert.equal(io.bodyOf(id), before);

    // No claim at all: the door commits and writes no claim fields.
    const unclaimed = heldOrder(idOf('e5'), {
      emailResendClaimId: undefined, emailResendClaimKind: undefined, emailResendClaimArtifact: undefined, emailResendClaimAt: undefined,
    });
    const io2 = casOrderIo([unclaimed]);
    assert.equal((await call(io2, unclaimed.id, DOORS.resend(unclaimed))).status, 200);
    const after2 = io2.recordOf(unclaimed.id);
    assert.equal('emailResendClaimId' in after2, false);

    // The admin resend, ship and refund paths, and the fulfillment patch
    // boundary, all refuse while `emailResendClaimId` is set. After a door it
    // is null, so none of them is blocked by the confirmation any longer.
    const claimed = heldOrder(idOf('e6'));
    const io3 = casOrderIo([claimed]);
    assert.ok(claimed.emailResendClaimId);
    assert.equal((await call(io3, claimed.id, DOORS.bind(claimed))).status, 200);
    assert.equal(io3.recordOf(claimed.id).emailResendClaimId, null);
    const adminActions = readRepo('src/lib/admin-actions.ts');
    assert.ok((adminActions.match(/current\.emailResendClaimId/g) ?? []).length >= 3, 'the blocking predicate is the claim id');
  });
});

test('OP-14: a writer gate that is off or refused → 409 reconciliation_unavailable with no read or write', async () => {
  await isolated(async () => {
    const id = idOf('e7');
    const order = heldOrder(id);
    for (const [label, env, ambient] of [
      ['off', { HSB_CONFIRMATION_ENVELOPE_WRITER: undefined } as unknown as NodeJS.ProcessEnv, undefined],
      ['refused', writerEnv({ HSB_BLOB_NAMESPACE: 'ns-a' }), 'ns-z'],
    ] as const) {
      await withEnv({ HSB_BLOB_NAMESPACE: ambient }, async () => {
        const io = casOrderIo([order]);
        const { deps } = operatorDeps(io, { env });
        const r = await call(io, id, DOORS.resend(order), { deps });
        assert.equal(r.status, 409, label);
        assert.deepEqual(r.json, { ok: false, error: 'reconciliation_unavailable' }, label);
        assert.deepEqual(io.counts, { read: 0, transact: 0, commits: 0 }, label);
      });
    }
  });
});

test('OP-15: CAS exhaustion maps to stale_record; namespace drift to reconciliation_unavailable; neither writes', async () => {
  await isolated(async () => {
    const id = idOf('e8');
    const order = heldOrder(id);
    const io = casOrderIo([order], (orderId) => { io.poke(orderId, (o) => ({ ...o, updatedAt: new Date().toISOString() })); });
    const r = await call(io, id, DOORS.resend(order));
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { ok: false, error: 'stale_record' });
    assert.equal(io.recordOf(id).confirmationEmailState, 'RECONCILIATION_REQUIRED');

    const io2 = casOrderIo([order], () => { process.env.HSB_BLOB_NAMESPACE = 'ns-drifted'; });
    const { deps, errors } = operatorDeps(io2);
    try {
      const drift = await call(io2, id, DOORS.resend(order), { deps });
      assert.equal(drift.status, 409);
      assert.deepEqual(drift.json, { ok: false, error: 'reconciliation_unavailable' });
    } finally {
      delete process.env.HSB_BLOB_NAMESPACE;
    }
    assert.equal(io2.recordOf(id).confirmationEmailState, 'RECONCILIATION_REQUIRED');
    assert.deepEqual(errors, [`[confirmation-email-operator] door refused orderId=${id} reason=namespace_drift`]);
  });
});

test('OP-16: an unexpected fault is a 500 with a class name only — never the error text', async () => {
  await isolated(async () => {
    const id = idOf('e9');
    const order = heldOrder(id);
    const io = casOrderIo([order]);
    const { deps, errors } = operatorDeps(io);
    (io.io as { transact: unknown }).transact = async () => { throw new RangeError(`private ${CANARY.email}`); };
    const r = await call(io, id, DOORS.resend(order), { deps });
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { ok: false, error: 'unexpected' });
    assert.deepEqual(errors, [`[confirmation-email-operator] door failed orderId=${id} errorClass=RangeError`]);
    assertNoCanary('500', r.text, errors.join('\n'));
  });
});

// ── Form posts (the page's native forms) ───────────────────────────────────

test('OP-17: a form post is answered with a 303 to the order page and a closed result code', async () => {
  await isolated(async () => {
    const id = idOf('f1');
    const order = heldOrder(id);
    const io = casOrderIo([order]);
    const ok = await call(io, id, DOORS.resend(order), { form: true });
    assert.equal(ok.status, 303);
    assert.equal(ok.response.headers.get('location'), `/admin/orders/${id}?confirmation=resend_attested`);
    assert.equal(ok.text, '');
    const again = await call(io, id, DOORS.resend(order), { form: true });
    assert.equal(again.response.headers.get('location'), `/admin/orders/${id}?confirmation=not_held`);
    const bad = await call(io, id, { action: 'nope' }, { form: true });
    assert.equal(bad.response.headers.get('location'), `/admin/orders/${id}?confirmation=bad_input`);
    // Auth, origin and id failures are never redirected.
    assert.equal((await call(io, id, DOORS.resend(order), { form: true, authed: false })).status, 401);
    assert.equal((await call(io, id, DOORS.resend(order), { form: true, origin: 'https://evil.example.invalid' })).status, 403);
  });
});

test('OP-18: the result-code lookup is closed and never echoes its input', () => {
  for (const code of ['reconciled_accepted', 'returned_to_snapshot', 'resend_attested', 'bad_input', 'stale_record', 'not_held',
    'door_not_permitted', 'evidence_conflict', 'claim_other_kind', 'reconciliation_unavailable', 'unexpected']) {
    const text = describeConfirmationEmailOperatorResult(code);
    assert.equal(typeof text, 'string', code);
    assert.ok(text!.length > 0);
    assert.equal(text!.includes(code), false, `${code}: the raw code is echoed`);
  }
  for (const raw of [undefined, null, '', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '<script>x</script>', ['resend_attested'], 42]) {
    assert.equal(describeConfirmationEmailOperatorResult(raw), null, String(raw));
  }
});

// ── Projection ─────────────────────────────────────────────────────────────

test('OP-19: the projection has exactly the allowlisted keys, built by name, and does not mutate its input', () => {
  const id = idOf('f2');
  const order = heldOrder(id, { confirmationEmailSentAt: null, confirmationEmailAcceptedAt: null });
  const snapshot = JSON.stringify(order);
  const view = projectConfirmationEmailForOperator(order);
  assert.equal(JSON.stringify(order), snapshot, 'input mutated');
  assert.deepEqual(Object.keys(view), [...CONFIRMATION_EMAIL_OPERATOR_PROJECTION_KEYS]);
  assert.deepEqual([...CONFIRMATION_EMAIL_OPERATOR_PROJECTION_KEYS], [
    'envelope', 'state', 'holdReason', 'firstDispatchIntentAt', 'dispatchDeadlineAt', 'acceptedAt', 'sentAt',
    'providerMessageId', 'from', 'attemptCount', 'availableDoors', 'expectedToken',
  ]);
  assert.deepEqual(view, {
    envelope: {
      envelopeVersion: 1, orderId: id, templateVersion: 'confirmation-v1', createdAt: '2026-10-15T12:30:00.000Z',
      canonicalDigest: 'b'.repeat(64), canonicalBytes: 2048, accountLabel: 'hsb-test-account', purgedAt: null,
    },
    state: 'RECONCILIATION_REQUIRED',
    holdReason: 'deadline_exceeded',
    firstDispatchIntentAt: INTENT_AT,
    dispatchDeadlineAt: DEADLINE_AT,
    acceptedAt: null,
    sentAt: null,
    providerMessageId: null,
    from: RECORD_FROM,
    attemptCount: 1,
    availableDoors: ['bind_acceptance', 'prove_non_acceptance', 'resend_attestation'],
    expectedToken: computeConfirmationEmailReconciliationToken(order),
  });
  assert.match(view.expectedToken, /^[a-f0-9]{64}$/);
  // Canaries: request, key, email, claim, attempt id and the inline envelope never appear.
  assertNoCanary('projection', JSON.stringify(view));
  assert.ok(JSON.stringify(view).includes(RECORD_FROM), 'the frozen sender identity is shown');
});

test('OP-20: unrecognized and non-canonical values project as closed sentinels or null', () => {
  const id = idOf('f3');
  const view = projectConfirmationEmailForOperator(heldOrder(id, {
    confirmationEmailState: 'HACKED<script>',
    confirmationEmailHoldReason: 'free text reason',
    confirmationEmailFirstDispatchIntentAt: '2026-10-15T13:00:00',
    confirmationEmailDispatchDeadlineAt: '2026-09-31T00:00:00.000Z',
    confirmationEmailAcceptedAt: 12345,
    confirmationEmailSentAt: ' 2026-10-15T13:00:00.000Z',
    confirmationEmailProviderMessageId: 'has space',
    confirmationEmailFrom: { toString: () => 'x' },
    confirmationEmailAttempts: { length: 5 },
    confirmationEmailEnvelopeRef: { ...refOf(id), request: { from: CANARY.requestFrom } },
  }));
  assert.equal(view.state, 'unrecognized');
  assert.equal(view.holdReason, 'unrecognized');
  for (const key of ['firstDispatchIntentAt', 'dispatchDeadlineAt', 'acceptedAt', 'sentAt', 'providerMessageId', 'from', 'envelope'] as const) {
    assert.equal(view[key], null, key);
  }
  assert.equal(view.attemptCount, 0);
  assert.deepEqual(view.availableDoors, []);
  assertNoCanary('sentinels', JSON.stringify(view));

  const empty = projectConfirmationEmailForOperator(heldOrder(idOf('f4'), {
    confirmationEmailState: undefined, confirmationEmailHoldReason: undefined,
  }));
  assert.equal(empty.state, null);
  assert.equal(empty.holdReason, null);
  assert.deepEqual(empty.availableDoors, []);
});

test('OP-21: availableDoors mirrors the commit refusals', () => {
  const id = idOf('f5');
  assert.deepEqual(projectConfirmationEmailForOperator(heldOrder(id, { confirmationEmailHoldReason: 'receipt_write_failed' })).availableDoors,
    ['bind_acceptance', 'resend_attestation']);
  assert.deepEqual(projectConfirmationEmailForOperator(heldOrder(id, { emailResendClaimKind: 'proof_ready' })).availableDoors, []);
  assert.deepEqual(projectConfirmationEmailForOperator(heldOrder(id, { confirmationEmailState: 'ACCEPTED' })).availableDoors, []);
});

// ── The page (source guard; .tsx cannot render under node:test) ───────────

test('OP-22: the page renders only the projection, posts native forms to the route, and says door 3 sends nothing', () => {
  const page = readRepo('src/app/admin/orders/[orderId]/page.tsx');
  assert.match(page, /import \{[^}]*projectConfirmationEmailForOperator[^}]*\} from '@\/lib\/confirmation-email-reconciliation';/);
  for (const forbidden of [
    'confirmation-envelope-producer', 'confirmation-email-dispatch', 'confirmation-envelope-store', 'order-email',
    'confirmation-email-state', 'resolveConfirmationEnvelopeWriter', 'dangerouslySetInnerHTML',
  ]) {
    assert.equal(page.includes(forbidden), false, `the page names ${forbidden}`);
  }
  assert.doesNotMatch(page, /confirmationEmail(State|HoldReason|Attempts|AttemptId|DispatchDeadlineAt|FirstDispatchIntentAt|ProviderMessageId|AcceptedAt|Envelope|IdempotencyKey|From|SentAt)\b/,
    'the page reads the record fields directly');
  assert.doesNotMatch(page, /emailResendClaim/);

  // Only projection members are read off the view.
  const members = new Set([...page.matchAll(/\bemailRecon\.([A-Za-z]+)/g)].map((match) => match[1]));
  assert.ok(members.size > 0);
  for (const member of members) {
    assert.ok((CONFIRMATION_EMAIL_OPERATOR_PROJECTION_KEYS as readonly string[]).includes(member), `emailRecon.${member}`);
  }
  assert.match(page, /const confirmationDoorAction = `\/api\/admin\/orders\/\$\{order\.id\}\/confirmation-email`;/);
  assert.equal((page.match(/<form method="post" action=\{confirmationDoorAction\}/g) ?? []).length, 3, 'three native door forms');
  assert.equal((page.match(/<form\b/g) ?? []).length, 3, 'no other form on the page');
  assert.ok(page.includes('Records that you already sent it yourself. This sends nothing.'));
  assert.ok(page.includes('may already have been accepted'));
  // The result code goes through the closed lookup and nowhere else.
  assert.match(page, /describeConfirmationEmailOperatorResult\(/);
  const searchUses = [...page.matchAll(/\bconfirmationResultCode\b/g)].length;
  assert.equal(searchUses, 2, 'the raw code is read once and passed only to the lookup');
});

test('OP-23: no reconciliation path reaches a provider — source and file-end spies', () => {
  const source = readRepo('src/lib/confirmation-email-reconciliation.ts');
  for (const forbidden of ['dispatchFrozenConfirmation', 'resolveFrozenDispatcher', 'order-email', "'resend'", 'sendOrderConfirmationEmail',
    'idempotencyKey', 'buildConfirmationEmailEnvelope', 'newClaimId', 'randomUUID']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  // The operator commit uses the modelled operator events, the reaper T9 only.
  assert.match(source, /actor: 'operator'/);
  assert.equal(FETCH_CALLS, 0, 'an operator path reached fetch');
  globalThis.fetch = ORIGINAL_FETCH;
});
