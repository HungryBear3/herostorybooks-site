/**
 * Homepage JSON-LD.
 *
 * Structured data is the one surface where a wrong claim is machine-read and
 * republished by search engines as fact, so this suite checks two things: that
 * every value traces to the public catalog or to the FAQ array the page
 * actually renders, and that the fields nobody has evidence for stay absent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  buildPublicStructuredData,
  serializeJsonLd,
} from '../src/lib/public-structured-data.ts';
import {
  PUBLIC_CATALOG,
  PUBLIC_CATALOG_LAST_REVIEWED,
} from '../src/lib/public-catalog.ts';
import { PUBLIC_HOME_FAQS } from '../src/lib/public-faqs.ts';
import { PRODUCTION_ORIGIN } from '../src/lib/site-url.ts';

const graph = buildPublicStructuredData();
const nodes = graph['@graph'] as Array<Record<string, any>>;
const byType = (type: string) => nodes.filter((node) => node['@type'] === type);

test('the payload is valid JSON-LD on the HTTPS schema context', () => {
  const serialized = serializeJsonLd(graph);
  const reparsed = JSON.parse(serialized);
  assert.equal(reparsed['@context'], 'https://schema.org');
  assert.deepEqual(reparsed, JSON.parse(JSON.stringify(graph)));
  assert.deepEqual(
    nodes.map((node) => node['@type']),
    ['Organization', 'WebSite', 'Product', 'Product', 'Product', 'FAQPage'],
  );
});

test('serialization cannot break out of the script tag', () => {
  const serialized = serializeJsonLd({ hostile: '</script><img src=x onerror=alert(1)>&' });
  assert.ok(!serialized.includes('<'));
  assert.ok(!serialized.includes('>'));
  assert.ok(!serialized.includes('&'));
  assert.equal(
    JSON.parse(serialized).hostile,
    '</script><img src=x onerror=alert(1)>&',
    'escaping must not corrupt the value',
  );
});

test('every product exposes a crawlable catalog image', () => {
  const products = byType('Product');
  assert.equal(products.length, PUBLIC_CATALOG.products.length);

  for (const [index, product] of products.entries()) {
    const source = PUBLIC_CATALOG.products[index];
    assert.equal(product.image, source.imageUrl);
    assert.ok(product.image.startsWith(PRODUCTION_ORIGIN));
  }
});

test('every product image resolves to a file that exists under public/', () => {
  const products = byType('Product');
  assert.equal(products.length, PUBLIC_CATALOG.products.length);

  for (const product of products) {
    const image: string = product.image;
    assert.ok(
      image.startsWith(`${PRODUCTION_ORIGIN}/`),
      `product image is not served from the production origin: ${image}`,
    );
    const path = image.slice(PRODUCTION_ORIGIN.length);
    assert.ok(
      existsSync(`public${path}`),
      `product image has no file on disk: public${path}`,
    );
  }
});

test('every product uses an inline Google-supported Brand object', () => {
  for (const product of byType('Product')) {
    assert.deepEqual(product.brand, {
      '@type': 'Brand',
      name: PUBLIC_CATALOG.brand.name,
    });
  }
});

test('every product offer matches the catalog price and currency', () => {
  const products = byType('Product');
  assert.equal(products.length, PUBLIC_CATALOG.products.length);

  for (const [index, product] of products.entries()) {
    const source = PUBLIC_CATALOG.products[index];
    assert.equal(product.name, source.name);
    assert.equal(product.description, source.description);
    assert.equal(product['@id'], `${PRODUCTION_ORIGIN}/#product-${source.id}`);
    assert.equal(product.offers['@type'], 'Offer');
    assert.equal(product.offers.priceCurrency, source.currency);
    assert.equal(product.offers.price, (source.priceMinorUnits / 100).toFixed(2));
    assert.match(product.offers.price, /^\d+\.\d{2}$/);
  }
});

test('no availability claim is stated anywhere in the catalog or the graph', () => {
  // Availability is a stock claim Google republishes as fact. It cannot be
  // hard-coded here because HSB_CHECKOUT_PAUSED can close checkout at any time
  // and this module is forbidden from reading operational state, so the only
  // truthful markup is silence.
  assert.ok(
    !JSON.stringify(PUBLIC_CATALOG).includes('availability'),
    'public catalog states an availability claim',
  );
  assert.ok(
    !JSON.stringify(graph).includes('availability'),
    'JSON-LD states an availability claim',
  );
  for (const product of byType('Product')) {
    assert.ok(!('availability' in product.offers));
  }
  for (const source of PUBLIC_CATALOG.products) {
    assert.ok(!('availability' in source));
  }
});

test('the catalog review date covers the facts this candidate adds', () => {
  assert.equal(PUBLIC_CATALOG_LAST_REVIEWED, '2026-09-06');
  assert.equal(PUBLIC_CATALOG.lastReviewed, PUBLIC_CATALOG_LAST_REVIEWED);
});

test('every @id and url uses the production apex origin', () => {
  const urls: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value) && !value.startsWith('https://schema.org')) urls.push(value);
    } else if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };
  walk(graph);
  assert.ok(urls.length > 0);
  for (const url of urls) {
    assert.ok(url.startsWith(PRODUCTION_ORIGIN), `non-apex URL in JSON-LD: ${url}`);
  }
});

test('FAQ structured data is character-identical to the rendered FAQ', () => {
  const faq = byType('FAQPage')[0];
  assert.deepEqual(
    faq.mainEntity.map((entry: any) => [entry.name, entry.acceptedAnswer.text]),
    PUBLIC_HOME_FAQS.map(([question, answer]) => [question, answer]),
  );
  for (const entry of faq.mainEntity) {
    assert.equal(entry['@type'], 'Question');
    assert.equal(entry.acceptedAnswer['@type'], 'Answer');
  }
});

test('the rendered page consumes the same FAQ array the JSON-LD does', () => {
  const editorial = readFileSync('src/components/editorial-site.tsx', 'utf8');
  assert.match(editorial, /import \{ PUBLIC_HOME_FAQS \} from '@\/lib\/public-faqs';/);
  assert.match(editorial, /PUBLIC_HOME_FAQS\.map\(/);
  assert.ok(
    !/const faqs\s*[:=]/.test(editorial),
    'editorial-site must not reintroduce a private FAQ copy',
  );
});

test('no unevidenced commercial claim appears in the graph', () => {
  const serialized = JSON.stringify(graph);
  const banned = [
    'aggregateRating',
    'ratingValue',
    'reviewCount',
    '"review"',
    'sku',
    'gtin',
    'gtin13',
    'mpn',
    'productID',
    'availability',
    'priceValidUntil',
    'shippingDetails',
    'deliveryTime',
    'hasMerchantReturnPolicy',
    'warranty',
    'award',
  ];
  for (const field of banned) {
    assert.ok(!serialized.includes(field), `JSON-LD asserts unevidenced field: ${field}`);
  }
});

test('the homepage mounts the structured data', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(page, /import \{ PublicStructuredData \} from '@\/components\/public-structured-data';/);
  assert.match(page, /<PublicStructuredData \/>/);

  const component = readFileSync('src/components/public-structured-data.tsx', 'utf8');
  assert.match(component, /type="application\/ld\+json"/);
  assert.match(component, /serializeJsonLd\(buildPublicStructuredData\(\)\)/);
});
