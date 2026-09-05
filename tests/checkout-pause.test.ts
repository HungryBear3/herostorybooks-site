import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CHECKOUT_PAUSED_CODE,
  CHECKOUT_PAUSED_MESSAGE,
  isCheckoutPaused,
} from '../src/lib/checkout-pause.ts';

test('isCheckoutPaused only enables for true, allowing Vercel env whitespace/case', () => {
  assert.equal(isCheckoutPaused('true'), true);
  assert.equal(isCheckoutPaused(' TRUE '), true);
  assert.equal(isCheckoutPaused('false'), false);
  assert.equal(isCheckoutPaused(''), false);
  assert.equal(isCheckoutPaused(undefined), false);
});

test('checkout page gates the active form behind the pause flag', () => {
  const src = readFileSync('src/app/checkout/page.tsx', 'utf8');
  assert.match(src, /isCheckoutPaused\(\)/);
  assert.match(src, /<CheckoutPaused \/>/);
  assert.match(src, /return <CheckoutForm storyMediaEnabled=\{isCheckoutStoryMediaEnabled\(\)\} \/>/);
  assert.match(src, /No orders or payments can be started while checkout is paused/);
  assert.match(src, /export const dynamic = 'force-dynamic'/, 'checkout must read pause flag at request time, not static build time');
});

test('order route checks pause before parsing form data or creating Stripe checkout', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  const pauseIdx = src.indexOf('if (isCheckoutPaused())');
  const formIdx = src.indexOf('await request.formData()');
  // Session creation moved into the shared provisioner; the handler's provider
  // boundary is the first orchestration entry point it can reach.
  const directEntryIdx = src.indexOf('await runDirectIntakeCheckout({');
  const legacyEntryIdx = src.indexOf('await provisionCheckoutSession({');
  const stripeIdx = Math.min(directEntryIdx, legacyEntryIdx);

  assert.ok(pauseIdx > -1, 'route must check checkout pause flag');
  assert.ok(formIdx > -1, 'route must parse form data after pause check');
  assert.ok(directEntryIdx > -1 && legacyEntryIdx > -1, 'route must still reach both provider paths');
  assert.ok(pauseIdx < formIdx, 'pause response must happen before form validation/parsing');
  assert.ok(pauseIdx < stripeIdx, 'pause response must happen before Stripe checkout');
  assert.match(src, /CHECKOUT_PAUSED_MESSAGE/);
  assert.match(src, /CHECKOUT_PAUSED_CODE/);
  assert.equal(CHECKOUT_PAUSED_CODE, 'checkout_paused');
  assert.match(CHECKOUT_PAUSED_MESSAGE, /Checkout is temporarily paused/);
});


test('order route fails closed for non-child primary heroes unless beta gate is enabled', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  const gateIdx = src.indexOf("if (heroType !== 'child')");
  // Must precede BOTH provider paths, not just the old inline legacy create.
  const directEntryIdx = src.indexOf('await runDirectIntakeCheckout({');
  const legacyEntryIdx = src.indexOf('await provisionCheckoutSession({');
  const stripeIdx = Math.min(directEntryIdx, legacyEntryIdx);

  assert.ok(gateIdx > -1, 'route must explicitly gate non-child primary hero orders');
  assert.ok(directEntryIdx > -1 && legacyEntryIdx > -1, 'route must still create Stripe sessions after validation');
  assert.ok(gateIdx < stripeIdx, 'non-child hero gate must run before Stripe checkout creation');
  assert.match(src, /PRIMARY_HERO_BETA_ENABLED/);
  assert.match(src, /primary_hero_beta_required/);
  assert.match(src, /primary_hero_recipient_context_required/);
});

test('checkout hides primary-hero selector unless private beta flag is enabled', () => {
  const src = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  assert.match(src, /NEXT_PUBLIC_HSB_PRIMARY_HERO_BETA === ["']true["']/);
  assert.match(src, /PRIMARY_HERO_BETA_ENABLED && \(/);
  assert.match(src, /Primary hero type/);
  // Calm customer-facing review-only copy (Cowork finding #3) still surfaces the
  // non-child hold; internal engineering language ("Preview hold") is gone.
  assert.match(src, /available by review only/i);
  assert.match(src, /confirm the recipient details and reference photo before production/i);
  assert.doesNotMatch(src, /Preview hold/);
});


test('Custom Story upload intake is no longer gated behind a client flag', () => {
  const src = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  assert.doesNotMatch(src, /STORY_UPLOAD_ENABLED/);
  assert.doesNotMatch(src, /NEXT_PUBLIC_HSB_STORY_UPLOAD/);
  assert.match(src, /isCustomStorySelected && \([\s\S]*?data-testid="custom-story-intake-panel"/);
});

test('primary hero beta exposes friend or other family member as a fourth review-only hero type', () => {
  const formSrc = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  const routeSrc = readFileSync('src/app/api/order/route.ts', 'utf8');
  assert.match(formSrc, /id: "parent"/);
  assert.match(formSrc, /id: "grandparent"/);
  assert.match(formSrc, /id: "other", label: "Friend \/ other family member", helper: "Available by review only"/);
  assert.doesNotMatch(formSrc, /id: "pet"/);
  assert.doesNotMatch(formSrc, /id: "whole-family"/);
  assert.match(routeSrc, /PRIMARY_HERO_TYPES = new Set\(\['child', 'parent', 'grandparent', 'other'\]\)/);
});

test('supporting photo upload failures fail before Stripe for every error path', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  const supportIdx = src.indexOf('supporting photo persistence failed');
  // Supporting photos are a legacy-path concern; the direct branch has already
  // returned by here, so the boundary is the legacy provisioning entry.
  const stripeIdx = src.indexOf('await provisionCheckoutSession({');
  assert.ok(supportIdx > -1, 'route must have an explicit supporting-photo failure branch');
  assert.ok(stripeIdx > -1, 'route creates Stripe after validation/persistence');
  assert.ok(supportIdx < stripeIdx, 'supporting photo failure must happen before Stripe');
  assert.doesNotMatch(src, /supporting photo upload failed[\s\S]{0,160}continuing without that photo/);
  assert.match(src, /supporting_photo_persist_failed/);
});
