/**
 * Operator retrieval of an order's PRIVATE intake asset bytes.
 *
 * Every test here pins one refusal or one guarantee of the admin-only
 * `GET /api/admin/orders/[orderId]/intake-assets/[assetId]` surface. The
 * handler takes injected order/provider/auth dependencies, so nothing in this
 * file touches Vercel, Stripe, a customer, or a real provider.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adminIntakeAssetOptionsReply,
  adminIntakeAssetUnsupportedMethodReply,
  handleAdminIntakeAssetRequest,
  listAdminIntakeAssets,
  type AdminIntakeAssetLogEvent,
  type IntakeAssetObject,
} from '../src/lib/admin-intake-asset-route-handler.ts';
import {
  finalizationFingerprint,
  intakeAssetPath,
  type FinalizedSelectionEntry,
} from '../src/lib/checkout-intake.ts';
import {
  createOrderRecord,
  type FamilyCharacter,
  type OrderRecord,
} from '../src/lib/orders.ts';

const ORDER_ID = 'ord_admin_intake_read';
const INTAKE_ID = 'intake_abababababababababababababababab';
const INTAKE_TOKEN = 'vercel_blob_rw_INTAKESTORE00_intakesecret';

const HERO_ASSET = `asset_${'1'.repeat(32)}`;
const FAMILY_ASSET = `asset_${'2'.repeat(32)}`;
const GUIDED_ASSET = `asset_${'3'.repeat(32)}`;
const VOICE_ASSET = `asset_${'4'.repeat(32)}`;
const DOCUMENT_ASSET = `asset_${'5'.repeat(32)}`;

const CONSENT_AT = '2026-09-17T10:00:00.000Z';

async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const original = {
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  const lines: string[] = [];
  const capture = (...values: unknown[]) => lines.push(values.map(String).join(' '));
  console.error = capture;
  console.info = capture;
  console.log = capture;
  console.warn = capture;
  try {
    return { result: await fn(), output: lines.join('\n') };
  } finally {
    console.error = original.error;
    console.info = original.info;
    console.log = original.log;
    console.warn = original.warn;
  }
}

function bytes(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function streamOf(payload: Uint8Array, chunk = 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= payload.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(payload.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
}

function entry(
  category: FinalizedSelectionEntry['category'],
  assetId: string,
  overrides: Partial<FinalizedSelectionEntry> = {},
): FinalizedSelectionEntry {
  const familyCharacterId = category === 'family_pet_reference' ? 'char-bruno' : null;
  const guidedStillIndex = category === 'guided_still' ? 0 : null;
  const slotKey = category === 'family_pet_reference'
    ? `${category}:${familyCharacterId}`
    : category === 'guided_still'
      ? `${category}:${guidedStillIndex}`
      : category;
  const mimeType = category === 'voice_inspiration'
    ? 'audio/mp4'
    : category === 'document_inspiration'
      ? 'application/pdf'
      : 'image/jpeg';
  return {
    slotKey,
    category,
    familyCharacterId,
    familyCharacterIndex: category === 'family_pet_reference' ? 0 : null,
    guidedStillIndex,
    assetId,
    pathname: intakeAssetPath(INTAKE_ID, assetId),
    mimeType,
    size: 2048,
    etag: 'etag-abc',
    generation: 1,
    consentAt: CONSENT_AT,
    voiceSource: category === 'voice_inspiration' ? 'recorded' : null,
    ...overrides,
  };
}

function familyCharacter(media: FinalizedSelectionEntry | null): FamilyCharacter {
  return {
    role: 'sibling',
    name: 'Bruno',
    relationshipLabel: 'brother',
    pronouns: 'he/him',
    notes: '',
    isGiftRecipient: false,
    appearsInStory: true,
    photoFileName: null,
    photoBlobPath: null,
    photoBlobUrl: null,
    likenessIntent: 'reference',
    mustInclude: [],
    mustIncludeOther: '',
    focusPersonLabel: null,
    cropHint: null,
    checkoutIntakeMedia: media,
  };
}

/** A fully coherent, actively retained, intake-bound order. */
function boundOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const hero = entry('primary_hero_photo', HERO_ASSET);
  const family = entry('family_pet_reference', FAMILY_ASSET);
  const guided = entry('guided_still', GUIDED_ASSET);
  const voice = entry('voice_inspiration', VOICE_ASSET);
  const selection = [hero, family, guided, voice];
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' },
    { id: ORDER_ID, now: '2026-09-17T10:05:00.000Z' },
  );
  return {
    ...base,
    familyCharacters: [familyCharacter(family)],
    checkoutIntake: {
      intakeId: INTAKE_ID,
      fingerprint: finalizationFingerprint(INTAKE_ID, selection),
      orderContractDigest: 'a'.repeat(64),
      selection,
    },
    checkoutIntakeMediaRetention: { status: 'active', activatedAt: CONSENT_AT },
    primaryHeroIntakeMedia: hero,
    guidedStillIntakeMedia: [guided],
    voiceIntakeMedia: voice,
    documentIntakeMedia: null,
    ...overrides,
  } as OrderRecord;
}

