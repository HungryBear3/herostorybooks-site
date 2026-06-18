import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  appendFamilyContribution,
  buildFamilyContributionUrl,
  createOrderRecord,
  sanitizeFamilyContributionInput,
} from '../src/lib/orders.ts';

test('createOrderRecord generates a private family contribution token for each order', () => {
  const record = createOrderRecord(
    { childName: 'Milo', bookFormat: 'digital', email: 'parent@example.com' },
    { id: 'ord_family_link', now: '2026-06-17T15:00:00.000Z' },
  );

  assert.match(record.familyContributionToken ?? '', /^[a-f0-9]{32}$/);
  assert.deepEqual(record.familyContributions, []);
});

test('buildFamilyContributionUrl returns only tokenized private links', () => {
  const url = buildFamilyContributionUrl('https://herostorybooks.com/', 'abc123token');
  assert.equal(url, 'https://herostorybooks.com/family-contribute/abc123token');
});

test('sanitizeFamilyContributionInput keeps bounded family story material and strips control characters', () => {
  const contribution = sanitizeFamilyContributionInput({
    contributorName: ' Grandma\nSue ',
    relationship: ' grandma ',
    dedication: 'For Milo — you are loved.\u0000',
    memory: 'He calls dinosaurs “roar-roars”.'.repeat(30),
    storyIdea: 'Put Grandma and the puppy in the moon parade.',
    supportingCharacterName: 'Buddy',
    supportingCharacterRelationship: 'family dog',
    supportingCharacterNotes: 'golden doodle, red collar',
  }, '2026-06-17T15:05:00.000Z');

  assert.equal(contribution.contributorName, 'Grandma Sue');
  assert.equal(contribution.relationship, 'grandma');
  assert.equal(contribution.dedication, 'For Milo — you are loved.');
  assert.equal(contribution.storyIdea, 'Put Grandma and the puppy in the moon parade.');
  assert.equal(contribution.supportingCharacterName, 'Buddy');
  assert.equal(contribution.supportingCharacterRelationship, 'family dog');
  assert.equal(contribution.supportingCharacterNotes, 'golden doodle, red collar');
  assert.equal(contribution.submittedAt, '2026-06-17T15:05:00.000Z');
  assert.ok(contribution.memory.length <= 800);
});

test('appendFamilyContribution adds newest private contribution without changing payment or fulfillment state', () => {
  const order = createOrderRecord(
    { childName: 'Milo', bookFormat: 'classic', email: 'parent@example.com' },
    { id: 'ord_family_append', now: '2026-06-17T15:00:00.000Z' },
  );

  const next = appendFamilyContribution(
    order,
    sanitizeFamilyContributionInput(
      { contributorName: 'Uncle Dan', memory: 'Milo loved the lake trip.' },
      '2026-06-17T15:05:00.000Z',
    ),
  );

  assert.equal(next.id, order.id);
  assert.equal(next.paymentStatus, 'pending');
  assert.equal(next.status, 'order_received');
  assert.equal(next.familyContributions?.length, 1);
  assert.equal(next.familyContributions?.[0]?.contributorName, 'Uncle Dan');
  assert.equal(next.updatedAt, '2026-06-17T15:05:00.000Z');
});

test('source contract: order success URL carries contributionToken and thank-you renders invite copy', () => {
  const route = readFileSync('src/app/api/order/route.ts', 'utf8');
  const thankYou = readFileSync('src/app/thank-you/page.tsx', 'utf8');

  assert.match(route, /contributionToken/);
  assert.match(route, /order\.familyContributionToken/);
  assert.doesNotMatch(route, /familyContributionUrl/);
  assert.match(thankYou, /Invite family/);
  assert.match(thankYou, /family-contribute/);
});

test('source contract: contribution page and API route are private-token based and do not mention child public gallery', () => {
  const page = readFileSync('src/app/family-contribute/[token]/page.tsx', 'utf8');
  const route = readFileSync('src/app/api/family-contributions/[token]/route.ts', 'utf8');

  assert.match(page, /private family contribution link/i);
  assert.match(route, /findOrderByFamilyContributionToken/);
  assert.match(route, /appendFamilyContribution/);
  assert.doesNotMatch(page + route, /public gallery/i);
});

test('source contract: contribution API accepts voice-only or photo-only submissions', () => {
  const route = readFileSync('src/app/api/family-contributions/[token]/route.ts', 'utf8');
  const emptyGuard = route.slice(route.indexOf('!contribution.dedication'), route.indexOf("{ error: 'empty' }"));

  assert.match(emptyGuard, /!isAttachedFile\(voiceFile\)/);
  assert.match(emptyGuard, /!isAttachedFile\(photoFile\)/);
});

test('source contract: contribution photo uploads require explicit permission and persist consent timestamp', () => {
  const page = readFileSync('src/app/family-contribute/[token]/page.tsx', 'utf8');
  const route = readFileSync('src/app/api/family-contributions/[token]/route.ts', 'utf8');
  const orders = readFileSync('src/lib/orders.ts', 'utf8');

  assert.match(page, /name="photoConsent"/);
  assert.match(page, /permission to share this supporting character photo/i);
  assert.match(route, /photoConsent/);
  assert.match(route, /error:\s*'photo_consent'/);
  assert.match(route, /photoConsentAt:\s*submittedAt/);
  assert.match(orders, /photoConsentAt/);
});

test('source contract: contribution API rejects unpaid or failed private-token orders', () => {
  const route = readFileSync('src/app/api/family-contributions/[token]/route.ts', 'utf8');

  assert.match(route, /paymentStatus\s*!==\s*'paid'/);
  assert.match(route, /error:\s*'inactive_order'/);
});
