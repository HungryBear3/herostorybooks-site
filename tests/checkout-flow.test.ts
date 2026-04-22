import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKOUT_SECTION_ORDER,
  PRINT_PREVIEW_PROMISE,
  PHOTO_UPLOAD_HELP,
} from '../src/lib/checkout-flow.ts';

test('checkout flow leads with story and hero details before photo upload', () => {
  assert.deepEqual(CHECKOUT_SECTION_ORDER, [
    'theme',
    'child-details',
    'format',
    'email',
    'photo',
    'order-summary',
  ]);
});

test('print preview promise clearly says approval happens before printing', () => {
  assert.match(PRINT_PREVIEW_PROMISE, /approve/i);
  assert.match(PRINT_PREVIEW_PROMISE, /before it prints/i);
});

test('photo upload help supports gift buyers who want to start before finding a photo', () => {
  assert.match(PHOTO_UPLOAD_HELP, /start now/i);
  assert.match(PHOTO_UPLOAD_HELP, /add a photo later/i);
});