/** A document-bearing variant; voice and document are mutually exclusive. */
function documentOrder(): OrderRecord {
  const hero = entry('primary_hero_photo', HERO_ASSET);
  const document = entry('document_inspiration', DOCUMENT_ASSET);
  const selection = [hero, document];
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' },
    { id: ORDER_ID, now: '2026-09-17T10:05:00.000Z' },
  );
  return {
    ...base,
    familyCharacters: [],
    checkoutIntake: {
      intakeId: INTAKE_ID,
      fingerprint: finalizationFingerprint(INTAKE_ID, selection),
      orderContractDigest: 'a'.repeat(64),
      selection,
    },
    checkoutIntakeMediaRetention: { status: 'active', activatedAt: CONSENT_AT },
    primaryHeroIntakeMedia: hero,
    guidedStillIntakeMedia: [],
    voiceIntakeMedia: null,
    documentIntakeMedia: document,
  } as OrderRecord;
}

interface CallOptions {
  order?: OrderRecord | null;
  object?: Partial<IntakeAssetObject> | null;
  objectError?: Error;
  authed?: boolean;
  token?: () => string;
  request?: Request;
}

function call(assetId: string, options: CallOptions = {}) {
  const logs: AdminIntakeAssetLogEvent[] = [];
  const opened: string[] = [];
  const order = options.order === undefined ? boundOrder() : options.order;
  const bound = order?.checkoutIntake?.selection.find((item) => item.assetId === assetId) ?? null;
  const payload = bytes(bound?.size ?? 2048);
  const promise = handleAdminIntakeAssetRequest(
    options.request ?? new Request('https://hsb.test/api/admin/orders/x/intake-assets/y'),
    ORDER_ID,
    assetId,
    {
      isAdminAuthed: () => options.authed !== false,
      readOrder: async () => order,
      intakeToken: options.token ?? (() => INTAKE_TOKEN),
      openIntakeAsset: async (pathname, token) => {
        opened.push(`${pathname}|${token}`);
        if (options.objectError) throw options.objectError;
        if (options.object === null) return null;
        return {
          pathname,
          contentType: bound?.mimeType ?? 'image/jpeg',
          size: bound?.size ?? 2048,
          stream: streamOf(payload),
          ...options.object,
        } as IntakeAssetObject;
      },
      log: (event) => logs.push(event),
    },
  );
  return { promise, logs, opened, payload };
}

// ── Authentication ───────────────────────────────────────────────────────────

test('refuses an unauthenticated request before reading the order', async () => {
  let readCalls = 0;
  const reply = await handleAdminIntakeAssetRequest(
    new Request('https://hsb.test/x'),
    ORDER_ID,
    HERO_ASSET,
    {
      isAdminAuthed: () => false,
      readOrder: async () => { readCalls += 1; return boundOrder(); },
      intakeToken: () => INTAKE_TOKEN,
      openIntakeAsset: async () => { throw new Error('must not open'); },
    },
  );
  assert.equal(reply.status, 401);
  assert.equal(readCalls, 0);
});

test('uses the real admin cookie boundary, rejecting a wrong key', async () => {
  const previous = process.env.HSB_ORDER_ADMIN_KEY;
  process.env.HSB_ORDER_ADMIN_KEY = 'the-real-ops-key';
  try {
    const wrong = await handleAdminIntakeAssetRequest(
      new Request('https://hsb.test/x', { headers: { cookie: 'hsb-ops-key=nope' } }),
      ORDER_ID,
      HERO_ASSET,
      { readOrder: async () => boundOrder(), intakeToken: () => INTAKE_TOKEN,
        openIntakeAsset: async () => { throw new Error('must not open'); } },
    );
    assert.equal(wrong.status, 401);

    const right = await handleAdminIntakeAssetRequest(
      new Request('https://hsb.test/x', { headers: { cookie: 'hsb-ops-key=the-real-ops-key' } }),
      ORDER_ID,
      HERO_ASSET,
      {
        readOrder: async () => boundOrder(),
        intakeToken: () => INTAKE_TOKEN,
        openIntakeAsset: async (pathname) => ({
          pathname, contentType: 'image/jpeg', size: 2048, stream: streamOf(bytes(2048)),
        }),
      },
    );
    assert.equal(right.status, 200);
  } finally {
    if (previous === undefined) delete process.env.HSB_ORDER_ADMIN_KEY;
    else process.env.HSB_ORDER_ADMIN_KEY = previous;
  }
});

