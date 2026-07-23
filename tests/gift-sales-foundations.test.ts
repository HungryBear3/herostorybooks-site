import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APPROVED_SAMPLE, GIFT_OCCASIONS, getGiftOccasion, giftCheckoutHref } from '../src/lib/gift-occasions.ts';
import { buildProofReminderDraft, buildReferralInvitationDraft, buildReviewRequestDraft } from '../src/lib/customer-lifecycle-drafts.ts';
import { evaluatePrintReadiness, type PrintReadinessEvidence } from '../src/lib/print-readiness-gate.ts';

test('gift occasion catalog covers the approved sales-engine structure', () => {
  assert.deepEqual(GIFT_OCCASIONS.map(({ id }) => id), ['birthdays', 'grandparents', 'siblings', 'pets', 'holidays', 'child-as-hero']);
  assert.equal(APPROVED_SAMPLE.src, '/assets/kind-dragon-v5/23-bravest-magic.jpg');
  assert.match(APPROVED_SAMPLE.framing, /Digital sample.*illustrative only/i);
  assert.equal(giftCheckoutHref(getGiftOccasion('birthdays')!), '/checkout?occasion=birthday');
});

test('gift page foundation avoids forbidden promises and private promo codes', () => {
  const files = ['src/lib/gift-occasions.ts', 'src/app/gifts/page.tsx', 'src/app/gifts/[occasion]/page.tsx'];
  const source = files.map((file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(source, /ERIC50|same-day|instant delivery|guaranteed delivery/i);
  assert.match(source, /usually ready in 2–3 business days/i);
  assert.match(source, /before approval|before fulfillment/i);
});

test('checkout accepts the gift-page occasion handoff without exposing child data', () => {
  const source = readFileSync(new URL('../src/app/checkout/checkout-form.tsx', import.meta.url), 'utf8');
  assert.match(source, /params\.get\("occasion"\)/);
  assert.match(source, /occasionFromUrl \? \{ occasion: occasionFromUrl \}/);
});

test('lifecycle drafts preserve privacy and proof-first gates without sending anything', () => {
  const input = { childName: 'Avery', statusUrl: 'https://example.test/status/order', supportEmail: 'support@example.test' };
  assert.match(buildProofReminderDraft(input).text, /Nothing enters print until the proof is approved/i);
  assert.match(buildReviewRequestDraft(input).text, /do not include private child photos/i);
  assert.match(buildReferralInvitationDraft(input).text, /Never share a child’s photos or private proof/i);
});

function validEvidence(): PrintReadinessEvidence {
  return {
    provider: 'lulu', sku: 'provider-sku-from-current-template', templateFile: 'current-provider-template.pdf',
    templateSha256: 'a'.repeat(64), templateRetrievedAt: '2026-07-22', interiorTrim: 'exact-provider-trim',
    pageCount: 32, interiorFullBleed: true, coverUsesExactTemplateDimensions: true,
    coverImportantContentInsetInches: 0.875, coverBackgroundReachesBleed: true, spineReviewed: true,
    orientationReviewed: true, bindingReviewed: true, deterministicPreflightPassed: true,
    proofCopyReceivedAndReviewed: true,
  };
}

test('print-readiness gate fails closed on missing templates, unsafe cover edges, and missing proof', () => {
  const result = evaluatePrintReadiness({ ...validEvidence(), sku: '', templateSha256: '', coverImportantContentInsetInches: 0.5, proofCopyReceivedAndReviewed: false });
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((blocker) => /SKU/i.test(blocker)));
  assert.ok(result.blockers.some((blocker) => /SHA-256/i.test(blocker)));
  assert.ok(result.blockers.some((blocker) => /0.875-inch/i.test(blocker)));
  assert.ok(result.blockers.some((blocker) => /physical proof/i.test(blocker)));
});

test('print-readiness gate only passes complete, exact-template evidence', () => {
  assert.deepEqual(evaluatePrintReadiness(validEvidence()), { ready: true, blockers: [] });
});
