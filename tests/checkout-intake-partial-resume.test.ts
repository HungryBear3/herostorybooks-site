/**
 * Resuming a direct-upload checkout that died part-way through the batch.
 *
 * THE FAILURE THIS SUITE EXISTS FOR
 * --------------------------------
 * A buyer on a phone picks four photos and records a voice note. The four
 * photos land. The voice note dies on the fifth request. Today the page throws
 * away EVERYTHING — the intake, the capability, and the four objects the
 * server already holds — because the preparation state is only kept once the
 * whole batch succeeds. Pressing Continue again re-creates an intake and
 * re-uploads all five files over the same bad connection that just failed.
 *
 * So the second attempt is slower and less likely to succeed than the first,
 * on exactly the connection least able to afford it.
 *
 * WHAT IS BEING PINNED
 * --------------------
 *   • the preparation state exists from the moment a session does, not from
 *     the moment the batch finishes;
 *   • a retry with the SAME File objects reuses the same intake and skips the
 *     exact slots the server already confirmed;
 *   • a `transport.upload` that THROWS is reconciled against the immutable
 *     reserved path before it is called a failure — bytes that landed are not
 *     re-sent, and bytes that did not are still a failure;
 *   • any change to the media invalidates the whole partial state;
 *   • two Continues make one intake and one upload per slot;
 *   • the capability stays in memory and nowhere else.
 *
 * Everything below drives the REAL `POST /api/checkout/intake` handler and the
 * REAL server-side token authorization / completion path. The only double is
 * the Blob upload call itself, which is the injected transport boundary.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { handleIntakeRequest, type IntakeRouteDeps } from '../src/lib/checkout-intake-route.ts';
import { createMemoryCheckoutGuardStore } from '../src/lib/checkout-request-guard.ts';
import { authorizeReservedUpload, completeSlotUpload } from '../src/lib/checkout-intake-upload.ts';
import { createIntakeClientState } from '../src/lib/checkout-intake-client.ts';
import {
  applyPrimaryAndSupportingMediaToOrderPayload,
  assertDirectIntakeAttemptAuthorityIsCurrent,
  assertDirectIntakeResultIsCurrent,
  captureDirectIntakeAttemptAuthority,
  createCheckoutIntakeSession,
  createDirectIntakePreparation,
  createSlotStateStore,
  invalidateDirectIntakeMediaSelection,
  prepareOrReuseDirectIntakeSubmission,
  releaseSlotFile,
  uploadSlotFile,
  type DirectIntakePreparation,
  type DirectIntakeSubmissionCache,
  type IntakeClientTransport,
  type PrepareDirectIntakeSubmissionParams,
  type PreparedDirectIntake,
  type SlotStateStore,
} from '../src/lib/checkout-intake-client-flow.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';
import { processEnv } from './support/process-env.ts';

const ORIGIN = 'https://preview.herostorybooks.test';
const ENV = processEnv({ HSB_CHECKOUT_DIRECT_UPLOAD: 'true' });
const NANA = 'supporting-nana-0001';
const UNCLE = 'supporting-uncle-0002';

/** Where in the upload a simulated connection loss happens. */
type UploadFailureMode =
  /** Nothing reached the provider. Nothing is on the reserved path. */
  | 'before_bytes'
  /** Bytes landed on the reserved path; the completion callback never ran. */
  | 'after_bytes'
  /** Bytes landed WRONG (truncated) and the callback never ran. */
  | 'after_bytes_mismatched'
  /** Bytes landed AND the authenticated callback committed; the response died. */
  | 'after_commit';

interface Rig {
  transport: IntakeClientTransport;
  store: MemoryIntakeStore;
  state: SlotStateStore;
  /** The next upload for `slotKey` dies in the given way. */
  failUploadForSlot(slotKey: string, mode: UploadFailureMode): void;
  /** Runs between the bytes landing and the completion callback, once. */
  beforeNextCommit(hook: (slotKey: string) => void | Promise<void>): void;
  /** Runs once while the next intake call of `action` is still in flight. */
  duringIntake(action: string, hook: () => void | Promise<void>): void;
  uploads: number;
  reserves: number;
  creates: number;
  resolves: number;
  /** Slot key of every Blob upload the page issued, in order. */
  uploadedSlotKeys: string[];
}

