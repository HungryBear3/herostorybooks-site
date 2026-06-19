import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const mockupFiles = [
  {
    path: 'public/design-mockups/hsb-evergreen-homepage-standalone.html',
    title: 'HeroStoryBooks — Evergreen homepage · mockup',
    routePath: '/design-mockups/hsb-evergreen-homepage-standalone.html',
  },
  {
    path: 'public/design-mockups/hsb-fathers-day-landing-standalone-v2.html',
    title: "HeroStoryBooks — Father's Day digital · landing mockup v2",
    routePath: '/design-mockups/hsb-fathers-day-landing-standalone-v2.html',
  },
];

test('imported HSB standalone mockup artifacts are present', async () => {
  for (const mockup of mockupFiles) {
    const html = await readFile(mockup.path, 'utf8');

    assert.match(html, /<script type="__bundler\/manifest">/);
    assert.match(html, /<script type="__bundler\/template">/);
    assert.ok(html.includes(mockup.title));
  }
});

test('HSB mockup preview route embeds each imported artifact', async () => {
  const route = await readFile('src/app/design-previews/hsb-mockups/page.tsx', 'utf8');

  assert.match(route, /index: false/);
  assert.match(route, /checkout, fulfillment, image generation/);
  for (const mockup of mockupFiles) {
    assert.ok(route.includes(mockup.routePath));
  }
});
