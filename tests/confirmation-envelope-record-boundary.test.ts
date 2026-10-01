/*
 * L-4 Slice A3-3 — the record boundary.
 *
 * Three properties, and the asymmetry between the first two is the whole design:
 *
 *   WRITE REFUSES. Every public-store order write refuses a record that carries
 *   the retired inline `confirmationEmailEnvelope` at all, or a structurally
 *   invalid `confirmationEmailEnvelopeRef`. It throws; it never strips and
 *   continues. A write that repaired itself would report an order persisted
 *   while the frozen request a later dispatch depends on had silently vanished.
 *
 *   READ REPAIRS. The authoritative read path deletes a stray inline envelope,
 *   so a legacy or hand-edited record cannot bring request bytes back into
 *   memory and from there into a DTO, a log line or a response body.
 *
 *   THE OPERATOR VIEW IS POSITIVE. A valid ref projects exactly eight
 *   non-request fields. Anything else — absent, malformed, extra-keyed,
 *   foreign-order, tombstoned — omits the property entirely rather than falling
 *   back to the stored object.
 *
 * `persistOrder`, `persistNewOrder` and `commitOrderConditional` are each
 * exercised separately and against their own write seam, because they are three
 * entry points into the store and a guard on one proves nothing about the other
 * two. The serialized body that reached the store is asserted directly, not the
 * input object: an input that looks clean and a body that carries request bytes
 * is exactly the failure this slice exists to prevent.
 *
 * Every fixture is synthetic. Nothing here reaches a provider, a real store, a
 * credential, or customer data.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONFIRMATION_ENVELOPE_LIMITS,
  type ConfirmationEmailEnvelopeV1,
} from '../src/lib/confirmation-email-envelope.ts';
import {
  CONFIRMATION_ENVELOPE_ORDER_ID_RE,
  CONFIRMATION_ENVELOPE_PATH_PREFIX,
  confirmationEnvelopeObjectPath,
} from '../src/lib/confirmation-envelope-config.ts';
import {
  CONFIRMATION_ENVELOPE_OPERATOR_VIEW_KEYS,
  CONFIRMATION_ENVELOPE_REF_KEYS,
  CONFIRMATION_ENVELOPE_REF_MAX_CANONICAL_BYTES,
  CONFIRMATION_ENVELOPE_REF_ORDER_ID_RE,
  CONFIRMATION_ENVELOPE_REF_PATH_PREFIX,
  CONFIRMATION_ENVELOPE_REF_STORAGE_KIND,
  expectedConfirmationEnvelopeObjectPath,
  isConfirmationEmailEnvelopeRef,
  materializeConfirmationEmailEnvelopeRef,
  projectConfirmationEmailEnvelopeRefIfValid,
  validateConfirmationEmailEnvelopeRef,
  validateConfirmationEmailEnvelopeRefShape,
  type ConfirmationEmailEnvelopeRefV1,
} from '../src/lib/confirmation-envelope-ref.ts';
import {
  toAdminOrderDetail,
  toAdminOrderListItem,
  ADMIN_ORDER_DETAIL_KEYS,
  ADMIN_ORDER_LIST_ITEM_KEYS,
} from '../src/lib/admin-order-dto.ts';
import {
  OrderPersistenceError,
  __resetOrderStoreAdapterFactoryForTests,
  __setOrderStoreAdapterFactoryForTests,
  assertNoConfirmationRequestBytes,
  checkoutIntakeOrderContractDigest,
  commitOrderConditional,
  createOrderRecord,
  getOrderAuthoritative,
  persistNewOrder,
  persistOrder,
  readOrderVersioned,
  type OrderRecord,
  type OrderStoreAdapter,
} from '../src/lib/orders.ts';
// NBT (AM-NB1…AM-NB3): the bound substrate, imported as a namespace object so
// a tree without it fails only the NBT siblings, never the A3-3 tests here.
import * as boundOrders from '../src/lib/orders.ts';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ORDERS_SOURCE = readFileSync(path.join(REPO_ROOT, 'src/lib/orders.ts'), 'utf8');

/**
 * Grammar-valid 16-hex order ids, ASSEMBLED rather than written as literals.
 *
 * The ref grammar requires a real `ord_[a-f0-9]{16}`, and REQ16
 * (`tests/review-snapshot-and-guards.test.ts`) refuses any committable line
 * matching that shape so a production identifier cannot be pasted into the
 * repository. Assembling them satisfies both, exactly as the accepted A3-2
 * suites do.
 */
const ORDER_ID = `ord_${'a33b'.repeat(4)}`;
const OTHER_ORDER_ID = `ord_${'c17e'.repeat(4)}`;

const CREATED_AT = '2026-09-26T12:00:00.000Z';
const DIGEST = 'a'.repeat(64);

/**
 * Distinct markers, so a leak names the exact field it came from.
 *
 * The six request fields are the canaries. `sender` is seeded differently from
 * `requestFrom` deliberately: the architecture requires that the business
 * sender's presence on an operator surface can never mask a request-byte leak.
 */
const CANARY = {
  requestFrom: 'CANARY-A33-FROM-41d2 <no-reply@example.invalid>',
  requestTo: 'CANARY-A33-TO-9e07@example.invalid',
  requestSubject: 'CANARY-A33-SUBJ-c318',
  requestHtml: '<p>CANARY-A33-HTML-7b6a</p>',
  requestText: 'CANARY-A33-TEXT-20fe',
  requestReplyTo: 'CANARY-A33-REPLY-55cd@example.invalid',
  idempotencyKey: 'CANARY-A33-IDEM-8f41',
  sender: 'CANARY-A33-SENDER-1a90 <no-reply@example.invalid>',
  objectUrl: 'https://CANARY-A33-URL-6d2b.example.invalid/envelope.json',
  token: 'CANARY-A33-TOKEN-b0e5',
} as const;

/** The six request fields, by value — what must never reach the public store. */
const REQUEST_CANARIES: readonly string[] = [
  CANARY.requestFrom,
  CANARY.requestTo,
  CANARY.requestSubject,
  CANARY.requestHtml,
  CANARY.requestText,
  CANARY.requestReplyTo,
];

function inlineEnvelope(orderId = ORDER_ID): ConfirmationEmailEnvelopeV1 {
  return {
    envelopeVersion: 1,
    orderId,
    templateVersion: 'order-confirmation@a33test',
    createdAt: CREATED_AT,
    idempotencyKey: CANARY.idempotencyKey,
    providerBinding: { accountLabel: 'hsb-test-prod-v1' },
    request: {
      from: CANARY.requestFrom,
      to: [CANARY.requestTo],
      subject: CANARY.requestSubject,
      html: CANARY.requestHtml,
      text: CANARY.requestText,
      replyTo: CANARY.requestReplyTo,
    },
    canonicalDigest: DIGEST,
    canonicalBytes: 1234,
    purgedAt: null,
  };
}

function validRef(
  orderId = ORDER_ID,
  overrides: Partial<Record<keyof ConfirmationEmailEnvelopeRefV1, unknown>> = {},
  namespace = '',
): ConfirmationEmailEnvelopeRefV1 {
  return {
    envelopeVersion: 1,
    orderId,
    templateVersion: 'order-confirmation@a33test',
    createdAt: CREATED_AT,
    canonicalDigest: DIGEST,
    canonicalBytes: 1234,
    accountLabel: 'hsb-test-prod-v1',
    storageKind: 'private_blob',
    objectPath: expectedConfirmationEnvelopeObjectPath(orderId, namespace)!,
    purgedAt: null,
    ...overrides,
  } as ConfirmationEmailEnvelopeRefV1;
}

function baseOrder(id = ORDER_ID, overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Luna', bookFormat: 'digital', email: 'buyer@example.invalid' },
      { id, now: '2026-09-26T10:00:00.000Z' },
    ),
    paymentStatus: 'paid' as const,
    paidAt: '2026-09-26T10:05:00.000Z',
    ...overrides,
  } as OrderRecord;
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

/**
 * A real on-disk order store.
 *
 * `persistOrder` does NOT go through `OrderStoreAdapter` — it writes through
 * `@vercel/blob` or, with no token, straight to the filesystem. So the only
 * honest "did a write happen" seam for that path is the store directory itself,
 * which has the additional virtue of letting the SERIALIZED BODY be asserted.
 */
function localStore<T>(
  fn: (dir: string) => Promise<T> | T,
  extraEnv: Record<string, string | undefined> = {},
): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-a33-record-boundary-'));
  return withEnv(
    {
      HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
      BLOB_READ_WRITE_TOKEN: undefined,
      HSB_ORDER_STORE_DIR: dir,
      HSB_BLOB_NAMESPACE: undefined,
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      NODE_ENV: 'development',
      ...extraEnv,
    },
    () => fn(dir),
  ).finally(() => {
    __resetOrderStoreAdapterFactoryForTests();
    rmSync(dir, { recursive: true, force: true });
  });
}

/** Every record file currently in the store directory. */
function storedFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

interface RecordingAdapter extends OrderStoreAdapter {
  readonly calls: string[];
}

/**
 * An adapter that records every call and writes nothing.
 *
 * Used for `persistNewOrder` and `commitOrderConditional`, whose store access
 * goes through the adapter seam. A refused write must leave `calls` empty: it is
 * not enough that no bytes changed, the store must never have been asked.
 */
function recordingAdapter(): RecordingAdapter {
  const calls: string[] = [];
  return {
    kind: 'recording',
    calls,
    async readVersioned(pathname) {
      calls.push(`readVersioned:${pathname}`);
      return null;
    },
    async createIfAbsent(pathname, body) {
      calls.push(`createIfAbsent:${pathname}:${body.length}`);
      return { ok: true, version: 'v-recorded' };
    },
    async replaceIfVersion(pathname, body, expectedVersion) {
      calls.push(`replaceIfVersion:${pathname}:${expectedVersion}:${body.length}`);
      return { ok: true, version: 'v-recorded' };
    },
  };
}

function assertNoRequestCanaries(serialized: string, where: string): void {
  for (const canary of REQUEST_CANARIES) {
    assert.equal(serialized.includes(canary), false, `${where} carries a request canary`);
  }
  for (const forbidden of [CANARY.idempotencyKey, CANARY.objectUrl, CANARY.token]) {
    assert.equal(serialized.includes(forbidden), false, `${where} carries ${forbidden}`);
  }
}

