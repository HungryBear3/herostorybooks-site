import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CUSTOMER_COPY_FILES = [
  'src/app/checkout/checkout-form.tsx',
  'src/app/family-review/portal-flow.tsx',
  'src/components/editorial-site.tsx',
  'src/components/landing/FAQ.tsx',
  'src/components/landing/Pricing.tsx',
  'src/components/landing/TrustBadges.tsx',
  'src/lib/fathers-day.ts',
  'src/lib/order-email.ts',
  'src/lib/orders.ts',
  'src/lib/pricing.ts',
  'src/lib/public-catalog.ts',
  'src/lib/public-faqs.ts',
] as const;

const copy = CUSTOMER_COPY_FILES
  .map((file) => `${file}\n${readFileSync(file, 'utf8')}`)
  .join('\n');

const REVIEWED_PUBLIC_CLAIM_FILES = [
  'src/app/checkout/checkout-form.tsx',
  'src/app/family-review/portal-flow.tsx',
  'src/app/privacy/page.tsx',
  'src/app/terms/page.tsx',
  'src/components/checkout/VoiceRecorderSection.tsx',
  'src/components/editorial-site.tsx',
  'src/lib/guided-photo-capture.ts',
  'src/lib/proof-turnaround.ts',
  'src/lib/public-catalog.ts',
  'src/lib/public-faqs.ts',
] as const;

const reviewedClaims = REVIEWED_PUBLIC_CLAIM_FILES
  .map((file) => `${file}\n${readFileSync(file, 'utf8')}`)
  .join('\n');

const familyReview = readFileSync('src/app/family-review/portal-flow.tsx', 'utf8');

test('customer copy contains no retired print or arrival numeric SLA', () => {
  assert.doesNotMatch(copy, /5[–-]7 business days|3[–-]5 days|9[–-]12 (?:business )?days/i);
});

test('checkout no longer implies instant post-approval digital delivery', () => {
  const checkout = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  assert.doesNotMatch(checkout, /delivered right away/i);
  assert.match(checkout, /full Digital PDF comes with the proof email/i);
});

test('printed-book timing is approval-gated and evidence-dependent', () => {
  const timing = readFileSync('src/lib/proof-turnaround.ts', 'utf8');
  assert.match(timing, /After proof approval.*print provider.*destination.*shipping option/i);
  assert.match(timing, /arrival dates are estimates and are not guaranteed/i);
  assert.doesNotMatch(timing, /confirm(?:s|ed|ing)? the estimate separately/i);
});

test('public product counts are format-specific illustrated-story counts', () => {
  const catalog = readFileSync('src/lib/public-catalog.ts', 'utf8');
  const checkout = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  assert.doesNotMatch(reviewedClaims, /32-page (?:personalized |illustrated )?(?:book|storybook|proof)/i);
  assert.match(catalog, /24 illustrated story pages[\s\S]*?Classic softcover[\s\S]*?24 illustrated story pages[\s\S]*?Premium hardcover[\s\S]*?32 illustrated story pages/);
  assert.match(checkout, /ILLUSTRATED_STORY_PAGE_COUNTS[\s\S]*?digital: 24[\s\S]*?classic: 24[\s\S]*?premium: 32/);
});

test('privacy copy discloses provider processing without an unverified training guarantee', () => {
  assert.doesNotMatch(reviewedClaims, /(?:never|not|won(?:'|&apos;)t)[^\n.]{0,100}\b(?:train|training)\b|\b(?:train|training)\b[^\n.]{0,100}(?:never|not|won(?:'|&apos;)t)/i);
  assert.match(reviewedClaims, /service providers may process/i);
  assert.equal(
    (familyReview.match(/Service providers may process/g) ?? []).length,
    3,
    'each family-review photo-upload disclosure must state provider processing',
  );
});

test('gift FAQ avoids instant-sharing delivery language', () => {
  const faq = readFileSync('src/lib/public-faqs.ts', 'utf8');
  assert.doesNotMatch(faq, /share it instantly/i);
  assert.match(faq, /share the downloaded file/i);
});

test('/faq permanently redirects to the rendered homepage FAQ anchor', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
    redirects: Array<{ source: string; destination: string; permanent: boolean }>;
  };
  assert.ok(config.redirects.some((redirect) =>
    redirect.source === '/faq'
    && redirect.destination === '/#faq'
    && redirect.permanent === true));
});
