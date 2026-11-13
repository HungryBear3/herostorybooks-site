import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeShippingContact, normalizeShippingInput, shippingBinding } from '../src/lib/shipping-selection.ts';

function input() {
  return {
    draftId: 'synthetic-draft-1', ownerBinding: 'a'.repeat(64), operation: 'initial_checkout_shipping',
    plannedProductVersion: 'synthetic-layout-v1', bookFormat: 'classic', podPackageId: 'SC.PKG',
    pageCount: 32, quantity: 1, currency: 'USD', baselineService: 'MAIL', selectedService: 'EXPEDITED',
    address: { name: 'Synthetic Recipient', phone: '+13125550101', line1: '123 Example Lane', line2: null,
      city: 'Chicago', state: 'IL', zip: '60601', country: 'US', isBusiness: false, isPostbox: false },
  };
}

test('contact normalization preserves the priced name/phone and eligibility flags', () => {
  const raw = input().address;
  assert.deepEqual(normalizeShippingContact(raw), raw);
  assert.equal(normalizeShippingContact({ ...raw, state: ' il ', country: 'us' }).state, 'IL');
});

test('invalid or missing real contact fails without echoing rejected values', () => {
  for (const patch of [{ phone: '' }, { phone: undefined }, { name: '' }, { phone: '000-000-0000' },
    { phone: 'SYNTHETIC_PRIVATE_SENTINEL' }, { country: 'CA' }, { isPostbox: 'false' }, { zip: 'bad' }]) {
    assert.throws(() => normalizeShippingContact({ ...input().address, ...patch }), /^Error: SHIPPING_INPUT_INVALID$/);
  }
});

test('shipping-only input enforces one planned printed book and explicit frozen services', () => {
  for (const patch of [{ quantity: 2 }, { quantity: 0 }, { quantity: 1.5 }, { bookFormat: 'digital' },
    { pageCount: NaN }, { pageCount: 0 }, { currency: 'EUR' }, { ownerBinding: 'raw-capability' },
    { plannedProductVersion: '' }, { selectedService: 'MAIL' }, { baselineService: '' }]) {
    assert.throws(() => normalizeShippingInput({ ...input(), ...patch }), /SHIPPING_INPUT_INVALID/);
  }
});

test('binding changes for every meaningful ownership/product/service/contact field', () => {
  const raw = input();
  const original = shippingBinding(normalizeShippingInput(raw));
  const mutations = [{ draftId: 'another-draft' }, { ownerBinding: 'b'.repeat(64) }, { plannedProductVersion: 'layout-v2' },
    { bookFormat: 'premium' }, { podPackageId: 'HC.PKG' }, { pageCount: 40 }, { selectedService: 'EXPRESS' },
    { baselineService: 'GROUND' }];
  for (const patch of mutations) assert.notEqual(shippingBinding(normalizeShippingInput({ ...raw, ...patch })), original);
  for (const patch of [{ name: 'Other Synthetic Recipient' }, { phone: '+13125550102' }, { line1: '124 Example Lane' },
    { line2: 'Unit 2' }, { city: 'Evanston' }, { state: 'WI' }, { zip: '60602' }, { isBusiness: true }, { isPostbox: true }]) {
    assert.notEqual(shippingBinding(normalizeShippingInput({ ...raw, address: { ...raw.address, ...patch } })), original);
  }
});

test('normalization detaches the caller input before any awaited producer work', () => {
  const raw = input(); const frozen = normalizeShippingInput(raw); const before = shippingBinding(frozen);
  raw.address.phone = '+13125550103'; raw.podPackageId = 'CHANGED.PKG';
  assert.equal(shippingBinding(frozen), before);
  assert.equal(frozen.address.phone, '+13125550101');
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.address), true);
});
