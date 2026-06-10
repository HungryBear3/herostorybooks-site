/**
 * Manual Fulfillment Factory — Phase 3 admin path.
 *
 * Proves the three operations (register artifact / set QA / mark proof ready),
 * the blob-ref-only ledger, and — critically — that a manual order CANNOT reach
 * customer release through the legacy releaseOrderAfterQa path without the new
 * manifest gate, while auto/legacy orders stay backward-compatible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, persistOrder, getOrder } from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import type { OrderArtifactManifest, ArtifactRecord } from '../src/lib/fulfillment-types.ts';
import {
  isApprovedBlobUrl,
  registerManualArtifact,
  setManualQaReport,
  markManualProofReady,
} from '../src/lib/manual-artifact-factory.ts';
import { releaseOrderAfterQa } from '../src/lib/admin-actions.ts';
import { buildOrderStatusView } from '../src/lib/order-status-view.ts';

const BLOB = 'https://abc123.public.blob.vercel-storage.com';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-manual-factory-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
}

async function seed(overrides: Partial<OrderRecord>, id: string): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: overrides.bookFormat ?? 'digital', email: 'luna@example.com' },
    { id, now: '2026-06-10T00:00:00Z' },
  );
  const order: OrderRecord = { ...base, paymentStatus: 'paid', ...overrides };
  await persistOrder(order);
  return order;
}

function rec(source: ArtifactRecord['source'] = 'operator_upload', file = 'a.bin'): ArtifactRecord {
  return { url: `${BLOB}/${file}`, source, producedAt: '2026-06-10T00:00:00Z', producedBy: 'alexy' };
}

function completeManifest(orderId: string): OrderArtifactManifest {
  return {
    schemaVersion: 1,
    orderId,
    createdAt: '2026-06-10T00:00:00Z',
    updatedAt: '2026-06-10T00:00:00Z',
    generatedBy: 'operator',
    storyBrief: rec(),
    pagePlan: rec(),
    proseFinal: rec('operator_upload', 'prose.txt'),
    artDirectionPacket: rec('operator_upload', 'art.json'),
    pageImages: { 1: rec('operator_upload', 'p1.png'), 2: rec('operator_upload', 'p2.png') },
    proofPdf: rec('operator_upload', 'proof.pdf'),
    qaReport: {
      passed: true,
      reviewedAt: '2026-06-10T01:00:00Z',
      reviewedBy: 'alexy',
      notes: 'ok',
      checks: {
        noTemplateSource: true,
        allPageImagesPresent: true,
        proofPdfPresent: true,
        artDirectionPacketPresent: true,
        proseFinalPresent: true,
      },
    },
  };
}

// ── Blob-ref validation (B, blob-ref tests) ──────────────────────────────────

test('isApprovedBlobUrl: rejects data:, base64, external; accepts approved blob', () => {
  assert.equal(isApprovedBlobUrl(`${BLOB}/x.png`), true);
  assert.equal(isApprovedBlobUrl('data:image/png;base64,iVBORw0KGgo='), false);
  assert.equal(isApprovedBlobUrl('data:text/plain,hello'), false);
  assert.equal(isApprovedBlobUrl('https://evil.example.com/x.png'), false);
  assert.equal(isApprovedBlobUrl('https://abc.blob.vercel-storage.com/x.png'), false); // not .public.
  assert.equal(isApprovedBlobUrl('ftp://abc123.public.blob.vercel-storage.com/x'), false);
  assert.equal(isApprovedBlobUrl(''), false);
  assert.equal(isApprovedBlobUrl(undefined), false);
});

test('registerManualArtifact rejects data:/base64/external URLs at the write boundary', async () => {
  const dir = makeTmp();
  try {
    await seed({ fulfillmentStatus: 'manual_generation_required' }, 'ord_url');
    for (const bad of ['data:image/png;base64,AAAA', 'https://evil.com/p.png', 'not-a-url']) {
      const r = await registerManualArtifact('ord_url', {
        slot: 'proofPdf', url: bad, source: 'operator_upload', producedBy: 'alexy',
      });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.status, 400);
      assert.equal(r.code, 'invalid_artifact_url');
    }
  } finally { cleanup(dir); }
});

test('registerManualArtifact stores a blob REF (no raw bytes/base64) and advances status', async () => {
  const dir = makeTmp();
  try {
    await seed({ fulfillmentStatus: 'manual_generation_required' }, 'ord_reg');
    const r = await registerManualArtifact('ord_reg', {
      slot: 'proofPdf', url: `${BLOB}/proof.pdf`, source: 'operator_upload', producedBy: 'alexy', checksum: 'sha256:abc',
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.fulfillmentStatus, 'generation_in_progress');
    const after = await getOrder('ord_reg');
    assert.equal(after?.artifactManifest?.proofPdf?.url, `${BLOB}/proof.pdf`);
    assert.equal(after?.artifactManifest?.proofPdf?.checksum, 'sha256:abc');
    // No raw image bytes / base64 / data URIs anywhere in the serialized order.
    const serialized = readFileSync(path.join(process.env.HSB_ORDER_STORE_DIR!, 'ord_reg.json'), 'utf8');
    assert.doesNotMatch(serialized, /;base64,/i);
    assert.doesNotMatch(serialized, /data:image\//i);
  } finally { cleanup(dir); }
});

// ── Gate wired: mark proof ready (D, gate tests) ─────────────────────────────

test('markManualProofReady: 422 with reasons when manifest incomplete', async () => {
  const dir = makeTmp();
  try {
    await seed({ fulfillmentStatus: 'proof_ready_for_internal_qa' }, 'ord_incomplete');
    const r = await markManualProofReady('ord_incomplete');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 422);
    assert.equal(r.code, 'manifest_not_proof_ready');
    assert.ok((r.reasons ?? []).includes('manifest_missing'));
    const after = await getOrder('ord_incomplete');
    assert.notEqual(after?.fulfillmentStatus, 'proof_ready_for_customer');
  } finally { cleanup(dir); }
});

test('markManualProofReady: succeeds ONLY when manifest complete; no email/token/storyArtifactUrl', async () => {
  const dir = makeTmp();
  try {
    await seed({ fulfillmentStatus: 'proof_ready_for_internal_qa', artifactManifest: completeManifest('ord_ok') }, 'ord_ok');
    const r = await markManualProofReady('ord_ok');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.fulfillmentStatus, 'proof_ready_for_customer');
    const after = await getOrder('ord_ok');
    assert.equal(after?.fulfillmentStatus, 'proof_ready_for_customer');
    // No customer-release side effects in this slice.
    assert.equal(after?.storyArtifactUrl ?? null, null);
    assert.equal(after?.proofApprovalToken ?? null, null);
    assert.equal(after?.customerProofReleasedAt ?? null, null);
  } finally { cleanup(dir); }
});

const BLOCK_CASES: { name: string; mutate: (m: OrderArtifactManifest) => void; reason: string }[] = [
  { name: 'template source', mutate: (m) => { m.proseFinal = rec('template', 'prose.txt'); }, reason: 'template_source_present' },
  { name: 'template_after_openai_failure source', mutate: (m) => { m.pageImages = { 1: rec('template_after_openai_failure', 'p1.png') }; }, reason: 'template_source_present' },
  { name: 'missing prose', mutate: (m) => { m.proseFinal = null; }, reason: 'prose_final_missing' },
  { name: 'missing art direction packet', mutate: (m) => { m.artDirectionPacket = null; }, reason: 'art_direction_packet_missing' },
  { name: 'missing page images', mutate: (m) => { m.pageImages = {}; }, reason: 'page_images_missing' },
  { name: 'missing proof pdf', mutate: (m) => { m.proofPdf = null; }, reason: 'proof_pdf_missing' },
  { name: 'missing QA report', mutate: (m) => { m.qaReport = null; }, reason: 'qa_report_missing' },
  { name: 'QA not passed', mutate: (m) => { m.qaReport!.passed = false; }, reason: 'qa_report_not_passed' },
];

for (const c of BLOCK_CASES) {
  test(`markManualProofReady blocks: ${c.name} → 422 (${c.reason})`, async () => {
    const dir = makeTmp();
    try {
      const m = completeManifest('ord_block');
      c.mutate(m);
      await seed({ fulfillmentStatus: 'proof_ready_for_internal_qa', artifactManifest: m }, 'ord_block');
      const r = await markManualProofReady('ord_block');
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.status, 422);
      assert.ok((r.reasons ?? []).includes(c.reason), `expected reason ${c.reason}, got ${(r.reasons ?? []).join(',')}`);
    } finally { cleanup(dir); }
  });
}

// ── QA report (C) ─────────────────────────────────────────────────────────────

test('setManualQaReport requires an existing manifest, then records the report', async () => {
  const dir = makeTmp();
  try {
    await seed({ fulfillmentStatus: 'generation_in_progress' }, 'ord_qa_none');
    const none = await setManualQaReport('ord_qa_none', {
      passed: true, reviewedBy: 'alexy',
      checks: { noTemplateSource: true, allPageImagesPresent: true, proofPdfPresent: true, artDirectionPacketPresent: true, proseFinalPresent: true },
    });
    assert.equal(none.ok, false);
    if (none.ok) return;
    assert.equal(none.code, 'manifest_missing');

    const m = completeManifest('ord_qa');
    m.qaReport = null;
    await seed({ fulfillmentStatus: 'generation_in_progress', artifactManifest: m }, 'ord_qa');
    const r = await setManualQaReport('ord_qa', {
      passed: true, reviewedBy: 'alexy', notes: 'looks good',
      checks: { noTemplateSource: true, allPageImagesPresent: true, proofPdfPresent: true, artDirectionPacketPresent: true, proseFinalPresent: true },
    });
    assert.equal(r.ok, true);
    const after = await getOrder('ord_qa');
    assert.equal(after?.artifactManifest?.qaReport?.passed, true);
    assert.equal(after?.fulfillmentStatus, 'proof_ready_for_internal_qa');
  } finally { cleanup(dir); }
});

// ── Existing-path boundary (E / test 7) ──────────────────────────────────────

test('manual order CANNOT release via legacy releaseOrderAfterQa — refused, email never sent', async () => {
  const dir = makeTmp();
  try {
    // A manual order, even if maliciously/accidentally put in awaiting_qa with a
    // story artifact, must be refused by the manifest boundary — and no email.
    await seed({
      fulfillmentStatus: 'awaiting_qa',
      storyArtifactUrl: `${BLOB}/legacy-proof.pdf`,
      artifactManifest: completeManifest('ord_boundary'),
    }, 'ord_boundary');

    let proofEmails = 0;
    let digitalEmails = 0;
    const r = await releaseOrderAfterQa('ord_boundary', {
      qaPassBy: 'alexy',
      checklist: { childLikeness: true, noArtifacts: true, textAccuracy: true, pageOrder: true },
    }, {
      sendProofReadyEmail: async () => { proofEmails += 1; },
      sendDigitalDeliveryEmail: async () => { digitalEmails += 1; },
    });

    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.failureCode, 'MANUAL_ORDER_USES_MANIFEST_PATH');
    assert.equal(proofEmails, 0, 'no proof email for a manual order');
    assert.equal(digitalEmails, 0, 'no digital delivery email for a manual order');
  } finally { cleanup(dir); }
});

test('auto/legacy order (no manifest) is unaffected by the manual boundary guard', async () => {
  const dir = makeTmp();
  try {
    await seed({ fulfillmentStatus: 'awaiting_qa', storyArtifactUrl: `${BLOB}/p.pdf` }, 'ord_auto');
    let proofEmails = 0;
    const r = await releaseOrderAfterQa('ord_auto', {
      qaPassBy: 'alexy',
      checklist: { childLikeness: true, noArtifacts: true, textAccuracy: true, pageOrder: true },
    }, { sendProofReadyEmail: async () => { proofEmails += 1; }, sendDigitalDeliveryEmail: async () => { proofEmails += 1; } });
    // It may still refuse for a pre-existing reason (e.g. missing route decision),
    // but it must NOT be the manual-boundary refusal — the guard is transparent
    // to non-manual orders.
    if (r.ok === false) {
      assert.notEqual(r.failureCode, 'MANUAL_ORDER_USES_MANIFEST_PATH');
    }
  } finally { cleanup(dir); }
});

// ── Status copy honesty (test 8) ──────────────────────────────────────────────

test('new manual states render honest order-status copy; customer-ready exposes no link', async () => {
  const dir = makeTmp();
  try {
    for (const status of ['manual_generation_required', 'generation_in_progress', 'proof_ready_for_internal_qa'] as const) {
      const order = await seed({ fulfillmentStatus: status }, `ord_st_${status}`);
      const view = buildOrderStatusView(order);
      assert.match(view.subhead, /being crafted|email you/i);
      assert.equal(view.primaryAction ?? null, null, `${status} must not expose a proof link`);
    }
    const order = await seed({ fulfillmentStatus: 'proof_ready_for_customer' }, 'ord_st_ready');
    const view = buildOrderStatusView(order);
    assert.match(view.subhead, /email you/i);
    assert.equal(view.primaryAction ?? null, null, 'no review link exists in this phase');
  } finally { cleanup(dir); }
});

// ── Scope guard (test 9) ──────────────────────────────────────────────────────

test('manual-artifact-factory module imports no Stripe / Lulu / RPI / email / print transports', () => {
  const src = readFileSync('src/lib/manual-artifact-factory.ts', 'utf8');
  // Inspect only actual import statements + code (strip line/block comments) so
  // the header's "no Stripe/Lulu/RPI" prose can't false-positive.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  const importLines = code.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
  assert.doesNotMatch(importLines, /stripe/i);
  assert.doesNotMatch(importLines, /order-email/i);
  assert.doesNotMatch(importLines, /lulu|\brpi\b/i);
  assert.doesNotMatch(importLines, /print|fulfillment/i);
  // No transport call sites anywhere in code.
  assert.doesNotMatch(code, /sendProofReadyEmail|sendDigitalDeliveryEmail|runPrintProduction|submitPrint|stripe\./i);
});
