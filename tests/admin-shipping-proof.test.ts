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
  releaseOrderAfterQa,
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

test('resendProofEmail: proof_ready state → ok (email skipped without key)', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'proof_ready',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      proofApprovalToken: 'tok_abc',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'admin',
      qaStatus: 'passed',
      qaReviewer: 'admin',
      // Generation Operating Policy §5 — resend now re-runs the manifest
      // guard, so the order must look policy-clean before any email goes.
      ...policyReadyOverrides(),
      shippingAddress: { line1: '1 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
    }, 'ord_proof_ready');

    const r = await resendProofEmail('ord_proof_ready', 'https://h.com');
    assert.equal(r.ok, true, !r.ok ? r.error : '');
  } finally { cleanup(dir); }
});

// ── releaseOrderAfterQa ──────────────────────────────────────────────────────

const COMPLETE_CHECKLIST = {
  storyReviewed: true,
  imagesReviewed: true,
  proofArtifactReviewed: true,
  customerSafe: true,
  noPrintRelease: true,
};

/**
 * Minimum order overrides required by the Generation Operating Policy
 * release guard: non-fallback storyMeta, at least one page with a
 * non-fixture provider, source photo + personalization inputs present.
 * Tests that exercise the happy-path release must merge this in.
 */
function policyReadyOverrides(): Partial<OrderRecord> {
  return {
    theme: 'dinosaur-discovery',
    photoBlobUrl: 'https://example.com/photos/luna.jpg',
    photoBlobPath: 'orders/test/photo.jpg',
    photoFileName: 'luna.jpg',
    // Default to the manual / Abby subscription route per the Generation
    // Operating Policy. OPENAI_API would require apiFallbackEnabled=true
    // + per-order apiAuthorizedBy/At, which these tests don't model.
    storyMeta: {
      source: 'manual',
      model: 'abby:manual-subscription',
      generatedAt: '2026-05-31T19:00:00.000Z',
      fallbackError: null,
    },
    pageArtifacts: [
      {
        pageIndex: 0,
        storyText: 'Once upon a time…',
        basePrompt: 'p1',
        currentImageUrl: 'https://example.com/p1.png',
        generationProvider: 'manual',
        generationModel: 'abby:manual-subscription',
        generationConditioning: 'photo_edit',
        regenerateCount: 0,
        accepted: false,
        feedbackHistory: [],
        versionHistory: [],
      },
    ],
  };
}

test('releaseOrderAfterQa: rejects incomplete checklist', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      fulfillmentStatus: 'awaiting_qa',
      storyArtifactUrl: 'https://cdn.example.com/book.pdf',
    }, 'ord_qa_incomplete');

    const r = await releaseOrderAfterQa('ord_qa_incomplete', {
      qaPassBy: 'ops',
      checklist: { storyReviewed: true },
    });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);

    const after = await getOrder('ord_qa_incomplete');
    assert.equal(after?.fulfillmentStatus, 'awaiting_qa');
    assert.equal(after?.qaPassAt, undefined);
  } finally { cleanup(dir); }
});

test('releaseOrderAfterQa: digital awaiting_qa records QA and sends delivery email', async () => {
  const dir = makeTmp();
  try {
    let emailCalls = 0;
    await seed({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      fulfillmentStatus: 'awaiting_qa',
      storyArtifactUrl: 'https://cdn.example.com/book.pdf',
      ...policyReadyOverrides(),
    }, 'ord_qa_digital');

    const r = await releaseOrderAfterQa('ord_qa_digital', {
      qaPassBy: 'ops@example.com',
      checklist: COMPLETE_CHECKLIST,
    }, {
      now: () => '2026-05-31T21:00:00.000Z',
      sendDigitalDeliveryEmail: async (_order, options) => {
        emailCalls += 1;
        assert.equal(options.pdfUrl, 'https://cdn.example.com/book.pdf');
      },
    });

    assert.equal(r.ok, true);
    assert.equal(emailCalls, 1);
    const after = await getOrder('ord_qa_digital');
    assert.equal(after?.fulfillmentStatus, 'complete');
    assert.equal(after?.qaPassAt, '2026-05-31T21:00:00.000Z');
    assert.equal(after?.qaPassBy, 'ops@example.com');
    assert.equal(after?.auditEvents?.at(-1)?.type, 'qa_pass_recorded');
  } finally { cleanup(dir); }
});

