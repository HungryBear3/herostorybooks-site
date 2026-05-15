import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const checkoutFormSource = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
const namePreviewSource = readFileSync('src/components/name-preview.tsx', 'utf8');

test('checkout reads childName query param for NamePreview handoff', () => {
  assert.match(checkoutFormSource, /params\.get\(['"]childName['"]\)/);
  assert.match(checkoutFormSource, /sanitizeChildNameParam/);
  assert.match(checkoutFormSource, /childNameFromUrl \? \{ childName: childNameFromUrl \}/);
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

test('NamePreview CTA links to /checkout with encoded childName when a name was typed', () => {
  // Carries the typed name as a URL-encoded query param so checkout can
  // prefill the Child's Name input via the params.get('childName') path above.
  assert.match(
    namePreviewSource,
    /\/checkout\?childName=\$\{encodeURIComponent\(trimmedName\)\}/,
  );
  // Empty/whitespace-only input goes to bare /checkout — we don't want to
  // overwrite saved progress with the placeholder DEFAULT_NAME ("Lukas").
  assert.match(namePreviewSource, /trimmedName\s*\n?\s*\?\s*`\/checkout\?childName/);
  assert.match(namePreviewSource, /:\s*["']\/checkout["']/);
});
