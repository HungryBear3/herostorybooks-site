import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COVER_VARIANT_COOKIE,
  COVER_VARIANT_COOKIE_MAX_AGE,
  pickVariant,
  parseVariantCookie,
  realisticUrlFor,
  type CoverVariant,
} from '../src/lib/cover-variant.ts';

// ── Cookie parsing ────────────────────────────────────────────────────────────

test('parseVariantCookie: returns "A" or "B" only, never anything else', () => {
  assert.equal(parseVariantCookie('A'), 'A');
  assert.equal(parseVariantCookie('B'), 'B');
  assert.equal(parseVariantCookie('a'), 'A'); // tolerant of case
  assert.equal(parseVariantCookie('b'), 'B');
  assert.equal(parseVariantCookie(''), null);
  assert.equal(parseVariantCookie(undefined), null);
  assert.equal(parseVariantCookie('haha'), null);
  assert.equal(parseVariantCookie('A;B'), null);
});

// ── 50/50 split ───────────────────────────────────────────────────────────────

test('pickVariant: ~50/50 split across many trials', () => {
  let a = 0;
  let b = 0;
  for (let i = 0; i < 5000; i++) {
    const v = pickVariant();
    if (v === 'A') a++; else b++;
  }
  // Each should be within 5% of 50% — allow generous slack to keep the test stable.
  assert.ok(a > 2300 && a < 2700, `A=${a} outside ~50% band`);
  assert.ok(b > 2300 && b < 2700, `B=${b} outside ~50% band`);
});

test('pickVariant: deterministic when given a seed', () => {
  const seed = 'consistent-seed-abc';
  const v1 = pickVariant(seed);
  const v2 = pickVariant(seed);
  assert.equal(v1, v2);
});

test('pickVariant: different seeds can produce different variants', () => {
  // Sample many seeds — at least one A and one B should appear.
  const variants = new Set<CoverVariant>();
  for (let i = 0; i < 100; i++) {
    variants.add(pickVariant(`seed-${i}`));
  }
  assert.ok(variants.has('A'));
  assert.ok(variants.has('B'));
});

// ── URL mapping ───────────────────────────────────────────────────────────────

test('realisticUrlFor: maps illustrative paths to /assets/covers/realistic/<basename>', () => {
  assert.equal(
    realisticUrlFor('/assets/space-voyager-gpt.png'),
    '/assets/covers/realistic/space-voyager-gpt.png',
  );
  assert.equal(
    realisticUrlFor('/assets/brave-explorer-gpt.png'),
    '/assets/covers/realistic/brave-explorer-gpt.png',
  );
});

test('realisticUrlFor: leaves non-/assets/ paths alone', () => {
  assert.equal(realisticUrlFor('https://cdn.example.com/foo.png'), 'https://cdn.example.com/foo.png');
  assert.equal(realisticUrlFor(''), '');
});

test('realisticUrlFor: idempotent — already-realistic paths are returned unchanged', () => {
  const already = '/assets/covers/realistic/space-voyager-gpt.png';
  assert.equal(realisticUrlFor(already), already);
});

// ── Constants ─────────────────────────────────────────────────────────────────

test('cookie name + max-age are stable contracts', () => {
  assert.equal(COVER_VARIANT_COOKIE, 'cover-variant');
  // 7 days in seconds
  assert.equal(COVER_VARIANT_COOKIE_MAX_AGE, 60 * 60 * 24 * 7);
});