async function rejectsWith(fn: () => Promise<unknown>, reason: string): Promise<OrderPersistenceError> {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof OrderPersistenceError, `expected OrderPersistenceError for ${reason}`);
  const error = thrown as OrderPersistenceError;
  assert.match(error.message, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // A refusal message is handed to a log sink. It must name a code, not content.
  assertNoRequestCanaries(error.message, `the refusal message for ${reason}`);
  assertNoRequestCanaries(String(error.stack ?? ''), `the refusal stack for ${reason}`);
  return error;
}

// ── B0 — the restated constants do not drift from the storage boundary ──────

test('B0: the ref module mirrors the storage config exactly', () => {
  assert.equal(CONFIRMATION_ENVELOPE_REF_PATH_PREFIX, CONFIRMATION_ENVELOPE_PATH_PREFIX);
  assert.equal(
    CONFIRMATION_ENVELOPE_REF_ORDER_ID_RE.source,
    CONFIRMATION_ENVELOPE_ORDER_ID_RE.source,
  );
  assert.equal(
    CONFIRMATION_ENVELOPE_REF_MAX_CANONICAL_BYTES,
    CONFIRMATION_ENVELOPE_LIMITS.canonicalBytes,
  );
});

test('B0: the expected object path agrees with the storage path builder', () => {
  for (const namespace of ['', 'preview', 'development', 'ns-1_2']) {
    assert.equal(
      expectedConfirmationEnvelopeObjectPath(ORDER_ID, namespace),
      confirmationEnvelopeObjectPath(ORDER_ID, namespace),
      `namespace ${JSON.stringify(namespace)} must produce the same key in both modules`,
    );
  }
  // And both refuse an id outside the grammar rather than building a key from it.
  assert.equal(expectedConfirmationEnvelopeObjectPath('ord_nope', ''), null);
  assert.equal(confirmationEnvelopeObjectPath('ord_nope', ''), null);
  assert.equal(expectedConfirmationEnvelopeObjectPath(`${ORDER_ID}/../x`, ''), null);
});

test('B0: the ref key set and the operator view key set are exactly as declared', () => {
  assert.deepEqual([...CONFIRMATION_ENVELOPE_REF_KEYS], [
    'envelopeVersion', 'orderId', 'templateVersion', 'createdAt', 'canonicalDigest',
    'canonicalBytes', 'accountLabel', 'storageKind', 'objectPath', 'purgedAt',
  ]);
  assert.deepEqual(Object.keys(validRef()).sort(), [...CONFIRMATION_ENVELOPE_REF_KEYS].sort());
  // The view is the ref minus the two storage locators, and nothing else.
  assert.deepEqual(
    [...CONFIRMATION_ENVELOPE_REF_KEYS].filter((k) => k !== 'storageKind' && k !== 'objectPath').sort(),
    [...CONFIRMATION_ENVELOPE_OPERATOR_VIEW_KEYS].sort(),
  );
  assert.equal(CONFIRMATION_ENVELOPE_REF_STORAGE_KIND, 'private_blob');
});

// ── B1 — the validator refuses everything that is not a ref ────────────────

test('B1: a valid ref validates, in both the shape and the namespace-exact form', () => {
  assert.equal(validateConfirmationEmailEnvelopeRefShape(validRef(), { orderId: ORDER_ID }), null);
  assert.equal(
    validateConfirmationEmailEnvelopeRef(validRef(), { orderId: ORDER_ID, namespace: '' }),
    null,
  );
  assert.equal(isConfirmationEmailEnvelopeRef(validRef(), { orderId: ORDER_ID }), true);
});

test('B1: an unexpected key is refused, and a request-like key is named as such', () => {
  // Extra keys, by count and by identity.
  assert.equal(
    validateConfirmationEmailEnvelopeRefShape({ ...validRef(), extra: 1 }, { orderId: ORDER_ID }),
    'ref_key_set',
  );
  const { purgedAt: _dropped, ...missing } = validRef();
  assert.equal(validateConfirmationEmailEnvelopeRefShape(missing, { orderId: ORDER_ID }), 'ref_key_set');
  // A key set of the right SIZE but the wrong membership.
  const swapped = { ...missing, notAKey: null };
  assert.equal(Object.keys(swapped).length, CONFIRMATION_ENVELOPE_REF_KEYS.length);
  assert.equal(validateConfirmationEmailEnvelopeRefShape(swapped, { orderId: ORDER_ID }), 'ref_key_set');

  // Request bytes and identity, each reported as the incident it is.
  for (const key of [
    'request', 'from', 'to', 'subject', 'html', 'text', 'replyTo',
    'idempotencyKey', 'providerBinding', 'url', 'downloadUrl', 'blobUrl',
    'token', 'accessToken', 'body', 'headers', 'email', 'recipient',
  ]) {
    assert.equal(
      validateConfirmationEmailEnvelopeRefShape({ ...validRef(), [key]: 'x' }, { orderId: ORDER_ID }),
      'ref_request_like_field',
      `a ref carrying ${key} must be refused as request-like`,
    );
  }
});

test('B1: every member is validated, and a nested object cannot hide inside one', () => {
  const cases: ReadonlyArray<[string, Partial<Record<string, unknown>>]> = [
    ['ref_not_object', {}], // replaced below
    ['ref_envelope_version', { envelopeVersion: 2 }],
    ['ref_envelope_version', { envelopeVersion: '1' }],
    ['ref_order_id', { orderId: 'ord_short' }],
    ['ref_order_id', { orderId: `${ORDER_ID}/../other` }],
    ['ref_order_id', { orderId: ORDER_ID.toUpperCase() }],
    ['ref_order_id_mismatch', { orderId: OTHER_ORDER_ID, objectPath: expectedConfirmationEnvelopeObjectPath(OTHER_ORDER_ID, '')! }],
    ['ref_template_version', { templateVersion: '' }],
    ['ref_template_version', { templateVersion: 'has\nnewline' }],
    ['ref_template_version', { templateVersion: 'x'.repeat(257) }],
    ['ref_template_version', { templateVersion: { from: CANARY.requestFrom } }],
    ['ref_created_at', { createdAt: '2026-09-26T12:00:00Z' }],   // no milliseconds
    ['ref_created_at', { createdAt: '2026-09-26T12:00:00.000' }], // zone-less
    ['ref_created_at', { createdAt: '2026-09-31T00:00:00.000Z' }], // impossible date
    ['ref_created_at', { createdAt: 17590000000 }],
    ['ref_canonical_digest', { canonicalDigest: 'a'.repeat(63) }],
    ['ref_canonical_digest', { canonicalDigest: 'A'.repeat(64) }], // uppercase hex
    ['ref_canonical_digest', { canonicalDigest: `${'a'.repeat(63)}z` }],
    ['ref_canonical_bytes', { canonicalBytes: 1234.5 }],
    ['ref_canonical_bytes', { canonicalBytes: 0 }],
    ['ref_canonical_bytes', { canonicalBytes: -1 }],
    ['ref_canonical_bytes', { canonicalBytes: '1234' }],
    ['ref_canonical_bytes', { canonicalBytes: Number.NaN }],
    ['ref_canonical_bytes', { canonicalBytes: CONFIRMATION_ENVELOPE_REF_MAX_CANONICAL_BYTES + 1 }],
    ['ref_canonical_bytes', { canonicalBytes: Number.MAX_SAFE_INTEGER + 2 }],
    ['ref_account_label', { accountLabel: '' }],
    ['ref_account_label', { accountLabel: 'lbl‮en' }],
    ['ref_storage_kind', { storageKind: 'public_blob' }],
    ['ref_storage_kind', { storageKind: 'private' }],
    ['ref_purged_at', { purgedAt: undefined }],
    ['ref_purged_at', { purgedAt: '2026-09-26' }],
    ['ref_purged_at', { purgedAt: '' }],
  ];

  for (const [expected, overrides] of cases.slice(1)) {
    assert.equal(
      validateConfirmationEmailEnvelopeRefShape({ ...validRef(), ...overrides }, { orderId: ORDER_ID }),
      expected,
      `${JSON.stringify(overrides)} must be refused as ${expected}`,
    );
  }

  for (const notAnObject of [null, undefined, 0, '', 'ref', true, [validRef()], () => validRef()]) {
    assert.equal(
      validateConfirmationEmailEnvelopeRefShape(notAnObject, { orderId: ORDER_ID }),
      'ref_not_object',
      `${String(notAnObject)} must not read as a ref`,
    );
  }
});

test('B1: the object path must be the exact key for the order, not merely under it', () => {
  const bad = [
    expectedConfirmationEnvelopeObjectPath(OTHER_ORDER_ID, '')!,
    `${CONFIRMATION_ENVELOPE_REF_PATH_PREFIX}/${ORDER_ID}/v1.json.bak`,
    `${CONFIRMATION_ENVELOPE_REF_PATH_PREFIX}/${ORDER_ID}/v2.json`,
    `${CONFIRMATION_ENVELOPE_REF_PATH_PREFIX}/${ORDER_ID}/`,
    `${CONFIRMATION_ENVELOPE_REF_PATH_PREFIX}/${ORDER_ID}`,
    `a/b/${CONFIRMATION_ENVELOPE_REF_PATH_PREFIX}/${ORDER_ID}/v1.json`,
    `../${CONFIRMATION_ENVELOPE_REF_PATH_PREFIX}/${ORDER_ID}/v1.json`,
    `orders/${ORDER_ID}.json`,
    `/${CONFIRMATION_ENVELOPE_REF_PATH_PREFIX}/${ORDER_ID}/v1.json`,
    CANARY.objectUrl,
    '',
  ];
  for (const objectPath of bad) {
    assert.equal(
      validateConfirmationEmailEnvelopeRefShape({ ...validRef(), objectPath }, { orderId: ORDER_ID }),
      'ref_object_path',
      `${JSON.stringify(objectPath)} must be refused`,
    );
  }
  // One valid namespace segment is accepted by the shape form.
  assert.equal(
    validateConfirmationEmailEnvelopeRefShape(
      { ...validRef(), objectPath: expectedConfirmationEnvelopeObjectPath(ORDER_ID, 'preview')! },
      { orderId: ORDER_ID },
    ),
    null,
  );
});

