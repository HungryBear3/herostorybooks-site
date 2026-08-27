import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ALLOWED_STRIPE_CHECKOUT_HOSTS,
  createSubmitLock,
  isAllowedStripeCheckoutUrl,
  performStripeHandoff,
} from '../src/lib/checkout-handoff.ts';

const CHECKOUT_FORM_SRC = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
const VALID = 'https://checkout.stripe.com/c/pay/cs_test_placeholder#fidExample';

// ── Redirect allowlist: fail closed ────────────────────────────────────────

test('accepts the exact Stripe Checkout host over https', () => {
  assert.equal(isAllowedStripeCheckoutUrl(VALID), true);
  assert.equal(isAllowedStripeCheckoutUrl('https://CHECKOUT.STRIPE.COM/c/pay/cs_x'), true);
  assert.equal(isAllowedStripeCheckoutUrl(`  ${VALID}  `), true);
});

test('the allowlist is the single host the app already recognizes', () => {
  assert.deepEqual([...ALLOWED_STRIPE_CHECKOUT_HOSTS], ['checkout.stripe.com']);
});

test('rejects missing, empty, and non-string redirect targets', () => {
  for (const value of [undefined, null, '', '   ', 0, 1, {}, [], true, () => VALID]) {
    assert.equal(isAllowedStripeCheckoutUrl(value), false, `accepted ${String(value)}`);
  }
});

test('rejects non-HTTPS schemes, including script and data URLs', () => {
  for (const value of [
    'http://checkout.stripe.com/c/pay/cs_x',
    'javascript:alert(1)',
    'JavaScript:void(0)',
    'data:text/html,<script>1</script>',
    'blob:https://checkout.stripe.com/abc',
    'ftp://checkout.stripe.com/x',
  ]) {
    assert.equal(isAllowedStripeCheckoutUrl(value), false, `accepted ${value}`);
  }
});

test('rejects relative and protocol-relative targets (no open redirect)', () => {
  for (const value of ['/c/pay/cs_x', '//checkout.stripe.com/c/pay/cs_x', 'checkout.stripe.com/c/pay/cs_x']) {
    assert.equal(isAllowedStripeCheckoutUrl(value), false, `accepted ${value}`);
  }
});

test('rejects lookalike hosts rather than matching a suffix', () => {
  for (const value of [
    'https://checkout.stripe.com.attacker.example/c/pay/cs_x',
    'https://notcheckout.stripe.com/c/pay/cs_x',
    'https://checkout.stripe.com.evil/c/pay/cs_x',
    'https://stripe.com/c/pay/cs_x',
    'https://attacker.example/?next=https://checkout.stripe.com/c/pay/cs_x',
    'https://attacker.example/checkout.stripe.com',
  ]) {
    assert.equal(isAllowedStripeCheckoutUrl(value), false, `accepted ${value}`);
  }
});

test('rejects credential-embedding URLs whose real host is not Stripe', () => {
  assert.equal(isAllowedStripeCheckoutUrl('https://checkout.stripe.com@attacker.example/x'), false);
  assert.equal(isAllowedStripeCheckoutUrl('https://user:pw@checkout.stripe.com/c/pay/cs_x'), false);
});

// ── Hand-off: immediate, once, unblockable ─────────────────────────────────

function spyDeps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const navigated: string[] = [];
  return {
    calls,
    navigated,
    deps: {
      navigate: (url: string) => {
        calls.push('navigate');
        navigated.push(url);
      },
      clearSavedDraft: () => void calls.push('clearSavedDraft'),
      clearAttemptId: () => void calls.push('clearAttemptId'),
      ...overrides,
    },
  };
}

test('a valid URL navigates exactly once, in the same tick, with no timer', () => {
  const { calls, navigated, deps } = spyDeps();
  const result = performStripeHandoff(VALID, deps);
  // Synchronous: the navigation has already happened by the time this returns.
  assert.equal(navigated.length, 1);
  assert.equal(navigated[0], VALID);
  assert.equal(result.ok, true);
  assert.equal(result.url, VALID);
  assert.equal(result.reason, null);
  // Navigation strictly precedes every cleanup step.
  assert.deepEqual(calls, ['navigate', 'clearSavedDraft', 'clearAttemptId']);
});

test('cleanup cannot delay, block, or undo a started hand-off', () => {
  const { navigated, deps } = spyDeps({
    clearSavedDraft: () => {
      throw new Error('localStorage unavailable');
    },
    clearAttemptId: () => {
      throw new Error('sessionStorage unavailable');
    },
  });
  const result = performStripeHandoff(VALID, deps);
  assert.equal(navigated.length, 1);
  assert.equal(result.ok, true, 'a throwing storage cleanup must not fail the hand-off');
});

test('the hand-off works with no cleanup hooks at all', () => {
  const navigated: string[] = [];
  const result = performStripeHandoff(VALID, { navigate: (url) => void navigated.push(url) });
  assert.deepEqual(navigated, [VALID]);
  assert.equal(result.ok, true);
});

