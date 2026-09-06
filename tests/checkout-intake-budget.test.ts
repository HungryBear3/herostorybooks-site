/*
 * F3 — the upload-byte ceiling has to be charged by a real route.
 *
 * Reproduced against the rejected candidate: `COST_BY_ACTION` for
 * `reserve-upload` listed `uploadReservations` and `replacementCount` but not
 * `uploadBytes`, even though the declared size was right there in the body. A
 * 15 MiB reservation recorded `uploadReservations=1, uploadBytes=0`, so the
 * configured 120 MiB/minute ceiling constrained nothing at all.
 *
 * CONTROLLER RULING IMPLEMENTED HERE
 * ----------------------------------
 * Bytes are charged ONCE, at reservation, against the DECLARED reserved size:
 *
 *   - Reservation capacity is the thing that costs — a reservation authorises
 *     an upload of that size whether or not the bytes ever arrive — so an
 *     abandoned reservation is still charged.
 *   - `uploadReservations`, `uploadBytes` and `replacementCount` are all
 *     charged at that one point.
 *   - Token issuance charges request count only; charging again there would
 *     double-count the same upload.
 *   - Callback completion charges its own authenticated request work and never
 *     re-charges the reserved bytes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { handleIntakeRequest, type IntakeRouteDeps } from '../src/lib/checkout-intake-route.ts';
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
const INTAKE_URL = `${ORIGIN}/api/checkout/intake`;
const UPLOAD_URL = `${ORIGIN}/api/checkout/intake/upload`;
const MIB = 1024 * 1024;

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { HSB_CHECKOUT_DIRECT_UPLOAD: 'true', ...overrides } as NodeJS.ProcessEnv;
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      ...(url === UPLOAD_URL ? {} : {}),
    },
    body: JSON.stringify(body),
  });
}

async function bucket(
  guardStore: CheckoutGuardStore,
  scope: string,
  now: number,
): Promise<CheckoutGuardBucket | null> {
  const entry = await guardStore.read(guardBucketPath(scope, now - (now % 60_000)));
  return (entry?.record as CheckoutGuardBucket) ?? null;
}

function deps(store: MemoryIntakeStore, guardStore: CheckoutGuardStore, e = env()): IntakeRouteDeps {
  return { store, guardStore, env: e, now: () => new Date(60_000) };
}

async function createSession(routeDeps: IntakeRouteDeps) {
  const response = await handleIntakeRequest(
    post(INTAKE_URL, { action: 'create', consent: { mediaAuthorized: true } }),
    routeDeps,
  );
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200, JSON.stringify(body));
  return { intakeId: String(body.intakeId), capability: String(body.capability) };
}

test('a 15 MiB reservation charges 15 MiB to the durable bucket', async () => {
  const store = createMemoryIntakeStore();
  const guardStore = createMemoryCheckoutGuardStore();
  const routeDeps = deps(store, guardStore);
  const session = await createSession(routeDeps);

  const response = await handleIntakeRequest(
    post(INTAKE_URL, {
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'primary_hero_photo' },
      mimeType: 'image/jpeg',
      size: 15 * MIB,
    }),
    routeDeps,
  );
  assert.equal(response.status, 200, await response.text());

  const spent = await bucket(guardStore, 'intake', 60_000);
  assert.equal(spent?.uploadBytes, 15 * MIB, 'the declared size must reach the durable counter');
  assert.equal(spent?.uploadReservations, 1);
  assert.equal(spent?.replacementCount, 1);
});

test('a wrong capability cannot spend upload capacity claimed in its body', async () => {
  const store = createMemoryIntakeStore();
  const guardStore = createMemoryCheckoutGuardStore();
  const routeDeps = deps(store, guardStore);
  const session = await createSession(routeDeps);
  const before = await bucket(guardStore, 'intake', 60_000);

  const response = await handleIntakeRequest(
    post(INTAKE_URL, {
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: 'wrong-capability',
      slot: { category: 'primary_hero_photo' },
      mimeType: 'image/jpeg',
      size: 15 * MIB,
    }),
    routeDeps,
  );
  assert.equal(response.status, 403);
  const spent = await bucket(guardStore, 'intake', 60_000);
  assert.equal(spent?.uploadBytes, 0);
  assert.equal(spent?.uploadReservations, 0);
  assert.equal(spent?.replacementCount, 0);
  assert.equal(
    spent?.requestCount,
    (before?.requestCount ?? 0) + 1,
    'rejected traffic still costs exactly one request unit',
  );
});

test('crossing the byte ceiling refuses BEFORE the reservation is written', async () => {
  const store = createMemoryIntakeStore();
  const guardStore = createMemoryCheckoutGuardStore();
  const routeDeps = deps(store, guardStore, env({
    HSB_CHECKOUT_GUARD_MAX_UPLOAD_BYTES_PER_MINUTE: String(10 * MIB),
  }));
  const session = await createSession(routeDeps);

  const response = await handleIntakeRequest(
    post(INTAKE_URL, {
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'primary_hero_photo' },
      mimeType: 'image/jpeg',
      size: 15 * MIB,
    }),
    routeDeps,
  );

  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, 'rate_limited');
  const record = store.records.get(session.intakeId)!.record;
  assert.deepEqual(record.slots, {}, 'no slot was reserved');
  const spent = await bucket(guardStore, 'intake', 60_000);
  assert.equal(spent?.uploadBytes, 0, 'a refused spend is not banked');
});

test('an abandoned reservation still costs its declared bytes', async () => {
  const store = createMemoryIntakeStore();
  const guardStore = createMemoryCheckoutGuardStore();
  const routeDeps = deps(store, guardStore, env({
    HSB_CHECKOUT_GUARD_MAX_UPLOAD_BYTES_PER_MINUTE: String(20 * MIB),
  }));
  const session = await createSession(routeDeps);

  const reserve = () => handleIntakeRequest(
    post(INTAKE_URL, {
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'primary_hero_photo' },
      mimeType: 'image/jpeg',
      size: 15 * MIB,
    }),
    routeDeps,
  );

  assert.equal((await reserve()).status, 200);
  // The first upload is abandoned; reserving again must not be free.
  assert.equal((await reserve()).status, 429);
  const spent = await bucket(guardStore, 'intake', 60_000);
  assert.equal(spent?.uploadBytes, 15 * MIB);
});

test('token issuance does not re-charge the reservation or its bytes', async () => {
  const store = createMemoryIntakeStore();
  const guardStore = createMemoryCheckoutGuardStore();
  const routeDeps = deps(store, guardStore);
  const session = await createSession(routeDeps);

  const reserved = await (await handleIntakeRequest(
    post(INTAKE_URL, {
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'primary_hero_photo' },
      mimeType: 'image/jpeg',
      size: 4 * MIB,
    }),
    routeDeps,
  )).json() as Record<string, unknown>;

  const uploadDeps: IntakeUploadRouteDeps = {
    handleUpload: (async ({ body, onBeforeGenerateToken }) => {
      await onBeforeGenerateToken(
        (body as { payload: { pathname: string } }).payload.pathname,
        (body as { payload: { clientPayload: string } }).payload.clientPayload,
        false,
      );
      return { type: 'blob.generate-client-token', clientToken: 'tok' };
    }) as IntakeUploadRouteDeps['handleUpload'],
    store,
    guardStore,
    env: env(),
    blobToken: 'vercel_blob_rw_StoreAbcdefgh_secretsecret',
    now: () => new Date(60_000),
  };

  const response = await handleIntakeUploadRequest(
    post(UPLOAD_URL, {
      type: 'blob.generate-client-token',
      payload: {
        pathname: reserved.pathname,
        callbackUrl: UPLOAD_URL,
        clientPayload: JSON.stringify({
          intakeId: session.intakeId,
          capability: session.capability,
          slotKey: reserved.slotKey,
          generation: reserved.generation,
          reservationId: reserved.reservationId,
        }),
        multipart: false,
      },
    }),
    uploadDeps,
  );
  assert.equal(response.status, 200, await response.text());

  const tokenScope = await bucket(guardStore, 'intake-upload', 60_000);
  assert.equal(tokenScope?.requestCount, 1, 'token issuance costs a request');
  assert.equal(tokenScope?.uploadBytes, 0, 'and nothing else — the bytes were charged at reservation');
  assert.equal(tokenScope?.uploadReservations, 0);

  const reserveScope = await bucket(guardStore, 'intake', 60_000);
  assert.equal(reserveScope?.uploadBytes, 4 * MIB, 'charged exactly once, at reservation');
});