test('B1: the namespace-exact form refuses a ref pointing into another namespace', () => {
  const previewRef = validRef(ORDER_ID, {}, 'preview');
  // Well-shaped, so the shape form accepts it …
  assert.equal(validateConfirmationEmailEnvelopeRefShape(previewRef, { orderId: ORDER_ID }), null);
  // … and the write boundary still refuses it under a different namespace.
  assert.equal(
    validateConfirmationEmailEnvelopeRef(previewRef, { orderId: ORDER_ID, namespace: '' }),
    'ref_object_path',
  );
  assert.equal(
    validateConfirmationEmailEnvelopeRef(previewRef, { orderId: ORDER_ID, namespace: 'development' }),
    'ref_object_path',
  );
  assert.equal(
    validateConfirmationEmailEnvelopeRef(previewRef, { orderId: ORDER_ID, namespace: 'preview' }),
    null,
  );
  // A namespace outside the segment grammar cannot be satisfied at all.
  assert.equal(
    validateConfirmationEmailEnvelopeRef(validRef(), { orderId: ORDER_ID, namespace: 'a/b' }),
    'ref_object_path',
  );
});

test('B1: validation is timezone independent', () => {
  // Asserted in-process; the suite is additionally executed under TZ=UTC and
  // TZ=America/Chicago. A canonical instant is absolute, and every non-canonical
  // form is refused before its value is compared, so nothing is left for the
  // host zone to influence.
  const offsetMinutes = new Date(Date.parse(CREATED_AT)).getTimezoneOffset();
  assert.equal(
    validateConfirmationEmailEnvelopeRefShape(validRef(), { orderId: ORDER_ID }),
    null,
    `a valid ref must validate at UTC offset ${offsetMinutes}`,
  );
  assert.equal(
    validateConfirmationEmailEnvelopeRefShape(
      { ...validRef(), createdAt: '2026-09-26T12:00:00.000' },
      { orderId: ORDER_ID },
    ),
    'ref_created_at',
    `a zone-less instant must be refused at UTC offset ${offsetMinutes}`,
  );
});

// ── B2 — the three write call sites each refuse, and ask the store nothing ──

test('B2: persistOrder refuses an inline envelope and writes no file', async () => {
  await localStore(async (dir) => {
    const order = baseOrder(ORDER_ID, { confirmationEmailEnvelope: inlineEnvelope() });
    await rejectsWith(() => persistOrder(order), 'retired_inline_envelope_present');
    assert.deepEqual(storedFiles(dir), [], 'a refused persistOrder must write nothing');
  });
});

test('B2: persistNewOrder refuses an inline envelope and calls the store zero times', async () => {
  await localStore(async () => {
    const adapter = recordingAdapter();
    __setOrderStoreAdapterFactoryForTests(() => adapter);
    const order = baseOrder(ORDER_ID, { confirmationEmailEnvelope: inlineEnvelope() });
    await rejectsWith(() => persistNewOrder(order), 'retired_inline_envelope_present');
    assert.deepEqual(adapter.calls, [], 'a refused persistNewOrder must not touch the store');
  });
});

test('B2: commitOrderConditional refuses an inline envelope and calls the store zero times', async () => {
  await localStore(async () => {
    const adapter = recordingAdapter();
    __setOrderStoreAdapterFactoryForTests(() => adapter);
    const order = baseOrder(ORDER_ID, { confirmationEmailEnvelope: inlineEnvelope() });
    await rejectsWith(
      () => commitOrderConditional(order, 'v-expected'),
      'retired_inline_envelope_present',
    );
    assert.deepEqual(adapter.calls, [], 'a refused commitOrderConditional must not touch the store');
  });
});

test('B2: presence beats truthiness — undefined and null are still present', async () => {
  for (const present of [undefined, null] as const) {
    await localStore(async (dir) => {
      const order = baseOrder(ORDER_ID) as OrderRecord & Record<string, unknown>;
      // Assigned, not spread from a literal that omits it: the key must exist.
      order.confirmationEmailEnvelope = present;
      assert.equal('confirmationEmailEnvelope' in order, true);
      await rejectsWith(() => persistOrder(order), 'retired_inline_envelope_present');
      assert.deepEqual(storedFiles(dir), [], `present:${String(present)} must write nothing`);
    });
  }
});

test('B2: an invalid ref is refused on all three paths, by its own problem code', async () => {
  const invalid: ReadonlyArray<[string, unknown]> = [
    ['ref_request_like_field', { ...validRef(), from: CANARY.requestFrom }],
    ['ref_key_set', { ...validRef(), extra: 1 }],
    ['ref_canonical_digest', { ...validRef(), canonicalDigest: 'a'.repeat(63) }],
    ['ref_canonical_bytes', { ...validRef(), canonicalBytes: 12.5 }],
    ['ref_storage_kind', { ...validRef(), storageKind: 'public_blob' }],
    ['ref_object_path', { ...validRef(), objectPath: `${CONFIRMATION_ENVELOPE_REF_PATH_PREFIX}/${ORDER_ID}/v1.json.bak` }],
    ['ref_order_id_mismatch', validRef(OTHER_ORDER_ID, {}, '')],
    ['ref_created_at', { ...validRef(), createdAt: '2026-09-26T12:00:00Z' }],
    ['ref_not_object', 'not-a-ref'],
  ];

  for (const [code, ref] of invalid) {
    await localStore(async (dir) => {
      const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: ref } as Partial<OrderRecord>);
      await rejectsWith(() => persistOrder(order), code);
      assert.deepEqual(storedFiles(dir), [], `${code} must write nothing through persistOrder`);

      const adapter = recordingAdapter();
      __setOrderStoreAdapterFactoryForTests(() => adapter);
      await rejectsWith(() => persistNewOrder(order), code);
      await rejectsWith(() => commitOrderConditional(order, 'v-expected'), code);
      assert.deepEqual(adapter.calls, [], `${code} must not reach the store adapter`);
    });
  }
});

test('B2: the boundary is callable on its own and is exported for the record', () => {
  assert.equal(assertNoConfirmationRequestBytes(baseOrder()), undefined);
  assert.throws(
    () => assertNoConfirmationRequestBytes(
      baseOrder(ORDER_ID, { confirmationEmailEnvelope: null }) as OrderRecord,
    ),
    OrderPersistenceError,
  );
  // Each of the three writers calls it by name, so removing one is visible here
  // as well as in the behavioural tests above.
  assert.equal(
    (ORDERS_SOURCE.match(/assertNoConfirmationRequestBytes\(order\)/g) ?? []).length,
    3,
    'all three write paths must call the boundary on the raw record',
  );
  for (const fn of ['persistOrderUnsafe', 'persistNewOrder', 'commitOrderConditional']) {
    const start = ORDERS_SOURCE.indexOf(`function ${fn}(`);
    assert.ok(start > 0, `${fn} must exist`);
    const body = ORDERS_SOURCE.slice(start, start + 2000);
    const guardAt = body.indexOf('assertNoConfirmationRequestBytes(order)');
    const scrubAt = body.indexOf('scrubRetiredPrivateFields(order)');
    assert.ok(guardAt > 0, `${fn} must call the boundary`);
    assert.ok(scrubAt > 0, `${fn} must still scrub`);
    assert.ok(guardAt < scrubAt, `${fn} must refuse BEFORE it scrubs`);
  }
});

// ── B3 — the legacy writer, and the scrubbed read-modify-write control ──────

