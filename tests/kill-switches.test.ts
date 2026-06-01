import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getKillSwitchSnapshot,
  isKillSwitchActive,
  updateKillSwitch,
} from '../src/lib/ops-kill-switches.ts';
import { createOrderRecord, getOrder, persistOrder, type OrderRecord } from '../src/lib/orders.ts';
import { releaseOrderAfterQa, recordOwnerPrintGo } from '../src/lib/admin-actions.ts';
import { submitPrintAfterOwnerGo } from '../src/lib/fulfillment.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-ks-'));
  process.env.HSB_ORDER_STORE_DIR = path.join(dir, 'orders');
  process.env.HSB_KILL_SWITCH_STATE_PATH = path.join(dir, 'state', 'kill-switches.json');
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
  delete process.env.HSB_KILL_SWITCH_STATE_PATH;
  delete process.env.HSB_ORDER_ADMIN_KEY;
}

async function seed(overrides: Partial<OrderRecord>, id: string): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: overrides.childName ?? 'Luna', bookFormat: overrides.bookFormat ?? 'classic', email: 'luna@example.com' },
    { id, now: '2026-06-01T12:00:00Z' },
  );
  const order: OrderRecord = { ...base, ...policyReadyOverrides(), ...overrides };
  await persistOrder(order);
  return order;
}

function policyReadyOverrides(): Partial<OrderRecord> {
  return {
    theme: 'dinosaur-discovery',
    photoBlobUrl: 'https://example.com/photos/luna.jpg',
    photoBlobPath: 'orders/test/photo.jpg',
    photoFileName: 'luna.jpg',
    storyMeta: {
      source: 'manual',
      model: 'abby:manual-subscription',
      generatedAt: '2026-06-01T12:00:00.000Z',
      fallbackError: null,
    },
    generationRouteDecision: {
      route: 'manual_safe',
      source: 'manual',
      model: 'abby:manual-subscription',
      decidedAt: '2026-06-01T12:00:00.000Z',
      releasable: true,
      fallbackError: null,
      reason: null,
    },
    auditEvents: [
      {
        at: '2026-06-01T12:00:00.000Z',
        type: 'route_decision_recorded',
        meta: {
          route: 'manual_safe',
          source: 'manual',
          model: 'abby:manual-subscription',
          releasable: true,
          fallbackError: null,
          reason: null,
        },
      },
    ],
    pageArtifacts: [
      {
        pageIndex: 0,
        storyText: 'Once upon a time...',
        basePrompt: 'p1',
        currentImageUrl: 'https://example.com/p1.png',
        generationProvider: 'manual',
        generationModel: 'abby:manual-subscription',
        generationConditioning: 'photo_edit',
        regenerateCount: 0,
        accepted: true,
        feedbackHistory: [],
        versionHistory: [],
      },
    ],
  };
}

const COMPLETE_CHECKLIST = {
  storyReviewed: true,
  imagesReviewed: true,
  proofArtifactReviewed: true,
  customerSafe: true,
  noPrintRelease: true,
};

test('kill-switch API source: admin auth required before read or mutate', async () => {
  const dir = makeTmp();
  try {
    const src = readFileSync(new URL('../src/app/api/admin/kill-switches/route.ts', import.meta.url), 'utf8');
    assert.match(src, /export async function GET\(request: Request\)/);
    assert.match(src, /export async function POST\(request: Request\)/);
    const getAuthIdx = src.indexOf('if (!isAdminAuthedFromRequest(request))');
    const getReadIdx = src.indexOf('getKillSwitchSnapshot()');
    const postAuthIdx = src.lastIndexOf('if (!isAdminAuthedFromRequest(request))');
    const postBodyIdx = src.indexOf('await request.json()');
    const postUpdateIdx = src.indexOf('updateKillSwitch({');
    assert.ok(getAuthIdx > -1 && getAuthIdx < getReadIdx, 'GET must auth before state read');
    assert.ok(postAuthIdx > -1 && postAuthIdx < postBodyIdx, 'POST must auth before body parse');
    assert.ok(postAuthIdx < postUpdateIdx, 'POST must auth before state mutation');
  } finally {
    cleanup(dir);
  }
});

test('kill-switch state: activation requires operator and reason, then records history', async () => {
  const dir = makeTmp();
  try {
    await assert.rejects(
      () => updateKillSwitch({ id: 'checkout_pause', active: true, reason: '', updatedBy: 'ops' }),
      /REASON_REQUIRED_WHEN_ACTIVE/,
    );

    await assert.rejects(
      () => updateKillSwitch({ id: 'checkout_pause', active: false, reason: '', updatedBy: '' }),
      /UPDATED_BY_REQUIRED/,
    );

    await updateKillSwitch({
      id: 'checkout_pause',
      active: true,
      reason: 'capacity stop',
      updatedBy: 'ops@example.com',
    });
    assert.equal(await isKillSwitchActive('checkout_pause'), true);

    const snapshot = await getKillSwitchSnapshot();
    assert.equal(snapshot.switches.find((item) => item.id === 'checkout_pause')?.reason, 'capacity stop');
    assert.equal(snapshot.history[0]?.id, 'checkout_pause');
  } finally {
    cleanup(dir);
  }
});

