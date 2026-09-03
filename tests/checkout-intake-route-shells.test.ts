/*
 * F8 — the actual Next route shells, and the difference between "absent" and
 * "unreadable".
 *
 * The previous suites drove `handleIntakeRequest` / `handleIntakeUploadRequest`
 * directly. That is real behavioural coverage of the request logic, but it is
 * NOT coverage of the exported route handlers: nothing imported
 * the route files under `src/app/api`, so their flag gate, dependency construction and
 * cron auth were unproven. (They could not even be imported by a test: they
 * used the `@/…` tsconfig alias, which the node test runner does not resolve.
 * The repo's other testable route — `api/cron/fulfillment-sweep` — uses
 * relative `.ts` imports for exactly this reason.)
 *
 * Separately: `headAsset` collapsed every provider failure to `null`. Absent
 * and unreadable are different answers — the first means "the upload has not
 * landed", the second means "we cannot tell", and reporting an outage as an
 * ordinary pending upload misleads both the retry logic and whoever is paged.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { POST as intakePost } from '../src/app/api/checkout/intake/route.ts';
import { POST as uploadPost } from '../src/app/api/checkout/intake/upload/route.ts';
import { GET as cronGet, POST as cronPost } from '../src/app/api/cron/checkout-intake-cleanup/route.ts';
import { createIntake, IntakeError, createVercelIntakeStore } from '../src/lib/checkout-intake.ts';
import { reserveSlotUpload, resolveSlotUpload } from '../src/lib/checkout-intake-upload.ts';
import { createMemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const ORIGIN = 'https://herostorybooks.com';
const INTAKE_TOKEN = 'vercel_blob_rw_IntakeStore01_intakesecret01';

function withEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function post(path: string, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// The exported route handlers
// ---------------------------------------------------------------------------

test('the intake route shell answers 404 while the feature flag is off', async () => {
  const response = await withEnv({ HSB_CHECKOUT_DIRECT_UPLOAD: undefined }, () => intakePost(
    post('/api/checkout/intake', { action: 'create', consent: { mediaAuthorized: true } }),
  ));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'not_found');
});

test('the intake route shell fails closed when the dedicated store is unconfigured', async () => {
  const response = await withEnv(
    { HSB_CHECKOUT_DIRECT_UPLOAD: 'true', HSB_INTAKE_BLOB_READ_WRITE_TOKEN: undefined },
    () => intakePost(post('/api/checkout/intake', { action: 'create', consent: { mediaAuthorized: true } })),
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'intake_store_unavailable');
});

test('the intake route shell fails closed when the store is misconfigured on Preview', async () => {
  const response = await withEnv(
    {
      HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
      HSB_INTAKE_BLOB_READ_WRITE_TOKEN: INTAKE_TOKEN,
      VERCEL_ENV: 'preview',
      HSB_BLOB_NAMESPACE: undefined,
    },
    () => intakePost(post('/api/checkout/intake', { action: 'create', consent: { mediaAuthorized: true } })),
  );
  assert.equal(response.status, 503);
});

test('the upload route shell answers 404 while the flag is off, and 503 without a store', async () => {
  const off = await withEnv({ HSB_CHECKOUT_DIRECT_UPLOAD: undefined }, () => uploadPost(
    post('/api/checkout/intake/upload', { type: 'blob.generate-client-token', payload: {} }),
  ));
  assert.equal(off.status, 404);

  const unconfigured = await withEnv(
    { HSB_CHECKOUT_DIRECT_UPLOAD: 'true', HSB_INTAKE_BLOB_READ_WRITE_TOKEN: undefined },
    () => uploadPost(post('/api/checkout/intake/upload', { type: 'blob.generate-client-token', payload: {} })),
  );
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json()).error, 'intake_store_unavailable');
});

test('the cleanup cron shell fails closed without a configured secret', async () => {
  const response = await withEnv({ CRON_SECRET: undefined }, () => cronPost(
    new Request(`${ORIGIN}/api/cron/checkout-intake-cleanup`, { method: 'POST' }),
  ));
  assert.equal(response.status, 503);
});

test('the cleanup cron shell rejects a wrong bearer', async () => {
  const response = await withEnv({ CRON_SECRET: 'right-secret' }, () => cronGet(
    new Request(`${ORIGIN}/api/cron/checkout-intake-cleanup`, {
      headers: { authorization: 'Bearer wrong-secret' },
    }),
  ));
  assert.equal(response.status, 401);
});

test('an authorised cleanup cron run is inert while the feature flag is off', async () => {
  const response = await withEnv(
    { CRON_SECRET: 'right-secret', HSB_CHECKOUT_DIRECT_UPLOAD: undefined },
    () => cronGet(new Request(`${ORIGIN}/api/cron/checkout-intake-cleanup`, {
      headers: { authorization: 'Bearer right-secret' },
    })),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.skipped, 'direct_upload_disabled');
});

test('an authorised cleanup cron run fails closed when the store is unconfigured', async () => {
  const response = await withEnv(
    {
      CRON_SECRET: 'right-secret',
      HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
      HSB_INTAKE_BLOB_READ_WRITE_TOKEN: undefined,
    },
    () => cronGet(new Request(`${ORIGIN}/api/cron/checkout-intake-cleanup`, {
      headers: { authorization: 'Bearer right-secret' },
    })),
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
});

// ---------------------------------------------------------------------------
// headAsset: absent vs unreadable
// ---------------------------------------------------------------------------

test('a missing object is absent; an unreadable one is a retryable outage', async () => {
  const notFound = Object.assign(new Error('The requested blob does not exist'), {
    name: 'BlobNotFoundError',
  });
  const outage = Object.assign(new Error('service unavailable'), { name: 'BlobServiceNotAvailable' });

  const absentStore = createVercelIntakeStore(INTAKE_TOKEN, {} as NodeJS.ProcessEnv, {
    head: async () => { throw notFound; },
  });
  assert.equal(await absentStore.headAsset('intakes/x'), null, 'absent is null');

  const brokenStore = createVercelIntakeStore(INTAKE_TOKEN, {} as NodeJS.ProcessEnv, {
    head: async () => { throw outage; },
  });
  await assert.rejects(
    brokenStore.headAsset('intakes/x'),
    (error) => error instanceof IntakeError
      && error.code === 'intake_store_unavailable'
      && error.status === 503,
  );
});

test('resolve-upload reports an outage as an outage, not as a pending upload', async () => {
  const store = createMemoryIntakeStore();
  const session = await createIntake(store, { mediaAuthorizedAt: '2026-09-02T12:00:00.000Z' });
  const reservation = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: { category: 'primary_hero_photo' },
    mimeType: 'image/jpeg',
    size: 1024,
  });

  // Genuinely absent: the upload has not landed yet.
  assert.equal(
    (await resolveSlotUpload(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'primary_hero_photo' },
      generation: reservation.generation,
    })).status,
    'pending',
  );

  // Unreadable: we cannot tell, and must not say "pending".
  store.failNextHead();
  await assert.rejects(
    resolveSlotUpload(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'primary_hero_photo' },
      generation: reservation.generation,
    }),
    (error) => error instanceof IntakeError && error.status === 503,
  );
});
