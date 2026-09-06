/**
 * Intake capacity + honest processing expectations.
 *
 * Two guarantees, locked together because they are the same policy:
 *
 *  1. There is no hard public daily paid-order cap. Checkout must never refuse a
 *     buyer merely because N paid orders already exist that day, and no obsolete
 *     limit env var (`HSB_PUBLIC_CHECKOUT_DAILY_PAID_LIMIT` and friends, which
 *     live only on unmerged branches) may silently reintroduce one.
 *  2. Because we do not cap intake, every customer surface must instead be
 *     honest about the wait: personal review before the proof, a longer wait when
 *     volume is high, and a support path — all single-sourced from
 *     `src/lib/proof-turnaround.ts` so the surfaces cannot drift.
 *
 * The real safety refusals (pause kill switch, privacy/photo gates, invalid
 * input, custom-story gates) must keep failing closed before Stripe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildDeliveryExpectation, createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';
import { buildOrderConfirmationEmail } from '../src/lib/order-email.ts';
import { buildOrderStatusView } from '../src/lib/order-status-view.ts';
import {
  PROOF_DELAY_SUPPORT_NOTE,
  PROOF_REVIEW_ASSURANCE,
  PROOF_TURNAROUND_WINDOW,
  PROOF_VOLUME_NOTE,
} from '../src/lib/proof-turnaround.ts';

const read = (p: string) => readFileSync(p, 'utf8');
const orderRoute = () => read('src/lib/checkout-order-route-handler.ts') + read('src/app/api/order/route.ts');

/** Every identifier the unmerged capacity-cap stack used. None may return. */
const CAP_IDENTIFIERS = [
  'HSB_PUBLIC_CHECKOUT_DAILY_PAID_LIMIT',
  'parsePublicCheckoutDailyPaidLimit',
  'isCheckoutCapacityFull',
  'buildCapacityDashboardSummary',
  'capacity-dashboard',
  'dailyPaidCeiling',
  'paidOrdersToday',
];

/** Live customer-facing surfaces. Dead landing/* components are excluded. */
const CUSTOMER_SURFACES: Array<[string, string]> = [
  ['homepage/pricing/FAQ', 'src/components/editorial-site.tsx'],
  ['checkout', 'src/app/checkout/checkout-form.tsx'],
  ['thank-you', 'src/app/thank-you/page.tsx'],
  ['status', 'src/app/status/[orderId]/page.tsx'],
  ['status view', 'src/lib/order-status-view.ts'],
  ['order email', 'src/lib/order-email.ts'],
  ['order records', 'src/lib/orders.ts'],
];

const FORMATS = ['digital', 'classic', 'premium'] as const;

// ── 1. No daily paid-order cap ───────────────────────────────────────────────

test('no daily paid-order cap identifier survives anywhere in the intake path', () => {
  const scanned: Array<[string, string]> = [
    ['order route', 'src/app/api/order/route.ts'],
    ['order route handler', 'src/lib/checkout-order-route-handler.ts'],
    ['checkout pause', 'src/lib/checkout-pause.ts'],
    ['checkout page', 'src/app/checkout/page.tsx'],
    ...CUSTOMER_SURFACES,
  ];
  for (const [label, path] of scanned) {
    const src = read(path);
    for (const id of CAP_IDENTIFIERS) {
      assert.ok(!src.includes(id), `${label} (${path}) must not reference cap identifier ${id}`);
    }
  }
});

test('checkout intake reads no capacity/limit env var at all', () => {
  const src = orderRoute();
  const envReads = src.match(/process\.env\.[A-Z0-9_]+/g) ?? [];
  for (const read of envReads) {
    assert.ok(
      !/LIMIT|CAP|CEILING|QUOTA|MAX_ORDERS/.test(read),
      `order route must not read a capacity env var, found ${read}`,
    );
  }
});

test('many otherwise-valid paid orders on the same day are all accepted identically', () => {
  const now = '2026-08-20T15:00:00.000Z';
  const records: OrderRecord[] = [];
  for (let i = 0; i < 6; i += 1) {
    records.push(
      createOrderRecord(
        { childName: `Kid${i}`, bookFormat: 'classic', email: `buyer${i}@example.com` },
        { id: `ord_same_day_${i}`, now },
      ),
    );
  }
  assert.equal(records.length, 6, 'order creation must not be count-limited');
  // The 3rd+ same-day order is treated exactly like the 1st — no cap-derived
  // degradation of price, expectation, or state.
  for (const rec of records) {
    assert.equal(rec.paymentStatus, records[0].paymentStatus);
    assert.equal(rec.priceCents, records[0].priceCents);
    assert.equal(rec.deliveryExpectation, records[0].deliveryExpectation);
  }
});

