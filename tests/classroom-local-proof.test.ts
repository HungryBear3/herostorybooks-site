// SYNTHETIC classroom local proof journey. Real intake, withdrawal, roster,
// manifest, order, checkout, signed webhook, settlement, producer and native
// PDFKit bytes. Only the Stripe resources and the private Blob transport are
// in-memory; no network, print, email or storage provider is reached. The
// artifact is a private local proof, not a finished book or a release.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

import { resolveOwnedTestRuntime, resolvePdftotext } from './support/owned-test-runtime.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNED = resolveOwnedTestRuntime('hsb-classroom-local-proof');
const PDFTOTEXT = resolvePdftotext();
const ARTIFACT_ROOT = path.join(OWNED, 'synthetic-classroom-local-proof-artifact');
mkdirSync(ARTIFACT_ROOT, { recursive: true });
// One directory per run, so an earlier proof in this root is never overwritten.
const ARTIFACT_DIR = mkdtempSync(path.join(ARTIFACT_ROOT, 'run-'));
const STORE_ROOT = path.join(realpathSync(process.env.TMPDIR as string), 'classroom-local-proof');
mkdirSync(STORE_ROOT, { recursive: true });
const STORE = mkdtempSync(path.join(STORE_ROOT, 'orders-'));

const ADMIN_KEY = 'synthetic-classroom-local-proof-admin-key-0001';
const WEBHOOK_SECRET = 'whsec_synthetic_classroom_local_proof_only';
const GROUP_TOKEN = 'vercel_blob_rw_classroomproofsynthetic_localonly';
const KIND = 'hsb_classroom_zero_total_test';
const ELIGIBLE_ALPHA = 'SyntheticEligibleAlpha';
const ELIGIBLE_BRAVO = 'SyntheticEligibleBravo';
const WITHDRAWN_CHARLIE = 'SyntheticWithdrawnCharlie';
const NOTES_MARKER = 'SyntheticNotesMarker';
const PARENT_MARKER = 'SyntheticParentMarker';
const FUTURE = new Date(Date.now() + 30 * 86400000).toISOString();
const COHORTS = Array.from({ length: 24 }, (_, index) => ['alpha', 'bravo', 'charlie'].map((name, family) => ({
  token: `SyntheticProofToken${String(index * 3 + family + 1).padStart(14, '0')}`,
  cohortId: `synthetic_proof_cohort_${index + 1}`,
  familySlotId: `family_${name}`,
  cohortLabel: 'Synthetic classroom',
  expiresAt: FUTURE,
})));
process.env.HSB_ORDER_STORE_DIR = STORE;
process.env.HSB_PAYMENT_RECOVERY_STORE_DIR = path.join(STORE, 'recovery');
process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_classroom_local_proof_only';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.HSB_ORDER_ADMIN_KEY = ADMIN_KEY;
process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = GROUP_TOKEN;
process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify(COHORTS.flat());
process.env.GROUP_BOOK_INTAKE_ENABLED = 'true';
for (const name of ['VERCEL', 'VERCEL_ENV', 'BLOB_READ_WRITE_TOKEN', 'FAMILY_REVIEW_DEST_BLOB_TOKEN', 'HSB_BLOB_NAMESPACE', 'HSB_CLASSROOM_CODES_JSON', 'HSB_CLASSROOM_QA_ONLY', 'HSB_PAID_ORDER_OUTBOX_ENABLED']) delete process.env[name];
let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls += 1; throw new TypeError('synthetic_network_denied'); }) as typeof fetch;

