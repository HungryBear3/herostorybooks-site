import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const CHECKOUT_SRC = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
const ORDER_ROUTE_SRC = readFileSync('src/app/api/order/route.ts', 'utf8');

test('checkout requires photos for human supporting characters before payment', () => {
  assert.match(CHECKOUT_SRC, /missingSupportingCharacterPhotoLabels/);
  assert.match(CHECKOUT_SRC, /missingSupportingPhotoLabels\.join\(", "\)/);
  assert.match(CHECKOUT_SRC, /Upload picture/);
  assert.match(CHECKOUT_SRC, /Take 1 picture/);
  assert.match(CHECKOUT_SRC, /Human family members need their own still reference photo before payment/);
});

test('Dad preset is not auto-selected as the gift recipient', () => {
  assert.match(
    CHECKOUT_SRC,
    /\{ role: "dad", label: "Dad", relationshipLabel: "Dad", pronouns: "Dad", isGiftRecipient: false \}/,
  );
  assert.doesNotMatch(
    CHECKOUT_SRC,
    /\{ role: "dad", label: "Dad", relationshipLabel: "Dad", pronouns: "Dad", isGiftRecipient: true \}/,
  );
});

test('order route fails closed when human supporting-character photos are missing', () => {
  assert.match(ORDER_ROUTE_SRC, /missingSupportingCharacterPhotoLabels/);
  assert.match(ORDER_ROUTE_SRC, /supporting_character_photo_required/);
  assert.match(ORDER_ROUTE_SRC, /No charge was made/);
});
