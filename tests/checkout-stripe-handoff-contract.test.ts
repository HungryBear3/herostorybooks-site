/**
 * What the BROWSER is allowed to tell a buyer when a checkout submission does
 * not end in a redirect to Stripe.
 *
 * Every one of these paths can be reached AFTER the server has created and
 * bound a payable provider Session:
 *
 *  - a non-2xx response whose body is not JSON, or carries no message: the
 *    server may have failed at any point, including after the create;
 *  - a 2xx response with no `redirectTo`: the order and Session exist, the
 *    response shape does not;
 *  - a redirect target the allowlist rejects: same, plus a URL we will not use.
 *
 * All three used to say "You have not been charged." That is a claim about the
 * buyer's money made from the browser, which cannot see the provider at all.
 * The only truthful answer is the reconciliation one: do not pay again, contact
 * support. A server-supplied message is preserved verbatim, because the server
 * DOES know which of its own failures it hit.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  CHECKOUT_HANDOFF_UNCONFIRMED,
  CHECKOUT_SUBMIT_UNCONFIRMED,
  checkoutSubmitFailureMessage,
  performStripeHandoff,
} from '../src/lib/checkout-handoff.ts';

const FORM = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

test('the browser reconciliation copy never denies a charge, and says what to do', () => {
  for (const copy of [CHECKOUT_SUBMIT_UNCONFIRMED, CHECKOUT_HANDOFF_UNCONFIRMED]) {
    assert.doesNotMatch(copy, /not been charged/i);
    assert.doesNotMatch(copy, /no charge/i);
    assert.doesNotMatch(copy, /nothing was charged/i);
    assert.match(copy, /do not pay again/i);
    assert.match(copy, /support@herostorybooks\.com/);
  }
});

test('a failed submission with no server message falls back to reconciliation, not to a no-charge claim', () => {
  for (const absent of [undefined, null, '', '   ', 42, {}, []]) {
    assert.equal(
      checkoutSubmitFailureMessage(absent),
      CHECKOUT_SUBMIT_UNCONFIRMED,
      `a non-message body must not produce a charge claim: ${JSON.stringify(absent)}`,
    );
  }
});

test('a server-supplied message is preserved verbatim — including its own safe no-charge sentence', () => {
  // The server knows which of its failures it hit; the browser does not. A
  // provable no-charge refusal keeps saying so.
  const proven = 'We could not securely save your order. No charge was made. Please retry in a moment.';
  assert.equal(checkoutSubmitFailureMessage(proven), proven);
  const ambiguous = 'We could not confirm the status of this checkout. Please do not pay again.';
  assert.equal(checkoutSubmitFailureMessage(ambiguous), ambiguous);
  assert.equal(checkoutSubmitFailureMessage('  trimmed  '), 'trimmed');
});

test('a rejected redirect target is a failed hand-off that navigates nowhere', () => {
  const navigations: string[] = [];
  for (const target of [
    'https://checkout.stripe.com.attacker.example/pay',
    'http://checkout.stripe.com/pay',
    'javascript:alert(1)',
    '/relative',
    null,
    undefined,
  ]) {
    const result = performStripeHandoff(target, { navigate: (url) => navigations.push(url) });
    assert.equal(result.ok, false, String(target));
    assert.equal(result.reason, 'invalid_url', String(target));
    assert.equal(result.url, null, String(target));
  }
  assert.deepEqual(navigations, [], 'a rejected target is never navigated to');
});

test('the checkout form uses the shared reconciliation copy on every unconfirmed path', () => {
  // The submit handler is a React event handler in a client component; what is
  // executable about its decisions lives in the helpers above and is driven
  // directly. This guard only pins that the handler has no second, softer copy
  // of its own for the same three states.
  const start = FORM.indexOf('const response = await fetch("/api/order"');
  const submit = FORM.slice(start, FORM.indexOf('} finally {', start));
  assert.ok(start > -1 && submit.length > 0, 'the submit path must still exist');
  assert.doesNotMatch(submit, /have not been charged/i);
  assert.doesNotMatch(submit, /no charge/i);
  assert.ok(submit.includes('checkoutSubmitFailureMessage('), 'the non-ok fallback is the shared resolver');
  assert.ok(
    submit.split('CHECKOUT_HANDOFF_UNCONFIRMED').length - 1 >= 2,
    'both the missing-redirect and rejected-URL states use the shared reconciliation copy',
  );
});

test('the error banner denies a charge only for a fresh attempt that never left the browser', () => {
  // The banner used to append "You have not been charged." to EVERY submit
  // failure, including ones that happened after this or an earlier invocation
  // could have reached the server.
  assert.equal(
    FORM.split('You have not been charged.').length - 1,
    1,
    'exactly one place may make that claim',
  );
  assert.match(FORM, /\{!chargeUnconfirmed && "You have not been charged\. "\}/);
  assert.match(FORM, /let requestSent = false;/);
  assert.match(FORM, /let attemptWasReused = false;/);
  assert.match(FORM, /attemptWasReused = Boolean\(checkoutAttemptId\);[\s\S]{0,180}if \(!checkoutAttemptId\)/);
  assert.match(FORM, /requestSent = true;\s*\n\s*const response = await fetch\("\/api\/order"/);
  assert.match(FORM, /attemptMayHaveReachedServer:\s*requestSent \|\| attemptWasReused/);
  assert.match(FORM, /setSubmitError\(described\.message, described\.showRecordedVoiceHint, requestSent \|\| attemptWasReused\)/);
  assert.match(FORM, /setChargeUnconfirmed\(Boolean\(message\) && unconfirmedCharge\)/);
});
