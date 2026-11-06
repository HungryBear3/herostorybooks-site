// SYNTHETIC consumer hold tests. The bound baseline is obtained through the
// actual signed synthetic settlement path (real SDK offline signature, actual
// webhook route, inline 'stripe' module mock reading an in-memory provider,
// inline assembly mock); legacy artifact metadata is then seeded as an
// explicit FIXTURE through a generic writer, never as generation evidence.
// Unbound retail controls are labelled fixtures. No provider/network/Blob.
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';

// Owned fixture runtime: inherited HOME/TMPDIR must be existing canonical
// directories confined to the owned runtime, validated before any app import.
const OWNED_RUNTIME = '/Users/abigailclaw/.hermes/cache/scratch/hsb-suite-fixture-correction-runtime-20261029';
function ownedRuntime(sub: string): string {
  const owned = realpathSync(OWNED_RUNTIME);
  assert.equal(owned, OWNED_RUNTIME, 'owned runtime path is canonical');
  for (const name of ['HOME', 'TMPDIR'] as const) {
    const value = (process.env[name] ?? '').replace(/\/+$/, '');
    assert.ok(value && path.isAbsolute(value), `${name} must be absolute`);
    assert.equal(realpathSync(value), value, `${name} must be canonical`);
    assert.ok(statSync(value).isDirectory(), `${name} must be an existing directory`);
    assert.ok(value === owned || value.startsWith(`${owned}${path.sep}`), `${name} must be confined to the owned runtime`);
  }
  const dir = path.join((process.env.TMPDIR as string).replace(/\/+$/, ''), sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const RUNTIME = ownedRuntime('classroom-settlement-consumers');
process.env.TMPDIR = RUNTIME;
const STORE = path.join(RUNTIME, `consumers-${process.pid}-${Date.now()}`);
mkdirSync(STORE, { recursive: true });
const WEBHOOK_SECRET = 'whsec_synthetic_classroom_consumers_only';
process.env.HSB_ORDER_STORE_DIR = STORE;
process.env.HSB_PAYMENT_RECOVERY_STORE_DIR = path.join(STORE, 'recovery');
process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_classroom_consumers_only';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.HSB_PRIVATE_READ_WRITE_TOKEN = 'vercel_blob_rw_privatesynth_consumers';
process.env.HSB_ORDER_ADMIN_KEY = 'synthetic-classroom-consumers-admin-key-0001';
// Resolution-only hook so DIRECT ROUTE EXPORTS (which import '@/lib/*' and
// 'next/server') load the actual source modules. No transport interception.
const nodeModule = await import('node:module');
const SRC_ROOT = new URL('../src/', import.meta.url).href;
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) return nextResolve(`${SRC_ROOT}${specifier.slice(2)}.ts`, context);
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    return nextResolve(specifier, context);
  },
});
// '@vercel/blob' -> existing in-memory store fake (inert private bytes); `get`
// reports the pathname like the real SDK result.
const blobFake = await import(new URL('./helpers/blob-store-fake.mjs', import.meta.url).href);
mock.module('@vercel/blob', { namedExports: {
  ...blobFake,
  BlobStoreNotFoundError: class BlobStoreNotFoundError extends Error {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get: async (p: string, o: any) => { const r = await blobFake.get(p, o); if (r.blob) r.blob.pathname = p; return r; },
} });
for (const name of ['VERCEL', 'VERCEL_ENV', 'BLOB_READ_WRITE_TOKEN', 'HSB_BLOB_NAMESPACE', 'HSB_PAID_ORDER_OUTBOX_ENABLED']) delete process.env[name];
console.error = () => {}; console.warn = () => {}; console.log = () => {};
let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls += 1; throw new TypeError('synthetic_network_denied'); }) as typeof fetch;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const provider = { events: new Map<string, Obj>(), sessions: new Map<string, Obj>(), reads: 0 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RealStripe: any = (await import('stripe')).default;
class SyntheticStripe extends RealStripe {
  constructor(...args: unknown[]) {
    super(...args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any;
    self.events = { retrieve: async (id: string) => { provider.reads += 1; const e = provider.events.get(id); if (!e) throw new Error('no_event'); return structuredClone(e); } };
    self.checkout = { sessions: { retrieve: async (id: string) => { provider.reads += 1; const s = provider.sessions.get(id); if (!s) throw new Error('no_session'); return structuredClone(s); }, create: async () => { throw new Error('forbidden'); } } };
  }
}
mock.module('stripe', { defaultExport: SyntheticStripe });
const assemblyUrl = new URL('../src/lib/group-book/assembly.ts', import.meta.url).href;
const realAssembly = await import(assemblyUrl);
mock.module(assemblyUrl, { namedExports: { ...realAssembly, assertClassroomAssemblyCurrent: async () => ({ ok: true }) } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const orders: any = await import('../src/lib/orders.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lib: any = await import('../src/lib/group-book/classroom-checkout.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const webhook: any = await import('../src/app/api/webhooks/stripe/route.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fulfillment: any = await import('../src/lib/fulfillment.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pageReview: any = await import('../src/lib/page-review.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const characterReview: any = await import('../src/lib/character-review.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const privateReview: any = await import('../src/lib/private-review-route-handler.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin: any = await import('../src/lib/admin-actions.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const outbox: any = await import('../src/lib/paid-order-outbox.ts');

const KIND = 'hsb_classroom_zero_total_test';
const HELD = 'classroom_release_held';
const FUTURE = new Date(Date.now() + 20 * 86400000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
const BINDING = { schemaVersion: 1, cohortId: 'synthetic_cohort', digest: 'c'.repeat(64), participantCount: 2, expiresAt: FUTURE };
const TOKEN = 'synthetic-review-capability-token-000000000001';
let seq = 0;
const freshId = () => { seq += 1; return `ord_${(Date.now().toString(16) + seq.toString(16).padStart(4, '0')).slice(-16).padStart(16, '0')}`; };
const read = async (id: string) => (await orders.readOrderVersioned(id)).order as Obj;

const checkoutProvider = {
  async createZeroTotalSession(req: Obj) {
    const id = `cs_test_synthetic_consumer_${seq}`;
    const s = { id, livemode: false, mode: 'payment', status: 'open', payment_status: 'unpaid', amount_subtotal: req.order.priceCents, amount_total: 0,
      total_details: { amount_discount: req.order.priceCents }, currency: 'usd', client_reference_id: req.order.id, metadata: { ...req.metadata }, payment_intent: null, url: `https://checkout.synthetic.invalid/${id}` };
    provider.sessions.set(id, s); return structuredClone(s);
  },
  async retrieveSession(id: string) { return structuredClone(provider.sessions.get(id)); },
};
const { createHash: sha } = await import('node:crypto');
const PAGE_BYTES = Buffer.from('PNG1');
const PDF_BYTES = Buffer.from('%PDF');
const hex = (b: Buffer) => sha('sha256').update(b).digest('hex');
const legacyArtifacts = (id: string): Obj => ({
  storyArtifactUrl: `/api/order/${id}/review-asset/proof-pdf`,
  privateStoryArtifact: { pathname: `orders/${id}/private/proof.pdf`, sha256: hex(PDF_BYTES), bytes: 4, contentType: 'application/pdf' },
  pageArtifacts: [{ pageIndex: 0, currentImageUrl: `/api/order/${id}/review-asset/page-01`, privateReviewAsset: { pathname: `orders/${id}/private/page-01.png`, sha256: hex(PAGE_BYTES), bytes: 4, contentType: 'image/png' }, status: 'generated', regenCount: 0, accepted: false }],
  proofApprovalToken: TOKEN, proofVersion: 'pv_synthetic_legacy',
});
/** Bound + paid through the actual signed synthetic settlement path. */
async function settledBound(presetId?: string): Promise<string> {
  const id = presetId ?? freshId();
  const order = orders.createOrderRecord({ email: 'synthetic@example.invalid', bookFormat: 'digital', childName: 'SYNTH' }, { id, fulfillmentMode: 'manual_hold' });
  order.groupBookAssembly = { ...BINDING };
  await orders.persistNewOrder(order);
  const res: Response = await lib.classroomCheckoutResponse(new Request('http://127.0.0.1/x', { method: 'POST' }), { authenticate: () => true, target: () => ({ orderId: id }), provider: checkoutProvider, baseUrl: () => 'http://127.0.0.1' });
  assert.equal(res.status, 200, 'fixture checkout');
  const sessionId = (await read(id)).stripeSessionId;
  Object.assign(provider.sessions.get(sessionId)!, { status: 'complete', payment_status: 'no_payment_required' });
  const eventId = `evt_synthetic_consumer_${seq}`;
  const event = { id: eventId, object: 'event', type: 'checkout.session.completed', livemode: false, created: 1_777_000_000, data: { object: { id: sessionId, metadata: { kind: KIND, orderId: id } } } };
  provider.events.set(eventId, event);
  const payload = JSON.stringify(event);
  const sig = new RealStripe('sk_test_signer').webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const w: Response = await webhook.POST(new Request('http://127.0.0.1/api/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': sig }, body: payload }));
  assert.equal(w.status, 200, 'fixture settlement');
  const paid = await read(id);
  // Baseline authentic payment via the signed route; the receipt itself is asserted in A01, not here.
  assert.equal(paid.paymentStatus, 'paid', 'fixture paid through the signed synthetic settlement path');
  await orders.withOrderTransaction(id, (c: Obj) => ({ commit: { ...c, ...legacyArtifacts(id), updatedAt: new Date().toISOString() }, result: true }));
  return id;
}
async function retailPaid(): Promise<string> {
  const id = freshId();
  const order = orders.createOrderRecord({ email: 'retail@example.invalid', bookFormat: 'digital', childName: 'RETAIL' }, { id, fulfillmentMode: 'manual_hold' });
  Object.assign(order, { paymentStatus: 'paid', paidAt: new Date().toISOString(), stripeSessionId: 'cs_test_synthetic_retail_fixture' }, legacyArtifacts(id));
  await orders.persistNewOrder(order);
  return id;
}
function effectSpy() {
  const touched: string[] = [];
  const deps = new Proxy({}, { get(_t, key) { if (typeof key === 'string' && key !== 'then') touched.push(key); return undefined; } });
  return { deps, touched };
}

let bound = '';
let retail = '';
/** Each case builds (or reuses) its own found fixtures; no case depends on another finishing. */
async function fixtures() {
  if (!bound) bound = await settledBound();
  if (!retail) retail = await retailPaid();
  assert.equal((await read(bound)).id, bound, 'bound record-found control');
  assert.equal((await read(retail)).id, retail, 'retail record-found control');
}
test('C01_fulfillment_direct_proof_retry_and_print', async () => {
  await fixtures();
  for (const [label, run] of [
    ['triggerFulfillment', (d: object) => fulfillment.triggerFulfillment(bound, d)],
    ['buildProofArtifactFromPageArtifacts', (d: object) => fulfillment.buildProofArtifactFromPageArtifacts(bound, d)],
    ['rebuildProofFromPageArtifacts', (d: object) => fulfillment.rebuildProofFromPageArtifacts(bound, d)],
    ['approvePrintProof', (d: object) => fulfillment.approvePrintProof(bound, TOKEN, d)],
    ['retryOrderFulfillment', (d: object) => admin.retryOrderFulfillment(bound, d)],
  ] as const) {
    const spy = effectSpy();
    const r = await run(spy.deps);
    assert.match(JSON.stringify(r), new RegExp(HELD), `${label}: typed hold`);
    assert.deepEqual(spy.touched, [], `${label}: zero effect-seam access`);
  }
  // NATIVE effect-positive matrix: counting inert FulfillmentDeps (the existing
  // injection seam used by tests/fulfillment.test.ts). Retail auto reaches the
  // effect seams; a signed-settled bound order moved to auto stays at zero.
  const counters: Record<string, number> = {};
  const story = { title: 'Synthetic', dedication: '', characterDescription: 'A synthetic child.',
    pages: Array.from({ length: 24 }, (_, i) => ({ pageNum: i + 1, sceneTitle: `S${i + 1}`, story: `Page ${i + 1}.`, imagePrompt: `prompt ${i + 1}` })) };
  const bump = (k: string) => { counters[k] = (counters[k] ?? 0) + 1; };
  const countingDeps = {
    generateStory: async () => { bump('generateStory'); return story; },
    generateImages: async (prompts: string[]) => { bump('generateImages'); return prompts.map((_, i) => `https://cdn.synthetic.invalid/p${i + 1}.jpg`); },
    buildPdf: async () => { bump('buildPdf'); return Buffer.from('%PDF-1.4 synthetic'); },
    buildPrintInteriorPdf: async () => { bump('buildPrintInteriorPdf'); return Buffer.from('%PDF-1.4 i'); },
    buildPrintCoverPdf: () => { bump('buildPrintCoverPdf'); return Buffer.from('%PDF-1.4 c'); },
    calculateCoverDimensions: async () => { bump('calculateCoverDimensions'); return { widthPt: 1, heightPt: 1 }; },
    uploadArtifact: async (oid: string, _b: Buffer, f: string) => { bump('uploadArtifact'); return `https://cdn.synthetic.invalid/${oid}/${f}`; },
    submitPrint: async () => { bump('submitPrint'); return { jobId: 'synthetic-job' }; },
    sleep: async () => {},
    getBaseUrl: () => 'https://synthetic.invalid',
  };
  const total = () => Object.values(counters).reduce((a, b) => a + b, 0);
  // Retail control (labelled fixture): unbound paid auto order.
  const retailAuto = freshId();
  const ra = orders.createOrderRecord({ email: 'retail-auto@example.invalid', bookFormat: 'digital', childName: 'RETAIL' }, { id: retailAuto, fulfillmentMode: 'auto' });
  Object.assign(ra, { paymentStatus: 'paid', paidAt: new Date().toISOString(), stripeSessionId: 'cs_test_synthetic_retail_auto' });
  await orders.persistNewOrder(ra);
  await fulfillment.triggerFulfillment(retailAuto, countingDeps).catch(() => undefined);
  assert.ok((counters.generateStory ?? 0) >= 1, `retail auto reaches the inert story effect seam: ${JSON.stringify(counters)}`);
  process.stdout.write(`SUBCASE C01 retail_auto_effect_positive counters=${JSON.stringify(counters)}\n`);
  // Bound: actual signed settlement, then an allowed generic mode transition to auto (effect-admissible except for the hold).
  const boundAuto = await settledBound();
  await orders.withOrderTransaction(boundAuto, (c: Obj) => ({ commit: { ...c, fulfillmentMode: 'auto', pageArtifacts: undefined, proofVersion: undefined, storyArtifactUrl: undefined, privateStoryArtifact: undefined, proofApprovalToken: undefined, updatedAt: new Date().toISOString() }, result: true }));
  const ba = await read(boundAuto);
  assert.equal(ba.fulfillmentMode, 'auto'); assert.equal(ba.paymentStatus, 'paid'); assert.equal(orders.isClassroomReleaseHeld(ba), true);
  for (const k of Object.keys(counters)) delete counters[k];
  const held = await fulfillment.triggerFulfillment(boundAuto, countingDeps);
  assert.match(JSON.stringify(held), new RegExp(HELD), 'bound auto: typed hold');
  assert.equal(total(), 0, 'bound auto: zero effect counters');
  process.stdout.write('SUBCASE C01 bound_auto_trigger held zero_counters\n');
  // Resumed: a stale (expired) kickoff claim in a recoverable status is re-entered.
  await orders.withOrderTransaction(boundAuto, (c: Obj) => ({ commit: { ...c, fulfillmentStatus: 'generating_story', fulfillmentKickoffId: 'stale-claim', fulfillmentKickoffAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), updatedAt: new Date().toISOString() }, result: true }));
  const resumed = await fulfillment.triggerFulfillment(boundAuto, countingDeps);
  assert.match(JSON.stringify(resumed), new RegExp(HELD), 'bound auto resumed claim: typed hold');
  assert.equal(total(), 0, 'bound auto resumed: zero effect counters');
  assert.equal((await read(boundAuto)).fulfillmentKickoffId, 'stale-claim', 'resumed: no new claim taken');
  process.stdout.write('SUBCASE C01 bound_auto_resumed_claim held zero_counters\n');
  const viaRetry = await admin.retryOrderFulfillment(boundAuto, countingDeps);
  assert.equal(viaRetry.status, 409); assert.equal(total(), 0);
  process.stdout.write('SUBCASE C01 bound_auto_admin_retry 409 zero_counters\n');

  // INTERNAL CLAIM boundary (legitimate schedule): trigger is admitted while the
  // order does not yet exist (entry hold sees null). During the native readback
  // sleep seam (FulfillmentDeps.sleep), the bound order is CREATED via the
  // create-only writer, settled through the signed route, and moved to auto via
  // a generic writer. Readback then sees paid; claimFulfillmentKickoff's
  // in-transaction hold is the first refusal. Without it this auto/paid record
  // would be claimed (no workOutbox/characterReview/media source/status).
  const lateId = freshId();
  let barrierRuns = 0;
  for (const k of Object.keys(counters)) delete counters[k];
  const lateDeps = {
    ...countingDeps,
    sleep: async () => {
      if (barrierRuns++ > 0) return;
      await settledBound(lateId);
      await orders.withOrderTransaction(lateId, (c: Obj) => ({ commit: { ...c, fulfillmentMode: 'auto', pageArtifacts: undefined, proofVersion: undefined, storyArtifactUrl: undefined, privateStoryArtifact: undefined, proofApprovalToken: undefined, updatedAt: new Date().toISOString() }, result: true }));
    },
  };
  const lateResult = await fulfillment.triggerFulfillment(lateId, lateDeps);
  const late = await read(lateId);
  assert.equal(barrierRuns >= 1, true, 'readback barrier reached after entry admission');
  assert.equal(late.paymentStatus, 'paid'); assert.equal(late.fulfillmentMode, 'auto'); assert.equal(orders.isClassroomReleaseHeld(late), true);
  assert.doesNotMatch(JSON.stringify(lateResult), /classroom_release_held/, 'entry hold was NOT the refusal (record absent at entry)');
  assert.deepEqual(lateResult, { status: 'skipped_already_running', fulfillmentStatus: 'policy_not_auto' }, 'claim-transaction hold refused');
  assert.equal(late.fulfillmentKickoffId ?? null, null, 'no kickoff claim committed');
  assert.equal(late.fulfillmentStatus ?? null, null, 'start never reached');
  assert.equal(total(), 0, 'internal claim boundary: zero effect counters');
  process.stdout.write('SUBCASE C01 internal_claim_hold_after_late_creation policy_not_auto no_claim zero_counters\n');

  // SWEEP: DIRECT ROUTE EXPORT src/app/api/cron/fulfillment-sweep with native
  // evaluateCronAuth, running the ACTUAL runFulfillmentSweep through the
  // existing route-deps seam; only its injected deps are inert
  // (listOrders = actual stored records, triggerFulfillment = actual trigger + counting FulfillmentDeps).
  process.env.CRON_SECRET = 'synthetic-cron-secret-consumers';
  const sweepRoute = await import('../src/app/api/cron/fulfillment-sweep/route.ts');
  const sweepDeps = await import('../src/lib/fulfillment-sweep-route-deps.ts');
  const sweepLib = await import('../src/lib/fulfillment-sweep.ts');
  const sweepWith = (ids: string[]) => sweepDeps.__setFulfillmentSweepRouteDepsForTests({
    runSweep: () => sweepLib.runFulfillmentSweep({
      listOrders: async () => Promise.all(ids.map(async (x) => (await orders.readOrderVersioned(x)).order)),
      triggerFulfillment: (x: string) => fulfillment.triggerFulfillment(x, countingDeps),
      now: () => Date.now(), graceMs: 0, log: () => {}, errorLog: () => {}, maxStarts: 5,
    }),
  });
  const cronReq = (auth: string | null) => new Request('http://127.0.0.1/api/cron/fulfillment-sweep', { headers: auth ? { authorization: auth } : {} });
  sweepWith([boundAuto]);
  const denied: Response = await sweepRoute.GET(cronReq('Bearer wrong'));
  assert.equal(denied.status, 401, 'native cron auth refuses first');
  for (const k of Object.keys(counters)) delete counters[k];
  const bSweep: Response = await sweepRoute.GET(cronReq(`Bearer ${process.env.CRON_SECRET}`));
  const bBody = await bSweep.json();
  assert.equal(bSweep.status, 200, JSON.stringify(bBody));
  assert.equal(bBody.eligible, 1, 'bound auto recoverable order IS sweep-eligible (effect-admissible fixture)');
  assert.equal(bBody.started, 0, 'bound: sweep never starts');
  assert.equal(bBody.skipped, 1, 'bound: trigger returned the typed hold');
  assert.equal(total(), 0, 'bound sweep: zero effect counters');
  assert.equal((await read(boundAuto)).fulfillmentKickoffId, 'stale-claim', 'bound sweep: no resume claim taken');
  process.stdout.write(`SUBCASE C01 route_sweep_bound eligible=1 started=0 skipped=1 zero_counters\n`);
  // Retail control through the same route + actual sweep: an eligible retail auto order is started and reaches the inert effect seams.
  const retailSweep = freshId();
  const rs = orders.createOrderRecord({ email: 'retail-sweep@example.invalid', bookFormat: 'digital', childName: 'RETAIL' }, { id: retailSweep, fulfillmentMode: 'auto' });
  Object.assign(rs, { paymentStatus: 'paid', paidAt: new Date(Date.now() - 60_000).toISOString(), stripeSessionId: 'cs_test_synthetic_retail_sweep' });
  await orders.persistNewOrder(rs);
  sweepWith([retailSweep]);
  const rSweep: Response = await sweepRoute.GET(cronReq(`Bearer ${process.env.CRON_SECRET}`));
  const rBody = await rSweep.json();
  assert.equal(rBody.eligible, 1, JSON.stringify(rBody));
  assert.ok((counters.generateStory ?? 0) >= 1, `retail sweep reaches inert effect seam ${JSON.stringify(counters)}`);
  process.stdout.write(`SUBCASE C01 route_sweep_retail eligible=1 started=${rBody.started} skipped=${rBody.skipped} counters=${JSON.stringify(counters)}\n`);
  sweepDeps.__resetFulfillmentSweepRouteDepsForTests();

  // Retail control proceeds past the hold to its ordinary refusal/effect checks.
  const r = await fulfillment.rebuildProofFromPageArtifacts(retail, effectSpy().deps).catch((e: Error) => ({ error: e.message }));
  assert.doesNotMatch(JSON.stringify(r), new RegExp(HELD), 'retail control not held');
  assert.equal(networkCalls, 0);
});

test('C02_page_review_capabilities_mutations_and_reads', async () => {
  await fixtures();
  const b = await read(bound);
  const rt = await read(retail);
  assert.equal(pageReview.hasReviewAccess(rt, { reviewToken: TOKEN }), true, 'retail capability valid');
  assert.equal(pageReview.hasReviewAccess(b, { reviewToken: TOKEN }), false);
  assert.equal(pageReview.hasReviewWriteAccess(b, { reviewToken: TOKEN }), false);
  assert.equal(await pageReview.getReviewSnapshot(bound, { reviewToken: TOKEN }), null);
  assert.ok(await pageReview.getReviewSnapshot(retail, { reviewToken: TOKEN }), 'retail snapshot');
  assert.deepEqual(pageReview.evaluateReviewMutationEligibility(b), { status: 409, error: HELD });
  assert.deepEqual(pageReview.evaluateProofLayoutMutationLifecycle(b), { status: 409, error: HELD });
  assert.equal(pageReview.evaluateProofLayoutEditCapability(b).allowed, false);
  const snap = pageReview.reviewSnapshotFromOrder(b);
  assert.equal(JSON.stringify(snap).includes('review-asset'), false, 'bound snapshot exposes no artifacts');
  const before = JSON.stringify(await read(bound));
  const actor = pageReview.customerReviewActor(TOKEN);
  let executed = 0;
  // B2: effect-admissible native inputs for the four input-gated entry points.
  const GEOMETRY = { x: 0.1, y: 0.6, width: 0.8, height: 0.3, opacity: 0.85, fontScale: 1 };
  const proofBuild = { ok: true, proofUrl: 'https://cdn.synthetic.invalid/proof.pdf', sourceFingerprint: 'f'.repeat(64), proofVersion: 'pv_synthetic_build' };
  const inputs = (oid: string, ord: Obj) => ({
    save: { orderId: oid, pageIndex: 0, note: 'Synthetic wording change', reviewToken: TOKEN },
    build: proofBuild,
    fit: { orderId: oid, pageIndex: 0, actor, geometry: GEOMETRY, authoredAgainstProofVersion: ord.proofVersion ?? 'pv_synthetic_legacy', authoredAgainstFingerprint: ord.proofSourceFingerprint ?? 'e'.repeat(64) },
    layout: { orderId: oid, pageIndex: 0, actor, appliedBy: 'synthetic-operator', geometry: GEOMETRY, authoredAgainstProofVersion: ord.proofVersion ?? 'pv_synthetic_legacy', authoredAgainstFingerprint: ord.proofSourceFingerprint ?? 'e'.repeat(64) },
  });
  const INPUT_GATE_ERRORS = /invalid_note|invalid_page_index|proof_build_incomplete|invalid_geometry|binding_required|invalid_applied_by/;
  // Retail positives: identical inputs progress PAST the native input gates (inert: no build/render/upload deps).
  // B2: genuinely valid native proof state (24-page digital set, live proof,
  // COMPUTED proofSourceFingerprint, matching build identity) per operation.
  const { NEW_PROOF_LAYOUT_VERSION: LAYOUT } = await import('../src/lib/fulfillment-types.ts');
  const proofState = (oid: string): Obj => {
    // Native normalized page set (the exact form publish/fit fingerprint).
    const pages = fulfillment.normalizePageArtifactTextLayouts(Array.from({ length: 24 }, (_, i) => ({
      pageIndex: i, storyText: `Synthetic page ${i + 1}.`, basePrompt: `prompt ${i + 1}`,
      currentImageUrl: `https://cdn.synthetic.invalid/${oid}/p${i + 1}.jpg`, acceptedImageUrl: null,
      generationProvider: null, generationModel: null, regenerateCount: 0, accepted: false, feedbackHistory: [], versionHistory: [],
    })));
    const draft: Obj = { id: oid, childName: 'SYNTH', bookFormat: 'digital', printTitle: 'Synthetic', pageArtifacts: pages, layoutVersion: LAYOUT };
    const fp = fulfillment.proofSourceFingerprint(draft);
    assert.ok(typeof fp === 'string' && fp.length > 0, 'native fingerprint computed');
    return { pageArtifacts: pages, printTitle: 'Synthetic', layoutVersion: LAYOUT, proofVersion: `pv_${oid}`, proofSourceFingerprint: fp,
      storyArtifactUrl: `https://cdn.synthetic.invalid/${oid}/proof.pdf`, proofApprovalToken: TOKEN, reviewStatus: 'in_review' };
  };
  const proofRetail = async (): Promise<string> => {
    const oid = freshId();
    const o = orders.createOrderRecord({ email: 'retail-proof@example.invalid', bookFormat: 'digital', childName: 'SYNTH' }, { id: oid, fulfillmentMode: 'manual_hold' });
    Object.assign(o, { paymentStatus: 'paid', paidAt: new Date().toISOString(), stripeSessionId: 'cs_test_synthetic_retail_proof' }, proofState(oid));
    await orders.persistNewOrder(o);
    return oid;
  };
  const opInputs = (oid: string, st: Obj) => ({
    save: { orderId: oid, pageIndex: 0, note: 'Synthetic wording change', reviewToken: TOKEN },
    build: { ok: true, proofUrl: `https://cdn.synthetic.invalid/${oid}/proof-v2.pdf`, sourceFingerprint: st.proofSourceFingerprint, proofVersion: `pv2_${oid}` },
    fit: { orderId: oid, pageIndex: 0, actor, geometry: GEOMETRY, authoredAgainstProofVersion: st.proofVersion, authoredAgainstFingerprint: st.proofSourceFingerprint },
    layout: { orderId: oid, pageIndex: 0, actor, appliedBy: 'synthetic-operator', geometry: GEOMETRY, authoredAgainstProofVersion: st.proofVersion, authoredAgainstFingerprint: st.proofSourceFingerprint },
  });
  // Retail positives: an isolated fixture per operation; each must SUCCEED natively.
  {
    const id1 = await proofRetail(); const s1 = await read(id1);
    const r = await pageReview.saveTextChangeRequest(opInputs(id1, s1).save);
    assert.equal(r.ok, true, `B2 retail save: ${JSON.stringify(r)}`); assert.equal(r.status ?? 200, 200);
    process.stdout.write('SUBCASE B2 retail_saveTextChangeRequest 200\n');
  }
  {
    const id2 = await proofRetail(); const s2 = await read(id2);
    const r = await pageReview.publishProofGuarded(id2, opInputs(id2, s2).build, { actor });
    assert.equal(r.refreshed, true, `B2 retail publish: ${JSON.stringify(r)}`);
    assert.equal((await read(id2)).proofVersion, `pv2_${id2}`, 'retail publish committed new proof identity');
    process.stdout.write('SUBCASE B2 retail_publishProofGuarded refreshed=true\n');
  }
  {
    const id3 = await proofRetail(); const s3 = await read(id3);
    const r = await pageReview.evaluateProofFit(opInputs(id3, s3).fit);
    assert.equal(r.status, 200, `B2 retail fit: ${JSON.stringify(r)}`); assert.equal(r.ok, true);
    process.stdout.write('SUBCASE B2 retail_evaluateProofFit 200\n');
  }
  {
    const id4 = await proofRetail(); const s4 = await read(id4);
    const r = await pageReview.setProofLayoutOverride(opInputs(id4, s4).layout);
    assert.equal(r.status, 200, `B2 retail layout: ${JSON.stringify(r)}`); assert.equal(r.ok, true);
    process.stdout.write('SUBCASE B2 retail_setProofLayoutOverride 200\n');
  }
  // Bound counterpart: signed-settled bound order given the EQUIVALENT valid proof
  // state via a supported generic write (binding/custody untouched); exact hold, no change.
  const boundProof = await settledBound();
  await orders.withOrderTransaction(boundProof, (c: Obj) => ({ commit: { ...c, ...proofState(boundProof), privateStoryArtifact: undefined, updatedAt: new Date().toISOString() }, result: true }));
  const bp = await read(boundProof);
  assert.equal(bp.proofSourceFingerprint, fulfillment.proofSourceFingerprint(bp), 'bound proof fingerprint is natively current');
  const bi = opInputs(boundProof, bp);
  const boundBeforeB2 = JSON.stringify(bp);
  const net0 = networkCalls;
  for (const [label, run] of [
    ['saveTextChangeRequest', () => pageReview.saveTextChangeRequest(bi.save)],
    ['publishProofGuarded', () => pageReview.publishProofGuarded(boundProof, bi.build, { actor })],
    ['evaluateProofFit', () => pageReview.evaluateProofFit(bi.fit)],
    ['setProofLayoutOverride', () => pageReview.setProofLayoutOverride(bi.layout)],
  ] as const) {
    const r = await (run as () => Promise<Obj>)();
    assert.deepEqual(r, { ok: false, status: 409, error: HELD }, `B2 bound ${label}: exact hold shape`);
    process.stdout.write(`SUBCASE B2 bound_${label} exact_409_hold\n`);
  }
  assert.equal(JSON.stringify(await read(boundProof)), boundBeforeB2, 'B2: bound order unchanged');
  assert.equal(networkCalls, net0, 'B2: zero network/effects');
  for (const [label, run] of [
    // Native signatures; valid customer capability actor (retail-equivalent token).
    ['acceptPage', () => pageReview.acceptPage({ orderId: bound, pageIndex: 0, actor })],
    ['regeneratePage', () => pageReview.regeneratePage({ orderId: bound, pageIndex: 0, actor }, effectSpy().deps)],
    ['acknowledgeProofReview', () => pageReview.acknowledgeProofReview(bound, { actor, proofVersion: 'pv_synthetic_legacy' })],
    ['approveWholeBook', () => pageReview.approveWholeBook(bound, { actor })],
    ['saveTextChangeRequest', () => pageReview.saveTextChangeRequest({ orderId: bound, pageIndex: 0, note: 'Synthetic wording change', reviewToken: TOKEN })],
    ['resolveTextChangeRequest', () => pageReview.resolveTextChangeRequest({ orderId: bound, pageIndex: 0, storyText: 'x' })],
    ['prepareCustomerReviewLink', () => pageReview.prepareCustomerReviewLink(bound, { tokenFactory: () => 'never-minted' })],
    ['prepareCustomerReviewLink-replay', () => pageReview.prepareCustomerReviewLink(bound)],
    ['publishProofGuarded', () => pageReview.publishProofGuarded(bound, proofBuild, { actor })],
    ['setProofLayoutOverride', () => pageReview.setProofLayoutOverride({ ...bi.layout, orderId: bound })],
    ['requestLayoutHelp', () => pageReview.requestLayoutHelp({ orderId: bound, pageIndex: 0, actor })],
    ['evaluateProofFit', () => pageReview.evaluateProofFit({ ...bi.fit, orderId: bound })],
  ] as const) {
    const r = await (run as () => Promise<unknown>)().catch((e: Error) => ({ thrown: e.message }));
    assert.match(JSON.stringify(r), new RegExp(HELD), `${label}: typed 409 hold`);
    assert.doesNotMatch(JSON.stringify(r), /never-minted|reviewPath/, `${label}: no capability output`);
    executed += 1;
    process.stdout.write(`SUBCASE C02 ${label} held\n`);
  }
  assert.equal(executed, 12, 'all twelve page-review entry points executed');
  assert.equal(JSON.stringify(await read(bound)), before, 'no review mutation landed');
});

test('C03_mounted_character_review', async () => {
  await fixtures();
  const id = await settledBound();
  const sheet = 'f'.repeat(64);
  const { createHash } = await import('node:crypto');
  const capability = 'synthetic-character-capability-token-0001';
  const review = { version: 'v1', imageHash: sheet, description: 'SYNTH', tokenHash: createHash('sha256').update(capability).digest('hex'), expiresAt: FUTURE, status: 'awaiting_customer', history: [], workQueue: [] };
  await orders.withOrderTransaction(id, (c: Obj) => ({ commit: { ...c, pageArtifacts: undefined, proofVersion: undefined, characterReview: review }, result: true }));
  // Retail control with the SAME valid capability: customer review GET succeeds (200) before any hold claim.
  const retailId = await retailPaid();
  await orders.withOrderTransaction(retailId, (c: Obj) => ({ commit: { ...c, pageArtifacts: undefined, proofVersion: undefined, characterReview: review }, result: true }));
  let artifactReads = 0; let commits = 0;
  const deps = {
    authenticate: () => true,
    readOrder: async (oid: string) => orders.readOrderVersioned(oid),
    readArtifact: async () => { artifactReads += 1; throw new Error('inert'); },
    commit: async () => { commits += 1; return { ok: true }; },
    now: () => new Date(),
  };
  const req = (method: string, url: string, body?: unknown) => new Request(url, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${capability}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const base = `http://127.0.0.1/api/character-review/${id}`;
  const retailGet = await characterReview.characterReviewRequest(req('GET', `http://127.0.0.1/api/character-review/${retailId}`), retailId, deps);
  assert.equal(retailGet.status, 200, 'retail valid-capability baseline 200');
  process.stdout.write('SUBCASE C03 retail_valid_capability_get 200\n');
  const adminGet = await characterReview.characterReviewRequest(req('GET', base), id, deps, true);
  assert.equal(adminGet.status, 200, 'admin metadata GET remains valid without capability');
  for (const [label, r] of [
    ['admin adoption', await characterReview.characterReviewRequest(req('POST', base, { expectedVersion: 'v1', attestation: 'reviewed_exact_character_sheet', imageHash: sheet, description: 'x' }), id, deps, true)],
    ['admin reissue', await characterReview.characterReviewRequest(req('POST', base, { action: 'reissue_invitation', expectedVersion: 'v1' }), id, deps, true)],
  ] as const) {
    assert.equal(r.status, 409, label);
    assert.equal((await r.json()).error, HELD, label);
  }
  assert.equal(artifactReads, 0); assert.equal(commits, 0);
  // Customer paths: hold precedes image/review/decision (capability irrelevant once held).
  for (const [label, r] of [
    ['customer image', await characterReview.characterReviewRequest(req('GET', `${base}?asset=image&version=v1`), id, deps)],
    ['customer review GET', await characterReview.characterReviewRequest(req('GET', base), id, deps)],
    ['approve', await characterReview.characterReviewRequest(req('POST', base, { version: 'v1', action: 'approve' }), id, deps)],
    ['request_changes', await characterReview.characterReviewRequest(req('POST', base, { version: 'v1', action: 'request_changes', comment: 'x' }), id, deps)],
  ] as const) {
    assert.equal(r.status, 409, `${label}: exact hold with valid capability`);
    assert.equal((await r.json()).error, HELD, label);
    assert.doesNotMatch(r.headers.get('content-type') ?? '', /image/, `${label}: no bytes`);
    process.stdout.write(`SUBCASE C03 ${label} 409\n`);
  }
  assert.equal(artifactReads, 0); assert.equal(commits, 0);

  // DIRECT ROUTE EXPORT with the actual manualMediaProofRuntime (native auth,
  // native order reads/commit, native private reader over the inert fake).
  const crRoute = await import('../src/app/api/order/[orderId]/character-review/route.ts');
  const ctx = (oid: string) => ({ params: Promise.resolve({ orderId: oid }) });
  const reads0 = blobFake.journal.filter((e: Obj) => e.op === 'get').length;
  const rr: Response = await crRoute.GET(req('GET', `http://127.0.0.1/api/order/${retailId}/character-review`), ctx(retailId));
  assert.equal(rr.status, 200, 'ROUTE retail valid-capability review GET 200');
  process.stdout.write('SUBCASE C03 route_retail_review_get 200\n');
  for (const [label, r] of [
    ['route bound review GET', await crRoute.GET(req('GET', `http://127.0.0.1/api/order/${id}/character-review`), ctx(id))],
    ['route bound image GET', await crRoute.GET(req('GET', `http://127.0.0.1/api/order/${id}/character-review?asset=image&version=v1`), ctx(id))],
    ['route bound approve', await crRoute.POST(req('POST', `http://127.0.0.1/api/order/${id}/character-review`, { version: 'v1', action: 'approve' }), ctx(id))],
    ['route bound request_changes', await crRoute.POST(req('POST', `http://127.0.0.1/api/order/${id}/character-review`, { version: 'v1', action: 'request_changes', comment: 'synthetic change' }), ctx(id))],
    ['route bound duplicate approve', await crRoute.POST(req('POST', `http://127.0.0.1/api/order/${id}/character-review`, { version: 'v1', action: 'approve' }), ctx(id))],
  ] as const) {
    assert.equal(r.status, 409, label);
    assert.equal((await r.json()).error, HELD, label);
    process.stdout.write(`SUBCASE C03 ${label.replace(/ /g, '_')} 409\n`);
  }
  // DIRECT ROUTE EXPORT: admin character-review route (native admin auth + actual runtime).
  const adminCrRoute = await import('../src/app/api/admin/orders/[orderId]/character-review/route.ts');
  const adminRouteReq = (method: string, body?: unknown, key: string | null = process.env.HSB_ORDER_ADMIN_KEY!) => new Request(`http://127.0.0.1/api/admin/orders/${id}/character-review`, {
    method, headers: { 'content-type': 'application/json', ...(key ? { 'x-hsb-order-admin-key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const commits0 = JSON.stringify((await read(id)).characterReview);
  const aUnauth: Response = await adminCrRoute.GET(adminRouteReq('GET', undefined, null), ctx(id));
  assert.equal(aUnauth.status, 401, 'ROUTE admin: native auth refuses first');
  const aMeta: Response = await adminCrRoute.GET(adminRouteReq('GET'), ctx(id));
  assert.equal(aMeta.status, 200, 'ROUTE admin metadata GET 200');
  process.stdout.write('SUBCASE C03 route_admin_metadata_get 200\n');
  for (const [label, body] of [
    ['route_admin_adoption', { expectedVersion: 'v1', attestation: 'reviewed_exact_character_sheet', imageHash: sheet, description: 'x' }],
    ['route_admin_reissue', { action: 'reissue_invitation', expectedVersion: 'v1' }],
  ] as const) {
    const r: Response = await adminCrRoute.POST(adminRouteReq('POST', body), ctx(id));
    assert.equal(r.status, 409, label); assert.equal((await r.json()).error, HELD, label);
    process.stdout.write(`SUBCASE C03 ${label} 409\n`);
  }
  assert.equal(JSON.stringify((await read(id)).characterReview), commits0, 'ROUTE admin: no review/token commit');
  // Admin character-review handler with the ACTUAL runtime (handler-level, retained).
  const { manualMediaProofRuntime } = await import('../src/lib/manual-media-proof-runtime.ts');
  const adminReq = (method: string, body?: unknown) => new Request(`http://127.0.0.1/api/admin/orders/${id}/character-review`, {
    method, headers: { 'content-type': 'application/json', 'x-hsb-order-admin-key': process.env.HSB_ORDER_ADMIN_KEY! }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const adminMeta: Response = await characterReview.characterReviewRequest(adminReq('GET'), id, manualMediaProofRuntime, true);
  assert.equal(adminMeta.status, 200, 'native admin auth: metadata GET 200 without capability');
  process.stdout.write('SUBCASE C03 runtime_admin_metadata_get 200\n');
  for (const [label, body] of [
    ['runtime_admin_adoption', { expectedVersion: 'v1', attestation: 'reviewed_exact_character_sheet', imageHash: sheet, description: 'x' }],
    ['runtime_admin_reissue', { action: 'reissue_invitation', expectedVersion: 'v1' }],
  ] as const) {
    const r: Response = await characterReview.characterReviewRequest(adminReq('POST', body), id, manualMediaProofRuntime, true);
    assert.equal(r.status, 409, label); assert.equal((await r.json()).error, HELD, label);
    process.stdout.write(`SUBCASE C03 ${label} 409\n`);
  }
  const unauth: Response = await characterReview.characterReviewRequest(new Request(`http://127.0.0.1/x`, { method: 'GET' }), id, manualMediaProofRuntime, true);
  assert.equal(unauth.status, 401, 'native admin auth still refuses first');
  assert.equal(blobFake.journal.filter((e: Obj) => e.op === 'get').length, reads0, 'ROUTE: zero private artifact reads');
  const stored = await read(id);
  assert.deepEqual(stored.characterReview.workQueue, [], 'ROUTE: no queue authority written');
});

test('C04_private_cookie_and_asset', async () => {
  await fixtures();
  const id = await settledBound();
  const rid = retail;
  let blobReads = 0;
  const getPrivateBlob = async (p: string) => { blobReads += 1; return { pathname: p, contentType: 'image/png', body: new Uint8Array([1, 2, 3, 4]) }; };
  const sessionReq = () => new Request('http://127.0.0.1/s', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  const assetReq = (oid: string) => new Request(`http://127.0.0.1/api/order/${oid}/review-asset/page-01?token=${TOKEN}`, { headers: { cookie: `hsb_review_${oid}=${TOKEN}` } });
  const rs = await privateReview.handlePrivateReviewSessionRequest(sessionReq(), rid);
  assert.equal(rs.status, 200, 'retail control mints session'); assert.ok(rs.headers['Set-Cookie']);
  const s = await privateReview.handlePrivateReviewSessionRequest(sessionReq(), id);
  assert.notEqual(s.status, 200); assert.equal(s.headers['Set-Cookie'], undefined);
  assert.equal(s.internalReason, HELD, 'internal typed hold reason');
  const a = await privateReview.handlePrivateReviewAssetRequest(assetReq(id), id, 'page-01', { getPrivateBlob });
  assert.equal(a.status, 404); assert.equal(a.internalReason, HELD); assert.equal(blobReads, 0, 'no artifact read');
  await privateReview.handlePrivateReviewAssetRequest(assetReq(rid), rid, 'page-01', { getPrivateBlob });
  assert.ok(blobReads >= 1, 'retail fixture found and capable of reaching the blob read');

  // DIRECT ROUTE EXPORT (not mounted HTTP): actual Next route modules, native
  // capability checks, native default private-blob reader over the inert fake.
  const sessionRoute = await import('../src/app/api/order/[orderId]/review-session/route.ts');
  const assetRoute = await import('../src/app/api/order/[orderId]/review-asset/[assetId]/route.ts');
  const ptoken = process.env.HSB_PRIVATE_READ_WRITE_TOKEN!;
  for (const oid of [rid, id]) {
    await blobFake.put(`orders/${oid}/private/page-01.png`, PAGE_BYTES, { access: 'private', token: ptoken, allowOverwrite: true, contentType: 'image/png' });
  }
  const before = blobFake.journal.filter((e: Obj) => e.op === 'get').length;
  const rSess: Response = await sessionRoute.POST(sessionReq(), { params: Promise.resolve({ orderId: rid }) });
  assert.equal(rSess.status, 200, 'ROUTE retail session baseline 200');
  assert.ok(rSess.headers.get('set-cookie'), 'ROUTE retail cookie minted');
  process.stdout.write('SUBCASE C04 route_retail_session 200\n');
  const rAsset: Response = await assetRoute.GET(assetReq(rid), { params: Promise.resolve({ orderId: rid, assetId: 'page-01' }) });
  assert.equal(rAsset.status, 200, 'ROUTE retail asset baseline 200');
  assert.deepEqual(Buffer.from(await rAsset.arrayBuffer()), PAGE_BYTES, 'ROUTE retail bytes served');
  process.stdout.write('SUBCASE C04 route_retail_asset 200 bytes\n');
  const afterRetail = blobFake.journal.filter((e: Obj) => e.op === 'get').length;
  assert.ok(afterRetail > before, 'retail route reached native private blob read');
  // Negative auth control: wrong capability on the bound order gets the ORIGINAL non-disclosing envelope, before any hold.
  const wrongSess: Response = await sessionRoute.POST(new Request('http://127.0.0.1/s', { method: 'POST', body: JSON.stringify({ token: 'wrong-synthetic-token' }) }), { params: Promise.resolve({ orderId: id }) });
  assert.equal(wrongSess.status, 403, 'ROUTE bound wrong capability: 403');
  assert.equal(wrongSess.headers.get('set-cookie'), null);
  assert.notEqual((await wrongSess.json()).error, HELD, 'hold not disclosed to unauthorized caller');
  process.stdout.write('SUBCASE C04 route_bound_wrong_capability 403 no_cookie no_hold_disclosure\n');
  const bSess: Response = await sessionRoute.POST(sessionReq(), { params: Promise.resolve({ orderId: id }) });
  assert.equal(bSess.status, 409, 'ROUTE bound session with valid capability: exact 409 hold');
  assert.equal((await bSess.json()).error, HELD);
  assert.equal(bSess.headers.get('set-cookie'), null, 'ROUTE bound: no cookie');
  process.stdout.write('SUBCASE C04 route_bound_session 409\n');
  const bAsset: Response = await assetRoute.GET(assetReq(id), { params: Promise.resolve({ orderId: id, assetId: 'page-01' }) });
  assert.equal(bAsset.status, 404, 'ROUTE bound asset: generic 404');
  assert.equal(blobFake.journal.filter((e: Obj) => e.op === 'get').length, afterRetail, 'ROUTE bound: zero private blob reads');
  process.stdout.write('SUBCASE C04 route_bound_asset 404 zero_reads\n');
});

test('C05_admin_and_outbox_authority', async () => {
  await fixtures();
  const id = await settledBound();
  for (const [label, run] of [
    ['resendDigitalDelivery', () => admin.resendDigitalDelivery(id)],
    ['resendProofEmail', () => admin.resendProofEmail(id, 'http://127.0.0.1')],
    ['markOrderShipped', () => admin.markOrderShipped(id, { trackingNumber: 'T1', carrier: 'synthetic' })],
    ['manuallyApproveProof', () => admin.manuallyApproveProof(id)],
    ['retryOrderFulfillment', () => admin.retryOrderFulfillment(id, effectSpy().deps)],
  ] as const) {
    const r = await (run as () => Promise<Obj>)();
    assert.equal(r.ok, false, label); assert.equal(r.status, 409, label); assert.equal(r.error, HELD, label);
  }
  assert.equal(networkCalls, 0);
  const o = await read(id);
  const forged = { id: 'evt_x', kind: 'new_paid_order', version: null, at: new Date().toISOString(), revenue: 'paid', owner: { status: 'pending', attempts: 0 }, agent: { status: 'pending', attempts: 0 } };
  const noArtifacts = { ...o, pageArtifacts: undefined, proofVersion: undefined, workOutbox: [forged] };
  assert.equal(outbox.eligible(noArtifacts, forged), false, 'forged revenue=paid cannot gain authority');
  assert.equal(outbox.eligible(noArtifacts, forged, 'owner'), false);
  assert.throws(() => outbox.mutateOutbox(noArtifacts, { action: 'claim', eventId: 'evt_x', lane: 'agent', worker: 'w' }, Date.now()));
  assert.equal(outbox.validDeliveryClaim(noArtifacts, 'evt_x', 'agent', 't', Date.now()), false);
  assert.equal(outbox.validWorkFence(noArtifacts, 'evt_x', 't', Date.now()), false);
  assert.throws(() => outbox.requireAdoptionFence({ ...o, workOutbox: undefined }, null, 'character', Date.now()), /classroom_release_held/, 'no-workOutbox early return closed');
  let transport = 0;
  // Actual store command semantics: the claim is computed by the real mutateOutbox over the stored record.
  let claimError = '';
  const store = {
    command: async (oid: string, cmd: Obj) => {
      try { return outbox.mutateOutbox({ ...(await read(oid)), pageArtifacts: undefined, proofVersion: undefined, workOutbox: [forged] }, cmd, Date.now()); } catch (e) { claimError = (e as Error).message; throw e; }
    },
    validate: async () => false,
  };
  await assert.rejects(outbox.deliverClaim(store, { reconcile: async () => { transport += 1; return { status: 'absent' }; }, deliver: async () => { transport += 1; return { receipt: 'r' }; } }, id, 'evt_x', 'agent', 'w'));
  assert.equal(claimError, 'ineligible_or_stale', 'claim refused by the held eligibility');
  assert.equal(transport, 0);
  // Retail control: unbound eligible event passes.
  const rr = { ...(await read(retail)), pageArtifacts: undefined, proofVersion: undefined };
  assert.equal(outbox.eligible(rr, forged), true);
  // Lulu status recorded without notification; refund path not blanket-banned.
  const lulu = await admin.applyLuluStatusUpdate({ data: { external_id: id, id: 'job_synthetic', status: { name: 'SHIPPED' } } });
  assert.notEqual(lulu.error, HELD, 'historical status path not blanket-held');
  assert.equal(networkCalls, 0, 'no notification transport');

  // Historical status persistence matrix (native applyLuluStatusUpdate) on a
  // signed-settled bound order carrying a print job id: recorded, never notified.
  const expected: Record<string, Obj> = {
    IN_PRODUCTION: { printJobStatus: 'IN_PRODUCTION', status: 'print_in_production' },
    PRODUCTION_DELAYED: { printJobStatus: 'PRODUCTION_DELAYED', status: 'print_in_production' },
    REJECTED: { printJobStatus: 'REJECTED', fulfillmentStatus: 'failed_manual_review' },
    SHIPPED: { printJobStatus: 'SHIPPED', status: 'shipped', trackingNumber: 'TRK-SYNTH-1' },
  };
  for (const [statusName, want] of Object.entries(expected)) {
    const lid = await settledBound();
    await orders.withOrderTransaction(lid, (c: Obj) => ({ commit: { ...c, printJobId: 'job_synth_hist', updatedAt: new Date().toISOString() }, result: true }));
    const net0 = networkCalls;
    const r = await admin.applyLuluStatusUpdate({ data: { external_id: lid, id: 'job_synth_hist', status: { name: statusName }, line_items: [{ tracking_id: 'TRK-SYNTH-1', tracking_urls: ['https://track.synthetic.invalid/1'] }] } });
    assert.equal(r.ok, true, `${statusName}: recorded ${JSON.stringify(r)}`);
    const stored = await read(lid);
    for (const [k, v] of Object.entries(want)) assert.equal(stored[k], v, `${statusName}: ${k} persisted`);
    assert.equal(networkCalls, net0, `${statusName}: zero notification transport`);
    assert.equal(stored.paymentStatus, 'paid'); assert.ok(stored.classroomFinancialReceipt, `${statusName}: financial evidence intact`);
    process.stdout.write(`SUBCASE C05 lulu_${statusName} recorded no_notification\n`);
  }

  // Refund remains available under existing defenses (injected inert Stripe refund client).
  let refundCreates = 0;
  const refundClient = (intent: string | null) => () => ({
    retrieveSession: async () => ({ payment_intent: intent }),
    createRefund: async () => { refundCreates += 1; return { id: 're_synthetic_1' }; },
  });
  const retailRefundId = await retailPaid();
  const rRefund = await admin.refundOrder(retailRefundId, 'synthetic', { getStripe: refundClient('pi_synthetic_retail') });
  assert.equal(rRefund.ok, true, `retail refund positive ${JSON.stringify(rRefund)}`);
  assert.equal((await read(retailRefundId)).paymentStatus, 'refunded');
  process.stdout.write('SUBCASE C05 refund_retail_positive refunded\n');
  const boundRefundId = await settledBound();
  const creates0 = refundCreates;
  const bRefund = await admin.refundOrder(boundRefundId, 'synthetic', { getStripe: refundClient(null) });
  assert.notEqual(bRefund.error, HELD, 'refund path not blanket-held for bound orders');
  process.stdout.write(`SUBCASE C05 refund_bound_zero_total status=${bRefund.status} error=${bRefund.error ?? 'none'} creates=${refundCreates - creates0}\n`);
});

test('C06_preserved_manifest_and_manual_proof_holds', async () => {
  await fixtures();
  const { readFileSync } = await import('node:fs');
  const handler = readFileSync(new URL('../src/lib/group-book/order-handler.ts', import.meta.url), 'utf8');
  assert.match(handler, /publisher/, 'manifest-only order publisher retained');
  const exportRoute = readFileSync(new URL('../src/app/api/admin/group-book/export/route.ts', import.meta.url), 'utf8');
  assert.match(exportRoute, /publisher:\s*null/, 'admin export null publisher unchanged');
  const runtime = readFileSync(new URL('../src/lib/manual-media-proof-runtime.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(runtime, /classroom|groupBookAssembly/i, 'manual-proof runtime has no classroom validator');
  // DIRECT ROUTE EXPORT: admin manual-proof adoption with the actual
  // manualMediaProofRuntime (no classroom validator) and native admin auth.
  const { canonicalSourceHash } = await import('../src/lib/review-source-identity.ts');
  const { NEW_PROOF_LAYOUT_VERSION } = await import('../src/lib/fulfillment-types.ts');
  const proofRoute = await import('../src/app/api/admin/orders/[orderId]/manual-proof/route.ts');
  const manifestFor = (orderId: string) => {
    const story = { title: 'SYNTH', pages: [{ pageNum: 1, story: 'Synthetic page', imagePrompt: 'synthetic prompt' }] };
    const images = [{ filename: 'page-1.image', sha256: 'a'.repeat(64), bytes: 4 }];
    const expectedOrderHash = 'c'.repeat(64);
    const sourcePages = story.pages.map((p, i) => ({ pageIndex: i, storyText: p.story, textLayout: undefined, currentImageUrl: `sha256:${images[i].sha256}`, acceptedImageUrl: null, accepted: false }));
    const m = {
      schema: 'hsb-manual-media-proof-preparation-v1', orderId, expectedOrderHash,
      candidateVersion: canonicalSourceHash({ orderId, expectedOrderHash, story, pages: sourcePages }),
      status: 'local_candidate_not_adopted', customerReleaseAuthorized: false,
      proof: { filename: 'candidate.pdf', sha256: 'b'.repeat(64), bytes: 4 }, images, story, layoutVersion: NEW_PROOF_LAYOUT_VERSION,
    };
    return { attestation: 'reviewed_exact_candidate', mode: 'adopt', manifest: m, expectedManifestHash: canonicalSourceHash(m) };
  };
  const adminPost = (oid: string) => new Request(`http://127.0.0.1/api/admin/orders/${oid}/manual-proof`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hsb-order-admin-key': process.env.HSB_ORDER_ADMIN_KEY! }, body: JSON.stringify(manifestFor(oid)),
  });
  const gets0 = blobFake.journal.filter((e: Obj) => e.op === 'get').length;
  const boundBefore = JSON.stringify(await read(bound));
  const heldRes: Response = await proofRoute.POST(adminPost(bound), { params: Promise.resolve({ orderId: bound }) });
  const heldBody = await heldRes.json();
  assert.equal(heldRes.status, 400, JSON.stringify(heldBody));
  assert.equal(heldBody.error, 'group_book_assembly_unverified', 'ROUTE manual proof: actual runtime has no classroom validator -> held');
  assert.equal(JSON.stringify(await read(bound)), boundBefore, 'ROUTE manual proof: bound order unchanged');
  assert.equal(blobFake.journal.filter((e: Obj) => e.op === 'get').length, gets0, 'ROUTE manual proof: zero artifact reads');
  process.stdout.write('SUBCASE C06 route_manual_proof_bound group_book_assembly_unverified zero_reads\n');
  // Reach control (NOT success): the same valid manifest on an unbound retail
  // order passes manifest validation and the assembly gate, then stops at the
  // native preparation-state check. Proves the hold, not a fixture error, refused the bound order.
  const ctrl: Response = await proofRoute.POST(adminPost(retail), { params: Promise.resolve({ orderId: retail }) });
  const ctrlBody = await ctrl.json();
  assert.notEqual(ctrlBody.error, 'group_book_assembly_unverified', 'retail control passes the assembly gate');
  assert.doesNotMatch(String(ctrlBody.error), /^manifest_|^candidate_|^invalid_manifest/, `retail control manifest valid: ${ctrlBody.error}`);
  process.stdout.write(`SUBCASE C06 route_manual_proof_retail_reach_control ${ctrl.status} ${ctrlBody.error}\n`);
  // Positive admin DTO read (native projection module, pure): the held, paid
  // record still projects for operators; no custody field crosses the boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dtoMod: any = await import('../src/lib/admin-order-dto.ts');
  const boundRecord = await read(bound);
  let projected = 0;
  for (const [name, fn] of Object.entries(dtoMod)) {
    if (typeof fn !== 'function') continue;
    let out: unknown;
    try { out = (fn as (o: unknown) => unknown)(boundRecord); } catch { continue; }
    if (!out || typeof out !== 'object' || (out as Obj).id !== bound) continue;
    assert.equal((out as Obj).paymentStatus, 'paid', `${name}: positive DTO`);
    assert.doesNotMatch(JSON.stringify(out), /classroomAcceptedTerms|classroomAcceptedSession|classroomFinancialReceipt|classroomFinancialReconciliation/, `${name}: no custody leak`);
    projected += 1;
    process.stdout.write(`SUBCASE C06 admin_dto_${name} paid no_custody_fields\n`);
  }
  assert.ok(projected >= 1, 'at least one native admin DTO projection of the held order');
  // Positive authenticated status read of a held record stays available.
  const o = await read(bound);
  assert.equal(o.paymentStatus, 'paid');
  assert.equal(orders.isClassroomReleaseHeld(o), true);
});