test('releaseOrderAfterQa: print awaiting_qa creates token and sends proof email without print release', async () => {
  const dir = makeTmp();
  try {
    let emailCalls = 0;
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'awaiting_qa',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      ...policyReadyOverrides(),
      shippingAddress: { line1: '1 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
    }, 'ord_qa_print');

    const r = await releaseOrderAfterQa('ord_qa_print', {
      qaPassBy: 'ops',
      checklist: COMPLETE_CHECKLIST,
    }, {
      now: () => '2026-05-31T21:05:00.000Z',
      createProofToken: () => 'tok_qa_release',
      getBaseUrl: () => 'https://herostorybooks.com',
      sendProofReadyEmail: async (_order, options) => {
        emailCalls += 1;
        assert.equal(options.proofUrl, 'https://cdn.example.com/proof.pdf');
        assert.equal(options.reviewUrl, 'https://herostorybooks.com/review/ord_qa_print?token=tok_qa_release');
      },
    });

    assert.equal(r.ok, true);
    assert.equal(emailCalls, 1);
    const after = await getOrder('ord_qa_print');
    assert.equal(after?.fulfillmentStatus, 'proof_ready');
    assert.equal(after?.status, 'preview_ready');
    assert.equal(after?.proofApprovalToken, 'tok_qa_release');
    assert.equal(after?.printJobId, undefined);
    assert.equal(after?.printJobStatus, undefined);
    assert.equal(after?.qaPassAt, '2026-05-31T21:05:00.000Z');
  } finally { cleanup(dir); }
});

test('releaseOrderAfterQa: rejects template_after_openai_failure for digital — no email, no state advance', async () => {
  const dir = makeTmp();
  try {
    let digitalEmailCalls = 0;
    let proofEmailCalls = 0;
    await seed({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      fulfillmentStatus: 'awaiting_qa',
      storyArtifactUrl: 'https://cdn.example.com/book.pdf',
      storyMeta: {
        source: 'template_after_openai_failure',
        model: 'template:Quest',
        generatedAt: '2026-05-31T20:00:00.000Z',
        fallbackError: 'fetch failed',
      },
    }, 'ord_qa_tpl_digital');

    const r = await releaseOrderAfterQa('ord_qa_tpl_digital', {
      qaPassBy: 'ops@example.com',
      checklist: COMPLETE_CHECKLIST,
    }, {
      now: () => '2026-05-31T22:00:00.000Z',
      sendDigitalDeliveryEmail: async () => { digitalEmailCalls += 1; },
      sendProofReadyEmail: async () => { proofEmailCalls += 1; },
    });

    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
    assert.match(!r.ok ? r.error : '', /template fallback/);

    // No customer email sent.
    assert.equal(digitalEmailCalls, 0);
    assert.equal(proofEmailCalls, 0);

    // State did NOT advance.
    const after = await getOrder('ord_qa_tpl_digital');
    assert.equal(after?.fulfillmentStatus, 'awaiting_qa');
    assert.notEqual(after?.fulfillmentStatus, 'complete');
    assert.equal(after?.qaPassAt, undefined);
    assert.equal(after?.qaPassBy, undefined);
    // No qa_pass_recorded audit event written.
    assert.equal(
      (after?.auditEvents ?? []).some((ev) => ev.type === 'qa_pass_recorded'),
      false,
    );
  } finally { cleanup(dir); }
});

