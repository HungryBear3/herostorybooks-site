/*
 * The upload route's two callers are authenticated differently.
 *
 * `POST /api/checkout/intake/upload` is hit by two very different clients:
 *
 *   - the BROWSER, asking for a client upload token
 *     (`blob.generate-client-token`), and
 *   - VERCEL BLOB, reporting that the upload finished
 *     (`blob.upload-completed`), server-to-server, authenticated by an HMAC
 *     signature over the body and carrying no `Origin` or `Sec-Fetch-Site`.
 *
 * The rejected candidate applied a browser same-origin guard to every POST on
 * this route. A runtime probe shaped like the real callback returned
 * `{"code":"origin_required","status":403}` — meaning that on Vercel the
 * completion half of the state machine could never run, and the helper-level
 * tests that "proved" replacement worked proved nothing about production.
 *
 * These tests drive the real route handler and assert the split directly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createIntake } from '../src/lib/checkout-intake.ts';
import { listIntakeSlots } from '../src/lib/checkout-intake.ts';
import { reserveSlotUpload } from '../src/lib/checkout-intake-upload.ts';
import {
  handleIntakeUploadRequest,
  type IntakeUploadRouteDeps,
} from '../src/lib/checkout-intake-upload-route.ts';
import { createMemoryCheckoutGuardStore } from '../src/lib/checkout-request-guard.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const ORIGIN = 'https://herostorybooks.com';
const UPLOAD_URL = `${ORIGIN}/api/checkout/intake/upload`;
const HERO = { category: 'primary_hero_photo' } as const;

const ENV = {
  HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
} as NodeJS.ProcessEnv;

/**
 * Stands in for `@vercel/blob/client`'s `handleUpload`, reproducing only its
 * dispatch: token requests go to `onBeforeGenerateToken`, completions go to
 * `onUploadCompleted`. Signature verification is the SDK's job — what matters
 * here is whether our route lets the callback reach it at all.
 */
function fakeHandleUpload(record: {
  tokenOptions?: unknown;
  reached?: string[];
}): IntakeUploadRouteDeps['handleUpload'] {
  return (async ({ body, onBeforeGenerateToken, onUploadCompleted }) => {
    record.reached ??= [];
    if (body.type === 'blob.generate-client-token') {
      record.reached.push('token');
      const options = await onBeforeGenerateToken(
        body.payload.pathname,
        body.payload.clientPayload ?? null,
        body.payload.multipart ?? false,
      );
      record.tokenOptions = options;
      return { type: 'blob.generate-client-token', clientToken: 'fake-token' };
    }
    record.reached.push('completed');
    await onUploadCompleted?.(body.payload);
    return { type: 'blob.upload-completed', response: 'ok' };
  }) as IntakeUploadRouteDeps['handleUpload'];
}

function deps(store: MemoryIntakeStore, record: { tokenOptions?: unknown; reached?: string[] }): IntakeUploadRouteDeps {
  return {
    handleUpload: fakeHandleUpload(record),
    store,
    guardStore: createMemoryCheckoutGuardStore(),
    env: ENV,
    blobToken: 'vercel_blob_rw_test',
  };
}

function tokenRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(UPLOAD_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  });
}

/** No Origin, no Sec-Fetch-Site — exactly what Vercel Blob sends. */
function callbackRequest(body: unknown): Request {
  return new Request(UPLOAD_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vercel-signature': 'deadbeefcafe' },
    body: JSON.stringify(body),
  });
}

async function seedReservation(store: MemoryIntakeStore) {
  const session = await createIntake(store, { mediaAuthorizedAt: '2026-09-02T12:00:00.000Z' });
  const reservation = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/jpeg',
    size: 2048,
  });
  return { session, reservation };
}