test('B3: a stale raw writer that kept a pre-scrub record is refused', async () => {
  await localStore(async (dir) => {
    // A record written before A3 existed, planted directly in the store.
    const legacy = baseOrder(ORDER_ID, { confirmationEmailEnvelope: inlineEnvelope() });
    const file = path.join(dir, `${ORDER_ID}.json`);
    writeFileSync(file, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
    const before = readFileSync(file, 'utf8');

    // The legacy writer kept its own raw object rather than the scrubbed read,
    // changed one unrelated field, and wrote it back. This is the case the
    // privacy review named explicitly; the new producer is not the only risk.
    const replayed = { ...legacy, internalDispositionNote: 'touched something unrelated' };
    await rejectsWith(() => persistOrder(replayed as OrderRecord), 'retired_inline_envelope_present');
    await rejectsWith(() => commitOrderConditional(replayed as OrderRecord, 'v'), 'retired_inline_envelope_present');

    assert.equal(readFileSync(file, 'utf8'), before, 'a refused replay must not change the record');
  });
});

test('B3: the ordinary scrubbed read-modify-write is allowed — this is a control', async () => {
  await localStore(async (dir) => {
    const legacy = baseOrder(ORDER_ID, { confirmationEmailEnvelope: inlineEnvelope() });
    writeFileSync(path.join(dir, `${ORDER_ID}.json`), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

    // Read through the authoritative path, which scrubs, then write that back.
    const read = await getOrderAuthoritative(ORDER_ID);
    assert.ok(read, 'the legacy record must be readable');
    assert.equal('confirmationEmailEnvelope' in (read as object), false, 'the read must scrub the field away');

    const updated = { ...(read as OrderRecord), internalDispositionNote: 'ordinary update' };
    await persistOrder(updated as OrderRecord);

    const body = readFileSync(path.join(dir, `${ORDER_ID}.json`), 'utf8');
    assertNoRequestCanaries(body, 'the rewritten record');
    assert.equal(body.includes('confirmationEmailEnvelope'), false);
    // No hidden provenance or taint mechanism is required, and none is present.
    assert.equal(body.includes('legacyConfirmationEnvelope'), false);
  });
});

// ── B4 — the read path scrubs ──────────────────────────────────────────────

test('B4: every authoritative read scrubs a stray inline envelope', async () => {
  await localStore(async (dir) => {
    const legacy = baseOrder(ORDER_ID, { confirmationEmailEnvelope: inlineEnvelope() });
    const raw = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(path.join(dir, `${ORDER_ID}.json`), raw, 'utf8');
    // The bytes on disk really do carry the request, so the scrub is doing work.
    assert.ok(raw.includes(CANARY.requestHtml), 'the fixture must actually contain request bytes');

    for (const [label, read] of [
      ['getOrderAuthoritative', await getOrderAuthoritative(ORDER_ID)],
      ['readOrderVersioned', (await readOrderVersioned(ORDER_ID))?.order ?? null],
    ] as const) {
      assert.ok(read, `${label} must return the record`);
      assert.equal('confirmationEmailEnvelope' in (read as object), false, `${label} must scrub`);
      assertNoRequestCanaries(JSON.stringify(read), `${label}'s returned record`);
    }
  });
});

test('B4: the scrub is on the shared deserializer, so no read path can miss it', () => {
  // Every order-record deserialization in the module funnels through
  // parseOrderRecord; pin that, rather than enumerating call sites by hand.
  const parse = ORDERS_SOURCE.slice(ORDERS_SOURCE.indexOf('function parseOrderRecord('));
  assert.match(parse.slice(0, 400), /scrubRetiredPrivateFields\(JSON\.parse\(serialized\)/);
  const scrub = ORDERS_SOURCE.slice(ORDERS_SOURCE.indexOf('function scrubRetiredPrivateFields('));
  assert.match(
    scrub.slice(0, scrub.indexOf('\n}')),
    /delete sanitized\[CONFIRMATION_ENVELOPE_RETIRED_INLINE_FIELD\]/,
    'the scrub must delete the retired inline envelope',
  );
  // Every `as OrderRecord` deserialization in the module must be the scrubbed
  // one. An unscrubbed second read path is what this excludes.
  const unscrubbed = [...ORDERS_SOURCE.matchAll(/(.{0,30})JSON\.parse\([^)]*\) as OrderRecord/g)]
    .filter((match) => !match[1].includes('scrubRetiredPrivateFields('))
    .map((match) => match[0]);
  assert.deepEqual(unscrubbed, [], 'order records must only be deserialized through the scrub');
  assert.equal(
    (ORDERS_SOURCE.match(/JSON\.parse\([^)]*\) as OrderRecord/g) ?? []).length,
    1,
    'there must be exactly one order-record deserialization site',
  );
});

// ── B5 — a valid ref survives persist → read → conditional commit ──────────

test('B5: a valid ref round-trips byte-identically through all three paths', async () => {
  await localStore(async (dir) => {
    const ref = validRef();
    const expectedBytes = JSON.stringify(ref);

    const created = await persistNewOrder(
      baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: ref } as Partial<OrderRecord>),
    );
    assert.equal(JSON.stringify(created.confirmationEmailEnvelopeRef), expectedBytes);

    const read = await readOrderVersioned(ORDER_ID);
    assert.ok(read, 'the created order must be readable');
    assert.equal(JSON.stringify(read!.order.confirmationEmailEnvelopeRef), expectedBytes);
    assert.deepEqual(read!.order.confirmationEmailEnvelopeRef, ref);

    const committed = await commitOrderConditional(
      { ...read!.order, internalDispositionNote: 'unrelated change' } as OrderRecord,
      read!.version,
    );
    assert.equal(committed.ok, true, 'the conditional commit must land');

    const after = await getOrderAuthoritative(ORDER_ID);
    assert.equal(JSON.stringify(after?.confirmationEmailEnvelopeRef), expectedBytes);

    await persistOrder({ ...(after as OrderRecord), internalDispositionNote: 'again' } as OrderRecord);
    const final = await getOrderAuthoritative(ORDER_ID);
    assert.equal(JSON.stringify(final?.confirmationEmailEnvelopeRef), expectedBytes);

    // And the bytes on disk carry the ref and nothing request-shaped.
    const body = readFileSync(path.join(dir, `${ORDER_ID}.json`), 'utf8');
    assert.ok(body.includes('"confirmationEmailEnvelopeRef"'));
    assertNoRequestCanaries(body, 'the stored record');
  });
});

test('B5: a ref under the configured namespace round-trips too', async () => {
  await localStore(
    async () => {
      const ref = validRef(ORDER_ID, {}, 'previewns');
      const created = await persistNewOrder(
        baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: ref } as Partial<OrderRecord>),
      );
      assert.deepEqual({ ...created.confirmationEmailEnvelopeRef }, ref);
      assert.equal(JSON.stringify(created.confirmationEmailEnvelopeRef), JSON.stringify(ref));
      assert.equal(Object.getPrototypeOf(created.confirmationEmailEnvelopeRef), null);
      // The flat-namespace ref is now the WRONG one for this deployment.
      await rejectsWith(
        () => persistOrder(baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: validRef() } as Partial<OrderRecord>)),
        'ref_object_path',
      );
    },
    { HSB_BLOB_NAMESPACE: 'previewns' },
  );
});

test('B5: a record with no confirmation fields at all persists unchanged', async () => {
  await localStore(async (dir) => {
    const order = baseOrder(ORDER_ID);
    assert.equal('confirmationEmailEnvelope' in order, false);
    assert.equal('confirmationEmailEnvelopeRef' in order, false);
    const persisted = await persistOrder(order);
    assert.equal('confirmationEmailEnvelopeRef' in persisted, false);
    const body = readFileSync(path.join(dir, `${ORDER_ID}.json`), 'utf8');
    assert.equal(body.includes('confirmationEmail'), false, 'no confirmation key should appear');
  });
});

// ── B6 — the serialized store body, not the input object ───────────────────

test('B6: no canary ever reaches the serialized store body, on any write path', async () => {
  // Asserted on the exact bytes handed to the store. An input that looks clean
  // and a body that carries request bytes is the failure mode being excluded.
  const bodies: string[] = [];
  await localStore(async () => {
    const adapter: OrderStoreAdapter = {
      kind: 'body-canary',
      async readVersioned() { return null; },
      async createIfAbsent(_pathname, body) { bodies.push(body); return { ok: true, version: 'v1' }; },
      async replaceIfVersion(_pathname, body) { bodies.push(body); return { ok: true, version: 'v2' }; },
    };
    __setOrderStoreAdapterFactoryForTests(() => adapter);

    const clean = baseOrder(ORDER_ID, {
      confirmationEmailEnvelopeRef: validRef(),
      confirmationEmailFrom: CANARY.sender,
      confirmationEmailIdempotencyKey: CANARY.idempotencyKey,
    } as Partial<OrderRecord>);

    await persistNewOrder(clean);
    await commitOrderConditional(clean, 'v1');
    assert.equal(bodies.length, 2, 'both adapter paths must have been exercised');

    for (const body of bodies) {
      for (const canary of REQUEST_CANARIES) {
        assert.equal(body.includes(canary), false, 'a request canary reached the store body');
      }
      // The ref itself did reach it — the assertion above must not pass by the
      // record having been emptied.
      assert.ok(body.includes(DIGEST), 'the ref must be in the body');
      assert.ok(body.includes('"storageKind": "private_blob"'));
      // The idempotency key and sender are pre-existing accepted record fields;
      // they are not A3-3 additions and are deliberately still stored.
      assert.ok(body.includes(CANARY.idempotencyKey));
    }
  });
  // persistOrder's body was asserted from disk in B5.
});

// ── B7 — the immutable intake digest is untouched ──────────────────────────

test('B7: confirmation lifecycle fields do not move the checkout intake digest', () => {
  const plain = baseOrder(ORDER_ID);
  const baseline = checkoutIntakeOrderContractDigest(plain);
  assert.ok(baseline, 'the digest must compute for a plain record');

  for (const [label, overrides] of [
    ['ref', { confirmationEmailEnvelopeRef: validRef() }],
    ['state', { confirmationEmailState: 'ACCEPTED' }],
    ['sentAt', { confirmationEmailSentAt: CREATED_AT }],
    ['from', { confirmationEmailFrom: CANARY.sender }],
    ['idempotencyKey', { confirmationEmailIdempotencyKey: CANARY.idempotencyKey }],
    ['inline envelope', { confirmationEmailEnvelope: inlineEnvelope() }],
  ] as ReadonlyArray<[string, Partial<OrderRecord>]>) {
    assert.equal(
      checkoutIntakeOrderContractDigest({ ...plain, ...overrides } as OrderRecord),
      baseline,
      `${label} must not change the intake contract digest`,
    );
  }

  // A genuine intake field still does, so the assertion above is not vacuous.
  assert.notEqual(
    checkoutIntakeOrderContractDigest({ ...plain, childName: 'Changed' } as OrderRecord),
    baseline,
  );
});

// ── B8 — the positive operator projection ─────────────────────────────────

test('B8: a valid ref projects exactly the eight non-request fields', () => {
  const ref = validRef();
  const order = baseOrder(ORDER_ID, {
    confirmationEmailEnvelopeRef: ref,
    confirmationEmailFrom: CANARY.sender,
    confirmationEmailIdempotencyKey: CANARY.idempotencyKey,
  } as Partial<OrderRecord>);

  for (const [label, dto] of [
    ['list', toAdminOrderListItem(order)],
    ['detail', toAdminOrderDetail(order)],
  ] as const) {
    assert.ok(dto.confirmation, `${label} must project the confirmation view`);
    assert.deepEqual(
      Object.keys(dto.confirmation!).sort(),
      [...CONFIRMATION_ENVELOPE_OPERATOR_VIEW_KEYS].sort(),
      `${label}'s view must be exactly the allowlist`,
    );
    assert.deepEqual(dto.confirmation, {
      envelopeVersion: 1,
      orderId: ORDER_ID,
      templateVersion: 'order-confirmation@a33test',
      createdAt: CREATED_AT,
      canonicalDigest: DIGEST,
      canonicalBytes: 1234,
      accountLabel: 'hsb-test-prod-v1',
      purgedAt: null,
    });

    const serialized = JSON.stringify(dto);
    assertNoRequestCanaries(serialized, `${label}'s projection`);
    // The two storage locators stop at the boundary.
    for (const key of ['storageKind', 'objectPath', 'request', 'idempotencyKey', 'providerBinding']) {
      assert.equal(serialized.includes(key), false, `${label} serializes ${key}`);
    }
    // And the view shares no reference with the record it came from.
    assert.notEqual(dto.confirmation, ref);
  }
});

