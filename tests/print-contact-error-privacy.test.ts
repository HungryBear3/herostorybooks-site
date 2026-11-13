/**
 * Print contact error privacy (correction-1, F1).
 *
 * The standard print lane sends the saved recipient name, delivery phone and
 * street to Lulu. Provider error bodies, transport exceptions and JSON parse
 * errors can echo those values back. None of them may reach the persisted
 * `fulfillmentLastError`, the two shared admin DTOs, any action return value,
 * the audit trail or a log line — while the canonical attempt fence, the
 * no-resubmit rule and every proof/financial field stay exactly as they are.
 *
 * Real: approvePrintProof, the DEFAULT submitPrintJob and calculateCoverDimensions,
 * the local canonical order store (CAS adapter), manuallyApproveProof,
 * retryOrderFulfillment and both admin DTO projections. Fake: globalThis.fetch
 * only (provider I/O), plus cover build/upload in the one valid-guard control.
 * `submitPrint` is never injected. Every endpoint is `.invalid`; nothing
 * leaves the host.
 *
 * State/fence assertions run first and stay hard. Privacy surfaces are then
 * collected and asserted together, so a RED run names every leaking surface
 * rather than stopping at the first.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { approvePrintProof, proofSourceFingerprint, type FulfillmentDeps } from '../src/lib/fulfillment.ts';
import { clearTokenCache, submitPrintJob } from '../src/lib/lulu.ts';
import {
  __resetOrderStoreAdapterFactoryForTests,
  createOrderRecord,
  getOrder,
  persistOrder,
  withOrderTransaction,
  type OrderRecord,
  type PageArtifact,
} from '../src/lib/orders.ts';
import { toAdminOrderDetail, toAdminOrderListItem } from '../src/lib/admin-order-dto.ts';
import { manuallyApproveProof, retryOrderFulfillment } from '../src/lib/admin-actions.ts';
import { ensureRecommendedTextLayout, NEW_PROOF_LAYOUT_VERSION } from '../src/lib/fulfillment-types.ts';
import { fillerPage, padPageSet } from './support/full-page-set.ts';

const NAME = 'Zqxname Recipient';
const PHONE = '+13125550177';
const STREET = '77 Qzx Lane';
/** Distinct substrings of the saved contact; none appears anywhere else in a fixture. */
const CONTACT_TOKENS = ['Zqxname', '3125550177', 'Qzx Lane'] as const;
const ECHO_TEXT = `${NAME} ${PHONE} ${STREET}`;
const ADDRESS = { line1: STREET, line2: null, city: 'Chicago', state: 'IL', zip: '60640', country: 'US', name: NAME, phone: PHONE };

const LULU = 'https://lulu.example.invalid';
const TOKEN_URL = `${LULU}/auth/realms/glasstree/protocol/openid-connect/token`;
const COVER_URL = `${LULU}/cover-dimensions/`;
const PRINT_JOBS_URL = `${LULU}/print-jobs/`;
const PROOF_TOKEN = 'synthetic-print-privacy-approval-token';
const NOW = '2026-11-12T12:00:00.000Z';

/** Assembled at runtime: committed tests carry no production-shaped order-id literal. */
const orderId = (n: number) => ['ord', `${'e'.repeat(14)}${n.toString(16).padStart(2, '0')}`].join('_');

// ── Environment, provider fake and log capture ────────────────────────────────

const MANAGED_ENV = [
  'HSB_ORDER_STORE_DIR', 'BLOB_READ_WRITE_TOKEN', 'HSB_REQUIRE_DURABLE_PERSISTENCE', 'HSB_BLOB_NAMESPACE',
  'HSB_BLOB_ACCESS_MODE', 'VERCEL', 'VERCEL_ENV', 'NEXT_PUBLIC_URL',
  'LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET', 'LULU_API_URL', 'LULU_SHIPPING_LEVEL',
  'LULU_SOFTCOVER_POD_PACKAGE_ID', 'LULU_HARDCOVER_POD_PACKAGE_ID', 'LULU_FALLBACK_PHONE',
  'HSB_SUPPORT_EMAIL', 'EMAIL_FROM', 'HSB_EMAIL_FROM', 'HSB_EMAIL_FROM_FALLBACK', 'RESEND_API_KEY', 'HSB_RESEND_API_KEY',
  'HSB_INITIAL_EXPEDITED_QUOTES_ENABLED', 'HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED',
  'HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION',
] as const;