function clientPayloadFor(
  session: { intakeId: string; capability: string },
  reservation: { slotKey: string; generation: number; reservationId: string },
): string {
  return JSON.stringify({
    intakeId: session.intakeId,
    capability: session.capability,
    slotKey: reservation.slotKey,
    generation: reservation.generation,
    reservationId: reservation.reservationId,
  });
}

test('a Vercel completion callback is NOT rejected for having no browser origin', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await seedReservation(store);
  store.putAsset({ pathname: reservation.pathname, mimeType: 'image/jpeg', size: 2048, etag: 'etag-1' });

  const calls: { tokenOptions?: unknown; reached?: string[] } = {};
  const response = await handleIntakeUploadRequest(
    callbackRequest({
      type: 'blob.upload-completed',
      payload: {
        blob: { pathname: reservation.pathname, contentType: 'image/jpeg', etag: 'etag-1', url: 'https://blob/x', downloadUrl: 'https://blob/x', contentDisposition: 'inline' },
        tokenPayload: reservation.tokenPayload,
      },
    }),
    deps(store, calls),
  );

  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(calls.reached, ['completed'], 'the callback reached handleUpload');

  const { slots } = await listIntakeSlots(store, session);
  assert.equal(slots[0]?.asset?.assetId, reservation.assetId, 'the completion actually activated the slot');
});

test('a browser token request without a same-origin header is still rejected', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await seedReservation(store);
  const calls: { reached?: string[] } = {};

  const response = await handleIntakeUploadRequest(
    new Request(UPLOAD_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'blob.generate-client-token',
        payload: {
          pathname: reservation.pathname,
          callbackUrl: UPLOAD_URL,
          clientPayload: clientPayloadFor(session, reservation),
          multipart: false,
        },
      }),
    }),
    deps(store, calls),
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'origin_required');
  assert.equal(calls.reached, undefined, 'handleUpload was never reached');
});

test('a token request is pinned to exactly the reserved pathname, type and size', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await seedReservation(store);
  const calls: { tokenOptions?: Record<string, unknown>; reached?: string[] } = {};

  const response = await handleIntakeUploadRequest(
    tokenRequest({
      type: 'blob.generate-client-token',
      payload: {
        pathname: reservation.pathname,
        callbackUrl: UPLOAD_URL,
        clientPayload: clientPayloadFor(session, reservation),
        multipart: false,
      },
    }),
    deps(store, calls),
  );

  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(calls.tokenOptions?.allowedContentTypes, ['image/jpeg']);
  assert.equal(calls.tokenOptions?.maximumSizeInBytes, 2048);
  assert.equal(calls.tokenOptions?.addRandomSuffix, false);
  assert.equal(calls.tokenOptions?.allowOverwrite, false, 'blind overwrite is never enabled');
});

test('a token request for a different pathname than the reservation is refused', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await seedReservation(store);
  const calls: { reached?: string[] } = {};

  const response = await handleIntakeUploadRequest(
    tokenRequest({
      type: 'blob.generate-client-token',
      payload: {
        pathname: `intakes/${session.intakeId}/assets/asset_${'0'.repeat(32)}`,
        callbackUrl: UPLOAD_URL,
        clientPayload: clientPayloadFor(session, reservation),
        multipart: false,
      },
    }),
    deps(store, calls),
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'asset_prefix_mismatch');
});

test('a token request for a superseded generation is refused', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await seedReservation(store);
  // The buyer reselects; the old token request arrives afterwards.
  await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/jpeg',
    size: 4096,
  });

  const response = await handleIntakeUploadRequest(
    tokenRequest({
      type: 'blob.generate-client-token',
      payload: {
        pathname: reservation.pathname,
        callbackUrl: UPLOAD_URL,
        clientPayload: clientPayloadFor(session, reservation),
        multipart: false,
      },
    }),
    deps(store, {}),
  );

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'upload_generation_superseded');
});