test('releaseOrderAfterQa: rejects template_after_openai_failure for print — no email, no proof_ready, no token', async () => {
  const dir = makeTmp();
  try {
    let proofEmailCalls = 0;
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'awaiting_qa',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      storyMeta: {
        source: 'template_after_openai_failure',
        model: 'template:Quest',
        generatedAt: '2026-05-31T20:00:00.000Z',
        fallbackError: 'fetch failed',
      },
    }, 'ord_qa_tpl_print');

    const r = await releaseOrderAfterQa('ord_qa_tpl_print', {
      qaPassBy: 'ops@example.com',
      checklist: COMPLETE_CHECKLIST,
    }, {
      now: () => '2026-05-31T22:05:00.000Z',
      createProofToken: () => 'tok_should_not_be_minted',
      sendProofReadyEmail: async () => { proofEmailCalls += 1; },
    });

    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
    assert.match(!r.ok ? r.error : '', /template fallback/);

    assert.equal(proofEmailCalls, 0);

    const after = await getOrder('ord_qa_tpl_print');
    assert.equal(after?.fulfillmentStatus, 'awaiting_qa');
    assert.notEqual(after?.fulfillmentStatus, 'proof_ready');
    assert.equal(after?.qaPassAt, undefined);
    assert.equal(after?.proofApprovalToken, undefined);
  } finally { cleanup(dir); }
});

test('releaseOrderAfterQa: allows normal QA pass when storyMeta source is non-fallback', async () => {
  const dir = makeTmp();
  try {
    let emailCalls = 0;
    await seed({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      fulfillmentStatus: 'awaiting_qa',
      storyArtifactUrl: 'https://cdn.example.com/book.pdf',
      ...policyReadyOverrides(),
    }, 'ord_qa_chat_ok');

    const r = await releaseOrderAfterQa('ord_qa_chat_ok', {
      qaPassBy: 'ops@example.com',
      checklist: COMPLETE_CHECKLIST,
    }, {
      now: () => '2026-05-31T22:10:00.000Z',
      sendDigitalDeliveryEmail: async () => { emailCalls += 1; },
    });

    assert.equal(r.ok, true);
    assert.equal(emailCalls, 1);
    const after = await getOrder('ord_qa_chat_ok');
    assert.equal(after?.fulfillmentStatus, 'complete');
    assert.equal(after?.qaPassAt, '2026-05-31T22:10:00.000Z');
  } finally { cleanup(dir); }
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

// ── Follow-up regression tests (post-42d03e6 blockers) ────────────────────────

import { resendDigitalDelivery } from '../src/lib/admin-actions.ts';

test('resendDigitalDelivery: refuses unsafe manifest (template fallback story)', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      fulfillmentStatus: 'delivery_email_failed',
      storyArtifactUrl: 'https://cdn.example.com/book.pdf',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'admin',
      qaStatus: 'passed',
      qaReviewer: 'admin',
      ...policyReadyOverrides(),
      storyMeta: {
        source: 'template_after_openai_failure',
        model: 'template:Quest',
        generatedAt: '2026-05-31T20:00:00.000Z',
        fallbackError: 'fetch failed',
      },
    }, 'ord_resend_digital_tpl');
    const r = await resendDigitalDelivery('ord_resend_digital_tpl');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
    assert.match(!r.ok ? r.error : '', /TEMPLATE_STORY_BLOCKED/);
    // No state-flip to complete — manifest guard refused before the email send.
    const after = await getOrder('ord_resend_digital_tpl');
    assert.notEqual(after?.fulfillmentStatus, 'complete');
    // Audit event recorded.
    assert.ok(
      (after?.auditEvents ?? []).some(
        (ev) => ev.type === 'proof_release_failed' && ev.meta?.source === 'resendDigitalDelivery',
      ),
      'proof_release_failed audit event must be appended on resend refusal',
    );
  } finally { cleanup(dir); }
});

test('resendDigitalDelivery: refuses unsafe manifest (fixture asset page)', async () => {
  const dir = makeTmp();
  try {
    const overrides = policyReadyOverrides();
    await seed({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      fulfillmentStatus: 'delivery_email_failed',
      storyArtifactUrl: 'https://cdn.example.com/book.pdf',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'admin',
      qaStatus: 'passed',
      qaReviewer: 'admin',
      ...overrides,
      pageArtifacts: [
        { ...overrides.pageArtifacts![0]!, assetSource: 'fixture' },
      ],
    }, 'ord_resend_digital_fixture');
    const r = await resendDigitalDelivery('ord_resend_digital_fixture');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
    assert.match(!r.ok ? r.error : '', /FIXTURE_ASSET_BLOCKED/);
  } finally { cleanup(dir); }
});