type Mode = 'ok' | 'http400' | 'http503' | 'transport' | 'malformed' | 'auth401' | 'authTransport' | 'cover500' | 'coverGuard';

interface Provider {
  mode: Mode;
  printPosts: Array<Record<string, unknown>>;
  urls: string[];
  unmatched: string[];
  onCover?: () => Promise<void>;
}

function providerFetch(provider: Provider): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    provider.urls.push(url);
    const mode = provider.mode;
    if (url === TOKEN_URL) {
      if (mode === 'authTransport') throw new Error(`token connection reset for ${ECHO_TEXT}`);
      if (mode === 'auth401') return new Response(JSON.stringify({ error: 'invalid_client', detail: ECHO_TEXT }), { status: 401 });
      return new Response(JSON.stringify({ access_token: 'synthetic-only-token', expires_in: 3600 }), { status: 200 });
    }
    if (url === COVER_URL) {
      if (mode === 'cover500') return new Response(JSON.stringify({ detail: ECHO_TEXT }), { status: 500 });
      await provider.onCover?.();
      return new Response(JSON.stringify({ width: 1200, height: 650 }), { status: 200 });
    }
    if (url === PRINT_JOBS_URL) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      provider.printPosts.push(body);
      // A real echo: the provider repeats the exact values it was sent.
      const sent = body.shipping_address as Record<string, unknown>;
      const echo = { phone_number: sent.phone_number, name: sent.name, street1: sent.street1, detail: 'shipping_address invalid' };
      if (mode === 'http400') return new Response(JSON.stringify(echo), { status: 400 });
      if (mode === 'http503') return new Response(JSON.stringify(echo), { status: 503 });
      if (mode === 'transport') throw new Error(`socket hang up after sending ${JSON.stringify(echo)}`);
      if (mode === 'malformed') return new Response(`${sent.name} ${sent.phone_number} ${sent.street1}`, { status: 200 });
      return new Response(JSON.stringify({ id: 4242, status: 'CREATED' }), { status: 200 });
    }
    provider.unmatched.push(url);
    throw new Error('UNMATCHED_SYNTHETIC_FETCH');
  }) as typeof fetch;
}

function formatLogArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

interface World {
  provider: Provider;
  logs: string[];
}

