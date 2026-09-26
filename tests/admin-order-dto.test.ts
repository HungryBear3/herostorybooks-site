/*
 * L-4 Slice A3-1 — the admin order DTO boundary.
 *
 * Three surfaces used to serialize whole `OrderRecord` values: the admin list
 * API, the admin detail API, and the admin list page's handoff into a
 * `'use client'` component. These tests hold the replacement to a positive
 * allowlist and prove, at the level of the bytes the handlers actually return,
 * that nothing outside that allowlist crosses.
 *
 * Canary convention
 * -----------------
 * Every marker below is synthetic. No real customer, order, address or message
 * appears anywhere in this file.
 *
 * The six provider-request markers are seeded under the neutral synthetic key
 * `__canaryProviderRequest` rather than under the inert L-4 envelope field.
 * That is not a shortcut: the accepted Slice 1 guard
 * `tests/confirmation-email-integration-guards.test.ts`
 * ("I1-2: no persistence writer, route, kickoff or provider path touches the
 * new fields") fails any file outside its own allowlist that so much as
 * *mentions* one of the nine new record field names, and this file is not on
 * that allowlist. Seeding under a neutral key tests the same property through
 * the same code path — an unknown nested object carrying request-shaped bytes
 * must not cross a boundary built from fresh literals — while leaving the
 * accepted inertness guard intact. See HSB-L4-A3-1-IMPLEMENTATION-REPORT.md §2.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ADMIN_ORDER_ATTENTION_KEYS,
  ADMIN_ORDER_CHECKOUT_TRACKING_KEYS,
  ADMIN_ORDER_DETAIL_KEYS,
  ADMIN_ORDER_LIST_ITEM_KEYS,
  toAdminOrderDetail,
  toAdminOrderListItem,
} from '../src/lib/admin-order-dto.ts';
import { deriveOrderAttention, deriveOrderStage } from '../src/lib/order-stage.ts';
import { createOrderRecord, persistOrder, type OrderRecord } from '../src/lib/orders.ts';
import { GET as listRoute } from '../src/app/api/admin/orders/route.ts';
import { GET as detailRoute } from '../src/app/api/admin/orders/[orderId]/route.ts';

const ADMIN_KEY = 'a31-synthetic-operator-key';
const ORDER_ID = 'ord_a31canary';

/** Distinct markers, so a leak names the exact field it came from. */
const CANARY = {
  requestFrom: 'CANARY-FROM-9f31 <no-reply@example.invalid>',
  requestTo: 'CANARY-TO-4b7c@example.invalid',
  requestSubject: 'CANARY-SUBJ-1d90',
  requestHtml: '<p>CANARY-HTML-77ae</p>',
  requestText: 'CANARY-TEXT-0c52',
  requestReplyTo: 'CANARY-REPLY-3e18@example.invalid',
  idempotencyKey: 'CANARY-IDEM-5a44-order-confirmation-primary-v1',
  sender: 'CANARY-SENDER-8a20 <no-reply@example.invalid>',
  shipping: 'CANARY-SHIP-2f6b',
  audit: 'CANARY-AUDIT-b013',
  proofToken: 'CANARY-PROOF-c5d7',
  leak: 'CANARY-LEAK-e908',
} as const;

function canaryOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'digital', email: 'buyer@example.invalid' },
    { id: ORDER_ID, now: '2026-09-20T10:00:00.000Z' },
  );
  return {
    ...base,
    updatedAt: '2026-09-21T10:00:00.000Z',
    paymentStatus: 'paid',
    paidAt: '2026-09-20T10:05:00.000Z',
    status: 'order_received',
    fulfillmentStatus: 'not_started',
    fulfillmentLastError: null,
    storyArtifactUrl: null,
    customerQueueStatus: 'in_review',
    checkoutTracking: { cohort: 'ff-beta', invite: 'tester01' },
    // Authorized-but-not-projected record content, each with its own marker.
    shippingAddress: {
      name: CANARY.shipping,
      line1: `${CANARY.shipping} 1 Example Way`,
      city: 'Exampleton',
      state: 'EX',
      postalCode: '00000',
      country: 'US',
    },
    auditEvents: [{ at: '2026-09-20T11:00:00.000Z', type: 'proof_review_acknowledged', reason: CANARY.audit }],
    proofApprovalToken: CANARY.proofToken,
    confirmationEmailIdempotencyKey: CANARY.idempotencyKey,
    confirmationEmailFrom: CANARY.sender,
    // Unknown nested content, request-shaped. See the file header.
    __canaryProviderRequest: {
      from: CANARY.requestFrom,
      to: [CANARY.requestTo],
      subject: CANARY.requestSubject,
      html: CANARY.requestHtml,
      text: CANARY.requestText,
      replyTo: CANARY.requestReplyTo,
    },
    // Unknown scalar content.
    __leak: CANARY.leak,
    ...overrides,
  } as OrderRecord;
}

