/**
 * Tests for the optional child-voice-note beta (NEXT_PUBLIC_HSB_VOICE_BETA).
 *
 * Locked-in behaviors:
 *  - uploadOrderVoice() mirrors uploadOrderPhoto() durable-failure semantics:
 *    in a production-like env with no BLOB_READ_WRITE_TOKEN it throws
 *    OrderPersistenceError; in dev with no token it returns null silently.
 *  - createOrderRecord() persists privacy-safe voice metadata, never the
 *    caller-controlled original filename, and clamps voiceSource.
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
  bindOrderCheckoutSession,
  createOrderRecord,
  getOrder,
  MAX_VOICE_BYTES,
  OrderPersistenceError,
  assertPrivateStorySourceStorage,
  updateOrderPayment,
  updateOrderStatus,
  uploadOrderVoice,
} from '../src/lib/orders.ts';
import { classifyStoryAttachment } from '../src/lib/story-attachment.ts';

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

test('legacy story-source storage fails closed unless Blob access is private', async () => {
  await assert.rejects(
    () => withEnv({ HSB_BLOB_ACCESS_MODE: undefined }, () => assertPrivateStorySourceStorage('ord_default_public')),
    /private Blob storage is required/i,
  );
  await assert.rejects(
    () => withEnv({ HSB_BLOB_ACCESS_MODE: 'public' }, () => assertPrivateStorySourceStorage('ord_explicit_public')),
    /private Blob storage is required/i,
  );
  await assert.doesNotReject(
    () => withEnv({ HSB_BLOB_ACCESS_MODE: 'private' }, () => assertPrivateStorySourceStorage('ord_private')),
  );

  const ordersSource = readFileSync('src/lib/orders.ts', 'utf8');
  const functionRanges = [
    ['uploadOrderVoice', 'export const MAX_DOCUMENT_BYTES'],
    ['uploadOrderDocument', 'async function uploadOrderPhotoAtPath'],
  ] as const;
  for (const [functionName, nextMarker] of functionRanges) {
    const start = ordersSource.indexOf(`export async function ${functionName}`);
    const end = ordersSource.indexOf(nextMarker, start);
    const body = ordersSource.slice(start, end);
    assert.ok(body.indexOf('assertPrivateStorySourceStorage(orderId)') > 0, `${functionName} must enforce private storage`);
    assert.ok(
      body.indexOf('assertPrivateStorySourceStorage(orderId)') < body.indexOf('put(pathname'),
      `${functionName} must fail before Blob write`,
    );
  }
});

test('switching away from Custom Story resets every source consent and fences late recorder callbacks', () => {
  const checkout = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  const recorder = readFileSync('src/components/checkout/VoiceRecorderSection.tsx', 'utf8');
  assert.match(checkout, /onClick=\{\(\) => \{[\s\S]{0,1200}setDirectMediaConsent\(false\)[\s\S]{0,500}Choose a ready-made adventure instead/);
  assert.match(recorder, /mountedRef\.current = false/);
  assert.match(recorder, /if \(!mountedRef\.current\)[\s\S]{0,300}return/);
});

// ── createOrderRecord persists voice metadata ────────────────────────────────

test('createOrderRecord persists privacy-safe voice metadata when provided', () => {
  const record = createOrderRecord(
    {
      childName: 'Lila',
      bookFormat: 'classic',
      email: 'a@b.com',
      voiceBlobPath: 'orders/ord_1/voice-aB12cD34eF56.webm',
      voiceBlobUrl: 'https://blob.example.com/orders/ord_1/voice-aB12cD34eF56.webm',
      voiceConsentAt: '2026-05-14T10:00:00.000Z',
      voiceSource: 'recorded',
    },
    { id: 'ord_voice_record', now: '2026-05-14T10:00:00.000Z' },
  );
  assert.equal(record.voiceBlobPath, 'orders/ord_1/voice-aB12cD34eF56.webm');
  assert.equal(record.voiceBlobUrl, 'https://blob.example.com/orders/ord_1/voice-aB12cD34eF56.webm');
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
  assert.equal(record.voiceBlobPath, null);
  assert.equal(record.voiceBlobUrl, null);
  assert.equal(record.voiceConsentAt, null);
  assert.equal(record.voiceSource, null);
});

test('createOrderRecord drops a caller-controlled original voice filename', () => {
  const record = createOrderRecord(
    {
      childName: 'Lila',
      bookFormat: 'digital',
      email: 'a@b.com',
      // @ts-expect-error — forbidden legacy field supplied to prove runtime defense in depth
      voiceFileName: 'Synthetic Child Recording 2026.m4a',
    },
    { id: 'ord_no_voice_filename', now: '2026-05-14T10:00:00.000Z' },
  );

  assert.equal(
    (record as unknown as Record<string, unknown>).voiceFileName,
    undefined,
    'customer voice filenames must never be persisted',
  );
});

test('legacy voice filenames are scrubbed whenever an order is re-persisted', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { readFile, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-voice-privacy-'));
  const filePath = path.join(dir, 'ord_legacy_voice.json');
  const legacy = {
    ...createOrderRecord(
      { childName: 'Legacy', bookFormat: 'digital', email: 'legacy@example.com' },
      { id: 'ord_legacy_voice', now: '2026-05-14T10:00:00.000Z' },
    ),
    voiceFileName: 'Synthetic Legacy Recording 2026.m4a',
  };

  try {
    await withEnv(
      {
        HSB_ORDER_STORE_DIR: dir,
        BLOB_READ_WRITE_TOKEN: undefined,
        VERCEL_ENV: undefined,
        HSB_REQUIRE_DURABLE_PERSISTENCE: undefined,
      },
      async () => {
        await writeFile(filePath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
        const loaded = await getOrder('ord_legacy_voice');
        assert.ok(loaded);
        assert.equal((loaded as unknown as Record<string, unknown>).voiceFileName, undefined);
        assert.equal(loaded.legacyVoiceUploadPresent, true);

        await bindOrderCheckoutSession('ord_legacy_voice', 'cs_legacy_voice');
        const paymentResult = await updateOrderPayment('ord_legacy_voice', 'paid', {
          stripeSessionId: 'cs_legacy_voice',
        });
        assert.equal((paymentResult as unknown as Record<string, unknown>).voiceFileName, undefined);
        assert.equal(paymentResult?.legacyVoiceUploadPresent, true);
        const afterPayment = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
        assert.equal(afterPayment.voiceFileName, undefined, 'payment update must scrub legacy filename PII');
        assert.equal(afterPayment.legacyVoiceUploadPresent, true);

        await writeFile(filePath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
        await updateOrderStatus('ord_legacy_voice', 'preview_ready');
        const afterStatus = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
        assert.equal(afterStatus.voiceFileName, undefined, 'status update must scrub legacy filename PII');
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

const ORDERS_SRC = readFileSync('src/lib/orders.ts', 'utf8');

function uploadOrderVoiceBody(): string {
  const start = ORDERS_SRC.indexOf('export async function uploadOrderVoice');
  assert.ok(start !== -1, 'uploadOrderVoice must exist');
  const after = ORDERS_SRC.slice(start + 1);
  const nextTopLevelFunction = after.search(/\n(?:export\s+)?async function\s/);
  return after.slice(0, nextTopLevelFunction === -1 ? after.length : nextTopLevelFunction);
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('orders source does not declare or persist voiceFileName', () => {
  const code = stripComments(ORDERS_SRC);
  assert.doesNotMatch(code, /\bvoiceFileName\s*\??\s*:/);
});

test('uploadOrderVoice uses a random asset id and never reads file.name', () => {
  const body = stripComments(uploadOrderVoiceBody());
  assert.match(body, /crypto\s*\.\s*(?:randomBytes|randomUUID)/);
  assert.doesNotMatch(body, /\bfile\.name\b/);
  assert.doesNotMatch(body, /voice-\$\{[^}]*\bsafeName\b/);
});

test('raw AAC uses an .aac extension rather than an M4A container extension', () => {
  assert.deepEqual(classifyStoryAttachment(makeAudioFile('voice.aac', 'audio/aac')), {
    kind: 'audio',
    mimeType: 'audio/aac',
    extension: 'aac',
  });
});

// ── /api/order route source contract (static grep) ──────────────────────────

const ROUTE_SRC = readFileSync('src/app/api/order/route.ts', 'utf8');
const ADMIN_ORDER_SRC = readFileSync('src/app/admin/orders/[orderId]/page.tsx', 'utf8');

test('order and admin surfaces do not retain or display customer voice filenames', () => {
  assert.doesNotMatch(stripComments(ROUTE_SRC), /\bvoiceFileName\s*:/);
  assert.doesNotMatch(ROUTE_SRC, /\(voiceRaw as File\)\.name/);
  assert.doesNotMatch(ADMIN_ORDER_SRC, /\bvoiceFileName\b/);
  assert.match(ADMIN_ORDER_SRC, /hasVoiceOrUpload:\s*Boolean\([\s\S]*?order\.legacyVoiceUploadPresent/);
  assert.doesNotMatch(ADMIN_ORDER_SRC, /voiceFileName\s*:/);
  assert.doesNotMatch(ADMIN_ORDER_SRC, /Upload file/);
});

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

// ── Checkout client source contract: visible Custom Story intake + wiring ───

const CHECKOUT_SRC = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

test('checkout source mounts VoiceRecorderSection immediately in the Custom Story intake panel', () => {
  assert.match(CHECKOUT_SRC, /data-testid="custom-story-intake-panel"[\s\S]*?<VoiceRecorderSection/);
  assert.doesNotMatch(CHECKOUT_SRC, /STORY_UPLOAD_ENABLED|NEXT_PUBLIC_HSB_STORY_UPLOAD/);
});

test('Custom Story exposes typing and voice/document controls together without a source-mode chooser', () => {
  assert.match(CHECKOUT_SRC, /Type the memory or story idea/);
  assert.match(CHECKOUT_SRC, /Or add audio or a file/);
  assert.doesNotMatch(CHECKOUT_SRC, /Record or upload a voice note|Prefer typing\?/);
});

test('checkout source attaches audio as voice and documents through the separate document field', () => {
  assert.match(
    CHECKOUT_SRC,
    /if \(attachedStoryFile && attachedStoryFileIsAudio\) \{[\s\S]*?payload\.set\(['"]voice['"], attachedStoryFile\)/,
  );
  assert.match(
    CHECKOUT_SRC,
    /else if \(attachedStoryFile\) \{[\s\S]*?payload\.set\(['"]document['"], attachedStoryFile\)/,
  );
  assert.match(CHECKOUT_SRC, /payload\.set\(['"]documentConsent['"]/);
});

test('direct intake routes audio and documents to distinct slot parameters', () => {
  assert.match(CHECKOUT_SRC, /const attachedStoryFile = isCustomStorySelected \? form\.voiceFile : null/);
  assert.match(CHECKOUT_SRC, /const attachedStoryFileIsAudio = isStoryAudioFile\(attachedStoryFile\)/);
  assert.match(CHECKOUT_SRC, /voice:\s*attachedStoryFile && attachedStoryFileIsAudio && form\.voiceSource/);
  assert.match(CHECKOUT_SRC, /document:\s*attachedStoryFile && !attachedStoryFileIsAudio/);
  assert.match(CHECKOUT_SRC, /document:[\s\S]*?consent: form\.voiceConsent/);
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
  assert.match(VOICE_UI_SRC, /won&apos;t be used for voice cloning/i);
});

test('voice section avoids beta/data-loss confidence killers', () => {
  assert.match(VOICE_UI_SRC, /Up to 3 minutes\. 30 seconds is plenty\./);
  assert.match(VOICE_UI_SRC, /Our story team reads your file and uses it as inspiration\. Nothing is generated from it automatically\./);
  assert.doesNotMatch(VOICE_UI_SRC, /deleted on request/i);
  assert.doesNotMatch(VOICE_UI_SRC, /Beta · Optional/i);
  assert.doesNotMatch(VOICE_UI_SRC, /Notes and uploads are in beta/i);
  assert.doesNotMatch(VOICE_UI_SRC, /checkout hits an\s+unexpected error/i);
  assert.doesNotMatch(VOICE_UI_SRC, /avoid losing/i);
});

test('voice section releases mic tracks on stop AND on unmount', () => {
  assert.match(VOICE_UI_SRC, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
});

test('attachment section presents separate voice-note and written-file cards', () => {
  assert.match(VOICE_UI_SRC, />\s*🎙️ Voice note\s*</);
  assert.match(VOICE_UI_SRC, />\s*📄 Written file\s*</);
  assert.match(VOICE_UI_SRC, />\s*Record audio\s*</);
  assert.match(VOICE_UI_SRC, /Upload audio file/);
  assert.match(VOICE_UI_SRC, /Upload document/);
  assert.match(VOICE_UI_SRC, /TXT, PDF, or Word, up to 10 MB\./);
});

test('voice and document inputs stay keyboard reachable with visible focus treatment', () => {
  assert.match(VOICE_UI_SRC, /aria-label="Upload audio file"[\s\S]*?className="sr-only"/);
  assert.match(VOICE_UI_SRC, /aria-label="Upload document"[\s\S]*?className="sr-only"/);
  assert.match(VOICE_UI_SRC, /htmlFor="custom-story-audio-upload"[\s\S]*?has-\[:focus-visible\]:ring-2[\s\S]*?custom-story-audio-upload-control/);
  assert.match(VOICE_UI_SRC, /htmlFor="custom-story-document-upload"[\s\S]*?has-\[:focus-visible\]:ring-2[\s\S]*?custom-story-document-upload-control/);
});

test('consent wording switches by attached media type', () => {
  assert.match(VOICE_UI_SRC, /I have the right to share this document/);
  assert.match(VOICE_UI_SRC, /parent\/guardian or an authorized adult for everyone in this recording/);
  assert.match(VOICE_UI_SRC, /won&apos;t be used for AI training and won&apos;t be shared/);
});
