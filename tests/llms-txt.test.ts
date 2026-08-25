/**
 * /llms.txt and the crawl rules that decide whether anything can reach it or
 * the public catalog endpoint.
 *
 * llms.txt is generated from PUBLIC_CATALOG rather than checked in, so the
 * interesting assertions are that it quotes the contract rather than restating
 * it, that it points only at production URLs, and that it makes no promise
 * about indexing or recommendation that nobody can keep.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import * as llms from '../src/app/llms.txt/route.ts';
import robots from '../src/app/robots.ts';
import {
  PUBLIC_CATALOG,
  PUBLIC_CANONICAL_PAGES,
  PUBLIC_CATALOG_ENDPOINT_PATH,
  PUBLIC_CATALOG_ENDPOINT_URL,
} from '../src/lib/public-catalog.ts';
import { PRODUCTION_ORIGIN } from '../src/lib/site-url.ts';

const body = await llms.GET().text();

const PRODUCTION_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'production', VERCEL_ENV: 'production' };
const PREVIEW_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  VERCEL_ENV: 'preview',
  VERCEL_URL: 'hsb-preview.vercel.app',
};

function withEnv<T>(env: NodeJS.ProcessEnv, run: () => T): T {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return run();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

/* ------------------------------------------------------------- llms.txt */

test('served as plain text with the reviewed cache headers', () => {
  const response = llms.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(response.headers.get('cache-control') ?? '', /public.*max-age=300/);
});

test('every canonical page and the catalog endpoint are linked', () => {
  for (const page of PUBLIC_CANONICAL_PAGES) {
    assert.ok(body.includes(page.url), `llms.txt omits ${page.url}`);
    assert.ok(body.includes(page.title), `llms.txt omits the title for ${page.url}`);
  }
  assert.ok(body.includes(PUBLIC_CATALOG_ENDPOINT_URL));
});

test('every URL in the file is a production apex URL', () => {
  const urls = [...body.matchAll(/https?:\/\/[^\s)\]]+/g)].map((match) => match[0]);
  assert.ok(urls.length >= PUBLIC_CANONICAL_PAGES.length);
  for (const url of urls) {
    assert.ok(url.startsWith(PRODUCTION_ORIGIN), `non-production URL in llms.txt: ${url}`);
  }
});

test('product facts are quoted from the catalog, not restated', () => {
  for (const product of PUBLIC_CATALOG.products) {
    assert.ok(body.includes(product.name), `llms.txt omits ${product.name}`);
    assert.ok(body.includes(`id: ${product.id}`), `llms.txt omits the stable id ${product.id}`);
    assert.ok(body.includes(product.priceDisplay), `llms.txt omits the price for ${product.id}`);
    assert.ok(body.includes(product.description), `llms.txt paraphrases ${product.id}`);
  }
  assert.ok(body.includes(PUBLIC_CATALOG.policies.shippingGeography));
  assert.ok(body.includes(PUBLIC_CATALOG.policies.refundDigital));
  assert.ok(body.includes(PUBLIC_CATALOG.policies.refundPrinted));
  assert.ok(body.includes(PUBLIC_CATALOG.lastReviewed));
  assert.ok(body.includes(PUBLIC_CATALOG.schemaVersion));
});

test('general product facts are separated from private order support', () => {
  const support = body.slice(body.indexOf('## Order support'));
  assert.ok(support.length > 0, 'llms.txt has no order-support section');
  assert.ok(/private/i.test(support));
  assert.ok(support.includes(PUBLIC_CATALOG.brand.supportContact));
  assert.ok(
    /not available here|is not available/i.test(support),
    'llms.txt must say order data is not served here',
  );
});

test('delivery is explicitly not guaranteed, and no indexing promise is made', () => {
  assert.ok(/not guaranteed/i.test(body));

  // The "Limits of this information" section exists to DENY these ("No instant,
  // same-day, or rush fulfillment is offered"), so the claim scan stops there.
  const claims = body.slice(0, body.indexOf('## Limits of this information'));
  assert.ok(claims.length > 0);
  for (const overclaim of [
    /guarantees? (?:indexing|inclusion|citation|ranking|recommendation)/i,
    /will be (?:indexed|cited|recommended|ranked)/i,
    /ensures? (?:indexing|citation)/i,
    /same[- ]day/i,
    /\bmoney[- ]back\b/i,
  ]) {
    assert.ok(!overclaim.test(claims), `llms.txt overclaims: ${overclaim}`);
  }
});

test('no private marker leaks into llms.txt', () => {
  const lower = body.toLowerCase();
  for (const marker of ['ord_', 'sk_live', 'sk_test', 'whsec_', 'blob.vercel-storage.com', 'token=']) {
    assert.ok(!lower.includes(marker), `private marker "${marker}" in llms.txt`);
  }
  const addresses = [...body.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(addresses)], [PUBLIC_CATALOG.brand.supportContact]);
});

/* --------------------------------------------------------------- robots */

test('production robots allows the catalog endpoint without opening other APIs', () => {
  const rules = withEnv(PRODUCTION_ENV, () => robots()).rules as {
    allow?: string | string[];
    disallow?: string | string[];
  };

  const allow = ([] as string[]).concat(rules.allow ?? []);
  const disallow = ([] as string[]).concat(rules.disallow ?? []);

  assert.ok(allow.includes('/'), 'public site must stay crawlable');
  assert.ok(
    allow.includes(PUBLIC_CATALOG_ENDPOINT_PATH),
    'the catalog endpoint must be explicitly allowed',
  );
  assert.ok(disallow.includes('/api/'), 'all other APIs must stay disallowed');

  // The allow must be strictly more specific than the /api/ disallow, which is
  // what makes most-specific-rule-wins crawlers fetch it.
  assert.ok(PUBLIC_CATALOG_ENDPOINT_PATH.startsWith('/api/'));
  assert.ok(PUBLIC_CATALOG_ENDPOINT_PATH.length > '/api/'.length);

  // Nothing else was widened.
  assert.deepEqual(allow, ['/', PUBLIC_CATALOG_ENDPOINT_PATH]);
  for (const priv of ['/admin/', '/checkout', '/family-review', '/order', '/review/', '/status/', '/thank-you']) {
    assert.ok(disallow.includes(priv), `${priv} must stay disallowed`);
  }
});

test('llms.txt is not blocked by any robots rule', () => {
  const rules = withEnv(PRODUCTION_ENV, () => robots()).rules as { disallow?: string | string[] };
  const disallow = ([] as string[]).concat(rules.disallow ?? []);
  for (const rule of disallow) {
    assert.ok(!'/llms.txt'.startsWith(rule), `/llms.txt is blocked by the "${rule}" rule`);
  }
});

test('preview deployments stay fully non-indexable', () => {
  const rules = withEnv(PREVIEW_ENV, () => robots()).rules as {
    allow?: string | string[];
    disallow?: string | string[];
  };
  assert.equal(rules.allow, undefined, 'preview must allow nothing');
  assert.equal(rules.disallow, '/', 'preview must disallow everything');
});
