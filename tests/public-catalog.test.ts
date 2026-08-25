/**
 * The public fact contract: shape, truthfulness, price parity, and — the part
 * that actually matters — the privacy boundary.
 *
 * src/lib/public-catalog.ts is the only thing the public JSON API, the JSON-LD,
 * and /llms.txt are allowed to serve. If a private module ever becomes
 * reachable from it, every one of those surfaces inherits the leak at once, so
 * the import graph is walked transitively here rather than eyeballed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import {
  PUBLIC_CATALOG,
  PUBLIC_CATALOG_ENDPOINT_PATH,
  PUBLIC_CATALOG_ENDPOINT_URL,
  PUBLIC_CANONICAL_PAGES,
} from '../src/lib/public-catalog.ts';
import { PRODUCTION_ORIGIN } from '../src/lib/site-url.ts';
import { PROOF_TURNAROUND_WINDOW, PROOF_VOLUME_NOTE } from '../src/lib/proof-turnaround.ts';
import { GIFT_OCCASIONS } from '../src/lib/gift-occasions.ts';

/* ------------------------------------------------------------------ shape */

test('catalog carries a stable identity and an explicit review date', () => {
  assert.equal(PUBLIC_CATALOG.catalogId, 'hsb-public-catalog');
  assert.match(PUBLIC_CATALOG.schemaVersion, /^\d+\.\d+\.\d+$/);
  assert.match(PUBLIC_CATALOG.lastReviewed, /^\d{4}-\d{2}-\d{2}$/);
  // Valid calendar date, not merely digit-shaped.
  const parsed = new Date(`${PUBLIC_CATALOG.lastReviewed}T00:00:00Z`);
  assert.ok(!Number.isNaN(parsed.getTime()));
  assert.equal(parsed.toISOString().slice(0, 10), PUBLIC_CATALOG.lastReviewed);
});

test('every product has a stable id, integer minor units, and a canonical URL', () => {
  assert.deepEqual(
    PUBLIC_CATALOG.products.map((product) => product.id),
    ['digital', 'classic', 'premium'],
  );

  for (const product of PUBLIC_CATALOG.products) {
    assert.equal(product.currency, 'USD');
    assert.ok(Number.isInteger(product.priceMinorUnits), `${product.id} price must be integer`);
    assert.ok(product.priceMinorUnits > 0);
    assert.equal(
      product.priceDisplay,
      `$${product.priceMinorUnits / 100}`,
      `${product.id} display price must equal its minor units`,
    );
    assert.equal(product.proofFirst, true);
    assert.ok(product.canonicalUrl.startsWith(`${PRODUCTION_ORIGIN}/`) || product.canonicalUrl === `${PRODUCTION_ORIGIN}/`);
    assert.ok(product.features.length > 0);
  }
});

test('gift occasions mirror the approved occasion list with canonical URLs', () => {
  assert.deepEqual(
    PUBLIC_CATALOG.giftOccasions.map((occasion) => occasion.id),
    GIFT_OCCASIONS.map((occasion) => occasion.id),
  );
  for (const occasion of PUBLIC_CATALOG.giftOccasions) {
    assert.equal(occasion.canonicalUrl, `${PRODUCTION_ORIGIN}/gifts/${occasion.id}`);
  }
});

test('every URL in the contract is on the production apex origin', () => {
  const urls: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value)) urls.push(value);
    } else if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };
  walk(PUBLIC_CATALOG);
  walk(PUBLIC_CANONICAL_PAGES);
  urls.push(PUBLIC_CATALOG_ENDPOINT_URL);

  assert.ok(urls.length > 0);
  for (const url of urls) {
    assert.ok(
      url.startsWith(`${PRODUCTION_ORIGIN}/`) || url === PRODUCTION_ORIGIN,
      `non-production URL in public contract: ${url}`,
    );
  }
});

