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
import { customerReviewActor, getReviewSnapshot, regeneratePage } from '../src/lib/page-review.ts';
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
  const pages = [page(0), page(1)];
  return {
    ...createOrderRecord(
      { childName: 'Testkid', bookFormat: 'digital', email: 'reviewer@example.invalid' },
      { id, now: NOW }),
    paymentStatus: 'paid', reviewStatus: 'in_review',
    storyArtifactUrl: IMMUTABLE_PROOF,
    proofSourceFingerprint: proofSourceFingerprint(pages),
    proofVersion: 'v4', proofReviewedAt: NOW, proofReviewedVersion: 'v4',
    proofApprovalToken: TOKEN, pageArtifacts: pages, auditEvents: [], ...o,
  };
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

// ── 16/17: source guards, bounded and load-bearing ─────────────────────────

const BANNED: Array<{ label: string; pattern: RegExp }> = [
  { label: 'real recipient first name', pattern: new RegExp(`\\b${['P', 'eter'].join('')}\\b`, 'i') },
  { label: 'real child name', pattern: new RegExp(`\\b${['B', 'enny'].join('')}\\b`, 'i') },
  { label: 'real order id', pattern: new RegExp(['ord_', '217450cb153f4543'].join(''), 'i') },
  { label: 'order-scoped artifact path', pattern: /review-v2-cc/i },
  { label: 'shared bookgen runs path', pattern: /hsb-bookgen-runs/i },
];

/** Everything a commit could carry: tracked plus untracked-not-ignored. */
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|mp[34]|mov|mp4|webm|wav|ogg|bin|wasm|node|so|dll|exe|jar|db|sqlite3?|lock)$/i;
function scannedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean).filter((f) => !BINARY.test(f)).map((f) => path.join(REPO, f));
}

test('REQ16: no real customer or order identifier appears in anything committable', () => {
  const violations: string[] = [];
  const self = path.join(REPO, 'tests/review-snapshot-and-guards.test.ts');
  for (const file of scannedFiles()) {
    if (file === self) continue;
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

  // Bound to the acknowledge call specifically, so this cannot be satisfied by
  // the word appearing somewhere unrelated.
  const i = text.indexOf('acknowledge-proof');
  assert.ok(i > 0, `${rel}: the acknowledge call must exist`);
  const ackCall = text.slice(i, i + 600);
  assert.match(
    ackCall,
    /body: JSON\.stringify\(\{\s*proofVersion: snapshot\.proofVersion\s*\}\)/,
    `${rel}: acknowledge must POST the exact persisted revision, so the server can ` +
      'bind the acknowledgment to that artifact',
  );
  assert.match(text, /proofVersion: string \| null;/, `${rel}: snapshot must carry the revision`);
  assert.doesNotMatch(text, /proofNonce/,
    `${rel}: a session-local nonce must not be load-bearing — the persisted URL is immutable`);
});
