/**
 * Meta Conversions API — the deferral is real, not a flag.
 *
 * The previous candidate built a Purchase payload with no `user_data`. Meta
 * requires `user_data` with at least one matching parameter on every server
 * event, so that payload could never have matched anything: `event_id`
 * deduplicates, `event_source_url` describes a page, and neither identifies a
 * person. Rather than add customer matching without server-side consent
 * evidence or a privacy approval, CAPI is deferred and the send path is gone.
 *
 * These tests exist to stop it coming back by accident.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  META_CAPI_ACCESS_TOKEN_ENV,
  META_CAPI_DATASET_ID_ENV,
  META_CAPI_FLAG_ENV,
  META_CAPI_NEVER_SENDS,
  metaCapiStatus,
} from '../src/lib/marketing/meta-capi.ts';

const capiSource = readFileSync(
  new URL('../src/lib/marketing/meta-capi.ts', import.meta.url),
  'utf8',
);
const webhookSource = readFileSync(
  new URL('../src/app/api/webhooks/stripe/route.ts', import.meta.url),
  'utf8',
);

/* ── 1. The status is a decision, not a configuration state ─────────────── */

test('CAPI reports deferred, with the reason and the unmet preconditions', () => {
  const status = metaCapiStatus();
  assert.equal(status.status, 'deferred');
  assert.equal(status.reason, 'no_matching_contract');
  assert.ok(status.blockers.includes('meta_requires_user_data_with_at_least_one_matching_parameter'));
  assert.ok(status.blockers.includes('no_server_side_consent_evidence_for_the_purchaser'));
  assert.ok(status.blockers.includes('no_owner_privacy_approval_for_customer_matching'));
});

test('setting every credential and the flag cannot change the status', () => {
  const prior = {
    [META_CAPI_FLAG_ENV]: process.env[META_CAPI_FLAG_ENV],
    [META_CAPI_DATASET_ID_ENV]: process.env[META_CAPI_DATASET_ID_ENV],
    [META_CAPI_ACCESS_TOKEN_ENV]: process.env[META_CAPI_ACCESS_TOKEN_ENV],
  };
  try {
    process.env[META_CAPI_FLAG_ENV] = 'true';
    process.env[META_CAPI_DATASET_ID_ENV] = '987654321098765';
    process.env[META_CAPI_ACCESS_TOKEN_ENV] = 'not-a-real-token';
    const status = metaCapiStatus();
    assert.equal(
      status.status,
      'deferred',
      'configuration must not be able to switch on a path that does not exist',
    );
    assert.ok(status.blockers.length >= 3, 'the blockers are not credential-shaped');
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('the status function reads no environment at all', () => {
  const fn = capiSource.slice(
    capiSource.indexOf('export function metaCapiStatus'),
    capiSource.indexOf('export interface FutureMetaCapiPurchaseContract'),
  );
  assert.doesNotMatch(fn, /process\.env/);
});

/* ── 2. There is no send path, anywhere ─────────────────────────────────── */

test('the module contains no network primitive of any kind', () => {
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'https://graph.facebook.com', 'axios', 'request(']) {
    assert.equal(
      capiSource.includes(forbidden),
      false,
      `a deferred module must not contain ${forbidden}`,
    );
  }
});

test('no endpoint, version, or timeout constant survives to be wired back up', () => {
  for (const forbidden of [
    'META_GRAPH_API_VERSION',
    'META_CAPI_TIMEOUT_MS',
    'META_EVENT_SOURCE_URL',
    'sendMetaCapiPurchase',
    'scheduleMetaCapiPurchase',
    'buildMetaCapiPayload',
  ]) {
    // The words may appear in prose explaining the decision; they must not be
    // declared. Anchor on a declaration, not a mention.
    assert.doesNotMatch(
      capiSource,
      new RegExp(`(?:export )?(?:const|function|async function|let|var) ${forbidden}\\b`),
      `${forbidden} is declared in a module that must not send`,
    );
  }
});

test('the webhook no longer references Meta at all', () => {
  assert.equal(webhookSource.includes('scheduleMetaCapiPurchase'), false);
  assert.equal(webhookSource.includes('metaCapiPurchaseFrom'), false);
  assert.equal(webhookSource.includes('meta-capi'), false);
  assert.equal(/\bMeta\b/.test(webhookSource), false, 'the webhook still mentions Meta');
});

/* ── 3. The seam records what a future contract would need ──────────────── */

test('the retained seam names user_data as the required matching block', () => {
  assert.match(capiSource, /export interface FutureMetaCapiPurchaseContract/);
  assert.match(capiSource, /user_data: \{/);
  assert.match(capiSource, /event_id: string;/);
  // And it is a type only: nothing builds one.
  assert.doesNotMatch(
    capiSource,
    /function .*FutureMetaCapiPurchaseContract|: FutureMetaCapiPurchaseContract =/,
    'the future contract must remain a type, not a constructed value',
  );
});

test('the never-send list still names child, family, order, and token data', () => {
  for (const field of [
    'child_name',
    'family_data',
    'order_id',
    'submission_id',
    'customer_email',
    'proof_token',
    'review_token',
  ]) {
    assert.ok(
      (META_CAPI_NEVER_SENDS as readonly string[]).includes(field),
      `${field} dropped off the never-send list`,
    );
  }
});

test('the documented reason survives, so the decision is not folklore', () => {
  assert.match(capiSource, /requires `user_data`/);
  assert.match(capiSource, /event_id` exists\s*\n? \* to DEDUPLICATE|DEDUPLICATE/);
  assert.match(capiSource, /NO SERVER-SIDE CONSENT EVIDENCE/);
  assert.match(capiSource, /NO PRIVACY APPROVAL/);
});

/* ── 4. Purchase ownership is unchanged ─────────────────────────────────── */

test('the browser is still forbidden from emitting Purchase', () => {
  const pixelSource = readFileSync(
    new URL('../src/lib/marketing/meta-pixel.ts', import.meta.url),
    'utf8',
  );
  const contractSource = readFileSync(
    new URL('../src/lib/marketing/event-contract.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(pixelSource, /'Purchase'/);
  assert.match(contractSource, /Purchase/, 'the contract should still name Purchase as prohibited');
});

test('Stripe remains the only purchase authority, with GA4 its only destination', () => {
  const ga4Calls = webhookSource.match(/scheduleGa4Purchase\(\{/g) ?? [];
  assert.equal(ga4Calls.length, 3);
  assert.match(webhookSource, /constructEvent|verifyStripeSignature|stripe-signature/i);
});
