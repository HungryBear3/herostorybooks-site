/**
 * What the checkout PAGE does with the intake state machine.
 *
 * The reviewed foundation proved the reducers fence stale results. It could
 * not prove anything about the sequence a real page runs — reserve, upload,
 * reconcile — because nothing consumed the reducers yet. That gap is what this
 * suite closes, and it drives the REAL `POST /api/checkout/intake` handler
 * (real guard, real budget, real state machine) so the client's assumptions
 * about the endpoint contract are checked against the endpoint.
 *
 * Only the Blob upload itself is a double, and even that double runs the real
 * server-side token authorization and completion path, so a slot can only
 * become "saved" the same way it would in a browser.
 *
 * The property that matters most: a buyer who changes or removes a photo
 * mid-upload must never end up ordering the photo they replaced.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { handleIntakeRequest, type IntakeRouteDeps } from '../src/lib/checkout-intake-route.ts';
import { createMemoryCheckoutGuardStore } from '../src/lib/checkout-request-guard.ts';
import { slotKeyFor } from '../src/lib/checkout-intake.ts';
import { authorizeReservedUpload, completeSlotUpload } from '../src/lib/checkout-intake-upload.ts';
import type { CheckoutFinalizeSelection } from '../src/lib/checkout-finalize.ts';
import { createIntakeClientState } from '../src/lib/checkout-intake-client.ts';
import {
  buildDirectIntakeSelection,
  createCheckoutIntakeSession,
  createSlotStateStore,
  directSlotKey,
  directUploadBlockers,
  prepareOrReuseDirectIntakeSubmission,
  prepareDirectIntakeSubmission,
  releaseSlotFile,
  updateIntakeConsent,
  uploadSlotFile,
  type IntakeClientTransport,
  type SlotStateStore,
} from '../src/lib/checkout-intake-client-flow.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const ORIGIN = 'https://preview.herostorybooks.test';
const ENV = { HSB_CHECKOUT_DIRECT_UPLOAD: 'true' } as NodeJS.ProcessEnv;
const FAMILY_ID = 'supporting-character-abc123';

interface Rig {
  transport: IntakeClientTransport;
  store: MemoryIntakeStore;
  state: SlotStateStore;
  /** Resolves the next upload only when the test says so. */
  holdNextUpload(): { release: () => void; started: Promise<void> };
  failNextUpload(error?: Error): void;
  uploads: number;
  reserves: number;
}