test('B8: the property is omitted entirely for anything that is not a valid ref', () => {
  const omitted: ReadonlyArray<[string, unknown]> = [
    ['absent', undefined],
    ['null', null],
    ['not an object', 'ref'],
    ['empty object', {}],
    ['extra key', { ...validRef(), extra: 1 }],
    ['request-like key', { ...validRef(), html: CANARY.requestHtml }],
    ['malformed digest', { ...validRef(), canonicalDigest: 'nope' }],
    ['malformed createdAt', { ...validRef(), createdAt: '2026-09-26T12:00:00Z' }],
    ['non-integer bytes', { ...validRef(), canonicalBytes: 1.5 }],
    ['wrong storage kind', { ...validRef(), storageKind: 'public_blob' }],
    ['path outside the namespace', { ...validRef(), objectPath: `x/y/${CONFIRMATION_ENVELOPE_REF_PATH_PREFIX}/${ORDER_ID}/v1.json` }],
    ['foreign order id', validRef(OTHER_ORDER_ID, {}, '')],
    ['tombstoned', { ...validRef(), purgedAt: CREATED_AT }],
  ];

  for (const [label, ref] of omitted) {
    const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: ref } as Partial<OrderRecord>);
    for (const [surface, dto] of [
      ['list', toAdminOrderListItem(order)],
      ['detail', toAdminOrderDetail(order)],
    ] as const) {
      assert.equal(
        Object.hasOwn(dto, 'confirmation'),
        false,
        `${surface} must omit confirmation for ${label}`,
      );
      assert.equal(
        JSON.stringify(dto).includes('confirmation'),
        false,
        `${surface} must not serialize a confirmation key for ${label}`,
      );
      assertNoRequestCanaries(JSON.stringify(dto), `${surface} for ${label}`);
    }
  }
});

test('B8: the A3-1 exact-key contract still holds for every record without a valid ref', () => {
  // The optional property must not have widened what a ref-less order emits, or
  // the accepted A3-1 fixtures would no longer be byte-compatible.
  for (const order of [
    baseOrder(ORDER_ID),
    baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: null } as Partial<OrderRecord>),
    baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: { ...validRef(), extra: 1 } } as Partial<OrderRecord>),
  ]) {
    assert.deepEqual(
      Object.keys(toAdminOrderListItem(order)).sort(),
      [...ADMIN_ORDER_LIST_ITEM_KEYS].sort(),
    );
    assert.deepEqual(
      Object.keys(toAdminOrderDetail(order)).sort(),
      [...ADMIN_ORDER_DETAIL_KEYS].sort(),
    );
  }
  // The key constants themselves were not widened.
  assert.equal([...ADMIN_ORDER_LIST_ITEM_KEYS].includes('confirmation' as never), false);
  assert.equal([...ADMIN_ORDER_DETAIL_KEYS].includes('confirmation' as never), false);
  // A valid ref adds exactly one key, and only that one.
  const withRef = toAdminOrderListItem(
    baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: validRef() } as Partial<OrderRecord>),
  );
  assert.deepEqual(
    Object.keys(withRef).sort(),
    [...ADMIN_ORDER_LIST_ITEM_KEYS, 'confirmation'].sort(),
  );
});

test('B8: the projection does not mutate the record it reads', () => {
  const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: validRef() } as Partial<OrderRecord>);
  const before = JSON.stringify(order);
  toAdminOrderListItem(order);
  toAdminOrderDetail(order);
  assert.equal(JSON.stringify(order), before, 'the private dispatch path depends on this');
});

test('B8: the standalone projector agrees with the DTO, including on tombstones', () => {
  assert.ok(projectConfirmationEmailEnvelopeRefIfValid(validRef(), { orderId: ORDER_ID }));
  assert.equal(
    projectConfirmationEmailEnvelopeRefIfValid({ ...validRef(), purgedAt: CREATED_AT }, { orderId: ORDER_ID }),
    null,
    'a tombstone is omitted, not rendered as a purged view',
  );
  assert.equal(projectConfirmationEmailEnvelopeRefIfValid(undefined, { orderId: ORDER_ID }), null);
});

// ── B9 — the new record field and the new module's reach ───────────────────

test('B9: the ref field is declared additive, optional and nullable', () => {
  assert.match(
    ORDERS_SOURCE,
    /\n {2}confirmationEmailEnvelopeRef\?: ConfirmationEmailEnvelopeRefV1 \| null;/,
    'the ref must be an additive optional nullable record field',
  );
  const atThePin: OrderRecord = {
    id: 'ord_pin',
    childName: 'Luna',
    email: 'buyer@example.invalid',
    bookFormat: 'digital',
    paymentStatus: 'paid',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  } as OrderRecord;
  assert.equal(atThePin.confirmationEmailEnvelopeRef, undefined);
});

test('B9: the ref module is pure — no storage, credential, clock or log sink', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'src/lib/confirmation-envelope-ref.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const [pattern, why] of [
    [/process\.env/, 'reads the environment'],
    [/console\./, 'writes to a log sink'],
    [/@vercel\/blob/, 'reaches storage'],
    [/\bfetch\s*\(/, 'performs network I/O'],
    [/Date\.now|new Date\(\)/, 'reads a clock'],
    [/\bawait\b/, 'performs asynchronous work'],
    [/^import /m, 'depends on another module'],
  ] as ReadonlyArray<[RegExp, string]>) {
    assert.doesNotMatch(code, pattern, `confirmation-envelope-ref.ts ${why}`);
  }
});

test('B9: the ref module is reached at runtime only by the files that need it (A3-4 R2: plus the snapshot producer)', () => {
  const skip = new Set([
    'node_modules', '.git', '.next', '.vercel', 'graphify-out',
    'test-results', 'playwright-report', 'blob-report', '.e2e-store', '.data',
  ]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry)) files.push(path.relative(REPO_ROOT, full));
    }
  };
  walk(REPO_ROOT);

  const allowed = new Set([
    'src/lib/confirmation-envelope-ref.ts',
    'src/lib/orders.ts',
    'src/lib/admin-order-dto.ts',
    'tests/confirmation-envelope-record-boundary.test.ts',
    // A3-4 R2 AM-B1: the snapshot producer materializes the ref it writes.
    'src/lib/confirmation-envelope-producer.ts',
    // A3-6: the reconciliation module validates the ref for door 2 and the
    // operator projection, and owns the order-id grammar for the route.
    'src/lib/confirmation-email-reconciliation.ts',
    // A3-7 AM-1: the inert retention planner uses only the two pure ref predicates.
    'src/lib/confirmation-envelope-retention.ts',
  ]);
  const offenders = files.filter((file) => {
    if (allowed.has(file)) return false;
    return /['"][^'"]*confirmation-envelope-ref(?:\.ts)?['"]/.test(
      readFileSync(path.join(REPO_ROOT, file), 'utf8'),
    );
  });
  assert.deepEqual(offenders, [], `the ref module is imported outside its boundary:\n${offenders.join('\n')}`);
});

// ── B10 — R3: the serialized bytes, not the own enumerable keys ────────────
//
// `JSON.stringify` honours a `toJSON` found anywhere on the prototype chain,
// and reads each member through [[Get]]. A ref that passes an own-keys check
// can therefore still serialize as something else entirely.

/** Request-shaped bytes, as a hostile `toJSON` would return them. */
function requestShapedCanaryPayload(): Record<string, unknown> {
  return {
    request: {
      from: CANARY.requestFrom,
      to: [CANARY.requestTo],
      subject: CANARY.requestSubject,
      html: CANARY.requestHtml,
      text: CANARY.requestText,
      replyTo: CANARY.requestReplyTo,
    },
    idempotencyKey: CANARY.idempotencyKey,
  };
}

/** The ten valid own fields, on an object whose prototype supplies `toJSON`. */
function prototypeToJsonRef(): ConfirmationEmailEnvelopeRefV1 {
  const proto = { toJSON: () => requestShapedCanaryPayload() };
  return Object.assign(Object.create(proto) as object, validRef()) as ConfirmationEmailEnvelopeRefV1;
}

/** An adapter that captures every body handed to the store. */
function capturingAdapter(): OrderStoreAdapter & { readonly bodies: string[] } {
  const bodies: string[] = [];
  return {
    kind: 'r3-capturing',
    bodies,
    async readVersioned() { return null; },
    async createIfAbsent(_pathname, body) { bodies.push(body); return { ok: true, version: 'v1' }; },
    async replaceIfVersion(_pathname, body) { bodies.push(body); return { ok: true, version: 'v2' }; },
  };
}

test('B10: a ref whose prototype supplies toJSON never reaches the store body (persistNewOrder)', async () => {
  await localStore(async () => {
    const adapter = capturingAdapter();
    __setOrderStoreAdapterFactoryForTests(() => adapter);
    const ref = prototypeToJsonRef();
    // The fixture is what the review described: ten valid own fields, and a
    // stringify that emits request bytes instead.
    assert.deepEqual(Object.keys(ref).sort(), [...CONFIRMATION_ENVELOPE_REF_KEYS].sort());
    assert.ok(JSON.stringify(ref).includes(CANARY.requestHtml), 'the fixture must serialize the canary');

    const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: ref } as Partial<OrderRecord>);
    let thrown: unknown;
    try {
      await persistNewOrder(order);
    } catch (error) {
      thrown = error;
    }
    // The bytes first: this is the leak, stated as the leak.
    for (const body of adapter.bodies) assertNoRequestCanaries(body, 'the persistNewOrder store body');
    assert.deepEqual(adapter.bodies, [], 'a refused persistNewOrder must hand the store nothing');
    assert.ok(thrown instanceof OrderPersistenceError, 'the write must be refused, not repaired');
    assert.match((thrown as Error).message, /confirmation_envelope_boundary:ref_not_plain_data/);
  });
});

type WritePath = 'persistOrder' | 'persistNewOrder' | 'commitOrderConditional';
const WRITE_PATHS: readonly WritePath[] = ['persistOrder', 'persistNewOrder', 'commitOrderConditional'];

