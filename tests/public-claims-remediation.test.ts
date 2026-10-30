import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CUSTOMER_COPY_FILES = [
  'src/app/checkout/checkout-form.tsx',
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