function rig(options: { uploadLandsLate?: boolean; uploadNeverLands?: boolean } = {}): Rig {
  const store = createMemoryIntakeStore();
  const deps: IntakeRouteDeps = { store, guardStore: createMemoryCheckoutGuardStore(), env: ENV };
  const counters = { uploads: 0, reserves: 0 };
  let hold: { promise: Promise<void>; release: () => void; started: () => void } | null = null;
  let uploadError: Error | null = null;

  const transport: IntakeClientTransport = {
    async intake(body) {
      if ((body as { action?: string }).action === 'reserve-upload') counters.reserves += 1;
      const response = await handleIntakeRequest(new Request(`${ORIGIN}/api/checkout/intake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify(body),
      }), deps);
      return { ok: response.ok, status: response.status, body: await response.json() as Record<string, unknown> };
    },

    async upload({ pathname, clientPayload, contentType, file }) {
      counters.uploads += 1;
      if (hold) {
        const current = hold;
        hold = null;
        current.started();
        await current.promise;
      }
      if (uploadError) {
        const error = uploadError;
        uploadError = null;
        throw error;
      }
      // `upload()` resolved but no object exists — a provider write that was
      // reported and then lost. `resolve-upload` must keep reporting pending.
      if (options.uploadNeverLands) return;
      // Everything below is the REAL server path a Vercel Blob callback takes.
      const payload = JSON.parse(clientPayload) as {
        intakeId: string; capability: string; slotKey: string; generation: number; reservationId: string;
      };
      const size = typeof (file as Blob).size === 'number' ? (file as Blob).size : 1;
      const authorization = await authorizeReservedUpload(store, { ...payload, pathname }, new Date());
      store.putAsset({ pathname, mimeType: contentType, size, etag: `etag-${pathname.slice(-8)}` });
      const complete = async () => completeSlotUpload(store, {
        tokenPayload: authorization.tokenPayload,
        blob: { pathname, contentType, size, etag: `etag-${pathname.slice(-8)}` },
      }, new Date());
      if (options.uploadLandsLate) {
        // The callback has not arrived when `upload()` resolves — exactly the
        // case `resolve-upload` exists for.
        setTimeout(() => { void complete().catch(() => {}); }, 5);
        return;
      }
      await complete();
    },
  };

  return {
    transport,
    store,
    state: createSlotStateStore(createIntakeClientState()),
    holdNextUpload() {
      let release!: () => void;
      let started!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      hold = { promise, release, started };
      return { release, started: startedPromise };
    },
    failNextUpload(error = new Error('network lost')) { uploadError = error; },
    get uploads() { return counters.uploads; },
    get reserves() { return counters.reserves; },
  } as Rig;
}

function jpeg(bytes = 64): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
}

async function session(r: Rig) {
  return createCheckoutIntakeSession(r.transport, { mediaAuthorized: true });
}

test('the client slot key is byte-identical to the one the server derives', () => {
  const refs = [
    { category: 'primary_hero_photo' as const },
    { category: 'family_pet_reference' as const, familyCharacterId: FAMILY_ID },
    { category: 'guided_still' as const, guidedStillIndex: 0 },
    { category: 'guided_still' as const, guidedStillIndex: 2 },
    { category: 'voice_inspiration' as const },
    { category: 'document_inspiration' as const },
  ];
  for (const ref of refs) {
    assert.equal(directSlotKey(ref), slotKeyFor(ref), JSON.stringify(ref));
  }
});

test('creating an intake stamps consent on the server and never sends a client timestamp', async () => {
  const r = rig();
  const sent: unknown[] = [];
  const spy: IntakeClientTransport = {
    intake: async (body) => { sent.push(body); return r.transport.intake(body); },
    upload: r.transport.upload,
  };

  const created = await createCheckoutIntakeSession(spy, { mediaAuthorized: true });

  assert.match(created.intakeId, /^intake_[a-f0-9]{32}$/);
  assert.ok(created.capability.length >= 16);
  assert.equal(JSON.stringify(sent).includes('AuthorizedAt'), false, 'consent instants are the server\'s to stamp');
  const stored = r.store.records.get(created.intakeId)!.record;
  assert.equal(stored.consent.mediaAuthorizedAt, stored.createdAt);
  assert.equal(stored.consent.childVoiceAuthorizedAt, null);
});

test('a hero photo uploads, reconciles, and becomes the saved selection', async () => {
  const r = rig();
  const s = await session(r);

  const outcome = await uploadSlotFile(r.transport, r.state, {
    session: s,
    slot: { category: 'primary_hero_photo' },
    file: jpeg(),
    mimeType: 'image/jpeg',
    size: 64,
  });

  assert.equal(outcome.status, 'saved');
  const slot = r.state.get().slots.primary_hero_photo!;
  assert.equal(slot.state, 'saved');
  assert.equal(slot.assetId, outcome.status === 'saved' ? outcome.assetId : null);
  assert.equal(r.store.records.get(s.intakeId)!.record.slots.primary_hero_photo!.active!.assetId, slot.assetId);

  const built = buildDirectIntakeSelection(r.state.get(), []);
  assert.deepEqual(built.unmapped, []);
  assert.equal(built.selection.primaryHeroPhotoAssetId, slot.assetId);
});

test('a late callback is reconciled by resolve-upload rather than lost', async () => {
  const r = rig({ uploadLandsLate: true });
  const s = await session(r);

  const outcome = await uploadSlotFile(r.transport, r.state, {
    session: s,
    slot: { category: 'primary_hero_photo' },
    file: jpeg(),
    mimeType: 'image/jpeg',
    size: 64,
    resolve: { attempts: 8, delayMs: 2 },
  });

  assert.equal(outcome.status, 'saved');
  assert.equal(r.state.get().slots.primary_hero_photo!.state, 'saved');
});

test('an upload that never lands fails closed instead of reporting a saved photo', async () => {
  const r = rig({ uploadNeverLands: true });
  const s = await session(r);

  const outcome = await uploadSlotFile(r.transport, r.state, {
    session: s,
    slot: { category: 'primary_hero_photo' },
    file: jpeg(),
    mimeType: 'image/jpeg',
    size: 64,
    resolve: { attempts: 3, delayMs: 1 },
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.status === 'failed' && outcome.code, 'upload_not_reconciled');
  assert.notEqual(r.state.get().slots.primary_hero_photo!.state, 'saved');
  assert.equal(buildDirectIntakeSelection(r.state.get(), []).selection.primaryHeroPhotoAssetId, null);
});

test('a replacement chosen mid-upload wins; the superseded upload cannot enter the selection', async () => {
  const r = rig();
  const s = await session(r);
  const gate = r.holdNextUpload();

  const first = uploadSlotFile(r.transport, r.state, {
    session: s,
    slot: { category: 'primary_hero_photo' },
    file: jpeg(11),
    mimeType: 'image/jpeg',
    size: 11,
  });
  await gate.started;

  // The buyer picks a different photo while the first one is still uploading.
  const second = uploadSlotFile(r.transport, r.state, {
    session: s,
    slot: { category: 'primary_hero_photo' },
    file: jpeg(22),
    mimeType: 'image/jpeg',
    size: 22,
  });
  gate.release();

  const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

  assert.equal(firstOutcome.status, 'superseded');
  assert.equal(secondOutcome.status, 'saved');
  const saved = r.state.get().slots.primary_hero_photo!;
  assert.equal(saved.state, 'saved');
  assert.equal(saved.assetId, secondOutcome.status === 'saved' ? secondOutcome.assetId : null);
  assert.notEqual(
    saved.assetId,
    firstOutcome.status === 'saved' ? (firstOutcome as { assetId: string }).assetId : '—',
  );
  assert.equal(buildDirectIntakeSelection(r.state.get(), []).selection.primaryHeroPhotoAssetId, saved.assetId);
});

test('a photo removed mid-upload is not restored by the completion, locally or on the server', async () => {
  const r = rig();
  const s = await session(r);
  const gate = r.holdNextUpload();

  const inFlight = uploadSlotFile(r.transport, r.state, {
    session: s,
    slot: { category: 'primary_hero_photo' },
    file: jpeg(),
    mimeType: 'image/jpeg',
    size: 64,
  });
  await gate.started;
  await releaseSlotFile(r.transport, r.state, { session: s, slot: { category: 'primary_hero_photo' } });
  gate.release();

  const outcome = await inFlight;

  assert.equal(outcome.status, 'superseded');
  assert.equal(r.state.get().slots.primary_hero_photo!.state, 'empty');
  assert.equal(buildDirectIntakeSelection(r.state.get(), []).selection.primaryHeroPhotoAssetId, null);
  assert.equal(
    r.store.records.get(s.intakeId)!.record.slots.primary_hero_photo?.active ?? null,
    null,
    'the removed slot must not hold a live asset the next list could repaint',
  );
});

test('a refused reservation never uploads and leaves the slot retryable', async () => {
  const r = rig();
  const s = await session(r);

  const outcome = await uploadSlotFile(r.transport, r.state, {
    session: s,
    slot: { category: 'primary_hero_photo' },
    file: jpeg(),
    // A MIME the hero category does not accept.
    mimeType: 'image/gif',
    size: 64,
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.status === 'failed' && outcome.code, 'asset_mime_invalid');
  assert.equal(r.uploads, 0, 'nothing may be uploaded against a refused reservation');
  assert.notEqual(r.state.get().slots.primary_hero_photo!.state, 'saved');
});

test('a failed upload is retryable and the retry succeeds', async () => {
  const r = rig();
  const s = await session(r);
  r.failNextUpload();

  const failed = await uploadSlotFile(r.transport, r.state, {
    session: s,
    slot: { category: 'primary_hero_photo' },
    file: jpeg(),
    mimeType: 'image/jpeg',
    size: 64,
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.status === 'failed' && failed.code, 'upload_failed');
  assert.notEqual(r.state.get().slots.primary_hero_photo!.state, 'saved');

  const retried = await uploadSlotFile(r.transport, r.state, {
    session: s,
    slot: { category: 'primary_hero_photo' },
    file: jpeg(),
    mimeType: 'image/jpeg',
    size: 64,
  });
  assert.equal(retried.status, 'saved');
  assert.equal(r.state.get().slots.primary_hero_photo!.state, 'saved');
});

test('voice consent is widened with the exact source before the audio is uploaded', async () => {
  const r = rig();
  const s = await session(r);

  await updateIntakeConsent(r.transport, s, { childVoiceAuthorized: true, voiceSource: 'recorded' });
  const outcome = await uploadSlotFile(r.transport, r.state, {
    session: s,
    slot: { category: 'voice_inspiration' },
    file: new Blob([new Uint8Array(32)], { type: 'audio/mpeg' }),
    mimeType: 'audio/mpeg',
    size: 32,
  });

  assert.equal(outcome.status, 'saved');
  const record = r.store.records.get(s.intakeId)!.record;
  assert.equal(record.consent.voiceSource, 'recorded');
  assert.equal(record.slots.voice_inspiration!.active!.voiceSource, 'recorded');
  assert.equal(record.slots.voice_inspiration!.active!.consentAt, record.consent.childVoiceAuthorizedAt);
  assert.equal(
    buildDirectIntakeSelection(r.state.get(), []).selection.voiceAssetId,
    record.slots.voice_inspiration!.active!.assetId,
  );
});

test('supporting photos are keyed by the stable id, and an undeclared id is reported not silently dropped', async () => {
  const r = rig();
  const s = await session(r);
  await uploadSlotFile(r.transport, r.state, {
    session: s,
    slot: { category: 'family_pet_reference', familyCharacterId: FAMILY_ID },
    file: jpeg(),
    mimeType: 'image/jpeg',
    size: 64,
  });

  const declared = buildDirectIntakeSelection(r.state.get(), [FAMILY_ID]);
  assert.deepEqual(declared.unmapped, []);
  assert.equal(declared.selection.familyCharacterAssets.length, 1);
  assert.equal(declared.selection.familyCharacterAssets[0]!.familyCharacterId, FAMILY_ID);

  // The character was deleted from the form but its photo is still saved.
  const undeclared = buildDirectIntakeSelection(r.state.get(), []);
  assert.deepEqual(undeclared.unmapped, [`family_pet_reference:${FAMILY_ID}`]);
  assert.equal(undeclared.selection.familyCharacterAssets.length, 0);
});

test('payment is blocked while any expected slot is unsettled or unsaved', async () => {
  const r = rig();
  const s = await session(r);
  const expected = [{ slotKey: 'primary_hero_photo', label: 'hero photo' }];

  assert.deepEqual(directUploadBlockers(r.state.get(), expected), ['hero photo']);

  const gate = r.holdNextUpload();
  const inFlight = uploadSlotFile(r.transport, r.state, {
    session: s,
    slot: { category: 'primary_hero_photo' },
    file: jpeg(),
    mimeType: 'image/jpeg',
    size: 64,
  });
  await gate.started;
  assert.deepEqual(directUploadBlockers(r.state.get(), expected), ['hero photo']);
  // Even a slot nothing is waiting on blocks while it is in flight; with no
  // buyer-facing label to use, the slot key is what gets reported.
  assert.deepEqual(directUploadBlockers(r.state.get(), []), ['primary_hero_photo']);

  gate.release();
  await inFlight;
  assert.deepEqual(directUploadBlockers(r.state.get(), expected), []);
});

test('the built selection is exactly the shape the server finalizer accepts', async () => {
  const r = rig();
  const s = await session(r);
  await uploadSlotFile(r.transport, r.state, {
    session: s,
    slot: { category: 'primary_hero_photo' },
    file: jpeg(),
    mimeType: 'image/jpeg',
    size: 64,
  });
  const built = buildDirectIntakeSelection(r.state.get(), []);
  // Compile-time proof that the client and the server agree on the contract.
  const forServer: CheckoutFinalizeSelection = built.selection;
  assert.deepEqual(Object.keys(forServer).sort(), [
    'documentAssetId', 'familyCharacterAssets', 'guidedStillAssetIds', 'primaryHeroPhotoAssetId', 'voiceAssetId',
  ]);
});

test('the high-level checkout orchestrator makes zero intake calls when the client flag is off', async () => {
  let intakeCalls = 0;
  let uploadCalls = 0;
  const transport: IntakeClientTransport = {
    async intake() { intakeCalls += 1; throw new Error('must not be called'); },
    async upload() { uploadCalls += 1; throw new Error('must not be called'); },
  };

  const result = await prepareDirectIntakeSubmission({
    enabled: false,
    transport,
    heroPhoto: jpeg(),
    familyPhotos: [{ familyCharacterId: FAMILY_ID, file: jpeg() }],
    guidedStills: [],
    voice: null,
  });

  assert.equal(result, null);
  assert.equal(intakeCalls, 0);
  assert.equal(uploadCalls, 0);
});

test('the high-level checkout orchestrator uploads every current file and preserves stable family identity', async () => {
  const r = rig();
  const result = await prepareDirectIntakeSubmission({
    enabled: true,
    transport: r.transport,
    heroPhoto: jpeg(20),
    familyPhotos: [{ familyCharacterId: FAMILY_ID, file: jpeg(21) }],
    guidedStills: [],
    voice: { file: new Blob([new Uint8Array(22)], { type: 'audio/mpeg' }), source: 'uploaded', consent: true },
  });

  assert.ok(result);
  assert.ok(result.selection.primaryHeroPhotoAssetId);
  assert.equal(result.selection.familyCharacterAssets[0]?.familyCharacterId, FAMILY_ID);
  assert.ok(result.selection.voiceAssetId);
  assert.deepEqual(result.familyCharacterIds, [FAMILY_ID]);
  assert.equal(r.uploads, 3);
});

test('a direct document upload uses document consent and the document slot, never the voice slot', async () => {
  const r = rig();
  const document = new Blob([new Uint8Array(23)], { type: 'application/pdf' });
  const result = await prepareDirectIntakeSubmission({
    enabled: true,
    transport: r.transport,
    heroPhoto: null,
    familyPhotos: [],
    guidedStills: [],
    voice: null,
    document: { file: document, consent: true, mimeType: document.type },
  });

  assert.ok(result);
  assert.equal(result.selection.voiceAssetId, null);
  assert.ok(result.selection.documentAssetId);
  const record = r.store.records.get(result.session.intakeId)!.record;
  assert.equal(record.consent.childVoiceAuthorizedAt, null);
  assert.ok(record.consent.documentAuthorizedAt);
  assert.equal(record.slots.voice_inspiration, undefined);
  assert.equal(
    record.slots.document_inspiration!.active!.assetId,
    result.selection.documentAssetId,
  );
  assert.equal(r.uploads, 1);
});

test('a direct empty-MIME document derives canonical MIME and stays in the document slot', async () => {
  const r = rig();
  const document = new File([new Uint8Array(23)], 'notes.docx', { type: '' });
  const result = await prepareDirectIntakeSubmission({
    enabled: true,
    transport: r.transport,
    heroPhoto: null,
    familyPhotos: [],
    guidedStills: [],
    voice: null,
    document: { file: document, consent: true, mimeType: document.type },
  });

  assert.ok(result);
  const record = r.store.records.get(result.session.intakeId)!.record;
  assert.equal(record.slots.document_inspiration!.active!.mimeType,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(record.slots.voice_inspiration, undefined);
});

test('a contradictory direct document MIME and extension fails before reserve or upload', async () => {
  const r = rig();
  await assert.rejects(
    prepareDirectIntakeSubmission({
      enabled: true,
      transport: r.transport,
      heroPhoto: null,
      familyPhotos: [],
      guidedStills: [],
      voice: null,
      document: {
        file: new File(['bad'], 'memory.mp3', { type: 'application/pdf' }),
        consent: true,
        mimeType: 'application/pdf',
      },
    }),
    /document_type_invalid/,
  );
  assert.equal(r.reserves, 0);
  assert.equal(r.uploads, 0);
});

test('one failed direct upload aborts preparation while leaving the caller file available for retry', async () => {
  const r = rig();
  const localFile = jpeg(33);
  r.failNextUpload();

  await assert.rejects(
    prepareDirectIntakeSubmission({
      enabled: true,
      transport: r.transport,
      heroPhoto: localFile,
      familyPhotos: [],
      guidedStills: [],
      voice: null,
    }),
    /upload_failed/,
  );
  assert.equal(localFile.size, 33, 'the selected local file remains owned by the form for retry');
  assert.equal(r.uploads, 1);
});

test('a repeated order attempt reuses the exact prepared intake and changed media fails closed', async () => {
  const r = rig();
  const heroPhoto = jpeg(41);
  const params = {
    enabled: true,
    transport: r.transport,
    heroPhoto,
    familyPhotos: [],
    guidedStills: [],
    voice: null,
  };

  const first = await prepareOrReuseDirectIntakeSubmission(params, null);
  assert.ok(first);
  assert.equal(r.uploads, 1);

  const retry = await prepareOrReuseDirectIntakeSubmission(params, first.cache);
  assert.ok(retry);
  assert.equal(retry.submission, first.submission);
  assert.equal(r.uploads, 1, 'an identical retry must not create or upload a second intake');

  await assert.rejects(
    prepareOrReuseDirectIntakeSubmission({ ...params, heroPhoto: jpeg(42) }, first.cache),
    /direct_upload_selection_changed_reload_required/,
  );
  assert.equal(r.uploads, 1, 'changed media may not silently replace a frozen checkout attempt');

  const document = new Blob([new Uint8Array(43)], { type: 'application/pdf' });
  const documentParams = {
    ...params,
    heroPhoto: null,
    document: { file: document, consent: true, mimeType: document.type },
  };
  const documentFirst = await prepareOrReuseDirectIntakeSubmission(documentParams, null);
  assert.ok(documentFirst);
  await assert.rejects(
    prepareOrReuseDirectIntakeSubmission(
      { ...documentParams, document: { ...documentParams.document, file: new Blob([new Uint8Array(44)], { type: 'application/pdf' }) } },
      documentFirst.cache,
    ),
    /direct_upload_selection_changed_reload_required/,
  );
});

test('all five guided UI stills upload and map in canonical index order', async () => {
  const r = rig();
  const files = Array.from({ length: 5 }, (_, index) => jpeg(70 + index));
  const prepared = await prepareDirectIntakeSubmission({
    enabled: true,
    transport: r.transport,
    heroPhoto: null,
    familyPhotos: [],
    guidedStills: files.map((file) => ({ file, mimeType: file.type })),
    voice: null,
  });
  assert.ok(prepared);
  assert.equal(prepared.selection.guidedStillAssetIds.length, 5);
  assert.deepEqual(
    prepared.selection.guidedStillAssetIds,
    [0, 1, 2, 3, 4].map((index) =>
      r.store.records.get(prepared.session.intakeId)!.record.slots[`guided_still:${index}`]!.active!.assetId),
  );
});

test('a sparse guided-still state is refused instead of silently renumbering later poses', async () => {
  const r = rig();
  const s = await session(r);
  for (const index of [0, 1, 3, 4]) {
    await uploadSlotFile(r.transport, r.state, {
      session: s,
      slot: { category: 'guided_still', guidedStillIndex: index },
      file: jpeg(),
      mimeType: 'image/jpeg',
      size: 64,
    });
  }

  const built = buildDirectIntakeSelection(r.state.get(), []);
  assert.deepEqual(built.selection.guidedStillAssetIds, [
    r.state.get().slots['guided_still:0']!.assetId,
    r.state.get().slots['guided_still:1']!.assetId,
  ]);
  assert.deepEqual(built.unmapped, ['guided_still:3', 'guided_still:4']);
});
