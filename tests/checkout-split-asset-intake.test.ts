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
