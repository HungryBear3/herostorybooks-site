/**
 * The wiring itself: what `/api/order` and the checkout page do differently
 * once the direct private-intake path is switched on — and, more importantly,
 * what they must keep doing identically when it is not.
 *
 * The route cannot be imported under `node:test` (next/server + Stripe).
 * Everything that CAN be executed — the request fingerprint, the payload
 * assembly — is executed, and the route's actual checkout behaviour is driven
 * end-to-end at its extracted entrypoints against the real order CAS (see
 * checkout-legacy-order-entrypoint.test.ts and
 * checkout-session-provisioning.test.ts).
 *
 * What is left for source inspection is only what those cannot show about a
 * file they do not import: that the handler retains NO provider surface and no
 * session decision of its own. Those guards are stated as absence inside the
 * handler body, not as "X appears before Y" — position was the weakness in the
 * tests this replaces, because the provider adapters are declared below the
 * handler and so came "after" everything regardless of control flow.
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

const ROUTE = readFileSync('src/app/api/order/route.ts', 'utf8');
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
const ADAPTERS_AT = ROUTE.indexOf('async function retrieveDirectCheckoutSession');
const HANDLER = ROUTE.slice(ROUTE.indexOf('export async function POST'), ADAPTERS_AT);
const ADAPTERS = ROUTE.slice(ADAPTERS_AT);
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
  const photoUploadIdx = ROUTE.indexOf('await uploadOrderPhoto');
  const supportingUploadIdx = ROUTE.indexOf('await uploadOrderSupportingPhoto');
  const voiceUploadIdx = ROUTE.indexOf('await uploadOrderVoice');
  assert.ok(directIdx > -1, 'route must run the direct saga');
  for (const [label, idx] of [
    ['hero', photoUploadIdx], ['supporting', supportingUploadIdx], ['voice', voiceUploadIdx],
  ] as const) {
    assert.ok(idx > directIdx, `the direct branch must precede the legacy ${label} upload`);
  }
});

test('order route: legacy ordering guarantees are untouched', () => {
  const resumeIdx = HANDLER.indexOf('await resumeOrContinueLegacyCheckout');
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
  // Exactly two hand-offs exist on the legacy path: the resume/recovery
  // entrypoint before media, and the shared machine after the final order CAS.
  assert.match(HANDLER, /await resumeOrContinueLegacyCheckout\(/);
  assert.match(HANDLER, /await provisionCheckoutSession\(/);
  assert.match(ROUTE, /from '@\/lib\/checkout-legacy-order'/);
  assert.match(ROUTE, /from '@\/lib\/checkout-session-provisioning'/);
  // Media, pause, and order persistence all precede BOTH of them.
  const resumeIdx = HANDLER.indexOf('await resumeOrContinueLegacyCheckout(');
  const provisionIdx = HANDLER.indexOf('await provisionCheckoutSession(');
  for (const [label, marker] of [
    ['checkout pause', 'isCheckoutPaused()'],
    ['request parse', 'parseDirectIntakeOrderRequest(form)'],
    ['durable owner record', 'await resumeOrContinueLegacyCheckout('],
  ] as const) {
    const idx = HANDLER.indexOf(marker);
    assert.ok(idx > -1 && idx <= resumeIdx, `${label} must precede the legacy resume entrypoint`);
  }
  for (const [label, marker] of [
    ['hero photo upload', 'await uploadOrderPhoto'],
    ['supporting photo upload', 'await uploadOrderSupportingPhoto'],
    ['voice upload', 'await uploadOrderVoice'],
    ['document upload', 'await uploadOrderDocument'],
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
    const imports = ROUTE.slice(0, ROUTE.indexOf("} from '@/lib/orders';"));
    assert.ok(imports.includes(primitive), `${primitive} must be imported from lib/orders`);
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
