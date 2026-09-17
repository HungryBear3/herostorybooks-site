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
  CHECKOUT_FRESH_ATTEMPT_GUIDANCE,
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

test('a reconciliation code adds bounded recovery without weakening the refusal', () => {
  const server = 'We could not confirm the status of this checkout. Please do not pay again — contact support@herostorybooks.com with your order details and we will confirm exactly what happened and put it right.';

  for (const code of ['checkout_canonical_reconciliation_required', 'checkout_intent_order_ownership_conflict']) {
    const message = checkoutSubmitFailureMessage(server, code);
    assert.ok(message.startsWith(server), `${code} must keep the server sentence first`);
    assert.equal(message, `${server} ${CHECKOUT_FRESH_ATTEMPT_GUIDANCE}`);
    assert.match(message, /do not pay again/i);
    // The guidance offers ONE more submission of this form. It may not deny a
    // charge, claim the request stopped, or promise the next attempt succeeds.
    assert.doesNotMatch(message, /not been charged|no charge|nothing was charged|stopped before payment/i);
    assert.doesNotMatch(CHECKOUT_FRESH_ATTEMPT_GUIDANCE, /\b(?:retry|try again|reload)\b/i);
    assert.match(CHECKOUT_FRESH_ATTEMPT_GUIDANCE, /once more/i);
  }
});

test('every other refusal keeps exactly the message it had', () => {
  const server = 'We could not confirm the status of this checkout. Please do not pay again.';
  for (const code of [
    undefined, null, '', 'checkout_unconfirmed', 'hero_photo_persist_failed',
    'CHECKOUT_CANONICAL_RECONCILIATION_REQUIRED', 42, {},
  ]) {
    assert.equal(checkoutSubmitFailureMessage(server, code), server, `unexpected guidance for ${String(code)}`);
  }
  assert.equal(
    checkoutSubmitFailureMessage(null, 'checkout_intent_order_ownership_conflict'),
    `${CHECKOUT_SUBMIT_UNCONFIRMED} ${CHECKOUT_FRESH_ATTEMPT_GUIDANCE}`,
    'a refusal with a code but no sentence still reconciles first',
  );
});

