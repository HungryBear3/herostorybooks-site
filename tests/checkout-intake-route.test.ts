/*
 * The browser-facing intake route: `POST /api/checkout/intake`.
 *
 * Everything the buyer's page does to the state machine goes through here —
 * create the intake, widen consent, reserve a slot generation, reconcile a
 * lost upload, list what is saved, remove a slot. Unlike the Vercel callback
 * route, EVERY action here is a browser mutation and is guarded as one.
 *
 * The reservation step lives here rather than inside the Blob token handler on
 * purpose: the server picks the destination pathname, tells the browser what
 * it is, and the token handler then only verifies. That is what lets the
 * upload token be issued with `allowOverwrite: false` and no negotiation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createIntake } from '../src/lib/checkout-intake.ts';
import { handleIntakeRequest, type IntakeRouteDeps } from '../src/lib/checkout-intake-route.ts';
import { createMemoryCheckoutGuardStore, guardBucketPath } from '../src/lib/checkout-request-guard.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const ORIGIN = 'https://herostorybooks.com';
const URL_ = `${ORIGIN}/api/checkout/intake`;
const ENV = { HSB_CHECKOUT_DIRECT_UPLOAD: 'true' } as NodeJS.ProcessEnv;

function deps(store: MemoryIntakeStore, env: NodeJS.ProcessEnv = ENV): IntakeRouteDeps {
  return { store, guardStore: createMemoryCheckoutGuardStore(), env };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function createSession(store: MemoryIntakeStore, routeDeps = deps(store)) {
  const response = await handleIntakeRequest(
    post({ action: 'create', consent: { mediaAuthorized: true } }),
    routeDeps,
  );
  const body = await json(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  return {
    routeDeps,
    intakeId: String(body.intakeId),
    capability: String(body.capability),
  };
}

test('the route does not exist unless the direct-upload flag is on', async () => {
  const store = createMemoryIntakeStore();
  const response = await handleIntakeRequest(
    post({ action: 'create', consent: { mediaAuthorized: true } }),
    deps(store, {} as NodeJS.ProcessEnv),
  );
  assert.equal(response.status, 404);
});

test('every action is guarded as a browser mutation', async () => {
  const store = createMemoryIntakeStore();
  const response = await handleIntakeRequest(
    new Request(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', consent: { mediaAuthorized: true } }),
    }),
    deps(store),
  );
  assert.equal(response.status, 403);
  assert.equal((await json(response)).error, 'origin_required');
});

test('create issues an intake and a capability, and consent timestamps are server-stamped', async () => {
  const store = createMemoryIntakeStore();
  const routeDeps = deps(store);
  const response = await handleIntakeRequest(
    post({
      action: 'create',
      consent: {
        mediaAuthorized: true,
        // A client-supplied timestamp must not be trusted or stored.
        mediaAuthorizedAt: '1999-01-01T00:00:00.000Z',
      },
    }),
    routeDeps,
  );
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.match(String(body.intakeId), /^intake_[a-f0-9]{32}$/);
  assert.equal(typeof body.capability, 'string');

  const stored = store.records.get(String(body.intakeId))!.record;
  assert.notEqual(stored.consent.mediaAuthorizedAt, '1999-01-01T00:00:00.000Z');
  assert.equal(stored.capabilityHash.length, 64);
  assert.equal(
    JSON.stringify(stored).includes(String(body.capability)),
    false,
    'the raw capability is never persisted',
  );
});

test('create refuses without media authorization', async () => {
  const store = createMemoryIntakeStore();
  const response = await handleIntakeRequest(
    post({ action: 'create', consent: { mediaAuthorized: false } }),
    deps(store),
  );
  assert.equal(response.status, 400);
  assert.equal((await json(response)).error, 'media_authorization_required');
});

test('reserve-upload returns the destination but never the callback token payload', async () => {
  const store = createMemoryIntakeStore();
  const session = await createSession(store);

  const response = await handleIntakeRequest(
    post({
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'primary_hero_photo' },
      mimeType: 'image/jpeg',
      size: 2048,
    }),
    session.routeDeps,
  );

  const body = await json(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.slotKey, 'primary_hero_photo');
  assert.equal(body.generation, 1);
  assert.match(String(body.pathname), new RegExp(`^intakes/${session.intakeId}/assets/asset_[a-f0-9]{32}$`));
  assert.equal(body.tokenPayload, undefined, 'the callback payload stays server-side');
  assert.equal(body.capabilityHash, undefined);

  const now = Date.now();
  const bucketStart = now - (now % 60_000);
  const stored = await session.routeDeps.guardStore!.read(guardBucketPath('intake', bucketStart));
  const bucket = stored!.record as unknown as Record<string, number>;
  assert.equal(bucket.requestCount, 2, 'create plus reserve cost exactly two request units');
  assert.equal(bucket.uploadReservations, 1);
  assert.equal(bucket.uploadBytes, 2048);
});

test('reserve-upload enforces the category MIME and size policy', async () => {
  const store = createMemoryIntakeStore();
  const session = await createSession(store);

  const badMime = await handleIntakeRequest(
    post({
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'primary_hero_photo' },
      mimeType: 'application/pdf',
      size: 2048,
    }),
    session.routeDeps,
  );
  assert.equal(badMime.status, 415);
  assert.equal((await json(badMime)).error, 'asset_mime_invalid');

  const tooBig = await handleIntakeRequest(
    post({
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'primary_hero_photo' },
      mimeType: 'image/jpeg',
      size: 64 * 1024 * 1024,
    }),
    session.routeDeps,
  );
  assert.equal(tooBig.status, 413);
});

test('reserve-upload refuses a voice note without child-voice consent', async () => {
  const store = createMemoryIntakeStore();
  const session = await createSession(store);

  const refused = await handleIntakeRequest(
    post({
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'voice_inspiration' },
      mimeType: 'audio/mp4',
      size: 2048,
    }),
    session.routeDeps,
  );
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).error, 'child_voice_authorization_required');

  // Widening consent unlocks it.
  const widened = await handleIntakeRequest(
    post({
      action: 'consent',
      intakeId: session.intakeId,
      capability: session.capability,
      consent: { childVoiceAuthorized: true, voiceSource: 'recorded' },
    }),
    session.routeDeps,
  );
  assert.equal(widened.status, 200, await widened.text());

  const allowed = await handleIntakeRequest(
    post({
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'voice_inspiration' },
      mimeType: 'audio/mp4',
      size: 2048,
    }),
    session.routeDeps,
  );
  assert.equal(allowed.status, 200, await allowed.text());
});

test('a rolled-back request clock cannot place voice consent before intake creation', async () => {
  const store = createMemoryIntakeStore();
  const guardStore = createMemoryCheckoutGuardStore();
  const createdAt = new Date('2042-03-04T12:00:00.000Z');
  const routeDeps: IntakeRouteDeps = { store, guardStore, env: ENV, now: () => createdAt };
  const session = await createSession(store, routeDeps);
  routeDeps.now = () => new Date('2042-03-04T11:00:00.000Z');

  const response = await handleIntakeRequest(post({
    action: 'consent', intakeId: session.intakeId, capability: session.capability,
    consent: { childVoiceAuthorized: true, voiceSource: 'uploaded' },
  }), routeDeps);
  assert.equal(response.status, 200, await response.text());
  const record = store.records.get(session.intakeId)!.record;
  assert.equal(record.consent.childVoiceAuthorizedAt, record.createdAt);
});

test('resolve-upload converges a lost callback only on an exact match', async () => {
  const store = createMemoryIntakeStore();
  const session = await createSession(store);
  const reserved = await json(await handleIntakeRequest(
    post({
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'primary_hero_photo' },
      mimeType: 'image/jpeg',
      size: 2048,
    }),
    session.routeDeps,
  ));

  const resolveBody = {
    action: 'resolve-upload',
    intakeId: session.intakeId,
    capability: session.capability,
    slot: { category: 'primary_hero_photo' },
    generation: reserved.generation,
  };

  // Nothing landed yet.
  const pending = await handleIntakeRequest(post(resolveBody), session.routeDeps);
  assert.equal((await json(pending)).status, 'pending');

  // Bytes landed, but they are not what was reserved.
  store.putAsset({ pathname: String(reserved.pathname), mimeType: 'image/png', size: 11, etag: 'e' });
  const mismatched = await handleIntakeRequest(post(resolveBody), session.routeDeps);
  assert.equal(mismatched.status, 409);
  assert.equal((await json(mismatched)).error, 'asset_metadata_mismatch');

  // Exactly what was reserved.
  store.putAsset({ pathname: String(reserved.pathname), mimeType: 'image/jpeg', size: 2048, etag: 'etag-real' });
  const converged = await handleIntakeRequest(post(resolveBody), session.routeDeps);
  const body = await json(converged);
  assert.equal(converged.status, 200, JSON.stringify(body));
  assert.equal(body.status, 'activated');
  assert.equal(typeof (body.asset as Record<string, unknown>)?.assetId, 'string');

  // And it is idempotent.
  const again = await handleIntakeRequest(post(resolveBody), session.routeDeps);
  assert.equal((await json(again)).status, 'idempotent');
});

test('resolve-upload for a superseded generation reports stale, not an error', async () => {
  const store = createMemoryIntakeStore();
  const session = await createSession(store);
  const first = await json(await handleIntakeRequest(
    post({
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'primary_hero_photo' },
      mimeType: 'image/jpeg',
      size: 2048,
    }),
    session.routeDeps,
  ));
  await handleIntakeRequest(
    post({
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'primary_hero_photo' },
      mimeType: 'image/jpeg',
      size: 4096,
    }),
    session.routeDeps,
  );

  const response = await handleIntakeRequest(
    post({
      action: 'resolve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'primary_hero_photo' },
      generation: first.generation,
    }),
    session.routeDeps,
  );
  assert.equal(response.status, 200);
  assert.equal((await json(response)).status, 'stale');
});

test('list shows only what the slots currently hold, and never the capability hash', async () => {
  const store = createMemoryIntakeStore();
  const session = await createSession(store);
  const reserved = await json(await handleIntakeRequest(
    post({
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'family_pet_reference', familyCharacterId: 'char-alice' },
      mimeType: 'image/jpeg',
      size: 2048,
    }),
    session.routeDeps,
  ));
  store.putAsset({ pathname: String(reserved.pathname), mimeType: 'image/jpeg', size: 2048, etag: 'etag-a' });
  await handleIntakeRequest(
    post({
      action: 'resolve-upload',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'family_pet_reference', familyCharacterId: 'char-alice' },
      generation: reserved.generation,
    }),
    session.routeDeps,
  );

  const listed = await json(await handleIntakeRequest(
    post({ action: 'list', intakeId: session.intakeId, capability: session.capability }),
    session.routeDeps,
  ));
  const slots = listed.slots as Array<Record<string, unknown>>;
  assert.equal(slots.length, 1);
  assert.equal(slots[0]!.slotKey, 'family_pet_reference:char-alice');
  assert.equal(slots[0]!.familyCharacterId, 'char-alice');
  assert.equal(typeof slots[0]!.assetId, 'string');
  assert.equal(slots[0]!.etag, undefined, 'storage validators stay server-side');
  assert.equal(JSON.stringify(listed).includes('capabilityHash'), false);

  // Remove it and the slot drops out of the listing.
  const released = await handleIntakeRequest(
    post({
      action: 'release',
      intakeId: session.intakeId,
      capability: session.capability,
      slot: { category: 'family_pet_reference', familyCharacterId: 'char-alice' },
    }),
    session.routeDeps,
  );
  assert.equal(released.status, 200);
  const after = await json(await handleIntakeRequest(
    post({ action: 'list', intakeId: session.intakeId, capability: session.capability }),
    session.routeDeps,
  ));
  assert.deepEqual(after.slots, []);
});

test('a wrong capability is refused on every addressed action', async () => {
  const store = createMemoryIntakeStore();
  const session = await createSession(store);
  for (const body of [
    { action: 'list', intakeId: session.intakeId, capability: 'nope' },
    {
      action: 'reserve-upload',
      intakeId: session.intakeId,
      capability: 'nope',
      slot: { category: 'primary_hero_photo' },
      mimeType: 'image/jpeg',
      size: 1024,
    },
    { action: 'release', intakeId: session.intakeId, capability: 'nope', slot: { category: 'primary_hero_photo' } },
  ]) {
    const response = await handleIntakeRequest(post(body), session.routeDeps);
    assert.equal(response.status, 403, JSON.stringify(body));
    assert.equal((await json(response)).error, 'intake_forbidden');
  }
});

test('an unknown action is refused', async () => {
  const store = createMemoryIntakeStore();
  const response = await handleIntakeRequest(post({ action: 'drop-everything' }), deps(store));
  assert.equal(response.status, 400);
  assert.equal((await json(response)).error, 'intake_action_invalid');
});

test('intake creation is bounded by the durable budget', async () => {
  const store = createMemoryIntakeStore();
  const routeDeps: IntakeRouteDeps = {
    ...deps(store),
    env: { ...ENV, HSB_CHECKOUT_GUARD_MAX_INTAKES_PER_MINUTE: '2' } as NodeJS.ProcessEnv,
  };

  for (let i = 0; i < 2; i += 1) {
    const ok = await handleIntakeRequest(
      post({ action: 'create', consent: { mediaAuthorized: true } }),
      routeDeps,
    );
    assert.equal(ok.status, 200);
  }
  const refused = await handleIntakeRequest(
    post({ action: 'create', consent: { mediaAuthorized: true } }),
    routeDeps,
  );
  assert.equal(refused.status, 429);
  assert.equal((await json(refused)).error, 'rate_limited');
});

test('a failed reservation CAS refunds the scarce upload budget', async () => {
  const now = new Date('2026-09-02T12:00:00.000Z');
  const store = createMemoryIntakeStore();
  const guardStore = createMemoryCheckoutGuardStore();
  const routeDeps: IntakeRouteDeps = { store, guardStore, env: ENV, now: () => now };
  const session = await createSession(store, routeDeps);
  store.failNextCas(5);
  const response = await handleIntakeRequest(post({
    action: 'reserve-upload', intakeId: session.intakeId, capability: session.capability,
    slot: { category: 'primary_hero_photo' }, mimeType: 'image/jpeg', size: 15 * 1024 * 1024,
  }), routeDeps);
  assert.equal(response.status, 409);
  assert.deepEqual(store.records.get(session.intakeId)!.record.slots, {});
  const bucketStart = now.getTime() - (now.getTime() % 60_000);
  const stored = await guardStore.read(guardBucketPath('intake', bucketStart));
  const bucket = stored!.record as unknown as Record<string, number>;
  assert.equal(bucket.requestCount, 2);
  assert.equal(bucket.uploadReservations, 0);
  assert.equal(bucket.uploadBytes, 0);
  assert.equal(bucket.replacementCount, 0);
});

test('production-shaped deps resolve one guard store for spend and refund', async () => {
  const now = new Date('2043-03-04T12:00:00.000Z');
  const base = createMemoryIntakeStore();
  const env = {
    ...ENV,
    HSB_CHECKOUT_ALLOW_PROCESS_LOCAL_GUARD: 'true',
    HSB_CHECKOUT_GUARD_MAX_UPLOADS_PER_MINUTE: '1',
  } as NodeJS.ProcessEnv;
  const session = await createIntake(base, { mediaAuthorizedAt: now.toISOString() }, now);
  let failCas = true;
  const store: MemoryIntakeStore = {
    ...base,
    async compareAndSwap(intakeId, etag, record) {
      if (failCas) return false;
      return base.compareAndSwap(intakeId, etag, record);
    },
  };
  const routeDeps: IntakeRouteDeps = { store, env, now: () => now };
  const body = {
    action: 'reserve-upload', intakeId: session.intakeId, capability: session.capability,
    slot: { category: 'primary_hero_photo' }, mimeType: 'image/jpeg', size: 1024,
  };
  assert.equal((await handleIntakeRequest(post(body), routeDeps)).status, 409);
  failCas = false;
  assert.equal((await handleIntakeRequest(post(body), routeDeps)).status, 200);
});