test('resendProofEmail: refuses unsafe manifest (template fallback story)', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'proof_ready',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      proofApprovalToken: 'tok_resend',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'admin',
      qaStatus: 'passed',
      qaReviewer: 'admin',
      ...policyReadyOverrides(),
      shippingAddress: { line1: '1 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
      storyMeta: {
        source: 'template_after_openai_failure',
        model: 'template:Quest',
        generatedAt: '2026-05-31T20:00:00.000Z',
        fallbackError: 'fetch failed',
      },
    }, 'ord_resend_proof_tpl');
    const r = await resendProofEmail('ord_resend_proof_tpl', 'https://h.com');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
    assert.match(!r.ok ? r.error : '', /TEMPLATE_STORY_BLOCKED/);
    const after = await getOrder('ord_resend_proof_tpl');
    assert.ok(
      (after?.auditEvents ?? []).some(
        (ev) => ev.type === 'proof_release_failed' && ev.meta?.source === 'resendProofEmail',
      ),
    );
  } finally { cleanup(dir); }
});

test('resendProofEmail: refuses unsafe manifest (fal_edit page without emergency flag)', async () => {
  const dir = makeTmp();
  try {
    const overrides = policyReadyOverrides();
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'proof_ready',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      proofApprovalToken: 'tok_resend_fal',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'admin',
      qaStatus: 'passed',
      qaReviewer: 'admin',
      ...overrides,
      shippingAddress: { line1: '1 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
      pageArtifacts: [
        { ...overrides.pageArtifacts![0]!, generationProvider: 'fal_edit', generationModel: 'fal-ai/bytedance/seedream/v4/edit' },
      ],
      emergencyOverrideUsed: true,
      emergencyApprovedBy: 'alexy',
      emergencyApprovalRef: 'fd-emergency-2026-06-19',
    }, 'ord_resend_proof_fal');
    // Even with order-level approval, default config emergencyImageRoute=false → PROVIDER_ROUTE_BLOCKED.
    const r = await resendProofEmail('ord_resend_proof_fal', 'https://h.com');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
    assert.match(!r.ok ? r.error : '', /PROVIDER_ROUTE_BLOCKED/);
  } finally { cleanup(dir); }
});

// ── retryOrderFulfillment: delivery_email_failed retry path MUST run the release guard ─

import { retryOrderFulfillment } from '../src/lib/admin-actions.ts';

test('retryOrderFulfillment: delivery_email_failed digital + template fallback storyMeta → REFUSED, no email, audit recorded', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      fulfillmentStatus: 'delivery_email_failed',
      storyArtifactUrl: 'https://cdn.example.com/book.pdf',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'admin',
      qaStatus: 'passed',
      qaReviewer: 'admin',
      ...policyReadyOverrides(),
      // Override the policyReady storyMeta with a template-fallback source.
      storyMeta: {
        source: 'template_after_openai_failure',
        model: 'template:Quest',
        generatedAt: '2026-05-31T20:00:00.000Z',
        fallbackError: 'fetch failed',
      },
    }, 'ord_retry_digital_tpl');
    const r = await retryOrderFulfillment('ord_retry_digital_tpl');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
    assert.match(!r.ok ? r.error : '', /TEMPLATE_STORY_BLOCKED/);
    const after = await getOrder('ord_retry_digital_tpl');
    // No state flip to complete.
    assert.notEqual(after?.fulfillmentStatus, 'complete');
    assert.equal(after?.fulfillmentStatus, 'delivery_email_failed');
    assert.ok(
      (after?.auditEvents ?? []).some(
        (ev) => ev.type === 'proof_release_failed' &&
          ev.meta?.source === 'retryOrderFulfillment:delivery_email_failed:digital',
      ),
      'proof_release_failed audit event must be appended on retry refusal (digital)',
    );
  } finally { cleanup(dir); }
});