test('the checkout form passes the refusal code to the shared resolver', () => {
  const start = FORM.indexOf('const response = await fetch("/api/order"');
  const submit = FORM.slice(start, FORM.indexOf('} finally {', start));
  assert.match(submit, /checkoutSubmitFailureMessage\(serverMessage, serverCode\)/);
  assert.match(submit, /serverCode = refusal\?\.code/);
  // Bounded means buyer-driven: no automatic resubmission of an ambiguous POST.
  assert.doesNotMatch(submit.slice(0, submit.indexOf('} catch (error) {')), /fetch\("\/api\/order"[\s\S]*fetch\("\/api\/order"/);
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

test('the error banner distinguishes the current order request from an unresolved older attempt', () => {
  // The banner used to append "You have not been charged." to EVERY submit
  // failure, including ones that happened after this or an earlier invocation
  // could have reached the server. It then kept doing so through the RENDER,
  // below a message that said the opposite. The claim now exists in exactly one
  // place — the decision helper — and the page has no literal of its own, so no
  // branch of the JSX can reintroduce it.
  assert.equal(
    FORM.split('You have not been charged').length - 1,
    0,
    'the page may not carry its own no-charge literal',
  );
  const customerFacingStringLiterals = [...FORM.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    .join('\n');
  assert.doesNotMatch(
    customerFacingStringLiterals,
    /no charge|nothing was charged/i,
    'the page may import audited helpers/constants but must not own literal no-charge copy',
  );

  // Every rendered line comes from the one decision helper, which is driven
  // directly in tests/checkout-paid-attempt-recovery.test.ts.
  assert.match(FORM, /setSubmitBannerState\(checkoutSubmitBanner\(\{[\s\S]{0,180}message,[\s\S]{0,180}attemptRisk,[\s\S]{0,180}recordedVoiceHint,[\s\S]{0,180}paidAttemptId: paidAttemptRef\.current/);
  assert.match(FORM, /\{submitBanner\.heading\}/);
  assert.match(FORM, /\{submitBanner\.message\}/);
  assert.match(FORM, /submitBanner\.noChargeReassurance && `\$\{NOT_CHARGED\} `/);
  assert.match(FORM, /submitBanner\.showRecordedVoiceHint && SUBMIT_BANNER_RECORDED_VOICE_HINT/);

  // Dispatch state stays separate from retained-marker state.
  assert.match(FORM, /let requestSent = false;/);
  assert.match(FORM, /let attemptWasPreviouslySent = false;/);
  assert.match(FORM, /if \(!serverLeaseBacked && !markCheckoutAttemptSent\(checkoutAttemptId\)\)[\s\S]{0,300}throw new Error/);
  assert.match(FORM, /if \(!serverLeaseBacked\) checkoutAttemptSentRef\.current = checkoutAttemptId;\s*\n\s*requestSent = true;/);
  assert.match(FORM, /requestSent = true;\s*\n\s*const response = await fetch\("\/api\/order"/);
  assert.match(FORM, /checkoutSubmitAttemptRisk\(\{[\s\S]{0,200}requestSent,[\s\S]{0,200}previouslySent: attemptWasPreviouslySent,[\s\S]{0,200}previousAttemptResolved,[\s\S]{0,200}previousAttemptPaid/);
  assert.match(FORM, /setSubmitError\(described\.message, described\.showRecordedVoiceHint, attemptRisk\)/);
  // Resolution evidence outlives the invocation that earned it.
  assert.match(FORM, /resolvedAttemptRef = useRef</);
  assert.match(FORM, /resolvedAttemptId: resolvedAttemptRef\.current/);
  assert.match(FORM, /checkoutSubmitBannerAttemptRisk\(\{/);
});

test('a previously paid attempt cannot be rotated into a second payable checkout by Continue', () => {
  // The rotation branch is gated on the shared decision helper, which is driven
  // directly in tests/checkout-paid-attempt-recovery.test.ts. What is pinned
  // here is that the handler has no second, softer path of its own.
  assert.match(FORM, /decideCheckoutAttemptContinue\(\{/);
  assert.match(FORM, /continueDecision\.action === "paid_confirmation_required"/);
  assert.match(FORM, /continueDecision\.action === "rotate_attempt"/);
  assert.match(FORM, /newPurchaseConsentAttemptId: newPurchaseConsentRef\.current/);
  // Consent is written by an explicit control, never by the submit handler.
  const submitStart = FORM.indexOf('const handleSubmit');
  const submitEnd = FORM.indexOf('} finally {', submitStart);
  const submit = FORM.slice(submitStart, submitEnd);
  assert.ok(submitStart > -1 && submitEnd > submitStart);
  const submitConsentAssignments = [
    ...submit.matchAll(/newPurchaseConsentRef\.current\s*=\s*([^;\n]+)/g),
  ].map((match) => match[1].trim());
  assert.deepEqual(
    submitConsentAssignments,
    ['null'],
    'the submit handler must clear new-purchase consent exactly once and never grant it',
  );
  // Exactly one place mints a replacement identity after a restart approval.
  assert.equal(
    FORM.split('decideCheckoutAttemptContinue({').length - 1,
    1,
    'one decision point owns every rotation',
  );
});

test('clearing recovered form details never advertises or creates a fresh payment attempt', () => {
  const recoveryStart = FORM.indexOf('{showRecovery &&');
  const recoveryEnd = FORM.indexOf('</AnimatePresence>', recoveryStart);
  const recovery = FORM.slice(recoveryStart, recoveryEnd);
  assert.ok(recoveryStart > -1 && recoveryEnd > recoveryStart);
  assert.match(recovery, />\s*Clear saved details\s*</);
  assert.doesNotMatch(recovery, />\s*Start fresh\s*</);
  assert.doesNotMatch(recovery, /checkoutAttemptIdRef\.current\s*=\s*null/);
  assert.doesNotMatch(recovery, /removeItem\(CHECKOUT_ATTEMPT_STORAGE_KEY\)/);
});
