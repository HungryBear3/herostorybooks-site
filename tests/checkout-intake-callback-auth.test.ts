/*
 * F6 — the callback budget must be spent only by an AUTHENTIC callback.
 *
 * The auth split fixed the original defect (a browser origin guard rejecting
 * every real Vercel callback), but it introduced a smaller one: the route
 * selected the callback branch from unauthenticated JSON and spent the global
 * callback budget there, before `handleUpload` verified the HMAC. Anyone who
 * learns the endpoint can post callback-shaped bodies with junk signatures
 * until that scope is rate-limited, after which genuine callbacks are refused
 * before their signature is ever checked. State stays safe; callback
 * AVAILABILITY does not.
 *
 * These tests use the REAL `@vercel/blob/client` `handleUpload` and compute a
 * real `x-vercel-signature`, so authenticity is actually exercised rather than
 * assumed. The signature is `HMAC-SHA256(token, JSON.stringify(body))` in hex —
 * the same construction the SDK verifies. Nothing here reaches the network:
 * both SDK branches are local crypto.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { handleUpload } from '@vercel/blob/client';

import { createIntake, listIntakeSlots } from '../src/lib/checkout-intake.ts';
import { reserveSlotUpload } from '../src/lib/checkout-intake-upload.ts';
import {
  handleIntakeUploadRequest,
  type IntakeUploadRouteDeps,
} from '../src/lib/checkout-intake-upload-route.ts';
import {
  createMemoryCheckoutGuardStore,
  guardBucketPath,
  type CheckoutGuardBucket,
  type CheckoutGuardStore,
} from '../src/lib/checkout-request-guard.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const ORIGIN = 'https://herostorybooks.com';
const UPLOAD_URL = `${ORIGIN}/api/checkout/intake/upload`;
const BLOB_TOKEN = 'vercel_blob_rw_StoreAbcdefgh_secretsecretsecret';
const NOW = 60_000;

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { HSB_CHECKOUT_DIRECT_UPLOAD: 'true', ...overrides } as NodeJS.ProcessEnv;
}

/** Exactly what Vercel Blob signs: the HMAC of the serialized body. */
function signBody(body: unknown, token = BLOB_TOKEN): string {
  return crypto.createHmac('sha256', token).update(JSON.stringify(body)).digest('hex');
}

function callbackRequest(body: unknown, signature: string | null): Request {
  return new Request(UPLOAD_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature === null ? {} : { 'x-vercel-signature': signature }),
    },
    body: JSON.stringify(body),
  });
}

async function callbackBucket(guardStore: CheckoutGuardStore): Promise<CheckoutGuardBucket | null> {
  const entry = await guardStore.read(guardBucketPath('intake-upload-callback', NOW - (NOW % 60_000)));
  return (entry?.record as CheckoutGuardBucket) ?? null;
}

async function seed(store: MemoryIntakeStore) {
  const session = await createIntake(store, { mediaAuthorizedAt: '2026-09-02T12:00:00.000Z' });
  const reservation = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: { category: 'primary_hero_photo' },
    mimeType: 'image/jpeg',
    size: 2048,
  });
  store.putAsset({ pathname: reservation.pathname, mimeType: 'image/jpeg', size: 2048, etag: 'etag-1' });
  return { session, reservation };
}

function completionBody(pathname: string, tokenPayload: string) {
  return {
    type: 'blob.upload-completed',
    payload: {
      blob: {
        url: `https://blob.example/${pathname}`,
        downloadUrl: `https://blob.example/${pathname}?download=1`,
        pathname,
        contentType: 'image/jpeg',
        contentDisposition: 'inline',
        etag: 'etag-1',
      },
      tokenPayload,
    },
  };
}

/** Counts every touch of the intake store so "zero work" can be asserted. */
function countingStore(store: MemoryIntakeStore) {
  const counts = { reads: 0, heads: 0, writes: 0 };
  const wrapped: MemoryIntakeStore = {
    ...store,
    read: async (id) => {
      counts.reads += 1;
      return store.read(id);
    },
    headAsset: async (pathname) => {
      counts.heads += 1;
      return store.headAsset(pathname);
    },
    compareAndSwap: async (id, etag, record) => {
      counts.writes += 1;
      return store.compareAndSwap(id, etag, record);
    },
  };
  return { wrapped, counts };
}

function deps(store: MemoryIntakeStore, guardStore: CheckoutGuardStore, e = env()): IntakeUploadRouteDeps {
  return {
    // The real SDK, not a dispatcher: signature verification is the behaviour
    // under test.
    handleUpload,
    store,
    guardStore,
    env: e,
    blobToken: BLOB_TOKEN,
    now: () => new Date(NOW),
  };
}

