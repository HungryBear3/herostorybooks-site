import test from 'node:test';
import assert from 'node:assert/strict';

import { submitPrintJob as submitWithContact, clearTokenCache, type LuluPrintDeps } from '../src/lib/lulu.ts';
import { createOrderRecord } from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import { syntheticPrintContact } from './support/print-contact-fixture.ts';

const submitPrintJob = (order: OrderRecord, deps: Omit<LuluPrintDeps, 'contact'> = {}) =>
  submitWithContact(order, { ...deps, contact: syntheticPrintContact(order) });

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_ORDER: OrderRecord = {
  ...createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'luna@example.com' },
    { id: 'ord_lulu_test_001', now: '2026-04-23T10:00:00Z' },
  ),
  paymentStatus: 'paid',
  printTitle: "Luna's Great Adventure",
  printInteriorArtifactUrl: 'https://cdn.example.com/book-interior.pdf',
  printInteriorMd5: 'INTERIORMD5',
  printInteriorPageCount: 32,
  printCoverArtifactUrl: 'https://cdn.example.com/book-cover.pdf',
  printCoverMd5: 'COVERMD5',
  shippingAddress: {
    line1: '123 Main St',
    line2: null,
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
    country: 'US',
  },
};

const TOKEN_RESPONSE = { access_token: 'test-token-xyz', expires_in: 3600, token_type: 'Bearer' };
const JOB_RESPONSE = { id: 98765432, status: 'CREATED', estimated_shipping_dates: { earliest: '2026-05-01' } };

function mockFetch(responses: Array<{ ok: boolean; body: unknown }>) {
  let idx = 0;
  return async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const spec = responses[idx++] ?? responses[responses.length - 1];
    return {
      ok: spec.ok,
      status: spec.ok ? 200 : 400,
      json: async () => spec.body,
      text: async () => JSON.stringify(spec.body),
    } as Response;
  };
}

function withCreds(fn: () => Promise<void>) {
  return async () => {
    clearTokenCache();
    process.env.LULU_CLIENT_KEY = 'test-client-key';
    process.env.LULU_CLIENT_SECRET = 'test-client-secret';
    try {
      await fn();
    } finally {
      delete process.env.LULU_CLIENT_KEY;
      delete process.env.LULU_CLIENT_SECRET;
      clearTokenCache();
    }
  };
}

// ── Missing credentials ───────────────────────────────────────────────────────

test('submitPrintJob: throws when LULU_CLIENT_KEY is missing', async () => {
  clearTokenCache();
  delete process.env.LULU_CLIENT_KEY;
  delete process.env.LULU_CLIENT_SECRET;

  await assert.rejects(
    () => submitPrintJob(BASE_ORDER),
    /LULU_CLIENT_KEY and LULU_CLIENT_SECRET are required/,
  );
});

test('submitPrintJob: throws when only LULU_CLIENT_SECRET is missing', async () => {
  clearTokenCache();
  process.env.LULU_CLIENT_KEY = 'key-only';
  delete process.env.LULU_CLIENT_SECRET;

  try {
    await assert.rejects(
      () => submitPrintJob(BASE_ORDER),
      /LULU_CLIENT_KEY and LULU_CLIENT_SECRET are required/,
    );
  } finally {
    delete process.env.LULU_CLIENT_KEY;
  }
});

// ── Auth failure ──────────────────────────────────────────────────────────────

test('submitPrintJob: throws on auth 401', withCreds(async () => {
  const _fetch = mockFetch([{ ok: false, body: { error: 'invalid_client' } }]);
  await assert.rejects(
    () => submitPrintJob(BASE_ORDER, { fetch: _fetch }),
    /Lulu auth failed 400/,
  );
}));

// ── Successful submission ─────────────────────────────────────────────────────

test('submitPrintJob: returns jobId and estimatedShipDate on success', withCreds(async () => {
  const _fetch = mockFetch([
    { ok: true, body: TOKEN_RESPONSE },
    { ok: true, body: JOB_RESPONSE },
  ]);

  const result = await submitPrintJob(BASE_ORDER, { fetch: _fetch });

  assert.equal(result.jobId, '98765432');
  assert.equal(result.status, 'submitted');
  assert.equal(result.estimatedShipDate, '2026-05-01');
}));

