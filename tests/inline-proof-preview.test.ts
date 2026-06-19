/**
 * Inline-proof-preview wiring tests.
 *
 * No DOM renderer in this repo — we lock the contract via:
 *  (a) source-level guards that the component is mounted on /review and
 *      renders the right testids,
 *  (b) verifying the missing-proof branch is in the component source,
 *  (c) verifying the per-page review controls and approval gate are
 *      untouched on /review.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const REVIEW_CLIENT = 'src/app/review/[orderId]/review-client.tsx';
const PREVIEW = 'src/app/review/[orderId]/inline-proof-preview.tsx';

test('inline preview component exists and exports InlineProofPreview', () => {
  const src = readFileSync(PREVIEW, 'utf8');
  assert.match(src, /export function InlineProofPreview/);
});

test('inline preview lazy-mounts the iframe via IntersectionObserver', () => {
  const src = readFileSync(PREVIEW, 'utf8');
  assert.match(src, /IntersectionObserver/);
  assert.match(src, /shouldMount/);
});

test('inline preview detects iOS / in-app webviews and skips the iframe', () => {
  const src = readFileSync(PREVIEW, 'utf8');
  assert.match(src, /iPad\|iPhone\|iPod/);
  assert.match(src, /FBAN\|FBAV\|Instagram/);
  assert.match(src, /iframeBlocked/);
});

test('inline preview always renders Open + Download CTAs as the supported fallback', () => {
  const src = readFileSync(PREVIEW, 'utf8');
  assert.match(src, /data-testid=\{`\$\{testId\}-open`\}/);
  assert.match(src, /data-testid=\{`\$\{testId\}-download`\}/);
  assert.match(src, /Open in new tab/);
  assert.match(src, /Download PDF/);
});

test('inline preview handles missing proof gracefully (no iframe, explicit shell)', () => {
  const src = readFileSync(PREVIEW, 'utf8');
  // Missing branch returns a labeled section with a `<testId>-missing` testid.
  assert.match(src, /-missing/);
  assert.match(src, /!proofUrl/);
  assert.match(src, /full proof PDF isn[^\n]*ready yet/i);
});

test('inline preview labels the section as "Complete print proof" / "Complete assembled PDF"', () => {
  const src = readFileSync(PREVIEW, 'utf8');
  assert.match(src, /Complete print proof/);
  assert.match(src, /Complete assembled PDF/);
  assert.match(src, /isPrint/);
});

test('review client mounts InlineProofPreview between per-page review and approval', () => {
  const src = readFileSync(REVIEW_CLIENT, 'utf8');
  assert.match(src, /InlineProofPreview/);
  // The preview must come BEFORE the approval section in source order so the
  // customer scrolls through the full proof on the way to Approve.
  const previewIdx = src.indexOf('InlineProofPreview');
  const approvalIdx = src.indexOf('data-testid="approval-section"');
  assert.ok(previewIdx > -1);
  assert.ok(approvalIdx > -1);
  assert.ok(previewIdx < approvalIdx, 'InlineProofPreview must mount before the approval section');
});

test('review client preserves per-page review controls (request changes / approve / past feedback)', () => {
  const src = readFileSync(REVIEW_CLIENT, 'utf8');
  // Page selector + per-page actions
  assert.match(src, /Request changes/);
  assert.match(src, /Approve this page/);
  // Per-page feedback / version history surfaces still rendered
  assert.match(src, /Past feedback/);
});

test('review client still gates Approve on allAccepted + proofAck + storyArtifactUrl', () => {
  const src = readFileSync(REVIEW_CLIENT, 'utf8');
  const upTo = src.indexOf('data-testid="approve-whole-book"');
  const before = src.slice(0, upTo);
  const disabledStart = before.lastIndexOf('disabled={');
  const disabledBlock = before.slice(disabledStart, upTo);
  assert.match(disabledBlock, /!allAccepted/);
  assert.match(disabledBlock, /!proofAck/);
  assert.match(disabledBlock, /!snapshot\.storyArtifactUrl/);
});

test('review client preserves the existing Open Full Proof PDF CTA in the approval block', () => {
  const src = readFileSync(REVIEW_CLIENT, 'utf8');
  assert.match(src, /data-testid="full-proof-cta"/);
  // The approval block keeps an explicit full-proof PDF button in step 1.
  assert.match(src, /Open the full proof PDF/);
});

test('inline preview is a client component (uses hooks)', () => {
  const src = readFileSync(PREVIEW, 'utf8');
  assert.match(src, /^['"]use client['"]/m);
  assert.match(src, /useState|useRef|useEffect/);
});
