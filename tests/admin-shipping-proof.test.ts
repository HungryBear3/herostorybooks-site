import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, persistOrder, getOrder } from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import {
  markOrderShipped,
  resendProofEmail,
  manuallyApproveProof,
  applyLuluStatusUpdate,
} from '../src/lib/admin-actions.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-ops-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

async function seed(overrides: Partial<OrderRecord>, id: string): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: overrides.childName ?? 'Luna', bookFormat: overrides.bookFormat ?? 'classic', email: 'luna@example.com' },
    { id, now: '2026-04-23T10:00:00Z' },
  );
  const order: OrderRecord = { ...base, ...overrides };
  await persistOrder(order);
  return order;
}

// ── markOrderShipped ──────────────────────────────────────────────────────────

test('markOrderShipped: unknown order → 404', async () => {
  const dir = makeTmp();
  try {
    const r = await markOrderShipped('ord_ghost', { trackingNumber: '1Z' });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 404);
  } finally { cleanup(dir); }
});

test('markOrderShipped: digital order → 400', async () => {
  const dir = makeTmp();
  try {
    await seed({ bookFormat: 'digital', paymentStatus: 'paid' }, 'ord_digital_ship');
    const r = await markOrderShipped('ord_digital_ship', { trackingNumber: '1Z' });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
  } finally { cleanup(dir); }
});

test('markOrderShipped: unpaid print order → 400', async () => {
  const dir = makeTmp();
  try {
    await seed({ bookFormat: 'classic', paymentStatus: 'pending' }, 'ord_unpaid_ship');
    const r = await markOrderShipped('ord_unpaid_ship', { trackingNumber: '1Z' });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
  } finally { cleanup(dir); }
});

test('markOrderShipped: paid print order → status shipped + tracking persisted', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'premium',
      paymentStatus: 'paid',
      fulfillmentStatus: 'complete',
      status: 'print_in_production',
    }, 'ord_ship_ok');

    const r = await markOrderShipped('ord_ship_ok', {
      trackingNumber: '9400111202555842761234',
      trackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111',
    });
    assert.equal(r.ok, true);

    const after = await getOrder('ord_ship_ok');
    assert.equal(after?.status, 'shipped');
    assert.equal(after?.trackingNumber, '9400111202555842761234');
    assert.ok(after?.trackingUrl?.includes('usps.com'));
    assert.ok(after?.shippedAt);
  } finally { cleanup(dir); }
});

// ── resendProofEmail ──────────────────────────────────────────────────────────

test('resendProofEmail: unknown order → 404', async () => {
  const dir = makeTmp();
  try {
    const r = await resendProofEmail('ord_ghost', 'https://herostorybooks.com');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 404);
  } finally { cleanup(dir); }
});

test('resendProofEmail: no proof yet → 409', async () => {
  const dir = makeTmp();
  try {
    await seed({ bookFormat: 'classic', paymentStatus: 'paid' }, 'ord_no_proof');
    const r = await resendProofEmail('ord_no_proof', 'https://h.com');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
  } finally { cleanup(dir); }
});

test('resendProofEmail: proof_ready state without provider key fails closed and retains claim', async () => {
  const dir = makeTmp();
  try {
    delete process.env.HSB_RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'proof_ready',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      proofApprovalToken: 'tok_abc',
    }, 'ord_proof_ready');

    const r = await resendProofEmail('ord_proof_ready', 'https://h.com');
    assert.equal(r.ok, false);
    const persisted = await getOrder('ord_proof_ready');
    assert.ok(persisted?.emailResendClaimId);
  } finally { cleanup(dir); }
});

