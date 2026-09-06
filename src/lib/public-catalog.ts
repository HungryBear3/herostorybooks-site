/**
 * The single machine-readable public fact contract for Hero Story Books.
 *
 * Everything a non-human consumer is allowed to learn about this business —
 * the public JSON API at /api/public/v1/catalog, the JSON-LD on the homepage,
 * and /llms.txt — is assembled from this module and nothing else.
 *
 * TRUTH RULE. Every string below is backed by copy that is live on a public
 * page today (primarily the homepage FAQ and pricing sections rendered by
 * src/components/editorial-site.tsx) or by an authoritative shared constant.
 * Nothing here may state a policy that no public page states. Where two live
 * surfaces disagree, this module stays silent rather than picking a winner —
 * see the DELIBERATE OMISSIONS note below.
 *
 * PRIVACY RULE. This module's import graph must contain only static public
 * fact modules. It must never import orders, customers, checkout, family
 * review, Blob, Stripe, fulfillment, email, admin, proofs, signed assets, or
 * any operational state. tests/public-catalog.test.ts walks the transitive
 * import graph and fails if that is ever violated, so adding an import here is
 * a reviewed act, not a convenience.
 *
 * PRICE RULE. `priceMinorUnits` is duplicated here rather than imported from
 * src/lib/orders.ts, because orders.ts is an order module and importing it
 * would breach the privacy rule. tests/public-catalog.test.ts asserts these
 * values equal orders.ts FORMAT_META.priceCents, so the duplication cannot
 * drift from what Stripe actually charges.
 *
 * NOT src/lib/pricing.ts. That module is unreachable dead code that still
 * carries the retired "final PDF delivered after approval" claim, and
 * tests/digital-pdf-timing-truthfulness.ts holds a standing assertion that it
 * stays confined to the dead pricing section. It is deliberately not a source
 * here.
 *
 * DELIBERATE OMISSIONS (open adjudication items — do not fill these in without
 * an owner decision):
 *   - Age suitability. No live public page states an age range. The "ages 0-10"
 *     copy lives only in src/components/faq-section.tsx, which nothing renders.
 *   - Whether printed tiers include the Digital PDF. The live homepage
 *     comparison table says they do not; the live checkout summary strings in
 *     src/app/checkout/checkout-form.tsx say they do. Silent until adjudicated.
 *   - Any "30 days / full refund" replacement promise. That copy exists only in
 *     the unrendered src/components/faq-section.tsx and contradicts the live
 *     homepage refund answers, which are the ones represented below.
 */
import {
  PROOF_TURNAROUND_WINDOW,
  PROOF_VOLUME_NOTE,
} from './proof-turnaround.ts';
import { GIFT_OCCASIONS } from './gift-occasions.ts';
import { PRODUCTION_ORIGIN } from './site-url.ts';

/** Semantic version of the contract shape. Bump on any breaking field change. */
export const PUBLIC_CATALOG_SCHEMA_VERSION = '1.0.0';

/** Stable identifier for this catalog document. */
export const PUBLIC_CATALOG_ID = 'hsb-public-catalog';

/**
 * The date a human last reviewed every fact in this file for truthfulness.
 *
 * This is an explicit literal on purpose. Nothing in the serving path may read
 * the current clock: a response that changes because time passed is not a
 * deterministic contract, and a freshness date that advances on its own is a
 * lie about review having happened.
 */
export const PUBLIC_CATALOG_LAST_REVIEWED = '2026-09-06';

export type PublicProductId = 'digital' | 'classic' | 'premium';

