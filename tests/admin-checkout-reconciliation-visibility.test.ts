/**
 * The ambiguous checkout-provisioning state has to be findable and recognisable
 * by an operator: enumerable on the authenticated order list, explained on the
 * order detail page, and never rendered with the marker's own secrets.
 *
 * This slice is read-only visibility. The modules that decide incidents, scan
 * for stranded orders, schedule work, and write checkout state stay byte-for-byte
 * identical to the base commit — pinned below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  CHECKOUT_RECONCILIATION_LABEL,
  CHECKOUT_RECONCILIATION_WARNING,
} from '../src/lib/checkout-provisioning-evidence.ts';

const BASE_SHA = '6aef22c36e9f9b897ce7d7fae51660af46e45c8a';

function src(path: string): string {
  return readFileSync(path, 'utf8');
}

const LIST_PAGE = 'src/app/admin/orders/page.tsx';
const DETAIL_PAGE = 'src/app/admin/orders/[orderId]/page.tsx';

/**
 * The one sanctioned change to `orders.ts` since the base commit.
 *
 * The browser-side media size preflight moved the two story-attachment caps
 * into the browser-safe `story-media-size.ts` so the checkout page refuses an
 * oversize file using the exact number this server boundary enforces. That
 * extraction touches `orders.ts` in three places and nowhere else.
 *
 * Each rule rewrites exactly one of those places back to its base form. A rule
 * that does not apply exactly once fails, and the whole-file equality check
 * that follows still has to hold — so any OTHER byte that moved, anywhere in
 * the file, is a failure. This narrows the freeze; it does not relax it.
 */
const ORDERS_SANCTIONED_TRANSFORMS: ReadonlyArray<{
  description: string;
  candidate: string;
  base: string;
}> = [
  {
    description: 'import of the canonical story-media size policy',
    candidate: "import { STORY_MEDIA_MAX_BYTES } from './story-media-size.ts';\n",
    base: '',
  },
  {
    description: 'MAX_VOICE_BYTES reading the canonical audio cap',
    candidate: 'export const MAX_VOICE_BYTES = STORY_MEDIA_MAX_BYTES.audio;',
    base: 'export const MAX_VOICE_BYTES = 15 * 1024 * 1024;',
  },
  {
    description: 'MAX_DOCUMENT_BYTES reading the canonical document cap',
    candidate: 'export const MAX_DOCUMENT_BYTES = STORY_MEDIA_MAX_BYTES.document;',
    base: 'export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;',
  },
];

function withoutStoryMediaSizeExtraction(candidate: string): string {
  let normalized = candidate;
  for (const rule of ORDERS_SANCTIONED_TRANSFORMS) {
    const occurrences = normalized.split(rule.candidate).length - 1;
    assert.equal(
      occurrences,
      1,
      `src/lib/orders.ts must carry the ${rule.description} exactly once, found ${occurrences}`,
    );
    // A function replacer: no `$&`-style expansion out of the base text.
    normalized = normalized.replace(rule.candidate, () => rule.base);
  }
  return normalized;
}

/** Files frozen except for a declared, reversible transformation. */
const FREEZE_NORMALIZERS: Readonly<Record<string, (source: string) => string>> = {
  'src/lib/orders.ts': withoutStoryMediaSizeExtraction,
};

test('the operator copy says what the state is and forbids automatic retry', () => {
  assert.equal(CHECKOUT_RECONCILIATION_LABEL, 'Checkout reconciliation required');
  assert.equal(CHECKOUT_RECONCILIATION_WARNING, 'Do not retry payment automatically');
});

test('the admin order list enumerates orders needing checkout reconciliation', () => {
  const page = src(LIST_PAGE);
  assert.match(page, /readCheckoutProvisioningEvidence/);
  assert.match(page, /CHECKOUT_RECONCILIATION_LABEL/);
  assert.match(page, /CHECKOUT_RECONCILIATION_WARNING/);
  // The panel must enumerate: one linked order id per affected order.
  assert.match(page, /\/admin\/orders\/\$\{row\.id\}/);
});

test('the admin order detail page shows the checkout reconciliation evidence', () => {
  const page = src(DETAIL_PAGE);
  assert.match(page, /readCheckoutProvisioningEvidence/);
  assert.match(page, /CHECKOUT_RECONCILIATION_LABEL/);
  assert.match(page, /CHECKOUT_RECONCILIATION_WARNING/);
  assert.match(page, /checkoutEvidence\.status === 'reconciliation_required'/);
});

test('neither admin surface renders the marker token, nonce, or provider identifiers', () => {
  for (const path of [LIST_PAGE, DETAIL_PAGE]) {
    const page = src(path);
    for (const field of [
      'idempotencyKey',
      'checkoutAttemptId',
      'checkoutFingerprint',
      'checkoutLeaseId',
      'checkoutSessionCandidate',
      'checkoutSessionProvisioning',
    ]) {
      assert.equal(page.includes(field), false, `${path} renders ${field}`);
    }
  }
});

test('the runbook documents read-only verification and forbids automatic retry', () => {
  const runbook = src('docs/runbooks/support-stuck-order-checklist.md');
  assert.match(runbook, /Checkout reconciliation required/);
  assert.match(runbook, /Do not retry payment automatically/);
  assert.match(runbook, /read-only/i);
});

test('incident classification, stranded-order scans, and schedules are unchanged from the base commit', () => {
  for (const path of [
    'src/lib/order-incident.ts',
    'src/lib/stranded-order-detector.ts',
    'src/lib/stranded-order-detector-runtime.ts',
    'vercel.json',
    'src/lib/checkout-session-provisioning.ts',
    'src/lib/orders.ts',
    'src/lib/fulfillment.ts',
    'src/lib/checkout-intake-order-binding.ts',
  ]) {
    const committed = execFileSync('git', ['show', `${BASE_SHA}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const normalize = FREEZE_NORMALIZERS[path] ?? ((source: string) => source);
    assert.equal(
      normalize(src(path)),
      committed,
      `${path} differs from ${BASE_SHA} beyond its declared transformations`,
    );
  }
});