test('resendProofEmail: concurrent requests send exactly once', async (t) => {
  const dir = makeTmp();
  const originalFetch = globalThis.fetch;
  process.env.HSB_RESEND_API_KEY = 're_test_stub';
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ id: 'proof_once' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; cleanup(dir); });
  await seed({
    bookFormat: 'classic',
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
    proofApprovalToken: 'tok_once',
  }, 'ord_proof_once');

  const results = await Promise.all([
    resendProofEmail('ord_proof_once', 'https://h.com'),
    resendProofEmail('ord_proof_once', 'https://h.com'),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(calls, 1);
  const after = await getOrder('ord_proof_once');
  assert.equal(after?.emailResendClaimId ?? null, null);
});

// ── manuallyApproveProof ──────────────────────────────────────────────────────

test('manuallyApproveProof: rejects order not in proof_ready state', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'generating_story',
    }, 'ord_not_ready');
    const r = await manuallyApproveProof('ord_not_ready');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
  } finally { cleanup(dir); }
});

// ── applyLuluStatusUpdate ─────────────────────────────────────────────────────

test('applyLuluStatusUpdate: resolves order by external_id and applies SHIPPED', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'complete',
      status: 'print_in_production',
      printJobId: 'lulu-12345',
    }, 'ord_lulu_ship');

    const r = await applyLuluStatusUpdate({
      topic: 'PRINT_JOB_STATUS_CHANGED',
      data: {
        id: 12345,
        external_id: 'ord_lulu_ship',
        status: { name: 'SHIPPED' },
        line_items: [{ tracking_id: 'FX123456', tracking_urls: ['https://fedex.com/t/FX123456'] }],
      },
    });

    assert.equal(r.ok, true);
    const after = await getOrder('ord_lulu_ship');
    assert.equal(after?.status, 'shipped');
    assert.equal(after?.printJobStatus, 'SHIPPED');
    assert.equal(after?.trackingNumber, 'FX123456');
    assert.ok(after?.trackingUrl?.includes('fedex.com'));
    assert.ok(after?.shippedAt);
  } finally { cleanup(dir); }
});

test('applyLuluStatusUpdate: IN_PRODUCTION → print_in_production status', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'complete',
      printJobId: 'lulu-999',
    }, 'ord_lulu_prod');

    const r = await applyLuluStatusUpdate({
      data: { external_id: 'ord_lulu_prod', status: 'IN_PRODUCTION' },
    });

    assert.equal(r.ok, true);
    const after = await getOrder('ord_lulu_prod');
    assert.equal(after?.status, 'print_in_production');
    assert.equal(after?.printJobStatus, 'IN_PRODUCTION');
  } finally { cleanup(dir); }
});

test('applyLuluStatusUpdate: REJECTED → failed_manual_review', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'complete',
      printJobId: 'lulu-reject',
    }, 'ord_lulu_reject');

    const r = await applyLuluStatusUpdate({
      data: { external_id: 'ord_lulu_reject', status: { name: 'REJECTED' } },
    });

    assert.equal(r.ok, true);
    const after = await getOrder('ord_lulu_reject');
    assert.equal(after?.fulfillmentStatus, 'failed_manual_review');
    assert.match(after?.fulfillmentLastError ?? '', /REJECTED/);
  } finally { cleanup(dir); }
});

test('applyLuluStatusUpdate: resolves order via printJobId when external_id missing', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      printJobId: 'lulu-by-jobid',
    }, 'ord_by_jobid');

    const r = await applyLuluStatusUpdate(
      { data: { id: 'lulu-by-jobid', status: 'IN_PRODUCTION' } },
      async (jobId) => jobId === 'lulu-by-jobid' ? 'ord_by_jobid' : null,
    );

    assert.equal(r.ok, true);
    const after = await getOrder('ord_by_jobid');
    assert.equal(after?.status, 'print_in_production');
  } finally { cleanup(dir); }
});

test('applyLuluStatusUpdate: unresolvable → 404', async () => {
  const dir = makeTmp();
  try {
    const r = await applyLuluStatusUpdate({ data: { status: 'IN_PRODUCTION' } });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 404);
  } finally { cleanup(dir); }
});
