import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
const blob = await import('@vercel/blob');
const requests: any[] = [];
const unmatched = async () => { throw new Error('UNMATCHED_EXTERNAL_IO'); };
mock.module('@vercel/blob', { namedExports: { ...blob, get: unmatched, put: unmatched, list: unmatched, head: unmatched, del: unmatched } });
mock.module('resend', { namedExports: { Resend: class { emails = { send: async (...args: any[]) => { requests.push(args); return { data: { id: 'synthetic-message' }, error: null }; } }; } } });
const { syntheticOrderBlob, presentationOrder, withLuluEnv, synthOrderId } = await import('./support/initial-shipping-fixture.ts');
const { publicShippingSummary, adminShippingSummary } = await import('../src/lib/initial-shipping-summary.ts');
const { deliverOrderConfirmationEmail } = await import('../src/lib/confirmation-email-delivery.ts');
const { readOrderVersioned, withOrderTransaction } = await import('../src/lib/orders.ts');
const { buildOrderConfirmationEmail } = await import('../src/lib/order-email.ts');

async function fixture(run: (s: ReturnType<typeof syntheticOrderBlob>) => Promise<void>) {
  const env = { ...process.env }; const s = syntheticOrderBlob(); requests.length = 0;
  Object.assign(process.env, { HSB_RESEND_API_KEY: 'synthetic', HSB_REQUIRE_DURABLE_PERSISTENCE: 'true', HSB_EMAIL_FROM: 'sender@example.invalid' });
  try { await withLuluEnv(() => run(s)); } finally { s.close(); for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); }
}
const read = async (id: string) => (await readOrderVersioned(id))?.order ?? null;
const delivery = (id: string) => deliverOrderConfirmationEmail(id, { getOrder: read, log() {}, errorLog() {} });

test('produced shipping summary cannot confirm pending, reversal, dispatch hold or unknown print outcome', () => fixture(async s => {
  const order = await presentationOrder(s);
  assert.equal(order.initialShippingSettlement?.state, 'committed');
  assert.equal((publicShippingSummary(order) as any).status, 'confirmed');
  for (const patch of [{ paymentStatus: 'pending' }, { paymentStatus: 'refunded' }, { refundStatus: 'partial' },
    { refundClaimId: 'private-refund-canary' }, { refundedAt: '2026-11-09' },
    { fulfillmentLastError: 'print_submission_failed_before_attempt: shipping_hold:dispatch_cost_exceeded' },
    { printSubmissionAttemptedAt: '2026-11-09', printJobId: null }]) {
    const summary = publicShippingSummary({ ...order, ...patch });
    assert.notEqual((summary as any).status, 'confirmed', JSON.stringify(patch));
    assert.doesNotMatch(JSON.stringify(summary), /private-refund-canary/);
  }
  const admin = adminShippingSummary({ ...order, fulfillmentLastError: 'print_submission_failed_before_attempt: shipping_hold:dispatch_cost_exceeded' });
  assert.equal((admin as any).reason, 'dispatch_cost_exceeded');
}));

test('actual default sender decorates once; canonical receipt blocks replay; legacy request is unchanged', () => fixture(async s => {
  const order = await presentationOrder(s);
  assert.equal((await delivery(order.id)).status, 'sent');
  assert.equal(requests.length, 1);
  const request = requests[0][0];
  for (const text of [request.text, request.html]) {
    assert.match(text, /Standard shipping/); assert.match(text, /\$4\.20/); assert.match(text, /\$0\.20/); assert.match(text, /\$44\.19/);
    assert.doesNotMatch(text, /Synthetic Recipient|123 Example|receiptDigest|draftRef|accountBinding/);
  }
  assert.equal(request.text.split('Shipping: Expedited').length, 2);
  assert.equal((await delivery(order.id)).status, 'blocked'); assert.equal(requests.length, 1);
  const legacy = await presentationOrder(s, synthOrderId('b'));
  await withOrderTransaction(legacy.id, current => { const next = { ...current }; delete next.initialShipping; delete next.initialShippingSettlement; return { commit: next, result: true }; });
  const standard = (await read(legacy.id))!;
  assert.equal((await delivery(legacy.id)).status, 'sent');
  const base = buildOrderConfirmationEmail(standard);
  assert.deepEqual(requests[1], [{ from: 'sender@example.invalid', to: [standard.email], ...base, replyTo: 'support@herostorybooks.com' }, { idempotencyKey: `order-confirmation-${standard.id}-primary-v1` }]);
}));

test('held, unverified, malformed and dispatch-held records get no claim, receipt or send', () => fixture(async s => {
  for (const [i, patch] of [
    { initialShipping: null },
    { initialShippingSettlement: { version: 1, state: 'unverified', receiptDigest: null, reason: null, updatedAt: new Date().toISOString() } },
    { initialShippingSettlement: { version: 1, state: 'held', receiptDigest: null, reason: 'payment_discounted', updatedAt: new Date().toISOString() } },
    { fulfillmentLastError: 'print_submission_failed_before_attempt: shipping_hold:dispatch_cost_exceeded' },
    { refundStatus: 'partial' },
  ].entries()) {
    const o = await presentationOrder(s, synthOrderId(String(i)));
    await withOrderTransaction(o.id, current => ({ commit: { ...current, ...patch } as typeof current, result: true }));
    const before = JSON.stringify(await read(o.id));
    assert.equal((await delivery(o.id)).status, 'blocked');
    assert.equal(JSON.stringify(await read(o.id)), before);
  }
  assert.equal(requests.length, 0);
}));