test('an unapproved URL never navigates and never clears state', () => {
  for (const bad of [undefined, '', 'http://checkout.stripe.com/x', 'https://attacker.example/x']) {
    const { calls, deps } = spyDeps();
    const result = performStripeHandoff(bad, deps);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_url');
    assert.equal(result.url, null);
    assert.deepEqual(calls, [], `side effects ran for ${String(bad)}`);
  }
});

test('a refused navigation keeps the attempt id so a retry reuses the session', () => {
  const calls: string[] = [];
  const result = performStripeHandoff(VALID, {
    navigate: () => {
      calls.push('navigate');
      throw new Error('navigation blocked');
    },
    clearSavedDraft: () => void calls.push('clearSavedDraft'),
    clearAttemptId: () => void calls.push('clearAttemptId'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'navigation_failed');
  // The validated URL is returned so the UI can offer it as a manual link
  // without creating another order or Stripe Checkout Session.
  assert.equal(result.url, VALID);
  assert.deepEqual(calls, ['navigate'], 'a failed hand-off must not clear the attempt id');
});

// ── Submit lock: one click, one order ──────────────────────────────────────

test('submit lock admits exactly one caller until released', () => {
  const lock = createSubmitLock();
  assert.equal(lock.acquire(), true);
  assert.equal(lock.acquire(), false, 'a rapid second click must not start a second order');
  assert.equal(lock.acquire(), false);
  assert.equal(lock.held, true);
  lock.release();
  assert.equal(lock.held, false);
  assert.equal(lock.acquire(), true, 'a failed submit must be retryable');
});

test('a held lock stops repeated re-entry (StrictMode / re-render) from re-navigating', () => {
  const lock = createSubmitLock();
  const navigated: string[] = [];
  const submit = () => {
    if (!lock.acquire()) return;
    performStripeHandoff(VALID, { navigate: (url) => void navigated.push(url) });
  };
  submit();
  submit();
  submit();
  assert.equal(navigated.length, 1);
});

// ── Checkout form wiring ───────────────────────────────────────────────────

test('the checkout form no longer delays the Stripe hand-off behind a timer', () => {
  assert.doesNotMatch(
    CHECKOUT_FORM_SRC,
    /window\.location\.(href|assign)\s*=\s*result/,
    'the hand-off must go through performStripeHandoff, not a bare assignment',
  );
  assert.doesNotMatch(
    CHECKOUT_FORM_SRC,
    /setTimeout\([\s\S]{0,400}?window\.location/,
    'no timer may sit between a successful response and the Stripe navigation',
  );
  assert.doesNotMatch(CHECKOUT_FORM_SRC, /\},\s*1200\)/, 'the 1.2s hand-off delay must be gone');
});

test('the checkout form hands off through the validated, immediate path', () => {
  assert.match(CHECKOUT_FORM_SRC, /performStripeHandoff\(result\.redirectTo/);
  assert.match(CHECKOUT_FORM_SRC, /navigate:\s*\(url\)\s*=>\s*window\.location\.replace\(url\)/);
  assert.match(CHECKOUT_FORM_SRC, /handoff\.reason === "invalid_url"/);
});

test('the checkout form takes a ref-backed submit lock before any network call', () => {
  assert.match(CHECKOUT_FORM_SRC, /submitLockRef\.current\?\.acquire\(\)/);
  assert.match(CHECKOUT_FORM_SRC, /submitLockRef\.current\?\.release\(\)/);
  const acquireAt = CHECKOUT_FORM_SRC.indexOf('submitLockRef.current?.acquire()');
  const fetchAt = CHECKOUT_FORM_SRC.indexOf('fetch("/api/order"');
  assert.ok(acquireAt > 0 && fetchAt > 0);
  assert.ok(acquireAt < fetchAt, 'the lock must be claimed before the order request');
});

test('the interstitial offers the already-created Stripe URL as a manual fallback', () => {
  assert.match(CHECKOUT_FORM_SRC, /data-testid="stripe-handoff-fallback"/);
  assert.match(CHECKOUT_FORM_SRC, /href=\{checkoutHandoffUrl\}/);
  assert.match(CHECKOUT_FORM_SRC, /does not create a second order/);
});

test('analytics stays out of the hand-off path', () => {
  const handoffAt = CHECKOUT_FORM_SRC.indexOf('performStripeHandoff(result.redirectTo');
  const successAt = CHECKOUT_FORM_SRC.indexOf('setSuccess(true)');
  assert.ok(handoffAt > 0 && successAt > handoffAt, 'navigation must precede success state');
  const between = CHECKOUT_FORM_SRC.slice(handoffAt, successAt);
  assert.doesNotMatch(between, /\btrack\(/, 'no analytics call may sit inside the hand-off');
  assert.doesNotMatch(between, /\bawait\b/, 'nothing may be awaited inside the hand-off');
});