test('canonical pages and the endpoint path point at routes that exist', () => {
  const routeForPath = (pathname: string) => {
    const trimmed = pathname.replace(/^\//, '');
    return trimmed === ''
      ? 'src/app/page.tsx'
      : `src/app/${trimmed}/page.tsx`;
  };

  for (const page of PUBLIC_CANONICAL_PAGES) {
    const pathname = page.url.slice(PRODUCTION_ORIGIN.length);
    const file = routeForPath(pathname);
    assert.ok(existsSync(file), `${page.url} has no page at ${file}`);
  }

  assert.equal(PUBLIC_CATALOG_ENDPOINT_PATH, '/api/public/v1/catalog');
  assert.ok(existsSync(`src/app${PUBLIC_CATALOG_ENDPOINT_PATH}/route.ts`));
});

/* ------------------------------------------------------- source-of-truth */

test('catalog prices equal the priceCents Stripe is actually charged', () => {
  // orders.ts is an order module and must never be imported by the catalog, so
  // parity is proven by reading its source rather than by linking to it.
  const orders = readFileSync('src/lib/orders.ts', 'utf8');
  const block = orders.match(/const FORMAT_META[\s\S]*?\n\};/);
  assert.ok(block, 'FORMAT_META not found in src/lib/orders.ts');

  const actual = new Map<string, number>();
  for (const [, id, cents] of block[0].matchAll(/(\w+):\s*\{[^}]*priceCents:\s*(\d+)/g)) {
    actual.set(id, Number(cents));
  }
  assert.equal(actual.size, 3);

  for (const product of PUBLIC_CATALOG.products) {
    assert.equal(
      product.priceMinorUnits,
      actual.get(product.id),
      `catalog price for ${product.id} has drifted from FORMAT_META.priceCents`,
    );
  }
});

test('proof timing quotes the authoritative turnaround constant', () => {
  assert.equal(PUBLIC_CATALOG.policies.proofTurnaround, PROOF_TURNAROUND_WINDOW);
  assert.ok(PUBLIC_CATALOG.policies.proofTurnaroundNote.includes(PROOF_TURNAROUND_WINDOW));
  assert.equal(PUBLIC_CATALOG.policies.highVolumeNote, PROOF_VOLUME_NOTE);
});

/* ------------------------------------------------------------ determinism */

test('serialization is byte-identical across calls and unaffected by the clock', () => {
  const first = JSON.stringify(PUBLIC_CATALOG);
  const second = JSON.stringify(PUBLIC_CATALOG);
  assert.equal(first, second);

  const source = readFileSync('src/lib/public-catalog.ts', 'utf8');
  for (const clock of ['Date.now(', 'new Date(', 'performance.now(', 'Math.random(']) {
    assert.ok(!source.includes(clock), `public-catalog.ts must not read ${clock}`);
  }
});

test('the served contract is deeply frozen', () => {
  assert.ok(Object.isFrozen(PUBLIC_CATALOG));
  assert.ok(Object.isFrozen(PUBLIC_CATALOG.products));
  assert.ok(Object.isFrozen(PUBLIC_CATALOG.products[0]));
  assert.ok(Object.isFrozen(PUBLIC_CATALOG.products[0].features));
  assert.ok(Object.isFrozen(PUBLIC_CATALOG.policies));
  assert.throws(() => {
    (PUBLIC_CATALOG.products[0] as { priceMinorUnits: number }).priceMinorUnits = 1;
  });
});

/* --------------------------------------------------------------- privacy */

// `fulfillmentMode` is a public product attribute (download vs printed and
// shipped), so the ban targets fulfillment *state* rather than the word.
const FORBIDDEN_KEY =
  /order|customer|buyer|recipient|child|parent|photo|token|secret|stripe|blob|signedurl|signed_url|apikey|api_key|webhook|password|session|admin|fulfillment(?:status|state|id|path|error)|shipment|tracking|internal|queue|count/i;

/** `supportContact` is the published support address and is public by design. */
const PUBLIC_SUPPORT_ADDRESS = 'support@herostorybooks.com';

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, out));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
  return out;
}

test('no key in the served payload names a private concept', () => {
  const offenders = collectKeys(PUBLIC_CATALOG).filter((key) => FORBIDDEN_KEY.test(key));
  assert.deepEqual(offenders, [], `forbidden keys in public catalog: ${offenders.join(', ')}`);
});

test('the only email address in the payload is the published support address', () => {
  const payload = JSON.stringify(PUBLIC_CATALOG);
  const addresses = [...payload.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(addresses)], [PUBLIC_SUPPORT_ADDRESS]);
});

test('no credential, identifier, or storage-URL shape appears in the payload', () => {
  const payload = JSON.stringify(PUBLIC_CATALOG);
  const leaks: Array<[string, RegExp]> = [
    ['Stripe secret/publishable key', /\b(?:sk|pk|rk|whsec)_[A-Za-z0-9]/],
    ['Stripe object id', /\b(?:cs|pi|ch|cus|re|evt)_[A-Za-z0-9]{8}/],
    ['HSB order id', /\bord_[0-9a-f]{8}/i],
    ['Vercel Blob URL', /blob\.vercel-storage\.com/i],
    ['signed-URL query', /[?&](?:token|signature|sig|expires|X-Amz-Signature)=/i],
    ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\./],
    ['bare env interpolation', /process\.env/],
  ];
  for (const [label, pattern] of leaks) {
    assert.ok(!pattern.test(payload), `${label} found in public catalog payload`);
  }
});

