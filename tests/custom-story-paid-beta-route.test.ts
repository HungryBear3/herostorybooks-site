import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = () => readFileSync('src/app/create/your-memory/page.tsx', 'utf8');
const form = () => readFileSync('src/app/create/your-memory/paid-memory-beta-form.tsx', 'utf8');
const orderRoute = () => readFileSync('src/lib/checkout-order-route-handler.ts', 'utf8') + readFileSync('src/app/api/order/route.ts', 'utf8');

test('friends/family paid custom-memory route is private and noindexed', () => {
  const source = page();
  assert.match(source, /robots:\s*{\s*index:\s*false,\s*follow:\s*false/s);
  assert.match(source, /HSB_CUSTOM_STORY_PAID_BETA/);
  assert.match(source, /PaidMemoryBetaForm paidBetaEnabled/);
});

test('paid memory beta form posts sanitized customStoryBrief to /api/order', () => {
  const source = form();
  const fetchIdx = source.indexOf('fetch("/api/order"');
  const customBriefIdx = source.indexOf('form.set("customStoryBrief", JSON.stringify(brief))');
  assert.ok(customBriefIdx > 0, 'form sends customStoryBrief');
  assert.ok(fetchIdx > customBriefIdx, 'customStoryBrief is attached before POST');
  assert.match(source, /briefApprovedByOperator:\s*false/);
  assert.match(source, /transcriptSanitized:\s*true/);
  assert.doesNotMatch(source, /rawTranscript/);
});

test('paid memory beta copy keeps proof print and public-use gates closed', () => {
  const source = form();
  assert.match(source, /does <strong>not<\/strong> automatically generate, release, print, or publicly reuse/i);
  assert.match(source, /No automatic proof, print, likeness rendering, shipping, or public sample use/i);
  assert.match(source, /human review/i);
});

test('custom-story paid checkout uses narrow beta flag, not broad primary-hero gate', () => {
  const source = orderRoute();
  const customGateIdx = source.indexOf('if (!shapeStatus.sellableSelfServe && !CUSTOM_STORY_PAID_BETA_ENABLED)');
  const primaryGateIdx = source.indexOf("if (heroType !== 'child')");
  assert.ok(customGateIdx > 0, 'custom-story paid gate exists');
  assert.ok(primaryGateIdx > 0, 'primary hero gate still exists separately');
  assert.match(source, /custom_story_paid_beta_required/);
  assert.doesNotMatch(source, /custom_story_shape_private_beta_required/);
});
