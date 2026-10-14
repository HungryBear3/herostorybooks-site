/**
 * The customer-facing print-upgrade offer email. Drafted by the operator
 * action, sent only through an explicitly enabled, idempotent path. The copy
 * must be truthful about what the customer pays (provider cost only, quoted
 * live), what happens after payment (print files prepared for the chosen
 * format, no automatic printing), and what the link is (private, expiring).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';
import {
  PRINT_UPGRADE_OFFER_EMAIL_ENABLED_ENV,
  buildPrintUpgradeOfferEmail,
  sendPrintUpgradeOfferEmail,
} from '../src/lib/print-upgrade-email.ts';

const CHOOSER_URL = 'https://herostorybooks.com/upgrade/ord_email_test_0001#token=abc123';

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Lukas', bookFormat: 'digital', email: 'parent@example.com' },
      { id: 'ord_email_test_0001', now: '2026-09-01T12:00:00Z' },
    ),
    paymentStatus: 'paid',
    printTitle: 'Lukas, King of Dino Earth',
    ...overrides,
  };
}

test('offer email: truthful at-cost copy, private expiring link, no automatic-print claim', () => {
  const email = buildPrintUpgradeOfferEmail(makeOrder(), { chooserUrl: CHOOSER_URL, expiresAt: '2026-10-28T12:00:00.000Z', supportEmail: 'help@example.com' });
  assert.equal(email.to, 'parent@example.com');
  assert.match(email.subject, /Lukas/);
  for (const body of [email.text, email.html]) {
    assert.ok(body.includes(CHOOSER_URL), 'link present');
    assert.match(body, /Lukas, King of Dino Earth/);
    assert.match(body, /softcover/i);
    assert.match(body, /hardcover/i);
    assert.match(body, /print provider/i);
    assert.match(body, /no markup/i);
    assert.match(body, /shipping/i);
    assert.match(body, /tax/i);
    assert.match(body, /quoted live/i);
    assert.match(body, /October 28, 2026/);
    assert.match(body, /private/i);
    assert.match(body, /nothing (is|gets) printed automatically/i);
    assert.match(body, /prepare the print files for the format you choose/i);
    assert.match(body, /digital (book|PDF) (stays|remains) yours/i);
    assert.match(body, /help@example\.com/);
    assert.doesNotMatch(body, /\$\d/, 'no price is promised before the live quote');
    assert.doesNotMatch(body, /free shipping/i);
    assert.doesNotMatch(body, /ships in \d/i);
  }
  assert.doesNotMatch(email.html, /<script/i);
});

test('offer email: HTML-escapes the title and never embeds the token outside the link', () => {
  const email = buildPrintUpgradeOfferEmail(makeOrder({ printTitle: 'Lukas <King> & "Dino"' }), { chooserUrl: CHOOSER_URL, expiresAt: '2026-10-28T12:00:00.000Z' });
  assert.match(email.html, /Lukas &lt;King&gt; &amp; &quot;Dino&quot;/);
  assert.doesNotMatch(email.html, /Lukas <King>/);
  const occurrences = email.html.split('abc123').length - 1;
  const linkOccurrences = email.html.split(CHOOSER_URL).length - 1;
  assert.equal(occurrences, linkOccurrences);
});

test('offer email: send is refused unless explicitly enabled, and a configured send is idempotent per offer', async () => {
  const saved = { flag: process.env[PRINT_UPGRADE_OFFER_EMAIL_ENABLED_ENV], key: process.env.HSB_RESEND_API_KEY, key2: process.env.RESEND_API_KEY };
  delete process.env[PRINT_UPGRADE_OFFER_EMAIL_ENABLED_ENV];
  process.env.HSB_RESEND_API_KEY = 're_test_key';
  try {
    const sends: Array<{ payload: Record<string, unknown>; idempotencyKey?: string }> = [];
    const transport = {
      send: async (payload: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
        sends.push({ payload, idempotencyKey: options?.idempotencyKey });
        return { data: { id: 'msg_1' }, error: null };
      },
    };
    const blocked = await sendPrintUpgradeOfferEmail(makeOrder(), { chooserUrl: CHOOSER_URL, expiresAt: '2026-10-28T12:00:00.000Z', offerId: 'puo_0123456789abcdef' }, { transport });
    assert.deepEqual(blocked, { skipped: true, reason: 'print_upgrade_offer_email_disabled' });
    assert.equal(sends.length, 0);

    process.env[PRINT_UPGRADE_OFFER_EMAIL_ENABLED_ENV] = 'true';
    const sent = await sendPrintUpgradeOfferEmail(makeOrder(), { chooserUrl: CHOOSER_URL, expiresAt: '2026-10-28T12:00:00.000Z', offerId: 'puo_0123456789abcdef' }, { transport });
    assert.deepEqual(sent, { skipped: false, id: 'msg_1' });
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].payload.to, ['parent@example.com']);
    assert.equal(sends[0].idempotencyKey, 'print-upgrade-offer-ord_email_test_0001-puo_0123456789abcdef');

    delete process.env.HSB_RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    const noKey = await sendPrintUpgradeOfferEmail(makeOrder(), { chooserUrl: CHOOSER_URL, expiresAt: '2026-10-28T12:00:00.000Z', offerId: 'puo_0123456789abcdef' }, { transport });
    assert.deepEqual(noKey, { skipped: true, reason: 'missing_resend_api_key' });
  } finally {
    if (saved.flag === undefined) delete process.env[PRINT_UPGRADE_OFFER_EMAIL_ENABLED_ENV]; else process.env[PRINT_UPGRADE_OFFER_EMAIL_ENABLED_ENV] = saved.flag;
    if (saved.key === undefined) delete process.env.HSB_RESEND_API_KEY; else process.env.HSB_RESEND_API_KEY = saved.key;
    if (saved.key2 === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.key2;
  }
});
