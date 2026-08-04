import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sendDigitalDeliveryEmail,
  getFallbackSenderEmail,
} from '../src/lib/order-email.ts';
import { createOrderRecord } from '../src/lib/orders.ts';

// Behaviour matrix for the synthetic Resend "domain is not verified" 403 case.
// After the fix, the email sender:
//   - surfaces an actionable error mentioning the configured sender,
//     the HSB_EMAIL_FROM_FALLBACK env var, and the Resend dashboard URL,
//   - retries automatically with the fallback sender when set,
//   - throws (not swallows) when both primary and fallback fail so the
//     caller can record `delivery_email_failed`.

function makeDigitalOrder() {
  return createOrderRecord(
    { childName: 'Mira', bookFormat: 'digital', email: 'mira@example.com' },
    { id: 'ord_test_domain_fallback', now: '2026-05-12T10:00:00Z' },
  );
}

function recordCalls() {
  const calls: Array<{ url: string; body: { from?: string } }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    let body: { from?: string } = {};
    try {
      body = init?.body ? JSON.parse(String(init.body)) : {};
    } catch {
      body = {};
    }
    calls.push({ url: String(url), body });
    return { calls };
  }) as unknown as typeof fetch;
  return { calls, fakeFetch };
}

test('getFallbackSenderEmail reflects HSB_EMAIL_FROM_FALLBACK', () => {
  const original = process.env.HSB_EMAIL_FROM_FALLBACK;
  process.env.HSB_EMAIL_FROM_FALLBACK = 'HSB <bot@verified.example>';
  try {
    assert.equal(getFallbackSenderEmail(), 'HSB <bot@verified.example>');
  } finally {
    if (original === undefined) delete process.env.HSB_EMAIL_FROM_FALLBACK;
    else process.env.HSB_EMAIL_FROM_FALLBACK = original;
  }
  delete process.env.HSB_EMAIL_FROM_FALLBACK;
  assert.equal(getFallbackSenderEmail(), null);
});

