/**
 * schema.org JSON-LD for the public homepage.
 *
 * Every value is read from PUBLIC_CATALOG or from PUBLIC_HOME_FAQS — the exact
 * array the page renders — so the structured data cannot describe a business
 * different from the one a visitor reads.
 *
 * What is deliberately absent, and must stay absent without an owner decision
 * and real evidence behind it: aggregateRating, review, sku, gtin/mpn,
 * availability, priceValidUntil, shippingDetails, hasMerchantReturnPolicy, and
 * any guarantee. Each of those is a claim Google surfaces to shoppers as fact,
 * and none of them is backed by a live public page today. availability in
 * particular cannot be stated from here: HSB_CHECKOUT_PAUSED can close checkout
 * at any time, and this module is forbidden from reading operational state, so
 * any hard-coded stock claim would be a claim it cannot keep true.
 */
import { PUBLIC_CATALOG } from './public-catalog.ts';
import { PUBLIC_HOME_FAQS } from './public-faqs.ts';

/**
 * JSON embedded in <script> must not be able to close the tag or open a comment
 * that the HTML parser would honour. Escaping the three characters that can do
 * that keeps the payload inert while leaving it valid JSON.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** Minor units -> the decimal string schema.org Offer.price expects. */
function offerPrice(minorUnits: number): string {
  return (minorUnits / 100).toFixed(2);
}

export function buildPublicStructuredData() {
  const { brand, products } = PUBLIC_CATALOG;
  const organizationId = `${brand.url}#organization`;
  const websiteId = `${brand.url}#website`;

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': organizationId,
        name: brand.name,
        url: brand.url,
        description: brand.description,
        email: brand.supportContact,
      },
      {
        '@type': 'WebSite',
        '@id': websiteId,
        name: brand.name,
        url: brand.url,
        publisher: { '@id': organizationId },
        inLanguage: 'en-US',
      },
      ...products.map((product) => ({
        '@type': 'Product',
        '@id': `${brand.url}#product-${product.id}`,
        name: product.name,
        description: product.description,
        image: product.imageUrl,
        brand: {
          '@type': 'Brand',
          name: brand.name,
        },
        url: product.canonicalUrl,
        offers: {
          '@type': 'Offer',
          price: offerPrice(product.priceMinorUnits),
          priceCurrency: product.currency,
          url: product.canonicalUrl,
          seller: { '@id': organizationId },
        },
      })),
      {
        '@type': 'FAQPage',
        '@id': `${brand.url}#faq`,
        mainEntity: PUBLIC_HOME_FAQS.map(([question, answer]) => ({
          '@type': 'Question',
          name: question,
          acceptedAnswer: { '@type': 'Answer', text: answer },
        })),
      },
    ],
  };
}