test('submitPrintJob: works without shippingAddress', withCreds(async () => {
  const orderNoShipping: OrderRecord = { ...BASE_ORDER, shippingAddress: null };
  const _fetch = mockFetch([
    { ok: true, body: TOKEN_RESPONSE },
    { ok: true, body: { id: 11111111, status: 'CREATED' } },
  ]);

  const result = await submitPrintJob(orderNoShipping, { fetch: _fetch });
  assert.equal(result.jobId, '11111111');
  assert.equal(result.estimatedShipDate, undefined);
}));

test('submitPrintJob: fails closed when id is missing from response', withCreds(async () => {
  const _fetch = mockFetch([
    { ok: true, body: TOKEN_RESPONSE },
    { ok: true, body: { status: 'CREATED' } },
  ]);

  await assert.rejects(
    () => submitPrintJob(BASE_ORDER, { fetch: _fetch }),
    /missing print job id/,
  );
}));

// ── API error ─────────────────────────────────────────────────────────────────

test('submitPrintJob: throws on print-jobs API 422', withCreds(async () => {
  const _fetch = mockFetch([
    { ok: true, body: TOKEN_RESPONSE },
    { ok: false, body: { detail: 'Invalid pod_package_id' } },
  ]);

  await assert.rejects(
    () => submitPrintJob(BASE_ORDER, { fetch: _fetch }),
    /Lulu API error 400/,
  );
}));

// ── Token caching ─────────────────────────────────────────────────────────────

test('token is reused across calls within expiry window', withCreds(async () => {
  let tokenFetchCount = 0;

  const trackingFetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = String(url);
    if (urlStr.includes('openid-connect/token')) {
      tokenFetchCount++;
      return { ok: true, status: 200, json: async () => TOKEN_RESPONSE, text: async () => '' } as Response;
    }
    return { ok: true, status: 200, json: async () => JOB_RESPONSE, text: async () => '' } as Response;
  };

  clearTokenCache();
  await submitPrintJob(BASE_ORDER, { fetch: trackingFetch });
  await submitPrintJob(BASE_ORDER, { fetch: trackingFetch });

  assert.equal(tokenFetchCount, 1, 'token endpoint should only be called once when cached');
}));

test('premium format uses configured hardcover pod_package_id env var', withCreds(async () => {
  process.env.LULU_HARDCOVER_POD_PACKAGE_ID = 'HARDCOVER_TEST_ID_XYZ';
  let capturedBody = '';

  const capturingFetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = String(url);
    if (urlStr.includes('openid-connect/token')) {
      return { ok: true, status: 200, json: async () => TOKEN_RESPONSE, text: async () => '' } as Response;
    }
    capturedBody = init?.body as string ?? '';
    return { ok: true, status: 200, json: async () => JOB_RESPONSE, text: async () => '' } as Response;
  };

  clearTokenCache();
  const premiumOrder: OrderRecord = { ...BASE_ORDER, bookFormat: 'premium' };
  await submitPrintJob(premiumOrder, { fetch: capturingFetch });

  assert.ok(capturedBody.includes('HARDCOVER_TEST_ID_XYZ'), 'should use configured hardcover pod_package_id');

  delete process.env.LULU_HARDCOVER_POD_PACKAGE_ID;
}));

test('default Lulu package ids match HSB MVP square full-color softcover and casewrap targets', withCreds(async () => {
  let capturedBodies: string[] = [];

  const capturingFetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = String(url);
    if (urlStr.includes('openid-connect/token')) {
      return { ok: true, status: 200, json: async () => TOKEN_RESPONSE, text: async () => '' } as Response;
    }
    capturedBodies.push(String(init?.body ?? ''));
    return { ok: true, status: 200, json: async () => JOB_RESPONSE, text: async () => '' } as Response;
  };

  clearTokenCache();
  await submitPrintJob({ ...BASE_ORDER, bookFormat: 'classic' }, { fetch: capturingFetch });
  await submitPrintJob({ ...BASE_ORDER, bookFormat: 'premium' }, { fetch: capturingFetch });

  assert.match(capturedBodies[0], /0850X0850\.FC\.STD\.PB\.080CW444\.GXX/);
  assert.match(capturedBodies[1], /0850X0850\.FC\.STD\.CW\.080CW444\.MXX/);
}));

test('auth uses the real Lulu OpenID token path', withCreds(async () => {
  const seenUrls: string[] = [];
  const trackingFetch = async (url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    seenUrls.push(String(url));
    if (String(url).includes('openid-connect/token')) {
      return { ok: true, status: 200, json: async () => TOKEN_RESPONSE, text: async () => '' } as Response;
    }
    return { ok: true, status: 200, json: async () => JOB_RESPONSE, text: async () => '' } as Response;
  };

  clearTokenCache();
  await submitPrintJob(BASE_ORDER, { fetch: trackingFetch });

  assert.equal(seenUrls[0], 'https://api.lulu.com/auth/realms/glasstree/protocol/openid-connect/token');
}));