/**
 * Drive one real write path and return every body the store received.
 *
 * `persistOrder` writes to the on-disk store (it has no adapter seam), so its
 * body is read back from the directory; the other two go through a capturing
 * adapter. A refused write returns its error and the bodies (which must be none).
 */
async function writeThrough(
  pathName: WritePath,
  order: OrderRecord,
): Promise<{ bodies: string[]; error: unknown; result: unknown }> {
  return localStore(async (dir) => {
    const adapter = capturingAdapter();
    __setOrderStoreAdapterFactoryForTests(() => adapter);
    let error: unknown;
    let result: unknown;
    try {
      if (pathName === 'persistOrder') result = await persistOrder(order);
      else if (pathName === 'persistNewOrder') result = await persistNewOrder(order);
      else result = await commitOrderConditional(order, 'v-expected');
    } catch (caught) {
      error = caught;
    }
    const bodies = pathName === 'persistOrder'
      ? storedFiles(dir).map((name) => readFileSync(path.join(dir, name), 'utf8'))
      : [...adapter.bodies];
    return { bodies, error, result };
  });
}

test('B10: a proxy ref whose [[Get]] answers toJSON is written as its validated values only', async () => {
  // Indistinguishable from plain data to every inspection a pure module can
  // make — prototype, `in`, own keys and descriptors are all honest — but
  // `JSON.stringify` asks [[Get]] for `toJSON`, and this proxy answers. No
  // validator can refuse it, so only serializing a fresh copy is safe.
  for (const pathName of WRITE_PATHS) {
    const target = validRef();
    const ref = new Proxy(target, {
      get(t, key, receiver) {
        if (key === 'toJSON') return () => requestShapedCanaryPayload();
        return Reflect.get(t, key, receiver);
      },
    });
    assert.ok(JSON.stringify(ref).includes(CANARY.requestHtml), 'the fixture must serialize the canary');

    const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: ref } as Partial<OrderRecord>);
    const { bodies, error } = await writeThrough(pathName, order);
    assert.equal(error, undefined, `${pathName} must write the validated ref`);
    assert.equal(bodies.length, 1, `${pathName} must have written exactly one body`);
    for (const body of bodies) {
      assertNoRequestCanaries(body, `the ${pathName} store body`);
      const stored = (JSON.parse(body) as OrderRecord).confirmationEmailEnvelopeRef;
      assert.equal(JSON.stringify(stored), JSON.stringify(validRef()), `${pathName} must store the ten values`);
    }
  }
});

test('B10: a ref field re-read between the boundary and the scrub cannot swap in a hostile ref', async () => {
  // The boundary reads the raw record; the scrub copies it again. A record
  // whose ref is an accessor can answer the two reads differently, so the
  // bytes must be decided from the copy that is actually serialized.
  for (const pathName of WRITE_PATHS) {
    const order = baseOrder(ORDER_ID) as OrderRecord & Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(order, 'confirmationEmailEnvelopeRef', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? validRef() : prototypeToJsonRef();
      },
    });

    const { bodies, error } = await writeThrough(pathName, order);
    for (const body of bodies) assertNoRequestCanaries(body, `the ${pathName} store body`);
    assert.deepEqual(bodies, [], `${pathName} must hand the store nothing`);
    assert.ok(error instanceof OrderPersistenceError, `${pathName} must refuse, not repair`);
    assert.match((error as Error).message, /confirmation_envelope_boundary:ref_not_plain_data/);
  }
});

/** Hostile candidates that must be refused, each with the code it must name. */
function hostileRefs(): ReadonlyArray<[string, string, () => unknown]> {
  return [
    ['inherited toJSON', 'ref_not_plain_data', () => prototypeToJsonRef()],
    ['own non-enumerable toJSON', 'ref_key_set', () => Object.defineProperty(validRef(), 'toJSON', {
      value: () => requestShapedCanaryPayload(), enumerable: false,
    })],
    ['own enumerable toJSON', 'ref_key_set', () => ({ ...validRef(), toJSON: () => requestShapedCanaryPayload() })],
    ['accessor-backed allowed field', 'ref_not_plain_data', () => {
      const ref = validRef() as unknown as Record<string, unknown>;
      Object.defineProperty(ref, 'templateVersion', { enumerable: true, get: () => 'order-confirmation@a33test' });
      return ref;
    }],
    ['non-enumerable allowed field', 'ref_not_plain_data', () => {
      const ref = validRef() as unknown as Record<string, unknown>;
      Object.defineProperty(ref, 'purgedAt', { value: null, enumerable: false });
      return ref;
    }],
    ['symbol-keyed extra', 'ref_key_set', () => ({ ...validRef(), [Symbol('x')]: requestShapedCanaryPayload() })],
    ['class instance', 'ref_not_plain_data', () => {
      class Carrier {}
      return Object.assign(new Carrier(), validRef());
    }],
    ['function-valued prototype chain', 'ref_not_plain_data', () => Object.assign(
      Object.create(Object.create(null, { toJSON: { value: () => requestShapedCanaryPayload() } })) as object,
      validRef(),
    )],
    ['throwing ownKeys trap', 'ref_not_plain_data', () => new Proxy(validRef(), {
      ownKeys() { throw new Error(CANARY.requestHtml); },
    })],
    ['throwing getPrototypeOf trap', 'ref_not_plain_data', () => new Proxy(validRef(), {
      getPrototypeOf() { throw new Error(CANARY.requestHtml); },
    })],
    ['throwing has trap', 'ref_not_plain_data', () => new Proxy(validRef(), {
      has() { throw new Error(CANARY.requestHtml); },
    })],
    ['throwing getOwnPropertyDescriptor trap', 'ref_not_plain_data', () => new Proxy(validRef(), {
      getOwnPropertyDescriptor() { throw new Error(CANARY.requestHtml); },
    })],
    ['non-object prototype via trap', 'ref_not_plain_data', () => new Proxy(validRef(), {
      getPrototypeOf() { return { toJSON: () => requestShapedCanaryPayload() }; },
    })],
    ['revoked proxy', 'ref_not_plain_data', () => {
      const { proxy, revoke } = Proxy.revocable(validRef(), {});
      revoke();
      return proxy;
    }],
    ['boxed string member', 'ref_template_version', () => ({
      ...validRef(), templateVersion: Object.assign(new String('x'), { toJSON: () => requestShapedCanaryPayload() }),
    })],
  ];
}

test('B10: the validator is total — every hostile ref is refused by code, and nothing throws', () => {
  for (const [label, code, make] of hostileRefs()) {
    let shape: unknown;
    let exact: unknown;
    assert.doesNotThrow(() => {
      shape = validateConfirmationEmailEnvelopeRefShape(make(), { orderId: ORDER_ID });
      exact = validateConfirmationEmailEnvelopeRef(make(), { orderId: ORDER_ID, namespace: '' });
    }, `${label} must not throw out of the validator`);
    assert.equal(shape, code, `${label} (shape form)`);
    assert.equal(exact, code, `${label} (namespace-exact form)`);
    assert.equal(isConfirmationEmailEnvelopeRef(make(), { orderId: ORDER_ID }), false, label);
    assert.equal(projectConfirmationEmailEnvelopeRefIfValid(make(), { orderId: ORDER_ID }), null, label);
  }
});

test('B10: every hostile ref is refused on all three write paths before the store is asked', async () => {
  for (const [label, code, make] of hostileRefs()) {
    for (const pathName of WRITE_PATHS) {
      const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: make() } as Partial<OrderRecord>);
      const { bodies, error } = await writeThrough(pathName, order);
      for (const body of bodies) assertNoRequestCanaries(body, `${pathName} body for ${label}`);
      assert.deepEqual(bodies, [], `${pathName} must write nothing for ${label}`);
      assert.ok(error instanceof OrderPersistenceError, `${pathName} must refuse ${label}`);
      assert.match((error as Error).message, new RegExp(`confirmation_envelope_boundary:${code}$`), label);
      assertNoRequestCanaries((error as Error).message, `${pathName} refusal for ${label}`);
    }
  }
});

test('B10: the admin projection omits a hostile ref and never throws', () => {
  for (const [label, , make] of hostileRefs()) {
    const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: make() } as Partial<OrderRecord>);
    for (const [surface, project] of [
      ['list', toAdminOrderListItem],
      ['detail', toAdminOrderDetail],
    ] as const) {
      let dto: object | undefined;
      assert.doesNotThrow(() => { dto = project(order); }, `${surface} must not throw for ${label}`);
      assert.equal(Object.hasOwn(dto!, 'confirmation'), false, `${surface} must omit ${label}`);
      assertNoRequestCanaries(JSON.stringify(dto), `${surface} for ${label}`);
    }
  }
});

test('B10: a polluted Object.prototype.toJSON is refused rather than serialized', async () => {
  const proto = Object.prototype as unknown as Record<string, unknown>;
  assert.equal(Object.hasOwn(proto, 'toJSON'), false, 'the realm must start unpolluted');
  // Built BEFORE pollution: `localStore` and the order fixture must not run
  // under it, only the boundary.
  const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: validRef() } as Partial<OrderRecord>);
  const ref = validRef();
  let shape: unknown;
  let thrown: unknown;
  Object.defineProperty(proto, 'toJSON', {
    value: () => requestShapedCanaryPayload(), configurable: true, writable: true, enumerable: false,
  });
  try {
    shape = validateConfirmationEmailEnvelopeRefShape(ref, { orderId: ORDER_ID });
    try {
      assertNoConfirmationRequestBytes(order);
    } catch (error) {
      thrown = error;
    }
  } finally {
    delete proto.toJSON;
  }
  assert.equal(Object.hasOwn(proto, 'toJSON'), false, 'the realm must be restored');
  assert.equal(shape, 'ref_not_plain_data');
  assert.ok(thrown instanceof OrderPersistenceError);
  assert.match((thrown as Error).message, /confirmation_envelope_boundary:ref_not_plain_data$/);
});

/** Pollute only ref serialization, leaving the surrounding order observable. */
function installRefToJsonPollution(): void {
  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true,
    enumerable: false,
    writable: true,
    value(this: Record<string, unknown>) {
      return this.storageKind === 'private_blob' ? requestShapedCanaryPayload() : this;
    },
  });
}