test('a token request with a wrong capability is refused', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await seedReservation(store);

  const response = await handleIntakeUploadRequest(
    tokenRequest({
      type: 'blob.generate-client-token',
      payload: {
        pathname: reservation.pathname,
        callbackUrl: UPLOAD_URL,
        clientPayload: clientPayloadFor(
          { intakeId: session.intakeId, capability: 'not-the-capability' },
          reservation,
        ),
        multipart: false,
      },
    }),
    deps(store, {}),
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'intake_forbidden');
});

test('the completion callback takes size and etag from storage, not from the callback body', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await seedReservation(store);
  // Storage says 2048 bytes; the callback body cannot claim otherwise because
  // it does not carry a size at all.
  store.putAsset({ pathname: reservation.pathname, mimeType: 'image/jpeg', size: 2048, etag: 'etag-real' });

  const response = await handleIntakeUploadRequest(
    callbackRequest({
      type: 'blob.upload-completed',
      payload: {
        blob: { pathname: reservation.pathname, contentType: 'image/jpeg', etag: 'etag-claimed', url: 'u', downloadUrl: 'u', contentDisposition: 'inline' },
        tokenPayload: reservation.tokenPayload,
      },
    }),
    deps(store, {}),
  );

  assert.equal(response.status, 200, await response.text());
  const { slots } = await listIntakeSlots(store, session);
  assert.equal(slots[0]?.asset?.size, 2048);
  assert.equal(slots[0]?.asset?.etag, 'etag-real');
});

test('a completion whose stored object contradicts the reservation is refused', async () => {
  const store = createMemoryIntakeStore();
  const { reservation } = await seedReservation(store);
  // Bytes landed, but they are not what was reserved.
  store.putAsset({ pathname: reservation.pathname, mimeType: 'image/png', size: 999, etag: 'etag-x' });

  const response = await handleIntakeUploadRequest(
    callbackRequest({
      type: 'blob.upload-completed',
      payload: {
        blob: { pathname: reservation.pathname, contentType: 'image/png', etag: 'etag-x', url: 'u', downloadUrl: 'u', contentDisposition: 'inline' },
        tokenPayload: reservation.tokenPayload,
      },
    }),
    deps(store, {}),
  );

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'asset_metadata_mismatch');
});

test('an unrecognised event type is refused before any state is touched', async () => {
  const store = createMemoryIntakeStore();
  const calls: { reached?: string[] } = {};
  const response = await handleIntakeUploadRequest(
    tokenRequest({ type: 'blob.something-else', payload: {} }),
    deps(store, calls),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'upload_event_invalid');
  assert.equal(calls.reached, undefined);
});

test('the route is absent unless the direct-upload flag is on', async () => {
  const store = createMemoryIntakeStore();
  const base = deps(store, {});
  const response = await handleIntakeUploadRequest(
    tokenRequest({ type: 'blob.generate-client-token', payload: {} }),
    { ...base, env: {} as NodeJS.ProcessEnv },
  );
  assert.equal(response.status, 404);
});

test('one issuance instant determines both token authorization and expiry', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await seedReservation(store);
  const calls: { tokenOptions?: Record<string, unknown>; reached?: string[] } = {};
  const issuedAt = new Date('2026-09-02T12:00:00.000Z');
  let clockCalls = 0;
  const routeDeps = deps(store, calls);
  routeDeps.now = () => {
    clockCalls += 1;
    // First read is the generic request budget; second is token issuance. A
    // third read would prove the old authorize/expiry split is still present.
    return clockCalls <= 2 ? issuedAt : new Date(issuedAt.getTime() + 120_000);
  };
  const response = await handleIntakeUploadRequest(tokenRequest({
    type: 'blob.generate-client-token',
    payload: {
      pathname: reservation.pathname, callbackUrl: UPLOAD_URL,
      clientPayload: clientPayloadFor(session, reservation), multipart: false,
    },
  }), routeDeps);
  assert.equal(response.status, 200, await response.text());
  assert.equal(calls.tokenOptions?.validUntil, issuedAt.getTime() + 5 * 60_000);
});
