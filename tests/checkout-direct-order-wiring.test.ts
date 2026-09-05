/**
 * The wiring itself: what `/api/order` and the checkout page do differently
 * once the direct private-intake path is switched on — and, more importantly,
 * what they must keep doing identically when it is not.
 *
 * The route FILE cannot be imported under `node:test` (next/server + Stripe),
 * but the handler it instantiates can be, and is: the production handler is
 * executed end-to-end, with only its Next/Stripe/Blob boundaries injected, in
 * checkout-order-route-handler.test.ts. That is where reachability is proven —
 * a mutation that makes the legacy resume unreachable fails there.
 *
 * Everything here that CAN be executed — the request fingerprint, the payload
 * assembly — still is. What is left for source inspection is only what the
 * behavioural suites cannot show: that the handler retains NO provider surface
 * and no session decision of its own for the removed bypass to grow back into,
 * and that the route file is nothing but a thin instantiation. These are
 * tripwires against a shape regressing, NOT evidence that a line runs; they are
 * stated as absence inside the handler body rather than as "X appears before
 * Y", because position was the weakness in the tests these replace.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  CHECKOUT_FINGERPRINT_EXCLUDED_FIELDS,
  DIRECT_INTAKE_CAPABILITY_FIELD,
  DIRECT_INTAKE_FIELD,
} from '../src/lib/checkout-direct-order-request.ts';
import { checkoutRequestFingerprint } from '../src/lib/checkout-request-fingerprint.ts';
import {
  applyDirectIntakeToOrderPayload,
  applyPrimaryAndSupportingMediaToOrderPayload,
} from '../src/lib/checkout-intake-client-flow.ts';
import { parseDirectIntakeOrderRequest } from '../src/lib/checkout-direct-order-request.ts';

const ROUTE_FILE = readFileSync('src/app/api/order/route.ts', 'utf8');
const HANDLER_FILE = readFileSync('src/lib/checkout-order-route-handler.ts', 'utf8');
/**
 * The production POST path is these two files, in the order they run: the
 * handler that owns every decision, then the route file whose only content is
 * the thin instantiation and the provider adapters.
 */
const ROUTE = HANDLER_FILE + ROUTE_FILE;
const FORM = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

/**
 * The request handler body ONLY, and the provider adapters below it.
 *
 * Lexical position is a weak guarantee and was previously used as if it were a
 * strong one: `checkout.sessions.create` lives in an adapter declared BELOW the
 * handler, so "the create comes after X" held no matter what the handler did.
 * These guards therefore say something a reordering cannot satisfy — the
 * handler body must contain no provider call and no session decision at all.
 */
const ADAPTERS_AT = ROUTE_FILE.indexOf('async function retrieveDirectCheckoutSession');
/** The thin instantiation the route file is now reduced to. */
const THIN_POST = ROUTE_FILE.slice(ROUTE_FILE.indexOf('export async function POST'), ADAPTERS_AT);
const HANDLER =
  HANDLER_FILE.slice(HANDLER_FILE.indexOf('export async function handleCheckoutOrderPost'))
  + THIN_POST;
const ADAPTERS = ROUTE_FILE.slice(ADAPTERS_AT);
const CAPABILITY = 'Zm9vYmFyLWNhcGFiaWxpdHktdG9rZW4tdmFsdWUtMDAx';

/** The pre-existing algorithm, reproduced so a drift is visible as a diff. */
async function legacyFingerprint(form: FormData): Promise<string> {
  const entries: string[] = [];
  for (const [key, value] of form.entries()) {
    if (value instanceof File) {
      const bytes = Buffer.from(await value.arrayBuffer());
      entries.push(JSON.stringify([
        key, 'file', value.name, value.type, value.size,
        crypto.createHash('sha256').update(bytes).digest('hex'),
      ]));
    } else {
      entries.push(JSON.stringify([key, 'text', value]));
    }
  }
  entries.sort();
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}

test('a legacy request fingerprints exactly as it always has', async () => {
  const form = new FormData();
  form.set('checkoutAttemptId', 'b'.repeat(32));
  form.set('childName', 'Mina');
  form.set('email', 'buyer@example.com');
  form.set('photo', new File([new Uint8Array([9, 8, 7])], 'hero.jpg', { type: 'image/jpeg' }));

  assert.equal(await checkoutRequestFingerprint(form), await legacyFingerprint(form));
});

