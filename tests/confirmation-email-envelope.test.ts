/*
 * L-4 Slice A1 — the immutable confirmation-email envelope.
 *
 * The duplicate-confirmation failure this exists to close is a body that is
 * rebuilt at send time: `buildOrderConfirmationEmail` reads the support
 * address, the site URL and the sender from the environment on every call, so
 * two presentations of the same idempotency key can carry different bytes and
 * Resend then refuses the second with `invalid_idempotent_request` — or, worse,
 * accepts it as a new message. The envelope is the fix: the exact provider
 * request is frozen once, read back verbatim, and never recomputed.
 *
 * Everything here is pure. No provider, no credential, no store, no network.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CONFIRMATION_ENVELOPE_LIMITS,
  CONFIRMATION_ENVELOPE_VERSION,
  buildConfirmationEmailEnvelope,
  canonicalizeConfirmationRequest,
  checkConfirmationEnvelopeLimits,
  digestConfirmationRequest,
  isConfirmationEmailEnvelopeTombstone,
  projectConfirmationEmailEnvelopeForOperator,
  purgeConfirmationEmailEnvelope,
  type ConfirmationEmailEnvelopeV1,
  type ConfirmationEmailRequestV1,
} from '../src/lib/confirmation-email-envelope.ts';

const ENVELOPE_SOURCE = readFileSync(
  new URL('../src/lib/confirmation-email-envelope.ts', import.meta.url),
  'utf8',
);

const BUYER_EMAIL = 'buyer@example.com';
const CHILD_NAME = 'Luna';
const SUPPORT_EMAIL = 'support@example.com';
const SENDER = 'Hero Storybooks <orders@example.com>';
const ORDER_ID = 'ord_envelope';
const TEMPLATE_VERSION = 'order-confirmation@2efc3557';
const CREATED_AT = '2026-09-23T15:00:00.000Z';
const IDEMPOTENCY_KEY = `order-confirmation-${ORDER_ID}-primary-v1`;
const ACCOUNT_LABEL = 'hsb-resend-prod-v1';

function makeRequest(overrides: Partial<ConfirmationEmailRequestV1> = {}): ConfirmationEmailRequestV1 {
  return {
    from: SENDER,
    to: [BUYER_EMAIL],
    subject: `${CHILD_NAME}'s storybook order is confirmed`,
    html: `<p>Thanks! ${CHILD_NAME}'s book is on the way.</p>`,
    text: `Thanks! ${CHILD_NAME}'s book is on the way.`,
    replyTo: SUPPORT_EMAIL,
    ...overrides,
  };
}

function buildOk(
  overrides: {
    request?: ConfirmationEmailRequestV1;
    orderId?: string;
    templateVersion?: string;
    createdAt?: string;
    idempotencyKey?: string;
    accountLabel?: string;
  } = {},
): ConfirmationEmailEnvelopeV1 {
  const result = buildConfirmationEmailEnvelope({
    orderId: overrides.orderId ?? ORDER_ID,
    templateVersion: overrides.templateVersion ?? TEMPLATE_VERSION,
    createdAt: overrides.createdAt ?? CREATED_AT,
    idempotencyKey: overrides.idempotencyKey ?? IDEMPOTENCY_KEY,
    providerBinding: { accountLabel: overrides.accountLabel ?? ACCOUNT_LABEL },
    request: overrides.request ?? makeRequest(),
  });
  assert.equal(result.ok, true, `expected a buildable envelope, got ${JSON.stringify(result)}`);
  if (result.ok !== true) throw new Error('unreachable');
  return result.envelope;
}

function padTo(bytes: number, seed = 'x'): string {
  return seed.repeat(bytes);
}

// ── A1 — canonicalization is deterministic ──────────────────────────────────

test('A1: canonicalization is byte-stable across calls and across source key order', () => {
  const request = makeRequest();
  assert.equal(canonicalizeConfirmationRequest(request), canonicalizeConfirmationRequest(request));

  // Same six values, declared in a different order in the source object. The
  // canonical form must not inherit the caller's insertion order.
  const reordered = {
    replyTo: request.replyTo,
    text: request.text,
    html: request.html,
    subject: request.subject,
    to: [...request.to] as unknown as readonly [string],
    from: request.from,
  } satisfies ConfirmationEmailRequestV1;

  assert.equal(
    canonicalizeConfirmationRequest(reordered),
    canonicalizeConfirmationRequest(request),
    'the digest must describe the values, never the literal that carried them',
  );
});

test('A1: the canonical form is exactly the six transmitted fields, in the fixed order', () => {
  const request = makeRequest();
  assert.equal(
    canonicalizeConfirmationRequest(request),
    JSON.stringify({
      from: request.from,
      to: [...request.to],
      subject: request.subject,
      html: request.html,
      text: request.text,
      replyTo: request.replyTo,
    }),
  );
});

// ── A2 — the digest tracks every field and nothing else ─────────────────────

test('A2: changing any one of the six fields changes the digest; changing none leaves it', () => {
  const base = makeRequest();
  const baseDigest = digestConfirmationRequest(base);
  assert.equal(digestConfirmationRequest(makeRequest()), baseDigest);

  const mutations: ConfirmationEmailRequestV1[] = [
    makeRequest({ from: 'Hero Storybooks <other@example.com>' }),
    makeRequest({ to: ['someone-else@example.com'] }),
    makeRequest({ subject: `${base.subject}!` }),
    makeRequest({ html: `${base.html}<p>#194 revision policy</p>` }),
    makeRequest({ text: `${base.text}\nRevisions: two rounds.` }),
    makeRequest({ replyTo: 'help@example.com' }),
  ];
  const digests = mutations.map(digestConfirmationRequest);
  for (const [index, digest] of digests.entries()) {
    assert.notEqual(digest, baseDigest, `mutation ${index} must move the digest`);
  }
  assert.equal(new Set([baseDigest, ...digests]).size, 7, 'each mutation is distinguishable');
});

test('A2: the digest is sha256 over the canonical UTF-8 bytes', () => {
  const request = makeRequest();
  assert.equal(
    digestConfirmationRequest(request),
    createHash('sha256').update(Buffer.from(canonicalizeConfirmationRequest(request), 'utf8')).digest('hex'),
  );
});

// ── A3 — stored bytes are transmitted bytes ─────────────────────────────────

test('A3: no NFC, no trim, no minification — the stored bytes survive verbatim', () => {
  // "Café" as NFD (combining acute), plus trailing whitespace, plus HTML that a
  // minifier would collapse. Every one of these is a byte the provider sees.
  const awkward = makeRequest({
    subject: 'Café order confirmed   ',
    html: '<p>   spaced   </p>\n\n<p>Café</p>',
    text: 'Café\t trailing \t',
  });
  const canonical = canonicalizeConfirmationRequest(awkward);
  const parsed = JSON.parse(canonical) as Record<string, string>;

  assert.equal(parsed.subject, awkward.subject, 'subject must not be trimmed or normalized');
  assert.equal(parsed.html, awkward.html, 'html must not be rebuilt');
  assert.equal(parsed.text, awkward.text, 'text must not be trimmed');

  const normalized = makeRequest({
    subject: 'Café order confirmed   '.normalize('NFC').trim(),
    html: awkward.html,
    text: awkward.text,
  });
  assert.notEqual(
    digestConfirmationRequest(awkward),
    digestConfirmationRequest(normalized),
    'a normalizing implementation would describe bytes the provider never sees',
  );

  const envelope = buildOk({ request: awkward });
  assert.equal(envelope.request?.subject, awkward.subject);
  assert.equal(envelope.canonicalBytes, Buffer.byteLength(canonical, 'utf8'));
});

// ── A4 — exactly one recipient ──────────────────────────────────────────────

test('A4: a recipient count other than exactly one refuses to snapshot', () => {
  for (const to of [[] as unknown as readonly [string], [BUYER_EMAIL, 'second@example.com'] as unknown as readonly [string]]) {
    const refusal = checkConfirmationEnvelopeLimits(makeRequest({ to }));
    assert.equal(refusal, 'recipient_count', `to.length=${to.length} must refuse`);
    const built = buildConfirmationEmailEnvelope({
      orderId: ORDER_ID,
      templateVersion: TEMPLATE_VERSION,
      createdAt: CREATED_AT,
      idempotencyKey: IDEMPOTENCY_KEY,
      providerBinding: { accountLabel: ACCOUNT_LABEL },
      request: makeRequest({ to }),
    });
    assert.equal(built.ok, false);
    if (built.ok === false) assert.equal(built.refusal, 'recipient_count');
  }
  assert.equal(checkConfirmationEnvelopeLimits(makeRequest()), null);
});

// ── A5 — every byte limit fails closed at limit + 1 ─────────────────────────

test('A5: each byte limit admits at the limit and refuses at limit + 1', () => {
  const cases: ReadonlyArray<{
    field: keyof ConfirmationEmailRequestV1;
    limit: number;
    refusal: string;
    make: (bytes: number) => ConfirmationEmailRequestV1;
  }> = [
    {
      field: 'from',
      limit: CONFIRMATION_ENVELOPE_LIMITS.fromBytes,
      refusal: 'from_too_long',
      make: (bytes) => makeRequest({ from: padTo(bytes) }),
    },
    {
      field: 'to',
      limit: CONFIRMATION_ENVELOPE_LIMITS.toBytes,
      refusal: 'to_too_long',
      make: (bytes) => makeRequest({ to: [padTo(bytes)] }),
    },
    {
      field: 'replyTo',
      limit: CONFIRMATION_ENVELOPE_LIMITS.replyToBytes,
      refusal: 'reply_to_too_long',
      make: (bytes) => makeRequest({ replyTo: padTo(bytes) }),
    },
    {
      field: 'subject',
      limit: CONFIRMATION_ENVELOPE_LIMITS.subjectBytes,
      refusal: 'subject_too_long',
      make: (bytes) => makeRequest({ subject: padTo(bytes) }),
    },
    {
      field: 'html',
      limit: CONFIRMATION_ENVELOPE_LIMITS.htmlBytes,
      refusal: 'html_too_long',
      make: (bytes) => makeRequest({ html: padTo(bytes), text: 'short' }),
    },
    {
      field: 'text',
      limit: CONFIRMATION_ENVELOPE_LIMITS.textBytes,
      refusal: 'text_too_long',
      make: (bytes) => makeRequest({ html: 'short', text: padTo(bytes) }),
    },
  ];

  for (const { field, limit, refusal, make } of cases) {
    assert.equal(checkConfirmationEnvelopeLimits(make(limit)), null, `${field} must admit at ${limit}`);
    assert.equal(
      checkConfirmationEnvelopeLimits(make(limit + 1)),
      refusal,
      `${field} must refuse at ${limit + 1}`,
    );
  }
});

test('A5: a multi-byte character is measured in bytes, not code units', () => {
  // U+00E9 is two UTF-8 bytes. 160 of them is exactly the 320-byte path limit.
  const limit = CONFIRMATION_ENVELOPE_LIMITS.fromBytes;
  assert.equal(checkConfirmationEnvelopeLimits(makeRequest({ from: 'é'.repeat(limit / 2) })), null);
  assert.equal(
    checkConfirmationEnvelopeLimits(makeRequest({ from: 'é'.repeat(limit / 2) + 'x' })),
    'from_too_long',
  );
});

test('A5: the canonical total refuses even when every field is individually legal', () => {
  const atFieldLimits = makeRequest({
    html: padTo(CONFIRMATION_ENVELOPE_LIMITS.htmlBytes),
    text: padTo(CONFIRMATION_ENVELOPE_LIMITS.textBytes),
  });
  assert.ok(
    Buffer.byteLength(canonicalizeConfirmationRequest(atFieldLimits), 'utf8')
      > CONFIRMATION_ENVELOPE_LIMITS.canonicalBytes,
    'the fixture must actually exceed the total cap',
  );
  assert.equal(checkConfirmationEnvelopeLimits(atFieldLimits), 'canonical_too_large');
});

// ── A6 / I-9 — the key is copied, never derived ─────────────────────────────

test('A6: two envelopes with different bodies on one order carry the same key', () => {
  const first = buildOk({ request: makeRequest({ html: '<p>v1</p>' }) });
  const second = buildOk({ request: makeRequest({ html: '<p>v2 with the #194 paragraph</p>' }) });

  assert.notEqual(first.canonicalDigest, second.canonicalDigest, 'the bodies differ');
  assert.equal(first.idempotencyKey, IDEMPOTENCY_KEY);
  assert.equal(second.idempotencyKey, IDEMPOTENCY_KEY, 'the key is order identity, not body identity');
});

test('A6: a missing frozen identity refuses to snapshot rather than inventing one', () => {
  for (const [idempotencyKey, refusal] of [['', 'missing_idempotency_key'], ['   ', 'missing_idempotency_key']] as const) {
    const built = buildConfirmationEmailEnvelope({
      orderId: ORDER_ID,
      templateVersion: TEMPLATE_VERSION,
      createdAt: CREATED_AT,
      idempotencyKey,
      providerBinding: { accountLabel: ACCOUNT_LABEL },
      request: makeRequest(),
    });
    assert.equal(built.ok, false);
    if (built.ok === false) assert.equal(built.refusal, refusal);
  }
});

test('A7: no expression in the module derives the key from the digest, template, or attempt', () => {
  assert.doesNotMatch(
    ENVELOPE_SOURCE,
    /idempotencyKey\s*[:=][^,;\n]*(canonicalDigest|digest|templateVersion|attemptId|canonical\()/,
    'the idempotency key must be copied from the frozen record identity and nothing else',
  );
  assert.doesNotMatch(
    ENVELOPE_SOURCE,
    /attemptId/,
    'an attempt identity has no place in a snapshot that outlives every attempt',
  );
  assert.match(
    ENVELOPE_SOURCE,
    /idempotencyKey:\s*input\.idempotencyKey/,
    'the only legal assignment is a verbatim copy of the caller-supplied key',
  );
});

// ── Controller corrections R1/R2 — no secret ever reaches the envelope ──────

test('the provider binding is explicit non-secret data: no key, no env, no fingerprint', () => {
  assert.doesNotMatch(ENVELOPE_SOURCE, /process\.env/, 'the envelope may not read the environment');
  assert.doesNotMatch(ENVELOPE_SOURCE, /apiKey|API_KEY|RESEND/i, 'the envelope may not touch a credential');
  assert.doesNotMatch(ENVELOPE_SOURCE, /accountFingerprint|fingerprint/i, 'no key digest is stored');

  const envelope = buildOk();
  assert.deepEqual(
    Object.keys(envelope.providerBinding).sort(),
    ['accountLabel'],
    'the binding is a versioned operator label and nothing else',
  );
  assert.equal(envelope.providerBinding.accountLabel, ACCOUNT_LABEL);
});

test('an absent account label refuses to snapshot: a missing binding fails closed', () => {
  const built = buildConfirmationEmailEnvelope({
    orderId: ORDER_ID,
    templateVersion: TEMPLATE_VERSION,
    createdAt: CREATED_AT,
    idempotencyKey: IDEMPOTENCY_KEY,
    providerBinding: { accountLabel: '  ' },
    request: makeRequest(),
  });
  assert.equal(built.ok, false);
  if (built.ok === false) assert.equal(built.refusal, 'missing_account_label');
});

test('the module has no log sink, no provider call, and no persistence', () => {
  assert.doesNotMatch(ENVELOPE_SOURCE, /console\.|fetch\(|resend|blob|put\(|await /i);
  assert.doesNotMatch(ENVELOPE_SOURCE, /^import .* from '\.\//m, 'a pure module imports no sibling');
});

// ── Identity fields are validated ───────────────────────────────────────────

test('the envelope refuses a non-canonical createdAt rather than reformatting it', () => {
  for (const createdAt of ['2026-09-23T15:00:00Z', 'not-a-date', '']) {
    const built = buildConfirmationEmailEnvelope({
      orderId: ORDER_ID,
      templateVersion: TEMPLATE_VERSION,
      createdAt,
      idempotencyKey: IDEMPOTENCY_KEY,
      providerBinding: { accountLabel: ACCOUNT_LABEL },
      request: makeRequest(),
    });
    assert.equal(built.ok, false, `createdAt=${JSON.stringify(createdAt)} must refuse`);
    if (built.ok === false) assert.equal(built.refusal, 'invalid_created_at');
  }
});

test('an empty order id or template version refuses to snapshot', () => {
  const missingOrder = buildConfirmationEmailEnvelope({
    orderId: '',
    templateVersion: TEMPLATE_VERSION,
    createdAt: CREATED_AT,
    idempotencyKey: IDEMPOTENCY_KEY,
    providerBinding: { accountLabel: ACCOUNT_LABEL },
    request: makeRequest(),
  });
  assert.equal(missingOrder.ok, false);
  if (missingOrder.ok === false) assert.equal(missingOrder.refusal, 'missing_order_id');

  const missingTemplate = buildConfirmationEmailEnvelope({
    orderId: ORDER_ID,
    templateVersion: '',
    createdAt: CREATED_AT,
    idempotencyKey: IDEMPOTENCY_KEY,
    providerBinding: { accountLabel: ACCOUNT_LABEL },
    request: makeRequest(),
  });
  assert.equal(missingTemplate.ok, false);
  if (missingTemplate.ok === false) assert.equal(missingTemplate.refusal, 'missing_template_version');
});

test('a freshly built envelope is a live payload at the current version, not a tombstone', () => {
  const envelope = buildOk();
  assert.equal(envelope.envelopeVersion, CONFIRMATION_ENVELOPE_VERSION);
  assert.equal(envelope.purgedAt, null);
  assert.equal(isConfirmationEmailEnvelopeTombstone(envelope), false);
  assert.deepEqual(envelope.request, makeRequest());
  assert.equal(envelope.canonicalDigest, digestConfirmationRequest(makeRequest()));
});

// ── A8 — the tombstone keeps every identity the payload had ─────────────────

test('A8: purge nulls the request and preserves every identity and integrity field', () => {
  const live = buildOk();
  const purgedAt = '2026-10-23T15:00:00.000Z';
  const tombstone = purgeConfirmationEmailEnvelope(live, purgedAt);

  assert.equal(tombstone.request, null);
  assert.equal(tombstone.purgedAt, purgedAt);
  assert.equal(isConfirmationEmailEnvelopeTombstone(tombstone), true);

  assert.equal(tombstone.envelopeVersion, live.envelopeVersion);
  assert.equal(tombstone.orderId, live.orderId);
  assert.equal(tombstone.templateVersion, live.templateVersion);
  assert.equal(tombstone.createdAt, live.createdAt);
  assert.equal(tombstone.idempotencyKey, live.idempotencyKey);
  assert.equal(tombstone.canonicalDigest, live.canonicalDigest);
  assert.equal(tombstone.canonicalBytes, live.canonicalBytes);
  assert.deepEqual(tombstone.providerBinding, live.providerBinding);

  // The live envelope is untouched: purge returns a new value.
  assert.deepEqual(live.request, makeRequest());
  assert.equal(live.purgedAt, null);
});

test('A8: purging a tombstone keeps the first purge instant — the payload is already gone', () => {
  const first = purgeConfirmationEmailEnvelope(buildOk(), '2026-10-23T15:00:00.000Z');
  const second = purgeConfirmationEmailEnvelope(first, '2026-11-23T15:00:00.000Z');
  assert.equal(second.purgedAt, '2026-10-23T15:00:00.000Z');
  assert.equal(second.request, null);
});

test('A8: no serialization of a tombstone can reconstruct the payload', () => {
  const tombstone = purgeConfirmationEmailEnvelope(buildOk(), '2026-10-23T15:00:00.000Z');
  const serialized = JSON.stringify(tombstone);
  for (const secret of [BUYER_EMAIL, CHILD_NAME, SUPPORT_EMAIL, SENDER]) {
    assert.ok(!serialized.includes(secret), `a purged envelope still exposed ${secret}`);
  }
});

// ── A9 — the operator projection carries no request bytes ───────────────────

test('A9: the operator projection contains no recipient, child name, or body', () => {
  const projection = projectConfirmationEmailEnvelopeForOperator(buildOk());
  const serialized = JSON.stringify(projection);

  for (const secret of [BUYER_EMAIL, CHILD_NAME, SUPPORT_EMAIL, SENDER]) {
    assert.ok(!serialized.includes(secret), `the operator projection leaked ${secret}`);
  }
  assert.ok(!serialized.includes('<p>'), 'no rendered body may reach an operator surface');
});

test('A9: the projection is an exact allow-list, so a new payload field cannot leak by default', () => {
  const projection = projectConfirmationEmailEnvelopeForOperator(buildOk());
  assert.deepEqual(
    Object.keys(projection).sort(),
    ['accountLabel', 'canonicalBytes', 'canonicalDigest', 'createdAt', 'envelopeVersion', 'orderId', 'purgedAt', 'templateVersion'],
  );
  assert.equal(projection.canonicalDigest, buildOk().canonicalDigest);
  assert.equal(projection.accountLabel, ACCOUNT_LABEL);
});

test('A9: the projection of a tombstone is the same shape, with the purge instant', () => {
  const projection = projectConfirmationEmailEnvelopeForOperator(
    purgeConfirmationEmailEnvelope(buildOk(), '2026-10-23T15:00:00.000Z'),
  );
  assert.equal(projection.purgedAt, '2026-10-23T15:00:00.000Z');
  assert.equal(projection.canonicalDigest, buildOk().canonicalDigest, 'integrity metadata survives');
});
