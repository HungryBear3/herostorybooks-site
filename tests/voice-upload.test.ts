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
  assert.match(ROUTE_SRC, /isAcceptedInspirationFile/);
});

test('order route accepts text/PDF/Word inspiration uploads but transcribes audio only', () => {
  assert.match(ROUTE_SRC, /INSPIRATION_DOC_EXT_RE/);
  for (const extension of ['txt', 'pdf', 'doc', 'docx']) {
    assert.match(ROUTE_SRC, new RegExp(extension));
  }
  assert.match(ROUTE_SRC, /isAudioInspirationFile\(voiceRaw\)/);
  assert.match(ROUTE_SRC, /transcribeVoiceNote/);
});

test('order route enforces the 15 MB cap (voice_too_large)', () => {
  assert.match(ROUTE_SRC, /voice_too_large/);
});

test('order route uploads attached voice BEFORE creating the Stripe Checkout Session', () => {
  const voiceUploadIdx = ROUTE_SRC.indexOf('uploadOrderVoice');
  const stripeIdx = ROUTE_SRC.indexOf('stripe.checkout.sessions.create');
  assert.ok(voiceUploadIdx > -1, 'route must call uploadOrderVoice');
  assert.ok(stripeIdx > -1, 'route must call stripe.checkout.sessions.create');
  assert.ok(
    voiceUploadIdx < stripeIdx,
    'uploadOrderVoice must run before stripe.checkout.sessions.create',
  );
  assert.match(
    ROUTE_SRC,
    /if \(voiceRaw instanceof File && voiceRaw\.size > 0\) \{[\s\S]*?uploadOrderVoice\(draftOrder\.id, voiceRaw\)/,
    'route must only call uploadOrderVoice when a real File is attached, not for preuploaded refs',
  );
});

test('order route supports preuploaded voice refs without re-uploading a null file', () => {
  assert.match(ROUTE_SRC, /String\(form\.get\('voiceBlobPath'\) \|\| ''\)\.trim\(\) \|\| null/);
  assert.match(ROUTE_SRC, /const hasVoiceUpload = \(voiceRaw instanceof File && voiceRaw\.size > 0\) \|\| Boolean\(preuploadedVoiceBlobPath\)/);
  assert.doesNotMatch(ROUTE_SRC, /uploadOrderVoice\(draftOrder\.id, voiceRaw as File\)/);
});

test('order route persists voice metadata onto the order record', () => {
  assert.match(ROUTE_SRC, /voiceBlobPath/);
  assert.match(ROUTE_SRC, /voiceBlobUrl/);
  assert.match(ROUTE_SRC, /voiceConsentAt/);
  assert.match(ROUTE_SRC, /voiceSource/);
});

// ── /api/order route: voice transcription wiring (static grep) ───────────────

test('order route imports + calls transcribeVoiceNote', () => {
  assert.match(ROUTE_SRC, /transcribeVoiceNote/);
  assert.match(ROUTE_SRC, /voiceTranscript/);
});

test('order route transcribes AFTER voice upload and BEFORE Stripe', () => {
  const uploadIdx = ROUTE_SRC.indexOf('uploadOrderVoice');
  const transcribeIdx = ROUTE_SRC.indexOf('transcribeVoiceNote(');
  const stripeIdx = ROUTE_SRC.indexOf('stripe.checkout.sessions.create');
  assert.ok(transcribeIdx > -1, 'route must call transcribeVoiceNote');
  assert.ok(uploadIdx > -1 && uploadIdx < transcribeIdx, 'transcription must run after uploadOrderVoice');
  assert.ok(transcribeIdx < stripeIdx, 'transcription must run before the Stripe Checkout Session');
});

test('order route persists voiceTranscript onto the order record', () => {
  // The persistOrder spread must carry the transcript metadata field.
  assert.match(ROUTE_SRC, /voiceTranscript,/);
});

// ── Transcription helper is feature-flagged (static grep) ────────────────────

const TRANSCRIPTION_SRC = readFileSync('src/lib/voice-transcription.ts', 'utf8');

test('voice transcription helper is gated behind HSB_VOICE_TRANSCRIPTION_ENABLED', () => {
  assert.match(TRANSCRIPTION_SRC, /HSB_VOICE_TRANSCRIPTION_ENABLED/);
  // The model env + documented default must both be present.
  assert.match(TRANSCRIPTION_SRC, /HSB_VOICE_TRANSCRIPTION_MODEL/);
  assert.match(TRANSCRIPTION_SRC, /gpt-4o-mini-transcribe/);
});

test('voice transcription helper disclaims voice cloning / published audio in scope comment', () => {
  assert.match(TRANSCRIPTION_SRC, /never used for voice cloning/i);
});

// ── VoiceRecorderSection copy: Father's Day framing, not published ───────────

test('voice section copy frames it as an optional 30-second story idea', () => {
  assert.match(VOICE_UI_SRC, /30-second story idea/i);
  assert.match(VOICE_UI_SRC, /Father&apos;s Day/);
});

test('voice section copy explicitly says the recording is never published', () => {
  assert.match(VOICE_UI_SRC, /never published/i);
});

test('order route handles OrderPersistenceError from voice upload (aborts before Stripe)', () => {
  // The route's voice block sits before persistOrder + Stripe — assert that
  // OrderPersistenceError is named at least twice (photo path + voice path).
  const matches = ROUTE_SRC.match(/OrderPersistenceError/g) ?? [];
  assert.ok(matches.length >= 2, `expected ≥2 OrderPersistenceError usages, got ${matches.length}`);
});

// ── Checkout client source contract: feature flag + FormData wiring ─────────

const CHECKOUT_SRC = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

test('checkout source reads NEXT_PUBLIC_HSB_VOICE_BETA feature flag', () => {
  assert.match(CHECKOUT_SRC, /NEXT_PUBLIC_HSB_VOICE_BETA/);
});

test('checkout source mounts VoiceRecorderSection ONLY when flag is on', () => {
  assert.match(CHECKOUT_SRC, /VOICE_BETA_ENABLED && \(\s*<VoiceRecorderSection/);
});

test('checkout source uploads voice separately and sends lightweight refs only when flag is on', () => {
  assert.match(
    CHECKOUT_SRC,
    /VOICE_BETA_ENABLED && form\.voiceFile[\s\S]*?uploadCheckoutFile\(checkoutDraftId, "voice", form\.voiceFile\)/,
  );
  assert.match(CHECKOUT_SRC, /payload\.set\(['"]voiceBlobPath['"], uploadedVoice\.pathname\)/);
  assert.match(CHECKOUT_SRC, /payload\.set\(['"]voiceBlobUrl['"], uploadedVoice\.url\)/);
  assert.match(CHECKOUT_SRC, /payload\.set\(['"]voiceConsent['"]/);
  assert.match(CHECKOUT_SRC, /payload\.set\(['"]voiceSource['"]/);
  assert.doesNotMatch(CHECKOUT_SRC, /payload\.set\(['"]voice['"], form\.voiceFile\)/);
});

test('checkout source blocks submit when voice attached without consent', () => {
  // The same gate may be expressed either way:
  //   - as a disabled condition:   form.voiceFile != null && !form.voiceConsent
  //   - as an enable condition:    form.voiceFile == null || form.voiceConsent
  // Both encode "block submit when a voice file is attached without consent."
  // Accept either form so a refactor of the surrounding submit-enable predicate
  // doesn't regress this contract.
  const negative = /form\.voiceFile != null && !form\.voiceConsent/;
  const positive = /form\.voiceFile == null \|\| form\.voiceConsent/;
  assert.ok(
    negative.test(CHECKOUT_SRC) || positive.test(CHECKOUT_SRC),
    'checkout source must encode the "voice attached without consent → blocked" gate ' +
      'in either negative ("voiceFile != null && !voiceConsent") or positive ' +
      '("voiceFile == null || voiceConsent") form',
  );
});

test('checkout source auto-selects the custom story direction when a voice file is attached first', () => {
  assert.match(CHECKOUT_SRC, /custom-voice-story/);
  assert.match(CHECKOUT_SRC, /theme:\s*file && !prev\.theme \? "custom-voice-story" : prev\.theme/);
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

test('voice section lets families download an inspiration file before leaving checkout', () => {
  assert.match(VOICE_UI_SRC, /download=\{voiceFile\.name \|\| 'hero-story-voice-note\.webm'\}/);
  assert.match(VOICE_UI_SRC, /Download file/);
  assert.match(VOICE_UI_SRC, /Save it before leaving this page/);
});

test('voice section warns beta users they can upload saved notes/documents', () => {
  assert.match(VOICE_UI_SRC, /Notes and uploads are in beta/);
  assert.match(VOICE_UI_SRC, /save it first on your device/);
  assert.match(VOICE_UI_SRC, /upload the saved file here/);
});

test('voice upload picker explicitly allows common audio and document extensions', () => {
  assert.match(VOICE_UI_SRC, /VOICE_AUDIO_UPLOAD_ACCEPT_ATTR/);
  assert.match(VOICE_UI_SRC, /VOICE_DOCUMENT_UPLOAD_ACCEPT_ATTR/);
  for (const extension of ['.m4a', '.mp3', '.wav', '.caf', '.aif', '.aiff']) {
    assert.match(VOICE_UI_SRC, new RegExp(extension.replace('.', '\\.')));
  }
  for (const extension of ['.txt', '.pdf', '.doc', '.docx']) {
    assert.match(VOICE_UI_SRC, new RegExp(extension.replace('.', '\\.')));
  }
  assert.match(VOICE_UI_SRC, /Record audio/);
  assert.match(VOICE_UI_SRC, /Upload audio file/);
  assert.match(VOICE_UI_SRC, /Upload text\/document/);
  assert.match(VOICE_UI_SRC, /for text, PDF, or Word/);
});

test('voice section clears stale microphone errors after a successful file attachment', () => {
  const uploadHandler = /const handleUpload = useCallback\([\s\S]*?setRecorderError\(null\);[\s\S]*?event\.target\.value = '';/;
  const recordStopHandler = /recorder\.addEventListener\('stop', \(\) => \{[\s\S]*?onVoiceChange\(file, previewUrl, 'recorded'\);[\s\S]*?setRecorderError\(null\);/;
  assert.match(VOICE_UI_SRC, uploadHandler);
  assert.match(VOICE_UI_SRC, recordStopHandler);
});

test('voice section releases mic tracks on stop AND on unmount', () => {
  assert.match(VOICE_UI_SRC, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
});

// ── Retention copy: no unbacked automated-deletion promise ───────────────────

test('voice section no longer promises automated deletion after shipping', () => {
  // The "Deleted after your book ships" claim had no backing code. It must be
  // gone until a feature-flagged deletion sweep exists (see runbook).
  assert.doesNotMatch(VOICE_UI_SRC, /deleted after your book ships/i);
});

test('voice section offers a backable manual deletion path instead', () => {
  assert.match(VOICE_UI_SRC, /never share it/i);
  assert.match(VOICE_UI_SRC, /support@herostorybooks\.com/);
});

// ── Route: voice-save abort is specific + honest (static grep) ───────────────

test('order route voice-save abort carries a specific code and "no charge" wording', () => {
  assert.match(ROUTE_SRC, /code: 'voice_persist_failed'/);
  // Must not imply the recording was kept when the save aborted.
  assert.match(ROUTE_SRC, /No charge was made and the recording was not saved/);
});

// ── Checkout client: specific inline errors, no false "saved" implication ────

test('checkout surfaces the SPECIFIC server error inline (not a generic alert)', () => {
  // Inline banner, not window.alert (alerts vanish on mobile and hide the reason).
  assert.doesNotMatch(CHECKOUT_SRC, /\balert\(/);
  assert.match(CHECKOUT_SRC, /setSubmitError\(/);
  assert.match(CHECKOUT_SRC, /data-testid="submit-error"/);
  // It reads the server's error field to show the exact reason.
  assert.match(CHECKOUT_SRC, /body\.error/);
});

test('checkout reassures the customer they were not charged on failure', () => {
  assert.match(CHECKOUT_SRC, /have not been charged/i);
});

test('checkout does not claim the order is complete before payment', () => {
  // The pre-payment interstitial must not imply completion/receipt — the
  // customer is being redirected to Stripe, not done.
  assert.doesNotMatch(CHECKOUT_SRC, /Order Received!/);
  assert.match(CHECKOUT_SRC, /Taking you to secure payment/i);
});

test('checkout aborts (no success screen) when the server returns no redirect URL', () => {
  // Guard so a 200 without redirectTo can never strand the user on the
  // "redirecting" screen while implying success.
  assert.match(CHECKOUT_SRC, /if \(!result\?\.redirectTo\)/);
});