test('retryOrderFulfillment: delivery_email_failed print + template fallback → REFUSED, no email, no proof_ready flip', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'delivery_email_failed',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      proofApprovalToken: 'tok_retry_tpl',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'admin',
      qaStatus: 'passed',
      qaReviewer: 'admin',
      ...policyReadyOverrides(),
      shippingAddress: { line1: '1 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
      storyMeta: {
        source: 'template_after_openai_failure',
        model: 'template:Quest',
        generatedAt: '2026-05-31T20:00:00.000Z',
        fallbackError: 'fetch failed',
      },
    }, 'ord_retry_print_tpl');
    const r = await retryOrderFulfillment('ord_retry_print_tpl');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
    assert.match(!r.ok ? r.error : '', /TEMPLATE_STORY_BLOCKED/);
    const after = await getOrder('ord_retry_print_tpl');
    assert.notEqual(after?.fulfillmentStatus, 'proof_ready');
    assert.equal(after?.fulfillmentStatus, 'delivery_email_failed');
    assert.ok(
      (after?.auditEvents ?? []).some(
        (ev) => ev.type === 'proof_release_failed' &&
          ev.meta?.source === 'retryOrderFulfillment:delivery_email_failed:print',
      ),
    );
  } finally { cleanup(dir); }
});

test('retryOrderFulfillment: delivery_email_failed digital + fixture-asset page → REFUSED FIXTURE_ASSET_BLOCKED', async () => {
  const dir = makeTmp();
  try {
    const overrides = policyReadyOverrides();
    await seed({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      fulfillmentStatus: 'delivery_email_failed',
      storyArtifactUrl: 'https://cdn.example.com/book.pdf',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'admin',
      qaStatus: 'passed',
      qaReviewer: 'admin',
      ...overrides,
      pageArtifacts: [
        { ...overrides.pageArtifacts![0]!, assetSource: 'fixture' },
      ],
    }, 'ord_retry_digital_fixture');
    const r = await retryOrderFulfillment('ord_retry_digital_fixture');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
    assert.match(!r.ok ? r.error : '', /FIXTURE_ASSET_BLOCKED/);
    const after = await getOrder('ord_retry_digital_fixture');
    assert.notEqual(after?.fulfillmentStatus, 'complete');
  } finally { cleanup(dir); }
});

test('retryOrderFulfillment: delivery_email_failed digital + missing-lineage page → REFUSED MISSING_LINEAGE', async () => {
  const dir = makeTmp();
  try {
    const overrides = policyReadyOverrides();
    await seed({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      fulfillmentStatus: 'delivery_email_failed',
      storyArtifactUrl: 'https://cdn.example.com/book.pdf',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'admin',
      qaStatus: 'passed',
      qaReviewer: 'admin',
      ...overrides,
      pageArtifacts: [
        { ...overrides.pageArtifacts![0]!, generationProvider: null },
      ],
    }, 'ord_retry_digital_lineage');
    const r = await retryOrderFulfillment('ord_retry_digital_lineage');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
    assert.match(!r.ok ? r.error : '', /MISSING_LINEAGE/);
  } finally { cleanup(dir); }
});

test('retryOrderFulfillment: delivery_email_failed digital + unknown provider → REFUSED MISSING_LINEAGE', async () => {
  const dir = makeTmp();
  try {
    const overrides = policyReadyOverrides();
    await seed({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      fulfillmentStatus: 'delivery_email_failed',
      storyArtifactUrl: 'https://cdn.example.com/book.pdf',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'admin',
      qaStatus: 'passed',
      qaReviewer: 'admin',
      ...overrides,
      pageArtifacts: [
        // Unknown provider (not in policy allow-list): must be hard-blocked
        // even with QA passed.
        { ...overrides.pageArtifacts![0]!, generationProvider: 'midjourney' as 'manual' },
      ],
    }, 'ord_retry_digital_unknown');
    const r = await retryOrderFulfillment('ord_retry_digital_unknown');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
    assert.match(!r.ok ? r.error : '', /MISSING_LINEAGE/);
  } finally { cleanup(dir); }
});