test('an admin key in the query string grants nothing', async () => {
  const previous = process.env.HSB_ORDER_ADMIN_KEY;
  process.env.HSB_ORDER_ADMIN_KEY = 'the-real-ops-key';
  try {
    const reply = await handleAdminIntakeAssetRequest(
      new Request('https://hsb.test/x?key=the-real-ops-key'),
      ORDER_ID,
      HERO_ASSET,
      { readOrder: async () => boundOrder(), intakeToken: () => INTAKE_TOKEN,
        openIntakeAsset: async () => { throw new Error('must not open'); } },
    );
    assert.equal(reply.status, 401);
  } finally {
    if (previous === undefined) delete process.env.HSB_ORDER_ADMIN_KEY;
    else process.env.HSB_ORDER_ADMIN_KEY = previous;
  }
});

// ── Order and asset resolution ───────────────────────────────────────────────

test('refuses a missing order without opening storage', async () => {
  const { promise, opened } = call(HERO_ASSET, { order: null });
  const reply = await promise;
  assert.equal(reply.status, 404);
  assert.deepEqual(opened, []);
});

test('refuses a malformed asset id', async () => {
  const { promise, opened } = call('asset_not-hex');
  const reply = await promise;
  assert.equal(reply.status, 404);
  assert.deepEqual(opened, []);
});

test('refuses an asset id that is not in this order selection', async () => {
  const { promise, opened } = call(`asset_${'9'.repeat(32)}`);
  const reply = await promise;
  assert.equal(reply.status, 404);
  assert.deepEqual(opened, []);
});

test('refuses an order with no intake binding at all', async () => {
  const order = boundOrder({
    checkoutIntake: null,
    checkoutIntakeMediaRetention: null,
    primaryHeroIntakeMedia: null,
    guidedStillIntakeMedia: [],
    voiceIntakeMedia: null,
    familyCharacters: [familyCharacter(null)],
  });
  const reply = await call(HERO_ASSET, { order }).promise;
  assert.equal(reply.status, 404);
});

test('refuses a selection carrying the same asset id twice', async () => {
  const order = boundOrder();
  const duplicated = entry('guided_still', HERO_ASSET, {
    slotKey: 'guided_still:1', guidedStillIndex: 1,
  });
  order.checkoutIntake!.selection = [...order.checkoutIntake!.selection, duplicated];
  const { promise, opened } = call(HERO_ASSET, { order });
  assert.equal((await promise).status, 404);
  assert.deepEqual(opened, []);
});

test('refuses a selection carrying the same slot twice', async () => {
  const order = boundOrder();
  order.checkoutIntake!.selection = [
    ...order.checkoutIntake!.selection,
    entry('guided_still', `asset_${'6'.repeat(32)}`),
  ];
  assert.equal((await call(HERO_ASSET, { order }).promise).status, 404);
});

test('refuses a malformed selection entry', async () => {
  const order = boundOrder();
  order.checkoutIntake!.selection[0] = {
    ...order.checkoutIntake!.selection[0]!,
    mimeType: 'application/x-msdownload',
  };
  assert.equal((await call(HERO_ASSET, { order }).promise).status, 404);
});

test('refuses an entry whose pathname is not the derived intake asset path', async () => {
  const order = boundOrder();
  order.checkoutIntake!.selection[0] = {
    ...order.checkoutIntake!.selection[0]!,
    pathname: 'orders/ord_admin_intake_read/somewhere-else',
  };
  const { promise, opened } = call(HERO_ASSET, { order });
  assert.equal((await promise).status, 404);
  assert.deepEqual(opened, []);
});

test('refuses a selection whose fingerprint does not cover it', async () => {
  const order = boundOrder();
  order.checkoutIntake!.fingerprint = 'f'.repeat(64);
  assert.equal((await call(HERO_ASSET, { order }).promise).status, 404);
});

// ── Mirrored binding coherence ───────────────────────────────────────────────

test('refuses a hero asset whose mirrored primaryHeroIntakeMedia disagrees', async () => {
  const order = boundOrder();
  order.primaryHeroIntakeMedia = { ...order.primaryHeroIntakeMedia!, size: 4096 };
  const { promise, opened } = call(HERO_ASSET, { order });
  assert.equal((await promise).status, 404);
  assert.deepEqual(opened, []);
});