test('the intake capability is never a fingerprint input', async () => {
  const base = () => {
    const form = new FormData();
    form.set('checkoutAttemptId', 'b'.repeat(32));
    form.set('childName', 'Mina');
    form.set(DIRECT_INTAKE_FIELD, JSON.stringify({ intakeId: `intake_${'a'.repeat(32)}` }));
    return form;
  };

  const one = base();
  one.set(DIRECT_INTAKE_CAPABILITY_FIELD, CAPABILITY);
  const two = base();
  two.set(DIRECT_INTAKE_CAPABILITY_FIELD, 'a-completely-different-capability-value');
  const none = base();

  assert.equal(await checkoutRequestFingerprint(one), await checkoutRequestFingerprint(two));
  assert.equal(await checkoutRequestFingerprint(one), await checkoutRequestFingerprint(none));
  assert.ok(CHECKOUT_FINGERPRINT_EXCLUDED_FIELDS.has(DIRECT_INTAKE_CAPABILITY_FIELD));

  // Everything else still changes it.
  const changed = base();
  changed.set(DIRECT_INTAKE_CAPABILITY_FIELD, CAPABILITY);
  changed.set('childName', 'Noor');
  assert.notEqual(await checkoutRequestFingerprint(changed), await checkoutRequestFingerprint(one));
});

test('the submitted payload carries the intake pointer and keeps the capability out of the JSON', () => {
  const set = new Map<string, string>();
  applyDirectIntakeToOrderPayload({ set: (name, value) => set.set(name, value) }, {
    session: { intakeId: `intake_${'a'.repeat(32)}`, capability: CAPABILITY, expiresAt: '2026-03-02T00:00:00.000Z' },
    selection: {
      primaryHeroPhotoAssetId: `asset_${'1'.repeat(32)}`,
      familyCharacterAssets: [],
      guidedStillAssetIds: [],
      voiceAssetId: null,
      documentAssetId: null,
    },
    familyCharacterIds: ['supporting-character-1'],
  });

  assert.deepEqual(
    [...set.keys()].sort(),
    [DIRECT_INTAKE_CAPABILITY_FIELD, DIRECT_INTAKE_FIELD].sort(),
  );
  const payload = JSON.parse(set.get(DIRECT_INTAKE_FIELD)!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ['familyCharacterIds', 'intakeId', 'selection']);
  assert.equal(set.get(DIRECT_INTAKE_FIELD)!.includes(CAPABILITY), false);
  assert.equal(set.get(DIRECT_INTAKE_CAPABILITY_FIELD), CAPABILITY);
});

test('the actual direct payload shape carries no raw family media while legacy still does', () => {
  const familyPhoto = new File([new Uint8Array([1, 2, 3])], 'family.jpg', { type: 'image/jpeg' });
  const submission = {
    session: { intakeId: `intake_${'a'.repeat(32)}`, capability: CAPABILITY, expiresAt: '2026-03-02T00:00:00.000Z' },
    selection: {
      primaryHeroPhotoAssetId: null,
      familyCharacterAssets: [{ assetId: `asset_${'1'.repeat(32)}`, familyCharacterId: 'supporting-character-1' }],
      guidedStillAssetIds: [], voiceAssetId: null, documentAssetId: null,
    },
    familyCharacterIds: ['supporting-character-1'],
  };
  const direct = new FormData();
  direct.set('checkoutAttemptId', 'b'.repeat(32));
  applyPrimaryAndSupportingMediaToOrderPayload(direct, {
    directSubmission: submission,
    heroPhoto: null,
    familyPhotos: [familyPhoto],
  });
  assert.equal(parseDirectIntakeOrderRequest(direct).kind, 'direct');
  assert.equal([...direct.values()].some((value) => value instanceof File), false);

  const legacy = new FormData();
  applyPrimaryAndSupportingMediaToOrderPayload(legacy, {
    directSubmission: null,
    heroPhoto: null,
    familyPhotos: [familyPhoto],
  });
  assert.equal(legacy.get('familyCharacterPhoto_0'), familyPhoto);
});

