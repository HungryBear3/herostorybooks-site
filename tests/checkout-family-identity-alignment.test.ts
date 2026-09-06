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

/**
 * `POST /api/order` is two files. `src/app/api/order/route.ts` is a thin
 * adapter that supplies the boundaries the handler cannot construct under
 * `node:test` — the response constructor, the Stripe provider, the Blob-backed
 * media writes, the intake store — and `checkout-order-route-handler.ts` holds
 * the control flow. The gate lives in the handler, so that is where the
 * lexical checks read; the adapter is read only to confirm it reintroduces
 * nothing and defers what it injects.
 *
 * These are guards against the shape regressing, and nothing more: text
 * position is not reachability. The runtime proof — that the refusal actually
 * fires and actually precedes every durable surface — is
 * checkout-order-route-family-identity.test.ts, which executes the real POST
 * against a journalled `@vercel/blob`, `stripe` and `src/lib/orders.ts`.
 */
const HANDLER = readFileSync('src/lib/checkout-order-route-handler.ts', 'utf8');
const ADAPTER = readFileSync('src/app/api/order/route.ts', 'utf8');
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

test('the handler derives supporting-photo indexes from the alignment, not from indexOf', () => {
  for (const [name, source] of [['handler', HANDLER], ['adapter', ADAPTER]] as const) {
    assert.equal(
      source.includes('familyCharacterIds.indexOf('),
      false,
      `positional lookup into the client id array must be gone from the ${name}`,
    );
  }
  assert.match(HANDLER, /alignFamilyCharacterIdentity\(/);
  assert.match(HANDLER, /supportingPhotoIndexesForAlignment\(/);
});

test('the handler refuses a misaligned identity before persistence or Stripe', () => {
  const refusal = HANDLER.indexOf('alignFamilyCharacterIdentity({');
  assert.ok(refusal > 0, 'the handler must align the family identity');
  // The refusal is a 400 carrying the alignment's own code. The handler is
  // generic in its response type and builds every reply through the injected
  // `json(body, httpStatus)`, so the status is a positional argument rather
  // than a `status:` property on a NextResponse init.
  assert.match(
    HANDLER,
    /if \(!alignment\.ok\) \{[\s\S]{0,500}?code: FAMILY_IDENTITY_MISMATCH_CODE,[\s\S]{0,200}?\n\s*400,\n\s*\);/,
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
    'getRequiredStripeProductId(',
  ]) {
    const at = HANDLER.indexOf(later);
    assert.ok(at > 0, `expected the handler to still call ${later}`);
    assert.ok(refusal < at, `the identity refusal must come before ${later}`);
  }
});

test('the private intake store is constructed only after the identity gate', () => {
  // `createVercelIntakeStore` is NOT in the handler — it is one of the
  // boundaries the adapter injects, so no single-file ordering claim covers
  // it. What makes it late is the shape of the injection plus where the
  // handler calls the dep, and both halves are checked here.
  assert.equal(
    HANDLER.includes('createVercelIntakeStore('),
    false,
    'the handler must not reach for the concrete store itself',
  );
  // Deferred: the adapter hands over a thunk, so importing or invoking the
  // route cannot reserve anything on its own.
  assert.match(
    ADAPTER,
    /createIntakeStore:\s*\(\)\s*=>\s*createVercelIntakeStore\(\)/,
    'the adapter must inject the store as a thunk, not an already-built store',
  );
  const refusal = HANDLER.indexOf('alignFamilyCharacterIdentity({');
  const invoked = HANDLER.indexOf('deps.createIntakeStore(');
  assert.ok(invoked > 0, 'the handler must still build the intake store');
  assert.ok(
    refusal < invoked,
    'the identity refusal must come before the handler invokes the store thunk',
  );
});

test('the checkout form sends each supporting character its own stable id', () => {
  assert.match(
    FORM,
    /familyCharacters[\s\S]{0,400}?id: character\.id/,
    'the serialized familyCharacters entries must carry the stable id',
  );
});
