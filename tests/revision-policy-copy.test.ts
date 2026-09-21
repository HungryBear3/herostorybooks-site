import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const publicFaqs = readFileSync('src/lib/public-faqs.ts', 'utf8');
const landingFaq = readFileSync('src/components/landing/FAQ.tsx', 'utf8');
const terms = readFileSync('src/app/terms/page.tsx', 'utf8');
const reviewClient = readFileSync('src/app/review/[orderId]/review-client.tsx', 'utf8');

test('public surfaces communicate one consolidated revision round', () => {
  for (const source of [publicFaqs, landingFaq, terms, reviewClient]) {
    assert.match(source, /one consolidated revision round/i);
  }
});

test('public policy preserves no-charge correction of our quality defects', () => {
  for (const source of [publicFaqs, landingFaq, terms]) {
    assert.match(source, /identity/i);
    assert.match(source, /continuity/i);
  }
});

test('FAQ and terms disclose restart scope, fee, and post-approval cutoff', () => {
  for (const source of [publicFaqs, landingFaq, terms]) {
    assert.match(source, /new photos/i);
    assert.match(source, /\$19 restart fee/i);
    assert.match(source, /cannot be made after printing begins/i);
  }
});
