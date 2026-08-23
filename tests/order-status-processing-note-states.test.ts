/**
 * State-awareness of the order-status processing note.
 *
 * The wait note ("when order volume is high, proofs can take longer…") is only
 * honest while we still owe the customer a proof. Two defects were confirmed in
 * candidate c66ed44 and are locked out here:
 *
 *  1. `delivery_email_failed` showed the note even though the book was already
 *     built and only the notification failed — blaming volume misstated the
 *     cause, and "we email you as soon as yours is ready" named the exact
 *     mechanism that had just broken.
 *  2. Digital `generating_images` / `building_pdf` paired the note with subheads
 *     promising "a few minutes" / "within a minute", putting two contradictory
 *     time scales in one block.
 *
 * Everything is asserted at the real `buildOrderStatusView` boundary, for both a
 * digital and a print format, rather than by reading source text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';
import { buildOrderStatusView } from '../src/lib/order-status-view.ts';
import { PROOF_DELAY_SUPPORT_NOTE, PROOF_VOLUME_NOTE } from '../src/lib/proof-turnaround.ts';

const FORMATS = ['digital', 'classic'] as const;
const NOW = '2026-08-20T15:00:00.000Z';

function view(bookFormat: string, patch: Partial<OrderRecord>) {
  const base = createOrderRecord(
    { childName: 'Rio', bookFormat, email: 'rio@example.com' },
    { id: 'ord_note_state', now: NOW },
  );
  return buildOrderStatusView({ ...base, ...patch } as OrderRecord);
}

/** Short numeric timings that would contradict a multi-day queue caveat. */
const SHORT_TIMING =
  /\b(a few|within a|in a|just a)\s+(second|seconds|minute|minutes|hour|hours)\b|\bminutes\b|\bwithin \d+/i;

// ── 1. delivery_email_failed never gets the note ─────────────────────────────

test('delivery_email_failed carries no processing note for digital or print', () => {
  for (const bookFormat of FORMATS) {
    const v = view(bookFormat, {
      paymentStatus: 'paid',
      fulfillmentStatus: 'delivery_email_failed',
      storyArtifactUrl: 'https://example.invalid/artifact.pdf',
    });
    assert.equal(
      v.processingNote,
      undefined,
      `${bookFormat}: the book is already built — a queue-delay note misstates the cause`,
    );
    // The state's own handling is untouched: it still routes somewhere real and
    // still offers the support path.
    assert.ok(v.headline.length > 0, `${bookFormat}: headline preserved`);
    assert.ok(v.subhead.length > 0, `${bookFormat}: subhead preserved`);
    assert.match(v.supportBlurb, /support@herostorybooks\.com/, `${bookFormat}: support path preserved`);
    assert.equal(v.isFailed, false, `${bookFormat}: delivery failure is not a manual-review failure`);
  }
});

// ── 2. No contradictory time scales in one block ─────────────────────────────

test('digital generation states no longer promise minutes', () => {
  for (const fulfillmentStatus of ['generating_images', 'building_pdf'] as const) {
    const v = view('digital', { paymentStatus: 'paid', fulfillmentStatus });
    assert.doesNotMatch(
      v.subhead,
      SHORT_TIMING,
      `digital/${fulfillmentStatus}: subhead must not promise a minutes-scale wait`,
    );
    assert.ok(v.subhead.length > 0, `digital/${fulfillmentStatus}: subhead still explains the step`);
  }
});

test('no state ever pairs the wait note with a short-timing subhead', () => {
  const states = [
    'not_started', 'generating_story', 'generating_images', 'building_pdf',
    'proof_ready', 'proof_approved', 'submitting_to_print', 'complete',
    'delivery_email_failed', 'failed_manual_review',
  ];
  for (const bookFormat of FORMATS) {
    for (const fulfillmentStatus of states) {
      const v = view(bookFormat, { paymentStatus: 'paid', fulfillmentStatus } as unknown as Partial<OrderRecord>);
      if (!v.processingNote) continue;
      assert.doesNotMatch(
        v.subhead,
        SHORT_TIMING,
        `${bookFormat}/${fulfillmentStatus}: wait note and "${v.subhead}" state two different time scales`,
      );
    }
  }
});

// ── 3. Genuinely in-progress states still carry the note ─────────────────────

