/**
 * The wiring itself: what `/api/order` and the checkout page do differently
 * once the direct private-intake path is switched on — and, more importantly,
 * what they must keep doing identically when it is not.
 *
 * The route cannot be imported under `node:test` (next/server + Stripe), so
 * the ordering guarantees inside it are pinned the same way the existing
 * checkout regressions pin them: by source position. Everything that CAN be
 * executed — the request fingerprint, the payload assembly — is executed.
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
  const parseIdx = ROUTE.indexOf('parseDirectIntakeOrderRequest(form)');
  const disabledIdx = ROUTE.indexOf('direct_upload_disabled');
  const stripeIdx = ROUTE.indexOf('checkout.sessions.create');
  assert.ok(parseIdx > -1 && disabledIdx > parseIdx, 'the half-enabled refusal follows the parse');
  assert.ok(disabledIdx < stripeIdx, 'the half-enabled refusal happens before Stripe');
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
  const createIdx = ROUTE.indexOf('await persistOrResumeCheckoutOrder');
  const casIdx = ROUTE.indexOf('await withOrderTransaction');
  const stripeIdx = ROUTE.indexOf('checkout.sessions.create');
  const promoIdx = ROUTE.indexOf('allow_promotion_codes: true');
  assert.ok(createIdx > -1 && casIdx > createIdx && stripeIdx > casIdx);
  assert.ok(promoIdx > stripeIdx, 'promotion codes remain part of session creation');
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
// The legacy public path used to create a Session and bind it in one breath,
// with no durable record in between. A create that succeeded followed by a bind
// that failed lost the provider identity entirely, leaving retry safety to
// Stripe's finite idempotency retention — after which an ordinary retry could
// mint a second payable Session. Source position is how the ordering guarantee
// inside this un-importable route is pinned; the behaviour itself is proven
// against the real order CAS in checkout-session-provisioning.test.ts.
// ---------------------------------------------------------------------------

test('order route: the legacy path provisions through the shared primitive, not inline', () => {
  const legacyIdx = ROUTE.indexOf('const provisioned = await provisionCheckoutSession({');
  assert.ok(legacyIdx > -1, 'the legacy branch must call the shared provisioning primitive');
  assert.match(ROUTE, /import \{ provisionCheckoutSession \} from '@\/lib\/checkout-session-provisioning'/);

  // The inline create-then-bind pair is gone. Any direct session creation in
  // this file must now live inside the injected provider adapter, never in the
  // request handler where it can outrun candidate persistence.
  const handlerEnd = ROUTE.indexOf('async function retrieveDirectCheckoutSession');
  const handler = ROUTE.slice(0, handlerEnd);
  assert.doesNotMatch(handler, /stripe\.checkout\.sessions\.create/);
  assert.doesNotMatch(handler, /bindOrderCheckoutSession\(order\.id, session\.id/);
});

test('order route: both paths inject the same four durable order primitives', () => {
  for (const primitive of [
    'renewCheckoutLease',
    'recordCheckoutSessionCandidate',
    'supersedeExpiredCheckoutSession',
    'bindOrderCheckoutSession',
  ]) {
    assert.ok(
      ROUTE.split(primitive).length - 1 >= 2,
      `${primitive} must be wired on both the direct and the legacy path`,
    );
  }
  // And every one of them comes from lib/orders, not a local reimplementation.
  const imports = ROUTE.slice(0, ROUTE.indexOf("} from '@/lib/orders';"));
  for (const primitive of [
    'recordCheckoutSessionCandidate',
    'renewCheckoutLease',
    'supersedeExpiredCheckoutSession',
    'bindOrderCheckoutSession',
  ]) {
    assert.ok(imports.includes(primitive), `${primitive} must be imported from lib/orders`);
  }
});

test('order route: the legacy branch releases the provisioner URL, never a raw session URL', () => {
  assert.match(ROUTE, /redirectTo: provisioned\.url/);
  assert.doesNotMatch(ROUTE, /redirectTo: session\.url/);
});