test('refuses a hero asset with no mirrored binding at all', async () => {
  const order = boundOrder({ primaryHeroIntakeMedia: null });
  assert.equal((await call(HERO_ASSET, { order }).promise).status, 404);
});

test('refuses a family asset whose character mirror is missing', async () => {
  const order = boundOrder({ familyCharacters: [familyCharacter(null)] });
  assert.equal((await call(FAMILY_ASSET, { order }).promise).status, 404);
});

test('refuses a family asset mirrored on the wrong character index', async () => {
  const order = boundOrder();
  const media = order.checkoutIntake!.selection.find((e) => e.assetId === FAMILY_ASSET)!;
  order.familyCharacters = [familyCharacter(null), familyCharacter(media)];
  assert.equal((await call(FAMILY_ASSET, { order }).promise).status, 404);
});

test('refuses a guided still absent from guidedStillIntakeMedia', async () => {
  const order = boundOrder({ guidedStillIntakeMedia: [] });
  assert.equal((await call(GUIDED_ASSET, { order }).promise).status, 404);
});

test('refuses a voice asset whose mirror disagrees', async () => {
  const order = boundOrder();
  order.voiceIntakeMedia = { ...order.voiceIntakeMedia!, consentAt: '2026-01-01T00:00:00.000Z' };
  assert.equal((await call(VOICE_ASSET, { order }).promise).status, 404);
});

test('refuses a document asset whose mirror is missing', async () => {
  const order = documentOrder();
  order.documentIntakeMedia = null;
  assert.equal((await call(DOCUMENT_ASSET, { order }).promise).status, 404);
});

// ── Retention ────────────────────────────────────────────────────────────────

for (const status of ['cleanup_claimed', 'reclaimed'] as const) {
  test(`refuses retrieval when retention is ${status}`, async () => {
    const order = boundOrder({
      checkoutIntakeMediaRetention: {
        status,
        activatedAt: CONSENT_AT,
        cleanupClaimedAt: CONSENT_AT,
        ...(status === 'reclaimed' ? { reclaimedAt: CONSENT_AT } : {}),
      },
    });
    const { promise, opened } = call(HERO_ASSET, { order });
    assert.equal((await promise).status, 404);
    assert.deepEqual(opened, []);
  });
}

test('refuses retrieval when retention is absent', async () => {
  const order = boundOrder({ checkoutIntakeMediaRetention: null });
  assert.equal((await call(HERO_ASSET, { order }).promise).status, 404);
});

// ── Provider object verification ─────────────────────────────────────────────

test('reads the exact bound pathname with the dedicated intake credential', async () => {
  const { promise, opened } = call(HERO_ASSET);
  assert.equal((await promise).status, 200);
  assert.deepEqual(opened, [`${intakeAssetPath(INTAKE_ID, HERO_ASSET)}|${INTAKE_TOKEN}`]);
});

test('fails closed when the intake credential is unusable', async () => {
  const { promise, opened } = call(HERO_ASSET, {
    token: () => { throw new Error('intake_store_must_be_dedicated'); },
  });
  const reply = await promise;
  assert.equal(reply.status, 503);
  assert.deepEqual(opened, []);
});

test('refuses a missing provider object', async () => {
  assert.equal((await call(HERO_ASSET, { object: null }).promise).status, 502);
});

test('refuses when the provider read throws', async () => {
  assert.equal((await call(HERO_ASSET, { objectError: new Error('boom') }).promise).status, 502);
});

test('refuses a provider object whose content type differs from the bound MIME', async () => {
  const reply = await call(HERO_ASSET, { object: { contentType: 'text/html' } }).promise;
  assert.equal(reply.status, 502);
});

test('refuses a provider object whose reported size differs from the bound size', async () => {
  const reply = await call(HERO_ASSET, { object: { size: 4096 } }).promise;
  assert.equal(reply.status, 502);
});

test('refuses a provider object returned from a different pathname', async () => {
  const reply = await call(HERO_ASSET, { object: { pathname: 'intakes/other/assets/x' } }).promise;
  assert.equal(reply.status, 502);
});

test('refuses a stream that exceeds the bound size without buffering it whole', async () => {
  const oversized = bytes(2048 + 4096);
  const reply = await call(HERO_ASSET, {
    object: { stream: streamOf(oversized, 512) },
  }).promise;
  assert.equal(reply.status, 502);
});