test('order route: the path is chosen by request shape AND the server flag, never by one alone', () => {
  assert.match(ROUTE, /parseDirectIntakeOrderRequest\(form\)/);
  assert.match(ROUTE, /isDirectUploadServerEnabled\(\)/);
  // A direct request into a deployment that does not serve it is refused, not
  // silently downgraded to an order with no media.
  assert.match(ROUTE, /direct_upload_disabled/);
  const parseIdx = HANDLER.indexOf('parseDirectIntakeOrderRequest(form)');
  const disabledIdx = HANDLER.indexOf('direct_upload_disabled');
  assert.ok(parseIdx > -1, 'the request shape is parsed inside the handler');
  assert.ok(disabledIdx > parseIdx, 'the half-enabled refusal follows the parse, inside the handler');
});

test('order route: the direct branch returns before any legacy public upload helper runs', () => {
  const directIdx = ROUTE.indexOf('runDirectIntakeCheckout');
  const photoUploadIdx = ROUTE.indexOf('await deps.uploadOrderPhoto');
  const supportingUploadIdx = ROUTE.indexOf('await deps.uploadOrderSupportingPhoto');
  const voiceUploadIdx = ROUTE.indexOf('await deps.uploadOrderVoice');
  assert.ok(directIdx > -1, 'route must run the direct saga');
  for (const [label, idx] of [
    ['hero', photoUploadIdx], ['supporting', supportingUploadIdx], ['voice', voiceUploadIdx],
  ] as const) {
    assert.ok(idx > directIdx, `the direct branch must precede the legacy ${label} upload`);
  }
});

test('order route: legacy ordering guarantees are untouched', () => {
  const resumeIdx = HANDLER.indexOf('await runLegacyCheckoutRoute<TResponse>');
  const casIdx = HANDLER.indexOf('await withOrderTransaction');
  const provisionIdx = HANDLER.indexOf('await provisionCheckoutSession');
  const promoIdx = ROUTE.indexOf('allow_promotion_codes: true');
  const createIdx = ROUTE.indexOf('checkout.sessions.create');
  assert.ok(resumeIdx > -1 && casIdx > resumeIdx && provisionIdx > casIdx,
    'the durable owner record and the final order CAS both precede the provider hand-off');
  assert.ok(promoIdx > createIdx, 'promotion codes remain part of session creation');
  assert.match(ROUTE, /const photoReady = photoValidation\.ok === true/);
  assert.match(ROUTE, /likenessIntent: likenessIntentForPhoto\(photoReady\)/);
  assert.match(ROUTE, /fulfillmentMode: 'manual_hold'/);
});

