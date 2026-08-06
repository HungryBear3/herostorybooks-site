/**
 * REAL route-level contract for the customer layout editor (Slice 2). Invokes
 * the framework-free route handlers with actual Request objects against a local
 * order store (the route.ts files are thin NextResponse wrappers around these).
 * Synthetic fixtures only; provider/blob creds stripped.
 *
 * Covers: token auth; apply + reset; revision + fingerprint binding (reset
 * binds too); stale-tab / CAS fail-closed WITHOUT mutation; overflow + bad
 * color fail BEFORE persistence; lifecycle close; proof invalidation; idempotent
 * repeat + concurrent; request-help durable + non-emailing + idempotent; print
 * interior unaffected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  handleProofLayoutOverrideRequest,
  handleRequestLayoutHelpRequest,
} from '../src/lib/proof-layout-route-handler.ts';
import {
  createOrderRecord, persistOrder, getOrder, __resetOrderStoreAdapterFactoryForTests,
} from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import { proofSourceFingerprint } from '../src/lib/fulfillment.ts';
import { buildPrintInteriorPdf } from '../src/lib/pdf-builder.ts';
import { setProofLayoutOverride, customerReviewActor } from '../src/lib/page-review.ts';
import { proofStoryFromPageArtifacts } from '../src/lib/review-source-identity.ts';

const NOW = '2026-08-05T00:00:00.000Z';
const TOKEN = 'dcba'.repeat(12);
const ORDER = 'ord_layout_route';
const ROOMY = { x: 0.1, y: 0.12, width: 0.6, height: 0.3, opacity: 0.9, fontScale: 1 };

function page(i: number, o: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i, storyText: `Short page ${i + 1}.`, basePrompt: 'p',
    currentImageUrl: `https://example.invalid/p${i}.png`, acceptedImageUrl: `https://example.invalid/p${i}.png`,
    generationProvider: null, generationModel: null, regenerateCount: 0,
    accepted: true, feedbackHistory: [], versionHistory: [], ...o,
  };
}

function seed(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const order: OrderRecord = {
    ...createOrderRecord({ childName: 'Kid', bookFormat: 'digital', email: 'r@example.invalid' }, { id: ORDER, now: NOW }),
    paymentStatus: 'paid', reviewStatus: 'in_review', fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.invalid/proof.pdf', proofVersion: 'pv_1',
    proofReviewedAt: null, proofReviewedVersion: null,
    proofApprovalToken: TOKEN, pageArtifacts: [page(0), page(1)], auditEvents: [], ...overrides,
  };
  order.proofSourceFingerprint = proofSourceFingerprint(order);
  return order;
}
async function persistSeed(overrides: Partial<OrderRecord> = {}): Promise<OrderRecord> {
  const order = seed(overrides);
  await persistOrder(order);
  return order;
}

function req(pathName: string, body: unknown, token: string | null = TOKEN): Request {
  const q = token == null ? '' : `?token=${token}`;
  return new Request(`http://localhost/api/order/${ORDER}/${pathName}${q}`, { method: 'POST', body: JSON.stringify(body) });
}
const applyLayout = (body: unknown, token: string | null = TOKEN) =>
  handleProofLayoutOverrideRequest(req('proof-layout', body, token), ORDER);
const requestHelp = (body: unknown, token: string | null = TOKEN) =>
  handleRequestLayoutHelpRequest(req('request-help', body, token), ORDER);

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-layout-route-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  for (const k of ['RESEND_API_KEY', 'OPENAI_API_KEY', 'FAL_KEY', 'GEMINI_API_KEY', 'LULU_CLIENT_KEY']) delete process.env[k];
  return dir;
}
function cleanup(dir: string) {
  __resetOrderStoreAdapterFactoryForTests();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

const binding = (o: OrderRecord) => ({ authoredAgainstProofVersion: 'pv_1', authoredAgainstFingerprint: o.proofSourceFingerprint });

// ── auth ─────────────────────────────────────────────────────────────────────

test('rejects a missing/invalid token before any mutation', async () => {
  const dir = makeTmp();
  try {
    const order = await persistSeed();
    const r = await applyLayout({ pageIndex: 0, geometry: ROOMY, ...binding(order) }, 'wrong');
    assert.equal(r.status, 403);
    const after = await getOrder(ORDER);
    assert.equal(after?.pageArtifacts?.[0].proofCardOverride ?? null, null);
    assert.equal(after?.storyArtifactUrl, order.storyArtifactUrl, 'no mutation on auth failure');
  } finally { cleanup(dir); }
});

// ── apply + proof invalidation ───────────────────────────────────────────────

test('applies a valid override, invalidates the proof, and audits privacy-safely', async () => {
  const dir = makeTmp();
  try {
    const order = await persistSeed();
    const r = await applyLayout({ pageIndex: 0, geometry: ROOMY, textColor: 'dark_brown', ...binding(order) });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);

    const after = await getOrder(ORDER);
    const ov = after?.pageArtifacts?.[0].proofCardOverride;
    assert.ok(ov, 'override persisted');
    assert.equal(ov!.appliedBy, 'customer', 'appliedBy is the non-PII server identifier');
    assert.equal(after?.storyArtifactUrl ?? null, null, 'proof invalidated');
    assert.equal(after?.proofVersion ?? null, null);

    const evt = after?.auditEvents?.find((e) => e.type === 'page_layout_override_applied');
    assert.ok(evt);
    const evtJson = JSON.stringify(evt);
    for (const leak of ['Short page', TOKEN, 'r@example.invalid', ORDER]) {
      assert.doesNotMatch(evtJson, new RegExp(leak.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `audit must not leak ${leak}`);
    }
  } finally { cleanup(dir); }
});

// ── stale-tab / binding fail closed WITHOUT mutation ─────────────────────────

for (const [name, patch] of [
  ['stale revision', { authoredAgainstProofVersion: 'pv_OLD' }],
  ['stale fingerprint', { authoredAgainstFingerprint: 'pf_wrong' }],
  ['missing binding', { authoredAgainstProofVersion: undefined, authoredAgainstFingerprint: undefined }],
] as const) {
  test(`${name} fails closed (409) without mutation`, async () => {
    const dir = makeTmp();
    try {
      const order = await persistSeed();
      const r = await applyLayout({ pageIndex: 0, geometry: ROOMY, ...binding(order), ...patch });
      assert.equal(r.status, 409);
      const after = await getOrder(ORDER);
      assert.equal(after?.pageArtifacts?.[0].proofCardOverride ?? null, null, 'no override persisted');
      assert.equal(after?.storyArtifactUrl, order.storyArtifactUrl, 'proof not invalidated');
    } finally { cleanup(dir); }
  });
}

// ── validation fails BEFORE persistence ──────────────────────────────────────

test('overflow fails closed (422) before persistence', async () => {
  const dir = makeTmp();
  try {
    const order = await persistSeed({ pageArtifacts: [page(0, { storyText: 'word '.repeat(400) }), page(1)] });
    const tiny = { x: 0.4, y: 0.4, width: 0.15, height: 0.06, opacity: 0.9, fontScale: 1.15 };
    const r = await applyLayout({ pageIndex: 0, geometry: tiny, ...binding(order) });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'text_overflow');
    const after = await getOrder(ORDER);
    assert.equal(after?.pageArtifacts?.[0].proofCardOverride ?? null, null);
    assert.equal(after?.storyArtifactUrl, order.storyArtifactUrl, 'no mutation');
  } finally { cleanup(dir); }
});

test('an illegible color/opacity combo fails closed (422) before persistence', async () => {
  const dir = makeTmp();
  try {
    const order = await persistSeed();
    const r = await applyLayout({ pageIndex: 0, geometry: { ...ROOMY, opacity: 0.35 }, textColor: 'cream', ...binding(order) });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'insufficient_contrast');
    assert.equal((await getOrder(ORDER))?.pageArtifacts?.[0].proofCardOverride ?? null, null);
  } finally { cleanup(dir); }
});

// ── lifecycle close ──────────────────────────────────────────────────────────

test('editing is closed after approval (409), no mutation', async () => {
  const dir = makeTmp();
  try {
    const order = await persistSeed({ reviewStatus: 'approved' });
    const r = await applyLayout({ pageIndex: 0, geometry: ROOMY, ...binding(order) });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'order_approved');
  } finally { cleanup(dir); }
});

// ── reset (also binds) ───────────────────────────────────────────────────────

function seedWithOverride(): OrderRecord {
  const base = seed();
  const withOv: OrderRecord = {
    ...base,
    pageArtifacts: [
      { ...base.pageArtifacts![0], proofCardOverride: {
        ...ROOMY, textColor: 'dark_brown', authoredAgainstProofVersion: 'pv_1',
        authoredAgainstFingerprint: 'pf_seed', appliedAt: NOW, appliedBy: 'customer',
      } },
      base.pageArtifacts![1],
    ],
  };
  withOv.proofSourceFingerprint = proofSourceFingerprint(withOv);
  withOv.proofVersion = 'pv_1';
  return withOv;
}

test('reset removes the override under a valid binding; stale binding fails closed', async () => {
  const dir = makeTmp();
  try {
    const order = seedWithOverride();
    await persistOrder(order);
    const stale = await applyLayout({ pageIndex: 0, authoredAgainstProofVersion: 'pv_OLD', authoredAgainstFingerprint: order.proofSourceFingerprint });
    assert.equal(stale.status, 409);
    assert.ok((await getOrder(ORDER))?.pageArtifacts?.[0].proofCardOverride, 'override retained on stale reset');

    const ok = await applyLayout({ pageIndex: 0, ...binding(order) });
    assert.equal(ok.status, 200);
    const after = await getOrder(ORDER);
    assert.equal(after?.pageArtifacts?.[0].proofCardOverride ?? null, null, 'override cleared');
    assert.equal(after?.storyArtifactUrl ?? null, null, 'proof invalidated by reset');
  } finally { cleanup(dir); }
});

test('reset with nothing to reset is an idempotent no-op (no mutation)', async () => {
  const dir = makeTmp();
  try {
    const order = await persistSeed();
    const r = await applyLayout({ pageIndex: 0, ...binding(order) });
    assert.equal(r.status, 200);
    assert.equal(r.body.noop, true);
    assert.ok(r.body.snapshot, 'every successful public response carries authoritative review state');
    const snapshot = r.body.snapshot as { proofVersion?: string | null; proofSourceFingerprint?: string | null };
    assert.equal(snapshot.proofVersion, order.proofVersion);
    assert.equal(snapshot.proofSourceFingerprint, order.proofSourceFingerprint);
    assert.equal((await getOrder(ORDER))?.storyArtifactUrl, order.storyArtifactUrl, 'proof untouched');
  } finally { cleanup(dir); }
});

test('successful direct-service no-op reset carries an authoritative snapshot', async () => {
  const dir = makeTmp();
  try {
    const order = await persistSeed();
    const result = await setProofLayoutOverride({
      orderId: ORDER, pageIndex: 0, geometry: null, ...binding(order),
      appliedBy: 'internal_ops',
    });
    assert.equal(result.ok, true);
    assert.equal(result.noop, true);
    assert.ok(result.snapshot, 'service success must always include a snapshot');
    assert.equal(result.snapshot.proofVersion, order.proofVersion);
    assert.equal(result.snapshot.proofSourceFingerprint, order.proofSourceFingerprint);
  } finally { cleanup(dir); }
});

// ── idempotent repeat + concurrent ───────────────────────────────────────────

test('a repeated apply against a now-consumed revision fails closed (exactly one applied)', async () => {
  const dir = makeTmp();
  try {
    const order = await persistSeed();
    const body = { pageIndex: 0, geometry: ROOMY, ...binding(order) };
    assert.equal((await applyLayout(body)).status, 200);
    assert.equal((await applyLayout(body)).status, 409, 'binding consumed → stale');
    const after = await getOrder(ORDER);
    assert.equal((after?.auditEvents ?? []).filter((e) => e.type === 'page_layout_override_applied').length, 1);
  } finally { cleanup(dir); }
});

test('two concurrent applies are CAS-safe: exactly one applies', async () => {
  const dir = makeTmp();
  try {
    const order = await persistSeed();
    const fp = order.proofSourceFingerprint!;
    const [a, b] = await Promise.all([
      setProofLayoutOverride({ orderId: ORDER, pageIndex: 0, geometry: ROOMY, authoredAgainstProofVersion: 'pv_1', authoredAgainstFingerprint: fp, appliedBy: 'customer', actor: customerReviewActor(TOKEN) }),
      setProofLayoutOverride({ orderId: ORDER, pageIndex: 0, geometry: ROOMY, authoredAgainstProofVersion: 'pv_1', authoredAgainstFingerprint: fp, appliedBy: 'customer', actor: customerReviewActor(TOKEN) }),
    ]);
    assert.equal([a, b].filter((r) => r.ok).length, 1, 'exactly one concurrent apply succeeds');
    const after = await getOrder(ORDER);
    assert.equal((after?.auditEvents ?? []).filter((e) => e.type === 'page_layout_override_applied').length, 1);
  } finally { cleanup(dir); }
});

// ── print interior unaffected ────────────────────────────────────────────────

test('an applied override does not change the print interior content', async () => {
  const dir = makeTmp();
  try {
    const order = await persistSeed({ bookFormat: 'classic' });
    const strip = (bf: Buffer) => bf.toString('latin1').replace(/D:\d{8,14}[Z0-9+'-]*/g, '').replace(/\/ID\s*\[[^\]]*\]/g, '').replace(/<[0-9a-fA-F]{16,}>/g, '');
    const storyBefore = proofStoryFromPageArtifacts(order, order.pageArtifacts!)!;
    const before = strip(await buildPrintInteriorPdf(storyBefore, order, [null, null, null]));

    assert.equal((await applyLayout({ pageIndex: 0, geometry: ROOMY, ...binding(order) })).status, 200);
    const after = await getOrder(ORDER);
    const storyAfter = proofStoryFromPageArtifacts(after!, after!.pageArtifacts!)!;
    const afterBytes = strip(await buildPrintInteriorPdf(storyAfter, after!, [null, null, null]));
    assert.equal(afterBytes, before, 'print interior content is unchanged by a proof-only override');
  } finally { cleanup(dir); }
});

