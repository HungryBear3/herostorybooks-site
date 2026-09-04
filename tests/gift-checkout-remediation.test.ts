/**
 * Remediation coverage for PR #117 Cowork CHANGES REQUIRED findings:
 *  1. Gift index + detail routes use the shared EditorialPageShell chrome
 *     (one shared header/footer, not a second implementation) and /gifts has a
 *     clear primary "Start a custom story" CTA.
 *  2. Sitemap <loc> values use the exported production-origin constant, never the
 *     preview-aware getSiteOrigin().
 *  3. Customer-visible internal engineering phrases are gone from checkout.
 *  4. Checkout + gift proof timing carries no tightened 2-day promise and
 *     sources the shared authoritative window (see turnaround-consistency.test).
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

// ── 4. Turnaround consistency — Alexy authoritative "2–3 business days" ───────
// Full turnaround policy coverage lives in tests/turnaround-consistency.test.ts.
// Here we only lock that the touched gift/checkout surfaces carry no tightened
// 2-day proof promise and source the shared window constant.
test('touched checkout + gift surfaces carry no tightened 2-day proof promise', () => {
  for (const [label, src] of [['checkout', checkoutForm], ['gift detail', giftDetail], ['gift index', giftIndex]] as const) {
    assert.doesNotMatch(src, /(within|in)\s+2 business days/i, `${label} must not promise a 2-day proof window`);
  }
});

test('touched checkout + gift surfaces source the shared proof-turnaround window', () => {
  assert.match(checkoutForm, /PROOF_TURNAROUND_WINDOW/);
  assert.match(giftDetail, /PROOF_TURNAROUND_WINDOW/);
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
  assert.match(orderRoute, /PRIMARY_HERO_TYPES = new Set\(\['child', 'parent', 'grandparent', 'other'\]\)/);
  assert.match(orderRoute, /if \(heroType !== 'child'\)/);
  assert.match(orderRoute, /PRIMARY_HERO_BETA_ENABLED/);
  assert.match(orderRoute, /primary_hero_beta_required/);
  assert.match(orderRoute, /primary_hero_recipient_context_required/);
  // The client still only gates the selector behind the beta flag.
  assert.match(checkoutForm, /NEXT_PUBLIC_HSB_PRIMARY_HERO_BETA === ["']true["']/);
});

// ── 6. Gift detail pages are text/CTA-led — no occasion illustration ──────────
// CD found no complete, privacy-safe occasion-art set (private-name crop risk on
// pets/holidays, no safe birthday/grandparents/siblings/hero asset), so the
// repeated APPROVED_SAMPLE illustration is removed. No replacement image is added.
test('gift-detail template renders no APPROVED_SAMPLE and no occasion illustration', () => {
  assert.doesNotMatch(giftDetail, /APPROVED_SAMPLE/, 'gift detail must not reference APPROVED_SAMPLE');
  assert.doesNotMatch(giftDetail, /<img[\s>]/i, 'gift detail must not render an <img>');
  assert.doesNotMatch(giftDetail, /<figure[\s>]/i, 'gift detail must not render an illustration <figure>');
});

test('no gift page references a caution / private-name / occasion image asset', () => {
  for (const [label, source] of [['index', giftIndex], ['detail', giftDetail]] as const) {
    assert.doesNotMatch(source, /\/assets\//, `${label} must not reference any /assets/ image`);
    assert.doesNotMatch(source, /<img[\s>]/i, `${label} must not render an <img>`);
  }
});

test('gift detail stays complete: headline, story directions, checkout CTA, shared chrome, proof-first steps', () => {
  // Shared chrome
  assert.match(giftDetail, /<EditorialPageShell[\s>]/);
  // Headline (occasion title)
  assert.match(giftDetail, /<h1[^>]*>\{occasion\.title\}<\/h1>/);
  // Story directions
  assert.match(giftDetail, /Story directions/);
  assert.match(giftDetail, /occasion\.storyIdeas\.map/);
  // Checkout CTA / occasion handoff
  assert.match(giftDetail, /giftCheckoutHref\(occasion\)/);
  assert.match(giftDetail, /Start a custom story/);
  // Proof-first steps preserved
  assert.match(giftDetail, /What happens next/);
  assert.match(giftDetail, /Review the private proof/);
  assert.match(giftDetail, /Approve before fulfillment/);
  // Proof-timing sourced from the shared authoritative window (2–3 business days).
  assert.match(giftDetail, /usually ready in \{PROOF_TURNAROUND_WINDOW\}/);
});