async function withWorld(mode: Mode, run: (world: World) => Promise<void>): Promise<void> {
  const saved = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));
  const root = mkdtempSync(path.join(os.tmpdir(), 'hsb-print-contact-privacy-'));
  const realFetch = globalThis.fetch;
  const sinks = ['error', 'warn', 'log', 'info', 'debug'] as const;
  const originals = sinks.map((sink) => console[sink]);
  const provider: Provider = { mode, printPosts: [], urls: [], unmatched: [] };
  const logs: string[] = [];
  for (const key of MANAGED_ENV) delete process.env[key];
  process.env.HSB_ORDER_STORE_DIR = path.join(root, 'orders');
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
  process.env.LULU_CLIENT_KEY = 'synthetic-client';
  process.env.LULU_CLIENT_SECRET = 'synthetic-secret';
  process.env.LULU_API_URL = LULU;
  __resetOrderStoreAdapterFactoryForTests();
  clearTokenCache();
  globalThis.fetch = providerFetch(provider);
  for (const sink of sinks) {
    console[sink] = (...args: unknown[]) => { logs.push(args.map(formatLogArg).join(' ')); };
  }
  try {
    await run({ provider, logs });
  } finally {
    sinks.forEach((sink, index) => { console[sink] = originals[index]; });
    globalThis.fetch = realFetch;
    clearTokenCache();
    __resetOrderStoreAdapterFactoryForTests();
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── Fixture: an effect-admissible standard print order ────────────────────────

function completePages(): PageArtifact[] {
  return padPageSet([fillerPage(0)]).map((page) => ({ ...page, textLayout: ensureRecommendedTextLayout(page.textLayout) }));
}

function printOrder(id: string, overrides: Partial<OrderRecord> = {}): OrderRecord {
  const order: OrderRecord = {
    ...createOrderRecord(
      { childName: 'Synthetic Hero', bookFormat: 'classic', email: 'buyer@example.invalid' },
      { id, now: NOW },
    ),
    paymentStatus: 'paid',
    paidAt: NOW,
    settledAmountCents: 3900,
    stripeSessionId: `cs_test_privacy_${id.slice(-2)}`,
    stripePaymentIntentId: `pi_test_privacy_${id.slice(-2)}`,
    status: 'preview_ready',
    fulfillmentStatus: 'proof_ready',
    reviewStatus: 'approved',
    layoutVersion: NEW_PROOF_LAYOUT_VERSION,
    pageArtifacts: completePages(),
    storyArtifactUrl: `https://cdn.example.invalid/${id}/proof.pdf`,
    proofVersion: 'proof-v1',
    proofSourceFingerprint: null,
    proofReviewedAt: NOW,
    proofReviewedVersion: 'proof-v1',
    proofApprovalToken: PROOF_TOKEN,
    printInteriorArtifactUrl: `https://cdn.example.invalid/${id}/interior.pdf`,
    printInteriorMd5: 'synthetic-interior-md5',
    printInteriorPageCount: 32,
    printInteriorProofVersion: 'proof-v1',
    printTitle: 'Synthetic Hero Story',
    printCoverArtifactUrl: `https://cdn.example.invalid/${id}/cover.pdf`,
    printCoverMd5: 'synthetic-cover-md5',
    shippingAddress: { ...ADDRESS },
    ...overrides,
  };
  order.proofSourceFingerprint = proofSourceFingerprint(order);
  return order;
}

/** Financial, proof, artifact and contact fields no failure path may move. */
const RETAINED = [
  'paymentStatus', 'priceCents', 'settledAmountCents', 'paidAt', 'stripeSessionId', 'stripePaymentIntentId',
  'refundedAt', 'refundClaimId', 'stripeRefundId', 'proofVersion', 'proofSourceFingerprint', 'proofReviewedAt',
  'proofReviewedVersion', 'proofApprovalToken', 'reviewStatus', 'storyArtifactUrl', 'layoutVersion', 'pageArtifacts',
  'printInteriorArtifactUrl', 'printInteriorMd5', 'printInteriorPageCount', 'printInteriorProofVersion', 'printTitle',
  'printCoverArtifactUrl', 'printCoverMd5', 'shippingAddress',
] as const;

function retained(order: OrderRecord): Record<string, unknown> {
  const record = order as unknown as Record<string, unknown>;
  return Object.fromEntries(RETAINED.map((key) => [key, record[key] ?? null]));
}

/** Every `surface:token` pair where a contact token appears. */
function leakSurfaces(surfaces: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const [label, value] of Object.entries(surfaces)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    for (const token of CONTACT_TOKENS) if (text.includes(token)) found.push(`${label}:${token}`);
  }
  return found;
}

function assertSentRealContact(post: Record<string, unknown> | undefined): void {
  assert.ok(post, 'the print job was actually posted');
  const sent = post.shipping_address as Record<string, unknown>;
  assert.equal(sent.name, NAME);
  assert.equal(sent.phone_number, PHONE);
  assert.equal(sent.street1, STREET);
}

// ── Direct default Lulu adapter ───────────────────────────────────────────────

test('direct submitPrintJob 200 success control sends the saved contact and returns the job id', () => withWorld('ok', async ({ provider }) => {
  const result = await submitPrintJob(printOrder(orderId(1)));
  assert.equal(result.jobId, '4242');
  assert.equal(result.status, 'submitted');
  assert.equal(provider.printPosts.length, 1);
  assertSentRealContact(provider.printPosts[0]);
}));

const DIRECT_FAILURES: ReadonlyArray<[Mode, string, number]> = [
  ['auth401', 'Lulu auth failed 401', 0],
  ['authTransport', 'Lulu auth unavailable', 0],
  ['http400', 'Lulu API error 400', 1],
  ['http503', 'Lulu API error 503', 1],
  ['transport', 'Lulu print-job transport failed', 1],
  ['malformed', 'Lulu print-job response unreadable', 1],
];

DIRECT_FAILURES.forEach(([mode, expected, posts], index) => {
  test(`direct submitPrintJob ${mode} rejects with a fixed value-free class only`, () => withWorld(mode, async ({ provider, logs }) => {
    let message = '';
    await assert.rejects(submitPrintJob(printOrder(orderId(0x10 + index))), (error: unknown) => {
      message = error instanceof Error ? error.message : String(error);
      return true;
    });
    assert.equal(provider.printPosts.length, posts);
    if (posts) assertSentRealContact(provider.printPosts[0]);
    const leaks = leakSurfaces({ errorMessage: message, logs: logs.join('\n') });
    assert.deepEqual({ leaks, message }, { leaks: [], message: expected });
  }));
});