test('order route: a direct hero photo and direct supporting photos satisfy the same required-field gate', () => {
  // Without this the direct path would demand a written hero description from
  // a buyer who did attach a photo, and would demand written details for every
  // supporting character whose photo is already saved privately.
  assert.match(ROUTE, /directSelection\?\.primaryHeroPhotoAssetId != null/);
  assert.match(ROUTE, /missingSupportingCharacterDescriptionLabels\(\s*familyCharacters,\s*supportingPhotoIndexes/);
});

test('order route: no uploaded media is handed to generation, proof, print, or email in this change', () => {
  assert.doesNotMatch(ROUTE, /kickoffFulfillment|generateBook|buildProof|luluCreatePrintJob|sendProofEmail/);
});

test('checkout form delegates mutually-exclusive direct and legacy media shape to the tested helper', () => {
  assert.match(FORM, /isDirectUploadClientEnabled/);
  const prepared = FORM.indexOf('const directIntakeSubmission = preparedDirectIntake?.submission ?? null');
  const applied = FORM.indexOf('applyPrimaryAndSupportingMediaToOrderPayload(payload, {', prepared);
  const fetchOrder = FORM.indexOf('fetch("/api/order"', applied);
  assert.ok(prepared > -1 && applied > prepared && fetchOrder > applied);
  assert.doesNotMatch(FORM, /payload\.set\(`familyCharacterPhoto_/);
  assert.doesNotMatch(FORM, /payload\.set\("photo", form\.photoFile\)/);
});

test('checkout form: the raw capability is never persisted, tracked, or put in a URL', () => {
  const savedDraft = FORM.slice(FORM.indexOf('function saveProgress'), FORM.indexOf('function loadProgress'));
  assert.ok(savedDraft.length > 0, 'saveProgress must still exist');
  assert.equal(savedDraft.includes('capability'), false, 'the capability may never reach localStorage');
  assert.doesNotMatch(FORM, /localStorage\.setItem\([\s\S]{0,800}capability/);
  assert.doesNotMatch(FORM, /track\([^)]*capability/);
  assert.doesNotMatch(FORM, /console\.(log|error|warn)\([^)]*capability/);
  assert.doesNotMatch(FORM, /searchParams[\s\S]{0,80}capability/);
  // Held in a ref for the life of the page, and dropped on hand-off.
  assert.match(FORM, /intakeSessionRef/);
});

test('checkout form: payment stays blocked until every chosen file is saved privately', () => {
  assert.match(FORM, /directUploadBlockers/);
  assert.match(FORM, /directMediaBlockers/);
  assert.match(FORM, /directMediaBlockers\.length === 0/);
});

// ---------------------------------------------------------------------------
// Both checkout paths share ONE provider-Session state machine
//
// The legacy public path used to answer from a local fast path: it read
// `persistedDraft.stripeSessionId`, retrieved that Session itself, and returned
// either its URL or a permanent 409 — all BEFORE the shared machine, and so
// with none of its recovery. An expired Session tombstoned the buyer's attempt
// forever; a Session created but never bound was invisible.
//
// The behaviour is proven against the real order CAS and the real provisioning
// machine at the actual legacy entrypoint in
// checkout-legacy-order-entrypoint.test.ts. What these source guards add is the
// thing behaviour cannot show about an un-importable file: that the handler
// retains no session decision of its own for the bypass to grow back into.
// ---------------------------------------------------------------------------

test('order route: the handler has no provider surface of its own at all', () => {
  // Not "the create comes later" — later is free when the adapter is declared
  // below. The handler body must contain no provider verb whatsoever.
  for (const forbidden of [
    /checkout\.sessions\.create/,
    /checkout\.sessions\.retrieve/,
    /getStripe\(\)/,
    /new Stripe\(/,
  ]) {
    assert.doesNotMatch(HANDLER, forbidden, `the request handler must not reach the provider directly: ${forbidden}`);
  }
  // The only provider entrypoints in the whole file are the two injected
  // adapters, and they are declared outside the handler.
  assert.match(ADAPTERS, /checkout\.sessions\.create/);
  assert.match(ADAPTERS, /checkout\.sessions\.retrieve/);
});

test('order route: the legacy bound-Session fast path cannot come back', () => {
  // The exact shape of the removed bypass, and the generalisations of it.
  for (const forbidden of [
    /persistedDraft\.stripeSessionId/,
    /existingSession/,
    /already reached payment/,
    /sessions\.retrieve\(/,
    /bindOrderCheckoutSession\(order\.id, session\.id/,
    /redirectTo: session\.url/,
    /redirectTo: existing/,
  ]) {
    assert.doesNotMatch(HANDLER, forbidden, `a local bound-Session decision is forbidden here: ${forbidden}`);
  }
  // Nothing in the handler may read a durable session field to decide an answer.
  assert.doesNotMatch(HANDLER, /\.stripeSessionId/);
  assert.doesNotMatch(HANDLER, /\.checkoutSessionCandidate/);
  assert.doesNotMatch(HANDLER, /\.checkoutSessionProvisioning/);
});

test('order route: every legacy exit to the provider goes through a shared entrypoint', () => {
  // Exactly two hand-offs exist on the legacy path: the orchestration that owns
  // the resume/recovery decision before media, and the shared machine after the
  // final order CAS. The first one is a function the tests can actually EXECUTE
  // (checkout-legacy-order-entrypoint.test.ts drives it with injected
  // dependencies), because a decision made inline in an un-importable handler
  // could be removed without a single test noticing — it was.
  assert.match(HANDLER, /await runLegacyCheckoutRoute<TResponse>\(/);
  assert.match(HANDLER, /continueWithMedia: async \(persisted\) => \{/);
  assert.match(HANDLER, /await provisionCheckoutSession\(/);
  assert.match(HANDLER_FILE, /from '\.\/checkout-legacy-order\.ts'/);
  assert.match(HANDLER_FILE, /from '\.\/checkout-session-provisioning\.ts'/);
  // The resume decision itself lives in the shared entrypoint, and the media
  // continuation is reachable only through it.
  const entrypoint = readFileSync('src/lib/checkout-legacy-order.ts', 'utf8');
  assert.match(entrypoint, /await resumeOrContinueLegacyCheckout\(params, deps\)/);
  assert.match(entrypoint, /return deps\.continueWithMedia\(resumed\.order\)/);
  assert.doesNotMatch(HANDLER, /resumeOrContinueLegacyCheckout/);
  // Media, pause, and order persistence all precede BOTH of them.
  const resumeIdx = HANDLER.indexOf('await runLegacyCheckoutRoute<TResponse>(');
  const provisionIdx = HANDLER.indexOf('await provisionCheckoutSession(');
  for (const [label, marker] of [
    ['checkout pause', 'isCheckoutPaused()'],
    ['request parse', 'parseDirectIntakeOrderRequest(form)'],
    ['durable owner record', 'await runLegacyCheckoutRoute<TResponse>('],
  ] as const) {
    const idx = HANDLER.indexOf(marker);
    assert.ok(idx > -1 && idx <= resumeIdx, `${label} must precede the legacy resume entrypoint`);
  }
  for (const [label, marker] of [
    ['hero photo upload', 'await deps.uploadOrderPhoto'],
    ['supporting photo upload', 'await deps.uploadOrderSupportingPhoto'],
    ['voice upload', 'await deps.uploadOrderVoice'],
    ['document upload', 'await deps.uploadOrderDocument'],
    ['final order CAS', 'await withOrderTransaction'],
  ] as const) {
    const idx = HANDLER.indexOf(marker);
    assert.ok(idx > -1 && idx < provisionIdx, `${label} must precede the shared provisioning hand-off`);
  }
});

test('order route: both paths inject the same durable order primitives', () => {
  for (const primitive of [
    'renewCheckoutLease',
    'beginCheckoutSessionProvisioning',
    'recordCheckoutSessionCandidate',
    'supersedeExpiredCheckoutSession',
    'bindOrderCheckoutSession',
  ]) {
    assert.ok(
      HANDLER.split(primitive).length - 1 >= 2,
      `${primitive} must be wired on both the direct and the legacy path`,
    );
    const imports = HANDLER_FILE.slice(0, HANDLER_FILE.indexOf("} from './orders.ts';"));
    assert.ok(imports.includes(primitive), `${primitive} must be imported from lib/orders`);
  }
});

test('order route: the route file is a thin instantiation with nothing left to decide', () => {
  // The reachability guarantee rests on this: everything the handler decides is
  // in a module the tests EXECUTE, and the route file contains no branch, no
  // form parsing and no second entry point for a legacy path to grow back into.
  assert.match(THIN_POST, /return handleCheckoutOrderPost<NextResponse>\(request, \{/);
  assert.match(THIN_POST, /json: \(body, httpStatus\) => NextResponse\.json\(body, \{ status: httpStatus \}\)/);
  for (const forbidden of [
    /\bif\s*\(/,
    /request\.formData\(\)/,
    /runLegacyCheckoutRoute/,
    /provisionCheckoutSession/,
    /runDirectIntakeCheckout/,
  ]) {
    assert.doesNotMatch(THIN_POST, forbidden, `the route file may not decide anything: ${forbidden}`);
  }
  // And there is exactly one of each hand-off in the whole production path, so
  // no second, unprovisioned legacy exit can exist beside the tested one.
  for (const [label, marker] of [
    ['legacy orchestration', 'runLegacyCheckoutRoute<TResponse>('],
    ['direct saga', 'runDirectIntakeCheckout('],
    ['shared provisioner', 'provisionCheckoutSession('],
  ] as const) {
    assert.equal(
      HANDLER.split(`await ${marker}`).length - 1,
      1,
      `exactly one ${label} hand-off may exist on the production path`,
    );
  }
});

test('order route: the legacy branch releases only a provisioner-approved URL', () => {
  const releases = [...HANDLER.matchAll(/redirectTo: ([A-Za-z0-9_.]+)/g)].map((match) => match[1]);
  assert.ok(releases.length > 0, 'the handler must release a checkout URL somewhere');
  for (const release of releases) {
    assert.match(
      release!,
      /^(directResult\.redirectTo|provisioned\.url|resumed\.url)$/,
      `a checkout URL may only come from a shared machine result, not ${release}`,
    );
  }
});
