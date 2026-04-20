import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOrderConfirmationEmail,
  buildPreviewReadyEmail,
  buildPrintInProductionEmail,
  buildShippedEmail,
  sendLifecycleEmail,
} from '../src/lib/order-email.ts';
import { createOrderRecord } from '../src/lib/orders.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePremiumOrder() {
  return createOrderRecord(
    {
      childName: 'Ava',
      childAge: '6',
      theme: 'royal-adventure',
      lesson: 'kindness',
      occasion: 'mothers-day',
      giftMessage: 'You are magic',
      bookFormat: 'premium',
      email: 'ava.parent@example.com',
      photoFileName: 'ava.jpg',
    },
    { now: '2026-04-20T16:30:00.000Z', id: 'ord_test_email' },
  );
}

function makeClassicOrder() {
  return createOrderRecord(
    { childName: 'Leo', bookFormat: 'classic', email: 'leo@example.com' },
    { id: 'ord_test_classic' },
  );
}

function makeDigitalOrder() {
  return createOrderRecord(
    { childName: 'Mia', bookFormat: 'digital', email: 'mia@example.com' },
    { id: 'ord_test_digital' },
  );
}

const SUPPORT = 'hello@herostorybooks.com';

// ── Existing confirmation email ───────────────────────────────────────────────

test('buildOrderConfirmationEmail includes the promised order details and support info', () => {
  const order = makePremiumOrder();
  const email = buildOrderConfirmationEmail(order, { supportEmail: SUPPORT });

  assert.match(email.subject, /Ava/i);
  assert.match(email.html, /Ava/);
  assert.match(email.html, /Premium/);
  assert.match(email.html, /hello@herostorybooks.com/);
  assert.match(email.html, /digital preview.*before it prints/i);
  assert.match(email.text, /Premium/);
  assert.match(email.text, /Hardcover ships in 5–7 business days/i);
  assert.match(email.text, /hello@herostorybooks.com/);
});

// ── buildPreviewReadyEmail ────────────────────────────────────────────────────

test('buildPreviewReadyEmail for print includes child name and approval framing', () => {
  const order = { ...makePremiumOrder(), status: 'preview_ready' as const };
  const email = buildPreviewReadyEmail(order, { supportEmail: SUPPORT });

  assert.match(email.subject, /Ava/i);
  assert.match(email.html, /Ava/);
  assert.match(email.html, /preview/i);
  assert.match(email.html, /hello@herostorybooks.com/);
  assert.match(email.text, /preview/i);
  assert.match(email.text, /hello@herostorybooks.com/);
});

test('buildPreviewReadyEmail for print mentions approval before printing', () => {
  const order = { ...makeClassicOrder(), status: 'preview_ready' as const };
  const email = buildPreviewReadyEmail(order, { supportEmail: SUPPORT });

  // Should not say it has already shipped or is in production
  assert.doesNotMatch(email.html, /has shipped/i);
  assert.doesNotMatch(email.html, /in production/i);
  // Should mention the approval / print flow
  assert.match(email.html, /print/i);
});

test('buildPreviewReadyEmail for digital has different messaging from print', () => {
  const digitalOrder = { ...makeDigitalOrder(), status: 'preview_ready' as const };
  const printOrder = { ...makeClassicOrder(), status: 'preview_ready' as const };

  const digitalEmail = buildPreviewReadyEmail(digitalOrder, { supportEmail: SUPPORT });
  const printEmail = buildPreviewReadyEmail(printOrder, { supportEmail: SUPPORT });

  // Digital should mention PDF / sending
  assert.match(digitalEmail.html, /PDF|on its way|sending/i);
  // Print should mention preview / review / approval
  assert.match(printEmail.html, /preview/i);
  // Subjects should differ
  assert.notEqual(digitalEmail.subject, printEmail.subject);
});

test('buildPreviewReadyEmail includes child name in all variants', () => {
  const digitalEmail = buildPreviewReadyEmail(
    { ...makeDigitalOrder(), status: 'preview_ready' as const },
    { supportEmail: SUPPORT },
  );
  const printEmail = buildPreviewReadyEmail(
    { ...makeClassicOrder(), status: 'preview_ready' as const },
    { supportEmail: SUPPORT },
  );

  assert.match(digitalEmail.subject, /Mia/i);
  assert.match(printEmail.subject, /Leo/i);
});

// ── buildPrintInProductionEmail ───────────────────────────────────────────────

test('buildPrintInProductionEmail includes child name and format', () => {
  const order = { ...makePremiumOrder(), status: 'print_in_production' as const };
  const email = buildPrintInProductionEmail(order, { supportEmail: SUPPORT });

  assert.match(email.subject, /Ava/i);
  assert.match(email.html, /Premium/i);
  assert.match(email.html, /Ava/);
  assert.match(email.html, /hello@herostorybooks.com/);
  assert.match(email.text, /hello@herostorybooks.com/);
});

