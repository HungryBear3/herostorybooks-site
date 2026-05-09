import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildRecoveryOrderRecord,
  recoverOrder,
  formatRecoverySummary,
  uploadOrderPhotoFromPath,
} from '../src/lib/order-recovery.ts';
import { getOrder } from '../src/lib/orders.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-recovery-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

// ── Pure builder ─────────────────────────────────────────────────────────────

test('buildRecoveryOrderRecord: preserves the supplied id exactly', () => {
  const r = buildRecoveryOrderRecord({
    id: 'ord_09f2391715a14bc3',
    childName: 'Lukas',
    theme: 'dinosaur-discovery',
    bookFormat: 'classic',
    email: 'al.laplun@gmail.com',
  });
  assert.equal(r.id, 'ord_09f2391715a14bc3');
});

test('buildRecoveryOrderRecord: forces paymentStatus="paid"', () => {
  const r = buildRecoveryOrderRecord({
    id: 'ord_paid',
    childName: 'Mia',
    bookFormat: 'digital',
    email: 'a@b.com',
  });
  assert.equal(r.paymentStatus, 'paid');
});

test('buildRecoveryOrderRecord: passes through stripeSessionId + shippingAddress when provided', () => {
  const r = buildRecoveryOrderRecord({
    id: 'ord_with_meta',
    childName: 'Mia',
    bookFormat: 'classic',
    email: 'a@b.com',
    stripeSessionId: 'cs_test_abc',
    shippingAddress: {
      line1: '1 Main',
      city: 'Chicago',
      state: 'IL',
      zip: '60601',
      country: 'US',
    },
  });
  assert.equal(r.stripeSessionId, 'cs_test_abc');
  assert.equal(r.shippingAddress?.line1, '1 Main');
});

test('buildRecoveryOrderRecord: defaults nullable refs to null when not provided', () => {
  const r = buildRecoveryOrderRecord({
    id: 'ord_minimal',
    childName: 'Mia',
    bookFormat: 'digital',
    email: 'a@b.com',
  });
  assert.equal(r.stripeSessionId, null);
  assert.equal(r.shippingAddress, null);
  assert.equal(r.photoBlobPath, null);
});

test('buildRecoveryOrderRecord: digital format yields the digital priceCents + delivery copy', () => {
  const r = buildRecoveryOrderRecord({
    id: 'ord_d',
    childName: 'Mia',
    bookFormat: 'digital',
    email: 'a@b.com',
  });
  assert.equal(r.bookFormat, 'digital');
  assert.equal(r.priceCents, 1499);
  assert.match(r.deliveryExpectation, /PDF/);
});

// ── recoverOrder round-trip ──────────────────────────────────────────────────

test('recoverOrder: writes a record getOrder() can retrieve under the same id', async () => {
  const dir = makeTmp();
  try {
    const summary = await recoverOrder({
      id: 'ord_roundtrip',
      childName: 'Lukas',
      theme: 'dinosaur-discovery',
      bookFormat: 'classic',
      email: 'al.laplun@gmail.com',
    });
    assert.equal(summary.orderId, 'ord_roundtrip');
    const after = await getOrder('ord_roundtrip');
    assert.ok(after, 'persisted order must be retrievable');
    assert.equal(after!.paymentStatus, 'paid');
    assert.equal(after!.bookFormat, 'classic');
    assert.equal(after!.theme, 'dinosaur-discovery');
  } finally {
    cleanup(dir);
  }
});

test('recoverOrder: print order missing shipping emits a warning but still persists', async () => {
  const dir = makeTmp();
  try {
    const s = await recoverOrder({
      id: 'ord_print_no_ship',
      childName: 'Lukas',
      bookFormat: 'classic',
      email: 'a@b.com',
    });
    assert.ok(s.warnings.some((w) => /shippingAddress/.test(w)));
    assert.equal(s.shippingPersisted, false);
    const after = await getOrder('ord_print_no_ship');
    assert.ok(after);
  } finally {
    cleanup(dir);
  }
});

test('recoverOrder: digital order does NOT warn about shipping', async () => {
  const dir = makeTmp();
  try {
    const s = await recoverOrder({
      id: 'ord_digital_recovered',
      childName: 'Mia',
      bookFormat: 'digital',
      email: 'a@b.com',
    });
    assert.equal(s.warnings.some((w) => /shippingAddress/.test(w)), false);
  } finally {
    cleanup(dir);
  }
});

test('recoverOrder: warns when stripeSessionId is missing', async () => {
  const dir = makeTmp();
  try {
    const s = await recoverOrder({
      id: 'ord_no_session',
      childName: 'Mia',
      bookFormat: 'digital',
      email: 'a@b.com',
    });
    assert.ok(s.warnings.some((w) => /stripeSessionId/.test(w)));
  } finally {
    cleanup(dir);
  }
});

// ── uploadOrderPhotoFromPath: filesystem fallback when no blob token ─────────

test('uploadOrderPhotoFromPath: returns a warning + null path when BLOB token missing', async () => {
  const dir = makeTmp();
  const tmpFile = path.join(dir, 'photo.jpg');
  writeFileSync(tmpFile, Buffer.from([0xff, 0xd8, 0xff])); // tiny stub
  try {
    const r = await uploadOrderPhotoFromPath('ord_x', tmpFile);
    assert.equal(r.photoBlobPath, null);
    assert.equal(r.photoFileName, 'photo.jpg');
    assert.match(r.warning ?? '', /BLOB_READ_WRITE_TOKEN/);
  } finally {
    cleanup(dir);
  }
});

test('uploadOrderPhotoFromPath: sanitizes weird filenames', async () => {
  const dir = makeTmp();
  const tmpFile = path.join(dir, 'My Phone Photo (1).jpg');
  writeFileSync(tmpFile, Buffer.from([0xff, 0xd8, 0xff]));
  try {
    const r = await uploadOrderPhotoFromPath('ord_x', tmpFile);
    assert.match(r.photoFileName, /^[a-zA-Z0-9._-]+$/);
  } finally {
    cleanup(dir);
  }
});

// ── Summary formatting ───────────────────────────────────────────────────────

test('formatRecoverySummary: includes id, child, format, payment status', () => {
  const text = formatRecoverySummary({
    orderId: 'ord_xyz',
    childName: 'Mia',
    bookFormat: 'classic',
    paymentStatus: 'paid',
    photoBlobPath: 'orders/ord_xyz/photo-x.jpg',
    photoFileName: 'x.jpg',
    shippingPersisted: true,
    stripeSessionId: 'cs_abc',
    warnings: ['heads up'],
  });
  assert.match(text, /ord_xyz/);
  assert.match(text, /Mia/);
  assert.match(text, /classic/);
  assert.match(text, /paid/);
  assert.match(text, /heads up/);
});