test('unverified domain without fallback → actionable error message thrown', async () => {
  const originalKey = process.env.HSB_RESEND_API_KEY;
  const originalFrom = process.env.HSB_EMAIL_FROM;
  const originalFallback = process.env.HSB_EMAIL_FROM_FALLBACK;
  const originalFetch = globalThis.fetch;
  process.env.HSB_RESEND_API_KEY = 're_test_stub';
  process.env.HSB_EMAIL_FROM = 'Hero Story Books <support@herostorybooks.com>';
  delete process.env.HSB_EMAIL_FROM_FALLBACK;

  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(
      JSON.stringify({
        statusCode: 403,
        name: 'validation_error',
        message: 'The herostorybooks.com domain is not verified.',
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        sendDigitalDeliveryEmail(makeDigitalOrder(), {
          pdfUrl: 'https://cdn.example.com/order/storybook.pdf',
          reviewUrl: 'https://example.com/review/order_test?token=re_test_stub',
        }),
      (err: Error) => {
        assert.match(err.message, /not on a verified Resend domain/i);
        assert.match(err.message, /HSB_EMAIL_FROM_FALLBACK/);
        assert.match(err.message, /resend\.com\/domains/);
        assert.match(err.message, /support@herostorybooks\.com/);
        return true;
      },
    );
    assert.equal(
      fetchCalls,
      1,
      'should not retry when no HSB_EMAIL_FROM_FALLBACK is configured',
    );
  } finally {
    if (originalKey === undefined) delete process.env.HSB_RESEND_API_KEY;
    else process.env.HSB_RESEND_API_KEY = originalKey;
    if (originalFrom === undefined) delete process.env.HSB_EMAIL_FROM;
    else process.env.HSB_EMAIL_FROM = originalFrom;
    if (originalFallback === undefined) delete process.env.HSB_EMAIL_FROM_FALLBACK;
    else process.env.HSB_EMAIL_FROM_FALLBACK = originalFallback;
    globalThis.fetch = originalFetch;
  }
});

test('unverified primary domain WITH fallback → retries once with fallback sender', async () => {
  const originalKey = process.env.HSB_RESEND_API_KEY;
  const originalFrom = process.env.HSB_EMAIL_FROM;
  const originalFallback = process.env.HSB_EMAIL_FROM_FALLBACK;
  const originalFetch = globalThis.fetch;
  process.env.HSB_RESEND_API_KEY = 're_test_stub';
  process.env.HSB_EMAIL_FROM = 'Hero Story Books <support@herostorybooks.com>';
  process.env.HSB_EMAIL_FROM_FALLBACK = 'Hero Story Books <onboarding@resend.dev>';

  const fromCalls: string[] = [];
  let attempt = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    attempt++;
    const body = init?.body ? JSON.parse(String(init.body)) : ({} as { from?: string });
    fromCalls.push(body.from ?? '(none)');
    if (attempt === 1) {
      return new Response(
        JSON.stringify({
          statusCode: 403,
          name: 'validation_error',
          message: 'The herostorybooks.com domain is not verified.',
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ id: 'email_fallback_ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await sendDigitalDeliveryEmail(makeDigitalOrder(), {
      pdfUrl: 'https://cdn.example.com/order/storybook.pdf',
      reviewUrl: 'https://example.com/review/order_test?token=re_test_stub',
    });
    assert.equal((result as { skipped?: boolean }).skipped, false);
    assert.equal(attempt, 2, 'expected one retry against the fallback sender');
    assert.equal(fromCalls[0], 'Hero Story Books <support@herostorybooks.com>');
    assert.equal(fromCalls[1], 'Hero Story Books <onboarding@resend.dev>');
  } finally {
    if (originalKey === undefined) delete process.env.HSB_RESEND_API_KEY;
    else process.env.HSB_RESEND_API_KEY = originalKey;
    if (originalFrom === undefined) delete process.env.HSB_EMAIL_FROM;
    else process.env.HSB_EMAIL_FROM = originalFrom;
    if (originalFallback === undefined) delete process.env.HSB_EMAIL_FROM_FALLBACK;
    else process.env.HSB_EMAIL_FROM_FALLBACK = originalFallback;
    globalThis.fetch = originalFetch;
  }
});

test('non-domain error (e.g. 500) does NOT trigger the fallback retry', async () => {
  const originalKey = process.env.HSB_RESEND_API_KEY;
  const originalFrom = process.env.HSB_EMAIL_FROM;
  const originalFallback = process.env.HSB_EMAIL_FROM_FALLBACK;
  const originalFetch = globalThis.fetch;
  process.env.HSB_RESEND_API_KEY = 're_test_stub';
  process.env.HSB_EMAIL_FROM = 'Hero Story Books <support@herostorybooks.com>';
  process.env.HSB_EMAIL_FROM_FALLBACK = 'Hero Story Books <onboarding@resend.dev>';

  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    return new Response(
      JSON.stringify({
        statusCode: 500,
        name: 'internal_error',
        message: 'Resend temporary outage',
      }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        sendDigitalDeliveryEmail(makeDigitalOrder(), {
          pdfUrl: 'https://cdn.example.com/order/storybook.pdf',
          reviewUrl: 'https://example.com/review/order_test?token=re_test_stub',
        }),
      (err: Error) => /Resend temporary outage|500/.test(err.message),
    );
    assert.equal(
      attempts,
      1,
      'fallback retry should only fire for domain-verification 403, not generic errors',
    );
  } finally {
    if (originalKey === undefined) delete process.env.HSB_RESEND_API_KEY;
    else process.env.HSB_RESEND_API_KEY = originalKey;
    if (originalFrom === undefined) delete process.env.HSB_EMAIL_FROM;
    else process.env.HSB_EMAIL_FROM = originalFrom;
    if (originalFallback === undefined) delete process.env.HSB_EMAIL_FROM_FALLBACK;
    else process.env.HSB_EMAIL_FROM_FALLBACK = originalFallback;
    globalThis.fetch = originalFetch;
  }
});
