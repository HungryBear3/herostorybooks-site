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

test('checkout pause kill switch is checked before formData and Stripe setup AND fails closed on durability error', async () => {
  const src = readFileSync(new URL('../src/app/api/order/route.ts', import.meta.url), 'utf8');
  const killIdx = src.indexOf("enforceKillSwitch('checkout_pause')");
  const formIdx = src.indexOf('request.formData()');
  const stripeIdx = src.indexOf('stripe.checkout.sessions.create');
  assert.ok(killIdx > -1, 'checkout kill switch check must exist (enforceKillSwitch)');
  assert.ok(killIdx < formIdx, 'checkout kill switch must run before form parsing');
  assert.ok(killIdx < stripeIdx, 'checkout kill switch must run before Stripe session creation');
  // Fail-closed: durable-read failure must also refuse the request.
  assert.match(src, /checkoutKs\.kind === 'unavailable'/);
  assert.match(src, /killSwitchStateUnavailable: true/);
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

// ── R1 + R6: durable persistence + DURABILITY_FAILED surface ────────────────

test('kill-switch durable read fails closed in production when BLOB_READ_WRITE_TOKEN is missing', async () => {
  const dir = makeTmp();
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'true';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const { isKillSwitchActive: ksActive, KillSwitchDurabilityError } =
      await import('../src/lib/ops-kill-switches.ts');
    await assert.rejects(
      () => ksActive('checkout_pause'),
      (err) => err instanceof KillSwitchDurabilityError,
      'durable read must throw KillSwitchDurabilityError when no blob token in prod',
    );
  } finally {
    delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
    cleanup(dir);
  }
});

test('kill-switch durable write fails closed in production when BLOB_READ_WRITE_TOKEN is missing', async () => {
  const dir = makeTmp();
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'true';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const { updateKillSwitch: update, KillSwitchDurabilityError } =
      await import('../src/lib/ops-kill-switches.ts');
    await assert.rejects(
      () => update({
        id: 'checkout_pause',
        active: true,
        reason: 'durability test',
        updatedBy: 'ops@example.com',
      }),
      (err) => err instanceof KillSwitchDurabilityError,
      'durable write must throw KillSwitchDurabilityError when no blob token in prod',
    );
  } finally {
    delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
    cleanup(dir);
  }
});

test('enforceKillSwitch surfaces durable failure as { unavailable: true } instead of throwing', async () => {
  const dir = makeTmp();
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'true';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const { enforceKillSwitch } = await import('../src/lib/ops-kill-switches.ts');
    const result = await enforceKillSwitch('checkout_pause');
    assert.equal(result.kind, 'unavailable', 'enforceKillSwitch must return kind=unavailable in prod with no blob token');
    if (result.kind === 'unavailable') {
      assert.match(result.reason, /BLOB_READ_WRITE_TOKEN/);
    }
  } finally {
    delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
    cleanup(dir);
  }
});

test('KS-1 /api/order route source: fail-closed branch refuses checkout when KS state is unavailable', async () => {
  const src = readFileSync(new URL('../src/app/api/order/route.ts', import.meta.url), 'utf8');
  // Both the active-switch refusal AND the unavailable-state refusal
  // must precede form parsing + Stripe.
  const activeIdx = src.indexOf("checkoutKs.kind === 'active'");
  const unavailableIdx = src.indexOf("checkoutKs.kind === 'unavailable'");
  const formIdx = src.indexOf('request.formData()');
  const stripeIdx = src.indexOf('stripe.checkout.sessions.create');
  assert.ok(activeIdx > -1 && unavailableIdx > -1);
  assert.ok(activeIdx < formIdx && unavailableIdx < formIdx);
  assert.ok(activeIdx < stripeIdx && unavailableIdx < stripeIdx);
  // Body must carry killSwitchStateUnavailable signal for admin UI / logs.
  assert.match(src, /killSwitchStateUnavailable: true/);
});

test('KS admin route surfaces DURABILITY_FAILED with operator guidance on durable-store failure', async () => {
  // Source-level guarantee (route handler can't mount under node:test).
  const src = readFileSync(new URL('../src/app/api/admin/kill-switches/route.ts', import.meta.url), 'utf8');
  assert.match(src, /code: DURABILITY_FAILED/);
  assert.match(src, /KillSwitchDurabilityError/);
  assert.match(src, /durabilityFailedResponse/);
  assert.match(src, /operatorGuidance/);
  assert.match(src, /status: 503/);
  // Both GET and POST must handle the error type.
  const getIdx = src.indexOf('export async function GET');
  const postIdx = src.indexOf('export async function POST');
  const firstCatchIdx = src.indexOf('KillSwitchDurabilityError', getIdx);
  const secondCatchIdx = src.indexOf('KillSwitchDurabilityError', postIdx);
  assert.ok(firstCatchIdx > getIdx && firstCatchIdx < postIdx);
  assert.ok(secondCatchIdx > postIdx);
});