// ── Real approval through canonical persistence and the shared DTOs ───────────

test('approval 200 success control on the identical fixture binds the job and clears the error', () => withWorld('ok', async ({ provider }) => {
  const id = orderId(0x20);
  await persistOrder(printOrder(id));
  const before = (await getOrder(id))!;
  const result = await approvePrintProof(id, PROOF_TOKEN);
  assert.deepEqual(result, { ok: true });
  assert.equal(provider.printPosts.length, 1);
  assertSentRealContact(provider.printPosts[0]);
  const after = (await getOrder(id))!;
  assert.equal(after.fulfillmentStatus, 'complete');
  assert.equal(after.status, 'print_in_production');
  assert.equal(after.printJobId, '4242');
  assert.ok(after.printSubmissionAttemptedAt);
  assert.equal(after.printSubmissionProofVersion, before.proofVersion);
  assert.equal(after.fulfillmentLastError ?? null, null);
  assert.deepEqual(retained(after), retained(before));
  assert.deepEqual(await approvePrintProof(id, PROOF_TOKEN), { ok: true });
  assert.equal(provider.printPosts.length, 1, 'a completed job is never posted again');
}));

const POST_FENCE_FAILURES: ReadonlyArray<[Mode, string, number]> = [
  ['http400', 'Lulu API error 400', 1],
  ['http503', 'Lulu API error 503', 1],
  ['transport', 'Lulu print-job transport failed', 1],
  ['malformed', 'Lulu print-job response unreadable', 1],
  ['auth401', 'Lulu auth failed 401', 0],
  ['authTransport', 'Lulu auth unavailable', 0],
];

POST_FENCE_FAILURES.forEach(([mode, expectedDetail, posts], index) => {
  test(`approval ${mode} after the attempt fence stays ambiguous, never re-posts, and persists no contact`, () => withWorld(mode, async ({ provider, logs }) => {
    const id = orderId(0x30 + index);
    await persistOrder(printOrder(id));
    const before = (await getOrder(id))!;

    const first = await approvePrintProof(id, PROOF_TOKEN);
    const afterFirst = (await getOrder(id))!;
    // Fence and state semantics: unchanged by this correction.
    assert.deepEqual(first, { ok: false, error: 'print_submission_ambiguous' });
    assert.equal(afterFirst.fulfillmentStatus, 'submitting_to_print');
    assert.ok(afterFirst.printSubmissionAttemptedAt, 'the attempt marker was written before the provider call');
    assert.equal(afterFirst.printSubmissionProofVersion, before.proofVersion);
    assert.equal(afterFirst.printJobId ?? null, null);
    assert.equal(afterFirst.status, 'preview_ready');
    assert.equal(provider.printPosts.length, posts);
    if (posts) assertSentRealContact(provider.printPosts[0]);

    // Every later approval or retry path refuses without another POST.
    const second = await approvePrintProof(id, PROOF_TOKEN);
    assert.deepEqual(second, { ok: true }, 'existing idempotent claim abort');
    const manual = await manuallyApproveProof(id);
    assert.equal(manual.ok, false);
    assert.equal(manual.ok === false ? manual.status : 0, 409);
    const retry = await retryOrderFulfillment(id);
    assert.equal(retry.ok, false);
    assert.equal(retry.ok === false ? retry.status : 0, 409);
    assert.equal(provider.printPosts.length, posts, 'no additional print-job POST');

    const final = (await getOrder(id))!;
    assert.equal(final.fulfillmentStatus, 'submitting_to_print');
    assert.equal(final.printSubmissionAttemptedAt, afterFirst.printSubmissionAttemptedAt);
    assert.equal(final.printSubmissionProofVersion, afterFirst.printSubmissionProofVersion);
    assert.equal(final.printJobId ?? null, null);
    assert.equal(final.fulfillmentLastError, afterFirst.fulfillmentLastError);
    assert.ok(final.fulfillmentLastError?.startsWith('print_submission_ambiguous: '));
    assert.deepEqual(retained(final), retained(before));
    assert.deepEqual(provider.unmatched, []);

    // Privacy: every public surface, collected so RED names each one.
    const leaks = leakSurfaces({
      fulfillmentLastError: final.fulfillmentLastError,
      adminListDto: toAdminOrderListItem(final),
      adminDetailDto: toAdminOrderDetail(final),
      approveReturn: first,
      secondApproveReturn: second,
      manualApproveReturn: manual,
      retryReturn: retry,
      auditEvents: final.auditEvents ?? [],
      logs: logs.join('\n'),
    });
    assert.deepEqual(
      { leaks, fulfillmentLastError: final.fulfillmentLastError },
      { leaks: [], fulfillmentLastError: `print_submission_ambiguous: ${expectedDetail}` },
    );
  }));
});