function rig(): Rig {
  const store = createMemoryIntakeStore();
  const deps: IntakeRouteDeps = { store, guardStore: createMemoryCheckoutGuardStore(), env: ENV };
  const counters = { uploads: 0, reserves: 0, creates: 0, resolves: 0 };
  const uploadedSlotKeys: string[] = [];
  const failures = new Map<string, UploadFailureMode>();
  const duringIntake = new Map<string, () => void | Promise<void>>();
  let beforeCommit: ((slotKey: string) => void | Promise<void>) | null = null;

  const transport: IntakeClientTransport = {
    async intake(body) {
      const action = (body as { action?: string }).action;
      if (action === 'reserve-upload') counters.reserves += 1;
      if (action === 'create') counters.creates += 1;
      if (action === 'resolve-upload') counters.resolves += 1;
      const response = await handleIntakeRequest(new Request(`${ORIGIN}/api/checkout/intake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify(body),
      }), deps);
      const parsed = { ok: response.ok, status: response.status, body: await response.json() as Record<string, unknown> };
      // The buyer acting while this very request is still outstanding.
      const hook = duringIntake.get(action ?? '');
      if (hook) {
        duringIntake.delete(action ?? '');
        await hook();
      }
      return parsed;
    },

    async upload({ pathname, clientPayload, contentType, file }) {
      counters.uploads += 1;
      const payload = JSON.parse(clientPayload) as {
        intakeId: string; capability: string; slotKey: string; generation: number; reservationId: string;
      };
      uploadedSlotKeys.push(payload.slotKey);
      const mode = failures.get(payload.slotKey);
      if (mode) failures.delete(payload.slotKey);
      if (mode === 'before_bytes') throw new Error('network lost before any bytes');

      const size = typeof (file as Blob).size === 'number' ? (file as Blob).size : 1;
      const etag = `etag-${pathname.slice(-8)}`;
      // The REAL server-side authorization for this exact reservation.
      const authorization = await authorizeReservedUpload(store, { ...payload, pathname }, new Date());
      if (mode === 'after_bytes_mismatched') {
        store.putAsset({ pathname, mimeType: contentType, size: size + 1, etag });
        throw new Error('connection reset after a truncated write');
      }
      store.putAsset({ pathname, mimeType: contentType, size, etag });
      if (mode === 'after_bytes') throw new Error('connection reset before the callback');
      if (beforeCommit) {
        const hook = beforeCommit;
        beforeCommit = null;
        await hook(payload.slotKey);
      }
      // The REAL authenticated completion callback.
      await completeSlotUpload(store, {
        tokenPayload: authorization.tokenPayload,
        blob: { pathname, contentType, size, etag },
      }, new Date());
      if (mode === 'after_commit') throw new Error('connection reset after the callback committed');
    },
  };

  return {
    transport,
    store,
    state: createSlotStateStore(createIntakeClientState()),
    failUploadForSlot(slotKey, mode) { failures.set(slotKey, mode); },
    beforeNextCommit(hook) { beforeCommit = hook; },
    duringIntake(action, hook) { duringIntake.set(action, hook); },
    get uploads() { return counters.uploads; },
    get reserves() { return counters.reserves; },
    get creates() { return counters.creates; },
    get resolves() { return counters.resolves; },
    get uploadedSlotKeys() { return uploadedSlotKeys; },
  } as Rig;
}

function jpeg(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
}

function voiceNote(bytes: number): File {
  return new File([new Uint8Array(bytes)], 'bedtime.m4a', { type: 'audio/mp4' });
}

/** The exact batch the failure report describes: four photos and a voice note. */
function fiveAssetParams(r: Rig, files: {
  hero: Blob; nana: Blob; uncle: Blob; guided: Blob; voice: Blob;
}): PrepareDirectIntakeSubmissionParams {
  return {
    enabled: true,
    transport: r.transport,
    heroPhoto: files.hero,
    familyCharacterIds: [NANA, UNCLE],
    familyPhotos: [
      { familyCharacterId: NANA, file: files.nana, mimeType: 'image/jpeg' },
      { familyCharacterId: UNCLE, file: files.uncle, mimeType: 'image/jpeg' },
    ],
    guidedStills: [{ file: files.guided, mimeType: 'image/jpeg' }],
    voice: { file: files.voice, source: 'recorded', consent: true, mimeType: 'audio/mp4' },
    document: null,
  };
}

function freshFiveFiles() {
  return { hero: jpeg(10), nana: jpeg(11), uncle: jpeg(12), guided: jpeg(13), voice: voiceNote(14) };
}

/** How many assets the server holds as active across EVERY intake it has. */
function totalActiveAssets(r: Rig): number {
  let count = 0;
  for (const entry of r.store.records.values()) {
    for (const slot of Object.values(entry.record.slots)) if (slot.active) count += 1;
  }
  return count;
}

/** Every slot the server currently holds as active, keyed by slot key. */
function activeAssetIds(r: Rig, intakeId: string): Record<string, string> {
  const record = r.store.records.get(intakeId)!.record;
  const out: Record<string, string> = {};
  for (const [slotKey, slot] of Object.entries(record.slots)) {
    if (slot.active) out[slotKey] = slot.active.assetId;
  }
  return out;
}

// ---------------------------------------------------------------------------
// (1) The preparation exists as soon as the session does.
// ---------------------------------------------------------------------------

test('the intake session is preserved the moment it exists, not only after the batch succeeds', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const hero = jpeg(21);
  const params: PrepareDirectIntakeSubmissionParams = {
    enabled: true,
    transport: r.transport,
    heroPhoto: hero,
    familyPhotos: [],
    guidedStills: [],
    voice: null,
  };
  // The very FIRST upload dies, so nothing has ever succeeded.
  r.failUploadForSlot('primary_hero_photo', 'before_bytes');

  await assert.rejects(
    prepareOrReuseDirectIntakeSubmission(params, null, { preparation }),
    /upload_failed/,
  );

  assert.ok(preparation.session, 'the session survives a batch that never saved anything');
  assert.equal(r.creates, 1);
  const intakeId = preparation.session!.intakeId;

  const retry = await prepareOrReuseDirectIntakeSubmission(params, null, { preparation });

  assert.ok(retry);
  assert.equal(r.creates, 1, 'the retry reuses the same intake rather than creating a second');
  assert.equal(retry!.submission.session.intakeId, intakeId);
  assert.equal(r.uploads, 2, 'the one unsaved slot is retried, and only it');
});

// ---------------------------------------------------------------------------
// (a) Four photos saved, the voice note fails, the retry sends only the voice.
// ---------------------------------------------------------------------------

test('a voice note that fails after four saved photos retries only the voice note', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const files = freshFiveFiles();
  const params = fiveAssetParams(r, files);
  r.failUploadForSlot('voice_inspiration', 'before_bytes');

  await assert.rejects(
    prepareOrReuseDirectIntakeSubmission(params, null, { preparation }),
    /upload_failed/,
  );
  assert.equal(r.uploads, 5, 'the first attempt uploaded all five');
  assert.equal(r.creates, 1);
  const intakeId = preparation.session!.intakeId;

  const retry = await prepareOrReuseDirectIntakeSubmission(params, null, { preparation });

  assert.ok(retry);
  assert.equal(r.creates, 1, 'the same intake and capability are reused');
  assert.equal(retry!.submission.session.intakeId, intakeId);
  assert.equal(r.uploads, 6, 'exactly one more upload: the voice note');
  assert.equal(r.reserves, 6, 'the four saved slots are not re-reserved either');
  assert.deepEqual(
    r.uploadedSlotKeys.slice(5),
    ['voice_inspiration'],
    'the second attempt touches the voice slot and nothing else',
  );

  // The canonical selection is exactly the one a clean single pass produces.
  const active = activeAssetIds(r, intakeId);
  assert.deepEqual(retry!.submission.selection, {
    primaryHeroPhotoAssetId: active.primary_hero_photo,
    familyCharacterAssets: [
      { assetId: active[`family_pet_reference:${NANA}`]!, familyCharacterId: NANA },
      { assetId: active[`family_pet_reference:${UNCLE}`]!, familyCharacterId: UNCLE },
    ],
    guidedStillAssetIds: [active['guided_still:0']!],
    voiceAssetId: active.voice_inspiration,
    documentAssetId: null,
  });
  assert.equal(Object.keys(active).length, 5, 'five assets, one per expected slot');
});

// ---------------------------------------------------------------------------
// (b) The upload threw, but the callback had already committed.
// ---------------------------------------------------------------------------

test('an upload that throws after the callback committed reconciles to saved without a second upload', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const hero = jpeg(31);
  r.failUploadForSlot('primary_hero_photo', 'after_commit');

  const prepared = await prepareOrReuseDirectIntakeSubmission({
    enabled: true,
    transport: r.transport,
    heroPhoto: hero,
    familyPhotos: [],
    guidedStills: [],
    voice: null,
  }, null, { preparation });

  assert.ok(prepared, 'a committed object is a saved photo, not a failure');
  assert.equal(r.uploads, 1, 'the bytes are never sent twice');
  const active = activeAssetIds(r, prepared!.submission.session.intakeId);
  assert.equal(prepared!.submission.selection.primaryHeroPhotoAssetId, active.primary_hero_photo);
});

test('an upload that throws after the bytes landed is reconciled from the reserved path', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const hero = jpeg(32);
  r.failUploadForSlot('primary_hero_photo', 'after_bytes');

  const prepared = await prepareOrReuseDirectIntakeSubmission({
    enabled: true,
    transport: r.transport,
    heroPhoto: hero,
    familyPhotos: [],
    guidedStills: [],
    voice: null,
  }, null, { preparation });

  assert.ok(prepared);
  assert.equal(r.uploads, 1);
  assert.ok(r.resolves >= 1, 'the reserved path is reconciled rather than re-uploaded');
});

// ---------------------------------------------------------------------------
// (c) The upload threw and the object cannot be proven. Fail closed.
// ---------------------------------------------------------------------------

test('an upload that throws with nothing on the reserved path still fails closed', async () => {
  const r = rig();
  const session = await createCheckoutIntakeSession(r.transport, { mediaAuthorized: true });
  r.failUploadForSlot('primary_hero_photo', 'before_bytes');

  const outcome = await uploadSlotFile(r.transport, r.state, {
    session,
    slot: { category: 'primary_hero_photo' },
    file: jpeg(33),
    mimeType: 'image/jpeg',
    size: 33,
    resolve: { attempts: 2, delayMs: 1 },
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.status === 'failed' && outcome.code, 'upload_failed');
  assert.notEqual(r.state.get().slots.primary_hero_photo!.state, 'saved');
  assert.equal(activeAssetIds(r, session.intakeId).primary_hero_photo, undefined);
});

test('an upload that throws leaving a mismatched object fails closed instead of claiming it', async () => {
  const r = rig();
  const session = await createCheckoutIntakeSession(r.transport, { mediaAuthorized: true });
  r.failUploadForSlot('primary_hero_photo', 'after_bytes_mismatched');

  const outcome = await uploadSlotFile(r.transport, r.state, {
    session,
    slot: { category: 'primary_hero_photo' },
    file: jpeg(34),
    mimeType: 'image/jpeg',
    size: 34,
    resolve: { attempts: 2, delayMs: 1 },
  });

  assert.equal(outcome.status, 'failed');
  assert.notEqual(r.state.get().slots.primary_hero_photo!.state, 'saved');
  assert.equal(activeAssetIds(r, session.intakeId).primary_hero_photo, undefined);
});

// ---------------------------------------------------------------------------
// (6) Fencing survives the new reconciliation path.
// ---------------------------------------------------------------------------

test('a slot emptied while its upload was dying is never repainted by reconciliation', async () => {
  const r = rig();
  const session = await createCheckoutIntakeSession(r.transport, { mediaAuthorized: true });
  r.failUploadForSlot('primary_hero_photo', 'after_commit');
  // The buyer hits Remove between the bytes landing and the callback.
  r.beforeNextCommit(async () => {
    await releaseSlotFile(r.transport, r.state, {
      session,
      slot: { category: 'primary_hero_photo' },
    });
  });

  const outcome = await uploadSlotFile(r.transport, r.state, {
    session,
    slot: { category: 'primary_hero_photo' },
    file: jpeg(35),
    mimeType: 'image/jpeg',
    size: 35,
    resolve: { attempts: 2, delayMs: 1 },
  });

  assert.equal(outcome.status, 'superseded');
  assert.notEqual(r.state.get().slots.primary_hero_photo!.state, 'saved');
});

// ---------------------------------------------------------------------------
// (d) A changed selection invalidates the whole partial state.
// ---------------------------------------------------------------------------

test('a replaced file between tries discards the partial state instead of reusing it', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const files = freshFiveFiles();
  r.failUploadForSlot('voice_inspiration', 'before_bytes');
  await assert.rejects(
    prepareOrReuseDirectIntakeSubmission(fiveAssetParams(r, files), null, { preparation }),
    /upload_failed/,
  );
  const abandoned = preparation.session!.intakeId;

  // The buyer swaps the hero photo before pressing Continue again.
  const changed = { ...files, hero: jpeg(99) };
  const retry = await prepareOrReuseDirectIntakeSubmission(fiveAssetParams(r, changed), null, { preparation });

  assert.ok(retry);
  assert.notEqual(retry!.submission.session.intakeId, abandoned, 'a changed batch gets a fresh intake');
  assert.equal(r.creates, 2);
  assert.equal(r.uploads, 10, 'nothing from the abandoned batch is reused');
  const reused = Object.values(activeAssetIds(r, abandoned));
  const selected = JSON.stringify(retry!.submission.selection);
  for (const assetId of reused) {
    assert.equal(selected.includes(assetId), false, 'no asset from the abandoned intake survives');
  }
});

test('a changed family mapping between tries discards the partial state', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const files = freshFiveFiles();
  r.failUploadForSlot('voice_inspiration', 'before_bytes');
  await assert.rejects(
    prepareOrReuseDirectIntakeSubmission(fiveAssetParams(r, files), null, { preparation }),
    /upload_failed/,
  );
  const abandoned = preparation.session!.intakeId;

  // Same photo bytes, different person. Reusing the saved slot would bind
  // Nana's photo to a character the buyer never pointed it at.
  const remapped = fiveAssetParams(r, files);
  remapped.familyCharacterIds = [NANA, 'supporting-cousin-0003'];
  remapped.familyPhotos = [
    { familyCharacterId: NANA, file: files.nana, mimeType: 'image/jpeg' },
    { familyCharacterId: 'supporting-cousin-0003', file: files.uncle, mimeType: 'image/jpeg' },
  ];

  const retry = await prepareOrReuseDirectIntakeSubmission(remapped, null, { preparation });

  assert.ok(retry);
  assert.notEqual(retry!.submission.session.intakeId, abandoned);
  // Canonical order is by character id, not by form position.
  assert.deepEqual(
    retry!.submission.selection.familyCharacterAssets.map((entry) => entry.familyCharacterId),
    ['supporting-cousin-0003', NANA],
  );
  // Nana's photo is the SAME file as before; the cousin's is the file that
  // used to be Uncle's. Neither may carry an asset id from the dead intake.
  const stranded = Object.values(activeAssetIds(r, abandoned));
  const selected = JSON.stringify(retry!.submission.selection);
  for (const assetId of stranded) assert.equal(selected.includes(assetId), false);
});

test('a completed batch still refuses changed media with the reload requirement', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const hero = jpeg(41);
  const params: PrepareDirectIntakeSubmissionParams = {
    enabled: true,
    transport: r.transport,
    heroPhoto: hero,
    familyPhotos: [],
    guidedStills: [],
    voice: null,
  };
  const first = await prepareOrReuseDirectIntakeSubmission(params, null, { preparation });
  assert.ok(first);

  await assert.rejects(
    prepareOrReuseDirectIntakeSubmission({ ...params, heroPhoto: jpeg(42) }, first!.cache, { preparation }),
    /direct_upload_selection_changed_reload_required/,
  );
  assert.equal(r.uploads, 1, 'a frozen attempt is never silently rebuilt');
});

// ---------------------------------------------------------------------------
// (e) Two Continues.
// ---------------------------------------------------------------------------

test('two concurrent Continues create one intake and upload each slot exactly once', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const files = freshFiveFiles();
  const params = fiveAssetParams(r, files);

  const [first, second] = await Promise.all([
    prepareOrReuseDirectIntakeSubmission(params, null, { preparation }),
    prepareOrReuseDirectIntakeSubmission(params, null, { preparation }),
  ]);

  assert.ok(first);
  assert.ok(second);
  assert.equal(r.creates, 1, 'one intake');
  assert.equal(r.uploads, 5, 'one upload per slot');
  assert.equal(new Set(r.uploadedSlotKeys).size, 5, 'no slot uploaded twice');
  assert.equal(first!.submission, second!.submission, 'both Continues see the same submission');
});

test('a second Continue while the first is still failing does not double-upload the saved slots', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const files = freshFiveFiles();
  const params = fiveAssetParams(r, files);
  r.failUploadForSlot('voice_inspiration', 'before_bytes');

  const failing = prepareOrReuseDirectIntakeSubmission(params, null, { preparation });
  const joined = prepareOrReuseDirectIntakeSubmission(params, null, { preparation });

  await assert.rejects(failing, /upload_failed/);
  await assert.rejects(joined, /upload_failed/);
  assert.equal(r.creates, 1);
  assert.equal(r.uploads, 5, 'the joined Continue rides the in-flight preparation');

  const retry = await prepareOrReuseDirectIntakeSubmission(params, null, { preparation });
  assert.ok(retry);
  assert.equal(r.uploads, 6);
});

// ---------------------------------------------------------------------------
// (f) The capability stays in memory.
// ---------------------------------------------------------------------------

test('the capability never reaches storage, logs, serialization, or the order payload', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const files = freshFiveFiles();
  const params = fiveAssetParams(r, files);

  const storageCalls: string[] = [];
  const logged: string[] = [];
  const fakeStorage = (name: string) => ({
    getItem: (key: string) => { storageCalls.push(`${name}.getItem:${key}`); return null; },
    setItem: (key: string, value: string) => { storageCalls.push(`${name}.setItem:${key}=${value}`); },
    removeItem: (key: string) => { storageCalls.push(`${name}.removeItem:${key}`); },
    clear: () => { storageCalls.push(`${name}.clear`); },
    key: () => null,
    length: 0,
  });
  const globals = globalThis as Record<string, unknown>;
  const restore: Array<() => void> = [];
  for (const name of ['localStorage', 'sessionStorage']) {
    const had = Object.prototype.hasOwnProperty.call(globals, name);
    const previous = globals[name];
    Object.defineProperty(globals, name, { value: fakeStorage(name), configurable: true, writable: true });
    restore.push(() => {
      if (had) Object.defineProperty(globals, name, { value: previous, configurable: true, writable: true });
      else delete globals[name];
    });
  }
  const console_ = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console_[method]!;
    console_[method] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    restore.push(() => { console_[method] = original; });
  }

  let prepared;
  try {
    r.failUploadForSlot('voice_inspiration', 'before_bytes');
    await assert.rejects(prepareOrReuseDirectIntakeSubmission(params, null, { preparation }), /upload_failed/);
    prepared = await prepareOrReuseDirectIntakeSubmission(params, null, { preparation });
  } finally {
    for (const undo of restore.reverse()) undo();
  }

  assert.ok(prepared);
  const capability = prepared!.submission.session.capability;
  assert.ok(capability.length >= 16);
  assert.deepEqual(storageCalls, [], 'the flow touches no web storage at all');
  assert.equal(
    logged.some((line) => line.includes(capability)),
    false,
    'no console line carries the capability',
  );
  assert.equal(
    JSON.stringify({ preparation }).includes(capability),
    false,
    'serializing the preparation state cannot leak the capability',
  );
  assert.equal(
    JSON.stringify(preparation.toJSON()).includes(capability),
    false,
  );

  const payload = new FormData();
  applyPrimaryAndSupportingMediaToOrderPayload(payload, {
    directSubmission: prepared!.submission,
    heroPhoto: files.hero,
    familyPhotos: [files.nana, files.uncle],
  });
  const carrying: string[] = [];
  for (const [field, value] of payload.entries()) {
    if (typeof value === 'string' && value.includes(capability)) carrying.push(field);
  }
  assert.deepEqual(carrying, ['checkoutIntakeCapability'], 'exactly the one dedicated field');
});

test('the client flow module reaches for no persistent browser surface', () => {
  // Comments SAY localStorage — to explain why it is absent. Only executable
  // text is judged here.
  const code = readFileSync('src/lib/checkout-intake-client-flow.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'console.']) {
    assert.equal(code.includes(forbidden), false, `${forbidden} has no place in the intake flow`);
  }
});

// ---------------------------------------------------------------------------
// (g) The clean first try is untouched.
// ---------------------------------------------------------------------------

test('a successful first try is byte-for-byte what it was before resumption existed', async () => {
  const withController = rig();
  const withoutController = rig();
  const filesA = freshFiveFiles();
  const filesB = freshFiveFiles();

  const controlled = await prepareOrReuseDirectIntakeSubmission(
    fiveAssetParams(withController, filesA),
    null,
    { preparation: createDirectIntakePreparation() },
  );
  const plain = await prepareOrReuseDirectIntakeSubmission(
    fiveAssetParams(withoutController, filesB),
    null,
  );

  assert.ok(controlled);
  assert.ok(plain);
  assert.equal(withController.creates, withoutController.creates);
  assert.equal(withController.uploads, withoutController.uploads);
  assert.equal(withController.reserves, withoutController.reserves);
  assert.equal(withController.resolves, withoutController.resolves);
  assert.deepEqual(withController.uploadedSlotKeys, withoutController.uploadedSlotKeys);

  const shape = (selection: Record<string, unknown>) => ({
    hero: typeof selection.primaryHeroPhotoAssetId,
    family: (selection.familyCharacterAssets as Array<{ familyCharacterId: string }>)
      .map((entry) => entry.familyCharacterId),
    guided: (selection.guidedStillAssetIds as string[]).length,
    voice: typeof selection.voiceAssetId,
    document: selection.documentAssetId,
  });
  assert.deepEqual(
    shape(controlled!.submission.selection as unknown as Record<string, unknown>),
    shape(plain!.submission.selection as unknown as Record<string, unknown>),
  );
});

// ---------------------------------------------------------------------------
// Wiring: the page must actually hold one preparation controller and drop it.
// ---------------------------------------------------------------------------

test('the checkout page holds a single preparation controller and clears it with the capability', () => {
  const form = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  assert.ok(form.includes('createDirectIntakePreparation'), 'the page creates a preparation controller');
  assert.ok(
    /preparation:\s*directIntakePreparationRef\.current/.test(form),
    'the controller is handed to the preparation call',
  );
  const resets = form.match(/directIntakePreparationRef\.current\?\.reset\(\)/g) ?? [];
  const cacheClears = form.match(/intakeSessionRef\.current = null/g) ?? [];
  assert.equal(
    resets.length,
    cacheClears.length,
    'every place the frozen cache is dropped also drops the partial state',
  );
});

// ---------------------------------------------------------------------------
// (h) Reset CANCELS. Clearing the refs is not enough while a run is parked on
//     an await: it wakes up holding the old session and the old capability, and
//     unless something fences it, it writes both back.
// ---------------------------------------------------------------------------

/** The smallest real batch: one hero photo. */
function heroOnlyParams(r: Rig, hero: Blob): PrepareDirectIntakeSubmissionParams {
  return {
    enabled: true,
    transport: r.transport,
    heroPhoto: hero,
    familyPhotos: [],
    guidedStills: [],
    voice: null,
  };
}

test('a reset while the intake is being created never resurrects the session', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const params = heroOnlyParams(r, jpeg(61));
  // The buyer presses Start over while `action: create` is still outstanding.
  r.duringIntake('create', () => { preparation.reset(); });

  await assert.rejects(
    prepareOrReuseDirectIntakeSubmission(params, null, { preparation }),
    /direct_upload_preparation_cancelled/,
  );

  assert.equal(preparation.session, null, 'the cleared session is never written back');
  assert.equal(preparation.media, null, 'nor the media it belonged to');
  assert.equal(preparation.saved.size, 0);
  assert.equal(r.uploads, 0, 'not one byte goes to an intake the page has dropped');
});

test('a reset while bytes are moving leaves no saved slot and no submission behind', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const files = { hero: jpeg(62), nana: jpeg(63) };
  const params: PrepareDirectIntakeSubmissionParams = {
    enabled: true,
    transport: r.transport,
    heroPhoto: files.hero,
    familyCharacterIds: [NANA],
    familyPhotos: [{ familyCharacterId: NANA, file: files.nana, mimeType: 'image/jpeg' }],
    guidedStills: [],
    voice: null,
  };
  // Start over lands between the hero bytes landing and the commit callback.
  r.beforeNextCommit(() => { preparation.reset(); });

  await assert.rejects(
    prepareOrReuseDirectIntakeSubmission(params, null, { preparation }),
    /direct_upload_preparation_cancelled/,
  );

  assert.equal(preparation.session, null, 'the dropped capability stays dropped');
  assert.equal(preparation.saved.size, 0, 'no slot from a cancelled run is remembered');
  assert.equal(preparation.media, null);
  assert.equal(
    preparation.slots.get().slots.primary_hero_photo,
    undefined,
    'the fresh slot store the reset installed is left untouched',
  );
  assert.equal(r.uploads, 1, 'the second file is never sent to the abandoned intake');
});

// ---------------------------------------------------------------------------
// (i) Single flight is RE-ACQUIRED after every wait. A, then B, then B.
// ---------------------------------------------------------------------------

test('a changed selection asked for twice mid-flight starts exactly one new preparation', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const paramsA = heroOnlyParams(r, jpeg(71));
  const paramsB = heroOnlyParams(r, jpeg(72));

  // A is under way; both B callers arrive before it settles, so both must wait
  // — and then exactly one of them may claim the next preparation.
  const a = prepareOrReuseDirectIntakeSubmission(paramsA, null, { preparation });
  const b1 = prepareOrReuseDirectIntakeSubmission(paramsB, null, { preparation });
  const b2 = prepareOrReuseDirectIntakeSubmission(paramsB, null, { preparation });

  const [, firstB, secondB] = await Promise.all([a, b1, b2]);

  assert.ok(firstB);
  assert.ok(secondB);
  assert.equal(r.creates, 2, 'one intake for A and exactly one for B, never two for B');
  assert.equal(r.uploads, 2, 'the changed hero photo is uploaded once, not twice');
  assert.equal(
    firstB!.submission.session.intakeId,
    secondB!.submission.session.intakeId,
    'both B callers converge on one intake',
  );
  assert.equal(firstB!.submission, secondB!.submission, 'and on one submission');
});

// ---------------------------------------------------------------------------
// (j) The gap the flow cannot fence for itself: between its own resolution and
//     the caller's next line. An order must never be built in that window.
// ---------------------------------------------------------------------------

test('a preparation reset after the submission was built refuses the order hand-off', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const params = heroOnlyParams(r, jpeg(81));

  const prepared = await prepareOrReuseDirectIntakeSubmission(params, null, { preparation });
  assert.ok(prepared);
  // Exactly the page's window: the result is in hand, nothing has been posted,
  // and the buyer presses Start over.
  preparation.reset();

  assert.throws(
    () => assertDirectIntakeResultIsCurrent(prepared, preparation),
    /direct_upload_preparation_cancelled/,
  );

  // And a live result is still accepted, or the page could never check out.
  const again = await prepareOrReuseDirectIntakeSubmission(params, null, { preparation });
  assert.ok(again);
  assertDirectIntakeResultIsCurrent(again, preparation);
});

test('the checkout page refuses an obsolete preparation result before it posts an order', () => {
  const form = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  const guard = form.indexOf('assertDirectIntakeResultIsCurrent(preparedDirectIntake');
  const payload = form.indexOf('applyPrimaryAndSupportingMediaToOrderPayload(payload');
  const order = form.indexOf('fetch("/api/order"');
  assert.ok(guard > 0, 'the page checks the preparation result it was handed');
  assert.ok(payload > guard, 'a cancelled result never reaches the order payload');
  assert.ok(order > guard, 'and never reaches /api/order');
});

test('a reset preparation cannot resume the intake it was holding', async () => {
  const r = rig();
  const preparation: DirectIntakePreparation = createDirectIntakePreparation();
  const hero = jpeg(51);
  const params: PrepareDirectIntakeSubmissionParams = {
    enabled: true,
    transport: r.transport,
    heroPhoto: hero,
    familyPhotos: [],
    guidedStills: [],
    voice: null,
  };
  const first = await prepareOrReuseDirectIntakeSubmission(params, null, { preparation });
  assert.ok(first);
  const intakeId = first!.submission.session.intakeId;

  preparation.reset();
  assert.equal(preparation.session, null);

  const second = await prepareOrReuseDirectIntakeSubmission(params, null, { preparation });
  assert.ok(second);
  assert.notEqual(second!.submission.session.intakeId, intakeId, 'a cleared controller starts over');
  assert.equal(r.creates, 2);
});

// ---------------------------------------------------------------------------
// (k) The fence has to reach INSIDE one slot's upload.
//
// `prepareDirectIntakeSubmission` checks before it calls `uploadSlotFile` and
// after it returns, which leaves the whole reserve → upload → reconcile
// sequence unfenced. A reset landing while the reservation is outstanding
// therefore still sends the bytes.
// ---------------------------------------------------------------------------

test('a reset while the reservation is outstanding sends no bytes to the abandoned intake', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const params = heroOnlyParams(r, jpeg(91));
  // The reserve response is held at the boundary, Start over lands, and only
  // then is the response released into the upload sequence.
  r.duringIntake('reserve-upload', () => { preparation.reset(); });

  await assert.rejects(
    prepareOrReuseDirectIntakeSubmission(params, null, { preparation }),
    /direct_upload_preparation_cancelled/,
  );

  assert.equal(r.reserves, 1, 'the reservation the reset interrupted is the only one');
  assert.equal(r.uploads, 0, 'not one byte goes to a reservation the buyer discarded');
  assert.equal(r.resolves, 0, 'and nothing asks that reservation what it is holding');
  assert.equal(totalActiveAssets(r), 0, 'no asset is activated on any intake');
  assert.equal(preparation.session, null, 'the dropped capability stays dropped');
  assert.equal(preparation.saved.size, 0, 'no slot from a cancelled run is remembered');
  assert.equal(preparation.media, null);
  assert.equal(
    preparation.slots.get().slots.primary_hero_photo,
    undefined,
    'the fresh slot store the reset installed is left untouched',
  );
});

// ---------------------------------------------------------------------------
// (l) A queued waiter may not outlive the reset that cancelled the run it was
//     waiting on. Waking up to an empty flight is NOT permission to start one.
// ---------------------------------------------------------------------------

test('a queued changed-selection Continue is cancelled by a reset it waited through', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const paramsA = heroOnlyParams(r, jpeg(92));
  const paramsB = heroOnlyParams(r, jpeg(93));

  // A is creating its intake. B is a different selection, so it parks behind A
  // rather than joining it. Start over lands while B is parked.
  r.duringIntake('create', () => { preparation.reset(); });

  const a = prepareOrReuseDirectIntakeSubmission(paramsA, null, { preparation });
  const b = prepareOrReuseDirectIntakeSubmission(paramsB, null, { preparation });

  await assert.rejects(a, /direct_upload_preparation_cancelled/);
  await assert.rejects(
    b,
    /direct_upload_preparation_cancelled/,
    'the waiter cannot swallow the cancellation and claim the next preparation',
  );

  assert.equal(r.creates, 1, 'no second intake is created after the reset');
  assert.equal(r.uploads, 0, 'and not one byte moves after it');
  assert.equal(totalActiveAssets(r), 0);
  assert.equal(preparation.session, null);
  assert.equal(preparation.saved.size, 0);
  assert.equal(preparation.media, null);
});

/**
 * The other half of (l), and the reason a queued caller is bound to the ATTEMPT
 * rather than to the generation.
 *
 * Three different selections queued in a row is a buyer changing their mind
 * twice. Each waiter wakes to find the generation moved — by the restart the
 * waiter ahead of it legitimately performed, not by any reset — and must go on
 * regardless. A waiter bound to the generation cancels the third Continue as
 * though Start over had been pressed, which it never was.
 */
test('three different selections queued in a row are each prepared, none cancelled', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();

  const a = prepareOrReuseDirectIntakeSubmission(heroOnlyParams(r, jpeg(96)), null, { preparation });
  const b = prepareOrReuseDirectIntakeSubmission(heroOnlyParams(r, jpeg(97)), null, { preparation });
  const c = prepareOrReuseDirectIntakeSubmission(heroOnlyParams(r, jpeg(98)), null, { preparation });

  const settled = await Promise.all([a, b, c].map((p) => p.catch((error: unknown) => error)));

  for (const [index, result] of settled.entries()) {
    assert.ok(
      result && typeof result === 'object' && 'submission' in result,
      `selection ${index} was refused: ${String(result)}`,
    );
  }
  assert.equal(r.creates, 3, 'one intake per distinct selection');
  assert.equal(r.uploads, 3, 'each hero photo uploaded once');
  assert.equal(preparation.attempt, 0, 'no reset happened, so no attempt ended');
  // Only the last one is still the page's; the first two were superseded by the
  // restarts that followed them, and the hand-off guard says so.
  assertDirectIntakeResultIsCurrent(settled[2] as PreparedDirectIntake, preparation);
});

// ---------------------------------------------------------------------------
// (m) A frozen cache belongs to the controller and generation that built it.
//     Re-stamping it with the page's current generation launders a discarded
//     attempt into a live order.
// ---------------------------------------------------------------------------

test('a completed cache from before a reset is neither reused nor re-stamped', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const params = heroOnlyParams(r, jpeg(94));

  const first = await prepareOrReuseDirectIntakeSubmission(params, null, { preparation });
  assert.ok(first);
  const staleCache = first!.cache;

  // Start over. The capability that cache was built on is gone.
  preparation.reset();

  await assert.rejects(
    prepareOrReuseDirectIntakeSubmission(params, staleCache, { preparation }),
    /direct_upload_preparation_cancelled/,
  );
  assert.equal(r.creates, 1, 'the refusal starts nothing');
  assert.equal(r.uploads, 1, 'and re-sends nothing');
  assert.throws(
    () => assertDirectIntakeResultIsCurrent(first, preparation),
    /direct_upload_preparation_cancelled/,
    'the hand-off guard cannot accept the pre-reset result either',
  );

  // And the page can still check out afterwards, or the refusal would be a
  // dead end rather than a fence.
  const fresh = await prepareOrReuseDirectIntakeSubmission(params, null, { preparation });
  assert.ok(fresh);
  assertDirectIntakeResultIsCurrent(fresh, preparation);
  assert.notEqual(fresh!.submission.session.intakeId, first!.submission.session.intakeId);
});

test('a completed cache cannot be reused by a different preparation controller', async () => {
  const r = rig();
  const owner = createDirectIntakePreparation();
  const params = heroOnlyParams(r, jpeg(95));

  const prepared = await prepareOrReuseDirectIntakeSubmission(params, null, { preparation: owner });
  assert.ok(prepared);

  // A second controller, holding none of that intake's state, brought to the
  // very same generation number. Generation alone cannot tell these two apart.
  const stranger = createDirectIntakePreparation();
  while (stranger.generation < owner.generation) stranger.reset();
  assert.equal(stranger.generation, owner.generation);

  await assert.rejects(
    prepareOrReuseDirectIntakeSubmission(params, prepared!.cache, { preparation: stranger }),
    /direct_upload_preparation_cancelled/,
  );
  assert.throws(
    () => assertDirectIntakeResultIsCurrent(prepared, stranger),
    /direct_upload_preparation_cancelled/,
  );
  assert.equal(r.creates, 1);
  assert.equal(r.uploads, 1);
});

// ---------------------------------------------------------------------------
// (i) The page's ONE invalidation boundary for committed media.
//
//     The refs are not the fence. A handler that clears `heroPhoto` in React
//     state and leaves the preparation alone leaves the generation where it
//     was: a reserve-upload already in flight for the DISCARDED photo wakes up
//     current, uploads, passes the hand-off guard, and `/api/order` is handed a
//     book built on media the buyer removed on screen. Every committed change
//     to the media a direct intake is built from therefore has to run through
//     one boundary that invalidates BOTH authorities — the frozen batch and the
//     live preparation — synchronously, before the UI state moves.
// ---------------------------------------------------------------------------

const CHECKOUT_FORM = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

/**
 * The source of one `const <name> = ...` arrow function, brace-balanced.
 *
 * Deliberately structural rather than a line window: a handler that grows a
 * branch must not be able to slide its mutation out of the region the
 * assertions below read.
 */
function namedHandlerSource(name: string): string {
  const start = CHECKOUT_FORM.indexOf(`const ${name} = `);
  assert.ok(start > 0, `the checkout page must define a named ${name} handler`);
  const open = CHECKOUT_FORM.indexOf('{', CHECKOUT_FORM.indexOf('=>', start));
  assert.ok(open > start, `${name} must have a block body`);
  let depth = 0;
  for (let i = open; i < CHECKOUT_FORM.length; i += 1) {
    if (CHECKOUT_FORM[i] === '{') depth += 1;
    else if (CHECKOUT_FORM[i] === '}') {
      depth -= 1;
      if (depth === 0) return CHECKOUT_FORM.slice(start, i + 1);
    }
  }
  throw new assert.AssertionError({ message: `${name} has an unbalanced body` });
}

/** Every committed direct-intake media mutation, and the state write it makes. */
const COMMITTED_MEDIA_MUTATIONS: ReadonlyArray<{ handler: string; mutation: string }> = [
  { handler: 'applyHeroPhotoSelection', mutation: 'photoFile: uploadFile' },
  { handler: 'clearHeroPhoto', mutation: 'photoFile: null' },
  { handler: 'saveSupportingCharacter', mutation: 'familyCharacters:' },
  { handler: 'removeSupportingCharacter', mutation: 'familyCharacters:' },
  { handler: 'handleGuidedFramesChange', mutation: 'setGuidedFrames(' },
  { handler: 'handleGuidedConsentChange', mutation: 'setGuidedConsent(' },
  { handler: 'handleStoryMediaChange', mutation: 'voiceFile: file' },
  { handler: 'handleStoryMediaConsentChange', mutation: 'voiceConsent: consent' },
  { handler: 'handleDirectMediaConsentChange', mutation: 'setDirectMediaConsent(consent)' },
  { handler: 'clearCustomStoryMedia', mutation: 'voiceFile: null' },
  { handler: 'clearSavedCheckoutProgress', mutation: 'setForm(emptyForm)' },
];

test('the checkout page invalidates both intake authorities in one boundary', () => {
  const boundary = namedHandlerSource('commitDirectIntakeMediaChange');
  assert.match(
    boundary,
    /invalidateDirectIntakeMediaSelection\(/,
    'the boundary delegates to the audited invalidation',
  );
  assert.ok(
    boundary.indexOf('invalidateDirectIntakeMediaSelection(') < boundary.indexOf('mutate('),
    'invalidation happens BEFORE the UI state mutation it guards',
  );
  assert.match(boundary, /completed:\s*intakeSessionRef/, 'the frozen batch is one of the two');
  assert.match(boundary, /preparation:\s*directIntakePreparationRef/, 'the live preparation is the other');
});

test('every committed media mutation on the checkout page runs inside that boundary', () => {
  for (const { handler, mutation } of COMMITTED_MEDIA_MUTATIONS) {
    const source = namedHandlerSource(handler);
    const guard = source.indexOf('commitDirectIntakeMediaChange(');
    const write = source.indexOf(mutation);
    assert.ok(guard > 0, `${handler} must invalidate through the boundary`);
    assert.ok(write > 0, `${handler} must still perform its ${mutation} mutation`);
    assert.ok(write > guard, `${handler} mutates ${mutation} before invalidating`);
  }
});

test('no media control on the checkout page is bound straight to a raw state setter', () => {
  for (const bypass of [
    'onFramesChange={setGuidedFrames}',
    'onConsentChange={setGuidedConsent}',
    'onChange={(event) => setDirectMediaConsent(event.target.checked)}',
  ]) {
    assert.ok(!CHECKOUT_FORM.includes(bypass), `${bypass} skips the invalidation boundary`);
  }
});

test('a committed media change during a held reservation uploads nothing and hands off nothing', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const completed: { current: DirectIntakeSubmissionCache | null } = { current: null };
  const params = heroOnlyParams(r, jpeg(96));

  // Continue is under way and the reserve-upload response for the hero photo is
  // in hand. The buyer navigates back and presses Change Photo: the discarded
  // photo disappears from the screen, and that handler runs THIS and nothing
  // else. The reservation is released a moment later.
  r.duringIntake('reserve-upload', () => {
    invalidateDirectIntakeMediaSelection({ completed, preparation: { current: preparation } });
  });

  await assert.rejects(
    prepareOrReuseDirectIntakeSubmission(params, completed.current, { preparation }),
    /direct_upload_preparation_cancelled/,
    'the run for the discarded selection is cancelled, not completed',
  );

  assert.equal(r.reserves, 1, 'the reservation was taken and then abandoned');
  assert.equal(r.uploads, 0, 'the released reservation sends no bytes for the discarded photo');
  assert.equal(totalActiveAssets(r), 0, 'and the server holds nothing for the discarded attempt');
});

test('the boundary drops the frozen batch a refused order left on the page', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const completed: { current: DirectIntakeSubmissionCache | null } = { current: null };
  const params = heroOnlyParams(r, jpeg(99));

  // A completed batch is on the page, exactly as it would be after a refused
  // /api/order response, when the buyer changes their media.
  const earlier = await prepareOrReuseDirectIntakeSubmission(params, null, { preparation });
  assert.ok(earlier);
  completed.current = earlier!.cache;

  invalidateDirectIntakeMediaSelection({ completed, preparation: { current: preparation } });

  assert.equal(completed.current, null, 'the page cannot even present it any more');
  assert.throws(
    () => assertDirectIntakeResultIsCurrent(earlier, preparation),
    /direct_upload_preparation_cancelled/,
    'the pre-change result can never reach /api/order',
  );
  await assert.rejects(
    prepareOrReuseDirectIntakeSubmission(params, earlier!.cache, { preparation }),
    /direct_upload_preparation_cancelled/,
    'and re-presenting it by hand is refused too',
  );
  assert.equal(r.uploads, 1, 'nothing is re-sent for the abandoned batch');
});

test('after that boundary the same selection still single-flights and still resumes', async () => {
  const r = rig();
  const preparation = createDirectIntakePreparation();
  const completed: { current: DirectIntakeSubmissionCache | null } = { current: null };

  invalidateDirectIntakeMediaSelection({ completed, preparation: { current: preparation } });

  const replacement = jpeg(98);
  const params = heroOnlyParams(r, replacement);
  const [a, b] = await Promise.all([
    prepareOrReuseDirectIntakeSubmission(params, null, { preparation }),
    prepareOrReuseDirectIntakeSubmission(params, null, { preparation }),
  ]);
  assert.ok(a);
  assert.equal(a, b, 'two Continues for one selection coalesce onto one preparation');
  assert.equal(r.creates, 1, 'one intake');
  assert.equal(r.uploads, 1, 'one upload of the replacement photo');
  assertDirectIntakeResultIsCurrent(a, preparation);
});

test('submit ownership captured before attempt resolution is revoked by a media reset', () => {
  const preparation = createDirectIntakePreparation();
  const authority = captureDirectIntakeAttemptAuthority(preparation);

  assertDirectIntakeAttemptAuthorityIsCurrent(authority, preparation);
  preparation.reset();
  assert.throws(
    () => assertDirectIntakeAttemptAuthorityIsCurrent(authority, preparation),
    /direct_upload_preparation_cancelled/,
  );
});

test('the checkout page captures submit media ownership before its first await and rechecks it before upload and order dispatch', () => {
  const submit = namedHandlerSource('handleSubmit');
  const capture = submit.indexOf('captureDirectIntakeAttemptAuthority(');
  const firstAwait = submit.indexOf('await ');
  const prepare = submit.indexOf('prepareOrReuseDirectIntakeSubmission(');
  const order = submit.indexOf('fetch("/api/order"');
  const checks = [...submit.matchAll(/assertDirectIntakeAttemptAuthorityIsCurrent\(/g)]
    .map((match) => match.index ?? -1);

  assert.ok(capture > 0 && capture < firstAwait, 'submit ownership must be captured before attempt-resolution awaits');
  assert.ok(prepare > firstAwait && order > prepare);
  assert.ok(checks.some((index) => index > firstAwait && index < prepare), 'superseded submit must stop before direct upload');
  assert.ok(checks.some((index) => index > prepare && index < order), 'superseded submit must stop before /api/order');
});