/** Recursively freeze so a consumer cannot mutate the served contract. */
function deepFreeze<T>(value: T): T {
  if (value && (typeof value === 'object' || typeof value === 'function')) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

const url = (path: string) => `${PRODUCTION_ORIGIN}${path}`;

const PRODUCT_IMAGE_URL = url('/assets/lukas-watercolor-dino-cover.jpg');

const SOURCES = {
  home: url('/'),
  samples: url('/samples'),
  about: url('/about'),
  gifts: url('/gifts'),
  privacy: url('/privacy'),
  terms: url('/terms'),
} as const;

export const PUBLIC_CATALOG = deepFreeze({
  schemaVersion: PUBLIC_CATALOG_SCHEMA_VERSION,
  catalogId: PUBLIC_CATALOG_ID,
  lastReviewed: PUBLIC_CATALOG_LAST_REVIEWED,

  brand: {
    name: 'Hero Story Books',
    url: SOURCES.home,
    description:
      'Hero Story Books makes personalized 32-page illustrated children’s storybooks in which the child is the hero. Every order starts with a digital proof the buyer reviews and approves before anything is printed.',
    supportContact: 'support@herostorybooks.com',
  },

  products: [
    {
      id: 'digital' as PublicProductId,
      name: 'Digital PDF',
      description:
        'A personalized 32-page storybook delivered as a high-resolution PDF. The digital proof and the full PDF arrive in the same email, so there is no printing or shipping step.',
      currency: 'USD',
      priceMinorUnits: 1900,
      priceDisplay: '$19',
      fulfillmentMode: 'digital-download',
      proofFirst: true,
      canonicalUrl: SOURCES.home,
      imageUrl: PRODUCT_IMAGE_URL,
      features: [
        '32-page personalized book',
        'Full-color illustrated spreads',
        'Digital proof included',
        'High-resolution PDF delivered with the proof email',
        'No printing or shipping step',
      ],
    },
    {
      id: 'classic' as PublicProductId,
      name: 'Classic softcover',
      description:
        'A personalized 32-page 8.5 in × 8.5 in perfect-bound softcover book, printed only after the buyer approves the digital proof.',
      currency: 'USD',
      priceMinorUnits: 3900,
      priceDisplay: '$39',
      fulfillmentMode: 'printed-and-shipped',
      proofFirst: true,
      canonicalUrl: SOURCES.home,
      imageUrl: PRODUCT_IMAGE_URL,
      features: [
        '32-page personalized book',
        'Full-color illustrated spreads',
        'Digital proof reviewed and approved before print',
        'Perfect-bound softcover, 8.5 in × 8.5 in',
        'US shipping included',
      ],
    },
    {
      id: 'premium' as PublicProductId,
      name: 'Premium hardcover',
      description:
        'A personalized 32-page 8.5 in × 8.5 in case-bound hardcover keepsake book, printed only after the buyer approves the digital proof.',
      currency: 'USD',
      priceMinorUnits: 6400,
      priceDisplay: '$64',
      fulfillmentMode: 'printed-and-shipped',
      proofFirst: true,
      canonicalUrl: SOURCES.home,
      imageUrl: PRODUCT_IMAGE_URL,
      features: [
        '32-page personalized book',
        'Full-color illustrated spreads',
        'Digital proof reviewed and approved before print',
        'Case-bound hardcover, 8.5 in × 8.5 in',
        'Keepsake hardcover finish',
        'US shipping included',
      ],
    },
  ],

  giftOccasions: GIFT_OCCASIONS.map((occasion) => ({
    id: occasion.id,
    title: occasion.title,
    description: occasion.description,
    canonicalUrl: url(`/gifts/${occasion.id}`),
  })),

  policies: {
    proofFirst:
      'Every order starts with a digital proof. Printed books are not sent to print until the buyer approves that proof.',
    proofTurnaround: PROOF_TURNAROUND_WINDOW,
    proofTurnaroundNote: `Digital proofs are usually ready in ${PROOF_TURNAROUND_WINDOW}.`,
    highVolumeNote: PROOF_VOLUME_NOTE,
    revisionsBeforeApproval:
      'Revisions requested before approval are included, not an upsell. Nothing is printed until the buyer approves.',
    printDispatchAfterApproval:
      'Printed books ship 5–7 business days after the buyer approves the proof.',
    usDeliveryAfterDispatch:
      'Once a printed book ships, US delivery is typically 3–5 days. Specific delivery dates are not guaranteed because carrier timing varies.',
    shippingGeography:
      'For launch, printed books ship within the United States only. Buyers outside the US can order the Digital PDF from anywhere with a US-billed payment method.',
    shippingIncluded:
      'US shipping is included in the Classic softcover and Premium hardcover prices.',
    refundDigital:
      'Digital orders are fully refundable up until the buyer approves the proof. Approving accepts the book, and the digital order is final from that point.',
    refundPrinted:
      'Printed books are refundable up until the buyer approves the proof for print. After proof approval the book goes to print and generally cannot be canceled; we replace books with printing defects or fulfillment errors.',
    multipleCopies:
      'Additional softcover or hardcover prints of an approved book are arranged at a reduced rate by emailing support after approval.',
    giftDeadlines:
      'We do not promise specific delivery dates. The Digital PDF has no printing or shipping step and is the reliable option when timing is tight.',
  },

  sources: {
    brand: [SOURCES.home, SOURCES.about],
    products: [SOURCES.home],
    pricing: [SOURCES.home],
    policies: [SOURCES.home, SOURCES.terms],
    giftOccasions: [SOURCES.gifts],
    samples: [SOURCES.samples],
    privacy: [SOURCES.privacy],
  },

  limitations: [
    'Delivery dates are not guaranteed. Carrier timing varies and no specific arrival date is promised.',
    'No instant, same-day, or rush fulfillment is offered.',
    'This catalog is general public product information. It contains no order, customer, or delivery status and cannot be used to look up an order.',
    'Prices and policies are current as of lastReviewed and may change.',
    'Sample artwork shown on public pages is illustrative, not a specific customer’s book.',
  ],
} as const);

export type PublicCatalog = typeof PUBLIC_CATALOG;

/** Canonical public pages an agent may cite, in the order they should be read. */
export const PUBLIC_CANONICAL_PAGES = deepFreeze([
  { url: SOURCES.home, title: 'Home — product, pricing, and FAQ' },
  { url: SOURCES.samples, title: 'Samples — illustrative sample artwork' },
  { url: SOURCES.gifts, title: 'Gifts — gift occasions' },
  { url: SOURCES.about, title: 'About — who makes the books' },
  { url: SOURCES.privacy, title: 'Privacy policy' },
  { url: SOURCES.terms, title: 'Terms of service' },
] as const);

/** Path of the public catalog endpoint. Single source for robots and llms.txt. */
export const PUBLIC_CATALOG_ENDPOINT_PATH = '/api/public/v1/catalog';
export const PUBLIC_CATALOG_ENDPOINT_URL = url(PUBLIC_CATALOG_ENDPOINT_PATH);
