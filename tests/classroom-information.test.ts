/**
 * /classroom is a brief, information-only page: three story choices, a short
 * how-it-works, plain proposed privacy terms and the three approved Pasta
 * Planet samples. Intake is closed. These tests pin the content contract and
 * security posture rather than the exact bytes, so copy can be simplified
 * without loosening what the page may do.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { GET, dynamic } from '../src/app/classroom/route.ts';
import { CLASSROOM_HTML } from '../src/app/classroom/classroom-html.ts';

const CANONICAL_LINK = '<link rel="canonical" href="https://herostorybooks.com/classroom">';
const META_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; " +
  "img-src 'self'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

const ASSETS: Record<string, { hash: string; alt: string }> = {
  'pasta-planet-page-19-art-only.png': {
    hash: '64b64bc9ee5c7c82a4d00d7b8971c501c9e9a2d6112541189f8290f59e3271ba',
    alt: 'Illustration sample from Pasta Planet: a child exploring a colorful imagined planet landscape.',
  },
  'pasta-planet-page-20-art-only.png': {
    hash: '0b957e5a72713921c618b14c94104175d13d10a05a89a6da670374d750fa1221',
    alt: 'Illustration sample from Pasta Planet: a child in a playful outer-space scene.',
  },
  'pasta-planet-page-24-art-only.png': {
    hash: '525c73509cd9abd463f73c33b3d84c1a86e901f2779ed5895ee4ae4e2216d141',
    alt: 'Illustration sample from Pasta Planet: a bright storybook scene with a child and fantastical surroundings.',
  },
};

const BANNER = 'Classroom book preview · Family submissions aren’t open yet';
const STORY_TITLES = ['One big adventure', 'Our year in class', 'Little stories, one book'];
const INCLUSIVE =
  'Whichever story you choose, each child gets a meaningful part, and teachers can appear as familiar guides with their permission.';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const head = CLASSROOM_HTML.slice(0, CLASSROOM_HTML.indexOf('</head>'));
const style = CLASSROOM_HTML.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
const body = CLASSROOM_HTML.slice(CLASSROOM_HTML.indexOf('<body>'), CLASSROOM_HTML.indexOf('</body>'));
const visibleText = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

function section(id: string): string {
  const start = CLASSROOM_HTML.indexOf(`id="${id}"`);
  assert.ok(start > 0, `section #${id} exists`);
  return CLASSROOM_HTML.slice(start, CLASSROOM_HTML.indexOf('</section>', start));
}

test('canonical link, CSP meta and viewport are retained in <head>', () => {
  assert.equal(count(CLASSROOM_HTML, CANONICAL_LINK), 1, 'exactly one canonical link');
  assert.ok(head.includes(CANONICAL_LINK));
  assert.ok(head.includes(`<meta http-equiv="Content-Security-Policy" content="${META_CSP}">`));
  assert.ok(head.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
  assert.equal(count(CLASSROOM_HTML, 'http-equiv="Content-Security-Policy"'), 1);
});

test('GET serves static HTML with security headers', async () => {
  assert.equal(dynamic, 'force-static');
  const res = await GET();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('content-security-policy'), `${META_CSP}; frame-ancestors 'none'`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(await res.text(), CLASSROOM_HTML);
});

test('sample assets are the exact approved bytes with their approved framing', () => {
  const dir = path.join(process.cwd(), 'public', 'classroom', 'assets');
  assert.equal((CLASSROOM_HTML.match(/<img\b/g) ?? []).length, 3, 'exactly three images');
  for (const [name, { hash, alt }] of Object.entries(ASSETS)) {
    assert.equal(sha256(readFileSync(path.join(dir, name))), hash, name);
    assert.equal(count(CLASSROOM_HTML, `<img src="/classroom/assets/${name}" alt="${alt}">`), 1, `${name} referenced`);
  }
  assert.equal(count(CLASSROOM_HTML, '<figcaption class="tag">Digital sample — illustrative only</figcaption>'), 3);
  assert.ok(
    CLASSROOM_HTML.includes(
      'The examples below show approved illustration samples from a different Hero Story Books title—not a finished classroom book or a promise of its final art.',
    ),
  );
  assert.ok(
    CLASSROOM_HTML.includes(
      'These three art-only images are approved examples from <em>Pasta Planet</em>. They illustrate a general visual standard only; they do not depict this classroom, an actual classroom book or a current deliverable. Binding, dimensions, page count, illustration approach and available print options are still to be confirmed.',
    ),
  );
  assert.ok(CLASSROOM_HTML.includes('Concept layout only — not a book or illustration sample'));
});

test('page is information-only: no forms, inputs, scripts or remote requests', () => {
  assert.doesNotMatch(CLASSROOM_HTML, /<form\b/i);
  assert.doesNotMatch(CLASSROOM_HTML, /<script\b/i);
  assert.doesNotMatch(CLASSROOM_HTML, /<input\b|<textarea\b|<select\b/i);
  assert.doesNotMatch(CLASSROOM_HTML, /<iframe\b|<object\b|<embed\b|<video\b|<audio\b|<source\b/i);
  assert.doesNotMatch(CLASSROOM_HTML, /\son[a-z]+\s*=/i, 'no inline event handlers');
  assert.doesNotMatch(CLASSROOM_HTML, /javascript:|mailto:|tel:/i);
  assert.doesNotMatch(CLASSROOM_HTML, /\bsrcset=/i);
  assert.doesNotMatch(CLASSROOM_HTML, /group-book/);
  assert.doesNotMatch(style, /url\(|@import/i, 'stylesheet loads nothing');
  assert.equal((CLASSROOM_HTML.match(/<link\b/g) ?? []).length, 1, 'canonical is the only <link>');

  const hrefs = [...CLASSROOM_HTML.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    if (href === 'https://herostorybooks.com/classroom') continue;
    assert.ok(href.startsWith('#'), `unexpected link ${href}`);
    assert.ok(CLASSROOM_HTML.includes(`id="${href.slice(1)}"`), `anchor target ${href} exists`);
  }
  const srcs = [...CLASSROOM_HTML.matchAll(/src="([^"]*)"/g)].map((m) => m[1]);
  for (const src of srcs) assert.ok(src.startsWith('/classroom/assets/'), `unexpected src ${src}`);
});

test('intake is closed: one disabled CTA, no checkout, prices or contact invitations', () => {
  const buttons = CLASSROOM_HTML.match(/<button\b[^>]*>/g) ?? [];
  assert.equal(buttons.length, 1);
  assert.match(buttons[0] ?? '', /\bdisabled\b/);
  assert.ok(CLASSROOM_HTML.includes('<button type="button" disabled>Family submissions not open yet</button>'));
  assert.ok(CLASSROOM_HTML.includes('Please don’t send children’s photos or personal details.'));
  assert.ok(CLASSROOM_HTML.includes('Family submissions are closed for now.'));

  assert.doesNotMatch(
    visibleText,
    /\b(checkout|prices?|pay|payment|buy|order|contact|email|sign up|register|deadline)\b|[$£€]/i,
  );
});

test('preview banner is small, first and non-sticky; nothing can occlude content', () => {
  assert.equal(count(CLASSROOM_HTML, `<p class="notice" role="note">${BANNER}</p>`), 1);
  assert.ok(CLASSROOM_HTML.indexOf(BANNER) < CLASSROOM_HTML.indexOf('<header'), 'banner precedes header');
  const notice = style.match(/\.notice\{[^}]*\}/)?.[0] ?? '';
  assert.ok(notice, 'banner has a style rule');
  assert.doesNotMatch(notice, /position/);
  assert.doesNotMatch(style, /position:\s*(sticky|fixed)/, 'no sticky or fixed elements');
  assert.match(style, /:focus-visible\{outline:3px solid/);
  assert.ok(CLASSROOM_HTML.includes('<a class="skip" href="#main">Skip to content</a>'));
  assert.ok(CLASSROOM_HTML.includes('<main id="main">'));

  assert.doesNotMatch(CLASSROOM_HTML, /owner/i, 'no owner-only prose');
  assert.doesNotMatch(CLASSROOM_HTML, /Not a live invitation|Review draft/);
});

test('three simple story choices are the primary content', () => {
  const stories = section('stories');
  assert.ok(CLASSROOM_HTML.indexOf('id="stories"') < CLASSROOM_HTML.indexOf('id="book"'));
  assert.ok(CLASSROOM_HTML.indexOf('id="stories"') < CLASSROOM_HTML.indexOf('id="how"'));
  assert.ok(CLASSROOM_HTML.indexOf('id="stories"') < CLASSROOM_HTML.indexOf('id="privacy"'));

  const titles = [...stories.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(titles, STORY_TITLES);

  const cards = [...stories.matchAll(/<article class="card">([\s\S]*?)<\/article>/g)].map((m) => m[1]);
  assert.equal(cards.length, 3);
  for (const card of cards) {
    const paras = [...card.matchAll(/<p>([^<]*)<\/p>/g)].map((m) => m[1]);
    assert.equal(paras.length, 1, 'one short description per choice');
    const description = paras[0] ?? '';
    const sentences = description.split(/[.!?](?=\s|$)/).filter((s) => s.trim());
    assert.ok(sentences.length >= 1 && sentences.length <= 2, `short description: ${description}`);
  }

  assert.equal(count(CLASSROOM_HTML, INCLUSIVE), 1, 'one plain inclusive sentence');
});

test('no internal planning markers, roster maps or count metrics are public', () => {
  for (const marker of [
    /\bC(0[1-9]|1[0-5])\b/,
    /\bT[12]\b/,
    /spread/i,
    /tally/i,
    /roster/i,
    /featured (twice|scene)/i,
    /worked example/i,
    /participation map/i,
    /coverage|governance/i,
    /matrix|matrices|schema/i,
    /treatment/i,
    /capacity/i,
    /fifteen|small-group/i,
  ]) {
    assert.doesNotMatch(CLASSROOM_HTML, marker, `planning marker ${marker}`);
  }
  assert.doesNotMatch(
    style,
    /\.(belong|figures|map|ens|crowd|dot|dia|spreads?|sp|trio|id|legend|tally|paths?|faq|gateline|owner|shelf|spine)\b/,
    'planning-diagram CSS removed',
  );
  assert.doesNotMatch(visibleText, /\d/, 'no counts, prices or dates in visible text');
});

test('how it works, privacy and proposed-terms truths are stated plainly', () => {
  const how = section('how');
  assert.deepEqual(
    [...how.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]),
    ['Choose a story direction', 'Families share details privately', 'Review the proof'],
  );
  assert.ok(how.includes('Only once a project opens, each family privately shares approved details about their own child.'));
  assert.ok(how.includes('Printing is a separate release that happens only after that approval.'));

  const privacy = section('privacy');
  assert.ok(privacy.includes('Raw photos and submission fields stay private to the authorized Hero Story Books team.'));
  assert.ok(
    privacy.includes('The finished book is shared with agreed recipients and can include approved names and illustrated likenesses.'),
  );
  assert.ok(privacy.includes('There is no public gallery and no school endorsement; this is an independent keepsake idea.'));
  assert.ok(privacy.includes('All terms on this page are proposed.'));
});