test('buildPrintInProductionEmail does not claim the book has shipped', () => {
  const order = { ...makeClassicOrder(), status: 'print_in_production' as const };
  const email = buildPrintInProductionEmail(order, { supportEmail: SUPPORT });

  assert.doesNotMatch(email.html, /has shipped/i);
  assert.doesNotMatch(email.text, /has shipped/i);
});

test('buildPrintInProductionEmail mentions expected shipping timeframe', () => {
  const order = { ...makeClassicOrder(), status: 'print_in_production' as const };
  const email = buildPrintInProductionEmail(order, { supportEmail: SUPPORT });

  assert.match(email.html, /5.7 business days/i);
  assert.match(email.text, /5.7 business days/i);
});

// ── buildShippedEmail ─────────────────────────────────────────────────────────

test('buildShippedEmail includes child name and format', () => {
  const order = { ...makeClassicOrder(), status: 'shipped' as const };
  const email = buildShippedEmail(order, { supportEmail: SUPPORT });

  assert.match(email.subject, /Leo/i);
  assert.match(email.html, /Leo/);
  assert.match(email.html, /Classic/i);
  assert.match(email.html, /hello@herostorybooks.com/);
});

test('buildShippedEmail without tracking number gives honest placeholder', () => {
  const order = { ...makeClassicOrder(), status: 'shipped' as const };
  const email = buildShippedEmail(order, { supportEmail: SUPPORT });

  // Should not invent a fake tracking number
  assert.doesNotMatch(email.html, /1Z[A-Z0-9]{16}/); // UPS format
  // Should acknowledge tracking is coming
  assert.match(email.html, /carrier|tracking/i);
});

test('buildShippedEmail with tracking number includes it in email', () => {
  const order = { ...makeClassicOrder(), status: 'shipped' as const };
  const email = buildShippedEmail(order, {
    supportEmail: SUPPORT,
    trackingNumber: '1Z999AA10123456784',
  });

  assert.match(email.html, /1Z999AA10123456784/);
  assert.match(email.text, /1Z999AA10123456784/);
});

test('buildShippedEmail with tracking URL renders a link', () => {
  const order = { ...makeClassicOrder(), status: 'shipped' as const };
  const email = buildShippedEmail(order, {
    supportEmail: SUPPORT,
    trackingNumber: 'ABC123',
    trackingUrl: 'https://track.example.com/ABC123',
  });

  assert.match(email.html, /href="https:\/\/track\.example\.com\/ABC123"/);
  assert.match(email.text, /https:\/\/track\.example\.com\/ABC123/);
});

test('buildShippedEmail includes 7-day guarantee language', () => {
  const order = { ...makeClassicOrder(), status: 'shipped' as const };
  const email = buildShippedEmail(order, { supportEmail: SUPPORT });

  assert.match(email.html, /7.day/i);
});

// ── Digital orders: print-only statuses skipped ───────────────────────────────

test('sendLifecycleEmail skips print_in_production for digital orders', async () => {
  const order = { ...makeDigitalOrder(), status: 'print_in_production' as const };
  const result = await sendLifecycleEmail(order);

  assert.equal(result.skipped, true);
  assert.equal((result as { skipped: true; reason: string }).reason, 'not_print_format');
});

test('sendLifecycleEmail skips shipped for digital orders', async () => {
  const order = { ...makeDigitalOrder(), status: 'shipped' as const };
  const result = await sendLifecycleEmail(order);

  assert.equal(result.skipped, true);
  assert.equal((result as { skipped: true; reason: string }).reason, 'not_print_format');
});

test('sendLifecycleEmail skips order_received (handled at order creation)', async () => {
  const order = makeDigitalOrder(); // status: order_received
  const result = await sendLifecycleEmail(order);

  assert.equal(result.skipped, true);
  assert.equal(
    (result as { skipped: true; reason: string }).reason,
    'no_lifecycle_email_for_status',
  );
});

// ── Missing config fails safely ───────────────────────────────────────────────

test('sendLifecycleEmail skips gracefully when Resend API key is missing', async () => {
  const original = process.env.HSB_RESEND_API_KEY;
  const originalFallback = process.env.RESEND_API_KEY;

  delete process.env.HSB_RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;

  try {
    const order = { ...makeClassicOrder(), status: 'preview_ready' as const };
    const result = await sendLifecycleEmail(order);

    assert.equal(result.skipped, true);
    assert.equal(
      (result as { skipped: true; reason: string }).reason,
      'missing_resend_api_key',
    );
  } finally {
    if (original !== undefined) process.env.HSB_RESEND_API_KEY = original;
    if (originalFallback !== undefined) process.env.RESEND_API_KEY = originalFallback;
  }
});
