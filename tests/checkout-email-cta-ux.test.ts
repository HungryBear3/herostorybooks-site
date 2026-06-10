/**
 * Checkout email + CTA UX hardening (fix/hsb-checkout-email-cta-ux).
 *
 * Source assertions against the checkout form for the two Rex findings:
 *   1. The primary pay CTA must NOT load as a washed-out opacity-50 button with
 *      no explanation; it must use a legible disabled style + an explained,
 *      accessible reason.
 *   2. Email must unlock checkout only when it is a valid format (not any
 *      non-empty string), because proof-before-print depends on a deliverable
 *      email.
 * Preserves: proof-before-print story, privacy reassurance, keepsake palette.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

// ── Finding 2: email format gates the CTA ────────────────────────────────────

test('pay CTA gate uses email FORMAT validation, not just non-empty', () => {
  // The readiness gate must validate format via looksLikeEmail, and must NOT
  // fall back to the old Boolean(form.email) non-empty check.
  assert.match(SRC, /const isReadyToPay\s*=/);
  assert.match(SRC, /emailLooksValid/);
  assert.match(SRC, /const emailLooksValid = looksLikeEmail\(form\.email\)/);
  assert.doesNotMatch(
    SRC,
    /isReadyToPay[\s\S]{0,260}Boolean\(form\.email\)/,
    'readiness gate must not use Boolean(form.email) (non-empty only)',
  );
});

test('a malformed email shows an inline, accessible format error', () => {
  assert.match(SRC, /id="email-error"/);
  assert.match(SRC, /aria-invalid=/);
  assert.match(SRC, /aria-describedby=\{[\s\S]{0,80}email-error/);
  assert.match(SRC, /Enter a valid email address/i);
});

// ── Finding 1: disabled CTA is legible + explained ───────────────────────────

test('disabled pay button no longer uses the washed-out opacity-50 style', () => {
  assert.doesNotMatch(SRC, /disabled:opacity-50/, 'opacity-50 disabled CTA reads as broken/low-contrast');
  // Legible muted disabled palette instead.
  assert.match(SRC, /disabled:bg-\[#e3d7bf\]/);
  assert.match(SRC, /disabled:text-\[#5c5145\]/);
});

test('disabled CTA is explained and wired for assistive tech', () => {
  assert.match(SRC, /aria-disabled=/);
  assert.match(SRC, /aria-describedby=\{[\s\S]{0,80}cta-reason/);
  assert.match(SRC, /id="cta-reason"/);
  assert.match(SRC, /Finish these before continuing:/);
  // The reason list must call out a malformed email distinctly from a missing one.
  assert.match(SRC, /a valid email address/);
});

// ── Preserved guarantees (must not be removed by this change) ─────────────────

test('proof-before-print story, privacy reassurance, and keepsake palette preserved', () => {
  assert.match(SRC, /PRINT_PREVIEW_PROMISE/);
  assert.match(SRC, /Nothing prints until/i);
  assert.match(SRC, /Your data\s*\n?\s*is never shared/i);
  assert.match(SRC, /Proof approval before printing/i);
  // Keepsake visual system: warm gold CTA + cream/serif system still present.
  assert.match(SRC, /bg-deep-gold/);
  assert.match(SRC, /font-serif/);
});