/* ------------------------------------------------------ the import graph */

const PRIVATE_MODULE = /orders|order-email|checkout|stripe|blob|fulfillment|email|admin|family-review|proof(?!-turnaround)|page-review|recovery|storage|db|kv|redis|auth|session|lulu|print|customer|analytics|incident/i;

/** Resolve one import specifier to a repo-relative file path, or null. */
function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = path.join('src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.join(path.dirname(fromFile), specifier);
  else return null; // bare package specifier — not our source tree

  for (const candidate of [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) return candidate;
  }
  return null;
}

function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    const specifiers = [
      ...source.matchAll(/(?:^|\n)\s*import\s[^'"]*?from\s*['"]([^'"]+)['"]/g),
      ...source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      const resolved = resolveImport(file, specifier);
      if (resolved) queue.push(resolved);
    }
  }
  seen.delete(entry);
  return seen;
}

test('the catalog import graph contains only static public fact modules', () => {
  const graph = importGraph('src/lib/public-catalog.ts');

  assert.deepEqual(
    [...graph].sort(),
    ['src/lib/gift-occasions.ts', 'src/lib/proof-turnaround.ts', 'src/lib/site-url.ts'],
    'the public catalog reached a module outside the approved static-fact set',
  );

  for (const file of graph) {
    assert.ok(!PRIVATE_MODULE.test(path.basename(file)), `private module reachable from catalog: ${file}`);
  }
});

test('the catalog reads no environment variable, directly or transitively', () => {
  for (const file of ['src/lib/public-catalog.ts', ...importGraph('src/lib/public-catalog.ts')]) {
    const source = readFileSync(file, 'utf8');
    // site-url.ts exposes env-reading helpers, but the catalog imports only the
    // PRODUCTION_ORIGIN constant from it. Assert the constant, not the file.
    if (file === 'src/lib/site-url.ts') continue;
    assert.ok(!source.includes('process.env'), `${file} reads process.env`);
  }
  const catalog = readFileSync('src/lib/public-catalog.ts', 'utf8');
  const siteUrlImport = catalog.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/site-url\.ts'/);
  assert.ok(siteUrlImport, 'expected a named import from site-url');
  assert.deepEqual(
    siteUrlImport[1].split(',').map((s) => s.trim()).filter(Boolean),
    ['PRODUCTION_ORIGIN'],
    'only the PRODUCTION_ORIGIN constant may be imported from site-url',
  );
});

test('the catalog does not source src/lib/pricing.ts, which is dead and stale', () => {
  // tests/digital-pdf-timing-truthfulness.test.ts holds pricing.ts to the dead
  // pricing section precisely because it still carries the retired
  // "final PDF delivered after approval" claim. Importing it here would ship
  // that claim to every machine consumer at once.
  const source = readFileSync('src/lib/public-catalog.ts', 'utf8');
  assert.ok(!/from\s*'[^']*pricing/.test(source));
});

/* ----------------------------------------------------- truthfulness locks */

test('no unadjudicated policy claim appears in the contract', () => {
  // `limitations` exists to DENY these claims ("No instant, same-day, or rush
  // fulfillment is offered"), so scanning it would flag the denial as the claim.
  // Only the claim-bearing sections are scanned.
  const { limitations: _denials, ...claims } = PUBLIC_CATALOG;
  const payload = JSON.stringify(claims).toLowerCase();
  const banned: Array<[string, RegExp]> = [
    ['an age-range claim (no live public page states one)', /\bages?\s+\d|\bage range\b|\bage-appropriate\b/],
    ['a 30-day / full-refund replacement promise', /30 days|full refund/],
    ['a PDF-included claim for printed tiers', /digital pdf included/],
    ['a guaranteed delivery date', /we guarantee|guaranteed (?:delivery|arrival|date)|delivered by|arrives by/],
    ['a same-day or instant claim', /same[- ]day|instant(?:ly)?|overnight|rush/],
    ['a satisfaction guarantee', /satisfaction guarantee|money[- ]back/],
  ];
  for (const [label, pattern] of banned) {
    assert.ok(!pattern.test(payload), `public catalog states ${label}`);
  }
});

test('the contract states its own limits', () => {
  const limitations = PUBLIC_CATALOG.limitations.join(' ').toLowerCase();
  assert.ok(limitations.includes('not guaranteed'));
  assert.ok(/cannot be used to look up an order|no order/.test(limitations));
});
