/**
 * Remediation coverage for PR #117 Cowork CHANGES REQUIRED findings:
 *  1. Gift index + detail routes use the shared EditorialPageShell chrome
 *     (one shared header/footer, not a second implementation) and /gifts has a
 *     clear primary "Start a custom story" CTA.
 *  2. Sitemap <loc> values use the exported production-origin constant, never the
 *     preview-aware getSiteOrigin().
 *  3. Customer-visible internal engineering phrases are gone from checkout.
 *  4. Checkout + gift proof timing matches the homepage ("within 2 business
 *     days"); "2–3 business days" is absent from those touched public surfaces.
 *  5. The existing server-side non-child primary-hero gate is preserved.
 *
 * Source-text regression style (matches the repo's node:test convention).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const giftIndex = read('src/app/gifts/page.tsx');
const giftDetail = read('src/app/gifts/[occasion]/page.tsx');
const checkoutForm = read('src/app/checkout/checkout-form.tsx');
const sitemap = read('src/app/sitemap.ts');
const siteUrl = read('src/lib/site-url.ts');
const orderRoute = read('src/app/api/order/route.ts');

// ── 1. Shared editorial chrome on gift routes ────────────────────────────────
test('gift index and detail routes render the shared EditorialPageShell chrome', () => {
  for (const [label, source] of [['index', giftIndex], ['detail', giftDetail]] as const) {
    assert.match(source, /import\s*\{[^}]*\bEditorialPageShell\b[^}]*\}\s*from\s*['"]@\/components\/editorial-site['"]/, `${label} must import EditorialPageShell from the shared editorial site`);
    assert.match(source, /<EditorialPageShell[\s>]/, `${label} must render EditorialPageShell`);
  }
});

test('gift routes do not ship a second header/footer implementation', () => {
  for (const [label, source] of [['index', giftIndex], ['detail', giftDetail]] as const) {
    assert.doesNotMatch(source, /<header[\s>]/i, `${label} must not define its own <header>`);
    assert.doesNotMatch(source, /<footer[\s>]/i, `${label} must not define its own <footer>`);
    // No nested <main>: EditorialPageShell already provides the page <main>.
    assert.doesNotMatch(source, /<main[\s>]/i, `${label} must not nest its own <main> inside the shell`);
  }
});

test('gift routes preserve their titles, canonicals, cards, and occasion handoff', () => {
  assert.match(giftIndex, /alternates:\s*\{\s*canonical:\s*['"]\/gifts['"]/s);
  assert.match(giftIndex, /Personalized Storybook Gift Ideas \| HeroStoryBooks/);
  assert.match(giftIndex, /GIFT_OCCASIONS\.map/);
  assert.match(giftDetail, /alternates:\s*\{\s*canonical:\s*`\/gifts\/\$\{occasion\.id\}`/s);
  assert.match(giftDetail, /\| HeroStoryBooks/);
  assert.match(giftDetail, /giftCheckoutHref\(occasion\)/);
});

// ── 1b. Primary CTA on /gifts ─────────────────────────────────────────────────
test('/gifts has a clear primary "Start a custom story" CTA into checkout', () => {
  assert.match(giftIndex, /Start a custom story/);
  assert.match(giftIndex, /href=["']\/checkout/);
});

// ── 2. Sitemap uses the exported production origin, not getSiteOrigin ──────────
test('site-url exports a reusable production-origin constant', () => {
  assert.match(siteUrl, /export const PRODUCTION_ORIGIN\s*=\s*['"]https:\/\/herostorybooks\.com['"]/);
});

test('sitemap loc values always use the production origin, never getSiteOrigin', () => {
  assert.match(sitemap, /PRODUCTION_ORIGIN/, 'sitemap must use the shared production-origin constant');
  // getSiteOrigin must not be imported or called for <loc> values (a clarifying
  // comment naming it is fine; using it is not).
  assert.doesNotMatch(sitemap, /import\s*\{[^}]*\bgetSiteOrigin\b/, 'sitemap must not import getSiteOrigin');
  assert.doesNotMatch(sitemap, /getSiteOrigin\s*\(/, 'sitemap must not call getSiteOrigin');
  // The origin variable feeding every url template must resolve to the constant.
  assert.match(sitemap, /const origin = PRODUCTION_ORIGIN/);
  assert.doesNotMatch(sitemap, /VERCEL_URL|VERCEL_ENV/, 'sitemap host must not be preview-aware');
});

// ── 3. Internal engineering language removed from checkout ────────────────────
test('checkout removes internal engineering phrases from customer-visible copy', () => {
  for (const banned of ['Current live-safe path', 'Private beta after QA gate', 'generator/legal approval', 'Preview hold']) {
    assert.doesNotMatch(checkoutForm, new RegExp(banned.replace(/[/]/g, '\\/')), `banned phrase must be gone: ${banned}`);
  }
});

test('checkout uses calm customer language for hero availability', () => {
  assert.match(checkoutForm, /Available now/);
  assert.match(checkoutForm, /Available by review only/);
  assert.match(checkoutForm, /available by review only/i);
  assert.match(checkoutForm, /confirm the recipient details and reference photo before production/i);
});

// ── 4. Turnaround consistency on touched public surfaces ──────────────────────
test('touched checkout + gift surfaces drop "2–3 business days"', () => {
  assert.doesNotMatch(checkoutForm, /2–3 business days/, 'checkout must not say 2–3 business days');
  assert.doesNotMatch(giftDetail, /2–3 business days/, 'gift detail must not say 2–3 business days');
  assert.doesNotMatch(giftIndex, /2–3 business days/, 'gift index must not say 2–3 business days');
});

test('touched checkout + gift surfaces use the approved "within 2 business days" wording', () => {
  assert.match(checkoutForm, /usually ready within 2 business days/i);
  assert.match(checkoutForm, /within 2 business days after we have the needed photos/i);
  assert.match(giftDetail, /usually ready within 2 business days/i);
});

test('turnaround change adds no guaranteed/instant/same-day/holiday-delivery promise', () => {
  // Gift surfaces (fully in scope) carry no delivery promise at all.
  const giftSurfaces = [giftIndex, giftDetail].join('\n');
  assert.doesNotMatch(giftSurfaces, /same-day|instant delivery|guaranteed delivery|guaranteed to arrive|holiday delivery/i);
  // Checkout must not introduce guaranteed/instant delivery promises. (A
  // pre-existing, carrier-qualified "digital arrives same-day after proof
  // approval" note is factual and out of scope for the proof-timing change.)
  assert.doesNotMatch(checkoutForm, /instant delivery|guaranteed delivery|guaranteed to arrive|holiday delivery guarantee/i);
  // Carrier/ship timing stays qualified, not promised.
  assert.match(checkoutForm, /5–7 business days after approval/);
});

// ── 5. Server-side non-child gate preserved (not weakened by copy changes) ────
test('server-side non-child primary-hero gate remains intact', () => {
  assert.match(orderRoute, /PRIMARY_HERO_TYPES = new Set\(\['child', 'parent', 'grandparent'\]\)/);
  assert.match(orderRoute, /if \(heroType !== 'child'\)/);
  assert.match(orderRoute, /PRIMARY_HERO_BETA_ENABLED/);
  assert.match(orderRoute, /primary_hero_beta_required/);
  assert.match(orderRoute, /primary_hero_recipient_context_required/);
  // The client still only gates the selector behind the beta flag.
  assert.match(checkoutForm, /NEXT_PUBLIC_HSB_PRIMARY_HERO_BETA === ["']true["']/);
});