test('refuses a stream that is shorter than the bound size', async () => {
  const reply = await call(HERO_ASSET, { object: { stream: streamOf(bytes(100)) } }).promise;
  assert.equal(reply.status, 502);
});

test('refuses a bound size above the hard category cap', async () => {
  const order = documentOrder();
  const huge = 64 * 1024 * 1024;
  order.checkoutIntake!.selection = order.checkoutIntake!.selection.map((e) =>
    e.assetId === DOCUMENT_ASSET ? { ...e, size: huge } : e);
  order.documentIntakeMedia = { ...order.documentIntakeMedia!, size: huge };
  order.checkoutIntake!.fingerprint = finalizationFingerprint(INTAKE_ID, order.checkoutIntake!.selection);
  const { promise, opened } = call(DOCUMENT_ASSET, { order });
  assert.equal((await promise).status, 404);
  assert.deepEqual(opened, []);
});

// ── Successful retrieval, per category ───────────────────────────────────────

const SUCCESS_CASES: Array<[string, string, () => OrderRecord, string]> = [
  ['hero photo', HERO_ASSET, boundOrder, 'image/jpeg'],
  ['family character photo', FAMILY_ASSET, boundOrder, 'image/jpeg'],
  ['guided still', GUIDED_ASSET, boundOrder, 'image/jpeg'],
  ['voice note', VOICE_ASSET, boundOrder, 'audio/mp4'],
  ['inspiration document', DOCUMENT_ASSET, documentOrder, 'application/pdf'],
];

for (const [label, assetId, makeOrder, mime] of SUCCESS_CASES) {
  test(`serves a bound ${label}`, async () => {
    const { promise, payload } = call(assetId, { order: makeOrder() });
    const reply = await promise;
    assert.equal(reply.status, 200);
    assert.equal(reply.headers['Content-Type'], mime);
    assert.ok(reply.body instanceof Uint8Array);
    assert.deepEqual(Array.from(reply.body as Uint8Array), Array.from(payload));
  });
}

// ── Response headers ─────────────────────────────────────────────────────────

test('sets the exact privacy and isolation headers', async () => {
  const reply = await call(HERO_ASSET).promise;
  assert.equal(reply.headers['Cache-Control'], 'private, no-store');
  assert.equal(reply.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(reply.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(reply.headers['X-Robots-Tag'], 'noindex, nofollow');
  assert.equal(
    reply.headers['Content-Security-Policy'],
    "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  assert.equal(reply.headers['Content-Length'], '2048');
});

/**
 * A voice note is served `inline`, so the operator's browser opens it as a
 * media document whose only policy is the one sent with these bytes. Under
 * `default-src 'none'` with no media allowance, Chromium refuses the media
 * element's own load: the player renders but stays at readyState 0, and the
 * workflow the runbook advertises cannot happen. The media document is
 * same-origin with this response, so `media-src 'self'` is the whole of the
 * allowance it needs. tests/e2e/admin-intake-asset-playback.spec.ts proves both
 * halves of that in a real browser.
 */
test('an inline voice note is served under a policy that permits same-origin media', async () => {
  const reply = await call(VOICE_ASSET).promise;
  assert.equal(reply.headers['Content-Disposition'], `inline; filename="hsb-intake-${VOICE_ASSET}.m4a"`);
  assert.equal(
    reply.headers['Content-Security-Policy'],
    "default-src 'none'; media-src 'self'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
});

test('the audio policy still denies every other subresource and keeps the sandbox', async () => {
  const csp = (await call(VOICE_ASSET).promise).headers['Content-Security-Policy']!;
  const directives = csp.split(';').map((part) => part.trim()).filter(Boolean);
  // Exactly one allowance, and it is same-origin media. No scheme, no host,
  // no wildcard, no `data:`, and nothing that relaxes the sandbox.
  assert.deepEqual(directives.filter((d) => !d.startsWith("default-src 'none'")
    && d !== 'sandbox' && d !== "base-uri 'none'" && d !== "form-action 'none'"
    && d !== "frame-ancestors 'none'"), ["media-src 'self'"]);
  assert.ok(!/sandbox\s+allow-/.test(csp), 'the sandbox must not be relaxed to make media load');
});

test('the media allowance reaches nothing but audio bytes', async () => {
  const photo = await call(HERO_ASSET).promise;
  const document = await call(DOCUMENT_ASSET, { order: documentOrder() }).promise;
  const refused = await call(HERO_ASSET, { order: null }).promise;
  for (const [label, reply] of [['photo', photo], ['document', document], ['refusal', refused]] as const) {
    assert.ok(
      !reply.headers['Content-Security-Policy']!.includes('media-src'),
      `${label} responses must keep default-src 'none' with no media allowance`,
    );
  }
});

test('generates its own filename and never echoes a customer one', async () => {
  const reply = await call(HERO_ASSET).promise;
  assert.equal(
    reply.headers['Content-Disposition'],
    `inline; filename="hsb-intake-${HERO_ASSET}.jpg"`,
  );
});

test('forces a download for document bytes rather than rendering them', async () => {
  const reply = await call(DOCUMENT_ASSET, { order: documentOrder() }).promise;
  assert.equal(
    reply.headers['Content-Disposition'],
    `attachment; filename="hsb-intake-${DOCUMENT_ASSET}.pdf"`,
  );
});

test('leaks no token, pathname, intake id or provider URL in the response', async () => {
  const reply = await call(VOICE_ASSET).promise;
  const serialized = JSON.stringify(reply.headers);
  assert.ok(!serialized.includes(INTAKE_TOKEN));
  assert.ok(!serialized.includes(INTAKE_ID));
  assert.ok(!serialized.includes('intakes/'));
  assert.ok(!serialized.includes('vercel-storage'));
  assert.ok(!serialized.includes('blob.vercel'));
});

test('refusal bodies carry the privacy headers and no detail', async () => {
  const reply = await call(HERO_ASSET, { order: null }).promise;
  assert.equal(reply.headers['Cache-Control'], 'private, no-store');
  assert.equal(reply.headers['X-Content-Type-Options'], 'nosniff');
  assert.deepEqual(reply.body, { error: 'Not found' });
});

// ── Logging ──────────────────────────────────────────────────────────────────

test('logs only metadata-safe fields on success', async () => {
  const { promise, logs } = call(VOICE_ASSET);
  await promise;
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]!).sort(), ['assetId', 'category', 'event', 'orderId', 'outcome']);
  assert.deepEqual(logs[0], {
    event: 'admin_intake_asset_read',
    orderId: ORDER_ID,
    assetId: VOICE_ASSET,
    category: 'voice_inspiration',
    outcome: 'served',
  });
});

test('logs a refusal outcome without the customer email, pathname or token', async () => {
  const { promise, logs } = call(HERO_ASSET, { object: { size: 4096 } });
  await promise;
  const serialized = JSON.stringify(logs);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.outcome, 'provider_size_mismatch');
  assert.ok(!serialized.includes('luna@example.com'));
  assert.ok(!serialized.includes('intakes/'));
  assert.ok(!serialized.includes(INTAKE_TOKEN));
  assert.ok(!serialized.includes(INTAKE_ID));
});

