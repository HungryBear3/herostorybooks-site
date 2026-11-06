import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildRecoveryOrderRecord,
  invalidRecoveryInputMessage,
  recoverOrder,
  formatRecoverySummary,
  uploadOrderPhotoFromPath,
  type RecoveryInput,
} from '../src/lib/order-recovery.ts';
import { createOrderRecord, getOrder, persistNewOrder, persistOrder } from '../src/lib/orders.ts';

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
    id: 'ord_synthetic_recovery_identity',
    childName: 'Testkid',
    theme: 'dinosaur-discovery',
    bookFormat: 'classic',
    email: 'recovery-fixture@example.invalid',
  });
  assert.equal(r.id, 'ord_synthetic_recovery_identity');
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
  assert.equal(r.priceCents, 1900);
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

test('recoverOrder: refuses an existing order and preserves its auto fulfillment mode', async () => {
  const dir = makeTmp();
  try {
    const existing = createOrderRecord(
      {
        childName: 'Existing',
        bookFormat: 'digital',
        email: 'existing@example.com',
      },
      {
        id: 'ord_existing_auto',
        fulfillmentMode: 'auto',
      },
    );
    await persistOrder(existing);

    await assert.rejects(
      recoverOrder({
        id: existing.id,
        childName: 'Replacement',
        bookFormat: 'digital',
        email: 'replacement@example.com',
      }),
      /already exists; recovery refuses to overwrite/,
    );

    const after = await getOrder(existing.id);
    assert.ok(after);
    assert.equal(after.fulfillmentMode, 'auto');
    assert.equal(after.childName, 'Existing');
    assert.equal(after.paymentStatus, 'pending');
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

// Private contact: synthetic input through the real builder and store boundary.

const CONTACT_NAME = 'Quill Recoveree';
const CONTACT_PHONE = '+13125550177';
const CONTACT_ADDRESS = { line1: '10 Synthetic Way', line2: 'Unit 2', city: 'Testville', state: 'IL', zip: '60601', country: 'US' };

test('buildRecoveryOrderRecord: keeps only the address, whatever contact the input carries', async () => {
  const dir = makeTmp();
  try {
    const id = 'ord_recovery_contact';
    const input: RecoveryInput = {
      id,
      childName: 'Mia',
      bookFormat: 'classic',
      email: 'a@b.com',
      stripeSessionId: 'cs_test_recovery_contact',
      shippingAddress: {
        ...CONTACT_ADDRESS,
        name: CONTACT_NAME,
        phone: CONTACT_PHONE,
        recipientPhone: CONTACT_PHONE,
        attention: CONTACT_NAME,
      } as RecoveryInput['shippingAddress'],
      ...{ name: CONTACT_NAME, phone: CONTACT_PHONE },
    };
    const record = buildRecoveryOrderRecord(input);
    assert.deepEqual(record.shippingAddress, CONTACT_ADDRESS);
    await persistNewOrder(record);
    const raw = readFileSync(path.join(dir, `${id}.json`), 'utf8');
    for (const text of [JSON.stringify(record), raw]) {
      assert.equal(text.includes(CONTACT_NAME), false);
      assert.equal(text.includes(CONTACT_PHONE), false);
    }
    assert.deepEqual((await getOrder(id))?.shippingAddress, CONTACT_ADDRESS);
  } finally {
    cleanup(dir);
  }
});

test('invalid recovery input log: fixed text and position only, never the raw entry or parser text', () => {
  assert.equal(invalidRecoveryInputMessage(2), 'Skipping invalid input #3 (missing id/childName/email/bookFormat)');
  const script = readFileSync('scripts/recover-orders.ts', 'utf8');
  assert.doesNotMatch(script, /JSON\.stringify/);
  assert.match(script, /console\.error\(invalidRecoveryInputMessage\(index\)\)/);
  assert.match(script, /Could not parse \$\{configPath\}: expected a JSON array of recovery inputs/);
  assert.doesNotMatch(script, /Could not parse[^\n]*err/);
});