function assertNoCanaries(serialized: string, where: string): void {
  for (const [name, marker] of Object.entries(CANARY)) {
    assert.equal(
      serialized.includes(marker),
      false,
      `${where} leaked the ${name} canary`,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

// ── The allowlist is exact, and pinned twice ────────────────────────────────

test('A3-1: the exported key constants match a hand-written allowlist', () => {
  // Pinned here as literals so widening the DTO takes two deliberate edits:
  // one in the module, one here. A single edit fails this test.
  assert.deepEqual([...ADMIN_ORDER_CHECKOUT_TRACKING_KEYS], ['cohort', 'invite']);
  assert.deepEqual([...ADMIN_ORDER_ATTENTION_KEYS], ['severity', 'reason', 'queue', 'nextActionOwner']);
  const expected = [
    'id', 'childName', 'email', 'createdAt', 'updatedAt', 'status', 'paymentStatus',
    'fulfillmentStatus', 'fulfillmentLastError', 'storyArtifactUrl', 'refundedAt',
    'formatLabel', 'internalDisposition', 'internalDispositionNote',
    'customerQueueStatus', 'checkoutTracking', 'stage', 'attention',
  ];
  assert.deepEqual([...ADMIN_ORDER_LIST_ITEM_KEYS], expected);
  assert.deepEqual([...ADMIN_ORDER_DETAIL_KEYS], expected);
});

test('A3-1: list and detail projections emit exactly the allowlisted keys', () => {
  const order = canaryOrder();
  assert.deepEqual(Object.keys(toAdminOrderListItem(order)).sort(), [...ADMIN_ORDER_LIST_ITEM_KEYS].sort());
  assert.deepEqual(Object.keys(toAdminOrderDetail(order)).sort(), [...ADMIN_ORDER_DETAIL_KEYS].sort());
});

test('A3-1: the nested attention and tracking objects are exact too', () => {
  const item = toAdminOrderListItem(canaryOrder());
  assert.deepEqual(Object.keys(item.attention).sort(), [...ADMIN_ORDER_ATTENTION_KEYS].sort());
  assert.ok(item.checkoutTracking);
  assert.deepEqual(Object.keys(item.checkoutTracking).sort(), [...ADMIN_ORDER_CHECKOUT_TRACKING_KEYS].sort());
});

test('A3-1: the key set does not depend on which optional fields a record carries', () => {
  // An order with none of the optional fields must still emit the same keys,
  // so an exact-key assertion elsewhere means something for every record.
  const sparse = createOrderRecord(
    { childName: 'Sam', bookFormat: 'digital', email: 'sam@example.invalid' },
    { id: 'ord_a31sparse', now: '2026-09-20T10:00:00.000Z' },
  );
  assert.deepEqual(Object.keys(toAdminOrderListItem(sparse)).sort(), [...ADMIN_ORDER_LIST_ITEM_KEYS].sort());
  assert.deepEqual(Object.keys(toAdminOrderDetail(sparse)).sort(), [...ADMIN_ORDER_DETAIL_KEYS].sort());
});

// ── Nothing outside the allowlist crosses ──────────────────────────────────

test('A3-1: no canary survives either projection', () => {
  const order = canaryOrder();
  assertNoCanaries(JSON.stringify(toAdminOrderListItem(order)), 'the list projection');
  assertNoCanaries(JSON.stringify(toAdminOrderDetail(order)), 'the detail projection');
});

test('A3-1: the named forbidden fields are absent by key as well as by value', () => {
  for (const projected of [toAdminOrderListItem(canaryOrder()), toAdminOrderDetail(canaryOrder())]) {
    const serialized = JSON.stringify(projected);
    for (const key of [
      'shippingAddress',
      'auditEvents',
      'proofApprovalToken',
      'confirmationEmailIdempotencyKey',
      'confirmationEmailFrom',
      'confirmationEmailSentAt',
      'stripeSessionId',
      'stripePaymentIntentId',
      'photoBlobPath',
      '__canaryProviderRequest',
      '__leak',
    ]) {
      assert.equal(Object.hasOwn(projected as object, key), false, `projection carries the ${key} key`);
      assert.equal(serialized.includes(key), false, `projection serializes the ${key} key`);
    }
  }
});

test('A3-1: a synthetic unknown field added to the record does not cross', () => {
  const order = canaryOrder({ ['__futureField' as keyof OrderRecord]: 'CANARY-FUTURE-1111' } as Partial<OrderRecord>);
  for (const serialized of [
    JSON.stringify(toAdminOrderListItem(order)),
    JSON.stringify(toAdminOrderDetail(order)),
  ]) {
    assert.equal(serialized.includes('CANARY-FUTURE-1111'), false);
    assert.equal(serialized.includes('__futureField'), false);
  }
});

test('A3-1: the projection shares no object reference with the record', () => {
  const order = canaryOrder();
  const item = toAdminOrderListItem(order);
  assert.notEqual(item.checkoutTracking as unknown, order.checkoutTracking as unknown);
  assert.deepEqual(item.checkoutTracking, { cohort: 'ff-beta', invite: 'tester01' });
});

test('A3-1: projecting a deep-frozen record neither throws nor mutates it', () => {
  const order = deepFreeze(canaryOrder());
  const before = JSON.stringify(order);
  const item = toAdminOrderListItem(order);
  const detail = toAdminOrderDetail(order);
  assert.equal(JSON.stringify(order), before, 'the record was mutated');
  assert.equal(item.id, ORDER_ID);
  assert.equal(detail.id, ORDER_ID);
});

// ── Malformed and absent inputs degrade safely, never to the raw object ─────

test('A3-1: malformed or absent checkout tracking never yields the stored object', () => {
  const cases: Array<{ label: string; value: unknown; expected: unknown }> = [
    { label: 'null', value: null, expected: null },
    { label: 'undefined', value: undefined, expected: null },
    { label: 'empty object', value: {}, expected: null },
    { label: 'both members blank', value: { cohort: null, invite: null }, expected: null },
    { label: 'non-object', value: 'ff-beta', expected: null },
    { label: 'array', value: ['ff-beta'], expected: null },
    { label: 'cohort only', value: { cohort: 'ff-beta' }, expected: { cohort: 'ff-beta', invite: null } },
    { label: 'invite only', value: { invite: 'tester01' }, expected: { cohort: null, invite: 'tester01' } },
    {
      label: 'unexpected extra key',
      value: { cohort: 'ff-beta', invite: 'tester01', referrer: 'CANARY-REFERRER-4242' },
      expected: { cohort: 'ff-beta', invite: 'tester01' },
    },
    {
      label: 'non-string members',
      value: { cohort: 42, invite: { nested: 'CANARY-NESTED-4343' } },
      expected: null,
    },
  ];

  for (const { label, value, expected } of cases) {
    const order = canaryOrder({ checkoutTracking: value } as Partial<OrderRecord>);
    const item = toAdminOrderListItem(order);
    assert.deepEqual(item.checkoutTracking, expected, `checkoutTracking: ${label}`);
    const serialized = JSON.stringify(item);
    assert.equal(serialized.includes('CANARY-REFERRER-4242'), false, `checkoutTracking: ${label}`);
    assert.equal(serialized.includes('CANARY-NESTED-4343'), false, `checkoutTracking: ${label}`);
    // Never the stored object itself, even when both members happen to match.
    if (value !== null && typeof value === 'object') {
      assert.notEqual(item.checkoutTracking as unknown, value, `checkoutTracking: ${label}`);
    }
  }
});

test('A3-1: absent optional fields project to null, not to undefined or a fallback', () => {
  const order = canaryOrder();
  delete (order as Partial<OrderRecord>).fulfillmentStatus;
  delete (order as Partial<OrderRecord>).fulfillmentLastError;
  delete (order as Partial<OrderRecord>).storyArtifactUrl;
  delete (order as Partial<OrderRecord>).refundedAt;
  delete (order as Partial<OrderRecord>).internalDisposition;
  delete (order as Partial<OrderRecord>).internalDispositionNote;
  delete (order as Partial<OrderRecord>).customerQueueStatus;
  delete (order as Partial<OrderRecord>).checkoutTracking;

  const item = toAdminOrderListItem(order);
  for (const key of [
    'fulfillmentStatus', 'fulfillmentLastError', 'storyArtifactUrl', 'refundedAt',
    'internalDisposition', 'internalDispositionNote', 'customerQueueStatus', 'checkoutTracking',
  ] as const) {
    assert.equal(item[key], null, `${key} must project to null`);
    assert.ok(Object.hasOwn(item, key), `${key} must still be present as a key`);
  }
});

// ── Positive controls: the client keeps everything it renders ──────────────

test('A3-1: every field the ops grid renders survives the projection', () => {
  const order = canaryOrder({
    fulfillmentStatus: 'failed_manual_review',
    fulfillmentLastError: 'lulu_timeout',
    storyArtifactUrl: 'https://example.invalid/proof.pdf',
    refundedAt: '2026-09-22T10:00:00.000Z',
    internalDisposition: 'abandoned_internal_test',
    internalDispositionNote: 'smoke run',
  });
  const item = toAdminOrderListItem(order);
  assert.equal(item.id, ORDER_ID);
  assert.equal(item.childName, 'Luna');
  assert.equal(item.email, 'buyer@example.invalid');
  assert.equal(item.createdAt, '2026-09-20T10:00:00.000Z');
  assert.equal(item.updatedAt, '2026-09-21T10:00:00.000Z');
  assert.equal(item.status, 'order_received');
  assert.equal(item.paymentStatus, 'paid');
  assert.equal(item.fulfillmentStatus, 'failed_manual_review');
  assert.equal(item.fulfillmentLastError, 'lulu_timeout');
  assert.equal(item.storyArtifactUrl, 'https://example.invalid/proof.pdf');
  assert.equal(item.refundedAt, '2026-09-22T10:00:00.000Z');
  assert.equal(item.formatLabel, order.formatLabel);
  assert.equal(item.internalDisposition, 'abandoned_internal_test');
  assert.equal(item.internalDispositionNote, 'smoke run');
  assert.equal(item.customerQueueStatus, 'in_review');
  assert.deepEqual(item.checkoutTracking, { cohort: 'ff-beta', invite: 'tester01' });
});

test('A3-1: server-computed stage and attention equal the direct derivations', () => {
  const fixtures: OrderRecord[] = [
    canaryOrder(),
    canaryOrder({ paymentStatus: 'pending' }),
    canaryOrder({ refundedAt: '2026-09-22T10:00:00.000Z' }),
    canaryOrder({ fulfillmentStatus: 'failed_manual_review' }),
    canaryOrder({ fulfillmentStatus: 'proof_ready', storyArtifactUrl: 'https://example.invalid/p.pdf' }),
    canaryOrder({ fulfillmentStatus: 'generating_images' }),
    canaryOrder({ internalDisposition: 'superseded_internal_smoke' }),
    canaryOrder({ status: 'shipped', shippedAt: '2026-09-23T10:00:00.000Z' }),
    canaryOrder({ bookFormat: 'classic', formatLabel: 'Classic', printJobId: 'PJ-1' }),
  ];
  for (const order of fixtures) {
    const item = toAdminOrderListItem(order);
    assert.equal(item.stage, deriveOrderStage(order), `stage for ${item.id}`);
    const derived = deriveOrderAttention(order);
    assert.deepEqual(item.attention, {
      severity: derived.severity,
      reason: derived.reason,
      queue: derived.queue,
      nextActionOwner: derived.nextActionOwner,
    });
    // The full four-field contract, not a shorthand.
    assert.equal(typeof item.attention.reason, 'string');
    assert.equal(typeof item.attention.nextActionOwner, 'string');
  }
});

// ── The bytes the handlers actually return ─────────────────────────────────

interface StoreScope {
  dir: string;
  previous: Record<string, string | undefined>;
}

function openStore(): StoreScope {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-a31-dto-'));
  const previous: Record<string, string | undefined> = {
    HSB_ORDER_STORE_DIR: process.env.HSB_ORDER_STORE_DIR,
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
    HSB_REQUIRE_DURABLE_PERSISTENCE: process.env.HSB_REQUIRE_DURABLE_PERSISTENCE,
    HSB_ORDER_ADMIN_KEY: process.env.HSB_ORDER_ADMIN_KEY,
    VERCEL: process.env.VERCEL,
  };
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
  process.env.HSB_ORDER_ADMIN_KEY = ADMIN_KEY;
  return { dir, previous };
}

function closeStore(scope: StoreScope): void {
  for (const [key, value] of Object.entries(scope.previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scope.dir, { recursive: true, force: true });
}

function authed(url: string): Request {
  return new Request(url, { headers: { 'x-hsb-order-admin-key': ADMIN_KEY } });
}

test('A3-1: the list route returns projections, and no canary is in its bytes', async () => {
  const scope = openStore();
  try {
    await persistOrder(canaryOrder());
    const response = await listRoute(authed('https://hsb.test/api/admin/orders'));
    assert.equal(response.status, 200);
    const body = await response.text();
    assertNoCanaries(body, 'the list route');
    const parsed = JSON.parse(body) as { orders: Array<Record<string, unknown>> };
    assert.equal(parsed.orders.length, 1);
    assert.deepEqual(Object.keys(parsed.orders[0]).sort(), [...ADMIN_ORDER_LIST_ITEM_KEYS].sort());
    assert.equal(parsed.orders[0].id, ORDER_ID);
  } finally {
    closeStore(scope);
  }
});

test('A3-1: the paid_artifact-filtered list route projects too, and still filters', async () => {
  const scope = openStore();
  try {
    // Paid with no artifact and nothing started: the paid-artifact ops issue.
    await persistOrder(canaryOrder());
    // A shipped order that the filter must drop.
    await persistOrder(canaryOrder({
      id: 'ord_a31shipped',
      status: 'shipped',
      fulfillmentStatus: 'complete',
      storyArtifactUrl: 'https://example.invalid/done.pdf',
    }));

    const all = await listRoute(authed('https://hsb.test/api/admin/orders'));
    assert.equal(((await all.json()) as { orders: unknown[] }).orders.length, 2);

    const response = await listRoute(authed('https://hsb.test/api/admin/orders?opsIssue=paid_artifact'));
    assert.equal(response.status, 200);
    const body = await response.text();
    assertNoCanaries(body, 'the filtered list route');
    const parsed = JSON.parse(body) as { orders: Array<Record<string, unknown>> };
    assert.equal(parsed.orders.length, 1, 'the paid-artifact filter must still select');
    assert.equal(parsed.orders[0].id, ORDER_ID);
    assert.deepEqual(Object.keys(parsed.orders[0]).sort(), [...ADMIN_ORDER_LIST_ITEM_KEYS].sort());
  } finally {
    closeStore(scope);
  }
});

test('A3-1: the detail route returns a projection, and no canary is in its bytes', async () => {
  const scope = openStore();
  try {
    await persistOrder(canaryOrder());
    const response = await detailRoute(
      authed(`https://hsb.test/api/admin/orders/${ORDER_ID}`),
      { params: Promise.resolve({ orderId: ORDER_ID }) },
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assertNoCanaries(body, 'the detail route');
    const parsed = JSON.parse(body) as { order: Record<string, unknown> };
    assert.deepEqual(Object.keys(parsed.order).sort(), [...ADMIN_ORDER_DETAIL_KEYS].sort());
    assert.equal(parsed.order.id, ORDER_ID);
  } finally {
    closeStore(scope);
  }
});

test('A3-1: both routes still refuse an unauthenticated caller without touching the store', async () => {
  const scope = openStore();
  try {
    await persistOrder(canaryOrder());
    const list = await listRoute(new Request('https://hsb.test/api/admin/orders'));
    assert.equal(list.status, 401);
    assertNoCanaries(await list.text(), 'the unauthenticated list route');

    const detail = await detailRoute(
      new Request(`https://hsb.test/api/admin/orders/${ORDER_ID}`),
      { params: Promise.resolve({ orderId: ORDER_ID }) },
    );
    assert.equal(detail.status, 401);
    assertNoCanaries(await detail.text(), 'the unauthenticated detail route');
  } finally {
    closeStore(scope);
  }
});

test('A3-1: a missing order is still a 404 carrying no record content', async () => {
  const scope = openStore();
  try {
    const response = await detailRoute(
      authed('https://hsb.test/api/admin/orders/ord_a31missing'),
      { params: Promise.resolve({ orderId: 'ord_a31missing' }) },
    );
    assert.equal(response.status, 404);
    assertNoCanaries(await response.text(), 'the 404 detail route');
  } finally {
    closeStore(scope);
  }
});

test('A3-1: the RSC handoff payload carries only projections', () => {
  // `src/app/admin/orders/page.tsx` cannot be imported here — it reaches
  // `next/headers`, which does not resolve outside the Next build (the same
  // limitation tests/admin-orders.test.ts records for the cookie reader). What
  // is testable is the exact expression the page passes into the client
  // component, evaluated on the canary fixture: these are the bytes the
  // RSC/Flight payload carries. The type-level proof that the page passes this
  // and not the record is in tests/admin-order-serialization-guard.test.ts.
  const orders = [canaryOrder(), canaryOrder({ id: 'ord_a31second' })];
  const clientProp = orders.map(toAdminOrderListItem);
  const serialized = JSON.stringify(clientProp);
  assertNoCanaries(serialized, 'the RSC client prop');
  for (const item of clientProp) {
    assert.deepEqual(Object.keys(item).sort(), [...ADMIN_ORDER_LIST_ITEM_KEYS].sort());
  }
});