test('a correctly signed callback completes the upload', async () => {
  const store = createMemoryIntakeStore();
  const guardStore = createMemoryCheckoutGuardStore();
  const { session, reservation } = await seed(store);
  const body = completionBody(reservation.pathname, reservation.tokenPayload);

  const response = await handleIntakeUploadRequest(
    callbackRequest(body, signBody(body)),
    deps(store, guardStore),
  );

  assert.equal(response.status, 200, await response.text());
  const { slots } = await listIntakeSlots(store, session);
  assert.equal(slots[0]?.asset?.assetId, reservation.assetId);
  assert.equal((await callbackBucket(guardStore))?.requestCount, 1);
});

test('a callback with NO signature spends no budget and touches no intake state', async () => {
  const store = createMemoryIntakeStore();
  const { wrapped, counts } = countingStore(store);
  const guardStore = createMemoryCheckoutGuardStore();
  const { reservation } = await seed(store);
  const body = completionBody(reservation.pathname, reservation.tokenPayload);

  const response = await handleIntakeUploadRequest(
    callbackRequest(body, null),
    deps(wrapped, guardStore),
  );

  assert.notEqual(response.status, 200);
  assert.equal(await callbackBucket(guardStore), null, 'no callback budget was consumed');
  assert.deepEqual(counts, { reads: 0, heads: 0, writes: 0 }, 'no intake-store work was done');
});

test('a callback with a WRONG signature spends no budget and touches no intake state', async () => {
  const store = createMemoryIntakeStore();
  const { wrapped, counts } = countingStore(store);
  const guardStore = createMemoryCheckoutGuardStore();
  const { reservation } = await seed(store);
  const body = completionBody(reservation.pathname, reservation.tokenPayload);

  const response = await handleIntakeUploadRequest(
    // Signed with a different token — the shape is right, the secret is not.
    callbackRequest(body, signBody(body, 'vercel_blob_rw_StoreAbcdefgh_attackerguess')),
    deps(wrapped, guardStore),
  );

  assert.notEqual(response.status, 200);
  assert.equal(await callbackBucket(guardStore), null);
  assert.deepEqual(counts, { reads: 0, heads: 0, writes: 0 });
});

test('a tampered body cannot ride an otherwise valid signature', async () => {
  const store = createMemoryIntakeStore();
  const guardStore = createMemoryCheckoutGuardStore();
  const { session, reservation } = await seed(store);
  const body = completionBody(reservation.pathname, reservation.tokenPayload);
  const signature = signBody(body);

  // Same signature, different pathname.
  const tampered = completionBody(
    `intakes/${session.intakeId}/assets/asset_${'0'.repeat(32)}`,
    reservation.tokenPayload,
  );
  const response = await handleIntakeUploadRequest(
    callbackRequest(tampered, signature),
    deps(store, guardStore),
  );

  assert.notEqual(response.status, 200);
  const { slots } = await listIntakeSlots(store, session);
  assert.deepEqual(slots.filter((slot) => slot.asset), [], 'nothing was activated');
});

test('unsigned floods cannot exhaust the budget a genuine callback needs', async () => {
  const store = createMemoryIntakeStore();
  const guardStore = createMemoryCheckoutGuardStore();
  const { session, reservation } = await seed(store);
  const body = completionBody(reservation.pathname, reservation.tokenPayload);
  // A ceiling of one callback per minute makes the exhaustion obvious.
  const routeDeps = deps(store, guardStore, env({ HSB_CHECKOUT_GUARD_MAX_CALLBACKS_PER_MINUTE: '1' }));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await handleIntakeUploadRequest(callbackRequest(body, 'deadbeef'), routeDeps);
    assert.notEqual(response.status, 200);
  }

  const genuine = await handleIntakeUploadRequest(
    callbackRequest(body, signBody(body)),
    routeDeps,
  );
  assert.equal(genuine.status, 200, await genuine.text());
  const { slots } = await listIntakeSlots(store, session);
  assert.equal(slots[0]?.asset?.assetId, reservation.assetId);
});

test('authentic callbacks are still bounded', async () => {
  const store = createMemoryIntakeStore();
  const guardStore = createMemoryCheckoutGuardStore();
  const { reservation } = await seed(store);
  const body = completionBody(reservation.pathname, reservation.tokenPayload);
  const routeDeps = deps(store, guardStore, env({ HSB_CHECKOUT_GUARD_MAX_CALLBACKS_PER_MINUTE: '1' }));

  assert.equal((await handleIntakeUploadRequest(callbackRequest(body, signBody(body)), routeDeps)).status, 200);
  const second = await handleIntakeUploadRequest(callbackRequest(body, signBody(body)), routeDeps);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error, 'rate_limited');
});