for (const timing of ['pre-existing', 'during descriptor inspection'] as const) {
  // A null-prototype candidate remains valid even with pre-existing pollution.
  // The proxy installs the same hook AFTER the materializer's `in` check.
  function candidate(): ConfirmationEmailEnvelopeRefV1 {
    const target = Object.assign(Object.create(null) as object,
      Object.fromEntries(Object.entries(validRef()).reverse())) as ConfirmationEmailEnvelopeRefV1;
    return timing === 'pre-existing' ? target : new Proxy(target, {
      getOwnPropertyDescriptor(object, key) {
        installRefToJsonPollution();
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
    });
  }

  test(`B10 R3.1: materialized bytes resist ${timing} Object.prototype.toJSON pollution`, () => {
    assert.equal(Object.hasOwn(Object.prototype, 'toJSON'), false);
    const ref = candidate();
    const expected = JSON.stringify(Object.fromEntries(Object.entries(validRef()).reverse()));
    let serialized: string | undefined;
    let output: ConfirmationEmailEnvelopeRefV1 | undefined;
    let hostileBytes: string | undefined;
    try {
      if (timing === 'pre-existing') installRefToJsonPollution();
      const materialized = materializeConfirmationEmailEnvelopeRef(ref, { orderId: ORDER_ID, namespace: '' });
      assert.equal(materialized.ok, true, 'valid null-prototype data must remain accepted');
      if (materialized.ok) {
        output = materialized.ref;
        serialized = JSON.stringify(output); // Must serialize WHILE pollution is installed.
      }
      assert.equal(Object.hasOwn(Object.prototype, 'toJSON'), true, 'the attack must actually run');
      hostileBytes = JSON.stringify(validRef());
    } finally {
      Reflect.deleteProperty(Object.prototype, 'toJSON');
    }
    assert.ok(hostileBytes!.includes(CANARY.requestHtml), 'an ordinary output would leak');
    assertNoRequestCanaries(serialized!, 'materialized ref under pollution');
    assert.equal(serialized, expected, 'values and original key order must survive');
    assert.notEqual(output, ref);
    assert.equal(Object.getPrototypeOf(output), null);
  });

  test(`B10 R3.1: all writer bodies resist ${timing} Object.prototype.toJSON pollution`, async () => {
    for (const pathName of WRITE_PATHS) {
      assert.equal(Object.hasOwn(Object.prototype, 'toJSON'), false);
      const ref = candidate();
      const expected = JSON.stringify(Object.fromEntries(Object.entries(validRef()).reverse()));
      const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: ref });
      let captured: Awaited<ReturnType<typeof writeThrough>>;
      try {
        if (timing === 'pre-existing') installRefToJsonPollution();
        captured = await writeThrough(pathName, order);
        assert.equal(Object.hasOwn(Object.prototype, 'toJSON'), true, 'the attack must actually run');
      } finally {
        Reflect.deleteProperty(Object.prototype, 'toJSON');
      }
      assert.equal(captured.error, undefined, `${pathName} must accept valid data`);
      assert.equal(captured.bodies.length, 1, `${pathName} must write exactly one body`);
      assertNoRequestCanaries(captured.bodies[0], `${pathName} under ${timing} pollution`);
      const stored = (JSON.parse(captured.bodies[0]) as OrderRecord).confirmationEmailEnvelopeRef;
      assert.equal(JSON.stringify(stored), expected, `${pathName} must retain values and key order`);
    }
  });
}

test('B10: what a writer stores and returns is a fresh literal, not the caller\'s ref', async () => {
  for (const pathName of WRITE_PATHS) {
    const ref = validRef();
    const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: ref } as Partial<OrderRecord>);
    const { bodies, error, result } = await writeThrough(pathName, order);
    assert.equal(error, undefined, `${pathName} must accept a valid ref`);
    assert.equal(bodies.length, 1);
    assert.deepEqual((JSON.parse(bodies[0]) as OrderRecord).confirmationEmailEnvelopeRef, ref);
    // The caller's record is not mutated by the seal.
    assert.equal(order.confirmationEmailEnvelopeRef, ref, `${pathName} must not mutate the caller's record`);
    if (pathName !== 'commitOrderConditional') {
      const returned = (result as OrderRecord).confirmationEmailEnvelopeRef!;
      assert.notEqual(returned, ref, `${pathName} must return the materialized copy`);
      assert.deepEqual({ ...returned }, ref);
      assert.equal(JSON.stringify(returned), JSON.stringify(ref));
      assert.equal(Object.getPrototypeOf(returned), null);
    }
  }
});

test('B10: plain data that is not an Object literal is still accepted and round-trips', async () => {
  // JSON.parse output, a null-prototype object, and a non-canonical key order.
  const parsed = JSON.parse(JSON.stringify(validRef())) as unknown;
  const nullProto = Object.assign(Object.create(null) as object, validRef());
  const reordered = Object.fromEntries(Object.entries(validRef()).reverse());
  for (const [label, ref] of [['parsed', parsed], ['null prototype', nullProto], ['reordered', reordered]] as const) {
    assert.equal(validateConfirmationEmailEnvelopeRefShape(ref, { orderId: ORDER_ID }), null, label);
    const expectedBytes = JSON.stringify(ref);
    for (const pathName of WRITE_PATHS) {
      const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: ref } as Partial<OrderRecord>);
      const { bodies, error } = await writeThrough(pathName, order);
      assert.equal(error, undefined, `${pathName} must accept ${label}`);
      const stored = (JSON.parse(bodies[0]) as OrderRecord).confirmationEmailEnvelopeRef;
      // Same ten values, in the candidate's own key order.
      assert.equal(JSON.stringify(stored), expectedBytes, `${pathName} must keep ${label} byte-identical`);
    }
  }
});

test('B10: each writer seals the ref after the scrub and before it serializes', () => {
  for (const fn of ['persistOrderUnsafe', 'persistNewOrder', 'commitOrderConditional']) {
    const start = ORDERS_SOURCE.indexOf(`function ${fn}(`);
    const body = ORDERS_SOURCE.slice(start, start + 2000);
    const guardAt = body.indexOf('assertNoConfirmationRequestBytes(order)');
    const scrubAt = body.indexOf('const sanitized = scrubRetiredPrivateFields(order);');
    const sealAt = body.indexOf('sealConfirmationEnvelopeRefForWrite(sanitized);');
    const serializeAt = body.indexOf('JSON.stringify(sanitized');
    assert.ok(guardAt > 0 && scrubAt > guardAt, `${fn} must refuse before it scrubs`);
    assert.ok(sealAt > scrubAt, `${fn} must seal the scrubbed copy`);
    assert.ok(serializeAt > sealAt, `${fn} must serialize only after the seal`);
  }
  assert.equal(
    (ORDERS_SOURCE.match(/sealConfirmationEnvelopeRefForWrite\(sanitized\);/g) ?? []).length,
    3,
    'exactly the three writers seal',
  );
});

test('B9: there is still no envelope producer, store caller or dispatch wiring', () => {
  // A3-3 adds a shape and a refusal. It must not have added a writer.
  assert.doesNotMatch(ORDERS_SOURCE, /createConfirmationEnvelopeStore/);
  assert.doesNotMatch(ORDERS_SOURCE, /buildConfirmationEmailEnvelope/);
  assert.doesNotMatch(
    readFileSync(path.join(REPO_ROOT, 'src/lib/confirmation-envelope-ref.ts'), 'utf8'),
    /createConfirmationEnvelopeStore|buildConfirmationEmailEnvelope/,
  );
});

// ── NBT siblings (AM-NB1…AM-NB3): the fourth writer ────────────────────────
//
// NBT adds exactly one new write path to the record boundary: the private
// `commitOrderConditionalInNamespace`, reachable only through
// `withOrderTransactionInNamespace`. Its boundary and seal calls name the
// bound namespace, so their call text differs from the three ambient writers'
// and B2/B10 above (which count those three) cannot see it. These siblings
// extend the same pins and the same hostile-ref fixtures to it; B2 and B10
// themselves are unchanged and still count three.

/** The bound writer's source text, through the end of its declaration. */
function boundWriterSource(): string {
  const start = ORDERS_SOURCE.indexOf('async function commitOrderConditionalInNamespace(');
  assert.ok(start > 0, 'the bound writer must exist');
  const end = ORDERS_SOURCE.indexOf('\n}\n', start);
  assert.ok(end > start, 'the bound writer must be bounded');
  return ORDERS_SOURCE.slice(start, end + 2);
}

test('B2/NBT: the bound writer calls the boundary on the raw record, against the bound namespace, before it scrubs', () => {
  const body = boundWriterSource();
  const guardAt = body.indexOf('assertNoConfirmationRequestBytes(order, binding.namespace)');
  const scrubAt = body.indexOf('scrubRetiredPrivateFields(order)');
  assert.ok(guardAt > 0, 'the bound writer must call the boundary against the bound namespace');
  assert.ok(scrubAt > 0, 'the bound writer must still scrub');
  assert.ok(guardAt < scrubAt, 'the bound writer must refuse BEFORE it scrubs');
  assert.equal(
    (ORDERS_SOURCE.match(/assertNoConfirmationRequestBytes\(order, binding\.namespace\)/g) ?? []).length,
    1,
    'exactly the one bound writer calls the boundary against the bound namespace',
  );
});

test('B10/NBT: the bound writer seals the ref against the bound namespace after the scrub and before it serializes', () => {
  const body = boundWriterSource();
  const guardAt = body.indexOf('assertNoConfirmationRequestBytes(order, binding.namespace)');
  const scrubAt = body.indexOf('const sanitized = scrubRetiredPrivateFields(order);');
  const sealAt = body.indexOf('sealConfirmationEnvelopeRefForWrite(sanitized, binding.namespace);');
  const serializeAt = body.indexOf('JSON.stringify(sanitized');
  assert.ok(guardAt > 0 && scrubAt > guardAt, 'the bound writer must refuse before it scrubs');
  assert.ok(sealAt > scrubAt, 'the bound writer must seal the scrubbed copy, against the bound namespace');
  assert.ok(serializeAt > sealAt, 'the bound writer must serialize only after the seal');
  assert.equal(
    (ORDERS_SOURCE.match(/sealConfirmationEnvelopeRefForWrite\(sanitized, binding\.namespace\);/g) ?? []).length,
    1,
    'exactly the one bound writer seals against the bound namespace',
  );
});

