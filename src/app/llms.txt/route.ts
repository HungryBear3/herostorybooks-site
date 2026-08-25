/**
 * GET /llms.txt — a compact, factual map of the public surface for models and
 * research tools.
 *
 * Generated from PUBLIC_CATALOG rather than checked in as a static file. A
 * static public/llms.txt would be a second copy of the prices, policies, and
 * URLs, and second copies drift; generating it means the only way this file can
 * state a price is for the catalog to state it first.
 *
 * This file makes no claim that publishing it causes indexing, citation, or
 * recommendation by anyone. It is a map, not a request.
 */
import {
  PUBLIC_CANONICAL_PAGES,
  PUBLIC_CATALOG,
  PUBLIC_CATALOG_ENDPOINT_URL,
} from '../../lib/public-catalog.ts';

export const dynamic = 'force-static';

function build(): string {
  const { brand, products, policies, lastReviewed, schemaVersion } = PUBLIC_CATALOG;

  const lines: string[] = [
    `# ${brand.name}`,
    '',
    `> ${brand.description}`,
    '',
    '## Machine-readable catalog',
    '',
    `- [Public catalog JSON](${PUBLIC_CATALOG_ENDPOINT_URL}): versioned, read-only product, pricing, gift-occasion, and policy facts. Schema version ${schemaVersion}; facts last reviewed ${lastReviewed}.`,
    '',
    '## Canonical pages',
    '',
    ...PUBLIC_CANONICAL_PAGES.map((page) => `- [${page.title}](${page.url})`),
    '',
    '## Products',
    '',
    ...products.map(
      (product) =>
        `- ${product.name} (id: ${product.id}) — ${product.priceDisplay} ${product.currency} one-time. ${product.description}`,
    ),
    '',
    '## Key policies',
    '',
    `- ${policies.proofFirst}`,
    `- ${policies.proofTurnaroundNote} ${policies.highVolumeNote}`,
    `- ${policies.printDispatchAfterApproval}`,
    `- ${policies.usDeliveryAfterDispatch}`,
    `- ${policies.shippingGeography}`,
    `- ${policies.refundDigital}`,
    `- ${policies.refundPrinted}`,
    '',
    '## Limits of this information',
    '',
    ...PUBLIC_CATALOG.limitations.map((limitation) => `- ${limitation}`),
    '',
    '## Order support',
    '',
    `General product facts are public and listed above. Anything about a specific order — its status, proof, artwork, delivery, or the people in it — is private and is not available here or through the catalog endpoint. Buyers with an order question should email ${brand.supportContact}.`,
    '',
  ];

  return `${lines.join('\n')}`;
}

const BODY = build();

export function GET(): Response {
  return new Response(BODY, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
