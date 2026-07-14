import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const checkoutFormSource = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

test('Custom Story is the primary story direction and templates are secondary', () => {
  const customIndex = checkoutFormSource.indexOf('Fully custom');
  const templatesIndex = checkoutFormSource.indexOf('Or pick a ready adventure template');
  assert.ok(customIndex > -1, 'custom primary badge should render');
  assert.ok(templatesIndex > -1, 'template group label should render');
  assert.ok(customIndex < templatesIndex, 'Custom Story should appear before templates');
  assert.match(checkoutFormSource, /templateThemes = THEMES\.filter\(\(theme\) => theme\.id !== CUSTOM_STORY_THEME_ID\)/);
});

test('required main photo intake uses simple audio-style choice cards', () => {
  assert.match(checkoutFormSource, /Add one clear photo for the main character/);
  assert.match(checkoutFormSource, /1 main character photo needed/);
  assert.match(checkoutFormSource, /Main character photo added/);
  assert.match(checkoutFormSource, /Choose an existing photo from your phone\./);
  assert.match(checkoutFormSource, /Open your camera for a still photo\./);
  assert.doesNotMatch(checkoutFormSource, /Drag &amp; drop · JPG\/PNG\/WebP\/HEIC/);
});

test('optional guided photos stay collapsed behind a likeness link', () => {
  const linkIndex = checkoutFormSource.indexOf('Want an even better likeness? Take guided photos');
  const panelIndex = checkoutFormSource.indexOf('showGuidedPhotos && (');
  const componentIndex = checkoutFormSource.indexOf('<GuidedPhotoCapture');
  assert.ok(linkIndex > -1, 'optional guided photo link should render');
  assert.ok(panelIndex > -1, 'guided photo panel should be gated by showGuidedPhotos');
  assert.ok(componentIndex > panelIndex, 'GuidedPhotoCapture should mount only inside the expanded panel');
  assert.match(checkoutFormSource, /aria-expanded=\{showGuidedPhotos\}/);
});
