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

test('checkout print step drops the unsupported separate timing confirmation', () => {
  const checkout = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  const printStep = checkout.match(/Then we print or deliver<\/strong>([\s\S]*?)<\/span>/)?.[1] ?? '';
  assert.ok(printStep.trim(), 'checkout must keep the "Then we print or deliver" step');
  assert.doesNotMatch(checkout, /timing confirmed separately/i);
  assert.doesNotMatch(printStep, /confirm(?:s|ed|ing|ation)?[\s\S]{0,80}separately|separately[\s\S]{0,80}confirm/i);
  assert.match(printStep, /full Digital PDF comes with the proof email/i);
  assert.match(printStep, /only after (?:proof )?approval/i);
  assert.match(
    printStep,
    /\{PRINT_TIMING_AFTER_APPROVAL\}|provider, destination, and shipping option/i,
  );
  assert.doesNotMatch(printStep, /\d|guarantee/i);
});

test('public marketing distinguishes formats without universal numeric page entitlements', () => {
  const catalog = readFileSync('src/lib/public-catalog.ts', 'utf8');
  const checkout = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  const editorial = readFileSync('src/components/editorial-site.tsx', 'utf8');
  assert.doesNotMatch(reviewedClaims, /32-page (?:personalized |illustrated )?(?:book|storybook|proof)/i);
  for (const [surface, source] of Object.entries({ catalog, checkout, editorial })) {
    assert.doesNotMatch(
      source,
      /\b(?:24|32)\s+(?:illustrated\s+)?(?:story\s+)?pages?\b/i,
      `${surface} must not market a universal numeric page entitlement`,
    );
  }
  assert.doesNotMatch(checkout, /ILLUSTRATED_STORY_PAGE_COUNTS/);
  assert.match(catalog, /Digital PDF[\s\S]*?Classic softcover[\s\S]*?Premium hardcover/);
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

// Collapse JSX source to rendered-equivalent text: `{" "}` spacers and line
// breaks between JSX text become single spaces, and entities become quotes.
const renderedJsxText = (source: string) => source
  .replace(/\{\s*(["'`])\s*\1\s*\}/g, ' ')
  .replace(/&apos;|&#39;|&rsquo;/g, "'")
  .replace(/\s+/g, ' ');

test('checkout footer drops the absolute data-sharing promise split across JSX lines', () => {
  const checkout = renderedJsxText(readFileSync('src/app/checkout/checkout-form.tsx', 'utf8'));
  const sharingPromise = checkout.match(
    /\b(?:never|not|won['’]t|don['’]t)\s+(?:be\s+|ever\s+)?(?:(?:sold|sell|rented|rent)\s+(?:or|and)\s+)?shar(?:e|ed|es|ing)\b/i,
  )?.[0];
  assert.equal(
    sharingPromise,
    undefined,
    `checkout must not promise data is never shared while disclosing provider processing (found: "${sharingPromise}")`,
  );
  assert.ok(/Service providers may process/.test(checkout), 'checkout must keep its provider-processing disclosure');
  assert.ok(/Proof approval before printing/.test(checkout), 'checkout footer must keep the approval-before-print note');
});

test('trust badges drop unsupported volume, rating, and satisfaction metrics', () => {
  const badges = readFileSync('src/components/landing/TrustBadges.tsx', 'utf8');
  const unsupportedMetrics: Array<[string, RegExp]> = [
    ['books-created volume count', /\b\d{1,3}(?:,\d{3})+\s*\+|\b\d+(?:\.\d+)?\s*[km]\s*\+|\bBooks\s+Created\b/i],
    ['average star rating', /\b\d(?:\.\d+)?\s*\/\s*5\b|\bAv(?:g\.?|erage)\s+Rating\b/i],
    ['satisfaction rate', /\b100\s*%|\bSatisfaction\b/i],
  ];
  for (const [claim, pattern] of unsupportedMetrics) {
    assert.ok(!pattern.test(badges), `TrustBadges must not show an unsupported ${claim}`);
  }
  assert.ok(
    /Proof first/.test(badges) && /Approve Before Print/i.test(badges),
    'TrustBadges must keep the approval-before-print badge',
  );
});