test('kill-switch durable read uses list + blob URL fetch, not pathname get()', async () => {
  const src = readFileSync(new URL('../src/lib/ops-kill-switches.ts', import.meta.url), 'utf8');
  const readStart = src.indexOf('async function readStoreFromBlob');
  const readEnd = src.indexOf('async function writeStoreToBlob');
  assert.ok(readStart > -1 && readEnd > readStart);
  const readBlock = src.slice(readStart, readEnd);
  assert.match(readBlock, /await list\(\{ prefix: pathname, token/);
  assert.match(readBlock, /fetch\(`\$\{match\.url\}/);
  assert.doesNotMatch(readBlock, /await get\(/);
});

test('KS admin page surfaces DURABILITY_FAILED warning instead of toggle UI', async () => {
  const src = readFileSync(new URL('../src/app/admin/kill-switches/page.tsx', import.meta.url), 'utf8');
  assert.match(src, /data-testid="kill-switches-durability-failed"/);
  assert.match(src, /UNSAFE TO USE/);
  assert.match(src, /DURABILITY_FAILED/);
  assert.match(src, /HSB_CHECKOUT_PAUSED=true/);
});

// ── R2: KS-2 leak coverage on every customer-email path ─────────────────────

test('proof_release_hold also blocks resendDigitalDelivery (R2 leak closure)', async () => {
  const dir = makeTmp();
  try {
    await updateKillSwitch({
      id: 'proof_release_hold',
      active: true,
      reason: 'R2 test',
      updatedBy: 'ops@example.com',
    });
    await seed({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      qaPassAt: '2026-06-02T12:00:00.000Z',
      qaPassBy: 'opsA',
      qaStatus: 'passed',
      storyArtifactUrl: 'https://cdn.example.com/digital.pdf',
      fulfillmentStatus: 'complete',
    }, 'ord_r2_resend_digital');
    const { resendDigitalDelivery } = await import('../src/lib/admin-actions.ts');
    const r = await resendDigitalDelivery('ord_r2_resend_digital');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.failureCode, 'PROOF_RELEASE_HELD');
    assert.equal(!r.ok && r.status, 409);
  } finally { cleanup(dir); }
});

test('proof_release_hold also blocks resendProofEmail (R2 leak closure)', async () => {
  const dir = makeTmp();
  try {
    await updateKillSwitch({
      id: 'proof_release_hold',
      active: true,
      reason: 'R2 test',
      updatedBy: 'ops@example.com',
    });
    await seed({
      bookFormat: 'classic',
      paymentStatus: 'paid',
      qaPassAt: '2026-06-02T12:00:00.000Z',
      qaPassBy: 'opsA',
      qaStatus: 'passed',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      proofApprovalToken: 'tok_r2_proof',
      fulfillmentStatus: 'proof_ready',
    }, 'ord_r2_resend_proof');
    const { resendProofEmail } = await import('../src/lib/admin-actions.ts');
    const r = await resendProofEmail('ord_r2_resend_proof', 'http://localhost:3000');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.failureCode, 'PROOF_RELEASE_HELD');
  } finally { cleanup(dir); }
});

test('proof_release_hold also blocks retryOrderFulfillment delivery_email_failed paths (R2 leak closure)', async () => {
  const dir = makeTmp();
  try {
    await updateKillSwitch({
      id: 'proof_release_hold',
      active: true,
      reason: 'R2 test',
      updatedBy: 'ops@example.com',
    });
    await seed({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      qaPassAt: '2026-06-02T12:00:00.000Z',
      qaPassBy: 'opsA',
      qaStatus: 'passed',
      storyArtifactUrl: 'https://cdn.example.com/digital.pdf',
      fulfillmentStatus: 'delivery_email_failed',
    }, 'ord_r2_retry_digital');
    const { retryOrderFulfillment } = await import('../src/lib/admin-actions.ts');
    const r = await retryOrderFulfillment('ord_r2_retry_digital');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.failureCode, 'PROOF_RELEASE_HELD');
  } finally { cleanup(dir); }
});

test('manuallyApproveProof is intentionally NOT KS-2 gated (no customer email) — docstring records scope', async () => {
  const src = readFileSync(new URL('../src/lib/admin-actions.ts', import.meta.url), 'utf8');
  // The action itself must not consult proof_release_hold (no email
  // side effect); the docstring must explicitly call that out so the
  // next reader doesn't think it's a leak.
  const fnIdx = src.indexOf('export async function manuallyApproveProof');
  const fnEndIdx = src.indexOf('\n}\n', fnIdx);
  assert.ok(fnIdx > -1 && fnEndIdx > fnIdx);
  const body = src.slice(fnIdx, fnEndIdx);
  assert.doesNotMatch(body, /proof_release_hold|refuseIfProofReleaseHeld/);
  // Docstring above the function must say so.
  const docStart = src.lastIndexOf('/**', fnIdx);
  const docBlock = src.slice(docStart, fnIdx);
  assert.match(docBlock, /KS-2 \/ proof_release_hold is intentionally NOT consulted/i);
});
