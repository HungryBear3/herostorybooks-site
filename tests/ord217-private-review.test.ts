import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAttachOrd217PrivateReviewCli } from '../scripts/attach-ord217-private-review.ts';
import { createOrderRecord, OrderVersionConflictError } from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import {
  ORD217_PINS,
  runOrd217PrivateReviewAttachment,
  type Ord217Approval,
  type Ord217ApprovedManifest,
  type Ord217ProofInput,
  type Ord217StripeFacts,
  type Ord217PageInput,
} from '../src/lib/ord217-private-review.ts';

const NOW = '2026-08-19T12:00:00.000Z';
const ORDER_ID = ORD217_PINS.orderId;
const SESSION_ID = 'cs_live_ord217_bound';

function sha256Hex(body: Buffer): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Kid', recipientName: 'Recipient', bookFormat: 'digital', email: 'family@example.invalid' },
      { id: ORDER_ID, now: NOW },
    ),
    paymentStatus: 'paid',
    stripeSessionId: SESSION_ID,
    settledAmountCents: 1900,
    status: 'order_received',
    fulfillmentMode: 'manual_hold',
    pageArtifacts: [],
    auditEvents: [],
    ...overrides,
  };
}

function makeStripeFacts(overrides: Partial<Ord217StripeFacts> = {}): Ord217StripeFacts {
  return {
    sessionId: SESSION_ID,
    paid: true,
    refunded: false,
    disputed: false,
    livemode: true,
    amountCents: 1900,
    product: 'digital',
    ...overrides,
  };
}

function makeApproval(overrides: Partial<Ord217Approval> = {}): Ord217Approval {
  return {
    orderId: ORD217_PINS.orderId,
    sourceCommit: ORD217_PINS.sourceCommit,
    pdfSha256: ORD217_PINS.pdfSha256,
    pdfBytes: ORD217_PINS.pdfBytes,
    manifestSha256: ORD217_PINS.manifestSha256,
    zipSha256: ORD217_PINS.zipSha256,
    sha256sumsSha256: ORD217_PINS.sha256sumsSha256,
    operator: 'rex',
    expiresAt: '2026-08-20T00:00:00.000Z',
    maxOrderCasCommits: 1,
    allowCustomerSend: false,
    allowPrintProvider: false,
    allowPaymentMutation: false,
    allowRefund: false,
    allowDeploy: false,
    allowDelete: false,
    ...overrides,
  };
}

function makePagesAndManifest(): { manifest: Ord217ApprovedManifest; pages: Ord217PageInput[] } {
  const pages: Ord217PageInput[] = [];
  const rows: Ord217ApprovedManifest['rows'] = [];
  for (let index = 0; index < 24; index += 1) {
    const storyPage = index + 1;
    const body = Buffer.from(`ord217-page-${storyPage}`);
    const sha256 = sha256Hex(body);
    pages.push({
      body,
      storyPage,
      pdfPage: storyPage + 2,
      assetId: `page-${String(storyPage).padStart(2, '0')}`,
      contentType: 'image/png',
      bytes: body.byteLength,
      sha256,
      storyText: `Story ${storyPage}`,
      basePrompt: `Prompt ${storyPage}`,
    });
    rows.push({
      storyPage,
      pdfPage: storyPage + 2,
      assetId: `page-${String(storyPage).padStart(2, '0')}`,
      fileName: `page-${String(storyPage).padStart(2, '0')}.png`,
      contentType: 'image/png',
      bytes: body.byteLength,
      sha256,
    });
  }
  return { manifest: { rows }, pages };
}

function makeProof(): Ord217ProofInput {
  const body = Buffer.from('%PDF synthetic ord217 proof');
  return {
    body,
    bytes: body.byteLength,
    sha256: sha256Hex(body),
    contentType: 'application/pdf',
  };
}

