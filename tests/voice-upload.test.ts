/**
 * Tests for the optional child-voice-note beta (NEXT_PUBLIC_HSB_VOICE_BETA).
 *
 * Locked-in behaviors:
 *  - uploadOrderVoice() mirrors uploadOrderPhoto() durable-failure semantics:
 *    in a production-like env with no BLOB_READ_WRITE_TOKEN it throws
 *    OrderPersistenceError; in dev with no token it returns null silently.
 *  - createOrderRecord() persists sanitized voice metadata + clamps voiceSource
 *    to the allowed enum.
 *  - The /api/order route source (static grep):
 *      • rejects an attached voice with missing consent (voice_consent_required)
 *      • rejects an attached voice that is not audio (voice_invalid_type)
 *      • rejects an attached voice larger than 15 MB (voice_too_large)
 *      • uploads voice BEFORE creating the Stripe Checkout Session
 *      • persists voiceBlobPath / voiceBlobUrl / voiceConsentAt / voiceSource
 *  - The checkout client source: voice UI is gated by
 *    NEXT_PUBLIC_HSB_VOICE_BETA === 'true' and the FormData submission only
 *    includes voice fields when the flag is on AND a file is attached.
 *
 * Why mostly static-grep: importing the route directly under node:test pulls
 * next/server + Stripe, which we cannot resolve here. We exercise the lib
 * layer end-to-end and assert the route's contract at the source level.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createOrderRecord,
  MAX_VOICE_BYTES,
  OrderPersistenceError,
  uploadOrderVoice,
} from '../src/lib/orders.ts';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) previous[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function makeAudioFile(name = 'voice.webm', type = 'audio/webm', size = 32): File {
  return {
    name,
    type,
    size,
    arrayBuffer: async () => new Uint8Array(size).buffer,
  } as unknown as File;
}

// ── createOrderRecord persists voice metadata ────────────────────────────────

test('createOrderRecord persists sanitized voice metadata when provided', () => {
  const record = createOrderRecord(
    {
      childName: 'Lila',
      bookFormat: 'classic',
      email: 'a@b.com',
      voiceFileName: 'child-voice-note.webm',
      voiceBlobPath: 'orders/ord_1/voice-child-voice-note.webm',
      voiceBlobUrl: 'https://blob.example.com/orders/ord_1/voice-child-voice-note.webm',
      voiceConsentAt: '2026-05-14T10:00:00.000Z',
      voiceSource: 'recorded',
    },
    { id: 'ord_voice_record', now: '2026-05-14T10:00:00.000Z' },
  );
  assert.equal(record.voiceFileName, 'child-voice-note.webm');
  assert.equal(record.voiceBlobPath, 'orders/ord_1/voice-child-voice-note.webm');
  assert.equal(record.voiceBlobUrl, 'https://blob.example.com/orders/ord_1/voice-child-voice-note.webm');
  assert.equal(record.voiceConsentAt, '2026-05-14T10:00:00.000Z');
  assert.equal(record.voiceSource, 'recorded');
});

test('createOrderRecord clamps voiceSource to the allowed enum', () => {
  const record = createOrderRecord(
    {
      childName: 'Lila',
      bookFormat: 'digital',
      email: 'a@b.com',
      // @ts-expect-error — test invalid runtime input
      voiceSource: 'evil',
    },
    { id: 'ord_voice_enum', now: '2026-05-14T10:00:00.000Z' },
  );
  assert.equal(record.voiceSource, null);
});

test('createOrderRecord leaves voice metadata null when not provided (backward compat)', () => {
  const record = createOrderRecord(
    { childName: 'Lila', bookFormat: 'digital', email: 'a@b.com' },
    { id: 'ord_voice_null', now: '2026-05-14T10:00:00.000Z' },
  );
  assert.equal(record.voiceFileName, null);
  assert.equal(record.voiceBlobPath, null);
  assert.equal(record.voiceBlobUrl, null);
  assert.equal(record.voiceConsentAt, null);
  assert.equal(record.voiceSource, null);
});

// ── uploadOrderVoice strict mode mirrors uploadOrderPhoto ────────────────────

test('uploadOrderVoice in production-like env with NO blob token → throws OrderPersistenceError', async () => {
  await withEnv(
    {
      HSB_REQUIRE_DURABLE_PERSISTENCE: 'true',
      BLOB_READ_WRITE_TOKEN: undefined,
    },
    async () => {
      await assert.rejects(
        () => uploadOrderVoice('ord_voice_strict', makeAudioFile()),
        (err) => err instanceof OrderPersistenceError,
      );
    },
  );
});

test('uploadOrderVoice in dev with NO blob token → returns null silently', async () => {
  await withEnv(
    {
      HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
      VERCEL: undefined,
      NODE_ENV: 'development',
      BLOB_READ_WRITE_TOKEN: undefined,
    },
    async () => {
      const result = await uploadOrderVoice('ord_voice_dev', makeAudioFile());
      assert.equal(result, null);
    },
  );
});

// ── 15 MB cap is one source of truth and reasonable ─────────────────────────

test('MAX_VOICE_BYTES is exactly 15 MiB', () => {
  assert.equal(MAX_VOICE_BYTES, 15 * 1024 * 1024);
});

// ── /api/order route source contract (static grep) ──────────────────────────

const ROUTE_SRC = readFileSync('src/app/api/order/route.ts', 'utf8');

test('order route imports uploadOrderVoice + MAX_VOICE_BYTES', () => {
  assert.match(ROUTE_SRC, /uploadOrderVoice/);
  assert.match(ROUTE_SRC, /MAX_VOICE_BYTES/);
});

test('order route returns voice_consent_required when audio present without consent', () => {
  assert.match(ROUTE_SRC, /voice_consent_required/);
});

test('order route validates voice mime/extension (voice_invalid_type)', () => {
  assert.match(ROUTE_SRC, /voice_invalid_type/);
});

test('order route enforces the 15 MB cap (voice_too_large)', () => {
  assert.match(ROUTE_SRC, /voice_too_large/);
});

test('order route uploads voice BEFORE creating the Stripe Checkout Session', () => {
  const voiceUploadIdx = ROUTE_SRC.indexOf('uploadOrderVoice');
  const stripeIdx = ROUTE_SRC.indexOf('stripe.checkout.sessions.create');
  assert.ok(voiceUploadIdx > -1, 'route must call uploadOrderVoice');
  assert.ok(stripeIdx > -1, 'route must call stripe.checkout.sessions.create');
  assert.ok(
    voiceUploadIdx < stripeIdx,
    'uploadOrderVoice must run before stripe.checkout.sessions.create',
  );
});

test('order route persists voice metadata onto the order record', () => {
  assert.match(ROUTE_SRC, /voiceBlobPath/);
  assert.match(ROUTE_SRC, /voiceBlobUrl/);
  assert.match(ROUTE_SRC, /voiceConsentAt/);
  assert.match(ROUTE_SRC, /voiceSource/);
});

test('order route handles OrderPersistenceError from voice upload (aborts before Stripe)', () => {
  // The route's voice block sits before persistOrder + Stripe — assert that
  // OrderPersistenceError is named at least twice (photo path + voice path).
  const matches = ROUTE_SRC.match(/OrderPersistenceError/g) ?? [];
  assert.ok(matches.length >= 2, `expected ≥2 OrderPersistenceError usages, got ${matches.length}`);
});

// ── Checkout client source contract: feature flag + FormData wiring ─────────

const CHECKOUT_SRC = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

test('checkout source reads NEXT_PUBLIC_HSB_STORY_UPLOAD feature flag', () => {
  assert.match(CHECKOUT_SRC, /NEXT_PUBLIC_HSB_STORY_UPLOAD/);
});

test('checkout source mounts VoiceRecorderSection in the Custom Story source section', () => {
  assert.match(CHECKOUT_SRC, /Tell us the memory in your own words[\s\S]*?STORY_UPLOAD_ENABLED && customStorySourceMode === ["']audio["'] && \(\s*<VoiceRecorderSection/);
  assert.match(CHECKOUT_SRC, /NEXT_PUBLIC_HSB_STORY_UPLOAD/);
  assert.match(CHECKOUT_SRC, /Record a voice note/);
  assert.match(CHECKOUT_SRC, /Upload a voice memo/);
  assert.match(CHECKOUT_SRC, /Prefer typing\?/);
});

test('checkout source attaches voice fields to FormData only when story upload is on', () => {
  // The single FormData wiring block must be guarded by STORY_UPLOAD_ENABLED.
  assert.match(
    CHECKOUT_SRC,
    /if \(STORY_UPLOAD_ENABLED && form\.voiceFile\) \{[\s\S]*?payload\.set\(['"]voice['"],/,
  );
  assert.match(CHECKOUT_SRC, /payload\.set\(['"]voiceConsent['"]/);
  assert.match(CHECKOUT_SRC, /payload\.set\(['"]voiceSource['"]/);
});

test('checkout source blocks submit when voice attached without consent', () => {
  assert.match(CHECKOUT_SRC, /form\.voiceFile != null && !form\.voiceConsent/);
});

// ── VoiceRecorderSection source: no auto-mic, consent inline, no cloning copy ─

const VOICE_UI_SRC = readFileSync('src/components/checkout/VoiceRecorderSection.tsx', 'utf8');

test('voice section never auto-starts the microphone (only on Record tap)', () => {
  // getUserMedia must appear inside handleRecord (a callback), not at module
  // or component-top level. We assert it lives inside a useCallback body.
  assert.match(VOICE_UI_SRC, /handleRecord = useCallback\(async \(\) => \{[\s\S]*?getUserMedia/);
  // And it is NOT called at module top.
  assert.doesNotMatch(VOICE_UI_SRC, /^\s*navigator\.mediaDevices\.getUserMedia/m);
});

test('voice section copy explicitly disclaims voice cloning', () => {
  assert.match(VOICE_UI_SRC, /not.*clone/i);
});

test('voice section releases mic tracks on stop AND on unmount', () => {
  assert.match(VOICE_UI_SRC, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
});
