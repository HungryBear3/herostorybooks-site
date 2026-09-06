/*
 * The supporting-character description gate is index-based, and in the direct
 * intake flow the indexes were derived from a free-floating client array:
 *
 *   familyCharacterIds.indexOf(binding.familyCharacterId)
 *
 * Nothing tied position `i` of that array to position `i` of the
 * `familyCharacters` payload the same request carried. A buyer could therefore
 * declare the ids in one order and the characters in another and the photo
 * exemption would land on the wrong person:
 *
 *   familyCharacters   = [ Nana (no description), Uncle Bo (description) ]
 *   familyCharacterIds = [ "char-bo", "char-nana" ]      <- reordered
 *   familyCharacterAssets = [ { familyCharacterId: "char-bo" } ]
 *
 *   indexOf("char-bo") === 0  ->  index 0 counts as photo-backed
 *   ->  Nana needs no written description, and downstream `likenessIntent`
 *       marks NANA as photo-referenced while Bo — who actually uploaded — is
 *       left with none.
 *
 * The fix makes the id travel ON the character, so eligibility is derived from
 * the character's own stable id, and any declared list that does not match it
 * element-for-element is refused before persistence or Stripe.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  alignFamilyCharacterIdentity,
  FAMILY_IDENTITY_MISMATCH_CODE,
  supportingPhotoIndexesForAlignment,
} from '../src/lib/checkout-family-identity.ts';
import { sanitizeFamilyCharacters } from '../src/lib/orders.ts';
import {
  clearUntrustedSupportingPhotoMetadata,
  missingSupportingCharacterDescriptionLabels,
} from '../src/lib/checkout-photo-policy.ts';

const ROUTE = readFileSync('src/app/api/order/route.ts', 'utf8');
const FORM = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

/** Nana carries no written description; Uncle Bo does. */
function familyPayload(ids: [string, string]): string {
  return JSON.stringify([
    {
      id: ids[0],
      role: 'grandparent',
      name: 'Nana',
      relationshipLabel: 'grandma',
      pronouns: '',
      notes: '',
      isGiftRecipient: false,
      appearsInStory: true,
      photoFileName: null,
      mustInclude: [],
      mustIncludeOther: '',
      focusPersonLabel: null,
      cropHint: null,
    },
    {
      id: ids[1],
      role: 'other',
      name: 'Uncle Bo',
      relationshipLabel: 'uncle',
      pronouns: '',
      notes: 'tall, curly hair, always in a denim jacket',
      isGiftRecipient: false,
      appearsInStory: true,
      photoFileName: null,
      mustInclude: [],
      mustIncludeOther: '',
      focusPersonLabel: null,
      cropHint: null,
    },
  ]);
}

function characters(raw: string) {
  return clearUntrustedSupportingPhotoMetadata(sanitizeFamilyCharacters(raw));
}

function missingDescriptions(raw: string, declaredIds: string[], boundIds: string[]): string[] {
  const family = characters(raw);
  const alignment = alignFamilyCharacterIdentity({
    rawFamilyCharacters: raw,
    sanitizedCount: family.length,
    declaredIds,
  });
  assert.ok(alignment.ok, 'this helper is only for requests that align');
  return missingSupportingCharacterDescriptionLabels(
    family,
    supportingPhotoIndexesForAlignment(alignment.ids, boundIds),
  );
}

// ── the defect ──────────────────────────────────────────────────────────────

test('a reordered declared id list is refused rather than re-indexed', () => {
  const raw = familyPayload(['char-nana', 'char-bo']);
  const family = characters(raw);
  assert.equal(family.length, 2);

  const alignment = alignFamilyCharacterIdentity({
    rawFamilyCharacters: raw,
    sanitizedCount: family.length,
    // The characters are declared Nana-then-Bo, but the ids arrive reversed.
    declaredIds: ['char-bo', 'char-nana'],
  });

  assert.equal(alignment.ok, false);
  assert.equal(
    alignment.ok === false ? alignment.code : null,
    'direct_intake_family_identity_mismatch',
  );
});

test('the reorder cannot lend Bo’s photo to Nana’s description requirement', () => {
  const raw = familyPayload(['char-nana', 'char-bo']);
  const family = characters(raw);

  // What the honest request produces: Bo uploaded, so only Bo is exempt, and
  // Nana — who wrote nothing — is still named as missing.
  assert.deepEqual(
    missingDescriptions(raw, ['char-nana', 'char-bo'], ['char-bo']),
    ['Nana'],
  );

  // The crafted request never gets that far: it is refused outright.
  assert.equal(
    alignFamilyCharacterIdentity({
      rawFamilyCharacters: raw,
      sanitizedCount: family.length,
      declaredIds: ['char-bo', 'char-nana'],
    }).ok,
    false,
  );
});

// ── what must keep working ──────────────────────────────────────────────────

