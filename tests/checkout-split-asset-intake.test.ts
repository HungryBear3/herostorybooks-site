/**
 * Checkout split-asset pre-upload — guards.
 *
 * The split-asset intake (draft → per-file asset upload → JSON finalize) is the
 * fix for the ~4MB serverless body limit: each photo/voice file is its own small
 * request to Blob, and only Blob refs go to finalize. These tests pin the
 * contract that matters for launch safety:
 *   - the flag actually gates the split flow,
 *   - the legacy single-multipart POST /api/order remains ONLY a fallback,
 *   - no third parallel upload system was introduced,
 *   - per-file retry is idempotent (already-uploaded files are not re-sent).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  isSplitAssetIntakeEnabled,
  planAssetUploads,
} from '../src/lib/order-intake.ts';

const CHECKOUT_SRC = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
const ORDER_ROUTE_SRC = readFileSync('src/app/api/order/route.ts', 'utf8');
const FINALIZE_SRC = readFileSync('src/app/api/order/finalize/route.ts', 'utf8');
const ORDER_INTAKE_SRC = readFileSync('src/lib/order-intake.ts', 'utf8');

// ── flag gating ───────────────────────────────────────────────────────────────

test('isSplitAssetIntakeEnabled is true only for the exact string "true"', () => {
  assert.equal(isSplitAssetIntakeEnabled('true'), true);
  assert.equal(isSplitAssetIntakeEnabled('false'), false);
  assert.equal(isSplitAssetIntakeEnabled('1'), false);
  assert.equal(isSplitAssetIntakeEnabled(''), false);
  assert.equal(isSplitAssetIntakeEnabled(undefined), false);
});

test('checkout reads the split-asset flag from NEXT_PUBLIC_HSB_SPLIT_ASSET_INTAKE', () => {
  assert.match(CHECKOUT_SRC, /NEXT_PUBLIC_HSB_SPLIT_ASSET_INTAKE/);
  assert.match(CHECKOUT_SRC, /SPLIT_ASSET_INTAKE_ENABLED/);
});

test('checkout uses the draft → assets → finalize flow ONLY when the flag is on', () => {
  // The split flow must be inside an `if (SPLIT_ASSET_INTAKE_ENABLED) { ... }`
  // guard that contains the draft/assets/finalize calls.
  const guardStart = CHECKOUT_SRC.indexOf('if (SPLIT_ASSET_INTAKE_ENABLED)');
  assert.ok(guardStart > -1, 'split flow must be flag-guarded');
  // The guarded block runs from the flag check up to the legacy fallback POST.
  const legacyPost = CHECKOUT_SRC.indexOf('await fetch("/api/order"', guardStart);
  const guardedRegion = CHECKOUT_SRC.slice(guardStart, legacyPost);
  assert.match(guardedRegion, /\/api\/order\/draft/);
  assert.match(guardedRegion, /\/api\/order\/draft\/\$\{draftOrderId\}\/assets/);
  assert.match(guardedRegion, /\/api\/order\/finalize/);
});

// ── legacy multipart is a fallback only ───────────────────────────────────────

test('legacy POST /api/order multipart is reached only after the split flow returns', () => {
  const guardStart = CHECKOUT_SRC.indexOf('if (SPLIT_ASSET_INTAKE_ENABLED)');
  const legacyPost = CHECKOUT_SRC.indexOf('await fetch("/api/order"');
  assert.ok(legacyPost > -1, 'legacy /api/order POST should still exist as a fallback');
  // The legacy POST must come AFTER the split-flow guard block, and the split
  // block must early-return so legacy never runs when the flag is on.
  assert.ok(legacyPost > guardStart, 'legacy POST must be after the split-flow guard');
  const guardedRegion = CHECKOUT_SRC.slice(guardStart, legacyPost);
  assert.match(guardedRegion, /\breturn;\s*\n\s*}/, 'split flow must early-return before legacy');
});

// ── no third parallel upload system ───────────────────────────────────────────

test('no separate upload-asset route was introduced (single asset path is the draft route)', () => {
  assert.equal(
    existsSync('src/app/api/order/upload-asset/route.ts'),
    false,
    'a parallel /api/order/upload-asset route must NOT exist',
  );
});

test('POST /api/order/route.ts stays multipart-only (no parallel JSON blob-ref branch added)', () => {
  // The legacy order route must keep reading formData() and must NOT have grown
  // a second JSON path that accepts raw blob URLs — that would be the duplicate
  // system we explicitly avoided.
  assert.match(ORDER_ROUTE_SRC, /await request\.formData\(\)/);
  assert.doesNotMatch(ORDER_ROUTE_SRC, /application\/json/);
  assert.doesNotMatch(ORDER_ROUTE_SRC, /guidedReferencePhotoBlobUrls/);
});

// ── idempotent per-file retry (no duplicate uploads) ──────────────────────────

test('planAssetUploads: first attempt uploads every file, nothing reused', () => {
  const files = ['a', 'b', 'c'];
  const { pending, reusedAssetIds } = planAssetUploads(files, new Map());
  assert.deepEqual(pending, ['a', 'b', 'c']);
  assert.deepEqual(reusedAssetIds, []);
});

test('planAssetUploads: retry skips already-uploaded files and reuses their assetIds', () => {
  // Simulate: a, b uploaded successfully; c failed. Retry must re-send ONLY c.
  const files = ['a', 'b', 'c'];
  const uploaded = new Map<string, string>([
    ['a', 'asset_a'],
    ['b', 'asset_b'],
  ]);
  const { pending, reusedAssetIds } = planAssetUploads(files, uploaded);
  assert.deepEqual(pending, ['c'], 'only the failed file is re-uploaded');
  assert.deepEqual(reusedAssetIds, ['asset_a', 'asset_b'], 'prior assetIds reused, not re-uploaded');
});

test('planAssetUploads: when all files already uploaded, nothing is re-sent', () => {
  const files = ['a', 'b'];
  const uploaded = new Map([['a', 'asset_a'], ['b', 'asset_b']]);
  const { pending, reusedAssetIds } = planAssetUploads(files, uploaded);
  assert.deepEqual(pending, []);
  assert.deepEqual(reusedAssetIds, ['asset_a', 'asset_b']);
});

test('planAssetUploads: order is preserved across pending + reused', () => {
  const files = ['a', 'b', 'c', 'd'];
  const uploaded = new Map([['b', 'asset_b'], ['d', 'asset_d']]);
  const { pending, reusedAssetIds } = planAssetUploads(files, uploaded);
  assert.deepEqual(pending, ['a', 'c']);
  assert.deepEqual(reusedAssetIds, ['asset_b', 'asset_d']);
});

test('checkout memoizes uploaded assetIds per File so a retry does not re-upload', () => {
  // Source guard: the client must cache assetIds by File and short-circuit on retry.
  assert.match(CHECKOUT_SRC, /uploadedAssetIdsRef/);
  assert.match(CHECKOUT_SRC, /uploadedAssetIdsRef\.current\.get\(file\)/);
  assert.match(CHECKOUT_SRC, /uploadedAssetIdsRef\.current\.set\(file, assetId\)/);
});

// ── double-tap / concurrent retry is idempotent (no duplicate uploads) ─────────

test('uploadOneAsset short-circuits a cached File (returns the assetId before any fetch)', () => {
  // The cached branch must `return cached;` BEFORE issuing the assets POST, so a
  // double-tap / re-submit of an already-uploaded file never hits the network.
  const cachedIdx = CHECKOUT_SRC.indexOf('const cached = uploadedAssetIdsRef.current.get(file)');
  assert.ok(cachedIdx > -1, 'must read the per-File cache');
  const assetsFetchIdx = CHECKOUT_SRC.indexOf('/api/order/draft/${draftOrderId}/assets', cachedIdx);
  const earlyReturn = CHECKOUT_SRC.slice(cachedIdx, assetsFetchIdx);
  assert.match(earlyReturn, /if \(cached\)[\s\S]*return cached;/, 'cached File returns before the assets PUT');
});

test('submit button is disabled while submitting so a double-tap cannot fire a second batch', () => {
  assert.match(CHECKOUT_SRC, /disabled=\{isSubmitting/);
});

// ── charge copy is bounded by the Stripe handoff ──────────────────────────────

test('finalize hands off to hosted Stripe Checkout (charge happens there, not at finalize)', () => {
  // This is WHY the pre-handoff copy can say "not charged yet": finalize only
  // creates a Stripe Checkout session and returns its URL; the customer is
  // charged on the hosted Stripe page, not by finalize.
  assert.match(FINALIZE_SRC, /stripe\.checkout\.sessions\.create/);
  assert.match(FINALIZE_SRC, /redirectTo: session\.url/);
});

test('pre-handoff upload band shows the "not charged yet" promise', () => {
  // While files are uploading (before any Stripe handoff) the persistent band
  // must reassure the customer they have not been charged.
  assert.match(CHECKOUT_SRC, /Saving your files securely — you have not been charged yet\./);
});

test('post-finalize interstitial uses Stripe-handoff wording, not a charged/free claim', () => {
  // After finalize succeeds we redirect to hosted Stripe. The copy must say
  // payment is reviewed in Stripe and nothing is charged until completed there —
  // never "charged"/"confirmed"/"free", which would misstate the boundary.
  const successIdx = CHECKOUT_SRC.indexOf('Taking you to secure payment');
  assert.ok(successIdx > -1, 'Stripe-handoff interstitial must exist');
  const successBlock = CHECKOUT_SRC.slice(successIdx, successIdx + 900);
  assert.match(successBlock, /review payment in Stripe/);
  assert.match(successBlock, /nothing is charged[\s\S]*until you complete it there/);
  assert.doesNotMatch(successBlock, /\byou have been charged\b/i);
  assert.doesNotMatch(successBlock, /\bfor free\b|\bit'?s free\b/i);
});

// ── reload/resume-safe dedupe is now implemented via a stable client localId ──

test('server-side reload/resume-safe dedupe is implemented via localId', () => {
  // addIntakeAsset short-circuits on a matching (category, localId): a re-sent
  // file returns the existing asset instead of duplicating or tripping a cap.
  assert.match(ORDER_INTAKE_SRC, /Reload\/resume-safe idempotency/);
  assert.match(ORDER_INTAKE_SRC, /asset\.localId === localId/);
  // The client sends a stable per-file localId with every asset upload.
  assert.match(CHECKOUT_SRC, /assetPayload\.set\("localId"/);
});

// ── durable draft read path ───────────────────────────────────────────────────

test('getIntakeDraft public blob reads resolve the persisted blob URL before reading', () => {
  // Production/Preview order reads learned this lesson already: with public Blob
  // stores, read via the listed blob.url first. Reading a just-written draft only
  // by pathname through @vercel/blob get() can fail in Vercel Preview and break
  // the next /assets call with `Durable draft read failed`.
  const readStart = ORDER_INTAKE_SRC.indexOf('export async function getIntakeDraft');
  assert.ok(readStart > -1, 'getIntakeDraft must exist');
  const readBlock = ORDER_INTAKE_SRC.slice(readStart, ORDER_INTAKE_SRC.indexOf('export async function createIntakeDraft', readStart));
  assert.match(readBlock, /await list\(\{ prefix: pathname, token \}\)/);
  assert.match(readBlock, /blob\.pathname === pathname/);
  assert.match(readBlock, /readBlobText\(\{ pathname: blob\.pathname, url: blob\.url, token \}\)/);
});