// ── request-help: durable, non-emailing, idempotent ──────────────────────────

test('request-help records a durable audit event with no email/proof/order side effects; idempotent', async () => {
  const dir = makeTmp();
  try {
    const order = await persistSeed();
    assert.equal((await requestHelp({ pageIndex: 0 })).status, 200);
    let after = await getOrder(ORDER);
    assert.equal((after?.auditEvents ?? []).filter((e) => e.type === 'layout_help_requested').length, 1);
    assert.equal(after?.storyArtifactUrl, order.storyArtifactUrl, 'proof untouched');
    assert.equal(after?.reviewStatus, 'in_review', 'order not advanced');

    const again = await requestHelp({ pageIndex: 0 });
    assert.equal(again.status, 200);
    assert.equal(again.body.noop, true);
    after = await getOrder(ORDER);
    assert.equal((after?.auditEvents ?? []).filter((e) => e.type === 'layout_help_requested').length, 1, 'idempotent');
  } finally { cleanup(dir); }
});

test('malformed geometry cannot apply or reset and causes no mutation', async () => {
  const dir = makeTmp();
  try {
    const order = seedWithOverride();
    await persistOrder(order);
    const r = await applyLayout({ pageIndex: 0, geometry: 'malformed', ...binding(order) });
    assert.equal(r.status, 422);
    const after = await getOrder(ORDER);
    assert.ok(after?.pageArtifacts?.[0].proofCardOverride, 'malformed geometry must not reset');
    assert.equal(after?.storyArtifactUrl, order.storyArtifactUrl);
    assert.equal(after?.auditEvents?.length ?? 0, order.auditEvents?.length ?? 0);
  } finally { cleanup(dir); }
});