test('paid orders still awaiting a proof do carry the volume note and support path', () => {
  for (const bookFormat of FORMATS) {
    for (const fulfillmentStatus of ['not_started', 'generating_story', 'generating_images', 'building_pdf'] as const) {
      const v = view(bookFormat, { paymentStatus: 'paid', fulfillmentStatus });
      assert.ok(
        v.processingNote?.includes(PROOF_VOLUME_NOTE),
        `${bookFormat}/${fulfillmentStatus}: must disclose that volume can lengthen the wait`,
      );
      assert.ok(
        v.processingNote?.includes(PROOF_DELAY_SUPPORT_NOTE),
        `${bookFormat}/${fulfillmentStatus}: must offer the support path`,
      );
    }
  }
});

test('an unset fulfillment status is treated as not_started, not as unknown', () => {
  for (const bookFormat of FORMATS) {
    const v = view(bookFormat, { paymentStatus: 'paid', fulfillmentStatus: undefined });
    assert.ok(v.processingNote?.includes(PROOF_VOLUME_NOTE), `${bookFormat}: legacy orders still get the note`);
  }
});

// ── 4. Every other state is excluded ─────────────────────────────────────────

test('states where the proof already exists, or the order is not in production, carry no note', () => {
  const excluded: Array<[string, Partial<OrderRecord>]> = [
    ['unpaid', { paymentStatus: 'pending', fulfillmentStatus: 'not_started' }],
    ['payment failed', { paymentStatus: 'failed', fulfillmentStatus: 'not_started' }],
    ['refunded', { paymentStatus: 'refunded', fulfillmentStatus: 'not_started' }],
    ['proof ready', { paymentStatus: 'paid', fulfillmentStatus: 'proof_ready', storyArtifactUrl: 'https://example.invalid/p.pdf' }],
    ['proof ready without artifact', { paymentStatus: 'paid', fulfillmentStatus: 'proof_ready' }],
    ['proof approved', { paymentStatus: 'paid', fulfillmentStatus: 'proof_approved' }],
    ['submitting to print', { paymentStatus: 'paid', fulfillmentStatus: 'submitting_to_print' }],
    ['delivery email failed', { paymentStatus: 'paid', fulfillmentStatus: 'delivery_email_failed' }],
    ['complete', { paymentStatus: 'paid', fulfillmentStatus: 'complete', storyArtifactUrl: 'https://example.invalid/f.pdf' }],
    ['complete without artifact', { paymentStatus: 'paid', fulfillmentStatus: 'complete' }],
    ['in production', { paymentStatus: 'paid', fulfillmentStatus: 'complete', status: 'print_in_production' }],
    ['shipped', { paymentStatus: 'paid', fulfillmentStatus: 'complete', status: 'shipped' }],
    ['failed manual review', { paymentStatus: 'paid', fulfillmentStatus: 'failed_manual_review' }],
    // Deliberately outside FulfillmentStatus: a legacy or corrupted record must
    // not earn a queue claim we cannot substantiate. Cast through unknown
    // because the value is invalid by construction.
    ['unrecognized status', { paymentStatus: 'paid', fulfillmentStatus: 'not_a_real_status' } as unknown as Partial<OrderRecord>],
  ];
  for (const bookFormat of FORMATS) {
    for (const [label, patch] of excluded) {
      const v = view(bookFormat, patch);
      assert.equal(v.processingNote, undefined, `${bookFormat}/${label}: must not carry a queue-delay note`);
    }
  }
});

test('a customer holding their proof is never told that proofs are running long', () => {
  // The single most misleading pairing: the proof is in their inbox and the page
  // simultaneously blames a busy queue.
  for (const bookFormat of FORMATS) {
    for (const fulfillmentStatus of ['proof_ready', 'proof_approved', 'complete'] as const) {
      const v = view(bookFormat, {
        paymentStatus: 'paid',
        fulfillmentStatus,
        storyArtifactUrl: 'https://example.invalid/artifact.pdf',
      });
      assert.ok(
        !(v.processingNote ?? '').includes(PROOF_VOLUME_NOTE),
        `${bookFormat}/${fulfillmentStatus}: proof exists, so volume language is false`,
      );
    }
  }
});

test('excluding the note never removes the support path from the page', () => {
  for (const bookFormat of FORMATS) {
    for (const fulfillmentStatus of ['delivery_email_failed', 'failed_manual_review', 'complete'] as const) {
      const v = view(bookFormat, { paymentStatus: 'paid', fulfillmentStatus });
      assert.match(
        v.supportBlurb,
        /support@herostorybooks\.com/,
        `${bookFormat}/${fulfillmentStatus}: the customer must still be able to reach us`,
      );
    }
  }
});