test('refuses before network when private credential, operator approval, proof body, or manifest are invalid', async () => {
  let reads = 0;
  const { manifest, pages } = makePagesAndManifest();
  const proof = makeProof();
  const deps = {
    now: () => new Date(NOW),
    readOrderVersioned: async () => {
      reads += 1;
      return { order: makeOrder(), version: 'v1' };
    },
    readStripeFacts: async () => makeStripeFacts(),
    putPrivateArtifact: async () => ({ outcome: 'created' as const, pathname: 'x' }),
  };

  const cases = [
    {
      input: {
        mode: 'preflight' as const,
        env: { HSB_PRIVATE_READ_WRITE_TOKEN: '', BLOB_READ_WRITE_TOKEN: 'public' },
        approval: makeApproval(),
        manifest,
        proof,
        pages,
      },
      error: 'private_credential_missing',
    },
    {
      input: {
        mode: 'preflight' as const,
        env: { HSB_PRIVATE_READ_WRITE_TOKEN: 'private', BLOB_READ_WRITE_TOKEN: 'public' },
        approval: makeApproval({ operator: '   ' }),
        manifest,
        proof,
        pages,
      },
      error: 'approval_operator_missing',
    },
    {
      input: {
        mode: 'preflight' as const,
        env: { HSB_PRIVATE_READ_WRITE_TOKEN: 'private', BLOB_READ_WRITE_TOKEN: 'public' },
        approval: makeApproval(),
        manifest: undefined,
        proof,
        pages,
      },
      error: 'manifest_missing',
    },
    {
      input: {
        mode: 'preflight' as const,
        env: { HSB_PRIVATE_READ_WRITE_TOKEN: 'private', BLOB_READ_WRITE_TOKEN: 'public' },
        approval: makeApproval(),
        manifest,
        proof: { ...proof, body: undefined as unknown as Buffer },
        pages,
      },
      error: 'proof_body_missing',
    },
  ];

  for (const candidate of cases) {
    const result = await runOrd217PrivateReviewAttachment(candidate.input, deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, candidate.error);
    assert.deepEqual(result.artifacts, { created: 0, reconciled: 0 });
  }
  assert.equal(reads, 0);
});