test('obsolete limit env values cannot reactivate a cap or alter customer copy', () => {
  const baseline = {
    expectation: buildDeliveryExpectation('classic'),
    order: createOrderRecord(
      { childName: 'Ada', bookFormat: 'classic', email: 'ada@example.com' },
      { id: 'ord_env_baseline', now: '2026-08-20T15:00:00.000Z' },
    ),
  };
  const baselineEmail = buildOrderConfirmationEmail(baseline.order, { supportEmail: 's@example.com' });

  const previous = process.env.HSB_PUBLIC_CHECKOUT_DAILY_PAID_LIMIT;
  try {
    for (const value of ['0', '1', '2', 'not-a-number', '']) {
      process.env.HSB_PUBLIC_CHECKOUT_DAILY_PAID_LIMIT = value;
      const order = createOrderRecord(
        { childName: 'Ada', bookFormat: 'classic', email: 'ada@example.com' },
        { id: 'ord_env_baseline', now: '2026-08-20T15:00:00.000Z' },
      );
      const email = buildOrderConfirmationEmail(order, { supportEmail: 's@example.com' });
      assert.equal(buildDeliveryExpectation('classic'), baseline.expectation, `limit=${value} changed delivery copy`);
      assert.equal(order.deliveryExpectation, baseline.order.deliveryExpectation, `limit=${value} changed order expectation`);
      assert.equal(email.html, baselineEmail.html, `limit=${value} changed email HTML`);
      assert.equal(email.text, baselineEmail.text, `limit=${value} changed email text`);
    }
  } finally {
    if (previous === undefined) delete process.env.HSB_PUBLIC_CHECKOUT_DAILY_PAID_LIMIT;
    else process.env.HSB_PUBLIC_CHECKOUT_DAILY_PAID_LIMIT = previous;
  }
});

// ── 2. Real safety refusals still fail closed before Stripe ──────────────────

test('pause kill switch and every unrelated safety gate still precede Stripe construction', () => {
  const src = orderRoute();
  // Provider Session creation is no longer written inline in the handler: both
  // paths now enter a shared provisioner (src/lib/checkout-session-provisioning.ts)
  // which owns renew → create → record candidate → bind → release. The gate
  // boundary is therefore the point where ANY provider work first becomes
  // reachable — whichever orchestration entry point comes first.
  const directEntryIdx = src.indexOf('await runDirectIntakeCheckout({');
  const legacyEntryIdx = src.indexOf('await provisionCheckoutSession({');
  assert.ok(directEntryIdx > -1, 'route still reaches the direct provisioning saga');
  assert.ok(legacyEntryIdx > -1, 'route still reaches the legacy provisioning saga');
  const stripeIdx = Math.min(directEntryIdx, legacyEntryIdx);
  const formIdx = src.indexOf('await request.formData()');

  const pauseIdx = src.indexOf('if (isCheckoutPaused())');
  assert.ok(pauseIdx > -1, 'pause kill switch still exists');
  assert.ok(pauseIdx < formIdx, 'pause must refuse before form parsing');
  assert.ok(pauseIdx < stripeIdx, 'pause must refuse before Stripe');

  // Gates that apply to every submission must precede BOTH entry points —
  // strictly stronger than the old single-inline-create boundary.
  for (const gate of [
    'voice_consent_required',
    'primary_hero_beta_required',
    'custom_story_paid_beta_required',
    'custom_story_manual_review_required',
  ]) {
    const idx = src.indexOf(gate);
    assert.ok(idx > -1, `safety gate ${gate} must still exist`);
    assert.ok(idx < stripeIdx, `safety gate ${gate} must refuse before either provider path`);
  }
  // Legacy-path media gates run after the direct branch has already returned,
  // so their boundary is the legacy provisioning entry.
  for (const gate of [
    'supporting_character_details_required',
    'supporting_photo_persist_failed',
    'voice_persist_failed',
  ]) {
    const idx = src.indexOf(gate);
    assert.ok(idx > -1, `safety gate ${gate} must still exist`);
    assert.ok(idx < legacyEntryIdx, `safety gate ${gate} must refuse before Stripe`);
  }
  // And nothing may construct a provider Session inside the handler itself.
  const handler = src.slice(0, src.indexOf('async function retrieveDirectCheckoutSession'));
  assert.doesNotMatch(handler, /checkout\.sessions\.create/);

  // Duplicate/idempotency protection is untouched by capacity policy. It no
  // longer lives in the route as a flat "already reached payment" 409 — that
  // string asserted a payment the status did not prove, and tombstoned every
  // attempt whose Session had merely expired. The protection is now the shared
  // provisioner's: a complete Session is never replaced and never denied.
  const provisioner = readFileSync('src/lib/checkout-session-provisioning.ts', 'utf8');
  assert.match(provisioner, /checkout_session_complete/, 'duplicate-payment protection must remain');
  assert.match(provisioner, /CHECKOUT_PAYMENT_MAY_BE_COMPLETE/);
  assert.match(src, /checkoutFingerprint/, 'idempotency fingerprint must remain');
});

