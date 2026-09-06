/**
 * `@/lib/orders`, journalled.
 *
 * The REAL module runs — this only records that the route reached the durable
 * order surface at all. `createOrderRecord` is pure, but it is the first thing
 * the route does once it has decided a request is acceptable, so seeing it in
 * the journal is how "the refusal came earlier" is proven.
 *
 * Exactly the names `src/app/api/order/route.ts` imports. A new import there
 * fails loudly here rather than silently escaping the journal.
 */
import * as real from '../../../src/lib/orders.ts';
import { record } from './journal.mjs';

function spy(name) {
  const fn = real[name];
  if (typeof fn !== 'function') throw new Error(`orders.${name} is not a function`);
  return (...args) => {
    record('orders', name, null);
    return fn(...args);
  };
}

export const MAX_VOICE_BYTES = real.MAX_VOICE_BYTES;
export const OrderPersistenceError = real.OrderPersistenceError;
export const isPrintFormat = real.isPrintFormat;
// Read-only shaping the route does before it can judge a request. Not a
// durable surface, so not journalled — it must stay callable pre-refusal.
export const sanitizeFamilyCharacters = real.sanitizeFamilyCharacters;

export const createOrderRecord = spy('createOrderRecord');
export const bindOrderCheckoutSession = spy('bindOrderCheckoutSession');
export const persistOrResumeCheckoutOrder = spy('persistOrResumeCheckoutOrder');
export const renewCheckoutLease = spy('renewCheckoutLease');
export const rollbackOrderMediaUploads = spy('rollbackOrderMediaUploads');
export const uploadOrderPhoto = spy('uploadOrderPhoto');
export const uploadOrderSupportingPhoto = spy('uploadOrderSupportingPhoto');
export const uploadOrderVoice = spy('uploadOrderVoice');
export const withOrderTransaction = spy('withOrderTransaction');
