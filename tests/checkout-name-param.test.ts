import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const checkoutFormSource = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
const namePreviewSource = readFileSync('src/components/name-preview.tsx', 'utf8');
const layoutSource = readFileSync('src/app/layout.tsx', 'utf8');
const analyticsSource = readFileSync('src/lib/analytics.ts', 'utf8');

test('checkout still supports legacy childName query param for old internal links', () => {
  assert.match(checkoutFormSource, /params\.get\(['"]childName['"]\)/);
  assert.match(checkoutFormSource, /sanitizeChildNameParam/);
  assert.match(checkoutFormSource, /childNameFromUrl/);
  assert.match(checkoutFormSource, /childNamePrefill/);
});

test('homepage pricing does not advertise stale $24 digital footnote', () => {
  const homepageSources = [
    readFileSync('src/app/page.tsx', 'utf8'),
    readFileSync('src/components/pricing-section.tsx', 'utf8'),
    readFileSync('src/components/landing/Pricing.tsx', 'utf8'),
  ].join('\n');

  assert.doesNotMatch(homepageSources, /Available from \$24 on the pricing page/);
  assert.doesNotMatch(homepageSources, /Prefer a digital copy\?\s*Available from \$24/);
});

test('NamePreview CTA links to checkout with dinosaur direction and no child name query', () => {
  // The visible prehistoric/dinosaur story tease is safe to carry in the URL.
  // A typed child name must not be placed in the query string because preview
  // URLs can be logged by hosts and analytics tools.
  assert.match(namePreviewSource, /NAME_PREVIEW_DIRECTION\s*=\s*["']dinosaur["']/);
  assert.match(namePreviewSource, /new URLSearchParams\(\{ direction: NAME_PREVIEW_DIRECTION \}\)/);
  assert.match(namePreviewSource, /const checkoutHref = `\/checkout\?\$\{checkoutParams\.toString\(\)\}`/);
  assert.doesNotMatch(namePreviewSource, /checkoutParams\.set\(["']childName["']/);
  assert.match(namePreviewSource, /sessionStorage\.setItem/);
  assert.match(checkoutFormSource, /readNamePreviewHandoff/);
});

test('checkout parses ?direction= and maps it to a launch story-theme id', () => {
  // The map exists.
  assert.match(checkoutFormSource, /DIRECTION_TO_THEME[\s\S]*?dinosaur['"]?\s*:\s*['"]dinosaur-discovery['"]/);
  // The direction is read from URL and gated through the map helper.
  assert.match(checkoutFormSource, /themeIdFromDirection\(directionFromUrl\)/);
  // The resolved theme is applied to the form state.
  assert.match(checkoutFormSource, /themeFromDirection \? \{ theme: themeFromDirection \}/);
});

test('NamePreview + checkout fire shared analytics events', () => {
  // NamePreview CTA pushes a name_preview_submitted event.
  assert.match(namePreviewSource, /track\(["']name_preview_submitted["']/);
  // Checkout fires start_checkout, format_selected, story_selected, and
  // the order_submit_attempt + purchase_intent pair on submit.
  assert.match(checkoutFormSource, /track\(["']start_checkout["']/);
  assert.match(checkoutFormSource, /track\(["']format_selected["']/);
  assert.match(checkoutFormSource, /track\(["']story_selected["']/);
  assert.match(checkoutFormSource, /track\(["']order_submit_attempt["']/);
  assert.match(checkoutFormSource, /track\(["']purchase_intent["']/);
});

test('HSB mounts Vercel Analytics and forwards campaign params without full href', () => {
  assert.match(layoutSource, /from ['"]@vercel\/analytics\/next['"]/);
  assert.match(layoutSource, /<Analytics \/>/);
  assert.match(analyticsSource, /utm_source/);
  assert.match(analyticsSource, /utm_campaign/);
  assert.match(analyticsSource, /window\.va\(['"]track['"], event, vercelSafeProps\(record\)\)/);
  assert.match(analyticsSource, /href: _href/);
});