/**
 * The two path segments are attacker-controlled on an UNAUTHENTICATED request,
 * and the refusal is logged before either of them has been checked against any
 * grammar. Whatever a caller puts in the URL therefore lands verbatim in the
 * log sink — an address, a pasted capability, a newline-framed fake record.
 * The same grammar now gates the order boundary after authentication, so the
 * raw id reaches neither the store nor the metadata log.
 */
const EMAIL_LIKE_ORDER_ID = 'victim.parent+hsb@example.com';
const CAPABILITY_LIKE_ASSET_ID = 'vercel_blob_rw_INTAKESTORE00_pastedsecret';

test('an unauthenticated refusal logs sentinels, not the raw path segments', async () => {
  const logs: AdminIntakeAssetLogEvent[] = [];
  let readCalls = 0;
  const reply = await handleAdminIntakeAssetRequest(
    new Request('https://hsb.test/x'),
    EMAIL_LIKE_ORDER_ID,
    CAPABILITY_LIKE_ASSET_ID,
    {
      isAdminAuthed: () => false,
      readOrder: async () => { readCalls += 1; return boundOrder(); },
      intakeToken: () => { throw new Error('must not mint'); },
      openIntakeAsset: async () => { throw new Error('must not open'); },
      log: (event) => logs.push(event),
    },
  );
  assert.equal(reply.status, 401);
  assert.equal(readCalls, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.outcome, 'unauthenticated');
  assert.equal(logs[0]!.orderId, '__invalid__');
  assert.equal(logs[0]!.assetId, '__invalid__');
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes(EMAIL_LIKE_ORDER_ID), 'the raw order segment must not be logged');
  assert.ok(!serialized.includes('@example.com'), 'no fragment of the address may be logged');
  assert.ok(!serialized.includes(CAPABILITY_LIKE_ASSET_ID), 'the raw asset segment must not be logged');
  assert.ok(!serialized.includes('vercel_blob_rw'), 'no fragment of the capability may be logged');
});

