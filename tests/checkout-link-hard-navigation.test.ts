import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const editorialSource = readFileSync('src/components/editorial-site.tsx', 'utf8');
const namePreviewSource = readFileSync('src/components/name-preview.tsx', 'utf8');

test('homepage start-book checkout CTAs use hard anchors instead of Next client transitions', () => {
  assert.doesNotMatch(
    editorialSource,
    /<Link[^>]+href=\{?['"]\/checkout/,
    'homepage /checkout CTAs should hard-navigate so mobile/in-app browsers cannot stall on a Next client transition',
  );
  assert.doesNotMatch(
    namePreviewSource,
    /<Link[^>]+href=\{checkoutHref\}/,
    'name preview checkout CTA should hard-navigate after saving sessionStorage handoff',
  );

  assert.match(editorialSource, /<a[\s\S]*href=\{href\}/, 'PrimaryCta should render a plain anchor');
  assert.match(namePreviewSource, /<a[\s\S]*href=\{checkoutHref\}/, 'name preview CTA should render a plain anchor');
});
