import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const editorial = read('src/components/editorial-site.tsx');
const samples = editorial.slice(editorial.indexOf('export function EditorialSamplesPage()'));
const hero = editorial.slice(editorial.indexOf('function HeroSection()'), editorial.indexOf('function BookCoverStack()'));
const gifts = read('src/app/gifts/page.tsx');
const giftDetail = read('src/app/gifts/[occasion]/page.tsx');

test('samples has one visible descriptive H1 and preserves existing sample section headings', () => {
  const headings = [...samples.matchAll(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/g)];
  assert.equal(headings.length, 1, 'the samples route needs exactly one H1');
  assert.equal(headings[0][2].trim(), 'Sample personalized story books');
  assert.doesNotMatch(headings[0][1], /sr-only|\bhidden\b/);
  for (const title of ['A closer look inside personalized adventures.', 'A dinosaur book example.']) {
    assert.ok(samples.includes(`title="${title}"`), `${title} remains a section heading`);
  }
});

test('gifts uses the descriptive H1 without losing evocative subheading or proof-first safeguards', () => {
  assert.equal(gifts.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1].trim(),
    'Personalized storybook gifts starring the child you love');
  assert.match(gifts, /Start with the person and the moment\. We&apos;ll help shape the story\./);
  assert.match(gifts, /title: 'Personalized Storybook Gift Ideas \| HeroStoryBooks'/);
  assert.match(gifts, /Every HeroStoryBook starts as a private digital proof/);
  assert.match(gifts, /physical books do not enter print until the proof is approved/);
  assert.match(gifts, /Start a custom story/);
});

test('each occasion uses its descriptive title as link text rather than repeated generic text', () => {
  assert.doesNotMatch(gifts, /Explore this gift/);
  assert.match(gifts, /<Link href=\{`\/gifts\/\$\{occasion\.id\}`\}[^>]*>\s*\{occasion\.title\}\s*<\/Link>/);
});

test('homepage and samples have contextual gift-hub body links, not only a shared footer link', () => {
  for (const [name, body] of [['homepage', hero], ['samples', samples]]) {
    assert.match(body, /<Link href="\/gifts"[^>]*>personalized storybook gift ideas<\/Link>/, `${name} contextual gift link`);
  }
});

test('gift detail pages link back to the hub inside their content', () => {
  assert.match(giftDetail, /<section[^>]*>\s*<Link href="\/gifts"[^>]*>All personalized storybook gift ideas<\/Link>/);
});

test('bounded editorial pricing links point directly to the existing homepage anchor, preserving legacy redirect', () => {
  assert.doesNotMatch(editorial, /['"]\/pricing['"]/);
  assert.match(editorial, /<section id="pricing"/);
  assert.match(read('src/app/page.tsx'), /EditorialHomePage/);
  assert.match(read('src/app/pricing/page.tsx'), /redirect\('\/#pricing'\)/);
});