test('an authenticated refusal sanitizes the same segments and still reads nothing', async () => {
  const logs: AdminIntakeAssetLogEvent[] = [];
  let readCalls = 0;
  const reply = await handleAdminIntakeAssetRequest(
    new Request('https://hsb.test/x'),
    EMAIL_LIKE_ORDER_ID,
    CAPABILITY_LIKE_ASSET_ID,
    {
      isAdminAuthed: () => true,
      readOrder: async () => { readCalls += 1; return boundOrder(); },
      intakeToken: () => { throw new Error('must not mint'); },
      openIntakeAsset: async () => { throw new Error('must not open'); },
      log: (event) => logs.push(event),
    },
  );
  assert.equal(reply.status, 404);
  assert.equal(readCalls, 0, 'a non-canonical asset id is refused before the order is read');
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.outcome, 'order_id_invalid');
  assert.equal(logs[0]!.orderId, '__invalid__');
  assert.equal(logs[0]!.assetId, '__invalid__');
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes(EMAIL_LIKE_ORDER_ID));
  assert.ok(!serialized.includes(CAPABILITY_LIKE_ASSET_ID));
  assert.ok(!serialized.includes('vercel_blob_rw'));
});

test('a canonical-shaped order and asset id are still logged as themselves', async () => {
  const { promise, logs } = call(HERO_ASSET);
  assert.equal((await promise).status, 200);
  assert.equal(logs[0]!.orderId, ORDER_ID);
  assert.equal(logs[0]!.assetId, HERO_ASSET);
});

test('real default order boundary rejects a hostile order id before the store or logs', async () => {
  const adminKey = 'privacy-test-admin-key';
  await withEnv(
    {
      HSB_ORDER_ADMIN_KEY: adminKey,
      HSB_REQUIRE_DURABLE_PERSISTENCE: 'true',
      BLOB_READ_WRITE_TOKEN: undefined,
    },
    async () => {
      const { result: reply, output } = await captureConsole(() =>
        handleAdminIntakeAssetRequest(
          new Request('https://hsb.test/x', {
            headers: { cookie: `hsb-ops-key=${adminKey}` },
          }),
          EMAIL_LIKE_ORDER_ID,
          HERO_ASSET,
        ));

      assert.equal(reply.status, 404);
      assert.deepEqual(reply.body, { error: 'Not found' });
      assert.ok(!output.includes(EMAIL_LIKE_ORDER_ID));
      assert.ok(!output.includes('@example.com'));
      assert.ok(
        !output.includes('BLOB_READ_WRITE_TOKEN'),
        'invalid ids must be rejected before the real getOrder boundary runs',
      );
    },
  );
});

test('real default order boundary contains valid-id store failures without raw logging', async () => {
  const adminKey = 'privacy-test-admin-key';
  await withEnv(
    {
      HSB_ORDER_ADMIN_KEY: adminKey,
      HSB_REQUIRE_DURABLE_PERSISTENCE: 'true',
      BLOB_READ_WRITE_TOKEN: undefined,
    },
    async () => {
      const { result: reply, output } = await captureConsole(() =>
        handleAdminIntakeAssetRequest(
          new Request('https://hsb.test/x', {
            headers: { cookie: `hsb-ops-key=${adminKey}` },
          }),
          ORDER_ID,
          HERO_ASSET,
        ));

      assert.equal(reply.status, 503, 'a valid id must reach the default getOrder boundary');
      assert.deepEqual(reply.body, { error: 'Order unavailable' });
      assert.ok(output.includes('order_unavailable'));
      assert.ok(!output.includes('BLOB_READ_WRITE_TOKEN'));
      assert.ok(!output.includes('cannot read order'));
      assert.ok(!output.includes('OrderPersistenceError'));
    },
  );
});

/**
 * Order lookup is I/O: a store outage, a malformed stored record or a driver
 * bug rejects the promise. Nothing caught that, so the rejection escaped
 * `handleAdminIntakeAssetRequest` to the route shell, which had no boundary of
 * its own — the operator got the framework's own 500 page, with none of the
 * privacy headers this surface exists to set and, in a non-production build,
 * the thrown message. It has to fail closed through the same refusal boundary
 * as everything else.
 */