// ── 3. One canonical processing expectation, used everywhere ─────────────────

test('canonical processing expectation states review, volume honesty, and a support path', () => {
  // Describes the automated pipeline, NOT a human gate — fulfillment releases
  // proofs with no QA prerequisite, so a manual-review claim would be false.
  assert.match(PROOF_REVIEW_ASSURANCE, /write the story, illustrate every page, and build your proof/i);
  assert.match(PROOF_VOLUME_NOTE, /volume is high/i);
  assert.match(PROOF_VOLUME_NOTE, /longer than usual/i);
  assert.match(PROOF_DELAY_SUPPORT_NOTE, /support@herostorybooks\.com/);
});

test('the honest-wait copy introduces no second numeric SLA and no queue position', () => {
  for (const copy of [PROOF_REVIEW_ASSURANCE, PROOF_VOLUME_NOTE, PROOF_DELAY_SUPPORT_NOTE]) {
    assert.ok(!/\d/.test(copy), `no bare number is authorized in wait copy: ${copy}`);
    assert.ok(!/\bposition\b|\bnumber \d+ in\b|\bahead of you\b/i.test(copy), `no queue position: ${copy}`);
  }
  // The only authorized customer-facing number stays the approved window.
  assert.equal(PROOF_TURNAROUND_WINDOW, '2–3 business days');
});

test('checkout, homepage/FAQ, thank-you, status, and email all render the canonical copy', () => {
  for (const [label, path] of [
    ['checkout', 'src/app/checkout/checkout-form.tsx'],
    ['homepage/FAQ', 'src/components/editorial-site.tsx'],
    ['thank-you', 'src/app/thank-you/page.tsx'],
    ['order email', 'src/lib/order-email.ts'],
    ['status view', 'src/lib/order-status-view.ts'],
  ] as Array<[string, string]>) {
    const src = read(path);
    assert.match(src, /proof-turnaround/, `${label} must import the canonical module`);
    assert.match(src, /PROOF_VOLUME_NOTE/, `${label} must surface the volume note`);
  }
  // The status page renders whatever the view computed, rather than its own copy.
  assert.match(read('src/app/status/[orderId]/page.tsx'), /view\.processingNote/);
});

test('confirmation email states the personal review, the volume caveat, and how the customer is notified', () => {
  for (const bookFormat of FORMATS) {
    const order = createOrderRecord(
      { childName: 'Nia', bookFormat, email: 'nia@example.com' },
      { id: `ord_expect_${bookFormat}` },
    );
    const email = buildOrderConfirmationEmail(order, { supportEmail: 'support@herostorybooks.com' });
    for (const channel of [email.html, email.text] as const) {
      assert.ok(channel.includes(PROOF_VOLUME_NOTE), `${bookFormat}: volume note missing`);
      assert.ok(channel.includes(PROOF_REVIEW_ASSURANCE), `${bookFormat}: review assurance missing`);
      assert.ok(channel.includes(PROOF_DELAY_SUPPORT_NOTE), `${bookFormat}: delay support path missing`);
      assert.match(channel, /2–3 business days|preview will arrive first/, `${bookFormat}: no next-step timing`);
      assert.match(channel, /support@herostorybooks\.com/, `${bookFormat}: no support path`);
    }
    // No private order data leaks into the generic wait copy.
    assert.ok(!PROOF_DELAY_SUPPORT_NOTE.includes(order.id));
  }
});