// ── Before the attempt fence ──────────────────────────────────────────────────

test('approval default cover-dimension 500 echo fails before the attempt with no marker, no POST and no contact', () => withWorld('cover500', async ({ provider, logs }) => {
  const id = orderId(0x40);
  await persistOrder(printOrder(id, { printCoverArtifactUrl: null, printCoverMd5: null }));
  const before = (await getOrder(id))!;

  const first = await approvePrintProof(id, PROOF_TOKEN);
  assert.deepEqual(first, { ok: false, error: 'print_submission_failed' });
  assert.ok(provider.urls.includes(COVER_URL), 'the default cover-dimension path ran');
  const after = (await getOrder(id))!;
  assert.equal(after.fulfillmentStatus, 'failed_manual_review');
  assert.equal(after.printSubmissionAttemptedAt ?? null, null);
  assert.equal(after.printJobId ?? null, null);
  assert.equal(provider.printPosts.length, 0);
  assert.deepEqual(retained(after), retained(before));

  // Not retried through retryOrderFulfillment: that would regenerate the book.
  const second = await approvePrintProof(id, PROOF_TOKEN);
  assert.equal(second.ok, false);
  const manual = await manuallyApproveProof(id);
  assert.equal(manual.ok === false ? manual.status : 0, 409);
  assert.equal(provider.printPosts.length, 0);
  assert.deepEqual(provider.unmatched, []);

  const final = (await getOrder(id))!;
  const leaks = leakSurfaces({
    fulfillmentLastError: final.fulfillmentLastError,
    adminListDto: toAdminOrderListItem(final),
    adminDetailDto: toAdminOrderDetail(final),
    approveReturn: first,
    secondApproveReturn: second,
    manualApproveReturn: manual,
    auditEvents: final.auditEvents ?? [],
    logs: logs.join('\n'),
  });
  assert.deepEqual(
    { leaks, fulfillmentLastError: final.fulfillmentLastError },
    { leaks: [], fulfillmentLastError: 'print_submission_failed_before_attempt: print_error_detail_withheld' },
  );
}));

test('approval valid release-guard control keeps its finite refusal code before the attempt', () => withWorld('coverGuard', async ({ provider, logs }) => {
  const id = orderId(0x41);
  await persistOrder(printOrder(id, { printCoverArtifactUrl: null, printCoverMd5: null }));
  // While the default cover-dimension request is open, the acknowledged proof
  // version moves: the boundary re-check must refuse before the attempt fence.
  provider.onCover = async () => {
    await withOrderTransaction<null>(id, (current) => ({
      commit: { ...current, proofReviewedVersion: 'proof-v0', updatedAt: new Date().toISOString() },
      result: null,
    }), { notFound: () => null });
  };
  const deps: FulfillmentDeps = {
    buildPrintCoverPdf: () => Buffer.from('%PDF-1.4 synthetic cover'),
    uploadArtifact: async (oid, _buffer, filename) => `https://cdn.example.invalid/${oid}/${filename}`,
  };
  const first = await approvePrintProof(id, PROOF_TOKEN, deps);
  assert.deepEqual(first, { ok: false, error: 'print_submission_failed' });
  assert.ok(provider.urls.includes(COVER_URL), 'the default cover-dimension path ran');
  const after = (await getOrder(id))!;
  assert.equal(after.fulfillmentStatus, 'failed_manual_review');
  assert.equal(after.printSubmissionAttemptedAt ?? null, null);
  assert.equal(after.printJobId ?? null, null);
  assert.equal(after.paymentStatus, 'paid');
  assert.equal(provider.printPosts.length, 0);
  assert.deepEqual(provider.unmatched, []);
  const leaks = leakSurfaces({
    fulfillmentLastError: after.fulfillmentLastError,
    adminListDto: toAdminOrderListItem(after),
    adminDetailDto: toAdminOrderDetail(after),
    approveReturn: first,
    logs: logs.join('\n'),
  });
  assert.deepEqual(
    { leaks, fulfillmentLastError: after.fulfillmentLastError },
    { leaks: [], fulfillmentLastError: 'print_submission_failed_before_attempt: Refusing print: proof_ack_stale' },
  );
}));