test('an aligned request exempts exactly the characters that own a photo', () => {
  const raw = familyPayload(['char-nana', 'char-bo']);

  assert.deepEqual(missingDescriptions(raw, ['char-nana', 'char-bo'], ['char-nana']), []);
  assert.deepEqual(missingDescriptions(raw, ['char-nana', 'char-bo'], ['char-bo']), ['Nana']);
  assert.deepEqual(missingDescriptions(raw, ['char-nana', 'char-bo'], []), ['Nana']);
  assert.deepEqual(
    missingDescriptions(raw, ['char-nana', 'char-bo'], ['char-nana', 'char-bo']),
    [],
  );
});

test('indexes come from the character’s own id, not from the bound array order', () => {
  const ids = ['char-nana', 'char-bo'];
  assert.deepEqual([...supportingPhotoIndexesForAlignment(ids, ['char-bo'])], [1]);
  assert.deepEqual([...supportingPhotoIndexesForAlignment(ids, ['char-nana'])], [0]);
  assert.deepEqual(
    [...supportingPhotoIndexesForAlignment(ids, ['char-bo', 'char-nana'])].sort(),
    [0, 1],
  );
  // An id nobody declared contributes no index — it never becomes -1.
  assert.deepEqual([...supportingPhotoIndexesForAlignment(ids, ['char-ghost'])], []);
});

// ── malformed identity ──────────────────────────────────────────────────────

test('missing, malformed, duplicated and miscounted ids are all refused', () => {
  const family = characters(familyPayload(['char-nana', 'char-bo']));
  const align = (rawFamilyCharacters: unknown, declaredIds: string[]) =>
    alignFamilyCharacterIdentity({
      rawFamilyCharacters,
      sanitizedCount: family.length,
      declaredIds,
    }).ok;

  // No id on the character at all — the pre-fix wire format.
  const idless = JSON.parse(familyPayload(['char-nana', 'char-bo'])) as Record<string, unknown>[];
  for (const entry of idless) delete entry.id;
  assert.equal(align(JSON.stringify(idless), ['char-nana', 'char-bo']), false);

  // An id that is not a plausible stable identifier.
  assert.equal(align(familyPayload(['char nana!', 'char-bo']), ['char nana!', 'char-bo']), false);

  // The same id twice.
  assert.equal(align(familyPayload(['char-bo', 'char-bo']), ['char-bo', 'char-bo']), false);

  // Fewer declared ids than characters, and more.
  assert.equal(align(familyPayload(['char-nana', 'char-bo']), ['char-nana']), false);
  assert.equal(
    align(familyPayload(['char-nana', 'char-bo']), ['char-nana', 'char-bo', 'char-x']),
    false,
  );

  // Not an array / unparseable.
  assert.equal(align('{}', ['char-nana', 'char-bo']), false);
  assert.equal(align('not json', ['char-nana', 'char-bo']), false);
});

test('an order with no supporting characters aligns against an empty id list', () => {
  const alignment = alignFamilyCharacterIdentity({
    rawFamilyCharacters: '',
    sanitizedCount: 0,
    declaredIds: [],
  });
  assert.equal(alignment.ok, true);
  assert.deepEqual(alignment.ok ? [...alignment.ids] : null, []);
});

// ── wiring ──────────────────────────────────────────────────────────────────

test('the route derives supporting-photo indexes from the alignment, not from indexOf', () => {
  assert.equal(
    ROUTE.includes('familyCharacterIds.indexOf('),
    false,
    'positional lookup into the client id array must be gone',
  );
  assert.match(ROUTE, /alignFamilyCharacterIdentity\(/);
  assert.match(ROUTE, /supportingPhotoIndexesForAlignment\(/);
});

test('the route refuses a misaligned identity before persistence or Stripe', () => {
  const refusal = ROUTE.indexOf('alignFamilyCharacterIdentity({');
  assert.ok(refusal > 0, 'the route must align the family identity');
  // The refusal is a 400 carrying the alignment's own code, so the buyer is
  // told nothing was charged and the reason is the shared identity contract.
  assert.match(
    ROUTE,
    /if \(!alignment\.ok\) \{[\s\S]{0,500}?code: FAMILY_IDENTITY_MISMATCH_CODE,[\s\S]{0,200}?status: 400/,
    'a failed alignment must return 400 with the alignment code',
  );
  assert.equal(
    FAMILY_IDENTITY_MISMATCH_CODE,
    'direct_intake_family_identity_mismatch',
    'the refusal code stays the one the direct-order path already contracts on',
  );

  for (const later of [
    'createOrderRecord(',
    'persistOrResumeCheckoutOrder(',
    'runDirectIntakeCheckout(',
    'createVercelIntakeStore(',
    'getRequiredStripeProductId(',
  ]) {
    const at = ROUTE.indexOf(later);
    assert.ok(at > 0, `expected the route to still call ${later}`);
    assert.ok(refusal < at, `the identity refusal must come before ${later}`);
  }
});

test('the checkout form sends each supporting character its own stable id', () => {
  assert.match(
    FORM,
    /familyCharacters[\s\S]{0,400}?id: character\.id/,
    'the serialized familyCharacters entries must carry the stable id',
  );
});