test('status view shows the wait note only while a paid order is still being prepared', () => {
  const base = createOrderRecord(
    { childName: 'Rio', bookFormat: 'classic', email: 'rio@example.com' },
    { id: 'ord_status_note' },
  );

  const inProgress = buildOrderStatusView({
    ...base,
    paymentStatus: 'paid',
    fulfillmentStatus: 'generating_images',
  } as OrderRecord);
  assert.equal(inProgress.tone, 'neutral');
  assert.ok(inProgress.processingNote?.includes(PROOF_VOLUME_NOTE), 'in-progress order must carry the wait note');
  assert.ok(inProgress.processingNote?.includes(PROOF_DELAY_SUPPORT_NOTE), 'in-progress order must carry the support path');

  // Proof is with the customer: it is their turn, so no wait note.
  const awaitingApproval = buildOrderStatusView({
    ...base,
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.invalid/proof.pdf',
  } as OrderRecord);
  assert.equal(awaitingApproval.needsAction, true);
  assert.equal(awaitingApproval.processingNote, undefined);

  // Failed orders keep their own manual-review path, not a queue excuse.
  const failed = buildOrderStatusView({
    ...base,
    paymentStatus: 'paid',
    fulfillmentStatus: 'failed_manual_review',
  } as OrderRecord);
  assert.equal(failed.isFailed, true);
  assert.equal(failed.processingNote, undefined);
});

// ── 4. No surface promises instant / guaranteed proofs ───────────────────────

/**
 * Proof PREPARATION must never be sold as instant/same-day/guaranteed. Digital
 * DELIVERY after the customer approves is a different, already-approved claim
 * ("once you approve the proof, the PDF arrives the same day"), so these
 * patterns deliberately target readiness language, not post-approval delivery.
 */
const INSTANT_PROOF_CLAIMS: Array<[string, RegExp]> = [
  ['instant proof', /\b(instant|same[- ]day|immediate|overnight)\s+(digital\s+)?(proof|preview)\b/i],
  ['proof ready instantly', /\b(proof|preview)\b[^.]{0,40}\b(ready|prepared|back to you)\b[^.]{0,40}\b(instantly|immediately|same[- ]day|within minutes|in minutes)\b/i],
  // Nouns stay lowercase (customer prose). Capitalised "Preview" is the Vercel
  // deployment environment in engineering comments, not a customer promise.
  ['guaranteed proof', /\b[Gg]uarantee[a-z]*\b[^.]{0,20}\b(proof|preview|turnaround)\b/],
];
const GUARANTEED_DATE_CLAIM = /\bguarantee[a-z]*\s+(a\s+)?(specific\s+)?(delivery|arrival|shipping)\s+date/i;
const AUTOMATIC_PRINT_CLAIM = /\b(automatically|instantly)\s+(print|prints|printed|sends? to (the )?print)/i;

test('no customer surface promises an instant/same-day/guaranteed proof or automatic printing', () => {
  for (const [label, path] of CUSTOMER_SURFACES) {
    const src = read(path);
    for (const [claim, pattern] of INSTANT_PROOF_CLAIMS) {
      const hit = src.match(pattern);
      assert.equal(hit?.[0] ?? null, null, `${label} (${path}) makes a "${claim}" promise`);
    }
    const dated = src.match(GUARANTEED_DATE_CLAIM);
    assert.equal(dated?.[0] ?? null, null, `${label} (${path}) guarantees a delivery date`);
    const auto = src.match(AUTOMATIC_PRINT_CLAIM);
    assert.equal(auto?.[0] ?? null, null, `${label} (${path}) promises automatic printing`);
  }
});

test('proof readiness stays distinct from printing and shipping in the persisted expectation', () => {
  for (const format of FORMATS) {
    const expectation = buildDeliveryExpectation(format);
    assert.match(expectation, /proof/i, `${format}: must name the proof step`);
    if (format === 'digital') {
      // The PDF ships WITH the proof email, not after approval — asserting the
      // opposite is what let the old approval-first claim survive this suite.
      assert.match(expectation, /comes with it/i, `${format}: PDF must arrive with the proof`);
      assert.doesNotMatch(expectation, /after approval/i, `${format}: PDF must not be gated on approval`);
      assert.ok(!/ships/i.test(expectation), 'digital must not claim a shipping step');
    } else {
      assert.match(expectation, /After approval,[^.]*ships/i, `${format}: shipping must be gated on approval`);
    }
  }
});

test('proof-first ordering is preserved: nothing prints before customer approval', () => {
  assert.match(read('src/app/checkout/checkout-form.tsx'), /Nothing prints until/i);
  assert.match(read('src/app/thank-you/page.tsx'), /only after proof approval/i);
});
