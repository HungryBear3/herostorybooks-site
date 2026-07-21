import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const checkoutFormSource = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
const namePreviewSource = readFileSync('src/components/name-preview.tsx', 'utf8');
const analyticsSource = readFileSync('src/lib/analytics.ts', 'utf8');
const layoutSource = readFileSync('src/app/layout.tsx', 'utf8');
const safeVercelAnalyticsSource = readFileSync(
  'src/components/safe-vercel-analytics.tsx',
  'utf8',
);

test('checkout reads childName query param for NamePreview handoff', () => {
  assert.match(checkoutFormSource, /params\.get\(['"]childName['"]\)/);
  assert.match(checkoutFormSource, /sanitizeChildNameParam/);
  assert.match(checkoutFormSource, /childNameFromUrl \? \{ childName: childNameFromUrl \}/);
});

test('homepage pricing does not advertise stale $24 digital footnote', () => {
  const homepageSources = [
    readFileSync('src/app/page.tsx', 'utf8'),
    readFileSync('src/components/pricing-section.tsx', 'utf8'),
    readFileSync('src/components/landing/Pricing.tsx', 'utf8'),
  ].join('\n');

  assert.doesNotMatch(homepageSources, /Available from \$24 on the pricing page/);
  assert.doesNotMatch(homepageSources, /Prefer a digital copy\?\s*Available from \$24/);
});

test('checkout default buyer copy does not advertise stale Father\'s Day framing', () => {
  assert.doesNotMatch(checkoutFormSource, /Father's Day pick|e\.g\. Father's Day/);

  const voiceRecorderSource = readFileSync('src/components/checkout/VoiceRecorderSection.tsx', 'utf8');
  assert.doesNotMatch(voiceRecorderSource, /Father(&apos;|')s Day book feel/);
});

test('checkout form does not ask buyers for hero pronouns', () => {
  assert.doesNotMatch(checkoutFormSource, /childPronouns: string/);
  assert.doesNotMatch(checkoutFormSource, /value=\{form\.childPronouns\}/);
  assert.doesNotMatch(checkoutFormSource, /set\("childPronouns", e\.target\.value\)/);
  assert.doesNotMatch(checkoutFormSource, /payload\.set\("childPronouns", form\.childPronouns\)/);
  assert.doesNotMatch(checkoutFormSource, /Boolean\(form\.childPronouns\)/);
  assert.doesNotMatch(checkoutFormSource, />\s*Pronouns\s*</i);
  assert.doesNotMatch(checkoutFormSource, /Select pronouns/i);
});

test('checkout visible format pricing matches server-side order pricing', () => {
  assert.match(checkoutFormSource, /label: ["']Digital proof["'][\s\S]*?price: ["']\$19\.00["'][\s\S]*?priceNum: 19/);
  assert.match(checkoutFormSource, /label: ["']Classic softcover["'][\s\S]*?price: ["']\$39\.00["'][\s\S]*?priceNum: 39/);
  assert.match(checkoutFormSource, /label: ["']Premium hardcover["'][\s\S]*?price: ["']\$64\.00["'][\s\S]*?priceNum: 64/);
  assert.doesNotMatch(checkoutFormSource, /\$14\.99|\$44\.99|\$64\.99/);
});

test('NamePreview hands checkout prefill through sessionStorage without putting childName in the URL', () => {
  assert.match(namePreviewSource, /const NAME_PREVIEW_HANDOFF_KEY = ["']hsb_name_preview_handoff["']/);
  assert.match(namePreviewSource, /window\.sessionStorage\.setItem\(/);
  assert.match(namePreviewSource, /JSON\.stringify\(\{ childName, direction: ["']custom["'] \}\)/);
  assert.match(namePreviewSource, /href=["']\/checkout["']/);
  assert.doesNotMatch(namePreviewSource, /\/checkout\?childName|encodeURIComponent\(trimmedName\)/);
  assert.match(checkoutFormSource, /readNamePreviewHandoff\(\)/);
  assert.match(checkoutFormSource, /window\.sessionStorage\.removeItem\(NAME_PREVIEW_HANDOFF_KEY\)/);
});

test('NamePreview + checkout fire shared analytics events', () => {
  assert.match(namePreviewSource, /track\(["']name_preview_submitted["']/);
  assert.match(checkoutFormSource, /track\(["']start_checkout["']/);
  assert.match(checkoutFormSource, /track\(["']format_selected["']/);
  assert.match(checkoutFormSource, /track\(["']story_selected["']/);
  assert.match(checkoutFormSource, /track\(["']order_submit_attempt["']/);
  assert.match(checkoutFormSource, /track\(["']purchase_intent["']/);
});

test('HSB mounts privacy-sanitized Vercel Analytics and forwards campaign params', () => {
  assert.match(layoutSource, /<SafeVercelAnalytics \/>/);
  assert.match(safeVercelAnalyticsSource, /from ["']@vercel\/analytics\/next["']/);
  assert.match(safeVercelAnalyticsSource, /beforeSend=/);
  assert.match(safeVercelAnalyticsSource, /`\$\{url\.origin\}\$\{url\.pathname\}`/);
  assert.match(analyticsSource, /utm_source/);
  assert.match(analyticsSource, /utm_campaign/);
  assert.match(analyticsSource, /event !== ['"]page_view['"]/);
  assert.match(analyticsSource, /trackVercelEvent\(event, vercelSafeProps\(record\)\)/);
  assert.match(analyticsSource, /key === ['"]href['"]/);
});

test('NamePreview analytics sends only derived metrics, never the child name', () => {
  const eventBlock = namePreviewSource.match(/track\(["']name_preview_submitted["'][\s\S]*?\}\);/)?.[0] ?? '';
  assert.match(eventBlock, /has_name/);
  assert.match(eventBlock, /preview_name_length/);
  assert.doesNotMatch(eventBlock, /childName\s*:|displayName\s*:|\bname\s*:/);
});
