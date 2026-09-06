/**
 * The `/api/order` direct-intake request contract.
 *
 * Everything here happens BEFORE any order, provider, or Stripe call, so this
 * is the layer that has to be exact. Three things it exists to prevent:
 *
 *   1. A legacy multipart request being misread as a direct one (or the other
 *      way round). The two paths persist different media, so the selection
 *      must be unambiguous and must not depend on a feature flag.
 *   2. A half-formed direct request reaching finalization. A selection is a
 *      claim about which private objects an order binds; a malformed claim has
 *      to be refused with a stable code, not repaired.
 *   3. Raw media riding along on the direct path. If files are still attached,
 *      the Mobile Safari failure this whole lane exists to fix is still there.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DIRECT_INTAKE_CAPABILITY_FIELD,
  DIRECT_INTAKE_FIELD,
  parseDirectIntakeOrderRequest,
} from '../src/lib/checkout-direct-order-request.ts';

const INTAKE_ID = `intake_${'a'.repeat(32)}`;
const HERO_ASSET = `asset_${'1'.repeat(32)}`;
const FAMILY_ASSET = `asset_${'2'.repeat(32)}`;
const VOICE_ASSET = `asset_${'3'.repeat(32)}`;
const DOC_ASSET = `asset_${'4'.repeat(32)}`;
const CAPABILITY = 'Zm9vYmFyLWNhcGFiaWxpdHktdG9rZW4tdmFsdWUtMDAx';
const ATTEMPT = 'b'.repeat(32);
const FAMILY_ID = 'supporting-character-9f1c2d3e';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    intakeId: INTAKE_ID,
    selection: {
      primaryHeroPhotoAssetId: HERO_ASSET,
      familyCharacterAssets: [{ assetId: FAMILY_ASSET, familyCharacterId: FAMILY_ID }],
      guidedStillAssetIds: [],
      voiceAssetId: null,
      documentAssetId: null,
    },
    familyCharacterIds: [FAMILY_ID],
    ...overrides,
  };
}

function directForm(
  body: unknown = payload(),
  options: { capability?: string | null; attemptId?: string | null } = {},
): FormData {
  const form = new FormData();
  form.set('checkoutAttemptId', options.attemptId === undefined ? ATTEMPT : String(options.attemptId ?? ''));
  if (body !== undefined) {
    form.set(DIRECT_INTAKE_FIELD, typeof body === 'string' ? body : JSON.stringify(body));
  }
  if (options.capability !== null) {
    form.set(DIRECT_INTAKE_CAPABILITY_FIELD, options.capability ?? CAPABILITY);
  }
  return form;
}

test('a request with no intake fields is legacy and is not disturbed', () => {
  const form = new FormData();
  form.set('checkoutAttemptId', ATTEMPT);
  form.set('childName', 'Mina');
  form.set('photo', new File([new Uint8Array([1, 2, 3])], 'hero.jpg', { type: 'image/jpeg' }));

  assert.deepEqual(parseDirectIntakeOrderRequest(form), { kind: 'legacy' });
});

test('a well-formed direct request yields the exact intake identity, capability, and selection', () => {
  const parsed = parseDirectIntakeOrderRequest(directForm());

  assert.equal(parsed.kind, 'direct');
  assert.equal(parsed.kind === 'direct' && parsed.request.intakeId, INTAKE_ID);
  assert.equal(parsed.kind === 'direct' && parsed.request.capability, CAPABILITY);
  assert.equal(parsed.kind === 'direct' && parsed.request.checkoutAttemptId, ATTEMPT);
  assert.deepEqual(parsed.kind === 'direct' && parsed.request.familyCharacterIds, [FAMILY_ID]);
  assert.deepEqual(parsed.kind === 'direct' && parsed.request.selection, {
    primaryHeroPhotoAssetId: HERO_ASSET,
    familyCharacterAssets: [{ assetId: FAMILY_ASSET, familyCharacterId: FAMILY_ID }],
    guidedStillAssetIds: [],
    voiceAssetId: null,
    documentAssetId: null,
  });
});

test('a capability without an intake payload, or an intake payload without a capability, is refused', () => {
  const noCapability = directForm(payload(), { capability: null });
  assert.deepEqual(parseDirectIntakeOrderRequest(noCapability), {
    kind: 'invalid',
    code: 'direct_intake_capability_invalid',
  });

  const noPayload = new FormData();
  noPayload.set('checkoutAttemptId', ATTEMPT);
  noPayload.set(DIRECT_INTAKE_CAPABILITY_FIELD, CAPABILITY);
  assert.deepEqual(parseDirectIntakeOrderRequest(noPayload), {
    kind: 'invalid',
    code: 'direct_intake_payload_invalid',
  });
});

test('raw media may never ride along on the direct path', () => {
  const image = () => new File([new Uint8Array([1, 2, 3])], 'x.jpg', { type: 'image/jpeg' });
  for (const field of ['photo', 'voice', 'familyCharacterPhoto_0', 'familyCharacterPhoto_3', 'guidedPhoto_0']) {
    const form = directForm();
    form.set(field, image());
    assert.deepEqual(
      parseDirectIntakeOrderRequest(form),
      { kind: 'invalid', code: 'direct_intake_media_forbidden' },
      `${field} must be refused on the direct path`,
    );
  }
});

test('the checkout attempt must be exactly what finalization will accept', () => {
  // The legacy route accepts a case-insensitive attempt id; finalization does
  // not. An uppercase id would pass the route and then fail AFTER an intake
  // reservation, so it is refused here instead.
  for (const attemptId of ['B'.repeat(32), 'b'.repeat(31), 'b'.repeat(33), '', 'not-hex-at-all']) {
    assert.deepEqual(
      parseDirectIntakeOrderRequest(directForm(payload(), { attemptId })),
      { kind: 'invalid', code: 'direct_intake_checkout_attempt_invalid' },
      `attempt id ${JSON.stringify(attemptId)} must be refused`,
    );
  }
});

test('malformed intake identities and capabilities are refused with stable codes', () => {
  assert.deepEqual(parseDirectIntakeOrderRequest(directForm('{not json')), {
    kind: 'invalid',
    code: 'direct_intake_payload_invalid',
  });
  assert.deepEqual(parseDirectIntakeOrderRequest(directForm(payload({ intakeId: 'intake_nope' }))), {
    kind: 'invalid',
    code: 'direct_intake_id_invalid',
  });
  assert.deepEqual(parseDirectIntakeOrderRequest(directForm(payload({ extraKey: 1 }))), {
    kind: 'invalid',
    code: 'direct_intake_payload_invalid',
  });
  for (const capability of ['', ' ', 'short', `${CAPABILITY}!`, 'x'.repeat(1025)]) {
    assert.deepEqual(
      parseDirectIntakeOrderRequest(directForm(payload(), { capability })),
      { kind: 'invalid', code: 'direct_intake_capability_invalid' },
      `capability ${JSON.stringify(capability.slice(0, 12))} must be refused`,
    );
  }
});

test('a selection is refused unless every asset reference is exact, unique, and in bounds', () => {
  const bad: Array<[string, unknown]> = [
    ['missing key', { primaryHeroPhotoAssetId: null, familyCharacterAssets: [], guidedStillAssetIds: [] }],
    ['unknown key', { ...payload().selection, sneak: 1 }],
    ['bad hero id', { ...payload().selection, primaryHeroPhotoAssetId: 'asset_zz' }],
    ['array hero id', { ...payload().selection, primaryHeroPhotoAssetId: [HERO_ASSET] }],
    ['guided not array', { ...payload().selection, guidedStillAssetIds: HERO_ASSET }],
    ['too many guided', {
      ...payload().selection,
      guidedStillAssetIds: [HERO_ASSET, FAMILY_ASSET, VOICE_ASSET, DOC_ASSET],
    }],
    ['duplicate asset across categories', {
      ...payload().selection,
      guidedStillAssetIds: [HERO_ASSET],
    }],
    ['voice and document together', {
      ...payload().selection,
      voiceAssetId: VOICE_ASSET,
      documentAssetId: DOC_ASSET,
    }],
  ];
  for (const [label, selection] of bad) {
    assert.deepEqual(
      parseDirectIntakeOrderRequest(directForm(payload({ selection }))),
      { kind: 'invalid', code: 'direct_intake_selection_invalid' },
      `${label} must be refused`,
    );
  }
});

test('family bindings are refused unless they name a declared, unique, well-formed stable id', () => {
  const cases: Array<[string, unknown]> = [
    ['unknown stable id', payload({
      selection: {
        ...payload().selection,
        familyCharacterAssets: [{ assetId: FAMILY_ASSET, familyCharacterId: 'someone-else' }],
      },
    })],
    ['duplicate declared id', payload({ familyCharacterIds: [FAMILY_ID, FAMILY_ID] })],
    ['illegal id character', payload({
      familyCharacterIds: ['bad id!'],
      selection: {
        ...payload().selection,
        familyCharacterAssets: [{ assetId: FAMILY_ASSET, familyCharacterId: 'bad id!' }],
      },
    })],
    ['two bindings on one id', payload({
      selection: {
        ...payload().selection,
        familyCharacterAssets: [
          { assetId: FAMILY_ASSET, familyCharacterId: FAMILY_ID },
          { assetId: VOICE_ASSET, familyCharacterId: FAMILY_ID },
        ],
      },
    })],
    ['more declared characters than the product allows', payload({
      familyCharacterIds: ['a1', 'a2', 'a3', 'a4', 'a5'],
    })],
    ['binding carries an extra key', payload({
      selection: {
        ...payload().selection,
        familyCharacterAssets: [{ assetId: FAMILY_ASSET, familyCharacterId: FAMILY_ID, index: 0 }],
      },
    })],
  ];
  for (const [label, body] of cases) {
    const parsed = parseDirectIntakeOrderRequest(directForm(body));
    assert.equal(parsed.kind, 'invalid', `${label} must be refused`);
    assert.match(
      parsed.kind === 'invalid' ? parsed.code : '',
      /^direct_intake_(selection|family_identity)_invalid$/,
      label,
    );
  }
});

test('an empty selection is legitimate — a buyer may order with no media at all', () => {
  const parsed = parseDirectIntakeOrderRequest(directForm(payload({
    selection: {
      primaryHeroPhotoAssetId: null,
      familyCharacterAssets: [],
      guidedStillAssetIds: [],
      voiceAssetId: null,
      documentAssetId: null,
    },
    familyCharacterIds: [],
  })));
  assert.equal(parsed.kind, 'direct');
});