test('a failing order lookup refuses through the privacy boundary instead of throwing', async () => {
  const logs: AdminIntakeAssetLogEvent[] = [];
  const secret = 'pg: relation orders row luna@example.com token vercel_blob_rw_INTAKESTORE00_x';
  let opened = 0;
  const reply = await handleAdminIntakeAssetRequest(
    new Request('https://hsb.test/x'),
    ORDER_ID,
    HERO_ASSET,
    {
      isAdminAuthed: () => true,
      readOrder: async () => { throw new Error(secret); },
      intakeToken: () => INTAKE_TOKEN,
      openIntakeAsset: async () => { opened += 1; throw new Error('must not open'); },
      log: (event) => logs.push(event),
    },
  );

  assert.equal(reply.status, 503);
  assert.deepEqual(reply.body, { error: 'Order unavailable' });
  assert.equal(opened, 0, 'a failed order lookup must not reach the provider');

  assert.equal(reply.headers['Cache-Control'], 'private, no-store');
  assert.equal(reply.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(reply.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(reply.headers['X-Robots-Tag'], 'noindex, nofollow');
  assert.equal(
    reply.headers['Content-Security-Policy'],
    "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  assert.equal(reply.headers['Content-Type'], 'application/json');

  const wire = JSON.stringify({ body: reply.body, headers: reply.headers, logs });
  assert.ok(!wire.includes(secret), 'the thrown message must not reach the operator or the log');
  assert.ok(!wire.includes('luna@example.com'));
  assert.ok(!wire.includes('vercel_blob_rw'));

  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]!).sort(), ['assetId', 'category', 'event', 'orderId', 'outcome']);
  assert.deepEqual(logs[0], {
    event: 'admin_intake_asset_read',
    orderId: ORDER_ID,
    assetId: HERO_ASSET,
    category: null,
    outcome: 'order_unavailable',
  });
});

// ── Unsupported methods ────────────────────────────────────────────────

function assertMethodPolicy(reply: { status: number; headers: Record<string, string> }) {
  assert.equal(reply.headers.Allow, 'GET, OPTIONS');
  assert.equal(reply.headers['Cache-Control'], 'private, no-store');
  assert.equal(reply.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(reply.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(reply.headers['Content-Security-Policy'] ?? '', /(?:^|;)\s*default-src 'none'(?:;|$)/);
  assert.match(reply.headers['Content-Security-Policy'] ?? '', /(?:^|;)\s*media-src 'self'(?:;|$)/);
}

test('POST is a centralized 405 carrying the complete private-route policy', () => {
  const reply = adminIntakeAssetUnsupportedMethodReply();
  assert.equal(reply.status, 405);
  assert.deepEqual(reply.body, { error: 'Method not allowed' });
  assertMethodPolicy(reply);
});

test('OPTIONS is a centralized 204 carrying Allow and the complete private-route policy', () => {
  const reply = adminIntakeAssetOptionsReply();
  assert.equal(reply.status, 204);
  assert.equal(reply.body, null);
  assertMethodPolicy(reply);
});

test('never mutates the order record to record a read', async () => {
  const order = boundOrder();
  const before = JSON.stringify(order);
  await call(HERO_ASSET, { order }).promise;
  assert.equal(JSON.stringify(order), before);
});

// ── Admin UI links ───────────────────────────────────────────────────────────

test('lists every bound asset as a same-origin order-scoped link', () => {
  const links = listAdminIntakeAssets(boundOrder());
  assert.deepEqual(links.map((link) => link.assetId).sort(), [HERO_ASSET, FAMILY_ASSET, GUIDED_ASSET, VOICE_ASSET].sort());
  for (const link of links) {
    assert.equal(link.href, `/api/admin/orders/${ORDER_ID}/intake-assets/${link.assetId}`);
    assert.ok(!/^[a-z]+:\/\//.test(link.href));
  }
});

test('asset links carry a role label but no path, URL or capability', () => {
  const links = [...listAdminIntakeAssets(boundOrder()), ...listAdminIntakeAssets(documentOrder())];
  assert.ok(links.some((link) => link.label.toLowerCase().includes('voice')));
  assert.ok(links.some((link) => link.label.toLowerCase().includes('document')));
  const serialized = JSON.stringify(links);
  assert.ok(!serialized.includes('intakes/'));
  assert.ok(!serialized.includes(INTAKE_ID));
  assert.ok(!serialized.includes('vercel-storage'));
  assert.ok(!serialized.includes('etag'));
});

test('lists nothing for an order with no active retained intake media', () => {
  assert.deepEqual(listAdminIntakeAssets(boundOrder({ checkoutIntake: null })), []);
  assert.deepEqual(
    listAdminIntakeAssets(boundOrder({
      checkoutIntakeMediaRetention: { status: 'reclaimed', activatedAt: CONSENT_AT, cleanupClaimedAt: CONSENT_AT, reclaimedAt: CONSENT_AT },
    })),
    [],
  );
});
