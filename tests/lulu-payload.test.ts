import test from 'node:test';
import assert from 'node:assert/strict';

import { submitPrintJob, clearTokenCache } from '../src/lib/lulu.ts';
import { createOrderRecord } from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';

const BASE_ORDER: OrderRecord = {
  ...createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'luna@example.com' },
    { id: 'ord_lulu_payload_001', now: '2026-04-23T10:00:00Z' },
  ),
  paymentStatus: 'paid',
  printTitle: "Luna's Great Adventure",
  printInteriorArtifactUrl: 'https://cdn.example.com/luna-interior.pdf',
  printInteriorMd5: 'INTERIORMD5',
  printInteriorPageCount: 32,
  printCoverArtifactUrl: 'https://cdn.example.com/luna-cover.pdf',
  printCoverMd5: 'COVERMD5',
  shippingAddress: {
    line1: '123 Main St',
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
    country: 'US',
  },
};

const TOKEN_RESPONSE = { access_token: 'test-token-xyz', expires_in: 3600, token_type: 'Bearer' };
const JOB_RESPONSE = { id: 98765432, status: 'CREATED' };

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

test('submitPrintJob sends separate interior and cover payload objects with md5s', withCreds(async () => {
  let capturedBody = '';

  const fetchMock = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (String(url).includes('openid-connect/token')) {
      return { ok: true, status: 200, json: async () => TOKEN_RESPONSE, text: async () => '' } as Response;
    }
    capturedBody = String(init?.body ?? '');
    return { ok: true, status: 200, json: async () => JOB_RESPONSE, text: async () => '' } as Response;
  };

  await submitPrintJob(BASE_ORDER, { fetch: fetchMock });
  const parsed = JSON.parse(capturedBody);
  const item = parsed.line_items[0];

  assert.equal(item.pod_package_id, '0850X0850.FC.STD.PB.080CW444.GXX');
  assert.deepEqual(item.interior, {
    source_url: 'https://cdn.example.com/luna-interior.pdf',
    source_md5_sum: 'INTERIORMD5',
  });
  assert.deepEqual(item.cover, {
    source_url: 'https://cdn.example.com/luna-cover.pdf',
    source_md5_sum: 'COVERMD5',
  });
  assert.equal(item.title, "Luna's Great Adventure");
}));

test('submitPrintJob fails clearly when print artifacts are missing', withCreds(async () => {
  const brokenOrder: OrderRecord = { ...BASE_ORDER, printCoverArtifactUrl: null };
  await assert.rejects(
    () => submitPrintJob(brokenOrder, { fetch: async () => ({ ok: true, status: 200, json: async () => TOKEN_RESPONSE, text: async () => '' } as Response) }),
    /print-ready interior\/cover artifacts/i,
  );
}));