test('direct service rejects non-finite geometry before persistence', async () => {
  const dir = makeTmp();
  try {
    const order = await persistSeed();
    const result = await setProofLayoutOverride({
      orderId: ORDER, pageIndex: 0, geometry: { ...ROOMY, x: Number.POSITIVE_INFINITY },
      ...binding(order), appliedBy: 'customer', actor: customerReviewActor(TOKEN),
    });
    assert.equal(result.status, 422);
    const after = await getOrder(ORDER);
    assert.equal(after?.pageArtifacts?.[0].proofCardOverride ?? null, null);
    assert.equal(after?.storyArtifactUrl, order.storyArtifactUrl);
  } finally { cleanup(dir); }
});

test('direct service still rejects an unapproved text color on apply', async () => {
  const dir = makeTmp();
  try {
    const order = await persistSeed();
    const result = await setProofLayoutOverride({
      orderId: ORDER, pageIndex: 0, geometry: ROOMY,
      textColor: 'hot_pink' as never, ...binding(order), appliedBy: 'internal_ops',
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.equal(result.error, 'invalid_text_color');
    const after = await getOrder(ORDER);
    assert.equal(after?.pageArtifacts?.[0].proofCardOverride ?? null, null);
    assert.equal(after?.storyArtifactUrl, order.storyArtifactUrl);
  } finally { cleanup(dir); }
});

test('byte-equivalent canonical apply is a no-op and preserves the live proof', async () => {
  const dir = makeTmp();
  try {
    const order = seedWithOverride();
    await persistOrder(order);
    const beforeAudit = order.auditEvents?.length ?? 0;
    const r = await applyLayout({ pageIndex: 0, geometry: { ...ROOMY, x: 0.10000001 }, textColor: 'dark_brown', ...binding(order) });
    assert.equal(r.status, 200);
    assert.equal(r.body.noop, true);
    const after = await getOrder(ORDER);
    assert.equal(after?.storyArtifactUrl, order.storyArtifactUrl);
    assert.equal(after?.proofVersion, order.proofVersion);
    assert.equal(after?.auditEvents?.length ?? 0, beforeAudit);
  } finally { cleanup(dir); }
});

test('request-help rejects malformed or nonexistent supplied page indexes without persistence', async () => {
  const dir = makeTmp();
  try {
    await persistSeed();
    for (const pageIndex of ['0', 999999]) {
      const result = await requestHelp({ pageIndex });
      assert.equal(result.status, 422);
    }
    const after = await getOrder(ORDER);
    assert.equal(after?.auditEvents?.filter((e) => e.type === 'layout_help_requested').length, 0);
  } finally { cleanup(dir); }
});

test('request-help idempotency is scoped to the current proof fingerprint', async () => {
  const dir = makeTmp();
  try {
    const first = await persistSeed();
    assert.equal((await requestHelp({ pageIndex: 0 })).status, 200);
    assert.equal((await requestHelp({ pageIndex: 0 })).body.noop, true);
    const afterFirst = (await getOrder(ORDER))!;
    const changed: OrderRecord = {
      ...afterFirst,
      pageArtifacts: [page(0, { storyText: 'A newly rebuilt page.' }), page(1)],
      proofVersion: 'pv_2', storyArtifactUrl: 'https://example.invalid/proof-2.pdf',
    };
    changed.proofSourceFingerprint = proofSourceFingerprint(changed);
    assert.notEqual(changed.proofSourceFingerprint, first.proofSourceFingerprint);
    await persistOrder(changed);
    const second = await requestHelp({ pageIndex: 0 });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.noop, true);
    const events = (await getOrder(ORDER))?.auditEvents?.filter((e) => e.type === 'layout_help_requested') ?? [];
    assert.equal(events.length, 2);
  } finally { cleanup(dir); }
});
