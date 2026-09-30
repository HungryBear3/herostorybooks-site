/**
 * Drives the real signed Stripe webhook against a temp-dir order store with
 * every outbound request intercepted and recorded — nothing leaves the host.
 * The GA4 Measurement Protocol endpoint is answered locally; any other host is
 * recorded (so a test can prove it was never contacted) and refused.
 *
 * Mirrors the Phase-A harness in tests/stripe-webhook-purchase-analytics.test.ts.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Stripe from 'stripe';

import { POST } from '../../src/app/api/webhooks/stripe/route.ts';
import { createOrderRecord, persistOrder, type OrderRecord } from '../../src/lib/orders.ts';

export const WEBHOOK_SECRET = 'whsec_hsb_phase_b_local_test';
const STRIPE_KEY = 'sk_test_hsb_phase_b_local_test';
export const MP_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

export const ANALYTICS_SETTLED = /^\[purchase-analytics\] ga4=/;
export const CONFIRMATION_EMAIL_SETTLED = /^\[confirmation-email\] setImmediate (?:completed|failed|joined failed send) for /;
export const FULFILLMENT_KICKOFF_SETTLED = /^\[webhook\]\[kickoff:[^\]]+\] \[setImmediate\] chain exited:/;
export const NEWLY_PAID = [ANALYTICS_SETTLED, CONFIRMATION_EMAIL_SETTLED, FULFILLMENT_KICKOFF_SETTLED];

const BASE_ENV = [
  'HSB_ORDER_STORE_DIR', 'HSB_PAYMENT_RECOVERY_STORE_DIR', 'HSB_REQUIRE_DURABLE_PERSISTENCE',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'VERCEL_ENV', 'VERCEL', 'BLOB_READ_WRITE_TOKEN',
  'GA4_MEASUREMENT_ID', 'GA4_API_SECRET', 'NEXT_PUBLIC_GA_MEASUREMENT_ID',
  'RESEND_API_KEY', 'HSB_RESEND_API_KEY', 'HSB_CONTROL_PLANE_SHADOW',
];

/** A temp order store in a production-shaped env; `extra` is applied last. Returns a restore(). */
export function setupWebhookStore(extra: Record<string, string> = {}): () => void {
  const managed = [...new Set([...BASE_ENV, ...Object.keys(extra)])];
  const saved = new Map(managed.map((key) => [key, process.env[key]]));
  const root = mkdtempSync(path.join(os.tmpdir(), 'hsb-phase-b-webhook-'));
  for (const key of managed) delete process.env[key];
  process.env.HSB_ORDER_STORE_DIR = path.join(root, 'orders');
  process.env.HSB_PAYMENT_RECOVERY_STORE_DIR = path.join(root, 'recovery');
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
  process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.GA4_MEASUREMENT_ID = 'G-68FKEDZEG3';
  process.env.GA4_API_SECRET = 'test-mp-secret-phase-b';
  process.env.VERCEL_ENV = 'production';
  Object.assign(process.env, extra);
  return () => {
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export async function seedPendingOrder(hex: string): Promise<OrderRecord> {
  const order = {
    ...createOrderRecord(
      { childName: 'ZQX-CHILD-7731', bookFormat: 'digital', email: 'zqx.parent.7731@example.invalid' },
      { id: `ord_${hex}`, now: new Date().toISOString() },
    ),
    stripeSessionId: `cs_test_${hex}`,
    paymentStatus: 'pending',
  } as OrderRecord;
  await persistOrder(order);
  return order;
}

export function completedEvent(order: OrderRecord, metadata: Record<string, string>) {
  return {
    id: `evt_${order.id.slice(4)}`,
    object: 'event',
    type: 'checkout.session.completed',
    created: 1_800_000_000,
    data: {
      object: {
        id: order.stripeSessionId,
        object: 'checkout.session',
        client_reference_id: order.id,
        metadata,
        payment_intent: `pi_${order.id.slice(4)}`,
        amount_total: order.priceCents,
        amount_subtotal: order.priceCents,
        currency: 'usd',
        mode: 'payment',
        payment_status: 'paid',
      },
    },
  };
}

function signed(event: Record<string, unknown>): Request {
  const payload = JSON.stringify(event);
  const signature = new Stripe(STRIPE_KEY).webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return new Request('http://127.0.0.1/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
}

export interface OutboundCall { url: string; body: string }

export async function runWebhook(
  event: Record<string, unknown>,
  opts: { settledBy?: RegExp[]; deliveries?: number; onResponse?: () => void } = {},
): Promise<{ statuses: number[]; lines: string[]; outbound: OutboundCall[] }> {
  const lines: string[] = [];
  const outbound: OutboundCall[] = [];
  const sinks = ['error', 'warn', 'log', 'info'] as const;
  const originals = sinks.map((sink) => console[sink]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    outbound.push({ url, body: String(init?.body ?? '') });
    if (!url.startsWith(`${MP_ENDPOINT}?`)) throw new Error('outbound request refused by test harness');
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  for (const sink of sinks) {
    console[sink] = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
  }
  try {
    const responses = await Promise.all(Array.from({ length: opts.deliveries ?? 1 }, async () => {
      const response = await POST(signed(event));
      opts.onResponse?.();
      return response;
    }));
    const markers = opts.settledBy ?? [];
    const expiry = Date.now() + 30_000;
    while (!markers.every((marker) => lines.some((line) => marker.test(line))) && Date.now() < expiry) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(markers.every((marker) => lines.some((line) => marker.test(line))), `deferred webhook work did not settle:\n${lines.join('\n')}`);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return { statuses: responses.map((response) => response.status), lines: [...lines], outbound: [...outbound] };
  } finally {
    sinks.forEach((sink, index) => { console[sink] = originals[index]; });
    globalThis.fetch = realFetch;
  }
}
