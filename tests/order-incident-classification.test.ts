/**
 * RED-first specification for the shared, pure incident classifier
 * (`src/lib/order-incident.ts`).
 *
 * The classifier is the single source of truth consumed by the stranded
 * detector, `deriveOrderAttention` and `classifyPaidOrderOpsIssue`. It is pure
 * over `OrderRecord` + an injected clock: no storage, no fulfillment, no
 * order writes, no PII in anything it emits.
 *
 * Taxonomy under test (highest severity first):
 *   print_submission_ambiguous   — irreversible provider call, never retryable
 *   delivery_email_failed        — artifacts exist, notification did not land
 *   failed_manual_review         — real failure, EXCLUDING refund finalization
 *   stale_in_progress_no_lease   — generating/building with no live lease
 *   auto_not_started             — explicit `auto` intent that never started
 *   manual_hold_sla              — paid operator hold past its own SLA
 *   customer_review_wait_overdue — intentional customer wait past its own SLA
 *   data_quality_uncertain       — clock/mode/timestamp uncertainty
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { OrderRecord } from '../src/lib/orders.ts';
import {
  DEFAULT_INCIDENT_THRESHOLDS,
  INCIDENT_SEVERITY_RANK,
  classifyOrderIncident,
  hasActiveFulfillmentLease,
  isPrintSubmissionAmbiguous,
  type IncidentThresholds,
} from '../src/lib/order-incident.ts';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const T: IncidentThresholds = DEFAULT_INCIDENT_THRESHOLDS;

function makeOrder(partial: Partial<OrderRecord> & { id: string }): OrderRecord {
  return {
    id: partial.id,
    childName: 'Luna',
    email: 'parent@example.com',
    bookFormat: 'digital',
    formatLabel: 'Digital',
    priceCents: 950,
    status: 'order_received',
    paymentStatus: 'paid',
    deliveryExpectation: 'digital',
    createdAt: iso(NOW - 72 * HOUR),
    updatedAt: iso(NOW - 48 * HOUR),
    paidAt: iso(NOW - 48 * HOUR),
    ...partial,
  } as unknown as OrderRecord;
}

const classify = (order: OrderRecord, nowMs = NOW) => classifyOrderIncident(order, { nowMs });

// ── 1. manual hold: below / at / above the operator SLA ───────────────────────

test('manual_hold below the operator SLA is not an incident', () => {
  const o = makeOrder({
    id: 'ord_hold_below',
    fulfillmentMode: 'manual_hold',
    fulfillmentStatus: 'not_started',
    paidAt: iso(NOW - T.manualHoldMs + 1),
  });
  assert.equal(classify(o), null);
});

test('manual_hold exactly at the operator SLA is an incident (inclusive boundary)', () => {
  const o = makeOrder({
    id: 'ord_hold_at',
    fulfillmentMode: 'manual_hold',
    fulfillmentStatus: 'not_started',
    paidAt: iso(NOW - T.manualHoldMs),
  });
  const incident = classify(o);
  assert.equal(incident?.incidentClass, 'manual_hold_sla');
  assert.equal(incident?.ageMs, T.manualHoldMs);
  assert.equal(incident?.thresholdMs, T.manualHoldMs);
});

test('manual_hold above the operator SLA is an incident and never claims to be retryable', () => {
  const o = makeOrder({
    id: 'ord_hold_above',
    fulfillmentMode: 'manual_hold',
    fulfillmentStatus: 'not_started',
    paidAt: iso(NOW - T.manualHoldMs - 5 * HOUR),
  });
  const incident = classify(o);
  assert.equal(incident?.incidentClass, 'manual_hold_sla');
  assert.equal(incident?.severity, 'medium');
  // Detection never starts fulfillment: a hold is an operator decision.
  assert.equal(incident?.retryable, false);
});

// ── 2. auto not-started: below / at / above the threshold ─────────────────────

test('auto + not_started below the threshold is not an incident', () => {
  const o = makeOrder({
    id: 'ord_auto_below',
    fulfillmentMode: 'auto',
    fulfillmentStatus: 'not_started',
    paidAt: iso(NOW - T.autoNotStartedMs + 1),
  });
  assert.equal(classify(o), null);
});

test('auto + not_started exactly at the threshold is an incident', () => {
  const o = makeOrder({
    id: 'ord_auto_at',
    fulfillmentMode: 'auto',
    fulfillmentStatus: 'not_started',
    paidAt: iso(NOW - T.autoNotStartedMs),
  });
  const incident = classify(o);
  assert.equal(incident?.incidentClass, 'auto_not_started');
  assert.equal(incident?.severity, 'high');
});

test('auto + not_started above the threshold is an incident', () => {
  const o = makeOrder({
    id: 'ord_auto_above',
    fulfillmentMode: 'auto',
    fulfillmentStatus: 'not_started',
    paidAt: iso(NOW - T.autoNotStartedMs - 10 * HOUR),
  });
  assert.equal(classify(o)?.incidentClass, 'auto_not_started');
});

test('unset fulfillmentMode is honest data-quality uncertainty, not a silent pass', () => {
  const o = makeOrder({
    id: 'ord_mode_unset',
    fulfillmentStatus: 'not_started',
    paidAt: iso(NOW - T.manualHoldMs - HOUR),
  });
  const incident = classify(o);
  assert.equal(incident?.incidentClass, 'data_quality_uncertain');
  assert.equal(incident?.detailCode, 'fulfillment_mode_unset');
});

// ── 3. refund exclusions for failed_manual_review ─────────────────────────────

test('fully refunded failed_manual_review never alerts (refund finalization writes that state)', () => {
  const o = makeOrder({
    id: 'ord_refunded',
    paymentStatus: 'refunded',
    refundedAt: iso(NOW - 2 * HOUR),
    stripeRefundId: 're_test_123',
    fulfillmentStatus: 'failed_manual_review',
    fulfillmentLastError: 'stripe_charge_refunded: ch_test_123',
    updatedAt: iso(NOW - 2 * HOUR),
  });
  assert.equal(classify(o), null);
});

test('partially refunded failed_manual_review never alerts', () => {
  const o = makeOrder({
    id: 'ord_partial_refund',
    paymentStatus: 'partially_refunded',
    refundedAt: null,
    stripeRefundId: 're_test_partial',
    stripeRefundedAmountCents: 400,
    fulfillmentStatus: 'failed_manual_review',
    fulfillmentLastError: 'stripe_partial_refund: ch_test_partial',
    updatedAt: iso(NOW - 2 * HOUR),
  });
  assert.equal(classify(o), null);
});

test('an in-flight refund claim excludes failed_manual_review', () => {
  const o = makeOrder({
    id: 'ord_refund_claim',
    fulfillmentStatus: 'failed_manual_review',
    refundClaimId: 'rc_abc',
    updatedAt: iso(NOW - 2 * HOUR),
  });
  assert.equal(classify(o), null);
});

test('internal, disposed, shipped and complete orders are excluded', () => {
  const cases: Array<Partial<OrderRecord>> = [
    { internalDisposition: 'abandoned_internal_test' },
    { status: 'shipped', shippedAt: iso(NOW - HOUR) },
    { printJobStatus: 'delivered' },
    { fulfillmentStatus: 'complete' },
  ];
  for (const extra of cases) {
    const o = makeOrder({
      id: 'ord_terminal',
      fulfillmentStatus: 'failed_manual_review',
      updatedAt: iso(NOW - 5 * HOUR),
      ...extra,
    });
    assert.equal(classify(o), null, `expected exclusion for ${JSON.stringify(extra)}`);
  }
});

test('a genuine failed_manual_review with no refund evidence IS an incident', () => {
  const o = makeOrder({
    id: 'ord_real_failure',
    fulfillmentStatus: 'failed_manual_review',
    fulfillmentLastError: 'openai_rate_limited: too many requests',
    updatedAt: iso(NOW - 3 * HOUR),
  });
  const incident = classify(o);
  assert.equal(incident?.incidentClass, 'failed_manual_review');
  assert.equal(incident?.severity, 'high');
  assert.equal(incident?.retryable, true);
});

test('delivery_email_failed is its own incident class', () => {
  const o = makeOrder({
    id: 'ord_email_failed',
    fulfillmentStatus: 'delivery_email_failed',
    storyArtifactUrl: 'https://example.com/story.pdf',
    updatedAt: iso(NOW - 30 * MINUTE),
  });
  const incident = classify(o);
  assert.equal(incident?.incidentClass, 'delivery_email_failed');
  assert.equal(incident?.retryable, true);
});

// ── 4. active lease exclusion vs stale no-lease incident ──────────────────────

test('an active fulfillment lease suppresses a stale in-progress incident', () => {
  const o = makeOrder({
    id: 'ord_leased',
    fulfillmentStatus: 'generating_images',
    fulfillmentKickoffId: 'a1b2c3d4e5f60718',
    fulfillmentKickoffAt: iso(NOW - MINUTE),
    updatedAt: iso(NOW - 6 * HOUR),
  });
  assert.equal(hasActiveFulfillmentLease(o, NOW, T.leaseTtlMs), true);
  assert.equal(classify(o), null);
});

test('an expired lease past the stale threshold IS an incident', () => {
  const o = makeOrder({
    id: 'ord_lease_expired',
    fulfillmentStatus: 'building_pdf',
    fulfillmentKickoffId: 'a1b2c3d4e5f60718',
    fulfillmentKickoffAt: iso(NOW - T.staleInProgressMs - MINUTE),
    updatedAt: iso(NOW - T.staleInProgressMs - MINUTE),
  });
  assert.equal(hasActiveFulfillmentLease(o, NOW, T.leaseTtlMs), false);
  const incident = classify(o);
  assert.equal(incident?.incidentClass, 'stale_in_progress_no_lease');
  assert.equal(incident?.severity, 'high');
});

test('no lease at all but still inside the stale window is not yet an incident', () => {
  const o = makeOrder({
    id: 'ord_fresh_no_lease',
    fulfillmentStatus: 'generating_story',
    fulfillmentKickoffId: null,
    fulfillmentKickoffAt: null,
    updatedAt: iso(NOW - T.staleInProgressMs + MINUTE),
  });
  assert.equal(hasActiveFulfillmentLease(o, NOW, T.leaseTtlMs), false);
  assert.equal(classify(o), null);
});

test('a lease timestamp in the future never counts as active (clock fail-closed)', () => {
  const o = makeOrder({
    id: 'ord_future_lease',
    fulfillmentStatus: 'generating_images',
    fulfillmentKickoffId: 'a1b2c3d4e5f60718',
    fulfillmentKickoffAt: iso(NOW + HOUR),
    updatedAt: iso(NOW - 10 * HOUR),
  });
  assert.equal(hasActiveFulfillmentLease(o, NOW, T.leaseTtlMs), false);
  assert.equal(classify(o)?.incidentClass, 'data_quality_uncertain');
});

// ── 5. ambiguous print is highest severity even with an artifact ──────────────

test('ambiguous print with an existing story artifact is still the highest-severity incident', () => {
  const o = makeOrder({
    id: 'ord_ambiguous',
    bookFormat: 'classic',
    fulfillmentStatus: 'submitting_to_print',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    printInteriorArtifactUrl: 'https://example.com/interior.pdf',
    printSubmissionAttemptedAt: iso(NOW - 20 * MINUTE),
    fulfillmentLastError: 'print_submission_ambiguous: upstream timeout',
    updatedAt: iso(NOW - 20 * MINUTE),
  });
  assert.equal(isPrintSubmissionAmbiguous(o), true);
  const incident = classify(o);
  assert.equal(incident?.incidentClass, 'print_submission_ambiguous');
  assert.equal(incident?.severity, 'critical');
  assert.equal(incident?.retryable, false);
  // Highest rank in the taxonomy.
  for (const [cls, rank] of Object.entries(INCIDENT_SEVERITY_RANK)) {
    if (cls === 'print_submission_ambiguous') continue;
    assert.ok(
      INCIDENT_SEVERITY_RANK.print_submission_ambiguous > rank,
      `print_submission_ambiguous must outrank ${cls}`,
    );
  }
});

test('the durable pre-POST fence alone makes a print submission ambiguous', () => {
  const o = makeOrder({
    id: 'ord_fence_only',
    bookFormat: 'classic',
    fulfillmentStatus: 'submitting_to_print',
    printSubmissionAttemptedAt: iso(NOW - 90 * MINUTE),
    fulfillmentLastError: null,
    updatedAt: iso(NOW - 90 * MINUTE),
  });
  assert.equal(isPrintSubmissionAmbiguous(o), true);
  assert.equal(classify(o)?.incidentClass, 'print_submission_ambiguous');
});

test('a reconciled print job id clears the ambiguity', () => {
  const o = makeOrder({
    id: 'ord_reconciled',
    bookFormat: 'classic',
    fulfillmentStatus: 'submitting_to_print',
    printJobId: 'PJ-123',
    printSubmissionAttemptedAt: iso(NOW - 90 * MINUTE),
    fulfillmentLastError: 'print_submission_ambiguous: upstream timeout',
    updatedAt: iso(NOW - 90 * MINUTE),
  });
  assert.equal(isPrintSubmissionAmbiguous(o), false);
});

test('ambiguous print survives refund and internal-disposition exclusions', () => {
  // A refund does not un-submit a physical book. The provider must still be
  // reconciled, so this incident is deliberately outside the terminal filter.
  const o = makeOrder({
    id: 'ord_ambiguous_refunded',
    bookFormat: 'classic',
    paymentStatus: 'refunded',
    refundedAt: iso(NOW - HOUR),
    stripeRefundId: 're_test_x',
    fulfillmentStatus: 'submitting_to_print',
    printSubmissionAttemptedAt: iso(NOW - 3 * HOUR),
    fulfillmentLastError: 'print_submission_ambiguous: upstream timeout',
    updatedAt: iso(NOW - HOUR),
  });
  assert.equal(classify(o)?.incidentClass, 'print_submission_ambiguous');
});

// ── 6. customer review/proof waiting states ───────────────────────────────────

test('a proof waiting on the customer is not an incident before its own SLA', () => {
  const o = makeOrder({
    id: 'ord_customer_wait',
    bookFormat: 'classic',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    customerProofReleasedAt: iso(NOW - T.customerWaitMs + HOUR),
    updatedAt: iso(NOW - T.customerWaitMs + HOUR),
  });
  assert.equal(classify(o), null);
});

test('a proof waiting past its own SLA becomes a distinct low-urgency incident', () => {
  const o = makeOrder({
    id: 'ord_customer_overdue',
    bookFormat: 'classic',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    customerProofReleasedAt: iso(NOW - T.customerWaitMs - HOUR),
    updatedAt: iso(NOW - T.customerWaitMs - HOUR),
  });
  const incident = classify(o);
  assert.equal(incident?.incidentClass, 'customer_review_wait_overdue');
  assert.equal(incident?.severity, 'medium');
});

// ── 7. data-quality / clock uncertainty ──────────────────────────────────────

test('missing, malformed and future paidAt are all data-quality incidents', () => {
  const cases: Array<[Partial<OrderRecord>, string]> = [
    [{ paidAt: null }, 'paidat_missing'],
    [{ paidAt: 'not-a-date' }, 'paidat_invalid'],
    [{ paidAt: iso(NOW + HOUR) }, 'paidat_future'],
  ];
  for (const [extra, detailCode] of cases) {
    const o = makeOrder({ id: 'ord_dq', fulfillmentMode: 'auto', fulfillmentStatus: 'not_started', ...extra });
    const incident = classify(o);
    assert.equal(incident?.incidentClass, 'data_quality_uncertain', detailCode);
    assert.equal(incident?.detailCode, detailCode);
    assert.equal(incident?.retryable, false);
  }
});

// ── 8. incident identity / dedup fingerprint ─────────────────────────────────

test('dedup key is orderId + incidentClass + state fingerprint, never order id alone', () => {
  const o = makeOrder({
    id: 'ord_key',
    fulfillmentStatus: 'failed_manual_review',
    fulfillmentAttempts: 1,
    updatedAt: iso(NOW - 3 * HOUR),
  });
  const incident = classify(o);
  assert.ok(incident);
  assert.ok(incident.dedupKey.startsWith('ord_key::failed_manual_review::'));
  assert.notEqual(incident.dedupKey, 'ord_key');
  assert.ok(incident.fingerprint.length > 0);
  assert.ok(incident.dedupKey.endsWith(incident.fingerprint));
});

test('dedup key is stable across repeated classification of the same state', () => {
  const o = makeOrder({
    id: 'ord_stable',
    fulfillmentStatus: 'failed_manual_review',
    fulfillmentAttempts: 2,
    updatedAt: iso(NOW - 3 * HOUR),
  });
  assert.equal(classify(o, NOW)?.dedupKey, classify(o, NOW + 9 * HOUR)?.dedupKey);
});

test('a new attempt changes the dedup key', () => {
  const base = { id: 'ord_attempt', fulfillmentStatus: 'failed_manual_review', updatedAt: iso(NOW - 3 * HOUR) } as const;
  const first = classify(makeOrder({ ...base, fulfillmentAttempts: 1 }));
  const second = classify(makeOrder({ ...base, fulfillmentAttempts: 2 }));
  assert.notEqual(first?.dedupKey, second?.dedupKey);
});

test('a new state entry changes the dedup key', () => {
  const base = { id: 'ord_reentry', fulfillmentStatus: 'failed_manual_review', fulfillmentAttempts: 1 } as const;
  const first = classify(makeOrder({ ...base, updatedAt: iso(NOW - 3 * HOUR) }));
  const second = classify(makeOrder({ ...base, updatedAt: iso(NOW - 2 * HOUR) }));
  assert.notEqual(first?.dedupKey, second?.dedupKey);
});

test('a new print submission attempt changes the ambiguous-print dedup key', () => {
  const base = {
    id: 'ord_reattempt',
    bookFormat: 'classic',
    fulfillmentStatus: 'submitting_to_print',
    fulfillmentLastError: 'print_submission_ambiguous: upstream timeout',
  } as const;
  const first = classify(makeOrder({ ...base, printSubmissionAttemptedAt: iso(NOW - 3 * HOUR) }));
  const second = classify(makeOrder({ ...base, printSubmissionAttemptedAt: iso(NOW - HOUR) }));
  assert.notEqual(first?.dedupKey, second?.dedupKey);
});

// ── 9. the incident payload is PII-free by construction ──────────────────────

test('no classified incident carries PII or provider identifiers', () => {
  const orders = [
    makeOrder({
      id: 'ord_pii_1',
      childName: 'Persephone',
      email: 'secret.parent@example.com',
      fulfillmentStatus: 'failed_manual_review',
      fulfillmentLastError: 'stripe_charge_refunded: ch_LEAKY_ID',
      storyArtifactUrl: 'https://blob.example.com/private/story-Persephone.pdf',
      proofApprovalToken: 'tok_SUPER_SECRET',
      shippingAddress: { line1: '9 Leak Lane', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
      updatedAt: iso(NOW - 4 * HOUR),
    }),
    makeOrder({
      id: 'ord_pii_2',
      childName: 'Persephone',
      email: 'secret.parent@example.com',
      bookFormat: 'classic',
      fulfillmentStatus: 'submitting_to_print',
      printSubmissionAttemptedAt: iso(NOW - HOUR),
      fulfillmentLastError: 'print_submission_ambiguous: lulu 502 for ch_LEAKY_ID',
      storyArtifactUrl: 'https://blob.example.com/private/story-Persephone.pdf',
      proofApprovalToken: 'tok_SUPER_SECRET',
      updatedAt: iso(NOW - HOUR),
    }),
  ];
  const forbidden = [
    'Persephone', 'secret.parent@example.com', '@example.com', 'tok_SUPER_SECRET',
    'ch_LEAKY_ID', 're_test', '9 Leak Lane', '60601', 'blob.example.com', 'https://',
  ];
  for (const order of orders) {
    const incident = classify(order);
    assert.ok(incident, `expected an incident for ${order.id}`);
    const serialized = JSON.stringify(incident);
    for (const needle of forbidden) {
      assert.equal(serialized.includes(needle), false, `${order.id} payload leaked ${needle}`);
    }
    // Only the opaque order id and an admin path built from it are identifying.
    assert.equal(incident.orderId, order.id);
    assert.equal(incident.adminPath, `/admin/orders/${order.id}`);
  }
});

test('the classifier module is pure — no runtime imports at all', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../src/lib/order-incident.ts', import.meta.url)), 'utf8');
  const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
  for (const line of importLines) {
    assert.match(line, /^\s*import\s+type\b/, `non-type import in pure classifier: ${line.trim()}`);
  }
  // Reading a field named `stripeRefundId` is fine; importing the SDK is not.
  for (const token of ['node:crypto', 'node:fs', '@vercel/blob', "from 'stripe'", "from './fulfillment", "from './order-email"]) {
    assert.equal(src.includes(token), false, `pure classifier must not reference ${token}`);
  }
});