test('retryOrderFulfillment: delivery_email_failed without qaPassAt → REFUSED pre-guard (existing behavior)', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      fulfillmentStatus: 'delivery_email_failed',
      storyArtifactUrl: 'https://cdn.example.com/book.pdf',
      // No qaPassAt — the pre-guard "cannot resend before QA pass" check fires.
      ...policyReadyOverrides(),
    }, 'ord_retry_no_qa');
    const r = await retryOrderFulfillment('ord_retry_no_qa');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
    assert.match(!r.ok ? r.error : '', /before QA pass/);
  } finally { cleanup(dir); }
});

test('retryOrderFulfillment: delivery_email_failed digital + clean manifest → ALLOWED, email sent, state advances to complete', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      fulfillmentStatus: 'delivery_email_failed',
      storyArtifactUrl: 'https://cdn.example.com/book.pdf',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'admin',
      qaStatus: 'passed',
      qaReviewer: 'admin',
      ...policyReadyOverrides(),
    }, 'ord_retry_digital_clean');
    const r = await retryOrderFulfillment('ord_retry_digital_clean');
    assert.equal(r.ok, true, !r.ok ? r.error : '');
    const after = await getOrder('ord_retry_digital_clean');
    assert.equal(after?.fulfillmentStatus, 'complete');
    assert.equal(after?.fulfillmentLastError, null);
  } finally { cleanup(dir); }
});

test('retryOrderFulfillment: delivery_email_failed print + clean manifest → ALLOWED, proof email sent, state advances to proof_ready', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'delivery_email_failed',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      proofApprovalToken: 'tok_retry_clean',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'admin',
      qaStatus: 'passed',
      qaReviewer: 'admin',
      ...policyReadyOverrides(),
      shippingAddress: { line1: '1 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
    }, 'ord_retry_print_clean');
    const r = await retryOrderFulfillment('ord_retry_print_clean');
    assert.equal(r.ok, true, !r.ok ? r.error : '');
    const after = await getOrder('ord_retry_print_clean');
    assert.equal(after?.fulfillmentStatus, 'proof_ready');
    assert.equal(after?.fulfillmentLastError, null);
  } finally { cleanup(dir); }
});

// ── G3 owner-go admin route + source assertions ──────────────────────────────

import { recordOwnerPrintGo } from '../src/lib/admin-actions.ts';

test('recordOwnerPrintGo: refuses when fulfillmentStatus is not proof_approved', async () => {
  const dir = makeTmp();
  try {
    // Order is still at proof_ready — customer has not yet clicked
    // approve. Operator-go must refuse before any submitPrint call.
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'proof_ready',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      proofApprovalToken: 'tok_pending',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'admin',
      qaStatus: 'passed',
      qaReviewer: 'admin',
      ...policyReadyOverrides(),
      shippingAddress: { line1: '1 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
    }, 'ord_g3_pre_customer_approve');
    const r = await recordOwnerPrintGo('ord_g3_pre_customer_approve', 'ops@example.com');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
    assert.match(!r.ok ? r.error : '', /customer approval|proof_approved|state/i);
    const after = await getOrder('ord_g3_pre_customer_approve');
    assert.equal(after?.ownerPrintGoAt, undefined);
    assert.equal(after?.printJobId, undefined);
  } finally { cleanup(dir); }
});

test('recordOwnerPrintGo: refuses with empty ownerBy', async () => {
  const dir = makeTmp();
  try {
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'proof_approved',
      proofApprovedAt: '2026-05-31T22:00:00.000Z',
      printApprovedAt: '2026-05-31T22:00:00.000Z',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      proofApprovalToken: 'tok_ok',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'admin',
      qaStatus: 'passed',
      qaReviewer: 'admin',
      ...policyReadyOverrides(),
      shippingAddress: { line1: '1 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
    }, 'ord_g3_blank_owner');
    const r = await recordOwnerPrintGo('ord_g3_blank_owner', '   ');
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : '', /ownerBy/i);
  } finally { cleanup(dir); }
});