test('page validation is bound to the approved manifest and page body bytes', async () => {
  const { manifest, pages } = makePagesAndManifest();
  const proof = makeProof();
  const result = await runOrd217PrivateReviewAttachment(
    {
      mode: 'preflight',
      env: { HSB_PRIVATE_READ_WRITE_TOKEN: 'private', BLOB_READ_WRITE_TOKEN: 'public' },
      approval: makeApproval(),
      manifest,
      proof,
      pages: pages.map((page, index) => (
        index === 0
          ? { ...page, bytes: page.bytes + 1 }
          : page
      )),
    },
    {
      now: () => new Date(NOW),
      readOrderVersioned: async () => ({ order: makeOrder(), version: 'v1' }),
      readStripeFacts: async () => makeStripeFacts(),
      putPrivateArtifact: async () => ({ outcome: 'created' as const, pathname: 'x' }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'page_set_manifest_bytes_mismatch');
});

test('already_exists and ambiguous uploads both require authenticated reconciliation with exact hash, bytes, and content type', async () => {
  const { manifest, pages } = makePagesAndManifest();
  const proof = makeProof();

  const unreconciled = await runOrd217PrivateReviewAttachment(
    {
      mode: 'execute',
      env: { HSB_PRIVATE_READ_WRITE_TOKEN: 'private', BLOB_READ_WRITE_TOKEN: 'public' },
      approval: makeApproval(),
      manifest,
      proof,
      pages,
    },
    {
      now: () => new Date(NOW),
      readOrderVersioned: async () => ({ order: makeOrder(), version: 'v1' }),
      readStripeFacts: async () => makeStripeFacts(),
      putPrivateArtifact: async ({ pathname }) => ({ outcome: 'already_exists' as const, pathname }),
      reconcilePrivateArtifact: async ({ pathname, sha256, bytes }) => ({
        found: true,
        pathname,
        sha256,
        bytes: bytes + 1,
        contentType: 'image/png',
      }),
    },
  );
  assert.equal(unreconciled.ok, false);
  assert.equal(unreconciled.error, 'private_upload_reconciliation_failed');

  const reconciled = await runOrd217PrivateReviewAttachment(
    {
      mode: 'execute',
      env: { HSB_PRIVATE_READ_WRITE_TOKEN: 'private', BLOB_READ_WRITE_TOKEN: 'public' },
      approval: makeApproval(),
      manifest,
      proof,
      pages,
    },
    {
      now: () => new Date(NOW),
      readOrderVersioned: async () => ({ order: makeOrder(), version: 'v1' }),
      readStripeFacts: async () => makeStripeFacts(),
      putPrivateArtifact: async ({ pathname, kind }) => ({
        outcome: kind === 'proof' ? 'ambiguous' as const : 'already_exists' as const,
        pathname,
      }),
      reconcilePrivateArtifact: async ({ pathname, sha256, bytes, contentType }) => ({
        found: true,
        pathname,
        sha256,
        bytes,
        contentType,
      }),
      withOrderTransaction: async (_orderId, mutate, opts) => {
        assert.equal(opts?.maxAttempts, 1);
        return (await mutate(makeOrder()) as { result: { ok: true; order: OrderRecord } }).result;
      },
    },
  );
  assert.equal(reconciled.ok, true);
  assert.deepEqual(reconciled.artifacts, { created: 0, reconciled: 25 });
});

test('fresh Stripe facts are rechecked after uploads and inside the one-attempt CAS, and refund changes refuse the attach', async () => {
  const { manifest, pages } = makePagesAndManifest();
  const proof = makeProof();
  let stripeReads = 0;
  let puts = 0;
  const result = await runOrd217PrivateReviewAttachment(
    {
      mode: 'execute',
      env: { HSB_PRIVATE_READ_WRITE_TOKEN: 'private', BLOB_READ_WRITE_TOKEN: 'public' },
      approval: makeApproval(),
      manifest,
      proof,
      pages,
    },
    {
      now: () => new Date(NOW),
      readOrderVersioned: async () => ({ order: makeOrder(), version: 'v1' }),
      readStripeFacts: async () => {
        stripeReads += 1;
        return stripeReads >= 3 ? makeStripeFacts({ refunded: true }) : makeStripeFacts();
      },
      putPrivateArtifact: async ({ pathname }) => {
        puts += 1;
        return { outcome: 'created' as const, pathname };
      },
      withOrderTransaction: async (_orderId, mutate) => {
        const outcome = await mutate(makeOrder());
        return 'abort' in outcome ? outcome.abort : outcome.result;
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'prestate_refunded');
  assert.equal(stripeReads, 3);
  assert.equal(puts, 25);
});

test('typed CAS conflicts return hold_order_cas_conflict and successful attach reports actual artifact counts', async () => {
  const { manifest, pages } = makePagesAndManifest();
  const proof = makeProof();

  const conflict = await runOrd217PrivateReviewAttachment(
    {
      mode: 'execute',
      env: { HSB_PRIVATE_READ_WRITE_TOKEN: 'private', BLOB_READ_WRITE_TOKEN: 'public' },
      approval: makeApproval(),
      manifest,
      proof,
      pages,
    },
    {
      now: () => new Date(NOW),
      readOrderVersioned: async () => ({ order: makeOrder(), version: 'v1' }),
      readStripeFacts: async () => makeStripeFacts(),
      putPrivateArtifact: async ({ pathname }) => ({ outcome: 'created' as const, pathname }),
      withOrderTransaction: async () => {
        throw new OrderVersionConflictError(ORDER_ID, 1);
      },
    },
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'hold_order_cas_conflict');
  assert.deepEqual(conflict.artifacts, { created: 25, reconciled: 0 });

  const success = await runOrd217PrivateReviewAttachment(
    {
      mode: 'execute',
      env: { HSB_PRIVATE_READ_WRITE_TOKEN: 'private', BLOB_READ_WRITE_TOKEN: 'public' },
      approval: makeApproval(),
      manifest,
      proof,
      pages,
    },
    {
      now: () => new Date(NOW),
      readOrderVersioned: async () => ({ order: makeOrder({ queueStatusNote: 'keep me' }), version: 'v1' }),
      readStripeFacts: async () => makeStripeFacts(),
      putPrivateArtifact: async ({ pathname }) => ({ outcome: 'created' as const, pathname }),
      withOrderTransaction: async (_orderId, mutate, opts) => {
        assert.equal(opts?.maxAttempts, 1);
        return (await mutate(makeOrder({ queueStatusNote: 'keep me' })) as { result: { ok: true; order: OrderRecord } }).result;
      },
    },
  );
  assert.equal(success.ok, true);
  assert.equal(success.order?.queueStatusNote, 'keep me');
  assert.equal(success.order?.proofApprovalToken ?? null, null);
  assert.equal(typeof success.order?.proofApprovalTokenHash, 'string');
  assert.equal(success.order?.storyArtifactUrl, `/api/order/${ORDER_ID}/review-asset/proof-pdf`);
  assert.deepEqual(success.artifacts, { created: 25, reconciled: 0 });
  assert.equal(success.reviewPath, `/review/${ORDER_ID}#token=[redacted]`);
});

test('CLI refuses before any network call on local artifact hash or approval errors, and source includes real default adapters only', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hsb-ord217-cli-'));
  try {
    const manifestPath = path.join(tmp, 'manifest.json');
    const pdfPath = path.join(tmp, 'proof.pdf');
    const shaPath = path.join(tmp, 'sha256sums.txt');
    const zipPath = path.join(tmp, 'evidence.zip');
    const rendersDir = path.join(tmp, 'renders');
    const approvalPath = path.join(tmp, 'approval.json');
    writeFileSync(manifestPath, JSON.stringify({ rows: [] }), 'utf8');
    writeFileSync(pdfPath, 'not-the-real-pdf', 'utf8');
    writeFileSync(shaPath, 'not-the-real-sha256sums', 'utf8');
    writeFileSync(zipPath, 'not-the-real-zip', 'utf8');
    writeFileSync(approvalPath, JSON.stringify(makeApproval({ operator: '   ' })), 'utf8');
    mkdirSync(rendersDir);

    let orderReads = 0;
    let stripeReads = 0;
    const summary = await runAttachOrd217PrivateReviewCli(
      [
        '--pdf', pdfPath,
        '--manifest', manifestPath,
        '--sha256sums', shaPath,
        '--evidence-zip', zipPath,
        '--renders-dir', rendersDir,
        '--approval', approvalPath,
      ],
      {
        readOrderVersioned: async () => {
          orderReads += 1;
          return { order: makeOrder(), version: 'v1' };
        },
        readStripeFacts: async () => {
          stripeReads += 1;
          return makeStripeFacts();
        },
      },
    ).catch((error: Error) => ({
      ok: false,
      error: error.message,
      reviewPath: null,
      orderId: ORDER_ID,
      artifacts: { created: 0, reconciled: 0 },
    }));
    assert.equal(summary.ok, false);
    assert.match(summary.error ?? '', /manifest\.json_sha256_mismatch|proof\.pdf_sha256_mismatch/);
    assert.equal(orderReads, 0);
    assert.equal(stripeReads, 0);

    const libSrc = readFileSync(new URL('../src/lib/ord217-private-review.ts', import.meta.url), 'utf8');
    const cliSrc = readFileSync(new URL('../scripts/attach-ord217-private-review.ts', import.meta.url), 'utf8');
    assert.match(cliSrc, /from ['"]@vercel\/blob['"]/);
    assert.match(cliSrc, /getOptionalStripeSecretKey/);
    assert.match(libSrc, /readOrderVersioned/);
    assert.match(libSrc, /withOrderTransaction/);
    assert.doesNotMatch(cliSrc, /from ['"]stripe['"]/);
    assert.doesNotMatch(libSrc, /from ['"]stripe['"]/);
    assert.doesNotMatch(cliSrc, /sendProofReadyEmail|sendDigitalDeliveryEmail|submitPrintJob|refundOrder/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