/** A store for the bound writer: one seeded record to read, every write body captured. */
function boundCapturingAdapter(): OrderStoreAdapter & { readonly bodies: string[]; readonly calls: string[] } {
  const bodies: string[] = [];
  const calls: string[] = [];
  const seed = JSON.stringify(baseOrder(ORDER_ID), null, 2);
  return {
    kind: 'nbt-capturing',
    bodies,
    calls,
    async readVersioned(pathname) { calls.push(`readVersioned:${pathname}`); return { body: seed, version: 'v1' }; },
    async createIfAbsent(pathname) { calls.push(`createIfAbsent:${pathname}`); throw new Error('the bound writer never creates'); },
    async replaceIfVersion(pathname, body) {
      calls.push(`replaceIfVersion:${pathname}`);
      bodies.push(body);
      return { ok: true, version: 'v2' };
    },
  };
}

/**
 * Drive the bound writer once: `withOrderTransactionInNamespace` with a
 * one-shot decision that returns `order`, under a binding equal to the ambient
 * namespace (so this exercises the writer, not drift). Returns every body the
 * store received.
 */
async function writeThroughBound(order: OrderRecord): Promise<{ bodies: string[]; error: unknown; result: unknown }> {
  return localStore(async () => {
    const adapter = boundCapturingAdapter();
    __setOrderStoreAdapterFactoryForTests(() => adapter);
    const bound = boundOrders.bindOrderNamespace(boundOrders.getBlobNamespace());
    assert.equal(bound.ok, true, 'the ambient namespace must bind');
    const binding = (bound as { ok: true; binding: boundOrders.OrderNamespaceBinding }).binding;
    let served = 0;
    let error: unknown;
    let result: unknown;
    try {
      result = await boundOrders.withOrderTransactionInNamespace(binding, ORDER_ID, () => {
        served += 1;
        return { commit: order, result: 'written' };
      }, { notFound: () => 'not_found', maxAttempts: 1 });
    } catch (caught) {
      error = caught;
    }
    assert.ok(served <= 1, 'the decision is one-shot');
    for (const call of adapter.calls) assert.ok(call.endsWith(`orders/${ORDER_ID}.json`), `bound call at the record path: ${call}`);
    return { bodies: [...adapter.bodies], error, result };
  });
}

test('B10/NBT: a ref whose prototype supplies toJSON never reaches the bound store body', async () => {
  const ref = prototypeToJsonRef();
  assert.ok(JSON.stringify(ref).includes(CANARY.requestHtml), 'the fixture must serialize the canary');
  const { bodies, error } = await writeThroughBound(
    baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: ref } as Partial<OrderRecord>),
  );
  for (const body of bodies) assertNoRequestCanaries(body, 'the bound store body');
  assert.deepEqual(bodies, [], 'a refused bound write must hand the store nothing');
  assert.ok(error instanceof OrderPersistenceError, 'the bound write must be refused, not repaired');
  assert.match((error as Error).message, /confirmation_envelope_boundary:ref_not_plain_data/);
});

test('B10/NBT: a proxy ref whose [[Get]] answers toJSON is written by the bound writer as its validated values only', async () => {
  const ref = new Proxy(validRef(), {
    get(t, key, receiver) {
      if (key === 'toJSON') return () => requestShapedCanaryPayload();
      return Reflect.get(t, key, receiver);
    },
  });
  assert.ok(JSON.stringify(ref).includes(CANARY.requestHtml), 'the fixture must serialize the canary');
  const { bodies, error } = await writeThroughBound(
    baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: ref } as Partial<OrderRecord>),
  );
  assert.equal(error, undefined, 'the bound writer must write the validated ref');
  assert.equal(bodies.length, 1, 'the bound writer must have written exactly one body');
  assertNoRequestCanaries(bodies[0], 'the bound store body');
  const stored = (JSON.parse(bodies[0]) as OrderRecord).confirmationEmailEnvelopeRef;
  assert.equal(JSON.stringify(stored), JSON.stringify(validRef()), 'the bound writer must store the ten values');
});

test('B10/NBT: a ref field re-read between the boundary and the scrub cannot swap in a hostile ref on the bound writer', async () => {
  const order = baseOrder(ORDER_ID) as OrderRecord & Record<string, unknown>;
  let reads = 0;
  Object.defineProperty(order, 'confirmationEmailEnvelopeRef', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? validRef() : prototypeToJsonRef();
    },
  });
  const { bodies, error } = await writeThroughBound(order);
  for (const body of bodies) assertNoRequestCanaries(body, 'the bound store body');
  assert.deepEqual(bodies, [], 'the bound writer must hand the store nothing');
  assert.ok(error instanceof OrderPersistenceError, 'the bound writer must refuse, not repair');
  assert.match((error as Error).message, /confirmation_envelope_boundary:ref_not_plain_data/);
});

test('B10/NBT: every hostile ref is refused on the bound write path before the store is asked', async () => {
  for (const [label, code, make] of hostileRefs()) {
    const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: make() } as Partial<OrderRecord>);
    const { bodies, error } = await writeThroughBound(order);
    for (const body of bodies) assertNoRequestCanaries(body, `bound body for ${label}`);
    assert.deepEqual(bodies, [], `the bound writer must write nothing for ${label}`);
    assert.ok(error instanceof OrderPersistenceError, `the bound writer must refuse ${label}`);
    assert.match((error as Error).message, new RegExp(`confirmation_envelope_boundary:${code}$`), label);
    assertNoRequestCanaries((error as Error).message, `bound refusal for ${label}`);
  }
});

test('B10/NBT: a polluted Object.prototype.toJSON is refused by the bound writer rather than serialized', async () => {
  assert.equal(Object.hasOwn(Object.prototype, 'toJSON'), false, 'the realm must start unpolluted');
  // Built BEFORE pollution, as in the ambient test.
  const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: validRef() } as Partial<OrderRecord>);
  let captured: Awaited<ReturnType<typeof writeThroughBound>>;
  try {
    installRefToJsonPollution();
    captured = await writeThroughBound(order);
  } finally {
    Reflect.deleteProperty(Object.prototype, 'toJSON');
  }
  assert.equal(Object.hasOwn(Object.prototype, 'toJSON'), false, 'the realm must be restored');
  for (const body of captured.bodies) assertNoRequestCanaries(body, 'the bound store body under pollution');
  assert.deepEqual(captured.bodies, [], 'the bound writer must hand the store nothing');
  assert.ok(captured.error instanceof OrderPersistenceError);
  assert.match((captured.error as Error).message, /confirmation_envelope_boundary:ref_not_plain_data$/);
});

for (const timing of ['pre-existing', 'during descriptor inspection'] as const) {
  // The same null-prototype candidate the R3.1 tests above use.
  function boundCandidate(): ConfirmationEmailEnvelopeRefV1 {
    const target = Object.assign(Object.create(null) as object,
      Object.fromEntries(Object.entries(validRef()).reverse())) as ConfirmationEmailEnvelopeRefV1;
    return timing === 'pre-existing' ? target : new Proxy(target, {
      getOwnPropertyDescriptor(object, key) {
        installRefToJsonPollution();
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
    });
  }

  test(`B10/NBT R3.1: the bound writer body resists ${timing} Object.prototype.toJSON pollution`, async () => {
    assert.equal(Object.hasOwn(Object.prototype, 'toJSON'), false);
    const expected = JSON.stringify(Object.fromEntries(Object.entries(validRef()).reverse()));
    const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: boundCandidate() });
    let captured: Awaited<ReturnType<typeof writeThroughBound>>;
    try {
      if (timing === 'pre-existing') installRefToJsonPollution();
      captured = await writeThroughBound(order);
      assert.equal(Object.hasOwn(Object.prototype, 'toJSON'), true, 'the attack must actually run');
    } finally {
      Reflect.deleteProperty(Object.prototype, 'toJSON');
    }
    assert.equal(captured.error, undefined, 'the bound writer must accept valid data');
    assert.equal(captured.bodies.length, 1, 'the bound writer must write exactly one body');
    assertNoRequestCanaries(captured.bodies[0], `the bound body under ${timing} pollution`);
    const stored = (JSON.parse(captured.bodies[0]) as OrderRecord).confirmationEmailEnvelopeRef;
    assert.equal(JSON.stringify(stored), expected, 'the bound writer must retain values and key order');
  });
}

test('B10/NBT: what the bound writer stores is a fresh literal, not the caller\'s ref', async () => {
  const ref = validRef();
  const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: ref } as Partial<OrderRecord>);
  const { bodies, error, result } = await writeThroughBound(order);
  assert.equal(error, undefined, 'the bound writer must accept a valid ref');
  assert.equal((result as { status: string }).status, 'committed');
  assert.equal(bodies.length, 1);
  assert.deepEqual((JSON.parse(bodies[0]) as OrderRecord).confirmationEmailEnvelopeRef, ref);
  assert.equal(order.confirmationEmailEnvelopeRef, ref, 'the bound writer must not mutate the caller\'s record');
});

test('B10/NBT: plain data that is not an Object literal is still accepted and round-trips through the bound writer', async () => {
  const parsed = JSON.parse(JSON.stringify(validRef())) as unknown;
  const nullProto = Object.assign(Object.create(null) as object, validRef());
  const reordered = Object.fromEntries(Object.entries(validRef()).reverse());
  for (const [label, ref] of [['parsed', parsed], ['null prototype', nullProto], ['reordered', reordered]] as const) {
    const expectedBytes = JSON.stringify(ref);
    const order = baseOrder(ORDER_ID, { confirmationEmailEnvelopeRef: ref } as Partial<OrderRecord>);
    const { bodies, error } = await writeThroughBound(order);
    assert.equal(error, undefined, `the bound writer must accept ${label}`);
    const stored = (JSON.parse(bodies[0]) as OrderRecord).confirmationEmailEnvelopeRef;
    assert.equal(JSON.stringify(stored), expectedBytes, `the bound writer must keep ${label} byte-identical`);
  }
});