test('admin /print-go route: source guarantees admin auth check before recordOwnerPrintGo', async () => {
  // Static source assertion — the route must call isAdminAuthedFromRequest
  // and return 401 before ever invoking recordOwnerPrintGo. We assert the
  // source shape; the runtime auth helper itself is unit-tested elsewhere.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/api/admin/orders/[orderId]/print-go/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(src, /isAdminAuthedFromRequest\(request\)/);
  assert.match(src, /status:\s*401/);
  assert.match(src, /recordOwnerPrintGo\(/);
  // Auth check must appear before the recordOwnerPrintGo call.
  const authIdx = src.indexOf('isAdminAuthedFromRequest');
  const callIdx = src.indexOf('recordOwnerPrintGo(');
  assert.ok(authIdx > -1 && callIdx > -1 && authIdx < callIdx,
    'isAdminAuthedFromRequest must be checked before recordOwnerPrintGo is called');
});

test('admin owner-go UI: detail-client.tsx renders the two-step gate (ack checkbox + confirm dialog) and explicit "customer approval is not enough" copy', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/admin/orders/[orderId]/detail-client.tsx', import.meta.url),
    'utf8',
  );
  // 1. Owner-go panel exists.
  assert.match(src, /data-testid="owner-print-go-panel"/);
  // 2. Explicit "customer approval is not enough" copy is rendered (no
  //    operator can misread the affordance as customer-driven).
  assert.match(src, /[Cc]ustomer approval is not enough/);
  // 3. Two-step gate: an explicit ack checkbox plus a confirm() dialog.
  assert.match(src, /data-testid="owner-print-go-ack"/);
  assert.match(src, /ownerGoAck/);
  assert.match(src, /confirm\(/);
  assert.match(src, /Confirm: record owner print go/);
  // 4. The submit button calls the admin print-go route, not Lulu/RPI directly.
  assert.match(src, /\/api\/admin\/orders\/\$\{props\.orderId\}\/print-go/);
  // 5. Submit button is gated on both eligibility and the ack checkbox.
  assert.match(src, /disabled=\{!eligible \|\| !ownerGoAck/);
});

test('admin owner-go UI: blocker reasons are surfaced when ineligible', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/app/admin/orders/[orderId]/detail-client.tsx', import.meta.url),
    'utf8',
  );
  // Operator must see WHY the action is disabled.
  assert.match(src, /data-testid="owner-print-go-blocked-reasons"/);
  // Each individual blocker reason is enumerated.
  assert.match(src, /customer has not approved the proof/);
  assert.match(src, /QA not passed yet/);
  assert.match(src, /payment not confirmed/);
  assert.match(src, /owner go already recorded/);
  assert.match(src, /print already submitted/);
});

test('no customer-facing source imports recordOwnerPrintGo or submitPrintAfterOwnerGo', async () => {
  // Sanity check: the customer /review route and any customer-facing page
  // MUST NOT import the print-go path. Only admin routes / admin UI may.
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const path = await import('node:path');

  const repoRoot = new URL('../', import.meta.url);
  const srcDir = new URL('src/', repoRoot);

  function walk(dir: URL, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir.pathname, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(new URL(`${entry}/`, dir), out);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  const offenders: Array<{ file: string; reason: string }> = [];
  for (const file of walk(srcDir)) {
    const rel = file.slice(srcDir.pathname.length);
    // Only inspect customer-facing surfaces:
    //   - app/review/** (the customer proof-review surface)
    //   - app/api/order/** (customer order/approve/regenerate routes)
    //   - app/api/recovery/** (customer-facing recovery)
    //   - app/api/webhooks/** (Stripe/Lulu inbound — must not call our
    //     owner-go from a webhook either)
    if (
      !rel.startsWith('app/review/') &&
      !rel.startsWith('app/api/order/') &&
      !rel.startsWith('app/api/recovery/') &&
      !rel.startsWith('app/api/webhooks/')
    ) continue;
    const src = readFileSync(file, 'utf8');
    if (/recordOwnerPrintGo|submitPrintAfterOwnerGo/.test(src)) {
      offenders.push({ file: rel, reason: 'imports/calls owner-go API from a customer-facing surface' });
    }
  }
  assert.equal(
    offenders.length,
    0,
    `customer-facing surfaces must not reach the owner-go path: ${JSON.stringify(offenders)}`,
  );
});