test('auth strips /v2 from LULU_API_URL when building token endpoint', withCreds(async () => {
  const seenUrls: string[] = [];
  const previous = process.env.LULU_API_URL;
  process.env.LULU_API_URL = 'https://api.lulu.com/v2';
  const trackingFetch = async (url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    seenUrls.push(String(url));
    if (String(url).includes('openid-connect/token')) {
      return { ok: true, status: 200, json: async () => TOKEN_RESPONSE, text: async () => '' } as Response;
    }
    return { ok: true, status: 200, json: async () => JOB_RESPONSE, text: async () => '' } as Response;
  };

  try {
    clearTokenCache();
    await submitPrintJob(BASE_ORDER, { fetch: trackingFetch });
    assert.equal(seenUrls[0], 'https://api.lulu.com/auth/realms/glasstree/protocol/openid-connect/token');
  } finally {
    if (previous == null) delete process.env.LULU_API_URL;
    else process.env.LULU_API_URL = previous;
    clearTokenCache();
  }
}));

// Contact-bearing request: real Response bodies and rejections, no provider.

const ECHO_NAME = 'Quill Echoed';
const ECHO_PHONE = '+13125550188';

const submitWithEcho = (reply: () => Response) => submitWithContact(BASE_ORDER, {
  contact: { ...syntheticPrintContact(BASE_ORDER), recipientName: ECHO_NAME, phone: ECHO_PHONE },
  fetch: (async (url: RequestInfo | URL) => (String(url).includes('openid-connect/token')
    ? new Response(JSON.stringify(TOKEN_RESPONSE))
    : reply())) as typeof fetch,
});

async function rejectionOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

function assertNoEcho(error: Error) {
  const text = `${error.message}\n${error.stack}\n${String(error.cause)}`;
  for (const value of [ECHO_NAME, 'Quill', ECHO_PHONE, '5550188']) assert.equal(text.includes(value), false, value);
}

test('submitPrintJob: a 2xx non-JSON body echoing contact throws fixed text', withCreds(async () => {
  const error = await rejectionOf(submitWithEcho(() => new Response(`${ECHO_NAME} ${ECHO_PHONE}`, { status: 200 })));
  assert.equal(error.message, 'Lulu API success response was not JSON; outcome requires reconciliation');
  assertNoEcho(error);
}));

test('submitPrintJob: a failed transport echoing contact throws fixed text', withCreds(async () => {
  const error = await rejectionOf(submitWithEcho(() => {
    throw new TypeError(`fetch failed for ${ECHO_NAME} ${ECHO_PHONE}`, { cause: new Error(`${ECHO_NAME} ${ECHO_PHONE}`) });
  }));
  assert.equal(error.message, 'Lulu API transport failed; outcome requires reconciliation');
  assertNoEcho(error);
}));

test('submitPrintJob: a 2xx JSON reply with an unusable job id never becomes a job id', withCreds(async () => {
  for (const body of [
    { id: ECHO_NAME },
    { id: ECHO_PHONE },
    { id: { name: ECHO_NAME } },
    { id: '   ' },
    null,
    ECHO_NAME,
  ]) {
    const error = await rejectionOf(submitWithEcho(() => new Response(JSON.stringify(body), { status: 201 })));
    assert.match(error.message, /missing print job id/, JSON.stringify(body));
    assertNoEcho(error);
  }
}));

test('submitPrintJob: an unusable ship date is dropped', withCreds(async () => {
  const result = await submitWithEcho(() => new Response(JSON.stringify({ id: 777, estimated_shipping_dates: { earliest: `${ECHO_NAME} ${ECHO_PHONE}` } }), { status: 201 }));
  assert.deepEqual(result, { jobId: '777', status: 'submitted' });
}));

test('submitPrintJob: a numeric-string job id and a real date still pass through', withCreds(async () => {
  const result = await submitWithEcho(() => new Response(JSON.stringify({ id: '98765432', estimated_shipping_dates: { earliest: '2026-05-01' } }), { status: 201 }));
  assert.deepEqual(result, { jobId: '98765432', status: 'submitted', estimatedShipDate: '2026-05-01' });
}));
