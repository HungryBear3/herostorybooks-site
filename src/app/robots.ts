import type { MetadataRoute } from 'next';
import { PUBLIC_CATALOG_ENDPOINT_PATH } from '../lib/public-catalog.ts';
import { getSiteOrigin, shouldIndexSite } from '../lib/site-url.ts';

const PRIVATE_ROUTES = [
  '/admin/',
  '/api/',
  '/checkout',
  '/design-previews/',
  '/family-review',
  '/order',
  '/partner/',
  '/review/',
  '/status/',
  '/thank-you',
];

/**
 * `/api/` above disallows every API route, which is the correct default and
 * must stay. The public catalog is the one deliberate exception, so it is
 * listed as a longer, more specific Allow: crawlers that follow the
 * most-specific-rule-wins convention (Google, Bing) match the 24-character
 * catalog path over the 5-character `/api/` prefix and fetch it, while every
 * other API path still matches only the disallow.
 *
 * Nothing else is added here. Widening this list is how a private route
 * quietly becomes crawlable, so each entry needs its own reason.
 */
const PUBLIC_ALLOWED_ROUTES = ['/', PUBLIC_CATALOG_ENDPOINT_PATH];

export default function robots(): MetadataRoute.Robots {
  const origin = getSiteOrigin();
  const indexSite = shouldIndexSite();

  return {
    rules: {
      userAgent: '*',
      allow: indexSite ? PUBLIC_ALLOWED_ROUTES : undefined,
      disallow: indexSite ? PRIVATE_ROUTES : '/',
    },
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
