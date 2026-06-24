import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const editorialSiteSource = readFileSync(
  join(process.cwd(), 'src/components/editorial-site.tsx'),
  'utf8',
);
const samplesPageSource = readFileSync(
  join(process.cwd(), 'src/app/samples/page.tsx'),
  'utf8',
);

test('website sample lane uses two digital proof samples with illustrative framing', () => {
  assert.match(editorialSiteSource, /Lukas \/ Kind Dragon v5/);
  assert.match(editorialSiteSource, /Lukas \/ Year of Lights/);
  assert.match(editorialSiteSource, /Approved website sample/);
  assert.match(editorialSiteSource, /New digital proof sample/);
  assert.match(editorialSiteSource, /Digital sample - illustrative only/);
  assert.match(editorialSiteSource, /Each paid book still gets its own proof and approval pass/);

  for (const asset of [
    '/assets/kind-dragon-v5/cover.jpg',
    '/assets/kind-dragon-v5/01-scale-in-the-creek.jpg',
    '/assets/kind-dragon-v5/04-first-clue.jpg',
    '/assets/kind-dragon-v5/13-big-dragon-problem.jpg',
    '/assets/kind-dragon-v5/19-dragon-lantern.jpg',
    '/assets/kind-dragon-v5/23-bravest-magic.jpg',
    '/assets/kind-dragon-v5/contact-sheet.jpg',
    '/assets/year-of-lights/cover.jpg',
    '/assets/year-of-lights/01-first-light.jpg',
    '/assets/year-of-lights/05-rainy-day-parade.jpg',
    '/assets/year-of-lights/07-summer-lanterns.jpg',
    '/assets/year-of-lights/16-brody-big-jingle.jpg',
    '/assets/year-of-lights/21-lukas-chooses-thread.jpg',
    '/assets/year-of-lights/24-year-remembers.jpg',
    '/assets/year-of-lights/contact-sheet.jpg',
  ]) {
    assert.match(editorialSiteSource, new RegExp(asset.replace(/[/.]/g, '\\$&')));
  }
});

test('website sample lane includes recent hardcover photos as supporting evidence', () => {
  assert.match(editorialSiteSource, /Recent printed hardcover sample/);
  assert.match(editorialSiteSource, /Real book photos - illustrative only/);
  assert.match(editorialSiteSource, /not a guarantee that every book will look identical/);

  for (const asset of [
    '/assets/hsb-lukas-dino-photo-cover.jpg',
    '/assets/hsb-lukas-dino-photo-feast.jpg',
    '/assets/hsb-lukas-dino-photo-hands-1.jpg',
    '/assets/hsb-lukas-dino-photo-parade.jpg',
  ]) {
    assert.match(editorialSiteSource, new RegExp(asset.replace(/[/.]/g, '\\$&')));
  }
});

test('samples metadata frames the page as multiple digital samples', () => {
  assert.match(samplesPageSource, /HeroStoryBooks digital sample story proofs/);
  assert.match(samplesPageSource, /\/assets\/kind-dragon-v5\/cover\.jpg/);
  assert.equal(samplesPageSource.includes('/assets/hsb-lukas-print-story-21.jpg'), false);
});

test('digital sample copy stays away from forbidden launch claims', () => {
  const digitalSampleBlock = editorialSiteSource.slice(
    editorialSiteSource.indexOf('const kindDragonSample'),
    editorialSiteSource.indexOf('const faqs'),
  );

  for (const forbidden of [
    /ERIC50/i,
    /same-day delivery/i,
    /guaranteed arrival/i,
    /ready to print/i,
    /final customer proof/i,
    /Gingerbread/i,
    /Candy Monster/i,
  ]) {
    assert.equal(forbidden.test(digitalSampleBlock), false, `forbidden claim appeared: ${forbidden}`);
  }
});
