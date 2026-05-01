/**
 * Tailwind v4 token regression coverage for the checkout page.
 *
 * Background:
 *   The repo runs Tailwind v4 (`@import 'tailwindcss'` + `@theme inline`
 *   in src/app/globals.css). The legacy `tailwind.config.js` is NOT
 *   wired in via `@config`, so any token defined only there (e.g.
 *   `coral`, `coral-dark`, `purple`, `teal`, `teal-dark`) silently
 *   produces NO style — selected states render visually blank.
 *
 *   This test scans the checkout page for every custom-token utility
 *   class (`{prefix}-{token}` and `{prefix}-{token}/{opacity}`) and
 *   asserts that the matching `--color-{token}` exists in globals.css.
 *   Adding a token-classed element to checkout without its theme
 *   definition will fail this test before the regression hits prod.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const globalsCss = readFileSync(join(repoRoot, 'src/app/globals.css'), 'utf8');
const checkoutPage = readFileSync(join(repoRoot, 'src/app/checkout/page.tsx'), 'utf8');

// HSB-custom token names that have been used somewhere in this repo.
// We only check that any of these THAT APPEAR in the checkout page are
// defined in globals.css. Tailwind built-ins (gray, red, blue, etc.)
// are excluded — those ship with Tailwind by default.
const HSB_CUSTOM_TOKENS = [
  'navy',
  'forest',
  'gold',
  'deep-gold',
  'peach',
  'cream',
  'lavender',
  'purple',
  'coral',
  'coral-dark',
];

const TOKEN_PREFIXES = [
  'bg', 'text', 'border', 'from', 'to', 'via', 'ring', 'outline',
  'fill', 'stroke', 'shadow', 'placeholder', 'caret', 'accent',
  'decoration', 'divide',
];

function tokensUsedIn(source: string): Set<string> {
  const used = new Set<string>();
  for (const token of HSB_CUSTOM_TOKENS) {
    for (const prefix of TOKEN_PREFIXES) {
      // Match `prefix-token` followed by either a non-class char or `/N`.
      const re = new RegExp(`\\b${prefix}-${escapeRe(token)}(?:\\/\\d+)?(?=\\b|[^a-zA-Z0-9-])`);
      if (re.test(source)) {
        used.add(token);
        break;
      }
    }
  }
  return used;
}

function escapeRe(s: string): string {
  return s.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&');
}

function tokenIsDefinedInTheme(token: string, css: string): boolean {
  // Either `--color-{token}: ...` or `--color-{token}: var(--{alias});`
  const re = new RegExp(`--color-${escapeRe(token)}\\s*:`);
  return re.test(css);
}

// ── Original explicit assertion (kept for clarity) ────────────────────────────

test('globals.css defines the deep-gold token used by checkout selected states and CTA buttons', () => {
  assert.match(checkoutPage, /bg-deep-gold/);
  assert.match(checkoutPage, /border-deep-gold/);
  assert.match(globalsCss, /--color-deep-gold:\s*var\(--gold\);/);
});

// ── Generalized regression coverage ──────────────────────────────────────────

test('every custom token used by the checkout page has a --color-* definition in globals.css', () => {
  const used = tokensUsedIn(checkoutPage);
  // Sanity: the page should be using at least one custom token.
  assert.ok(used.size > 0, 'checkout page must reference at least one HSB custom token');
  const missing: string[] = [];
  for (const token of used) {
    if (!tokenIsDefinedInTheme(token, globalsCss)) missing.push(token);
  }
  assert.deepEqual(missing, [], `Tokens used by checkout but missing from globals.css @theme: ${missing.join(', ')}`);
});

// ── Specific selected-state classes called out in the design audit ───────────

test('checkout selected states + CTA + chips use only theme-backed tokens', () => {
  // Each of these patterns covers a surface the audit flagged as
  // visually regressing when the token alias was missing.
  const surfaces = [
    /\bbg-deep-gold\b/,                  // CTA button + selected progress circle
    /\bborder-deep-gold\b/,              // selected card/chip border
    /\bbg-deep-gold\/\d+\b/,             // tinted selected backgrounds
    /\bring-deep-gold(?:\/\d+)?\b/,      // focus rings on selected chips
    /\btext-deep-gold\b/,                // chip / link accents
    /\bbg-cream\b/,                      // page background
    /\btext-forest\b/,                   // headline text
  ];
  for (const re of surfaces) {
    assert.match(checkoutPage, re, `checkout page should use ${re}`);
  }
  // And every base token in those classes must be theme-backed.
  for (const token of ['deep-gold', 'cream', 'forest', 'lavender'] as const) {
    assert.ok(
      tokenIsDefinedInTheme(token, globalsCss),
      `--color-${token} must be defined in globals.css @theme inline`,
    );
  }
});