test('checkout pause kill switch is checked before formData and Stripe setup', async () => {
  const src = readFileSync(new URL('../src/app/api/order/route.ts', import.meta.url), 'utf8');
  const killIdx = src.indexOf("isKillSwitchActive('checkout_pause')");
  const formIdx = src.indexOf('request.formData()');
  const stripeIdx = src.indexOf('stripe.checkout.sessions.create');
  assert.ok(killIdx > -1, 'checkout kill switch check must exist');
  assert.ok(killIdx < formIdx, 'checkout kill switch must run before form parsing');
  assert.ok(killIdx < stripeIdx, 'checkout kill switch must run before Stripe session creation');
});

test('proof release hold refuses before customer email or state advance', async () => {
  const dir = makeTmp();
  try {
    await updateKillSwitch({
      id: 'proof_release_hold',
      active: true,
      reason: 'QA freeze',
      updatedBy: 'ops@example.com',
    });
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'awaiting_qa',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      printInteriorArtifactUrl: 'https://cdn.example.com/interior.pdf',
      printInteriorMd5: 'abc',
      printInteriorPageCount: 32,
      printTitle: 'Luna and the Dinosaurs',
    }, 'ord_ks_proof');

    let emailCalls = 0;
    const result = await releaseOrderAfterQa('ord_ks_proof', {
      qaPassBy: 'ops@example.com',
      checklist: COMPLETE_CHECKLIST,
    }, {
      sendProofReadyEmail: async () => { emailCalls += 1; },
      createProofToken: () => 'tok_ks',
    });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.failureCode, 'PROOF_RELEASE_HELD');
    assert.equal(emailCalls, 0);
    assert.equal((await getOrder('ord_ks_proof'))?.fulfillmentStatus, 'awaiting_qa');
  } finally {
    cleanup(dir);
  }
});

test('owner print-go hold refuses before lock acquisition and submitPrint', async () => {
  const dir = makeTmp();
  try {
    await updateKillSwitch({
      id: 'owner_print_go_hold',
      active: true,
      reason: 'owner pause',
      updatedBy: 'ops@example.com',
    });
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'proof_approved',
      qaPassAt: '2026-06-01T12:10:00.000Z',
      proofApprovedAt: '2026-06-01T12:15:00.000Z',
      printApprovedAt: '2026-06-01T12:15:00.000Z',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      printInteriorArtifactUrl: 'https://cdn.example.com/interior.pdf',
      printInteriorMd5: 'abc',
      printInteriorPageCount: 32,
      printTitle: 'Luna and the Dinosaurs',
    }, 'ord_ks_owner');

    const result = await recordOwnerPrintGo('ord_ks_owner', 'ops@example.com');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.failureCode, 'OWNER_PRINT_GO_HELD');
    const after = await getOrder('ord_ks_owner');
    assert.equal(after?.ownerPrintGoAt, undefined);
    assert.equal(after?.fulfillmentStatus, 'proof_approved');
  } finally {
    cleanup(dir);
  }
});

test('print-provider hold refuses before Lulu/RPI submitPrint side effect', async () => {
  const dir = makeTmp();
  try {
    await updateKillSwitch({
      id: 'print_provider_hold',
      active: true,
      reason: 'provider outage',
      updatedBy: 'ops@example.com',
    });
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      fulfillmentStatus: 'proof_approved',
      qaPassAt: '2026-06-01T12:10:00.000Z',
      proofApprovedAt: '2026-06-01T12:15:00.000Z',
      printApprovedAt: '2026-06-01T12:15:00.000Z',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      printInteriorArtifactUrl: 'https://cdn.example.com/interior.pdf',
      printInteriorMd5: 'abc',
      printInteriorPageCount: 32,
      printTitle: 'Luna and the Dinosaurs',
      printCoverArtifactUrl: 'https://cdn.example.com/cover.pdf',
      printCoverMd5: 'def',
      shippingAddress: { line1: '1 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
    }, 'ord_ks_print_provider');

    let submitPrintCalls = 0;
    const result = await submitPrintAfterOwnerGo('ord_ks_print_provider', 'ops@example.com', {
      submitPrint: async () => {
        submitPrintCalls += 1;
        return { jobId: 'should-not-fire' };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(submitPrintCalls, 0);
    assert.match(result.error ?? '', /Print-provider hold/);
  } finally {
    cleanup(dir);
  }
});

test('manual switches are visible but honestly marked status-only', async () => {
  const snapshot = await getKillSwitchSnapshot();
  const marketing = snapshot.switches.find((item) => item.id === 'marketing_hold');
  const provider = snapshot.switches.find((item) => item.id === 'provider_hold');
  assert.equal(marketing?.mode, 'manual');
  assert.match(marketing?.enforcement ?? '', /Status-only/i);
  assert.equal(provider?.mode, 'manual');
  assert.match(provider?.enforcement ?? '', /Status-only/i);
});

test('kill-switch UI source avoids guaranteed Father Day or date-specific print promises', async () => {
  const src = readFileSync(new URL('../src/app/admin/kill-switches/kill-switches-client.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /guarantee|guaranteed|Father'?s Day|Jun(e)?\s+\d/i);
  assert.match(src, /YELLOW-CANDIDATE/);
  assert.match(src, /RED\/HOLD/);
});
