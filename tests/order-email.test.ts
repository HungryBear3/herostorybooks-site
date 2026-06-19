import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOrderConfirmationEmail,
  buildPreviewReadyEmail,
  buildPrintInProductionEmail,
  buildProofReadyEmail,
  buildShippedEmail,
  getSupportEmail,
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

// ── Support alias defaults ─────────────────────────────────────────────────────

test('getSupportEmail defaults to support@herostorybooks.com for MVP', () => {
  const originalSupport = process.env.HSB_SUPPORT_EMAIL;
  const originalFrom = process.env.EMAIL_FROM;
  delete process.env.HSB_SUPPORT_EMAIL;
  delete process.env.EMAIL_FROM;

  try {
    assert.equal(getSupportEmail(), 'support@herostorybooks.com');
  } finally {
    if (originalSupport === undefined) delete process.env.HSB_SUPPORT_EMAIL;
    else process.env.HSB_SUPPORT_EMAIL = originalSupport;
    if (originalFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = originalFrom;
  }
});

const SUPPORT = 'support@herostorybooks.com';

// ── Existing confirmation email ───────────────────────────────────────────────

test('buildOrderConfirmationEmail includes the promised order details and support info', () => {
  const order = makePremiumOrder();
  const email = buildOrderConfirmationEmail(order, { supportEmail: SUPPORT });

  assert.match(email.subject, /Ava/i);
  assert.match(email.html, /Ava/);
  assert.match(email.html, /Premium/);
  assert.match(email.html, /support@herostorybooks.com/);
  assert.match(email.html, /digital preview.*before it prints/i);
  assert.match(email.text, /Premium/);
  assert.match(email.text, /Hardcover ships in 5–7 business days/i);
  assert.match(email.text, /support@herostorybooks.com/);
});

test('buildOrderConfirmationEmail includes clickable status CTA in html', () => {
  const originalUrl = process.env.NEXT_PUBLIC_URL;
  process.env.NEXT_PUBLIC_URL = 'https://preview.herostorybooks.test/';

  try {
    const order = makePremiumOrder();
    const email = buildOrderConfirmationEmail(order, { supportEmail: SUPPORT });

    assert.match(email.html, /Track your order/i);
    assert.match(email.html, /href="https:\/\/preview\.herostorybooks\.test\/status\/ord_test_email"/);
    assert.match(email.text, /Track your order: https:\/\/preview\.herostorybooks\.test\/status\/ord_test_email/);
  } finally {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_URL;
    else process.env.NEXT_PUBLIC_URL = originalUrl;
  }
});

// ── buildPreviewReadyEmail ────────────────────────────────────────────────────

test('buildPreviewReadyEmail for print includes child name and approval framing', () => {
  const order = { ...makePremiumOrder(), status: 'preview_ready' as const };
  const email = buildPreviewReadyEmail(order, { supportEmail: SUPPORT });

  assert.match(email.subject, /Ava/i);
  assert.match(email.html, /Ava/);
  assert.match(email.html, /preview/i);
  assert.match(email.html, /support@herostorybooks.com/);
  assert.match(email.text, /preview/i);
  assert.match(email.text, /support@herostorybooks.com/);
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
  assert.match(email.html, /support@herostorybooks.com/);
  assert.match(email.text, /support@herostorybooks.com/);
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
  assert.match(email.html, /support@herostorybooks.com/);
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

// ── buildProofReadyEmail — must point primary CTA at /review, not legacy approve-proof ──

test('buildProofReadyEmail: primary CTA is the /review/<orderId> surface', () => {
  const order = makeClassicOrder();
  const email = buildProofReadyEmail(order, {
    reviewUrl: `https://hsb.example.com/review/${order.id}?token=abc`,
    proofUrl: 'https://cdn.example.com/proof.pdf',
    supportEmail: SUPPORT,
  });

  // The review URL is the primary CTA, surfaced as the prominent button.
  assert.match(email.html, new RegExp(`href="https://hsb\\.example\\.com/review/${order.id}\\?token=abc"`));
  assert.match(email.text, new RegExp(`https://hsb\\.example\\.com/review/${order.id}\\?token=abc`));
  // Proof PDF stays as a fallback link.
  assert.match(email.html, /href="https:\/\/cdn\.example\.com\/proof\.pdf"/);
  assert.match(email.text, /https:\/\/cdn\.example\.com\/proof\.pdf/);
});

test('buildProofReadyEmail: does NOT link the legacy /api/order/.../approve-proof one-click endpoint', () => {
  const order = makeClassicOrder();
  const email = buildProofReadyEmail(order, {
    reviewUrl: `https://hsb.example.com/review/${order.id}?token=abc`,
    proofUrl: 'https://cdn.example.com/proof.pdf',
    supportEmail: SUPPORT,
  });
  // Bypass URL must not be reintroduced — it would skip ack + per-page gates.
  assert.doesNotMatch(email.html, /\/api\/order\/[^"]*\/approve-proof/);
  assert.doesNotMatch(email.text, /\/api\/order\/[^\s]*\/approve-proof/);
});

test('buildProofReadyEmail: copy describes the per-page review + acknowledgment + approval flow', () => {
  const order = makeClassicOrder();
  const email = buildProofReadyEmail(order, {
    reviewUrl: `https://hsb.example.com/review/${order.id}?token=abc`,
    proofUrl: 'https://cdn.example.com/proof.pdf',
    supportEmail: SUPPORT,
  });
  // Review-flow framing — illustrated pages + approve from the review surface.
  assert.match(email.html, /illustrated page/i);
  assert.match(email.html, /approve/i);
  // Honest about the proof-only fallback.
  assert.match(email.html, /proof PDF/i);
});

test('buildProofReadyEmail: subject + child name are present', () => {
  const order = makeClassicOrder();
  const email = buildProofReadyEmail(order, {
    reviewUrl: `https://x/review/${order.id}?token=t`,
    proofUrl: 'https://x/proof.pdf',
    supportEmail: SUPPORT,
  });
  assert.match(email.subject, /Leo/i);
  assert.match(email.subject, /proof.*ready/i);
  assert.match(email.html, /Leo/);
});

test('buildPreviewReadyEmail (print): does NOT instruct customer to "reply to view the preview"', () => {
  // Old copy directed customers to reply to the email instead of using the
  // dedicated review surface. That contradicts the modern flow.
  const order = { ...makeClassicOrder(), status: 'preview_ready' as const };
  const email = buildPreviewReadyEmail(order, { supportEmail: SUPPORT });
  assert.doesNotMatch(email.html, /reply to this email to view/i);
  assert.doesNotMatch(email.text, /reply to this email to view/i);
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
