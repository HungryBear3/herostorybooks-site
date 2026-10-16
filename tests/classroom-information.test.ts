/**
 * /classroom is an information-only page serving the owner-approved classroom
 * HTML verbatim. The only permitted transformations are rewriting the three
 * relative sample-image paths to /classroom/assets/ and adding a canonical
 * link to <head>. Reversing those must reproduce the approved bytes exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { GET, dynamic } from '../src/app/classroom/route.ts';
import { CLASSROOM_HTML } from '../src/app/classroom/classroom-html.ts';

const APPROVED_HTML_SHA256 = '82b6075534155ee503e4a3970c0f0edc73067b90560d0b13fe1788b398756b25';
const CANONICAL_LINK = '<link rel="canonical" href="https://herostorybooks.com/classroom">\n';

const ASSETS: Record<string, string> = {
  'pasta-planet-page-19-art-only.png': '64b64bc9ee5c7c82a4d00d7b8971c501c9e9a2d6112541189f8290f59e3271ba',
  'pasta-planet-page-20-art-only.png': '0b957e5a72713921c618b14c94104175d13d10a05a89a6da670374d750fa1221',
  'pasta-planet-page-24-art-only.png': '525c73509cd9abd463f73c33b3d84c1a86e901f2779ed5895ee4ae4e2216d141',
};

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

test('classroom HTML is the approved page after reversing only the allowed transformations', () => {
  assert.equal(CLASSROOM_HTML.split(CANONICAL_LINK).length - 1, 1, 'exactly one canonical link');
  assert.equal(CLASSROOM_HTML.split('src="/classroom/assets/').length - 1, 3, 'exactly three rewritten image paths');
  assert.ok(!CLASSROOM_HTML.includes('src="assets/'), 'no relative image paths remain');

  const reversed = CLASSROOM_HTML
    .replace(CANONICAL_LINK, '')
    .replaceAll('src="/classroom/assets/', 'src="assets/');
  assert.equal(sha256(Buffer.from(reversed, 'utf8')), APPROVED_HTML_SHA256);
});

test('canonical link sits inside <head>', () => {
  const head = CLASSROOM_HTML.slice(0, CLASSROOM_HTML.indexOf('</head>'));
  assert.ok(head.includes(CANONICAL_LINK));
});

test('sample assets are the exact approved bytes', () => {
  const dir = path.join(process.cwd(), 'public', 'classroom', 'assets');
  for (const [name, hash] of Object.entries(ASSETS)) {
    assert.equal(sha256(readFileSync(path.join(dir, name))), hash, name);
    assert.ok(CLASSROOM_HTML.includes(`src="/classroom/assets/${name}"`), `${name} referenced`);
  }
});

test('GET serves static HTML with security headers', async () => {
  assert.equal(dynamic, 'force-static');
  const res = await GET();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /img-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('referrer-policy'));
  assert.equal(await res.text(), CLASSROOM_HTML);
});

test('page is information-only: disabled CTAs, no forms, scripts or external links', () => {
  const buttons = CLASSROOM_HTML.match(/<button\b[^>]*>/g) ?? [];
  assert.equal(buttons.length, 2);
  for (const b of buttons) assert.match(b, /\bdisabled\b/);
  assert.equal((CLASSROOM_HTML.match(/Review draft — family submissions not open/g) ?? []).length, 2);

  assert.doesNotMatch(CLASSROOM_HTML, /<form\b/i);
  assert.doesNotMatch(CLASSROOM_HTML, /<script\b/i);
  assert.doesNotMatch(CLASSROOM_HTML, /<input\b|<textarea\b|<select\b/i);
  assert.doesNotMatch(CLASSROOM_HTML, /group-book/);

  const hrefs = [...CLASSROOM_HTML.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    if (href === 'https://herostorybooks.com/classroom') continue;
    assert.ok(href.startsWith('#'), `unexpected link ${href}`);
  }
  const srcs = [...CLASSROOM_HTML.matchAll(/src="([^"]*)"/g)].map((m) => m[1]);
  for (const src of srcs) assert.ok(src.startsWith('/classroom/assets/'), `unexpected src ${src}`);
});

test('CSP meta, review banner and proposed-policy language are retained', () => {
  assert.ok(CLASSROOM_HTML.includes('<meta http-equiv="Content-Security-Policy"'));
  assert.ok(CLASSROOM_HTML.includes('Owner review draft · Proposed experience only · Not a live invitation'));
  assert.ok(CLASSROOM_HTML.includes('Under the proposed policy'));
  assert.ok(CLASSROOM_HTML.includes('These terms still need approval; no submissions are open.'));
  assert.ok(CLASSROOM_HTML.includes('Digital sample'));
});