const NEXT_HEADERS = new URL('./helpers/group-book-next-headers.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier === 'next/headers') return { url: NEXT_HEADERS, shortCircuit: true };
    if (specifier.startsWith('@/')) {
      const base = path.resolve(ROOT, 'src', specifier.slice(2));
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const sdk = { events: new Map<string, Obj>(), sessions: new Map<string, Obj>() };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RealStripe: any = (await import('stripe')).default;
class SyntheticStripe extends RealStripe {
  constructor(...args: unknown[]) {
    super(...args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any;
    self.events = { retrieve: async (id: string) => { const event = sdk.events.get(id); if (!event) throw new Error('synthetic_no_event'); return structuredClone(event); } };
    self.checkout = { sessions: {
      retrieve: async (id: string) => { const session = sdk.sessions.get(id); if (!session) throw new Error('synthetic_no_session'); return structuredClone(session); },
      create: async () => { throw new Error('synthetic_create_forbidden'); },
    } };
  }
}
mock.module('stripe', { defaultExport: SyntheticStripe });

// Binary-safe private transport: exact PDF and JPEG bytes survive the store.
const blob = await import(new URL('./helpers/group-book-blob-faults.mjs', import.meta.url).href);
const storeFake = await import(new URL('./helpers/blob-store-fake.mjs', import.meta.url).href);
mock.module('@vercel/blob', { namedExports: {
  ...blob,
  head: storeFake.head,
  BlobError: storeFake.BlobError,
  BlobNotFoundError: storeFake.BlobNotFoundError,
  BlobPreconditionFailedError: storeFake.BlobPreconditionFailedError,
  BlobStoreNotFoundError: class BlobStoreNotFoundError extends Error {},
} });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const orders: any = await import('../src/lib/orders.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const checkoutLib: any = await import('../src/lib/group-book/classroom-checkout.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const assembly: any = await import('../src/lib/group-book/assembly.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const exporter: any = await import('../src/lib/group-book/export.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const release: any = await import('../src/lib/group-book/release.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const session: any = await import('../src/lib/group-book/session.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store: any = await import('../src/lib/group-book/store.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const webhook: any = await import('../src/app/api/webhooks/stripe/route.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const intakeRoute: any = await import('../src/app/api/group-book/intake/route.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withdrawRoute: any = await import('../src/app/group-book/family/withdraw/route.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const orderRoute: any = await import('../src/app/api/admin/group-book/order/route.ts');
const headers = await import(NEXT_HEADERS);
const sharp = (await import('sharp')).default;

const PRODUCER = new URL('../src/lib/group-book/proof-artifact.ts', import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function producer(): Promise<any> {
  assert.ok(existsSync(PRODUCER), 'structural RED: group-book proof producer module is absent');
  return import(PRODUCER.href);
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = async (id: string): Promise<Obj> => JSON.parse(JSON.stringify((await orders.readOrderVersioned(id)).order));
const proofObjects = (cohortId: string): string[] => blob.paths().filter((p: string) => p.startsWith(`group-book/proofs/${cohortId}/`));
const generic = (id: string, over: Obj) => orders.withOrderTransaction(id, (c: Obj) => ({ commit: { ...c, ...over, updatedAt: new Date().toISOString() }, result: true }));

const policyState = release.groupBookPolicyState();
assert.equal(policyState.state, 'adopted');
const policy = policyState.current;

async function intake(invite: Obj, childFirstName: string) {
  const jpeg = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#557799' } }).jpeg().toBuffer();
  const form = new FormData();
  for (const [key, value] of Object.entries({
    invite: invite.token, parentName: PARENT_MARKER, parentEmail: 'synthetic-parent@example.invalid', childFirstName, ageRange: '5-6',
    characterNotes: NOTES_MARKER, guardianAuthority: 'true', sharedWithParticipatingFamilies: 'true', sourcePhotosRemainPrivate: 'true',
    schoolApprovalNotRepresentedOrImplied: 'true', policyVersion: policy.record.version, policyDigest: policy.digest,
  })) form.set(key, value);
  form.append('photos', new File([new Uint8Array(jpeg)], 'synthetic.jpg', { type: 'image/jpeg' }));
  const response: Response = await intakeRoute.POST(new Request('https://synthetic.invalid/api/group-book/intake', { method: 'POST', body: form }));
  assert.equal(response.status, 200, await response.clone().text());
}

async function withdraw(invite: Obj) {
  headers.setCookieHeader(`${session.GROUP_BOOK_ACCESS_COOKIE}=${invite.token}`);
  const response: Response = await withdrawRoute.POST();
  headers.setCookieHeader('');
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).omitFromProofAndPrint, true);
}

const adminRequest = (pathname: string) => new Request(`http://127.0.0.1${pathname}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-hsb-order-admin-key': ADMIN_KEY }, body: '{}',
});

let sequence = 0;
const checkoutProvider = {
  async createZeroTotalSession(request: Obj) {
    sequence += 1;
    const id = `cs_test_synthetic_proof_${process.pid}_${sequence}`;
    const created = {
      id, object: 'checkout.session', livemode: false, mode: 'payment', status: 'open', payment_status: 'unpaid',
      amount_subtotal: request.order.priceCents, amount_total: 0, total_details: { amount_discount: request.order.priceCents },
      currency: 'usd', client_reference_id: request.order.id, metadata: { ...request.metadata }, payment_intent: null,
      url: `https://checkout.synthetic.invalid/${id}`,
    };
    sdk.sessions.set(id, created);
    return structuredClone(created);
  },
  async retrieveSession(id: string) { return structuredClone(sdk.sessions.get(id)); },
};

function publishEvent(sessionId: string, orderId: string): string {
  Object.assign(sdk.sessions.get(sessionId)!, { status: 'complete', payment_status: 'no_payment_required' });
  sequence += 1;
  const id = `evt_synthetic_proof_${process.pid}_${sequence}`;
  sdk.events.set(id, {
    id, object: 'event', type: 'checkout.session.completed', livemode: false, created: 1_777_500_000 + sequence, api_version: '2024-06-20',
    data: { object: { id: sessionId, object: 'checkout.session', metadata: { kind: KIND, orderId } } },
  });
  return id;
}

async function deliver(eventId: string) {
  const payload = JSON.stringify(sdk.events.get(eventId));
  const signature = new RealStripe('sk_test_synthetic_signer').webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const response: Response = await webhook.POST(new Request('http://127.0.0.1/api/webhooks/stripe', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload,
  }));
  return { status: response.status, body: (await response.json()) as Obj };
}

let cohortIndex = 0;
/** Three real submissions, one real withdrawal before assembly, then the requested stage. */
async function scenario(stage: 'order' | 'checkout' | 'settled' = 'settled') {
  const family = COHORTS[cohortIndex];
  cohortIndex += 1;
  assert.ok(family, 'fresh synthetic cohort available');
  const [alpha, bravo, charlie] = family;
  await intake(alpha, ELIGIBLE_ALPHA);
  await intake(bravo, ELIGIBLE_BRAVO);
  await intake(charlie, WITHDRAWN_CHARLIE);
  await withdraw(charlie);
  process.env.HSB_CLASSROOM_ORDER_INPUT_JSON = JSON.stringify({
    schemaVersion: 1, enabled: true, selectedCohortId: alpha.cohortId,
    targets: [{ cohortId: alpha.cohortId, bookFormat: 'digital', contactEmail: 'teacher@example.invalid' }],
  });
  const created: Response = await orderRoute.POST(adminRequest('/api/admin/group-book/order'));
  assert.equal(created.status, 201, await created.clone().text());
  const orderId = ((await created.json()) as Obj).orderId as string;
  const base = { orderId, alpha, bravo, charlie, cohortId: alpha.cohortId, sessionId: '' };
  if (stage === 'order') return base;
  const checkout: Response = await checkoutLib.classroomCheckoutResponse(adminRequest('/api/admin/group-book/checkout'), {
    target: () => ({ orderId }), provider: checkoutProvider, baseUrl: () => 'http://127.0.0.1',
  });
  assert.equal(checkout.status, 200, await checkout.clone().text());
  const sessionId = (await read(orderId)).stripeSessionId as string;
  const bound = { ...base, sessionId };
  if (stage === 'checkout') return bound;
  const settled = await deliver(publishEvent(sessionId, orderId));
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.equal(settled.body.classroomSettlement, 'receipt_recorded_held');
  const paid = await read(orderId);
  assert.equal(paid.paymentStatus, 'paid');
  assert.equal(paid.settledAmountCents, 0);
  return bound;
}

function byteForms(marker: string): Buffer[] {
  const utf16le = Buffer.from(marker, 'utf16le');
  const utf16be = Buffer.from(utf16le).swap16();
  return [Buffer.from(marker, 'latin1'), utf16le, utf16be, Buffer.from(utf16be.toString('hex')), Buffer.from(utf16be.toString('hex').toUpperCase())];
}
const containsMarker = (haystack: Buffer, marker: string) => byteForms(marker).some((form) => haystack.includes(form));

function inflatedStreams(pdf: Buffer): string {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const start = pdf.indexOf('stream\n', at);
    if (start < 0) break;
    const begin = start + 7;
    const end = pdf.indexOf('endstream', begin);
    if (end < 0) break;
    try { out.push(inflateSync(pdf.subarray(begin, end - 1)).toString('latin1')); } catch { /* DCT image streams are not Flate */ }
    at = end + 9;
  }
  return out.join('\n');
}

function persistPrivate(file: string, bytes: Buffer | string) {
  const staged = `${file}.${process.pid}.tmp`;
  writeFileSync(staged, bytes, { mode: 0o600 });
  renameSync(staged, file);
  chmodSync(file, 0o600);
}

async function swapObject(pathname: string, bytes: Buffer) {
  await blob.del([pathname], { token: GROUP_TOKEN });
  await blob.put(pathname, bytes, { access: 'private', token: GROUP_TOKEN, allowOverwrite: false, contentType: 'application/pdf' });
}

test('J01_submission_withdrawal_zero_settlement_real_private_pdf_and_adoption', async () => {
  const proof = await producer();
  const s = await scenario();
  const before = await read(s.orderId);
  assert.equal(orders.isClassroomReleaseHeld(before), true);
  assert.equal(before.fulfillmentMode, 'manual_hold');

  // Withdrawal is OMIT, not erasure: the retained record and photo authorize nothing.
  const retained = await store.findGroupBookSubmission(s.charlie);
  assert.equal(retained.child.firstName, WITHDRAWN_CHARLIE);
  const retainedPhoto: Buffer = await blob.bytes(retained.photos[0].pathname);
  assert.ok(retainedPhoto && retainedPhoto.byteLength > 0, 'withdrawn source photo stays retained');
  assert.equal((await store.loadEffectiveGroupBookSubmission(s.charlie)).effectiveStatus, 'withdrawal_requested');

  const manifestRead = await assembly.readClassroomManifest(before.groupBookAssembly);
  assert.equal(manifestRead.state, 'found');
  assert.deepEqual(manifestRead.manifest.participants.map((p: Obj) => p.familySlotId), [s.alpha.familySlotId, s.bravo.familySlotId]);
  assert.deepEqual(proofObjects(s.cohortId), [], 'nothing is produced before the command');

  const outcome = await proof.produceAndAdoptClassroomProof(s.orderId);
  assert.equal(outcome.state, 'adopted', JSON.stringify(outcome));
  const adoption = outcome.adoption;
  const after = await read(s.orderId);
  assert.deepEqual(after.classroomProofAdoption, adoption);
  assert.equal(adoption.status, 'adopted_unreleased_local_proof');
  assert.equal(adoption.customerReleaseAuthorized, false);
  assert.equal(adoption.orderId, s.orderId);
  assert.equal(adoption.cohortId, s.cohortId);
  assert.equal(adoption.manifestDigest, before.groupBookAssembly.digest);
  assert.equal(adoption.manifestExpiresAt, before.groupBookAssembly.expiresAt);
  assert.equal(adoption.participantCount, 2);
  assert.deepEqual(adoption.settlement, {
    amountTotalCents: 0, dispatchAttemptId: before.classroomFinancialReceipt.dispatchAttemptId,
    providerEventId: before.classroomFinancialReceipt.providerEventId, sessionId: before.classroomFinancialReceipt.sessionId,
  });

  // Unreleased: no retail proof, capability, email, print or fulfillment state appeared.
  for (const field of ['privateStoryArtifact', 'storyArtifactUrl', 'proofVersion', 'proofApprovalToken', 'pageArtifacts', 'customerProofReleasedAt', 'printJobId', 'fulfillmentStatus', 'workOutbox']) {
    assert.equal(after[field] ?? null, null, `${field} stays absent`);
  }
  assert.equal(after.fulfillmentMode, 'manual_hold');
  assert.equal(after.status, 'order_received');
  assert.equal(orders.isClassroomReleaseHeld(after), true);
  assert.equal(networkCalls, 0);
  const rawOrder = JSON.stringify(after);
  for (const marker of [ELIGIBLE_ALPHA, ELIGIBLE_BRAVO, WITHDRAWN_CHARLIE, NOTES_MARKER, PARENT_MARKER]) assert.equal(rawOrder.includes(marker), false, `${marker} stays out of the order record`);

  // The stored bytes are the adopted bytes.
  assert.deepEqual(proofObjects(s.cohortId), [adoption.artifact.pathname]);
  const stored: Buffer = await blob.bytes(adoption.artifact.pathname);
  assert.equal(stored.byteLength, adoption.artifact.bytes);
  assert.equal(sha256(stored), adoption.artifact.sha256);
  assert.equal(stored.subarray(0, 5).toString('latin1'), '%PDF-');

  // Exact export to the owned filesystem, then independent readback.
  const pdfFile = path.join(ARTIFACT_DIR, 'synthetic-classroom-local-proof.pdf');
  persistPrivate(pdfFile, stored);
  const pdf = readFileSync(pdfFile);
  assert.equal(statSync(pdfFile).mode & 0o777, 0o600);
  assert.equal(sha256(pdf), adoption.artifact.sha256);

  const extracted = execFileSync(PDFTOTEXT, ['-enc', 'UTF-8', pdfFile, '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const compact = extracted.replace(/\s+/g, '');
  assert.ok(compact.includes(ELIGIBLE_ALPHA), 'alpha present in extracted text');
  assert.ok(compact.includes(ELIGIBLE_BRAVO), 'bravo present in extracted text');
  assert.equal(compact.includes(WITHDRAWN_CHARLIE), false, 'withdrawn child absent from extracted text');
  assert.ok(compact.includes('LOCALPROOFONLY'), 'clearly marked as a local proof');
  for (const marker of [NOTES_MARKER, PARENT_MARKER]) assert.equal(compact.includes(marker), false, `${marker} absent from extracted text`);

  assert.ok(containsMarker(pdf, ELIGIBLE_ALPHA), 'raw-byte control: eligible marker is findable');
  assert.ok(containsMarker(pdf, ELIGIBLE_BRAVO), 'raw-byte control: eligible marker is findable');
  assert.equal(containsMarker(pdf, WITHDRAWN_CHARLIE), false, 'withdrawn child absent from raw artifact bytes');
  const inflated = inflatedStreams(pdf);
  assert.match(inflated, /\bBT\b/, 'content streams were really inflated');
  assert.equal(containsMarker(Buffer.from(inflated, 'latin1'), WITHDRAWN_CHARLIE), false, 'withdrawn child absent from inflated streams');

  // Approved art is embedded verbatim; no customer photo is.
  const approved = proof.CLASSROOM_PROOF_APPROVED_ASSETS as Obj[];
  assert.equal(approved.length, 3);
  for (const asset of approved) {
    const bytes = readFileSync(path.join(ROOT, asset.path));
    assert.equal(sha256(bytes), asset.sha256, asset.path);
    assert.ok(pdf.includes(bytes), `${asset.path} embedded verbatim`);
  }
  assert.deepEqual(adoption.assetSha256, approved.map((asset) => asset.sha256));
  for (const invite of [s.alpha, s.bravo, s.charlie]) {
    const submission = await store.findGroupBookSubmission(invite);
    const photo: Buffer = await blob.bytes(submission.photos[0].pathname);
    assert.equal(pdf.includes(photo), false, 'no submitted photo in the PDF');
  }

  const verified = await proof.verifyClassroomProofAdoption(s.orderId);
  assert.deepEqual(verified, { ok: true, adoption });
  const replay = await proof.produceAndAdoptClassroomProof(s.orderId);
  assert.equal(replay.state, 'replayed');
  assert.deepEqual(replay.adoption, adoption);
  assert.deepEqual(proofObjects(s.cohortId), [adoption.artifact.pathname], 'replay wrote nothing');

  const receiptFile = path.join(ARTIFACT_DIR, 'synthetic-classroom-local-proof-receipt.json');
  const receipt = {
    schema: 'hsb-synthetic-classroom-local-proof-receipt-v1', synthetic: true, localProofOnly: true, customerReleaseAuthorized: false,
    path: pdfFile, sha256: sha256(pdf), bytes: pdf.byteLength,
    markerChecks: {
      eligible: { alphaInText: true, bravoInText: true, alphaInRawBytes: true, bravoInRawBytes: true },
      withdrawn: { inText: false, inRawBytes: false, inInflatedStreams: false },
    },
    submissions: { eligible: [s.alpha.familySlotId, s.bravo.familySlotId], withdrawnOmitted: [s.charlie.familySlotId] },
    roster: { cohortId: s.cohortId, digest: adoption.manifestDigest, participantCount: adoption.participantCount, manifestExpiresAt: adoption.manifestExpiresAt },
    settlement: adoption.settlement,
    adoption: { orderId: s.orderId, status: adoption.status, adoptedAt: adoption.adoptedAt, contentDigest: adoption.contentDigest, artifact: adoption.artifact },
    hostedProviderQualification: 'not_performed',
  };
  persistPrivate(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  assert.equal(JSON.parse(readFileSync(receiptFile, 'utf8')).sha256, adoption.artifact.sha256);
  assert.equal(statSync(receiptFile).mode & 0o777, 0o600);
  console.log(`SUBCASE J01 artifact path=${pdfFile} sha256=${receipt.sha256} bytes=${receipt.bytes} receipt=${receiptFile}`);
});

test('F01_withdrawal_after_assembly_refuses_before_any_artifact', async () => {
  const proof = await producer();
  const s = await scenario();
  await withdraw(s.alpha);
  assert.deepEqual(await proof.produceAndAdoptClassroomProof(s.orderId), { state: 'refused', reason: 'participation_changed' });
  assert.deepEqual(proofObjects(s.cohortId), []);
  assert.equal((await read(s.orderId)).classroomProofAdoption, undefined);
});

for (const point of ['producer:rendered', 'producer:before_adopt', 'producer:adopt_guarded'] as const) {
  test(`F02_withdrawal_race_at_${point}_fails_closed_and_leaves_no_proof`, async () => {
    const proof = await producer();
    const s = await scenario();
    let fired = 0;
    const outcome = await proof.produceAndAdoptClassroomProof(s.orderId, {
      barrier: async (name: string) => { if (name === point && fired === 0) { fired += 1; await withdraw(s.alpha); } },
    });
    assert.equal(fired, 1, 'the race landed at its seam');
    assert.deepEqual(outcome, { state: 'refused', reason: 'participation_changed' });
    assert.deepEqual(proofObjects(s.cohortId), [], 'a stale proof naming a withdrawn child is not retained');
    assert.equal((await read(s.orderId)).classroomProofAdoption, undefined);
  });
}

test('F03_withdrawal_after_adoption_is_not_silently_current', async () => {
  const proof = await producer();
  const s = await scenario();
  assert.equal((await proof.produceAndAdoptClassroomProof(s.orderId)).state, 'adopted');
  await withdraw(s.bravo);
  assert.deepEqual(await proof.verifyClassroomProofAdoption(s.orderId), { ok: false, reason: 'participation_changed' });
  assert.deepEqual(await proof.produceAndAdoptClassroomProof(s.orderId), { state: 'refused', reason: 'participation_changed' });
});

test('F04_expired_assembly_refuses_at_entry_and_inside_the_adoption_guard', async () => {
  const proof = await producer();
  const entry = await scenario();
  const expires = Date.parse((await read(entry.orderId)).groupBookAssembly.expiresAt);
  assert.deepEqual(await proof.produceAndAdoptClassroomProof(entry.orderId, { now: () => new Date(expires + 1000) }), { state: 'refused', reason: 'expired' });
  assert.deepEqual(proofObjects(entry.cohortId), []);

  const race = await scenario();
  let clock = Date.now();
  const outcome = await proof.produceAndAdoptClassroomProof(race.orderId, {
    now: () => new Date(clock),
    barrier: async (name: string) => { if (name === 'producer:before_adopt') clock = expires + 1000; },
  });
  assert.deepEqual(outcome, { state: 'refused', reason: 'expired' });
  assert.deepEqual(proofObjects(race.cohortId), []);
  assert.equal((await read(race.orderId)).classroomProofAdoption, undefined);
});

test('F05_fake_or_incomplete_settlement_never_authorizes_a_proof', async () => {
  const proof = await producer();
  const noCheckout = await scenario('order');
  await generic(noCheckout.orderId, { paymentStatus: 'paid', settledAmountCents: 0, paidAt: new Date().toISOString() });
  assert.deepEqual(await proof.produceAndAdoptClassroomProof(noCheckout.orderId), { state: 'refused', reason: 'accepted_custody_invalid' });

  const noReceipt = await scenario('checkout');
  await generic(noReceipt.orderId, { paymentStatus: 'paid', settledAmountCents: 0, paidAt: new Date().toISOString() });
  assert.deepEqual(await proof.produceAndAdoptClassroomProof(noReceipt.orderId), { state: 'refused', reason: 'receipt_missing' });

  const unprojected = await scenario('checkout');
  await withdraw(unprojected.alpha);
  assert.equal((await deliver(publishEvent(unprojected.sessionId, unprojected.orderId))).status, 200);
  const held = await read(unprojected.orderId);
  assert.ok(held.classroomFinancialReceipt, 'authentic receipt retained');
  assert.equal(held.paymentStatus, 'pending');
  assert.deepEqual(await proof.produceAndAdoptClassroomProof(unprojected.orderId), { state: 'refused', reason: 'payment_not_settled' });

  const conflicted = await scenario();
  assert.equal((await deliver(publishEvent(conflicted.sessionId, conflicted.orderId))).status, 409);
  assert.deepEqual(await proof.produceAndAdoptClassroomProof(conflicted.orderId), { state: 'refused', reason: 'reconciliation_open' });

  const refunded = await scenario();
  await generic(refunded.orderId, { refundClaimId: 'rc_synthetic_proof' });
  assert.deepEqual(await proof.produceAndAdoptClassroomProof(refunded.orderId), { state: 'refused', reason: 'refund_present' });

  for (const s of [noCheckout, noReceipt, unprojected, conflicted, refunded]) {
    assert.deepEqual(proofObjects(s.cohortId), [], 'no artifact from fake settlement');
    assert.equal((await read(s.orderId)).classroomProofAdoption, undefined);
  }
});

test('F06_refund_race_inside_the_custody_cas_is_rechecked_on_retry', async () => {
  const proof = await producer();
  const s = await scenario();
  const outcome = await proof.produceAndAdoptClassroomProof(s.orderId, {
    barrier: async (name: string) => { if (name === 'producer:adopt_guarded') await generic(s.orderId, { refundClaimId: 'rc_synthetic_race' }); },
  });
  assert.deepEqual(outcome, { state: 'refused', reason: 'refund_present' });
  assert.deepEqual(proofObjects(s.cohortId), []);
  assert.equal((await read(s.orderId)).classroomProofAdoption, undefined);
});

test('F07_mismatched_artifact_fails_before_adoption_and_on_recheck', async () => {
  const proof = await producer();
  const race = await scenario();
  const outcome = await proof.produceAndAdoptClassroomProof(race.orderId, {
    barrier: async (name: string) => {
      if (name !== 'producer:before_adopt') return;
      const [pathname] = proofObjects(race.cohortId);
      await swapObject(pathname, Buffer.from('%PDF-1.7 synthetic substitute'));
    },
  });
  assert.deepEqual(outcome, { state: 'refused', reason: 'artifact_mismatch' });
  assert.equal((await read(race.orderId)).classroomProofAdoption, undefined);

  const adopted = await scenario();
  const done = await proof.produceAndAdoptClassroomProof(adopted.orderId);
  assert.equal(done.state, 'adopted');
  await swapObject(done.adoption.artifact.pathname, Buffer.from('%PDF-1.7 synthetic substitute'));
  assert.deepEqual(await proof.verifyClassroomProofAdoption(adopted.orderId), { ok: false, reason: 'artifact_mismatch' });
});

test('F08_forged_foreign_or_generic_adoption_is_refused', async () => {
  const proof = await producer();
  const first = await scenario();
  const adopted = await proof.produceAndAdoptClassroomProof(first.orderId);
  assert.equal(adopted.state, 'adopted');
  const target = await scenario();
  const guard = async () => null;

  // A foreign order's record cannot be replayed onto this order.
  assert.deepEqual(await orders.adoptClassroomProofCustody(target.orderId, { adoption: adopted.adoption, guard }), { ok: false, reason: 'adoption_invalid' });

  // A well-formed record for this order with a caller guard still needs real settlement and real bytes.
  const order = await read(target.orderId);
  const binding = order.groupBookAssembly;
  const digest = 'e'.repeat(64);
  const forged = {
    ...adopted.adoption, orderId: target.orderId, cohortId: binding.cohortId, manifestDigest: binding.digest,
    manifestExpiresAt: binding.expiresAt, participantCount: binding.participantCount,
    settlement: {
      amountTotalCents: 0, dispatchAttemptId: order.classroomFinancialReceipt.dispatchAttemptId,
      providerEventId: order.classroomFinancialReceipt.providerEventId, sessionId: order.classroomFinancialReceipt.sessionId,
    },
    artifact: { ...adopted.adoption.artifact, pathname: `group-book/proofs/${binding.cohortId}/${target.orderId}/${digest}.pdf`, sha256: digest },
  };
  assert.deepEqual(await orders.adoptClassroomProofCustody(target.orderId, { adoption: forged, guard }), { ok: false, reason: 'artifact_missing' });
  const wrongEvent = { ...forged, settlement: { ...forged.settlement, providerEventId: 'evt_synthetic_forged' } };
  assert.deepEqual(await orders.adoptClassroomProofCustody(target.orderId, { adoption: wrongEvent, guard }), { ok: false, reason: 'adoption_identity' });
  assert.equal((await read(target.orderId)).classroomProofAdoption, undefined);

  // Generic writers cannot add, replace or remove adoption custody.
  await assert.rejects(generic(target.orderId, { classroomProofAdoption: forged }));
  await assert.rejects(generic(first.orderId, { classroomProofAdoption: { ...adopted.adoption, contentDigest: digest } }));
  await assert.rejects(orders.withOrderTransaction(first.orderId, (c: Obj) => { const next = { ...c }; delete next.classroomProofAdoption; return { commit: next, result: true }; }));
  assert.deepEqual((await read(first.orderId)).classroomProofAdoption, adopted.adoption);
});

test('F09_retail_fences_and_null_export_publisher_stay_unchanged', async () => {
  await producer();
  const runtime = readFileSync(path.join(ROOT, 'src/lib/manual-media-proof-runtime.ts'), 'utf8');
  assert.doesNotMatch(runtime, /classroom|groupBookAssembly/i, 'retail manual runtime gains no classroom validator');
  const exportRoute = readFileSync(path.join(ROOT, 'src/app/api/admin/group-book/export/route.ts'), 'utf8');
  assert.match(exportRoute, /publisher:\s*null/);
  const s = await scenario('order');
  const held = await exporter.assembleGroupBookExport({ cohortId: s.cohortId, publisher: null });
  assert.equal(held.state, 'hold');
  assert.equal(held.reason, 'no_group_book_artifact_producer');
  assert.equal(orders.isClassroomReleaseHeld({ id: 'ord_retail_unbound' }), false);
  assert.equal(networkCalls, 0);
});
