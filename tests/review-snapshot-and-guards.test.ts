/**
 * Review snapshot freshness + source guards.
 *
 * The snapshot is what a reload/reopen renders from. It must carry the exact
 * persisted proof revision, and every proof link must be the immutable
 * persisted URL — never a session-local value. Nothing about correctness may
 * depend on React state surviving a refresh.
 *
 * The source guards are static assertions that pin invariants a future refactor
 * could silently undo. Each one is mutation-proven in
 * evidence (see the mutation-test record): removing the thing it pins makes it
 * fail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, getOrder, persistOrder } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import { proofSourceFingerprint } from '../src/lib/fulfillment.ts';
import { padPageSet } from './support/full-page-set.ts';
import {
  acceptPage,
  acknowledgeProofReview,
  approveWholeBook,
  customerReviewActor,
  getReviewSnapshot,
  regeneratePage,
  resolveTextChangeRequest,
  saveTextChangeRequest,
} from '../src/lib/page-review.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';

const REPO = process.cwd();
const NOW = '2026-08-03T12:00:00.000Z';
const TOKEN = 'fa90'.repeat(12);
const IMMUTABLE_PROOF = 'https://example.invalid/orders/ord_snap/proofs/v4.pdf';

function page(i: number, o: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i, storyText: `Page ${i + 1}`, basePrompt: 'p', characterAnchor: 'a',
    currentImageUrl: `https://example.invalid/p${i}.png`,
    acceptedImageUrl: `https://example.invalid/p${i}.png`,
    generationProvider: null, generationModel: null, regenerateCount: 0,
    accepted: true, feedbackHistory: [], versionHistory: [], ...o,
  };
}
function makeOrder(id: string, o: Partial<OrderRecord> = {}): OrderRecord {
  const pages = padPageSet([page(0), page(1)]);
  const order: OrderRecord = {
    ...createOrderRecord(
      { childName: 'Testkid', bookFormat: 'digital', email: 'reviewer@example.invalid' },
      { id, now: NOW }),
    paymentStatus: 'paid', reviewStatus: 'in_review',
    storyArtifactUrl: IMMUTABLE_PROOF,
    proofSourceFingerprint: null,
    proofVersion: 'v4', proofReviewedAt: NOW, proofReviewedVersion: 'v4',
    proofApprovalToken: TOKEN, pageArtifacts: pages, auditEvents: [], ...o,
  };
  if (o.proofSourceFingerprint === undefined) {
    order.proofSourceFingerprint = proofSourceFingerprint(order);
  }
  return order;
}
function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-snap-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

// ── 8: reload/reopen renders the immutable persisted URL ───────────────────

test('REQ8: the snapshot carries the immutable persisted proof URL and its exact revision', async () => {
  const dir = makeTmp();
  try {
    await persistOrder(makeOrder('ord_snap'));
    const snap = await getReviewSnapshot('ord_snap', { reviewToken: TOKEN });
    assert.ok(snap, 'snapshot must render for a valid capability');
    assert.equal(snap.storyArtifactUrl, IMMUTABLE_PROOF, 'the persisted immutable URL');
    assert.equal(snap.proofVersion, 'v4', 'the exact revision is exposed');
    assert.equal(snap.proofReviewedVersion, 'v4');
    assert.equal(snap.proofFresh, true, 'fingerprint matches the current pages');
    assert.equal(snap.proofAvailable, true);
  } finally {
    cleanup(dir);
  }
});

test('REQ8: a second read (reload/reopen) is byte-identical — no session-local dependency', async () => {
  const dir = makeTmp();
  try {
    await persistOrder(makeOrder('ord_snap'));
    const a = await getReviewSnapshot('ord_snap', { reviewToken: TOKEN });
    const b = await getReviewSnapshot('ord_snap', { reviewToken: TOKEN });
    assert.deepEqual(a, b, 'reopening yields the same snapshot');
    assert.ok(a?.storyArtifactUrl?.includes('/proofs/v4.pdf'), 'URL identifies the artifact itself');
    assert.doesNotMatch(String(a?.storyArtifactUrl), /[?&]v=/, 'no cache-busting nonce is needed');
  } finally {
    cleanup(dir);
  }
});

test('REQ8: after a content mutation the snapshot advertises NO proof', async () => {
  const dir = makeTmp();
  try {
    await persistOrder(makeOrder('ord_snap'));
    const stub: ImageProvider = {
      name: 'fal',
      async generate({ prompt }) {
        return { imageUrl: 'https://example.invalid/r.png', provider: 'fal', model: 'stub', promptUsed: prompt, latencyMs: 1, error: null };
      },
    };
    await regeneratePage(
      { orderId: 'ord_snap', pageIndex: 1, feedback: 'x', actor: customerReviewActor(TOKEN) },
      { providers: [stub], skipProofRebuild: true, now: () => new Date(NOW) },
    );
    const snap = await getReviewSnapshot('ord_snap', { reviewToken: TOKEN });
    assert.equal(snap?.storyArtifactUrl, null, 'no stale proof may be advertised');
    assert.equal(snap?.proofVersion, null);
    assert.equal(snap?.proofAvailable, false);
    assert.equal(snap?.proofFresh, false);
    assert.equal((await getOrder('ord_snap'))?.proofReviewedVersion, null);
  } finally {
    cleanup(dir);
  }
});

test('REQ8: successful mutations return the exact committed review snapshot', async () => {
  const dir = makeTmp();
  try {
    const acceptId = 'ord_snapshot_accept';
    await persistOrder(makeOrder(acceptId, {
      pageArtifacts: padPageSet([page(0, { accepted: false, acceptedImageUrl: null }), page(1)]),
    }));
    const accepted = await acceptPage({
      orderId: acceptId,
      pageIndex: 0,
      actor: customerReviewActor(TOKEN),
    });
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.snapshot, await getReviewSnapshot(acceptId, { reviewToken: TOKEN }));
    assert.equal(accepted.snapshot?.pageArtifacts[0].accepted, true);

    const ackId = 'ord_snapshot_ack';
    await persistOrder(makeOrder(ackId, { proofReviewedAt: null, proofReviewedVersion: null }));
    const acked = await acknowledgeProofReview(ackId, {
      proofVersion: 'v4',
      actor: customerReviewActor(TOKEN),
      now: new Date(NOW),
    });
    assert.equal(acked.ok, true);
    assert.deepEqual(acked.snapshot, await getReviewSnapshot(ackId, { reviewToken: TOKEN }));
    assert.equal(acked.snapshot?.proofReviewedVersion, 'v4');

    const approveId = 'ord_snapshot_approve';
    await persistOrder(makeOrder(approveId));
    const approved = await approveWholeBook(approveId, { actor: customerReviewActor(TOKEN) });
    assert.equal(approved.ok, true);
    assert.deepEqual(approved.snapshot, await getReviewSnapshot(approveId, { reviewToken: TOKEN }));
    assert.equal(approved.snapshot?.reviewStatus, 'approved');

    const wordingId = 'ord_snapshot_wording';
    await persistOrder(makeOrder(wordingId));
    const wording = await saveTextChangeRequest({
      orderId: wordingId,
      pageIndex: 0,
      note: 'Please make this sentence gentler.',
      reviewToken: TOKEN,
    }, { now: () => new Date(NOW) });
    assert.equal(wording.ok, true);
    assert.deepEqual(wording.snapshot, await getReviewSnapshot(wordingId, { reviewToken: TOKEN }));
    assert.equal(wording.snapshot?.reviewStatus, 'customer_changes_requested');
    assert.equal(wording.snapshot?.storyArtifactUrl, null);
    assert.equal(wording.snapshot?.pageArtifacts[0].customerRequestedChange?.lifecycleStatus, 'triage');
  } finally {
    cleanup(dir);
  }
});

test('REQ8: idempotent acknowledgment retries return the exact current snapshot', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_ack_retry_snapshot';
    await persistOrder(makeOrder(orderId));
    const result = await acknowledgeProofReview(orderId, {
      proofVersion: 'v4',
      actor: customerReviewActor(TOKEN),
      now: new Date(NOW),
    });
    assert.equal(result.ok, true);
    assert.ok(result.snapshot);
    const current = await getReviewSnapshot(orderId, { reviewToken: TOKEN });
    assert.deepEqual(result.snapshot, current);
  } finally {
    cleanup(dir);
  }
});

test('REQ17: unresolved wording blocks server approval; resolved wording permits it', async () => {
  const dir = makeTmp();
  try {
    const blockedId = 'ord_unresolved_wording_gate';
    const blocked = makeOrder(blockedId, {
      pageArtifacts: padPageSet([
        page(0, {
          customerReviewStatus: 'changes_requested',
          customerRequestedChange: {
            note: 'Revise this sentence',
            requestedAt: NOW,
            lifecycleStatus: 'triage',
          },
        }),
        page(1),
      ]),
      printInteriorArtifactUrl: 'https://example.invalid/interior.pdf',
      fulfillmentStatus: 'proof_ready',
    });
    blocked.proofSourceFingerprint = proofSourceFingerprint(blocked);
    await persistOrder(blocked);
    const before = await getOrder(blockedId);
    const rejected = await approveWholeBook(blockedId, { actor: customerReviewActor(TOKEN) });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 409);
    assert.match(rejected.error ?? '', /Resolve the pending text-change requests/);
    const after = await getOrder(blockedId);
    assert.notEqual(after?.reviewStatus, 'approved');
    assert.equal(after?.storyArtifactUrl, before?.storyArtifactUrl);
    assert.equal(after?.printInteriorArtifactUrl, before?.printInteriorArtifactUrl);
    assert.equal(after?.fulfillmentStatus, before?.fulfillmentStatus);

    const resolvedId = 'ord_resolved_wording_gate';
    const resolved = makeOrder(resolvedId, {
      pageArtifacts: padPageSet([
        page(0, {
          customerReviewStatus: 'resolved',
          customerRequestedChange: {
            note: 'Revise this sentence',
            requestedAt: NOW,
            lifecycleStatus: 'resolved',
          },
        }),
        page(1),
      ]),
    });
    resolved.proofSourceFingerprint = proofSourceFingerprint(resolved);
    await persistOrder(resolved);
    const approved = await approveWholeBook(resolvedId, { actor: customerReviewActor(TOKEN) });
    assert.equal(approved.ok, true);
    assert.equal(approved.snapshot?.reviewStatus, 'approved');
  } finally {
    cleanup(dir);
  }
});

test('REQ15: production wording workflow reaches fresh proof, acknowledgment, and approval', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_synthetic_wording_resolution';
    await persistOrder(makeOrder(orderId));

    const requested = await saveTextChangeRequest({
      orderId,
      pageIndex: 0,
      note: 'Use the reviewed synthetic sentence.',
      reviewToken: TOKEN,
    });
    assert.equal(requested.ok, true);
    assert.equal(requested.snapshot?.storyArtifactUrl, null);

    const resolved = await resolveTextChangeRequest(
      { orderId, pageIndex: 0, storyText: 'Reviewed synthetic canonical sentence.' },
      {
        now: () => new Date(NOW),
        buildProof: async (id) => {
          const current = await getOrder(id);
          assert.ok(current);
          return {
            ok: true as const,
            proofUrl: 'https://example.invalid/orders/ord_synthetic_wording_resolution/proofs/v5.pdf',
            sourceFingerprint: proofSourceFingerprint(current),
            proofVersion: 'v5',
          };
        },
      },
    );
    assert.equal(resolved.ok, true);
    assert.equal(resolved.proofRefreshed, true);
    assert.equal(resolved.snapshot?.pageArtifacts[0].storyText, 'Reviewed synthetic canonical sentence.');
    assert.equal(resolved.snapshot?.pageArtifacts[0].customerReviewStatus, 'resolved');
    assert.equal(
      resolved.snapshot?.pageArtifacts[0].customerRequestedChange?.lifecycleStatus,
      'resolved',
    );
    assert.equal(resolved.snapshot?.proofVersion, 'v5');

    const acked = await acknowledgeProofReview(orderId, {
      proofVersion: 'v5',
      actor: customerReviewActor(TOKEN),
      now: new Date(NOW),
    });
    assert.equal(acked.ok, true);
    const approved = await approveWholeBook(orderId, { actor: customerReviewActor(TOKEN) });
    assert.equal(approved.ok, true);
    assert.equal(approved.snapshot?.reviewStatus, 'approved');
  } finally {
    cleanup(dir);
  }
});

test('REQ15: failed wording proof build returns fresh state after a concurrent mutation', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_synthetic_wording_failure_race';
    await persistOrder(makeOrder(orderId));
    const requested = await saveTextChangeRequest({
      orderId,
      pageIndex: 0,
      note: 'Resolve the first synthetic page.',
      reviewToken: TOKEN,
    });
    assert.equal(requested.ok, true);

    const resolved = await resolveTextChangeRequest(
      { orderId, pageIndex: 0, storyText: 'Resolved synthetic canonical text.' },
      {
        now: () => new Date(NOW),
        buildProof: async () => {
          const concurrent = await saveTextChangeRequest({
            orderId,
            pageIndex: 1,
            note: 'Synthetic concurrent second-page request',
            reviewToken: TOKEN,
          });
          assert.equal(concurrent.ok, true);
          return { ok: false as const, error: 'synthetic_proof_build_failure' };
        },
      },
    );
    assert.equal(resolved.ok, false);
    assert.equal(resolved.error, 'synthetic_proof_build_failure');
    const authoritative = await getReviewSnapshot(orderId, { reviewToken: TOKEN });
    assert.deepEqual(resolved.snapshot, authoritative);
    assert.equal(
      resolved.snapshot?.pageArtifacts[1].customerRequestedChange?.note,
      'Synthetic concurrent second-page request',
    );
  } finally {
    cleanup(dir);
  }
});

// ── 16/17: source guards, bounded and load-bearing ─────────────────────────

const BANNED: Array<{ label: string; pattern: RegExp }> = [
  { label: 'real recipient first name', pattern: new RegExp(`\\b${['P', 'eter'].join('')}\\b`, 'i') },
  { label: 'real child name', pattern: new RegExp(`\\b${['B', 'enny'].join('')}\\b`, 'i') },
  { label: 'production-shaped order id', pattern: /\bord_[0-9a-f]{16,}\b/i },
  { label: 'order-scoped artifact path', pattern: new RegExp(['review-v2', '-cc'].join(''), 'i') },
  { label: 'shared bookgen runs path', pattern: new RegExp(['hsb-bookgen', '-runs'].join(''), 'i') },
];

/** Text files carried by this candidate, including untracked additions. */
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|mp[34]|mov|mp4|webm|wav|ogg|bin|wasm|node|so|dll|exe|jar|db|sqlite3?|lock)$/i;
const CANDIDATE_BASE = 'b9db1c32f1c66cd7c36ac2a71609a758d8a064a2';
function scannedFiles(): string[] {
  const changed = execFileSync('git', ['diff', '--name-only', '-z', CANDIDATE_BASE],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const untracked = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  return [...new Set([...changed, ...untracked])]
    .filter((f) => !BINARY.test(f)).map((f) => path.join(REPO, f));
}

test('REQ16: no real customer or order identifier appears in anything committable', () => {
  const violations: string[] = [];
  for (const file of scannedFiles()) {
    let buf: Buffer;
    try { buf = readFileSync(file); } catch { continue; }
    if (buf.subarray(0, 8192).includes(0)) continue;
    const text = buf.toString('utf8');
    text.split('\n').forEach((line, i) => {
      for (const { label, pattern } of BANNED) {
        if (pattern.test(line)) violations.push(`${path.relative(REPO, file)}:${i + 1} [${label}]`);
      }
    });
  }
  assert.deepEqual(violations, [], `banned identifiers must never be committable:\n${violations.join('\n')}`);
});

test('REQ17: approval must not import or reference any print/provider handoff', () => {
  const text = readFileSync(path.join(REPO, 'src/lib/page-review.ts'), 'utf8');
  for (const banned of ['approvePrintProof', 'submitPrintJob', 'sendProofReadyEmail', 'sendDigitalDeliveryEmail']) {
    assert.doesNotMatch(text, new RegExp(banned),
      `page-review.ts must never reference ${banned} — customer approval ends at review approval`);
  }
  // Approval must not rebuild: no proof builder may be reachable from it.
  const approve = text.slice(text.indexOf('export async function approveWholeBook'));
  const end = approve.indexOf('\n}\n');
  assert.ok(end > 0, 'approveWholeBook must be bounded');
  const body = approve.slice(0, end);
  assert.doesNotMatch(body, /buildProof|rebuildProof|refreshProof/,
    'approveWholeBook must not build or refresh a proof');
});

test('REQ17: the acknowledgment version check is present and load-bearing', () => {
  const text = readFileSync(path.join(REPO, 'src/lib/page-review.ts'), 'utf8');
  const ack = text.slice(text.indexOf('export async function acknowledgeProofReview'));
  const end = ack.indexOf('\n}\n');
  assert.ok(end > 0, 'acknowledgeProofReview must be bounded');
  const body = ack.slice(0, end);
  assert.match(body, /proof_version_mismatch/, 'ack must reject a mismatched submitted version');
  assert.match(body, /proofSourceFingerprint/, 'ack must verify the persisted fingerprint');
  assert.match(body, /proofReviewedVersion/, 'ack must persist the reviewed version');
});

test('REQ17: no truthy fingerprint guard may gate proof persistence', () => {
  for (const rel of ['src/lib/page-review.ts', 'src/lib/fulfillment.ts']) {
    const text = readFileSync(path.join(REPO, rel), 'utf8');
    assert.doesNotMatch(text, /if\s*\(\s*builtFrom\s*&&/,
      `${rel}: a truthy fingerprint guard fails OPEN when the fingerprint is absent — ` +
        'a missing fingerprint must fail closed instead');
  }
});

test('REQ17: the client submits the proof version and never uses a correctness nonce', () => {
  const rel = 'src/app/review/[orderId]/review-client.tsx';
  const text = readFileSync(path.join(REPO, rel), 'utf8');
  const i = text.indexOf('acknowledge-proof');
  assert.ok(i > 0, `${rel}: the acknowledge call must exist`);
  const ackCall = text.slice(i, i + 600);
  assert.match(
    ackCall,
    /body: JSON\.stringify\(\{\s*proofVersion: snapshot\.proofVersion\s*\}\)/,
    `${rel}: acknowledge must POST the exact persisted revision`,
  );
  assert.match(text, /proofVersion: string \| null;/, `${rel}: snapshot must carry the revision`);
  assert.doesNotMatch(text, /proofNonce/);
});

test('REQ17: wording requests are a separate snapshot-authoritative client action', () => {
  const rel = 'src/app/review/[orderId]/review-client.tsx';
  const text = readFileSync(path.join(REPO, rel), 'utf8');
  const start = text.indexOf('async function requestWordingChange');
  const end = text.indexOf('\n  return (', start);
  assert.ok(start > 0 && end > start, `${rel}: wording action must exist and be bounded`);
  const wording = text.slice(start, end);
  assert.match(wording, /request-text-change/, 'wording action must call only the wording route');
  assert.doesNotMatch(wording, /regenerate-page|generatePage|providers?/, 'wording must never call image generation');
  assert.match(wording, /setSnapshot\(data\.snapshot\)/, 'wording success must replace the full snapshot');
  assert.match(text, /unresolvedWording/, 'the client must derive unresolved wording state');
  assert.match(text, /!allAccepted \|\|[\s\S]*unresolvedWording \|\|[\s\S]*!proofAck/,
    'unresolved wording must disable final approval');
});

test('REQ17: failed regeneration applies committed snapshot before the client error branch', () => {
  const clientRel = 'src/app/review/[orderId]/review-client.tsx';
  const client = readFileSync(path.join(REPO, clientRel), 'utf8');
  const start = client.indexOf('async function regenerate()');
  const end = client.indexOf('async function accept()', start);
  assert.ok(start > 0 && end > start, `${clientRel}: regeneration action must be bounded`);
  const body = client.slice(start, end);
  const apply = body.indexOf('if (data.snapshot) setSnapshot(data.snapshot)');
  const fail = body.indexOf('if (!res.ok || !data.ok)');
  assert.ok(apply > 0 && fail > apply,
    'committed snapshot must be applied before a provider/error response returns');

  const routeRel = 'src/app/api/order/[orderId]/regenerate-page/route.ts';
  const route = readFileSync(path.join(REPO, routeRel), 'utf8');
  const failure = route.slice(route.indexOf('if (!result.ok)'), route.indexOf('return NextResponse.json({', route.indexOf('if (!result.ok)')));
  assert.match(failure, /snapshot:\s*result\.snapshot\s*\?\?\s*null/,
    `${routeRel}: failed committed mutations must expose the authoritative snapshot`);
});

test('REQ17: admin wording failure applies authoritative snapshot before displaying error', () => {
  const rel = 'src/app/admin/orders/[orderId]/page-review-grid.tsx';
  const text = readFileSync(path.join(REPO, rel), 'utf8');
  assert.match(text, /setAuthoritativePages\(snapshot\.pageArtifacts\)/,
    'admin grid must replace its page state from the returned snapshot');
  const start = text.indexOf('async function resolveWording()');
  const end = text.indexOf('const imgUrl', start);
  assert.ok(start > 0 && end > start, `${rel}: resolve action must be bounded`);
  const body = text.slice(start, end);
  const apply = body.indexOf('if (data.snapshot) applySnapshot(data.snapshot)');
  const refresh = body.indexOf('router.refresh()');
  const fail = body.indexOf('if (!res.ok) setErr');
  assert.ok(apply > 0 && refresh > apply && fail > refresh,
    'admin must apply and refresh authoritative committed state before displaying failure');
});

test('REQ17: every successful review mutation replaces the authoritative snapshot', () => {
  const rel = 'src/app/review/[orderId]/review-client.tsx';
  const text = readFileSync(path.join(REPO, rel), 'utf8');
  const replacements = text.match(/setSnapshot\(data\.snapshot\)/g) ?? [];
  assert.ok(replacements.length >= 5, 'regenerate, accept, wording, acknowledgment and approval replace snapshots');
  assert.doesNotMatch(text, /setSnapshot\(\(s\)\s*=>/, 'partial client-side snapshot patches are forbidden');
  assert.doesNotMatch(text, /useState\([^\n]*proofAck/, 'proof acknowledgment must be derived from the snapshot');
});

test('REQ17: customer approval copy cannot promise immediate print submission', () => {
  const rel = 'src/app/review/[orderId]/review-client.tsx';
  const text = readFileSync(path.join(REPO, rel), 'utf8');
  assert.match(text, /Print release happens separately after our final production checks/);
  assert.doesNotMatch(text, /Approve[^\n]*send to print/i);
  assert.doesNotMatch(text, /sent to print/i);
});
