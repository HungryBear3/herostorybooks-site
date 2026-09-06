/**
 * `src/lib/orders.ts`, journalled.
 *
 * The REAL module runs — this only records that the request reached the
 * durable order surface at all. `createOrderRecord` is pure, but it is the
 * first thing the handler does once it has decided a request is acceptable, so
 * seeing it in the journal is how "the refusal came earlier" is proven.
 *
 * `export *` carries every other name through untouched, because the resolve
 * hook now stands in front of the whole checkout graph — the route adapter,
 * `checkout-order-route-handler.ts`, the session provisioner, the legacy
 * orchestration — and an enumerated list would turn any unrelated import into
 * a link error rather than a finding. The names that MATTER are enumerated
 * below and shadow the star, so a durable call cannot silently escape the
 * journal; `spy()` fails loudly if one is renamed out from under it.
 */
import * as real from '../../../src/lib/orders.ts';
import { record } from './journal.mjs';

export * from '../../../src/lib/orders.ts';

function spy(name) {
  const fn = real[name];
  if (typeof fn !== 'function') throw new Error(`orders.${name} is not a function`);
  return (...args) => {
    record('orders', name, null);
    return fn(...args);
  };
}

// Every durable write, plus the reads that only a request past the gates makes.
// `sanitizeFamilyCharacters` is deliberately NOT here: it is read-only shaping
// the handler performs before it can judge a request, so it must stay callable
// pre-refusal without registering as a durable touch.
export const createOrderRecord = spy('createOrderRecord');
export const bindOrderCheckoutSession = spy('bindOrderCheckoutSession');
export const persistOrResumeCheckoutOrder = spy('persistOrResumeCheckoutOrder');
export const renewCheckoutLease = spy('renewCheckoutLease');
export const rollbackOrderMediaUploads = spy('rollbackOrderMediaUploads');
export const uploadOrderPhoto = spy('uploadOrderPhoto');
export const uploadOrderSupportingPhoto = spy('uploadOrderSupportingPhoto');
export const uploadOrderVoice = spy('uploadOrderVoice');
export const uploadOrderDocument = spy('uploadOrderDocument');
export const withOrderTransaction = spy('withOrderTransaction');
export const beginCheckoutSessionProvisioning = spy('beginCheckoutSessionProvisioning');
export const recordCheckoutSessionCandidate = spy('recordCheckoutSessionCandidate');
export const supersedeExpiredCheckoutSession = spy('supersedeExpiredCheckoutSession');
